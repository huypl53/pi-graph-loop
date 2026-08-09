// Tests for `/swarm register` identity adoption + orchestrator opt-in:
//  - 'here <id>' adopts the identity in-process (env + footer) for a normal agent
//  - 'here orchestrator' performs a FULL PM opt-in (env + mailbox-only record + pump + footer)
//  - registering a DIFFERENT pane as orchestrator is refused
//  - registerAgent itself refuses the reserved 'orchestrator' id (safety net for the tool path)
//
// Run: node extensions/swarm/register-adopt.test.mjs
import { rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "index.ts"));
const factory = mod.default;
const { registerAgent } = await import(join(here, "src", "agents.ts"));
const { stopOrchestratorPump } = await import(join(here, "src", "hooks.ts"));

const scratch = join(tmpdir(), `swarm-adopt-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

let swarmCmd = null;
// `targetPaneId` is what a targeted display-message (liveness / paneIdOf, sends -t) returns; the
// current-pane probe (no -t) always returns "work\t0\t1\t%7" so currentPaneTarget() resolves to %7.
const bind = (targetPaneId) => {
	swarmCmd = null;
	const pi = {
		registerTool: () => {},
		registerCommand: (name, opts) => { if (name === "swarm") swarmCmd = opts; },
		on: () => {},
		sendMessage: () => {},
		exec: async (cmd, args) => {
			if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
			if (cmd !== "tmux") return { code: 1, stdout: "", stderr: "" };
			if (args[0] === "display-message") {
				if (args.includes("-t")) return { code: 0, stdout: `${targetPaneId}\n`, stderr: "" };
				return { code: 0, stdout: "work\t0\t1\t%7\n", stderr: "" };
			}
			if (args[0] === "capture-pane") return { code: 0, stdout: "pi swarm session\nYou are reviewer\n", stderr: "" };
			if (args[0] === "send-keys") return { code: 0, stdout: "", stderr: "" };
			return { code: 1, stdout: "", stderr: "unknown tmux subcommand" };
		},
	};
	factory(pi);
};

const mkCtx = () => {
	const state = { status: null, notify: null };
	const ctx = {
		cwd: scratch,
		hasUI: true,
		mode: "tui",
		isIdle: () => true,
		ui: { notify: (m, k) => { state.notify = [m, k]; }, setStatus: (k, v) => { state.status = [k, v]; } },
	};
	return { ctx, state };
};

const resetEnv = () => { delete process.env.PI_SWARM_AGENT_ID; delete process.env.PI_SWARM_IS_ORCHESTRATOR; delete process.env.TMUX; };
const stateAgent = (id) => { try { return JSON.parse(readFileSync(join(scratch, ".pi", "swarm", "swarm-state.json"), "utf8")).agents[id]; } catch { return undefined; } };

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok  ", n); } else { fail++; console.error("  FAIL", n); } };
const throws = async (n, p) => { try { await p; fail++; console.error("  FAIL", n, "(did not throw)"); } catch { pass++; console.log("  ok  ", n); } };

console.log("\n[1] 'register here <id> [role]' adopts the identity and updates the footer");
{
	bind("%7"); resetEnv();
	process.env.TMUX = "/tmp/tmux-501/default,1234,0";
	const { ctx, state } = mkCtx();
	await swarmCmd.handler("register here reviewer Review the diff and report risks", ctx);
	ok("PI_SWARM_AGENT_ID set to reviewer", process.env.PI_SWARM_AGENT_ID === "reviewer");
	ok("footer updated to swarm:reviewer", !!state.status && state.status[0] === "swarm" && state.status[1] === "swarm:reviewer");
	ok("agent record written", !!stateAgent("reviewer"));
}

console.log("\n[2] alias '.' also adopts the identity");
{
	bind("%7"); resetEnv();
	process.env.TMUX = "/tmp/tmux-501/default,1234,0";
	const { ctx, state } = mkCtx();
	await swarmCmd.handler("register . planner Plan the work", ctx);
	ok("PI_SWARM_AGENT_ID set to planner", process.env.PI_SWARM_AGENT_ID === "planner");
	ok("footer updated to swarm:planner", !!state.status && state.status[1] === "swarm:planner");
}

console.log("\n[3] 'register here orchestrator' performs a FULL PM opt-in (not just a record)");
{
	bind("%7"); resetEnv();
	process.env.TMUX = "/tmp/tmux-501/default,1234,0";
	const { ctx, state } = mkCtx();
	await swarmCmd.handler("register here orchestrator Drive the swarm", ctx);
	ok("PI_SWARM_IS_ORCHESTRATOR=1 set", process.env.PI_SWARM_IS_ORCHESTRATOR === "1");
	ok("PI_SWARM_AGENT_ID=orchestrator set", process.env.PI_SWARM_AGENT_ID === "orchestrator");
	ok("footer updated to swarm:orchestrator", !!state.status && state.status[1] === "swarm:orchestrator");
	const orch = stateAgent("orchestrator");
	ok("mailbox-only orchestrator record exists", !!orch);
	ok("record is mailbox-only (no hijacked pane target)", orch.tmuxTarget === "unknown");
	ok("notify announces PM role", !!state.notify && /orchestrator \(PM\)/.test(String(state.notify[0])));
	stopOrchestratorPump(); // clean up the 5s interval the opt-in started
}

console.log("\n[4] explicit target that resolves to the current pane also adopts (pane-id match)");
{
	bind("%7"); resetEnv();
	process.env.TMUX = "/tmp/tmux-501/default,1234,0";
	const { ctx, state } = mkCtx();
	await swarmCmd.handler("register work:0.1 tester Run the suite", ctx);
	ok("explicit-current adopts identity", process.env.PI_SWARM_AGENT_ID === "tester");
	ok("footer updated to swarm:tester", !!state.status && state.status[1] === "swarm:tester");
}

console.log("\n[5] explicit target to a DIFFERENT pane does NOT re-identify this session");
{
	bind("%42"); resetEnv();
	process.env.TMUX = "/tmp/tmux-501/default,1234,0";
	const { ctx, state } = mkCtx();
	await swarmCmd.handler("register other:0.0 builder Build it", ctx);
	ok("identity NOT adopted for a different pane", process.env.PI_SWARM_AGENT_ID !== "builder");
	ok("footer NOT changed", !state.status || state.status[1] !== "swarm:builder");
	ok("agent record still written for the other pane", !!stateAgent("builder"));
}

console.log("\n[6] registering a DIFFERENT pane as 'orchestrator' is refused (no half-state)");
{
	bind("%42"); resetEnv(); // no TMUX -> currentPaneTarget null -> isCurrent false -> refuse
	const { ctx, state } = mkCtx();
	await swarmCmd.handler("register other:0.0 orchestrator Drive the swarm", ctx);
	ok("NOT opted in (no env)", process.env.PI_SWARM_IS_ORCHESTRATOR !== "1" && process.env.PI_SWARM_AGENT_ID !== "orchestrator");
	ok("footer NOT swarm:orchestrator", !state.status || state.status[1] !== "swarm:orchestrator");
	ok("refusal message guides to 'register here orchestrator'", !!state.notify && /register here orchestrator/.test(String(state.notify[0])));
}

console.log("\n[7] registerAgent itself refuses the reserved 'orchestrator' id (tool-path safety net)");
{
	resetEnv();
	const pi0 = { exec: async () => ({ code: 0, stdout: "", stderr: "" }) };
	const st0 = { swarmId: "x", tmuxSession: "s", agents: {}, delivered: {}, messages: {} };
	await throws("registerAgent throws on orchestrator id", registerAgent(pi0, scratch, {}, st0, { tmuxTarget: "s:0.0", id: "orchestrator", role: "pm" }));
	ok("no orchestrator agent record created", !st0.agents.orchestrator);
}

resetEnv();
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "REGISTER-ADOPT PASS" : "REGISTER-ADOPT FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
