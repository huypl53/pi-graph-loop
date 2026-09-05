// .pi/swarm.yml — YAML config source for the swarm model pool.
//
// Run: node extensions/swarm/tests/pool-yaml.test.mjs
//
// Red-first suite for the swarm.yml feature (task task-pool-yaml-config).
// Cases R1–R7 mirror artifacts/plan.md §Reproduction and are expected to FAIL
// before the implementation lands (observed red on 2026-09-04, then green).
//
// Covers:
//   R1  readSwarmSettings resolves modelPool/rotation/defaultModel from .pi/swarm.yml
//   R2  effectiveConfig slots from yml; precedence: JSON swarm block wins over yml
//   R3  classifySwarmSettings reports source "swarm.yml"
//   R4  ensurePoolScaffold scaffolds .pi/swarm.yml (not settings.json) when no source declares a pool
//   R4b scaffold skips when yml already declares a pool; JSON-block merge parity preserved
//   R5  both-sources warning in validateSwarmSettings (ok unaffected)
//   R6  corrupt yml -> validate ok:false, kind swarm_yml_unreadable; readers degrade to {}
//   R7  quotaResetMs readable from yml slots (effectiveBenchMs path)
//
// Read-only except the scratch dir (mkdtemp). Never touches the real project .pi/.
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readSwarmSettings } from "../src/session.ts";
import {
	classifySwarmSettings,
	effectiveConfig,
	effectiveBenchMs,
	validateSwarmSettings,
} from "../src/pool.ts";
import { ensurePoolScaffold } from "../src/pool-scaffold.ts";
import { _clearQuotaResetCacheForTests } from "../src/pool.ts";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error("  FAIL:", name); } };

const scratch = await mkdtemp(join(tmpdir(), "pool-yaml-test-"));
await mkdir(join(scratch, ".pi"), { recursive: true });
const ymlPath = join(scratch, ".pi", "swarm.yml");
const settingsPath = join(scratch, ".pi", "settings.json");

const writeYml = (text) => writeFile(ymlPath, text);
const writeSettings = (obj) => writeFile(settingsPath, JSON.stringify(obj, null, 2));

const sampleYml = `# swarm model pool — comments allowed
modelPool:
  - model: glm-5.1
    provider: zai-coding-cn
    weight: 10
  - model: gpt-5.4-mini
    provider: openai
    weight: 5
    roles: [implementer, tester]
rotation:
  strategy: weighted
  cooldownMs: 600000
  maxRetries: 2
defaultModel: glm-5.1
defaultProvider: zai-coding-cn
`;

// Fresh scratch per case where it matters; helper restores the baseline.
const resetScratch = async () => {
	await rm(ymlPath, { force: true });
	await rm(settingsPath, { force: true });
	_clearQuotaResetCacheForTests();
};

// === R1: readSwarmSettings resolves from yml ===
await resetScratch();
await writeYml(sampleYml);
{
	const s = readSwarmSettings(scratch);
	ok("R1: modelPool parsed from yml (2 slots)", Array.isArray(s.modelPool) && s.modelPool.length === 2);
	ok("R1: slot0 model", s.modelPool?.[0]?.model === "glm-5.1");
	ok("R1: slot1 roles forwarded", JSON.stringify(s.modelPool?.[1]?.roles) === JSON.stringify(["implementer", "tester"]));
	ok("R1: rotation parsed", s.rotation?.strategy === "weighted" && s.rotation?.cooldownMs === 600000);
	ok("R1: defaultModel from yml", s.defaultModel === "glm-5.1");
	ok("R1: defaultProvider from yml", s.defaultProvider === "zai-coding-cn");
}

// === R2: effectiveConfig from yml; JSON precedence ===
await resetScratch();
await writeYml(sampleYml);
{
	process.chdir(scratch);
	const cfg = effectiveConfig();
	ok("R2: effectiveConfig slots from yml", cfg.slots.length === 2);
	ok("R2: rotation defaults applied", cfg.rotation.strategy === "weighted");
}
// JSON swarm block wins over yml
await writeSettings({ swarm: { modelPool: [{ model: "json-model", provider: "p1" }] } });
{
	process.chdir(scratch);
	const s = readSwarmSettings(scratch);
	ok("R2: settings.json swarm block wins over yml", s.modelPool?.length === 1 && s.modelPool[0].model === "json-model");
	// extensions.swarm still wins over top-level swarm even when yml exists
	await writeSettings({ swarm: { modelPool: [{ model: "top", provider: "p" }] }, extensions: { swarm: { modelPool: [{ model: "ext", provider: "p" }] } } });
	const s2 = readSwarmSettings(scratch);
	ok("R2: extensions.swarm precedence preserved over yml", s2.modelPool?.[0]?.model === "ext");
}

// === R3: classify reports source swarm.yml ===
await resetScratch();
await writeYml(`modelPool:
  - model: glm-5.1
    provider: zai-coding-cn
  - model: gpt-5.4-mini
    provider: openai
rotation:
  strategy: weighted
`);
{
	const shape = classifySwarmSettings(scratch);
	ok("R3: shape is explicit-pool with 2 slots", shape.kind === "explicit-pool" && shape.slots === 2);
	ok("R3: source is swarm.yml", shape.source === "swarm.yml");
}

// === R4: scaffold writes .pi/swarm.yml when no source declares a pool ===
await resetScratch();
{
	const res = await ensurePoolScaffold(scratch);
	ok("R4: scaffold wrote", res.wrote === true);
	ok("R4: scaffold path is .pi/swarm.yml", res.path === ymlPath);
	ok("R4: yml file exists", existsSync(ymlPath));
	ok("R4: settings.json NOT created", !existsSync(settingsPath));
	const text = await readFile(ymlPath, "utf8");
	ok("R4: scaffold documents full surface (commented), no active null", /#\s*-\s*model:/.test(text) && !/^\s*-?\s*model:\s*null\s*$/m.test(text));
	ok("R4: scaffold is YAML (comment guidance present)", /#/.test(text));
}
// R4b: yml declares a pool -> skip
await resetScratch();
await writeYml(sampleYml);
{
	const res = await ensurePoolScaffold(scratch);
	ok("R4b: skip when yml declares a pool", res.wrote === false && res.skipped === "modelpool_present");
}
// R4b: settings.json has swarm block (no pool) -> placeholder merges into JSON block (parity)
await resetScratch();
await writeSettings({ theme: "dark", swarm: { rotation: { strategy: "weighted" } } });
{
	const res = await ensurePoolScaffold(scratch);
	ok("R4b: JSON-block merge preserved (wrote)", res.wrote === true);
	ok("R4b: JSON-block merge path is settings.json", res.path === settingsPath);
	ok("R4b: no yml written when JSON block exists", !existsSync(ymlPath));
}

// === R5: both-sources warning ===
await resetScratch();
await writeYml(sampleYml);
await writeSettings({ swarm: { modelPool: [{ model: "json-model", provider: "p1" }] } });
{
	const v = validateSwarmSettings(scratch);
	ok("R5: ok stays true with valid JSON + yml present", v.ok === true);
	ok("R5: warnings array exists", Array.isArray(v.warnings));
	ok(
		"R5: both-sources warning emitted naming swarm.yml",
		Array.isArray(v.warnings) && v.warnings.some((w) => w.kind === "both_sources_present" && /swarm\.yml/.test(w.message)),
	);
}

// === R6: corrupt yml ===
await resetScratch();
await writeYml("modelPool: [unclosed\n  this is : : not valid yaml :::\n\t- ?");
{
	const v = validateSwarmSettings(scratch);
	ok("R6: validate ok:false on corrupt yml", v.ok === false);
	ok("R6: error kind swarm_yml_unreadable", v.errors.some((e) => e.kind === "swarm_yml_unreadable"));
	const s = readSwarmSettings(scratch);
	ok("R6: readers degrade to {}", JSON.stringify(s) === "{}");
}

// === R7: quotaResetMs from yml ===
await resetScratch();
await writeYml(`modelPool:
  - model: glm-5.1
    provider: zai-coding-cn
    quotaResetMs: 7200000
rotation:
  cooldownMs: 60000
`);
{
	_clearQuotaResetCacheForTests();
	const bench = effectiveBenchMs({ model: "glm-5.1", provider: "zai-coding-cn" }, { strategy: "weighted", cooldownMs: 60000, maxRetries: 2 }, scratch);
	ok("R7: quotaResetMs (7200000) floors bench above cooldown", bench === 7200000);
}

// cleanup
process.chdir("/"); // leave scratch before rm (portable)
await rm(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
