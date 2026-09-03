#!/usr/bin/env node
/**
 * Attempt fencing tests — exercised against the REAL tool handlers (swarm_create_task,
 * swarm_assign_task, swarm_update_task) via the extension factory, using a scratch project dir.
 *
 * Covers (roadmap issue 2 acceptance):
 *  - stale node update after same-agent reassign  -> ATTEMPT_TOKEN_MISMATCH
 *  - stale node update after cross-agent reassign -> ATTEMPT_TOKEN_MISMATCH
 *  - stale node update after rework reopen        -> ATTEMPT_TOKEN_MISMATCH
 *  - duplicate assignment retry reuses the active assignment: attempt token preserved, no new attempt
 *  - update WITHOUT attempt token on a fenced node -> ATTEMPT_TOKEN_REQUIRED
 *  - active-attempt update succeeds
 *  - attempt audit history is immutable + persists
 *  - legacy nodes (no attempt fields) stay updateable via assignee check only
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-attempt-fencing-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

// Identity control: the harness is the root (may assign); workers are simulated by
// switching PI_SWARM_AGENT_ID before each update call. currentAgentId() reads it live.
process.env.PI_SWARM_AGENT_ID = "root";
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

let fail = 0;
const ok = (n, c) => { if (c) console.log("  ok  ", n); else { fail++; console.error("  FAIL", n); } };

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
		const result = await awaitAs(agentId, name, params);
		// Issue 83b — supersession refusal envelope is a successful tool result with
		// details.refused=true, not a thrown error. Accept it as the ATTEMPT_TOKEN_MISMATCH
		// signal when the caller presented a superseded attemptId (the late-result path).
		const refusal = result?.details?.refused === true && result?.details?.reason === "supersession";
		if (code === "ATTEMPT_TOKEN_MISMATCH" && refusal) {
			ok(`expect ${code} (got refused:supersession envelope)`, true);
			return result;
		}
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

// Register two worker agents so swarm_assign_task can target them by explicit agentId.
// Simplest reliable path: write minimal agent identity cards + state via register tool.
async function ensureWorker(agentId, roleKind) {
	await awaitAs(agentId, "swarm_register_agent", { tmuxTarget: "unknown", role: `test ${roleKind}`, roleKind, id: agentId, inject: false });
}

// ---- setup: create a task with a linear plan -> implement graph with a rework edge implement<-plan
const ct = await call("swarm_create_task", {
	title: "Attempt fencing", goal: "g", priority: "normal", cwd: scratch,
	start: "plan",
	nodes: {
		plan: { role: "planner", writeArtifacts: ["artifacts/plan.md"] },
		implement: { role: "implementer", dependsOn: ["plan"] },
	},
	edges: [
		{ from: "plan", to: "implement", when: "planned" },
	],
});
const taskId = ct.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];

await ensureWorker("worker-a", "planner");
await ensureWorker("worker-b", "planner");

// ============ 1. Same-agent reassign fences stale tokens ============
await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "worker-a", cwd: scratch });
const n1 = readNode(taskId, "plan");
const attempt1 = n1.activeAttemptId;
ok("assignment mints attempt + history", !!attempt1 && n1.attemptHistory?.length === 1 && n1.attemptHistory[0].attemptId === attempt1);

// Re-assign same agent while node status is "assigned" (duplicate/retry) must NOT mint a new attempt.
await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "worker-a", cwd: scratch });
const n1b = readNode(taskId, "plan");
ok("duplicate assignment retry preserves attempt token", n1b.activeAttemptId === attempt1);
ok("duplicate assignment retry adds no attempt", n1b.attemptHistory.length === 1);
ok("duplicate assignment retry keeps single active record", n1b.attemptHistory.filter((a) => a.status === "active").length === 1);

// Simulate reassign after the worker moved the node to in_progress (worker hold state).
await awaitAs("worker-a", "swarm_update_task", { taskId, nodeId: "plan", status: "in_progress", attemptId: attempt1, cwd: scratch });
const n1c = readNode(taskId, "plan");
ok("in_progress with active token succeeds", n1c.status === "in_progress");

// True same-agent reassign (from non-"assigned" state? in_progress) — force it as root-free:
// swarm_assign_task on an in_progress node assigned to same agent is still the same active assignment
// (retry). To model a genuine same-agent reassign, release first via root update to blocked.
await awaitAs("root", "swarm_update_task", { taskId, nodeId: "plan", status: "blocked", force: true, cwd: scratch });
await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "worker-a", cwd: scratch });
const n2 = readNode(taskId, "plan");
const attempt2 = n2.activeAttemptId;
ok("reassign after blocked mints new attempt", !!attempt2 && attempt2 !== attempt1);
ok("prior attempt superseded", n2.attemptHistory.find((a) => a.attemptId === attempt1)?.status === "superseded");

// Stale update using attempt1 token must be fenced.
await expectErrorCode("worker-a", "swarm_update_task", { taskId, nodeId: "plan", status: "done", outcome: "planned", attemptId: attempt1, cwd: scratch }, "ATTEMPT_TOKEN_MISMATCH");
ok("state unchanged after stale update", readNode(taskId, "plan").status === "assigned");

// Active token still works.
await awaitAs("worker-a", "swarm_update_task", { taskId, nodeId: "plan", status: "done", outcome: "planned", attemptId: attempt2, cwd: scratch });
ok("active token update succeeds", readNode(taskId, "plan").status === "done");
ok("terminal attempt recorded as completed", readNode(taskId, "plan").attemptHistory.find((a) => a.attemptId === attempt2)?.status === "completed");

// ============ 2. Cross-agent reassign + rework fencing ============
// implement depends on plan(planned) -> now ready. Assign to worker-a (implementer role ok).
await ensureWorker("impl-a", "implementer");
await ensureWorker("impl-b", "implementer");
await call("swarm_assign_task", { taskId, nodeId: "implement", agentId: "impl-a", cwd: scratch });
const implAttempt1 = readNode(taskId, "implement").activeAttemptId;
// Reassign to impl-b (cross-agent reassign: node is "assigned", impl-b != impl-a -> genuine reassign).
await call("swarm_assign_task", { taskId, nodeId: "implement", agentId: "impl-b", cwd: scratch });
const implNode = readNode(taskId, "implement");
ok("cross-agent reassign mints new attempt", implNode.activeAttemptId !== implAttempt1);
ok("cross-agent reassign supersedes prior", implNode.attemptHistory.find((a) => a.attemptId === implAttempt1)?.status === "superseded");
const implAttempt2 = readNode(taskId, "implement").activeAttemptId;
// impl-a's stale update is fenced (assignee check fires first — acceptable: state is protected).
{
	try { await awaitAs("impl-a", "swarm_update_task", { taskId, nodeId: "implement", status: "done", outcome: "implemented", attemptId: implAttempt1, cwd: scratch }); ok("impl-a stale update rejected", false); }
	catch (err) { ok(`impl-a stale update rejected (${err.errorCode})`, err.errorCode === "ATTEMPT_TOKEN_MISMATCH" || err.errorCode === "NODE_ASSIGNEE_MISMATCH"); }
}
await expectErrorCode("impl-b", "swarm_update_task", { taskId, nodeId: "implement", status: "done", outcome: "implemented", cwd: scratch }, "ATTEMPT_TOKEN_REQUIRED");
await awaitAs("impl-b", "swarm_update_task", { taskId, nodeId: "implement", status: "failed", outcome: "failed", attemptId: implAttempt2, cwd: scratch });
const failedNode = readNode(taskId, "implement");
ok("failed attempt recorded", failedNode.attemptHistory.find((a) => a.attemptId === implAttempt2)?.status === "failed");

// ============ 3. Rework reopen clears activeAttemptId; stale pre-rework token fenced ============
// Rework semantics (default-graph pattern): a FAILED node with an incoming rework edge from a node
// that reaches done with a matching outcome is reopened. Sequence here: test fails -> fix ready ->
// fix done(implemented) reopens test via the rework edge fix->test.
const ct2 = await call("swarm_create_task", {
	title: "Rework fencing", goal: "g", priority: "normal", cwd: scratch,
	start: "plan",
	nodes: {
		plan: { role: "planner" },
		implement: { role: "implementer", dependsOn: ["plan"] },
		test: { role: "tester", dependsOn: ["implement"] },
		fix: { role: "implementer", dependsOn: ["test"] },
		review: { role: "reviewer", dependsOn: ["test"] },
	},
	edges: [
		{ from: "plan", to: "implement", when: "planned" },
		{ from: "implement", to: "test", when: "implemented" },
		{ from: "test", to: "review", when: "passed" },
		{ from: "test", to: "fix", when: "failed", rework: true },
		{ from: "fix", to: "test", when: "implemented", rework: true },
	],
});
const taskId2 = ct2.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];
await ensureWorker("tester-1", "tester");
await call("swarm_assign_task", { taskId: taskId2, nodeId: "plan", agentId: "worker-a", cwd: scratch });
const rwPlan = readNode(taskId2, "plan").activeAttemptId;
await awaitAs("worker-a", "swarm_update_task", { taskId: taskId2, nodeId: "plan", status: "done", outcome: "planned", attemptId: rwPlan, cwd: scratch });
await call("swarm_assign_task", { taskId: taskId2, nodeId: "implement", agentId: "impl-a", cwd: scratch });
const rwImpl = readNode(taskId2, "implement").activeAttemptId;
await awaitAs("impl-a", "swarm_update_task", { taskId: taskId2, nodeId: "implement", status: "done", outcome: "implemented", attemptId: rwImpl, cwd: scratch });
await call("swarm_assign_task", { taskId: taskId2, nodeId: "test", agentId: "tester-1", cwd: scratch });
const rwTest1 = readNode(taskId2, "test").activeAttemptId;
ok("failed attempt on test recorded", !!rwTest1);
await awaitAs("tester-1", "swarm_update_task", { taskId: taskId2, nodeId: "test", status: "failed", outcome: "failed", attemptId: rwTest1, cwd: scratch });
ok("test failed makes fix actionable", readTask(taskId2).currentNodes.includes("fix"));
// fix completes -> rework edge fix->test reopens test.
await ensureWorker("fixer-1", "implementer");
await call("swarm_assign_task", { taskId: taskId2, nodeId: "fix", agentId: "fixer-1", cwd: scratch });
const rwFix = readNode(taskId2, "fix").activeAttemptId;
ok("fix attempt on rework node", !!rwFix);
await awaitAs("fixer-1", "swarm_update_task", { taskId: taskId2, nodeId: "fix", status: "done", outcome: "implemented", attemptId: rwFix, cwd: scratch });
const testAfterRework = readNode(taskId2, "test");
ok("rework reopens test as ready", testAfterRework.status === "ready");
ok("rework clears activeAttemptId", !testAfterRework.activeAttemptId);
ok("rework preserves attempt history", testAfterRework.attemptHistory.length === 1);
ok("rework annotates prior attempt superseded by <rework>", testAfterRework.attemptHistory[0].supersededBy === "<rework>");
ok("rework keeps prior attempt terminal status failed", testAfterRework.attemptHistory[0].status === "failed");
// Reopened node is unassigned; under Issue 24.a, a non-assignee CLAIMS the node (no longer
// rejected with NODE_ASSIGNEE_MISMATCH). The stale pre-rework attempt token the caller passes is
// then fenced as ATTEMPT_TOKEN_MISMATCH after the claim mints a fresh attempt.
await expectErrorCode("tester-1", "swarm_update_task", { taskId: taskId2, nodeId: "test", status: "done", outcome: "passed", attemptId: rwTest1, cwd: scratch }, "ATTEMPT_TOKEN_MISMATCH");
// Reassign after rework mints a fresh attempt; the OLD token must be fenced.
await call("swarm_assign_task", { taskId: taskId2, nodeId: "test", agentId: "tester-1", cwd: scratch });
const rwTest2 = readNode(taskId2, "test").activeAttemptId;
ok("reassign after rework mints new attempt", !!rwTest2 && rwTest2 !== rwTest1);
await expectErrorCode("tester-1", "swarm_update_task", { taskId: taskId2, nodeId: "test", status: "done", outcome: "passed", attemptId: rwTest1, cwd: scratch }, "ATTEMPT_TOKEN_MISMATCH");
await awaitAs("tester-1", "swarm_update_task", { taskId: taskId2, nodeId: "test", status: "done", outcome: "passed", attemptId: rwTest2, cwd: scratch });
ok("post-rework active token works", readNode(taskId2, "test").attemptHistory.at(-1).status === "completed");

// ============ 4. Audit immutability + persistence ============
const hist = readNode(taskId2, "test").attemptHistory;
ok("audit history append-only (2 attempts)", hist.length === 2);
ok("attempt 1 failed, annotated superseded by <rework>", hist[0].status === "failed" && hist[0].supersededBy === "<rework>" && hist[0].attemptNumber === 1);
ok("attempt 2 completed with outcome", hist[1].status === "completed" && hist[1].outcome === "passed" && hist[1].attemptNumber === 2);
ok("attempt records carry assignee + message id", hist.every((a) => a.assignee === "tester-1" && a.assignmentMessageId));

// Legacy compat: strip attempt fields from plan in task 2 and verify update works via assignee check.
const t2path = join(scratch, `.pi/swarm/tasks/${taskId2}/task.json`);
const t2 = JSON.parse(readFileSync(t2path, "utf8"));
delete t2.nodes.plan.activeAttemptId;
delete t2.nodes.plan.attemptHistory;
t2.nodes.plan.status = "assigned";
t2.nodes.plan.assignee = "worker-a";
const { writeFileSync } = await import("node:fs");
writeFileSync(t2path, JSON.stringify(t2, null, 2));
// plan is terminal done; root force-moves it to in_progress, then worker-a (still the
// stamped assignee, no attempt fields) updates it back to done WITHOUT an attempt token.
await awaitAs("root", "swarm_update_task", { taskId: taskId2, nodeId: "plan", status: "in_progress", force: true, cwd: scratch });
await awaitAs("worker-a", "swarm_update_task", { taskId: taskId2, nodeId: "plan", status: "done", outcome: "planned", cwd: scratch });
ok("legacy node (no attempt fields) updateable without token", readNode(taskId2, "plan").status === "done");

console.log(`\n${fail === 0 ? "FENCING PASS" : "FENCING FAIL"} (${fail} failures)`);
rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
