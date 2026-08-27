// Validation guard: the removed loop subsystem is no longer registered.
// Run: node extensions/swarm/loop-reconcile.validate.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "index.ts"));
const factory = mod.default;

const tools = [];
const cmds = [];
const pi = {
	registerTool: (def) => { tools.push(def.name); },
	registerCommand: (name) => { cmds.push(name); },
	on: () => {},
	exec: async () => ({ code: 1, stdout: "", stderr: "" }),
};
factory(pi);

const loopTools = tools.filter((n) => /^swarm_loop_/.test(n));
if (loopTools.length) {
	console.error("Loop tools still registered:", loopTools);
	process.exit(1);
}
if (cmds.includes("swarm-loop")) {
	console.error("Loop command still registered");
	process.exit(1);
}
console.log("LOOP-RECONCILE PASS: loop subsystem removed from registration");
