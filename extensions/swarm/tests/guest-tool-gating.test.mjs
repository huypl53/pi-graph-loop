// guest-tool-gating.test.mjs — regression proof that guest sessions never retain swarm tools.
//
// Reproduces:
// 1. Sibling extension (e.g. tbox/tool-masking) re-enabling tools after session_start.
// 2. Mid-session tool changes before agent turn (before_agent_start).
// 3. Session tree navigation / clear (session_tree).
// 4. Execution-time invocation rejection when caller is guest (wrapSwarmToolInvocation).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

let pass = 0;
let fail = 0;
const ok = (n, c, extra = "") => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n, extra);
	}
};

const scratch = mkdtempSync(join(tmpdir(), "guest-gating-test-"));
delete process.env.PI_SWARM_AGENT_ID;
delete process.env.PI_SWARM_IS_ROOT;
delete process.env.PI_SWARM_ADMIN_MODE;

const toolDefs = new Map();
let activeTools = new Set();
const handlers = {};
const commands = [];

const pi = {
	registerTool: (def) => {
		toolDefs.set(def.name, def);
		activeTools.add(def.name);
	},
	registerCommand: (name) => {
		commands.push(name);
	},
	on: (ev, fn) => {
		(handlers[ev] ??= []).push(fn);
	},
	getActiveTools: () => [...activeTools],
	getAllTools: () => [...toolDefs.values()].map((d) => ({ name: d.name })),
	setActiveTools: (names) => {
		activeTools = new Set(names);
	},
	exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	sendMessage: () => {},
};

factory(pi);

// Builtin non-swarm tools
pi.registerTool({ name: "bash" });
pi.registerTool({ name: "read" });
pi.registerTool({ name: "edit" });

const swarmActive = () => [...activeTools].filter((n) => n.startsWith("swarm_"));
const mkCtx = () => ({
	cwd: scratch,
	mode: "tui",
	hasUI: false,
	ui: { setStatus() {}, notify() {} },
	isIdle: () => false,
});

console.log("\n[1] session_start: sibling extension restores all tools after swarm gating");
// Swarm session_start runs, scheduling deferred re-gating
const sessionStartPromises = (handlers.session_start || []).map((fn) => fn({}, mkCtx()));
// Sibling extension runs during the session_start emit sequence and clobbers tool set
pi.setActiveTools([...toolDefs.keys()]);
ok("simulated sibling restore: swarm tools were force-added", swarmActive().length > 0);

// Wait for event loop ticks (setImmediate / queueMicrotask)
await new Promise((r) => setTimeout(r, 20));
ok(
	"1b: deferred tick strips swarm tools for guest after sibling clobber",
	swarmActive().length === 0,
	`active=[${swarmActive().join(",")}]`,
);

console.log("\n[2] before_agent_start: re-asserts tool gating before agent turn begins");
// Simulate another mid-session tool mutation adding swarm tools back
pi.setActiveTools([...toolDefs.keys()]);
ok("mid-session tool leakage: swarm tools active before turn", swarmActive().length > 0);

// before_agent_start fires before LLM prompt is executed
for (const fn of handlers.before_agent_start || []) {
	await fn({ prompt: "hello", systemPrompt: "base prompt" }, mkCtx());
}
ok("2b: before_agent_start strips swarm tools for guest", swarmActive().length === 0, `active=[${swarmActive().join(",")}]`);

console.log("\n[3] session_tree: re-asserts tool gating on tree changes");
pi.setActiveTools([...toolDefs.keys()]);
for (const fn of handlers.session_tree || []) {
	await fn({}, mkCtx());
}
ok("3b: session_tree strips swarm tools for guest", swarmActive().length === 0, `active=[${swarmActive().join(",")}]`);

console.log("\n[4] wrapSwarmToolInvocation: execution-time rejection for guest caller");
const listAgentsTool = toolDefs.get("swarm_list_agents");
ok("swarm_list_agents is registered", Boolean(listAgentsTool));
if (listAgentsTool) {
	let rejected = false;
	let errMessage = "";
	try {
		await listAgentsTool.execute("call-1", {}, undefined, undefined, mkCtx());
	} catch (err) {
		rejected = true;
		errMessage = String(err?.message || err);
	}
	ok("guest invocation of swarm_list_agents is rejected", rejected, errMessage);
	ok("error indicates guest authority denial", /guest/i.test(errMessage), errMessage);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\nGUEST-TOOL-GATING ${fail ? "FAIL" : "PASS"} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
