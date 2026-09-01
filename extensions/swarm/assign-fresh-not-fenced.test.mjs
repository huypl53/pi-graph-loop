#!/usr/bin/env node
// R11-5 repro: swarm_assign_task to a STOPPED-but-about-to-restart agent fences its own
// canonical assignment message via checkStallNotificationStale branch (6) — the branch was
// designed for NUDGE staleness (surfacing an OLD assignment to a dead agent), but
// swarm_assign_task reuses it for a FRESH assignment whose agent record is momentarily
// `stopped` (the orchestrator restarts the pane right after assigning).
//
// Live incident 2026-09-01 08:25:43 (task-202609010900-issue-84-audit-tooling):
//   task.assign.fenced reason="agent_stopped" — the worker then received the FENCED
//   information message instead of its brief, tried to self-assign
//   (ORCHESTRATOR_AUTHORITY_REQUIRED), and settled idle → swarm deadlock (idle-lock #5).
//
// Expected CORRECT behavior (assertions below): a fresh assignment to a stopped agent
// must deliver the CANONICAL assignment message (subject "... assigned", not FENCED).
// Fence branch (6) must not apply to the fresh-assign path.
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-assign-fence-repro-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

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

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log("  ok  ", n); } else { fail++; console.error("  FAIL", n, extra ?? ""); } };

const call = async (name, params) => {
	const t = tools[name]; if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: scratch });
};

// --- fixture: state with a STOPPED worker (swept after a prior task closed) ---
mkdirSync(join(scratch, ".pi/swarm"), { recursive: true });
const statePath = join(scratch, ".pi/swarm/swarm-state.json");
const nowIso = new Date().toISOString();
// Old canonical assignment message (from the PREVIOUS task) — age >> grace (2min) so branch (6)
// would compute assignmentAge > grace if it wrongly consults the OLD canonId.
const state = {
	version: 1,
	swarmId: "repro",
	agents: {
		orchestrator: { id: "orchestrator", status: "running", runtimeStatus: "idle", activeTaskIds: [], updatedAt: nowIso },
		"worker-x": { id: "worker-x", status: "stopped", runtimeStatus: "stopped", activeTaskIds: [], spawnedForTaskId: null, updatedAt: nowIso },
	},
	messages: {
		"msg-old-assignment": { id: "msg-old-assignment", from: "orchestrator", to: "worker-x", subject: "Task prior / node n assigned", createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), requiresAck: true, status: "acked", ack: { status: "done", at: new Date(Date.now() - 59 * 60 * 1000).toISOString() } },
	},
	updatedAt: nowIso,
};
writeFileSync(statePath, JSON.stringify(state, null, 2));

// --- create a task whose implement node carries a stale OLD assignmentMessageId (reuse shape) ---
const createRes = await call("swarm_create_task", {
	taskId: "repro-r115",
	title: "R11-5 repro",
	goal: "assign-fence repro",
	nodes: {
		plan: { role: "planner", dependsOn: [], writeArtifacts: ["artifacts/plan.md"] },
		implement: { role: "implementer", dependsOn: ["plan"], writeArtifacts: ["artifacts/impl.md"] },
		review: { role: "reviewer", dependsOn: ["implement"], terminal: true, writeArtifacts: ["artifacts/review.md"] },
	},
	edges: [
		{ from: "plan", to: "implement", when: "planned" },
		{ from: "implement", to: "review", when: "implemented" },
	],
	cwd: scratch,
});
ok("task created", !createRes?.details?.error);

// close plan (orchestrator force) so implement becomes ready
await call("swarm_update_task", { taskId: "repro-r115", nodeId: "plan", status: "done", outcome: "planned", force: true, cwd: scratch });

// seed the OLD canonical pointer + a completed prior attempt on implement (the reuse shape)
const taskPath = join(scratch, ".pi/swarm/tasks/repro-r115/task.json");
const task0 = JSON.parse(readFileSync(taskPath, "utf8"));
task0.nodes.implement.assignmentMessageId = "msg-old-assignment";
task0.nodes.implement.attemptHistory = [
	{ attemptId: "attempt-old", assignee: "worker-x", status: "superseded", assignedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), supersededBy: null },
];
writeFileSync(taskPath, JSON.stringify(task0, null, 2));

// --- THE REPRO: assign implement to the STOPPED worker ---
const res = await call("swarm_assign_task", { taskId: "repro-r115", nodeId: "implement", agentId: "worker-x", cwd: scratch });
const fenced = res?.details?.fenced === true;
console.log(fenced ? "\nREPRO (RED): fresh assignment to stopped agent was FENCED (reason=" + res?.details?.reason + ")" : "\nassign outcome fenced=", fenced);

// Assertions of CORRECT behavior:
ok("fresh assignment NOT fenced", fenced === false, `reason=${res?.details?.reason}`);
if (!fenced) {
	const msgId = res?.details?.messageId;
	const st1 = JSON.parse(readFileSync(statePath, "utf8"));
	const rec = st1.messages?.[msgId];
	ok("canonical assignment message delivered (not fence notice)", Boolean(rec) && !/FENCED/.test(rec?.subject || ""), rec?.subject || "(no record)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
