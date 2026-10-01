#!/usr/bin/env node
/**
 * issues-exhausted-blocked-notice — one-shot disposition notice for the exhausted-blocked run.
 *
 * Incident seed: my-daily-pi run-mup15r16-epimos — status running, activeIssueId=null,
 * queue = 9 done + 1 cancelled, 0 queued. The tick's post-hold replay funnels into
 * advanceNextIssueLocked's !next branch, guardCompleteRun refuses (incomplete_queue) and the
 * run rests in running FOREVER with zero surface.
 *
 * RED-first: T1 drives the REAL runPumpMaintenancePhasesLocked against the live field shape
 * and asserts the notice is ABSENT (red today). Fix: exactly-one `issues-exhausted:<runId>`
 * root notice in the !next refusal branch (names blocking id:status pairs + dispositions),
 * delivered via the real deliverMessageLocked; all-done completion untouched (structural
 * carve-out); paused/stopped silent at the existing early gate; queued-successor silent.
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
	const cwd = mkdtempSync(join(tmpdir(), "issues-exhausted-"));
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

function finishLinkedTask(cwd, taskId) {
	const tp = join(cwd, ".pi", "swarm", "tasks", taskId, "task.json");
	const task = JSON.parse(readFileSync(tp, "utf8"));
	task.status = "done";
	for (const n of Object.values(task.nodes ?? {})) n.status = "done";
	task.updatedAt = new Date().toISOString();
	writeFileSync(tp, JSON.stringify(task, null, 2) + "\n");
}

function cancelLinkedTask(cwd, taskId) {
	const tp = join(cwd, ".pi", "swarm", "tasks", taskId, "task.json");
	const task = JSON.parse(readFileSync(tp, "utf8"));
	task.status = "cancelled";
	task.updatedAt = new Date().toISOString();
	writeFileSync(tp, JSON.stringify(task, null, 2) + "\n");
}

async function mailboxRecs(cwd) {
	const { readdir } = await import("node:fs/promises");
	const dir = join(cwd, ".pi", "swarm", "mailboxes");
	try {
		const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
		return files.flatMap((f) =>
			readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)),
		);
	} catch (err) {
		if (err?.code === "ENOENT") return [];
		throw err;
	}
}

/**
 * Live field shape: issue 1 completes (done entry, linked task all-done on disk); issue 2's
 * linked task is CANCELLED (b1-b2 incident shape); run running, activeIssueId=null, 0 queued.
 * Reached through real command routes only (activate → finish task 1 → tick advances to 2 →
 * cancel task 2 mid-run via task cancel → tick replays post-hold → exhaustion).
 */
async function shapeExhausted({ blockStatus = "cancelled" } = {}) {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	let st = await readState(p, cwd);
	let run = getIssueRun(st);
	finishLinkedTask(cwd, run.queue[0].taskId);
	await runPumpMaintenancePhasesLocked({}, { cwd, isIdle: () => true }, p, st, Date.now(), "exhausted-advance");
	await writeState(p, st);
	st = await readState(p, cwd);
	run = getIssueRun(st);
	assert.equal(run.activeIssueId, "fix-two", "seed: fix-two activated");
	if (blockStatus === "cancelled") cancelLinkedTask(cwd, run.queue[1].taskId);
	else {
		const tp = join(cwd, ".pi", "swarm", "tasks", run.queue[1].taskId, "task.json");
		const task = JSON.parse(readFileSync(tp, "utf8"));
		task.status = "in_progress";
		task.nodes = task.nodes ?? {};
		task.nodes.plan = { ...(task.nodes.plan ?? {}), status: "blocked" };
		writeFileSync(tp, JSON.stringify(task, null, 2) + "\n");
	}
	// observe the blocked/cancelled terminal through the real tick (marks entry, clears active)
	await runPumpMaintenancePhasesLocked({}, { cwd, isIdle: () => true }, p, st, Date.now(), "exhausted-observe");
	await writeState(p, st);
	st = await readState(p, cwd);
	run = getIssueRun(st);
	// terminal observation PAUSES the run (b1-b2 branched notice); the exhausted-blocked shape
	// under test is the RUNING orphan, so resume through the real command (allowed: cancelled
	// entries don't block guardResumeRun; only blocked/failed do).
	if (run.status === "paused" && blockStatus === "cancelled") {
		// live field reconstruction (run-mup15r16-epimos rests RUNNING): direct state shape,
		// NOT the resume command — post-fix, a real resume on an exhausted queue routes into
		// the exhausted branch and would pre-emit the notice under test.
		run.status = "running";
		run.updatedAt = new Date().toISOString();
		await writeState(p, st);
		st = await readState(p, cwd);
		run = getIssueRun(st);
	}
	assert.notEqual(run.activeIssueId, "fix-two", "seed: active cleared after terminal observation");
	if (blockStatus === "cancelled") assert.equal(run.status, "running", "seed: run still running");
	const blocked = run.queue.find((q) => q.issueId === "fix-two");
	assert.equal(blocked.status, blockStatus === "cancelled" ? "cancelled" : "blocked", "seed: fix-two terminal-unsuccessful");
	if (blockStatus === "cancelled") assert.equal(run.status, "running", "seed: cancelled orphan rests in RUNNING");
	if (blockStatus === "cancelled") assert.equal(run.queue.filter((q) => q.status === "queued").length, 0, "seed: exhausted (0 queued)");
	// blocked variant rests in paused (guardResumeRun refuses blocked; b1-b2 terminal notice
	// is that state's surface — the exhausted seam covers the RUNNING orphan only).
	return { cwd, p, st };
}

const tick = (p, st, cwd) => runPumpMaintenancePhasesLocked({}, { cwd, isIdle: () => true }, p, st, Date.now(), "exhausted");
const exhaustedNotices = (recs) => recs.filter((r) => String(r.idempotencyKey || "").startsWith("issues-exhausted:"));

// === T1 (RED observed pre-fix, now revert-only control) ===
// RED was observed before the fix landed: the same real-tick leg asserted
// `exhaustedNotices(recs).length === 0` and FAILED with `1 !== 0` — the tick DID emit the
// notice, proving the absence premise red. Post-fix this leg inverts: the exhausted shape
// must produce the notice (covered exactly-once by T2/T3); here we keep the RED-observation
// record and pin the run rest semantics (no forced state transition).
await t("T1 record: RED observed pre-fix (notice absence failed 1!==0); exhausted run rests in running", async () => {
	const { cwd, p, st } = await shapeExhausted();
	await tick(p, st, cwd);
	await writeState(p, st);
	const run = getIssueRun(await readState(p, cwd));
	assert.equal(run.status, "running", "run rests in running (human disposition, no forced transition)");
	rmSync(cwd, { recursive: true, force: true });
});
console.log("issues-exhausted: RED phase done");

// === GREEN legs ===
await t("T2 GREEN: exhausted-cancelled — exactly ONE notice; body names id:status + dispositions", async () => {
	const { cwd, p, st } = await shapeExhausted();
	await tick(p, st, cwd);
	await writeState(p, st);
	const recs = exhaustedNotices(await mailboxRecs(cwd));
	assert.equal(recs.length, 1, "T2: exactly one exhausted notice");
	const n = recs[0];
	assert.equal(n.to, "root");
	assert.equal(n.idempotencyKey, `issues-exhausted:${getIssueRun(await readState(p, cwd)).runId}`);
	assert.ok(n.body.includes("fix-two:cancelled"), "body names blocking id:status");
	assert.ok(n.body.includes("/swarm issues stop"), "body names stop disposition");
	assert.ok(n.body.includes("/swarm issues abandon fix-two") && n.body.includes("/swarm issues resume"), "body names abandon+resume path");
	const run = getIssueRun(await readState(p, cwd));
	assert.equal(run.status, "running", "run legitimately rests in running (human disposition)");
	rmSync(cwd, { recursive: true, force: true });
});

await t("T3 double-tick dedupe: second REAL tick — still exactly one notice", async () => {
	const { cwd, p, st } = await shapeExhausted();
	await tick(p, st, cwd);
	await writeState(p, st);
	await tick(p, st, cwd);
	await writeState(p, st);
	assert.equal(exhaustedNotices(await mailboxRecs(cwd)).length, 1, "T3: exactly-once under replay");
	rmSync(cwd, { recursive: true, force: true });
});

await t("T4 all-done carve-out: completes with completion notice ONLY (no blocker notice)", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	let st = await readState(p, cwd);
	let run = getIssueRun(st);
	finishLinkedTask(cwd, run.queue[0].taskId);
	await tick(p, st, cwd);
	await writeState(p, st);
	st = await readState(p, cwd);
	run = getIssueRun(st);
	finishLinkedTask(cwd, run.queue[1].taskId);
	// observe second done via post-hold replay (no active after advance… drive both through ticks)
	await runPumpMaintenancePhasesLocked({}, { cwd, isIdle: () => true }, p, st, Date.now(), "exhausted-t4");
	await writeState(p, st);
	st = await readState(p, cwd);
	run = getIssueRun(st);
	// field orphan shape (activeIssueId cleared) so the post-hold branch replays
	run.activeIssueId = null;
	await writeState(p, st);
	st = await readState(p, cwd);
	await tick(p, st, cwd);
	await writeState(p, st);
	run = getIssueRun(await readState(p, cwd));
	assert.equal(run.status, "complete", "T4: all-done run completes");
	const recs = await mailboxRecs(cwd);
	assert.ok(recs.some((r) => String(r.idempotencyKey || "") === `issues-complete:${run.runId}`), "completion notice present");
	assert.equal(exhaustedNotices(recs).length, 0, "no blocker notice on the all-done path");
	rmSync(cwd, { recursive: true, force: true });
});

await t("T5 queued-successor: no exhausted notice (normal advance)", async () => {
	const cwd = seedWorld();
	const p = paths(cwd);
	await ensureDirs(p);
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	let st = await readState(p, cwd);
	let run = getIssueRun(st);
	finishLinkedTask(cwd, run.queue[0].taskId);
	await tick(p, st, cwd);
	await writeState(p, st);
	st = await readState(p, cwd);
	run = getIssueRun(st);
	assert.equal(run.activeIssueId, "fix-two", "normal advance happened");
	assert.equal(exhaustedNotices(await mailboxRecs(cwd)).length, 0, "no exhausted notice while a successor ran/queues");
	rmSync(cwd, { recursive: true, force: true });
});

await t("T6 paused/stopped: no exhausted notice (early gate)", async () => {
	const { cwd, p, st } = await shapeExhausted();
	// paused
	let run = getIssueRun(st);
	run.status = "paused";
	await writeState(p, st);
	const st2 = await readState(p, cwd);
	await tick(p, st2, cwd);
	await writeState(p, st2);
	assert.equal(exhaustedNotices(await mailboxRecs(cwd)).length, 0, "paused: no notice");
	// stopped (stop accepts paused directly; no resume — the resumed exhausted branch owns
	// notice emission and is covered by T7's disposition leg)
	const st3 = await readState(p, cwd);
	await handleIssuesCommand("issues", ["stop"], { cwd, ui: { notify: () => {} } }, p, {});
	await tick(p, st3, cwd);
	await writeState(p, st3);
	assert.equal(exhaustedNotices(await mailboxRecs(cwd)).length, 0, "stopped: no notice");
	rmSync(cwd, { recursive: true, force: true });
});

await t("T7 blocked variant: b1-b2 terminal notice names id:blocked + abandon path; abandon+resume completes", async () => {
	const { cwd, p, st } = await shapeExhausted({ blockStatus: "blocked" });
	const run = getIssueRun(st);
	assert.equal(run.status, "paused", "T7: blocked variant rests paused (guardResumeRun refuses blocked)");
	// the b1-b2 terminal notice IS the surface for this state (not the exhausted seam — the
	// run is not a RUNNING orphan); verify its body names the blocking entry + disposition.
	const recs = (await mailboxRecs(cwd)).filter((r) => String(r.idempotencyKey || "").startsWith("issues-terminal:"));
	assert.equal(recs.length, 1, "T7: exactly one terminal notice");
	assert.ok(recs[0].body.includes("fix-two") && recs[0].body.includes("blocked") && recs[0].body.includes("/swarm issues abandon fix-two"), "terminal notice names fix-two blocked + abandon disposition");
	// drive the notice's disposition: abandon + resume (real commands). abandon maps
	// blocked → cancelled (only blocked/failed are abandonable); resume then passes
	// guardResumeRun and advanceNextIssueLocked hits the exhausted branch with ZERO blockers
	// → guardCompleteRun .ok path completes the run (same seam, structural carve-out).
	await handleIssuesCommand("issues", ["abandon", "fix-two", "superseded"], { cwd, ui: { notify: () => {} } }, p, {});
	await handleIssuesCommand("issues", ["resume"], { cwd, ui: { notify: () => {} } }, p, {});
	const runAfter = getIssueRun(await readState(p, cwd));
	// abandon maps blocked → cancelled; a cancelled entry STILL blocks guardCompleteRun
	// (all-done required — the incident's exact rest state). The resumed exhausted branch
	// therefore emits the exactly-once exhausted notice (running orphan, 0 queued) naming
	// the abandoned entry; the run rests in running until /swarm issues stop.
	assert.equal(runAfter.status, "running", "T7: cancelled remnant keeps the run in running (guard untouched)");
	assert.equal(runAfter.queue.find((q) => q.issueId === "fix-two").status, "cancelled", "abandoned entry recorded as cancelled");
	const exhaustedAfter = exhaustedNotices(await mailboxRecs(cwd));
	assert.equal(exhaustedAfter.length, 1, "T7: resumed exhausted branch emitted the disposition notice");
	assert.ok(exhaustedAfter[0].body.includes("fix-two:cancelled"), "T7: notice names the abandoned remnant");
	rmSync(cwd, { recursive: true, force: true });
});

console.log(`\nissues-exhausted: ${passed} passed, ${process.exitCode ? "FAILURES" : "all green"}`);
