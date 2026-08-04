// Functional: exercise tool execute handlers end-to-end (mock pi) to catch runtime ReferenceErrors
// from missing value imports across the refactored modules. Covers taskgraph/state/metric/loop/mailbox/reconcile.
// Run: node extensions/swarm/functional.test.mjs
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "index.ts"));
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

const ts = await call("swarm_task_status", { taskId, cwd });
ok("task_status text", !!ts?.content?.[0]?.text);

const vg = await call("swarm_validate_graph", { taskId, cwd });
ok("validate_graph text", !!vg?.content?.[0]?.text);

const pg = await call("swarm_print_graph", { taskId, format: "text", cwd });
ok("print_graph text", !!pg?.content?.[0]?.text);

const nn = await call("swarm_next_nodes", { taskId, cwd });
ok("next_nodes text", !!nn?.content?.[0]?.text);

const md = await call("swarm_metric_define", { id: "quality", title: "Q", primaryMetric: { id: "q", direction: "maximize", valueType: "number", source: { type: "artifact" } } });
ok("metric_define text", !!md?.content?.[0]?.text);

const rr = await call("swarm_run_record", { status: "done", verdict: "pass", metricContractId: "quality", metrics: { q: 0.5 }, cwd });
ok("run_record text", !!rr?.content?.[0]?.text);
const rm = rr.content[0].text.match(/run-[A-Za-z0-9-]+/); const runId = rm?.[0];
ok("runId parsed", !!runId);

const ic = await call("swarm_iteration_create", { metricContractId: "quality", baselineRunId: runId });
ok("iteration_create text", !!ic?.content?.[0]?.text);

const ms = await call("swarm_memory_search", { query: "x" });
ok("memory_search text", !!ms?.content?.[0]?.text);

await call("swarm_task_message", { taskId, fromNode: "plan", to: "orchestrator", body: "hi", cwd });
const rec = await call("swarm_reconcile", { cwd });
ok("reconcile text", !!rec?.content?.[0]?.text);

console.log(`\n${fail === 0 ? "FUNC PASS" : "FUNC FAIL"} (${fail} failures)`);
rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
