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

import { readSwarmRawConfig } from "./config.ts";
import { DEFAULT_STOPPED_OLDER_THAN_MS, stoppedGcCandidates, applyStoppedGc } from "./agent-gc.ts";
import { loadTaskGraphsForGc } from "./agent-gc-io.ts";
import { paths, readState, trace, withLock, writeState } from "./state.ts";
import type { Paths } from "./types.ts";
import { logSwarmError } from "./errorlog.ts";

export interface AgentGcConfig {
	auto: boolean;
	stoppedOlderThanMs: number;
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
	const age =
		typeof rawAge === "number" && Number.isFinite(rawAge) && rawAge >= 0 ? rawAge : DEFAULT_STOPPED_OLDER_THAN_MS;
	return { auto: section.auto === true, stoppedOlderThanMs: age };
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
