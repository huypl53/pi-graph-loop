// === swarm/surface/staleness.ts — surface-time revalidation + suppression dedupe (Phase 7) ===
// Extracted verbatim from ../surface.ts (Phase 7 modular split; canonical logic unchanged).
//
// Module boundary: actionable→stale edge reasoning.
//   - staleSurfaceReason        — Row 68 surface-time revalidation of deferred nudges
//   - traceStaleSuppressedOnce  — dedupe helper for the stale→suppressed transition
//
// Depends on: goal-epoch (allEffectiveIdleAgents), taskgraph (computeReadyNodes,
// checkStallNotificationStale), state (trace). No Pi runtime boundary is crossed — these are
// pure/durable-state predicates over L1 records.
import type { Paths, SwarmState, TaskState } from "../types.ts";
import { TERMINAL_NODE_STATUSES } from "../constants.ts";
import { computeReadyNodes, checkStallNotificationStale } from "../taskgraph.ts";
import { allEffectiveIdleAgents } from "../nudges/goal-epoch.ts";
import { trace } from "../state.ts";

// === Row 68: surface-time revalidation of deferred nudges ===
// Acceptance criterion: "Deferred stale nudge is suppressed if node was assigned or an agent became
// busy before delivery." A nudge queued while a stall condition held may be stale by the time the
// pump is idle and able to surface it. This predicate re-checks at surface time:
//   - goal-idle nudges: suppressed if actionable graph work appeared on a LIVE task, or
//     the idle epoch advanced past the message's creation (stale idle window). R22
//     (2026-09-02): the previous "any effective agent became busy" leg was REMOVED — see
//     the goalKey branch comment below for the emission-vs-surface starvation rationale.
//   - graph-stall nudges: suppressed if agents are busy or no actionable unassigned node remains;
//   - graph-advance / initial-ready nudges: suppressed via checkStallNotificationStale (node
//     assigned/terminal/reassigned/task closed).
// Pure + exported for direct unit testing by idle-nudge.test.mjs (plan §2.3 — the pump's surface
// path is not reachable in unit tests because the leader gate denies non-leader pids).
export async function staleSurfaceReason(
	p: Paths,
	st: SwarmState,
	msg: { id: string; idempotencyKey?: string; createdAt?: string },
	taskIndex: Record<string, TaskState>,
	nowMs: number,
): Promise<{ stale: boolean; reason: string | null; evidence: string[] }> {
	const liveIdle = allEffectiveIdleAgents(st, nowMs).allIdle;
	// R27 (2026-09-04): the goal-key surface branch no longer consults task state. Emission
	// (evaluateIdleGoalNudgeLocked) is task-state-independent — an open actionable graph after
	// emission is the nudge's own requested action pending, not message staleness (same
	// R21/R22 principle: surface-time revalidation must AGREE with emission-time gating).
	// The legs that can make the MESSAGE itself false remain:
	//   - idle-epoch advanced past creation (the busy→idle edge after emission anchors a
	//     NEW epoch — this is the anti-immortality guard that bounds nudge lifetime).
	const idleAnchorMs = st.idleNudgeState?.allIdleSinceAt ? new Date(st.idleNudgeState.allIdleSinceAt).getTime() : NaN;
	const rec = st.messages[msg.id] || msg;
	const key = String(rec.idempotencyKey || msg.idempotencyKey || "");
	const createdAt = new Date(rec.createdAt || msg.createdAt).getTime();
	const taskKey = key.match(/^task:([^:]+):(?:node:([^:]+):)?nudge:/);
	const goalKey = key.match(/^goal:([^:]+):nudge:idle-streak:(\d+)$/);
	let staleReason: string | null = null;
	let evidence: string[] = [];
	if (goalKey) {
		// === R22 (2026-09-02) — the agent_busy leg is REMOVED for goal keys. ===
		// Emission (evaluateIdleGoalNudgeLocked) already required
		// allEffectiveIdleAgents().allIdle, so a worker that turned busy AFTER emission is
		// the nudge's own requested action succeeding (the root assigned work), not
		// message staleness. Re-checking it here contradicted the emission-time gate and
		// starved every queued goal nudge at surface time: live incident
		// 2026-09-02T12:03:36..12:30Z — nudges goal-1788350610025-7efafe
		// (msg-1788350616129-691b4e7c / -0aea3216 / -c6f752b8) suppressed with
		// `notification.stale.suppressed site=root_pump.surface reason=agent_busy`,
		// mailbox.root_pump_stuck_escalated every tick for 26+ min, ZERO
		// pi.sendMessage at the boundary, while consecutiveNoResolveNudges burned to
		// max+backoff on messages the root LLM never saw. R21 principle: surface
		// revalidation must AGREE with emission-time gating, never contradict it.
		// === R27 (2026-09-04) — the actionable_graph leg is REMOVED for goal keys. ===
		// Emission no longer consults task state, so neither may the surface gate
		// (the R21 liveGraphActionable leg — kept through R25 — contradicts the new
		// === R28 (2026-09-15) — Monotonic Goal Nudge Sequence Guard ===
		// Idle streak nudges carry a monotonic nudgeSeq in their idempotency key
		// (goal:{goalId}:nudge:idle-streak:{seq}).
		// First: check epoch advance (immortality guard). If message predates the idle epoch, it's idle_epoch_advanced.
		// Second: if the idle epoch is not active (allIdleSinceAt undefined due to root/worker busy) and st.goal
		// has advanced to a higher nudgeSeq, any older sequence number is strictly superseded and must NEVER
		// surface (prevents out-of-order resurrection like 50->51->52->49 when idleAnchorMs resets).
		// Also, if the goal is missing or changed, the nudge is stale.
		const msgSeq = Number(goalKey[2]);
		if (!st.goal || st.goal.id !== goalKey[1]) {
			staleReason = "goal_missing";
			evidence = [`goal_missing:${goalKey[1]}`];
		} else if (Number.isFinite(idleAnchorMs) && createdAt < idleAnchorMs) {
			staleReason = "idle_epoch_advanced";
			evidence = [
				`message_created_before_idle_epoch:${new Date(createdAt).toISOString()}`,
				`idle_epoch:${new Date(idleAnchorMs).toISOString()}`,
			];
		} else if (
			!Number.isFinite(idleAnchorMs) &&
			Number.isFinite(st.goal.nudgeSeq) &&
			Number.isFinite(msgSeq) &&
			msgSeq < st.goal.nudgeSeq
		) {
			staleReason = "goal_nudge_superseded";
			evidence = [`msg_seq:${msgSeq}`, `active_nudge_seq:${st.goal.nudgeSeq}`, `goal_id:${st.goal.id}`];
		}
	} else if (taskKey) {
		const task = taskKey[1] ? taskIndex[taskKey[1]] : undefined;
		const nodeId = taskKey[2];
		if (!liveIdle) {
			staleReason = "agent_busy";
			evidence = ["effective-agent-set-not-idle"];
		} else if (!task) {
			staleReason = "task_missing";
			evidence = [`task_missing:${taskKey[1]}`];
		} else if (key.includes(":nudge:graph-stall:")) {
			const cr = computeReadyNodes(task);
			const actionable = new Set([
				...cr.ready,
				...cr.current.filter((id) => task.nodes[id] && task.nodes[id].status === "ready" && !task.nodes[id].assignee),
			]);
			const actionableNodes = Array.from(actionable).filter((id) => {
				const n = task.nodes[id];
				return n && !n.assignee && !TERMINAL_NODE_STATUSES.has(n.status);
			});
			if (!actionableNodes.length) {
				staleReason = "no_active_node";
				evidence = ["no-actionable-unassigned-node-remains"];
			}
		} else if (nodeId) {
			const node = task.nodes[nodeId];
			const check = checkStallNotificationStale(st, task, nodeId, node?.assignee || "root", nowMs);
			if (check.stale) {
				staleReason = check.reason || "stale";
				evidence = check.evidence;
			}
		} else if (key.includes(":nudge:initial-ready")) {
			const start = task.nodes[task.start];
			if (!start || start.status !== "ready" || start.assignee) {
				staleReason = "no_active_node";
				evidence = ["initial-ready-node-no-longer-eligible"];
			}
		}
	}
	return { stale: staleReason !== null, reason: staleReason, evidence };
}

const staleSuppressionTraceSeen = new Set<string>();

export async function traceStaleSuppressedOnce(
	p: Paths,
	site: string,
	payload: { messageId?: string; idempotencyKey?: string | null; reason: string | null; evidence: string[] },
): Promise<boolean> {
	const key = String(payload.messageId || payload.idempotencyKey || "");
	if (staleSuppressionTraceSeen.has(key)) return false;
	staleSuppressionTraceSeen.add(key);
	await trace(p, "notification.stale.suppressed", {
		site,
		messageId: payload.messageId,
		idempotencyKey: payload.idempotencyKey,
		reason: payload.reason,
		evidence: payload.evidence,
	}).catch(() => {});
	return true;
}
