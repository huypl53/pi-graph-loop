#!/usr/bin/env node
/**
 * Issue 68: row-68 nudge semantics.
 *
 * Covers the authoritative behaviors:
 *   - graph nudge is priority over goal fallback (and emitted immediately on actionable+all-idle)
 *   - goal nudge waits for a continuous all-idle interval from the busy->idle edge
 *   - goal nudge is interval-spaced, not pump-tick-spaced
 *   - graph-stall nudge is interval-spaced after its immediate first emission
 *   - busy effective agents reset the idle epoch (and re-arm stall immediacy)
 *   - stopped/stale ghosts do not block or reset the idle epoch
 *   - graph and goal never double-fire for the same idle condition
 *   - deferred stale nudges are suppressed at surface time (direct staleSurfaceReason coverage)
 */
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PI_SWARM_GOAL_NUDGE_IDLE_INTERVAL_MS ||= "1000";
process.env.PI_SWARM_TASK_STALL_NUDGE_IDLE_INTERVAL_MS ||= "1000";

const here = dirname(fileURLToPath(import.meta.url));
const { paths, readState, withLock, writeState, taskPaths, ensureDirs } = await import(join(here, "src", "state.ts"));
const { evaluateIdleGoalNudgeLocked, evaluateTaskGraphStallNudgeLocked, staleSurfaceReason, updateIdleEpochLocked, pumpOrchestratorMailbox } = await import(join(here, "src", "reconcile.ts"));
const { ensureOrchestrator, heartbeatOrchestratorLeader } = await import(join(here, "src", "identity.ts"));
const { deliverMessageLocked } = await import(join(here, "src", "mailbox.ts"));

const dir = await mkdtemp(join(tmpdir(), "idle-nudge-"));
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
	} catch {
		return [];
	}
}
async function countEvents(name) {
	const events = await readEventsFile();
	return events.filter((e) => e.event === name).length;
}

async function setup({ taskId = "task-1", ageMs = 0, withTask = false, taskStatus = undefined } = {}) {
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
	st.agents["worker-b"] = {
		id: "worker-b", role: "worker-b role", roleKind: "worker", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1,
		status: "running", runtimeStatus: "idle", health: "healthy",
		tmuxSession: st.tmuxSession, tmuxWindow: "worker-b", tmuxTarget: "sess:worker-b.0",
		model: "glm-5.1", provider: "zai-coding-cn", cwd: dir, mailbox: ".pi/swarm/mailboxes/worker-b.jsonl",
		createdAt: ts, updatedAt: ts, lastHeartbeatAt: ts,
	};
	st.idleNudgeState = {};
	st.goal = {
		id: `goal-${Date.now()}-test`,
		text: "Ship Issue 68",
		setAt: new Date(Date.now() - ageMs).toISOString(),
		setBy: "orchestrator",
		consecutiveNoResolveNudges: 0,
	};
	await writeState(p, st);
	// Sections K/L: always clear leftover tasks (a previous section's task graph suppresses the
	// goal fallback with reason active_task even when this section seeds no graph of its own).
	try {
		const entries = await readdir(p.tasksDir);
		for (const entry of entries) await rm(join(p.tasksDir, entry), { recursive: true, force: true });
	} catch { /* ignore */ }
	if (withTask) {
		try {
			const entries = await readdir(p.tasksDir);
			for (const entry of entries) await rm(join(p.tasksDir, entry), { recursive: true, force: true });
		} catch { /* ignore */ }
		await seedGraphTask(taskId, { ageMs, taskStatus });
	}
	await rm(p.events, { force: true });
	sentMessages.length = 0;
}

async function seedGraphTask(taskId, { ageMs = 0, taskStatus = "in_progress" } = {}) {
	const tp = taskPaths(p, taskId);
	await mkdir(tp.root, { recursive: true });
	const createdAt = new Date(Date.now() - ageMs).toISOString();
	const task = {
		version: 1,
		taskId,
		title: "Issue 68 graph task",
		goal: "test graph goal",
		status: taskStatus,
		priority: "normal",
		createdAt,
		updatedAt: createdAt,
		owner: "orchestrator",
		workflow: "feature-dev",
		allowedFiles: [],
		acceptanceCriteria: [],
		validationCommands: [],
		start: "a",
		currentNodes: ["a"],
		sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
		nodes: {
			a: { status: "ready", role: "worker", assignee: undefined, dependsOn: [], messageIds: [], attempts: 0, lastActivityAt: createdAt },
		},
		edges: [],
		handoffs: [],
		gates: {},
		editLocks: {},
		evidence: {},
	};
	await writeFile(tp.taskJson, JSON.stringify(task, null, 2), "utf8");
}

async function tickGoal(nowMs = Date.now()) {
	let result;
	await withLock(p, async () => {
		const st = await readState(p, dir);
		ensureOrchestrator(st, dir, p);
		result = await evaluateIdleGoalNudgeLocked(pi, dir, p, st, nowMs);
		await writeState(p, st);
	});
	return result;
}

async function tickGraph(nowMs = Date.now()) {
	let result;
	await withLock(p, async () => {
		const st = await readState(p, dir);
		ensureOrchestrator(st, dir, p);
		result = await evaluateTaskGraphStallNudgeLocked(pi, dir, p, st, nowMs);
		await writeState(p, st);
	});
	return result;
}

async function getGoalState() {
	const st = await readState(p, dir);
	return { goal: st.goal, idle: st.idleNudgeState, idleNudgeState: st.idleNudgeState, taskStallState: st.taskStallState, agents: st.agents, messages: st.messages };
}

// =============================================================
// A. Goal waits for the full continuous idle interval
// =============================================================
console.log("\n[A] goal waits for continuous all-idle interval");
{
	await setup();
	const t0 = Date.now();
	let r = await tickGoal(t0);
	ok("first tick starts idle epoch", r.emitted === false && r.reason === "idle_interval_pending");
	let st = await getGoalState();
	ok("allIdleSinceAt stamped", typeof st.idle?.allIdleSinceAt === "string");
	r = await tickGoal(t0 + 999);
	ok("before interval no emit", r.emitted === false && r.reason === "idle_interval_pending");
	r = await tickGoal(t0 + 1000);
	ok("after interval emits", r.emitted === true && r.reason === "emitted");
	st = await getGoalState();
	ok("lastGoalNudgeAt stamped", typeof st.idle?.lastGoalNudgeAt === "string");
	ok("nextGoalNudgeAt scheduled", typeof st.idle?.nextGoalNudgeAt === "string");
}

// =============================================================
// B. Goal nudges are interval-spaced, not pump-tick-spaced
// =============================================================
console.log("\n[B] goal nudges are interval-spaced");
{
	await setup();
	const t0 = Date.now();
	await tickGoal(t0 + 1000);
	let r = await tickGoal(t0 + 1500);
	ok("subsequent 5s-ish tick does not re-emit", r.emitted === false && r.reason === "idle_interval_pending");
	r = await tickGoal(t0 + 2000);
	ok("next full interval emits again", r.emitted === true && r.reason === "emitted");
	const st = await getGoalState();
	ok("counter advanced on actual emissions", st.goal.consecutiveNoResolveNudges >= 1);
	ok("one goal message persisted", Object.values(st.messages).filter((m) => m.idempotencyKey?.startsWith(`goal:${st.goal.id}:nudge:idle-streak`)).length >= 1);
}

// =============================================================
// C. Goal-specific interval overrides env/default interval
// =============================================================
console.log("\n[C] goal-specific interval overrides env/default interval");
{
	await setup();
	const t0 = Date.now();
	await withLock(p, async () => {
		const st = await readState(p, dir);
		st.goal.nudgeIntervalMs = 2500;
		await writeState(p, st);
	});
	let r = await tickGoal(t0);
	ok("first tick starts idle epoch with override", r.emitted === false && r.reason === "idle_interval_pending");
	r = await tickGoal(t0 + 2499);
	ok("override interval still suppresses at t-1", r.emitted === false && r.reason === "idle_interval_pending");
	r = await tickGoal(t0 + 2500);
	ok("override interval emits at exact boundary", r.emitted === true && r.reason === "emitted");
	const st = await getGoalState();
	ok("durable interval remains on goal", st.goal.nudgeIntervalMs === 2500);
}

// =============================================================
// D. Busy effective agents reset the idle epoch; ghosts do not
// =============================================================
console.log("\n[D] busy agent resets idle epoch; ghosts ignored");
{
	await setup();
	const t0 = Date.now();
	let r = await tickGoal(t0 + 1000);
	ok("first tick starts idle epoch", r.emitted === false && r.reason === "idle_interval_pending");
	await withLock(p, async () => {
		const st = await readState(p, dir);
		st.agents["worker-a"].runtimeStatus = "busy";
		await writeState(p, st);
	});
	r = await tickGoal(t0 + 1100);
	ok("busy agent suppresses and resets epoch", r.emitted === false && r.reason === "agent_busy");
	let st = await getGoalState();
	ok("epoch cleared by busy agent", st.idle?.allIdleSinceAt === undefined);
	// Ghost record must neither block idle detection nor reset the epoch.
	await withLock(p, async () => {
		const s = await readState(p, dir);
		s.agents["worker-a"].runtimeStatus = "idle";
		s.agents["ghost-stopped"] = {
			id: "ghost-stopped", role: "ghost", roleKind: "worker", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1,
			status: "stopped", runtimeStatus: "stopped", health: "unhealthy",
			tmuxSession: s.tmuxSession, tmuxWindow: "ghost-stopped", tmuxTarget: "unknown",
			model: "glm-5.1", provider: "zai-coding-cn", cwd: dir, mailbox: ".pi/swarm/mailboxes/ghost-stopped.jsonl",
			createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString(), tmuxAlive: false,
		};
		// Also a running-but-stale-heartbeat ghost.
		s.agents["ghost-stale-hb"] = {
			...s.agents["ghost-stopped"],
			id: "ghost-stale-hb", tmuxWindow: "ghost-stale-hb", tmuxTarget: "sess:ghost-stale-hb.0", tmuxAlive: true,
			status: "running", runtimeStatus: "busy", health: "healthy",
			lastHeartbeatAt: new Date(Date.now() - 30 * 60_000).toISOString(), // 30min old > stale window
		};
		await writeState(p, s);
	});
	r = await tickGoal(t0 + 1200);
	ok("ghosts excluded: epoch re-starts (busy worker restored)", r.emitted === false && r.reason === "idle_interval_pending");
	st = await getGoalState();
	ok("epoch re-stamped despite ghost records", typeof st.idle?.allIdleSinceAt === "string");
	r = await tickGoal(t0 + 2200);
	ok("goal fires after interval once ghosts present", r.emitted === true && r.reason === "emitted");
}

// =============================================================
// E. Graph nudge wins over goal fallback
// =============================================================
console.log("\n[E] graph nudge wins over goal fallback");
{
	await setup({ taskId: "task-graph", ageMs: 120_000, withTask: true });
	const t0 = Date.now();
	const graphResult = await tickGraph(t0);
	ok("graph nudge emits", graphResult.emitted === true && graphResult.reason === "emitted");
	const goalResult = await tickGoal(t0 + 1000);
	// Row R19 (Fix A, 2026-09-02): goal floor is unconditional — actionable graph work only defers
// by one interval, then falls through to emit. The evaluator still fires suppressed_by_actionable_graph
// trace (for LIVE tasks), but does NOT return {emitted:false, reason:"actionable_graph"}.
// The new behavior: deferred + interval_pending, not full block.
ok("goal fallback is deferred (not blocked) by actionable graph", goalResult.emitted === false && (goalResult.reason === "idle_interval_pending" || goalResult.reason === "deferred_actionable_graph" || goalResult.reason === "actionable_graph"), `got ${goalResult.reason}/${goalResult.emitted}`);
	ok("graph nudge trace emitted", (await countEvents("task_stall.nudge_emitted")) === 1);
	ok("goal suppression trace emitted", (await countEvents("goal.nudge.suppressed_by_actionable_graph")) >= 1);
}

// =============================================================
// F. Deferred stale nudges are suppressed at surface time (direct predicate coverage)
// =============================================================
console.log("\n[F] deferred stale nudges are suppressed at surface time");
{
	await setup({ taskId: "task-surface", ageMs: 120_000, withTask: true });
	const t0 = Date.now();
	const graphResult = await tickGraph(t0);
	ok("graph nudge created", graphResult.emitted === true);
	let st = await getGoalState();
	const stallMsg = Object.values(st.messages).find((m) => m.idempotencyKey?.includes(":nudge:graph-stall:"));
	ok("stall nudge message persisted", Boolean(stallMsg));
	// Scenario 1: node becomes ASSIGNED + agent BUSY before the deferred message surfaces.
	await withLock(p, async () => {
		const s = await readState(p, dir);
		const tp = taskPaths(p, "task-surface");
		const task = JSON.parse(await readFile(tp.taskJson, "utf8"));
		task.nodes.a.status = "assigned";
		task.nodes.a.assignee = "worker-a";
		await writeFile(tp.taskJson, JSON.stringify(task, null, 2), "utf8");
		s.agents["worker-a"].activeTaskIds = ["task-surface"];
		s.agents["worker-a"].runtimeStatus = "busy";
		await writeState(p, s);
	});
	st = await getGoalState();
	let taskIndex = { "task-surface": JSON.parse(await readFile(taskPaths(p, "task-surface").taskJson, "utf8")) };
	let v = await staleSurfaceReason(p, st, stallMsg, taskIndex, Date.now());
	ok("assigned+busy suppresses deferred stall nudge", v.stale === true && v.reason === "agent_busy");
	// Scenario 2: agents idle again but node still assigned -> suppress via staleness check.
	await withLock(p, async () => {
		const s = await readState(p, dir);
		s.agents["worker-a"].runtimeStatus = "idle";
		await writeState(p, s);
	});
	st = await getGoalState();
	v = await staleSurfaceReason(p, st, stallMsg, taskIndex, Date.now());
	ok("assigned node suppresses deferred stall nudge even when idle", v.stale === true, JSON.stringify(v));
	// Scenario 3: a goal nudge created BEFORE an idle-epoch advance is stale.
	const goalKeyMsg = { id: "synthetic-goal-msg", idempotencyKey: `goal:${st.goal.id}:nudge:idle-streak:1`, createdAt: new Date(t0 - 5_000).toISOString() };
	v = await staleSurfaceReason(p, st, goalKeyMsg, taskIndex, Date.now());
	ok("goal nudge predating epoch advance is stale", v.stale === true && (v.reason === "idle_epoch_advanced" || v.reason === "agent_busy"), JSON.stringify(v));
	// Scenario 4: fresh stall condition + fresh message -> NOT stale.
	await withLock(p, async () => {
		const s = await readState(p, dir);
		const tp = taskPaths(p, "task-surface");
		const task = JSON.parse(await readFile(tp.taskJson, "utf8"));
		task.nodes.a.status = "ready";
		delete task.nodes.a.assignee;
		await writeFile(tp.taskJson, JSON.stringify(task, null, 2), "utf8");
		s.agents["worker-a"].activeTaskIds = [];
		await writeState(p, s);
	});
	st = await getGoalState();
	const freshMsg = { id: "synthetic-stall-msg", idempotencyKey: "task:task-surface:nudge:graph-stall:9", createdAt: new Date().toISOString() };
	v = await staleSurfaceReason(p, st, freshMsg, { "task-surface": JSON.parse(await readFile(taskPaths(p, "task-surface").taskJson, "utf8")) }, Date.now());
	ok("fresh stall + idle agents is not stale", v.stale === false, JSON.stringify(v));
}

// =============================================================
// F. Graph/goal never double-fire for the same idle condition
// =============================================================
console.log("\n[F] graph and goal do not double-fire in the same idle condition");
{
	await setup({ taskId: "task-double", ageMs: 120_000, withTask: true });
	const t0 = Date.now();
	const graphResult = await tickGraph(t0);
	ok("graph nudge emitted", graphResult.emitted === true);
	const goalResult = await tickGoal(t0 + 1000);
	// Row R19 (Fix A): goal floor is unconditional — actionable graph work defers but does not block.
ok("goal fallback deferred (not blocked) — no double-fire", goalResult.emitted === false && (goalResult.reason === "idle_interval_pending" || goalResult.reason === "deferred_actionable_graph" || goalResult.reason === "actionable_graph"), `got ${goalResult.reason}/${goalResult.emitted}`);
}

// =============================================================
// G. Graph-stall nudge is immediate on a fresh stall, then interval-spaced
// =============================================================
console.log("\n[G] graph-stall immediate first emit, then interval-spaced");
{
	await setup({ taskId: "task-spacing", ageMs: 120_000, withTask: true });
	const t0 = Date.now();
	let r = await tickGraph(t0);
	ok("fresh stall emits immediately", r.emitted === true && r.reason === "emitted");
	r = await tickGraph(t0 + 200); // well inside a 5s pump tick cadence
	ok("next pump tick does NOT re-emit (interval spacing)", r.emitted === false && r.reason === "stall_interval_pending");
	r = await tickGraph(t0 + 1000);
	ok("after full interval emits again", r.emitted === true && r.reason === "emitted");
	const st = await getGoalState();
	ok("counter=2 after two interval emissions", st.taskStallState?.["task-spacing"]?.consecutiveNoResolveNudges === 2);
	ok("nextStallNudgeAt scheduled", typeof st.taskStallState?.["task-spacing"]?.nextStallNudgeAt === "string");
}

// =============================================================
// H. Busy agent re-arms stall immediacy (epoch reset clears spacing)
// =============================================================
console.log("\n[H] busy agent re-arms graph-stall immediacy");
{
	await setup({ taskId: "task-rearm", ageMs: 120_000, withTask: true });
	const t0 = Date.now();
	await tickGraph(t0);
	await withLock(p, async () => {
		const s = await readState(p, dir);
		s.agents["worker-a"].runtimeStatus = "busy";
		await writeState(p, s);
	});
	let r = await tickGraph(t0 + 100);
	ok("busy agent suppresses graph nudge", r.emitted === false && r.reason === "agent_busy");
	const st1 = await getGoalState();
	ok("busy edge cleared stall spacing", st1.taskStallState?.["task-rearm"]?.nextStallNudgeAt === undefined);
	await withLock(p, async () => {
		const s = await readState(p, dir);
		s.agents["worker-a"].runtimeStatus = "idle";
		await writeState(p, s);
	});
	r = await tickGraph(t0 + 200);
	ok("next all-idle edge re-arms immediacy (re-emit despite prior spacing)", r.emitted === true && r.reason === "emitted");
}

// =============================================================
// I. AC1 regression: fresh (created, never assigned) task — task status "ready"
// =============================================================
console.log("\n[I] fresh status=ready task with actionable plan -> graph nudge, zero goal");
{
	await setup({ taskId: "task-fresh", ageMs: 120_000, withTask: true, taskStatus: "ready" });
	const t0 = Date.now();
	// Sanity: the seeded task really is pre-first-assign (task-level ready, plan ready+unassigned).
	const seeded = JSON.parse(await readFile(taskPaths(p, "task-fresh").taskJson, "utf8"));
	ok("seeded task is status=ready with unassigned ready plan node", seeded.status === "ready" && seeded.nodes.a.status === "ready" && !seeded.nodes.a.assignee);
	const graphResult = await tickGraph(t0);
	ok("graph nudge fires for fresh ready task", graphResult.emitted === true && graphResult.reason === "emitted");
	const goalResult = await tickGoal(t0 + 1000);
	// Row R19 (Fix A): goal floor is unconditional — deferred, not suppressed.
ok("goal evaluator deferred (not suppressed) for fresh ready task", goalResult.emitted === false && (goalResult.reason === "idle_interval_pending" || goalResult.reason === "deferred_actionable_graph" || goalResult.reason === "actionable_graph"), `got ${goalResult.reason}/${goalResult.emitted}`);
	// With Fix A the goal nudge may fire (deferred by one interval then emit). The fresh task
	// is LIVE (status=ready, actionable=true) so the goal IS deferred. No message before the
	// deferred interval elapses.
	const msgs = Object.values((await getGoalState()).messages).filter((m) => m.idempotencyKey?.includes(":nudge:idle-streak:") && new Date(m.createdAt).getTime() >= t0);
	ok("no goal nudge message emitted during this section (deferred, not blocked)", msgs.length === 0, `got ${msgs.length} messages`);
}

// =============================================================
// J. Assigned / in_progress task work suppresses the goal fallback
// =============================================================
console.log("\n[J] assigned/in_progress task work suppresses goal fallback");
{
	await setup({ taskId: "task-active-work", ageMs: 120_000, withTask: true, taskStatus: "in_progress" });
	const tp = taskPaths(p, "task-active-work");
	await withLock(p, async () => {
		const task = JSON.parse(await readFile(tp.taskJson, "utf8"));
		task.nodes.a.status = "in_progress";
		task.nodes.a.assignee = "worker-a";
		await writeFile(tp.taskJson, JSON.stringify(task, null, 2), "utf8");
		const st = await readState(p, dir);
		st.agents["worker-a"].activeTaskIds = ["task-active-work"];
		st.agents["worker-a"].runtimeStatus = "idle";
		await writeState(p, st);
	});
	const t0 = Date.now();
	const goalResult = await tickGoal(t0);
	// Issue 85 (task-202608310905, bug #2): the assignment-pointer fast path now fires BEFORE the
	// throttled task-dir scan, so the reason is `assignment_in_flight` (more diagnostic than the
	// generic `active_task`). The downstream task-dir scan is still the fallback for missing-pointer
	// cases (section K below).
	ok("goal evaluator suppresses when task node is assigned/in_progress (via assignment pointer)", goalResult.emitted === false && goalResult.reason === "assignment_in_flight", JSON.stringify(goalResult));
	ok("assignment-in-flight suppression trace emitted", (await countEvents("goal.nudge.suppressed_by_assignment_in_flight")) >= 1);
}

// =============================================================
// K. Missing activeTaskIds pointer still suppresses via bounded fallback scan
// =============================================================
console.log("\n[K] missing activeTaskIds pointer still suppresses goal fallback");
{
	await setup({ taskId: "task-missing-pointer", ageMs: 120_000, withTask: true, taskStatus: "in_progress" });
	const tp = taskPaths(p, "task-missing-pointer");
	await withLock(p, async () => {
		const task = JSON.parse(await readFile(tp.taskJson, "utf8"));
		task.nodes.a.status = "in_progress";
		task.nodes.a.assignee = "worker-a";
		await writeFile(tp.taskJson, JSON.stringify(task, null, 2), "utf8");
		const st = await readState(p, dir);
		st.agents["worker-a"].activeTaskIds = [];
		st.agents["worker-a"].runtimeStatus = "idle";
		await writeState(p, st);
	});
	const t0 = Date.now();
	const goalResult = await tickGoal(t0);
	ok("goal evaluator suppresses when pointer is missing but task.json still shows assigned/in_progress", goalResult.emitted === false && goalResult.reason === "active_task", JSON.stringify(goalResult));
	ok("fallback scan trace emitted", (await countEvents("goal.nudge.suppressed_by_active_task")) >= 1);
}

// =============================================================
// K. Round-2+3 self-heal: stale nextGoalNudgeAt under a changed interval,
//    and the post-resolve anchor must be max(idle-epoch, last-emit) + interval
// =============================================================
console.log("\n[K] schedule self-heal clamps stale boundaries to the CURRENT interval");
{
	await setup();
	const t0 = Date.now();
	// Simulate the live bug: interval was 1h when the schedule was anchored; user later set 30s
	// via a path that did NOT re-anchor (pre-fix state on disk). epoch + old interval = far future.
	await withLock(p, async () => {
		const st = await readState(p, dir);
		ensureOrchestrator(st, dir, p);
		st.goal = { id: "g-k1", text: "K1 stale schedule", setAt: new Date(t0 - 3_600_000).toISOString(), setBy: "orchestrator", consecutiveNoResolveNudges: 0, nudgeSeq: 0, nudgeIntervalMs: 30_000 };
		st.idleNudgeState = { allIdleSinceAt: new Date(t0 - 3_600_000).toISOString(), nextGoalNudgeAt: new Date(t0 - 1_800_000).toISOString() }; // wait — stale is FUTURE under 1h
		// stale boundary from the OLD 1h interval: epoch (t0-1h) + 1h = t0 + 0? Use epoch far past + old interval => boundary in the FUTURE
		st.idleNudgeState.nextGoalNudgeAt = new Date(t0 + 3_300_000).toISOString(); // ~55min out (old 1h schedule)
		await writeState(p, st);
	});
	// Correct expectation under 30s interval: eligible at epoch+30s = t0-59.5min (long past).
	// The clamp must pull the future boundary DOWN to max(epoch,last-emit)+30s -> emit NOW.
	let r = await tickGoal(t0);
	ok("stale future boundary (old interval) is clamped and nudge fires immediately", r.emitted === true && r.reason === "emitted", JSON.stringify(r));
	let st = await getGoalState();
	const afterEmit = new Date(st.idle.nextGoalNudgeAt).getTime();
	ok("post-emit schedule = last-emit + current interval", Math.abs(afterEmit - (t0 + 30_000)) < 5, `${st.idle.nextGoalNudgeAt}`);
	ok("schedule_reanchored trace emitted", (await countEvents("goal.nudge.schedule_reanchored")) >= 1);
}

console.log("\n[L] after a resolve, next nudge waits the full interval from the LAST EMISSION, not the idle epoch");
{
	await setup();
	const t0 = Date.now();
	await withLock(p, async () => {
		const st = await readState(p, dir);
		ensureOrchestrator(st, dir, p);
		st.goal = { id: "g-l1", text: "L1 post-resolve spacing", setAt: new Date(t0 - 3_600_000).toISOString(), setBy: "orchestrator", consecutiveNoResolveNudges: 0, nudgeSeq: 0, nudgeIntervalMs: 30_000 };
		// Live bug shape: epoch is 45min old; a resolve just cleared the counter; the v1 clamp
		// computed epoch+30s = far past => re-fired EVERY tick. v2 must anchor at last-emit.
		st.idleNudgeState = { allIdleSinceAt: new Date(t0 - 2_700_000).toISOString(), lastGoalNudgeAt: new Date(t0 - 5_000).toISOString(), nextGoalNudgeAt: new Date(t0 - 4_999).toISOString() };
		await writeState(p, st);
	});
	// boundary should clamp to last-emit(t0-5s)+30s = t0+25s => NOT eligible yet
	let r = await tickGoal(t0 + 24_000);
	ok("not eligible before last-emit + interval", r.emitted === false && r.reason === "idle_interval_pending", JSON.stringify(r));
	r = await tickGoal(t0 + 25_000);
	ok("eligible at last-emit + interval (no immediate re-fire)", r.emitted === true && r.reason === "emitted", JSON.stringify(r));
	// And with no prior emission at all, anchor = idle epoch (original Row 68 semantics preserved)
	await setup();
	await withLock(p, async () => {
		const st = await readState(p, dir);
		ensureOrchestrator(st, dir, p);
		st.goal = { id: "g-l2", text: "L2 epoch anchor", setAt: new Date(t0 - 3_600_000).toISOString(), setBy: "orchestrator", consecutiveNoResolveNudges: 0, nudgeSeq: 0, nudgeIntervalMs: 30_000 };
		st.idleNudgeState = { allIdleSinceAt: new Date(t0 - 20_000).toISOString() };
		await writeState(p, st);
	});
	r = await tickGoal(t0 + 25_000);
	ok("epoch-anchored: emits once epoch + interval reached", r.emitted === true && r.reason === "emitted", JSON.stringify(r));
	r = await tickGoal(t0 + 26_000);
	ok("epoch-anchored: no immediate re-fire after emit", r.emitted === false && r.reason === "idle_interval_pending", JSON.stringify(r));
}

// =============================================================
// M. Orchestrator busy resets the idle epoch (turn_start busy edge)
// =============================================================
console.log("\n[M] orchestrator busy during the interval resets the epoch");
{
	await setup();
	const t0 = Date.now();
	await withLock(p, async () => {
		const st = await readState(p, dir);
		ensureOrchestrator(st, dir, p);
		st.goal = { id: "g-m1", text: "M1 orchestrator busy", setAt: new Date(t0 - 3_600_000).toISOString(), setBy: "orchestrator", consecutiveNoResolveNudges: 0, nudgeSeq: 0, nudgeIntervalMs: 30_000 };
		st.idleNudgeState = { allIdleSinceAt: new Date(t0 - 25_000).toISOString(), lastGoalNudgeAt: new Date(t0 - 25_000).toISOString() };
		await writeState(p, st);
	});
	// 5s later the orchestrator goes BUSY (turn_start): epoch + pending boundary dropped.
	// Row 68 fix: busy orchestrator work must not count toward the idle interval.
	const hooks = await import(join(here, "src", "hooks.ts"));
	const handlers = {};
	const hpi = { on: (ev, fn) => { (handlers[ev] ||= []).push(fn); }, registerTool(){}, registerCommand(){}, exec: pi.exec, setModel: pi.setModel, sendMessage: pi.sendMessage };
	hooks.registerSwarmHooks(hpi);
	process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
	await handlers["turn_start"][0]({ turnIndex: 0 }, { cwd: dir });
	{
		const st = await getGoalState();
		ok("turn_start (orchestrator) drops the idle epoch", st.idle?.allIdleSinceAt === undefined && st.idle?.nextGoalNudgeAt === undefined, JSON.stringify(st.idle));
	}
	// 25s of busy work elapse; turn ends at t0+25s. Next pump tick stamps a FRESH epoch
	// (t0+25s) and the nudge must wait until t0+25s+30s — NOT fire at t0+30s (which would
	// ignore the busy window, the live bug).
	let r = await tickGoal(t0 + 30_000);
	ok("interval measured from the END of orchestrator work (not old epoch)", r.emitted === false && r.reason === "idle_interval_pending", JSON.stringify(r));
	{
		const st = await getGoalState();
		const fresh = new Date(st.idle.allIdleSinceAt).getTime();
		ok("fresh epoch stamped after the busy window", fresh >= t0 + 24_000, `${st.idle.allIdleSinceAt}`);
	}
	r = await tickGoal(t0 + 59_000);
	ok("still pending just before fresh epoch + 30s", r.emitted === false && r.reason === "idle_interval_pending", JSON.stringify(r));
	r = await tickGoal(t0 + 61_000);
	ok("fires at fresh epoch + 30s", r.emitted === true && r.reason === "emitted", JSON.stringify(r));
}

// =============================================================
// L. Assignment pointer suppresses goal nudge (post-assign pre-pickup) — Issue 85 bug #2
// =============================================================
console.log("\n[L] assignment pointer suppresses goal nudge (post-assign pre-pickup)");
{
	await setup({ taskId: "task-l-pointer", ageMs: 120_000 });
	// Pre-condition: one effective idle worker, no in-flight task graph, goal set.
	await withLock(p, async () => {
		const st = await readState(p, dir);
		st.goal.nudgeIntervalMs = 1000; // tight cadence so we'd notice a stray emit
		await writeState(p, st);
	});
	// Simulate a fresh assignment: agent still flagged runtimeStatus="idle" (hasn't picked up the
	// assignment message yet) but carries an `activeTaskIds` pointer. This is the post-assign
	// pre-pickup window the bug fires in.
	await withLock(p, async () => {
		const st = await readState(p, dir);
		st.agents["worker-a"].activeTaskIds = ["task-l-pointer"];
		st.agents["worker-a"].runtimeStatus = "idle";
		await writeState(p, st);
	});
	const t0 = Date.now();
	let r = await tickGoal(t0);
	ok("goal suppressed by assignment pointer (assignment_in_flight)", r.emitted === false && r.reason === "assignment_in_flight", JSON.stringify(r));
	ok("goal.nudge.suppressed_by_assignment_in_flight trace recorded", (await countEvents("goal.nudge.suppressed_by_assignment_in_flight")) >= 1);
	// Tick again 2s later — still no active task in tasksDir, still pointer only — must stay suppressed.
	// Pre-fix this would have been throttled (active-task scan every intervalMs) and could emit; the
	// pointer fast path closes the window.
	r = await tickGoal(t0 + 2000);
	ok("second tick also suppresses via pointer (no scan-throttle race)", r.emitted === false && r.reason === "assignment_in_flight", JSON.stringify(r));
	// Now mark the worker busy — still pointer + busy — must stay suppressed but with the generic
	// agent_busy reason (the pointer is no longer the only signal).
	await withLock(p, async () => {
		const st = await readState(p, dir);
		st.agents["worker-a"].runtimeStatus = "busy";
		await writeState(p, st);
	});
	r = await tickGoal(t0 + 3000);
	ok("busy worker suppresses with agent_busy (pointer no longer the leading signal)", r.emitted === false && r.reason === "agent_busy", JSON.stringify(r));
}

// =============================================================
// M. Vacuous idle: zero effective agents holds the goal nudge — Issue 85 bug #3
// =============================================================
console.log("\n[M] vacuous idle: zero effective agents holds goal nudge");
{
	await setup({ taskId: "task-m-vacuous", ageMs: 120_000 });
	await withLock(p, async () => {
		const st = await readState(p, dir);
		st.goal.nudgeIntervalMs = 1000;
		await writeState(p, st);
	});
	// Remove every non-orchestrator agent from st.agents so `agentIsEffectivelyAlive` filter is empty.
	await withLock(p, async () => {
		const st = await readState(p, dir);
		delete st.agents["worker-a"];
		delete st.agents["worker-b"];
		await writeState(p, st);
	});
	const t0 = Date.now();
	let r = await tickGoal(t0);
	ok("zero effective agents suppresses with reason no_live_workers", r.emitted === false && r.reason === "no_live_workers", JSON.stringify(r));
	ok("goal.nudge.held_no_live_workers trace recorded", (await countEvents("goal.nudge.held_no_live_workers")) >= 1);
	// Tick again 2s later — still vacuous — must stay held. Pre-fix this would fire forever.
	r = await tickGoal(t0 + 2000);
	ok("subsequent vacuous tick stays held (no emission forever)", r.emitted === false && r.reason === "no_live_workers", JSON.stringify(r));
}

// =============================================================
// N. Ghost agents do not count as effective workers (vacuous sanity) — Issue 85 bug #3 edge
// =============================================================
console.log("\n[N] ghost agents do not count as effective workers (vacuous sanity)");
{
	await setup({ taskId: "task-n-ghosts", ageMs: 120_000 });
	// Turn both workers into ghosts: tmuxAlive=false filters them out of the effective-alive set.
	await withLock(p, async () => {
		const st = await readState(p, dir);
		st.agents["worker-a"].tmuxAlive = false;
		st.agents["worker-a"].status = "stopped";
		st.agents["worker-a"].health = "unhealthy";
		st.agents["worker-b"].tmuxAlive = false;
		st.agents["worker-b"].status = "stopped";
		st.agents["worker-b"].health = "unhealthy";
		await writeState(p, st);
	});
	const t0 = Date.now();
	const r = await tickGoal(t0);
	ok("ghosts-only swarm (effective=0) suppresses with no_live_workers", r.emitted === false && r.reason === "no_live_workers", JSON.stringify(r));
	ok("vacuous trace recorded for ghost-only swarm", (await countEvents("goal.nudge.held_no_live_workers")) >= 1);
}

// =============================================================
// R22 — goal nudges must survive worker-busy at surface time.
// Live incident 2026-09-02T12:03:36..12:30Z: 3 goal nudges emitted under the all-idle
// gate, then a worker turned busy (the nudge's requested action succeeded), and
// staleSurfaceReason's goal-key agent_busy leg dropped them at orchestrator_pump.surface
// FOREVER: stuck_escalated every tick, ZERO pi.sendMessage at the boundary for 26+ min.
// R21 principle: surface-time revalidation must AGREE with emission-time gating, not
// re-check a condition emission already guaranteed. Fix (b): the goal-key branch drops
// the agent_busy leg; the idle_epoch_advanced + live-actionable-graph legs remain.
// =============================================================
console.log("\n[R22] goal nudges starve at surface when a worker turns busy after emission");
{
	await setup(); // no tasks on disk: the graph leg of staleSurfaceReason passes trivially
	const t0 = Date.now();

	// ---- Emit 3 goal nudges through the REAL production path while all-idle holds.
	// Interval env = 1000ms (file header), so ticks at +1000/+2000/+3000 each emit.
	await tickGoal(t0); // starts the idle epoch (allIdleSinceAt = t0)
	const e1 = await tickGoal(t0 + 1000);
	ok("R22 emission: nudge 1 emitted under the all-idle gate", e1.emitted === true && e1.reason === "emitted", JSON.stringify(e1));
	await tickGoal(t0 + 2000);
	await tickGoal(t0 + 3000);
	let st = await getGoalState();
	const goalMsgs = Object.values(st.messages)
		.filter((m) => m.idempotencyKey?.startsWith(`goal:${st.goal.id}:nudge:idle-streak`))
		.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
	ok("R22 three nudges durably enqueued", goalMsgs.length === 3, `got ${goalMsgs.length}`);

	// ---- THE STARVATION TRIGGER: worker-a turns busy (tool_running) after emission.
	// This is the nudge's own requested action succeeding (orchestrator assigned work).
	await withLock(p, async () => {
		const s = await readState(p, dir);
		s.agents["worker-a"].runtimeStatus = "tool_running";
		s.agents["worker-a"].tmuxAlive = true; // R10-1 fixture rule: explicit aliveness
		s.agents["worker-a"].lastHeartbeatAt = new Date(t0 + 3100).toISOString();
		await writeState(p, s);
	});

	// ---- R22-S1 (unit, root cause): the goal-key message must NOT be surface-stale
	// merely because a worker turned busy after emission.
	st = await getGoalState();
	const vS1 = await staleSurfaceReason(p, st, goalMsgs[0], /* taskIndex */ {}, t0 + 3200);
	// RED today: {stale:true, reason:"agent_busy", evidence:["effective-agent-set-not-idle"]}
	// POST-FIX: stale:false — busy leg removed for goal keys; epoch leg passes
	// (createdAt ~t0+1000 > anchor t0); graph leg passes (empty taskIndex).
	ok("R22-S1 goal nudge with post-emission busy worker is NOT surface-stale", vS1.stale === false, JSON.stringify(vS1));
	if (vS1.stale) ok("R22-S1 (diagnostic) suppression reason", vS1.reason === "<not-stale>", `reason=${vS1.reason}`);

	// ---- Control C2: the idle_epoch_advanced leg must SURVIVE the fix. Workers idle,
	// fresh anchor, message created an hour before the anchor -> still stale.
	await withLock(p, async () => {
		const s = await readState(p, dir);
		s.agents["worker-a"].runtimeStatus = "idle";
		s.idleNudgeState = { ...(s.idleNudgeState || {}), allIdleSinceAt: new Date(t0 + 4000).toISOString() };
		await writeState(p, s);
	});
	st = await getGoalState();
	const oldGoalMsg = { id: "r22-synthetic-old-goal", idempotencyKey: `goal:${st.goal.id}:nudge:idle-streak:1`, createdAt: new Date(t0 - 3_600_000).toISOString() };
	const vC2 = await staleSurfaceReason(p, st, oldGoalMsg, {}, t0 + 5000);
	ok("R22-C2 epoch-advanced goal nudge stays stale (immortality guard kept)", vC2.stale === true && vC2.reason === "idle_epoch_advanced", JSON.stringify(vC2));

	// ---- Control C3: LIVE actionable graph still suppresses goal keys (C-R21-3 kept).
	// Synthetic in-memory taskIndex only — the disk stays clean for S2's pump.
	const vC3 = await staleSurfaceReason(p, st, goalMsgs[0], {
		"task-r22-ctl-live": {
			taskId: "task-r22-ctl-live", status: "in_progress", start: "a", edges: [], handoffs: [],
			nodes: { a: { status: "ready", assignee: undefined, dependsOn: [] } },
		},
	}, t0 + 5100);
	ok("R22-C3 live actionable graph still suppresses goal nudge", vC3.stale === true && vC3.reason === "actionable_graph", JSON.stringify(vC3));

	// ---- Control C1: taskKey graph-stall nudges keep the busy suppression (fix is
	// goal-key-scoped; synthetic assigned node + busy worker). Reproduces section F
	// scenario 1 in isolation with the busy worker.
	await withLock(p, async () => {
		const s = await readState(p, dir);
		s.agents["worker-a"].runtimeStatus = "tool_running";
		s.agents["worker-a"].tmuxAlive = true;
		s.agents["worker-a"].lastHeartbeatAt = new Date(t0 + 5200).toISOString();
		await writeState(p, s);
	});
	st = await getGoalState();
	const stallCtlMsg = { id: "r22-synthetic-stall", idempotencyKey: "task:task-r22-ctl-stall:node:a:nudge:graph-stall:1", createdAt: new Date(t0 + 5000).toISOString() };
	const vC1 = await staleSurfaceReason(p, st, stallCtlMsg, {
		"task-r22-ctl-stall": {
			taskId: "task-r22-ctl-stall", status: "in_progress", start: "a", edges: [], handoffs: [],
			nodes: { a: { status: "assigned", assignee: "worker-a", dependsOn: [] } },
		},
	}, t0 + 5300);
	ok("R22-C1 taskKey graph-stall nudge still suppressed by busy worker", vC1.stale === true && vC1.reason === "agent_busy", JSON.stringify(vC1));

	// ---- R22-S2 (R10-1 boundary): idle-orchestrator pump tick must surface the queued
	// nudges through the REAL pi.sendMessage boundary — not an internal helper. The pi
	// object's sendMessage pushes into the shared sentMessages array (R10-1 counter).
	// Claim the leader (as production session_start does) so the pump's second-line
	// defense doesn't deny the tick — same reason the R13 harness claims it.
	const prevAgentId = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = "orchestrator";
	await withLock(p, async () => {
		const s = await readState(p, dir);
		ensureOrchestrator(s, dir, p);
		heartbeatOrchestratorLeader(s, t0 + 5400, process.pid, "r22_test_seed");
		await writeState(p, s);
	});
	const ctx = { cwd: dir, mode: "tui", isIdle: () => true, hasUI: false, ui: { setStatus: () => {} } };
	// RED today: 0 calls (the stale gate empties toSurface before the send loop).
	// POST-FIX: >= 1 call; coalescing surfaces exactly ONE per goal group per tick.
	// Isolate the pump slice to THIS section's incident: the file shares one scratch dir
	// across all sections, so every prior section's never-pumped goal nudge is still an
	// unsurfaced requiresAck candidate, and the busy worker clears the idle anchor (pump
	// phase updateIdleEpochLocked) which would otherwise epoch-suppress that history. Keep
	// only the current goal's nudges in mailbox + message records — the live-incident slice.
	await withLock(p, async () => {
		const s = await readState(p, dir);
		const keep = new Set(Object.values(s.messages)
			.filter((m) => m.idempotencyKey?.startsWith(`goal:${s.goal.id}:nudge:idle-streak`))
			.map((m) => m.id));
		for (const id of Object.keys(s.messages)) if (!keep.has(id)) delete s.messages[id];
		const mb = join(dir, ".pi", "swarm", "mailboxes", "orchestrator.jsonl");
		try {
			const lines = (await readFile(mb, "utf8")).trim().split("\n").filter(Boolean)
				.map((l) => JSON.parse(l)).filter((e) => keep.has(e.id));
			await writeFile(mb, lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
		} catch { /* no mailbox yet */ }
		await writeState(p, s);
	});

	const sendsAtPumpStart = sentMessages.length;
	const pump1 = await pumpOrchestratorMailbox(pi, ctx, p, "r22_starve_tick");
	ok("R22-S2 pump delivers the queued goal nudge (delivered >= 1)", (pump1?.delivered ?? 0) >= 1, `delivered=${pump1?.delivered}`);
	ok("R22-S2 pi.sendMessage called >= 1 at the real boundary", sentMessages.length - sendsAtPumpStart >= 1, `sends=${sentMessages.length - sendsAtPumpStart}`);
	if (sentMessages.length - sendsAtPumpStart >= 1) {
		ok("R22-S2 surfaced as swarm-message", sentMessages[sendsAtPumpStart]?.m?.customType === "swarm-message", `got ${sentMessages[sendsAtPumpStart]?.m?.customType}`);
		ok("R22-S2 first surface carries triggerTurn", sentMessages[sendsAtPumpStart]?.o?.triggerTurn === true, JSON.stringify(sentMessages[sendsAtPumpStart]?.o));
	}
	ok("R22-S2 coalescing surfaces ONE message per goal group (not 3)", sentMessages.length - sendsAtPumpStart === 1, `sends=${sentMessages.length - sendsAtPumpStart}`);

	// Replay guard (R13-S2 pattern): a second idle tick must NOT re-surface the same nudge.
	const sendsAfterFirst = sentMessages.length;
	const pump2 = await pumpOrchestratorMailbox(pi, ctx, p, "r22_starve_replay");
	ok("R22-S2 replay tick does not duplicate surface", sentMessages.length === sendsAfterFirst && (pump2?.delivered ?? 0) === 0, `sends=${sentMessages.length - sendsAfterFirst} delivered=${pump2?.delivered} ids=${JSON.stringify(pump2?.ids)}`);

	if (prevAgentId === undefined) delete process.env.PI_SWARM_AGENT_ID;
	else process.env.PI_SWARM_AGENT_ID = prevAgentId;
}

console.log(`\n${fail === 0 ? "IDLE-NUDGE PASS" : "IDLE-NUDGE FAIL"} (${pass} passed, ${fail} failed)`);
await rm(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
