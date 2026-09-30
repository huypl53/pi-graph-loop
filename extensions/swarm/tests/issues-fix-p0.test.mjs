#!/usr/bin/env node
/**
 * swarm-issues Phase 3b FIX — red-first reproductions (reproduce-first mandate 2026-08-31).
 *
 * P0-A RED: a linked task reaching terminal status with NO explicit observeLinkedTaskLocked
 *   call must still be observed/advanced by the PRODUCTION pump tick
 *   (runPumpMaintenancePhasesLocked — the plan's reconcileIssueRunTick design). Today no
 *   pump phase references issues → run stays running with a done task and stale active issue.
 * P0-B RED: after blocked → abandon → resume, the run flips to running but the next queued
 *   issue is never activated (resume only flips status). Expected: resume advances.
 * P1: (covered in issues-pump-notice.test.mjs) — real isActionableRootMessage classifier.
 *
 * Exit: nonzero while the P0s are red; green after the fix (this file becomes the regression test).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
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
const { deliverMessageLocked } = await import(join(src, "mailbox.ts"));
const { runPumpMaintenancePhasesLocked } = await import(join(src, "surface", "pump-phases.ts"));

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
	const cwd = mkdtempSync(join(tmpdir(), "issues-fix-"));
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

const uiQuiet = { cwd: "", ui: { notify: () => {} } };
const realDeps = { deliverMessageLocked };

// --- P0-A repro: pump tick observes + advances a linked-done task WITHOUT explicit observe call ---
await t("P0-A: pump tick (runPumpMaintenancePhasesLocked) advances a linked-done issue", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	let st = await readState(p, cwd);
	let run = getIssueRun(st);
	assert.equal(run.activeIssueId, "fix-one", "sanity: fix-one active after start");
	// The linked task graph reaches terminal done on disk (production shape: worker flips node/task).
	const tp = join(cwd, ".pi", "swarm", "tasks", run.queue[0].taskId, "task.json");
	const task = JSON.parse(readFileSync(tp, "utf8"));
	assert.ok(task, "sanity: linked task.json exists");
	task.status = "done";
	for (const n of Object.values(task.nodes ?? {})) n.status = "done";
	task.updatedAt = new Date().toISOString();
	writeFileSync(tp, JSON.stringify(task, null, 2) + "\n");
	// PRODUCTION PATH ONLY: one pump maintenance tick (no explicit observe call).
	await runPumpMaintenancePhasesLocked({}, { cwd, isIdle: () => true }, p, st, Date.now(), "p0a-red");
	await writeState(p, st);
	const run2 = getIssueRun(await readState(p, cwd));
	const doneCount = run2.queue.filter((q) => q.status === "done").length;
	const activeCount = run2.queue.filter((q) => q.status === "active").length;
	assert.equal(
		run2.status === "running" && doneCount === 1 && activeCount === 1 && run2.activeIssueId === "fix-two",
		true,
		`pump tick must observe done + activate fix-two (got status=${run2.status} done=${doneCount} active=${activeCount} activeId=${run2.activeIssueId})`,
	);
	rmSync(cwd, { recursive: true, force: true });
});

// --- P0-A freeze leg: pump tick pauses on blocked and stays silent for the later issue ---
await t("P0-A: pump tick pauses run on linked blocked; later issue untouched", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	let st = await readState(p, cwd);
	let run = getIssueRun(st);
	const tp = join(cwd, ".pi", "swarm", "tasks", run.queue[0].taskId, "task.json");
	const task = JSON.parse(readFileSync(tp, "utf8"));
	task.status = "blocked";
	for (const n of Object.values(task.nodes ?? {})) n.status = "blocked";
	task.updatedAt = new Date().toISOString();
	writeFileSync(tp, JSON.stringify(task, null, 2) + "\n");
	await runPumpMaintenancePhasesLocked({}, { cwd, isIdle: () => true }, p, st, Date.now(), "p0a-red-freeze");
	await writeState(p, st);
	const run2 = getIssueRun(await readState(p, cwd));
	assert.equal(run2.status, "paused", "run paused by pump tick");
	assert.equal(run2.queue[0].status, "blocked", "issue blocked");
	assert.equal(run2.queue[1].status, "queued", "later issue untouched (freeze)");
	rmSync(cwd, { recursive: true, force: true });
});

// --- P0-B repro: abandon → resume must advance to the next queued issue ---
await t("P0-B: resume after abandon activates the next queued issue", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const ctx = { cwd, ui: { notify: () => {} } };
	await handleIssuesCommand("issues", ["start"], ctx, p, {});
	let st = await readState(p, cwd);
	let run = getIssueRun(st);
	// drive the linked task terminal-blocked via the real controller observation path first
	// (abandon correctly refuses non-terminal-unsuccessful entries)
	const { observeLinkedTaskLocked } = await import(join(src, "issues", "controller.ts"));
	await observeLinkedTaskLocked(p, { cwd }, st, { taskId: run.queue[0].taskId, status: "blocked" }, realDeps);
	// blocked via the real controller observation (production observation path), then human abandon
	await handleIssuesCommand("issues", ["abandon", "fix-one", "human disposition: redo"], ctx, p, {});
	// guardResumeRun requires the terminal-unsuccessful entry to be disposed first — abandon did it
	await handleIssuesCommand("issues", ["resume"], ctx, p, {});
	const run2 = getIssueRun(await readState(p, cwd));
	assert.equal(
		run2.status === "running" && run2.activeIssueId === "fix-two" && run2.queue[1].status === "active",
		true,
		`resume must advance to fix-two (got status=${run2.status} activeId=${run2.activeIssueId} q1=${run2.queue[1].status})`,
	);
	rmSync(cwd, { recursive: true, force: true });
});

console.log(process.exitCode ? "\nissues-fix-p0: FAIL (red — as expected pre-fix)" : `\nissues-fix-p0: PASS (${passed})`);
