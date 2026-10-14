#!/usr/bin/env node
/**
 * Real pi + mock-LLM deterministic proxy for the /reload hook-pipeline regression.
 * Pi's /reload command cannot be invoked as a model scripted toolcall; the unit tests
 * directly exercise stale-context dispatch and pump re-arm, while this lane proves
 * the fresh pool hook observes a quota error and reaches gated-retry recovery.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "pool-reload-hook-death-"));
const transcripts = join(scratch, ".pi/mock-llm/transcripts");
mkdirSync(join(scratch, ".pi/swarm"), { recursive: true });
writeFileSync(
	join(scratch, ".pi", "swarm.yml"),
	`modelPool:\n  - model: pool-reload-hook-death\n    provider: mock-llm\n    roles: [root]\n  - model: pool-upstream-buffer-limit-alt\n    provider: mock-llm\n    roles: [root]\nrotation:\n  strategy: round-robin\n  maxRetries: 1\n  cooldownMs: 300000\n`,
);
writeFileSync(
	join(scratch, ".pi/swarm", "swarm-state.json"),
	JSON.stringify({
		version: 1,
		swarmId: "reload-hook-death-lane",
		cwd: scratch,
		tmuxSession: "t",
		agents: {
			root: {
				id: "root",
				roleKind: "root",
				status: "running",
				createdAt: new Date().toISOString(),
			},
		},
		messages: {},
		delivered: {},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	}),
);

const env = {
	...process.env,
	PI_SWARM_AGENT_ID: "root",
	PI_SWARM_IS_ROOT: "1",
	PI_SWARM_TERMINAL_MANAGER: "tmux",
	PI_SWARM_TMUX_OK: "1",
	PI_MOCK_LLM_TRANSCRIPTS_DIR: transcripts,
	MOCK_LLM_API_KEY: "mock",
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
		"pool-reload-hook-death",
		"-p",
		"Continue after any provider error and report the recovery."
	],
	{ cwd: scratch, env, timeout: 60_000, encoding: "utf8" },
);

let pass = 0;
let fail = 0;
const ok = (name, condition, info = "") => {
	if (condition) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info);
	}
};
const eventsFile = join(scratch, ".pi/swarm/traces/events.jsonl");
const events = existsSync(eventsFile)
	? readFileSync(eventsFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
	: [];
const transcriptsExist = existsSync(join(transcripts, "pool-reload-hook-death"));
const files = transcriptsExist ? readdirSync(join(transcripts, "pool-reload-hook-death")) : [];
ok("real pi lane exits successfully", run.status === 0, `status=${run.status} stderr=${(run.stderr || "").slice(-500)}`);
const gatedIndex = events.findIndex((event) => event.event === "pool.swap_gated_by_engine_retry" && event.kind === "quota");
const recoveredIndex = events.findIndex((event) => event.event === "pool.engine_retry_recovered");
ok(
	"fresh pool hook gates the quota error for engine retry",
	gatedIndex >= 0,
	JSON.stringify(events.filter((event) => event.event?.startsWith("pool."))),
);
ok(
	"fresh pool hook records retry recovery after the quota gate",
	recoveredIndex > gatedIndex,
	JSON.stringify(events.filter((event) => event.event?.startsWith("pool."))),
);
ok("provider transcript was captured", files.some((file) => file.endsWith(".json")), JSON.stringify(files));
console.log(`scratch: ${scratch}`);
if (process.env.KEEP_POOL_RELOAD_HOOK_DEATH_ARTIFACTS !== "1") rmSync(scratch, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
