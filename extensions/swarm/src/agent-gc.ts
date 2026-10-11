// === swarm/agent-gc.ts — stopped-agent record GC predicates + default-view row filter (PURE) ===
//
// Issue stopped-agent-records-gc (task-202610041206): stopped agent records pollute
// swarm_agent_status forever; the only removal path was one-by-one /swarm deregister --purge.
// This module is the pure core (no I/O, no locks) for:
//   1. Default-view hiding: filterAgentRows hides status==="stopped" rows from census/attention
//      unless includeStopped (explicit) — the view:"full" imply died with the full view
//      (2026-10-10). Targeted agentId queries always pass.
//   2. Batch purge gating (stoppedGcCandidates + applyStoppedGc): an agent record is purge-
//      eligible ONLY when ALL of:
//        - status === "stopped" and id !== "root"
//        - stopped for >= stoppedOlderThanMs (default 24h; age from lastShutdownAt||updatedAt||createdAt)
//        - no NON-terminal task node in any supplied task graph references it as assignee
//        - no response debt (responseMissingRecords-shaped requiresResponse messages, or
//          actionable pending/unacked messages addressed to it)
//   The companion surfaces (/swarm deregister --purge-stopped command; the stopped-gc
//   mock-llm lane driving these helpers directly) own readState/withLock/writeState +
//   requireRootAuthority. The former swarm_gc tool wrapper was removed in the 2026-10
//   retired-surface cleanup.
//
// Loss boundary (docs/swarm/operations.md): purging deletes the state record + delivered
// ledger only. Mailbox/identity files on disk, traces (events.jsonl), and task artifacts
// keep full history.

import type { SwarmState } from "./types.ts";

export const DEFAULT_STOPPED_OLDER_THAN_MS = 24 * 60 * 60 * 1000;

export interface StoppedGcOptions {
	/** Minimum stopped age (ms) before a record is purge-eligible. Default 24h. */
	stoppedOlderThanMs?: number;
	/** now in ms (injectable for tests). */
	nowMs?: number;
	/** Loaded task graphs to scan for assignee references: [{ taskId, nodes: {id: {assignee, status}} }] */
	taskGraphs?: Array<{ taskId?: string; nodes?: Record<string, { assignee?: string | null; status?: string }> }>;
}

export interface StoppedGcCandidate {
	agentId: string;
	ageMs: number | null;
	gates: { aged: boolean; unreferenced: boolean; debtFree: boolean };
	eligible: boolean;
	blocked: string[];
}

const TERMINAL_NODE_STATUSES = new Set(["done", "failed", "skipped", "cancelled"]);

function stoppedSinceMs(agent: any): number | null {
	const raw = agent.lastShutdownAt || agent.updatedAt || agent.createdAt;
	if (!raw) return null;
	const t = new Date(raw).getTime();
	return Number.isFinite(t) ? t : null;
}

export function isTaskReferenced(agentId: string, taskGraphs: StoppedGcOptions["taskGraphs"]): boolean {
	if (!taskGraphs?.length) return false;
	for (const g of taskGraphs) {
		for (const node of Object.values(g.nodes || {})) {
			if (node?.assignee === agentId && !TERMINAL_NODE_STATUSES.has(String(node.status || ""))) return true;
		}
	}
	return false;
}

export function hasResponseDebt(st: SwarmState, agentId: string): boolean {
	for (const m of Object.values(st.messages || {})) {
		if (!m || (m as any).to !== agentId) continue;
		const rec = m as any;
		// requiresResponse delivered/injected/intercepted/failed-with-ack and not verified/waived → debt
		const trackingActive =
			rec.requiresResponse === true &&
			rec.status !== "dead_letter" &&
			rec.status !== "queued" &&
			(rec.status !== "failed" || Boolean(rec.lastAck));
		if (trackingActive && rec.response?.status !== "verified" && rec.response?.status !== "waived") return true;
		// actionable pending/unacked debt (non-minimal-protocol shapes)
		if (rec.status === "queued" || rec.status === "failed") return true;
	}
	return false;
}

export function stoppedGcCandidates(st: SwarmState, opts: StoppedGcOptions = {}): StoppedGcCandidate[] {
	const minAge =
		typeof opts.stoppedOlderThanMs === "number" && Number.isFinite(opts.stoppedOlderThanMs) && opts.stoppedOlderThanMs >= 0
			? opts.stoppedOlderThanMs
			: DEFAULT_STOPPED_OLDER_THAN_MS;
	const nowMs = typeof opts.nowMs === "number" ? opts.nowMs : Date.now();
	const out: StoppedGcCandidate[] = [];
	for (const [agentId, agentAny] of Object.entries(st.agents || {})) {
		const agent = agentAny as any;
		if (agentId === "root") continue;
		if (agent?.status !== "stopped") continue;
		const since = stoppedSinceMs(agent);
		const ageMs = since === null ? null : Math.max(0, nowMs - since);
		const aged = ageMs !== null && ageMs >= minAge;
		const unreferenced = !isTaskReferenced(agentId, opts.taskGraphs);
		const debtFree = !hasResponseDebt(st, agentId);
		const blocked: string[] = [];
		if (!aged) blocked.push("too-recent");
		if (!unreferenced) blocked.push("task-referenced");
		if (!debtFree) blocked.push("response-debt");
		out.push({ agentId, ageMs, gates: { aged, unreferenced, debtFree }, eligible: blocked.length === 0, blocked });
	}
	return out;
}

export function applyStoppedGc(
	st: SwarmState,
	candidates: StoppedGcCandidate[],
	opts: { dryRun?: boolean } = {},
): { purged: string[]; blocked: string[]; dryRun: boolean } {
	const dryRun = opts.dryRun !== false;
	const purged: string[] = [];
	const blocked: string[] = [];
	st.delivered ||= {};
	for (const c of candidates) {
		if (!c.eligible) {
			blocked.push(c.agentId);
			continue;
		}
		if (!dryRun) {
			delete (st.agents as Record<string, unknown>)[c.agentId];
			delete st.delivered[c.agentId];
		}
		purged.push(c.agentId);
	}
	return { purged, blocked, dryRun };
}

export interface FilterAgentRowsOptions {
	/** Show stopped rows too (legacy behavior). */
	includeStopped?: boolean;
	/** View name, kept for call-site compatibility. The legacy view:"full" → includeStopped
	 *  imply was removed with the full view itself (2026-10-10); includeStopped is explicit-only. */
	view?: string;
	/** Targeted agentId query — targeted rows ALWAYS pass, any status. */
	agentId?: string;
}

/** Default-view hiding for census/attention rows: stopped rows are hidden unless
 *  includeStopped is explicit; targeted agentId queries always keep their rows. */
export function filterAgentRows(rows: Array<Record<string, unknown>>, opts: FilterAgentRowsOptions = {}): Array<Record<string, unknown>> {
	const targeted = Boolean(opts.agentId);
	const includeStopped = opts.includeStopped === true || targeted;
	if (includeStopped) return rows;
	return rows.filter((r) => r.status !== "stopped");
}
