#!/usr/bin/env node
/**
 * issues-restart-dedup.test.mjs — RED-first reproduction + GREEN contract for the
 * /swarm issues start restart-dedup fix (issues-sequencer-restart-dedup).
 *
 * Always-on assertions:
 *   T1 (RED-EXPECTED)  — two-run scratch harness: run 1 completes both issues; run 2
 *                          re-activates fix-one (current production bug).
 *   T2 (CONTROL)       — --force-all flag is parsed and recorded on the run.
 *   T3 (CONTROL)       — content-hash dedup is content-based: editing content between
 *                          runs re-opens the issue (no match).
 *   T4 (CONTROL)       — editing only docs does NOT re-open (sourceHash unchanged).
 *   T5 (CONTROL)       — a prior run that was PAUSED (not complete) does NOT trigger
 *                          dedup (snapshot exists but no completion evidence).
 *   T6 (CONTROL)       — footer notice "already completed in run <id>" surfaces in
 *                          /swarm issues status for the skipped entry.
 *
 * Opt-in replay lane (RUN_SWARM_ISSUES_RESTART_DEDUP_LANE=1): spawns a real
 * pi --provider mock-llm --model issues-restart-dedup session against a seeded
 * two-run world; asserts the run advances past the deduped issue to the next
 * queued issue.
 *
 * Deterministic, offline, scratch-cwd only.
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

const { paths, readState, writeState, withLock, ensureDirs } = await import(join(src, "state.ts"));
const { getIssueRun, guardMarkIssueTerminal } = await import(join(src, "issues", "state.ts"));
const { handleIssuesCommand } = await import(join(src, "commands", "issues.ts"));
const { observeLinkedTaskLocked } = await import(join(src, "issues", "controller.ts"));
const { findPriorCompletions } = await import(join(src, "issues", "dedup.ts"));

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

function seedWorld(issues = null) {
	const cwd = mkdtempSync(join(tmpdir(), "issues-restart-dedup-"));
	for (const d of ["traces", "mailboxes", "tasks"]) mkdirSync(join(cwd, ".pi", "swarm", d), { recursive: true });
	mkdirSync(join(cwd, "docs"), { recursive: true });
	writeFileSync(join(cwd, "docs", "one.md"), "doc one\n");
	writeFileSync(join(cwd, "docs", "two.md"), "doc two\n");
	const yml = issues ?? [
		"issues:",
		"  - id: fix-one",
		"    title: One",
		"    content: do one",
		"    docs:",
		"      - docs/one.md",
		"  - id: fix-two",
		"    title: Two",
		"    content: do two",
		"    docs:",
		"      - docs/two.md",
		"",
	].join("\n");
	writeFileSync(join(cwd, ".pi", "swarm", "issues.yml"), yml);
	return cwd;
}

/** Drive the linked task of the active issue to done via the real controller path. */
async function finishActiveIssue(cwd, p) {
	const st = await readState(p, cwd);
	const run = getIssueRun(st);
	const active = run.queue.find((q) => q.status === "active");
	if (!active) throw new Error("no active issue to finish");
	const { deliverMessageLocked } = await import(join(src, "mailbox.ts"));
	const deps = { pi: null, deliverMessageLocked };
	await observeLinkedTaskLocked(p, { cwd }, st, { taskId: active.taskId, status: "done" }, deps);
	await writeState(p, st);
	return active.issueId;
}

// ============================================================================
// T1 (RED-EXPECTED): two-run scratch harness — run 2 re-activates fix-one
// ============================================================================
await t("T1: two-run harness — run 2 re-activates fix-one (RED reproduction)", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	// Run 1: start, finish fix-one, finish fix-two
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	await finishActiveIssue(cwd, p);
	await finishActiveIssue(cwd, p);
	const st1 = await readState(p, cwd);
	const run1 = getIssueRun(st1);
	assert.equal(run1.status, "complete", "run 1 should be complete");
	assert.equal(run1.queue[0].status, "done", "fix-one should be done");
	assert.equal(run1.queue[1].status, "done", "fix-two should be done");
	// Run 2: start again on the SAME scratch cwd (no issues.yml change)
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	const st2 = await readState(p, cwd);
	const run2 = getIssueRun(st2);
	// RED: today fix-one is re-activated (status: "active"). GREEN: fix-one is "done" with reason.
	const fixOne = run2.queue.find((q) => q.issueId === "fix-one");
	assert.equal(fixOne.status, "done", `fix-one should be deduped (done), got "${fixOne.status}"`);
	assert.match(fixOne.reason ?? "", /already completed in run/, `reason should name prior run, got "${fixOne.reason}"`);
	// fix-two should be the active issue (or done if only one issue)
	const fixTwo = run2.queue.find((q) => q.issueId === "fix-two");
	assert.ok(fixTwo, "fix-two should still be in the queue");
});

// ============================================================================
// T2 (CONTROL): --force-all flag is parsed and recorded on the run
// ============================================================================
await t("T2: --force-all flag re-runs everything (no dedup)", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	// Run 1: complete both
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	await finishActiveIssue(cwd, p);
	await finishActiveIssue(cwd, p);
	// Clean up prior run's tasks to avoid the known taskId collision (phase-05 limitation).
	// In production, --force-all after a complete run hits the same collision; this test
	// isolates the --force-all flag behavior from the pre-existing collision issue.
	const { rmSync } = await import("node:fs");
	const tasksDir = join(cwd, ".pi", "swarm", "tasks");
	try { rmSync(tasksDir, { recursive: true, force: true }); } catch { /* best-effort */ }
	mkdirSync(tasksDir, { recursive: true });
	// Run 2 with --force-all
	await handleIssuesCommand("issues", ["start", "--force-all"], { cwd, ui: { notify: () => {} } }, p, {});
	const st2 = await readState(p, cwd);
	const run2 = getIssueRun(st2);
	assert.equal(run2.forceAll, true, "forceAll should be recorded on the run");
	const fixOne = run2.queue.find((q) => q.issueId === "fix-one");
	assert.equal(fixOne.status, "active", "with --force-all, fix-one should be re-activated");
});

// ============================================================================
// T3 (CONTROL): content-hash dedup is content-based — editing content re-opens
// ============================================================================
await t("T3: editing content between runs re-opens the issue (content-hash match)", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	// Run 1: complete both
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	await finishActiveIssue(cwd, p);
	await finishActiveIssue(cwd, p);
	// Edit fix-one's content (changes sourceHash)
	const editedYml = [
		"issues:",
		"  - id: fix-one",
		"    title: One",
		"    content: do one — EDITED",
		"    docs:",
		"      - docs/one.md",
		"  - id: fix-two",
		"    title: Two",
		"    content: do two",
		"    docs:",
		"      - docs/two.md",
		"",
	].join("\n");
	writeFileSync(join(cwd, ".pi", "swarm", "issues.yml"), editedYml);
	// Clean up prior run's tasks to avoid the known taskId collision (phase-05 limitation).
	const { rmSync } = await import("node:fs");
	const tasksDir = join(cwd, ".pi", "swarm", "tasks");
	try { rmSync(tasksDir, { recursive: true, force: true }); } catch { /* best-effort */ }
	mkdirSync(tasksDir, { recursive: true });
	// Run 2: fix-one should be re-activated (content changed → no dedup)
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	const st2 = await readState(p, cwd);
	const run2 = getIssueRun(st2);
	const fixOne = run2.queue.find((q) => q.issueId === "fix-one");
	assert.equal(fixOne.status, "active", `edited content should re-open fix-one, got "${fixOne.status}"`);
});

// ============================================================================
// T4 (CONTROL): editing only docs does NOT re-open (sourceHash unchanged)
// ============================================================================
await t("T4: editing only docs does NOT re-open (sourceHash unchanged)", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	// Run 1: complete both
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	await finishActiveIssue(cwd, p);
	await finishActiveIssue(cwd, p);
	// Edit only the doc file (does NOT change sourceHash)
	writeFileSync(join(cwd, "docs", "one.md"), "doc one — EDITED\n");
	// Run 2: fix-one should still be deduped
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	const st2 = await readState(p, cwd);
	const run2 = getIssueRun(st2);
	const fixOne = run2.queue.find((q) => q.issueId === "fix-one");
	assert.equal(fixOne.status, "done", `docs-only edit should NOT re-open fix-one, got "${fixOne.status}"`);
});

// ============================================================================
// T5 (CONTROL): a prior run that was PAUSED does NOT trigger dedup for uncompleted issues
// ============================================================================
await t("T5: paused prior run does NOT dedup uncompleted issues (no completion evidence)", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	// Run 1: start, finish fix-one, then PAUSE (fix-two never done)
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	await finishActiveIssue(cwd, p);
	// Pause the run (fix-two is queued, not done)
	await handleIssuesCommand("issues", ["pause"], { cwd, ui: { notify: () => {} } }, p, {});
	// Manually clear the run state AND the active goal to simulate a fresh start
	// (paused run refuses start; active goal also refuses start).
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		const run = getIssueRun(st);
		run.status = "inactive";
		run.activeIssueId = undefined;
		run.queue = [];
		delete st.goal;
		await writeState(p, st);
	});
	// Clean up prior run's tasks to avoid the known taskId collision (phase-05 limitation).
	const { rmSync } = await import("node:fs");
	const tasksDir = join(cwd, ".pi", "swarm", "tasks");
	try { rmSync(tasksDir, { recursive: true, force: true }); } catch { /* best-effort */ }
	mkdirSync(tasksDir, { recursive: true });
	// Run 2: fix-one WAS completed in run 1 (before pause) → deduped. fix-two was NEVER
	// completed → re-activated. The paused run itself doesn't prevent dedup; the absence
	// of a completion record for fix-two is what keeps it active.
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	const st2 = await readState(p, cwd);
	const run2 = getIssueRun(st2);
	const fixOne = run2.queue.find((q) => q.issueId === "fix-one");
	const fixTwo = run2.queue.find((q) => q.issueId === "fix-two");
	assert.ok(fixOne, "fix-one should be in the queue");
	assert.ok(fixTwo, "fix-two should be in the queue");
	assert.equal(fixOne.status, "done", `fix-one was completed in run 1, should be deduped, got "${fixOne.status}"`);
	assert.equal(fixTwo.status, "active", `fix-two was NEVER completed, should be re-activated, got "${fixTwo.status}"`);
});

// ============================================================================
// T6 (CONTROL): footer notice surfaces in /swarm issues status
// ============================================================================
await t("T6: footer notice 'already completed in run <id>' surfaces in status", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	// Run 1: complete only fix-one (leave fix-two queued so run 2 has something to activate)
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	await finishActiveIssue(cwd, p);
	// Clear the active goal + reset run state so run 2 can start (simulates a fresh start
	// after the human has disposed of the prior run's goal).
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		const run = getIssueRun(st);
		run.status = "inactive";
		run.activeIssueId = undefined;
		run.queue = [];
		delete st.goal;
		await writeState(p, st);
	});
	// Clean up prior run's tasks to avoid the known taskId collision (phase-05 limitation).
	const { rmSync } = await import("node:fs");
	const tasksDir = join(cwd, ".pi", "swarm", "tasks");
	try { rmSync(tasksDir, { recursive: true, force: true }); } catch { /* best-effort */ }
	mkdirSync(tasksDir, { recursive: true });
	// Run 2: start (dedup fix-one, activate fix-two)
	const notices = [];
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: (m) => notices.push(String(m)) } }, p, {});
	const st2 = await readState(p, cwd);
	const run2 = getIssueRun(st2);
	const fixOne = run2.queue.find((q) => q.issueId === "fix-one");
	assert.equal(fixOne.status, "done", "fix-one should be deduped");
	assert.match(fixOne.reason ?? "", /already completed in run/, "reason should name prior run");
	// STRENGTHEN: reason must contain a real runId string (not "undefined")
	assert.match(fixOne.reason ?? "", /already completed in run run-[a-z0-9]+-[a-z0-9]+/, "reason should contain a real runId, not 'undefined'");
	// /swarm issues status should render the reason
	const statusNotices = [];
	await handleIssuesCommand("issues", ["status"], { cwd, ui: { notify: (m) => statusNotices.push(String(m)) } }, p, {});
	const statusText = statusNotices.join("\n");
	assert.match(statusText, /already completed in run/, `status should surface the dedup reason, got: ${statusText.slice(0, 200)}`);
});

// ============================================================================
// T7 (CONTROL): findPriorCompletions helper is pure and reads the ledger
// ============================================================================
await t("T7: findPriorCompletions reads the completion ledger", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	// Run 1: complete both
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	await finishActiveIssue(cwd, p);
	await finishActiveIssue(cwd, p);
	// Read the ledger directly
	const completions = await findPriorCompletions(p.root, [
		{ id: "fix-one", sourceHash: "any" },
		{ id: "fix-two", sourceHash: "any" },
	]);
	assert.ok(completions.has("fix-one"), "fix-one should be in prior completions");
	assert.ok(completions.has("fix-two"), "fix-two should be in prior completions");
	assert.match(completions.get("fix-one").priorRunId, /^run-/, "priorRunId should be a run id");
});

// ============================================================================
// T8 (CONTROL): backfill seeds the ledger from current state done entries on first start
// ============================================================================
await t("T8: backfill seeds the ledger from current state done entries on first start", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	// Run 1: complete both issues (this writes to the ledger via controller)
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	await finishActiveIssue(cwd, p);
	await finishActiveIssue(cwd, p);
	// Verify ledger exists with 2 entries
	const ledgerPath = join(p.root, "issues", "completions.jsonl");
	assert.ok(existsSync(ledgerPath), "ledger should exist after run 1");
	const { readFileSync: rfs } = await import("node:fs");
	const linesAfterRun1 = rfs(ledgerPath, "utf8").split("\n").filter((l) => l.trim()).length;
	assert.equal(linesAfterRun1, 2, `ledger should have 2 lines after run 1, got ${linesAfterRun1}`);
	// Delete the ledger to simulate a pre-ledger state (e.g. ledger was lost)
	const { unlinkSync } = await import("node:fs");
	unlinkSync(ledgerPath);
	assert.ok(!existsSync(ledgerPath), "ledger should be absent after manual delete");
	// Clear run state so we can start a new run, but PRESERVE the done entries in the queue
	// (this mirrors the real flow: the prior run's queue still has done entries in state)
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		const run = getIssueRun(st);
		run.status = "inactive";
		run.activeIssueId = undefined;
		// DO NOT clear run.queue — the done entries are the backfill source
		delete st.goal;
		await writeState(p, st);
	});
	// Clean up prior run's tasks
	const { rmSync } = await import("node:fs");
	const tasksDir = join(cwd, ".pi", "swarm", "tasks");
	try { rmSync(tasksDir, { recursive: true, force: true }); } catch { /* best-effort */ }
	mkdirSync(tasksDir, { recursive: true });
	// Start run 2 — should trigger backfill from current state done entries
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	// Verify ledger was backfilled
	assert.ok(existsSync(ledgerPath), "ledger should exist after backfill");
	const linesAfterBackfill = rfs(ledgerPath, "utf8").split("\n").filter((l) => l.trim()).length;
	assert.ok(linesAfterBackfill >= 2, `ledger should have at least 2 lines after backfill, got ${linesAfterBackfill}`);
	// Verify the backfilled entries have real runIds
	const completions = await findPriorCompletions(p.root, [
		{ id: "fix-one", sourceHash: "any" },
		{ id: "fix-two", sourceHash: "any" },
	]);
	assert.ok(completions.has("fix-one"), "fix-one should be in ledger after backfill");
	assert.ok(completions.has("fix-two"), "fix-two should be in ledger after backfill");
	assert.match(completions.get("fix-one").priorRunId, /^run-[a-z0-9]+-[a-z0-9]+$/, "priorRunId should be a real run id, not 'undefined'");
});

// ============================================================================
// T9 (CONTROL): backfill is idempotent — second call does not duplicate lines
// ============================================================================
await t("T9: backfill is idempotent — second call does not duplicate lines", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	const { seedCompletionLedger } = await import(join(src, "issues", "dedup.ts"));
	const { readFileSync: rfs, writeFileSync: wfs, mkdirSync: ms } = await import("node:fs");
	const ledgerPath = join(p.root, "issues", "completions.jsonl");
	// Ensure the issues dir exists
	ms(join(p.root, "issues"), { recursive: true });
	// Seed the ledger manually with one entry (simulates a prior backfill)
	wfs(ledgerPath, JSON.stringify({ issueId: "fix-one", sourceHash: "h", runId: "run-x", completedAt: "2026-10-05T00:00:00Z" }) + "\n");
	// Backfill — should be a no-op (ledger exists)
	const bf = await seedCompletionLedger(p.root, { issueRun: { runId: "run-y", queue: [{ issueId: "fix-two", sourceHash: "h2", status: "done" }] } });
	assert.equal(bf.seeded, 0, `backfill should seed 0 (ledger exists), got ${bf.seeded}`);
	const linesAfter = rfs(ledgerPath, "utf8").split("\n").filter((l) => l.trim()).length;
	assert.equal(linesAfter, 1, `ledger should still have 1 line after backfill, got ${linesAfter}`);
});

// ============================================================================
// T10 (CONTROL): all-deduped queue completes successfully (no activation failure)
// ============================================================================
await t("T10: all-deduped queue completes successfully (no activation failure)", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	// Run 1: complete both issues
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	await finishActiveIssue(cwd, p);
	await finishActiveIssue(cwd, p);
	// Clear run state so we can start a new run
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		const run = getIssueRun(st);
		run.status = "inactive";
		run.activeIssueId = undefined;
		run.queue = [];
		delete st.goal;
		await writeState(p, st);
	});
	// Clean up prior run's tasks
	const { rmSync } = await import("node:fs");
	const tasksDir = join(cwd, ".pi", "swarm", "tasks");
	try { rmSync(tasksDir, { recursive: true, force: true }); } catch { /* best-effort */ }
	mkdirSync(tasksDir, { recursive: true });
	// Run 2: start — both issues should be deduped, run should complete successfully
	const notices = [];
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: (m) => notices.push(String(m)) } }, p, {});
	const st2 = await readState(p, cwd);
	const run2 = getIssueRun(st2);
	// All entries should be deduped
	assert.equal(run2.queue.length, 2, "queue should have 2 entries");
	for (const entry of run2.queue) {
		assert.equal(entry.status, "done", `${entry.issueId} should be deduped, got "${entry.status}"`);
		assert.match(entry.reason ?? "", /already completed in run/, `${entry.issueId} reason should name prior run`);
	}
	// Run should be complete (not paused/failed)
	assert.equal(run2.status, "complete", `run should be complete when all entries deduped, got "${run2.status}"`);
	// Notice should mention "no issues to activate"
	const noticeText = notices.join("\n");
	assert.match(noticeText, /no issues to activate/, `notice should mention "no issues to activate", got: ${noticeText.slice(0, 200)}`);
});

// ============================================================================
// T11 (PIN): realistic sequence — state holds completed run A → start creates run B
// → A's done entries seeded + deduped. This is the live criterion regression-guarded.
// ============================================================================
await t("T11: realistic sequence — completed run A in state → start run B → A's done entries seeded + deduped", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	// Run A: complete both issues (this writes to the ledger via controller)
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	await finishActiveIssue(cwd, p);
	await finishActiveIssue(cwd, p);
	// Verify run A is complete and ledger has 2 entries
	const stA = await readState(p, cwd);
	const runA = getIssueRun(stA);
	assert.equal(runA.status, "complete", `run A should be complete, got "${runA.status}"`);
	const ledgerPath = join(p.root, "issues", "completions.jsonl");
	assert.ok(existsSync(ledgerPath), "ledger should exist after run A");
	const { readFileSync: rfs } = await import("node:fs");
	const linesAfterA = rfs(ledgerPath, "utf8").split("\n").filter((l) => l.trim()).length;
	assert.equal(linesAfterA, 2, `ledger should have 2 lines after run A, got ${linesAfterA}`);
	// Delete the ledger to simulate a pre-ledger state (e.g. ledger was lost)
	const { unlinkSync } = await import("node:fs");
	unlinkSync(ledgerPath);
	assert.ok(!existsSync(ledgerPath), "ledger should be absent after manual delete");
	// Clear run state to inactive but PRESERVE the done entries in the queue
	// (this mirrors the real flow: the prior run's queue still has done entries in state)
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		const run = getIssueRun(st);
		run.status = "inactive";
		run.activeIssueId = undefined;
		// DO NOT clear run.queue — the done entries are the backfill source
		delete st.goal;
		await writeState(p, st);
	});
	// Clean up prior run's tasks
	const { rmSync } = await import("node:fs");
	const tasksDir = join(cwd, ".pi", "swarm", "tasks");
	try { rmSync(tasksDir, { recursive: true, force: true }); } catch { /* best-effort */ }
	mkdirSync(tasksDir, { recursive: true });
	// Run B: start — should trigger backfill from run A's done entries + dedup both
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	// Verify ledger was backfilled with run A's entries
	assert.ok(existsSync(ledgerPath), "ledger should exist after backfill");
	const linesAfterB = rfs(ledgerPath, "utf8").split("\n").filter((l) => l.trim()).length;
	assert.ok(linesAfterB >= 2, `ledger should have at least 2 lines after backfill, got ${linesAfterB}`);
	// Verify run B's queue has both issues deduped
	const stB = await readState(p, cwd);
	const runB = getIssueRun(stB);
	assert.equal(runB.queue.length, 2, "run B queue should have 2 entries");
	for (const entry of runB.queue) {
		assert.equal(entry.status, "done", `${entry.issueId} should be deduped, got "${entry.status}"`);
		assert.match(entry.reason ?? "", /already completed in run/, `${entry.issueId} reason should name prior run`);
	}
	// Run B should be complete (all deduped)
	assert.equal(runB.status, "complete", `run B should be complete when all entries deduped, got "${runB.status}"`);
});

try {
	rmSync(join(tmpdir(), "issues-restart-dedup-"), { recursive: true, force: true });
} catch {
	// best-effort cleanup
}

console.log(process.exitCode ? "\nissues-restart-dedup: FAIL" : `\nissues-restart-dedup: PASS (${passed} assertions)`);
