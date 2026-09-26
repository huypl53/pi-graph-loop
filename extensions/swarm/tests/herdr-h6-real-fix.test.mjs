// Focus-only RED/GREEN regression extracted from H6 real-shape coverage.
// The pre-fix caller regression observed two failures: pane-shaped focus targeted `p1`, and
// a missing pane still attempted a guessed tab focus. See task artifacts/red-attempt11.md.
import { deepEqual, ok, strictEqual } from "node:assert/strict";

const { focusAgentWindow } = await import("../src/focus.ts");
const { TmuxDriver } = await import("../src/terminal/drivers/tmux.ts");

function makeRegisterHereFocusPi({ paneExists = true } = {}) {
	const execLog = [];
	const tabs = [
		{ tab_id: "wK:tE", label: "root", focused: true, workspace_id: "wK" },
		{ tab_id: "w1W:t1", label: "worker", focused: false, workspace_id: "w1W" },
	];
	const panes = paneExists ? [{ pane_id: "w1W:p1", tab_id: "w1W:t1", workspace_id: "w1W" }] : [];
	let focusedTabId = "wK:tE";
	const api = {
		exec: async (bin, args) => {
			execLog.push({ bin, args });
			if (bin !== "herdr") return { code: 0, stdout: "", stderr: "" };
			if (args[0] === "pane" && args[1] === "list") {
				const wsIndex = args.indexOf("--workspace");
				const rows = wsIndex < 0 ? panes : panes.filter((pane) => pane.workspace_id === args[wsIndex + 1]);
				return { code: 0, stdout: JSON.stringify({ result: { panes: rows } }), stderr: "" };
			}
			if (args[0] === "tab" && args[1] === "focus") {
				const requested = args[2];
				if (!tabs.some((tab) => tab.tab_id === requested)) {
					return { code: 1, stdout: "", stderr: `tab_not_found: ${requested}` };
				}
				focusedTabId = requested;
				return { code: 0, stdout: JSON.stringify({ result: { focused: requested } }), stderr: "" };
			}
			return { code: 0, stdout: "{}", stderr: "" };
		},
	};
	return { api, execLog, focusedTabId: () => focusedTabId };
}

const previousManager = process.env.PI_SWARM_TERMINAL_MANAGER;
try {
	process.env.PI_SWARM_TERMINAL_MANAGER = "herdr";
	console.log("=== Herdr register-here focus regression ===");

	{
		const { api, execLog, focusedTabId } = makeRegisterHereFocusPi();
		const agent = { id: "worker-h6", tmuxSession: "w1W", tmuxWindow: "p1", tmuxTarget: "w1W:p1" };
		const result = await focusAgentWindow(api, agent);
		ok(result.ok, `expected pane target to focus its owning tab; got ${JSON.stringify(result)}`);
		const focusCalls = execLog.filter((entry) => entry.bin === "herdr" && entry.args[0] === "tab" && entry.args[1] === "focus");
		strictEqual(focusCalls.length, 1, JSON.stringify(focusCalls));
		strictEqual(focusCalls[0].args[2], "w1W:t1", "must focus the owning tab, not pane index p1");
		ok(!execLog.some((entry) => entry.args[0] === "tab" && entry.args[1] === "focus" && entry.args[2] === "p1"));
		strictEqual(focusedTabId(), "w1W:t1");
		console.log("  ok   pane-shaped register-here target focuses exact owning tab");
	}

	{
		const { api, execLog, focusedTabId } = makeRegisterHereFocusPi({ paneExists: false });
		const agent = { id: "worker-h6", tmuxSession: "w1W", tmuxWindow: "p1", tmuxTarget: "w1W:p99" };
		const result = await focusAgentWindow(api, agent);
		strictEqual(result.ok, false, JSON.stringify(result));
		ok(result.error && !result.error.includes("tab_not_found"), `expected pane-resolution failure, got ${result.error}`);
		ok(
			!execLog.some((entry) => entry.args[0] === "tab" && entry.args[1] === "focus"),
			"must not guess or focus any tab on a pane miss",
		);
		strictEqual(focusedTabId(), "wK:tE", "unrelated original focus must remain unchanged");
		console.log("  ok   missing pane fails closed without changing focus");
	}

	process.env.PI_SWARM_TERMINAL_MANAGER = "tmux";
	{
		const execs = [];
		const pi = {
			exec: async (bin, args) => {
				execs.push({ bin, args });
				return { code: 0, stdout: "", stderr: "" };
			},
		};
		const result = await new TmuxDriver().focusWindow(pi, {
			target: "w1W:p1",
			session: "w1W",
			window: "p1",
			paneId: "w1W:p1",
		});
		strictEqual(result.ok, true, JSON.stringify(result));
		deepEqual(execs, [
			{ bin: "tmux", args: ["select-window", "-t", "w1W:p1"] },
			{ bin: "tmux", args: ["select-pane", "-t", "w1W:p1"] },
		]);
		console.log("  ok   TmuxDriver focus argv remains byte-identical");
	}
} finally {
	if (previousManager === undefined) delete process.env.PI_SWARM_TERMINAL_MANAGER;
	else process.env.PI_SWARM_TERMINAL_MANAGER = previousManager;
}
