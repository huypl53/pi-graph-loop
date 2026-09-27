// === herdr-pane-to-tab-matching.test.mjs — D3 regression (task herdr-autofocus-parity-20260927) ===
//
// AC3: settle path focuses correctly for a registered-here agent whose tab IS focused.
// RED (pre-fix): isCurrentActiveTmuxWindow compared tmuxWindow ("p9" — pane component) against
// the herdr tab id/label; herdr 0.8.2 tab rows expose no active_pane_id → permanent
// active_window_mismatch. GREEN: driver.resolveOwningTabId resolves pane→owning tab
// (a67e351 parity with focusWindow) and the comparison succeeds.
//
// R10-1: boundary counting at the REAL pi.exec("herdr") seam.

import { strictEqual, ok } from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const here = import.meta.dirname || new URL(".", import.meta.url).pathname;
const mod = await import(join(here, "..", "index.ts"));
const { isCurrentActiveTmuxWindow, maybeAutoFocusBusyAgent } = mod;
const { paths, writeState } = await import(join(here, "..", "src", "state.ts"));

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

function fakePi({ tabList = [], panes = [] } = {}) {
	const execs = [];
	return {
		execs,
		api: {
			exec: async (bin, args) => {
				execs.push({ bin, args });
				const cmd = args.join(" ");
				if (bin === "herdr") {
					if (cmd === "tab list" || cmd.startsWith("tab list"))
						return { code: 0, stdout: JSON.stringify({ result: { tabs: tabList } }), stderr: "" };
					if (cmd.startsWith("pane list")) return { code: 0, stdout: JSON.stringify({ result: { panes } }), stderr: "" };
					if (cmd.startsWith("tab focus")) return { code: 0, stdout: "{}", stderr: "" };
					return { code: 0, stdout: "{}", stderr: "" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		},
	};
}
const countTabFocus = (execs) => execs.filter((e) => e.bin === "herdr" && e.args[0] === "tab" && e.args[1] === "focus").length;

const prevMgr = process.env.PI_SWARM_TERMINAL_MANAGER;
const setMgr = (m) => (process.env.PI_SWARM_TERMINAL_MANAGER = m);

// Lane B setup (plan §RED Lane B): registered-here agent, tmuxWindow = pane component "p9",
// tmuxTarget = workspace-qualified pane id, user's global focus on the owning tab wR:t1.
const regState = (scratch) => ({
	version: 1,
	swarmId: "laneB",
	cwd: scratch,
	tmuxSession: "wR",
	autoFocusBusy: true,
	agents: {
		"af-reg": {
			id: "af-reg",
			role: "worker",
			roleKind: "worker",
			status: "running",
			runtimeStatus: "busy",
			tmuxSession: "wR",
			tmuxWindow: "p9",
			tmuxTarget: "wR:p9",
		},
		"af-other": {
			id: "af-other",
			role: "worker",
			roleKind: "worker",
			status: "running",
			runtimeStatus: "busy",
			tmuxSession: "wR",
			tmuxWindow: "wR:t2",
			tmuxTarget: "wR:p2",
		},
	},
	delivered: {},
	messages: {},
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
});

const laneBFixtures = {
	tabList: [{ tab_id: "wR:t1", workspace_id: "wR", label: "1", focused: true }],
	panes: [{ pane_id: "wR:p9", workspace_id: "wR", tab_id: "wR:t1" }],
};

console.log("=== D3 pane→tab matching (settle path) ===");

await asyncTest("herdr registered-here agent (tmuxWindow=p9) whose tab IS focused → isCurrentActiveTmuxWindow true", async () => {
	setMgr("herdr");
	const { api } = fakePi(laneBFixtures);
	const okMatch = await isCurrentActiveTmuxWindow(api, "wR", regState(".").agents["af-reg"]);
	strictEqual(okMatch, true, "pane→owning-tab resolution must match the focused tab");
});

await asyncTest("herdr settle path hands off to next busy agent (0 active_window_mismatch skips, ≥1 tab focus)", async () => {
	const scratch = join(tmpdir(), `swarm-laneB-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	await writeState(paths(scratch), regState(scratch));
	const { api, execs } = fakePi(laneBFixtures);
	setMgr("herdr");
	const res = await maybeAutoFocusBusyAgent(api, { cwd: scratch }, "af-reg");
	strictEqual(res.switched, true, `expected handoff, got: ${JSON.stringify(res)}`);
	strictEqual(res.targetAgentId, "af-other");
	ok(countTabFocus(execs) >= 1, "herdr tab focus call expected at the pi.exec seam");
	rmSync(scratch, { recursive: true, force: true });
});

await asyncTest("tmux driver unaffected: resolveOwningTabId is pass-through", async () => {
	setMgr("tmux");
	const { api, execs } = fakePi({});
	const drv = (await import(join(here, "..", "src", "terminal", "index.ts"))).getTerminalDriver();
	strictEqual(drv.id, "tmux");
	const tab = await drv.resolveOwningTabId(api, "sess:win.0");
	strictEqual(tab, "sess:win.0");
	strictEqual(execs.filter((e) => e.bin === "tmux").length, 0, "pass-through must not exec tmux");
});

setMgr(prevMgr);
console.log(fail === 0 ? "\nALL PANE→TAB MATCHING TESTS PASSED." : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
