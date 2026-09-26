// === swarm/src/orphan-watch.ts — orphan watchdog clear (Phase 7 cycle-break) ===
// Extracted verbatim from agents.ts (Phase 7). agents.ts and mailbox.ts referenced each
// other (agents.ts -> mailbox.ts for deliverMessageLocked; mailbox.ts -> agents.ts via a
// documented dynamic import for clearOrphanWatch) — moving clearOrphanWatch + ORPHAN_TIMERS
// into this leaf module lets both sides import it statically with no cycle.
import type { OrphanClearReason } from "./types/agents.ts";
import type { Paths, SwarmState } from "./types.ts";
import { currentAgentId } from "./session.ts";
import { trace } from "./state.ts";

const ORPHAN_TIMERS = new Map<string, NodeJS.Timeout>();
/** Arm-site access for agents.ts (shared in-process timer map; NOT serialized into state). */
export function orphanTimers(): Map<string, NodeJS.Timeout> {
	return ORPHAN_TIMERS;
}

// with existing test assertions; the new `kind` field carries "preflight" vs "delivery" for ops
// observability.
export type OrphanClearKind = "preflight" | "delivery";

export async function clearOrphanWatch(
	p: Paths,
	st: SwarmState,
	agentId: string,
	reason: OrphanClearReason,
	kind: OrphanClearKind = "delivery",
) {
	if (!Array.isArray(st.recentSpawns) || st.recentSpawns.length === 0) return { cleared: false, reason: "empty" };
	const idx = st.recentSpawns.findIndex((s) => s.agentId === agentId);
	if (idx === -1) return { cleared: false, reason: "not-found" };
	const [removed] = st.recentSpawns.splice(idx, 1);
	const t = ORPHAN_TIMERS.get(agentId);
	if (t) {
		clearTimeout(t);
		ORPHAN_TIMERS.delete(agentId);
	}
	await trace(p, "agent.spawn.orphan_cleared", {
		agentId,
		by: reason,
		reason: kind,
		clearedBy: currentAgentId(),
		spawnedAt: removed.spawnedAt,
		deadlineAt: removed.deadlineAt,
		spawnedByPid: removed.spawnedByPid,
		spawnedBySessionStartedAt: removed.spawnedBySessionStartedAt,
	}).catch(() => {});
	return { cleared: true, reason, kind, removed };
}
