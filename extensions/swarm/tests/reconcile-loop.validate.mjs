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
	registerTool: (def) => { tools.push(def.name); },
	registerCommand: (name) => { cmds.push(name); },
	on: () => {},
	exec: async () => ({ code: 1, stdout: "", stderr: "" }),
};
factory(pi);

const removed = tools.filter((n) => /^(swarm_(metric|run|memory|iteration|loop)_)/.test(n));
if (removed.length) {
	console.error("Removed experimentation tools still registered:", removed);
	process.exit(1);
}
if (cmds.includes("swarm-loop")) {
	console.error("Removed loop command still registered");
	process.exit(1);
}
console.log("RECONCILE-LOOP PASS: experimentation subsystem removed from registration");
