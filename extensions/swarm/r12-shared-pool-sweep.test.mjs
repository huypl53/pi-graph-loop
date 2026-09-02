#!/usr/bin/env node
/**
 * R12 P0 — task-close sweep must not kill shared worker pool.
 *
 * Source incident: 2026-09-01T12:51:50 mass-sweep killed `fs-implementer`,
 * `r80-tester`, `r80-reviewer`, `r10-analyst` — all four `releaseReason ===
 * "sole_active_task"`, all four `spawnedForTaskId === null` (shared pool),
 * all four `leaseValidAtSweep === false`. ZERO non-orchestrator workers survived.
 *
 * Root cause (isolated): `sweepTaskWorkersLocked` pre-release `priorActiveByAgent`
 * reconstruction synthesized `[taskId]` for any agent listed in `task.nodes[*].assignee`
 * whose `activeTaskIds` was empty after `releaseTaskFromAllAgents`. That synthesis conflates
 * role evidence (the worker did the work) with ownership evidence (the worker belongs to
 * this task). Shared-pool workers have neither a `spawnedForTaskId` link nor any other
 * durable ownership marker; the only signal that they "did the work" is the transient
 * node.assignee stamp. Branch-B must only consult `spawnedForTaskId === taskId`.
 *
 * Invariants under test (RED→GREEN):
 *   R12-S1: 4 shared-pool workers (no spawnedForTaskId) with empty activeTaskIds AND
 *           each listed as the assignee of a different closing-task node → ZERO kill calls,
 *           all 4 still running.
 *   R12-S2: dedicated per-task worker (spawnedForTaskId === taskId) → IS swept
 *           (preserves the legitimate path).
 *   R12-S3: R10-1 boundary counting — assert kill calls are zero for shared workers and
 *           ≥1 for the dedicated worker at the real `stopAgent` boundary.
 *
 * ISOLATION CONTRACT — SCRATCH CWD ONLY:
 *   - mkdtemp creates a unique temp dir; cwd passed to every tool is `scratch`, NEVER process.cwd().
 *   - PI_SWARM_AGENT_ID + PI_SWARM_IS_ORCHESTRATOR env vars restored at file tail.
 *   - process.cwd() never used; the repo's real .pi/swarm state is never touched.
 *
 * Run: node extensions/swarm/r12-shared-pool-sweep.test.mjs
 */
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { sweepTaskWorkersLocked } = await import(join(here, "src/taskgraph.ts"));
const { paths, withLock, readState, writeState } = await import(join(here, "src/state.ts"));

const scratch = await mkdtemp(join(tmpdir(), `swarm-r12-shared-pool-${process.pid}-${Date.now()}`));
await mkdir(join(scratch, ".pi/swarm"), { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, info) => {
	if (cond) { pass++; console.log("  ok  ", name); }
	else { fail++; console.error("  FAIL", name, info ?? ""); }
};

// ===== scratch helpers =====
async function readEvents() {
	const p = join(scratch, ".pi/swarm/traces/events.jsonl");
	const txt = await readFile(p, "utf8").catch(() => "");
	return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
async function clearEvents() {
	await mkdir(join(scratch, ".pi/swarm/traces"), { recursive: true });
	await writeFile(join(scratch, ".pi/swarm/traces/events.jsonl"), "");
}
async function readStateFile() {
	return JSON.parse(await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
}
async function writeStateFile(state) {
	await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(state, null, 2));
}
async function setupTaskJson(taskId, task) {
	const taskDir = join(scratch, ".pi/swarm/tasks", taskId);
	await mkdir(join(taskDir, "artifacts"), { recursive: true });
	await writeFile(join(taskDir, "task.json"), JSON.stringify(task, null, 2));
}

function makeAgent(id, overrides = {}) {
	const now = new Date().toISOString();
	return {
		id, role: id, roleKind: overrides.roleKind ?? "worker", roleKindExplicit: overrides.roleKind !== undefined,
		capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1,
		status: "running", runtimeStatus: "idle", health: "healthy",
		lastHeartbeatAt: now, lastSessionStartAt: now, lastAgentStartAt: now,
		pid: 1000,
		tmuxSession: "r12", tmuxWindow: id, tmuxTarget: `r12:${id}.0`,
		model: "glm-5.1", provider: "zai-coding-cn",
		cwd: scratch, mailbox: `.pi/swarm/mailboxes/${id}.jsonl`,
		createdAt: now, updatedAt: now,
		...overrides,
	};
}
function makeState(agents) {
	const now = new Date().toISOString();
	return { version: 1, swarmId: "r12-test", cwd: scratch, tmuxSession: "r12", agents, delivered: {}, messages: {}, createdAt: now, updatedAt: now };
}
function makeTask(taskId, nodes = {}) {
	const now = new Date().toISOString();
	return { version: 1, taskId, title: "r12 mass-sweep", goal: "reproduce shared-pool mass-sweep", status: "in_progress", nodes, createdAt: now, updatedAt: now };
}

function makePiMock() {
	// R10-1 boundary counting at the real stop/kill boundary: every `tmux kill-window` /
	// `tmux kill-pane` call is counted per-agent-id. This is the assertion point the plan names.
	const killCalls = [];
	const pi = {
		registerTool: () => {},
		registerCommand: () => {},
		on: () => {},
		setModel: async () => true,
		sendMessage: () => {},
		exec: async (cmd, args) => {
			// Identify kill calls by tmux target arg (args typically: -t <target>).
			if (cmd === "tmux" && (args?.[0] === "kill-window" || args?.[0] === "kill-pane")) {
				const target = args?.find((a) => typeof a === "string" && a.includes(":")) ?? args?.join(" ");
				killCalls.push({ cmd, args: args ?? [], target });
			}
			if (cmd === "tmux" && args?.[0] === "list-panes") return { code: 0, stdout: "1\n", stderr: "" };
			if (cmd === "tmux" && args?.[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	return { pi, killCalls };
}

const ROLES = [
	{ id: "fs-implementer", roleKind: "implementer", node: "implement" },
	{ id: "r80-tester",     roleKind: "tester",      node: "test"      },
	{ id: "r80-reviewer",   roleKind: "reviewer",    node: "review"    },
	{ id: "r10-analyst",    roleKind: "analyst",     node: "plan"      },
];

function buildTaskWithSharedAssignees(taskId, sharedIds) {
	const nodes = {};
	for (const r of ROLES) {
		nodes[r.node] = {
			id: r.node,
			role: r.roleKind,
			status: "done",
			assignee: r.id,
			lastActivityAt: new Date().toISOString(),
		};
	}
	return makeTask(taskId, nodes);
}

function buildStateWithSharedPool(taskId, sharedIds, extraAgents = {}) {
	const agents = { orchestrator: makeAgent("orchestrator", { roleKind: "orchestrator", tmuxTarget: "r12:orchestrator.0" }) };
	for (const id of sharedIds) {
		const roleKind = ROLES.find((r) => r.id === id)?.roleKind ?? "worker";
		// Shared-pool agent: no spawnedForTaskId link, empty activeTaskIds (post-release state).
		agents[id] = makeAgent(id, { roleKind, activeTaskIds: [], status: "running", tmuxTarget: `r12:${id}.0` });
	}
	for (const [id, override] of Object.entries(extraAgents)) {
		const baseAgent = agents[id] ?? makeAgent(id);
		agents[id] = { ...baseAgent, ...override, id };
	}
	return makeState(agents);
}

// =============================================================================
// R12-S1: 4 shared-pool workers + sole closing task + each as node.assignee
//         → ZERO kill calls, all 4 still running. (RED pre-fix, GREEN post-fix.)
// =============================================================================
console.log("\n[R12-S1] shared-pool sole-task workers must NOT be swept");
{
	await clearEvents();
	const taskId = "task-r12-s1";
	const sharedIds = ROLES.map((r) => r.id);
	const state = buildStateWithSharedPool(taskId, sharedIds);
	const task = buildTaskWithSharedAssignees(taskId, sharedIds);
	await writeStateFile(state);
	await setupTaskJson(taskId, task);

	const { pi, killCalls } = makePiMock();
	const path = paths(scratch);
	const result = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await sweepTaskWorkersLocked(pi, scratch, st, taskId, task);
		await writeState(path, st);
		return out;
	});

	ok("R12-S1 sweep returned object outcome", typeof result === "object" && Array.isArray(result.stopped));
	ok("R12-S1 stopped array is EMPTY (no shared-pool workers killed)", result.stopped.length === 0, `got stopped=${JSON.stringify(result.stopped)}`);
	for (const id of sharedIds) {
		ok(`R12-S1 stopped excludes ${id}`, !result.stopped.includes(id));
	}

	// R10-1 boundary counting: zero tmux kill-window / kill-pane calls for any shared-pool worker.
	ok("R12-S1 killCalls.length === 0 (real boundary counter)", killCalls.length === 0, `got ${killCalls.length} kill calls: ${JSON.stringify(killCalls)}`);
	for (const k of killCalls) {
		const ok2 = !sharedIds.some((id) => (k.target || "").includes(id));
		ok(`R12-S1 killCall does NOT target a shared worker: ${JSON.stringify(k)}`, ok2);
	}

	// All four shared-pool agents remain running and unstopped.
	const finalState = await readStateFile();
	for (const id of sharedIds) {
		ok(`R12-S1 ${id}.status === 'running'`, finalState.agents[id]?.status === "running");
		ok(`R12-S1 ${id}.activeTaskIds === []`, Array.isArray(finalState.agents[id]?.activeTaskIds) && finalState.agents[id].activeTaskIds.length === 0);
	}

	// No per-agent sweep traces for any shared-pool worker.
	const events = await readEvents();
	const perAgent = events.filter((e) => e.event === "agent.task_sweep_stopped");
	ok("R12-S1 NO agent.task_sweep_stopped traces for shared workers", perAgent.length === 0, `got ${perAgent.length} per-agent traces`);

	// Summary trace only fires when something was stopped.
	const summary = events.filter((e) => e.event === "task.workers_swept");
	ok("R12-S1 NO task.workers_swept summary trace", summary.length === 0, `got ${summary.length} summary traces`);
}

// =============================================================================
// R12-S2: dedicated per-task worker (spawnedForTaskId === taskId) IS still swept.
// =============================================================================
console.log("\n[R12-S2] dedicated per-task worker IS swept (preserved)");
{
	await clearEvents();
	const taskId = "task-r12-s2";
	const dedicatedId = "dedicated-worker-01";
	const sharedIds = ROLES.map((r) => r.id);
	const state = buildStateWithSharedPool(taskId, sharedIds, {
		[dedicatedId]: { spawnedForTaskId: taskId, activeTaskIds: [], tmuxTarget: `r12:${dedicatedId}.0` },
	});
	const task = buildTaskWithSharedAssignees(taskId, sharedIds);
	await writeStateFile(state);
	await setupTaskJson(taskId, task);

	const { pi, killCalls } = makePiMock();
	const path = paths(scratch);
	const result = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await sweepTaskWorkersLocked(pi, scratch, st, taskId, task);
		await writeState(path, st);
		return out;
	});

	ok("R12-S2 stopped includes the dedicated worker", result.stopped.includes(dedicatedId), `stopped=${JSON.stringify(result.stopped)}`);
	ok("R12-S2 stopped excludes all shared workers", !sharedIds.some((id) => result.stopped.includes(id)));
	ok("R12-S2 exactly one kill call (the dedicated worker)", killCalls.length === 1, `got ${killCalls.length}`);
	ok("R12-S2 killCall targets dedicated worker", killCalls[0]?.target?.includes(dedicatedId));

	const finalState = await readStateFile();
	ok("R12-S2 dedicated worker status === 'stopped'", finalState.agents[dedicatedId]?.status === "stopped");
	for (const id of sharedIds) {
		ok(`R12-S2 ${id}.status === 'running' (still preserved)`, finalState.agents[id]?.status === "running");
	}

	const events = await readEvents();
	const perAgent = events.filter((e) => e.event === "agent.task_sweep_stopped");
	ok("R12-S2 exactly one per-agent trace", perAgent.length === 1, `got ${perAgent.length}`);
	ok("R12-S2 per-agent trace is for the dedicated worker", perAgent[0]?.agentId === dedicatedId);
	ok("R12-S2 trace.releaseReason === 'spawned_for_task'", perAgent[0]?.releaseReason === "spawned_for_task");
	ok("R12-S2 trace.spawnedForTaskId === taskId", perAgent[0]?.spawnedForTaskId === taskId);
}

// =============================================================================
// R12-S3: R10-1 boundary counting assertion at the real stop/kill boundary
//         for shared vs dedicated agents in the same sweep.
// =============================================================================
console.log("\n[R12-S3] R10-1 boundary counting: shared → 0 kills, dedicated → ≥1 kill");
{
	await clearEvents();
	const taskId = "task-r12-s3";
	const dedicatedId = "dedicated-worker-s3";
	const sharedIds = ROLES.map((r) => r.id);
	const state = buildStateWithSharedPool(taskId, sharedIds, {
		[dedicatedId]: { spawnedForTaskId: taskId, activeTaskIds: [], tmuxTarget: `r12:${dedicatedId}.0` },
	});
	const task = buildTaskWithSharedAssignees(taskId, sharedIds);
	await writeStateFile(state);
	await setupTaskJson(taskId, task);

	const { pi, killCalls } = makePiMock();
	const path = paths(scratch);
	const result = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await sweepTaskWorkersLocked(pi, scratch, st, taskId, task);
		await writeState(path, st);
		return out;
	});

	// Per-agent kill-call counter derived from killCalls.target strings.
	const killByAgent = Object.create(null);
	for (const k of killCalls) {
		for (const id of [dedicatedId, ...sharedIds]) {
			if ((k.target || "").includes(id)) {
				killByAgent[id] = (killByAgent[id] ?? 0) + 1;
			}
		}
	}

	ok("R12-S3 killByAgent[dedicated] >= 1", (killByAgent[dedicatedId] ?? 0) >= 1, `got ${killByAgent[dedicatedId]}`);
	for (const id of sharedIds) {
		ok(`R12-S3 killByAgent[${id}] === 0`, killByAgent[id] === 0 || killByAgent[id] === undefined, `got ${killByAgent[id]}`);
	}

	ok("R12-S3 result.stopped === [dedicatedId]", result.stopped.length === 1 && result.stopped[0] === dedicatedId, `stopped=${JSON.stringify(result.stopped)}`);
}

// =============================================================================
// Cleanup: process boundary
// =============================================================================
console.log(`\nR12-SHARED-POOL-SWEEP ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
if (fail > 0) {
	console.error("\n  ↳ RED regression reproduced — fix eligibility branch in sweepTaskWorkersLocked.");
	process.exit(1);
}
process.exit(0);
