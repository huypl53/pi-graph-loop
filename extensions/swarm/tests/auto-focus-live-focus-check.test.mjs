// === auto-focus-live-focus-check.test.mjs — D2 regression (task herdr-autofocus-parity-20260927) ===
//
// AC5: a stale sticky lastFocusedAgentId must not produce a permanently-wrong already_focused
// skip. The busy path now queries LIVE focus (driver.getFocusStatus + resolveOwningTabId).
// RED (pre-fix): manual navigation away → still skipped already_focused forever.
// GREEN: live check shows user elsewhere → the busy path proceeds and re-focuses.

import { strictEqual, ok } from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const here = import.meta.dirname || new URL(".", import.meta.url).pathname;
const mod = await import(join(here, "..", "index.ts"));
const { maybeAutoFocusOnBusy } = mod;
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
					if (cmd.startsWith("tab list")) return { code: 0, stdout: JSON.stringify({ result: { tabs: tabList } }), stderr: "" };
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

const baseState = (scratch, lastFocusedAgentId, lastFocusAt) => ({
	version: 1,
	swarmId: "livefocus",
	cwd: scratch,
	tmuxSession: "wA",
	autoFocusBusy: true,
	autoFocusPolicy: "steal", // isolate D2 from D1: guard dropped so the live-focus decision is observable
	lastFocusedAgentId,
	lastFocusAt,
	agents: {
		"af-worker": {
			id: "af-worker",
			role: "worker",
			roleKind: "worker",
			status: "running",
			runtimeStatus: "busy",
			tmuxSession: "wA",
			tmuxWindow: "wA:t1",
			tmuxTarget: "wA:p1",
		},
	},
	delivered: {},
	messages: {},
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
});

console.log("=== D2 live-focus check (busy path) ===");

await asyncTest("GREEN: stale lastFocusedAgentId + live focus elsewhere → busy path proceeds (no already_focused skip)", async () => {
	const scratch = join(tmpdir(), `swarm-d2-live-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	// Sticky state says af-worker was auto-focused before; the user then navigated to wU:t1.
	// Live `tab list` shows the focus on wU:t1, NOT on af-worker's tab → the sticky skip must
	// NOT fire. (suppress policy vetoes later for cross-workspace, so use steal to observe the
	// re-focus; either way already_focused must be gone.)
	await writeState(paths(scratch), baseState(scratch, "af-worker", new Date(Date.now() - 60_000).toISOString()));
	const { api, execs } = fakePi({
		tabList: [
			{ tab_id: "wA:t1", workspace_id: "wA", label: "af-worker", focused: false },
			{ tab_id: "wU:t1", workspace_id: "wU", label: "user-tab", focused: true },
		],
		panes: [{ pane_id: "wA:p1", workspace_id: "wA", tab_id: "wA:t1" }],
	});
	setMgr("herdr");
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	strictEqual(res.reason !== "already_focused", true, `must not skip already_focused, got ${res.reason}`);
	strictEqual(res.switched, true, "live check shows user elsewhere → re-focus");
	ok(countTabFocus(execs) >= 1, "tab focus call at seam");
	rmSync(scratch, { recursive: true, force: true });
});

await asyncTest("GREEN: sticky state + LIVE focus actually on the agent's tab → skip already-focused-live", async () => {
	const scratch = join(tmpdir(), `swarm-d2-live2-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	await writeState(paths(scratch), baseState(scratch, "af-worker", new Date(Date.now() - 60_000).toISOString()));
	const { api } = fakePi({
		tabList: [{ tab_id: "wA:t1", workspace_id: "wA", label: "af-worker", focused: true }],
		panes: [{ pane_id: "wA:p1", workspace_id: "wA", tab_id: "wA:t1" }],
	});
	setMgr("herdr");
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	strictEqual(res.switched, false, "user is genuinely already on the agent's tab → skip");
	strictEqual(res.reason, "already-focused-live", `live reason expected, got ${res.reason}`);
	rmSync(scratch, { recursive: true, force: true });
});

await asyncTest("tmux fallback: no live signal → legacy sticky already_focused skip preserved", async () => {
	const scratch = join(tmpdir(), `swarm-d2-tmux-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	await writeState(paths(scratch), baseState(scratch, "af-worker", new Date(Date.now() - 60_000).toISOString()));
	const { api } = fakePi({});
	setMgr("tmux");
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	strictEqual(res.switched, false);
	strictEqual(res.reason, "already_focused", "tmux without live signal keeps the legacy sticky skip (anti-flap)");
	rmSync(scratch, { recursive: true, force: true });
});

setMgr(prevMgr);
console.log(fail === 0 ? "\nALL LIVE-FOCUS TESTS PASSED." : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
