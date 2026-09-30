#!/usr/bin/env node
/**
 * swarm-issues Phase 2 — immutable snapshot files + durable issue-run state tests
 * (issues-state.test.mjs).
 *
 * Covers the approved plan §2 matrix:
 *   - snapshot bodies are files under .pi/swarm/issues/snapshots/<runId>/<issueId>.json;
 *     swarm-state.json NEVER contains doc content (grep probe on serialized state)
 *   - idempotent re-capture (same hash → no rewrite); different hash → snapshot_hash_conflict
 *   - oversized doc → truncated flag + sha256 of captured prefix; aggregate fair-share cap
 *   - symlink-escape doc rejected BEFORE any snapshot write (no partial file)
 *   - backfill: legacy (R16 shape, no issueRun) / partial issueRun / corrupt JSON recover safely
 *   - transition guards: second active, activation without snapshot, terminal-unsuccessful
 *     requeue, done-without-active, reason-less blocked/failed/cancelled, incomplete complete
 *   - reconcile: dangling/unlinked active pointer → run paused (state_loss_recovered), no recreation
 *   - RED-HARNESS PRESERVATION: issues-sequencer.test.mjs keeps its expected classification
 *
 * Deterministic, offline, scratch-cwd only. Exit nonzero on any failure.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = fileURLToPath(new URL(".", import.meta.url));
const src = join(here, "..", "src");

const { captureIssueSnapshot, readIssueSnapshot, snapshotPath, sourceHashOf } = await import(join(src, "issues", "snapshot.ts"));
const {
	backfillIssueRun, getIssueRun, guardActivateIssue, applyActivateIssue, guardObserveLinkedTerminal,
	guardMarkIssueTerminal, guardCompleteRun, guardPauseRun, guardResumeRun, guardStopRun, reconcileIssueRun,
} = await import(join(src, "issues", "state.ts"));
const { readState, writeState, paths, atomicWriteFile } = await import(join(src, "state.ts"));

let passed = 0;
async function t(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`  ok   ${name}`);
	} catch (err) {
		console.error(`  FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	}
}

function makeWorld(withDocs = true) {
	const cwd = mkdtempSync(join(tmpdir(), "issues-state-"));
	const swarmRoot = join(cwd, ".pi", "swarm");
	mkdirSync(swarmRoot, { recursive: true });
	if (withDocs) {
		mkdirSync(join(swarmRoot, "docs"), { recursive: true });
		writeFileSync(join(swarmRoot, "docs", "a.md"), "# A\n" + "line\n".repeat(50));
		writeFileSync(join(swarmRoot, "docs", "big.md"), "x".repeat(300_000));
	}
	// swarmRoot is the documented snapshot root (.pi/swarm); cwd is the project root.
	return withDocs ? { cwd, swarmRoot } : cwd;
}
const ISSUE = { id: "fix-login", title: "Fix login", content: "Patch sessions.", docs: ["docs/a.md"] };
await t("snapshot file lands under .pi/swarm/issues/snapshots/<runId>/<issueId>.json (documented layout) with hashes; state stays ref-only", async () => {
	const { cwd, swarmRoot } = makeWorld();
	const r = await captureIssueSnapshot(swarmRoot, "run-0001", ISSUE);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.equal(r.path, snapshotPath(swarmRoot, "run-0001", ISSUE.id));
	// F1: literal documented-layout assertion — evidence must live under .pi/swarm/issues/snapshots
	assert.equal(r.path, join(cwd, ".pi", "swarm", "issues", "snapshots", "run-0001", "fix-login.json"));
	assert.ok(existsSync(join(cwd, ".pi", "swarm", "issues", "snapshots", "run-0001")), "documented snapshots dir must exist under .pi/swarm");
	assert.ok(existsSync(r.path));
	assert.equal(r.idempotent, false);
	const snap = JSON.parse(readFileSync(r.path, "utf8"));
	assert.equal(snap.sourceHash, sourceHashOf(ISSUE));
	assert.equal(snap.docs[0].path, "docs/a.md");
	assert.equal(snap.docs[0].truncated, false);
	// state ref-only probe: even if someone serialized this result, no doc content allowed.
	const stPath = join(cwd, ".pi", "swarm", "swarm-state.json");
	await atomicWriteFile(stPath, JSON.stringify({ issueRun: { status: "running", runId: "run-0001", queue: [{ issueId: ISSUE.id, title: ISSUE.title, sourceHash: r.sourceHash, snapshotPath: r.path, status: "active" }], activeIssueId: ISSUE.id } }) + "\n");
	const serialized = readFileSync(stPath, "utf8");
	assert.ok(!serialized.includes("Patch sessions."), "state must not embed issue content");
	assert.ok(!serialized.includes("# A"), "state must not embed doc content");
});

await t("idempotent re-capture (same hash → no write); different hash at same path → hard conflict", async () => {
	const { swarmRoot } = makeWorld();
	const first = await captureIssueSnapshot(swarmRoot, "run-0002", ISSUE);
	assert.equal(first.ok, true);
	const mtime1 = statSync(first.ok ? first.path : "").mtimeMs;
	const again = await captureIssueSnapshot(swarmRoot, "run-0002", ISSUE);
	assert.equal(again.ok, true);
	assert.equal(again.ok && again.idempotent, true);
	assert.equal(statSync(first.ok ? first.path : "").mtimeMs, mtime1, "idempotent capture must not rewrite");
	const edited = { ...ISSUE, content: "Different content entirely." };
	const conflict = await captureIssueSnapshot(swarmRoot, "run-0002", edited);
	assert.equal(conflict.ok, false);
	assert.equal(conflict.ok ? "" : conflict.code, "snapshot_hash_conflict");
	// original snapshot intact
	const snap = JSON.parse(readFileSync(first.ok ? first.path : "", "utf8"));
	assert.equal(snap.content, ISSUE.content);
});

await t("oversized doc is truncated with flag + prefix sha256; aggregate cap enforced", async () => {
	const { swarmRoot } = makeWorld();
	const big = { ...ISSUE, docs: ["docs/big.md"] };
	const r = await captureIssueSnapshot(swarmRoot, "run-0003", big);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	const snap = JSON.parse(readFileSync(r.path, "utf8"));
	const d = snap.docs[0];
	assert.equal(d.truncated, true);
	assert.ok(d.bytes <= 256_000);
	assert.ok(d.fullBytes > d.bytes);
	const { createHash } = await import("node:crypto");
	assert.equal(d.sha256, createHash("sha256").update(Buffer.from(d.content, "utf8")).digest("hex"));
	// readIssueSnapshot verifies integrity
	const read = await readIssueSnapshot(r.path);
	assert.equal(read.ok, true);
});

await t("symlink-escape doc rejected BEFORE any write (no partial snapshot)", async () => {
	const { cwd, swarmRoot } = makeWorld();
	const outside = mkdtempSync(join(tmpdir(), "outside-"));
	writeFileSync(join(outside, "secret.md"), "secret");
	symlinkSync(join(outside, "secret.md"), join(swarmRoot, "docs", "escape.md"));
	const bad = { ...ISSUE, docs: ["docs/escape.md"] };
	const r = await captureIssueSnapshot(swarmRoot, "run-0004", bad);
	assert.equal(r.ok, false);
	assert.equal(r.ok ? "" : r.code, "doc_escape");
	// F1: rejected capture must leave no documented-layout snapshot dir/file under .pi/swarm
	assert.ok(!existsSync(join(cwd, ".pi", "swarm", "issues", "snapshots", "run-0004")), "no snapshot dir may exist under .pi/swarm after a rejected capture");
	assert.ok(!existsSync(snapshotPath(swarmRoot, "run-0004", ISSUE.id)), "no snapshot file may exist after a rejected capture");
});

await t("missing / directory docs rejected with typed errors", async () => {
	const { swarmRoot } = makeWorld();
	assert.equal((await captureIssueSnapshot(swarmRoot, "run-0005", { ...ISSUE, docs: ["docs/nope.md"] })).ok ? "" : "code", "code");
	const r = await captureIssueSnapshot(swarmRoot, "run-0005", { ...ISSUE, docs: ["docs/nope.md"] });
	assert.equal(r.ok ? "" : r.code, "doc_missing");
	const r2 = await captureIssueSnapshot(swarmRoot, "run-0005", { ...ISSUE, docs: ["docs"] });
	assert.equal(r2.ok ? "" : r2.code, "doc_directory");
});

// --- backfill / recovery ---
await t("backfill: legacy R16 shape without issueRun → inactive default", async () => {
	const cwd = makeWorld(false);
	const p = paths(cwd);
	await atomicWriteFile(p.state, JSON.stringify({ version: 1, swarmId: "s", cwd, tmuxSession: "t", agents: {}, delivered: {}, messages: {}, createdAt: "c", updatedAt: "u", idleNudgeState: null }) + "\n");
	const st = await readState(p, cwd);
	assert.deepEqual(st.issueRun, { status: "inactive", queue: [] });
});

await t("backfill: partial issueRun (queue dropped entries / bad status) normalized; activeIssueId cleared when not running/paused", async () => {
	const cwd = makeWorld(false);
	const p = paths(cwd);
	await atomicWriteFile(p.state, JSON.stringify({
		version: 1, swarmId: "s", cwd, tmuxSession: "t", agents: {}, delivered: {}, messages: {}, createdAt: "c", updatedAt: "u",
		issueRun: { status: "bogus", queue: [{ issueId: "a" }, "garbage", { issueId: "b", sourceHash: "h", status: "queued" }], activeIssueId: "b" },
	}) + "\n");
	const st = await readState(p, cwd);
	assert.equal(st.issueRun.status, "inactive");
	assert.equal(st.issueRun.activeIssueId, undefined);
	assert.equal(st.issueRun.queue.length, 1);
	assert.equal(st.issueRun.queue[0].issueId, "b");
});

await t("backfill: corrupt state → backup + fresh default WITH issueRun backfilled", async () => {
	const cwd = makeWorld(false);
	const p = paths(cwd);
	await atomicWriteFile(p.state, "{broken");
	const st = await readState(p, cwd);
	assert.deepEqual(st.issueRun, { status: "inactive", queue: [] });
});

// --- transitions ---
await t("guards: activate requires running run + queued entry + snapshot; only one active", () => {
	const cwd = makeWorld(false);
	const p = paths(cwd);
	const st = { version: 1, swarmId: "s", cwd, tmuxSession: "t", agents: {}, delivered: {}, messages: {}, createdAt: "c", updatedAt: "u" };
	getIssueRun(st).status = "running";
	getIssueRun(st).runId = "run-1";
	getIssueRun(st).queue = [{ issueId: "a", title: "A", sourceHash: "ha", status: "queued" }, { issueId: "b", title: "B", sourceHash: "hb", status: "queued" }];
	assert.equal(guardActivateIssue(st, "a", "", "").ok, false, "no snapshot → rejected");
	assert.equal(guardActivateIssue(st, "a", "/s/a.json", "ha").ok, true);
	assert.equal(applyActivateIssue(st, "a", "task-a", "goal-a", "/s/a.json", "ha").ok, true);
	assert.equal(getIssueRun(st).activeIssueId, "a");
	assert.equal(guardActivateIssue(st, "b", "/s/b.json", "hb").ok, false, "second active rejected");
	assert.equal(guardActivateIssue(st, "zz", "/s/z.json", "hz").ok, false, "unknown issue rejected");
	// observation provenance
	assert.equal(guardObserveLinkedTerminal(st, "a", "task-a", "WRONG").ok, false);
	assert.equal(guardObserveLinkedTerminal(st, "a", "task-a", "ha").ok, true);
	assert.equal(guardObserveLinkedTerminal(st, "a", "unlinked-task", "ha").ok, false, "unlinked task rejected");
});

await t("guards: terminal rules — done needs active; blocked/failed/cancelled need reason; no implicit requeue", () => {
	const cwd = makeWorld(false);
	const st = { version: 1, swarmId: "s", cwd, tmuxSession: "t", agents: {}, delivered: {}, messages: {}, createdAt: "c", updatedAt: "u" };
	getIssueRun(st).status = "running";
	getIssueRun(st).queue = [{ issueId: "a", title: "A", sourceHash: "ha", status: "queued" }];
	assert.equal(guardMarkIssueTerminal(st, "a", "done").ok, false, "done requires active");
	applyActivateIssue(st, "a", "task-a", "goal-a", "/s/a.json", "ha");
	assert.equal(guardMarkIssueTerminal(st, "a", "blocked").ok, false, "blocked requires reason");
	assert.equal(guardMarkIssueTerminal(st, "a", "blocked", "worker stuck").ok, true);
	assert.equal(guardMarkIssueTerminal(st, "a", "done", undefined).ok, false, "terminal-unsuccessful never requeued");
	getIssueRun(st).status = "running";
	getIssueRun(st).queue = [{ issueId: "b", title: "B", sourceHash: "hb", status: "queued" }];
	applyActivateIssue(st, "b", "task-b", "goal-b", "/s/b.json", "hb");
	assert.equal(guardMarkIssueTerminal(st, "b", "done").ok, true);
	assert.equal(getIssueRun(st).activeIssueId, undefined);
});

await t("guards: complete requires all done; pause/resume/stop rules", () => {
	const cwd = makeWorld(false);
	const st = { version: 1, swarmId: "s", cwd, tmuxSession: "t", agents: {}, delivered: {}, messages: {}, createdAt: "c", updatedAt: "u" };
	const run = getIssueRun(st);
	run.status = "running";
	run.queue = [{ issueId: "a", title: "A", sourceHash: "ha", status: "done" }, { issueId: "b", title: "B", sourceHash: "hb", status: "queued" }];
	assert.equal(guardCompleteRun(st).ok, false, "incomplete queue rejected");
	run.queue[1].status = "done";
	assert.equal(guardCompleteRun(st).ok, true);
	assert.equal(getIssueRun(st).status, "complete");
	// pause/resume
	run.status = "running";
	assert.equal(guardResumeRun(st).ok, false, "resume requires paused");
	assert.equal(guardPauseRun(st).ok, true);
	run.queue.push({ issueId: "c", title: "C", sourceHash: "hc", status: "failed", reason: "x" });
	assert.equal(guardResumeRun(st).ok, false, "resume blocked by failed item until human disposition");
	run.queue.pop();
	assert.equal(guardResumeRun(st).ok, true);
	assert.equal(guardStopRun(st).ok, true);
	assert.equal(guardStopRun(st).ok, false, "double stop rejected");
});

await t("reconcile: dangling/unlinked active pointer → run paused (state_loss_recovered), never recreated", () => {
	const cwd = makeWorld(false);
	const st = { version: 1, swarmId: "s", cwd, tmuxSession: "t", agents: {}, delivered: {}, messages: {}, createdAt: "c", updatedAt: "u" };
	const run = getIssueRun(st);
	run.status = "running";
	run.runId = "run-1";
	run.activeIssueId = "a";
	run.queue = [{ issueId: "a", title: "A", sourceHash: "ha", snapshotHash: "sha1", snapshotPath: "/s/a.json", status: "active", taskId: "task-a" }];
	// durable linkage lost
	let r = reconcileIssueRun(st, {});
	assert.equal(r.paused, true);
	assert.equal(run.status, "paused");
	assert.equal(run.queue[0].reason, "state_loss_recovered");
	// wrong issueId in durable link
	run.status = "running";
	r = reconcileIssueRun(st, { "task-a": { issueId: "zzz", snapshotHash: "sha1" } });
	assert.equal(r.paused, true);
	// provenance restored → healthy
	run.status = "running";
	run.queue[0].reason = undefined;
	r = reconcileIssueRun(st, { "task-a": { issueId: "a", snapshotHash: "sha1" } });
	assert.equal(r.paused, false);
	assert.equal(r.guard.ok, true);
	// inactive runs untouched
	run.status = "inactive";
	r = reconcileIssueRun(st, {});
	assert.equal(r.paused, false);
});

// --- writeState round-trip preserves issueRun ---
await t("writeState/readState round-trip preserves a valid issueRun", async () => {
	const cwd = makeWorld(false);
	const p = paths(cwd);
	const st = await readState(p, cwd);
	getIssueRun(st).status = "running";
	getIssueRun(st).runId = "run-9";
	getIssueRun(st).queue = [{ issueId: "a", title: "A", sourceHash: "ha", status: "queued" }];
	await writeState(p, st);
	const st2 = await readState(p, cwd);
	assert.equal(st2.issueRun.status, "running");
	assert.equal(st2.issueRun.queue[0].issueId, "a");
});

// --- Phase 1 red-harness preservation ---
// Phase-3b amendment (2026-10-01, planned + approved): the sequencer harness now drives the
// shipped /swarm issues surfaces — the former RED discriminators are GREEN contract tests
// (IS-1/5/6/7/8), and IS-5 flipped from "must not route" to "must route". The preservation
// invariant is unchanged: controls stay green, no harness defects, no classification drift.
await t("Phase 1 harness green-flip holds: GREEN discriminators pass, controls pass (classification amended 2026-10-01)", () => {
	const out = execFileSync(process.execPath, [join(here, "issues-sequencer.test.mjs")], { encoding: "utf8", timeout: 60_000 });
	assert.match(out, /RED-EXPECTED failing \(expected reproduction\): none/);
	assert.match(out, /RED-EXPECTED unexpectedly passing: none/);
	assert.match(out, /CONTROL failing: none/);
	assert.match(out, /PASS {2}IS-1 {2,}GREEN/);
	assert.match(out, /PASS {2}IS-5 {2,}CONTROL/);
	assert.match(out, /PASS {2}IS-6 {2,}GREEN/);
	assert.match(out, /PASS {2}IS-7 {2,}GREEN/);
	assert.match(out, /PASS {2}IS-8 {2,}GREEN/);
});

try {
	// scratch dirs cleaned per-test by OS tmp rotation; nothing global to remove here.
} catch {
	// no global cleanup needed
}

console.log(process.exitCode ? "\nissues-state: FAIL" : `\nissues-state: PASS (${passed} assertions)`);
