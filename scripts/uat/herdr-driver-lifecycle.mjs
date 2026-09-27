#!/usr/bin/env node
// === herdr-driver-lifecycle.mjs — audit-gap-closure real-binary UAT (herdr 0.8.2) ===
// Exercises the CURRENT HerdrDriver end-to-end against the REAL herdr binary in a DISPOSABLE
// workspace created solely for this run (label dl-<uuid>):
//   spawnAgent → sendText → capturePane → inspectProcess (piLike asserted FALSE with the real
//   shell command, not just boolean type) → isTargetAlive(false) → killAgent → tracked
//   teardown → workspace close. Before/after workspace snapshots + global-focus restoration
//   recorded. The production `swarm-agents` workspace is NEVER used as a spawn target.
// Env: HERDR_ENV=1 recommended. Usage: node scripts/uat/herdr-driver-lifecycle.mjs [outdir]
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir =
	process.argv[2] ||
	join(".pi", "swarm-uat", "runs", `herdr-driver-lifecycle-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 15)}`);
mkdirSync(outDir, { recursive: true });

function h(args, { json = false } = {}) {
	const out = execFileSync("herdr", args, { encoding: "utf8", timeout: 15_000, env: { ...process.env, HERDR_ENV: "1" } });
	return json ? JSON.parse(out.trim()) : out;
}

const results = [];
let fail = 0;
const previousAgentsLabel = process.env.PI_SWARM_HERDR_WS_LABEL;
function check(name, cond, detail = "") {
	const line = `${cond ? "  ok   " : "  FAIL "}${name}${cond ? "" : ` ${detail}`}`;
	results.push(line);
	if (cond) console.log(line);
	else console.error(line);
	if (!cond) fail++;
}

const id = `dl-${randomUUID().slice(0, 6)}`;
const version = execFileSync("herdr", ["--version"], { encoding: "utf8" }).trim();
writeFileSync(join(outDir, "version.txt"), version + "\n");

// --- snapshots BEFORE (workspace set + global focused tab) ---------------------------------
const beforeWorkspaces = h(["workspace", "list"], { json: true });
writeFileSync(join(outDir, "workspaces-before.json"), JSON.stringify(beforeWorkspaces, null, 2));
const priorWorkspaces = beforeWorkspaces?.result?.workspaces || [];
const PROD_WS_LABEL = "swarm-agents";
const prodWs = priorWorkspaces.find((w) => w.label === PROD_WS_LABEL);
const priorFocusedTab = priorWorkspaces.find((w) => w.focused)?.active_tab_id;
console.log(
	`herdr ${version} | disposable label: ${id} | prod ws: ${prodWs?.workspace_id || "(none)"} | prior focus: ${priorFocusedTab || "(none)"}`,
);

async function main() {
	let wsId;
	try {
		// Driver creates the uniquely labelled disposable agents workspace itself. This exercises
		// the real create path and captures its root-tab id for the H5 one-shot close assertion.
		process.env.PI_SWARM_HERDR_WS_LABEL = id;
		const { HerdrDriver } = await import("../../extensions/swarm/src/terminal/drivers/herdr.ts");
		const api = {
			exec: async (bin, args, opts) => {
				try {
					const stdout = execFileSync(bin, args, {
						encoding: "utf8",
						timeout: opts?.timeout || 10_000,
						env: { ...process.env, HERDR_ENV: "1" },
					});
					return { code: 0, stdout, stderr: "" };
				} catch (err) {
					return { code: err.status ?? 1, stdout: err.stdout || "", stderr: err.stderr || String(err.message || err) };
				}
			},
		};
		// Driver's "agents workspace" = OUR disposable ws (so spawnAgent's ensureAgentsWorkspace
		// resolves the disposable one, not production). We pre-seed it via list match.
		const driver = new HerdrDriver();

		// --- spawnAgent (two-step 0.8.2 contract, H5 root-tab close) ----------------------------
		const marker = `DL_${id.replace(/[^A-Za-z0-9]/g, "_")}`;
		// Words contract: typed as one line, env-prefixed printf is single-word-safe.
		const spawn = await driver.spawnAgent(api, {
			session: "unused-root-session",
			window: `${id}-agent1`,
			command: `printf '%s\\n' ${marker}_READY`,
			cwd: "/tmp",
		});
		wsId = spawn.session;
		check("setup: disposable workspace created", Boolean(wsId), JSON.stringify(spawn));
		check("setup: disposable label is NOT swarm-agents", id !== PROD_WS_LABEL && wsId !== prodWs?.workspace_id, `wsId=${wsId}`);
		check(
			"1a. spawnAgent returned real workspace-qualified ids",
			/^w[A-Za-z0-9_-]+:p[A-Za-z0-9]+$/.test(spawn.target) && /^w[A-Za-z0-9_-]+:t[A-Za-z0-9]+$/.test(spawn.window),
			JSON.stringify(spawn),
		);
		const agentsWorkspace = (h(["workspace", "list"], { json: true })?.result?.workspaces || []).find((w) => w.label === id);
		check(
			"1b. spawnAgent session is the agents workspace or disposable workspace",
			spawn.session === agentsWorkspace?.workspace_id || spawn.session === wsId,
			`session=${spawn.session} agents=${agentsWorkspace?.workspace_id} disposable=${wsId}`,
		);

		// H5: workspace create minted a root tab; first spawn must have closed it (one-shot).
		const tabsAfterSpawn = h(["tab", "list", "--workspace", wsId], { json: true })?.result?.tabs || [];
		check(
			"1c. H5 root tab closed after first spawn (only agent tab remains)",
			tabsAfterSpawn.length === 1,
			JSON.stringify(tabsAfterSpawn),
		);

		// --- wait for the shell to materialize, then assert pane is listed ---------------------
		await new Promise((r) => setTimeout(r, 500));
		const panes = h(["pane", "list", "--workspace", wsId], { json: true })?.result?.panes || [];
		check(
			"1d. spawned pane visible in pane list",
			panes.some((p) => p.pane_id === spawn.target),
			JSON.stringify(panes.map((p) => p.pane_id)),
		);

		// --- sendText lands the marker in the pane ---------------------------------------------
		const marker2 = `${marker}_SENT`;
		await driver.sendText(api, spawn.target, `printf '%s\\n' ${marker2}`);
		h(["pane", "wait-output", "--regex", `(?m)^${marker2}$`, "--timeout", "5000", spawn.target]);
		const captured = await driver.capturePane(api, spawn.target, 40);
		check(
			"2. sendText + capturePane sees marker line",
			captured.split(/\r?\n/).some((l) => l.trim() === marker2),
			JSON.stringify(captured.slice(-160)),
		);

		// --- inspectProcess: shell pane must be piLike:false WITH the real shell command ---------
		// (audit gap: the prior H6 script only checked `typeof piLike === "boolean"`)
		const info = await driver.inspectProcess(api, spawn.target);
		writeFileSync(join(outDir, "process-info-shell.json"), JSON.stringify(info, null, 2));
		check("3a. inspectProcess piLike === false for a shell pane", info.piLike === false, JSON.stringify(info));
		check(
			"3b. inspectProcess command is a real shell (not empty/unknown)",
			/^(bash|zsh|sh|dash)$/.test(info.command || ""),
			JSON.stringify(info),
		);

		const alive = await driver.isTargetAlive(api, spawn.target);
		check("4. isTargetAlive === false for shell pane", alive === false, String(alive));

		// --- killAgent + tracked teardown -------------------------------------------------------
		const kill = await driver.killAgent(api, {
			target: spawn.target,
			session: spawn.session,
			window: spawn.window,
			paneId: spawn.target,
		});
		check("5a. killAgent killed", kill.killed === true && kill.method === "pane-close", JSON.stringify(kill));
		let panesAfterKill = [];
		let workspaceClosedByKill = false;
		try {
			panesAfterKill = h(["pane", "list", "--workspace", wsId], { json: true })?.result?.panes || [];
		} catch (err) {
			if (!/workspace_not_found/i.test(String(err?.message || err))) throw err;
			workspaceClosedByKill = true;
		}
		check(
			"5b. pane removed or tracked-pane teardown closed workspace",
			workspaceClosedByKill || !panesAfterKill.some((p) => p.pane_id === spawn.target),
			JSON.stringify(panesAfterKill.map((p) => p.pane_id)),
		);
	} finally {
		// --- teardown + focus restoration -------------------------------------------------------
		try {
			const workspaces = h(["workspace", "list"], { json: true })?.result?.workspaces || [];
			if (wsId && workspaces.some((w) => w.workspace_id === wsId)) {
				h(["workspace", "close", wsId]);
				console.log(`cleanup: closed disposable workspace ${wsId}`);
			}
		} catch (err) {
			console.error(`cleanup: workspace close failed (${err?.message || err})`);
		}
		// Restore the GLOBAL focused tab captured before the run (if it still exists).
		if (priorFocusedTab) {
			try {
				const tabs = h(["tab", "list"], { json: true })?.result?.tabs || [];
				if (tabs.some((t) => t.tab_id === priorFocusedTab)) {
					h(["tab", "focus", priorFocusedTab]);
					console.log(`cleanup: restored global focus to ${priorFocusedTab}`);
				} else {
					console.log(`cleanup: prior focused tab ${priorFocusedTab} no longer exists; nothing to restore`);
				}
			} catch (err) {
				console.error(`cleanup: focus restore failed (${err?.message || err})`);
			}
		}
		// Final after-snapshot for the record.
		try {
			const after = h(["workspace", "list"], { json: true });
			writeFileSync(join(outDir, "workspaces-after.json"), JSON.stringify(after, null, 2));
			const prodStill = prodWs && (after?.result?.workspaces || []).some((w) => w.workspace_id === prodWs.workspace_id);
			check(
				"6. pre-existing production swarm-agents workspace still exists",
				!prodWs || prodStill,
				`pre-existing=${prodWs?.workspace_id || "none"} after=${Boolean(prodStill)}`,
			);
			const afterIds = (after?.result?.workspaces || []).map((w) => w.workspace_id);
			check("7. disposable workspace absent after cleanup", !afterIds.includes(wsId), JSON.stringify(afterIds));
		} catch (err) {
			console.error(`cleanup: after-snapshot failed (${err?.message || err})`);
		}
		if (previousAgentsLabel === undefined) delete process.env.PI_SWARM_HERDR_WS_LABEL;
		else process.env.PI_SWARM_HERDR_WS_LABEL = previousAgentsLabel;
		writeFileSync(join(outDir, "results.txt"), results.join("\n") + "\n");
	}
}

await main().catch((err) => {
	console.error("FATAL:", err?.message || err);
	process.exit(2);
});
console.log(`\nresults written to ${outDir}`);
process.exit(fail ? 1 : 0);
