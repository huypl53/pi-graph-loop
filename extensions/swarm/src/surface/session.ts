// === swarm/surface/session.ts — per-pid pump session gate (Phase 7) ===
// Extracted verbatim from ../surface.ts (Phase 7 modular split; canonical logic unchanged).
//
// Module boundary: session gate + retrigger counter source-of-truth.
//   - orchSession — the per-pid rootPumpSessions record (surfaced ids, triggeredAt,
//     retriggerCount, lastAt). Pure state accessor over the swarm state record (L1).
import type { SwarmState } from "../types.ts";
import { currentAgentId } from "../session.ts";

export function orchSession(
	st: SwarmState,
	nowMs: number,
): { ids: string[]; triggeredAt?: Record<string, string>; retriggerCount?: Record<string, number>; lastAt: string } | null {
	if (currentAgentId() !== "root") return null;
	st.rootPumpSessions ||= {};
	const key = String(process.pid);
	if (!st.rootPumpSessions[key]) st.rootPumpSessions[key] = { ids: [], lastAt: new Date(nowMs).toISOString() };
	return st.rootPumpSessions[key];
}
