// herdr-workspace-per-project.test.mjs — RED-first regression suite for
// task-202610040005-herdr-agents-workspace-p.
//
// Two bugs (user report 2026-10-03, forensics artifacts/context-analysis.md):
//   RED 1 — cross-project label collision: `getAgentsWorkspaceLabel()` returned the
//           constant "swarm-agents", so every project on one herdr instance converged
//           on the SAME workspace by label (ensureAgentsWorkspace matches across
//           `workspace list`). Fix A: label = `swarm-agents-<projectSlug(cwd)>`,
//           reusing the tmux per-project convention (state.ts:117); env override
//           PI_SWARM_HERDR_WS_LABEL stays a FULL-label override.
//   RED 2 — foreign-pane teardown hazard: `maybeCloseAgentsWorkspace()` closed the
//           workspace whenever THIS driver's tracked set hit zero, without checking
//           the workspace's LIVE pane list for foreign panes (live evidence: shared
//           wY held another project's implementer-04/tester-04/reviewer-04/
//           redteam-coordinator). Fix B: close ONLY when the workspace's total live
//           pane count is 0; foreign panes veto the close.
//
// Fixture: deterministic mock-`pi.exec` herdr 0.8.2 CLI fake (same pattern as
// herdr-driver.test.mjs / herdr-audit-gap-branches.test.mjs). The herdr driver is
// pure driver/CLI logic — no LLM turn surface is involved — so the mock-LLM JSONL
// fixture lane is impractical/unnecessary here (AGENTS.md fallback clause); this
// mock-exec lane IS the deterministic fixture.
//
// Run: node extensions/swarm/tests/herdr-workspace-per-project.test.mjs
import { equal, ok as assertOk, notEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrDriver } from "../src/terminal/index.ts";
import { projectSlug } from "../src/utils.ts";

// checkTmuxSession gates on $TMUX; this lane runs from a herdr pane (no $TMUX). PI_SWARM_TMUX_OK
// is the documented bypass (pool.ts checkTmuxSession) — the spawn boundary under test is the
// herdr driver's pi.exec seam, which this mock fully controls, so the bypass cannot mask a real
// spawn failure.
if (!process.env.TMUX) process.env.PI_SWARM_TMUX_OK = "1";

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

// ---------------------------------------------------------------- mock harness
// Records every exec; implements a small herdr 0.8.2-shaped fake with a
// per-workspace pane store so teardown can be exercised against a live pane list.
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
			const wsId = args[2];
			const ws = (state.workspaces || []).find((w) => w.workspace_id === wsId);
			if (!ws) return { code: 3, stdout: "", stderr: JSON.stringify({ error: { code: "workspace_not_found" } }) };
			return { code: 0, stdout: JSON.stringify({ result: { workspace: ws } }), stderr: "" };
		}
		if (sub === "workspace" && action === "create") {
			const labelIdx = args.indexOf("--label");
			const label = labelIdx !== -1 ? args[labelIdx + 1] : "swarm-agents";
			const ws = { workspace_id: state.nextWsId || "wNEW", label, active_tab_id: state.nextRootTabId || "wNEW:t1" };
			state.workspaces = state.workspaces || [];
			state.workspaces.push(ws);
			return {
				code: 0,
				stdout: JSON.stringify({
					result: { workspace: ws, tab: { tab_id: state.nextRootTabId || "wNEW:t1" } },
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
			return {
				code: 0,
				stdout: JSON.stringify({
					result: {
						tab: { tab_id: state.nextTabId || "wNEW:t2", workspace_id: state.nextWsId || "wNEW" },
						root_pane: { pane_id: state.nextPaneId || "wNEW:p2" },
					},
				}),
				stderr: "",
			};
		}

		if (sub === "pane" && action === "list") {
			if (state.failPaneList) return { code: 3, stdout: "", stderr: state.paneListErr || "pane list failed" };
			const wsIdx = args.indexOf("--workspace");
			let panes = state.panes || [];
			if (wsIdx !== -1) panes = panes.filter((p) => (p.workspace_id || String(p.pane_id).split(":")[0]) === args[wsIdx + 1]);
			return { code: 0, stdout: JSON.stringify({ result: { panes } }), stderr: "" };
		}
		if (sub === "pane" && action === "close") {
			if (state.failPaneClose) return { code: 1, stdout: "", stderr: "pane close failed" };
			state.closedPanes = state.closedPanes || [];
			state.closedPanes.push(args[2]);
			state.panes = (state.panes || []).filter((p) => p.pane_id !== args[2]);
			return { code: 0, stdout: "{}", stderr: "" };
		}
		return { code: 0, stdout: "{}", stderr: "" };
	};
	return { exec, calls, state };
}

// Run an async fn with process.cwd() temporarily pointed at a scratch dir whose basename
// differs per project — mirrors how the real driver resolves project slug from cwd.
// Awaits the fn so the chdir restore cannot race promise continuations.
async function withCwd(cwd, fn) {
	const prev = process.cwd();
	process.chdir(cwd);
	try {
		return await fn();
	} finally {
		process.chdir(prev);
	}
}

console.log("=== RED 1: per-project agents-workspace label ===");

await asyncTest("1.1 two project cwds resolve DIFFERENT agents-workspace labels", async () => {
	const proj1 = mkdtempSync(join(tmpdir(), "wsfix-alpha-"));
	const proj2 = mkdtempSync(join(tmpdir(), "wsfix-beta-"));
	try {
		const label1 = await withCwd(proj1, async () => {
			const d = new HerdrDriver();
			// ensureAgentsWorkspace is the only route that materializes the label; run it
			// against a mock that records the `workspace create --label` argv.
			const pi = createMockPi({ workspaces: [], nextWsId: "wA" });
			await d.ensureAgentsWorkspace(pi);
			const create = pi.calls.find((c) => c.args[0] === "workspace" && c.args[1] === "create");
			assertOk(create, "workspace create must be called when no matching workspace exists");
			const li = create.args.indexOf("--label");
			return create.args[li + 1];
		});
		const label2 = await withCwd(proj2, async () => {
			const d = new HerdrDriver();
			const pi = createMockPi({ workspaces: [], nextWsId: "wB" });
			await d.ensureAgentsWorkspace(pi);
			const create = pi.calls.find((c) => c.args[0] === "workspace" && c.args[1] === "create");
			const li = create.args.indexOf("--label");
			return create.args[li + 1];
		});

		// THE bug: pre-fix both labels are the same constant "swarm-agents".
		notEqual(label1, label2, `labels must differ per project slug (got ${label1} vs ${label2})`);
		equal(label1, `swarm-agents-${projectSlug(proj1)}`, "label carries project 1 slug");
		equal(label2, `swarm-agents-${projectSlug(proj2)}`, "label carries project 2 slug");
	} finally {
		rmSync(proj1, { recursive: true, force: true });
		rmSync(proj2, { recursive: true, force: true });
	}
});

await asyncTest("1.2 ensureAgentsWorkspace REUSES an existing per-project workspace (no duplicate create)", async () => {
	const proj = mkdtempSync(join(tmpdir(), "wsfix-gamma-"));
	try {
		await withCwd(proj, async () => {
			const slug = projectSlug(proj);
			const label = `swarm-agents-${slug}`;
			const pi = createMockPi({ workspaces: [{ workspace_id: "wEXIST", label }] });
			const d = new HerdrDriver();
			const ws = await d.ensureAgentsWorkspace(pi);
			equal(ws, "wEXIST", "existing per-project workspace must be matched by label");
			assertOk(!pi.calls.some((c) => c.args[0] === "workspace" && c.args[1] === "create"), "no create when the per-project label exists");
		});
	} finally {
		rmSync(proj, { recursive: true, force: true });
	}
});

await asyncTest("1.3 PI_SWARM_HERDR_WS_LABEL is a FULL-label override (no slug appended)", async () => {
	const proj = mkdtempSync(join(tmpdir(), "wsfix-delta-"));
	const prev = process.env.PI_SWARM_HERDR_WS_LABEL;
	process.env.PI_SWARM_HERDR_WS_LABEL = "my-custom-agents";
	try {
		await withCwd(proj, async () => {
			const pi = createMockPi({ workspaces: [], nextWsId: "wC" });
			const d = new HerdrDriver();
			await d.ensureAgentsWorkspace(pi);
			const create = pi.calls.find((c) => c.args[0] === "workspace" && c.args[1] === "create");
			const li = create.args.indexOf("--label");
			equal(create.args[li + 1], "my-custom-agents", "env override replaces the whole label verbatim");
		});
	} finally {
		if (prev === undefined) delete process.env.PI_SWARM_HERDR_WS_LABEL;
		else process.env.PI_SWARM_HERDR_WS_LABEL = prev;
		rmSync(proj, { recursive: true, force: true });
	}
});

await asyncTest("1.4 spawnAgent creates the tab inside the per-project workspace", async () => {
	const proj = mkdtempSync(join(tmpdir(), "wsfix-eps-"));
	try {
		await withCwd(proj, async () => {
			const slug = projectSlug(proj);
			const pi = createMockPi({
				workspaces: [],
				nextWsId: "wP",
				nextRootTabId: "wP:t1",
				nextTabId: "wP:t2",
				nextPaneId: "wP:p2",
				panes: [{ pane_id: "wP:p1", tab_id: "wP:t1", workspace_id: "wP" }],
			});
			const d = new HerdrDriver();
			await d.spawnAgent(pi, { session: "wsess", window: "agent-a", command: "pi --model m", cwd: proj });
			const create = pi.calls.find((c) => c.args[0] === "workspace" && c.args[1] === "create");
			assertOk(create, "per-project workspace created on first spawn");
			const li = create.args.indexOf("--label");
			equal(create.args[li + 1], `swarm-agents-${slug}`);
			const tabCreate = pi.calls.find((c) => c.args[0] === "tab" && c.args[1] === "create");
			const wi = tabCreate.args.indexOf("--workspace");
			equal(tabCreate.args[wi + 1], "wP", "tab lands in the per-project workspace");
		});
	} finally {
		rmSync(proj, { recursive: true, force: true });
	}
});

console.log("=== RED 2: foreign-pane teardown guard ===");

const WS_PER_PROJECT = [{ workspace_id: "wX", label: "swarm-agents-pi-graph-agents", active_tab_id: "wX:t1" }];

await asyncTest("2.1 last tracked pane killed while a FOREIGN pane remains → NO workspace close (RED 2)", async () => {
	const state = {
		workspaces: [...WS_PER_PROJECT],
		// After our tracked pane wX:p2 is closed, wX:p9 (foreign, never tracked by this
		// driver) still lives in the workspace — the close must be vetoed.
		panes: [
			{ pane_id: "wX:p2", tab_id: "wX:t2", workspace_id: "wX" },
			{ pane_id: "wX:p9", tab_id: "wX:t9", workspace_id: "wX" },
		],
	};
	const pi = createMockPi(state);
	const d = new HerdrDriver();
	d.agentsWorkspaceId = "wX";
	d.swarmPaneIds.add("wX:p2");
	d.everTrackedSwarmPanes = true;

	const res = await d.killAgent(pi, { target: "wX:p2", session: "wX", window: "wX:t2", paneId: "wX:p2" });
	equal(res.killed, true);
	equal((state.closedPanes || []).includes("wX:p2"), true, "our pane is closed");
	equal((state.closedWorkspaces || []).length, 0, "workspace must NOT close while a foreign pane remains (pre-fix: closes)");
	equal((state.panes || []).some((p) => p.pane_id === "wX:p9"), true, "foreign pane untouched");
});

await asyncTest("2.2 close DOES fire when the workspace's live pane list is empty (GREEN 2b)", async () => {
	const state = {
		workspaces: [...WS_PER_PROJECT],
		panes: [{ pane_id: "wX:p2", tab_id: "wX:t2", workspace_id: "wX" }],
	};
	const pi = createMockPi(state);
	const d = new HerdrDriver();
	d.agentsWorkspaceId = "wX";
	d.swarmPaneIds.add("wX:p2");
	d.everTrackedSwarmPanes = true;

	const res = await d.killAgent(pi, { target: "wX:p2", session: "wX", window: "wX:t2", paneId: "wX:p2" });
	equal(res.killed, true);
	equal((state.closedWorkspaces || []).includes("wX"), true, "workspace closes when zero panes remain");
});

await asyncTest("2.3 foreign pane appears AFTER tracked set empties but before close decision → veto via live list", async () => {
	// The pane list is the source of truth: a foreign pane present at close-decision time
	// vetoes even when the tracked set is empty (this is exactly the shared-wY live shape).
	const state = {
		workspaces: [...WS_PER_PROJECT],
		panes: [{ pane_id: "wX:p9", tab_id: "wX:t9", workspace_id: "wX" }],
	};
	const pi = createMockPi(state);
	const d = new HerdrDriver();
	d.agentsWorkspaceId = "wX";
	// Tracked pane already died outside this call; only the foreign pane remains live.
	d.everTrackedSwarmPanes = true;
	await d.maybeCloseAgentsWorkspace(pi);
	equal((state.closedWorkspaces || []).length, 0, "live foreign pane vetoes close even with an empty tracked set");
});

console.log("=== regression: existing contracts preserved ===");

await asyncTest("3.1 foreign-only driver (never tracked) still never closes", async () => {
	const state = {
		workspaces: [...WS_PER_PROJECT],
		panes: [{ pane_id: "wX:p9", tab_id: "wX:t9", workspace_id: "wX" }],
	};
	const pi = createMockPi(state);
	const d = new HerdrDriver();
	d.agentsWorkspaceId = "wX";
	await d.maybeCloseAgentsWorkspace(pi);
	equal((state.closedWorkspaces || []).length, 0, "everTrackedSwarmPanes guard intact");
});

await asyncTest("3.2 stale tracked ids pruned; survivor blocks close", async () => {
	const state = {
		workspaces: [...WS_PER_PROJECT],
		panes: [{ pane_id: "wX:p2", tab_id: "wX:t2", workspace_id: "wX" }],
	};
	const pi = createMockPi(state);
	const d = new HerdrDriver();
	d.agentsWorkspaceId = "wX";
	d.swarmPaneIds.add("wX:p2");
	d.everTrackedSwarmPanes = true;
	d.swarmPaneIds.add("wX:pGONE"); // no longer exists
	await d.maybeCloseAgentsWorkspace(pi);
	equal((state.closedWorkspaces || []).length, 0, "wX:p2 still alive → ws stays");
});

await asyncTest("3.3 workspace-not-found during teardown stays an expected branch (no close, no throw)", async () => {
	const state = { workspaces: [], failPaneList: true, paneListErr: "workspace_not_found" };
	const pi = createMockPi(state);
	const d = new HerdrDriver();
	d.agentsWorkspaceId = "wX";
	d.swarmPaneIds.add("wX:p2");
	d.everTrackedSwarmPanes = true;
	await d.maybeCloseAgentsWorkspace(pi);
	equal((state.closedWorkspaces || []).length, 0);
});

console.log(`\nherdr-workspace-per-project: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
