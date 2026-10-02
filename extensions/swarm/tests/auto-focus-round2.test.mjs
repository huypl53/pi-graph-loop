// === auto-focus-round2.test.mjs — RED→GREEN regression suite for task swarm-autofocus-round2 ===
//
// Four holes (a)(b)(d)(e) triaged + red-reproduced in .pi/swarm/tasks/swarm-autofocus-round2/artifacts/repro-matrix.js.
// Harness: fakePi exec-counter at the REAL pi.exec seam (R10-1 boundary counting on
// `tmux select-window` / `herdr tab focus` argv). Precedent: herdr-auto-focus-cross-workspace.test.mjs.
//
// (a)+(b) tmux busy path: user attached to the agents session viewing ANOTHER window must NOT
//         be stolen from by a busy agent's tool-call auto-focus (cooldown outlived, D2 live
//         check re-focuses today). Fixed: tmux joins the cross-window guard via driver
//         getFocusStatus (user-on-target-window or no live signal still focuses).
// (d)     herdr settle path: maybeAutoFocusBusyAgent must apply the same follow/suppress/steal
//         cross-workspace policy as the busy path before switching.
// (e)     herdr busy path: getFocusedWorkspaceId undefined (query OK, no focused row) must fail
//         CLOSED under follow/suppress (contract from 8fc0748), not fall through to focus.

import { strictEqual } from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const here = import.meta.dirname || new URL(".", import.meta.url).pathname;
const mod = await import(join(here, "..", "index.ts"));
const { maybeAutoFocusOnBusy, maybeAutoFocusBusyAgent } = mod;
const { paths, writeState, readState } = await import(join(here, "..", "src", "state.ts"));

let pass = 0;
let fail = 0;
async function asyncTest(name, fn) {
	try {
		await fn();
		pass++;
		console.log(`  ok   ${name}`);
	} catch (err) {
		fail++;
		console.error(`  FAIL ${name}:`, err?.message || err);
	}
}

function fakePi({ herdrTabList, herdrTabListWorkspaceScoped, herdrWorkspaceList, tmuxDisplayMessage } = {}) {
	const execs = [];
	return {
		execs,
		api: {
			exec: async (bin, args) => {
				execs.push({ bin, args });
				if (bin === "herdr") {
					const cmd = args.join(" ");
					if (cmd === "tab list") {
						return { code: 0, stdout: JSON.stringify({ result: { tabs: herdrTabList || [] } }), stderr: "" };
					}
					if (cmd.startsWith("tab list --workspace")) {
						return { code: 0, stdout: JSON.stringify({ result: { tabs: herdrTabListWorkspaceScoped || herdrTabList || [] } }), stderr: "" };
					}
					if (cmd === "workspace list") {
						return { code: 0, stdout: JSON.stringify({ result: { workspaces: herdrWorkspaceList || [] } }), stderr: "" };
					}
					return { code: 0, stdout: "{}", stderr: "" };
				}
				if (bin === "tmux") {
					const cmd = args.join(" ");
					if (cmd.includes("display-message")) {
						return { code: 0, stdout: tmuxDisplayMessage || "sess\t0\t%0\n", stderr: "" };
					}
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		},
	};
}

const count = (execs, bin, predicate) => execs.filter((e) => e.bin === bin && (!predicate || predicate(e))).length;
const tabFocusCount = (execs) => count(execs, "herdr", (e) => e.args[0] === "tab" && e.args[1] === "focus");
const selectWindowCount = (execs) => count(execs, "tmux", (e) => e.args[0] === "select-window");

function baseState(scratch, ws, tab, pane, policy, agents = {}) {
	return {
		version: 1,
		swarmId: "af2-test",
		cwd: scratch,
		tmuxSession: ws,
		autoFocusBusy: true,
		autoFocusPolicy: policy || "follow",
		agents: Object.keys(agents).length
			? agents
			: {
					"af-worker": {
						id: "af-worker",
						role: "worker",
						roleKind: "worker",
						status: "running",
						runtimeStatus: "busy",
						tmuxSession: ws,
						tmuxWindow: tab,
						tmuxTarget: pane,
						lastAgentStartAt: new Date().toISOString(),
					},
				},
		delivered: {},
		messages: {},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

const mkScratch = (label) => {
	const scratch = join(tmpdir(), `af2-${label}-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	return scratch;
};

const setMgr = (m) => (process.env.PI_SWARM_TERMINAL_MANAGER = m);
const prevMgr = process.env.PI_SWARM_TERMINAL_MANAGER;
const prevTmux = process.env.TMUX;
delete process.env.TMUX; // deterministic: no ambient tmux attachment

console.log("=== auto-focus round 2: holes (a)(b)(d)(e) ===");

// --- (a)+(b): tmux busy path, user attached to the agents session on another window ---
await asyncTest("(a+b) tmux busy: user viewing another window of the agents session → 0 select-window, skip reason", async () => {
	const scratch = mkScratch("ab");
	const p = paths(scratch);
	const ws = "wA", tab = "wA:t1", pane = "wA:p1";
	await writeState(p, baseState(scratch, ws, tab, pane, "follow"));
	const st = await readState(p, scratch);
	st.lastFocusedAgentId = "af-worker-2"; // sticky mismatch → live check decides
	st.lastFocusAt = new Date(Date.now() - 10_000).toISOString(); // cooldown expired
	await writeState(p, st);
	const { api, execs } = fakePi({ tmuxDisplayMessage: `${ws}\t0\t%user-pane\n` }); // user on %user-pane
	setMgr("tmux");
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	strictEqual(selectWindowCount(execs), 0, `expected 0 select-window; got ${selectWindowCount(execs)} (steal)`);
	strictEqual(res.switched, false, "must not switch");
	strictEqual(res.reason, "user-focused-elsewhere-in-session", `expected stable tmux skip reason, got: ${res.reason}`);
	rmSync(scratch, { recursive: true, force: true });
});

await asyncTest("(a-iso) tmux busy: same busy agent, two calls 3s apart, user elsewhere each time → 0 steals", async () => {
	const scratch = mkScratch("aiso");
	const p = paths(scratch);
	const ws = "wA", tab = "wA:t1", pane = "wA:p1";
	await writeState(p, baseState(scratch, ws, tab, pane, "follow"));
	const st = await readState(p, scratch);
	st.lastFocusedAgentId = "af-worker";
	await writeState(p, st);
	const { api, execs } = fakePi({ tmuxDisplayMessage: `${ws}\t0\t%user-pane\n` });
	setMgr("tmux");
	await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	const st2 = await readState(p, scratch);
	st2.lastFocusAt = new Date(Date.now() - 3_000).toISOString(); // outlive the 2.5s cooldown
	await writeState(p, st2);
	await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	strictEqual(selectWindowCount(execs), 0, `expected 0 steals across spaced calls; got ${selectWindowCount(execs)}`);
	rmSync(scratch, { recursive: true, force: true });
});

await asyncTest("(b-green) tmux busy: user viewing the target agent's window → focus proceeds", async () => {
	const scratch = mkScratch("bgreen");
	const p = paths(scratch);
	const ws = "wA", tab = "wA:t1", pane = "wA:p1";
	await writeState(p, baseState(scratch, ws, tab, pane, "follow"));
	const { api, execs } = fakePi({ tmuxDisplayMessage: `${ws}\t0\t${pane}\n` }); // user ON the agent's pane
	setMgr("tmux");
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	strictEqual(res.switched, true, "same-window focus should proceed");
	strictEqual(selectWindowCount(execs), 1, "exactly one select-window");
	rmSync(scratch, { recursive: true, force: true });
});

await asyncTest("(b-force) tmux busy: force option bypasses the new cross-window guard", async () => {
	const scratch = mkScratch("bforce");
	const p = paths(scratch);
	const ws = "wA", tab = "wA:t1", pane = "wA:p1";
	await writeState(p, baseState(scratch, ws, tab, pane, "follow"));
	const { api, execs } = fakePi({ tmuxDisplayMessage: `${ws}\t0\t%user-pane\n` });
	setMgr("tmux");
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker", { force: true });
	strictEqual(res.switched, true, "force must proceed");
	strictEqual(selectWindowCount(execs), 1, "force selects the window");
	rmSync(scratch, { recursive: true, force: true });
});

// --- (d): herdr settle path, user globally elsewhere ---
await asyncTest("(d) herdr settle: per-workspace active tab + user globally elsewhere → 0 tab focus, policy skip", async () => {
	const scratch = mkScratch("d");
	const p = paths(scratch);
	const ws = "wA", tab = "wA:t1", pane = "wA:p1", userWs = "wU";
	const agents = {
		"af-worker": {
			id: "af-worker", role: "worker", roleKind: "worker", status: "running",
			runtimeStatus: "idle", // settling agent is idle by the time the hook fires (settled.ts:176)
			tmuxSession: ws, tmuxWindow: tab, tmuxTarget: pane,
			lastAgentStartAt: new Date().toISOString(),
		},
		"af-worker-2": {
			id: "af-worker-2", role: "worker", roleKind: "worker", status: "running",
			runtimeStatus: "tool_running", tmuxSession: ws, tmuxWindow: "wA:t2", tmuxTarget: "wA:p2",
			lastAgentStartAt: new Date().toISOString(),
		},
	};
	const st = baseState(scratch, ws, tab, pane, "follow", agents);
	st.lastFocusByTarget = {};
	st.lastFocusedAgentId = "af-worker";
	st.lastFocusAt = new Date(Date.now() - 10_000).toISOString();
	await writeState(p, st);
	const { api, execs } = fakePi({
		// workspace-SCOPED list (getFocusStatus passes --workspace agents): settling tab is the
		// workspace's last-active tab even though GLOBAL focus (unfiltered) is in wU.
		herdrTabListWorkspaceScoped: [{ tab_id: tab, workspace_id: ws, label: "af-worker", focused: true }],
		herdrTabList: [
			{ tab_id: "wU:t1", workspace_id: userWs, label: "user-tab", focused: true },
			{ tab_id: tab, workspace_id: ws, label: "af-worker", focused: false },
		],
		herdrWorkspaceList: [{ workspace_id: ws, label: "agents" }, { workspace_id: userWs, label: "user" }],
	});
	setMgr("herdr");
	const res = await maybeAutoFocusBusyAgent(api, { cwd: scratch }, "af-worker");
	strictEqual(tabFocusCount(execs), 0, `expected 0 tab focus; got ${tabFocusCount(execs)} (steal via settle)`);
	strictEqual(res.switched, false, "must not switch");
	strictEqual(res.reason, "user-focused-outside-agents-workspace", `expected policy skip, got: ${res.reason}`);
	rmSync(scratch, { recursive: true, force: true });
});

await asyncTest("(d-green) herdr settle: user focused inside the agents workspace → handoff proceeds", async () => {
	const scratch = mkScratch("dgreen");
	const p = paths(scratch);
	const ws = "wA", tab = "wA:t1", pane = "wA:p1";
	const agents = {
		"af-worker": {
			id: "af-worker", role: "worker", roleKind: "worker", status: "running",
			runtimeStatus: "idle", tmuxSession: ws, tmuxWindow: tab, tmuxTarget: pane,
			lastAgentStartAt: new Date().toISOString(),
		},
		"af-worker-2": {
			id: "af-worker-2", role: "worker", roleKind: "worker", status: "running",
			runtimeStatus: "tool_running", tmuxSession: ws, tmuxWindow: "wA:t2", tmuxTarget: "wA:p2",
			lastAgentStartAt: new Date().toISOString(),
		},
	};
	const st = baseState(scratch, ws, tab, pane, "follow", agents);
	st.lastFocusByTarget = {};
	await writeState(p, st);
	const { api, execs } = fakePi({
		herdrTabList: [
			{ tab_id: tab, workspace_id: ws, label: "af-worker", focused: true }, // user in agents workspace
			{ tab_id: "wA:t2", workspace_id: ws, label: "af-worker-2", focused: false },
		],
		herdrWorkspaceList: [{ workspace_id: ws, label: "agents" }],
	});
	setMgr("herdr");
	const res = await maybeAutoFocusBusyAgent(api, { cwd: scratch }, "af-worker");
	strictEqual(res.switched, true, "in-workspace handoff should proceed");
	strictEqual(tabFocusCount(execs), 1, "exactly one tab focus");
	rmSync(scratch, { recursive: true, force: true });
});

// --- (e): herdr busy path, undefined focused workspace (no focused row) ---
await asyncTest("(e) herdr busy: tab list with NO focused row → fail closed, 0 tab focus", async () => {
	const scratch = mkScratch("e");
	const p = paths(scratch);
	const ws = "wA", tab = "wA:t1", pane = "wA:p1";
	await writeState(p, baseState(scratch, ws, tab, pane, "follow"));
	const { api, execs } = fakePi({
		herdrTabList: [{ tab_id: tab, workspace_id: ws, label: "af-worker", focused: false }],
		herdrWorkspaceList: [{ workspace_id: ws, label: "agents" }, { workspace_id: "wU", label: "user" }],
	});
	setMgr("herdr");
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	strictEqual(tabFocusCount(execs), 0, `expected fail-closed 0 focus calls; got ${tabFocusCount(execs)} (steal)`);
	strictEqual(res.switched, false, "must not switch");
	strictEqual(res.reason, "user-focused-outside-agents-workspace", `expected fail-closed skip, got: ${res.reason}`);
	rmSync(scratch, { recursive: true, force: true });
});

await asyncTest("(e-suppress) herdr busy + suppress policy: undefined focus also fails closed", async () => {
	const scratch = mkScratch("esup");
	const p = paths(scratch);
	const ws = "wA", tab = "wA:t1", pane = "wA:p1";
	await writeState(p, baseState(scratch, ws, tab, pane, "suppress"));
	const { api, execs } = fakePi({
		herdrTabList: [{ tab_id: tab, workspace_id: ws, label: "af-worker", focused: false }],
		herdrWorkspaceList: [{ workspace_id: ws, label: "agents" }],
	});
	setMgr("herdr");
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	strictEqual(tabFocusCount(execs), 0, "suppress must veto on undefined focus too");
	strictEqual(res.switched, false, "must not switch");
	rmSync(scratch, { recursive: true, force: true });
});

await asyncTest("(e-steal) herdr busy + steal policy: undefined focus proceeds (explicit opt-in)", async () => {
	const scratch = mkScratch("esteal");
	const p = paths(scratch);
	const ws = "wA", tab = "wA:t1", pane = "wA:p1";
	await writeState(p, baseState(scratch, ws, tab, pane, "steal"));
	const { api, execs } = fakePi({
		herdrTabList: [{ tab_id: tab, workspace_id: ws, label: "af-worker", focused: false }],
		herdrWorkspaceList: [{ workspace_id: ws, label: "agents" }],
	});
	setMgr("herdr");
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	strictEqual(res.switched, true, "steal policy is the explicit opt-out of the guard");
	strictEqual(tabFocusCount(execs), 1, "steal focuses");
	rmSync(scratch, { recursive: true, force: true });
});

setMgr(prevMgr);
if (prevTmux) process.env.TMUX = prevTmux;

console.log(`\nAuto-focus round 2: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
