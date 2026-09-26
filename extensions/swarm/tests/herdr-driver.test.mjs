import { ok as assertOk, equal, deepEqual } from "node:assert/strict";
import {
	HerdrDriver,
	herdrDriver,
	tmuxDriver,
	getTerminalDriver,
	translateTmuxKeyToHerdr,
	isPiLikeProcess,
} from "../src/terminal/index.ts";
import { checkTmuxSession, checkTerminalSession } from "../src/pool.ts";

let pass = 0;
let fail = 0;

function test(name, fn) {
	try {
		fn();
		pass++;
		console.log(`  ok   ${name}`);
	} catch (err) {
		fail++;
		console.error(`  FAIL ${name}:`, err);
	}
}

async function asyncTest(name, fn) {
	try {
		await fn();
		pass++;
		console.log(`  ok   ${name}`);
	} catch (err) {
		fail++;
		console.error(`  FAIL ${name}:`, err);
	}
}

console.log("=== HerdrDriver Basic & Key Translation Tests ===");

test("HerdrDriver id is 'herdr'", () => {
	const driver = new HerdrDriver();
	equal(driver.id, "herdr");
});

test("Key translation maps tmux tokens to Herdr tokens", () => {
	equal(translateTmuxKeyToHerdr("C-c"), "ctrl+c");
	equal(translateTmuxKeyToHerdr("c-c"), "ctrl+c");
	equal(translateTmuxKeyToHerdr("^c"), "ctrl+c");
	equal(translateTmuxKeyToHerdr("Escape"), "esc");
	equal(translateTmuxKeyToHerdr("esc"), "esc");
	equal(translateTmuxKeyToHerdr("Enter"), "enter");
	equal(translateTmuxKeyToHerdr("return"), "enter");
	equal(translateTmuxKeyToHerdr("C-d"), "ctrl+d");
	equal(translateTmuxKeyToHerdr("C-z"), "ctrl+z");
	equal(translateTmuxKeyToHerdr("Tab"), "tab");
	equal(translateTmuxKeyToHerdr("Space"), "space");
	equal(translateTmuxKeyToHerdr("Backspace"), "backspace");
	equal(translateTmuxKeyToHerdr("Up"), "up");
	equal(translateTmuxKeyToHerdr("Down"), "down");
	equal(translateTmuxKeyToHerdr("Left"), "left");
	equal(translateTmuxKeyToHerdr("Right"), "right");
	equal(translateTmuxKeyToHerdr("C-a"), "ctrl+a");
	equal(translateTmuxKeyToHerdr("M-x"), "alt+x");
});

console.log("\n=== Foreground Process Inspection Tests ===");

test("isPiLikeProcess detects node/pi/bun vs shells", () => {
	assertOk(isPiLikeProcess("node"));
	assertOk(isPiLikeProcess("pi"));
	assertOk(isPiLikeProcess("bun"));
	assertOk(isPiLikeProcess("/usr/local/bin/node"));
	assertOk(isPiLikeProcess("/opt/homebrew/bin/pi"));
	assertOk(!isPiLikeProcess("bash"));
	assertOk(!isPiLikeProcess("zsh"));
	assertOk(!isPiLikeProcess("-zsh"));
	assertOk(!isPiLikeProcess("sh"));
	assertOk(!isPiLikeProcess("python"));
	assertOk(!isPiLikeProcess(""));
});

console.log("\n=== HerdrDriver CLI Mock Tests ===");

function createMockPi() {
	const calls = [];
	const state = {
		panes: [
			{
				pane_id: "w1:p1",
				tab_id: "w1:t1",
				workspace_id: "w1",
				command: "node",
				title: "worker-1",
				active: true,
			},
		],
		processInfo: {
			"w1:p1": { command: "node", pid: 12345 },
			"w1:p2": { command: "bash", pid: 12346 }, // shell prompt: dead pi process
		},
		readOutput: "Line 1: agent initialized\nLine 2: working on task\n",
	};

	const exec = async (cmd, args, opts) => {
		calls.push({ cmd, args, opts });
		if (cmd !== "herdr") {
			return { code: 1, stdout: "", stderr: `unknown command: ${cmd}` };
		}

		const sub = args[0];
		const action = args[1];

		if (sub === "--version") {
			return { code: 0, stdout: "herdr 0.4.0\n", stderr: "" };
		}

		if (sub === "tab" && action === "create") {
			return {
				code: 0,
				stdout: JSON.stringify({
					result: {
						tab: { tab_id: "w1:t2", workspace_id: "w1" },
						root_pane: { pane_id: "w1:p3" },
					},
				}),
				stderr: "",
			};
		}

		if (sub === "pane" && action === "list") {
			return {
				code: 0,
				stdout: JSON.stringify({
					result: {
						panes: state.panes,
					},
				}),
				stderr: "",
			};
		}

		if (sub === "pane" && action === "process-info") {
			const paneIdx = args.indexOf("--pane");
			const paneId = paneIdx !== -1 ? args[paneIdx + 1] : args[2];
			const proc = state.processInfo[paneId] || { command: "", pid: undefined };
			return {
				code: 0,
				stdout: JSON.stringify({
					result: {
						process: proc,
					},
				}),
				stderr: "",
			};
		}

		if (sub === "pane" && action === "send-text") {
			return { code: 0, stdout: JSON.stringify({ result: { status: "ok" } }), stderr: "" };
		}

		if (sub === "pane" && action === "send-keys") {
			return { code: 0, stdout: JSON.stringify({ result: { status: "ok" } }), stderr: "" };
		}

		if (sub === "pane" && action === "read") {
			return {
				code: 0,
				stdout: JSON.stringify({
					result: {
						text: state.readOutput,
					},
				}),
				stderr: "",
			};
		}

		if (sub === "tab" && action === "focus") {
			return { code: 0, stdout: JSON.stringify({ result: { status: "ok" } }), stderr: "" };
		}

		if (sub === "pane" && action === "close") {
			return { code: 0, stdout: JSON.stringify({ result: { status: "ok" } }), stderr: "" };
		}

		return { code: 0, stdout: "{}", stderr: "" };
	};

	return { exec, calls, state };
}

await asyncTest("isAvailable checks herdr binary version", async () => {
	const mockPi = createMockPi();
	const driver = new HerdrDriver();
	const available = await driver.isAvailable(mockPi);
	assertOk(available);
	equal(mockPi.calls[0].args[0], "--version");
});

await asyncTest("spawnAgent creates tab with workspace confinement, isolated env (herdr 0.8.2 two-step contract)", async () => {
	const mockPi = createMockPi();
	const driver = new HerdrDriver("w1");
	const res = await driver.spawnAgent(mockPi, {
		session: "w1",
		window: "worker-test",
		command: "pi --agent worker",
		cwd: "/test/workspace",
	});

	equal(res.session, "w1");
	equal(res.window, "w1:t2");
	equal(res.target, "w1:p3");

	// Step 1: `tab create` is options-only — no positional command on 0.8.2.
	const spawnCall = mockPi.calls.find((c) => c.args[0] === "tab" && c.args[1] === "create");
	assertOk(spawnCall, "spawnCall must exist");
	assertOk(spawnCall.args.includes("--workspace"));
	assertOk(spawnCall.args.includes("w1"));
	assertOk(spawnCall.args.includes("--env"));
	assertOk(spawnCall.args.includes("PI_SWARM_AGENT_ID=worker-test"));
	assertOk(spawnCall.args.includes("PI_SWARM_IS_ROOT=0"));
	// 0.8.2 contract: tab create MUST NOT carry the launch command as a positional.
	const lastArg = spawnCall.args[spawnCall.args.length - 1];
	assertOk(lastArg.startsWith("--") || lastArg.includes("="), `tab create must be options-only; last arg was: ${lastArg}`);

	// Step 2: `pane run` launches the command in the root pane parsed from step 1.
	const paneRunCall = mockPi.calls.find((c) => c.args[0] === "pane" && c.args[1] === "run");
	assertOk(paneRunCall, "paneRunCall must exist");
	equal(paneRunCall.args[2], "w1:p3", "pane run must target the root pane from tab create");
	assertOk(paneRunCall.args.includes("sh"), "pane run wraps the command in sh -c");
	assertOk(paneRunCall.args.includes("-c"), "pane run uses sh -c");
	assertOk(paneRunCall.args.includes("pi --agent worker"), "pane run carries the launch command");
});

await asyncTest("listPanes queries panes scoped to workspace", async () => {
	const mockPi = createMockPi();
	const driver = new HerdrDriver("w1");
	const panes = await driver.listPanes(mockPi);

	equal(panes.length, 1);
	equal(panes[0].target, "w1:p1");
	equal(panes[0].command, "node");

	const listCall = mockPi.calls.find((c) => c.args[0] === "pane" && c.args[1] === "list");
	assertOk(listCall, "listCall must exist");
	assertOk(listCall.args.includes("--workspace"));
	assertOk(listCall.args.includes("w1"));
});

await asyncTest("isTargetAlive inspects foreground process (pi-like vs shell prompt)", async () => {
	const mockPi = createMockPi();
	const driver = new HerdrDriver("w1");

	// w1:p1 is node -> alive
	const aliveNode = await driver.isTargetAlive(mockPi, "w1:p1");
	assertOk(aliveNode, "node process should be detected as alive");

	// w1:p2 is bash -> dead (ghost agent at shell prompt)
	const aliveBash = await driver.isTargetAlive(mockPi, "w1:p2");
	assertOk(!aliveBash, "bash shell prompt should be detected as dead (not pi-like)");

	const procInfo = await driver.inspectProcess(mockPi, "w1:p1");
	assertOk(procInfo.piLike);
	equal(procInfo.command, "node");
	equal(procInfo.pid, 12345);
});

await asyncTest("sendText sends text followed by enter", async () => {
	const mockPi = createMockPi();
	const driver = new HerdrDriver("w1");
	await driver.sendText(mockPi, "w1:p1", "test input");

	const sendTextCall = mockPi.calls.find((c) => c.args[0] === "pane" && c.args[1] === "send-text");
	assertOk(sendTextCall);
	equal(sendTextCall.args[2], "w1:p1");
	equal(sendTextCall.args[3], "test input");

	const sendKeysCall = mockPi.calls.find((c) => c.args[0] === "pane" && c.args[1] === "send-keys");
	assertOk(sendKeysCall);
	equal(sendKeysCall.args[2], "w1:p1");
	equal(sendKeysCall.args[3], "enter");
});

await asyncTest("sendKeys translates tmux keys before invoking herdr", async () => {
	const mockPi = createMockPi();
	const driver = new HerdrDriver("w1");
	await driver.sendKeys(mockPi, "w1:p1", "C-c");

	const call = mockPi.calls.find((c) => c.args[0] === "pane" && c.args[1] === "send-keys");
	assertOk(call);
	equal(call.args[2], "w1:p1");
	equal(call.args[3], "ctrl+c");
});

await asyncTest("capturePane reads scrollback via recent-unwrapped source", async () => {
	const mockPi = createMockPi();
	const driver = new HerdrDriver("w1");
	const output = await driver.capturePane(mockPi, "w1:p1", 100);

	assertOk(output.includes("Line 1: agent initialized"));
	const readCall = mockPi.calls.find((c) => c.args[0] === "pane" && c.args[1] === "read");
	assertOk(readCall);
	assertOk(readCall.args.includes("--source"));
	assertOk(readCall.args.includes("recent-unwrapped"));
	assertOk(readCall.args.includes("--lines"));
	assertOk(readCall.args.includes("100"));
});

await asyncTest("focusWindow calls herdr tab focus", async () => {
	const mockPi = createMockPi();
	const driver = new HerdrDriver("w1");
	const res = await driver.focusWindow(mockPi, "w1:t1");
	assertOk(res.ok);

	const focusCall = mockPi.calls.find((c) => c.args[0] === "tab" && c.args[1] === "focus");
	assertOk(focusCall);
	equal(focusCall.args[2], "w1:t1");
});

await asyncTest("killAgent closes pane", async () => {
	const mockPi = createMockPi();
	const driver = new HerdrDriver("w1");
	const res = await driver.killAgent(mockPi, "w1:p1");
	assertOk(res.killed);
	equal(res.method, "pane-close");

	const closeCall = mockPi.calls.find((c) => c.args[0] === "pane" && c.args[1] === "close");
	assertOk(closeCall);
	equal(closeCall.args[2], "w1:p1");
});

console.log("\n=== Terminal Driver Resolution & Preflight Tests ===");

test("getTerminalDriver defaults safely to tmuxDriver", () => {
	delete process.env.PI_SWARM_TERMINAL_MANAGER;
	const driver = getTerminalDriver();
	equal(driver.id, "tmux");
	equal(driver, tmuxDriver);
});

test("getTerminalDriver resolves Herdr from environment variable", () => {
	process.env.PI_SWARM_TERMINAL_MANAGER = "herdr";
	try {
		const driver = getTerminalDriver();
		equal(driver.id, "herdr");
	} finally {
		delete process.env.PI_SWARM_TERMINAL_MANAGER;
	}
});

test("getTerminalDriver resolves Herdr from config", () => {
	delete process.env.PI_SWARM_TERMINAL_MANAGER;
	const driver = getTerminalDriver({ terminalManager: "herdr" });
	equal(driver.id, "herdr");
});

await asyncTest("checkTmuxSession succeeds without TMUX when PI_SWARM_TERMINAL_MANAGER=herdr", async () => {
	const prevTmux = process.env.TMUX;
	const prevOk = process.env.PI_SWARM_TMUX_OK;
	const prevMgr = process.env.PI_SWARM_TERMINAL_MANAGER;
	delete process.env.TMUX;
	delete process.env.PI_SWARM_TMUX_OK;

	try {
		// Under default (tmux), missing TMUX fails
		delete process.env.PI_SWARM_TERMINAL_MANAGER;
		const failRes = await checkTmuxSession("test-session");
		assertOk(!failRes.ok, "Should fail when TMUX is missing under tmux driver");

		// Under herdr, missing TMUX does NOT fail
		process.env.PI_SWARM_TERMINAL_MANAGER = "herdr";
		const okRes = await checkTmuxSession("w1");
		assertOk(okRes.ok, "Should pass when terminal manager is herdr");

		// Alias checkTerminalSession also works
		const aliasRes = await checkTerminalSession("w1");
		assertOk(aliasRes.ok, "checkTerminalSession alias should work");
	} finally {
		if (prevTmux) process.env.TMUX = prevTmux;
		if (prevOk) process.env.PI_SWARM_TMUX_OK = prevOk;
		if (prevMgr) process.env.PI_SWARM_TERMINAL_MANAGER = prevMgr;
		else delete process.env.PI_SWARM_TERMINAL_MANAGER;
	}
});

console.log(`\nHerdr Driver Tests: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
