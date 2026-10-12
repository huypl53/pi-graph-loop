#!/usr/bin/env node
/** Real pi + mock-LLM lane for the proxy request-buffer failure and pool rotation. */
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	existsSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "pool-upstream-buffer-limit-"));
const transcripts = join(scratch, ".pi/mock-llm/transcripts");
mkdirSync(join(scratch, ".pi"), { recursive: true });
writeFileSync(
	join(scratch, ".pi", "swarm.yml"),
	`modelPool:\n  - model: pool-upstream-buffer-limit\n    provider: mock-llm\n    weight: 1\n  - model: pool-upstream-buffer-limit-alt\n    provider: mock-llm\n    weight: 1\nrotation:\n  strategy: round-robin\n  maxRetries: 1\n  cooldownMs: 300000\n`,
);

const env = {
	...process.env,
	PI_SWARM_AGENT_ID: "buffer-limit-worker",
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
		"pool-upstream-buffer-limit",
		"-p",
		"Continue the task after any provider error; report the result.",
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
ok("real pi lane exits successfully after fallback rotation", run.status === 0, (run.stderr || run.stdout || "").slice(-600));
const eventsFile = join(scratch, ".pi/swarm/traces/events.jsonl");
ok("swarm trace exists", existsSync(eventsFile));
if (existsSync(eventsFile)) {
	const events = readFileSync(eventsFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
	ok(
		"buffer-limit failure records terminal slot failure",
		events.some((event) => event.event === "pool.slot_failure" && event.benchReason === "request_limit"),
		JSON.stringify(events.filter((event) => event.event?.startsWith("pool."))),
	);
	ok(
		"pool rotates from failed source to alternate model",
		events.some(
			(event) =>
				event.event === "pool.swap" &&
				event.kind === "request_limit" &&
				event.to === "mock-llm/pool-upstream-buffer-limit-alt",
		),
		JSON.stringify(events.filter((event) => event.event === "pool.swap")),
	);
}
const sourceTranscriptDir = join(transcripts, "pool-upstream-buffer-limit");
const sourceTranscripts = existsSync(sourceTranscriptDir)
	? readdirSync(sourceTranscriptDir).filter((name) => name.endsWith(".json"))
	: [];
ok(
	"source transcript records the exact upstream buffer error",
	sourceTranscripts.some((name) =>
		readFileSync(join(sourceTranscriptDir, name), "utf8").includes(
			"exceeded request buffer limit while retrying upstream",
		),
	),
);
ok(
	"alternate model transcript proves post-swap request",
	existsSync(join(transcripts, "pool-upstream-buffer-limit-alt")),
);
console.log(`\nscratch: ${scratch}`);
if (process.env.KEEP_POOL_BUFFER_LIMIT_ARTIFACTS !== "1") rmSync(scratch, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
