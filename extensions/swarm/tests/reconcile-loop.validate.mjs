// Validation guard: the removed loop subsystem is no longer registered.
// Run: node extensions/swarm/reconcile-loop.validate.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

const tools = [];
const cmds = [];
const pi = {
	registerTool: (def) => {
		tools.push(def.name);
	},
	registerCommand: (name) => {
		cmds.push(name);
	},
	on: () => {},
	exec: async () => ({ code: 1, stdout: "", stderr: "" }),
};
factory(pi);

const failures = [];
const removed = tools.filter((n) => /^(swarm_(metric|run|memory|iteration|loop)_)/.test(n));
if (removed.length) failures.push(`removed experimentation tools still registered: ${removed.join(", ")}`);
if (cmds.includes("swarm-loop")) failures.push("removed loop command still registered");
if (typeof mod.validateRunAgainstContract === "function") failures.push("validateRunAgainstContract export still present");
if (typeof mod.computeIterationBest === "function") failures.push("computeIterationBest export still present");
const coreTools = ["swarm_create_task", "swarm_update_task", "swarm_task_status"];
const missingCore = coreTools.filter((name) => !tools.includes(name));
if (missingCore.length) failures.push(`core task tools missing: ${missingCore.join(", ")}`);
if (failures.length) {
	console.error(failures.join("\n"));
	process.exit(1);
}
console.log("RETIRED-SUBSYSTEM PASS: removed exports, tools, and command absent; core task tools remain");
