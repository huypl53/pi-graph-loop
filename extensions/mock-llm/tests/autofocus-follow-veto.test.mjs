#!/usr/bin/env node
/**
 * autofocus-follow-veto.test.mjs — companion mock-LLM fixture lane for task
 * swarm-autofocus-focus-steal-fixture (covers swarm-autofocus-round2's herdr follow veto).
 *
 * Boundary (documented in the task plan): the mock-LLM provider scripts the LLM side of a pi
 * session; the auto-focus follow veto's observable is a TERMINAL-DRIVER side effect
 * (`herdr tab focus` must NOT be called) plus a durable `focus.skip` trace. Driver state is
 * therefore modeled by a deterministic PATH-injected fake `herdr` stub that (1) reports the
 * user's global focus in a DIFFERENT workspace (wU) than the agents workspace (wA) and
 * (2) appends every argv it receives to a counter file — `tab focus` lines are the boundary
 * evidence at the real exec seam.
 *
 * Lane: real child `pi -ne -e extensions/mock-llm -e extensions/swarm --provider mock-llm
 * --model swarm-autofocus-follow-veto -p …` with PI_SWARM_AGENT_ID=af-worker and
 * PI_SWARM_TERMINAL_MANAGER=herdr. The fixture's toolcall turn fires tool_execution_start →
 * hooks/tools.ts → maybeAutoFocusOnBusy → cross-workspace guard → follow veto.
 *
 * Always deterministic + offline; no real network/API. Test entry: `npm run test:mockllm`.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "swarm-autofocus-follow-veto.jsonl");
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

// === Part 1: fixture schema (always on) ===
console.log("== swarm-autofocus-follow-veto fixture shape ==");
ok("fixture file exists", existsSync(fixturePath));
const turns = existsSync(fixturePath)
	? readFileSync(fixturePath, "utf8")
			.split("\n")
			.filter((l) => l.trim() && !l.startsWith("#"))
			.map((l) => JSON.parse(l))
	: [];
ok("fixture has 2 turns (probe toolcall turn + settle turn)", turns.length === 2, { turns: turns.length });
ok(
	"turn 1 fires a toolcall that triggers the busy-path hook seam",
	turns[0]?.events?.some((e) => e.type === "toolcall" && typeof e.name === "string" && e.name.startsWith("swarm_")),
);
ok("all turns terminate", turns.every((t) => t.stopReason === "stop"));

// === Part 2: real child-pi replay lane (deterministic, offline) ===
console.log("\n== follow-veto replay lane (real pi, mock-llm, fake herdr) ==");
const scratch = mkdtempSync(join(tmpdir(), "swarm-af-veto-lane-"));
mkdirSync(join(scratch, ".pi"), { recursive: true });
mkdirSync(join(scratch, "fakebin"), { recursive: true });

// Agents workspace + herdr terminal manager, matching the seeded worker record below.
writeFileSync(join(scratch, ".pi", "swarm.yml"), "terminalManager: herdr\n");

// Fake herdr stub: user globally focused in workspace wU (NOT the agents workspace wA);
// argv counter for boundary evidence.
const argvLog = join(scratch, "fakebin", "herdr.argv.log");
writeFileSync(
	join(scratch, "fakebin", "herdr"),
	`#!/bin/sh
echo "$*" >> "${argvLog}"
case "$1 $2" in
  "workspace list") echo '{"result":{"workspaces":[{"workspace_id":"wA","label":"swarm-agents"},{"workspace_id":"wU","label":"user-ws"}]}}' ;;
  "tab list") echo '{"result":{"tabs":[{"tab_id":"wU:t1","workspace_id":"wU","label":"user-tab","focused":true},{"tab_id":"wA:t1","workspace_id":"wA","label":"af-worker","focused":false}]}}' ;;
  "pane list") echo '{"result":{"panes":[]}}' ;;
  *) echo '{}' ;;
esac
exit 0
`,
);
chmodSync(join(scratch, "fakebin", "herdr"), 0o755);

// Seed swarm state: worker af-worker (running/busy) in agents workspace wA.
const stateDir = join(scratch, ".pi", "swarm");
mkdirSync(stateDir, { recursive: true });
const now = new Date().toISOString();
writeFileSync(
	join(stateDir, "swarm-state.json"),
	JSON.stringify({
		version: 1,
		swarmId: "af-veto-lane",
		cwd: scratch,
		tmuxSession: "wA",
		autoFocusBusy: true,
		autoFocusPolicy: "follow",
		agents: {
			"af-worker": {
				id: "af-worker",
				role: "worker",
				roleKind: "worker",
				status: "running",
				runtimeStatus: "busy",
				tmuxSession: "wA",
				tmuxWindow: "wA:t1",
				tmuxTarget: "wA:t1",
				lastAgentStartAt: now,
				lastHeartbeatAt: now,
			},
		},
		delivered: {},
		messages: {},
		createdAt: now,
		updatedAt: now,
	}) + "\n",
);

const transcriptRoot = join(scratch, ".pi/mock-llm/transcripts");
const env = {
	...process.env,
	PI_SWARM_AGENT_ID: "af-worker",
	PI_SWARM_IS_ROOT: "",
	PI_SWARM_TERMINAL_MANAGER: "herdr",
	PI_MOCK_LLM_TRANSCRIPTS_DIR: transcriptRoot,
	MOCK_LLM_API_KEY: "mock",
	PATH: `${join(scratch, "fakebin")}:${process.env.PATH || ""}`,
};

const run = spawnSync(
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
		"swarm-autofocus-follow-veto",
		"-p",
		"Run the scripted worker probe turn.",
	],
	{ cwd: scratch, env, timeout: 90_000, encoding: "utf8" },
);

ok("real pi lane exits cleanly", run.status === 0, (run.stderr || run.stdout || "").slice(-400));

// The follow veto must hold end-to-end: ZERO tab focus at the real exec seam.
const argvLines = existsSync(argvLog) ? readFileSync(argvLog, "utf8").split("\n").filter(Boolean) : [];
const tabFocusCount = argvLines.filter((l) => l.startsWith("tab focus")).length;
ok("fake herdr was consulted (stub wired into the lane)", argvLines.length > 0, argvLog);
ok("ZERO `herdr tab focus` calls (follow veto held end-to-end)", tabFocusCount === 0, JSON.stringify(argvLines));

// Durable trace evidence: focus.skip with the stable follow-veto reason + policy.
const eventsPath = join(stateDir, "traces", "events.jsonl");
const traceLines = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8").split("\n").filter(Boolean) : [];
const focusSkips = traceLines
	.map((l) => {
		try {
			return JSON.parse(l);
		} catch {
			return null;
		}
	})
	.filter((e) => e && (e.event === "focus.skip" || e.type === "focus.skip" || JSON.stringify(e).includes("focus.skip")));
const veto = focusSkips.find((e) => {
	const d = e.data || e;
	return d.reason === "user-focused-outside-agents-workspace" && d.policy === "follow";
});
ok("focus.skip trace present with follow-veto reason + policy", Boolean(veto), JSON.stringify(focusSkips).slice(0, 200));

// Transcript evidence (exact path recorded for the artifact). The mock-llm provider writes
// one .json transcript per request under <transcriptsDir>/<modelId>/.
let transcriptFile = "";
try {
	const modelDir = join(transcriptRoot, "swarm-autofocus-follow-veto");
	const files = readdirSync(modelDir).filter((f) => f.endsWith(".json")).sort();
	for (const f of files) {
		const p = join(modelDir, f);
		if (readFileSync(p, "utf8").includes("swarm-autofocus-follow-veto")) {
			transcriptFile = p;
			break;
		}
	}
} catch (err) {
	console.error("transcript scan failed:", err?.message || err);
}
ok("mock-llm transcript captured", Boolean(transcriptFile), transcriptRoot);

// Record the exact lane + paths for the artifact report.
writeFileSync(
	join(scratch, "lane-record.json"),
	JSON.stringify(
		{
			scratch,
			command:
				'pi -ne -e extensions/mock-llm -e extensions/swarm --provider mock-llm --model swarm-autofocus-follow-veto -p "Run the scripted worker probe turn."',
			env: {
				PI_SWARM_AGENT_ID: "af-worker",
				PI_SWARM_TERMINAL_MANAGER: "herdr",
				fakeHerdr: join(scratch, "fakebin", "herdr"),
			},
			fakeHerdrArgvLog: argvLog,
			tracePath: eventsPath,
			transcriptPath: transcriptFile,
			argvLines,
			focusSkips,
		},
		null,
		2,
	) + "\n",
);

console.log(`\nSWARM-AUTOFOCUS-FOLLOW-VETO ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
if (process.env.AF_VETO_KEEP !== "1") rmSync(scratch, { recursive: true, force: true });
else console.log("scratch kept:", scratch);
process.exit(fail === 0 ? 0 : 1);
