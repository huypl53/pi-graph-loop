// Tests for `/swarm register` identity adoption + root opt-in:
//  - 'here <id>' adopts the identity in-process (env + footer) for a normal agent
//  - 'here root' performs a FULL PM opt-in (env + mailbox-only record + pump + footer)
//  - registering a DIFFERENT pane as root is refused
//  - registerAgent itself refuses the reserved 'root' id (safety net for the tool path)
//
// Run: node extensions/swarm/register-adopt.test.mjs
import { rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;
const { registerAgent } = await import(join(here, "..", "src", "agents.ts"));
const { stopRootPump } = await import(join(here, "..", "src", "hooks.ts"));

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

const resetEnv = () => { delete process.env.PI_SWARM_AGENT_ID; delete process.env.PI_SWARM_IS_ROOT; delete process.env.TMUX; };
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

console.log("\n[3] 'register here root' performs a FULL PM opt-in (not just a record)");
{
	bind("%7"); resetEnv();
	process.env.TMUX = "/tmp/tmux-501/default,1234,0";
	const { ctx, state } = mkCtx();
	await swarmCmd.handler("register here root Drive the swarm", ctx);
	ok("PI_SWARM_IS_ROOT=1 set", process.env.PI_SWARM_IS_ROOT === "1");
	ok("PI_SWARM_AGENT_ID=root set", process.env.PI_SWARM_AGENT_ID === "root");
	ok("footer updated to swarm:root", !!state.status && state.status[1] === "swarm:root");
	const orch = stateAgent("root");
	ok("mailbox-only root record exists", !!orch);
	ok("record is mailbox-only (no hijacked pane target)", orch.tmuxTarget === "unknown");
	ok("notify announces PM role", !!state.notify && /root \(PM\)/.test(String(state.notify[0])));
	stopRootPump(); // clean up the 5s interval the opt-in started
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

console.log("\n[6] registering a DIFFERENT pane as 'root' is refused (no half-state)");
{
	bind("%42"); resetEnv(); // no TMUX -> currentPaneTarget null -> isCurrent false -> refuse
	const { ctx, state } = mkCtx();
	await swarmCmd.handler("register other:0.0 root Drive the swarm", ctx);
	ok("NOT opted in (no env)", process.env.PI_SWARM_IS_ROOT !== "1" && process.env.PI_SWARM_AGENT_ID !== "root");
	ok("footer NOT swarm:root", !state.status || state.status[1] !== "swarm:root");
	ok("refusal message guides to 'register here root'", !!state.notify && /register here root/.test(String(state.notify[0])));
}

console.log("\n[7] registerAgent itself refuses the reserved 'root' id (tool-path safety net)");
{
	resetEnv();
	const pi0 = { exec: async () => ({ code: 0, stdout: "", stderr: "" }) };
	const st0 = { swarmId: "x", tmuxSession: "s", agents: {}, delivered: {}, messages: {} };
	await throws("registerAgent throws on root id", registerAgent(pi0, scratch, {}, st0, { tmuxTarget: "s:0.0", id: "root", role: "pm" }));
	ok("no root agent record created", !st0.agents.root);
}

console.log("\n[8] ensureRoot self-heals a 'misled' root record (real pane target -> mailbox-only)");
{
	bind("%7"); resetEnv();
	process.env.TMUX = "/tmp/tmux-501/default,1234,0";
	const stateFile = join(scratch, ".pi", "swarm", "swarm-state.json");
	mkdirSync(join(scratch, ".pi", "swarm", "mailboxes"), { recursive: true });
	// pre-seed a MISLED root record attached to a real tmux pane (the ship-crawl bug shape)
	writeFileSync(stateFile, JSON.stringify({
		version: 1, swarmId: "swarm-test", cwd: scratch, tmuxSession: "pi-swarm-x",
		agents: { root: { id: "root", role: "misled pm", roleKind: "root", status: "running", runtimeStatus: "idle", health: "healthy", tmuxTarget: "pi-swarm-x:3.0", tmuxSession: "pi-swarm-x", tmuxWindow: "3", mailbox: ".pi/swarm/mailboxes/root.jsonl", maxConcurrentTasks: 1, cwd: scratch, createdAt: "t", updatedAt: "t", lastHeartbeatAt: "t", capabilities: [], activeTaskIds: [] } },
		delivered: {}, messages: {}, createdAt: "t", updatedAt: "t",
	}, null, 2));
	ok("pre-seed: root misled to a real pane target", stateAgent("root")?.tmuxTarget === "pi-swarm-x:3.0");
	const { ctx } = mkCtx();
	await swarmCmd.handler("register here root Drive the swarm", ctx);
	const healed = stateAgent("root");
	ok("self-healed: tmuxTarget reset to 'unknown' (mailbox-only)", healed?.tmuxTarget === "unknown");
	ok("self-healed: roleKind re-normalized to root", healed?.roleKind === "root");
	ok("self-healed: tmuxWindow re-normalized to root", healed?.tmuxWindow === "root");
}

resetEnv();
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "REGISTER-ADOPT PASS" : "REGISTER-ADOPT FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
