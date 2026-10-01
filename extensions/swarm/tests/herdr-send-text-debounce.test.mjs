import { ok as assertOk, equal, deepEqual } from "node:assert/strict";
import { HerdrDriver } from "../src/terminal/drivers/herdr.ts";
import { PANE_SEND_ENTER_DEBOUNCE_MS } from "../src/terminal/drivers/tmux.ts";

let pass = 0;
let fail = 0;

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

console.log("=== Herdr sendText Debounce & Enter Settle Tests ===");

await asyncTest("HerdrDriver.sendText waits at least PANE_SEND_ENTER_DEBOUNCE_MS between send-text and enter", async () => {
	const callTimes = [];
	const mockPi = {
		exec: async (cmd, args) => {
			callTimes.push({ args: args.slice(), time: Date.now() });
			return { code: 0, stdout: JSON.stringify({ result: { status: "ok" } }), stderr: "" };
		},
	};

	const driver = new HerdrDriver("w1");
	await driver.sendText(mockPi, "w1:p1", "test kickoff prompt");

	const sendTextCall = callTimes.find((c) => c.args[0] === "pane" && c.args[1] === "send-text");
	const sendKeysEnterCall = callTimes.find((c) => c.args[0] === "pane" && c.args[1] === "send-keys" && c.args.includes("enter"));

	assertOk(sendTextCall, "must issue pane send-text");
	assertOk(sendKeysEnterCall, "must issue pane send-keys enter");

	const gapMs = sendKeysEnterCall.time - sendTextCall.time;
	// Expected gap must be at least PANE_SEND_ENTER_DEBOUNCE_MS (450ms, minus small timer jitter margin)
	const minExpectedGap = (PANE_SEND_ENTER_DEBOUNCE_MS || 450) - 50;
	assertOk(
		gapMs >= minExpectedGap,
		`sendText debounce between send-text and send-keys enter was ${gapMs}ms, expected >= ${minExpectedGap}ms (PANE_SEND_ENTER_DEBOUNCE_MS)`,
	);
});

import { waitForPaneReady } from "../src/tmux.ts";

await asyncTest("waitForPaneReady waits for process to become pi-like and TUI markers to appear", async () => {
	let pollCount = 0;
	// Mock driver where first 2 polls show shell prompt, 3rd poll shows Pi TUI
	const mockDriver = {
		id: "test-tmux",
		inspectProcess: async () => {
			pollCount++;
			if (pollCount < 3) return { piLike: false, command: "zsh" };
			return { piLike: true, command: "node" };
		},
		capturePane: async () => {
			if (pollCount < 3) return "➜  dotfiles git:(master) PI_SWARM_AGENT_ID='helper-1' ...\n";
			return "───────────────────────────────────────────────\nswarm:helper-1 ● ready\n";
		},
	};

	const prevMgr = process.env.PI_SWARM_TERMINAL_MANAGER;
	// Set mock driver on terminal manager facade or pass options
	const res = await waitForPaneReady({}, "test-target", {
		timeoutMs: 2000,
		pollIntervalMs: 20,
		settleMs: 10,
		expectedAgentId: "helper-1",
		_driver: mockDriver,
	});

	assertOk(res, "waitForPaneReady should return true once TUI is detected");
	assertOk(pollCount >= 3, `Expected at least 3 polls, got ${pollCount}`);
});

await asyncTest("waitForPaneReady returns false when pane never renders TUI within timeout", async () => {
	const mockDriver = {
		id: "test-tmux",
		inspectProcess: async () => ({ piLike: false, command: "bash" }),
		capturePane: async () => "bash-5.1$ \n",
	};

	const res = await waitForPaneReady({}, "dead-target", {
		timeoutMs: 100,
		pollIntervalMs: 20,
		settleMs: 10,
		_driver: mockDriver,
	});

	assertOk(!res, "waitForPaneReady should return false on timeout without throwing");
});

console.log(`\nTests: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
