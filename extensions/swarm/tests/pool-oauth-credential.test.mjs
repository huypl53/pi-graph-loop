// Repro: /swarm pool validate false-positives reported live 2026-10-10.
//
// Run: node extensions/swarm/tests/pool-oauth-credential.test.mjs
//
// Two red-first repros (expected RED before the fix lands):
//   O1  OAuth credential: a provider whose ~/.pi/agent/auth.json entry is type "oauth"
//       (access/refresh/expires — e.g. cliproxyapi managed by ccs) is a VALID credential
//       for pi core (pi-ai resolveProviderAuth resolves oauth entries, even auto-refreshing
//       them). validateSwarmSettings must NOT emit `slot_no_credential` for such a slot —
//       and preflightSpawn must not report a credential error either.
//   O2  Unknown-key warning: the scaffold template in constants.ts documents top-level
//       keys `issues:` and `issue-sequencer:` in .pi/swarm.yml; the validator's RECOGNIZED
//       set must include both, else a config following our own scaffold warns
//       "unknown key 'issues' — ignored" (live report: .pi/swarm.yml with issues.autoContinue).
//
// Negative controls (must stay flagged):
//   - provider absent from auth.json AND no env key → still `slot_no_credential`
//   - api_key entry with empty key string → still flagged
//   - oauth entry with neither access nor refresh → still flagged (pi core cannot resolve it)
//
// Read-only except scratch dirs. Never touches the real project .pi/ or real HOME.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateSwarmSettings } from "../src/pool.ts";

let pass = 0,
	fail = 0;
const ok = (name, cond) => {
	if (cond) pass++;
	else {
		fail++;
		console.error("  FAIL:", name);
	}
};

const scratch = await mkdtemp(join(tmpdir(), "pool-oauth-cred-"));
await mkdir(join(scratch, ".pi"), { recursive: true });
const ymlPath = join(scratch, ".pi", "swarm.yml");

// Registry probe mimicking ctx.modelRegistry.find: knows cliproxyapi/glm-4.7 and openai/gpt-5.4-mini.
const registryProbe = {
	find: (provider, modelId) =>
		(provider === "cliproxyapi" && modelId === "glm-4.7") || (provider === "openai" && modelId === "gpt-5.4-mini")
			? { id: modelId, provider }
			: undefined,
};

// Pin HOME at a scratch home whose auth.json carries an OAUTH entry for cliproxyapi —
// mirroring the live ~/.pi/agent/auth.json shape (access managed by ccs, far-future expires).
const savedHome = process.env.HOME;
const fakeHome = join(scratch, "home");
await mkdir(join(fakeHome, ".pi", "agent"), { recursive: true });
await writeFile(
	join(fakeHome, ".pi", "agent", "auth.json"),
	JSON.stringify({
		cliproxyapi: { type: "oauth", access: "ccs-internal-managed", refresh: "{}", expires: 4945198609379 },
		badapikey: { type: "api_key", key: "   " },
		badoauth: { type: "oauth", expires: 123 },
	}),
);
process.env.HOME = fakeHome;
const savedClipKey = process.env.CLIPROXYAPI_API_KEY;
delete process.env.CLIPROXYAPI_API_KEY;

// === O1: oauth credential slot must validate clean ===
await writeFile(
	ymlPath,
	`modelPool:
  - model: glm-4.7
    provider: cliproxyapi
`,
);
{
	const v = validateSwarmSettings(scratch, { registryProbe });
	ok("O1: oauth-entry slot NOT flagged slot_no_credential", !v.errors.some((e) => e.kind === "slot_no_credential"));
	ok("O1: oauth slot has zero errors", v.errors.length === 0, JSON.stringify(v.errors));
}

// === O1 negative controls: unresolvable credentials still flagged ===
await writeFile(
	ymlPath,
	`modelPool:
  - model: glm-4.7
    provider: nosuchprov
  - model: gpt-5.4-mini
    provider: badapikey
`,
);
{
	// extend probe so resolvability passes and only the credential gate can fire
	const probe2 = { find: (p, m) => ({ id: m, provider: p }) };
	const v = validateSwarmSettings(scratch, { registryProbe: probe2 });
	const noCred = v.errors.filter((e) => e.kind === "slot_no_credential");
	ok("O1n: absent provider still flagged", noCred.some((e) => e.field === "modelPool[0]"));
	ok("O1n: blank api_key still flagged", noCred.some((e) => e.field === "modelPool[1]"));
}
await writeFile(
	ymlPath,
	`modelPool:
  - model: glm-4.7
    provider: badoauth
`,
);
{
	const probe2 = { find: (p, m) => ({ id: m, provider: p }) };
	const v = validateSwarmSettings(scratch, { registryProbe: probe2 });
	ok("O1n: oauth entry without access/refresh still flagged", v.errors.some((e) => e.kind === "slot_no_credential"));
}

// === O2: scaffold-documented keys issues/issue-sequencer must be RECOGNIZED ===
await writeFile(
	ymlPath,
	`modelPool:
  - model: glm-4.7
    provider: cliproxyapi
issues:
  autoContinue: true
issue-sequencer:
  advancement: auto
`,
);
{
	const v = validateSwarmSettings(scratch, { registryProbe });
	ok("O2: no unknown_top_level_key for 'issues'", !v.warnings.some((w) => w.kind === "unknown_top_level_key" && w.field === "issues"));
	ok(
		"O2: no unknown_top_level_key for 'issue-sequencer'",
		!v.warnings.some((w) => w.kind === "unknown_top_level_key" && w.field === "issue-sequencer"),
	);
	// typos must still warn
}
await writeFile(
	ymlPath,
	`modelPool:
  - model: glm-4.7
    provider: cliproxyapi
issuess: true
`,
);
{
	const v = validateSwarmSettings(scratch, { registryProbe });
	ok("O2n: typo'd key still warns", v.warnings.some((w) => w.kind === "unknown_top_level_key" && w.field === "issuess"));
}

// === restore ===
process.env.HOME = savedHome;
if (savedClipKey !== undefined) process.env.CLIPROXYAPI_API_KEY = savedClipKey;
await rm(scratch, { recursive: true, force: true });

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
