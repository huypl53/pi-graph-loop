#!/usr/bin/env node
/**
 * Task-liveness tests (Issue 23) — drive `evaluateTaskGraphStallNudgeLocked` directly with a
 * scratch project + state. Mirrors idle-nudge.test.mjs fixture pattern.
 *
 * Covers the 14 cases from plan v2 §Test plan:
 *   1. No goal, no in_progress task                                  -> no_active_task
 *   2. No goal, in_progress task with all nodes done                 -> no_active_node
 *   3. No goal, in_progress task + agent busy                        -> agent_busy
 *   4. No goal, in_progress task + all idle, age < grace             -> within_grace
 *   5. Same as 4 but age > grace; first nudge                        -> emitted; counter=1
 *   6. Repeat 5 without resolve; counter increments                  -> up to MAX
 *   7. Continue past MAX; back-off armed                             -> max_nudges
 *   8. Back-off drain: tick N (count>0)                              -> backoff skip
 *   9. Back-off tick that hits 0                                     -> backoff_just_exhausted
 *  10. Resolve via assign on actionable node                         -> counter reset
 *  11. Resolve via applyTaskStatus terminal transition               -> counter reset
 *  12. Goal set + task stalled                                       -> both nudges (different keys)
 *  13. Resolve detection: applyTaskStatus terminal:false             -> counter NOT reset
 *  14. Resolve detection: applyTaskStatus terminal:true              -> counter reset + trace
 */
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Row 68: interval-spaced stall emissions. Tests drive ticks with synthetic nowMs, so a short
// interval makes interval boundaries reachable deterministically.
process.env.PI_SWARM_TASK_STALL_NUDGE_IDLE_INTERVAL_MS ||= "1000";
process.env.PI_SWARM_GOAL_NUDGE_IDLE_INTERVAL_MS ||= "1000";

// Row 68: interval-spaced stall emissions. Tests drive ticks with synthetic nowMs, so a short
// interval makes interval boundaries reachable deterministically.
process.env.PI_SWARM_TASK_STALL_NUDGE_IDLE_INTERVAL_MS ||= "1000";
process.env.PI_SWARM_GOAL_NUDGE_IDLE_INTERVAL_MS ||= "1000";

const here = dirname(fileURLToPath(import.meta.url));
const { paths, readState, withLock, writeState, taskPaths, ensureDirs, trace } = await import(join(here, "src", "state.ts"));
const { evaluateTaskGraphStallNudgeLocked, evaluateIdleGoalNudgeLocked, resolveTaskStallLocked } = await import(join(here, "src", "reconcile.ts"));
const { ensureOrchestrator } = await import(join(here, "src", "identity.ts"));
const { applyTaskStatus, computeReadyNodes, mintNodeAttempt, resolveNodeScope, computeTaskStatus } = await import(join(here, "src", "taskgraph.ts"));

const dir = await mkdtemp(join(tmpdir(), "task-liveness-"));
await mkdir(join(dir, ".pi"), { recursive: true });
await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ swarm: { defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" } }));
process.chdir(dir);
const p = paths(dir);
await ensureDirs(p);

const sentMessages = [];
const pi = {
	registerTool: () => {},
	registerCommand: () => {},
	on: () => {},
	setModel: async () => true,
	sendMessage: (m, o) => { sentMessages.push({ m, o }); },
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};

let pass = 0, fail = 0;
const ok = (n, c, info) => { if (c) { pass++; console.log("  ok  ", n); } else { fail++; console.error("  FAIL:", n, info ?? ""); } };

const SAVED_AGENT_ID = process.env.PI_SWARM_AGENT_ID;
const SAVED_ORCH = process.env.PI_SWARM_IS_ORCHESTRATOR;
delete process.env.PI_SWARM_AGENT_ID;
process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
process.on("exit", () => {
	if (SAVED_AGENT_ID === undefined) delete process.env.PI_SWARM_AGENT_ID;
	else process.env.PI_SWARM_AGENT_ID = SAVED_AGENT_ID;
	if (SAVED_ORCH === undefined) delete process.env.PI_SWARM_IS_ORCHESTRATOR;
	else process.env.PI_SWARM_IS_ORCHESTRATOR = SAVED_ORCH;
});

async function readEventsFile() {
	try {
		const raw = await readFile(p.events, "utf8");
		return raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	} catch { return []; }
}
async function countEvents(name) {
	const events = await readEventsFile();
	return events.filter((e) => e.event === name).length;
}

async function setup({ taskId, withTask = true, ageMs = 0, allNodesDone = false } = {}) {
	const st = await readState(p, dir);
	ensureOrchestrator(st, dir, p);
	const ts = new Date().toISOString();
	st.agents["worker-a"] = {
		id: "worker-a", role: "worker-a role", roleKind: "worker", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1,
		status: "running", runtimeStatus: "idle", health: "healthy",
		tmuxSession: st.tmuxSession, tmuxWindow: "worker-a", tmuxTarget: "sess:worker-a.0",
		model: "glm-5.1", provider: "zai-coding-cn", cwd: dir, mailbox: ".pi/swarm/mailboxes/worker-a.jsonl",
		createdAt: ts, updatedAt: ts, lastHeartbeatAt: ts,
	};
	// Reset transient state so prior tests don't leak: clear stale task-stall counters (each test
	// sets its own) and the goal nudge (case 12 sets it; other cases don't want it).
	st.taskStallState = {};
	st.goal = undefined;
	await writeState(p, st);
	// Clear leftover tasks between tests so the predicate scans the right graph. We don't delete
	// case-12's task explicitly — it's overwritten by the next setup().
	if (withTask) {
		// Remove any prior tasks (case N-1's task) before seeding case N's task.
		const tasksDir = p.tasksDir;
		try {
			const entries = await readdir(tasksDir);
			for (const entry of entries) {
				await rm(join(tasksDir, entry), { recursive: true, force: true });
			}
		} catch { /* no tasksDir yet */ }
		await seedTask(taskId, { ageMs, allNodesDone });
	}
	await rm(p.events, { force: true });
	sentMessages.length = 0;
}

async function seedTask(taskId, { ageMs = 0, allNodesDone = false } = {}) {
	const tp = taskPaths(p, taskId);
	await mkdir(tp.root, { recursive: true });
	const createdAt = new Date(Date.now() - ageMs).toISOString();
	const status = allNodesDone ? "done" : "in_progress";
	const nodeStatus = allNodesDone ? "done" : "ready";
	const task = {
		version: 1,
		taskId,
		title: "Task Liveness Test",
		goal: "test goal",
		status,
		priority: "normal",
		createdAt,
		updatedAt: createdAt,
		owner: "orchestrator",
		workflow: "feature-dev",
		allowedFiles: [],
		acceptanceCriteria: [],
		validationCommands: [],
		start: "a",
		currentNodes: [],
		sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
		nodes: {
			a: { status: nodeStatus, role: "worker", dependsOn: [], messageIds: [], attempts: 0, terminal: false },
		},
		edges: [],
		handoffs: [],
		gates: {},
		editLocks: {},
		evidence: {},
	};
	await writeFile(tp.taskJson, JSON.stringify(task, null, 2), "utf8");
}

async function tick(nowMs = Date.now()) {
	let result;
	await withLock(p, async () => {
		const st = await readState(p, dir);
		ensureOrchestrator(st, dir, p);
		result = await evaluateTaskGraphStallNudgeLocked(pi, dir, p, st, nowMs);
		await writeState(p, st);
	});
	return result;
}

// Row 68: emissions are interval-spaced, so multi-emit cases drive ticks across interval
// boundaries (interval is 1000ms via env override) rather than hammering same-time ticks.
const INTERVAL_MS = 1000;

async function getStallState(taskId) {
	const st = await readState(p, dir);
	return st.taskStallState?.[taskId];
}

async function resetMessages() {
	// Pre-fix: deleted emitted nudge messages so the static idempotency key would not suppress
	// later emits forever (the production one-nudge-per-task bug). Post-fix (seq-suffixed keys)
	// nothing needs cleaning between ticks: each emit gets a fresh dedupe slot and setup()
	// reseeds scratch state per case. Kept as a no-op to avoid touching every call site.
}

// =============================================================
// Case 1: no in_progress task
// =============================================================
console.log("\n[1] no in_progress task -> no_active_task");
{
	await setup({ withTask: false });
	const r = await tick();
	ok("emitted=false", r.emitted === false);
	ok("reason=no_active_task", r.reason === "no_active_task");
}

// =============================================================
// Case 2: in_progress task with all nodes done
// =============================================================
console.log("\n[2] in_progress task with all nodes done -> no_active_node");
{
	await setup({ taskId: "task-2", ageMs: 120_000, allNodesDone: true });
	const r = await tick();
	ok("emitted=false", r.emitted === false);
	ok("reason=no_active_node (no in_progress tasks found)", r.reason === "no_active_node" || r.reason === "no_active_task");
}

// =============================================================
// Case 3: in_progress task + agent busy
// =============================================================
console.log("\n[3] in_progress task + agent busy -> agent_busy");
{
	await setup({ taskId: "task-3", ageMs: 120_000 });
	await withLock(p, async () => {
		const s = await readState(p, dir);
		s.agents["worker-a"].runtimeStatus = "busy";
		await writeState(p, s);
	});
	const r = await tick();
	ok("emitted=false", r.emitted === false);
	ok("reason=agent_busy", r.reason === "agent_busy");
}

// =============================================================
// Case 4: in_progress + all idle + age < grace -> within_grace
// =============================================================
console.log("\n[4] in_progress + all idle + age < grace -> within_grace");
{
	await setup({ taskId: "task-4", ageMs: 5_000 });
	const r = await tick();
	ok("emitted=false", r.emitted === false);
	ok("reason=within_grace", r.reason === "within_grace");
}

// =============================================================
// Case 5: same as 4 but age > grace; first nudge emitted
// =============================================================
console.log("\n[5] age > grace + all idle; first nudge emitted");
{
	await setup({ taskId: "task-5", ageMs: 120_000 });
	const r = await tick();
	ok("emitted=true", r.emitted === true);
	ok("reason=emitted", r.reason === "emitted");
	const slot = await getStallState("task-5");
	ok("counter=1 after first emit", slot?.consecutiveNoResolveNudges === 1);
	ok("lastNudgeAt stamped", typeof slot?.lastNudgeAt === "string");
	ok("notify key in trace", (await countEvents("task_stall.nudge_emitted")) >= 1);
	ok("message persisted in mailbox", Boolean((await readFile(join(p.mailboxes, "orchestrator.jsonl"), "utf8").catch(() => "")).includes("graph-stall")));
}

// =============================================================
// Case 6: repeat emit; counter increments
// =============================================================
console.log("\n[6] repeat emit without resolve; counter increments");
{
	await setup({ taskId: "task-6", ageMs: 120_000 });
	await resetMessages();
	const t0 = Date.now();
	let r = await tick(t0);
	ok("interval 1 emits", r.emitted === true);
	await resetMessages();
	r = await tick(t0 + INTERVAL_MS);
	ok("interval 2 emits", r.emitted === true);
	let slot = await getStallState("task-6");
	ok("counter=2 after 2 interval emissions", slot?.consecutiveNoResolveNudges === 2);
	// Sub-interval ticks must NOT emit (no pump-tick burst).
	await resetMessages();
	r = await tick(t0 + INTERVAL_MS + 100);
	ok("sub-interval tick does not emit", r.emitted === false && r.reason === "stall_interval_pending");
}

// =============================================================
// Case 7: past MAX; back-off armed
// =============================================================
console.log("\n[7] past MAX; back-off armed; no emit");
{
	await setup({ taskId: "task-7", ageMs: 120_000 });
	await resetMessages();
	const t0 = Date.now();
	for (let i = 0; i < 3; i++) { await tick(t0 + i * INTERVAL_MS); await resetMessages(); }
	let slot = await getStallState("task-7");
	ok("counter=3 after 3 interval emissions", slot?.consecutiveNoResolveNudges === 3);
	await resetMessages();
	const r = await tick(t0 + 3 * INTERVAL_MS);
	ok("interval past MAX: no emit", r.emitted === false);
	ok("reason=max_nudges", r.reason === "max_nudges");
	slot = await getStallState("task-7");
	ok("backoffTicksRemaining=2 after entry", slot?.backoffTicksRemaining === 2);
}

// =============================================================
// Case 8: back-off drain
// =============================================================
console.log("\n[8] back-off drain: interval decrements without emit");
{
	await setup({ taskId: "task-8", ageMs: 120_000 });
	await resetMessages();
	const t0 = Date.now();
	for (let i = 0; i < 3; i++) { await tick(t0 + i * INTERVAL_MS); await resetMessages(); }
	await resetMessages();
	await tick(t0 + 3 * INTERVAL_MS); // enters back-off (max=3)
	let slot = await getStallState("task-8");
	ok("backoff armed", slot?.backoffTicksRemaining === 2);
	// Sub-interval tick: no decrement (tick-rate independent).
	await resetMessages();
	let r1 = await tick(t0 + 3 * INTERVAL_MS + 100);
	ok("sub-interval backoff tick: no emit + no decrement", r1.emitted === false && r1.reason === "stall_interval_pending");
	slot = await getStallState("task-8");
	ok("backoff NOT decremented by sub-interval tick", slot?.backoffTicksRemaining === 2);
	await resetMessages();
	r1 = await tick(t0 + 4 * INTERVAL_MS);
	ok("back-off interval: no emit", r1.emitted === false);
	ok("reason=backoff", r1.reason === "backoff");
	slot = await getStallState("task-8");
	ok("backoff decremented to 1", slot?.backoffTicksRemaining === 1);
}

// =============================================================
// Case 9: back-off exit gate
// =============================================================
console.log("\n[9] back-off exit gate (decrement to 0; no emit)");
{
	await setup({ taskId: "task-9", ageMs: 120_000 });
	await resetMessages();
	const t0 = Date.now();
	for (let i = 0; i < 3; i++) { await tick(t0 + i * INTERVAL_MS); await resetMessages(); }
	await resetMessages();
	await tick(t0 + 3 * INTERVAL_MS); // enter back-off (2)
	await resetMessages();
	await tick(t0 + 4 * INTERVAL_MS); // back-off (1)
	await resetMessages();
	const r = await tick(t0 + 5 * INTERVAL_MS); // back-off exit (0)
	ok("back-off exit: no emit", r.emitted === false);
	ok("reason=backoff_just_exhausted", r.reason === "backoff_just_exhausted");
}

// =============================================================
// Case 10: resolve via assign (resolveTaskStallLocked)
// =============================================================
console.log("\n[10] resolve via resolveTaskStallLocked: counter resets");
{
	await setup({ taskId: "task-10", ageMs: 120_000 });
	await resetMessages();
	await tick();
	let slot = await getStallState("task-10");
	ok("counter=1 before resolve", slot?.consecutiveNoResolveNudges === 1);
	await withLock(p, async () => {
		const s = await readState(p, dir);
		resolveTaskStallLocked(p, s, "task-10", "assigned");
		await writeState(p, s);
	});
	slot = await getStallState("task-10");
	ok("counter reset to 0", slot?.consecutiveNoResolveNudges === 0);
	ok("lastResolvedAt stamped", typeof slot?.lastResolvedAt === "string");
	ok("back-off cleared", slot?.backoffTicksRemaining === undefined);
}

// =============================================================
// Case 11: resolve via applyTaskStatus terminal transition
// =============================================================
console.log("\n[11] applyTaskStatus terminal transition: counter resets");
{
	await setup({ taskId: "task-11", ageMs: 120_000 });
	await resetMessages();
	await tick();
	let slot = await getStallState("task-11");
	ok("counter=1 before resolve", slot?.consecutiveNoResolveNudges === 1);
	await withLock(p, async () => {
		const s = await readState(p, dir);
		// Mark task as done (all nodes done); applyTaskStatus returns terminal=true
		const tp = taskPaths(p, "task-11");
		const t = JSON.parse(await readFile(tp.taskJson, "utf8"));
		t.nodes.a.status = "done";
		const change = applyTaskStatus(t);
		ok("applyTaskStatus terminal=true on all-done", change.terminal === true);
		if (change.terminal) resolveTaskStallLocked(p, s, "task-11", "task_terminal");
		await writeState(p, s);
	});
	slot = await getStallState("task-11");
	ok("counter reset to 0", slot?.consecutiveNoResolveNudges === 0);
}

// =============================================================
// Case 12: goal set + task stalled -> goal fallback is suppressed by actionable graph work
// =============================================================
console.log("\n[12] goal set + task stalled -> goal fallback suppressed by actionable graph work");
{
	await setup({ taskId: "task-12", ageMs: 120_000 });
	await withLock(p, async () => {
		const s = await readState(p, dir);
		ensureOrchestrator(s, dir, p);
		s.goal = { id: "goal-test", text: "Test goal", setAt: new Date().toISOString(), setBy: "orchestrator", consecutiveNoResolveNudges: 0 };
		await writeState(p, s);
	});
	await resetMessages();
	const goalResult = await evaluateIdleGoalNudgeLocked(pi, dir, p, await readState(p, dir), Date.now());
	ok("goal nudge suppressed while actionable graph work exists", goalResult.emitted === false && goalResult.reason === "actionable_graph");
	const r = await tick();
	ok("task-stall nudge still fires", r.emitted === true);
	ok("task-stall trace emitted", (await countEvents("task_stall.nudge_emitted")) >= 1);
}

// =============================================================
// Case 13: applyTaskStatus returns terminal:false (assign path) -> no reset
// =============================================================
console.log("\n[13] applyTaskStatus terminal:false -> counter NOT reset");
{
	await setup({ taskId: "task-13", ageMs: 120_000 });
	await resetMessages();
	await tick();
	let slot = await getStallState("task-13");
	ok("counter=1 before", slot?.consecutiveNoResolveNudges === 1);
	await withLock(p, async () => {
		const s = await readState(p, dir);
		const tp = taskPaths(p, "task-13");
		const t = JSON.parse(await readFile(tp.taskJson, "utf8"));
		// Assign node a (still in_progress task; status stays in_progress)
		t.nodes.a.status = "assigned";
		t.nodes.a.assignee = "worker-a";
		const change = applyTaskStatus(t);
		ok("applyTaskStatus terminal=false on partial assignment", change.terminal === false);
		if (change.terminal) resolveTaskStallLocked(p, s, "task-13", "task_terminal");
		await writeState(p, s);
	});
	slot = await getStallState("task-13");
	ok("counter NOT reset (terminal=false)", slot?.consecutiveNoResolveNudges === 1);
}

// =============================================================
// Case 14: resolve detection: terminal=true -> trace emitted
// =============================================================
console.log("\n[14] terminal=true -> trace task_stall.nudge.resolved emitted");
{
	await setup({ taskId: "task-14", ageMs: 120_000 });
	await resetMessages();
	await tick();
	await rm(p.events, { force: true });
	await withLock(p, async () => {
		const s = await readState(p, dir);
		const tp = taskPaths(p, "task-14");
		const t = JSON.parse(await readFile(tp.taskJson, "utf8"));
		t.nodes.a.status = "done";
		const change = applyTaskStatus(t);
		ok("applyTaskStatus terminal=true", change.terminal === true);
		if (change.terminal) resolveTaskStallLocked(p, s, "task-14", "task_terminal");
		await writeState(p, s);
	});
	// Trace is fire-and-forget; give it a tick to flush
	await new Promise((r) => setTimeout(r, 50));
	ok("task_stall.nudge.resolved trace emitted", (await countEvents("task_stall.nudge.resolved")) >= 1);
}

// R11-2 (kill-sweep root cause): `done` must require that NO live assignment remains in the
// graph, not merely that every graph-terminal node is done. Regression: 2026-09-01, 6 force-kills
// — a re-armed sub-task node (assigned) + done terminal set derived `done`, triggering
// releaseTaskFromAllAgents + sweepTaskWorkersLocked on live assignees.
{
	const mkNode = (status, assignee) => ({ status, assignee, attempts: 1, role: "worker" });
	const task = {
		taskId: "r112", title: "t", goal: "g", status: "in_progress",
		nodes: {
			commit: mkNode("done", "orchestrator"),
			test: mkNode("done", "r80-tester"),
			implement: mkNode("assigned", "fs-implementer"),
		},
		edges: [ { from: "implement", to: "test" }, { from: "test", to: "commit" } ],
	};
	ok("R11-2: done terminals + assigned re-armed node != done", computeTaskStatus(task) !== "done");
	const closed = { ...task, nodes: { ...task.nodes, implement: mkNode("done", "fs-implementer") } };
	ok("R11-2: all nodes done (incl. non-terminal) => done", computeTaskStatus(closed) === "done");
	const freshCycle = { ...task, nodes: { ...task.nodes, implement: mkNode("ready", undefined) } };
	ok("R11-2: ready (unassigned, pending work) node != done", computeTaskStatus(freshCycle) !== "done");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
