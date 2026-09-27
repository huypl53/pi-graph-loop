// === herdr-auto-focus-cross-workspace.test.mjs — Regression for task-202609270024-fix-herdr-auto-focus-foc ===
//
// RED→GREEN coverage for the Herdr busy-path cross-workspace guard in maybeAutoFocusOnBusy.
// The guard skips with reason "user-focused-outside-agents-workspace" when the user's
// current global Herdr focus is in a different workspace than the target agents workspace,
// unless `force` or `bypassActiveGuard` authorizes the operation. Tmux behavior is unchanged.
//
// Boundary counter at the REAL pi.exec seam (R10-1): under herdr mode, the guard must
// produce ZERO `herdr tab focus` calls when the user is outside the agents workspace.

import { strictEqual, ok, deepEqual } from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";

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

function fakePi({ herdrTabList, herdrWorkspaceList, tmuxDisplayMessage, herdrTabListThrows = false } = {}) {
	const execs = [];
	return {
		execs,
		api: {
			exec: async (bin, args, opts) => {
				execs.push({ bin, args, opts });
				if (bin === "herdr") {
					const cmd = args.join(" ");
					if (cmd === "tab list") {
						if (herdrTabListThrows) {
							return { code: 1, stdout: "", stderr: "herdr tab list failed" };
						}
						return { code: 0, stdout: JSON.stringify({ result: { tabs: herdrTabList || [] } }), stderr: "" };
					}
					if (cmd === "workspace list") {
						return { code: 0, stdout: JSON.stringify({ result: { workspaces: herdrWorkspaceList || [] } }), stderr: "" };
					}
					if (cmd.startsWith("pane list")) {
						return { code: 0, stdout: JSON.stringify({ result: { panes: [] } }), stderr: "" };
					}
					if (cmd.startsWith("tab focus")) {
						return { code: 0, stdout: JSON.stringify({ result: { status: "ok" } }), stderr: "" };
					}
					return { code: 0, stdout: "{}", stderr: "" };
				}
				if (bin === "tmux") {
					const cmd = args.join(" ");
					if (cmd.includes("display-message")) {
						return { code: 0, stdout: tmuxDisplayMessage || "sess\t0\t%0\n", stderr: "" };
					}
					if (cmd.startsWith("select-window")) {
						return { code: 0, stdout: "", stderr: "" };
					}
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		},
	};
}

const count = (execs, bin, predicate) => execs.filter((e) => e.bin === bin && (!predicate || predicate(e))).length;

const baseState = (scratch, agentsWsId, agentsTabId, agentsPaneId) => ({
	version: 1,
	swarmId: "af-test",
	cwd: scratch,
	tmuxSession: agentsWsId,
	autoFocusBusy: true,
	agents: {
		"af-worker": {
			id: "af-worker",
			role: "worker",
			roleKind: "worker",
			status: "running",
			runtimeStatus: "busy",
			tmuxSession: agentsWsId,
			tmuxWindow: agentsTabId,
			tmuxTarget: agentsPaneId,
			lastAgentStartAt: new Date().toISOString(),
		},
	},
	delivered: {},
	messages: {},
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
});

const prevMgr = process.env.PI_SWARM_TERMINAL_MANAGER;
const setMgr = (m) => (process.env.PI_SWARM_TERMINAL_MANAGER = m);

console.log("=== Herdr cross-workspace guard: busy path ===");

await asyncTest("RED→GREEN: herdr + user focused outside agents workspace → skip with distinct reason, 0 tab focus calls", async () => {
	const scratch = join(tmpdir(), `swarm-af-guard-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	const p = paths(scratch);
	const agentsWsId = "wA";
	const agentsTabId = "wA:t1";
	const agentsPaneId = "wA:p1";
	const userWsId = "wU";
	await writeState(p, baseState(scratch, agentsWsId, agentsTabId, agentsPaneId));

	const { api, execs } = fakePi({
		herdrTabList: [
			{ tab_id: agentsTabId, workspace_id: agentsWsId, label: "af-worker", focused: false },
			{ tab_id: "wU:t1", workspace_id: userWsId, label: "user-tab", focused: true },
		],
	});
	setMgr("herdr");
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	strictEqual(res.switched, false, "must not switch when user is outside agents workspace");
	strictEqual(res.reason, "user-focused-outside-agents-workspace", `reason must be the stable distinct skip reason, got: ${res.reason}`);
	strictEqual(res.targetAgentId, "af-worker", "targetAgentId should still be reported for diagnostics");
	strictEqual(
		count(execs, "herdr", (e) => e.args[0] === "tab" && e.args[1] === "focus"),
		0,
		"ZERO herdr tab focus calls at pi.exec seam",
	);
	rmSync(scratch, { recursive: true, force: true });
});

await asyncTest("GREEN: herdr + user already in agents workspace → normal busy auto-focus proceeds", async () => {
	const scratch = join(tmpdir(), `swarm-af-guard-2-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	const p = paths(scratch);
	const agentsWsId = "wA";
	const agentsTabId = "wA:t1";
	const agentsPaneId = "wA:p1";
	await writeState(p, baseState(scratch, agentsWsId, agentsTabId, agentsPaneId));

	const { api, execs } = fakePi({
		herdrTabList: [{ tab_id: agentsTabId, workspace_id: agentsWsId, label: "af-worker", focused: true }],
	});
	setMgr("herdr");
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	strictEqual(res.switched, true, "must switch when user is already in agents workspace");
	strictEqual(res.reason, "ok");
	ok(count(execs, "herdr", (e) => e.args[0] === "tab" && e.args[1] === "focus") >= 1, "herdr tab focus call expected");
	rmSync(scratch, { recursive: true, force: true });
});

await asyncTest("GREEN: herdr + force option bypasses cross-workspace guard", async () => {
	const scratch = join(tmpdir(), `swarm-af-guard-3-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	const p = paths(scratch);
	const agentsWsId = "wA";
	const agentsTabId = "wA:t1";
	const agentsPaneId = "wA:p1";
	const userWsId = "wU";
	await writeState(p, baseState(scratch, agentsWsId, agentsTabId, agentsPaneId));

	const { api, execs } = fakePi({
		herdrTabList: [
			{ tab_id: agentsTabId, workspace_id: agentsWsId, label: "af-worker", focused: false },
			{ tab_id: "wU:t1", workspace_id: userWsId, label: "user-tab", focused: true },
		],
	});
	setMgr("herdr");
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker", { force: true });
	strictEqual(res.switched, true, "force must bypass the cross-workspace guard");
	strictEqual(res.reason, "ok");
	ok(count(execs, "herdr", (e) => e.args[0] === "tab" && e.args[1] === "focus") >= 1, "herdr tab focus call expected under force");
	rmSync(scratch, { recursive: true, force: true });
});

await asyncTest("GREEN: herdr + bypassActiveGuard option bypasses cross-workspace guard", async () => {
	const scratch = join(tmpdir(), `swarm-af-guard-4-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	const p = paths(scratch);
	const agentsWsId = "wA";
	const agentsTabId = "wA:t1";
	const agentsPaneId = "wA:p1";
	const userWsId = "wU";
	await writeState(p, baseState(scratch, agentsWsId, agentsTabId, agentsPaneId));

	const { api, execs } = fakePi({
		herdrTabList: [
			{ tab_id: agentsTabId, workspace_id: agentsWsId, label: "af-worker", focused: false },
			{ tab_id: "wU:t1", workspace_id: userWsId, label: "user-tab", focused: true },
		],
	});
	setMgr("herdr");
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker", { bypassActiveGuard: true });
	strictEqual(res.switched, true, "bypassActiveGuard must bypass the cross-workspace guard");
	strictEqual(res.reason, "ok");
	ok(
		count(execs, "herdr", (e) => e.args[0] === "tab" && e.args[1] === "focus") >= 1,
		"herdr tab focus call expected under bypassActiveGuard",
	);
	rmSync(scratch, { recursive: true, force: true });
});

await asyncTest("GREEN: herdr + getFocusedWorkspaceId query failure → fail-open (logged durably, focus proceeds)", async () => {
	const scratch = join(tmpdir(), `swarm-af-guard-5-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	const p = paths(scratch);
	const agentsWsId = "wA";
	const agentsTabId = "wA:t1";
	const agentsPaneId = "wA:p1";
	await writeState(p, baseState(scratch, agentsWsId, agentsTabId, agentsPaneId));

	// herdr tab list throws → getFocusedWorkspaceId logs error + returns undefined → guard fails open.
	const { api, execs } = fakePi({ herdrTabListThrows: true });
	setMgr("herdr");
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	strictEqual(res.switched, true, "fail-open: query failure must not silently swallow the busy-path focus");
	strictEqual(res.reason, "ok");
	ok(count(execs, "herdr", (e) => e.args[0] === "tab" && e.args[1] === "focus") >= 1, "herdr tab focus call expected on fail-open");
	// Durable error log written
	const errFile = join(scratch, ".pi", "swarm", "traces", "errors.jsonl");
	ok(existsSync(errFile), "durable error log must be written on query failure");
	rmSync(scratch, { recursive: true, force: true });
});

console.log("\n=== Tmux path unaffected: guard is a no-op under tmux ===");

await asyncTest("GREEN: tmux + user on different window → busy path proceeds (guard is a no-op under tmux)", async () => {
	const scratch = join(tmpdir(), `swarm-af-guard-tmux-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	const p = paths(scratch);
	const agentsWsId = "sess";
	const agentsTabId = "worker-a";
	const agentsPaneId = "sess:worker-a.0";
	await writeState(p, baseState(scratch, agentsWsId, agentsTabId, agentsPaneId));

	// tmux display-message returns a different window. The busy path (maybeAutoFocusOnBusy)
	// does NOT have an active_window_mismatch guard — that lives in the settle path
	// (maybeAutoFocusBusyAgent). Under tmux, the cross-workspace guard is a no-op
	// (driver.id !== "herdr"), so the busy path proceeds to focusAgentWindow.
	process.env.TMUX = "1";
	const { api, execs } = fakePi({
		tmuxDisplayMessage: "other-window\t5\t%99\n",
	});
	setMgr("tmux");
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	strictEqual(res.switched, true, "tmux busy path must remain unchanged (no cross-workspace guard)");
	strictEqual(res.reason, "ok");
	ok(count(execs, "tmux", (e) => e.args[0] === "select-window") >= 1, "tmux select-window call expected");
	strictEqual(count(execs, "herdr"), 0, "ZERO herdr execs under tmux");
	rmSync(scratch, { recursive: true, force: true });
	delete process.env.TMUX;
});

await asyncTest("GREEN: tmux + user on matching window → normal busy auto-focus proceeds (guard does not interfere)", async () => {
	const scratch = join(tmpdir(), `swarm-af-guard-tmux-2-${process.pid}-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	const p = paths(scratch);
	const agentsWsId = "sess";
	const agentsTabId = "af-worker";
	const agentsPaneId = "sess:af-worker.0";
	await writeState(p, baseState(scratch, agentsWsId, agentsTabId, agentsPaneId));

	process.env.TMUX = "1";
	const { api, execs } = fakePi({
		tmuxDisplayMessage: "af-worker\t0\t%0\n",
	});
	setMgr("tmux");
	const res = await maybeAutoFocusOnBusy(api, { cwd: scratch }, "af-worker");
	strictEqual(res.switched, true, "tmux path must remain unchanged when active window matches");
	strictEqual(res.reason, "ok");
	ok(count(execs, "tmux", (e) => e.args[0] === "select-window") >= 1, "tmux select-window call expected");
	strictEqual(count(execs, "herdr"), 0, "ZERO herdr execs under tmux");
	rmSync(scratch, { recursive: true, force: true });
	delete process.env.TMUX;
});

setMgr(prevMgr);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
