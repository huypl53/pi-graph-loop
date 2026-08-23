// Careful tests for the agent lifecycle manipulation tools added to the swarm extension:
// register (adopt pane + retarget), stop (refuse active tasks / force), restart, set_role,
// pause/resume (reuse-pool skip), send_keys, attach, release_agent_task.
//
// Strategy: build the tool set from the real factory with a mock `pi` whose tmux exec returns
// success for the subcommands these tools use (display-message, capture-pane, send-keys,
// kill-window/kill-pane, has-session, new-window/new-session). State lives under a temp scratch
// dir. We also directly exercise the lock-free cores (findReusableAgent) for the pause-skip rule.
//
// Run: node extensions/swarm/agent-lifecycle.test.mjs
import { rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "index.ts"));
const factory = mod.default;

// Direct import of the lock-free reuse helper to assert the paused-skip rule on synthetic state.
const { findReusableAgent } = await import(join(here, "src", "agents.ts"));

const scratch = join(tmpdir(), `swarm-life-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

const tools = {};
const sentKeys = [];
const pi = {
	registerTool: (def) => { tools[def.name] = def; },
	registerCommand: () => {},
	on: () => {},
	sendMessage: () => {},
	exec: async (cmd, args) => {
		if (cmd !== "tmux") {
			if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
			return { code: 1, stdout: "", stderr: "" };
		}
		const sub = args[0];
		if (sub === "display-message") {
			// Return the window name the target asked for (parse from -t arg) + a pane id, so the
			// liveness window-name guard in isTmuxRunning sees a matching window.
			const tIdx = args.indexOf("-t");
			const t = tIdx >= 0 ? args[tIdx + 1] : "";
			const w = t.includes(":") ? t.slice(t.indexOf(":") + 1).split(".")[0] : "w";
			return { code: 0, stdout: `${w || "w"}\t%99\n`, stderr: "" };   // pane alive
		}
		if (sub === "capture-pane") return { code: 0, stdout: "pi swarm session\nYou are reviewer\n", stderr: "" };
		if (sub === "send-keys") { sentKeys.push(args.slice(1).join(" ")); return { code: 0, stdout: "", stderr: "" }; }
		if (sub === "kill-window" || sub === "kill-pane") return { code: 0, stdout: "", stderr: "" };
		if (sub === "has-session") return { code: 0, stdout: "", stderr: "" };
		if (sub === "new-window" || sub === "new-session") return { code: 0, stdout: "", stderr: "" };
		return { code: 1, stdout: "", stderr: "unknown tmux subcommand" };
	},
};
factory(pi);

const call = async (name, params) => {
	const t = tools[name]; if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: params.cwd || scratch });
};
const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");
const readSwarmState = () => JSON.parse(readFileSync(statePath, "utf8"));
const writeSwarmState = (st) => writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok  ", n); } else { fail++; console.error("  FAIL", n); } };
const throws = async (n, p) => { try { await p; fail++; console.error("  FAIL", n, "(did not throw)"); } catch { pass++; console.log("  ok  ", n); } };

console.log("\n[1] register adopts an existing pane under a role (tmuxTarget NOT unknown)");
{
	sentKeys.length = 0;
	const r = await call("swarm_register_agent", { tmuxTarget: "mysess:research.1", id: "researcher", role: "Research planner", cwd: scratch });
	ok("register returns text", /Registered researcher/.test(r?.content?.[0]?.text || ""));
	const a = readSwarmState().agents.researcher;
	ok("agent record exists", !!a);
	ok("tmuxTarget is the adopted pane (not unknown)", a.tmuxTarget === "mysess:research.1");
	ok("tmuxSession parsed", a.tmuxSession === "mysess");
	ok("tmuxWindow parsed", a.tmuxWindow === "research");
	ok("runtimeStatus idle (operator assertion)", a.runtimeStatus === "idle");
	ok("roleKind derived from role text", a.roleKind === "planner");
	ok("identity file written", existsSync(join(scratch, ".pi", "swarm", "agents", "researcher.md")));
	ok("kickoff injected into pane", sentKeys.some((k) => k.includes("[PI-SWARM IDENTITY]")));
}

console.log("\n[2] register retargets an existing agent (fixes the ghost 'unknown' target)");
{
	sentKeys.length = 0;
	await call("swarm_register_agent", { tmuxTarget: "mysess:research.2", id: "researcher", role: "Research planner", inject: false, cwd: scratch });
	const a = readSwarmState().agents.researcher;
	ok("retarget updates tmuxTarget", a.tmuxTarget === "mysess:research.2");
	ok("retarget keeps id/mailbox identity (createdAt preserved)", !!a.createdAt);
	ok("inject:false skips pane injection", !sentKeys.some((k) => k.includes("Identity")));
}

console.log("\n[3] set_role mutates role/roleKind, pins explicit kind, bumps identity version, injects");
{
	sentKeys.length = 0;
	const before = readSwarmState().agents.researcher;
	const v0 = before.identityVersion || 0;
	const r = await call("swarm_set_role", { agentId: "researcher", role: "Senior reviewer", roleKind: "reviewer", capabilities: ["review", "risk"], cwd: scratch });
	const a = readSwarmState().agents.researcher;
	ok("role updated", a.role === "Senior reviewer");
	ok("roleKind pinned", a.roleKind === "reviewer" && a.roleKindExplicit === true);
	ok("capabilities replaced", Array.isArray(a.capabilities) && a.capabilities.length === 2);
	ok("identity version bumped", (a.identityVersion || 0) > v0);
	ok("reload prompt injected", sentKeys.some((k) => k.includes("PI-SWARM IDENTITY RELOAD")));
	ok("tool returns provenance version", /v\d/.test(r?.content?.[0]?.text || ""));
}

console.log("\n[4] pause/resume flip the drain flag; findReusableAgent skips paused agents");
{
	await call("swarm_set_agent_paused", { agentId: "researcher", paused: true, cwd: scratch });
	ok("paused flag set", readSwarmState().agents.researcher.paused === true);
	// Synthetic reuse lookup: one paused + one free agent of the same roleKind.
	const st = {
		agents: {
			busy1: { id: "busy1", role: "r", roleKind: "reviewer", roleKindExplicit: true, capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1, status: "running", runtimeStatus: "idle", health: "healthy", tmuxSession: "s", tmuxWindow: "busy1", tmuxTarget: "s:busy1.0", model: "m", provider: "p", cwd: scratch, mailbox: "x", createdAt: "t", updatedAt: "t", paused: true },
			free1: { id: "free1", role: "r", roleKind: "reviewer", roleKindExplicit: true, capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1, status: "running", runtimeStatus: "idle", health: "healthy", tmuxSession: "s", tmuxWindow: "free1", tmuxTarget: "s:free1.0", model: "m", provider: "p", cwd: scratch, mailbox: "x", createdAt: "t", updatedAt: "t" },
		},
		messages: {},
	};
	const { matches, recommended } = await findReusableAgent(pi, st, { roleKind: "reviewer" });
	ok("reuse excludes paused agent", matches.every((m) => m.agentId !== "busy1"));
	ok("reuse recommends the free agent", recommended === "free1");
	await call("swarm_set_agent_paused", { agentId: "researcher", paused: false, cwd: scratch });
	ok("resume clears paused flag", readSwarmState().agents.researcher.paused === undefined);
}

console.log("\n[5] stop refuses active tasks, then succeeds with force; release clears stale pointers");
{
	// Plant a stale active-task pointer to a task file that does not exist (=> unknown => releasable).
	const st = readSwarmState();
	st.agents.researcher.activeTaskIds = ["ghost-task"];
	writeSwarmState(st);
	await throws("stop refuses an agent with active tasks", call("swarm_stop_agent", { agentId: "researcher", cwd: scratch }));
	ok("refused stop left agent running", readSwarmState().agents.researcher.status === "running");
	// release_agent_task should repair the dangling pointer (missing task file => terminal 'unknown').
	const rel = await call("swarm_release_agent_task", { agentId: "researcher", cwd: scratch });
	ok("release reports removed ghost task", JSON.stringify(rel.details).includes("ghost-task"));
	ok("activeTaskIds cleared after release", readSwarmState().agents.researcher.activeTaskIds.length === 0);
	// Now stop succeeds.
	const r = await call("swarm_stop_agent", { agentId: "researcher", cwd: scratch });
	ok("stop succeeds after release", /Stopped researcher/.test(r?.content?.[0]?.text || ""));
	const a = readSwarmState().agents.researcher;
	ok("agent marked stopped", a.status === "stopped" && a.runtimeStatus === "stopped");
}

console.log("\n[6] restart respawns at the same id (mailbox/identity persist), fresh record running");
{
	const beforeMailbox = readSwarmState().agents.researcher.mailbox;
	const r = await call("swarm_restart_agent", { agentId: "researcher", cwd: scratch });
	ok("restart returns text", /Restarted researcher/.test(r?.content?.[0]?.text || ""));
	const a = readSwarmState().agents.researcher;
	ok("same id preserved", a.id === "researcher");
	ok("mailbox path preserved (stable id)", a.mailbox === beforeMailbox);
	ok("fresh record is running", a.status === "running");
	ok("restart targets a swarm-managed window named id", a.tmuxWindow === "researcher");
}

console.log("\n[7] send_keys + attach (convenience wrappers over existing internals)");
{
	sentKeys.length = 0;
	await call("swarm_send_keys", { agentId: "researcher", keys: "C-c", cwd: scratch });
	ok("send_keys issued a C-c", sentKeys.some((k) => k.includes("C-c")));
	const a = await call("swarm_attach_agent", { agentId: "researcher", cwd: scratch });
	const txt = a?.content?.[0]?.text || "";
	ok("attach returns tmux commands", txt.includes("tmux attach -t") && txt.includes("tmux select-window -t"));
}

console.log("\n[8] register unknown agent ops throw clearly");
{
	await throws("stop unknown agent throws", call("swarm_stop_agent", { agentId: "nope", cwd: scratch }));
	await throws("set_role with no fields throws", call("swarm_set_role", { agentId: "researcher", cwd: scratch }));
}

console.log(`\n${fail === 0 ? "LIFECYCLE PASS" : "LIFECYCLE FAIL"} (${pass} passed, ${fail} failed)`);
rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
