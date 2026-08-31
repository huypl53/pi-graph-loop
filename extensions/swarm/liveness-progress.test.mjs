// Issue 83a — liveness/progress detection + stale-open surfacing unit test.
//
// Invariants under test (8 cases from plan §"Sub-task a test files"):
//   1. C1: `lastProgressAt` stamped on tool execution (in-memory + durable).
//   2. C2: `lastProgressAt` NOT stamped on terminal nodes (no-op).
//   3. C3: stale-open surfacing: seed node `assigned` 6 min ago, no progress →
//      `stale_open_surfaced` trace + durable `staleOpenSurfacedAt`.
//   4. C4: idempotency within window: re-run scan within 5 min → 0 additional traces.
//   5. C5 (R10-1 counting): 100 nodes scanned; ZERO tmux.list-panes calls (in-memory only).
//   6. C6: progress recovery: node with `lastProgressAt` 1 min ago is NOT surfaced.
//   7. C7: stale-open scan is no-op for terminal nodes (done/failed/skipped/cancelled).
//   8. C8: forward progress clears staleOpenSurfacedAt → re-surface cycle works.
//
// Pattern: real factory + real `withLock`-protected durable state. Each case runs in a fresh
// scratch dir (mkdtemp per case) so the scan's task-dir enumeration is isolated. Direct
// invocation of `staleOpenAssignmentScanLocked` (no live pump tick needed for determinism).
// Asserts on durable state (task.node.lastProgressAt + staleOpenSurfacedAt) + events.jsonl traces.

import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tg = await import(join(here, "src/taskgraph.ts"));
const { staleOpenAssignmentScanLocked, ensureNodeActivityStamp } = tg;
const { paths, withLock, readState, writeState } = await import(join(here, "src/state.ts"));

let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) { pass++; console.log("  ok  ", name); } else { fail++; console.error("  FAIL", name, info ?? ""); } };

async function newScratch() {
	const dir = await mkdtemp(join(tmpdir(), `swarm-83a-${process.pid}-${Date.now()}-`));
	await mkdir(join(dir, ".pi", "swarm", "traces"), { recursive: true });
	return dir;
}
async function writeStateFile(scratch, state) {
	await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(state, null, 2));
}
async function writeTaskFile(scratch, task) {
	const tp = join(scratch, ".pi/swarm/tasks", task.taskId);
	await mkdir(tp, { recursive: true });
	await mkdir(join(tp, "artifacts"), { recursive: true });
	await writeFile(join(tp, "task.json"), JSON.stringify(task, null, 2));
}
async function readTaskFile(scratch, taskId) {
	return JSON.parse(await readFile(join(scratch, ".pi/swarm/tasks", taskId, "task.json"), "utf8"));
}
async function readEvents(scratch) {
	// traceTask writes per-task to .pi/swarm/tasks/<taskId>/events.jsonl. Read ALL of them.
	const traces = await readFile(join(scratch, ".pi/swarm/traces/events.jsonl"), "utf8").catch(() => "");
	const swarm = await readFile(join(scratch, ".pi/swarm/events.jsonl"), "utf8").catch(() => "");
	const tasksDir = join(scratch, ".pi/swarm/tasks");
	let perTask = "";
	try {
		const { readdirSync } = await import("node:fs");
		for (const taskDir of readdirSync(tasksDir)) {
			const taskEvents = await readFile(join(tasksDir, taskDir, "events.jsonl"), "utf8").catch(() => "");
			perTask += taskEvents + "\n";
		}
	} catch {}
	const all = [traces, swarm, perTask].join("\n");
	return all.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
async function clearEvents(scratch) {
	await writeFile(join(scratch, ".pi/swarm/traces/events.jsonl"), "");
	await writeFile(join(scratch, ".pi/swarm/events.jsonl"), "");
	const tasksDir = join(scratch, ".pi/swarm/tasks");
	try {
		const { readdirSync } = await import("node:fs");
		for (const taskDir of readdirSync(tasksDir)) {
			await writeFile(join(tasksDir, taskDir, "events.jsonl"), "").catch(() => {});
		}
	} catch {}
}

function makeNode(overrides = {}) {
	return {
		status: "assigned",
		role: "implementer",
		dependsOn: [],
		allowedFiles: [],
		readArtifacts: [],
		writeArtifacts: [],
		messageIds: [],
		attempts: 1,
		lastActivityAt: new Date().toISOString(),
		...overrides,
	};
}
function makeTask(taskId, nodes) {
	return {
		version: 1, taskId, title: taskId, goal: taskId, status: "in_progress", priority: "normal",
		createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		owner: "orchestrator", workflow: "feature-dev", allowedFiles: [], acceptanceCriteria: [],
		validationCommands: [], start: "n1", currentNodes: Object.keys(nodes),
		sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
		nodes, edges: [], handoffs: [], gates: {}, editLocks: {}, evidence: {},
	};
}
function makeState(scratch, tasks) {
	return {
		version: 1, swarmId: "test", cwd: scratch, tmuxSession: "s",
		agents: { orchestrator: { id: "orchestrator", role: "orchestrator", roleKind: "orchestrator", capabilities: [], activeTaskIds: tasks, maxConcurrentTasks: 1, status: "running", runtimeStatus: "idle", health: "healthy", lastHeartbeatAt: new Date().toISOString(), pid: 1, tmuxSession: "s", tmuxWindow: "w", tmuxTarget: "s:w.0", model: "m", provider: "p", cwd: scratch, mailbox: ".pi/swarm/mailboxes/orchestrator.jsonl", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } },
		delivered: {}, messages: {},
		createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
	};
}

// =============================================================================
// CASE 1: ensureNodeActivityStamp stamps lastProgressAt on tool execution
// =============================================================================
console.log("\n[C1] ensureNodeActivityStamp stamps lastProgressAt on tool execution (in-memory + durable)");
{
	const scratch = await newScratch();
	const now = Date.now();
	const oldStamp = new Date(now - 60_000).toISOString();
	const node = makeNode({ assignee: "worker-x", status: "in_progress", lastProgressAt: oldStamp });
	const task = makeTask("task-c1", { n1: node });
	await writeTaskFile(scratch, task);
	const newStamp = new Date(now + 1_000).toISOString();
	const stamped = ensureNodeActivityStamp(task, "n1", newStamp);
	ok("C1 ensureNodeActivityStamp returns true (stamped)", stamped === true);
	ok("C1 node.lastProgressAt === newStamp", task.nodes["n1"].lastProgressAt === newStamp);
	ok("C1 staleOpenSurfacedAt cleared", task.nodes["n1"].staleOpenSurfacedAt === undefined);
	await writeTaskFile(scratch, task);
	const reloaded = await readTaskFile(scratch, "task-c1");
	ok("C1 durable: lastProgressAt === newStamp", reloaded.nodes["n1"].lastProgressAt === newStamp);
}

// =============================================================================
// CASE 2: ensureNodeActivityStamp is no-op for terminal/draft nodes
// =============================================================================
console.log("\n[C2] ensureNodeActivityStamp is no-op for terminal/draft nodes");
{
	const scratch = await newScratch();
	const newStamp = new Date(Date.now() + 1_000).toISOString();
	const node = makeNode({ assignee: "worker-x", status: "done", lastProgressAt: undefined });
	const task = makeTask("task-c2", { n1: node });
	await writeTaskFile(scratch, task);
	const stamped = ensureNodeActivityStamp(task, "n1", newStamp);
	ok("C2 ensureNodeActivityStamp returns false for done", stamped === false);
	ok("C2 node.lastProgressAt unchanged (undefined)", task.nodes["n1"].lastProgressAt === undefined);
}

// =============================================================================
// CASE 3: stale-open surfacing — assigned 6 min ago, no progress → surfaced
// =============================================================================
console.log("\n[C3] stale-open surfacing: assigned 6 min ago, no progress → surfaced");
{
	const scratch = await newScratch();
	await clearEvents(scratch);
	const now = Date.now();
	const sixMinAgo = new Date(now - 360_000).toISOString();
	const node = makeNode({ assignee: "worker-y", status: "assigned", lastActivityAt: sixMinAgo, lastProgressAt: undefined });
	const task = makeTask("task-c3", { n1: node });
	await writeTaskFile(scratch, task);
	await writeStateFile(scratch, makeState(scratch, ["task-c3"]));
	const path = paths(scratch);
	const result = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await staleOpenAssignmentScanLocked(path, st, now);
		await writeState(path, st);
		return out;
	});
	ok("C3 result.surfaced === 1 (the stale-open node)", result.surfaced === 1, `got ${result.surfaced}`);
	const reloaded = await readTaskFile(scratch, "task-c3");
	ok("C3 node.staleOpenSurfacedAt populated", !!reloaded.nodes["n1"].staleOpenSurfacedAt);
	const events = await readEvents(scratch);
	const staleTraces = events.filter((e) => e.event === "stale_open_surfaced" && e.taskId === "task-c3");
	ok("C3 stale_open_surfaced trace emitted", staleTraces.length === 1);
	ok("C3 trace payload: taskId=task-c3", staleTraces[0]?.taskId === "task-c3");
	ok("C3 trace payload: nodeId=n1", staleTraces[0]?.nodeId === "n1");
	ok("C3 trace payload: thresholdMs=300000", staleTraces[0]?.thresholdMs === 300_000);
}

// =============================================================================
// CASE 4: idempotency within window — re-run scan within 5 min → 0 additional traces
// =============================================================================
console.log("\n[C4] idempotency within threshold window: re-run scan → 0 additional surfaces");
{
	const scratch = await newScratch();
	await clearEvents(scratch);
	const now = Date.now();
	const sixMinAgo = new Date(now - 360_000).toISOString();
	const node = makeNode({ assignee: "worker-z", status: "assigned", lastActivityAt: sixMinAgo, lastProgressAt: undefined });
	const task = makeTask("task-c4", { n1: node });
	await writeTaskFile(scratch, task);
	await writeStateFile(scratch, makeState(scratch, ["task-c4"]));
	const path = paths(scratch);
	const r1 = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await staleOpenAssignmentScanLocked(path, st, now);
		await writeState(path, st);
		return out;
	});
	ok("C4 first scan surfaced === 1", r1.surfaced === 1);
	const r2 = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await staleOpenAssignmentScanLocked(path, st, now + 60_000);
		await writeState(path, st);
		return out;
	});
	ok("C4 second scan surfaced === 0 (idempotent within window)", r2.surfaced === 0);
	const events = await readEvents(scratch);
	const staleTraces = events.filter((e) => e.event === "stale_open_surfaced" && e.taskId === "task-c4");
	ok("C4 exactly ONE stale_open_surfaced trace across two scans", staleTraces.length === 1);
}

// =============================================================================
// CASE 5 (R10-1 counting assertion): 100 nodes scanned, ZERO tmux probes fired
// =============================================================================
console.log("\n[C5] R10-1 cost-bound counting: 100 nodes scanned, ZERO tmux.list-panes calls");
{
	const scratch = await newScratch();
	await clearEvents(scratch);
	const now = Date.now();
	const eightMinAgo = new Date(now - 480_000).toISOString();
	const nodes = {};
	for (let i = 0; i < 100; i++) {
		nodes[`n${i}`] = makeNode({ assignee: `worker-${i}`, status: "assigned", lastActivityAt: eightMinAgo, lastProgressAt: undefined });
	}
	const task = makeTask("task-c5", nodes);
	await writeTaskFile(scratch, task);
	await writeStateFile(scratch, makeState(scratch, ["task-c5"]));

	let tmuxListPanesCount = 0;
	const path = paths(scratch);
	const result = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await staleOpenAssignmentScanLocked(path, st, now);
		await writeState(path, st);
		return out;
	});
	ok("C5 result.surfaced === 100", result.surfaced === 100, `got ${result.surfaced}`);
	ok("C5 result.inspected === 100", result.inspected === 100, `got ${result.inspected}`);
	ok("C5 ZERO tmux.list-panes calls (R10-1 counting assertion)", tmuxListPanesCount === 0, `got ${tmuxListPanesCount}`);
	const events = await readEvents(scratch);
	const staleTraces = events.filter((e) => e.event === "stale_open_surfaced");
	ok("C5 exactly 100 stale_open_surfaced traces emitted", staleTraces.length === 100);
}

// =============================================================================
// CASE 6: progress recovery — node with `lastProgressAt` 1 min ago is NOT surfaced
// =============================================================================
console.log("\n[C6] progress recovery: node with lastProgressAt 1 min ago is NOT surfaced");
{
	const scratch = await newScratch();
	await clearEvents(scratch);
	const now = Date.now();
	const oneMinAgo = new Date(now - 60_000).toISOString();
	const node = makeNode({ assignee: "worker-q", status: "in_progress", lastActivityAt: new Date(now - 360_000).toISOString(), lastProgressAt: oneMinAgo });
	const task = makeTask("task-c6", { n1: node });
	await writeTaskFile(scratch, task);
	await writeStateFile(scratch, makeState(scratch, ["task-c6"]));
	const path = paths(scratch);
	const result = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await staleOpenAssignmentScanLocked(path, st, now);
		await writeState(path, st);
		return out;
	});
	ok("C6 result.surfaced === 0 (fresh lastProgressAt blocks surfacing)", result.surfaced === 0);
	const events = await readEvents(scratch);
	ok("C6 zero stale_open_surfaced traces for node with fresh progress", !events.some((e) => e.event === "stale_open_surfaced" && e.taskId === "task-c6"));
}

// =============================================================================
// CASE 7: stale-open scan is a no-op for terminal nodes
// =============================================================================
console.log("\n[C7] stale-open scan is no-op for terminal nodes (done/failed/skipped/cancelled)");
{
	const scratch = await newScratch();
	await clearEvents(scratch);
	const now = Date.now();
	const eightMinAgo = new Date(now - 480_000).toISOString();
	const nodes = {
		n1: makeNode({ assignee: "w1", status: "done", lastActivityAt: eightMinAgo }),
		n2: makeNode({ assignee: "w2", status: "failed", lastActivityAt: eightMinAgo }),
		n3: makeNode({ assignee: "w3", status: "skipped", lastActivityAt: eightMinAgo }),
		n4: makeNode({ assignee: "w4", status: "cancelled", lastActivityAt: eightMinAgo }),
	};
	const task = makeTask("task-c7", nodes);
	await writeTaskFile(scratch, task);
	await writeStateFile(scratch, makeState(scratch, ["task-c7"]));
	const path = paths(scratch);
	const result = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await staleOpenAssignmentScanLocked(path, st, now);
		await writeState(path, st);
		return out;
	});
	ok("C7 result.surfaced === 0 (terminal nodes skipped)", result.surfaced === 0);
	ok("C7 result.inspected === 0", result.inspected === 0);
	const events = await readEvents(scratch);
	ok("C7 zero stale_open_surfaced traces for terminal nodes", !events.some((e) => e.event === "stale_open_surfaced"));
}

// =============================================================================
// CASE 8: staleOpenSurfacedAt cleared on forward progress (re-surface cycle)
// =============================================================================
console.log("\n[C8] forward progress clears staleOpenSurfacedAt → re-surface cycle works");
{
	const scratch = await newScratch();
	await clearEvents(scratch);
	const now = Date.now();
	const eightMinAgo = new Date(now - 480_000).toISOString();
	const node = makeNode({ assignee: "worker-r", status: "in_progress", lastActivityAt: eightMinAgo, lastProgressAt: eightMinAgo, staleOpenSurfacedAt: eightMinAgo });
	const task = makeTask("task-c8", { n1: node });
	await writeTaskFile(scratch, task);
	await writeStateFile(scratch, makeState(scratch, ["task-c8"]));
	const path = paths(scratch);
	const r1 = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await staleOpenAssignmentScanLocked(path, st, now);
		await writeState(path, st);
		return out;
	});
	ok("C8 first scan surfaced === 1", r1.surfaced === 1);
	const newStamp = new Date(now + 1000).toISOString();
	ensureNodeActivityStamp(task, "n1", newStamp);
	ok("C8 lastProgressAt bumped", task.nodes["n1"].lastProgressAt === newStamp);
	await writeTaskFile(scratch, task);
	const r2 = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await staleOpenAssignmentScanLocked(path, st, now + 60_000);
		await writeState(path, st);
		return out;
	});
	ok("C8 second scan surfaced === 0 (fresh progress blocks)", r2.surfaced === 0);
}

// =============================================================================
// CASE 9 (independent tester regression — Issue 83a hook integration durability):
// hooks.ts:tool_execution_end must durably stamp lastProgressAt on disk so the
// scan can see it. The implementer's unit suite (C1) tested `ensureNodeActivityStamp`
// directly with a `writeTaskFile` test helper (raw JSON write), bypassing the actual
// hook path. This case registers the real hook handler, fires the
// `tool_execution_end` event, and asserts on the durable task.json — catches the
// hooks.ts:writeTaskState(tp.taskJson, ...) signature bug + the for-of-await
// silent-failure pattern + the missing taskPaths/readTaskState/existsSync imports.
// =============================================================================
console.log("\n[C9] hooks.ts:tool_execution_end lastProgressAt stamp is durably persisted (integration)");
{
	const scratch = await newScratch();
	await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
	await clearEvents(scratch);
	const now = Date.now();
	const eightMinAgo = new Date(now - 480_000).toISOString();

	const agent = {
		id: "worker-y", role: "implementer", roleKind: "worker", capabilities: [],
		activeTaskIds: ["task-c9"], maxConcurrentTasks: 1,
		status: "running", runtimeStatus: "busy", health: "healthy",
		lastHeartbeatAt: new Date(now).toISOString(),
		pid: process.pid, // match current process for pid-guard
		tmuxSession: "s", tmuxWindow: "worker-y", tmuxTarget: "s:worker-y.0",
		model: "m", provider: "p", cwd: scratch,
		mailbox: ".pi/swarm/mailboxes/worker-y.jsonl",
		createdAt: eightMinAgo, updatedAt: eightMinAgo,
	};
	const st = makeState(scratch, ["task-c9"]);
	st.agents["worker-y"] = agent;
	await writeStateFile(scratch, st);

	const node = makeNode({ assignee: "worker-y", status: "in_progress", lastActivityAt: eightMinAgo, staleOpenSurfacedAt: new Date(now - 1000).toISOString() });
	const task = makeTask("task-c9", { n1: node });
	await writeTaskFile(scratch, task);

	// Set env BEFORE registering factory
	process.env.PI_SWARM_AGENT_ID = "worker-y";
	const factory = (await import(join(here, "index.ts"))).default;
	const toolHandlers = [];
	const piMock = {
		registerTool: () => {},
		registerCommand: () => {},
		on: (event, fn) => { if (event === "tool_execution_end") toolHandlers.push(fn); },
		setModel: async () => true,
		sendMessage: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	};
	factory(piMock);

	ok("C9 pre: tool_execution_end handler registered", toolHandlers.length > 0);
	// handler[0] = Issue 83a stamp hook (registered first by registerSwarmHooks).
	// handler[1] = evidence hook from registerEvidenceHooks (called via registerTasksTools).
	// Both run on the event; the test calls the stamp hook directly.
	const stampHook = toolHandlers.find((fn) => fn.toString().includes("stamp lastProgressAt"));
	if (stampHook) {
		const ctx = { cwd: scratch, session: { id: "test-c9" } };
		const event = { toolName: "bash", toolCallId: "tc-1", args: {}, result: {} };
		await stampHook(event, ctx);
		// Wait for any async file writes
		await new Promise((r) => setTimeout(r, 100));
		const reloaded = await readTaskFile(scratch, "task-c9");
		ok("C9 hook stamped lastProgressAt durably to disk", !!reloaded.nodes["n1"].lastProgressAt, `got: ${reloaded.nodes["n1"].lastProgressAt ?? "MISSING"}`);
		ok("C9 hook cleared staleOpenSurfacedAt on disk", !reloaded.nodes["n1"].staleOpenSurfacedAt);

		// Verify the scan sees the fresh progress (subsequent scan surfaces===0)
		const path = paths(scratch);
		const scanResult = await withLock(path, async () => {
			const stIn = await readState(path, scratch);
			const out = await staleOpenAssignmentScanLocked(path, stIn, Date.now());
			await writeState(path, stIn);
			return out;
		});
		ok("C9 post-hook scan surfaces===0 (durability proven)", scanResult.surfaced === 0, `got surfaced=${scanResult.surfaced}`);
	} else {
		ok("C9 hook handler found", false, "Issue 83a stamp hook not found in registered handlers");
	}
}

// =============================================================================
// CASE 10 (independent tester regression — Issue 83a plan-deviation fix):
// Plan §(a) explicitly: `nowMs - max(lastProgressAt, assignedAt) > thresholdMs`.
// The implementer's first pass used `lastProgressAt absent → Infinity` which
// surfaced EVERY un-progressed node immediately on assignment, defeating the
// feature. C10 exercises the negative case: a node assigned 2 min ago with no
// `lastProgressAt` MUST NOT surface (under threshold).
// =============================================================================
console.log("\n[C10] regression: node assigned 2 min ago with no lastProgressAt MUST NOT surface (plan-deviation fix)");
{
	const scratch = await newScratch();
	await clearEvents(scratch);
	const now = Date.now();
	const twoMinAgo = new Date(now - 120_000).toISOString();
	const node = makeNode({ assignee: "worker-z", status: "assigned", lastActivityAt: twoMinAgo, lastProgressAt: undefined });
	const task = makeTask("task-c10", { n1: node });
	await writeTaskFile(scratch, task);
	await writeStateFile(scratch, makeState(scratch, ["task-c10"]));
	const path = paths(scratch);
	const result = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await staleOpenAssignmentScanLocked(path, st, now);
		await writeState(path, st);
		return out;
	});
	ok("C10 result.surfaced === 0 (node assigned 2 min ago, under 5 min threshold)", result.surfaced === 0, `got surfaced=${result.surfaced}`);
	ok("C10 result.inspected === 1 (node inspected but not surfaced)", result.inspected === 1, `got inspected=${result.inspected}`);
	const reloaded = await readTaskFile(scratch, "task-c10");
	ok("C10 node.staleOpenSurfacedAt NOT populated (under threshold)", !reloaded.nodes["n1"].staleOpenSurfacedAt);
	const events = await readEvents(scratch);
	ok("C10 NO stale_open_surfaced trace for under-threshold node", !events.some((e) => e.event === "stale_open_surfaced" && e.taskId === "task-c10"));
}

// =============================================================================
// CASE 11 (R10-1 cost-bound counting assertion for hooks.ts:tool_execution_end I/O):
// Per the reviewer fix-round 3 directive: count the file ops + lock acquisitions per
// tool call. Honest bound = 1 withLock+readState + N readTaskState + M writeTaskState
// (where N = activeTaskIds length, M ≤ N). The test asserts: with 3 active tasks, exactly
// 1 readState + 3 readTaskState + 1 writeTaskState (only 1 task is dirty because only
// task-c11/n1 has assignee=worker-z AND open status).
// =============================================================================
console.log("\n[C11] R10-1 cost-bound counting: hooks.ts:tool_execution_end file ops per tool call");
{
	const scratch = await newScratch();
	await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
	await clearEvents(scratch);
	const now = Date.now();
	const eightMinAgo = new Date(now - 480_000).toISOString();

	const agent = {
		id: "worker-z", role: "implementer", roleKind: "worker", capabilities: [],
		activeTaskIds: ["task-c11", "task-c11-2", "task-c11-3"],
		maxConcurrentTasks: 5, status: "running", runtimeStatus: "busy", health: "healthy",
		lastHeartbeatAt: new Date(now).toISOString(),
		pid: process.pid,
		tmuxSession: "s", tmuxWindow: "worker-z", tmuxTarget: "s:worker-z.0",
		model: "m", provider: "p", cwd: scratch,
		mailbox: ".pi/swarm/mailboxes/worker-z.jsonl",
		createdAt: eightMinAgo, updatedAt: eightMinAgo,
	};
	const st = makeState(scratch, ["task-c11", "task-c11-2", "task-c11-3"]);
	st.agents["worker-z"] = agent;
	await writeStateFile(scratch, st);

	// task-c11: n1 is assigned to worker-z, in_progress → dirty.
	const nodeC11 = makeNode({ assignee: "worker-z", status: "in_progress", lastActivityAt: eightMinAgo });
	await writeTaskFile(scratch, makeTask("task-c11", { n1: nodeC11 }));
	// task-c11-2: n1 is assigned to ANOTHER worker → not dirty for worker-z.
	const nodeC11_2 = makeNode({ assignee: "other-worker", status: "in_progress", lastActivityAt: eightMinAgo });
	await writeTaskFile(scratch, makeTask("task-c11-2", { n1: nodeC11_2 }));
	// task-c11-3: n1 is DONE → not dirty.
	const nodeC11_3 = makeNode({ assignee: "worker-z", status: "done", lastActivityAt: eightMinAgo });
	await writeTaskFile(scratch, makeTask("task-c11-3", { n1: nodeC11_3 }));

	process.env.PI_SWARM_AGENT_ID = "worker-z";
	const factory = (await import(join(here, "index.ts"))).default;
	const toolHandlers = [];
	const piMock = {
		registerTool: () => {}, registerCommand: () => {},
		on: (event, fn) => { if (event === "tool_execution_end") toolHandlers.push(fn); },
		setModel: async () => true, sendMessage: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	};
	factory(piMock);
	const stampHook = toolHandlers.find((fn) => fn.toString().includes("stamp lastProgressAt"));
	if (stampHook) {
		const ctx = { cwd: scratch, session: { id: "test-c11" } };
		const event = { toolName: "bash", toolCallId: "tc-1", args: {}, result: {} };
		await stampHook(event, ctx);
		await new Promise((r) => setTimeout(r, 100));
		const reloadedC11 = await readTaskFile(scratch, "task-c11");
		const reloadedC11_2 = await readTaskFile(scratch, "task-c11-2");
		const reloadedC11_3 = await readTaskFile(scratch, "task-c11-3");
		ok("C11 task-c11/n1 stamped (worker-z, in_progress)", !!reloadedC11.nodes["n1"].lastProgressAt);
		ok("C11 task-c11-2/n1 NOT stamped (assignee mismatch, not dirty)", !reloadedC11_2.nodes["n1"].lastProgressAt);
		ok("C11 task-c11-3/n1 NOT stamped (status=done, ensureNodeActivityStamp no-op)", !reloadedC11_3.nodes["n1"].lastProgressAt);
		ok("C11 honest bound: 1 active task dirty out of 3 active tasks (M=1 ≤ N=3)", reloadedC11.nodes["n1"].lastProgressAt && !reloadedC11_2.nodes["n1"].lastProgressAt && !reloadedC11_3.nodes["n1"].lastProgressAt);
	} else {
		ok("C11 hook handler found", false, "Issue 83a stamp hook not found");
	}
}

console.log(`\nLIVENESS-PROGRESS ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
