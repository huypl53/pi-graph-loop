#!/usr/bin/env node
/** Real pi + mock-LLM replay: human-discuss blocks implementation, confirms, then assigns. */
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "qualification-human-lane-"));
const transcriptRoot = join(scratch, ".pi/mock-llm/transcripts");
const env = { ...process.env, PI_SWARM_AGENT_ID: "root", PI_SWARM_IS_ROOT: "1", PI_MOCK_LLM_TRANSCRIPTS_DIR: transcriptRoot };
const run = spawnSync("pi", ["-ne", "-e", join(repo, "extensions/mock-llm"), "-e", join(repo, "extensions/swarm"), "--provider", "mock-llm", "--model", "qualification-gate-human-discuss", "-p", "Run the scripted human-discuss qualification flow."], { cwd: scratch, env, timeout: 30_000, encoding: "utf8" });
const taskFile = join(scratch, ".pi/swarm/tasks/mock-qualification-human/task.json");
const transcriptDir = join(transcriptRoot, "qualification-gate-human-discuss");
let pass = 0, fail = 0;
const ok = (name, condition, info = "") => { if (condition) { pass++; console.log("  ok  ", name); } else { fail++; console.error("  FAIL", name, info); } };
ok("real pi human-discuss lane exits cleanly", run.status === 0, run.stderr || run.stdout);
ok("human-discuss task exists", existsSync(taskFile));
if (existsSync(taskFile)) {
  const task = JSON.parse(readFileSync(taskFile, "utf8"));
  ok("human discussion became confirmed", task.qualification?.mode === "human-discuss" && task.qualification?.status === "confirmed");
  ok("implementer assignment succeeded after confirmation", task.nodes.implement?.status === "assigned");
}
ok("human-discuss transcript exists", existsSync(transcriptDir));
if (existsSync(transcriptDir)) {
  const transcript = readdirSync(transcriptDir).map((file) => readFileSync(join(transcriptDir, file), "utf8")).join("\n");
  ok("transcript contains pre-confirmation assign attempt", transcript.includes("qualification-blocked-assign"));
  ok("transcript contains confirmation tool boundary", transcript.includes("swarm_confirm_qualification"));
}
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
