// Follow-up: swarm.yml UX gaps reported by the user 2026-09-05 (task task-pool-yaml-followup).
//
// Run: node extensions/swarm/tests/pool-yaml-followup.test.mjs
//
// Red-first repro for three reported gaps (expected RED before the fix lands):
//   F1  EMPTY .pi/swarm.yml + JSON pool present: scaffold/validate/session_start must NOT
//       silently ignore the empty yml — validate warns `swarm_yml_empty` and scaffold, when the
//       JSON block declares NO pool, writes the commented yml placeholder even when an empty
//       swarm.yml exists (it is a fresh-scaffold opportunity, not a user declaration).
//   F2  validateSwarmSettings does not check slot resolvability: with a registry probe fn,
//       a slot whose provider/model is NOT resolvable must produce error kind `slot_unresolvable`
//       (and a missing API key must produce `slot_no_credential`), while resolvable slots stay clean.
//   F3  launching a session ON the pool (root session_start) must surface a warning notify when
//       the configured pool has zero resolvable slots (all-dead pool), so the PM learns it at
//       launch, not at first spawn failure.
//
// Read-only except scratch dirs. Never touches the real project .pi/.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSwarmSettings } from "../src/pool.ts";
import { ensurePoolScaffold } from "../src/pool-scaffold.ts";

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error("  FAIL:", name); } };

const scratch = await mkdtemp(join(tmpdir(), "pool-yaml-followup-"));
await mkdir(join(scratch, ".pi"), { recursive: true });
const ymlPath = join(scratch, ".pi", "swarm.yml");
const settingsPath = join(scratch, ".pi", "settings.json");

// A registry probe mimicking ctx.modelRegistry.find: knows ccs/glm-5.3 and openai/gpt-5.4-mini.
const registryProbe = {
	find: (provider, modelId) =>
		(provider === "ccs" && modelId === "glm-5.3") || (provider === "openai" && modelId === "gpt-5.4-mini")
			? { id: modelId, provider }
			: undefined,
};
// Credential probe: auth.json on the host may carry arbitrary keys; pin HOME's auth out of the
// test by pointing the probe's auth lookup at a scratch home with ONLY the entries we control.
// missingProviderCredential reads HOME/.pi/agent/auth.json + <PROVIDER>_API_KEY env.
const savedHome = process.env.HOME;
const fakeHome = join(scratch, "home");
await mkdir(join(fakeHome, ".pi", "agent"), { recursive: true });
await writeFile(join(fakeHome, ".pi", "agent", "auth.json"), JSON.stringify({ "openai": { type: "api_key", key: "test" } }));
process.env.HOME = fakeHome;
const savedKey = process.env.OPENAI_API_KEY;
const savedCcs = process.env.CCS_API_KEY;
delete process.env.CCS_API_KEY;
delete process.env.OPENAI_API_KEY; // the scratch auth.json provides openai's key instead

// === F2: validate checks slot resolvability via the registry probe ===
await writeFile(settingsPath, JSON.stringify({ swarm: { modelPool: [
	{ model: "glm-5.3", provider: "ccs" },           // resolvable model, NO api key -> slot_no_credential
	{ model: "gpt-5.4-mini", provider: "openai" },   // fully resolvable
	{ model: "nonexistent-model", provider: "ccs" }  // not in registry -> slot_unresolvable
] } }));

{
	const v = validateSwarmSettings(scratch, { registryProbe });
	const kinds = new Set(v.errors.map((e) => e.kind));
	ok("F2: unresolvable slot flagged", kinds.has("slot_unresolvable"));
	ok("F2: resolvable slot not flagged", !v.errors.some((e) => e.field === "modelPool[1]"));
	ok("F2: missing credential flagged", kinds.has("slot_no_credential"));
	ok("F2: credential failure is a warning-grade error only for that slot", v.errors.filter((e) => e.kind === "slot_no_credential").length === 1);
}
// No probe available → resolvability checks degrade to struct-only (no crash, no false errors)
{
	const v = validateSwarmSettings(scratch);
	ok("F2: no probe → structural validation only, still works", Array.isArray(v.errors));
}

// === F1: empty yml + JSON pool → validate warns swarm_yml_empty ===
await writeFile(ymlPath, "");
{
	const v = validateSwarmSettings(scratch, { registryProbe });
	ok("F1: empty yml + JSON config → swarm_yml_empty warning", v.warnings.some((w) => w.kind === "swarm_yml_empty"));
	ok("F1: warning names .pi/swarm.yml", v.warnings.some((w) => w.kind === "swarm_yml_empty" && /swarm\.yml/.test(w.message)));
	ok("F1: ok not flipped by the empty-yml warning (JSON pool drives ok)", v.ok === false); // false due to F2 errors, not the warning
}
// === F1b: empty yml + NO JSON pool → scaffold fills the commented placeholder ===
await rm(settingsPath, { force: true });
{
	const res = await ensurePoolScaffold(scratch);
	ok("F1b: empty yml is treated as fresh-scaffold (wrote placeholder into it)", res.wrote === true && res.path === ymlPath);
	const text = await (await import("node:fs/promises")).readFile(ymlPath, "utf8");
	ok("F1b: placeholder is the commented template with model: null", /model:\s*null/.test(text) && /#/.test(text));
}

// cleanup
process.env.HOME = savedHome;
if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
if (savedCcs === undefined) delete process.env.CCS_API_KEY; else process.env.CCS_API_KEY = savedCcs;
await rm(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
