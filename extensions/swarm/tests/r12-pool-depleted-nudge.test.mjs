#!/usr/bin/env node
/**
 * R12 P0 — pool-depletion nudge tests (companion to r12-shared-pool-sweep.test.mjs).
 *
 * Contract (R12): a task close that transitions the effective live non-orchestrator agent pool
 * from ≥1 to 0 emits exactly ONE priority-high orchestrator nudge (mailbox record +
 * `pool.depleted_nudge` trace + `deliverMessageLocked(priority: "high")` for Issue 86 interrupt).
 * Transitions that DO NOT nudge: 0 → 0, ≥1 → ≥1. Idempotent within a single sweep call.
 *
 * Invariants under test:
 *   N1 — real depletion (≥1 → 0): dedicated worker IS swept, pool ends at 0 → 1 nudge.
 *   N2 — non-depleting close (≥1 → ≥1): pool still has ≥1 running after sweep → 0 nudges.
 *   N3 — already-empty pool (0 → 0): pool was empty before, idempotent re-run → 0 nudges.
 *   N4 — two depleting closes: two separate task closes that each deplete → 2 nudges total.
 *
 * ISOLATION CONTRACT — SCRATCH CWD ONLY.
 * Run: node extensions/swarm/r12-pool-depleted-nudge.test.mjs
 */
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { sweepTaskWorkersLocked } = await import(join(here, "..", "src/taskgraph.ts"));
const { paths, withLock, readState, writeState } = await import(join(here, "..", "src/state.ts"));

const scratch = await mkdtemp(join(tmpdir(), `swarm-r12-pool-depleted-${process.pid}-${Date.now()}`));
await mkdir(join(scratch, ".pi/swarm"), { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, info) => {
	if (cond) { pass++; console.log("  ok  ", name); }
	else { fail++; console.error("  FAIL", name, info ?? ""); }
};

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
async function readOrchestratorMailbox() {
	const p = join(scratch, ".pi/swarm/mailboxes/orchestrator.jsonl");
	const txt = await readFile(p, "utf8").catch(() => "");
	return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
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
	return { version: 1, swarmId: "r12-nudge-test", cwd: scratch, tmuxSession: "r12", agents, delivered: {}, messages: {}, createdAt: now, updatedAt: now };
}
function makeTask(taskId, nodes = {}) {
	const now = new Date().toISOString();
	return { version: 1, taskId, title: "r12 pool-depleted", goal: "test pool depletion nudge", status: "in_progress", nodes, createdAt: now, updatedAt: now };
}
function makePiMock() {
	const pi = {
		registerTool: () => {},
		registerCommand: () => {},
		on: () => {},
		setModel: async () => true,
		sendMessage: () => {},
		exec: async (cmd, args) => {
			if (cmd === "tmux" && args?.[0] === "list-panes") return { code: 0, stdout: "1\n", stderr: "" };
			if (cmd === "tmux" && args?.[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	return { pi };
}

async function sweep(pi, taskId, task) {
	const path = paths(scratch);
	return await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await sweepTaskWorkersLocked(pi, scratch, st, taskId, task);
		await writeState(path, st);
		return out;
	});
}

function countPoolDepletedTraces(events) {
	return events.filter((e) => e.event === "pool.depleted_nudge");
}
function findPoolDepletedMessages(mailbox) {
	return mailbox.filter((m) => m.subject === "swarm pool depleted" && m.priority === "high");
}

// =============================================================================
// N1: real depletion (≥1 → 0) — single dedicated worker swept → 1 nudge.
// =============================================================================
console.log("\n[N1] real depletion ≥1 → 0 → exactly 1 nudge");
{
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
	await writeFile(join(scratch, ".pi/swarm/mailboxes/orchestrator.jsonl"), "", "utf8");
	await clearEvents();

	const taskId = "task-r12-n1";
	const state = makeState({
		orchestrator: makeAgent("orchestrator", { roleKind: "orchestrator", tmuxTarget: "r12:orchestrator.0" }),
		"dedicated-n1": makeAgent("dedicated-n1", { roleKind: "worker", spawnedForTaskId: taskId, activeTaskIds: [], tmuxTarget: "r12:dedicated-n1.0" }),
	});
	const task = makeTask(taskId, { "node-n1": { id: "node-n1", assignee: "dedicated-n1", status: "done" } });
	await writeStateFile(state);
	await setupTaskJson(taskId, task);

	const { pi } = makePiMock();
	const result = await sweep(pi, taskId, task);

	ok("N1 stopped === ['dedicated-n1']", result.stopped.length === 1 && result.stopped[0] === "dedicated-n1");
	const events = await readEvents();
	const nudges = countPoolDepletedTraces(events);
	ok("N1 exactly 1 pool.depleted_nudge trace", nudges.length === 1, `got ${nudges.length}`);
	if (nudges.length === 1) {
		ok("N1 trace.taskId === taskId", nudges[0].taskId === taskId);
		ok("N1 trace.preSweepLive >= 1", nudges[0].preSweepLive >= 1);
		ok("N1 trace.postSweepLive === 0", nudges[0].postSweepLive === 0);
	}

	const mailbox = await readOrchestratorMailbox();
	const nudgeMsgs = findPoolDepletedMessages(mailbox);
	ok("N1 exactly 1 high-priority orchestrator nudge in mailbox", nudgeMsgs.length === 1, `got ${nudgeMsgs.length}`);
	if (nudgeMsgs.length === 1) {
		ok("N1 nudge.to === 'orchestrator'", nudgeMsgs[0].to === "orchestrator");
		ok("N1 nudge.priority === 'high'", nudgeMsgs[0].priority === "high");
		ok("N1 nudge.subject === 'swarm pool depleted'", nudgeMsgs[0].subject === "swarm pool depleted");
		ok("N1 nudge.idempotencyKey === 'pool_depleted:taskId'", nudgeMsgs[0].idempotencyKey === `pool_depleted:${taskId}`);
		ok("N1 nudge.body references the closed task", nudgeMsgs[0].body?.includes(taskId));
	}
}

// =============================================================================
// N2: non-depleting close (≥1 → ≥1) — dedicated worker swept, 2 others remain → 0 nudges.
// =============================================================================
console.log("\n[N2] non-depleting ≥1 → ≥1 → 0 nudges");
{
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
	await writeFile(join(scratch, ".pi/swarm/mailboxes/orchestrator.jsonl"), "", "utf8");
	await clearEvents();

	const taskId = "task-r12-n2";
	const state = makeState({
		orchestrator: makeAgent("orchestrator", { roleKind: "orchestrator", tmuxTarget: "r12:orchestrator.0" }),
		"dedicated-n2": makeAgent("dedicated-n2", { roleKind: "worker", spawnedForTaskId: taskId, activeTaskIds: [], tmuxTarget: "r12:dedicated-n2.0" }),
		"survivor-n2-a": makeAgent("survivor-n2-a", { roleKind: "worker", activeTaskIds: [], tmuxTarget: "r12:survivor-n2-a.0" }),
		"survivor-n2-b": makeAgent("survivor-n2-b", { roleKind: "worker", activeTaskIds: [], tmuxTarget: "r12:survivor-n2-b.0" }),
	});
	const task = makeTask(taskId, { "node-n2": { id: "node-n2", assignee: "dedicated-n2", status: "done" } });
	await writeStateFile(state);
	await setupTaskJson(taskId, task);

	const { pi } = makePiMock();
	const result = await sweep(pi, taskId, task);

	ok("N2 stopped === ['dedicated-n2']", result.stopped.length === 1 && result.stopped[0] === "dedicated-n2");
	const events = await readEvents();
	const nudges = countPoolDepletedTraces(events);
	ok("N2 NO pool.depleted_nudge trace", nudges.length === 0, `got ${nudges.length}`);

	const mailbox = await readOrchestratorMailbox();
	const nudgeMsgs = findPoolDepletedMessages(mailbox);
	ok("N2 NO high-priority orchestrator nudge", nudgeMsgs.length === 0, `got ${nudgeMsgs.length}`);
}

// =============================================================================
// N3: 0 → 0 — pool empty before close (idempotent re-run path) → 0 nudges.
// =============================================================================
console.log("\n[N3] 0 → 0 → 0 nudges (idempotent / already-empty pool)");
{
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
	await writeFile(join(scratch, ".pi/swarm/mailboxes/orchestrator.jsonl"), "", "utf8");
	await clearEvents();

	const taskId = "task-r12-n3";
	const state = makeState({
		orchestrator: makeAgent("orchestrator", { roleKind: "orchestrator", tmuxTarget: "r12:orchestrator.0" }),
		// No other workers — pool is effectively 0 non-orchestrator agents.
	});
	const task = makeTask(taskId, {});
	await writeStateFile(state);
	await setupTaskJson(taskId, task);

	const { pi } = makePiMock();
	const result = await sweep(pi, taskId, task);

	ok("N3 stopped === [] (nothing to sweep)", result.stopped.length === 0);
	const events = await readEvents();
	const nudges = countPoolDepletedTraces(events);
	ok("N3 NO pool.depleted_nudge trace (0 → 0)", nudges.length === 0, `got ${nudges.length}`);

	const mailbox = await readOrchestratorMailbox();
	const nudgeMsgs = findPoolDepletedMessages(mailbox);
	ok("N3 NO high-priority orchestrator nudge", nudgeMsgs.length === 0);
}

// =============================================================================
// N4: two depleting closes → 2 nudges total (one per close).
// =============================================================================
console.log("\n[N4] two depleting closes → 2 nudges total");
{
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
	await writeFile(join(scratch, ".pi/swarm/mailboxes/orchestrator.jsonl"), "", "utf8");
	await clearEvents();

	const taskA = "task-r12-n4a";
	const taskB = "task-r12-n4b";

	// First close: dedicated-n4a is swept, pool ends at 0 → 1 nudge.
	let state = makeState({
		orchestrator: makeAgent("orchestrator", { roleKind: "orchestrator", tmuxTarget: "r12:orchestrator.0" }),
		"dedicated-n4a": makeAgent("dedicated-n4a", { roleKind: "worker", spawnedForTaskId: taskA, activeTaskIds: [], tmuxTarget: "r12:dedicated-n4a.0" }),
	});
	const taskAObj = makeTask(taskA, { "node-a": { id: "node-a", assignee: "dedicated-n4a", status: "done" } });
	await writeStateFile(state);
	await setupTaskJson(taskA, taskAObj);
	const { pi } = makePiMock();
	await sweep(pi, taskA, taskAObj);

	// Re-spawn a fresh worker, then close taskB (also depleting) → 1 more nudge.
	state = await readStateFile();
	state.agents["dedicated-n4b"] = makeAgent("dedicated-n4b", { roleKind: "worker", spawnedForTaskId: taskB, activeTaskIds: [], tmuxTarget: "r12:dedicated-n4b.0" });
	await writeStateFile(state);
	const taskBObj = makeTask(taskB, { "node-b": { id: "node-b", assignee: "dedicated-n4b", status: "done" } });
	await setupTaskJson(taskB, taskBObj);
	await sweep(pi, taskB, taskBObj);

	const events = await readEvents();
	const nudges = countPoolDepletedTraces(events);
	ok("N4 exactly 2 pool.depleted_nudge traces", nudges.length === 2, `got ${nudges.length}`);
	const taskIds = nudges.map((n) => n.taskId).sort();
	ok("N4 traces cover both taskIds", JSON.stringify(taskIds) === JSON.stringify([taskA, taskB].sort()), `got ${JSON.stringify(taskIds)}`);

	const mailbox = await readOrchestratorMailbox();
	const nudgeMsgs = findPoolDepletedMessages(mailbox);
	ok("N4 exactly 2 high-priority orchestrator nudges", nudgeMsgs.length === 2, `got ${nudgeMsgs.length}`);
	const msgTaskIds = nudgeMsgs.map((m) => m.idempotencyKey).sort();
	ok("N4 nudge idempotencyKeys cover both taskIds", JSON.stringify(msgTaskIds) === JSON.stringify([`pool_depleted:${taskA}`, `pool_depleted:${taskB}`].sort()), `got ${JSON.stringify(msgTaskIds)}`);
}

console.log(`\nR12-POOL-DEPLETED-NUDGE ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
process.exit(0);
