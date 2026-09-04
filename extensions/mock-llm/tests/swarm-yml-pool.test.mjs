#!/usr/bin/env node
/** Real pi + mock-LLM replay: swarm-yml-pool must resolve its spawn model from a pool declared
 * ONLY in .pi/swarm.yml (no settings.json swarm block). Proves the yml source end-to-end through
 * the real spawnAgent path: the spawned agent record + pool pick trace must carry a yml slot.
 *
 * This is the mock-llm fixture lane required by AGENTS.md ("swarm feature coding: mock-LLM
 * fixtures are compulsory") for the swarm.yml feature (task task-pool-yaml-config). */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "swarm-yml-pool-lane-"));
mkdirSync(join(scratch, ".pi"), { recursive: true });

// Pool declared ONLY in swarm.yml. Slot models = the fixture model itself so the spawned child
// resolves against the mock provider (deterministic, offline).
writeFileSync(join(scratch, ".pi", "swarm.yml"), `# comment-friendly pool (the point of swarm.yml)
modelPool:
  - model: swarm-yml-pool
    provider: mock-llm
    weight: 10
rotation:
  strategy: weighted # inline comment exercises YAML comment handling
`);

const transcriptRoot = join(scratch, ".pi/mock-llm/transcripts");
// MOCK_LLM_API_KEY: preflightSpawn probes provider credentials (a spawned pi would exit with
// "No API key found" for real providers). mock-llm is local and keyless — the conventional
// <PROVIDER>_API_KEY env (suggested by the probe's own error text) marks it authenticated.
const env = { ...process.env, PI_SWARM_AGENT_ID: "root", PI_SWARM_IS_ROOT: "1", PI_MOCK_LLM_TRANSCRIPTS_DIR: transcriptRoot, MOCK_LLM_API_KEY: "mock" };
const run = spawnSync(
	"pi",
	["-ne", "-e", join(repo, "extensions/mock-llm"), "-e", join(repo, "extensions/swarm"), "--provider", "mock-llm", "--model", "swarm-yml-pool", "-p", "Spawn the scripted probe agent using the available swarm tool."],
	{ cwd: scratch, env, timeout: 60_000, encoding: "utf8" },
);

let pass = 0, fail = 0;
const ok = (name, condition, info = "") => { if (condition) { pass++; console.log("  ok  ", name); } else { fail++; console.error("  FAIL", name, info); } };

ok("real pi lane exits cleanly", run.status === 0, (run.stderr || run.stdout || "").slice(-400));

// The spawned agent record must exist and be resolved from the pool.
const stateFile = join(scratch, ".pi", "swarm", "swarm-state.json");
ok("swarm state written (spawn happened)", existsSync(stateFile));
if (existsSync(stateFile)) {
	const st = JSON.parse(readFileSync(stateFile, "utf8"));
	const probe = st.agents?.["yaml-probe"];
	ok("yaml-probe agent recorded", Boolean(probe));
	ok("probe model resolved from yml pool slot (swarm-yml-pool@mock-llm)", probe && probe.model === "swarm-yml-pool" && probe.provider === "mock-llm", JSON.stringify(probe || null).slice(0, 200));
}

// Pool pick must be traced with a yml slot key (pool.spawn_pick carries slot "mock-llm/swarm-yml-pool").
const eventsFile = join(scratch, ".pi", "swarm", "traces", "events.jsonl");
ok("trace events written", existsSync(eventsFile));
if (existsSync(eventsFile)) {
	const lines = readFileSync(eventsFile, "utf8").split("\n").filter(Boolean);
	const picks = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.event === "pool.spawn_pick");
	ok("pool.spawn_pick traced from yml slot", picks.some((r) => r.slot === "mock-llm/swarm-yml-pool"), lines.slice(-3).join(" | ").slice(0, 300));
	const spawnOk = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.event === "agent.spawn.ok");
	ok("agent.spawn.ok carries model+provider from yml pool", spawnOk.some((r) => r.model === "swarm-yml-pool" && r.provider === "mock-llm"));
}

// mock-llm transcript cited as evidence
ok("mock transcript emitted", existsSync(join(transcriptRoot, "swarm-yml-pool")));

// settings.json must NOT have grown a swarm block (yml is the home; scaffold skip modelpool_present)
const settingsFile = join(scratch, ".pi", "settings.json");
if (existsSync(settingsFile)) {
	const s = JSON.parse(readFileSync(settingsFile, "utf8"));
	ok("settings.json has no swarm block (yml is the pool home)", !s.swarm && !s.extensions?.swarm);
} else {
	ok("settings.json has no swarm block (yml is the pool home)", true);
}

console.log(`\nscratch: ${scratch}`);
rmSync(scratch, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
