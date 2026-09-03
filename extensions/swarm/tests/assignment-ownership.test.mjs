#!/usr/bin/env node
/**
 * Assignment ownership tests (Issue 24) — drive the real swarm_update_task + deliverMessageLocked
 * via the extension factory. Mirrors attempt-fencing.test.mjs fixture pattern.
 *
 * Covers the 12 cases from plan v2 §Test plan:
 *   1. swarm_update_task on ready+unassigned by non-assignee -> CLAIM succeeds
 *   2. swarm_update_task on in_progress+unassigned -> OWNERSHIP_REQUIRED (inline-string)
 *   3. swarm_update_task on assigned+unassigned (rare reassign drift) -> CLAIM succeeds
 *   4. swarm_update_task on assigned+non-me assignee -> NODE_ASSIGNEE_MISMATCH + trace
 *   5. deliverMessageLocked assignment-style to node with no assignee -> auto-stamp (no nested withLock)
 *   6. deliverMessageLocked assignment-style to node with matching assignee -> no stamp
 *   7. deliverMessageLocked assignment-style to node with different assignee -> stamp + mismatch trace
 *   8. failTaskTool sites LISTED IN §24.c COVERAGE TABLE include hint -> static scan
 *   9. Claim branch updates agent.activeTaskIds
 *  10. mintNodeAttempt reuse branch (same-active-assignment duplicate)
 *  11. mintNodeAttempt mint branch (fresh attempt)
 *  12. Self-heal race simulation: writeTaskState failure between auto-stamp and return -> recipient's
 *      swarm_update_task lands in claim branch (24.a) and self-heals; no deadlock
 */
import { rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-assignment-ownership-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

process.env.PI_SWARM_AGENT_ID = "orchestrator";
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

const tools = {};
const pi = {
	registerTool: (def) => { tools[def.name] = def; },
	registerCommand: () => {},
	on: () => {},
	exec: async (cmd, args) => {
		if (cmd === "tmux" && args[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
		if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	},
	sendMessage: () => {},
};
factory(pi);

let pass = 0, fail = 0;
const ok = (n, c, info) => { if (c) { pass++; console.log("  ok  ", n); } else { fail++; console.error("  FAIL", n, info ?? ""); } };

const call = async (name, params) => {
	const t = tools[name]; if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: scratch });
};
const as = (agentId, fn) => {
	const prev = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = agentId;
	try { return fn(); } finally { process.env.PI_SWARM_AGENT_ID = prev; }
};
const awaitAs = async (agentId, name, params) => {
	const prev = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = agentId;
	try { return await call(name, params); } finally { process.env.PI_SWARM_AGENT_ID = prev; }
};
const expectErrorCode = async (agentId, name, params, code) => {
	try {
		await awaitAs(agentId, name, params);
		ok(`expect ${code}`, false);
		return null;
	} catch (err) {
		ok(`rejects with ${code} (got ${err.errorCode})`, err.errorCode === code);
		return err;
	}
};

const readTask = (taskId) =>
	JSON.parse(readFileSync(join(scratch, `.pi/swarm/tasks/${taskId}/task.json`), "utf8"));
const readNode = (taskId, nodeId) => readTask(taskId).nodes[nodeId];
const readStateFile = () => {
	const p = join(scratch, ".pi/swarm/swarm-state.json");
	if (!existsSync(p)) return { agents: {} };
	return JSON.parse(readFileSync(p, "utf8"));
};
const readEvents = (taskId) => {
	const p = join(scratch, `.pi/swarm/tasks/${taskId}/events.jsonl`);
	const swarm = join(scratch, ".pi/swarm/traces/events.jsonl");
	const out = [];
	if (existsSync(p)) out.push(...readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
	if (existsSync(swarm)) out.push(...readFileSync(swarm, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
	return out;
};

async function ensureWorker(agentId, roleKind) {
	await awaitAs(agentId, "swarm_register_agent", { tmuxTarget: "unknown", role: `test ${roleKind}`, roleKind, id: agentId, inject: false });
}

async function createTask(extra = {}) {
	const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-test`;
	return await call("swarm_create_task", {
		title: "Assignment ownership", goal: "g", priority: "normal", cwd: scratch,
		taskId,
		start: "plan",
		nodes: {
			plan: { role: "planner", writeArtifacts: ["artifacts/plan.md"] },
			implement: { role: "implementer", dependsOn: ["plan"] },
		},
		edges: [
			{ from: "plan", to: "implement", when: "planned" },
		],
		...extra,
	});
}

// =============================================================
// Case 1: swarm_update_task on ready+unassigned by non-assignee -> CLAIM succeeds
// =============================================================
console.log("\n[1] ready+unassigned by non-assignee -> CLAIM succeeds");
{
	const ct = await createTask();
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9_-]+/)[0];
	await ensureWorker("worker-a", "planner");
	await ensureWorker("worker-b", "implementer");
	const node = readNode(taskId, "plan");
	ok("node starts ready + unassigned", node.status === "ready" && !node.assignee);
	// Worker A claims the plan node — first call without status (claim only, no transition)
	await awaitAs("worker-a", "swarm_update_task", { taskId, nodeId: "plan", note: "claiming", cwd: scratch });
	const after = readNode(taskId, "plan");
	ok("claim stamps assignee=worker-a", after.assignee === "worker-a");
	ok("claim stamps status=assigned", after.status === "assigned");
	ok("active attempt id set", Boolean(after.activeAttemptId));
	ok("attempt history entry created", Array.isArray(after.attemptHistory) && after.attemptHistory.length >= 1);
	// task.node.claimed trace event
	const events = readEvents(taskId);
	ok("task.node.claimed trace emitted", events.some((e) => e.event === "task.node.claimed"));
	// activeTaskIds on the claimer
	const st = readStateFile();
	ok("activeTaskIds on claimer includes taskId", st.agents["worker-a"]?.activeTaskIds?.includes(taskId) === true);
}

// =============================================================
// Case 2: swarm_update_task on in_progress+unassigned -> OWNERSHIP_REQUIRED
// =============================================================
console.log("\n[2] in_progress+unassigned -> OWNERSHIP_REQUIRED (inline-string)");
{
	const ct = await createTask();
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9_-]+/)[0];
	await ensureWorker("worker-a", "planner");
	await ensureWorker("worker-b", "implementer");
	// Manually craft a node in in_progress with no assignee (rare reassign-drift scenario)
	const tp = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const task = JSON.parse(readFileSync(tp, "utf8"));
	task.nodes.plan.status = "in_progress";
	task.nodes.plan.assignee = undefined;
	delete task.nodes.plan.activeAttemptId;
	delete task.nodes.plan.attemptHistory;
	writeFileSync(tp, JSON.stringify(task, null, 2), "utf8");
	const err = await expectErrorCode("worker-a", "swarm_update_task", { taskId, nodeId: "plan", status: "done", cwd: scratch }, "OWNERSHIP_REQUIRED");
	ok("hint suggests escalate to orchestrator", err && err.suggestedNextCall && err.suggestedNextCall.tool === "swarm_send_message");
	const events = readEvents(taskId);
	ok("task.update.ownership_reject trace emitted", events.some((e) => e.event === "task.update.ownership_reject" && e.errorCode === "OWNERSHIP_REQUIRED"));
}

// =============================================================
// Case 3: swarm_update_task on assigned+unassigned (rare reassign drift) -> CLAIM succeeds
// =============================================================
console.log("\n[3] assigned+unassigned (reassign drift) -> CLAIM succeeds");
{
	const ct = await createTask();
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9_-]+/)[0];
	await ensureWorker("worker-a", "planner");
	await ensureWorker("worker-b", "implementer");
	// Manually craft: status=assigned, no assignee (rare reassign drift)
	const tp = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const task = JSON.parse(readFileSync(tp, "utf8"));
	task.nodes.plan.status = "assigned";
	task.nodes.plan.assignee = undefined;
	writeFileSync(tp, JSON.stringify(task, null, 2), "utf8");
	await awaitAs("worker-a", "swarm_update_task", { taskId, nodeId: "plan", status: "in_progress", cwd: scratch });
	const after = readNode(taskId, "plan");
	ok("claim stamps assignee=worker-a", after.assignee === "worker-a");
	ok("status is assigned (then transitions via the update)", after.status === "in_progress" || after.status === "assigned");
}

// =============================================================
// Case 4: swarm_update_task on assigned+non-me assignee -> NODE_ASSIGNEE_MISMATCH + trace
// =============================================================
console.log("\n[4] assigned+non-me -> NODE_ASSIGNEE_MISMATCH + ownership_reject trace");
{
	const ct = await createTask();
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9_-]+/)[0];
	await ensureWorker("worker-a", "planner");
	await ensureWorker("worker-b", "implementer");
	await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "worker-a", cwd: scratch });
	const n1 = readNode(taskId, "plan");
	const attempt1 = n1.activeAttemptId;
	await awaitAs("worker-a", "swarm_update_task", { taskId, nodeId: "plan", status: "in_progress", attemptId: attempt1, cwd: scratch });
	// Worker B tries to update — must fail with NODE_ASSIGNEE_MISMATCH (already assigned)
	const err = await expectErrorCode("worker-b", "swarm_update_task", { taskId, nodeId: "plan", status: "done", cwd: scratch }, "NODE_ASSIGNEE_MISMATCH");
	ok("hint present", err && typeof err.actionableHint === "string");
	const events = readEvents(taskId);
	ok("task.update.ownership_reject trace emitted with NODE_ASSIGNEE_MISMATCH", events.some((e) => e.event === "task.update.ownership_reject" && e.errorCode === "NODE_ASSIGNEE_MISMATCH"));
}

// =============================================================
// Case 5: deliverMessageLocked assignment-style to unassigned node -> auto-stamp (no nested withLock)
// =============================================================
console.log("\n[5] deliverMessageLocked assignment-style -> auto-stamp");
{
	const ct = await createTask();
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9_-]+/)[0];
	await ensureWorker("worker-a", "implementer");
	// Verify implement node has no assignee (depends on plan which isn't done)
	const node = readNode(taskId, "implement");
	ok("implement node unassigned", !node.assignee);
	// Drive the auto-stamp via swarm_send_message with assignment-style subject + conversationId
	const msgParams = {
		to: "worker-a",
		subject: `Task ${taskId} / node implement assigned`,
		body: "Assignment body",
		conversationId: `task:${taskId}:implement`,
		requiresAck: true,
		requiresResponse: true,
	};
	const result = await as("orchestrator", () => call("swarm_send_message", msgParams));
	ok("send succeeds", result && result.content);
	// Read task.json: node.assignee should now be worker-a (auto-stamped)
	const after = readNode(taskId, "implement");
	ok("auto-stamp set assignee=worker-a", after.assignee === "worker-a");
	const events = readEvents(taskId);
	ok("message.deliver.assignment_auto_stamp trace emitted", events.some((e) => e.event === "message.deliver.assignment_auto_stamp"));
}

// =============================================================
// Case 6: assignment-style message to node with matching assignee -> no stamp
// =============================================================
console.log("\n[6] assignment-style message to matching assignee -> no stamp");
{
	const ct = await createTask();
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9_-]+/)[0];
	await ensureWorker("worker-a", "implementer");
	// First stamp assignee=worker-a
	const tp = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const task = JSON.parse(readFileSync(tp, "utf8"));
	task.nodes.implement.assignee = "worker-a";
	task.nodes.implement.status = "assigned";
	writeFileSync(tp, JSON.stringify(task, null, 2), "utf8");
	const before = readNode(taskId, "implement");
	ok("precondition: implement assigned to worker-a", before.assignee === "worker-a");
	const beforeEventCount = readEvents(taskId).filter((e) => e.event === "message.deliver.assignment_auto_stamp").length;
	// Drive another assignment-style message
	const msgParams = {
		to: "worker-a",
		subject: `Task ${taskId} / node implement assigned`,
		body: "Assignment body",
		conversationId: `task:${taskId}:implement`,
		requiresAck: true,
		requiresResponse: true,
	};
	await as("orchestrator", () => call("swarm_send_message", msgParams));
	const after = readNode(taskId, "implement");
	ok("assignee unchanged (idempotent)", after.assignee === "worker-a");
	const afterEventCount = readEvents(taskId).filter((e) => e.event === "message.deliver.assignment_auto_stamp").length;
	ok("no NEW auto-stamp trace on idempotent send", afterEventCount === beforeEventCount);
}

// =============================================================
// Case 7: assignment-style message to node with different assignee -> stamp + mismatch trace
// =============================================================
console.log("\n[7] assignment-style message to different assignee -> stamp + mismatch warn");
{
	const ct = await createTask();
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9_-]+/)[0];
	await ensureWorker("worker-a", "implementer");
	await ensureWorker("worker-b", "implementer");
	// Pre-stamp assignee=worker-a
	const tp = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const task = JSON.parse(readFileSync(tp, "utf8"));
	task.nodes.implement.assignee = "worker-a";
	task.nodes.implement.status = "assigned";
	writeFileSync(tp, JSON.stringify(task, null, 2), "utf8");
	// Drive an assignment-style message to worker-b (reassign race simulation)
	const msgParams = {
		to: "worker-b",
		subject: `Task ${taskId} / node implement assigned`,
		body: "Assignment body",
		conversationId: `task:${taskId}:implement`,
		requiresAck: true,
		requiresResponse: true,
	};
	await as("orchestrator", () => call("swarm_send_message", msgParams));
	const after = readNode(taskId, "implement");
	ok("auto-stamp updated assignee=worker-b", after.assignee === "worker-b");
	const events = readEvents(taskId);
	ok("message.deliver.assignment_auto_stamp trace emitted", events.some((e) => e.event === "message.deliver.assignment_auto_stamp"));
	ok("message.deliver.assignment_mismatch warn trace emitted", events.some((e) => e.event === "message.deliver.assignment_mismatch"));
}

// =============================================================
// Case 8: failTaskTool sites LISTED IN §24.c COVERAGE TABLE include hint -> static scan
// =============================================================
console.log("\n[8] failTaskTool coverage table: each listed site has actionableHint or suggestedNextCall");
{
	const { readFile } = await import("node:fs/promises");
	const src = await readFile(join(here, "..", "src", "tools", "tasks.ts"), "utf8");
	// The 6 §24.c sites are identified by error code + a unique substring near them. We check
	// each by scanning the source for the error code + the next 350 chars; the hint must appear.
	const checks = [
		{ code: "NODE_ASSIGNEE_MISMATCH", contains: "send a task message" },
		{ code: "ATTEMPT_TOKEN_REQUIRED", contains: "check your mailbox" },
		{ code: "ATTEMPT_TOKEN_MISMATCH", contains: "superseded by a new assignment" },
		{ code: "NODE_NOT_READY", contains: "swarm_task_status" },
		{ code: "TASK_NODE_NOT_FOUND", contains: "swarm_task_status" },
		{ code: "INVALID_TRANSITION", contains: "force=true" },
	];
	for (const { code, contains } of checks) {
		// Find all occurrences of the error code
		const re = new RegExp(`"${code}"`, "g");
		const matches = [...src.matchAll(re)];
		ok(`error code ${code} found in source (${matches.length} occurrence(s))`, matches.length >= 1);
		let anySatisfy = false;
		for (const m of matches) {
			const idx = m.index;
			const tail = src.slice(idx, idx + 600);
			if (tail.includes(contains)) { anySatisfy = true; break; }
		}
		ok(`${code} has hint containing "${contains}"`, anySatisfy);
	}
}

// =============================================================
// Case 9: Claim branch updates agent.activeTaskIds
// =============================================================
console.log("\n[9] Claim branch updates agent.activeTaskIds");
{
	const ct = await createTask();
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9_-]+/)[0];
	await ensureWorker("worker-a", "planner");
	const stBefore = readStateFile();
	ok("precondition: worker-a not in activeTaskIds for task", !(stBefore.agents["worker-a"]?.activeTaskIds || []).includes(taskId));
	await awaitAs("worker-a", "swarm_update_task", { taskId, nodeId: "plan", status: "in_progress", cwd: scratch });
	const stAfter = readStateFile();
	ok("activeTaskIds on worker-a includes taskId after claim", stAfter.agents["worker-a"]?.activeTaskIds?.includes(taskId) === true);
}

// =============================================================
// Case 10: mintNodeAttempt reuse branch (same-active duplicate)
// =============================================================
console.log("\n[10] mintNodeAttempt reuse branch (duplicate)");
{
	const ct = await createTask();
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9_-]+/)[0];
	await ensureWorker("worker-a", "planner");
	await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "worker-a", cwd: scratch });
	const attempt1 = readNode(taskId, "plan").activeAttemptId;
	ok("first assignment mints attempt", Boolean(attempt1));
	await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "worker-a", cwd: scratch });
	const attempt2 = readNode(taskId, "plan").activeAttemptId;
	ok("duplicate assignment reuses attemptId", attempt2 === attempt1);
	const history = readNode(taskId, "plan").attemptHistory;
	ok("attemptHistory not extended on duplicate", history.length === 1);
}

// =============================================================
// Case 11: mintNodeAttempt mint branch (fresh attempt)
// =============================================================
console.log("\n[11] mintNodeAttempt mint branch (fresh attempt)");
{
	const ct = await createTask();
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9_-]+/)[0];
	await ensureWorker("worker-a", "planner");
	await ensureWorker("worker-b", "planner");
	await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "worker-a", cwd: scratch });
	const attempt1 = readNode(taskId, "plan").activeAttemptId;
	await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "worker-b", cwd: scratch });
	const attempt2 = readNode(taskId, "plan").activeAttemptId;
	ok("cross-agent reassign mints fresh attempt", attempt2 !== attempt1);
	const history = readNode(taskId, "plan").attemptHistory;
	ok("prior attempt superseded", history.find((a) => a.attemptId === attempt1)?.status === "superseded");
	ok("new attempt active", history.find((a) => a.attemptId === attempt2)?.status === "active");
}

// =============================================================
// Case 12: Self-heal race simulation: claim branch after manual edit
// =============================================================
console.log("\n[12] Self-heal: writeTaskState failure simulation");
{
	const ct = await createTask();
	const taskId = ct.content[0].text.match(/task-[A-Za-z0-9_-]+/)[0];
	await ensureWorker("worker-a", "implementer");
	// Simulate auto-stamp write failure by leaving assignee=null even after an assignment-style
	// message. We craft this by: (a) deleting the auto-stamp path entirely. We approximate by
	// setting assignee=null AFTER the auto-stamp would have run (simulating a write failure
	// mid-cycle). Then worker-a's swarm_update_task lands in the claim branch (24.a) and
	// self-heals.
	// Send an assignment-style message — auto-stamp runs, assignee=worker-a
	await as("orchestrator", () => call("swarm_send_message", {
		to: "worker-a",
		subject: `Task ${taskId} / node implement assigned`,
		body: "Assignment body",
		conversationId: `task:${taskId}:implement`,
		requiresAck: true,
	}));
	// Simulate writeTaskState failure by manually clearing assignee back to null
	const tp = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const task = JSON.parse(readFileSync(tp, "utf8"));
	task.nodes.implement.assignee = undefined;
	writeFileSync(tp, JSON.stringify(task, null, 2), "utf8");
	// Worker-a's swarm_update_task lands in claim branch -> self-heals
	await awaitAs("worker-a", "swarm_update_task", { taskId, nodeId: "implement", status: "in_progress", cwd: scratch });
	const after = readNode(taskId, "implement");
	ok("claim branch self-healed: assignee=worker-a", after.assignee === "worker-a");
	ok("status=assigned (then transitioned to in_progress)", after.status === "in_progress");
	ok("active attempt minted", Boolean(after.activeAttemptId));
	const events = readEvents(taskId);
	ok("task.node.claimed trace emitted (self-heal)", events.some((e) => e.event === "task.node.claimed"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
