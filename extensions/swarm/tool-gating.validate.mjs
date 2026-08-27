// tool-gating.validate.mjs — deterministic proof that swarm tool visibility is identity-gated.
//
// Loads the REAL extension factory (extensions/swarm/index.ts) into a faithful mock pi whose
// getActiveTools/getAllTools/setActiveTools are backed by real in-memory sets, then drives the REAL
// session_start hook under different identities and asserts the active tool set. Also simulates the
// `/swarm register here` opt-in re-gating path. No network, no model — pure logic against real code.
//
// Run: node extensions/swarm/tool-gating.validate.mjs
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "index.ts"));
const factory = mod.default;
if (typeof factory !== "function") throw new Error("no default export");

// --- faithful mock pi with REAL active-tool bookkeeping ---
const toolDefs = new Map();      // name -> definition
const activeTools = new Set();   // the live "active" set
const commands = [];
const handlers = {};
const pi = {
	registerTool: (def) => { toolDefs.set(def.name, def); activeTools.add(def.name); }, // registered => active by default
	registerCommand: (name) => { commands.push(name); },
	on: (ev, fn) => { (handlers[ev] ??= []).push(fn); },
	getActiveTools: () => [...activeTools],
	getAllTools: () => [...toolDefs.values()].map((d) => ({ name: d.name })),
	setActiveTools: (names) => { activeTools.clear(); for (const n of names) activeTools.add(n); },
	exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	sendMessage: () => {},
};

factory(pi);

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log("  ok  ", n); } else { fail++; console.error("  FAIL", n, extra); } };
const swarmActive = () => [...activeTools].filter((n) => n.startsWith("swarm_"));
const nonSwarmSample = () => [...activeTools].filter((n) => !n.startsWith("swarm_"));

console.log("\n[0] extension registers swarm tools and they are active by default");
const allNames = [...toolDefs.keys()];
const swarmCount = allNames.filter((n) => n.startsWith("swarm_")).length;
ok("swarm tools registered (>0)", swarmCount > 0, `count=${swarmCount}`);
ok("all registered swarm tools active by default", swarmActive().length === swarmCount, `${swarmActive().length}/${swarmCount}`);

// The mock registers synthetic non-swarm tools so we can prove gating never touches them.
pi.registerTool({ name: "bash" }); pi.registerTool({ name: "read" }); pi.registerTool({ name: "edit" });

const cwd = mkdtempSync(join(tmpdir(), "swarm-gate-"));
const mkCtx = () => ({ cwd, mode: "tui", hasUI: false, ui: { setStatus() {} }, isIdle: () => false });

const runSessionStart = async () => {
	for (const fn of (handlers.session_start || [])) await fn({}, mkCtx());
};

// Re-gating helper mirroring what `/swarm register here` does in command.ts (set env then gate).
const { applySwarmToolGating } = await import(join(here, "src", "tools", "gating.ts"));

console.log("\n[1] GUEST session (no PI_SWARM_AGENT_ID, no PI_SWARM_IS_ORCHESTRATOR) loses swarm tools");
delete process.env.PI_SWARM_AGENT_ID;
delete process.env.PI_SWARM_IS_ORCHESTRATOR;
await runSessionStart();
ok("guest: zero swarm tools active", swarmActive().length === 0, `leftover=[${swarmActive().join(",")}]`);
ok("guest: non-swarm tools preserved", nonSwarmSample().sort().join(",") === "bash,edit,read", `[${nonSwarmSample().join(",")}]`);

console.log("\n[2] GUEST gating is idempotent (re-run session_start does not throw / no change)");
await runSessionStart();
ok("guest: still zero swarm tools after re-run", swarmActive().length === 0);

console.log("\n[3] REGISTERED AGENT session keeps swarm tools active");
process.env.PI_SWARM_AGENT_ID = "worker";
delete process.env.PI_SWARM_IS_ORCHESTRATOR;
await runSessionStart();
ok("agent: swarm tools present", swarmActive().length === swarmCount, `${swarmActive().length}/${swarmCount}`);
ok("agent: non-swarm tools preserved", nonSwarmSample().sort().join(",") === "bash,edit,read");

console.log("\n[4] ORCHESTRATOR session (explicit opt-in) keeps swarm tools active");
delete process.env.PI_SWARM_AGENT_ID;
process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
await runSessionStart();
ok("orchestrator: swarm tools present", swarmActive().length === swarmCount, `${swarmActive().length}/${swarmCount}`);

console.log("\n[5] Opt-in escape hatch: guest -> register here -> tools re-enabled in-process");
delete process.env.PI_SWARM_AGENT_ID;
delete process.env.PI_SWARM_IS_ORCHESTRATOR;
await runSessionStart();                                  // back to guest: tools off
ok("opt-in start: guest has no swarm tools", swarmActive().length === 0);
process.env.PI_SWARM_AGENT_ID = "worker";                 // mimic `/swarm register here worker`
applySwarmToolGating(pi);                                 // mimic command.ts re-gate
ok("opt-in end: swarm tools re-enabled", swarmActive().length === swarmCount, `${swarmActive().length}/${swarmCount}`);

console.log("\n[6] Slash COMMAND is still registered for a guest (escape hatch intact)");
ok("/swarm command registered", commands.includes("swarm"));
ok("scoped /swarm-* commands registered", ["swarm-agents", "swarm-tasks", "swarm-msg"].every((c) => commands.includes(c)), `[${commands.join(",")}]`);

// Re-seed a writable scratch (the cwd above was wiped at end of [4] in some failures; use a fresh one).
const gateScratch = mkdtempSync(join(tmpdir(), "swarm-gate-prune-"));
const mkGateCtx = () => ({ cwd: gateScratch, mode: "tui", hasUI: false, ui: { setStatus() {} }, isIdle: () => false });

console.log("\n[7] ROLE-GATED destructive tools (Issue 10) reject non-orchestrator callers");
{
	const savedId = process.env.PI_SWARM_AGENT_ID;
	const savedOrch = process.env.PI_SWARM_IS_ORCHESTRATOR;

	// Seed a minimal swarm-state.json so prune/gc can read+write it.
	await import("node:fs/promises").then((fs) => fs.mkdir(join(gateScratch, ".pi/swarm"), { recursive: true }));
	const seedState = { version: 1, swarmId: "swarm-test", cwd: gateScratch, tmuxSession: "test", agents: {}, delivered: {}, messages: {}, orchestratorPumpSessions: {} };
	await import("node:fs/promises").then((fs) => fs.writeFile(join(gateScratch, ".pi/swarm/swarm-state.json"), JSON.stringify(seedState, null, 2)));

	const pruneTool = toolDefs.get("swarm_prune");
	const gcTool = toolDefs.get("swarm_gc");

	// --- (a) non-orchestrator caller is rejected BEFORE any state mutation ---
	process.env.PI_SWARM_AGENT_ID = "worker";
	delete process.env.PI_SWARM_IS_ORCHESTRATOR;
	const denyPrune = await pruneTool.execute("call", { dryRun: false, removeStopped: false, markDead: false }, undefined, undefined, mkGateCtx()).then(
		() => "ALLOWED",
		(err) => String(err?.message || err),
	);
	ok("non-orchestrator: swarm_prune rejected with ORCHESTRATOR_AUTHORITY_REQUIRED", denyPrune.includes("ORCHESTRATOR_AUTHORITY_REQUIRED"), denyPrune);
	const denyGc = await gcTool.execute("call", { dryRun: false }, undefined, undefined, mkGateCtx()).then(
		() => "ALLOWED",
		(err) => String(err?.message || err),
	);
	ok("non-orchestrator: swarm_gc rejected with ORCHESTRATOR_AUTHORITY_REQUIRED", denyGc.includes("ORCHESTRATOR_AUTHORITY_REQUIRED"), denyGc);

	// --- (b) orchestrator caller is allowed (dry-run default) ---
	delete process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
	const allowPrune = await pruneTool.execute("call", {}, undefined, undefined, mkGateCtx()).then(
		(r) => r?.content?.[0]?.text || "ALLOWED",
		(err) => `DENIED:${String(err?.message || err)}`,
	);
	ok("orchestrator: swarm_prune dry-run default succeeds", /Swarm Prune|dryRun/.test(allowPrune), allowPrune.slice(0, 80));
	const allowGc = await gcTool.execute("call", {}, undefined, undefined, mkGateCtx()).then(
		(r) => r?.content?.[0]?.text || "ALLOWED",
		(err) => `DENIED:${String(err?.message || err)}`,
	);
	ok("orchestrator: swarm_gc dry-run default succeeds", /dry run|applied/.test(allowGc), allowGc.slice(0, 80));

	// Restore
	if (savedId === undefined) delete process.env.PI_SWARM_AGENT_ID; else process.env.PI_SWARM_AGENT_ID = savedId;
	if (savedOrch === undefined) delete process.env.PI_SWARM_IS_ORCHESTRATOR; else process.env.PI_SWARM_IS_ORCHESTRATOR = savedOrch;
	rmSync(gateScratch, { recursive: true, force: true });
}

rmSync(cwd, { recursive: true, force: true });
console.log(`\nTOOL-GATING ${fail ? "FAIL" : "PASS"} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
