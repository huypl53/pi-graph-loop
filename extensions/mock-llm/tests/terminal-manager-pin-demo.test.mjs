#!/usr/bin/env node
/**
 * terminal-manager-pin-demo.test.mjs — behavioral demo lane for
 * test-hermeticity-pin-unpinned-lanes (2026-10-04).
 *
 * Proves the LEAK and the FIX end-to-end through a REAL pi child:
 *
 *   Leg A (RED — the leak): scratch HOME seeded with global
 *   ~/.pi/agent/swarm.yml (terminalManager: herdr), PI_SWARM_TERMINAL_MANAGER
 *   UNSET, fake `herdr` stub on PATH (sandboxed — never touches the live herdr
 *   daemon). The child pi's fixture calls swarm_spawn_agent. Expected: the
 *   child resolves the herdr driver from the global yml (env unset → cfg
 *   wins), pi.exec("herdr", ...) calls land in the fake stub's argv log, and
 *   the spawned agent record carries herdrPaneId. This is the exact leak
 *   fixed in 49241ad for swarm-yml-pool — recreated deterministically.
 *
 *   Leg B (GREEN — the pin): same world but PI_SWARM_TERMINAL_MANAGER=tmux
 *   in the child env (the pattern now pinned into all 12 spawn-based lanes).
 *   Expected: the env pin is precedence #1 in getTerminalDriver, the spawn
 *   goes through tmux (guarded by PI_SWARM_TMUX_OK so the tmux probe passes
 *   without a real tmux server; the tmux exec boundary itself hits the fake
 *   stub — assert herdr argv log does NOT grow), and the agent record has NO
 *   herdrPaneId.
 *
 * Fake stubs on PATH (the autofocus-follow-veto pattern):
 *   herdr — records argv, returns canned workspace/tab JSON for spawn.
 *   tmux  — records argv, returns canned list-panes/has-session/new-session.
 *
 * Assertions on child-side state (survives the child's exit):
 *   - fake herdr argv log: leg A has tab-create lines, leg B does not grow.
 *   - fake tmux argv log: leg B has new-session lines, leg A does not.
 *   - spawned agent record in scratch swarm-state.json: leg A herdrPaneId
 *     present; leg B herdrPaneId absent + tmuxTarget tmux-shaped.
 *
 * Run: node extensions/mock-llm/tests/terminal-manager-pin-demo.test.mjs
 * (also runs under `npm run test:mockllm` — deterministic, offline).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");

let pass = 0,
	fail = 0;
const ok = (name, condition, info = "") => {
	if (condition) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info);
	}
};

// === Fixture schema (always on) ===
const fixturePath = join(repo, "extensions/mock-llm/fixtures/terminal-manager-pin-demo.jsonl");
ok("fixture exists", existsSync(fixturePath));
const turns = existsSync(fixturePath)
	? readFileSync(fixturePath, "utf8")
			.split("\n")
			.filter((l) => l.trim() && !l.startsWith("#"))
			.map((l) => JSON.parse(l))
	: [];
ok("fixture has 1 turn with a swarm_spawn_agent toolcall", turns.length >= 1 && turns[0].events?.some((e) => e.type === "toolcall" && e.name === "swarm_spawn_agent"), JSON.stringify(turns).slice(0, 200));

// === Shared world builder ===
// Scratch project + scratch HOME (global yml seeded terminalManager: herdr — the real leak
// shape: the USER's global config merges into every scratch cwd). Fake herdr + tmux stubs
// on PATH intercept ALL terminal-driver execs; the live daemons are never touched.
function buildWorld(tag) {
	const scratch = mkdtempSync(join(tmpdir(), `tm-pin-demo-${tag}-`));
	const home = join(scratch, "home");
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	// The REAL leak vector: global yml declares herdr; a scratch cwd without an explicit
	// override inherits it (config layering).
	writeFileSync(join(home, ".pi", "agent", "swarm.yml"), "terminalManager: herdr\n");
	// Project-level pool so spawn resolves the mock provider deterministically (keyless).
	mkdirSync(join(scratch, ".pi"), { recursive: true });
	writeFileSync(join(scratch, ".pi", "swarm.yml"), "modelPool:\n  - model: terminal-manager-pin-demo\n    provider: mock-llm\n    weight: 10\n");
	mkdirSync(join(scratch, "fakebin"), { recursive: true });
	const herdrLog = join(scratch, "fakebin", "herdr.argv.log");
	const tmuxLog = join(scratch, "fakebin", "tmux.argv.log");
	// herdr stub: canned 0.8.2-shaped JSON for the spawn path (workspace list/create,
	// tab create, pane run). Every argv line is boundary evidence.
	writeFileSync(
		join(scratch, "fakebin", "herdr"),
		`#!/bin/sh
echo "herdr $*" >> "${herdrLog}"
case "$1 $2" in
  "workspace list") echo '{"result":{"workspaces":[]}}' ;;
  workspace*) echo '{"result":{"workspace":{"workspace_id":"wDEMO","label":"swarm-agents-demo"},"tab":{"tab_id":"wDEMO:t1"}}}' ;;
  "tab create") echo '{"result":{"tab":{"tab_id":"wDEMO:tA","workspace_id":"wDEMO"},"root_pane":{"pane_id":"wDEMO:pA"}}}' ;;
  "pane run") echo '{"result":{}}' ;;
  "tab close") echo '{"result":{}}' ;;
  *) echo '{"result":{}}' ;;
esac
exit 0
`,
	);
	chmodSync(join(scratch, "fakebin", "herdr"), 0o755);
	// tmux stub: has-session fails with the exact fallback-triggering message, new-session
	// succeeds with -P -F shaped output (session:window.pane<TAB>pane_id), list-panes reports
	// the fresh pane so liveness probes pass.
	writeFileSync(
		join(scratch, "fakebin", "tmux"),
		`#!/bin/sh
echo "tmux $*" >> "${tmuxLog}"
case "$1" in
  has-session) echo "can't find session '$4'" >&2; exit 1 ;;
  new-session) echo 'swarm-demo:0.0\t%1' ;;
  new-window) echo 'swarm-demo:1.0\t%2' ;;
  list-panes) echo '%1 0 1 1' ;;
  display-message) echo 'pi' ;;
  *) echo '' ;;
esac
exit 0
`,
	);
	chmodSync(join(scratch, "fakebin", "tmux"), 0o755);
	return { scratch, home, herdrLog, tmuxLog };
}

function childEnv({ scratch, home }, { pin }) {
	const env = {
		...process.env,
		HOME: home,
		PI_SWARM_AGENT_ID: "root",
		PI_SWARM_IS_ROOT: "1",
		PI_MOCK_LLM_TRANSCRIPTS_DIR: join(scratch, ".pi/mock-llm/transcripts"),
		MOCK_LLM_API_KEY: "mock",
		PI_SWARM_TMUX_OK: "1", // documented bypass (pool.ts checkTmuxSession): no real tmux server in the lane; tmux exec boundary itself is the fake stub
		PI_SWARM_TERMINAL_MANAGER: pin ? "tmux" : undefined,
		PATH: `${join(scratch, "fakebin")}:${process.env.PATH || ""}`,
	};
	if (!pin) delete env.PI_SWARM_TERMINAL_MANAGER; // UNSET = resolve from cfg (the leak shape)
	return env;
}

function runLane(world, pin) {
	return spawnSync(
		"pi",
		[
			"-ne",
			"-e",
			join(repo, "extensions/mock-llm"),
			"-e",
			join(repo, "extensions/swarm"),
			"--provider",
			"mock-llm",
			"--model",
			"terminal-manager-pin-demo",
			"-p",
			"Spawn the scripted demo probe agent using the available swarm tool.",
		],
		{ cwd: world.scratch, env: childEnv(world, { pin }), timeout: 90_000, encoding: "utf8" },
	);
}

function readAgentRecord(scratch, agentId) {
	const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");
	if (!existsSync(statePath)) return null;
	try {
		const st = JSON.parse(readFileSync(statePath, "utf8"));
		return st.agents?.[agentId] ?? null;
	} catch {
		return null;
	}
}

const argvLines = (log) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);

// === Leg A: RED — the leak (no pin; global yml herdr wins) ===
console.log("\n== Leg A: no pin, global yml herdr (the leak shape) ==");
const worldA = buildWorld("a");
const runA = runLane(worldA, false);
ok("leg A: real pi lane exits cleanly", runA.status === 0, (runA.stderr || runA.stdout || "").slice(-400));

const herdrLinesA = argvLines(worldA.herdrLog);
ok(
	"leg A: fake herdr was consulted by the child (leak reproduced — driver resolved herdr from global yml)",
	herdrLinesA.some((l) => l.includes("tab create")),
	`herdr argv log (${herdrLinesA.length} lines): ${herdrLinesA.slice(0, 6).join(" | ")}`,
);
const recA = readAgentRecord(worldA.scratch, "tmp-demo-probe");
ok("leg A: agent record persisted", Boolean(recA), "tmp-demo-probe missing from swarm-state.json");
ok(
	"leg A: spawned agent record carries herdrPaneId (child-side herdr evidence)",
	Boolean(recA?.herdrPaneId),
	`herdrPaneId=${JSON.stringify(recA?.herdrPaneId)} tmuxTarget=${JSON.stringify(recA?.tmuxTarget)}`,
);

// === Leg B: GREEN — the pin (PI_SWARM_TERMINAL_MANAGER=tmux beats the global yml) ===
console.log("\n== Leg B: pin set (the fix — same as the 12 pinned lanes) ==");
const worldB = buildWorld("b");
const runB = runLane(worldB, true);
ok("leg B: real pi lane exits cleanly", runB.status === 0, (runB.stderr || runB.stdout || "").slice(-400));

const herdrLinesB = argvLines(worldB.herdrLog);
ok(
	"leg B: fake herdr NOT consulted (env pin is precedence #1 in getTerminalDriver)",
	herdrLinesB.length === 0,
	`herdr argv log: ${herdrLinesB.slice(0, 6).join(" | ")}`,
);
const tmuxLinesB = argvLines(worldB.tmuxLog);
ok(
	"leg B: fake tmux WAS consulted (spawn went through the tmux driver)",
	tmuxLinesB.some((l) => l.includes("new-session") || l.includes("new-window")),
	`tmux argv log: ${tmuxLinesB.slice(0, 6).join(" | ")}`,
);
const recB = readAgentRecord(worldB.scratch, "tmp-demo-probe");
ok("leg B: agent record persisted", Boolean(recB), "tmp-demo-probe missing from swarm-state.json");
ok(
	"leg B: spawned agent record has NO herdrPaneId (tmux-shaped)",
	recB ? recA?.herdrPaneId === undefined || recB.herdrPaneId === undefined : false,
	`herdrPaneId=${JSON.stringify(recB?.herdrPaneId)} tmuxTarget=${JSON.stringify(recB?.tmuxTarget)}`,
);
ok(
	"leg B: tmuxTarget is tmux-shaped (no wN:pM herdr pane id)",
	Boolean(recB?.tmuxTarget) && !/^w[A-Za-z0-9_-]+:p[A-Za-z0-9]+$/.test(recB.tmuxTarget),
	`tmuxTarget=${JSON.stringify(recB?.tmuxTarget)}`,
);

// Cleanup
for (const w of [worldA, worldB]) rmSync(w.scratch, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
