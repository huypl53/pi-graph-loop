// === swarm/taskgraph/attention.ts — durable attention derivation + lifecycle notification fencing ===
// Pure, read-only classification from persisted state only (roadmap issues 5 & 9). Never consults
// tmux/process/pane liveness. Extracted from taskgraph.ts (Phase 6 real split).

import {
	ACK_MISSING_MS,
	PI_SWARM_MINIMAL_PROTOCOL,
	REMINDER_NO_PROGRESS_MS,
	SETTLE_NOTIFY_COOLDOWN_MS,
	TASK_NUDGE_MS,
	TASK_STALE_MS,
	TERMINAL_NODE_STATUSES,
} from "../constants.ts";
import type { MessageRecord, NodeAttention, ReminderRecord, SwarmAgent, SwarmState, TaskNode, TaskState } from "../types.ts";

const isoMs = (v?: string): number => (v ? new Date(v).getTime() || 0 : 0);

// The no-progress anchor: the MOST RECENT of the durable activity timestamps. The assignedAt floor
// guarantees a value; a reminder fires only when even the freshest evidence is stale.
function reminderAnchorMs(msg: MessageRecord | undefined, node: TaskNode, attempt: any): number {
	return Math.max(isoMs(msg?.lastAck?.at), isoMs(node.lastActivityAt), isoMs(attempt?.lastActivityAt), isoMs(attempt?.assignedAt));
}

// Receipt/processing confirmation requires both durable receipt timestamp and a progress ACK on
// the canonical assignment. `ackedAt` records receipt, never semantic completion; `done` still
// follows the separate response/closure path. Transport injection without this ACK is never receipt.
function receiptConfirmed(msg: MessageRecord | undefined): boolean {
	const s = msg?.lastAck?.status;
	return Boolean(msg?.ackedAt) && (s === "seen" || s === "processing");
}

export function deriveNodeAttention(st: SwarmState, task: TaskState, nodeId: string, nowMs: number): NodeAttention {
	const node = task.nodes[nodeId];
	if (!node) return { category: "none", evidence: ["node does not exist"], workerReminderEligible: false, rootDecision: false };
	const evidence: string[] = [];

	// 1. Cancellation/terminal guards — no reminder for dead work.
	if (task.status === "cancelled") {
		evidence.push(`task_cancelled: task ${task.taskId}`);
		return { category: "cancelled", evidence, workerReminderEligible: false, rootDecision: false };
	}
	if (node.status === "cancelled") {
		evidence.push(`node_cancelled: node ${nodeId}`);
		return { category: "cancelled", evidence, workerReminderEligible: false, rootDecision: false };
	}
	if (TERMINAL_NODE_STATUSES.has(node.status)) {
		evidence.push(`terminal: node is ${node.status}`);
		return { category: "terminal", evidence, workerReminderEligible: false, rootDecision: false };
	}

	// Attempt + canonical assignment message (persisted sources only).
	const attempt: any =
		node.activeAttemptId && Array.isArray(node.attemptHistory)
			? node.attemptHistory.find((a: any) => a.attemptId === node.activeAttemptId)
			: undefined;
	const msg: MessageRecord | undefined = node.assignmentMessageId ? st.messages[node.assignmentMessageId] : undefined;

	// 2. Supersession guard: obsolete assignments are never actionable.
	if (msg?.superseded) {
		evidence.push(`superseded: assignment ${msg.id} superseded by ${msg.superseded.supersededBy} at ${msg.superseded.at}`);
		return { category: "superseded", evidence, workerReminderEligible: false, rootDecision: false };
	}
	if (node.activeAttemptId && attempt && attempt.status !== "active") {
		evidence.push(`superseded: attempt ${attempt.attemptId} status is ${attempt.status}`);
		return { category: "superseded", evidence, workerReminderEligible: false, rootDecision: false };
	}

	// 3. Ready-but-unassigned: root decision to assign.
	if (node.status === "ready" && !node.assignee) {
		evidence.push(`unassigned_ready: node ${nodeId} (${node.role}) is ready with no assignee`);
		return { category: "unassigned_ready", evidence, workerReminderEligible: false, rootDecision: true };
	}

	// 4. Transport problems (advisory display; never completion evidence).
	const agent: SwarmAgent | undefined = node.assignee ? st.agents[node.assignee] : undefined;
	if (msg && msg.status === "dead_letter") {
		evidence.push(`dead_letter: assignment ${msg.id} (${msg.lastError || "unknown"})`);
		return { category: "dead_letter", evidence, workerReminderEligible: false, rootDecision: true };
	}
	if (msg && msg.status === "failed" && !msg.lastAck) {
		evidence.push(`delivery_failed: assignment ${msg.id} (${msg.lastError || "unknown"})`);
		return { category: "delivery_failed", evidence, workerReminderEligible: false, rootDecision: true };
	}
	if (agent && agent.status === "stopped") {
		evidence.push(`transport_unavailable: assignee ${agent.id} is stopped (advisory; not completion evidence)`);
		return { category: "transport_unavailable", evidence, workerReminderEligible: false, rootDecision: true };
	}

	// 5/6. Protocol problems.
	if (PI_SWARM_MINIMAL_PROTOCOL === 0 && msg && msg.requiresAck && !msg.ackedAt && !msg.lastAck) {
		const since = Math.max(isoMs(msg.injectedAt), isoMs(msg.interceptedAt), isoMs(msg.createdAt));
		const age = nowMs - since;
		if (age > ACK_MISSING_MS) {
			evidence.push(`ack_missing: assignment ${msg.id} delivered ${Math.round(age / 60000)}m ago (${msg.status}), no durable ack`);
			return { category: "ack_missing", evidence, workerReminderEligible: false, rootDecision: false };
		}
	}
	// 6. Protocol problem: completion claimed but result unverified (worker acked done/failed without
	// a verified response). An in-flight assignment acked seen/processing is work, not response debt.
	if (
		msg &&
		msg.requiresResponse &&
		(msg.lastAck?.status === "done" || msg.lastAck?.status === "failed") &&
		!(msg.response?.status === "verified" || msg.response?.status === "waived")
	) {
		evidence.push(
			`response_missing: assignment ${msg.id} acked ${msg.lastAck!.status} but response is ${msg.response?.status || "missing"}`,
		);
		return { category: "response_missing", evidence, workerReminderEligible: false, rootDecision: true };
	}

	// 7/8. Work-progress + reminder eligibility for open assignments.
	if (node.status === "assigned" || node.status === "in_progress") {
		// Attempt currency + canonical message are prerequisites for any worker reminder.
		const attemptCurrent = Boolean(node.activeAttemptId && attempt && attempt.status === "active");
		const canonical = Boolean(node.assignmentMessageId && msg && !msg.superseded);
		const receipt = receiptConfirmed(msg);
		const reminder: ReminderRecord | undefined = attempt?.reminder;
		if (attemptCurrent && canonical) {
			const anchor = reminderAnchorMs(msg, node, attempt);
			const age = nowMs - anchor;
			if (reminder) {
				evidence.push(
					`reminder_sent: ${reminder.messageId} at ${reminder.sentAt} (anchor ${reminder.noProgressSince}); one-per-attempt budget consumed`,
				);
				if (age > TASK_NUDGE_MS)
					evidence.push(
						`no_progress: anchor is ${Math.round(age / 60000)}m old (> ${Math.round(TASK_NUDGE_MS / 60000)}m TASK_NUDGE_MS)`,
					);
				return { category: "reminder_sent", evidence, workerReminderEligible: false, rootDecision: age > TASK_STALE_MS };
			}
			if (receipt && age > REMINDER_NO_PROGRESS_MS) {
				evidence.push(`receipt confirmed: lastAck ${msg!.lastAck!.status} at ${msg!.lastAck!.at}`);
				evidence.push(
					`no_progress: anchor ${Math.round(age / 60000)}m ago (> ${Math.round(REMINDER_NO_PROGRESS_MS / 60000)}m REMINDER_NO_PROGRESS_MS)`,
				);
				return { category: "reminder_eligible", evidence, workerReminderEligible: true, rootDecision: false };
			}
			if (receipt && age > TASK_NUDGE_MS) {
				evidence.push(
					`no_progress: anchor ${Math.round(age / 60000)}m ago (> ${Math.round(TASK_NUDGE_MS / 60000)}m TASK_NUDGE_MS), receipt confirmed`,
				);
				return { category: "no_progress", evidence, workerReminderEligible: false, rootDecision: false };
			}
			if (!receipt)
				evidence.push(
					`receipt not confirmed: assignment ${msg!.id} status=${msg!.status} ackedAt=${msg!.ackedAt || "none"} lastAck=${msg!.lastAck?.status || "none"}`,
				);
			else evidence.push(`receipt confirmed (${msg!.lastAck!.status}), within no-progress window`);
			return { category: "none", evidence, workerReminderEligible: false, rootDecision: false };
		}
		// Legacy/open assignment without attempt metadata: readable, advisory staleness only.
		const nodeAge =
			nowMs -
			Math.max(
				isoMs(node.lastActivityAt),
				isoMs(node.assignmentMessageId ? msg?.lastAck?.at : undefined),
				isoMs(attempt?.assignedAt),
			);
		if (nodeAge > TASK_NUDGE_MS)
			evidence.push(
				`no_progress: legacy/unfenced assignment, ~${Math.round(nodeAge / 60000)}m since last durable activity (no attempt metadata; reminder requires a fenced attempt)`,
			);
		return { category: nodeAge > TASK_NUDGE_MS ? "no_progress" : "none", evidence, workerReminderEligible: false, rootDecision: false };
	}

	// Blocked/other open states.
	if (node.status === "blocked") {
		evidence.push(`blocked: node is blocked; awaiting dependency or root decision`);
		return { category: "none", evidence, workerReminderEligible: false, rootDecision: false };
	}
	evidence.push(`pending: node is ${node.status}, waiting on dependencies`);
	return { category: "none", evidence, workerReminderEligible: false, rootDecision: false };
}

// ---- Lifecycle notification fencing (reliability roadmap issue 9) ----
// Two-mode staleness predicates for emit-time fencing of lifecycle notifications:
//   * checkStallNotificationStale: stall/root-safety-net notifies (sites 1-5, 8, 9)
//   * checkClosureNotificationStale: closure/cancellation notifies (sites 6, 7)
// Both are pure, read-only derivations of stale events from durable state already loaded by the
// emitter (task.json node/attempt + swarm-state messages/agents). No tmux/process inspection, no
// pane idleness inference. Emit-time only — emit iff the predicate returns { stale: false }.
// Predicates short-circuit to { stale: false } when legacy attempt metadata is missing.

export type NotificationStaleness = { stale: boolean; reason: string | null; evidence: string[] };

// checkStallNotificationStale — used by sites that emit STALL or ROOT-SAFETY-NET notifies
// (response_missing on settle, open-assignment on settle, session_shutdown with open nodes,
// graph-advance nudge, initial-ready nudge, assignment itself, /swarm remind). Stale iff:
//   1) task closed (done/failed/cancelled)
//   2) node terminal (TERMINAL_NODE_STATUSES.has(node.status))
//   3) canonical assignment message superseded
//   4) active attempt is not active (or legacy short-circuit when attempt metadata is absent)
//   5) node.assignee drift (the notifying agent is no longer the assignee)
//   6) agent stopped/unhealthy AND assignment is older than SETTLE_NOTIFY_COOLDOWN_MS grace
export function checkStallNotificationStale(
	st: SwarmState,
	task: TaskState,
	nodeId: string,
	agentId: string,
	nowMs: number,
	opts?: { freshAssignment?: boolean },
): NotificationStaleness {
	const evidence: string[] = [];
	const node = task.nodes[nodeId];
	if (!node) return { stale: false, reason: null, evidence: [] };

	// (1) Task closed
	if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
		evidence.push(`task_closed: task ${task.taskId} status=${task.status}`);
		return { stale: true, reason: "task_closed", evidence };
	}

	// (2) Node terminal by status
	if (TERMINAL_NODE_STATUSES.has(node.status)) {
		evidence.push(`node_terminal: node ${nodeId} status=${node.status}`);
		return { stale: true, reason: "node_terminal", evidence };
	}

	// (3) Superseded canonical assignment message
	const canonId = node.assignmentMessageId;
	if (canonId) {
		const rec = st.messages[canonId];
		if (rec?.superseded) {
			evidence.push(`superseded_message: assignment ${canonId} superseded by ${rec.superseded.supersededBy}`);
			return { stale: true, reason: "superseded", evidence };
		}
	}

	// (4) Attempt superseded — LEGACY SHORT-CIRCUIT (issue 4 plans predate attempt metadata).
	if (!node.activeAttemptId || !Array.isArray(node.attemptHistory)) {
		evidence.push(`legacy_no_attempt_metadata: skipping attempt staleness check`);
	} else {
		const attempt = node.attemptHistory.find((a: any) => a.attemptId === node.activeAttemptId);
		if (attempt && attempt.status !== "active") {
			evidence.push(`superseded_attempt: attempt ${attempt.attemptId} status=${attempt.status}`);
			return { stale: true, reason: "superseded_attempt", evidence };
		}
		// Last attempt's assignee stopped/unhealthy beyond grace: the node's work is orphaned — an
		// assign-nudge for it is stale until a fresh assignment (or deliberate reassignment) happens.
		// Applies when the node currently has no assignee (released) and the nudge targets the PM.
		const lastAttempt = attempt || node.attemptHistory.at(-1);
		if (!node.assignee && lastAttempt?.assignee) {
			const prior = st.agents[lastAttempt.assignee];
			if (prior && (prior.status === "stopped" || prior.health === "unhealthy")) {
				const assignedAt = lastAttempt.assignedAt ? new Date(lastAttempt.assignedAt).getTime() : 0;
				const age = nowMs - assignedAt;
				if (age > SETTLE_NOTIFY_COOLDOWN_MS) {
					evidence.push(
						`orphaned_attempt_assignee_stopped: ${lastAttempt.assignee} ${prior.status}/${prior.health}, attempt age=${Math.round(age / 1000)}s > grace`,
					);
					return { stale: true, reason: "agent_stopped", evidence };
				}
			}
		}
	}

	// (5) Assignee drift — the "root" agentId is a placeholder used by watchers that nudge the
	// PM about an UNASSIGNED node (initial-ready, graph-advance); there is no assignee to drift from.
	if (node.assignee !== agentId && agentId !== "root") {
		evidence.push(`assignee_drift: node assignee=${node.assignee || "(unassigned)"} but notifying agent=${agentId}`);
		return { stale: true, reason: "assignee_drift", evidence };
	}

	// (6) Agent stopped / unhealthy with grace (SETTLE_NOTIFY_COOLDOWN_MS per plan §2 C4).
	// R11-5: NEVER applies to a fresh assignment mint (swarm_assign_task passes freshAssignment) —
	// an agent being `stopped` at assign time is the normal restart-the-pane flow; fencing the
	// brand-new canonical assignment because the OLD canonId is old deadlocks the worker
	// (live incident 2026-09-01 08:25: task.assign.fenced agent_stopped → worker self-assign
	// attempt → ROOT_AUTHORITY_REQUIRED → settled idle with the node open).
	if (opts?.freshAssignment) {
		evidence.push("fresh_assignment: skipping agent-stopped staleness (assign path)");
		return { stale: false, reason: null, evidence };
	}
	const agent = st.agents[agentId];
	if (agent && (agent.status === "stopped" || agent.health === "unhealthy")) {
		const assignmentAge =
			canonId && st.messages[canonId]?.createdAt
				? nowMs - new Date(st.messages[canonId].createdAt).getTime()
				: Number.POSITIVE_INFINITY;
		if (assignmentAge > SETTLE_NOTIFY_COOLDOWN_MS) {
			evidence.push(
				`agent_stopped: agent ${agentId} ${agent.status}/${agent.health}, assignment age=${Math.round(assignmentAge / 1000)}s > grace=${SETTLE_NOTIFY_COOLDOWN_MS}ms`,
			);
			return { stale: true, reason: "agent_stopped", evidence };
		} else {
			evidence.push(
				`agent_stopped_within_grace: assignment age=${Math.round(assignmentAge / 1000)}s < grace=${SETTLE_NOTIFY_COOLDOWN_MS}ms (fresh)`,
			);
		}
	}

	return { stale: false, reason: null, evidence };
}

// checkClosureNotificationStale — used by sites that emit CLOSURE or CANCELLATION notifies
// (swarm_update_task closure, swarm_update_task cancellation). Critically narrow: it does NOT
// consider TERMINAL_NODE_STATUSES, message.superseded, attempt.status, or task.status drift as
// staleness — those are the EXPECTED trigger outcomes, not staleness. Stale iff:
//   1) node no longer exists in the graph
//   2) node re-opened (status=ready) AND re-assigned to a DIFFERENT agent (rework edge)
export function checkClosureNotificationStale(
	_st: SwarmState,
	task: TaskState,
	nodeId: string,
	triggeringAssignee: string | undefined,
	_nowMs: number,
): NotificationStaleness {
	const evidence: string[] = [];
	const node = task.nodes[nodeId];
	if (!node) {
		evidence.push(`node_missing: node ${nodeId} no longer exists in graph`);
		return { stale: true, reason: "node_missing", evidence };
	}

	// (2) Reopened + reassigned to a different agent: the closure/cancel event no longer applies
	// because the node has been re-opened and routed elsewhere.
	if (node.status === "ready" && node.assignee && node.assignee !== triggeringAssignee) {
		evidence.push(
			`reopened_reassigned: node ${nodeId} status=ready, assignee=${node.assignee} (was ${triggeringAssignee || "unassigned"})`,
		);
		return { stale: true, reason: "reopened_reassigned", evidence };
	}

	return { stale: false, reason: null, evidence };
}
