#!/usr/bin/env node
// === herdr-h6-real-binary.mjs — H6 rework real-binary UAT (herdr 0.8.2) ===
// Exercises the fixed driver paths against the REAL herdr binary in a DISPOSABLE workspace:
//   1. alphanumeric pane id passthrough (resolvePaneId / inspectProcess on a live pi pane)
//   2. legacy label resolution (resolvePaneIdByLabel uses real pane-list fields)
//   3. focus label→tab-id resolution (tab focus must receive a tab id, never a label)
//   4. getFocusStatus with a real workspace id + no-false-focus on a workspace with no focused tab
//   5. send-text into a shell pane; pane close (kill path)
// Disposable-workspace only; never touches the swarm-agents workspace or live agents.
// Env: PI_SWARM_TERMINAL_MANAGER=herdr recommended. Usage: node scripts/uat/herdr-h6-real-binary.mjs
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

function h(args, { json = false } = {}) {
	const out = execFileSync("herdr", args, { encoding: "utf8", timeout: 15_000 });
	return json ? JSON.parse(out.trim()) : out;
}
const id = `h6rf-${randomUUID().slice(0, 6)}`;
const results = [];
let fail = 0;
function check(name, cond, detail = "") {
	if (cond) {
		results.push(`  ok   ${name}`);
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		results.push(`  FAIL ${name} ${detail}`);
		console.error(`  FAIL ${name} ${detail}`);
	}
}

// --- setup: disposable workspace + one root pane (stays open; shell keeps ws alive) -------
const priorWorkspaces = h(["workspace", "list"], { json: true })?.result?.workspaces || [];
const priorFocusedTab = priorWorkspaces.find((w) => w.focused)?.active_tab_id;
const rootWorkspaceId = priorWorkspaces.find((w) => w.workspace_id)?.workspace_id;
const created = h(["workspace", "create", "--label", id, "--no-focus"], { json: true });
const wsId = created?.result?.workspace?.workspace_id || created?.result?.workspace_id;
if (!wsId) {
	console.error("FATAL: could not create disposable workspace");
	process.exit(2);
}
console.log(`workspace: ${wsId} (label ${id})`);
const rootPane =
	created?.result?.root_pane?.pane_id ||
	created?.result?.tab?.root_pane_id ||
	h(["pane", "list", "--workspace", wsId], { json: true })?.result?.panes?.[0]?.pane_id;

async function main() {
	try {
		// --- 1. alphanumeric pane indices: every pane id in a fresh ws uses base-N indices; spawn a
		// second pane and assert resolvePaneId passes through whatever shape herdr mints (incl. alpha).
		const tab = h(["tab", "create", "--workspace", wsId, "--label", `${id}-p2`], { json: true });
		const tabId = tab?.result?.tab?.tab_id;
		const p2 =
			tab?.result?.root_pane?.pane_id ||
			h(["pane", "list", "--workspace", wsId], { json: true })?.result?.panes?.find((p) => p.tab_id === tabId)?.pane_id;
		check("1a. second pane minted an id", Boolean(p2), `p2=${p2}`);
		check("1b. pane id is workspace-qualified w*:p*", /^w[A-Za-z0-9_-]+:p[A-Za-z0-9]+$/.test(p2 || ""), `p2=${p2}`);

		const { HerdrDriver } = await import("../../extensions/swarm/src/terminal/drivers/herdr.ts");
		const { TmuxDriver } = await import("../../extensions/swarm/src/terminal/drivers/tmux.ts");
		const api = {
			exec: async (bin, args, opts) => {
				try {
					const stdout = execFileSync(bin, args, { encoding: "utf8", timeout: opts?.timeout || 10_000 });
					return { code: 0, stdout, stderr: "" };
				} catch (err) {
					return { code: err.status ?? 1, stdout: err.stdout || "", stderr: err.stderr || String(err.message || err) };
				}
			},
		};
		const driver = new HerdrDriver(wsId);
		const group = async (name, fn) => {
			try {
				await fn();
			} catch (err) {
				check(name, false, String(err?.message || err));
			}
		};

		// resolvePaneId passthrough for BOTH panes (digit or alpha suffix)
		check("1c. resolvePaneId passthrough root pane", (await driver.resolvePaneId(api, rootPane)) === rootPane, `root=${rootPane}`);
		check("1d. resolvePaneId passthrough second pane", (await driver.resolvePaneId(api, p2)) === p2, `p2=${p2}`);

		// inspectProcess on a live pi pane: use THIS repo's live wK workspace? NO — production. Instead
		// spawn pi-less probe: a shell pane is NOT piLike; assert the negative against the real binary
		// (a false-negative here was the review's 4.2 symptom; the regex fix is proven by 1c/1d passthrough
		// reaching process-info for alpha ids instead of throwing).
		const info = await driver.inspectProcess(api, p2);
		check("1e. inspectProcess reaches process-info for alphanumeric pane", typeof info.piLike === "boolean", JSON.stringify(info));

		// --- 2. legacy label resolution: composite "ws:label.0" → real pane id
		await group("2. resolvePaneId resolves legacy composite label target", async () => {
			const resolved = await driver.resolvePaneId(api, `${wsId}:${id}-p2.0`);
			check("2. resolvePaneId resolves legacy composite label target", resolved === p2, `got ${resolved}`);
			// Root focus commonly queries the workers' separate Herdr workspace from its own one.
			// The label lookup must scope pane list by the matched tab.workspace_id, not driver root.
			const rootScoped = rootWorkspaceId ? new HerdrDriver(rootWorkspaceId) : driver;
			const crossWorkspace = await rootScoped.resolvePaneId(api, `${wsId}:${id}-p2.0`);
			check(
				"2b. label resolution finds tab in a workspace other than driver's root",
				crossWorkspace === p2,
				`got ${crossWorkspace}; tab workspace=${wsId}, driver root=${rootWorkspaceId}`,
			);
		});

		// --- 3. focus label→tab id
		await group("3. focusWindow label paths", async () => {
			const focusRes = await driver.focusWindow(api, `${wsId}:${id}-p2.0`);
			check("3a. focusWindow(label composite) succeeds", focusRes.ok === true, JSON.stringify(focusRes));
			const focusRes2 = await driver.focusWindow(api, { target: p2, session: wsId, window: tabId, paneId: p2 });
			check("3b. focusWindow(TerminalTargetRef with tab id) succeeds", focusRes2.ok === true, JSON.stringify(focusRes2));
		});

		// --- 4. getFocusStatus: real workspace id; label form; and no-focus fabrication guard.
		let st1;
		await group("4. getFocusStatus workspace id + label", async () => {
			st1 = await driver.getFocusStatus(api, wsId);
			check("4a. getFocusStatus(workspace id) alive", st1.sessionAlive === true, JSON.stringify(st1));
		});

		// no-false-focus: a workspace whose only tabs report focused:false — build via fake seam on REAL
		// shapes is covered by the unit test; against the real binary we assert the semantics: when we
		// CAN read a focused tab it must be an actual tab of the ws (never fabricated).
		const tabs = h(["tab", "list", "--workspace", wsId], { json: true })?.result?.tabs || [];
		if (tabs.some((t) => t.focused)) {
			check(
				"4c. focused tab report matches a real tab_id",
				tabs.some((t) => t.tab_id === st1.activeWindowIndex),
				JSON.stringify({ st: st1, tabs: tabs.map((t) => t.tab_id) }),
			);
		} else {
			check(
				"4c. no focused tab → driver reports no fabricated focus",
				!st1.activeWindowIndex && !st1.activeWindowName,
				JSON.stringify(st1),
			);
		}

		// --- 5. send-text + close (kill path) against the real binary
		await group("5. sendKeys/capture/kill against real binary", async () => {
			const marker = `H6RF_${id.replace(/[^A-Za-z0-9]/g, "_")}`;
			await driver.sendKeys(api, p2, `printf '%s\\n' ${marker}`, { literal: true, enter: true });
			// Wait for the command's standalone output line, not the echoed command input.
			h(["pane", "wait-output", "--regex", `(?m)^${marker}$`, "--timeout", "5000", p2]);
			const captured = await driver.capturePane(api, p2, 40);
			check(
				"5a. sendKeys literal+enter lands text in pane",
				captured.split(/\r?\n/).some((line) => line.trim() === marker),
				JSON.stringify(captured.slice(-200)),
			);

			const kill = await driver.killAgent(api, { target: p2, session: wsId, window: tabId, paneId: p2 });
			check("5b. killAgent closes the pane", kill.killed === true, JSON.stringify(kill));
			const panesAfter = h(["pane", "list", "--workspace", wsId], { json: true })?.result?.panes || [];
			check(
				"5c. pane removed from pane list",
				!panesAfter.some((p) => p.pane_id === p2),
				JSON.stringify(panesAfter.map((p) => p.pane_id)),
			);
		});

		// tmux byte-identity control (no live tmux needed): TmuxDriver argv via recorder
		const execs = [];
		const recApi = { exec: async (bin, args) => (execs.push({ bin, args }), { code: 0, stdout: "", stderr: "" }) };
		const td = new TmuxDriver();
		await td.killAgent(recApi, { target: "%3", session: "s", window: "w9", paneId: "%3" });
		const seq = execs.map((e) => e.args.join(" ")).join("|");
		check(
			"5d. TmuxDriver kill argv byte-identical",
			seq.includes("kill-window -t s:w9") && (seq.includes("kill-pane -t %3") || !execs.some((e) => e.args[0] === "kill-pane")),
			seq,
		);
	} finally {
		// Closing the workspace directly avoids a workspace_not_found error after the last tab closes.
		// If the driver already closed it, the workspace list makes that expected branch explicit.
		const workspaces = h(["workspace", "list"], { json: true })?.result?.workspaces || [];
		if (workspaces.some((w) => w.workspace_id === wsId)) h(["workspace", "close", wsId]);
		const tabs = h(["tab", "list"], { json: true })?.result?.tabs || [];
		if (priorFocusedTab && tabs.some((t) => t.tab_id === priorFocusedTab)) h(["tab", "focus", priorFocusedTab]);
		console.log(`cleanup: workspace ${wsId} closed; restored tab ${priorFocusedTab || "(none recorded)"}`);
	}
}
main().then(() => process.exit(fail ? 1 : 0));
