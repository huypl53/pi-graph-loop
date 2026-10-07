#!/usr/bin/env node
/**
 * Per-fixture scenario driver — extensions/mock-llm/fixtures/herdr-shared-workspace-teardown.jsonl
 *
 * task-fu-herdr-workspace-loss: shared-workspace teardown regression (H1, T1-T3).
 *
 * Reproduces the 6-incident workspace-loss pattern (wV, wW, wX, wY, wZ, w11 + the
 * w13-w17 close storm; see
 * .pi/swarm/tasks/task-fu-herdr-workspace-loss/artifacts/diagnosis.md) in deterministic
 * reduced form: TWO concurrent driver instances (a main-checkout root and a worktree
 * root) share ONE `swarm-agents` herdr workspace. Each driver tracks ONLY its own
 * spawned panes (per-instance `swarmPaneIds`), but the workspace is a process-global
 * singleton matched by label. When driver A retires its last agent,
 * `maybeCloseAgentsWorkspace` must consult the AUTHORITATIVE workspace-wide pane count
 * (live `herdr pane list --workspace`) — not A's own tracked-subset emptiness — before
 * closing, or B's live panes get Hangup-killed by the close (the herdr-server signature:
 * `cli:workspace:close` followed by victim `pane.exit signal=Hangup` within ms).
 *
 * T1 (cross-tenant teardown): A kills its pane while B's pane lives → the workspace
 *     MUST SURVIVE; a close here is the 6-incident RED artifact (co-tenant kill).
 * T2 (prune-race confirmation re-probe): a mid-flight-spawn pane pops into the
 *     workspace between the first cold reading and the close decision → the
 *     confirmation re-probe must veto a premature close (single cold reading saw 0).
 * T3 (R10-1 boundary count): `workspace close` invocations are counted at the REAL
 *     pi.exec boundary; the driver may close ONLY when the authoritative live pane
 *     census is zero twice consecutively, never while >=1 pane remains.
 *
 * RED/GREEN mode: with UAT_RED=1 the suite reduces the scenario to the pre-fix RED
 * observation — A retiring its own-last pane MUST NOT close the shared workspace while
 * B's pane is alive; RED mode asserts the CURRENT (buggy) behavior is a documented
 * artifact (the close is observed + co-tenant pane killed), GREEN mode enforces the
 * fixed invariant (close happens ONLY when the authoritative census + confirmation
 * re-probe agree on zero).
 *
 * Run: node extensions/swarm/tests/herdr-shared-workspace-teardown.test.mjs
 */

import { equal, ok as assertOk } from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RED = process.env.UAT_RED === "1";

// ------------------------------------------- scratch tree (cwd-sensitive writers) ---------
const scratch = mkdtempSync(join(tmpdir(), `herdr-shared-ws-${process.pid}-${Date.now()}`));
mkdirSync(join(scratch, ".pi", "swarm", "traces"), { recursive: true });

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info ?? "");
	}
};

// Error-sink oracle: per no-silent-swallow mandate every catch path routes to
// logSwarmError → .pi/swarm/traces/errors.jsonl. Hand the driver a REAL scratch cwd.
// (production sources `paths()` once at module level; tests chdir before import).
process.chdir(scratch);
const { HerdrDriver } = await import("../src/terminal/drivers/herdr.ts");

const safe = async (name, fn) => {
	try {
		await fn();
		pass++;
		console.log("  ok  ", name);
	} catch (err) {
		fail++;
		console.error("  FAIL", name, err?.message || err);
	}
};
const assertEq = async (name, fn) => {
	try {
		await fn();
		pass++;
		console.log("  ok  ", name);
	} catch (err) {
		fail++;
		console.error("  FAIL", name, err?.message || err);
	}
};

const closeCalls = (pi) => pi.calls.filter((a) => a[0] === "workspace" && a[1] === "close");

// ------------------------- fake herdr 0.8.2 server (one shared reality) ---------------------
function createSharedHerdrServer(state = {}) {
	const calls = [];
	state.__seq = { tab: 0, pane: 0, listProbe: 0 };
	const exec = async (cmd, args) => {
		if (cmd !== "herdr") return { code: 1, stdout: "", stderr: `unknown command: ${cmd}` };
		calls.push(args);
		const [sub, action] = args;
		if (sub === "--version") return { code: 0, stdout: "herdr 0.8.2\n", stderr: "" };
		if (sub === "workspace" && action === "list") {
			return { code: 0, stdout: JSON.stringify({ result: { workspaces: state.workspaces || [] } }), stderr: "" };
		}
		if (sub === "workspace" && action === "get") {
			const wsId = args[2];
			const ws = (state.workspaces || []).find((w) => w.workspace_id === wsId);
			if (!ws) return { code: 3, stdout: "", stderr: JSON.stringify({ error: { code: "workspace_not_found" } }) };
			return { code: 0, stdout: JSON.stringify({ result: { workspace: ws } }), stderr: "" };
		}
		if (sub === "workspace" && action === "create") {
			const labelIdx = args.indexOf("--label");
			const label = labelIdx !== -1 ? args[labelIdx + 1] : "swarm-agents";
			const ws = { workspace_id: `w${label.length}${state.__seq.wsn++}`, label, active_tab_id: null };
			state.workspaces = state.workspaces || [];
			state.workspaces.push(ws);
			return { code: 0, stdout: JSON.stringify({ result: { workspace: ws } }), stderr: "" };
		}
		if (sub === "workspace" && action === "close") {
			const wsId = args[2];
			const survivors = (state.panes || []).filter((p) => p.workspace_id === wsId);
			state.closedWorkspaces = state.closedWorkspaces || [];
			state.closedWorkspaces.push({ wsId, livePaneCountAtClose: survivors.length, atCall: calls.length });
			state.workspaces = (state.workspaces || []).filter((w) => w.workspace_id !== wsId);
			// Hangup semantics: every still-live pane in the closed workspace dies with it.
			state.panes = (state.panes || []).filter((p) => p.workspace_id !== wsId);
			return { code: 0, stdout: "{}", stderr: "" };
		}
		if (sub === "tab" && action === "create") {
			const wsIdx = args.indexOf("--workspace");
			const wsId = wsIdx !== -1 ? args[wsIdx + 1] : "?";
			const labelIdx = args.indexOf("--label");
			const tabId = `${wsId}:t${++state.__seq.tab}`;
			const paneId = `${wsId}:p${++state.__seq.pane}`;
			state.tabs = state.tabs || [];
			state.panes = state.panes || [];
			state.tabs.push({ tab_id: tabId, workspace_id: wsId });
			state.panes.push({
				pane_id: paneId,
				tab_id: tabId,
				workspace_id: wsId,
				spawnedBy: labelIdx !== -1 ? args[labelIdx + 1] : null,
			});
			return {
				code: 0,
				stdout: JSON.stringify({ result: { tab: { tab_id: tabId, workspace_id: wsId }, root_pane: { pane_id: paneId } } }),
				stderr: "",
			};
		}
		if (sub === "tab" && action === "close") {
			state.closedTabs = state.closedTabs || [];
			state.closedTabs.push(args[2]);
			state.tabs = (state.tabs || []).filter((t) => t.tab_id !== args[2]);
			return { code: 0, stdout: "{}", stderr: "" };
		}
		if (sub === "pane" && action === "list") {
			const wsIdx = args.indexOf("--workspace");
			const wsId = wsIdx !== -1 ? args[wsIdx + 1] : undefined;
			let panes = wsId ? (state.panes || []).filter((p) => p.workspace_id === wsId) : state.panes || [];
			// T2 race hook: a probe callback may rewrite the enumerator's view (mid-flight
			// spawns, stale snapshots). Returning a NEW array leaves state.panes untouched.
			if (state.onPaneList) panes = state.onPaneList(++state.__seq.listProbe, panes, wsId) || panes;
			return { code: 0, stdout: JSON.stringify({ result: { panes } }), stderr: "" };
		}
		if (sub === "pane" && action === "close") {
			state.closedPanes = state.closedPanes || [];
			state.closedPanes.push(args[2]);
			state.panes = (state.panes || []).filter((p) => p.pane_id !== args[2]);
			return { code: 0, stdout: "{}", stderr: "" };
		}
		if (sub === "pane" && action === "process-info") {
			const paneIdx = args.indexOf("--pane");
			const paneId = paneIdx !== -1 ? args[paneIdx + 1] : args[2];
			return {
				code: 0,
				stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "pi", pid: 1 }] } } }),
				stderr: "",
			};
		}
		return { code: 0, stdout: "{}", stderr: "" };
	};
	return { exec, calls, state };
}

const spinUp = (state) => createSharedHerdrServer(Object.assign({ __seq: { tab: 0, pane: 0, wsn: 9 } }, state));

// -------
// RED-seam: reproduce the PRE-FIX close criterion (close when this driver's own
// tracked-set is empty) against the SAME public killAgent boundary. The pre-fix
// `maybeCloseAgentsWorkspace` decided from `swarmPaneIds` (own-set emptiness); the
// fixed production code decides from the authoritative live census + confirmation
// re-probe. Agents may die from incoming EnemyFireEvent. This seam lets RED mode
// observe the 6-incident Hangup-kill signature (close with live co-tenants) —
// structurally identical to the pre-fix source at git HEAD~ (see diagnosis.md).
class PreFixSeamDriver extends HerdrDriver {
	constructor(workspaceId) {
		super(workspaceId);
	}
	async maybeCloseAgentsWorkspace(pi) {
		if (!this.agentsWorkspaceId) return;
		if (!this.everTrackedSwarmPanes) return;
		let wsPanes = [];
		try {
			const list = await this.herdrJson(pi, ["pane", "list", "--workspace", this.agentsWorkspaceId], 5_000);
			const rawList = Array.isArray(list?.result?.panes) ? list.result.panes : [];
			wsPanes = rawList.map((p) => p?.pane_id || p?.paneId).filter(Boolean);
		} catch (err) {
			return; // pre-fix: any list failure aborted teardown
		}
		const stillAlive = new Set();
		for (const paneId of this.swarmPaneIds) {
			if (wsPanes.includes(paneId)) stillAlive.add(paneId);
		}
		this.swarmPaneIds.clear();
		for (const id of stillAlive) this.swarmPaneIds.add(id);
		// ===== THE PRE-FIX CRITERION (the bug): own-set emptiness alone =====
		if (this.swarmPaneIds.size > 0) return;
		try {
			await this.herdr(pi, ["workspace", "close", this.agentsWorkspaceId], 5_000);
			this.agentsWorkspaceId = undefined;
		} catch {
			/* pre-fix swallow shape */
		}
	}
}

// Begin scenario — stream fixture + assert T1.

// =============================================================================================
// T1 — cross-tenant teardown: A retires its last agent while B's pane is live.
// =============================================================================================
await safe("T1 whole-block", async () => {
	console.log("=== T1: shared-workspace cross-tenant teardown (RED: workspace killed) ===");
	const srv = spinUp({
		workspaces: [
			{ workspace_id: "w1", label: "main", active_tab_id: "w1:t1" },
			{ workspace_id: "w99", label: "swarm-agents", active_tab_id: "w99:t1" },
		],
		tabs: [],
		panes: [],
	});

	// ONE shared herdr server = ONE herdr process. TWO drivers = session A (main root)
	// + session B (worktree root). The shared-workspace-by-label is the production state
	// observed across all 6 incidents (diagnosis.md §E1-E4).
	const mkDriver = () => (RED ? new PreFixSeamDriver("w1") : new HerdrDriver("w1"));
	const driverA = mkDriver();
	const driverB = mkDriver();
	// Same Label workspaces: force both drivers onto the SAME shared workspace 99:
	Object.defineProperty(driverA, "agentsWorkspaceId", { value: "w99", writable: true });
	Object.defineProperty(driverB, "agentsWorkspaceId", { value: "w99", writable: true });

	const ra = await driverA.spawnAgent(srv, { session: "w1", window: "agent-a", command: "pi --agent a", cwd: scratch });
	const rb = await driverB.spawnAgent(srv, { session: "w1", window: "agent-b", command: "pi --agent b", cwd: scratch });
	ok("T1 setup: both agents alive in shared workspace", srv.state.panes.length === 2, `panes=${srv.state.panes.length}`);
	ok("T1 setup: both agents share one workspace id", ra.session === rb.session, `${ra.session} != ${rb.session}`);
	equal(srv.state.panes.find((p) => p.pane_id === ra.target)?.spawnedBy, "agent-a", "A pane collocates with B in w99");

	// A retires its own agent. B's pane (rb.target) is ALIVE and UNRELATED to A.
	const kill = await driverA.killAgent(srv, { target: ra.target, session: ra.session, window: ra.window, paneId: ra.target });
	ok("T1: A's own pane killed", kill.killed);

	if (RED) {
		// Pre-fix observation: A's OWN tracked set is now empty → teardown DID close the
		// shared workspace and Hangup-killed B's live pane. Document the wrong behavior.
		const guiltyClose = srv.state.closedWorkspaces?.find((c) => c.livePaneCountAtClose > 0);
		ok("T1 (RED): shared workspace was closed while co-tenant pane live", Boolean(guiltyClose));
		ok("T1 (RED): co-tenant pane was Hangup-killed by the close", !srv.state.panes.some((p) => p.pane_id === rb.target));
	} else {
		// Post-fix invariant: A's own-set emptiness does NOT justify closing a shared
		// workspace: B's pane still lives in it. Workspace SURVIVES with B intact.
		equal(closeCalls(srv).length, 0, "workspace close forbidden while co-tenant pane is live");
		ok(
			"T1: B's pane survives A's teardown",
			srv.state.panes.some((p) => p.pane_id === rb.target),
		);
		ok(
			"T1: shared workspace survives",
			(srv.state.workspaces || []).some((w) => w.workspace_id === "w99"),
		);
		// Clean up — retire B too, teardown close happens (final pane gone legitimately).
		await driverB.killAgent(srv, { target: rb.target, session: rb.session, window: rb.window, paneId: rb.target });
		equal(closeCalls(srv).length, 1, "workspace close fires once both drivers' panes are truly gone");
		ok("T1: no survivor died in the legit close", srv.state.closedWorkspaces?.[0]?.livePaneCountAtClose === 0);
	}
});

// =============================================================================================
// T2 — prune-race: mid-flight spawn + confirmation re-probe vetoes premature close.
// =============================================================================================
await safe("T2 whole-block", async () => {
	console.log("=== T2: confirmation re-probe guards mid-flight spawn race ===");
	const srv = spinUp({
		workspaces: [
			{ workspace_id: "w1", label: "main", active_tab_id: "w1:t1" },
			{ workspace_id: "w99", label: "swarm-agents", active_tab_id: "w99:t1" },
		],
		tabs: [],
		panes: [],
	});
	const driverA = RED ? new PreFixSeamDriver("w1") : new HerdrDriver("w1");
	Object.defineProperty(driverA, "agentsWorkspaceId", { value: "w99", writable: true });
	const ra = await driverA.spawnAgent(srv, { session: "w1", window: "agent-a", command: "pi --agent a", cwd: scratch });
	// Race: a SECOND pane pops in (mid-flight spawn from another driver instance) BETWEEN
	// teardown probes. First pane-list probe (the prune) misses it (cold snapshot); the
	// confirmation re-probe (T2 guard) MUST see it and veto the close.
	srv.state.onPaneList = (probeIdx, panes, wsId) => {
		if (probeIdx === 1) return panes; // cold first reading: only A's pane.
		// Mid-flight spawn REALLY lands in the server state (another driver instance
		// created it): from probe #2 onward it is a genuine live co-tenant.
		srv.state.panes.push({ pane_id: "w99:pLate", tab_id: "w99:tLate", workspace_id: "w99", spawnedBy: "late-driver" });
		return srv.state.panes;
	};
	const kill = await driverA.killAgent(srv, { target: ra.target, session: ra.session, window: ra.window, paneId: ra.target });
	ok("T2: A's own pane killed", kill.killed);
	if (RED) {
		// Pre-fix: single cold census drove close (co-tenant slaughtered).
		ok("T2 (RED): premature close from single cold reading", (srv.state.closedWorkspaces?.length || 0) >= 1);
	} else {
		// Post-fix: confirmation re-probe sees the late pane, close vetoed.
		equal(closeCalls(srv).length, 0, "confirmation re-probe vetoes close when late pane appears");
		ok(
			"T2: late pane survived (no speculative close killed it)",
			srv.state.panes.some((p) => p.pane_id === "w99:pLate"),
		);
	}
});

// =============================================================================================
// T3 — R10-1 boundary count: zero `workspace close` invocations while any pane remains.
// =============================================================================================
await safe("T3 whole-block", async () => {
	console.log("=== T3: R10-1 workspace-close boundary count at real pi.exec ===");
	const srv = spinUp({
		workspaces: [
			{ workspace_id: "w1", label: "main", active_tab_id: "w1:t1" },
			{ workspace_id: "w99", label: "swarm-agents", active_tab_id: "w99:t1" },
		],
		tabs: [],
		panes: [],
	});
	const driverA = RED ? new PreFixSeamDriver("w1") : new HerdrDriver("w1");
	const driverB = RED ? new PreFixSeamDriver("w1") : new HerdrDriver("w1");
	Object.defineProperty(driverA, "agentsWorkspaceId", { value: "w99", writable: true });
	Object.defineProperty(driverB, "agentsWorkspaceId", { value: "w99", writable: true });

	const pa = await driverA.spawnAgent(srv, { session: "w1", window: "agent-a", command: "pi --agent a", cwd: scratch });
	const pb = await driverB.spawnAgent(srv, { session: "w1", window: "agent-b", command: "pi --agent b", cwd: scratch });
	await driverA.killAgent(srv, { target: pa.target, session: pa.session, window: pa.window, paneId: pa.target });
	await driverB.killAgent(srv, { target: pb.target, session: pb.session, window: pb.window, paneId: pb.target });

	const closes = closeCalls(srv);
	// Boundary contract: every close at the real pi.exec boundary may happen ONLY with a
	// census of 0 at close-time. Any close while >=1 pane lived = the production bug.
	const guiltyCloses = (srv.state.closedWorkspaces || []).filter((c) => c.livePaneCountAtClose > 0);
	equal(closes.length, srv.state.closedWorkspaces?.length || 0, "boundary count consistent with server-side census");
	if (RED) {
		equal(guiltyCloses.length, 1, "PRE-FIX shape: exactly the A-retire close killed B (the bug)");
	} else {
		equal(guiltyCloses.length, 0, "no close ever fired with live panes (R10-1)");
		equal(closes.length, 1, "exactly one legitimate close once the workspace truly emptied");
	}
});

// Summary + cleanup
console.log(`\nherdr-shared-workspace-teardown: ${pass} passed, ${fail} failed (mode: ${RED ? "RED" : "GREEN"})`);
if (fail > 0) process.exit(1);
rmSync(scratch, { recursive: true, force: true });
