#!/usr/bin/env node
/** Real pi + mock-LLM replay: task-role-staffing-hint must call the actual
 * swarm_create_task tool and leave the task state on disk. The concise hint
 * text is verified by the focused unit test
 * (extensions/swarm/tests/task-role-skill-hint.test.mjs); this lane proves
 * the real create-task response path is exercised end-to-end. */
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "task-role-staffing-hint-lane-"));
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
		"task-role-staffing-hint",
		"-p",
		"Create the scripted task-role-staffing task using the available swarm tool.",
	],
	{ cwd: scratch, env, timeout: 30_000, encoding: "utf8" },
);
const taskFile = join(scratch, ".pi/swarm/tasks/mock-task-role-staffing/task.json");
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
ok("mock transcript was emitted", existsSync(join(transcriptRoot, "task-role-staffing-hint")));
if (existsSync(taskFile)) {
	const task = JSON.parse(readFileSync(taskFile, "utf8"));
	ok("task persisted auto ready qualification", task.qualification?.mode === "auto" && task.qualification?.status === "ready");
	ok("task persisted the scripted title", task.title === "Mock task role staffing hint");
}
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
