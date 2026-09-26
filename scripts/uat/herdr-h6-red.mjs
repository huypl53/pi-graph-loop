#!/usr/bin/env node
// === scripts/uat/herdr-h6-red.mjs — H6 RED/GREEN lane (herdr-h6-driver-mirroring) ===
// Reproduces the residual raw-tmux exec bug: under PI_SWARM_TERMINAL_MANAGER=herdr the four
// residual call sites (killAgentPane, sendKeys, focus status, register pane-id resolution) exec
// the tmux binary against herdr-shaped pane ids and never call the herdr binary.
//
// Seam: a fake ExtensionAPI.exec recorder standing in for pi.exec — the REAL pi.exec seam per
// R10-1 (these driver classes call pi.exec("tmux"|...|"herdr") directly).
//
// RED expectation (pre-fix):  tmux execs > 0 AND herdr execs == 0 on every site  → BUG reproduced.
// GREEN expectation (post-fix): herdr execs > 0 AND tmux execs == 0 per site (herdr mode),
//                                and TmuxDriver emits the pre-fix byte-identical tmux argv (tmux mode).
//
// Evidence: every run writes its captured execs to UAT_OUT_DIR/execs.json so the pre-fix RED
// evidence is durable on disk (AGENTS.md mandate: red artifact must be observed and stored
// BEFORE source fixes). Run with separate UAT_OUT_DIRs for RED vs GREEN.
import { strictEqual, ok } from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { killAgentPane as killAgentPaneFn, sendKeys as sendKeysFn } from "../../extensions/swarm/src/agents.ts";
import { isCurrentActiveTmuxWindow, focusAgentWindow } from "../../extensions/swarm/src/focus.ts";
import { getTerminalDriver } from "../../extensions/swarm/src/terminal/index.ts";

const UAT_OUT_DIR = process.env.UAT_OUT_DIR || `/tmp/h6-red-${process.pid}`;
process.env.UAT_OUT_DIR = UAT_OUT_DIR;
mkdirSync(UAT_OUT_DIR, { recursive: true });

// herdr-shaped target from the live audit (tmux-composite ids like wK:p5 must not be exec'd at tmux)
const HERDR_PANE = "w9:p3";
const HERDR_SESSION = "ws-agents";

function fakePi() {
	const execs = [];
	const api = {
		exec: async (bin, args, opts) => {
			execs.push({ bin, args, opts });
			// Deterministic canned results per binary (no real terminals touched)
			if (bin === "tmux") {
				const cmd = args[0];
				if (cmd === "display-message") {
					const fmt = args[args.length - 1];
					if (fmt === "#{pane_id}") return { code: 0, stdout: HERDR_PANE + "\n", stderr: "" };
					return { code: 0, stdout: "3\tw9\t" + HERDR_PANE + "\n", stderr: "" };
				}
				if (cmd === "list-panes") return { code: 0, stdout: "fake\n", stderr: "" };
				if (cmd === "kill-window") return { code: 1, stdout: "", stderr: "can't find window" };
				if (cmd === "kill-pane") return { code: 0, stdout: "", stderr: "" };
				return { code: 0, stdout: "", stderr: "" };
			}
			if (bin === "herdr") {
				const cmd = args.join(" ");
				if (cmd.startsWith("pane process-info"))
					return {
						code: 0,
						stdout: JSON.stringify({ result: { process_info: { foreground_processes: [{ name: "pi", pid: 4242 }] } } }),
						stderr: "",
					};
				if (cmd.startsWith("pane read")) return { code: 0, stdout: JSON.stringify({ result: { text: "pi - ok" } }), stderr: "" };
				if (cmd.startsWith("pane send-text")) return { code: 0, stdout: "ok", stderr: "" };
				if (cmd.startsWith("pane send-keys")) return { code: 0, stdout: "ok", stderr: "" };
				if (cmd.startsWith("tab list"))
					return {
						code: 0,
						stdout: JSON.stringify({
							result: { tabs: [{ tab_id: "t1", label: "a1", active: true, active_pane_id: HERDR_PANE }] },
						}),
						stderr: "",
					};
				return { code: 0, stdout: "ok", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	return { api, execs };
}

function count(execs, bin) {
	return execs.filter((e) => e.bin === bin).length;
}

const agent = {
	id: "a1",
	tmuxTarget: HERDR_PANE,
	tmuxSession: HERDR_SESSION,
	tmuxWindow: "a1",
};

const sites = [];
const capturedErrors = [];

async function runSite(name, fn) {
	const { api, execs } = fakePi();
	try {
		await fn(api);
	} catch (err) {
		// Explicit capture — never silent. Errors are recorded and surfaced in the report.
		capturedErrors.push({ site: name, error: String((err && err.message) || err) });
	}
	sites.push({ name, execs });
}

await runSite("killAgentPane", (api) => killAgentPaneFn(api, { tmuxTraces: UAT_OUT_DIR }, agent));
await runSite("sendKeys", (api) => sendKeysFn(api, {}, HERDR_PANE, "hello", { literal: true }));
await runSite("focusStatus", (api) => isCurrentActiveTmuxWindow(api, HERDR_SESSION, agent));
await runSite("focusAgentWindow", (api) => focusAgentWindow(api, agent, UAT_OUT_DIR));
await runSite("registerPaneId", async (api) => {
	try {
		await getTerminalDriver().resolvePaneId(api, HERDR_PANE);
	} catch (err) {
		// Pre-fix the interface method doesn't exist — emulate the raw call registration.ts makes.
		const { tmux } = await import("../../extensions/swarm/src/tmux.ts");
		await tmux(api, ["display-message", "-p", "-t", HERDR_PANE, "#{pane_id}"], 3_000);
	}
});

const RED = process.env.H6_EXPECT === "red";
// killAgentPane's liveness probe already routes through driver.isTargetAlive (pre-fix) — the
// residual bug at that site is the kill-window/kill-pane execs only. Adjust per-site expectations:
const allowTmux = new Set(["killAgentPane"]);
let failed = 0;
const report = [];
for (const s of sites) {
	const t = count(s.execs, "tmux");
	const h = count(s.execs, "herdr");
	const tmuxTolerance = RED && allowTmux.has(s.name) ? 1 : 0; // pre-fix: 1 driver-routed probe exec
	// Site-4 herdr-native pass-through: herdr pane ids (wN:pM) resolve without any exec — that is
	// correct driver behavior, so green accepts herdr>0 OR a legitimate zero-exec resolution.
	const okGreen = t === 0 && (h > 0 || (s.name === "registerPaneId" && h === 0));
	const okRed = t > tmuxTolerance && h <= tmuxTolerance;
	const pass = RED ? okRed : okGreen;
	if (!pass) failed++;
	const line = `${pass ? "  ok " : " FAIL"} ${s.name}: tmux=${t} herdr=${h} (${RED ? "RED expectation" : "GREEN expectation"})`;
	console.log(line);
	report.push({ site: s.name, tmux: t, herdr: h, execs: s.execs, pass });
	if (!pass) {
		console.log(
			"       execs:",
			JSON.stringify(
				s.execs.map((e) => `${e.bin} ${e.args.join(" ")}`),
				null,
				1,
			),
		);
	}
}

// Tmux byte-identity snapshot (GREEN lane): TmuxDriver must emit the pre-fix argv for the kill path.
{
	const { api, execs } = fakePi();
	process.env.PI_SWARM_TERMINAL_MANAGER = "tmux";
	try {
		await killAgentPaneFn(api, { tmuxTraces: UAT_OUT_DIR }, agent);
	} catch (err) {
		capturedErrors.push({ site: "tmux-byte-identity", error: String(err.message || err) });
	}
	const args = execs.filter((e) => e.bin === "tmux").map((e) => e.args);
	const argvOk =
		args.some((a) => a[0] === "kill-window" && a[1] === "-t" && a[2] === "ws-agents:a1") &&
		args.some((a) => a[0] === "kill-pane" && a[1] === "-t" && a[2] === HERDR_PANE);
	if (!argvOk) failed++;
	console.log(`  ${argvOk ? "ok " : "FAIL"} tmux byte-identity: kill-window/kill-pane argv match pre-fix`);
	report.push({ site: "tmux-byte-identity", argv: args, pass: argvOk });
	process.env.PI_SWARM_TERMINAL_MANAGER = "herdr";
}

// Durable evidence: write the captured execs + verdict to UAT_OUT_DIR so the RED run is preserved
// on disk (AGENTS.md mandate: red artifact must be observed and stored BEFORE source fixes).
writeFileSync(
	join(UAT_OUT_DIR, "execs.json"),
	JSON.stringify({ mode: RED ? "red" : "green", capturedErrors, sites: report }, null, 2),
	"utf8",
);

if (RED) {
	if (failed > 0) {
		console.log(`RED lane: bug NOT reproduced (${failed} site(s) already herdr-routed?)`);
		process.exit(1);
	}
	console.log("RED lane: BUG REPRODUCED — all sites exec tmux under herdr mode");
	process.exit(0);
}

if (failed > 0) {
	console.log(`GREEN lane: ${failed} site(s) not herdr-routed`);
	process.exit(1);
}
console.log("GREEN lane: all four sites route through the herdr driver; tmux byte-identity holds");
