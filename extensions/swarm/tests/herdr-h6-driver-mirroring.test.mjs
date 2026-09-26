// === herdr-h6-driver-mirroring.test.mjs — H6 residual raw-tmux site elimination ===
// R10-1 boundary counters at the REAL pi.exec seam (fake ExtensionAPI.exec recorder): under
// PI_SWARM_TERMINAL_MANAGER=herdr the four residual call sites emit ZERO tmux execs; under tmux
// mode TmuxDriver emits the pre-fix byte-identical argv and ZERO herdr execs.
// Red-green evidence lane: scripts/uat/herdr-h6-red.mjs (H6_EXPECT=red reproduces, =green proves).
import { strictEqual, ok, deepEqual } from "node:assert/strict";
import { killAgentPane, sendKeys } from "../src/agents.ts";
import { isCurrentActiveTmuxWindow, focusAgentWindow } from "../src/focus.ts";
import { getTerminalDriver } from "../src/terminal/index.ts";

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

function fakePi() {
	const execs = [];
	return {
		execs,
		api: {
			exec: async (bin, args, opts) => {
				execs.push({ bin, args, opts });
				if (bin === "tmux") {
					const cmd = args[0];
					if (cmd === "display-message") {
						const fmt = args[args.length - 1];
						if (fmt === "#{pane_id}") return { code: 0, stdout: "w9:p3\n", stderr: "" };
						return { code: 0, stdout: "3\tw9\tw9:p3\n", stderr: "" };
					}
					if (cmd === "list-panes") return { code: 0, stdout: "panes\n", stderr: "" };
					if (cmd === "kill-window") return { code: 1, stdout: "", stderr: "can't find window" };
					return { code: 0, stdout: "", stderr: "" };
				}
				if (bin === "herdr") {
					const cmd = args.join(" ");
					if (cmd.startsWith("pane list --workspace w9"))
						return {
							code: 0,
							stdout: JSON.stringify({ result: { panes: [{ pane_id: "w9:p3", tab_id: "w9:t9", workspace_id: "w9" }] } }),
							stderr: "",
						};
					if (cmd.startsWith("pane process-info"))
						return {
							code: 0,
							stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "pi", pid: 7 }] } } }),
							stderr: "",
						};
					if (cmd.startsWith("pane read")) return { code: 0, stdout: JSON.stringify({ result: { text: "out" } }), stderr: "" };
					if (cmd.startsWith("tab list"))
						return {
							code: 0,
							stdout: JSON.stringify({
								result: { tabs: [{ tab_id: "t9", label: "a1", active: true, active_pane_id: "w9:p3" }] },
							}),
							stderr: "",
						};
					return { code: 0, stdout: "ok", stderr: "" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		},
	};
}

const count = (execs, bin) => execs.filter((e) => e.bin === bin).length;
const agent = { id: "a1", tmuxTarget: "w9:p3", tmuxSession: "ws-agents", tmuxWindow: "a1" };

// Preserve env
const prevMgr = process.env.PI_SWARM_TERMINAL_MANAGER;
const setMgr = (m) => (process.env.PI_SWARM_TERMINAL_MANAGER = m);

console.log("=== H6 herdr mode: zero tmux execs at the pi.exec seam ===");

await asyncTest("killAgentPane → herdr only (0 tmux execs)", async () => {
	const { api, execs } = fakePi();
	setMgr("herdr");
	const res = await killAgentPane(api, { tmuxTraces: "/tmp/h6-test" }, agent);
	strictEqual(res.killed, true);
	strictEqual(count(execs, "tmux"), 0);
	ok(count(execs, "herdr") > 0, "expected herdr execs");
});

await asyncTest("sendKeys → herdr only (0 tmux execs)", async () => {
	const { api, execs } = fakePi();
	setMgr("herdr");
	await sendKeys(api, {}, "w9:p3", "C-c");
	strictEqual(count(execs, "tmux"), 0);
	ok(execs.some((e) => e.bin === "herdr" && e.args.join(" ").includes("send-keys w9:p3 ctrl+c")));
});

await asyncTest("isCurrentActiveTmuxWindow → herdr only (0 tmux execs)", async () => {
	const { api, execs } = fakePi();
	setMgr("herdr");
	const res = await isCurrentActiveTmuxWindow(api, "ws-agents", agent);
	strictEqual(typeof res, "boolean");
	strictEqual(count(execs, "tmux"), 0);
});

await asyncTest("focusAgentWindow resolves register-here pane target via herdr only (0 tmux execs)", async () => {
	const { api, execs } = fakePi();
	setMgr("herdr");
	const res = await focusAgentWindow(api, { ...agent, tmuxSession: "w9", tmuxWindow: "p3" }, "/tmp/h6-test");
	strictEqual(res.ok, true);
	strictEqual(count(execs, "tmux"), 0);
	ok(execs.some((e) => e.bin === "herdr" && e.args.join(" ") === "pane list --workspace w9"));
	ok(execs.some((e) => e.bin === "herdr" && e.args.join(" ") === "tab focus w9:t9"));
});

await asyncTest("resolvePaneId (herdr pane id pass-through, 0 execs)", async () => {
	const { api, execs } = fakePi();
	setMgr("herdr");
	strictEqual(await getTerminalDriver().resolvePaneId(api, "w9:p3"), "w9:p3");
	strictEqual(count(execs, "tmux"), 0);
});

console.log("=== H6 tmux mode: byte-identical argv, zero herdr execs ===");

await asyncTest("killAgentPane tmux argv byte-identical", async () => {
	const { api, execs } = fakePi();
	setMgr("tmux");
	await killAgentPane(api, { tmuxTraces: "/tmp/h6-test" }, agent);
	strictEqual(count(execs, "herdr"), 0);
	const argv = execs.filter((e) => e.bin === "tmux").map((e) => e.args);
	// argv[0] is the driver's isTargetAlive liveness probe (pre-fix killAgentPane probed the same way
	// via isTmuxRunning → list-panes), then kill-window with fallback kill-pane.
	deepEqual(argv[1], ["kill-window", "-t", "ws-agents:a1"]);
	deepEqual(argv[2], ["kill-pane", "-t", "w9:p3"]);
});

await asyncTest("sendKeys tmux argv byte-identical (literal + tokens + enter)", async () => {
	const { api, execs } = fakePi();
	setMgr("tmux");
	await sendKeys(api, {}, "w9:p3", "hello", { literal: true });
	await sendKeys(api, {}, "w9:p3", "C-c", { enter: true });
	strictEqual(count(execs, "herdr"), 0);
	const argv = execs.filter((e) => e.bin === "tmux").map((e) => e.args);
	deepEqual(argv[0], ["send-keys", "-t", "w9:p3", "-l", "--", "hello"]);
	deepEqual(argv[1], ["send-keys", "-t", "w9:p3", "--", "C-c"]);
	deepEqual(argv[2], ["send-keys", "-t", "w9:p3", "Enter"]);
});

await asyncTest("focus status tmux argv byte-identical", async () => {
	const { api, execs } = fakePi();
	setMgr("tmux");
	await isCurrentActiveTmuxWindow(api, "ws-agents", agent);
	strictEqual(count(execs, "herdr"), 0);
	deepEqual(execs[0].args, ["display-message", "-p", "-t", "ws-agents", "#{window_name}\t#{window_index}\t#{pane_id}"]);
});

await asyncTest("focusWindow tmux argv byte-identical for register-here pane-shaped record", async () => {
	const { TmuxDriver } = await import("../src/terminal/drivers/tmux.ts");
	const { api, execs } = fakePi();
	const driver = new TmuxDriver();
	const registerHere = { target: "w1W:p1", session: "w1W", window: "p1", paneId: "w1W:p1" };
	const result = await driver.focusWindow(api, registerHere);
	strictEqual(result.ok, true, JSON.stringify(result));
	strictEqual(count(execs, "herdr"), 0);
	const focusArgv = execs.filter((entry) => entry.bin === "tmux").map((entry) => entry.args);
	deepEqual(focusArgv, [
		["select-window", "-t", "w1W:p1"],
		["select-pane", "-t", "w1W:p1"],
	]);
});

await asyncTest("resolvePaneId tmux argv byte-identical", async () => {
	const { api, execs } = fakePi();
	setMgr("tmux");
	strictEqual(await getTerminalDriver().resolvePaneId(api, "w9:p3"), "w9:p3");
	strictEqual(count(execs, "herdr"), 0);
	deepEqual(execs[0].args, ["display-message", "-p", "-t", "w9:p3", "#{pane_id}"]);
});

setMgr(prevMgr);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
