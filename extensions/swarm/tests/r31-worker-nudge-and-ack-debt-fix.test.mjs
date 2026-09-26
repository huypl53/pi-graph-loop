/**
 * extensions/swarm/tests/r31-worker-nudge-and-ack-debt-fix.test.mjs
 *
 * R31:
 * 1. Eliminate phantom ACK debt under PI_SWARM_MINIMAL_PROTOCOL=1
 *    - swarm_assign_task must set requiresAck: false under minimal protocol.
 *    - hooks.ts agent_settled must NOT generate "owing unacked ack(s)" notifies to root.
 * 2. 2-Tier Response-Missing Handling:
 *    - First settle with missing response: nudge WORKER directly in its own pane,
 *      do NOT block worker (keep idle) and do NOT notify root.
 *    - Second settle / unresponsiveness: escalate to root and mark response_missing.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { paths, withLock, readState, writeState } = await import(join(here, "..", "src/state.ts"));
const { ensureRoot, heartbeatRootLeader } = await import(join(here, "..", "src/identity.ts"));
const { deliverMessageLocked, readMailbox } = await import(join(here, "..", "src/mailbox.ts"));
const { registerMessagesTools } = await import(join(here, "..", "src/tools/messages.ts"));
const { registerTasksTools } = await import(join(here, "..", "src/tools/tasks.ts"));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
	if (cond) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.log(`  FAIL ${name}${detail ? " " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`);
	}
}

let scenarioIdx = 0;
function freshScratch() {
	scenarioIdx++;
	return mkdtempSync(join(tmpdir(), `swarm-r31-s${scenarioIdx}-${process.pid}-${Date.now()}`));
}

function makeMockPi() {
	const sentMessages = [];
	const eventHandlers = {};
	const tools = {};
	const pi = {
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		sendMessage: (msg, opts) => {
			sentMessages.push({ msg, opts, atMs: Date.now() });
			return undefined;
		},
		registerTool: (tool) => {
			tools[tool.name] = tool;
		},
		registerCommand: () => {},
		on: (event, handler) => {
			eventHandlers[event] = eventHandlers[event] || [];
			eventHandlers[event].push(handler);
		},
	};
	return { pi, sentMessages, eventHandlers, tools };
}

console.log("=== R31: Inferred ACK & 2-Tier Response Missing Validation ===");

// --- Scenario 1: Assignment requiresAck under minimal protocol ---
console.log("\n[R31-S1] swarm_assign_task under PI_SWARM_MINIMAL_PROTOCOL=1 sets requiresAck: false");
{
	const scratch = freshScratch();
	const p = paths(scratch);
	mkdirSync(p.root, { recursive: true });
	mkdirSync(p.traces, { recursive: true });
	mkdirSync(p.mailboxes, { recursive: true });
	mkdirSync(p.tasksDir, { recursive: true });

	const { pi, tools } = makeMockPi();
	registerTasksTools(pi);

	const workerId = "worker-r31-1";
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		ensureRoot(st, scratch, p);
		heartbeatRootLeader(st, Date.now(), process.pid, "test_r31_s1");
		st.agents[workerId] = {
			id: workerId,
			name: workerId,
			cwd: scratch,
			role: "worker",
			status: "running",
			tmuxTarget: "session:1.0",
			heartbeatAt: new Date().toISOString(),
			createdAt: new Date().toISOString(),
			activeTaskIds: [],
		};
		await writeState(p, st);
	});

	process.env.PI_SWARM_AGENT_ID = "root";
	process.env.PI_SWARM_IS_ROOT = "1";
	process.env.PI_SWARM_MINIMAL_PROTOCOL = "1";

	// Create task
	await tools.swarm_create_task.execute(
		"create-1",
		{
			taskId: "task-r31-test",
			title: "R31 test task",
			nodes: [{ id: "node-1", title: "Step 1", allowedFiles: ["step1.txt"] }],
		},
		undefined,
		undefined,
		{ cwd: scratch },
	);

	// Assign task to worker
	await tools.swarm_assign_task.execute(
		"assign-1",
		{
			taskId: "task-r31-test",
			nodeId: "0",
			agentId: workerId,
		},
		undefined,
		undefined,
		{ cwd: scratch },
	);

	const workerMsgs = await readMailbox(p, workerId);
	const assignMsg = workerMsgs.find((m) => m.subject && m.subject.includes("assigned"));

	ok("R31-S1 assignment message exists in worker mailbox", Boolean(assignMsg));
	ok("R31-S1 assignment message requiresAck is false under minimal protocol", assignMsg?.requiresAck === false, {
		requiresAck: assignMsg?.requiresAck,
	});
}

// --- Scenario 2: 2-Tier Response Missing: Settle 1 nudges worker, not root ---
console.log("\n[R31-S2] Worker settle 1 with requiresResponse missing -> nudges worker, root stays quiet");
{
	const scratch = freshScratch();
	const p = paths(scratch);
	mkdirSync(p.root, { recursive: true });
	mkdirSync(p.traces, { recursive: true });
	mkdirSync(p.mailboxes, { recursive: true });
	mkdirSync(p.tasksDir, { recursive: true });

	const { registerSwarmHooks } = await import(join(here, "..", "src/hooks.ts"));
	const { pi, eventHandlers } = makeMockPi();
	registerSwarmHooks(pi);

	const workerId = "worker-r31-2";
	let assignMsgId = "";
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		ensureRoot(st, scratch, p);
		heartbeatRootLeader(st, Date.now(), process.pid, "test_r31_s2");
		st.agents[workerId] = {
			id: workerId,
			name: workerId,
			cwd: scratch,
			role: "worker",
			status: "running",
			tmuxTarget: "session:2.0",
			heartbeatAt: new Date().toISOString(),
			createdAt: new Date().toISOString(),
			activeTaskIds: [],
		};

		// Seed a requiresResponse assignment
		process.env.PI_SWARM_AGENT_ID = "root";
		process.env.PI_SWARM_IS_ROOT = "1";
		const res = await deliverMessageLocked(pi, scratch, p, st, {
			to: workerId,
			subject: "Task node assigned",
			body: "Please implement node",
			conversationId: "task:t1:n1",
			requiresAck: false,
			requiresResponse: true,
		});
		assignMsgId = res.msg.id;
		await writeState(p, st);
	});

	// Worker settles for the FIRST time without responding
	process.env.PI_SWARM_AGENT_ID = workerId;
	process.env.PI_SWARM_IS_ROOT = "";
	process.env.PI_SWARM_MINIMAL_PROTOCOL = "1";

	const settleHandler = eventHandlers["agent_settled"]?.[0];
	ok("R31-S2 agent_settled handler registered", Boolean(settleHandler));

	const ctx = {
		cwd: scratch,
		mode: "tui",
		isIdle: () => true,
		hasUI: false,
		ui: { setStatus: () => {} },
	};
	await settleHandler({}, ctx);

	// Check worker mailbox: should have received a reminder nudge!
	const workerMsgs = await readMailbox(p, workerId);
	const reminderToWorker = workerMsgs.find((m) => m.replyTo === assignMsgId || m.subject?.includes("Missing verified response"));
	ok("R31-S2 worker received self-nudge on settle 1", Boolean(reminderToWorker), { workerMsgsCount: workerMsgs.length });

	// Check root mailbox: should NOT have received response_missing alert on strike 1!
	const rootMsgs = await readMailbox(p, "root");
	const rootAlertOnStrike1 = rootMsgs.find((m) => m.subject?.includes("missing response"));
	ok("R31-S2 root did NOT receive response_missing on strike 1", !rootAlertOnStrike1, {
		rootMsgs: rootMsgs.map((m) => m.subject),
	});

	// Check worker status: should NOT be blocked to response_missing on strike 1
	const stAfterStrike1 = await readState(p, scratch);
	ok(
		"R31-S2 worker runtimeStatus is NOT response_missing on strike 1",
		stAfterStrike1.agents[workerId]?.runtimeStatus !== "response_missing",
		{
			status: stAfterStrike1.agents[workerId]?.runtimeStatus,
		},
	);

	// --- Strike 2: Worker settles AGAIN without responding -> now escalate to root! ---
	await settleHandler({}, ctx);

	const rootMsgsAfterStrike2 = await readMailbox(p, "root");
	const rootAlertOnStrike2 = rootMsgsAfterStrike2.find((m) => m.subject?.includes("missing response"));
	ok("R31-S2 root received response_missing on strike 2 (escalation)", Boolean(rootAlertOnStrike2));

	const stAfterStrike2 = await readState(p, scratch);
	ok(
		"R31-S2 worker runtimeStatus is response_missing on strike 2",
		stAfterStrike2.agents[workerId]?.runtimeStatus === "response_missing",
		{
			status: stAfterStrike2.agents[workerId]?.runtimeStatus,
		},
	);
}

// --- Scenario 3: swarm_reconcile under PI_SWARM_MINIMAL_PROTOCOL=1 does NOT return awaiting_ack or ack_missing ---
console.log("\n[R31-S3] swarm_reconcile under PI_SWARM_MINIMAL_PROTOCOL=1 does not report awaiting_ack or ack_missing");
{
	const scratch = freshScratch();
	const p = paths(scratch);
	mkdirSync(p.root, { recursive: true });
	mkdirSync(p.traces, { recursive: true });
	mkdirSync(p.mailboxes, { recursive: true });
	mkdirSync(p.tasksDir, { recursive: true });

	const { pi, tools } = makeMockPi();
	registerMessagesTools(pi);

	const workerId = "worker-r31-3";
	let testMsgId;
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		ensureRoot(st, scratch, p);
		st.agents[workerId] = {
			id: workerId,
			name: workerId,
			cwd: scratch,
			role: "worker",
			status: "running",
			tmuxTarget: "session:1.0",
			heartbeatAt: new Date().toISOString(),
			createdAt: new Date().toISOString(),
			activeTaskIds: [],
		};
		// Deliver a legacy or requiresAck message that has not been acked
		const res = await deliverMessageLocked(pi, scratch, p, st, {
			to: workerId,
			from: "root",
			subject: "Test unacked message",
			body: "Hello",
			requiresAck: true,
		});
		testMsgId = res.msg.id;
		await writeState(p, st);
	});

	process.env.PI_SWARM_AGENT_ID = "root";
	process.env.PI_SWARM_IS_ROOT = "1";
	process.env.PI_SWARM_MINIMAL_PROTOCOL = "1";

	const recRes = await tools.swarm_reconcile.execute("reconcile-1", { dryRun: true }, undefined, undefined, { cwd: scratch });

	const actions = recRes.details?.actions || [];
	const hasAwaitingAck = actions.some((a) => a.action === "awaiting_ack" || a.action === "ack_missing");
	ok("R31-S3 swarm_reconcile does NOT return awaiting_ack or ack_missing actions under minimal protocol", !hasAwaitingAck, {
		actions,
	});
}

// --- Scenario 4: swarm_stop_agent under PI_SWARM_MINIMAL_PROTOCOL=1 does NOT send phantom ack debt notify ---
console.log("\n[R31-S4] swarm_stop_agent under PI_SWARM_MINIMAL_PROTOCOL=1 does not notify root about ack debt");
{
	const scratch = freshScratch();
	const p = paths(scratch);
	mkdirSync(p.root, { recursive: true });
	mkdirSync(p.traces, { recursive: true });
	mkdirSync(p.mailboxes, { recursive: true });
	mkdirSync(p.tasksDir, { recursive: true });

	const { registerAgentsTools } = await import(join(here, "..", "src/tools/agents.ts"));
	const { pi, tools } = makeMockPi();
	registerAgentsTools(pi);

	const workerId = "worker-r31-4";
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		ensureRoot(st, scratch, p);
		st.agents[workerId] = {
			id: workerId,
			name: workerId,
			cwd: scratch,
			role: "worker",
			status: "running",
			tmuxTarget: "session:1.0",
			heartbeatAt: new Date().toISOString(),
			createdAt: new Date().toISOString(),
			activeTaskIds: [],
		};
		// Seed unacked message
		await deliverMessageLocked(pi, scratch, p, st, {
			to: workerId,
			from: "root",
			subject: "Unacked task",
			body: "Do this",
			requiresAck: true,
		});
		await writeState(p, st);
	});

	process.env.PI_SWARM_AGENT_ID = "root";
	process.env.PI_SWARM_IS_ROOT = "1";
	process.env.PI_SWARM_MINIMAL_PROTOCOL = "1";

	await tools.swarm_stop_agent.execute("stop-1", { agentId: workerId, force: true }, undefined, undefined, { cwd: scratch });

	const rootMsgs = await readMailbox(p, "root");
	const ackDebtMsg = rootMsgs.find((m) => m.subject?.includes("unacked ack(s)"));
	ok("R31-S4 swarm_stop_agent does NOT notify root about unacked ack(s)", !ackDebtMsg, {
		rootMsgs: rootMsgs.map((m) => m.subject),
	});
}

// --- Scenario 5: taskgraph canCloseNode does NOT block on unacknowledged assignment under minimal protocol ---
console.log("\n[R31-S5] taskgraph canCloseNode does NOT block on unacknowledged assignment under minimal protocol");
{
	const scratch = freshScratch();
	const p = paths(scratch);
	mkdirSync(p.root, { recursive: true });
	mkdirSync(p.traces, { recursive: true });
	mkdirSync(p.mailboxes, { recursive: true });
	mkdirSync(p.tasksDir, { recursive: true });

	const { computeNodeClosureSummary } = await import(join(here, "..", "src/taskgraph.ts"));
	const { pi } = makeMockPi();
	const workerId = "worker-r31-5";

	let taskState;
	let assignMsgId;
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		ensureRoot(st, scratch, p);
		st.agents[workerId] = {
			id: workerId,
			name: workerId,
			cwd: scratch,
			role: "worker",
			status: "running",
			tmuxTarget: "session:1.0",
			heartbeatAt: new Date().toISOString(),
			createdAt: new Date().toISOString(),
			activeTaskIds: [],
		};
		const res = await deliverMessageLocked(pi, scratch, p, st, {
			to: workerId,
			from: "root",
			subject: "Task assignment",
			body: "Work on node-1",
			requiresAck: true, // legacy or unacked
		});
		assignMsgId = res.msg.id;
		taskState = {
			taskId: "task-r31-5",
			title: "Task 5",
			status: "done",
			nodes: {
				"node-1": {
					id: "node-1",
					title: "Node 1",
					role: "worker",
					assignee: workerId,
					status: "done",
					messageIds: [assignMsgId],
					assignmentMessageId: assignMsgId,
				},
			},
			handoffs: [],
			editLocks: {},
		};
		await writeState(p, st);
	});

	process.env.PI_SWARM_MINIMAL_PROTOCOL = "1";
	const st = await readState(p, scratch);
	const summary = computeNodeClosureSummary(st, taskState, "node-1", { root: scratch });
	const blockedByAck = summary.blocking.some((b) => b.includes("not acknowledged"));
	ok("R31-S5 computeNodeClosureSummary does NOT block done node on unacknowledged assignment", !blockedByAck, {
		blocking: summary.blocking,
	});
}

// --- Scenario 6: taskgraph deriveNodeAttention does NOT return ack_missing under minimal protocol ---
console.log("\n[R31-S6] taskgraph deriveNodeAttention does NOT return ack_missing under minimal protocol");
{
	const scratch = freshScratch();
	const p = paths(scratch);
	mkdirSync(p.root, { recursive: true });
	mkdirSync(p.traces, { recursive: true });
	mkdirSync(p.mailboxes, { recursive: true });
	mkdirSync(p.tasksDir, { recursive: true });

	const { deriveNodeAttention } = await import(join(here, "..", "src/taskgraph.ts"));
	const workerId = "worker-r31-6";

	process.env.PI_SWARM_MINIMAL_PROTOCOL = "1";
	const nowMs = Date.now();
	const sixMinAgo = new Date(nowMs - 360_000).toISOString();

	const msgId = "msg-old-assign";
	const st = {
		swarmId: "test-swarm",
		agents: {
			[workerId]: { id: workerId, status: "running", health: "healthy" },
		},
		messages: {
			[msgId]: {
				id: msgId,
				to: workerId,
				from: "root",
				status: "injected",
				injectedAt: sixMinAgo,
				createdAt: sixMinAgo,
				requiresAck: true,
			},
		},
	};
	const task = {
		taskId: "task-6",
		status: "in_progress",
		nodes: {
			"node-1": {
				id: "node-1",
				status: "assigned",
				assignee: workerId,
				assignmentMessageId: msgId,
			},
		},
	};

	const attention = deriveNodeAttention(st, task, "node-1", nowMs);
	ok("R31-S6 deriveNodeAttention does NOT return category ack_missing under minimal protocol", attention.category !== "ack_missing", {
		category: attention.category,
		evidence: attention.evidence,
	});
}

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
if (fail > 0) {
	process.exit(1);
}
