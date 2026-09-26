// === swarm/surface/ranking.ts — candidate priority sorting + group keys (Phase 7) ===
// Extracted verbatim from ../surface.ts (Phase 7 modular split; canonical logic unchanged).
//
// Module boundary: pure surface-plan helpers.
//   - rootSurfaceGroupKey       — logical coalescing key for backlog messages
//   - compareSurfaceCandidates  — deterministic candidate ordering (updatedAt asc, id tiebreak)
// Pure functions only; no I/O, no Pi runtime boundary.
import type { SwarmMessage } from "../types.ts";

export function rootSurfaceGroupKey(rec: {
	id: string;
	from?: string;
	subject?: string;
	conversationId?: string;
	replyTo?: string;
	requiresAck?: boolean;
	requiresResponse?: boolean;
	idempotencyKey?: string;
}): string {
	const rawKey = String(rec.idempotencyKey || "");
	if (rawKey) {
		const normalized = rawKey
			.replace(/^(goal:[a-z0-9_-]+:nudge:idle-streak:)\d+$/, "$1")
			.replace(/^(task:[a-z0-9_-]+:nudge:graph-stall:)\d+$/, "$1");
		return `idk:${normalized}`;
	}
	if (rec.conversationId) return `conv:${rec.conversationId}`;
	const subject = String(rec.subject || "").trim();
	if (subject) {
		return `subj:${subject}|from:${String(rec.from || "")}|replyTo:${String(rec.replyTo || "")}|ack:${rec.requiresAck ? 1 : 0}|resp:${rec.requiresResponse ? 1 : 0}`;
	}
	return `msg:${rec.id}`;
}

export function compareSurfaceCandidates(
	a: { id: string; createdAt?: string; updatedAt?: string },
	b: { id: string; createdAt?: string; updatedAt?: string },
): number {
	const aTs = new Date(a.updatedAt || a.createdAt || 0).getTime();
	const bTs = new Date(b.updatedAt || b.createdAt || 0).getTime();
	if (aTs !== bTs) return aTs - bTs;
	return a.id.localeCompare(b.id);
}

// Coalesced entry shape used by surface/pump.ts (kept here so pump + facade agree on it).
export type CoalescedEntry = { msg: SwarmMessage; dropped: string[] };
