// Smoke: load the REAL extension factory and confirm every tool registers + the 3 named exports exist.
// Run: node extensions/swarm/smoke.test.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "index.ts"));
const factory = mod.default;
if (typeof factory !== "function") throw new Error("no default export function");
const tools = [];
const cmds = [];
const hooks = {};
const pi = {
	registerTool: (def) => { tools.push(def.name); },
	registerCommand: (name) => { cmds.push(name); },
	on: (ev) => { hooks[ev] = true; },
	exec: async () => ({ code: 1, stdout: "", stderr: "" }),
};
factory(pi);
const expected = ["swarm_spawn_agent","swarm_list_agents","swarm_agent_status","swarm_send_message","swarm_check_mailbox","swarm_ack_message","swarm_message_status","swarm_reconcile","swarm_prune","swarm_dead_letters","swarm_trace","swarm_capture_agent_pane","swarm_agent_identity","swarm_reload_identity","swarm_register_agent","swarm_stop_agent","swarm_restart_agent","swarm_set_role","swarm_set_agent_paused","swarm_send_keys","swarm_attach_agent","swarm_release_agent_task","swarm_create_task","swarm_assign_task","swarm_update_task","swarm_task_message","swarm_task_status","swarm_validate_graph","swarm_print_graph","swarm_next_nodes","swarm_metric_define","swarm_metric_get","swarm_run_record","swarm_run_get","swarm_run_compare","swarm_memory_propose","swarm_memory_search","swarm_memory_accept","swarm_iteration_create","swarm_iteration_record","swarm_iteration_status","swarm_iteration_context","swarm_loop_status","swarm_loop_plan"];
const missing = expected.filter((n) => !tools.includes(n));
const extra = tools.filter((n) => !expected.includes(n));
console.log("registered", tools.length, "tools,", cmds.length, "commands,", Object.keys(hooks).length, "hooks");
if (missing.length) { console.error("MISSING tools:", missing); process.exit(1); }
if (extra.length) console.log("EXTRA tools (info):", extra);
for (const name of ["isDeliveryFailureRetryable","validateRunAgainstContract","computeIterationBest"]) {
	if (typeof mod[name] !== "function") { console.error("MISSING named export:", name); process.exit(1); }
}
console.log("SMOKE PASS");
