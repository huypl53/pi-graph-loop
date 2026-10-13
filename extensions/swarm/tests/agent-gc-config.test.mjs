#!/usr/bin/env node
/**
 * agent-gc-config.test.mjs — RED-first config + scaffold suite (idle-agent GC nudge plan §1.4/§1.5)
 *
 * Contract:
 *   - readAgentGcConfig returns the idleNudge sub-config with the documented defaults
 *     (enabled:true, afterMs 20', cooldownMs 30', maxNudges 3, intervalMs 60')
 *   - Precedence: project .pi/swarm.yml > global ~/.pi/agent/swarm.yml > defaults
 *   - Invalid values (non-numeric, negative) fall back to defaults per-key
 *   - Env overrides: PI_SWARM_IDLE_GC_AFTER_MS etc.
 *   - Scaffold templates (POOL_SCAFFOLD_YML_PLACEHOLDER / _GLOBAL_) still parse to null
 *     (comments-only invariant) AND now document the agentGc.idleNudge block
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0,
	failed = 0;
const ok = (n, c, info) => {
	if (c) {
		passed++;
		console.log("  ok  ", n);
	} else {
		failed++;
		console.error("  FAIL:", n, info ?? "");
	}
};

const MIN = 60_000;

console.log("=== agent-gc-config (RED-first) ===");

// --- Config defaults + layering ---
let readAgentGcConfig = null;
let savedHome = process.env.HOME;
try {
	const mod = await import(join(here, "..", "src", "agent-gc-auto.ts"));
	readAgentGcConfig = mod.readAgentGcConfig;
} catch {
	readAgentGcConfig = null;
}

if (typeof readAgentGcConfig === "function") {
	// D1: documented defaults when no config exists anywhere
	{
		const dir = await mkdtemp(join(tmpdir(), "agc-cfg-"));
		await mkdir(join(dir, ".pi"), { recursive: true });
		const cfg = readAgentGcConfig(dir);
		ok("D1: auto default false", cfg.auto === false, JSON.stringify(cfg));
		ok("D1: stoppedOlderThanMs default 24h", cfg.stoppedOlderThanMs === 24 * 60 * MIN, JSON.stringify(cfg));
		const idle = cfg.idleNudge || {};
		ok("D1: idleNudge.enabled default true", idle.enabled === true, JSON.stringify(idle));
		ok("D1: idleNudge.afterMs default 20min", idle.afterMs === 20 * MIN, JSON.stringify(idle));
		ok("D1: idleNudge.cooldownMs default 30min", idle.cooldownMs === 30 * MIN, JSON.stringify(idle));
		ok("D1: idleNudge.maxNudges default 3", idle.maxNudges === 3, JSON.stringify(idle));
		ok("D1: idleNudge.intervalMs default 60s", idle.intervalMs === MIN, JSON.stringify(idle));
	}

	// D2: project layer wins over defaults; invalid per-key values fall back
	{
		const dir = await mkdtemp(join(tmpdir(), "agc-cfg-"));
		await mkdir(join(dir, ".pi"), { recursive: true });
		await writeFile(
			join(dir, ".pi", "swarm.yaml"),
			"agentGc:\n  idleNudge:\n    afterMs: 900000\n    maxNudges: notanumber\n    cooldownMs: -5\n",
			"utf8",
		);
		const cfg = readAgentGcConfig(dir);
		const idle = cfg.idleNudge || {};
		ok("D2: project afterMs parsed", idle.afterMs === 15 * MIN, JSON.stringify(idle));
		ok("D2: invalid maxNudges falls back to default 3", idle.maxNudges === 3, JSON.stringify(idle));
		ok("D2: negative cooldownMs falls back to default 30min", idle.cooldownMs === 30 * MIN, JSON.stringify(idle));
		ok("D2: enabled stays default true when unset", idle.enabled === true, JSON.stringify(idle));
	}

	// D3: global layer used when project silent; project overrides global
	{
		const dir = await mkdtemp(join(tmpdir(), "agc-cfg-"));
		await mkdir(join(dir, ".pi"), { recursive: true });
		const home = await mkdtemp(join(tmpdir(), "agc-home-"));
		await mkdir(join(home, ".pi", "agent"), { recursive: true });
		await writeFile(
			join(home, ".pi", "agent", "swarm.yml"),
			"agentGc:\n  idleNudge:\n    enabled: false\n    afterMs: 1800000\n",
			"utf8",
		);
		process.env.HOME = home;
		try {
			const cfgGlobal = readAgentGcConfig(dir);
			ok(
				"D3: global idleNudge honored when project silent",
				cfgGlobal.idleNudge?.enabled === false && cfgGlobal.idleNudge?.afterMs === 30 * MIN,
				JSON.stringify(cfgGlobal.idleNudge),
			);
			await writeFile(join(dir, ".pi", "swarm.yaml"), "agentGc:\n  idleNudge:\n    enabled: true\n", "utf8");
			const cfgProject = readAgentGcConfig(dir);
			ok(
				"D3: project enabled:true overrides global false",
				cfgProject.idleNudge?.enabled === true,
				JSON.stringify(cfgProject.idleNudge),
			);
			ok(
				"D3: unset project key still inherits global afterMs",
				cfgProject.idleNudge?.afterMs === 30 * MIN,
				JSON.stringify(cfgProject.idleNudge),
			);
		} finally {
			process.env.HOME = savedHome;
		}
	}

	// D4: env overrides
	{
		const dir = await mkdtemp(join(tmpdir(), "agc-cfg-"));
		await mkdir(join(dir, ".pi"), { recursive: true });
		process.env.PI_SWARM_IDLE_GC_AFTER_MS = "420000";
		try {
			const cfg = readAgentGcConfig(dir);
			ok("D4: env PI_SWARM_IDLE_GC_AFTER_MS overrides config", cfg.idleNudge?.afterMs === 420_000, JSON.stringify(cfg.idleNudge));
		} finally {
			delete process.env.PI_SWARM_IDLE_GC_AFTER_MS;
		}
	}
} else {
	ok("readAgentGcConfig exported with idleNudge (RED: missing pre-fix)", false, "import failed or export missing idleNudge shape");
}

// --- Scaffold templates ---
{
	let constants = null;
	try {
		constants = await import(join(here, "..", "src", "constants.ts"));
	} catch {
		constants = null;
	}
	if (constants && constants.POOL_SCAFFOLD_YML_PLACEHOLDER) {
		const { parse: parseYaml } = await import("yaml");
		const proj = constants.POOL_SCAFFOLD_YML_PLACEHOLDER;
		const glob = constants.POOL_SCAFFOLD_GLOBAL_YML_PLACEHOLDER;
		ok(
			"scaffold: project template still parses to null (comments-only invariant)",
			parseYaml(proj) === null || parseYaml(proj) === undefined,
			String(parseYaml(proj)),
		);
		ok(
			"scaffold: global template still parses to null",
			parseYaml(glob) === null || parseYaml(glob) === undefined,
			String(parseYaml(glob)),
		);
		ok(
			"scaffold: project template documents agentGc.idleNudge",
			proj.includes("agentGc") && proj.includes("idleNudge"),
			proj.slice(-600),
		);
		ok(
			"scaffold: global template documents agentGc.idleNudge",
			glob.includes("agentGc") && glob.includes("idleNudge"),
			glob.slice(-600),
		);
		ok(
			"scaffold: template documents all five idle keys",
			["enabled", "afterMs", "cooldownMs", "maxNudges", "intervalMs"].every((k) => proj.includes(k)),
			"missing key in project template",
		);
	} else {
		ok("scaffold templates updated (RED: missing pre-fix)", false, "constants missing or no placeholders");
	}
}

console.log(`\n---\nagent-gc-config results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
