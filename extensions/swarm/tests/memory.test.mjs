// Regression tests for the removed experimentation subsystem boundary.
// Run: node extensions/swarm/memory.test.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

let fail = 0;
let pass = 0;
const ok = (name, cond) => {
	if (cond) pass++;
	else { fail++; console.error("  FAIL:", name); }
};

ok("validateRunAgainstContract export removed", typeof mod.validateRunAgainstContract !== "function");
ok("computeIterationBest export removed", typeof mod.computeIterationBest !== "function");

const tools = [];
const cmds = [];
const pi = {
	registerTool: (def) => { tools.push(def.name); },
	registerCommand: (name) => { cmds.push(name); },
	on: () => {},
	exec: async () => ({ code: 1, stdout: "", stderr: "" }),
};
factory(pi);

const removed = tools.filter((n) => /^(swarm_(metric|run|memory|iteration|loop)_)/.test(n));
ok("no experimentation tools are registered", removed.length === 0);
ok("loop command removed", !cmds.includes("swarm-loop"));
ok("core task tools still registered", ["swarm_create_task", "swarm_update_task", "swarm_task_status"].every((n) => tools.includes(n)));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
