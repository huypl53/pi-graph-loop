// Cancellation and supersession semantics — real-handler failure-injection tests.
//
// Run: node extensions/swarm/cancellation.test.mjs
//
// Coverage:
//   - Root can cancel a task (force + cancelTask); all attempts revoked, all messages superseded
//   - Worker cannot cancel (CANCEL_FORBIDDEN)
//   - cancelTask without force (CANCEL_REQUIRES_FORCE)
//   - Late task update after cancellation rejected (TASK_CANCELLED), state unchanged
//   - Late ACK after cancellation rejected at swarm_ack_message handler (ASSIGNMENT_SUPERSEDED)
//   - Reassignment supersession: reassigning a node supersedes prior assignment message
//   - Duplicate delivery idempotency: same idempotencyKey returns the same message id
//   - Audit persistence: traces + message records + attemptHistory retained post-cancel
//   - Resource release: activeTaskIds cleared for every assignee on cancellation
//   - Edit lock release: cancellation releases advisory edit locks for the cancelled nodes
//   - Historical compatibility: tasks without attemptHistory/cancelledAt remain readable
//   - Helper: isTaskOrNodeCancelled correctness
import { rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-cancel-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

// === Test harness: mock pi + import the real extension factory ===
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

const ORIGINAL_AGENT = process.env.PI_SWARM_AGENT_ID;
const ORIGINAL_ORCH = process.env.PI_SWARM_IS_ROOT;
const setAgent = async (id, isOrch = false) => {
	process.env.PI_SWARM_AGENT_ID = id;
	process.env.PI_SWARM_IS_ROOT = isOrch ? "1" : "";
	const url = join(here, "..", "index.ts");
	const mod = await import(`${url}?cb=${Date.now()}-${Math.random()}`);
	const factory = mod.default;
	factory(pi);
	// Reset the tools registry: factory() may re-register under the same module-cache identity.
	for (const k of Object.keys(tools)) delete tools[k];
	factory(pi);
	return mod;
};

const makeCall = () => async (name, params) => {
	const t = tools[name]; if (!t) throw new Error(`no tool ${name}`);
	return t.execute("call", params, undefined, undefined, { cwd: params.cwd || scratch });
};

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
	if (cond) { pass++; console.log("  ok  ", name); }
	else { fail++; console.error("  FAIL", name, detail || ""); }
};
const asJson = (r) => r && r.content && r.content[0] && r.content[0].text ? r.content[0].text : String(r);
const expectErr = async (fn, code) => {
	try { const r = await fn(); return { ok: false, err: null, r }; }
	catch (err) { return { ok: err?.message?.startsWith(code) || err?.message?.includes(code), err: err?.message || String(err), r: null }; }
};

const buildTask = async (call, label) => {
	const prevAgent = process.env.PI_SWARM_AGENT_ID;
	const prevOrch = process.env.PI_SWARM_IS_ROOT;
	process.env.PI_SWARM_AGENT_ID = "root";
	process.env.PI_SWARM_IS_ROOT = "1";
	const ct = await call("swarm_create_task", {
		taskId: `task-test-${label}-${Math.random().toString(36).slice(2, 8)}`,
		title: `Cancellation test ${label}`,
		goal: `Verify cancellation/supersession semantics — case ${label}`,
		priority: "normal",
		nodes: {
			plan: { role: "planner", dependsOn: [], readArtifacts: [], writeArtifacts: ["artifacts/plan.md"] },
			implement: { role: "implementer", dependsOn: ["plan"], readArtifacts: ["artifacts/plan.md"], writeArtifacts: ["artifacts/impl.md"] },
			test: { role: "tester", dependsOn: ["implement"], readArtifacts: ["artifacts/impl.md"], writeArtifacts: ["artifacts/test.md"] },
			review: { role: "reviewer", dependsOn: ["test"], readArtifacts: ["artifacts/test.md"], writeArtifacts: ["artifacts/review.md"] },
		},
		edges: [
			{ from: "plan", to: "implement", when: "planned" },
			{ from: "implement", to: "test", when: "implemented" },
			{ from: "test", to: "review", when: "passed" },
		],
		acceptanceCriteria: ["Cancellation revokes all attempts", "Late updates rejected"],
		validationCommands: ["node extensions/swarm/cancellation.test.mjs"],
		cwd: scratch,
	});
	const m = asJson(ct).match(/task-[\w-]+/);
	process.env.PI_SWARM_AGENT_ID = prevAgent;
	process.env.PI_SWARM_IS_ROOT = prevOrch;
	if (!m) throw new Error("no taskId parsed: " + asJson(ct));
	return m[0];
};

const stampAssignee = (taskId, nodeId, assignee, attemptId) => {
	const path = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const j = JSON.parse(readFileSync(path, "utf8"));
	const msgId = `msg-test-${nodeId}-${taskId}-${attemptId}`;
	j.nodes[nodeId].assignee = assignee;
	j.nodes[nodeId].activeAttemptId = attemptId;
	j.nodes[nodeId].assignmentMessageId = msgId;
	j.nodes[nodeId].attemptHistory = j.nodes[nodeId].attemptHistory || [];
	j.nodes[nodeId].attemptHistory.push({
		attemptId,
		attemptNumber: 1,
		assignmentMessageId: msgId,
		assignee,
		assignedAt: new Date().toISOString(),
		status: "active",
	});
	// Also record in handoffs so supersedeTaskAssignmentMessages picks it up
	j.handoffs = j.handoffs || [];
	j.handoffs.push({ fromNode: null, toNode: nodeId, kind: "assign", messageId: msgId, taskId, by: assignee, at: new Date().toISOString() });
	writeFileSync(path, JSON.stringify(j, null, 2));
};

const registerAgent = (st, id) => {
	st.agents[id] = st.agents[id] || {
		id, role: id, roleKind: "worker", capabilities: [], activeTaskIds: [],
		maxConcurrentTasks: 1, status: "running", runtimeStatus: "idle", health: "healthy",
		tmuxSession: "test", tmuxWindow: id, tmuxTarget: `test:${id}.0`,
		model: "x", provider: "y", cwd: scratch, mailbox: `.pi/swarm/mailboxes/${id}.jsonl`,
		createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
	};
};

const materializeAssignments = (taskId, nodeIds) => {
	const taskPath = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const j = JSON.parse(readFileSync(taskPath, "utf8"));
	const statePath = join(scratch, ".pi/swarm/swarm-state.json");
	const st = JSON.parse(readFileSync(statePath, "utf8"));
	for (const nodeId of nodeIds) {
		const node = j.nodes[nodeId];
		if (node.assignmentMessageId) {
			registerAgent(st, node.assignee);
			st.messages[node.assignmentMessageId] = {
				id: node.assignmentMessageId, from: "root", to: node.assignee,
				status: "injected", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
				attempts: 1, requiresAck: true, conversationId: `task:${taskId}:${nodeId}`,
				subject: "assignment", priority: "normal", type: "swarm.message", schemaVersion: 1,
				body: "test", headers: {},
			};
			st.delivered[node.assignee] = Array.from(new Set([...(st.delivered[node.assignee] || []), node.assignmentMessageId]));
		}
	}
	writeFileSync(statePath, JSON.stringify(st, null, 2));
};

// === Test 1: root cancels an in-progress task ===
{
	await setAgent("root", true);
	const call = makeCall();
	const taskId = await buildTask(call, "t1");
	stampAssignee(taskId, "plan", "planner-01", "att-plan-1");
	stampAssignee(taskId, "implement", "implementer-01", "att-impl-1");
	stampAssignee(taskId, "test", "tester-01", "att-test-1");
	const planPath = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const t0 = JSON.parse(readFileSync(planPath, "utf8"));
	t0.nodes.plan.status = "done"; t0.nodes.plan.outcome = "planned";
	writeFileSync(planPath, JSON.stringify(t0, null, 2));
	const r = await call("swarm_update_task", { taskId, nodeId: "implement", force: true, cancelTask: true, cwd: scratch });
	ok("root cancel returned a result", asJson(r).length > 0);
	const taskPath = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const j = JSON.parse(readFileSync(taskPath, "utf8"));
	ok("task.status = cancelled", j.status === "cancelled");
	ok("implement node.status = cancelled", j.nodes.implement.status === "cancelled");
	ok("test node.status = cancelled", j.nodes.test.status === "cancelled");
	ok("review node.status = cancelled", j.nodes.review.status === "cancelled");
	ok("plan (terminal done) NOT mutated", j.nodes.plan.status === "done");
	ok("implement attempt history shows cancelled", j.nodes.implement.attemptHistory.find((a) => a.attemptId === "att-impl-1").status === "cancelled");
	ok("test attempt history shows cancelled", j.nodes.test.attemptHistory.find((a) => a.attemptId === "att-test-1").status === "cancelled");
	const statePath = join(scratch, ".pi/swarm/swarm-state.json");
	try {
		const st = JSON.parse(readFileSync(statePath, "utf8"));
		for (const id of ["planner-01", "implementer-01", "tester-01"]) {
			if (st.agents[id]) ok(`activeTaskIds cleared for ${id}`, !st.agents[id].activeTaskIds.includes(taskId));
		}
	} catch {}
}

// === Test 2: worker cannot cancel (CANCEL_FORBIDDEN) ===
{
	await setAgent("worker-01", false);
	const call = makeCall();
	const taskId = await buildTask(call, "t2");
	const { ok: codeOk, err } = await expectErr(
		() => call("swarm_update_task", { taskId, nodeId: "plan", force: true, cancelTask: true, cwd: scratch }),
		"CANCEL_FORBIDDEN"
	);
	ok("worker cancel rejected with CANCEL_FORBIDDEN", codeOk, err);
}

// === Test 3: root cancel without force (CANCEL_REQUIRES_FORCE) ===
{
	await setAgent("root", true);
	const call = makeCall();
	const taskId = await buildTask(call, "t3");
	const { ok: codeOk, err } = await expectErr(
		() => call("swarm_update_task", { taskId, nodeId: "plan", cancelTask: true, cwd: scratch }),
		"CANCEL_REQUIRES_FORCE"
	);
	ok("root cancel without force rejected with CANCEL_REQUIRES_FORCE", codeOk, err);
}

// === Test 4: late task update after cancellation rejected (TASK_CANCELLED) ===
{
	await setAgent("root", true);
	const call = makeCall();
	const taskId = await buildTask(call, "t4");
	stampAssignee(taskId, "plan", "planner-01", "att-plan-2");
	await call("swarm_update_task", { taskId, nodeId: "plan", force: true, cancelTask: true, cwd: scratch });
	const { ok: codeOk, err } = await expectErr(
		() => call("swarm_update_task", { taskId, nodeId: "plan", status: "done", outcome: "planned", attemptId: "att-plan-2", cwd: scratch }),
		"TASK_CANCELLED"
	);
	ok("late update on cancelled task rejected with TASK_CANCELLED", codeOk, err);
	const taskPath = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const j = JSON.parse(readFileSync(taskPath, "utf8"));
	ok("cancelled task state unchanged after rejected late update", j.status === "cancelled" && j.nodes.plan.status === "cancelled");
}

// === Test 5: late ACK on a superseded assignment message rejected (ASSIGNMENT_SUPERSEDED) ===
{
	await setAgent("root", true);
	const call = makeCall();
	const taskId = await buildTask(call, "t5");
	stampAssignee(taskId, "plan", "planner-01", "att-plan-5");
	materializeAssignments(taskId, ["plan"]);
	const taskPath = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const tBefore = JSON.parse(readFileSync(taskPath, "utf8"));
	const msgId = tBefore.nodes.plan.assignmentMessageId || tBefore.nodes.plan.attemptHistory[0].assignmentMessageId;
	await call("swarm_update_task", { taskId, nodeId: "plan", force: true, cancelTask: true, cwd: scratch });
	const statePath = join(scratch, ".pi/swarm/swarm-state.json");
	const stAfter = JSON.parse(readFileSync(statePath, "utf8"));
	ok("test 5 setup: message was superseded by cancellation", Boolean(stAfter.messages[msgId]?.superseded), `superseded=${JSON.stringify(stAfter.messages[msgId]?.superseded)}`);
	await setAgent("planner-01", false);
	const call2 = makeCall();
	const { ok: codeOk, err } = await expectErr(
		() => call2("swarm_ack_message", { messageId: msgId, status: "processing", cwd: scratch }),
		"ASSIGNMENT_SUPERSEDED"
	);
	ok("late ACK on superseded assignment rejected with ASSIGNMENT_SUPERSEDED", codeOk, err);
}

// === Test 6: reassignment supersession ===
{
	await setAgent("root", true);
	const call = makeCall();
	const taskId = await buildTask(call, "t6");
	const statePath = join(scratch, ".pi/swarm/swarm-state.json");
	const st = JSON.parse(readFileSync(statePath, "utf8"));
	const msg1 = `msg-assign-1-${taskId}`;
	registerAgent(st, "planner-01");
	registerAgent(st, "planner-02");
	st.messages[msg1] = {
		id: msg1, from: "root", to: "planner-01",
		status: "injected", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		attempts: 1, requiresAck: true, conversationId: `task:${taskId}:plan`,
		subject: "assignment v1", priority: "normal", type: "swarm.message", schemaVersion: 1,
		body: "first assignment", headers: {},
	};
	st.delivered["planner-01"] = Array.from(new Set([...(st.delivered["planner-01"] || []), msg1]));
	const taskPath = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const j = JSON.parse(readFileSync(taskPath, "utf8"));
	j.handoffs = j.handoffs || [];
	j.handoffs.push({ fromNode: null, toNode: "plan", kind: "assign", messageId: msg1, taskId, by: "root", at: new Date().toISOString() });
	writeFileSync(taskPath, JSON.stringify(j, null, 2));
	writeFileSync(statePath, JSON.stringify(st, null, 2));
	// Reassignment via swarm_assign_task — the only path that triggers supersedeOpenAssignments.
	const ar = await call("swarm_assign_task", { taskId, nodeId: "plan", assignee: "planner-02", cwd: scratch });
	ok("reassignment call returned a result", asJson(ar).length > 0);
	const st2 = JSON.parse(readFileSync(statePath, "utf8"));
	ok("reassignment supersedes prior assignment message", Boolean(st2.messages[msg1]?.superseded), `st2.messages[msg1]=${JSON.stringify(st2.messages[msg1])}`);
	ok("superseded message response.status = waived", st2.messages[msg1]?.response?.status === "waived");
}

// === Test 7: duplicate delivery idempotency ===
{
	await setAgent("root", true);
	const call = makeCall();
	const idempKey = `idem-test-${Date.now()}`;
	const r1 = await call("swarm_send_message", { to: "planner-01", body: "dup test", subject: "dup", requiresAck: false, idempotencyKey: idempKey, cwd: scratch });
	const r2 = await call("swarm_send_message", { to: "planner-01", body: "dup test", subject: "dup", requiresAck: false, idempotencyKey: idempKey, cwd: scratch });
	const t1 = asJson(r1), t2 = asJson(r2);
	const id1 = (t1.match(/msg-[\w-]+/) || [])[0];
	const id2 = (t2.match(/msg-[\w-]+/) || [])[0];
	ok("duplicate delivery returns same message id", Boolean(id1 && id1 === id2), `id1=${id1} id2=${id2}`);
}

// === Test 8: audit persistence ===
{
	await setAgent("root", true);
	const call = makeCall();
	const taskId = await buildTask(call, "t8");
	stampAssignee(taskId, "plan", "planner-01", "att-plan-audit");
	await call("swarm_update_task", { taskId, nodeId: "plan", force: true, cancelTask: true, cwd: scratch });
	const taskEvents = join(scratch, `.pi/swarm/tasks/${taskId}/events.jsonl`);
	let traceText = "";
	try { traceText = readFileSync(taskEvents, "utf8"); } catch {}
	ok("per-task trace file written", traceText.length > 0);
	ok("per-task trace contains task.cancel.revoke_all event", traceText.includes("task.cancel.revoke_all"));
	const globalTraces = join(scratch, ".pi/swarm/traces/events.jsonl");
	let globalTrace = "";
	try { globalTrace = readFileSync(globalTraces, "utf8"); } catch {}
	ok("global trace contains message.superseded event", globalTrace.includes("message.superseded"));
	const taskPath = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const j = JSON.parse(readFileSync(taskPath, "utf8"));
	ok("task.json retained after cancellation", j.taskId === taskId);
	ok("attempt history retained (audit trail)", Array.isArray(j.nodes.plan.attemptHistory) && j.nodes.plan.attemptHistory.length > 0);
}

// === Test 9: edit lock release on cancel ===
{
	await setAgent("root", true);
	const call = makeCall();
	const taskId = await buildTask(call, "t9");
	const taskPath = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const j = JSON.parse(readFileSync(taskPath, "utf8"));
	j.editLocks = j.editLocks || {};
	j.editLocks["src/foo.ts"] = { nodeId: "implement", by: "implementer-01", at: new Date().toISOString() };
	j.nodes.implement.assignee = "implementer-01";
	j.nodes.implement.status = "assigned";
	writeFileSync(taskPath, JSON.stringify(j, null, 2));
	await call("swarm_update_task", { taskId, nodeId: "implement", force: true, cancelTask: true, cwd: scratch });
	const j2 = JSON.parse(readFileSync(taskPath, "utf8"));
	ok("edit lock released on cancelled node", !j2.editLocks || !j2.editLocks["src/foo.ts"]);
}

// === Test 10: historical compatibility — legacy task without attemptHistory still readable ===
{
	await setAgent("root", true);
	const call = makeCall();
	const ct = await call("swarm_create_task", {
		taskId: `task-legacy-${Math.random().toString(36).slice(2, 8)}`,
		title: "Legacy task",
		goal: "No attemptHistory / no cancelledAt fields",
		priority: "normal",
		nodes: { only: { role: "worker", dependsOn: [], readArtifacts: [], writeArtifacts: [] } },
		edges: [],
		acceptanceCriteria: [], validationCommands: [], cwd: scratch,
	});
	const legacyId = (asJson(ct).match(/task-[A-Za-z0-9-]+/) || [])[0];
	ok("legacy task created", !!legacyId);
	const legacyPath = join(scratch, `.pi/swarm/tasks/${legacyId}/task.json`);
	const lj = JSON.parse(readFileSync(legacyPath, "utf8"));
	for (const n of Object.values(lj.nodes)) { delete n.attemptHistory; delete n.activeAttemptId; }
	writeFileSync(legacyPath, JSON.stringify(lj, null, 2));
	const st = await call("swarm_task_status", { taskId: legacyId, cwd: scratch });
	ok("legacy task status readable", asJson(st).includes("Legacy task"));
	const update = await call("swarm_update_task", { taskId: legacyId, nodeId: "only", status: "done", outcome: "ok", cwd: scratch });
	ok("legacy task update succeeds without attempt token", !asJson(update).startsWith("ATTEMPT_TOKEN_REQUIRED"));
}

// === Test 11: isTaskOrNodeCancelled helper correctness ===
{
	await setAgent("root", true);
	const call = makeCall();
	const taskId = await buildTask(call, "t11");
	stampAssignee(taskId, "plan", "planner-01", "att-plan-helper");
	await call("swarm_update_task", { taskId, nodeId: "plan", force: true, cancelTask: true, cwd: scratch });
	const taskPath = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const j = JSON.parse(readFileSync(taskPath, "utf8"));
	const { isTaskOrNodeCancelled } = await import(join(here, "..", "src/taskgraph.ts"));
	ok("isTaskOrNodeCancelled(task) on cancelled task = true", isTaskOrNodeCancelled(j) === true);
	ok("isTaskOrNodeCancelled(task, plan) on cancelled node = true", isTaskOrNodeCancelled(j, "plan") === true);
	const ct2 = await call("swarm_create_task", {
		taskId: `task-uncancelled-${Math.random().toString(36).slice(2, 8)}`,
		title: "Uncancelled", goal: "g", priority: "normal",
		nodes: { a: { role: "worker", dependsOn: [], readArtifacts: [], writeArtifacts: [] } },
		edges: [], acceptanceCriteria: [], validationCommands: [], cwd: scratch,
	});
	const uncId = (asJson(ct2).match(/task-[A-Za-z0-9-]+/) || [])[0];
	const uncPath = join(scratch, `.pi/swarm/tasks/${uncId}/task.json`);
	const uj = JSON.parse(readFileSync(uncPath, "utf8"));
	ok("isTaskOrNodeCancelled(uncancelled task) = false", isTaskOrNodeCancelled(uj) === false);
}

// === Test 12: cancel during assigned (not yet in_progress); already-terminal nodes must NOT be mutated ===
{
	await setAgent("root", true);
	const call = makeCall();
	const taskId = await buildTask(call, "t12");
	stampAssignee(taskId, "implement", "implementer-01", "att-impl-assigned");
	// Pre-set plan to terminal-done (must be preserved across cancellation)
	const planPath = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const tBefore = JSON.parse(readFileSync(planPath, "utf8"));
	tBefore.nodes.plan.status = "done";
	tBefore.nodes.plan.outcome = "planned";
	writeFileSync(planPath, JSON.stringify(tBefore, null, 2));
	const r = await call("swarm_update_task", { taskId, nodeId: "implement", force: true, cancelTask: true, cwd: scratch });
	ok("cancel during assigned succeeded", asJson(r).length > 0);
	const taskPath = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const j = JSON.parse(readFileSync(taskPath, "utf8"));
	ok("assigned node transitioned to cancelled", j.nodes.implement.status === "cancelled");
	ok("test (downstream) also cancelled", j.nodes.test.status === "cancelled");
	ok("plan (already terminal done) preserved", j.nodes.plan.status === "done" && j.nodes.plan.outcome === "planned");
}

// === Test 13: fix-1 — cancellation fence wins for non-assignee workers (deterministic) ===
// Before fix-1, a non-assignee worker calling swarm_update_task on a cancelled task would
// receive NODE_ASSIGNEE_MISMATCH. The fix moves the cancellation fence ABOVE the assignee
// check so the cancel fence deterministically wins for ANY late worker mutation, even
// those that are not the assignee (e.g. stale workers trying to claim work).
{
	await setAgent("root", true);
	const call = makeCall();
	const taskId = await buildTask(call, "t13");
	stampAssignee(taskId, "implement", "implementer-01", "att-impl-fence");
	materializeAssignments(taskId, ["implement"]);
	// Cancel the task
	await call("swarm_update_task", { taskId, nodeId: "implement", force: true, cancelTask: true, cwd: scratch });
	const taskPath = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const tBefore = readFileSync(taskPath, "utf8");
	// Now a DIFFERENT, non-assignee worker tries to mutate the cancelled task
	await setAgent("stranger-99", false);
	let fenceErr = null;
	try {
		await call("swarm_update_task", { taskId, nodeId: "implement", status: "in_progress", cwd: scratch });
	} catch (e) { fenceErr = e; }
	const tAfter = readFileSync(taskPath, "utf8");
	ok("stranger worker on cancelled task rejected with TASK_CANCELLED (not NODE_ASSIGNEE_MISMATCH)",
		Boolean(fenceErr) && /TASK_CANCELLED/.test(String(fenceErr.message || fenceErr)));
	ok("cancelled task state unchanged after stranger attempt", tBefore === tAfter);
}

// === Test 14: fix-2 — historical assignment handoffs are also superseded ===
// Before fix-2, supersedeTaskAssignmentMessages only superseded node.assignmentMessageId
// because assign handoffs in task.handoffs do NOT carry taskId on the row. The fix
// supersedes EVERY historical assign handoff for nodes in this task by construction.
// We exercise this by: assign node X, record in handoffs (older assignment id), reassign
// to a newer attempt (which itself is in handoffs), then cancel — and verify BOTH
// historical handoff ids are marked superseded + waived.
{
	await setAgent("root", true);
	const call = makeCall();
	const taskId = await buildTask(call, "t14");
	// Build handoffs by hand: a historical assign (older) and a current assignment on the node.
	const path = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	const j = JSON.parse(readFileSync(path, "utf8"));
	const olderId = `msg-older-${taskId}`;
	const currentId = `msg-current-${taskId}`;
	j.nodes.implement.assignee = "implementer-01";
	j.nodes.implement.activeAttemptId = "att-current";
	j.nodes.implement.assignmentMessageId = currentId;
	j.nodes.implement.attemptHistory = [{
		attemptId: "att-current", attemptNumber: 1, assignmentMessageId: currentId,
		assignee: "implementer-01", assignedAt: new Date().toISOString(), status: "active",
	}];
	j.nodes.implement.status = "in_progress";
	// Historical assign handoff (older worker, no taskId on row — this is the bug case)
	j.handoffs = j.handoffs || [];
	j.handoffs.push({ fromNode: null, toNode: "implement", kind: "assign", messageId: olderId, by: "planner-01", at: new Date().toISOString() });
	// Current assign handoff
	j.handoffs.push({ fromNode: null, toNode: "implement", kind: "assign", messageId: currentId, by: "root", at: new Date().toISOString() });
	writeFileSync(path, JSON.stringify(j, null, 2));
	// Register both messages in swarm state
	const statePath = join(scratch, ".pi/swarm/swarm-state.json");
	const st = JSON.parse(readFileSync(statePath, "utf8"));
	registerAgent(st, "implementer-01");
	for (const mid of [olderId, currentId]) {
		st.messages[mid] = {
			id: mid, from: "root", to: "implementer-01",
			status: "injected", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
			attempts: 1, requiresAck: true, conversationId: `task:${taskId}:implement`,
			subject: "assignment", priority: "normal", type: "swarm.message", schemaVersion: 1,
			body: "test", headers: {},
		};
		st.delivered["implementer-01"] = Array.from(new Set([...(st.delivered["implementer-01"] || []), mid]));
	}
	writeFileSync(statePath, JSON.stringify(st, null, 2));
	// Cancel
	await call("swarm_update_task", { taskId, nodeId: "implement", force: true, cancelTask: true, cwd: scratch });
	const st2 = JSON.parse(readFileSync(statePath, "utf8"));
	ok("current assignment message superseded", Boolean(st2.messages[currentId].superseded));
	ok("historical assign handoff also superseded", Boolean(st2.messages[olderId].superseded));
	ok("current message response.status=waived", st2.messages[currentId].response?.status === "waived");
	ok("historical handoff message response.status=waived", st2.messages[olderId].response?.status === "waived");
	ok("supersededBy=task_cancellation on current", st2.messages[currentId].superseded?.supersededBy === "task_cancellation");
	ok("supersededBy=task_cancellation on historical", st2.messages[olderId].superseded?.supersededBy === "task_cancellation");
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);

process.env.PI_SWARM_AGENT_ID = ORIGINAL_AGENT;
process.env.PI_SWARM_IS_ROOT = ORIGINAL_ORCH;

rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
