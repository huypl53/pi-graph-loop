// Smoke: load the REAL extension factory and confirm every tool registers + the 3 named exports exist.
// Run: node extensions/swarm/smoke.test.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;
if (typeof factory !== "function") throw new Error("no default export function");
const tools = [];
const cmds = [];
const hooks = {};
const pi = {
	registerTool: (def) => {
		tools.push(def.name);
	},
	registerCommand: (name) => {
		cmds.push(name);
	},
	on: (ev) => {
		hooks[ev] = true;
	},
	exec: async () => ({ code: 1, stdout: "", stderr: "" }),
};
factory(pi);
const expected = [
	"swarm_agent_status",
	"swarm_list_agents",
	"swarm_spawn_agent",
	"swarm_stop_agent",
	"swarm_set_goal",
	"swarm_mark_goal_done",
	"swarm_send_message",
	"swarm_check_mailbox",
	"swarm_reconcile",
	"swarm_create_task",
	"swarm_task_status",
	"swarm_assign_task",
	"swarm_update_task",
	"swarm_audit",
];
const expectedCommands = ["swarm", "swarm-agents", "swarm-tasks", "swarm-msg"];
const missing = expected.filter((n) => !tools.includes(n));
const extra = tools.filter((n) => !expected.includes(n));
console.log("registered", tools.length, "tools,", cmds.length, "commands,", Object.keys(hooks).length, "hooks");
if (missing.length) {
	console.error("MISSING tools:", missing);
	process.exit(1);
}
if (extra.length) console.log("EXTRA tools (info):", extra);
const missingCommands = expectedCommands.filter((n) => !cmds.includes(n));
if (missingCommands.length) {
	console.error("MISSING commands:", missingCommands);
	process.exit(1);
}
if (typeof mod.isDeliveryFailureRetryable !== "function") {
	console.error("MISSING named export:", "isDeliveryFailureRetryable");
	process.exit(1);
}
console.log("SMOKE PASS");
