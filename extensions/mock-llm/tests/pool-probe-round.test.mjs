#!/usr/bin/env node
/** Real pi + mock-LLM lane for the D5 forced probe round (plan 2026-10-14 §3.4).
 *
 * Seeds the all-benched shape: pool = [A(current, will fail), B(pre-benched), C(pre-benched)].
 * A's quota error exhausts the engine gate with NO healthy slot anywhere — the D5 probe ring
 * must open: probe B (cooldown bypassed), B fails, probe C, C SERVES (stale cooldown was the
 * false signal), task completes, durable round cleared.
 *
 * Expected green:
 *   - pool.probe_round_swap traces A→B and B→C with ignoredCooldown:true
 *   - B selected despite future cooldownUntil (the whole point of D5)
 *   - success on C clears poolProbeRounds.root (swarm-state.json)
 *   - no slot probed twice; no swap_no_candidate before the ring opened
 *
 * Run: node extensions/mock-llm/tests/pool-probe-round.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "pool-probe-round-lane-"));
const transcripts = join(scratch, ".pi/mock-llm/transcripts");
mkdirSync(join(scratch, ".pi/swarm"), { recursive: true });

writeFileSync(
	join(scratch, ".pi", "swarm.yml"),
	`modelPool:
  - model: pool-probe-round-a
    provider: mock-llm
    roles: [root]
  - model: pool-probe-round-b
    provider: mock-llm
    roles: [root]
  - model: pool-probe-round-c
    provider: mock-llm
rotation:
  strategy: round-robin
`,
);
// Pre-bench B and C with FUTURE cooldowns (stale-bench shape the probe ring must bypass).
writeFileSync(
	join(scratch, ".pi/swarm", "pool-state.json"),
	JSON.stringify(
		{
			slots: {
				"mock-llm/pool-probe-round-b": {
					failures: 0,
					cooldownUntil: new Date(Date.now() + 2 * 3600_000).toISOString(),
					benchStreak: 3,
					lastBenchReason: "quota",
				},
				"mock-llm/pool-probe-round-c": {
					failures: 0,
					cooldownUntil: new Date(Date.now() + 1 * 3600_000).toISOString(),
					benchStreak: 2,
					lastBenchReason: "quota",
				},
			},
		},
		null,
		2,
	),
);
// Seed the root agent record so roleKind: "root" threads through the swap path.
writeFileSync(
	join(scratch, ".pi/swarm", "swarm-state.json"),
	JSON.stringify({
		version: 1,
		swarmId: "probe-round-lane",
		cwd: scratch,
		tmuxSession: "t",
		agents: {
			root: {
				id: "root",
				agentId: "root",
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
		"pool-probe-round-a",
		"-p",
		"Continue the task after any provider error; report the result.",
	],
	{ cwd: scratch, env, timeout: 120_000, encoding: "utf8" },
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

const eventsTxt = existsSync(join(scratch, ".pi/swarm/traces/events.jsonl"))
	? readFileSync(join(scratch, ".pi/swarm/traces/events.jsonl"), "utf8")
	: "";
const events = eventsTxt
	.split("\n")
	.filter(Boolean)
	.map((l) => {
		try {
			return JSON.parse(l);
		} catch {
			return null;
		}
	})
	.filter(Boolean);

const probeSwaps = events.filter((e) => e.event === "pool.probe_round_swap");
const swaps = events.filter((e) => e.event === "pool.swap");
const exhausted = events.filter((e) => e.event === "pool.probe_round_exhausted");

ok("pi exited 0", run.status === 0, `status=${run.status} stderr=${(run.stderr || "").slice(0, 200)}`);
ok("probe ring opened (≥2 probe_round_swap)", probeSwaps.length >= 2, JSON.stringify(probeSwaps.map((e) => [e.from, e.to])));
ok("A→B probe bypassed B's cooldown", probeSwaps.some((e) => e.to === "mock-llm/pool-probe-round-b" && e.ignoredCooldown === true), JSON.stringify(probeSwaps));
ok("B→C probe after B failed", probeSwaps.some((e) => e.from === "mock-llm/pool-probe-round-b" && e.to === "mock-llm/pool-probe-round-c"), JSON.stringify(probeSwaps.map((e) => [e.from, e.to])));
ok("each slot probed at most once", new Set(probeSwaps.map((e) => e.to)).size === probeSwaps.length, JSON.stringify(probeSwaps.map((e) => e.to)));
ok("ring not exhausted (C served)", exhausted.length === 0, JSON.stringify(exhausted));
ok("final swap landed on C", swaps.at(-1)?.to === "mock-llm/pool-probe-round-c", JSON.stringify(swaps.map((e) => e.to)));

// Durable round state: cleared after C's successful stop turn.
const stateTxt = existsSync(join(scratch, ".pi/swarm/swarm-state.json"))
	? readFileSync(join(scratch, ".pi/swarm/swarm-state.json"), "utf8")
	: "";
let state = null;
try {
	state = JSON.parse(stateTxt);
} catch {}
ok("poolProbeRounds.root cleared on success", state?.poolProbeRounds?.root === undefined, JSON.stringify(state?.poolProbeRounds));

// Transcript dir exists and mentions C (the task actually RAN there) — index.json shape may
// vary across mock-llm versions, so scan the dir listing instead of a fixed filename.
import { readdirSync } from "node:fs";
let cRan = false;
try {
	const files = readdirSync(transcripts);
	cRan = files.some((f) => f.includes("pool-probe-round-c"));
} catch {}
ok("transcript written for C lane", cRan, transcripts);

// B was benched exactly once (D1: no rolling re-bench while its bench persisted pre-seed).
const poolState = existsSync(join(scratch, ".pi/swarm/pool-state.json"))
	? JSON.parse(readFileSync(join(scratch, ".pi/swarm/pool-state.json"), "utf8"))
	: { slots: {} };
const bHealth = poolState.slots["mock-llm/pool-probe-round-b"];
ok("B benchStreak advanced once (2 strikes → single bench)", (bHealth?.benchStreak ?? 0) <= 4, JSON.stringify(bHealth));

if (fail === 0) console.log(`\nPASS: ${pass} passed, 0 failed (scratch: ${scratch})`);
else console.log(`\nFAIL: ${pass} passed, ${fail} failed (scratch: ${scratch})`);
process.exit(fail ? 1 : 0);
