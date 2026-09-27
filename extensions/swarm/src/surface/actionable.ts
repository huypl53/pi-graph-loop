// === swarm/surface/actionable.ts — root-message actionability predicate (Phase 7) ===
// Extracted verbatim from ../surface.ts (Phase 7 modular split; canonical logic unchanged).
//
// Module boundary: predicate gating root-visible PM surfacing.
//   - parseTaskNodeRef          — taskId/nodeId extraction from conversationId
//   - isActionableRootMessage   — actionability predicate for historical root PM messages
//
// Depends on: constants (allow-list gates + trace keys), state (taskPaths/trace/traceTask),
// types (Paths/TaskState). No Pi runtime boundary is crossed here — this module is a pure
// predicate over durable state records (L1) and never calls pi.sendMessage.
import type { Paths, TaskState } from "../types.ts";
import { PI_SWARM_MINIMAL_PROTOCOL, PUMP_RETRIGGER_MAX, TERMINAL_NODE_STATUSES, TRACE_LATE_RESULT_REJECTED } from "../constants.ts";
import { taskPaths, trace, traceTask } from "../state.ts";

// Helper to parse taskId/nodeId from conversationId (format: "task:${taskId}:${nodeId}").
export function parseTaskNodeRef(conversationId: string | undefined): { taskId?: string; nodeId?: string } | null {
	if (!conversationId) return null;
	// Canonical formats observed in production:
	//   - "task:{taskId}:{nodeId}"                — graph-advance nudge (line 844)
	//   - "task:{taskId}:node:{nodeId}:nudge:{kind}:seq:{n}" — stale-open / pool_depleted variants
	// The compact form must be matched first so a 3-segment conversationId is not mis-parsed as
	// the long form (where nodeId would be the literal "node").
	const compact = conversationId.match(/^task:([^:]+):([^:]+)$/);
	if (compact && !["node", "pool_depleted", "nudge"].includes(compact[2])) {
		return { taskId: compact[1], nodeId: compact[2] };
	}
	const long = conversationId.match(/^task:([^:]+):(?:node:([^:]+):nudge:|pool_depleted(?:$|:))/);
	if (long) return { taskId: long[1], nodeId: long[2] || null };
	// Last-resort: any leading "task:{taskId}:" — return taskId without a nodeId so the predicate
	// can still gate on task-terminal status even when the node ref is absent or unknown.
	const taskOnly = conversationId.match(/^task:([^:]+):/);
	if (taskOnly) return { taskId: taskOnly[1], nodeId: undefined };
	return null;
}

// Actionability predicate for historical root PM messages (issue 11, §5). Returns { ok: false }
// for messages that must NOT be surfaced: acked, dead_lettered, superseded, wrong recipient, task
// terminal/cancelled/missing, node terminal/missing/reassigned, retrigger-budget-exhausted, or
// informational already consumed. The `strictForMigration` flag treats retrigger-budget-exhausted as
// non-actionable for the one-time migration back-fill (the budget resets per session). Exported
// for reuse by the migration back-fill block.
export function isActionableRootMessage(
	rec: {
		id: string;
		to: string;
		from?: string;
		requiresAck?: boolean;
		status?: string;
		ackedAt?: string;
		superseded?: any;
		conversationId?: string;
		idempotencyKey?: string;
		requiresResponse?: boolean;
		replyTo?: string;
	},
	taskIndex: Record<string, TaskState>,
	nowMs: number,
	retriggerCounts: Record<string, number>,
	strictForMigration: boolean,
	p?: Paths,
): { ok: boolean; reason: string } {
	if (rec.ackedAt) return { ok: false, reason: "acked" };
	if (rec.status === "dead_letter") return { ok: false, reason: "dead_letter" };
	if (rec.superseded) {
		// === Issue 83b — rec-level late-result trace (round-4 KR5 fix) ===
		// Mirror the tool-layer TRACE_LATE_RESULT_REJECTED so the rec-level guard (the path that
		// runs in `reconcile` / pump re-trigger / migration back-fill) is also observable in the
		// trace census. The caller MUST thread `p: Paths` so the trace writes through the real
		// `taskPaths(p, taskId)` and lands in the durable events.jsonl. No silent swallow: if the
		// durable write fails we surface it as `swarm.rec_late_result_trace_failed` so the failure
		// is observable in the trace census. The predicate itself never throws.
		if (p) {
			const taskNodeRef = parseTaskNodeRef(rec.conversationId);
			if (taskNodeRef && taskNodeRef.taskId && taskNodeRef.nodeId) {
				const task = taskIndex[taskNodeRef.taskId];
				if (task) {
					const tp = taskPaths(p, task.taskId);
					traceTask(tp, TRACE_LATE_RESULT_REJECTED, {
						taskId: task.taskId,
						nodeId: taskNodeRef.nodeId,
						messageId: rec.id,
						supersededBy: rec.superseded?.supersededBy,
						reason: "rec_superseded",
					}).catch((err: any) => {
						// KR5: surface durable-write failure instead of silent swallow.
						return trace(p, "swarm.rec_late_result_trace_failed", {
							taskId: task.taskId,
							nodeId: taskNodeRef.nodeId,
							messageId: rec.id,
							error: String(err?.message || err),
						});
					});
				}
			}
		}
		return { ok: false, reason: "superseded" };
	}
	if (rec.to !== "root") return { ok: false, reason: "wrong_recipient" };
	// === self-echo-pump-suppression-20260927 — self-origin guard (DESIGN CORRECTION) ===
	// The root pump must not treat the root's OWN outbound messages as actionable work
	// (live incident 2026-09-27: root→root result echoes re-surfaced ~30s after authoring).
	// BUT the engine's own re-trigger voice — stale-open, goal idle, graph-advance/stall,
	// settle-stale, initial-ready, R20 artifact-progress nudges — is ALSO stamped
	// from:"root" (the pump/nudge machinery runs in the root process, so
	// deliverMessageLocked sees currentAgentId()==="root"). Those MUST stay actionable:
	// they are precisely the re-trigger class R13's high-priority bypass exists to
	// surface. Exempt only messages carrying a CANONICAL engine-nudge key:
	//   - `:nudge:` in idempotencyKey/conversationId — covers every NOTIFY_KEY_*
	//     template (task:...:nudge:{kind}:seq:n, goal:{id}:nudge:idle-streak:n) and the
	//     r20:nudge: artifact-progress key;
	//   - `goal:...:escalation:` — goal-epoch pool-empty escalations (not nudge-shaped).
	// A bare `goal:` prefix would exempt ANY root-authored traffic in a goal conversation
	// (e.g. `goal:some-id:chat`) — the exemption is keyed to the CANONICAL escalation form
	// `goal:...:escalation:...` only.
	// REWORK (review blocking finding) — requiresAck scope: the guard applies ONLY to
	// ack-expected records (`requiresAck !== false`). windowMsgs (pump-decision.ts) uses
	// this predicate as its INCLUSION filter, so a blanket guard excluded fresh
	// root-authored informational echoes from the one-time informational surface path:
	// neverDisplayed → surfaced once → pump.ts:250-255 stamps surfacedAt → the line-132
	// dedupe retires it → census informational_already_consumed. That path CANNOT
	// re-trigger: overdueRetrigger requires rec.requiresAck (pump-decision.ts:277-278
	// `if (!rec?.requiresAck || rec.ackedAt) return false`), and a surfaced-but-unstamped
	// echo (crash window) is deduped via surfacedAt once the stamp lands. So informational
	// self-origin is safe to let through the inclusion filter; only ACK-EXPECTED self-origin
	// (results, assignment echoes — the incident class) is suppressed. Placement: AFTER
	// dead_letter/superseded (supersession traces still fire for self-origin records),
	// BEFORE the R24 fingerprint logic. Read-only classification.
	if (rec.from === "root" && rec.requiresAck !== false) {
		const idem = String(rec.idempotencyKey || "");
		const conv = String(rec.conversationId || "");
		const isEngineNudge =
			idem.includes(":nudge:") ||
			conv.includes(":nudge:") ||
			/^goal:[^:]*:escalation:/.test(idem) ||
			/^goal:[^:]*:escalation:/.test(conv);
		if (!isEngineNudge) return { ok: false, reason: "self_origin" };
	}

	// Task-scoped predicate (covers terminal task, cancelled, terminal node, reassigned node).
	// Parse task/node reference from conversationId, falling back to the canonical
	// idempotencyKey format `task:{taskId}:node:{nodeId}:nudge:{kind}:seq:{n}` (production
	// stale-open / pool_depleted don't always set conversationId, but the idempotencyKey
	// always encodes the task+node ref).
	let taskNodeRef = parseTaskNodeRef(rec.conversationId);
	if ((!taskNodeRef || !taskNodeRef.taskId) && rec.idempotencyKey) {
		const idem = String(rec.idempotencyKey).match(/^task:([^:]+):(?:node:([^:]+):)?/);
		if (idem) taskNodeRef = { taskId: idem[1], nodeId: idem[2] || undefined };
	}
	if (taskNodeRef && taskNodeRef.taskId && taskNodeRef.nodeId) {
		// === R24 result-class exemption (2026-09-03) — task-scoped RESULT messages are not
		// suppressed by node_terminal/task_terminal. The pump's per-tick actionability gate
		// misclassifies these as moot historical alerts (the node they report on IS done), but
		// the recipient — typically the root PM — needs the result visible at the
		// surface to advance the task graph. Live incident 2026-09-02T15:26:06Z:
		// msg-1788362766708-64f55b39 (R23 implement-done result) was durably enqueued
		// (L1/C1 + L1/C2 mailbox_delivered) and durably classified node_terminal in
		// `isActionableRootMessage`, suppressing every pump tick for 5+ minutes
		// (notification.stale.suppressed reason:node_terminal) and only surfacing via a
		// manual swarm_check_mailbox at 15:31:09.993Z. The fix: detect result-class by the
		// minimal fingerprint (requiresAck && !requiresResponse && replyTo set) and treat the
		// message as actionable so the surface plan carries it. Nudges (canonical
		// `task:<id>:node:<id>:nudge:...` idempotencyKey) keep full gating — only the close-out
		// shape is exempted. This predicate is also called from migration back-fill (strictForMigration
		// = true) and re-trigger (false), so the exemption applies uniformly across the call sites
		// that filter the per-tick surface plan.
		// Predicate order: check `isResultClass` FIRST so nudges (which also lack replyTo in our
		// fingerprint) keep falling through to the existing task/node terminal gates.
		const isResultClass =
			(Boolean(rec.requiresAck) || PI_SWARM_MINIMAL_PROTOCOL === 1) && rec.requiresResponse === false && Boolean(rec.replyTo);
		const task = taskIndex[taskNodeRef.taskId];
		if (!task) return { ok: false, reason: "task_missing" };
		if (isResultClass) {
			if (task.status === "done") return { ok: true, reason: "result_class_exempt_task_done" };
			if (task.status === "failed") return { ok: true, reason: "result_class_exempt_task_failed" };
			if (task.status === "cancelled") return { ok: true, reason: "result_class_exempt_task_cancelled" };
		}
		if (task.status === "done") return { ok: false, reason: "task_done" };
		if (task.status === "failed") return { ok: false, reason: "task_failed" };
		if (task.status === "cancelled") return { ok: false, reason: "task_cancelled" };
		const node = task.nodes[taskNodeRef.nodeId];
		if (!node) return { ok: false, reason: "node_missing" };
		if (isResultClass) return { ok: true, reason: "result_class_exempt_node_terminal" };
		if (TERMINAL_NODE_STATUSES.has(node.status)) return { ok: false, reason: "node_terminal" };
		// Reassign race: a later assignment message carries a newer idempotencyKey for the same
		// (task,node) and stamped `superseded` on the prior one. The rec-level superseded flag
		// catches this — but if a stale message was written before the supersede record (race),
		// cross-check by finding the latest assign handoff for the node.
		const lastAssign = [...(task.handoffs || [])].reverse().find((h) => h.toNode === taskNodeRef.nodeId && h.kind === "assign");
		if (
			lastAssign &&
			rec.idempotencyKey &&
			(lastAssign as any).idempotencyKey &&
			(lastAssign as any).idempotencyKey !== rec.idempotencyKey
		) {
			return { ok: false, reason: "node_reassigned" };
		}
	}

	// Bounded re-trigger gate: a requiresAck message that was surfaced but never acked gets
	// a bounded number of fresh triggerTurns (PUMP_RETRIGGER_MAX). After that, suppress until
	// the message is acked or removed.
	if (rec.requiresAck && !rec.ackedAt) {
		const retriggerCount = retriggerCounts[rec.id] ?? 0;
		if (retriggerCount >= PUMP_RETRIGGER_MAX) {
			// For migration back-fill, treat retrigger-budget-exhausted as non-actionable (the
			// budget resets per session). For the standard pump, this is session-bounded.
			if (strictForMigration) return { ok: false, reason: "retrigger_budget_exhausted" };
			// In the live pump, we still allow it (the retriggerCount is session-bounded and
			// resets on PID change).
		}
	}

	return { ok: true, reason: "actionable" };
}
