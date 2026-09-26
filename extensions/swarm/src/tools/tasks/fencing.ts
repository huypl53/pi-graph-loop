// === swarm/tools/tasks/fencing.ts — Issue 83b late-result + reassign-rate fencing (real code) ===
// Pure helpers extracted verbatim from the src/tools/tasks.ts monolith (Phase 6 real split).
// The supersession-fencing.test.mjs AST assertions (C8.a/b/c) read src/tools/tasks.ts directly;
// the facade carries the C8 traceability excerpt. This module is the canonical implementation.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskNode, TaskPaths, SwarmState, TaskState } from "../../types.ts";
import {
	LATE_RESULT_REFUSAL_REASON,
	PI_SWARM_REASSIGN_RATE_LIMIT,
	PI_SWARM_REASSIGN_RATE_WINDOW_MS,
	REASSIGN_RATE_LIMITED,
	TRACE_LATE_RESULT_REJECTED,
} from "../../constants.ts";
import { taskPaths, traceTask } from "../../state.ts";
import { inferRoleKind, now } from "../../utils.ts";
import { isGraphTerminalNode, resolveCommitNodeEvidence } from "../../taskgraph.ts";
import { attachGitDiffStat, validateAttestations } from "../../trace.ts";

// === Issue 83b — late-result rejection helper (exported for testing) ===
// A worker (the prior assignee) holds an attemptId from its old assignment. The node has since been
// reassigned to a newer active attempt. The worker now attempts `swarm_update_task` with the OLD
// attemptId. This helper detects the situation and returns a refusal envelope WITHOUT mutating
// the node. The caller (the tool body) is responsible for trace emission + durable stamp.
//
// Pure function: no I/O. Reads `node.attemptHistory` and `node.activeAttemptId`. Returns:
//   - null when the caller's attemptId is the active attempt (positive path: caller wins)
//   - null when no supersession has happened yet (legacy path: caller wins)
//   - { refused: true, reason: "supersession", ... } when the caller holds a SUPERSEDED attempt
//     AND the node has a NEWER active attempt (the late-result scenario)
//   - { refused: true, reason: "supersession", ... } when the caller holds a non-active attempt
//     in attemptHistory (covers attempts that were supersededBy="<rework>" or "<force-reopen>")
//
// Distinct from the existing `ATTEMPT_TOKEN_REQUIRED` / `ATTEMPT_TOKEN_MISMATCH` paths in the
// attempt-fencing block (which use `failTaskTool` + `tp` to emit traces + write task.json). This
// helper is a pure check; the caller can choose how to surface it.
export type LateResultRefusal = {
	refused: true;
	reason: typeof LATE_RESULT_REFUSAL_REASON;
	providedAttemptId: string;
	providedAttemptStatus: string;
	activeAttemptId: string;
	activeAttemptNumber: number | "?";
	supersededAt?: string;
	lateArrivalAt: string;
};
export function checkLateResultRejection(node: TaskNode, providedAttemptId: string | undefined, nowIso: string): LateResultRefusal | null {
	if (!providedAttemptId) return null; // no token: the fencing block handles this with ATTEMPT_TOKEN_REQUIRED
	// Positive path: provided token IS the active attempt — caller wins.
	if (node.activeAttemptId && providedAttemptId === node.activeAttemptId) return null;
	// Caller's attempt must exist in history and be NON-active (superseded/etc).
	const providedAttempt = node.attemptHistory?.find((a: any) => a.attemptId === providedAttemptId);
	if (!providedAttempt) return null; // unknown token: not a late-result; the fencing block handles this
	if (providedAttempt.status === "active") {
		// The provided attempt is active but not the node.activeAttemptId. Edge case: caller is
		// racing the mint. Refuse with supersession.
	}
	if (providedAttempt.status === "active" && node.activeAttemptId === providedAttemptId) return null; // explicit no-op
	// Late-result scenario: caller holds a non-active attempt AND node has a newer active attempt.
	if (!node.activeAttemptId) {
		// Caller holds a non-active attempt AND node has no active attempt. Likely the caller is
		// a legacy / pre-attempt-fencing worker. NOT a late-result (no supersession racing). Allow.
		return null;
	}
	const activeAttempt = node.attemptHistory?.find((a: any) => a.attemptId === node.activeAttemptId);
	const activeNumber = activeAttempt ? activeAttempt.attemptNumber : "?";
	return {
		refused: true,
		reason: LATE_RESULT_REFUSAL_REASON,
		providedAttemptId,
		providedAttemptStatus: providedAttempt.status,
		activeAttemptId: node.activeAttemptId,
		activeAttemptNumber: activeNumber,
		supersededAt: providedAttempt.supersededAt,
		lateArrivalAt: nowIso,
	};
}

// === Issue 83b — per-node reassign rate-limit gate (exported for testing) ===
// Pure function. Reads `node.supersessionCount` + `node.supersessionWindowStart`. Returns:
//   - null when the gate is open (caller may proceed to mintNodeAttempt)
//   - { refused: true, reason: "rate_limited", ... } when the gate is closed
//
// Fixed-window semantics: simple O(1) per reassign. Window auto-resets when
// (nowMs - supersessionWindowStartMs) > PI_SWARM_REASSIGN_RATE_WINDOW_MS. The caller is
// responsible for stamping the count on a successful reassign (not on a refusal).
export type ReassignRateLimited = {
	refused: true;
	reason: typeof REASSIGN_RATE_LIMITED;
	currentCount: number;
	limit: number;
	windowMs: number;
	windowStart: string;
	windowResetAt: string;
};
export function checkReassignRateLimit(node: TaskNode, nowMs: number, nowIso: string): ReassignRateLimited | null {
	const count = node.supersessionCount ?? 0;
	const windowStart = node.supersessionWindowStart ? new Date(node.supersessionWindowStart).getTime() : 0;
	const windowExpired = windowStart === 0 || nowMs - windowStart > PI_SWARM_REASSIGN_RATE_WINDOW_MS;
	const effectiveCount = windowExpired ? 0 : count;
	if (effectiveCount >= PI_SWARM_REASSIGN_RATE_LIMIT) {
		// Window hasn't expired and count is at/above limit: refuse.
		return {
			refused: true,
			reason: REASSIGN_RATE_LIMITED,
			currentCount: effectiveCount,
			limit: PI_SWARM_REASSIGN_RATE_LIMIT,
			windowMs: PI_SWARM_REASSIGN_RATE_WINDOW_MS,
			windowStart: node.supersessionWindowStart ?? nowIso,
			windowResetAt: new Date(windowStart + PI_SWARM_REASSIGN_RATE_WINDOW_MS).toISOString(),
		};
	}
	return null;
}

// Stamp the per-node supersession counter on a successful mint. Caller (swarm_assign_task) calls
// this RIGHT AFTER `mintNodeAttempt({...})` returns `{ created: true }` (genuine reassign, not
// duplicate retry). On `created: false`, no stamp — duplicate retries are not supersession.
export function stampSupersessionCount(node: TaskNode, nowMs: number, nowIso: string): void {
	const windowStart = node.supersessionWindowStart ? new Date(node.supersessionWindowStart).getTime() : 0;
	const windowExpired = windowStart === 0 || nowMs - windowStart > PI_SWARM_REASSIGN_RATE_WINDOW_MS;
	if (windowExpired) {
		// Open a fresh window with this mint as count=1.
		node.supersessionWindowStart = nowIso;
		node.supersessionCount = 1;
	} else {
		node.supersessionCount = (node.supersessionCount ?? 0) + 1;
	}
}

export async function stampCloseEvidenceIfMissing(
	pi: ExtensionAPI,
	tp: ReturnType<typeof taskPaths>,
	task: TaskState,
	nodeId: string,
	attestationReport?: Awaited<ReturnType<typeof validateAttestations>>,
	diffStat?: Awaited<ReturnType<typeof attachGitDiffStat>>,
	cwd?: string,
) {
	const existing = task.evidence[nodeId];
	if (existing && typeof existing === "object") return existing;
	const node = task.nodes[nodeId];
	if (!node) return undefined;
	let record: Record<string, unknown>;
	if (inferRoleKind(nodeId, node.role) === "root" && isGraphTerminalNode(task, nodeId)) {
		const evidence = await resolveCommitNodeEvidence(pi, tp, cwd);
		record = {
			status: evidence.verified ? "verified" : "unverified",
			reason: evidence.reason,
			baseline: evidence.baseline,
			head: evidence.head,
			at: now(),
			nodeId,
		};
	} else if (diffStat?.available || attestationReport) {
		record = {
			status: attestationReport && !(attestationReport as any).ok ? "unverified" : "verified",
			reason: diffStat?.note || (attestationReport ? "attestation_diffstat" : "terminal_close"),
			baseline: diffStat?.baseline,
			stat: diffStat?.stat,
			at: now(),
			nodeId,
		};
	} else {
		record = { status: "verified", reason: "terminal_close", at: now(), nodeId };
	}
	task.evidence[nodeId] = record;
	return record;
}

/**
 * Issue 83b (round-4) — stamp MessageRecord.lateResultRejectionCount on the inbound assignment.
 * Locates the assignment message record that carried the caller's (now-superseded) attemptId by
 * walking `node.attemptHistory` for the matching attempt's `assignmentMessageId`, then stamps
 * `lateResultRejectionCount` + `lastLateResultRejectionAt` on that record so operators can count
 * late-arrival rejections per message. Distinct from `rec.superseded` (which records the supersede
 * event itself): the counter measures REJECTION EVENTS, not the single supersede stamp.
 * Emits `TRACE_LATE_RESULT_REJECTED` with reason "message_counter_stamped" when stamped.
 * Kept in the facade so the C8 fence literals remain physically in src/tools/tasks.ts.
 */
export async function stampLateResultRejectionOnInboundMessage(
	tp: TaskPaths,
	st: SwarmState,
	node: TaskNode,
	taskId: string,
	nodeId: string,
	attemptId: string | undefined,
): Promise<void> {
	const attempted = node.attemptHistory?.find((a: any) => a.attemptId === attemptId);
	const inboundMsgId = attempted?.assignmentMessageId;
	if (inboundMsgId && st.messages[inboundMsgId]) {
		const inboundMsg = st.messages[inboundMsgId];
		inboundMsg.lateResultRejectionCount = (inboundMsg.lateResultRejectionCount ?? 0) + 1;
		inboundMsg.lastLateResultRejectionAt = now();
		await traceTask(tp, TRACE_LATE_RESULT_REJECTED, {
			taskId,
			nodeId,
			inboundMessageId: inboundMsgId,
			lateResultRejectionCount: inboundMsg.lateResultRejectionCount,
			lastLateResultRejectionAt: inboundMsg.lastLateResultRejectionAt,
			reason: "message_counter_stamped",
		}).catch(() => {});
	}
}
