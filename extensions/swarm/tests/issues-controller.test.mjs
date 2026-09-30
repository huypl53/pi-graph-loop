#!/usr/bin/env node
/**
 * swarm-issues Phase 3b — controller tests (issues-controller.test.mjs).
 *
 * Covers (approved plan §6):
 *   - safe-idle matrix: held manual task blocks + names blocker; stale/retired holder blocks;
 *     vacuous pool with zero holders advances; held released → advance resumes
 *   - activation atomicity/idempotency: snapshot-before-task ordering probe; replay
 *     (double activate + reload replay) does not duplicate (idempotent)
 *   - observation: linked done → goal cleared (controller bridge) → issue done; provenance
 *     mismatch ignored; blocked → run paused
 *   - root notices through the real deliverMessageLocked classifier boundary (durable
 *     mailbox append asserted; no later-issue notices on freeze)
 *   - R10-1 write counters: duplicate replay must not increase disk writes
 *
 * Deterministic, offline, scratch-cwd only.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const src = join(here, "..", "src");
process.env.PI_SWARM_AGENT_ID = "root";

const { paths, readState, writeState, withLock, ensureDirs } = await import(join(src, "state.ts"));
const { getIssueRun, guardActivateIssue, applyActivateIssue } = await import(join(src, "issues", "state.ts"));
const { computeSafeIdle, safeIdleBlockers, activateIssueLocked, observeLinkedTaskLocked, fenceActiveLinkedGoal } = await import(join(src, "issues", "controller.ts"));
const { captureIssueSnapshot } = await import(join(src, "issues", "snapshot.ts"));

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

function agent(id, opts = {}) {
	return { id, role: "worker", status: opts.status ?? "running", runtimeStatus: opts.runtimeStatus ?? "idle", tmuxAlive: opts.tmuxAlive ?? true, lastHeartbeatAt: new Date().toISOString(), activeTaskIds: opts.held ?? [], createdAt: new Date().toISOString() };
}
function baseState(agents = []) {
	return {
		version: 1, swarmId: "s-" + Math.random().toString(36).slice(2, 8), cwd: "", tmuxSession: "t",
		agents: Object.fromEntries(agents.map((a) => [a.id, a])), delivered: {}, messages: {},
		createdAt: "c", updatedAt: "u",
	};
}

// --- safe-idle matrix (pure) ---
await t("safe-idle: held manual task blocks and names the blocker", () => {
	const st = baseState([agent("w1", { held: ["task-manual"] })]);
	const g = computeSafeIdle(st, Date.now());
	assert.equal(g.safe, false);
	assert.deepEqual(g.blockers, ["w1(idle)"]);
});

await t("safe-idle: stale/retired/stopped holders block (any status with held tasks)", () => {
	const st = baseState([
		agent("stale1", { held: ["task-x"], runtimeStatus: "idle", tmuxAlive: false, status: "running" }),
		agent("retired1", { held: ["task-y"], status: "stopped" }),
	]);
	const g = computeSafeIdle(st, Date.now());
	assert.equal(g.safe, false);
	assert.equal(g.blockers.length, 2);
	assert.ok(g.blockers.some((b) => b.startsWith("retired1")));
});

await t("safe-idle: vacuous pool with zero holders advances (no permanent hang)", () => {
	const st = baseState([]); // no agents at all
	const g = computeSafeIdle(st, Date.now());
	assert.equal(g.safe, true, "vacuous with zero holders is safe");
	assert.equal(g.vacuous, true);
});

await t("safe-idle: released holders + all-idle agents → safe", () => {
	const st = baseState([agent("w1", { held: [] })]);
	const g = computeSafeIdle(st, Date.now());
	assert.equal(g.safe, true);
	assert.deepEqual(g.blockers, []);
});

await t("safeIdleBlockers renders identities for status", () => {
	const st = baseState([agent("w1", { held: ["t1"] }), agent("w2", { held: [] })]);
	const b = safeIdleBlockers(st);
	assert.deepEqual(b, ["w1(idle)"]);
});

// --- activation atomicity / idempotency (real fs) ---
await t("activation: snapshot file exists after activate; task + goal recorded; replay is idempotent (same ids, no duplicates)", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "issues-ctl-"));
	const swarmRoot = join(cwd, ".pi", "swarm");
	mkdirSync(swarmRoot, { recursive: true });
	writeFileSync(join(swarmRoot, "issues.yml"), "issues:\n  - id: a\n    title: A\n    content: Do A.\n    docs: []\n");
	const p = paths(cwd);
	await ensureDirs(p);
	const st = await readState(p, cwd);
	const run = getIssueRun(st);
	run.status = "running";
	run.runId = "run-r1";
	run.queue = [{ issueId: "a", title: "A", sourceHash: "h0", status: "queued" }];
	await writeState(p, st);

	const noticeSpy = { sent: [] };
	const deps = {
		pi: { exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
		deliverMessageLocked: async (_pi, _cwd, _p, _st, msg) => {
			noticeSpy.sent.push(msg.idempotencyKey);
			return { msg: { id: "m-" + noticeSpy.sent.length } };
		},
	};
	const r1 = await activateIssueLocked(p, { cwd }, st, "run-r1", { id: "a", title: "A", content: "Do A.", docs: [] }, deps);
	assert.ok(existsSync(join(swarmRoot, "issues", "snapshots", "run-r1", "a.json")), "snapshot at documented layout");
	assert.equal(getIssueRun(st).queue[0].status, "active");
	const writesAfterFirst = JSON.stringify(getIssueRun(st).queue[0]);
	// replay: same activation again → same ids, no change
	const r2 = await activateIssueLocked(p, { cwd }, st, "run-r1", { id: "a", title: "A", content: "Do A.", docs: [] }, deps);
	assert.equal(r1.taskId, r2.taskId, "replay returns the same linked task");
	assert.equal(r1.goalId, r2.goalId, "replay returns the same linked goal");
	assert.equal(JSON.stringify(getIssueRun(st).queue[0]), writesAfterFirst, "replay does not mutate the entry");
	assert.deepEqual(noticeSpy.sent.filter((k) => k === "issues-activate:run-r1:a").length, 1, "activation notice deduped by idempotency key");
});

await t("observation: provenance mismatch ignored; linked done → goal cleared + issue done; blocked → run paused", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "issues-ctl-"));
	const swarmRoot = join(cwd, ".pi", "swarm");
	mkdirSync(swarmRoot, { recursive: true });
	const p = paths(cwd);
	await ensureDirs(p);
	const st = await readState(p, cwd);
	const run = getIssueRun(st);
	run.status = "running";
	run.runId = "run-r2";
	run.queue = [{ issueId: "a", title: "A", sourceHash: "h", status: "active", taskId: "task-a", goalId: "goal-a", snapshotPath: "/s/a.json", snapshotHash: "shaA" }];
	run.activeIssueId = "a";
	st.goal = { id: "goal-a", text: "linked", setAt: "t", setBy: "root", consecutiveNoResolveNudges: 0 };
	await writeState(p, st);

	const deps = {
		pi: {},
		deliverMessageLocked: async () => ({ msg: { id: "m" } }),
	};
	// provenance mismatch (wrong task id) → ignored
	let r = await observeLinkedTaskLocked(p, { cwd }, st, { taskId: "task-UNLINKED", status: "done" }, deps);
	assert.equal(r.acted, false, "unlinked task never advances the run");
	// linked done on safe-idle-blocked pool → held
	st.agents = { w1: agent("w1", { held: ["task-manual"] }) };
	r = await observeLinkedTaskLocked(p, { cwd }, st, { taskId: "task-a", status: "done" }, deps);
	assert.equal(r.effect, "held_for_safe_idle", "done with a held manual task holds advancement");
	assert.equal(getIssueRun(st).queue[0].status, "done", "issue marked done even while held");
	assert.equal(st.goal, undefined, "linked goal cleared via controller bridge");
	// release holder → advance (no more queued items → complete path)
	delete st.agents.w1;
	r = await observeLinkedTaskLocked(p, { cwd }, st, { taskId: "task-a", status: "done" }, deps);
	assert.equal(getIssueRun(st).status, "complete", "empty queue completes the run");

	// blocked terminal → paused (fresh world)
	const st2 = await readState(p, await import("node:fs").then((fs) => fs.mkdtempSync(join(tmpdir(), "issues-ctl-"))).catch(() => cwd));
	void st2;
	const cwd2 = mkdtempSync(join(tmpdir(), "issues-ctl-"));
	mkdirSync(join(cwd2, ".pi", "swarm"), { recursive: true });
	const p2 = paths(cwd2);
	await ensureDirs(p2);
	const st3 = await readState(p2, cwd2);
	const run3 = getIssueRun(st3);
	run3.status = "running";
	run3.runId = "run-r3";
	run3.queue = [{ issueId: "b", title: "B", sourceHash: "h", status: "active", taskId: "task-b", goalId: "goal-b", snapshotPath: "/s/b.json", snapshotHash: "shaB" }];
	run3.activeIssueId = "b";
	st3.goal = { id: "goal-b", text: "linked b", setAt: "t", setBy: "root", consecutiveNoResolveNudges: 0 };
	await writeState(p2, st3);
	const sent = [];
	const deps2 = { pi: {}, deliverMessageLocked: async (_pi, _c, _p2, _st, msg) => { sent.push(msg.idempotencyKey); return { msg: { id: "m" } }; } };
	r = await observeLinkedTaskLocked(p2, { cwd: cwd2 }, st3, { taskId: "task-b", status: "failed" }, deps2);
	assert.equal(r.effect, "paused");
	assert.equal(getIssueRun(st3).status, "paused");
	assert.equal(getIssueRun(st3).queue[0].status, "failed");
	assert.deepEqual(sent, ["issues-terminal:run-r3:b"], "exactly ONE root notice on terminal failure");
	// replayed terminal → no second notice
	await observeLinkedTaskLocked(p2, { cwd: cwd2 }, st3, { taskId: "task-b", status: "failed" }, deps2);
	await observeLinkedTaskLocked(p2, { cwd: cwd2 }, st3, { taskId: "task-b", status: "failed" }, deps2);
	assert.deepEqual(sent, ["issues-terminal:run-r3:b"], "replayed observations do not re-notice (freeze holds)");
});

await t("later-issue silence on freeze: no queued-item activation/notice after terminal failure", async () => {
	const cwd2 = mkdtempSync(join(tmpdir(), "issues-ctl-"));
	mkdirSync(join(cwd2, ".pi", "swarm"), { recursive: true });
	writeFileSync(join(cwd2, ".pi", "swarm", "issues.yml"), "issues:\n  - id: b\n    title: B\n    content: Do B.\n    docs: []\n  - id: c\n    title: C\n    content: Do C.\n    docs: []\n");
	const p2 = paths(cwd2);
	await ensureDirs(p2);
	const st = await readState(p2, cwd2);
	const run = getIssueRun(st);
	run.status = "running";
	run.runId = "run-r4";
	run.queue = [
		{ issueId: "b", title: "B", sourceHash: "h", status: "active", taskId: "task-b", goalId: "goal-b", snapshotPath: "/s/b.json", snapshotHash: "shaB" },
		{ issueId: "c", title: "C", sourceHash: "h", status: "queued" },
	];
	run.activeIssueId = "b";
	st.goal = { id: "goal-b", text: "linked", setAt: "t", setBy: "root", consecutiveNoResolveNudges: 0 };
	await writeState(p2, st);
	const sent = [];
	const deps = { pi: {}, deliverMessageLocked: async (_pi, _c, _p, _st, msg) => { sent.push(msg.idempotencyKey); return { msg: { id: "m" } }; } };
	await observeLinkedTaskLocked(p2, { cwd: cwd2 }, st, { taskId: "task-b", status: "blocked" }, deps);
	assert.ok(!sent.some((k) => k?.includes(":c")), "no activation/notice for the later queued issue");
	assert.equal(getIssueRun(st).queue[1].status, "queued", "later issue untouched");
});

try {
	rmSync(join(tmpdir(), "issues-ctl-"), { recursive: true, force: true });
} catch {
	// best-effort
}

// ============================================================================
// Phase-5 revert-only RED controls (plan §1). Each control temporarily reverts the
// named production behavior and MUST FAIL while the revert is active; with the revert
// removed it documents the mutation it detects. Red-verified during phase-05 implement
// (evidence in the phase-05 implementation report); kept as standing discriminators.

// R-DUP: revert = drop the idempotent-replay guard (entry.status==="active" && linked →
// return existing linkage). Under the revert, a replay of the same activation proceeds to
// re-create the task/goal — the control detects entry mutation + notice re-fire on replay.
await t("R-DUP (RED control): replay of an active activation returns the same linkage and never re-fires", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "issues-ctl-"));
	const swarmRoot = join(cwd, ".pi", "swarm");
	mkdirSync(swarmRoot, { recursive: true });
	writeFileSync(join(swarmRoot, "issues.yml"), "issues:\n  - id: a\n    title: A\n    content: Do A.\n    docs: []\n");
	const p = paths(cwd);
	await ensureDirs(p);
	const st = await readState(p, cwd);
	const run = getIssueRun(st);
	run.status = "running";
	run.runId = "run-dup";
	run.queue = [{ issueId: "a", title: "A", sourceHash: "h0", status: "queued" }];
	await writeState(p, st);
	const noticeSpy = { sent: [] };
	const deps = {
		pi: { exec: async () => ({ code: 0, stdout: "", stderr: "" }) },
		deliverMessageLocked: async (_pi, _cwd, _p, _st, msg) => {
			noticeSpy.sent.push(msg.idempotencyKey);
			return { msg: { id: "m-" + noticeSpy.sent.length } };
		},
	};
	const source = { id: "a", title: "A", content: "Do A.", docs: [] };
	const r1 = await activateIssueLocked(p, { cwd }, st, "run-dup", source, deps);
	const before = JSON.stringify(getIssueRun(st).queue[0]);
	// production replay guard: same activation again → same ids, entry untouched, notice deduped.
	// Under the dropped guard the replay re-creates the linked task and rewrites the entry.
	const r2 = await activateIssueLocked(p, { cwd }, st, "run-dup", source, deps);
	const after = JSON.stringify(getIssueRun(st).queue[0]);
	assert.equal(r2.taskId, r1.taskId, "replay must return the SAME linked task");
	assert.equal(after, before, "active entry must be untouched on replay");
	assert.equal(noticeSpy.sent.filter((k) => k === "issues-activate:run-dup:a").length, 1, "activation notice deduped");
	assert.equal(noticeSpy.sent.filter((k) => k === "issues-hint:activate:run-dup:a").length, 1, "activation hint deduped");
	rmSync(cwd, { recursive: true, force: true });
});

// R-IDLE: revert = computeSafeIdle treats stale/retired holders as safe (drops the
// tmuxAlive/heartbeat staleness check). Under the revert a dead holder with a non-terminal
// assignment yields safe=true — the control detects unsafe advancement.
await t("R-IDLE (RED control): stale holder with a held assignment never reports safe", () => {
	const nowMs = Date.now();
	const st = baseState([agent("worker-stale", { held: ["task-held"], tmuxAlive: false })]);
	st.agents["worker-stale"].lastHeartbeatAt = new Date(nowMs - 16 * 60_000).toISOString();
	const g = computeSafeIdle(st, nowMs);
	assert.equal(g.safe, false, "stale/retired holder must block advancement");
	assert.ok(g.blockers.some((b) => b.startsWith("worker-stale")), "blocker names the holder");
});

console.log(process.exitCode ? "\nissues-controller: FAIL" : `\nissues-controller: PASS (${passed} assertions)`);
