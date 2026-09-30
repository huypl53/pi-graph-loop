#!/usr/bin/env node
/**
 * swarm-issues Phase 4 — script parity / zero-mutation / viewer suite.
 *
 * Contract (plan §8.2): the two skill scripts are read-only; the validator shares the
 * canonical implementation (parity with direct validateIssuesSource --json); exit codes
 * 0/1/2 per contract; the viewer is linkage-derived, hash-verified, compact by default,
 * --full bounded, --json, plain no-active report.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = join(here, "..");
const src = join(extRoot, "src");
const VALIDATOR = join(extRoot, "issue-skills", "swarm-issues", "scripts", "validate-issues.mjs");
const VIEWER = join(extRoot, "issue-skills", "swarm-issues", "scripts", "show-active-issue.mjs");
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";

const { paths, readState, writeState, ensureDirs } = await import(join(src, "state.ts"));
const { captureIssueSnapshot } = await import(join(src, "issues", "snapshot.ts"));
const { validateIssuesSource } = await import(join(src, "issues", "source.ts"));

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

function runScript(script, args, cwd) {
	try {
		const out = execFileSync(process.execPath, [script, ...args], { encoding: "utf8", cwd, timeout: 30_000 });
		return { code: 0, out };
	} catch (err) {
		return { code: err.status ?? 1, out: String(err.stdout ?? "") + String(err.stderr ?? "") };
	}
}

function seedProject(yaml, withDocs = true) {
	const cwd = mkdtempSync(join(tmpdir(), "issues-scr-"));
	mkdirSync(join(cwd, ".pi", "swarm"), { recursive: true });
	if (withDocs) {
		mkdirSync(join(cwd, "docs"), { recursive: true });
		writeFileSync(join(cwd, "docs", "one.md"), "doc one\n");
	}
	writeFileSync(join(cwd, "issues.yml"), yaml);
	return cwd;
}

const VALID = "issues:\n  - id: fix-one\n    title: One\n    content: do one\n    docs:\n      - docs/one.md\n";

// --- validator: exit codes + outputs ---
await t("validator: valid source → exit 0, human output, zero mutation", async () => {
	const cwd = seedProject(VALID);
	const before = readFileSync(join(cwd, "issues.yml"), "utf8") + "|" + (existsState(cwd) ?? "");
	const r = runScript(VALIDATOR, [], cwd);
	assert.equal(r.code, 0, `exit ${r.code}: ${r.out}`);
	assert.match(r.out, /valid: 1 issue/);
	const after = readFileSync(join(cwd, "issues.yml"), "utf8") + "|" + (existsState(cwd) ?? "");
	assert.equal(before, after, "zero mutation required");
	rmSync(cwd, { recursive: true, force: true });
});
function existsState(cwd) {
	try {
		return readFileSync(join(cwd, ".pi", "swarm", "swarm-state.json"), "utf8");
	} catch {
		return null;
	}
}

await t("validator: broken schema → exit 1 + typed errors; --json matches canonical validateIssuesSource", async () => {
	const cwd = seedProject("issues:\n  - id: BAD\n");
	const r = runScript(VALIDATOR, ["--json"], cwd);
	assert.equal(r.code, 1);
	const parsed = JSON.parse(r.out);
	const canonical = validateIssuesSource("issues:\n  - id: BAD\n");
	assert.equal(parsed.ok, false);
	assert.deepEqual(
		parsed.errors.map((e) => e.code),
		canonical.errors.map((e) => e.code),
		"script errors must match the canonical implementation exactly (parity)",
	);
	rmSync(cwd, { recursive: true, force: true });
});

await t("validator: missing source → exit 2", async () => {
	const cwd = seedProject(VALID);
	const r = runScript(VALIDATOR, ["--source", join(cwd, "nope.yml")], cwd);
	assert.equal(r.code, 2, `exit ${r.code}`);
	rmSync(cwd, { recursive: true, force: true });
});

await t("validator: doc problems are warnings by default, hard under --strict", async () => {
	const cwd = seedProject("issues:\n  - id: fix-one\n    title: One\n    content: do one\n    docs:\n      - docs/gone.md\n");
	const soft = runScript(VALIDATOR, [], cwd);
	assert.equal(soft.code, 0, "non-strict: doc problems warn");
	assert.match(soft.out, /doc problem/);
	const strictRun = runScript(VALIDATOR, ["--strict"], cwd);
	assert.equal(strictRun.code, 1, "strict: doc problems fail");
	rmSync(cwd, { recursive: true, force: true });
});

await t("validator: escaped/absolute doc rejected by pure classifier without fs", async () => {
	const cwd = seedProject("issues:\n  - id: fix-one\n    title: One\n    content: do one\n    docs:\n      - ../outside.md\n");
	const strictRun = runScript(VALIDATOR, ["--strict"], cwd);
	assert.equal(strictRun.code, 1);
	assert.match(strictRun.out, /doc_traversal/);
	rmSync(cwd, { recursive: true, force: true });
});

// --- viewer: no-active, compact, --json, --full, hash mismatch ---
await t("viewer: no state / no active issue → plain report, exit 0", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "issues-scr-"));
	let r = runScript(VIEWER, [], cwd);
	assert.equal(r.code, 0);
	assert.match(r.out, /no active issue/);
	mkdirSync(join(cwd, ".pi", "swarm"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "swarm", "swarm-state.json"), JSON.stringify({ version: 1, agents: {} }));
	r = runScript(VIEWER, ["--json"], cwd);
	assert.equal(r.code, 0);
	assert.equal(JSON.parse(r.out).active, false);
	rmSync(cwd, { recursive: true, force: true });
});

function seedActiveWorld(cwd, { corruptHash = false } = {}) {
	const p = paths(cwd);
	return (async () => {
		await ensureDirs(p);
		const ISSUE = { id: "fix-one", title: "One", content: "do one", docs: [] };
		const snap = await captureIssueSnapshot(p.root, "run-v1", ISSUE, "run-v1", cwd);
		const st = await readState(p, cwd);
		st.issueRun = {
			status: "running", runId: "run-v1", activeIssueId: "fix-one",
			queue: [{ issueId: "fix-one", title: "One", sourceHash: "h", status: "active", taskId: "task-x", snapshotPath: snap.path, snapshotHash: corruptHash ? "deadbeef" + snap.snapshotHash.slice(8) : snap.snapshotHash }],
		};
		await writeState(p, st);
		return snap;
	})();
}

await t("viewer: compact default, --json shape, --full bounded", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "issues-scr-"));
	mkdirSync(join(cwd, ".pi", "swarm"), { recursive: true });
	await seedActiveWorld(cwd);
	const compact = runScript(VIEWER, [], cwd);
	assert.equal(compact.code, 0);
	assert.match(compact.out, /active issue: fix-one — One/);
	assert.doesNotMatch(compact.out, /"content"/, "compact mode must not dump snapshot content");
	const json = runScript(VIEWER, ["--json"], cwd);
	assert.equal(JSON.parse(json.out).active, true);
	assert.equal(JSON.parse(json.out).issue.id, "fix-one");
	const full = runScript(VIEWER, ["--full"], cwd);
	assert.match(full.out, /---snapshot---/);
	assert.match(full.out, /"content"/, "--full shows the bounded snapshot");
	rmSync(cwd, { recursive: true, force: true });
});

await t("viewer: hash mismatch refuses to render (stale-snapshot fence), exit 1", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "issues-scr-"));
	mkdirSync(join(cwd, ".pi", "swarm"), { recursive: true });
	await seedActiveWorld(cwd, { corruptHash: true });
	const r = runScript(VIEWER, [], cwd);
	assert.equal(r.code, 1);
	assert.match(r.out, /hash mismatch/);
	rmSync(cwd, { recursive: true, force: true });
});

// --- P2 fix (phase-04-fix): oversize truncation must never re-parse the sliced body ---
// RED FIRST: a snapshot whose JSON string straddles the MAX_SNAPSHOT_BYTES slice boundary
// used to crash with an uncaught SyntaxError (JSON.parse of a mid-string-literal slice).
const CAP = 1_000_000;
function seedOversizeSnapshot(cwd) {
	const p = paths(cwd);
	return (async () => {
		await ensureDirs(p);
		// content sized so JSON.stringify(snap,null,2) exceeds the cap and the slice lands
		// inside the content string literal (no whitespace near the cap)
		const filler = "A".repeat(CAP);
		const ISSUE = { id: "big-one", title: "Big", content: `start-${filler}-end`, docs: [] };
		const snap = await captureIssueSnapshot(p.root, "run-big", ISSUE, "run-big", cwd);
		const st = await readState(p, cwd);
		st.issueRun = {
			status: "running", runId: "run-big", activeIssueId: "big-one",
			queue: [{ issueId: "big-one", title: "Big", sourceHash: "h", status: "active", taskId: "task-big", snapshotPath: snap.path, snapshotHash: snap.snapshotHash }],
		};
		await writeState(p, st);
		return snap;
	})();
}

await t("viewer P2: oversize --full renders truncated verbatim WITHOUT re-parse (no SyntaxError)", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "issues-scr-"));
	mkdirSync(join(cwd, ".pi", "swarm"), { recursive: true });
	await seedOversizeSnapshot(cwd);
	const r = runScript(VIEWER, ["--full"], cwd);
	assert.equal(r.code, 0, `expected exit 0, got ${r.code}. Output tail: ${r.out.slice(-200)}`);
	assert.match(r.out, /truncated/);
	assert.match(r.out, /---snapshot---/);
	const rendered = r.out.split("---snapshot---")[1] ?? "";
	assert.ok(Buffer.byteLength(rendered) <= CAP + 4096, "rendered snapshot must be bounded at the cap");
	rmSync(cwd, { recursive: true, force: true });
});

await t("viewer P2: oversize --json emits metadata + raw sliced text, never re-parsed", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "issues-scr-"));
	mkdirSync(join(cwd, ".pi", "swarm"), { recursive: true });
	await seedOversizeSnapshot(cwd);
	const r = runScript(VIEWER, ["--json", "--full"], cwd);
	assert.equal(r.code, 0, `expected exit 0, got ${r.code}. Output tail: ${r.out.slice(-200)}`);
	// the payload is ~1MB; don't JSON.parse the whole stdout (runner buffers truncate it) —
	// assert the wrapper shape on the head and the raw-text field's boundedness on the tail.
	assert.match(r.out, /^\{[\s\S]*"active": true/);
	assert.match(r.out, /"truncated": true/, "must report truncation metadata");
	assert.match(r.out, /"snapshotText": "/, "oversize snapshot must ship as raw sliced TEXT, not a re-parsed object");
	assert.ok(Buffer.byteLength(r.out) < CAP + 8192, "total stdout must stay bounded near the cap");
	rmSync(cwd, { recursive: true, force: true });
});

await t("viewer P2: any snapshot size exits cleanly (small snapshot unaffected)", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "issues-scr-"));
	mkdirSync(join(cwd, ".pi", "swarm"), { recursive: true });
	await seedActiveWorld(cwd);
	for (const args of [["--full"], ["--json", "--full"], []]) {
		const r = runScript(VIEWER, args, cwd);
		assert.equal(r.code, 0, `args=${args.join(" ")} exit ${r.code}`);
	}
	rmSync(cwd, { recursive: true, force: true });
});

console.log(process.exitCode ? "\nswarm-issues-scripts: FAIL" : `\nswarm-issues-scripts: PASS (${passed})`);
