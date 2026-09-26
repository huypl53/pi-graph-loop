#!/usr/bin/env node
// === G2 lane: herdr spawn seam (agents.ts spawnAgent → getTerminalDriver) ===
// Task followup-g2-herdr-spawn-seam-20260926.
// RED: observes spawnAgent bypassing the driver seam in herdr mode (raw tmux execs,
//      no herdr tab-create, no herdrPaneId in the record).
// GREEN (after fix): herdr tab-create exec count 1, raw tmux new-session/new-window 0,
//      herdrPaneId present, sendKeys round-trips through the driver.
// Usage: node scripts/uat/herdr-spawn-seam.mjs [--red]
// Evidence: .pi/swarm/tasks/followup-g2-herdr-spawn-seam-20260926/artifacts/{red,green}-lane/
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const swarmRoot = join(repo, "extensions", "swarm");
const taskRoot = join(repo, ".pi", "swarm", "tasks", "followup-g2-herdr-spawn-seam-20260926");
const RED = process.argv.includes("--red") || process.env.UAT_RED === "1";
const outDir = process.env.UAT_OUT_DIR ? join(repo, process.env.UAT_OUT_DIR) : join(taskRoot, "artifacts", RED ? "red-lane" : "green-lane");
mkdirSync(outDir, { recursive: true });

let pass = 0,
	fail = 0;
const ok = (name, cond, detail = "") => {
	if (cond) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
};

// --- scratch swarm root ---
const scratch = mkdtempSync(join(tmpdir(), "g2-seam-"));
mkdirSync(join(scratch, ".pi"), { recursive: true });
process.env.PI_SWARM_ROOT = scratch;
process.env.PI_SWARM_TERMINAL_MANAGER = "herdr";
process.env.PI_SWARM_AGENT_ID = "g2-lane";
process.env.PI_SWARM_IS_ROOT = "1";

// --- boundary-counting pi mock (REAL pi.exec seam: counts every binary invocation) ---
const execCalls = []; // { cmd, args }
const tmuxExecs = () => execCalls.filter((c) => c.cmd === "tmux");
const herdrExecs = () => execCalls.filter((c) => c.cmd === "herdr");
const rawTmuxSpawn = () => tmuxExecs().filter((c) => c.args[0] === "new-session" || c.args[0] === "new-window");
const herdrTabCreate = () => herdrExecs().filter((c) => c.args[0] === "tab" && c.args[1] === "create");

const fakePi = {
	exec: async (cmd, args) => {
		execCalls.push({ cmd, args });
		if (cmd === "herdr") {
			const sub = args[0],
				action = args[1];
			if (sub === "--version") return { code: 0, stdout: "herdr 0.4.0\n", stderr: "" };
			if (sub === "tab" && action === "create") {
				return {
					code: 0,
					stderr: "",
					stdout: JSON.stringify({ result: { tab: { tab_id: "t-g2", workspace_id: "ws-g2" }, root_pane: { pane_id: "p-g2" } } }),
				};
			}
			if (sub === "pane" && action === "send") return { code: 0, stdout: "", stderr: "" };
			if (sub === "workspace" || sub === "tab" || sub === "pane") return { code: 0, stdout: "{}", stderr: "" };
			return { code: 0, stdout: "{}", stderr: "" };
		}
		if (cmd === "tmux") {
			// raw tmux facade: pretend sessions/windows exist so the legacy path "succeeds"
			if (args[0] === "has-session") return { code: 0, stdout: "", stderr: "" };
			if (args[0] === "new-window" || args[0] === "new-session") return { code: 0, stdout: "", stderr: "" };
			if (args[0] === "send-keys") return { code: 0, stdout: "", stderr: "" };
			if (args[0] === "capture-pane") return { code: 0, stdout: "$ ", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	},
};

// --- load real modules ---
const req = createRequire(import.meta.url);
const { spawnAgent } = await import(join(swarmRoot, "src", "agents.ts"));
const { paths, defaultState, writeState, readState } = await import(join(swarmRoot, "src", "state.ts"));

// minimal state bootstrap mirroring production init
const p = paths(scratch);
await (await import(join(swarmRoot, "src", "state.ts"))).ensureDirs(p);
let st = await readState(p, scratch);
st.swarmId = "g2-swarm";
st.tmuxSession = "g2-swarm";
st.rootId = "g2-lane";
await writeState(p, st);

console.log(RED ? "=== G2 RED lane (observe seam bypass) ===" : "=== G2 GREEN lane (driver seam) ===");

let spawnThrew = null;
try {
	await spawnAgent(fakePi, scratch, p, st, { id: "g2-worker", role: "worker" });
} catch (err) {
	spawnThrew = err;
}

// --- assertions (RED mode: the bypass must be OBSERVED; GREEN mode: the seam must be used) ---
if (RED) {
	ok(
		"RED: spawnAgent completed (legacy raw path still 'worked' mechanically)",
		spawnThrew === null,
		String(spawnThrew?.message || spawnThrew),
	);
	ok(
		"RED: herdr tab-create exec count == 0 (driver seam BYPASSED at the real pi.exec boundary)",
		herdrTabCreate().length === 0,
		`herdrTabCreate=${herdrTabCreate().length}`,
	);
	ok(
		"RED: raw tmux new-session/new-window exec observed (the bypass symptom)",
		rawTmuxSpawn().length > 0,
		`rawTmuxSpawn=${rawTmuxSpawn().length}`,
	);
	const rec = st.agents["g2-worker"];
	const noHerdrId = !rec || rec.herdrPaneId === undefined;
	ok("RED: agent record has NO herdrPaneId", noHerdrId, `record=${JSON.stringify(rec?.herdrPaneId ?? null)}`);
	ok(
		"RED: agent record carries tmux-style target (wrong driver target)",
		!rec || /g2-swarm:g2-worker/.test(rec.tmuxTarget || ""),
		`tmuxTarget=${rec?.tmuxTarget}`,
	);
} else {
	ok("GREEN: spawnAgent completed", spawnThrew === null, String(spawnThrew?.message || spawnThrew));
	ok(
		"GREEN R10-1: exactly 1 herdr tab-create exec per spawn (at the real pi.exec boundary)",
		herdrTabCreate().length === 1,
		`herdrTabCreate=${herdrTabCreate().length}`,
	);
	ok(
		"GREEN R10-1: 0 raw tmux new-session/new-window execs in herdr mode",
		rawTmuxSpawn().length === 0,
		`rawTmuxSpawn=${rawTmuxSpawn().length}`,
	);
	const rec = st.agents["g2-worker"];
	ok("GREEN: agent record exists", Boolean(rec));
	ok("GREEN: herdrPaneId mapped into agent record", rec?.herdrPaneId === "p-g2", `herdrPaneId=${JSON.stringify(rec?.herdrPaneId)}`);
	ok(
		"GREEN: driver target reflected (tmuxTarget set from driver return)",
		Boolean(rec?.tmuxTarget) && rec.tmuxTarget !== "g2-swarm:g2-worker.0",
		`tmuxTarget=${rec?.tmuxTarget}`,
	);
	// sendKeys round-trip via the driver (real sendToPane → driver.sendText seam)
	const before = execCalls.length;
	const { sendToPane } = await import(join(swarmRoot, "src", "tmux.ts"));
	let sendErr = null;
	try {
		await sendToPane(fakePi, rec.tmuxTarget, "hello g2");
	} catch (e) {
		sendErr = e;
	}
	const herdrSend = execCalls
		.slice(before)
		.some((c) => c.cmd === "herdr" && (c.args.includes("send-text") || c.args.includes("send-keys")));
	ok(
		"GREEN: sendKeys round-trips through the herdr driver at the real pi.exec boundary",
		sendErr === null && herdrSend,
		`err=${sendErr?.message} herdrSend=${herdrSend}`,
	);
	// backward compat: TMUX mode must use tmux execs and none of herdr
	execCalls.length = 0;
	process.env.PI_SWARM_TERMINAL_MANAGER = "tmux";
	await spawnAgent(fakePi, scratch, p, st, { id: "g2-worker-tmux", role: "worker" });
	const herdrInTmux = herdrExecs().length;
	const tmuxSpawns = rawTmuxSpawn().length;
	ok(
		"GREEN backward-compat: TMUX mode spawns via tmux new-window/new-session (baseline sequence intact)",
		tmuxSpawns >= 1,
		`tmuxSpawn=${tmuxSpawns}`,
	);
	ok("GREEN backward-compat: 0 herdr execs in TMUX mode", herdrInTmux === 0, `herdrExecs=${herdrInTmux}`);
}

// --- durable evidence ---
const evidence = {
	mode: RED ? "red" : "green",
	ts: new Date().toISOString(),
	execCalls: execCalls.map((c) => `${c.cmd} ${c.args.join(" ")}`),
	summary: { herdrTabCreate: herdrTabCreate().length, rawTmuxSpawn: rawTmuxSpawn().length, pass, fail },
	agents: st.agents,
};
writeFileSync(join(outDir, "evidence.json"), JSON.stringify(evidence, null, 2));
writeFileSync(
	join(outDir, "report.md"),
	`# G2 ${RED ? "RED" : "GREEN"} lane\n\npass=${pass} fail=${fail}\n\n- herdr tab-create execs: ${herdrTabCreate().length}\n- raw tmux new-session/new-window execs: ${rawTmuxSpawn().length}\n- agents: ${JSON.stringify(Object.fromEntries(Object.entries(st.agents).map(([k, v]) => [k, { herdrPaneId: v.herdrPaneId ?? null, tmuxTarget: v.tmuxTarget }])))}\n\nFull exec census in evidence.json.\n`,
);
rmSync(scratch, { recursive: true, force: true });
console.log(`\n[${RED ? "RED" : "GREEN"}] pass=${pass} fail=${fail} -> ${outDir}`);
process.exit(fail === 0 ? 0 : 1);
