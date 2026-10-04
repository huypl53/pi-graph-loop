#!/usr/bin/env node
/** Real pi + mock-LLM replay: qualification-gate-create must call the actual
 * swarm_create_task tool and leave its qualification artifact on disk. */
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "qualification-gate-lane-"));
const transcriptRoot = join(scratch, ".pi/mock-llm/transcripts");
// PI_SWARM_TERMINAL_MANAGER=tmux (test-hermeticity-pin-unpinned-lanes 2026-10-04): the
// USER's GLOBAL ~/.pi/agent/swarm.yml (e.g. terminalManager: herdr) merges into every
// scratch cwd that does not set inheritGlobal:false — without this pin the child pi
// spawns REAL herdr workspaces in the user's live daemon. Env var is precedence #1 in
// getTerminalDriver, so this pin makes the lane hermetic regardless of host config.
// Same pattern as swarm-yml-pool.test.mjs.
const env = { ...process.env, PI_SWARM_AGENT_ID: "root", PI_SWARM_IS_ROOT: "1", PI_MOCK_LLM_TRANSCRIPTS_DIR: transcriptRoot, PI_SWARM_TERMINAL_MANAGER: "tmux" };
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
		"qualification-gate-create",
		"-p",
		"Create the scripted qualification task using the available swarm tool.",
	],
	{ cwd: scratch, env, timeout: 30_000, encoding: "utf8" },
);
const taskFile = join(scratch, ".pi/swarm/tasks/mock-qualification-gate/task.json");
const gateFile = join(scratch, ".pi/swarm/tasks/mock-qualification-gate/artifacts/qualification-gate.md");
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
ok("real pi lane exits cleanly", run.status === 0, run.stderr || run.stdout);
ok("real tool created task state", existsSync(taskFile));
ok("real tool created qualification artifact", existsSync(gateFile));
if (existsSync(taskFile)) {
	const task = JSON.parse(readFileSync(taskFile, "utf8"));
	ok("task persisted auto ready qualification", task.qualification?.mode === "auto" && task.qualification?.status === "ready");
}
if (existsSync(gateFile))
	ok(
		"artifact contains scripted acceptance claim",
		readFileSync(gateFile, "utf8").includes("The gate is persisted before implementation."),
	);
ok("mock transcript was emitted", existsSync(join(transcriptRoot, "qualification-gate-create")));
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
