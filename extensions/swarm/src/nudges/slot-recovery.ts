// === swarm/nudges/slot-recovery.ts — provider slot-recovery nudge ===
// evaluateSlotRecoveryLocked (pool-health driven).
// Extracted from graph-advance.ts (Phase 6 real split). Bodies verbatim.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Paths, SwarmState } from "../types.ts";
import { logSwarmError } from "../errorlog.ts";
import { trace } from "../state.ts";
import { readPoolHealth, slotKey, withPoolLock, writePoolHealth } from "../pool.ts";

export async function evaluateSlotRecoveryLocked(
	pi: ExtensionAPI,
	cwd: string,
	p: Paths,
	st: SwarmState,
	nowMs: number,
): Promise<{ emitted: number; reasons: Record<string, number> }> {
	const reasons: Record<string, number> = { expired_no_tasks: 0, expired_quota: 0, deduped: 0, no_active_agent: 0, not_quota_bench: 0 };
	const emitted: Array<{ agentId: string; slot: string; afterMs: number; remainingTasks: number; benchMs: number }> = [];

	await withPoolLock(p, async () => {
		const h = await readPoolHealth(p);
		let dirty = false;
		for (const [slotKeyStr, health] of Object.entries(h.slots)) {
			// Skip slots with no cooldown or still in cooldown.
			if (!health?.cooldownUntil) continue;
			const cooldownEnd = new Date(health.cooldownUntil).getTime();
			if (cooldownEnd > nowMs) continue; // still in bench
			// Cooldown has expired — but only "quota" benches get a recovery event.
			if (health.lastBenchReason !== "quota") {
				reasons.not_quota_bench++;
				continue;
			}
			// Idempotent: skip if we already emitted for this bench cycle.
			if (health.lastRecoveredAt) {
				reasons.deduped++;
				continue;
			}
			// Find agents on this slot. The slot key is `${provider}/${model}`; agents carry their
			// current model+provider. We do NOT filter on tmuxTarget=="unknown" — even a dead-tmux
			// agent is a candidate for the trace (the root may want to know regardless).
			// Use slotKey() for consistent key derivation (handles "(default)" provider case).
			const slotAgentKey = slotKeyStr;
			const matchingAgents = Object.values(st.agents).filter((a) => {
				if (a.id === "root") return false; // root pseudo-agent never has active tasks for slot work
				return slotKey({ model: a.model, provider: a.provider }) === slotAgentKey;
			});
			const busyAgents = matchingAgents.filter((a) => (a.activeTaskIds?.length || 0) > 0);
			if (!busyAgents.length) {
				// Silent path (per plan §4 D): bench expired but no active tasks → no recovery event.
				// Slot is healthy again for the next pickSlot; no notify needed.
				reasons.expired_no_tasks++;
				continue;
			}
			// Compute afterMs = how long the bench has been expired (nowMs - cooldownEnd). The benchMs
			// payload comes from the slot's lastBenchMs stamped by recordProviderError at bench time.
			const afterMs = Math.max(0, nowMs - cooldownEnd);
			// Emit one trace per busy agent (a slot with multiple workers on it produces multiple
			// events; the root can dedupe downstream if it cares).
			for (const agent of busyAgents) {
				emitted.push({
					agentId: agent.id,
					slot: slotKeyStr,
					afterMs,
					remainingTasks: agent.activeTaskIds.length,
					benchMs: health.lastBenchMs ?? Math.max(0, cooldownEnd - (cooldownEnd - afterMs)),
				});
				reasons.expired_quota++;
			}
			// Stash idempotency stamp so the next tick (and all subsequent ticks until a new bench)
			// stay silent.
			health.lastRecoveredAt = new Date(nowMs).toISOString();
			dirty = true;
		}
		if (dirty) await writePoolHealth(p, h).catch((err) => logSwarmError(p, "nudges.graph-advance", "writePoolHealth.failed", err));
	});

	for (const ev of emitted) {
		await trace(p, "pool.slot_recovered", {
			agentId: ev.agentId,
			slot: ev.slot,
			afterMs: ev.afterMs,
			remainingTasks: ev.remainingTasks,
			benchMs: ev.benchMs,
		}).catch(() => {});
	}

	return { emitted: emitted.length, reasons };
}

// === Issue 11: Root wake-up escalation + durable replay fencing ===

// Helper to parse taskId/nodeId from conversationId (format: "task:${taskId}:${nodeId}").
