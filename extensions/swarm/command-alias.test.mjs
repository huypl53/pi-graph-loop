// Command alias regression: new grouped slash commands delegate to the existing /swarm handlers.
// Run: node extensions/swarm/command-alias.test.mjs
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "index.ts"));
const factory = mod.default;

const cmds = {};
const tools = {};
const pi = {
	registerTool: (def) => { tools[def.name] = def; },
	registerCommand: (name, opts) => { cmds[name] = opts; },
	on: () => {},
	exec: async () => ({ code: 0, stdout: "%1\n", stderr: "" }),
};
factory(pi);

let fail = 0;
const ok = (name, cond) => { if (cond) console.log("  ok  ", name); else { fail++; console.error("  FAIL", name); } };

for (const name of ["swarm", "swarm-agents", "swarm-tasks", "swarm-msg"]) {
	ok(`${name} registered`, typeof cmds[name]?.handler === "function");
}

const cwd = join(tmpdir(), `swarm-cmd-alias-${process.pid}-${Date.now()}`);
rmSync(cwd, { recursive: true, force: true });
const notes = [];
const ctx = {
	cwd,
	hasUI: true,
	ui: {
		notify: (msg, level) => notes.push({ msg, level }),
		setStatus: () => {},
	},
};

await cmds.swarm.handler("init", ctx);
ok("/swarm init notifies ready", notes.at(-1)?.msg?.includes("ready"));

await cmds["swarm-agents"].handler("list", ctx);
ok("/swarm-agents list delegates to list", /agents, tmux/.test(notes.at(-1)?.msg || ""));

await cmds["swarm-tasks"].handler("list", ctx);
ok("/swarm-tasks list delegates to tasks list", /No tasks found/.test(notes.at(-1)?.msg || ""));

await cmds["swarm-msg"].handler("", ctx);
ok("/swarm-msg empty shows usage", /Usage: \/swarm-msg send/.test(notes.at(-1)?.msg || ""));


rmSync(cwd, { recursive: true, force: true });
if (fail) { console.error(`\nCOMMAND ALIAS FAIL (${fail})`); process.exit(1); }
console.log("\nCOMMAND ALIAS PASS");
