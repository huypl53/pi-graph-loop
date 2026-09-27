// Pool config UX + preflight tests (v4.2: YAML-only)
//
// Run: node extensions/swarm/tests/pool-config.test.mjs
//
// Covers:
//   - legacy singleton config preserved as implicit singleton pool (no rewrite)
//   - valid explicit pool classified + validated + shown correctly
//   - invalid config (empty model, bad weight, duplicate, bad strategy) caught by validate
//   - pool_exhausted preflight when all slots benched
//   - pool ok preflight when one slot is eligible
//   - preview-preflight without tmux: only fires tmux branch when tmuxSession requested
//   - implicit singleton + show rendering output includes expected fields
//   - validateSwarmSettings handles missing / unreadable yml shapes
//
// v4.2: YAML-only. Uses .pi/swarm.yml instead of .pi/settings.json.
// Every assertion is read-only — never edits .pi/swarm.yml.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../src/state.ts";
import {
	classifySwarmSettings,
	implicitSingletonPool,
	pickSlot,
	poolStatus,
	preflightSpawn,
	recordProviderError,
	validateSwarmSettings,
} from "../src/pool.ts";

let pass = 0,
	fail = 0;
const ok = (name, cond) => {
	if (cond) pass++;
	else {
		fail++;
		console.error("  FAIL:", name);
	}
};

process.env.TMUX ||= "/tmp/tmux-test,1234,0";
process.env.OPENAI_API_KEY ||= "mock-key";
process.env.ZAI_CODING_CN_API_KEY ||= "mock-key";
process.env.ANTHROPIC_API_KEY ||= "mock-key";

const dir = await mkdtemp(join(tmpdir(), "pool-config-test-"));
await mkdir(join(dir, ".pi"), { recursive: true });
const ymlFile = join(dir, ".pi", "swarm.yml");

const validPool = `modelPool:
  - model: glm-5.1
    provider: zai-coding-cn
    weight: 50
  - model: gpt-5.4-mini
    provider: openai
    weight: 30
  - model: claude-sonnet-4
    provider: anthropic
    weight: 0
rotation:
  strategy: weighted
  cooldownMs: 60000
  maxRetries: 2
`;

// 1. Legacy singleton config (defaultModel/defaultProvider only) preserved as implicit singleton pool.
await writeFile(
	ymlFile,
	`defaultModel: glm-5.1
defaultProvider: zai-coding-cn
`,
);
process.chdir(dir);
{
	const p = paths(dir);
	const shape = classifySwarmSettings();
	ok("singleton shape classified as singleton", shape.kind === "singleton");
	const validation = validateSwarmSettings();
	ok("singleton validates clean", validation.ok);
	const singleton = implicitSingletonPool();
	ok("singleton pool has 1 slot", singleton.slots.length === 1);
	ok("singleton slot uses default model", singleton.slots[0].model === "glm-5.1");
	ok("singleton slot uses default provider", singleton.slots[0].provider === "zai-coding-cn");
	ok("singleton source=settings", singleton.source === "settings");
	const status = await poolStatus(p);
	ok("pool status empty when no pool configured", status.slots.length === 0);
}

// 2. Valid explicit pool classified + validated + renders through poolStatus.
await writeFile(ymlFile, validPool);
{
	const p = paths(dir);
	const shape = classifySwarmSettings();
	ok("valid pool classified as explicit-pool", shape.kind === "explicit-pool" && shape.slots === 3);
	const validation = validateSwarmSettings();
	ok("valid pool validates clean", validation.ok && validation.errors.length === 0);
	const status = await poolStatus(p);
	ok("pool status has 3 slots", status.slots.length === 3);
	ok("rotation strategy is weighted", status.rotation.strategy === "weighted");
	ok("rotation cooldownMs is 60000", status.rotation.cooldownMs === 60_000);
	ok("rotation maxRetries is 2", status.rotation.maxRetries === 2);
	const glm = status.slots.find((s) => s.model === "glm-5.1");
	ok("glm-5.1 slot has weight 50", glm && glm.weight === 50);
	const sonnet = status.slots.find((s) => s.model === "claude-sonnet-4");
	ok("claude-sonnet-4 fallback-only", sonnet && sonnet.weight === 0);
}

// 3. Invalid config: empty model + bad weight + duplicate + bad strategy.
await writeFile(
	ymlFile,
	`modelPool:
  - model: glm-5.1
    provider: zai-coding-cn
    weight: 50
  - model: ""
    provider: openai
    weight: -1
  - model: glm-5.1
    provider: zai-coding-cn
    weight: 10
rotation:
  strategy: wrong-strategy
  cooldownMs: -5
  maxRetries: 0
`,
);
{
	const validation = validateSwarmSettings();
	ok("invalid pool fails validation", !validation.ok);
	const kinds = new Set(validation.errors.map((e) => e.kind));
	ok("empty model caught", kinds.has("slot_empty_model"));
	ok("bad weight caught", kinds.has("slot_bad_weight"));
	ok("duplicate slot caught", kinds.has("slot_duplicate"));
	ok("bad strategy caught", kinds.has("rotation_bad_strategy"));
	ok("bad cooldown caught", kinds.has("rotation_bad_cooldown"));
	ok("bad maxRetries caught", kinds.has("rotation_bad_maxretries"));
}

// 4. Unknown provider (provider string present but no model) → classify + validate still works.
await writeFile(
	ymlFile,
	`defaultModel: ""
defaultProvider: openai
`,
);
{
	const validation = validateSwarmSettings();
	ok("empty defaultModel is still structurally valid (no slots)", validation.ok);
	const singleton = implicitSingletonPool();
	ok("implicit singleton reports settings as source (defaultProvider set)", singleton.source === "settings");
	ok("implicit singleton provider = openai (from settings)", singleton.slots[0].provider === "openai");
}

// 4b. When yml is entirely absent, implicit singleton falls through to env/constants.
delete process.env.PI_SWARM_DEFAULT_MODEL;
delete process.env.PI_SWARM_DEFAULT_PROVIDER;
await rm(ymlFile, { force: true });
{
	const singleton = implicitSingletonPool();
	ok("implicit singleton source=constants when yml+env absent", singleton.source === "constants");
}

// 5. Preflight: pool_exhausted when all slots are benched.
await writeFile(ymlFile, validPool);
{
	const p = paths(dir);
	const slot1 = { model: "glm-5.1", provider: "zai-coding-cn" };
	const slot2 = { model: "gpt-5.4-mini", provider: "openai" };
	const slot3 = { model: "claude-sonnet-4", provider: "anthropic" };
	for (const s of [slot1, slot2, slot3]) {
		await recordProviderError(p, s, "quota", "exhausted");
	}
	const preflight = await preflightSpawn(p, { tmuxSession: "pi-swarm-test-fake" });
	ok("preflight: pool_exhausted when all benched", preflight.ok === false && preflight.error.kind === "pool_exhausted");
	ok("preflight: error message references cooldown", preflight.error.message.toLowerCase().includes("cooldown"));
}

// 6. Preflight: ok when one slot is eligible.
{
	await rm(join(dir, ".pi", "swarm", "pool-state.json"), { force: true });
	const p = paths(dir);
	const preflight = await preflightSpawn(p, { tmuxSession: "pi-swarm-test-fake" });
	ok("preflight: ok when at least one slot eligible", preflight.ok === true && preflight.resolved.fromPool === true);
	ok(
		"preflight: resolved model matches a configured model",
		["glm-5.1", "gpt-5.4-mini", "claude-sonnet-4"].includes(preflight.resolved.model),
	);
	ok("preflight: resolved provider is a known provider", ["zai-coding-cn", "openai", "anthropic"].includes(preflight.resolved.provider));
}

// 7. Preflight: tmux_not_running when $TMUX unset and tmuxSession requested.
{
	const saved = process.env.TMUX;
	delete process.env.TMUX;
	try {
		const p = paths(dir);
		const preflight = await preflightSpawn(p, { tmuxSession: "pi-swarm-test-fake" });
		ok("preflight: tmux_not_running without $TMUX env", preflight.ok === false && preflight.error.kind === "tmux_not_running");
	} finally {
		if (saved !== undefined) process.env.TMUX = saved;
	}
}

// 8. Preflight: tmux session not requested → tmux check skipped, falls through to ok.
{
	const p = paths(dir);
	const preflight = await preflightSpawn(p);
	ok("preflight: skips tmux check when session not requested", preflight.ok === true);
}

// 9. classifySwarmSettings handles missing file → empty.
await rm(ymlFile, { force: true });
{
	const shape = classifySwarmSettings();
	ok("missing file -> empty", shape.kind === "empty");
	const validation = validateSwarmSettings();
	ok("missing file validates (empty is valid)", validation.ok);
}

// 10. validateSwarmSettings handles unreadable yml.
await writeFile(ymlFile, `modelPool: [{ model: "glm-5.1"\n  - invalid yaml\n`);
{
	const validation = validateSwarmSettings();
	ok("unreadable yml fails validation", !validation.ok);
	const kinds = new Set(validation.errors.map((e) => e.kind));
	ok("unreadable yml kind = project_swarm_yml_unreadable", kinds.has("project_swarm_yml_unreadable"));
}

// 11. Empty yml (comments-only) classifies as empty shape.
await writeFile(ymlFile, `# comments only\n`);
{
	const shape = classifySwarmSettings();
	ok("empty yml -> empty shape", shape.kind === "empty");
	const validation = validateSwarmSettings();
	ok("empty yml validates clean", validation.ok);
}

// 12. Preflight: invalid_settings surfaces invalid pool config.
await writeFile(
	ymlFile,
	`modelPool:
  - model: ""
    provider: openai
`,
);
{
	const p = paths(dir);
	const preflight = await preflightSpawn(p);
	ok("preflight: invalid_settings catches empty model", preflight.ok === false && preflight.error.kind === "invalid_settings");
	ok(
		"preflight: invalid_settings suggestion references /swarm pool validate",
		preflight.error.suggestion.toLowerCase().includes("validate"),
	);
}

// 13. pickSlot behavior is unchanged (regression) — confirm preflight uses the same code path.
await writeFile(ymlFile, validPool);
{
	const p = paths(dir);
	await rm(join(dir, ".pi", "swarm", "pool-state.json"), { force: true });
	const pick = await pickSlot(p);
	ok("pickSlot returns a configured slot", pick && pick.slot && ["glm-5.1", "gpt-5.4-mini", "claude-sonnet-4"].includes(pick.slot.model));
	ok("pickSlot weighted (excludes fallback-only when weighted available)", pick.slot.weight > 0);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.chdir("/");
await rm(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
