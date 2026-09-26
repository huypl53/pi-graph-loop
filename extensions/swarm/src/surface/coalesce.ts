// === swarm/surface/coalesce.ts — surface-plan coalescing + R13 bypass + receipt write-back ===
// Extracted verbatim from surface/pump-decision.ts (Phase 7 split of ../surface.ts).
//
// coalesceSurfacePlanLocked runs inside the pump's withLock over the candidate surface plan:
//   - Row 68 surface-time revalidation (staleSurfaceReason) with the R13 P0 priority-high
//     unknown-target root bypass and the R13 P1 liveness gate
//   - logical groupKey coalescing (one freshest notification per logical action)
//   - consumedSuppressedIds receipt write-back (durable dedupe, binding C4)
// Mutates the caller's per-pid orchSession `surfaced` set (entry.ids refreshed on suppression).
import type { MessageRecord, Paths, SwarmMessage, SwarmState, TaskState } from "../types.ts";
import { TERMINAL_NODE_STATUSES } from "../constants.ts";
import { now } from "../utils.ts";
import { trace } from "../state.ts";
import { parseTaskNodeRef } from "./actionable.ts";
import { staleSurfaceReason, traceStaleSuppressedOnce } from "./staleness.ts";
import { compareSurfaceCandidates, rootSurfaceGroupKey } from "./ranking.ts";
import { fingerprintMessage } from "./pump-shared.ts";

export async function coalesceSurfacePlanLocked(
	surfaceCandidates: SwarmMessage[],
	p: Paths,
	st: SwarmState,
	staleCtx: {
		taskIndex: Record<string, TaskState>;
		surfaced: Set<string>;
		nowMs: number;
		sess: { ids: string[]; [k: string]: unknown };
	},
): Promise<SwarmMessage[]> {
	const { taskIndex, surfaced, nowMs, sess } = staleCtx;
// Row 68: surface-time revalidation — deferred nudges are dropped if their stall condition no
// longer holds (node assigned / agent busy / graph quieted / epoch advanced).
// Coalesce repeated backlog messages by logical surface key before the final send decision so a
// compacted / replaced session replays at most one freshest eligible notification per logical
// action.
const surfacePlan = [...surfaceCandidates]
	.sort(compareSurfaceCandidates)
	.reverse()
	.map((msg) => {
		const rec = st.messages[msg.id] || msg;
		return { msg, rec: rec as MessageRecord, groupKey: rootSurfaceGroupKey(rec) };
	});
const coalesced = new Map<string, { msg: SwarmMessage; dropped: string[] }>();
const consumedSuppressedIds = new Set<string>();
for (const item of surfacePlan) {
	const v = await staleSurfaceReason(p, st, item.msg, taskIndex, nowMs);
	if (v.stale) {
		// === R13 P0 (2026-09-01) — priority-high unknown-target root safety-net bypass ===
		// The root pseudo-agent has tmuxTarget === "unknown" by design (identity.ts:69)
		// and a worker in `tool_running` state causes `staleSurfaceReason` to return
		// `{stale: true, reason: "agent_busy"}` — suppressing the durable nudge so the user
		// never sees it even though `deliverMessageLocked` reported success via mailbox_only.
		// Live incident 2026-09-01T13:10:27 trace: priority-high STALE-OPEN nudge durably
		// enqueued, mailbox_only logged, then `notification.stale.suppressed site=
		// root_pump.surface reason=agent_busy` with zero `pi.sendMessage` calls at the
		// reconcile.ts:1763-1773 boundary. Fix: for priority-high nudges bound for the
		// unknown-target root pseudo-agent, BYPASS the busy-suppression gate so the
		// safety nudge still surfaces locally. Normal-priority traffic still respects the
		// gate (otherwise the `goal.nudge.suppressed_by_active_task` storm from R10 returns).
		const recForBypass = item.rec;
		// Priority lives on the mailbox entry (item.msg — what windowMsgs read from the JSONL),
		// NOT on the st.messages record (upsertMessageRecord does not persist priority). Fall
		// back to the raw mailbox entry when the record's priority is absent.
		const bypassPriority = String(((recForBypass as unknown as SwarmMessage).priority ?? (item.msg as SwarmMessage)?.priority) || "").toLowerCase();
		const isHighPriority = bypassPriority === "high";
		const recipient = st.agents[recForBypass.to];
		const isUnknownTargetRoot = recipient?.id === "root" && (!recipient.tmuxTarget || recipient.tmuxTarget === "unknown");
		// === R13 P1 (2026-09-02) — liveness gate: the bypass MUST NOT rescue nudges whose
		// referenced task/node is already terminal. Live incident 2026-09-02: pre-R13
		// priority-high stale-open nudges that were durably enqueued on 2026-09-01
		// (when their tasks/nodes were still live) began re-surfacing on 2026-09-02
		// after those tasks/nodes closed overnight — the bypass converted a moot
		// historical alert into a user-visible "act now" message. Gate the bypass on
		// referenced-task liveness by parsing the canonical idempotencyKey format
		// (task:taskId:node:nodeId:nudge:*:seq:*) and reading taskIndex; fall back to
		// conversationId via parseTaskNodeRef for the production pool_depleted shape
		// (task:taskId:pool_depleted).
		const idemForLiveness = String(recForBypass.idempotencyKey || (item.msg as any)?.idempotencyKey || "");
		const idemMatch = idemForLiveness.match(/^task:([^:]+):(?:node:([^:]+):)?nudge:/);
		let liveTaskId: string | null = idemMatch ? idemMatch[1] : null;
		let liveNodeId: string | null = idemMatch ? idemMatch[2] || null : null;
		if (!liveTaskId) {
			const convRef = parseTaskNodeRef(recForBypass.conversationId || (item.msg as any)?.conversationId);
			if (convRef?.taskId) {
				liveTaskId = convRef.taskId;
				liveNodeId = convRef.nodeId || null;
			}
		}
		let liveTaskIsTerminal = false;
		let liveTerminalReason: string | null = null;
		if (liveTaskId) {
			const task = taskIndex[liveTaskId];
			if (!task) {
				liveTaskIsTerminal = true;
				liveTerminalReason = "task_missing";
			} else if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
				liveTaskIsTerminal = true;
				liveTerminalReason = `task_${task.status}`;
			} else if (liveNodeId && task.nodes[liveNodeId] && TERMINAL_NODE_STATUSES.has(task.nodes[liveNodeId].status)) {
				liveTaskIsTerminal = true;
				liveTerminalReason = "node_terminal";
			}
		}
		const bypassBusyForHigh = isHighPriority && isUnknownTargetRoot && v.reason === "agent_busy" && !liveTaskIsTerminal;
		if (liveTaskIsTerminal) {
			// Do NOT bypass — surface the historical nudge's terminal state via the
			// standard suppression trace + counters so it is observable in the
			// notification.batch.suppressed census (task_done / node_terminal).
			await traceStaleSuppressedOnce(p, "root_pump.surface", {
				messageId: item.msg.id,
				idempotencyKey: String(recForBypass.idempotencyKey || ""),
				reason: liveTerminalReason || "task_terminal",
				evidence: [liveTerminalReason || "task_terminal", "r13_p1_liveness_gate"],
			});
			consumedSuppressedIds.add(item.msg.id);
			continue;
		}
		if (bypassBusyForHigh) {
			await trace(p, "notification.surface.bypass_high_unknown_target", {
				messageId: item.msg.id,
				idempotencyKey: String(recForBypass.idempotencyKey || ""),
				suppressedReason: v.reason,
				suppressedEvidence: v.evidence,
				by: "R13 P0",
			}).catch(() => {});
			// Fall through to the coalescing path (do NOT continue past this item).
		} else {
			await traceStaleSuppressedOnce(p, "root_pump.surface", {
				messageId: item.msg.id,
				idempotencyKey: String(item.rec.idempotencyKey || item.msg.idempotencyKey || ""),
				reason: v.reason,
				evidence: v.evidence,
			});
			// If the stale reason is permanent (superseded, epoch advanced, terminal task/node, missing task/goal),
			// mark it consumed into receipts so it does not linger in the mailbox forever,
			// inflating oldestWaitMs and causing false stuck-busy escalations or resurrections.
			if (
				v.reason === "goal_nudge_superseded" ||
				v.reason === "idle_epoch_advanced" ||
				v.reason === "goal_missing" ||
				v.reason === "task_missing" ||
				v.reason === "task_done" ||
				v.reason === "task_failed" ||
				v.reason === "task_cancelled" ||
				v.reason === "node_terminal"
			) {
				consumedSuppressedIds.add(item.msg.id);
			}
			continue;
		}
	}
	const existing = coalesced.get(item.groupKey);
	if (!existing) {
		coalesced.set(item.groupKey, { msg: item.msg, dropped: [] });
		continue;
	}
	const existingTs = new Date((existing.msg as any).updatedAt || existing.msg.createdAt || 0).getTime();
	const incomingTs = new Date((item.msg as any).updatedAt || item.msg.createdAt || 0).getTime();
	if (incomingTs >= existingTs) {
		existing.dropped.push(existing.msg.id);
		existing.msg = item.msg;
	} else {
		existing.dropped.push(item.msg.id);
	}
	}
	for (const [groupKey, entry] of coalesced.entries()) {
		if (!entry.dropped.length) continue;
		await trace(p, "notification.coalesced.suppressed", {
			site: "root_pump.surface",
			groupKey,
			keptId: entry.msg.id,
			droppedIds: entry.dropped,
			count: entry.dropped.length,
		}).catch(() => {});
	}
	for (const entry of coalesced.values()) {
		for (const droppedId of entry.dropped) consumedSuppressedIds.add(droppedId);
	}
	if (consumedSuppressedIds.size) {
		const ts = now();
		if (!st.consumerReceipts) st.consumerReceipts = {};
		if (!st.consumerReceipts.root) st.consumerReceipts.root = { entries: {}, revision: 0 };
		if (!st.consumerReceipts.root.entries) st.consumerReceipts.root.entries = {};
		for (const id of consumedSuppressedIds) {
			const rec = st.messages[id];
			if (!rec || rec.to !== "root") continue;
			surfaced.add(id);
			if (rec.requiresAck === false) {
				st.delivered.root = Array.from(new Set([...(st.delivered.root || []), id]));
				const raw = rec as (MessageRecord & SwarmMessage) | SwarmMessage;
				if (!(raw as MessageRecord).surfacedAt) {
					(raw as MessageRecord).surfacedAt = ts;
					(raw as MessageRecord).updatedAt = ts;
				}
				continue;
			}
			if (!st.consumerReceipts.root.entries[id]) {
				st.consumerReceipts.root.entries[id] = {
					surfacedAt: ts,
					requiresAck: true,
					conversationId: rec.conversationId,
					fingerprint: fingerprintMessage(rec),
				};
				st.consumerReceipts.root.revision = (st.consumerReceipts.root.revision || 0) + 1;
			}
		}
		sess.ids = [...surfaced];
	}
	return [...coalesced.values()].map((entry) => entry.msg).sort(compareSurfaceCandidates);
}
