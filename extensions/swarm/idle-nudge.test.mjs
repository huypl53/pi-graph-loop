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
const { evaluateIdleGoalNudgeLocked, evaluateTaskGraphStallNudgeLocked, staleSurfaceReason, updateIdleEpochLocked } = await import(join(here, "src", "reconcile.ts"));
const { ensureOrchestrator } = await import(join(here, "src", "identity.ts"));
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
	ok("goal fallback is suppressed when actionable graph exists", goalResult.emitted === false && goalResult.reason === "actionable_graph");
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
	ok("goal fallback suppressed instead of double-firing", goalResult.emitted === false && goalResult.reason === "actionable_graph");
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
	ok("goal evaluator suppressed (actionable_graph) for fresh ready task", goalResult.emitted === false && goalResult.reason === "actionable_graph");
	ok("no goal nudge message emitted during this section", !Object.values((await getGoalState()).messages).some((m) => m.idempotencyKey?.includes(":nudge:idle-streak:") && new Date(m.createdAt).getTime() >= t0));
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
	ok("goal evaluator suppresses when task node is assigned/in_progress", goalResult.emitted === false && goalResult.reason === "active_task", JSON.stringify(goalResult));
	ok("active-work suppression trace emitted", (await countEvents("goal.nudge.suppressed_by_active_task")) >= 1);
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

console.log(`\n${fail === 0 ? "IDLE-NUDGE PASS" : "IDLE-NUDGE FAIL"} (${pass} passed, ${fail} failed)`);
await rm(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
