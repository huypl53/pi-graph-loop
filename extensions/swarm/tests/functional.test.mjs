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
const call = async (name, params) => {
	const t = tools[name]; if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: params.cwd || scratch });
};
const cwd = scratch;
let fail = 0;
const ok = (n, c) => { if (c) console.log("  ok  ", n); else { fail++; console.error("  FAIL", n); } };

const ct = await call("swarm_create_task", { title: "Demo", goal: "g", priority: "normal", cwd });
ok("create_task returns text", ct?.content?.[0]?.text?.includes("task-"));
const m = ct.content[0].text.match(/task-[A-Za-z0-9-]+/); const taskId = m[0];
ok("taskId parsed", !!taskId);

const taskPath = join(cwd, `.pi/swarm/tasks/${taskId}/task.json`);
// Reliability Phase 1: only root may set force=true. The functional test runs as a regular
// agent, so we drive the graph by stamping the node's assignee to the current agent between updates
// (mirroring how swarm_assign_task would, without depending on the agent pool).
// Drive the graph by stamping the node's assignee to the pinned test agent between updates
// (mirroring how swarm_assign_task would, without depending on the agent pool). No attempt
// fencing fields are stamped: these nodes have no attempt history, exercising the legacy path.
const ASSIGNEE = process.env.PI_SWARM_AGENT_ID;
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

const vg = await call("swarm_validate_graph", { taskId, cwd });
ok("validate_graph text", !!vg?.content?.[0]?.text);

const pg = await call("swarm_print_graph", { taskId, format: "text", cwd });
ok("print_graph text", !!pg?.content?.[0]?.text);

const nn = await call("swarm_next_nodes", { taskId, cwd });
ok("next_nodes text", !!nn?.content?.[0]?.text);

await call("swarm_task_message", { taskId, fromNode: "plan", to: "root", body: "hi", cwd });
const rec = await call("swarm_reconcile", { cwd });
ok("reconcile text", !!rec?.content?.[0]?.text);

console.log(`\n${fail === 0 ? "FUNC PASS" : "FUNC FAIL"} (${fail} failures)`);
rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
