// === swarm/agent-gc-auto.ts — optional auto-GC of stopped agent records (config-gated, DEF OFF) ===
//
// Issue stopped-agent-records-gc deliverable (3): auto-GC behind a config flag, default OFF.
// Config (project .pi/swarm.yaml or global):
//   agentGc:
//     auto: false                # default OFF — no behavior change unless opted in
//     stoppedOlderThanMs: 86400000  # optional, default 24h
// When enabled, the ROOT pump tick calls runAutoStoppedGc: pure predicates from agent-gc.ts,
// applied under the swarm lock. Gated identically to manual purge (age + task-reference +
// response debt). Errors are logged via logSwarmError and never propagate into the pump tick.

import { readSwarmRawConfig, readSwarmYml, readGlobalSwarmYml } from "./config.ts";
import { DEFAULT_STOPPED_OLDER_THAN_MS, stoppedGcCandidates, applyStoppedGc } from "./agent-gc.ts";
import { IDLE_GC_NUDGE_AFTER_MS, IDLE_GC_NUDGE_COOLDOWN_MS, IDLE_GC_NUDGE_INTERVAL_MS, IDLE_GC_NUDGE_MAX_NUDGES } from "./constants.ts";
import { loadTaskGraphsForGc } from "./agent-gc-io.ts";
import { paths, readState, trace, withLock, writeState } from "./state.ts";
import type { Paths } from "./types.ts";
import { logSwarmError } from "./errorlog.ts";

export interface AgentGcIdleNudgeConfig {
	enabled: boolean;
	afterMs: number;
	cooldownMs: number;
	maxNudges: number;
	intervalMs: number;
}

export interface AgentGcConfig {
	auto: boolean;
	stoppedOlderThanMs: number;
	idleNudge: AgentGcIdleNudgeConfig;
}

// Per-key tolerance: non-numeric / negative / non-finite values fall back to the default
// (same contract as stoppedOlderThanMs). Env vars win over yml so lanes/tests/operator
// overrides always apply without editing files.
function num(value: unknown, fallback: number, envVar?: string): number {
	if (envVar) {
		const raw = Number(process.env[envVar]);
		if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
	}
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

export function readAgentGcConfig(cwd: string): AgentGcConfig {
	let cfg: any;
	try {
		cfg = readSwarmRawConfig(cwd)?.cfg ?? null;
	} catch {
		cfg = null;
	}
	const section = cfg?.agentGc ?? {};
	const rawAge = section.stoppedOlderThanMs;
	const age = typeof rawAge === "number" && Number.isFinite(rawAge) && rawAge >= 0 ? rawAge : DEFAULT_STOPPED_OLDER_THAN_MS;
	// Per-sub-key merge for idleNudge (mirrors readRolesConfig): mergeSwarmConfig applies
	// whole-OBJECT replacement for agentGc, so a project declaring only idleNudge.afterMs
	// would hide global idleNudge.enabled. Re-read both layers and merge sub-key-wise:
	// project > global > default.
	let projIdle: any = null;
	let globalIdle: any = null;
	try {
		const projYml = readSwarmYml(cwd);
		projIdle = projYml?.agentGc?.idleNudge && typeof projYml.agentGc.idleNudge === "object" ? projYml.agentGc.idleNudge : null;
	} catch {
		projIdle = null; // corrupt project yml already reported by mergeSwarmConfig
	}
	try {
		const globalYml = readGlobalSwarmYml();
		globalIdle = globalYml?.agentGc?.idleNudge && typeof globalYml.agentGc.idleNudge === "object" ? globalYml.agentGc.idleNudge : null;
	} catch {
		globalIdle = null;
	}
	const idleRaw = { ...(globalIdle ?? {}), ...(projIdle ?? {}), ...(section.idleNudge ?? {}) };
	const idleNudge: AgentGcIdleNudgeConfig = {
		enabled: bool(idleRaw.enabled, true),
		afterMs: num(idleRaw.afterMs, IDLE_GC_NUDGE_AFTER_MS, "PI_SWARM_IDLE_GC_AFTER_MS"),
		cooldownMs: num(idleRaw.cooldownMs, IDLE_GC_NUDGE_COOLDOWN_MS, "PI_SWARM_IDLE_GC_COOLDOWN_MS"),
		maxNudges: num(idleRaw.maxNudges, IDLE_GC_NUDGE_MAX_NUDGES, "PI_SWARM_IDLE_GC_MAX_NUDGES"),
		intervalMs: num(idleRaw.intervalMs, IDLE_GC_NUDGE_INTERVAL_MS, "PI_SWARM_IDLE_GC_INTERVAL_MS"),
	};
	return { auto: section.auto === true, stoppedOlderThanMs: age, idleNudge };
}

/** Runs the gated stopped-record purge once, under the lock. Returns null when auto-GC is OFF. */
export async function runAutoStoppedGc(cwd: string): Promise<{ purged: string[]; blocked: string[] } | null> {
	const cfg = readAgentGcConfig(cwd);
	if (!cfg.auto) return null;
	const p: Paths = paths(cwd);
	try {
		return await withLock(p, async () => {
			const st = await readState(p, cwd);
			const taskGraphs = await loadTaskGraphsForGc(p);
			const candidates = stoppedGcCandidates(st, { nowMs: Date.now(), taskGraphs, stoppedOlderThanMs: cfg.stoppedOlderThanMs });
			const applied = applyStoppedGc(st, candidates, { dryRun: false });
			if (applied.purged.length > 0) {
				await writeState(p, st);
			}
			await trace(p, "gc.stopped_auto", {
				purged: applied.purged,
				blocked: candidates.filter((c) => !c.eligible).map((c) => ({ agentId: c.agentId, blocked: c.blocked })),
			});
			return { purged: applied.purged, blocked: applied.blocked };
		});
	} catch (err: any) {
		// auto-GC must never take the pump tick down; durable error census, no silent swallow.
		await logSwarmError(p, "agent-gc-auto", "auto_gc_failed", err);
		return { purged: [], blocked: [] };
	}
}
