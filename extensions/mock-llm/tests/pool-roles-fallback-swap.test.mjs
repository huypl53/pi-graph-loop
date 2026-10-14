#!/usr/bin/env node
/** Real pi + mock-LLM lane for the D2 roles-bypass swap fallback (plan 2026-10-14).
 *
 * Seeds the live-incident shape: pool = [main(roles:root, failing), other-root(roles:root,
 * PRE-BENCHED via seeded pool-state.json), alt(untagged healthy — the bypass target)]. The root
 * agent's roleKind comes from seeded swarm-state.json. Expected green:
 *   - pool.swap trace with rolesIgnored:true landing on mock-llm/pool-roles-fallback-swap-alt
 *   - turn 2 transcript exists (task completed on the alternate model)
 *   - the failing slot benched exactly ONCE (D1: cooldownUntil fixed, no rolling re-bench)
 * Run: node extensions/mock-llm/tests/pool-roles-fallback-swap.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "pool-roles-fallback-swap-"));
const transcripts = join(scratch, ".pi/mock-llm/transcripts");
mkdirSync(join(scratch, ".pi/swarm"), { recursive: true });

writeFileSync(
	join(scratch, ".pi", "swarm.yml"),
	`modelPool:
  - model: pool-roles-fallback-swap
    provider: mock-llm
    roles: [root]
  - model: pool-quota-bench-cooldown-recovery
    provider: mock-llm
    roles: [root]
  - model: pool-roles-fallback-swap-alt
    provider: mock-llm
rotation:
  strategy: weighted
`,
);
// Pre-bench the OTHER root-tagged slot for 2h (the live-incident shape: both root slots dead).
writeFileSync(
	join(scratch, ".pi/swarm", "pool-state.json"),
	JSON.stringify(
		{
			slots: {
				"mock-llm/pool-quota-bench-cooldown-recovery": {
					failures: 0,
					cooldownUntil: new Date(Date.now() + 2 * 3600_000).toISOString(),
					benchStreak: 1,
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
		swarmId: "roles-fallback-lane",
		cwd: scratch,
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
		"pool-roles-fallback-swap",
		"-p",
		"Continue the task after any provider error; report the result.",
	],
	{ cwd: scratch, env, timeout: 90_000, encoding: "utf8" },
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

const swap = events.filter((e) => e.event === "pool.swap").at(-1);
ok("lane ran (pi exit code 0)", run.status === 0, `exit=${run.status} stderr=${(run.stderr || "").slice(0, 300)}`);
ok("pool.swap traced", !!swap, eventsTxt.slice(0, 400));
ok("swap landed on the untagged alt slot", swap?.to === "mock-llm/pool-roles-fallback-swap-alt", JSON.stringify(swap));
ok("swap carries rolesIgnored:true (D2 loud fallback)", swap?.rolesIgnored === true, JSON.stringify(swap));
ok("rolesFilterMatched false on bypass (R8)", swap?.rolesFilterMatched === false, JSON.stringify(swap));
ok("no swap_no_candidate", !events.some((e) => e.event === "pool.swap_no_candidate"));

// D1 observability from the lane: the failing slot benched exactly once, cooldownUntil not rolled.
const poolState = JSON.parse(readFileSync(join(scratch, ".pi/swarm", "pool-state.json"), "utf8"));
const mainHealth = poolState.slots["mock-llm/pool-roles-fallback-swap"];
ok("failing slot benched", !!mainHealth?.cooldownUntil, JSON.stringify(mainHealth));
ok("bench bounded by D4 ceiling (≤ 1h + slack)", mainHealth?.cooldownUntil ? new Date(mainHealth.cooldownUntil).getTime() - Date.now() <= 3_600_500 : false, JSON.stringify(mainHealth));

// Transcript evidence: turn 2 ran on the alt model (transcripts/<model>/ dir per model).
const altTranscriptDir = join(transcripts, "pool-roles-fallback-swap-alt");
ok("alt-model transcript dir written (task continued on the bypass target)", existsSync(altTranscriptDir));

if (fail === 0) console.log(`\nPASS: ${pass} passed, 0 failed`);
else {
	console.error(`\nFAIL: ${pass} passed, ${fail} failed`);
	console.error("stdout:", (run.stdout || "").slice(0, 800));
}
rmSync(scratch, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
