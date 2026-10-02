// Functional: exercise core tool execute handlers end-to-end (mock pi) to catch runtime ReferenceErrors
// from missing value imports across the refactored modules. Covers taskgraph/state/mailbox/reconcile.
// Run: node extensions/swarm/functional.test.mjs
import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
// Pin a deterministic non-root identity BEFORE importing the extension so currentAgentId()
// never depends on the ambient swarm environment (the test may run inside any agent's shell).
process.env.PI_SWARM_AGENT_ID = "implementer-01";
process.env.PI_SWARM_IS_ROOT = "";
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;
const scratch = join(tmpdir(), `swarm-func-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
const tools = {};
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
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
const call = async (name, params) => {
	const t = tools[name];
	if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: params.cwd || scratch });
};
const cwd = scratch;
let fail = 0;
const ok = (n, c) => {
	if (c) console.log("  ok  ", n);
	else {
		fail++;
		console.error("  FAIL", n);
	}
};

const ASSIGNEE_STAMP = process.env.PI_SWARM_AGENT_ID;
// swarm_create_task is root-only (documented authority contract since Phase 1; the suite's
// historical non-root create was the stale side of the drift — testgate plan §0). Stamp root
// for the privileged setup call, then restore the pinned non-root identity so the
// assignee-stamping legs below still exercise a regular agent.
{
	const prevId = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = "root";
	const { paths: swarmPaths, readState: readSwarmState, writeState: writeSwarmState } = await import(join(here, "..", "src", "state.ts"));
	const sp = swarmPaths(cwd);
	const st = await readSwarmState(sp, cwd);
	st.agents = st.agents || {};
	st.agents.root = st.agents.root || {
		id: "root",
		role: "PM",
		roleKind: "root",
		roleKindExplicit: true,
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 99,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxSession: "x",
		tmuxWindow: "unknown",
		tmuxTarget: "unknown",
		model: "m",
		provider: "p",
		cwd,
		mailbox: "x",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	st.agents[ASSIGNEE_STAMP] = st.agents[ASSIGNEE_STAMP] || {
		id: ASSIGNEE_STAMP,
		role: "implementer",
		roleKind: "implementer",
		roleKindExplicit: true,
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxSession: "x",
		tmuxWindow: "unknown",
		tmuxTarget: "unknown",
		model: "m",
		provider: "p",
		cwd,
		mailbox: "x",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	await writeSwarmState(sp, st);
	// Keep root stamped for the privileged create itself; restore after.
	const ct = await call("swarm_create_task", { title: "Demo", goal: "g", priority: "normal", cwd });
	process.env.PI_SWARM_AGENT_ID = prevId;
	var ctOut = ct;
}
const ct = ctOut;
ok("create_task returns text", ct?.content?.[0]?.text?.includes("task-"));
const m = ct.content[0].text.match(/task-[A-Za-z0-9-]+/);
const taskId = m[0];
ok("taskId parsed", !!taskId);

const taskPath = join(cwd, `.pi/swarm/tasks/${taskId}/task.json`);
// Reliability Phase 1: only root may set force=true. The functional test runs as a regular
// agent, so we drive the graph by stamping the node's assignee to the current agent between updates
// (mirroring how swarm_assign_task would, without depending on the agent pool).
// Drive the graph by stamping the node's assignee to the pinned test agent between updates
// (mirroring how swarm_assign_task would, without depending on the agent pool). No attempt
// fencing fields are stamped: these nodes have no attempt history, exercising the legacy path.
const ASSIGNEE = process.env.PI_SWARM_AGENT_ID;
void ASSIGNEE;
const stamp = (nodeId, status) => {
	const j = JSON.parse(readFileSync(taskPath, "utf8"));
	j.nodes[nodeId].status = status;
	j.nodes[nodeId].assignee = ASSIGNEE;
	writeFileSync(taskPath, JSON.stringify(j, null, 2));
};
const stampOutcome = (nodeId, status, outcome) => {
	const j = JSON.parse(readFileSync(taskPath, "utf8"));
	j.nodes[nodeId].status = status;
	j.nodes[nodeId].assignee = ASSIGNEE;
	if (outcome !== undefined) j.nodes[nodeId].outcome = outcome;
	writeFileSync(taskPath, JSON.stringify(j, null, 2));
};
// Pretend each prior node has been assigned to "root" so a normal-call update is accepted via
// assignee authority. The agent pool lookup is irrelevant for this regression scenario.
stamp("plan", "assigned");
await call("swarm_update_task", { taskId, nodeId: "plan", status: "done", outcome: "planned", cwd });
stampOutcome("implement", "assigned");
await call("swarm_update_task", { taskId, nodeId: "implement", status: "done", outcome: "implemented", cwd });
stampOutcome("test", "assigned");
await call("swarm_update_task", { taskId, nodeId: "test", status: "failed", outcome: "failed", cwd });
let taskJson = JSON.parse(readFileSync(taskPath, "utf8"));
ok("failed test makes fix actionable", taskJson.currentNodes.includes("fix"));
stampOutcome("fix", "assigned");
await call("swarm_update_task", { taskId, nodeId: "fix", status: "done", outcome: "implemented", cwd });
taskJson = JSON.parse(readFileSync(taskPath, "utf8"));
ok("fix done reopens test as ready", taskJson.nodes.test.status === "ready");
ok("task returns to in_progress after rework reopen", taskJson.status === "in_progress");

const ts = await call("swarm_task_status", { taskId, cwd });
ok("task_status text", !!ts?.content?.[0]?.text);

// swarm_validate_graph / swarm_print_graph / swarm_next_nodes / swarm_task_message were retired
// from the live surface (R31-era 21-tool trim, CHANGELOG-documented); their observability role
// is served by swarm_task_status (asserted above) and the graph reads inside it.
console.log("   skip validate/print/next_nodes/task_message: retired from live surface (R31 trim)");

await call("swarm_send_message", { to: "root", body: "functional test message", cwd });
const rec = await call("swarm_reconcile", { cwd });
ok("reconcile text", !!rec?.content?.[0]?.text);

console.log(`\n${fail === 0 ? "FUNC PASS" : "FUNC FAIL"} (${fail} failures)`);
rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
