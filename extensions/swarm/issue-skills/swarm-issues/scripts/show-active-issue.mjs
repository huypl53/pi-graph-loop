#!/usr/bin/env node
// === swarm-issues Phase 4 — read-only active-issue snapshot viewer CLI ===
//
// Renders the immutable activation snapshot for the CURRENT linked issue only. The snapshot
// path is linkage-derived (swarm-state issueRun queue entry) and hash-verified when present.
// Zero writes, ever. Run-status rendering stays in `/swarm issues status`.
//
// Usage: node show-active-issue.mjs [--full] [--json] [--cwd <dir>]
//   Exit 0 — rendered (or plain "no active issue")
//   Exit 1 — snapshot unreadable / hash mismatch / corrupt
import { readFileSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
let full = false;
let asJson = false;
let cwd = process.cwd();
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--full") full = true;
	else if (args[i] === "--json") asJson = true;
	else if (args[i] === "--cwd") cwd = resolve(args[++i] ?? cwd);
	else if (args[i] === "--help" || args[i] === "-h") {
		console.log("Usage: node show-active-issue.mjs [--full] [--json] [--cwd <dir>]");
		process.exit(0);
	}
}

const stateFile = resolve(cwd, ".pi/swarm/swarm-state.json");
const MAX_SNAPSHOT_BYTES = 1_000_000; // mirrors captureIssueSnapshot's aggregate cap

function fail(msg, json) {
	if (asJson) console.log(JSON.stringify(json ?? { active: false, error: msg }));
	else console.error(`show-active-issue: ${msg}`);
	process.exit(1);
}

let state;
try {
	state = JSON.parse(readFileSync(stateFile, "utf8"));
} catch (err) {
	// no swarm state → plainly no active issue (exit 0)
	if (asJson) console.log(JSON.stringify({ active: false }));
	else console.log("no active issue");
	process.exit(0);
}

const run = state.issueRun;
const entry = run?.activeIssueId ? (run.queue ?? []).find((q) => q.issueId === run.activeIssueId) : null;
if (!entry) {
	if (asJson) console.log(JSON.stringify({ active: false }));
	else console.log("no active issue");
	process.exit(0);
}

if (!entry.snapshotPath) fail(`active issue "${entry.issueId}" has no recorded snapshot path`, { active: false, error: "no_snapshot_path", issueId: entry.issueId });

let snap;
try {
	snap = JSON.parse(readFileSync(entry.snapshotPath, "utf8"));
} catch (err) {
	fail(`snapshot at ${entry.snapshotPath} unreadable: ${err?.message || err}`, { active: true, issueId: entry.issueId, error: "snapshot_unreadable" });
}

// Hash verification when the snapshot carries its own hash (never render a stale snapshot).
if (snap.snapshotHash && entry.snapshotHash && snap.snapshotHash !== entry.snapshotHash) {
	fail(`snapshot hash mismatch for "${entry.issueId}" (file=${snap.snapshotHash.slice(0, 12)} state=${entry.snapshotHash.slice(0, 12)}) — refusing to render a stale snapshot`, {
		active: true,
		issueId: entry.issueId,
		error: "hash_mismatch",
	});
}

// Bound the rendered payload (--full) to the same cap capture used
// (MAX_SNAPSHOT_BYTES mirrored from src/issues/snapshot.ts — skill scripts stay import-free).
let truncated = false;
let snapText = JSON.stringify(snap, null, 2);
if (Buffer.byteLength(snapText) > MAX_SNAPSHOT_BYTES) {
	// P2 fix (phase-04-fix): the slice can land mid-string-literal, so the sliced body is NOT
	// valid JSON — render it verbatim, never re-parse. All oversize paths are string-only.
	truncated = true;
	snapText = snapText.slice(0, MAX_SNAPSHOT_BYTES) + "\n…[truncated]";
	snap = undefined;
}

if (asJson) {
	if (truncated) {
		console.log(JSON.stringify({ active: true, truncated, snapshotBytes: MAX_SNAPSHOT_BYTES, snapshotText: snapText }, null, 2));
	} else {
		console.log(JSON.stringify(full ? { active: true, truncated, snapshot: snap } : { active: true, issue: { id: snap.id, title: snap.title, capturedAt: snap.capturedAt, docs: (snap.docs ?? []).map((d) => d.path) } }, null, 2));
	}
	process.exit(0);
}

// Human: compact default; --full prints the bounded snapshot JSON (verbatim when truncated).
if (!truncated) {
	console.log(`active issue: ${snap.id} — ${snap.title}`);
	console.log(`captured: ${snap.capturedAt ?? "-"}`);
} else {
	console.log(`active issue: ${entry.issueId} — ${entry.title ?? ""}`.trimEnd());
	console.log("snapshot oversize — rendered truncated verbatim (content below may be cut mid-string)");
}
console.log(`snapshot: ${entry.snapshotPath}${truncated ? " (truncated at cap)" : ""}`);
if (full) {
	console.log("---snapshot---");
	console.log(snapText);
} else if (!truncated) {
	const docs = snap.docs ?? [];
	console.log(`docs: ${docs.length ? docs.map((d) => d.path).join(", ") : "(none)"}`);
	console.log("(use --full for the bounded snapshot, --json for machine output)");
}
process.exit(0);
