// Auto-focus busy pi agent test suite
// Run: node extensions/swarm/tests/auto-focus.test.mjs
import { rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "..", "index.ts"));
const { default: factory, pickNextBusyAgent, maybeAutoFocusBusyAgent, focusAgentWindow, AUTO_FOCUS_COOLDOWN_MS } = mod;

let fail = 0;
const ok = (name, cond, extra) => {
	if (cond) {
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, extra || "");
	}
};

console.log("=== 1. pickNextBusyAgent heuristic test ===");
{
	const nowIso = new Date().toISOString();
	const tenSecAgo = new Date(Date.now() - 10_000).toISOString();
	const oneSecAgo = new Date(Date.now() - 1_000).toISOString();

	const state = {
		agents: {
			"worker-a": {
				id: "worker-a",
				status: "running",
				runtimeStatus: "idle",
				tmuxSession: "sess",
				tmuxWindow: "worker-a",
				tmuxTarget: "sess:worker-a.0",
			},
			"worker-b": {
				id: "worker-b",
				status: "running",
				runtimeStatus: "busy",
				lastAgentStartAt: tenSecAgo,
				activeTaskIds: [],
				tmuxSession: "sess",
				tmuxWindow: "worker-b",
				tmuxTarget: "sess:worker-b.0",
			},
			"worker-c": {
				id: "worker-c",
				status: "running",
				runtimeStatus: "tool_running",
				lastToolAt: oneSecAgo,
				activeTaskIds: ["task-1"],
				tmuxSession: "sess",
				tmuxWindow: "worker-c",
				tmuxTarget: "sess:worker-c.0",
			},
			"worker-dead": {
				id: "worker-dead",
				status: "stopped",
				runtimeStatus: "busy",
				tmuxSession: "sess",
				tmuxWindow: "worker-dead",
			},
			"worker-unknown-tmux": {
				id: "worker-unknown-tmux",
				status: "running",
				runtimeStatus: "busy",
				tmuxSession: "sess",
				tmuxWindow: "unknown",
				tmuxTarget: "unknown",
			},
			root: {
				id: "root",
				roleKind: "root",
				status: "running",
				runtimeStatus: "busy",
				lastToolAt: nowIso,
				tmuxSession: "separate-root-session",
				tmuxWindow: "root",
				tmuxTarget: "separate-root-session:root.0",
			},
			"worker-in-different-session": {
				id: "worker-in-different-session",
				status: "running",
				runtimeStatus: "busy",
				lastToolAt: nowIso,
				tmuxSession: "completely-other-session",
				tmuxWindow: "diff",
				tmuxTarget: "completely-other-session:diff.0",
			},
		},
		tmuxSession: "sess",
	};

	// 1.1 Picks worker-c because it has newer tool activity than worker-b
	const pick1 = pickNextBusyAgent(state, "worker-a");
	ok("picks worker-c over worker-b due to recent activity", pick1?.id === "worker-c", { got: pick1?.id });

	// 1.2 Excluding worker-c falls back to worker-b (never picks root or different session)
	const pick2 = pickNextBusyAgent(state, "worker-c");
	ok("falls back to worker-b and ignores root / other session", pick2?.id === "worker-b", { got: pick2?.id });

	// 1.3 Never picks stopped agent or unknown tmux target or root
	const pickNone = pickNextBusyAgent({
		agents: {
			root: state.agents.root,
			dead: state.agents["worker-dead"],
			unknown: state.agents["worker-unknown-tmux"],
			other: state.agents["worker-in-different-session"],
		},
		tmuxSession: "sess",
	});
	ok("returns null for dead, root, or other-session agents", pickNone === null, { got: pickNone });

	// 1.4 When all idle, returns null
	const allIdleState = {
		agents: {
			"worker-a": { ...state.agents["worker-a"] },
			"worker-b": { ...state.agents["worker-b"], runtimeStatus: "idle" },
		},
	};
	ok("returns null when all agents are idle", pickNextBusyAgent(allIdleState) === null);
}

console.log("\n=== 2. Slash command /swarm auto-focus test ===");
{
	const scratch = join(tmpdir(), `swarm-auto-focus-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });

	const cmds = {};
	const tmuxCalls = [];
	const fakePi = {
		registerTool: () => {},
		registerCommand: (name, opts) => {
			cmds[name] = opts;
		},
		on: () => {},
		exec: async (bin, args) => {
			tmuxCalls.push({ bin, args });
			if (args[0] === "display-message" && args.includes("#{window_active}")) {
				return { code: 0, stdout: "1\n", stderr: "" };
			}
			return { code: 0, stdout: "ok\n", stderr: "" };
		},
	};

	factory(fakePi);

	const notes = [];
	const ctx = {
		cwd: scratch,
		hasUI: true,
		ui: {
			notify: (msg, level) => notes.push({ msg, level }),
			setStatus: () => {},
		},
	};

	// Initialize swarm
	await cmds.swarm.handler("init", ctx);

	// 2.1 Default status is ENABLED
	await cmds.swarm.handler("auto-focus status", ctx);
	ok("initial status is ENABLED", notes.at(-1)?.msg?.includes("ENABLED"));

	// 2.2 Turn OFF
	await cmds.swarm.handler("auto-focus off", ctx);
	ok("/swarm auto-focus off reports DISABLED", notes.at(-1)?.msg?.includes("DISABLED"));

	// Verify state file persisted
	const st1 = JSON.parse(readFileSync(join(scratch, ".pi", "swarm", "swarm-state.json"), "utf8"));
	ok("state.json has autoFocusBusy === false", st1.autoFocusBusy === false);

	// 2.3 Turn ON
	await cmds.swarm.handler("auto-focus on", ctx);
	ok("/swarm auto-focus on reports ENABLED", notes.at(-1)?.msg?.includes("ENABLED"));

	// 2.4 /swarm focus displays current focus status
	await cmds.swarm.handler("focus", ctx);
	ok(
		"/swarm focus reports status and session",
		notes.at(-1)?.msg?.includes("Auto-focus busy pi: ENABLED") && notes.at(-1)?.msg?.includes("Worker tmux session"),
	);

	// 2.5 /swarm auto-focus with no args displays status
	await cmds.swarm.handler("auto-focus", ctx);
	ok("/swarm auto-focus with no args reports status", notes.at(-1)?.msg?.includes("Auto-focus busy pi: ENABLED"));

	// 2.6 Toggle turns it DISABLED
	await cmds.swarm.handler("auto-focus toggle", ctx);
	ok("/swarm auto-focus toggle turns it DISABLED", notes.at(-1)?.msg?.includes("DISABLED"));

	const st2 = JSON.parse(readFileSync(join(scratch, ".pi", "swarm", "swarm-state.json"), "utf8"));
	ok("state.json has autoFocusBusy === false", st2.autoFocusBusy === false);

	// 2.7 /swarm-agents alias works for both focus and auto-focus
	await cmds["swarm-agents"].handler("auto-focus on", ctx);
	ok("/swarm-agents auto-focus on enables", notes.at(-1)?.msg?.includes("ENABLED"));

	await cmds["swarm-agents"].handler("focus", ctx);
	ok("/swarm-agents focus reports status", notes.at(-1)?.msg?.includes("Auto-focus busy pi: ENABLED"));

	rmSync(scratch, { recursive: true, force: true });
}

console.log("\n=== 3. maybeAutoFocusBusyAgent lifecycle integration ===");
{
	const scratch = join(tmpdir(), `swarm-auto-focus-life-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });

	const tmuxCommands = [];
	let activeWindowFlag = "1";
	let displayMessageOutput = "worker-a\t0\t%0";

	const fakePi = {
		registerTool: () => {},
		registerCommand: () => {},
		on: () => {},
		exec: async (bin, args) => {
			tmuxCommands.push(args.join(" "));
			if (args[0] === "display-message") {
				if (args.includes("#{window_active}")) {
					return { code: 0, stdout: `${activeWindowFlag}\n`, stderr: "" };
				}
				return { code: 0, stdout: `${displayMessageOutput}\n`, stderr: "" };
			}
			return { code: 0, stdout: "%0\n", stderr: "" };
		},
	};

	const ctx = { cwd: scratch };

	// Setup initial state
	const { paths, writeState } = await import(join(here, "..", "src", "state.ts"));
	const p = paths(scratch);
	const initialSt = {
		version: 1,
		swarmId: "test-swarm",
		cwd: scratch,
		tmuxSession: "sess",
		autoFocusBusy: false,
		agents: {
			"worker-a": {
				id: "worker-a",
				role: "worker",
				roleKind: "worker",
				status: "running",
				runtimeStatus: "idle",
				tmuxSession: "sess",
				tmuxWindow: "worker-a",
				tmuxTarget: "sess:worker-a.0",
			},
			"worker-b": {
				id: "worker-b",
				role: "worker",
				roleKind: "worker",
				status: "running",
				runtimeStatus: "busy",
				lastAgentStartAt: new Date().toISOString(),
				tmuxSession: "sess",
				tmuxWindow: "worker-b",
				tmuxTarget: "sess:worker-b.0",
			},
		},
		delivered: {},
		messages: {},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	await writeState(p, initialSt);

	// 3.1 Disabled: should return { switched: false, reason: "disabled" }
	const r1 = await maybeAutoFocusBusyAgent(fakePi, ctx, "worker-a");
	ok("returns disabled when autoFocusBusy is false", r1.switched === false && r1.reason === "disabled");

	// Enable feature
	initialSt.autoFocusBusy = true;
	await writeState(p, initialSt);

	// 3.1b Root exclusion: settle on root must NEVER auto-switch
	const rRoot = await maybeAutoFocusBusyAgent(fakePi, ctx, "root");
	ok("root settling is excluded and never triggers switch", rRoot.switched === false && rRoot.reason === "root_excluded");

	// 3.2 Active window guard mismatch: user is NOT looking at worker-a
	activeWindowFlag = "0";
	delete process.env.TMUX_PANE;
	displayMessageOutput = "other-window\t5\t%99";
	const r2 = await maybeAutoFocusBusyAgent(fakePi, ctx, "worker-a");
	ok("active window guard blocks switch when user is on another window", r2.switched === false && r2.reason === "active_window_mismatch");

	// 3.3 Active window matches: should switch to worker-b!
	displayMessageOutput = "worker-a\t0\t%0";
	const r3 = await maybeAutoFocusBusyAgent(fakePi, ctx, "worker-a");
	ok("successfully switches to worker-b when active window matches", r3.switched === true && r3.targetAgentId === "worker-b");
	ok(
		"executed tmux select-window -t sess:worker-b",
		tmuxCommands.some((c) => c.includes("select-window -t sess:worker-b")),
	);

	// 3.4 Cooldown guard: immediate subsequent settle should be blocked by cooldown
	const r4 = await maybeAutoFocusBusyAgent(fakePi, ctx, "worker-a");
	ok("cooldown blocks rapid subsequent switch", r4.switched === false && r4.reason === "cooldown");

	// 3.5 Bypassing cooldown works
	const r5 = await maybeAutoFocusBusyAgent(fakePi, ctx, "worker-a", { bypassCooldown: true });
	ok("bypassCooldown allows switch", r5.switched === true && r5.targetAgentId === "worker-b");

	// 3.6 When worker-b also becomes idle, no busy agent found
	initialSt.agents["worker-b"].runtimeStatus = "idle";
	initialSt.lastFocusAt = undefined;
	await writeState(p, initialSt);

	const r6 = await maybeAutoFocusBusyAgent(fakePi, ctx, "worker-a");
	ok("returns no_busy_agent when no agents are busy", r6.switched === false && r6.reason === "no_busy_agent");

	rmSync(scratch, { recursive: true, force: true });
}

console.log("\n=== 4. Error safety test (No silent throw / durable logging) ===");
{
	const scratch = join(tmpdir(), `swarm-auto-focus-err-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });

	const failingPi = {
		exec: async () => {
			throw new Error("tmux server connection died");
		},
	};

	const agent = {
		id: "worker-x",
		status: "running",
		runtimeStatus: "busy",
		tmuxSession: "sess",
		tmuxWindow: "worker-x",
		tmuxTarget: "sess:worker-x.0",
	};

	const res = await focusAgentWindow(failingPi, agent, scratch);
	ok("focusAgentWindow does not throw on tmux failure", res.ok === false);
	ok("returns error message", res.error?.includes("tmux server connection died"));

	// Verify durable error was recorded in .pi/swarm/traces/errors.jsonl
	const errFile = join(scratch, ".pi", "swarm", "traces", "errors.jsonl");
	ok("durable error log exists", existsSync(errFile));
	if (existsSync(errFile)) {
		const content = readFileSync(errFile, "utf8");
		ok("error log contains select_window.failed", content.includes("select_window.failed"));
	}

	rmSync(scratch, { recursive: true, force: true });
}

console.log("\n=== 5. Reproduce: Busy worker auto-focus and command focus ===");
{
	const scratch = join(tmpdir(), `swarm-auto-focus-s5-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });

	const { isCurrentActiveTmuxWindow, maybeAutoFocusOnBusy, isAutoFocusEnabled } = await import(join(here, "..", "src", "focus.ts"));
	const { paths, writeState } = await import(join(here, "..", "src", "state.ts"));
	const p = paths(scratch);

	// 5.1 isCurrentActiveTmuxWindow must check agent, NOT current process TMUX_PANE
	process.env.TMUX = "1";
	process.env.TMUX_PANE = "%999"; // some unrelated pane (like root or IDE)
	const fakePi1 = {
		exec: async (bin, args) => {
			if (args[0] === "display-message" && args.includes("#{window_active}")) {
				// %999 is active in its own window
				return { code: 0, stdout: "1\n", stderr: "" };
			}
			if (args[0] === "display-message" && args.includes("#{window_name}\t#{window_index}\t#{pane_id}")) {
				// Target session active window is worker-a (index 0, pane %10)
				return { code: 0, stdout: "worker-a\t0\t%10\n", stderr: "" };
			}
			return { code: 0, stdout: "\n", stderr: "" };
		},
	};

	const agentA = { id: "worker-a", tmuxSession: "sess", tmuxWindow: "worker-a", tmuxTarget: "sess:worker-a.0" };
	const agentB = { id: "worker-b", tmuxSession: "sess", tmuxWindow: "worker-b", tmuxTarget: "sess:worker-b.0" };

	const isA = await isCurrentActiveTmuxWindow(fakePi1, "sess", agentA);
	const isB = await isCurrentActiveTmuxWindow(fakePi1, "sess", agentB);
	ok("isCurrentActiveTmuxWindow returns true for matching agentA", isA === true);
	ok("isCurrentActiveTmuxWindow returns false for non-matching agentB despite TMUX_PANE active", isB === false);

	// 5.2 isAutoFocusEnabled checks default and env var PI_SWARM_AUTO_FOCUS
	delete process.env.PI_SWARM_AUTO_FOCUS;
	ok("isAutoFocusEnabled is true by default with no env and empty state", isAutoFocusEnabled({}) === true);
	ok("isAutoFocusEnabled is false when autoFocusBusy: false", isAutoFocusEnabled({ autoFocusBusy: false }) === false);
	process.env.PI_SWARM_AUTO_FOCUS = "0";
	ok("isAutoFocusEnabled is false when PI_SWARM_AUTO_FOCUS=0", isAutoFocusEnabled({ autoFocusBusy: true }) === false);
	process.env.PI_SWARM_AUTO_FOCUS = "1";
	ok("isAutoFocusEnabled is true when PI_SWARM_AUTO_FOCUS=1", isAutoFocusEnabled({ autoFocusBusy: false }) === true);
	delete process.env.PI_SWARM_AUTO_FOCUS;

	// 5.3 maybeAutoFocusOnBusy switches to busy agent
	const tmuxCommands = [];
	const fakePi2 = {
		exec: async (bin, args) => {
			tmuxCommands.push(args.join(" "));
			return { code: 0, stdout: "\n", stderr: "" };
		},
	};

	const st = {
		version: 1,
		swarmId: "test-swarm",
		cwd: scratch,
		tmuxSession: "sess",
		autoFocusBusy: true,
		agents: {
			"worker-b": {
				id: "worker-b",
				role: "worker",
				roleKind: "worker",
				status: "running",
				runtimeStatus: "busy",
				tmuxSession: "sess",
				tmuxWindow: "worker-b",
				tmuxTarget: "sess:worker-b.0",
			},
		},
		delivered: {},
		messages: {},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	await writeState(p, st);

	const rBusy = await maybeAutoFocusOnBusy(fakePi2, { cwd: scratch }, "worker-b");
	ok("maybeAutoFocusOnBusy switches to newly busy worker-b", rBusy.switched === true && rBusy.targetAgentId === "worker-b");
	ok(
		"executed tmux select-window -t sess:worker-b on busy",
		tmuxCommands.some((c) => c.includes("select-window -t sess:worker-b")),
	);

	// 5.4 /swarm focus <agentId> and /swarm focus (busy)
	const notes = [];
	const ctx = {
		cwd: scratch,
		ui: {
			notify: (msg, level) => notes.push({ msg, level }),
		},
	};
	const cmds = {};
	const fakePi3 = {
		registerTool: () => {},
		registerCommand: (name, opts) => {
			cmds[name] = opts;
		},
		exec: async (bin, args) => {
			tmuxCommands.push(args.join(" "));
			if (args[0] === "display-message" && args.includes("#{window_index}\t#{window_name}\t#{pane_id}")) {
				return { code: 0, stdout: "0\tworker-b\t%10\n", stderr: "" };
			}
			return { code: 0, stdout: "\n", stderr: "" };
		},
		on: () => {},
	};
	factory(fakePi3);

	// Focus explicit agent
	await cmds["swarm"].handler("focus worker-b", ctx);
	ok(
		"/swarm focus worker-b executes select-window",
		tmuxCommands.some((c) => c.includes("select-window -t sess:worker-b")),
	);
	ok("/swarm focus worker-b notifies user", notes.at(-1)?.msg?.includes("worker-b"));

	// Focus busy agent with bare /swarm focus
	await cmds["swarm"].handler("focus", ctx);
	ok("/swarm focus focuses to busy agent", notes.at(-1)?.msg?.includes("worker-b"));

	rmSync(scratch, { recursive: true, force: true });
}

if (fail > 0) {
	console.error(`\nFAILED: ${fail} assertions failed.`);
	process.exit(1);
} else {
	console.log(`\nALL AUTO-FOCUS TESTS PASSED.`);
}
