#!/usr/bin/env node
/**
 * swarm-issues Phase 3b FIX — P1: issue root notices at the REAL pump classifier boundary.
 *
 * The controller delivers activation/terminal notices as durable mailbox records to root.
 * The visible-surface path runs the REAL `isActionableRootMessage` classifier (surface/
 * actionable.ts) on those records. This test asserts at that real boundary:
 *   1. an issue activation notice (fresh, unacked, to root) is actionable → surfaces;
 *   2. an acked/copy of the same record is not actionable (dedupe by receipt);
 *   3. during a frozen (paused) run, the notice for the TERMINAL issue surfaces but a
 *      later queued issue produces no notice at all (freeze silence holds at L3).
 * No stubs — records come from the real deliverMessageLocked append, classified by the
 * real predicate with the same taskIndex shape the pump builds.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";

const { paths, readState, writeState, ensureDirs } = await import(join(src, "state.ts"));
const { getIssueRun } = await import(join(src, "issues", "state.ts"));
const { handleIssuesCommand } = await import(join(src, "commands", "issues.ts"));
const { observeLinkedTaskLocked } = await import(join(src, "issues", "controller.ts"));
const { deliverMessageLocked } = await import(join(src, "mailbox.ts"));
const { mailboxPath } = await import(join(src, "state.ts"));
const { isActionableRootMessage } = await import(join(src, "surface", "actionable.ts"));

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

function seedWorld() {
	const cwd = mkdtempSync(join(tmpdir(), "issues-p1-"));
	for (const d of ["traces", "mailboxes", "tasks"]) mkdirSync(join(cwd, ".pi", "swarm", d), { recursive: true });
	mkdirSync(join(cwd, "docs"), { recursive: true });
	writeFileSync(join(cwd, "docs", "one.md"), "doc one\n");
	writeFileSync(join(cwd, "docs", "two.md"), "doc two\n");
	writeFileSync(
		join(cwd, ".pi", "swarm", "issues.yml"),
		"issues:\n  - id: fix-one\n    title: One\n    content: do one\n    docs:\n      - docs/one.md\n  - id: fix-two\n    title: Two\n    content: do two\n    docs:\n      - docs/two.md\n",
	);
	return cwd;
}

function readMailboxRecords(p) {
	try {
		return readFileSync(mailboxPath(p, "root"), "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

// Build a minimal pump-shaped taskIndex (empty: issue notices are not task-scoped).
const taskIndex = {};

await t("P1: activation notice for the active issue is actionable at the real classifier", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const ctx = { cwd, ui: { notify: () => {} } };
	await handleIssuesCommand("issues", ["start"], ctx, p, {});
	const runId = getIssueRun(await readState(p, cwd)).runId;
	const recs = readMailboxRecords(p).filter((r) => r.idempotencyKey === `issues-activate:${runId}:fix-one`);
	assert.equal(recs.length, 1, "exactly one durable activation notice");
	const rec = recs[0];
	const verdict = isActionableRootMessage(rec, taskIndex, Date.now(), {}, false, p);
	assert.equal(verdict.ok, true, `activation notice must surface (reason=${verdict.reason})`);
	rmSync(cwd, { recursive: true, force: true });
});

await t("P1: acked activation notice is not actionable (surface dedupe)", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const ctx = { cwd, ui: { notify: () => {} } };
	await handleIssuesCommand("issues", ["start"], ctx, p, {});
	const rec = readMailboxRecords(p).find((r) => String(r.idempotencyKey || "").startsWith("issues-activate:"));
	const acked = { ...rec, ackedAt: new Date().toISOString() };
	const verdict = isActionableRootMessage(acked, taskIndex, Date.now(), {}, false, p);
	assert.equal(verdict.ok, false, "acked notice must not re-surface");
	assert.equal(verdict.reason, "acked");
	rmSync(cwd, { recursive: true, force: true });
});

await t("P1: freeze silence at L3 — terminal notice surfaces, later issue emits nothing", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const ctx = { cwd, ui: { notify: () => {} } };
	await handleIssuesCommand("issues", ["start"], ctx, p, {});
	let st = await readState(p, cwd);
	let run = getIssueRun(st);
	await observeLinkedTaskLocked(p, { cwd }, st, { taskId: run.queue[0].taskId, status: "blocked" }, { deliverMessageLocked });
	await writeState(p, st);
	const recs = readMailboxRecords(p);
	const terminal = recs.filter((r) => String(r.idempotencyKey || "").startsWith("issues-terminal:"));
	assert.equal(terminal.length, 1, "exactly one terminal notice");
	const verdict = isActionableRootMessage(terminal[0], taskIndex, Date.now(), {}, false, p);
	assert.equal(verdict.ok, true, `terminal notice surfaces (reason=${verdict.reason})`);
	// freeze silence: no notice keyed to the LATER issue (fix-two) exists at all
	const laterNotices = recs.filter((r) => String(r.idempotencyKey || "").includes(":fix-two"));
	assert.equal(laterNotices.length, 0, "frozen run emits nothing for the later issue");
	rmSync(cwd, { recursive: true, force: true });
});

// R-NOTICE — Phase-5 revert-only RED control (plan §1): revert = classifier drops
// failure/blocked reasons (only plain text actionable). Under the revert the terminal
// failure/blocked notice does not surface to root — the control detects the dropped notice.
await t("R-NOTICE (RED control): terminal blocked/failure notice is actionable at the real classifier", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const ctx = { cwd, ui: { notify: () => {} } };
	await handleIssuesCommand("issues", ["start"], ctx, p, {});
	const st = await readState(p, cwd);
	const run = getIssueRun(st);
	await observeLinkedTaskLocked(p, { cwd }, st, { taskId: run.queue[0].taskId, status: "blocked" }, { deliverMessageLocked });
	await writeState(p, st);
	const recs = readMailboxRecords(p);
	const terminal = recs.filter((r) => String(r.idempotencyKey || "").startsWith("issues-terminal:"));
	assert.equal(terminal.length, 1, "terminal notice delivered");
	const verdict = isActionableRootMessage(terminal[0], taskIndex, Date.now(), {}, false, p);
	assert.equal(verdict.ok, true, `blocked notice must surface to root (reason=${verdict.reason})`);
	rmSync(cwd, { recursive: true, force: true });
});

console.log(process.exitCode ? "\nissues-pump-notice: FAIL" : `\nissues-pump-notice: PASS (${passed})`);
