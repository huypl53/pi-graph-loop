// Issue 82 — agent-retirement-sweep lease extensions (P0, R9 a3 graveyard).
//
// Invariants under test (plan §"Unit tests" → "agent-retirement-sweep.test.mjs"):
//   1. Sole-task worker without lease → stopped (existing behavior preserved)
//   2. Sole-task worker WITH leaseKind:"reuse" + valid leaseUntil → skipped (NEW)
//   3. Sole-task worker WITH leaseKind:"park" + valid leaseUntil → paused (NEW) +
//      `agent.task_sweep_parked` trace
//   4. Lease with EXPIRED leaseUntil → default behavior applies (stop)
//   5. Lease with future leaseUntil but agent has OTHER active tasks → still skipped
//      (cross-task rule wins over lease; matches existing rule 2 in sweepTaskWorkersLocked)
//   6. Archived task (missing task.json) — agents with activeTaskIds:[taskId] are still swept
//      using priorActiveByAgent reconstruction
//   7. PI_SWARM_KEEP_TASK_WORKERS=1 opt-out (existing rule, must remain)
//   8. Idempotent re-invocation — second call is a no-op
//
// Pattern: REAL factory + captured `pi.exec("tmux", ...)` mock for stopAgent tmux calls.
// Asserts on durable state mutations + events.jsonl traces. No internal-return mocks.

import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const factory = (await import(join(here, "..", "index.ts"))).default;
const { sweepTaskWorkersLocked } = await import(join(here, "..", "src/taskgraph.ts"));
const { paths, withLock, readState, writeState, writeTaskState, readTaskState } = await import(join(here, "..", "src/state.ts"));

let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) { pass++; console.log("  ok  ", name); } else { fail++; console.error("  FAIL", name, info ?? ""); } };

const scratch = await mkdtemp(join(tmpdir(), `swarm-sweep-${process.pid}-${Date.now()}`));
await mkdir(join(scratch, ".pi", "swarm"), { recursive: true });

async function writeStateFile(state) {
	await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(state, null, 2));
}
async function readStateFile() {
	return JSON.parse(await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
}
async function readEvents() {
	const txt = await readFile(join(scratch, ".pi/swarm/traces/events.jsonl"), "utf8").catch(() => "");
	return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
async function clearEvents() {
	await mkdir(join(scratch, ".pi/swarm/traces"), { recursive: true });
	await writeFile(join(scratch, ".pi/swarm/traces/events.jsonl"), "");
}

function makeAgent(id, overrides = {}) {
	const now = new Date().toISOString();
	return {
		id, role: "worker", roleKind: "worker", capabilities: [],
		activeTaskIds: [], maxConcurrentTasks: 1,
		status: "running", runtimeStatus: "idle", health: "healthy",
		lastHeartbeatAt: now, lastSessionStartAt: now, lastAgentStartAt: now,
		pid: 1000,
		tmuxSession: "s", tmuxWindow: id, tmuxTarget: `s:${id}.0`,
		model: "m", provider: "p", cwd: scratch,
		mailbox: `.pi/swarm/mailboxes/${id}.jsonl`,
		createdAt: now, updatedAt: now,
		...overrides,
	};
}

function makeState(agents) {
	const now = new Date().toISOString();
	return {
		version: 1, swarmId: "test", cwd: scratch, tmuxSession: "s",
		agents, delivered: {}, messages: {},
		createdAt: now, updatedAt: now,
	};
}

function makeTask(taskId, nodes = {}) {
	const now = new Date().toISOString();
	return {
		version: 1, taskId,
		title: "test", goal: "test",
		status: "in_progress", nodes,
		createdAt: now, updatedAt: now,
	};
}

function makePiMock() {
	const execCalls = [];
	const pi = {
		registerTool: (def) => {},
		registerCommand: (name, def) => {},
		on: (ev, fn) => {},
		setModel: async () => true,
		sendMessage: (m, o) => {},
		exec: async (cmd, args) => {
			execCalls.push({ cmd, args });
			if (cmd === "tmux" && (args[0] === "kill-window" || args[0] === "kill-pane" || args[0] === "send-keys")) {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (cmd === "tmux" && args[0] === "list-panes") {
				return { code: 0, stdout: "1\n", stderr: "" };
			}
			if (cmd === "tmux" && args[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	return { pi, execCalls };
}

async function setupTaskJson(taskId, task) {
	const taskDir = join(scratch, ".pi/swarm/tasks", taskId);
	await mkdir(join(taskDir, "artifacts"), { recursive: true });
	await writeFile(join(taskDir, "task.json"), JSON.stringify(task, null, 2));
}

// =============================================================================
// CASE 1: sole-task worker without lease → stopped
// =============================================================================
console.log("\n[C1] sole-task worker without lease → stopped (existing behavior preserved)");
{
	await clearEvents();
	const taskId = "task-c1";
	const state = makeState({
		root: makeAgent("root", { tmuxTarget: "s:root.0" }),
		"worker-c1": makeAgent("worker-c1", { spawnedForTaskId: taskId, activeTaskIds: [taskId], tmuxTarget: "s:worker-c1.0" }),
	});
	const task = makeTask(taskId, { "node-c1": { id: "node-c1", assignee: "worker-c1", status: "done" } });
	await writeStateFile(state);
	await setupTaskJson(taskId, task);
	const { pi } = makePiMock();
	const path = paths(scratch);
	const result = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await sweepTaskWorkersLocked(pi, scratch, st, taskId);
		await writeState(path, st);
		return out;
	});
	const finalState = await readStateFile();
	ok("C1 stopped includes worker-c1", result.stopped?.includes("worker-c1") === true, JSON.stringify(result));
	ok("C1 worker-c1.status === 'stopped'", finalState.agents["worker-c1"]?.status === "stopped");
	const events = await readEvents();
	const trace = events.find((e) => e.event === "agent.task_sweep_stopped" && e.agentId === "worker-c1");
	ok("C1 task_sweep_stopped trace emitted", !!trace);
	ok("C1 trace.releaseReason === 'spawned_for_task'", trace?.releaseReason === "spawned_for_task");
}

// =============================================================================
// CASE 2: sole-task worker WITH reuse lease → skipped
// =============================================================================
console.log("\n[C2] sole-task worker WITH leaseKind:'reuse' + valid leaseUntil → skipped");
{
	await clearEvents();
	const taskId = "task-c2";
	const futureIso = new Date(Date.now() + 3_600_000).toISOString();
	const state = makeState({
		root: makeAgent("root", { tmuxTarget: "s:root.0" }),
		"worker-c2": makeAgent("worker-c2", {
			spawnedForTaskId: taskId, activeTaskIds: [taskId], tmuxTarget: "s:worker-c2.0",
			leaseKind: "reuse", leaseUntil: futureIso, leaseReason: "reuse across tasks",
		}),
	});
	const task = makeTask(taskId, { "node-c2": { id: "node-c2", assignee: "worker-c2", status: "done" } });
	await writeStateFile(state);
	await setupTaskJson(taskId, task);
	const { pi } = makePiMock();
	const path = paths(scratch);
	const result = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await sweepTaskWorkersLocked(pi, scratch, st, taskId);
		await writeState(path, st);
		return out;
	});
	const finalState = await readStateFile();
	ok("C2 worker-c2 NOT in stopped", !result.stopped?.includes("worker-c2"), JSON.stringify(result));
	ok("C2 worker-c2 in skipped as 'lease_reuse'", result.skipped?.some((s) => s.agentId === "worker-c2" && s.reason === "lease_reuse"));
	ok("C2 worker-c2.status unchanged ('running')", finalState.agents["worker-c2"]?.status === "running");
	const events = await readEvents();
	ok("C2 no task_sweep_stopped trace", !events.some((e) => e.event === "agent.task_sweep_stopped" && e.agentId === "worker-c2"));
	ok("C2 no task_sweep_parked trace", !events.some((e) => e.event === "agent.task_sweep_parked" && e.agentId === "worker-c2"));
}

// =============================================================================
// CASE 3: sole-task worker WITH park lease → paused
// =============================================================================
console.log("\n[C3] sole-task worker WITH leaseKind:'park' + valid leaseUntil → paused + parked trace");
{
	await clearEvents();
	const taskId = "task-c3";
	const futureIso = new Date(Date.now() + 3_600_000).toISOString();
	const state = makeState({
		root: makeAgent("root", { tmuxTarget: "s:root.0" }),
		"worker-c3": makeAgent("worker-c3", {
			spawnedForTaskId: taskId, activeTaskIds: [taskId], tmuxTarget: "s:worker-c3.0",
			leaseKind: "park", leaseUntil: futureIso, leaseReason: "park for inspection",
		}),
	});
	const task = makeTask(taskId, { "node-c3": { id: "node-c3", assignee: "worker-c3", status: "done" } });
	await writeStateFile(state);
	await setupTaskJson(taskId, task);
	const { pi } = makePiMock();
	const path = paths(scratch);
	const result = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await sweepTaskWorkersLocked(pi, scratch, st, taskId);
		await writeState(path, st);
		return out;
	});
	const finalState = await readStateFile();
	ok("C3 worker-c3 in stopped (counted as swept)", result.stopped?.includes("worker-c3"));
	ok("C3 worker-c3 also in skipped as 'lease_park'", result.skipped?.some((s) => s.agentId === "worker-c3" && s.reason === "lease_park"));
	ok("C3 worker-c3.paused === true", finalState.agents["worker-c3"]?.paused === true);
	ok("C3 worker-c3.status preserved ('running' — pane kept alive)", finalState.agents["worker-c3"]?.status === "running");
	ok("C3 worker-c3.leaseKind preserved", finalState.agents["worker-c3"]?.leaseKind === "park");
	const events = await readEvents();
	const parked = events.find((e) => e.event === "agent.task_sweep_parked" && e.agentId === "worker-c3");
	ok("C3 task_sweep_parked trace emitted", !!parked);
	ok("C3 trace.leaseKind === 'park'", parked?.leaseKind === "park");
	ok("C3 trace.leaseUntil populated", parked?.leaseUntil === futureIso);
	ok("C3 trace.leaseReason preserved", parked?.leaseReason === "park for inspection");
}

// =============================================================================
// CASE 4: lease with EXPIRED leaseUntil → default behavior (stop)
// =============================================================================
console.log("\n[C4] lease with EXPIRED leaseUntil → default behavior (stop)");
{
	await clearEvents();
	const taskId = "task-c4";
	const expiredIso = new Date(Date.now() - 60_000).toISOString();
	const state = makeState({
		root: makeAgent("root", { tmuxTarget: "s:root.0" }),
		"worker-c4": makeAgent("worker-c4", {
			spawnedForTaskId: taskId, activeTaskIds: [taskId], tmuxTarget: "s:worker-c4.0",
			leaseKind: "reuse", leaseUntil: expiredIso, leaseReason: "expired",
		}),
	});
	const task = makeTask(taskId, { "node-c4": { id: "node-c4", assignee: "worker-c4", status: "done" } });
	await writeStateFile(state);
	await setupTaskJson(taskId, task);
	const { pi } = makePiMock();
	const path = paths(scratch);
	const result = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await sweepTaskWorkersLocked(pi, scratch, st, taskId);
		await writeState(path, st);
		return out;
	});
	ok("C4 worker-c4 stopped (expired lease → default)", result.stopped?.includes("worker-c4"), JSON.stringify(result));
	const events = await readEvents();
	const trace = events.find((e) => e.event === "agent.task_sweep_stopped" && e.agentId === "worker-c4");
	ok("C4 task_sweep_stopped trace emitted", !!trace);
	ok("C4 trace.leaseValidAtSweep === false", trace?.leaseValidAtSweep === false);
}

// =============================================================================
// CASE 5: lease valid but agent has OTHER active tasks → still skipped
// =============================================================================
console.log("\n[C5] lease valid but cross-task → cross-task rule wins (skipped)");
{
	await clearEvents();
	const taskId = "task-c5";
	const otherTaskId = "task-c5-other";
	const futureIso = new Date(Date.now() + 3_600_000).toISOString();
	const state = makeState({
		root: makeAgent("root", { tmuxTarget: "s:root.0" }),
		"worker-c5": makeAgent("worker-c5", {
			spawnedForTaskId: taskId, activeTaskIds: [taskId, otherTaskId], tmuxTarget: "s:worker-c5.0",
			leaseKind: "reuse", leaseUntil: futureIso, leaseReason: "reuse",
		}),
	});
	const task = makeTask(taskId, { "node-c5": { id: "node-c5", assignee: "worker-c5", status: "done" } });
	await writeStateFile(state);
	await setupTaskJson(taskId, task);
	const { pi } = makePiMock();
	const path = paths(scratch);
	const result = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await sweepTaskWorkersLocked(pi, scratch, st, taskId);
		await writeState(path, st);
		return out;
	});
	ok("C5 worker-c5 NOT in stopped (cross-task wins)", !result.stopped?.includes("worker-c5"), JSON.stringify(result));
	ok("C5 skipped as 'cross_task_active'", result.skipped?.some((s) => s.agentId === "worker-c5" && s.reason === "cross_task_active"));
}

// =============================================================================
// CASE 6: archived task (missing task.json) — agents still swept via priorActiveByAgent
// =============================================================================
console.log("\n[C6] archived task (missing task.json) → agents with activeTaskIds:[taskId] still swept");
{
	await clearEvents();
	const taskId = "task-c6-archived";
	const state = makeState({
		root: makeAgent("root", { tmuxTarget: "s:root.0" }),
		"worker-c6": makeAgent("worker-c6", { activeTaskIds: [taskId], tmuxTarget: "s:worker-c6.0", spawnedForTaskId: taskId }),
	});
	await writeStateFile(state);
	// Deliberately DO NOT create task.json — simulates archived-by-hand task
	const { pi } = makePiMock();
	const path = paths(scratch);
	const result = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await sweepTaskWorkersLocked(pi, scratch, st, taskId);
		await writeState(path, st);
		return out;
	});
	ok("C6 worker-c6 swept (archived task path)", result.stopped?.includes("worker-c6"), JSON.stringify(result));
	const events = await readEvents();
	ok("C6 task_sweep_stopped trace emitted", events.some((e) => e.event === "agent.task_sweep_stopped" && e.agentId === "worker-c6"));
}

// =============================================================================
// CASE 7: PI_SWARM_KEEP_TASK_WORKERS=1 opt-out (existing rule preserved)
// =============================================================================
console.log("\n[C7] PI_SWARM_KEEP_TASK_WORKERS=1 → opt-out");
{
	await clearEvents();
	const taskId = "task-c7";
	const state = makeState({
		root: makeAgent("root", { tmuxTarget: "s:root.0" }),
		"worker-c7": makeAgent("worker-c7", { spawnedForTaskId: taskId, activeTaskIds: [taskId], tmuxTarget: "s:worker-c7.0" }),
	});
	const task = makeTask(taskId, { "node-c7": { id: "node-c7", assignee: "worker-c7", status: "done" } });
	await writeStateFile(state);
	await setupTaskJson(taskId, task);
	const { pi } = makePiMock();
	const path = paths(scratch);
	const prevEnv = process.env.PI_SWARM_KEEP_TASK_WORKERS;
	process.env.PI_SWARM_KEEP_TASK_WORKERS = "1";
	try {
		const result = await withLock(path, async () => {
			const st = await readState(path, scratch);
			return await sweepTaskWorkersLocked(pi, scratch, st, taskId);
		});
		ok("C7 result === 'opt_out'", result === "opt_out", JSON.stringify(result));
	} finally {
		if (prevEnv === undefined) delete process.env.PI_SWARM_KEEP_TASK_WORKERS;
		else process.env.PI_SWARM_KEEP_TASK_WORKERS = prevEnv;
	}
}

// =============================================================================
// CASE 8: idempotent re-invocation
// =============================================================================
console.log("\n[C8] idempotent re-invocation: second call is a no-op");
{
	await clearEvents();
	const taskId = "task-c8";
	const state = makeState({
		root: makeAgent("root", { tmuxTarget: "s:root.0" }),
		"worker-c8": makeAgent("worker-c8", { spawnedForTaskId: taskId, activeTaskIds: [taskId], tmuxTarget: "s:worker-c8.0" }),
	});
	const task = makeTask(taskId, { "node-c8": { id: "node-c8", assignee: "worker-c8", status: "done" } });
	await writeStateFile(state);
	await setupTaskJson(taskId, task);
	const { pi } = makePiMock();
	const path = paths(scratch);
	const r1 = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await sweepTaskWorkersLocked(pi, scratch, st, taskId);
		await writeState(path, st); // persistence is the caller's job; matches tools/tasks.ts pattern
		return out;
	});
	ok("C8 first call: worker-c8 stopped", r1.stopped?.includes("worker-c8"));
	const r2 = await withLock(path, async () => {
		const st = await readState(path, scratch);
		return await sweepTaskWorkersLocked(pi, scratch, st, taskId);
	});
	ok("C8 second call: worker-c8 in skipped as 'already_stopped'", r2.skipped?.some((s) => s.agentId === "worker-c8" && s.reason === "already_stopped"), JSON.stringify(r2));
	const eventsAfter2 = await readEvents();
	const tracesForWorker = eventsAfter2.filter((e) => e.event === "agent.task_sweep_stopped" && e.agentId === "worker-c8");
	ok("C8 exactly ONE task_sweep_stopped trace (idempotent)", tracesForWorker.length === 1, `got ${tracesForWorker.length}`);
}


// =============================================================================
// CASE C-R11-2: live assignment in closing graph → worker is NEVER swept
// (kill-sweep blast-radius guard; 2026-09-01: 6 workers force-killed mid-cycle)
// =============================================================================
console.log("\n[C-R11-2] live assigned/in_progress node → skipped as live_assignment_in_graph");
{
	await clearEvents();
	const taskId = "task-c-r112";
	const state = makeState({
		root: makeAgent("root", { tmuxTarget: "s:root.0" }),
		"worker-c1": makeAgent("worker-c1", { spawnedForTaskId: taskId, activeTaskIds: [taskId], tmuxTarget: "s:worker-c1.0" }),
	});
	// Re-armed sub-task cycle: one node closed, one node LIVE (assigned to the same worker).
	const task = makeTask(taskId, {
		"node-a": { id: "node-a", assignee: "worker-c1", status: "done" },
		"node-b": { id: "node-b", assignee: "worker-c1", status: "assigned" },
	});
	await writeStateFile(state);
	await setupTaskJson(taskId, task);
	const { pi } = makePiMock();
	const path = paths(scratch);
	const result = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await sweepTaskWorkersLocked(pi, scratch, st, taskId, task);
		await writeState(path, st);
		return out;
	});
	ok("C-R11-2 worker NOT stopped", result.stopped?.includes("worker-c1") !== true, JSON.stringify(result));
	ok("C-R11-2 skipped reason live_assignment_in_graph", result.skipped?.some((s) => s.agentId === "worker-c1" && s.reason === "live_assignment_in_graph") === true, JSON.stringify(result));
	const finalState = await readStateFile();
	ok("C-R11-2 worker still running", finalState.agents["worker-c1"]?.status === "running");
	ok("C-R11-2 activeTaskIds preserved", Array.isArray(finalState.agents["worker-c1"]?.activeTaskIds) && finalState.agents["worker-c1"].activeTaskIds.includes(taskId));
}

console.log(`\nAGENT-RETIREMENT-SWEEP ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
