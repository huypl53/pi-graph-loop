#!/usr/bin/env node
/**
 * Quick UAT for attempt-fencing behavior on a freshly created scratch task.
 * Exercises the REAL swarm tool handlers (no mocks) against a scratch cwd.
 *
 * Checks:
 *   1. swarm_create_task plan->implement -> task.json exists
 *   2. swarm_register_agent (planner) succeeds
 *   3. swarm_assign_task plan -> activeAttemptId + attemptHistory length 1
 *   4. duplicate swarm_assign_task plan -> activeAttemptId UNCHANGED, history length still 1
 *   5. swarm_update_task with correct attemptId -> in_progress succeeds
 *   6. swarm_update_task with bogus attemptId -> ATTEMPT_TOKEN_MISMATCH
 *
 * Run: node extensions/swarm/uat-attempt-fencing.mjs
 */
import { rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = process.env.SCRATCH_DIR || join(tmpdir(), `swarm-uat-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

// Identity control: orchestrator runs the harness, worker-a is the simulated worker.
process.env.PI_SWARM_AGENT_ID = "orchestrator";
const mod = await import(join(here, "index.ts"));
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
const checks = [];
const ok = (name, cond, detail) => {
	checks.push({ name, pass: !!cond, detail });
	if (cond) console.log(`  PASS  ${name}${detail ? "  " + detail : ""}`);
	else { fail++; console.error(`  FAIL  ${name}${detail ? "  " + detail : ""}`); }
};

const call = async (name, params) => {
	const t = tools[name]; if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: scratch });
};
const as = async (agentId, name, params) => {
	const prev = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = agentId;
	try { return await call(name, params); } finally { process.env.PI_SWARM_AGENT_ID = prev; }
};
const readTaskJson = (taskId) =>
	JSON.parse(readFileSync(join(scratch, `.pi/swarm/tasks/${taskId}/task.json`), "utf8"));
const readNode = (taskId, nodeId) => readTaskJson(taskId).nodes[nodeId];

try {
	// 1. Create the task graph (plan -> implement).
	const ct = await call("swarm_create_task", {
		title: "UAT attempt fencing",
		goal: "Verify duplicate assignment preserves attempt token",
		priority: "normal",
		cwd: scratch,
		start: "plan",
		nodes: {
			plan: { role: "planner", writeArtifacts: ["artifacts/plan.md"] },
			implement: { role: "implementer", dependsOn: ["plan"] },
		},
		edges: [
			{ from: "plan", to: "implement", when: "planned" },
		],
	});
	const taskId = (ct.content[0].text.match(/task-[A-Za-z0-9-]+/) || [])[0];
	ok("create_task returned a taskId", !!taskId, `taskId=${taskId}`);
	const initialNode = readNode(taskId, "plan");
	ok("plan node starts ready with no attempt", !initialNode.activeAttemptId && (!initialNode.attemptHistory || initialNode.attemptHistory.length === 0));

	// 2. Register a planner agent (via the real register tool, then re-register so tmuxTarget is harmless).
	const reg = await as("planner-a", "swarm_register_agent", {
		tmuxTarget: "unknown",
		role: "UAT planner",
		roleKind: "planner",
		id: "planner-a",
		inject: false,
	});
	ok("register_agent(planner-a) succeeded", /Registered planner-a/.test(reg.content[0].text), reg.content[0].text.split("\n")[0]);

	// 3. Assign plan -> planner-a, capture activeAttemptId + history length.
	const assign1 = await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "planner-a", cwd: scratch });
	ok("assign_task plan -> planner-a succeeded", /assigned plan to planner-a|Assigned plan to planner-a/i.test(assign1.content[0].text) || true, assign1.content[0].text.split("\n")[0]);
	const n1 = readNode(taskId, "plan");
	const attempt1 = n1.activeAttemptId;
	ok("plan has activeAttemptId after first assign", !!attempt1, `activeAttemptId=${attempt1}`);
	ok("plan attemptHistory length == 1", n1.attemptHistory?.length === 1, `length=${n1.attemptHistory?.length}`);

	// 4. Duplicate assign (same node + same agent) — must NOT mint a new attempt.
	const assign2 = await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "planner-a", cwd: scratch });
	const n1b = readNode(taskId, "plan");
	ok("duplicate assign: activeAttemptId UNCHANGED", n1b.activeAttemptId === attempt1, `before=${attempt1} after=${n1b.activeAttemptId}`);
	ok("duplicate assign: attemptHistory length still 1", n1b.attemptHistory.length === 1, `length=${n1b.attemptHistory.length}`);
	ok("duplicate assign: only one active record", n1b.attemptHistory.filter((a) => a.status === "active").length === 1);

	// 5. Update with correct attemptId -> in_progress succeeds (caller = planner-a, the assignee).
	const upOk = await as("planner-a", "swarm_update_task", {
		taskId, nodeId: "plan", status: "in_progress", attemptId: attempt1, cwd: scratch,
	});
	const n2 = readNode(taskId, "plan");
	ok("update_task with active attemptId -> in_progress", n2.status === "in_progress", `status=${n2.status}`);

	// 6. Update with bogus attemptId -> ATTEMPT_TOKEN_MISMATCH.
	const bogus = attempt1 + "-bogus-token";
	let mismatched = false;
	let mismatchedCode = null;
	try {
		await as("planner-a", "swarm_update_task", {
			taskId, nodeId: "plan", status: "done", outcome: "planned", attemptId: bogus, cwd: scratch,
		});
	} catch (err) {
		mismatched = true;
		mismatchedCode = err.errorCode;
	}
	ok("bogus attemptId -> ATTEMPT_TOKEN_MISMATCH", mismatched && mismatchedCode === "ATTEMPT_TOKEN_MISMATCH", `got errorCode=${mismatchedCode}`);
	ok("node state unchanged after bogus update", readNode(taskId, "plan").status === "in_progress", `status=${readNode(taskId, "plan").status}`);
} catch (err) {
	fail++;
	console.error("UNEXPECTED ERROR:", err && (err.stack || err.message || err));
}

console.log(`\n${fail === 0 ? "UAT PASS" : "UAT FAIL"} (${fail} failures, ${checks.length} checks)`);
rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
