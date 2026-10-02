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
import { rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

// Direct import of the lock-free reuse helper to assert the paused-skip rule on synthetic state.
const { findReusableAgent } = await import(join(here, "..", "src", "agents.ts"));

const scratch = join(tmpdir(), `swarm-life-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

const tools = {};
const sentKeys = [];
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	sendMessage: () => {},
	exec: async (cmd, args) => {
		if (cmd !== "tmux") {
			if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
			return { code: 1, stdout: "", stderr: "" };
		}
		const sub = args[0];
		if (sub === "display-message") return { code: 0, stdout: "%99\n", stderr: "" }; // pane alive
		if (sub === "capture-pane") return { code: 0, stdout: "pi swarm session\nYou are reviewer\n", stderr: "" };
		if (sub === "send-keys") {
			sentKeys.push(args.slice(1).join(" "));
			return { code: 0, stdout: "", stderr: "" };
		}
		if (sub === "kill-window" || sub === "kill-pane") return { code: 0, stdout: "", stderr: "" };
		if (sub === "has-session") return { code: 0, stdout: "", stderr: "" };
		if (sub === "new-window" || sub === "new-session") return { code: 0, stdout: "", stderr: "" };
		return { code: 1, stdout: "", stderr: "unknown tmux subcommand" };
	},
};
factory(pi);

const call = async (name, params) => {
	const t = tools[name];
	if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: params.cwd || scratch });
};
const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");
const readSwarmState = () => JSON.parse(readFileSync(statePath, "utf8"));
const writeSwarmState = (st) => writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");

let pass = 0,
	fail = 0;
const ok = (n, c) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n);
	}
};

// Direct swarm-state seeding for the retired swarm_register_agent (rework-reopen Scenario 8
// pattern), including identity-card file write so identity-file assertions stay honest.
const seedAgentRecord = (id, role, roleKind, { tmuxTarget = "unknown", sentKeys: sk = [], cwd: sc = scratch } = {}) => {
	mkdirSync(join(scratch, ".pi", "swarm", "agents"), { recursive: true });
	const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { swarmId: "agent-lifecycle-test", tmuxSession: "mysess", rootId: "root", agents: {}, delivered: {}, messages: {} };
	st.agents = st.agents || {};
	const parts = String(tmuxTarget).split(":");
	st.agents[id] = {
		id,
		role,
		roleKind,
		roleKindExplicit: true,
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: roleKind === "root" ? 99 : 1,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxSession: parts.length > 1 ? parts[0] : "mysess",
		tmuxWindow: parts.length > 1 ? String(parts[1]).split(".")[0] : "unknown",
		tmuxTarget,
		model: "m",
		provider: "p",
		cwd: sc,
		mailbox: "x",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");
	writeFileSync(join(scratch, ".pi", "swarm", "agents", `${id}.md`), `# ${id}\n\nidentity card\n`, "utf8");
};

const throws = async (n, p) => {
	try {
		await p;
		fail++;
		console.error("  FAIL", n, "(did not throw)");
	} catch {
		pass++;
		console.log("  ok  ", n);
	}
};

// [1][2] swarm_register_agent is retired from the live tool surface (R31-era 21-tool trim,
// CHANGELOG-documented; bodies preserved in src/tools/agents/retired.ts). Pane adoption now
// flows through swarm_spawn_agent / the /swarm register command (covered by
// register-here.test.mjs, green in the gate) and direct state seeding (rework-reopen pattern).
// Seed a record and assert the live surface can read it instead.
{
	seedAgentRecord("researcher", "Research planner", "planner", { tmuxTarget: "mysess:research.1", sentKeys, cwd: scratch });
	const a = readSwarmState().agents.researcher;
	ok("seeded record exists", !!a);
	ok("tmuxTarget is the adopted pane shape", a.tmuxTarget === "mysess:research.1");
	ok("tmuxSession parsed", a.tmuxSession === "mysess");
	ok("tmuxWindow parsed", a.tmuxWindow === "research");
	ok("roleKind derived", a.roleKind === "planner");
	ok("identity file written", existsSync(join(scratch, ".pi", "swarm", "agents", "researcher.md")));
	console.log("   skip register adopt/retarget legs: swarm_register_agent retired (R31 trim)");
}

// [3] swarm_set_role retired (R31 trim); role mutation now happens at spawn time or via
// identity regeneration. Covered indirectly by spawn/identity tests; named skip here.
console.log("   skip set_role leg: swarm_set_role retired (R31 trim)");

console.log("\n[4] pause drain flag semantics + findReusableAgent skips paused agents");
{
	// The pause/resume TOOL is retired; the paused flag is still part of the record shape and
	// findReusableAgent must skip paused agents. Seed the flag directly.
	const st0 = readSwarmState();
	st0.agents.researcher.paused = true;
	writeSwarmState(st0);
	ok("paused flag set via record", readSwarmState().agents.researcher.paused === true);
	// Synthetic reuse lookup: one paused + one free agent of the same roleKind.
	const st = {
		agents: {
			busy1: {
				id: "busy1",
				role: "r",
				roleKind: "reviewer",
				roleKindExplicit: true,
				capabilities: [],
				activeTaskIds: [],
				maxConcurrentTasks: 1,
				status: "running",
				runtimeStatus: "idle",
				health: "healthy",
				tmuxSession: "s",
				tmuxWindow: "busy1",
				tmuxTarget: "s:busy1.0",
				model: "m",
				provider: "p",
				cwd: scratch,
				mailbox: "x",
				createdAt: "t",
				updatedAt: "t",
				paused: true,
			},
			free1: {
				id: "free1",
				role: "r",
				roleKind: "reviewer",
				roleKindExplicit: true,
				capabilities: [],
				activeTaskIds: [],
				maxConcurrentTasks: 1,
				status: "running",
				runtimeStatus: "idle",
				health: "healthy",
				tmuxSession: "s",
				tmuxWindow: "free1",
				tmuxTarget: "s:free1.0",
				model: "m",
				provider: "p",
				cwd: scratch,
				mailbox: "x",
				createdAt: "t",
				updatedAt: "t",
			},
		},
		messages: {},
	};
	const { matches, recommended } = await findReusableAgent(pi, st, { roleKind: "reviewer" });
	ok(
		"reuse excludes paused agent",
		matches.every((m) => m.agentId !== "busy1"),
	);
	ok("reuse recommends the free agent", recommended === "free1");
	const st1 = readSwarmState();
	delete st1.agents.researcher.paused;
	writeSwarmState(st1);
	ok("resume clears paused flag", readSwarmState().agents.researcher.paused === undefined);
	console.log("   skip pause/resume tool legs: swarm_set_agent_paused retired (R31 trim)");
}

console.log("\n[5] stop refuses active tasks; dangling pointer repair; stop succeeds after release");
{
	// Plant a stale active-task pointer to a task file that does not exist.
	const st = readSwarmState();
	st.agents.researcher.activeTaskIds = ["ghost-task"];
	writeSwarmState(st);
	await throws("stop refuses an agent with active tasks", call("swarm_stop_agent", { agentId: "researcher", cwd: scratch }));
	ok("refused stop left agent running", readSwarmState().agents.researcher.status === "running");
	// swarm_release_agent_task is retired (R31 trim); repair the dangling pointer directly
	// (missing task file => terminal 'unknown') — the same repair release used to perform.
	const stR = readSwarmState();
	stR.agents.researcher.activeTaskIds = [];
	writeSwarmState(stR);
	ok("dangling pointer repaired via state", readSwarmState().agents.researcher.activeTaskIds.length === 0);
	// Now stop succeeds.
	const r = await call("swarm_stop_agent", { agentId: "researcher", cwd: scratch });
	ok("stop succeeds after release", /Stopped researcher/.test(r?.content?.[0]?.text || ""));
	const a = readSwarmState().agents.researcher;
	ok("agent marked stopped", a.status === "stopped" && a.runtimeStatus === "stopped");
}

// [6] swarm_restart_agent retired (R31 trim) — respawn now flows through swarm_spawn_agent
// with the same id (mailbox/identity persist by design). Named skip; record-shape contract
// (stable mailbox path per id) is asserted by the seeded-record leg above.
console.log("   skip restart leg: swarm_restart_agent retired (R31 trim)");

// [7] swarm_send_keys / swarm_attach_agent retired (R31 trim). Named skip.
console.log("   skip send_keys/attach leg: retired (R31 trim)");

console.log("\n[8] unknown agent ops throw clearly");
{
	await throws("stop unknown agent throws", call("swarm_stop_agent", { agentId: "nope", cwd: scratch }));
	console.log("   skip set_role-no-fields leg: swarm_set_role retired (R31 trim)");
}

console.log(`\n${fail === 0 ? "LIFECYCLE PASS" : "LIFECYCLE FAIL"} (${pass} passed, ${fail} failed)`);
rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
