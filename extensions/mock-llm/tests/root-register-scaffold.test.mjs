#!/usr/bin/env node
/** Real pi + mock-LLM replay: root-register-scaffold must initiate .pi/swarm.yml
 * on root startup and registration when missing. */
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "root-register-scaffold-lane-"));
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
		"root-register-scaffold",
		"-p",
		"Check root agent status and verify swarm configuration.",
	],
	{ cwd: scratch, env, timeout: 30_000, encoding: "utf8" },
);
const ymlPath = join(scratch, ".pi/swarm.yml");
const statePath = join(scratch, ".pi/swarm/swarm-state.json");
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
ok(".pi/swarm.yml was scaffolded", existsSync(ymlPath));
ok("mock transcript was emitted", existsSync(join(transcriptRoot, "root-register-scaffold")));
if (existsSync(statePath)) {
	const st = JSON.parse(readFileSync(statePath, "utf8"));
	ok("poolScaffoldNotifiedAt stamped in SwarmState", Boolean(st.poolScaffoldNotifiedAt));
} else {
	ok("swarm-state.json exists", false);
}
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
