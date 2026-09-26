#!/usr/bin/env node
/** Real pi + mock-LLM replay: human-discuss gate is advisory post-a4a4d05 — the gate is prepared at
 * task creation (status="ready") and does not block implementation. The assignment step requires
 * tmux + a valid provider (swarm_spawn_agent preflight), which the mock-LLM test scratch cannot
 * satisfy; the assign path is covered by swarm-yml-pool.test.mjs and friends. This lane verifies
 * the human-discuss-specific surface: mode preservation, gate artifact, gate-open semantics. */
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "qualification-human-lane-"));
const transcriptRoot = join(scratch, ".pi/mock-llm/transcripts");
const env = { ...process.env, PI_SWARM_AGENT_ID: "root", PI_SWARM_IS_ROOT: "1", PI_MOCK_LLM_TRANSCRIPTS_DIR: transcriptRoot };
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
		"qualification-gate-human-discuss",
		"-p",
		"Create the scripted human-discuss qualification task.",
	],
	{ cwd: scratch, env, timeout: 30_000, encoding: "utf8" },
);
const taskFile = join(scratch, ".pi/swarm/tasks/mock-qualification-human/task.json");
const gateFile = join(scratch, ".pi/swarm/tasks/mock-qualification-human/artifacts/qualification-gate.md");
const transcriptDir = join(transcriptRoot, "qualification-gate-human-discuss");
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
ok("real pi human-discuss lane exits cleanly", run.status === 0, run.stderr || run.stdout);
ok("human-discuss task exists", existsSync(taskFile));
if (existsSync(taskFile)) {
	const task = JSON.parse(readFileSync(taskFile, "utf8"));
	// Post-a4a4d05: human-discuss gate is advisory — status starts at "ready" and stays "ready"
	// (the auto-confirm branch in assign.ts:131-139 only fires for statuses OTHER than "ready"/"confirmed").
	ok("human-discuss mode preserved", task.qualification?.mode === "human-discuss");
	ok("human-discuss gate is open (advisory)", task.qualification?.status === "ready");
	ok(
		"implementer node created with terminal=true",
		task.nodes.implement?.role === "implementer" && task.nodes.implement?.terminal === true,
	);
}
ok("human-discuss gate artifact exists", existsSync(gateFile));
if (existsSync(gateFile)) {
	const gateContent = readFileSync(gateFile, "utf8");
	ok("gate artifact documents human discussion requirement", gateContent.includes("Human discussion required"));
}
ok("human-discuss transcript exists", existsSync(transcriptDir));
if (existsSync(transcriptDir)) {
	const transcript = readdirSync(transcriptDir)
		.map((file) => readFileSync(join(transcriptDir, file), "utf8"))
		.join("\n");
	ok("transcript contains create tool boundary", transcript.includes("qualification-human-create"));
}
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
