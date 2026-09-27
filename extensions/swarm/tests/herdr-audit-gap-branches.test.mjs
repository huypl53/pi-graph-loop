// herdr-audit-gap-branches.test.mjs — deterministic fake-exec branch tests closing the
// herdr-coverage-audit-20260928 matrix gaps. No real binary, no network, milliseconds.
// Run: node extensions/swarm/tests/herdr-audit-gap-branches.test.mjs
import { deepEqual, equal, ok as assertOk } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrDriver, getTerminalDriver, tmuxDriver, translateTmuxKeyToHerdr, isPiLikeProcess } from "../src/terminal/index.ts";
import { getAttachCommandsShapeProbe } from "./helpers/herdr-audit-helpers.mjs";

let pass = 0;
let fail = 0;
function test(name, fn) {
	try {
		fn();
		pass++;
		console.log(`  ok   ${name}`);
	} catch (err) {
		fail++;
		console.error(`  FAIL ${name}:`, err?.message || err);
	}
}
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

// This branch suite seeds TypeScript-private driver state directly where setup through public
// operations would require extra lifecycle work. It deliberately adds no test-only methods to the
// production class; the fields remain implementation details and are only touched by this fixture.
// ---------------------------------------------------------------- mock harness
// Records every exec; implements a small herdr 0.8.2-shaped fake with 0.8.2 REAL
// nested `foreground_processes[]` shapes (the audit flagged the old scalar fixture).
function createMockPi(state = {}) {
	const calls = [];
	const exec = async (cmd, args, opts) => {
		calls.push({ cmd, args, opts });
		if (cmd !== "herdr") return { code: 1, stdout: "", stderr: `unknown command: ${cmd}` };
		const [sub, action] = args;

		if (sub === "--version") return { code: 0, stdout: "herdr 0.8.2\n", stderr: "" };

		if (sub === "workspace" && action === "list") {
			return { code: 0, stdout: JSON.stringify({ result: { workspaces: state.workspaces || [] } }), stderr: "" };
		}
		if (sub === "workspace" && action === "get") {
			if (state.failWorkspaceGetOther) return { code: 1, stdout: "", stderr: "herdr daemon unreachable" };
			const wsId = args[2];
			const ws = (state.workspaces || []).find((w) => w.workspace_id === wsId);
			if (!ws) {
				// real 0.8.2 exits nonzero with a workspace_not_found body
				return { code: 3, stdout: "", stderr: JSON.stringify({ error: { code: "workspace_not_found" } }) };
			}
			return { code: 0, stdout: JSON.stringify({ result: { workspace: ws } }), stderr: "" };
		}
		if (sub === "workspace" && action === "create") {
			if (state.failWorkspaceCreate) return { code: 1, stdout: "", stderr: "boom" };
			const labelIdx = args.indexOf("--label");
			const label = labelIdx !== -1 ? args[labelIdx + 1] : "swarm-agents";
			const ws = { workspace_id: state.nextWsId || "w99", label, active_tab_id: state.nextRootTabId || "w99:t1" };
			state.workspaces = state.workspaces || [];
			state.workspaces.push(ws);
			return {
				code: 0,
				stdout: JSON.stringify({
					result: { workspace: ws, tab: state.nextRootTabId ? { tab_id: state.nextRootTabId } : { tab_id: "w99:t1" } },
				}),
				stderr: "",
			};
		}
		if (sub === "workspace" && action === "close") {
			const wsId = args[2];
			state.closedWorkspaces = state.closedWorkspaces || [];
			state.closedWorkspaces.push(wsId);
			state.workspaces = (state.workspaces || []).filter((w) => w.workspace_id !== wsId);
			return { code: 0, stdout: "{}", stderr: "" };
		}

		if (sub === "tab" && action === "create") {
			if (state.failTabCreate) return { code: 2, stdout: "", stderr: "unknown option: pi" };
			return {
				code: 0,
				stdout: JSON.stringify({
					result: {
						tab: {
							tab_id: "w99:t2",
							workspace_id: "w99",
							label: args.includes("--label") ? args[args.indexOf("--label") + 1] : undefined,
						},
						root_pane: { pane_id: "w99:p2" },
					},
				}),
				stderr: "",
			};
		}
		if (sub === "tab" && action === "list") {
			const wsIdx = args.indexOf("--workspace");
			let tabs = state.tabs || [];
			if (wsIdx !== -1) tabs = tabs.filter((t) => (t.workspace_id || t.tab_id.split(":")[0]) === args[wsIdx + 1]);
			return { code: 0, stdout: JSON.stringify({ result: { tabs } }), stderr: "" };
		}
		if (sub === "tab" && action === "close") {
			if (state.failTabClose) return { code: 1, stdout: "", stderr: "tab close failed" };
			state.closedTabs = state.closedTabs || [];
			state.closedTabs.push(args[2]);
			state.tabs = (state.tabs || []).filter((t) => t.tab_id !== args[2]);
			return { code: 0, stdout: "{}", stderr: "" };
		}
		if (sub === "tab" && action === "focus") {
			if (state.failTabFocus) return { code: 1, stdout: "", stderr: "tab focus failed" };
			state.focusedTabs = state.focusedTabs || [];
			state.focusedTabs.push(args[2]);
			return { code: 0, stdout: "{}", stderr: "" };
		}

		if (sub === "pane" && action === "list") {
			const wsIdx = args.indexOf("--workspace");
			let panes = state.panes || [];
			if (wsIdx !== -1) panes = panes.filter((p) => (p.workspace_id || p.pane_id.split(":")[0]) === args[wsIdx + 1]);
			if (state.failPaneList) return { code: 1, stdout: "", stderr: "pane list failed" };
			return { code: 0, stdout: JSON.stringify({ result: { panes } }), stderr: "" };
		}
		if (sub === "pane" && action === "process-info") {
			const paneIdx = args.indexOf("--pane");
			const paneId = paneIdx !== -1 ? args[paneIdx + 1] : args[2];
			if (state.processInfoThrow) return { code: 1, stdout: "", stderr: "process-info exploded" };
			const info = (state.processInfo || {})[paneId];
			if (!info) return { code: 4, stdout: "", stderr: JSON.stringify({ error: { code: "pane_not_found" } }) };
			return { code: 0, stdout: JSON.stringify({ result: { process_info: info } }), stderr: "" };
		}
		if (sub === "pane" && action === "close") {
			if (state.failPaneClose) return { code: 1, stdout: "", stderr: "pane close failed" };
			state.closedPanes = state.closedPanes || [];
			state.closedPanes.push(args[2]);
			state.panes = (state.panes || []).filter((p) => p.pane_id !== args[2]);
			return { code: 0, stdout: "{}", stderr: "" };
		}
		if (sub === "pane" && action === "send-text") return { code: 0, stdout: "{}", stderr: "" };
		if (sub === "pane" && action === "send-keys") return { code: 0, stdout: "{}", stderr: "" };
		if (sub === "pane" && action === "read") {
			return { code: 0, stdout: JSON.stringify({ result: { text: state.readOutput || "" } }), stderr: "" };
		}
		if (sub === "pane" && action === "current") {
			if (state.currentPane === null) return { code: 1, stdout: "", stderr: "not in a pane" };
			return { code: 0, stdout: JSON.stringify(state.currentPane ? { result: { pane: state.currentPane } } : {}), stderr: "" };
		}
		return { code: 0, stdout: "{}", stderr: "" };
	};
	return { exec, calls, state };
}

const WS = [{ workspace_id: "w99", label: "swarm-agents", active_tab_id: "w99:t1" }];
const PANE_WORKER = { pane_id: "w99:p2", tab_id: "w99:t2", workspace_id: "w99" };
const PANE_FOREIGN = { pane_id: "w99:p9", tab_id: "w99:t9", workspace_id: "w99" };

// real 0.8.2 nested shape: root shell wrapper → leaf user command
const NESTED_PI = {
	foreground_processes: [
		{ name: "sh", pid: 100, cmdline: "sh -c wrapper" },
		{ name: "pi", pid: 101, cmdline: "pi --model m" },
	],
};
const NESTED_SHELL_LEAF = {
	foreground_processes: [
		{ name: "sh", pid: 200, cmdline: "sh -c wrapper" },
		{ name: "bash", pid: 201, cmdline: "bash" },
	],
};
const NESTED_STRING_PID = {
	foreground_processes: [
		{ name: "sh", pid: 1 },
		{ name: "node", pid: "4242" },
	],
};

console.log("=== 1. inspectProcess: real 0.8.2 nested foreground_processes[] ===");

await asyncTest("1.1 leaf pi under sh wrapper → piLike:true, leaf pid", async () => {
	const pi = createMockPi({ workspaces: WS, processInfo: { "w99:p2": NESTED_PI } });
	const d = new HerdrDriver("w99");
	const info = await d.inspectProcess(pi, "w99:p2");
	deepEqual(info, { piLike: true, command: "pi", pid: 101 });
});

await asyncTest("1.2 leaf bash under sh wrapper → piLike:false (wrapper must not mask leaf)", async () => {
	const pi = createMockPi({ workspaces: WS, processInfo: { "w99:p2": NESTED_SHELL_LEAF } });
	const d = new HerdrDriver("w99");
	const info = await d.inspectProcess(pi, "w99:p2");
	equal(info.piLike, false);
	equal(info.command, "bash");
});

await asyncTest("1.3 numeric-string pid is coerced", async () => {
	const pi = createMockPi({ workspaces: WS, processInfo: { "w99:p2": NESTED_STRING_PID } });
	const d = new HerdrDriver("w99");
	const info = await d.inspectProcess(pi, "w99:p2");
	equal(info.piLike, true);
	equal(info.command, "node");
	equal(info.pid, 4242);
});

await asyncTest("1.4 malformed/empty shape → piLike:false without throwing", async () => {
	const pi = createMockPi({ workspaces: WS, processInfo: { "w99:p2": {} } });
	const d = new HerdrDriver("w99");
	const info = await d.inspectProcess(pi, "w99:p2");
	equal(info.piLike, false);
});

await asyncTest("1.5 process-info nonzero exit → {piLike:false}, no throw", async () => {
	const pi = createMockPi({ workspaces: WS, processInfoThrow: true });
	const d = new HerdrDriver("w99");
	const info = await d.inspectProcess(pi, "w99:p2");
	deepEqual(info, { piLike: false, command: "" });
	const alive = await new HerdrDriver("w99").isTargetAlive(pi, "w99:p2");
	equal(alive, false);
});

await asyncTest("1.6 legacy scalar fallback shape still supported", async () => {
	const pi = createMockPi({ workspaces: WS, processInfo: { "w99:p2": { command: "node", pid: 7 } } });
	const d = new HerdrDriver("w99");
	const info = await d.inspectProcess(pi, "w99:p2");
	equal(info.piLike, true);
	equal(info.pid, 7);
});

await asyncTest("1.7 unknown pane (nonzero + pane_not_found) → piLike:false", async () => {
	const pi = createMockPi({ workspaces: WS, processInfo: {} });
	const d = new HerdrDriver("w99");
	const info = await d.inspectProcess(pi, "w99:pZZ");
	equal(info.piLike, false);
});

console.log("=== 2. detectCurrentPane variants ===");

await asyncTest("2.1 HERDR_PANE_ID env takes precedence and shapes the ref", async () => {
	const prev = { ...process.env };
	process.env.HERDR_PANE_ID = "w7:p5";
	process.env.HERDR_WORKSPACE_ID = "w7";
	process.env.HERDR_TAB_ID = "w7:t3";
	try {
		const pi = createMockPi({ currentPane: { pane_id: "w1:p1" } });
		const ref = await new HerdrDriver("w99").detectCurrentPane(pi);
		deepEqual(ref, { target: "w7:p5", paneId: "w7:p5", session: "w7", window: "w7:t3", pane: "w7:p5" });
		equal(pi.calls.length, 0, "env path must not exec herdr");
	} finally {
		for (const k of ["HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID"]) delete process.env[k];
		Object.assign(process.env, prev);
	}
});

await asyncTest("2.2 pane current --current JSON variants (result.pane / bare pane / none)", async () => {
	const prev = {
		HERDR_PANE_ID: process.env.HERDR_PANE_ID,
		HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
		HERDR_TAB_ID: process.env.HERDR_TAB_ID,
	};
	delete process.env.HERDR_PANE_ID;
	delete process.env.HERDR_WORKSPACE_ID;
	delete process.env.HERDR_TAB_ID;
	try {
		const d = new HerdrDriver("w99");
		const r1 = await d.detectCurrentPane(createMockPi({ currentPane: { pane_id: "w9:p1", workspace_id: "w9", tab_id: "w9:t1" } }));
		equal(r1.paneId, "w9:p1");
		const r2 = await d.detectCurrentPane({
			exec: async () => ({ code: 0, stdout: JSON.stringify({ pane_id: "w8:p2", tab_id: "w8:t2" }), stderr: "" }),
		});
		equal(r2.paneId, "w8:p2");
		const r3 = await d.detectCurrentPane(createMockPi({ currentPane: null }));
		equal(r3, null, "no pane_id in response → null");
	} finally {
		for (const k of ["HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID"]) delete process.env[k];
		for (const [k, v] of Object.entries(prev)) if (v !== undefined) process.env[k] = v;
	}
});

await asyncTest("2.3 pane current error → null (logged, not thrown)", async () => {
	const prev = process.env.HERDR_PANE_ID;
	delete process.env.HERDR_PANE_ID;
	try {
		const pi = {
			exec: async () => ({ code: 1, stdout: "", stderr: "pane current exploded" }),
		};
		const r = await new HerdrDriver("w99").detectCurrentPane(pi);
		equal(r, null);
	} finally {
		if (prev !== undefined) process.env.HERDR_PANE_ID = prev;
	}
});

console.log("=== 3. agents-workspace ensure / stale cache / create failure ===");

await asyncTest("3.1 existing label is reused without create", async () => {
	const pi = createMockPi({ workspaces: WS });
	const d = new HerdrDriver("w1");
	const ws = await d.ensureAgentsWorkspace(pi);
	equal(ws, "w99");
	assertOk(!pi.calls.some((c) => c.args[0] === "workspace" && c.args[1] === "create"), "no workspace create when label exists");
});

await asyncTest("3.2 stale cached workspace (workspace_not_found) → re-create", async () => {
	const pi = createMockPi({ workspaces: [], nextWsId: "w100" });
	const d = new HerdrDriver("w1");
	d.agentsWorkspaceId = "wGONE"; // stale cache: probe must 404 and re-create
	const ws = await d.ensureAgentsWorkspace(pi);
	equal(ws, "w100");
	const getCalls = pi.calls.filter((c) => c.args[0] === "workspace" && c.args[1] === "get");
	equal(getCalls.length, 1, "cache probe runs once");
	assertOk(
		pi.calls.some((c) => c.args[0] === "workspace" && c.args[1] === "create"),
		"stale cache triggers re-create",
	);
});

await asyncTest("3.3 non-404 probe failure → cache dropped, create still attempted", async () => {
	const pi = createMockPi({ workspaces: [], nextWsId: "w101", failWorkspaceGetOther: true });
	const d = new HerdrDriver("w1");
	d.agentsWorkspaceId = "wGONE";
	const ws = await d.ensureAgentsWorkspace(pi);
	equal(ws, "w101");
	assertOk(pi.calls.some((c) => c.args[0] === "workspace" && c.args[1] === "create"));
});

await asyncTest("3.4 workspace create returning no id → throws", async () => {
	const pi = createMockPi({ workspaces: [], failWorkspaceCreate: true });
	const d = new HerdrDriver("w1");
	await assertOk;
	let threw = false;
	try {
		await d.ensureAgentsWorkspace(pi);
	} catch {
		threw = true;
	}
	equal(threw, true, "create failure must surface as an error");
});

console.log("=== 4. killAgent fallback chain ===");

await asyncTest("4.1 pane close fails → tab close fallback succeeds", async () => {
	const pi = createMockPi({
		workspaces: WS,
		panes: [PANE_WORKER],
		failPaneClose: true,
		tabs: [{ tab_id: "w99:t2", workspace_id: "w99" }],
	});
	const d = new HerdrDriver("w1");
	d.agentsWorkspaceId = "w99";
	d.swarmPaneIds.add("w99:p2");
	d.everTrackedSwarmPanes = true;
	const res = await d.killAgent(pi, { target: "w99:p2", session: "w99", window: "w99:t2", paneId: "w99:p2" });
	equal(res.killed, true);
	equal(res.method, "tab-close");
	equal((pi.state.closedTabs || []).includes("w99:t2"), true);
});

await asyncTest("4.2 both close paths fail → killed:false, workspace NOT closed", async () => {
	const pi = createMockPi({
		workspaces: WS,
		panes: [PANE_WORKER],
		failPaneClose: true,
		failTabClose: true,
		tabs: [{ tab_id: "w99:t2", workspace_id: "w99" }],
	});
	const d = new HerdrDriver("w1");
	d.agentsWorkspaceId = "w99";
	d.swarmPaneIds.add("w99:p2");
	d.everTrackedSwarmPanes = true;
	const res = await d.killAgent(pi, { target: "w99:p2", session: "w99", window: "w99:t2", paneId: "w99:p2" });
	equal(res.killed, false);
	equal(res.method, "kill-failed");
	equal((pi.state.closedWorkspaces || []).length, 0, "failed kill must never close the agents workspace");
});

console.log("=== 5. H5 root-tab one-shot close ===");

await asyncTest("5.1 root tab closed after FIRST agent spawn only; close failure non-fatal", async () => {
	// happy one-shot
	const pi1 = createMockPi({
		workspaces: [],
		nextWsId: "w99",
		nextRootTabId: "w99:t1",
		panes: [],
		tabs: [{ tab_id: "w99:t1", workspace_id: "w99" }],
	});
	const d1 = new HerdrDriver("w1");
	await d1.spawnAgent(pi1, { session: "w1", window: "agent-a", command: "pi --model m" });
	assertOk((pi1.state.closedTabs || []).includes("w99:t1"), "first spawn closes the idle root tab");

	// second spawn: no second root-tab close
	const pi2 = createMockPi({ workspaces: [], nextWsId: "w99", nextRootTabId: "w99:t1" });
	const d2 = new HerdrDriver("w1");
	await d2.spawnAgent(pi2, { session: "w1", window: "agent-a", command: "pi --model m" });
	await d2.spawnAgent(pi2, { session: "w1", window: "agent-b", command: "pi --model m" });
	equal((pi2.state.closedTabs || []).filter((t) => t === "w99:t1").length, 1, "root tab closed exactly once");

	// failure is logged, spawn still returns success
	const pi3 = createMockPi({ workspaces: [], nextWsId: "w99", nextRootTabId: "w99:t1", failTabClose: true });
	const d3 = new HerdrDriver("w1");
	const r3 = await d3.spawnAgent(pi3, { session: "w1", window: "agent-a", command: "pi --model m" });
	assertOk(r3.target && r3.window, "spawn result intact despite root-tab close failure");
});

console.log("=== 6. tracked-vs-foreign teardown (maybeCloseAgentsWorkspace) ===");

await asyncTest(
	"6.1 two tracked panes + one foreign: first kill keeps ws, final kill closes it, foreign-only never triggers close",
	async () => {
		const state = {
			workspaces: [...WS],
			panes: [PANE_WORKER, { ...PANE_FOREIGN }, { pane_id: "w99:p3", tab_id: "w99:t3", workspace_id: "w99" }],
		};
		const pi = createMockPi(state);
		const d = new HerdrDriver("w1");
		d.agentsWorkspaceId = "w99";
		d.swarmPaneIds.add("w99:p2");
		d.everTrackedSwarmPanes = true;
		d.swarmPaneIds.add("w99:p3");
		d.everTrackedSwarmPanes = true;

		const r1 = await d.killAgent(pi, { target: "w99:p2", session: "w99", window: "w99:t2", paneId: "w99:p2" });
		equal(r1.killed, true);
		equal((state.closedWorkspaces || []).length, 0, "workspace survives while another tracked agent remains");

		const r2 = await d.killAgent(pi, { target: "w99:p3", session: "w99", window: "w99:t3", paneId: "w99:p3" });
		equal(r2.killed, true);
		deepEqual(state.closedWorkspaces || [], ["w99"], "workspace closed after final tracked pane dies");

		// foreign-only pane state must NOT trigger close: fresh driver that tracked nothing
		const state2 = { workspaces: [...WS], panes: [{ ...PANE_FOREIGN }] };
		const pi2 = createMockPi(state2);
		const d2 = new HerdrDriver("w1");
		d2.agentsWorkspaceId = "w99";
		await d2.killAgent(pi2, { target: "w99:p9", session: "w99", window: "w99:t9", paneId: "w99:p9" });
		equal((state2.closedWorkspaces || []).length, 0, "foreign-only pane never triggers workspace close");
	},
);

await asyncTest("6.2 stale tracked ids pruned via pane list intersection", async () => {
	const state = { workspaces: [...WS], panes: [PANE_WORKER] };
	const pi = createMockPi(state);
	const d = new HerdrDriver("w1");
	d.agentsWorkspaceId = "w99";
	d.swarmPaneIds.add("w99:p2");
	d.everTrackedSwarmPanes = true;
	d.swarmPaneIds.add("w99:pGONE"); // no longer exists
	await d.maybeCloseAgentsWorkspace(pi);
	equal((state.closedWorkspaces || []).length, 0, "w99:p2 still alive → ws stays");
});

await asyncTest("6.3 workspace-not-found during teardown is swallowed as expected branch, no close attempt", async () => {
	const state = { workspaces: [], failPaneList: true, paneListErr: "workspace_not_found" };
	const pi = createMockPi(state);
	const d = new HerdrDriver("w1");
	d.agentsWorkspaceId = "w99";
	d.swarmPaneIds.add("w99:p2");
	d.everTrackedSwarmPanes = true;
	await d.maybeCloseAgentsWorkspace(pi);
	equal((state.closedWorkspaces || []).length, 0);
});

console.log("=== 7. focusWindow fail-closed mismatch ===");

await asyncTest("7.1 pane workspace vs claimed session mismatch → ok:false, zero tab focus", async () => {
	const pi = createMockPi({ workspaces: WS, panes: [PANE_WORKER] });
	const d = new HerdrDriver("w1");
	// window value is NOT a herdr tab id → forces pane-resolution path with the mismatch guard
	const res = await d.focusWindow(pi, { target: "w99:p2", session: "wOTHER", window: "p2", paneId: "w99:p2" });
	equal(res.ok, false);
	assertOk((res.error || "").includes("does not belong"), `mismatch error surfaced: ${res.error}`);
	equal((pi.state.focusedTabs || []).length, 0, "no tab focus executed");
});

await asyncTest("7.2 pane with no owning tab → ok:false", async () => {
	const pi = createMockPi({ workspaces: WS, panes: [] }); // pane list empty → no owning tab
	const d = new HerdrDriver("w1");
	const res = await d.focusWindow(pi, { target: "w99:p2", session: "w99", window: "p2", paneId: "w99:p2" });
	equal(res.ok, false);
	assertOk((res.error || "").includes("no owning tab"), res.error);
});

await asyncTest("7.3 unknown/empty target → ok:false without exec", async () => {
	const pi = createMockPi({ workspaces: WS });
	const d = new HerdrDriver("w1");
	const r1 = await d.focusWindow(pi, { target: "unknown", session: "w99", window: "unknown" });
	const r2 = await d.focusWindow(pi, "");
	equal(r1.ok, false);
	equal(r2.ok, false);
	equal(pi.calls.length, 0);
});

console.log("=== 8. getFocusStatus branches ===");

await asyncTest("8.1 empty tabs → alive, no fabricated focus", async () => {
	const pi = createMockPi({ workspaces: WS, tabs: [] });
	const d = new HerdrDriver("w1");
	const st = await d.getFocusStatus(pi, "w99");
	equal(st.sessionAlive, true);
	equal(st.activeWindowIndex, undefined);
	equal(st.activeWindowName, undefined);
});

await asyncTest("8.2 tabs but none focused → alive, no fabricated focus", async () => {
	const pi = createMockPi({ workspaces: WS, tabs: [{ tab_id: "w99:t1", workspace_id: "w99", focused: false }] });
	const d = new HerdrDriver("w1");
	const st = await d.getFocusStatus(pi, "w99");
	equal(st.sessionAlive, true);
	equal(st.activeWindowIndex, undefined);
});

await asyncTest("8.3 focused tab fields mapped", async () => {
	const pi = createMockPi({
		workspaces: WS,
		tabs: [{ tab_id: "w99:t2", label: "worker-a", workspace_id: "w99", focused: true, root_pane_id: "w99:p2" }],
	});
	const d = new HerdrDriver("w1");
	const st = await d.getFocusStatus(pi, "w99");
	equal(st.activeWindowIndex, "w99:t2");
	equal(st.activeWindowName, "worker-a");
	equal(st.activePaneId, "w99:p2");
});

await asyncTest("8.4 malformed response → sessionAlive:false (error branch)", async () => {
	const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "tab list exploded" }) };
	const d = new HerdrDriver("w1");
	const st = await d.getFocusStatus(pi, "w99");
	equal(st.sessionAlive, false);
});

await asyncTest("8.5 label resolves to workspace id before tab list", async () => {
	const pi = createMockPi({
		workspaces: [...WS, { workspace_id: "w88", label: "my-label" }],
		tabs: [{ tab_id: "w88:t1", workspace_id: "w88", focused: true }],
	});
	const d = new HerdrDriver("w1");
	const st = await d.getFocusStatus(pi, "my-label");
	equal(st.session, "w88");
	equal(st.activeWindowIndex, "w88:t1");
});

console.log("=== 9. getAttachCommands / isSameTarget / keys ===");

test("9.1 getAttachCommands string target", () => {
	const d = new HerdrDriver("w99");
	const c = d.getAttachCommands("w99:p2");
	equal(c.session, "");
	equal(c.windowTarget, "w99:p2");
	equal(c.paneTarget, "w99:p2");
	equal(c.attach, "herdr");
	equal(c.selectWindow, "herdr tab focus w99:p2");
	equal(c.selectPane, "herdr pane focus w99:p2");
});

test("9.2 getAttachCommands TerminalTargetRef", () => {
	const d = new HerdrDriver("w99");
	const c = d.getAttachCommands({ target: "w99:p2", session: "w99", window: "w99:t2", paneId: "w99:p2" });
	equal(c.session, "w99");
	equal(c.windowTarget, "w99:t2");
	equal(c.paneTarget, "w99:p2");
	equal(c.selectWindow, "herdr tab focus w99:t2");
});

test("9.3 isSameTarget exact, case-fold, empty", () => {
	const d = new HerdrDriver();
	equal(d.isSameTarget("wK:p2", "wK:p2"), true);
	equal(d.isSameTarget("WK:P2", "wK:p2"), true);
	equal(d.isSameTarget("wK:p2", "wK:p3"), false);
	equal(d.isSameTarget("", "wK:p2"), false);
	equal(d.isSameTarget("wK:p2", ""), false);
});

test("9.4 key translation tokens", () => {
	equal(translateTmuxKeyToHerdr("C-c"), "ctrl+c");
	equal(translateTmuxKeyToHerdr("M-x"), "alt+x");
	equal(translateTmuxKeyToHerdr("Escape"), "esc");
	equal(translateTmuxKeyToHerdr("Up"), "up");
	equal(translateTmuxKeyToHerdr("literal"), "literal");
});

test("9.5 isPiLikeProcess shells vs agents", () => {
	equal(isPiLikeProcess("bash"), false);
	equal(isPiLikeProcess("-zsh"), false);
	equal(isPiLikeProcess("/usr/bin/pi"), true);
	equal(isPiLikeProcess(""), false);
});

await asyncTest("9.6 sendKeys invalid target throws; translated keys routed per token", async () => {
	const pi = createMockPi({ workspaces: WS });
	const d = new HerdrDriver("w99");
	let threw = false;
	try {
		await d.sendKeys(pi, "unknown", "C-c");
	} catch (e) {
		threw = true;
	}
	equal(threw, true, "sendKeys('unknown') must throw");
	await d.sendKeys(pi, "w99:p2", "C-c Up", {});
	const keyCalls = pi.calls.filter((c) => c.args[1] === "send-keys");
	equal(keyCalls.length, 2);
	equal(keyCalls[0].args[2], "w99:p2");
	equal(keyCalls[0].args[3], "ctrl+c");
	equal(keyCalls[1].args[3], "up");
});

console.log("=== 10. helper export sanity (getAttachCommands shape) ===");

test("10.1 getAttachCommandsShapeProbe returns herdr attach", () => {
	const d = new HerdrDriver("w99");
	equal(getAttachCommandsShapeProbe(d, "w99:p2").attach, "herdr");
});

test("10.2 corrupt swarm.yml defaults to tmux and environment still takes precedence", () => {
	const previousCwd = process.cwd();
	const previousManager = process.env.PI_SWARM_TERMINAL_MANAGER;
	const scratch = mkdtempSync(join(tmpdir(), "herdr-corrupt-config-"));
	try {
		mkdirSync(join(scratch, ".pi"), { recursive: true });
		writeFileSync(join(scratch, ".pi", "swarm.yml"), "terminalManager: [unterminated\n");
		process.chdir(scratch); // cfg memo is keyed by cwd; this gets a fresh corrupt-config read.
		delete process.env.PI_SWARM_TERMINAL_MANAGER;
		const fallback = getTerminalDriver(); // no explicit cfg: corrupt config must not throw.
		equal(fallback, tmuxDriver, "corrupt config with env unset falls back to tmux");

		process.env.PI_SWARM_TERMINAL_MANAGER = "herdr";
		equal(getTerminalDriver().id, "herdr", "environment override wins despite corrupt config");
	} finally {
		process.chdir(previousCwd);
		if (previousManager === undefined) delete process.env.PI_SWARM_TERMINAL_MANAGER;
		else process.env.PI_SWARM_TERMINAL_MANAGER = previousManager;
		rmSync(scratch, { recursive: true, force: true });
	}
});

if (fail > 0) process.exit(1);

console.log(`\nherdr-audit-gap-branches: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
