// === swarm/taskgraph.ts — auto-extracted from index.ts (verbatim bodies) ===
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, dirname, relative, sep } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { GraphValidation, NodeClosureSummary, NodeInput, Paths, SwarmState, TaskEdge, TaskGate, TaskGateStatus, TaskNode, TaskNodeStatus, TaskPaths, TaskState, TaskStatus } from "./types.ts";
import { ACK_MISSING_MS, ALLOWED_NODE_TRANSITIONS, DEFAULT_AGENT_HEARTBEAT_STALE_MS, DEFAULT_STALE_OPEN_THRESHOLD_MS, NODE_ICON, NOTIFY_DEFAULT_COOLDOWN_MS, NOTIFY_DEFAULT_MAX_NUDGES, PI_SWARM_KEEP_TASK_WORKERS_OPT_OUT_ENV, PI_SWARM_PROXY_METRIC_INTERVAL_MS, REMINDER_NO_PROGRESS_MS, SAFE_ID_RE, SETTLE_NOTIFY_COOLDOWN_MS, TASK_NUDGE_MS, TASK_STALE_MS, TERMINAL_NODE_STATUSES, TRACE_AGENT_TASK_SWEEP_PARKED, TRACE_AGENT_TASK_SWEEP_STOPPED, TRACE_PROXY_METRIC_EMIT, TRACE_STALE_OPEN_NUDGE_EMITTED, TRACE_STALE_OPEN_SURFACED, TRACE_TASK_ATTEMPT_REOPENED_BY_REWORK, TRACE_TASK_WORKERS_SWEPT } from "./constants.ts";
import type { AttentionCategory, MessageRecord, NodeAttention, ReminderRecord, SwarmAgent } from "./types.ts";
import { ensureAgentDefaults, inferRoleKind, isSafeRelativePath, normalizeTaskNode, now, safeId } from "./utils.ts";
import { paths, readTaskState, taskPaths, trace, traceTask, writeState } from "./state.ts";
import { stopAgent } from "./agents.ts";

// ---- File-scope ownership: effective scope resolution + conservative overlap predicate ----
// (roadmap issue 4: prevent unsafe overlapping concurrent write scopes). Pure task-graph logic:
// no filesystem enumeration, no realpath/glob expansion. task.json stays the only authority.

export type ScopeSource = "node-explicit" | "node-inherited" | "task-default";

export type EffectiveScope = { source: ScopeSource; sourceNodeId?: string; files: string[] } | { unresolved: true; reason: string };

// Resolve a node's effective write scope: node.allowedFiles -> allowedFilesFrom (recursive, same
// task, cycle-safe) -> task.allowedFiles. Unresolved inheritance (missing source node or cycle)
// returns { unresolved } so callers can treat it conservatively (as overlapping) in preflight.
export function resolveNodeScope(task: TaskState, nodeId: string): EffectiveScope {
	const seen = new Set<string>();
	let cur = nodeId;
	let source: ScopeSource | null = null;
	let sourceNodeId: string | undefined;
	for (;;) {
		const node = task.nodes[cur];
		if (!node) return { unresolved: true, reason: `node ${cur} does not exist (inheritance chain from ${nodeId})` };
		if (node.allowedFiles && node.allowedFiles.length) {
			return source === "node-inherited" ? { source, sourceNodeId, files: [...node.allowedFiles] } : { source: "node-explicit", files: [...node.allowedFiles] };
		}
		if (node.allowedFilesFrom) {
			if (seen.has(cur)) return { unresolved: true, reason: `allowedFilesFrom cycle at ${cur} in chain from ${nodeId}` };
			seen.add(cur);
			source = "node-inherited";
			sourceNodeId = node.allowedFilesFrom;
			cur = node.allowedFilesFrom;
			continue;
		}
		return { source: "task-default", files: [...(task.allowedFiles || [])] };
	}
}

// Normalize a project-relative pattern to a segment array under a strict grammar: `/` separators,
// no absolute paths, no `..`, no empty/`.` segments. Wildcard support: a segment that is exactly
// `**` matches zero or more segments; a segment that is exactly `*` matches any single segment;
// `*` inside a segment (e.g. `*.ts`) matches any run of characters within that one segment.
// Other glob metacharacters (? [ ] { } !) are unsupported. Returns null for anything else
// (unknown => the caller must treat the pattern as conservatively overlapping).
export type ScopeSegment = string | { intra: string };
export function normalizeScopePattern(pattern: string): ScopeSegment[] | null {
	if (typeof pattern !== "string" || !pattern.length) return null;
	if (pattern.includes("\\") || pattern.startsWith("/")) return null;
	const segments = pattern.split("/");
	const out: ScopeSegment[] = [];
	for (const seg of segments) {
		if (!seg.length || seg === ".") return null;
		if (seg.includes("..")) return null;
		if (seg !== "**" && /[*?\[\]{}!]/.test(seg)) {
			if (!/^[\w.\-*]+$/.test(seg)) return null; // only simple intra-segment * wildcards
			out.push({ intra: seg });
			continue;
		}
		out.push(seg);
	}
	return out;
}

// Escape an intra-segment wildcard (`*.ts` etc.) into a regex over one segment.
function intraRegex(seg: string) {
	return new RegExp(`^${seg.replace(/[.+^$(){}|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

// Match one pattern segment list against another, both possibly containing wildcards.
// "overlap" iff at least one concrete path can match both. Unknown grammar upstream is handled by
// normalizeScopePattern (null => caller treats as unknown).
function segmentsOverlap(a: ScopeSegment[], i: number, b: ScopeSegment[], j: number): boolean | "unknown" {
	if (i >= a.length && j >= b.length) return true;
	const x = a[i], y = b[j];
	if (i >= a.length || j >= b.length) {
		// one exhausted, the other not: only a trailing ** (zero-or-more, can end early) keeps them overlapping
		if (i >= a.length) { if (y !== "**") return false; return segmentsOverlap(a, i, b, j + 1); }
		if (x !== "**") return false;
		return segmentsOverlap(a, i + 1, b, j);
	}
	if (x === "**" || y === "**") {
		// ** on one side: try consuming 0..n segments on the other side
		const other = x === "**" ? b : a;
		const oi = x === "**" ? j : i;
		for (let k = oi; k <= other.length; k++) {
			const r = x === "**" ? segmentsOverlap(a, i + 1, b, k) : segmentsOverlap(a, k, b, j + 1);
			if (r === true) return true;
			if (r === "unknown") return "unknown";
		}
		return false;
	}
	// intra-segment wildcard on either side (or both): match single-segment patterns.
	const xs = typeof x === "string" ? x : x.intra;
	const ys = typeof y === "string" ? y : y.intra;
	const xWild = typeof x !== "string";
	const yWild = typeof y !== "string";
	if (xWild && yWild) {
		// two single-segment wildcard patterns overlap iff one's literal pattern satisfies the other
		// (e.g. *.ts vs *.js share nothing; *.ts vs a.ts share "a.ts").
		if (intraRegex(xs).test(ys) || intraRegex(ys).test(xs)) return segmentsOverlap(a, i + 1, b, j + 1);
		return false;
	}
	if (xWild) { if (!intraRegex(xs).test(ys)) return false; }
	else if (yWild) { if (!intraRegex(ys).test(xs)) return false; }
	else if (xs !== ys) return false;
	return segmentsOverlap(a, i + 1, b, j + 1);
}

export function scopePatternsOverlap(a: string, b: string): boolean | "unknown" {
	const na = normalizeScopePattern(a);
	const nb = normalizeScopePattern(b);
	if (!na || !nb) return "unknown";
	return segmentsOverlap(na, 0, nb, 0);
}

export type ScopeRelation =
	| { overlap: true; relation: "equal" | "glob-match" | "unknown-syntax" | "unresolved-inheritance" }
	| { overlap: false };

// Overlap between two effective scopes (file lists). Unresolved scope or any unknown-syntax pattern
// conservatively reports overlap so preflight can never pass on ambiguity.
export function scopesOverlap(a: EffectiveScope, b: EffectiveScope): ScopeRelation {
	if ("unresolved" in a) return { overlap: true, relation: "unresolved-inheritance" };
	if ("unresolved" in b) return { overlap: true, relation: "unresolved-inheritance" };
	for (const fa of a.files) {
		for (const fb of b.files) {
			const r = scopePatternsOverlap(fa, fb);
			if (r === true) return { overlap: true, relation: fa === fb ? "equal" : "glob-match" };
			if (r === "unknown") return { overlap: true, relation: "unknown-syntax" };
		}
	}
	return { overlap: false };
}

// Describe an active lease (task/node/attempt) for conflict reporting. Read-only scan over task.json
// files under the swarm lock; never mutates anything and never touches the filesystem beyond readdir+read.
export type ActiveLease = {
	taskId: string;
	nodeId: string;
	assignee: string;
	attemptId: string;
	scope: EffectiveScope;
};

export function collectActiveLeases(task: TaskState): ActiveLease[] {
	const out: ActiveLease[] = [];
	for (const [nodeId, node] of Object.entries(task.nodes)) {
		if (!node.activeAttemptId || !node.attemptHistory) continue;
		// only a genuinely held lease: the active attempt record exists and is status:"active"
		const attempt = node.attemptHistory.find((a: any) => a.attemptId === node.activeAttemptId);
		if (!attempt || attempt.status !== "active") continue;
		const scope = attempt.scope
			? (attempt.scope as EffectiveScope)
			: resolveNodeScope(task, nodeId);
		out.push({ taskId: task.taskId, nodeId, assignee: attempt.assignee, attemptId: attempt.attemptId, scope });
	}
	return out;
}

// ---- Durable attention derivation (reliability roadmap issue 5) ----
// Pure, read-only classification of a task node's recovery condition from persisted state only:
// task.json (node + attempt history) and swarm-state messages/agents. NEVER consults tmux/process/
// pane liveness — pane idleness is not semantic evidence of completion or failure. Advisory only.

const isoMs = (v?: string): number => (v ? new Date(v).getTime() || 0 : 0);

// The no-progress anchor: the MOST RECENT of the durable activity timestamps. The assignedAt floor
// guarantees a value; a reminder fires only when even the freshest evidence is stale.
function reminderAnchorMs(msg: MessageRecord | undefined, node: TaskNode, attempt: any): number {
	return Math.max(
		isoMs(msg?.lastAck?.at),
		isoMs(node.lastActivityAt),
		isoMs(attempt?.lastActivityAt),
		isoMs(attempt?.assignedAt),
	);
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
	if (!node) return { category: "none", evidence: ["node does not exist"], workerReminderEligible: false, orchestratorDecision: false };
	const evidence: string[] = [];

	// 1. Cancellation/terminal guards — no reminder for dead work.
	if (task.status === "cancelled") {
		evidence.push(`task_cancelled: task ${task.taskId}`);
		return { category: "cancelled", evidence, workerReminderEligible: false, orchestratorDecision: false };
	}
	if (node.status === "cancelled") {
		evidence.push(`node_cancelled: node ${nodeId}`);
		return { category: "cancelled", evidence, workerReminderEligible: false, orchestratorDecision: false };
	}
	if (TERMINAL_NODE_STATUSES.has(node.status)) {
		evidence.push(`terminal: node is ${node.status}`);
		return { category: "terminal", evidence, workerReminderEligible: false, orchestratorDecision: false };
	}

	// Attempt + canonical assignment message (persisted sources only).
	const attempt: any = node.activeAttemptId && Array.isArray(node.attemptHistory)
		? node.attemptHistory.find((a: any) => a.attemptId === node.activeAttemptId)
		: undefined;
	const msg: MessageRecord | undefined = node.assignmentMessageId ? st.messages[node.assignmentMessageId] : undefined;

	// 2. Supersession guard: obsolete assignments are never actionable.
	if (msg?.superseded) {
		evidence.push(`superseded: assignment ${msg.id} superseded by ${msg.superseded.supersededBy} at ${msg.superseded.at}`);
		return { category: "superseded", evidence, workerReminderEligible: false, orchestratorDecision: false };
	}
	if (node.activeAttemptId && attempt && attempt.status !== "active") {
		evidence.push(`superseded: attempt ${attempt.attemptId} status is ${attempt.status}`);
		return { category: "superseded", evidence, workerReminderEligible: false, orchestratorDecision: false };
	}

	// 3. Ready-but-unassigned: orchestrator decision to assign.
	if (node.status === "ready" && !node.assignee) {
		evidence.push(`unassigned_ready: node ${nodeId} (${node.role}) is ready with no assignee`);
		return { category: "unassigned_ready", evidence, workerReminderEligible: false, orchestratorDecision: true };
	}

	// 4. Transport problems (advisory display; never completion evidence).
	const agent: SwarmAgent | undefined = node.assignee ? st.agents[node.assignee] : undefined;
	if (msg && msg.status === "dead_letter") {
		evidence.push(`dead_letter: assignment ${msg.id} (${msg.lastError || "unknown"})`);
		return { category: "dead_letter", evidence, workerReminderEligible: false, orchestratorDecision: true };
	}
	if (msg && msg.status === "failed" && !msg.lastAck) {
		evidence.push(`delivery_failed: assignment ${msg.id} (${msg.lastError || "unknown"})`);
		return { category: "delivery_failed", evidence, workerReminderEligible: false, orchestratorDecision: true };
	}
	if (agent && agent.status === "stopped") {
		evidence.push(`transport_unavailable: assignee ${agent.id} is stopped (advisory; not completion evidence)`);
		return { category: "transport_unavailable", evidence, workerReminderEligible: false, orchestratorDecision: true };
	}

	// 5/6. Protocol problems.
	if (msg && msg.requiresAck && !msg.ackedAt && !msg.lastAck) {
		const since = Math.max(isoMs(msg.injectedAt), isoMs(msg.interceptedAt), isoMs(msg.createdAt));
		const age = nowMs - since;
		if (age > ACK_MISSING_MS) {
			evidence.push(`ack_missing: assignment ${msg.id} delivered ${Math.round(age / 60000)}m ago (${msg.status}), no durable ack`);
			return { category: "ack_missing", evidence, workerReminderEligible: false, orchestratorDecision: false };
		}
	}
	// 6. Protocol problem: completion claimed but result unverified (worker acked done/failed without
	// a verified response). An in-flight assignment acked seen/processing is work, not response debt.
	if (msg && msg.requiresResponse && (msg.lastAck?.status === "done" || msg.lastAck?.status === "failed") && !(msg.response?.status === "verified" || msg.response?.status === "waived")) {
		evidence.push(`response_missing: assignment ${msg.id} acked ${msg.lastAck!.status} but response is ${msg.response?.status || "missing"}`);
		return { category: "response_missing", evidence, workerReminderEligible: false, orchestratorDecision: true };
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
				evidence.push(`reminder_sent: ${reminder.messageId} at ${reminder.sentAt} (anchor ${reminder.noProgressSince}); one-per-attempt budget consumed`);
				if (age > TASK_NUDGE_MS) evidence.push(`no_progress: anchor is ${Math.round(age / 60000)}m old (> ${Math.round(TASK_NUDGE_MS / 60000)}m TASK_NUDGE_MS)`);
				return { category: "reminder_sent", evidence, workerReminderEligible: false, orchestratorDecision: age > TASK_STALE_MS };
			}
			if (receipt && age > REMINDER_NO_PROGRESS_MS) {
				evidence.push(`receipt confirmed: lastAck ${msg!.lastAck!.status} at ${msg!.lastAck!.at}`);
				evidence.push(`no_progress: anchor ${Math.round(age / 60000)}m ago (> ${Math.round(REMINDER_NO_PROGRESS_MS / 60000)}m REMINDER_NO_PROGRESS_MS)`);
				return { category: "reminder_eligible", evidence, workerReminderEligible: true, orchestratorDecision: false };
			}
			if (receipt && age > TASK_NUDGE_MS) {
				evidence.push(`no_progress: anchor ${Math.round(age / 60000)}m ago (> ${Math.round(TASK_NUDGE_MS / 60000)}m TASK_NUDGE_MS), receipt confirmed`);
				return { category: "no_progress", evidence, workerReminderEligible: false, orchestratorDecision: false };
			}
			if (!receipt) evidence.push(`receipt not confirmed: assignment ${msg!.id} status=${msg!.status} ackedAt=${msg!.ackedAt || "none"} lastAck=${msg!.lastAck?.status || "none"}`);
			else evidence.push(`receipt confirmed (${msg!.lastAck!.status}), within no-progress window`);
			return { category: "none", evidence, workerReminderEligible: false, orchestratorDecision: false };
		}
		// Legacy/open assignment without attempt metadata: readable, advisory staleness only.
		const nodeAge = nowMs - Math.max(isoMs(node.lastActivityAt), isoMs(node.assignmentMessageId ? msg?.lastAck?.at : undefined), isoMs(attempt?.assignedAt));
		if (nodeAge > TASK_NUDGE_MS) evidence.push(`no_progress: legacy/unfenced assignment, ~${Math.round(nodeAge / 60000)}m since last durable activity (no attempt metadata; reminder requires a fenced attempt)`);
		return { category: nodeAge > TASK_NUDGE_MS ? "no_progress" : "none", evidence, workerReminderEligible: false, orchestratorDecision: false };
	}

	// Blocked/other open states.
	if (node.status === "blocked") {
		evidence.push(`blocked: node is blocked; awaiting dependency or orchestrator decision`);
		return { category: "none", evidence, workerReminderEligible: false, orchestratorDecision: false };
	}
	evidence.push(`pending: node is ${node.status}, waiting on dependencies`);
	return { category: "none", evidence, workerReminderEligible: false, orchestratorDecision: false };
}

// ---- Lifecycle notification fencing (reliability roadmap issue 9) ----
// Two-mode staleness predicates for emit-time fencing of lifecycle notifications:
//   * checkStallNotificationStale: stall/orchestrator-safety-net notifies (sites 1-5, 8, 9)
//   * checkClosureNotificationStale: closure/cancellation notifies (sites 6, 7)
// Both are pure, read-only derivations of stale events from durable state already loaded by the
// emitter (task.json node/attempt + swarm-state messages/agents). No tmux/process inspection, no
// pane idleness inference. Emit-time only — emit iff the predicate returns { stale: false }.
// Predicates short-circuit to { stale: false } when legacy attempt metadata is missing.

export type NotificationStaleness = { stale: boolean; reason: string | null; evidence: string[] };

// checkStallNotificationStale — used by sites that emit STALL or ORCHESTRATOR-SAFETY-NET notifies
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
					evidence.push(`orphaned_attempt_assignee_stopped: ${lastAttempt.assignee} ${prior.status}/${prior.health}, attempt age=${Math.round(age / 1000)}s > grace`);
					return { stale: true, reason: "agent_stopped", evidence };
				}
			}
		}
	}

	// (5) Assignee drift — the "orchestrator" agentId is a placeholder used by watchers that nudge the
	// PM about an UNASSIGNED node (initial-ready, graph-advance); there is no assignee to drift from.
	if (node.assignee !== agentId && agentId !== "orchestrator") {
		evidence.push(`assignee_drift: node assignee=${node.assignee || "(unassigned)"} but notifying agent=${agentId}`);
		return { stale: true, reason: "assignee_drift", evidence };
	}

	// (6) Agent stopped / unhealthy with grace (SETTLE_NOTIFY_COOLDOWN_MS per plan §2 C4).
	// R11-5: NEVER applies to a fresh assignment mint (swarm_assign_task passes freshAssignment) —
	// an agent being `stopped` at assign time is the normal restart-the-pane flow; fencing the
	// brand-new canonical assignment because the OLD canonId is old deadlocks the worker
	// (live incident 2026-09-01 08:25: task.assign.fenced agent_stopped → worker self-assign
	// attempt → ORCHESTRATOR_AUTHORITY_REQUIRED → settled idle with the node open).
	if (opts?.freshAssignment) {
		evidence.push("fresh_assignment: skipping agent-stopped staleness (assign path)");
		return { stale: false, reason: null, evidence };
	}
	const agent = st.agents[agentId];
	if (agent && (agent.status === "stopped" || agent.health === "unhealthy")) {
		const assignmentAge = canonId && st.messages[canonId]?.createdAt
			? nowMs - new Date(st.messages[canonId].createdAt).getTime()
			: Number.POSITIVE_INFINITY;
		if (assignmentAge > SETTLE_NOTIFY_COOLDOWN_MS) {
			evidence.push(`agent_stopped: agent ${agentId} ${agent.status}/${agent.health}, assignment age=${Math.round(assignmentAge / 1000)}s > grace=${SETTLE_NOTIFY_COOLDOWN_MS}ms`);
			return { stale: true, reason: "agent_stopped", evidence };
		} else {
			evidence.push(`agent_stopped_within_grace: assignment age=${Math.round(assignmentAge / 1000)}s < grace=${SETTLE_NOTIFY_COOLDOWN_MS}ms (fresh)`);
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
		evidence.push(`reopened_reassigned: node ${nodeId} status=ready, assignee=${node.assignee} (was ${triggeringAssignee || "unassigned"})`);
		return { stale: true, reason: "reopened_reassigned", evidence };
	}

	return { stale: false, reason: null, evidence };
}

export function buildDefaultGraph(allowedFiles: string[]): { start: string; nodes: Record<string, TaskNode>; edges: TaskEdge[]; gates: Record<string, TaskGate> } {
	return {
		start: "plan",
		nodes: {
			plan: { status: "ready", role: "planner", dependsOn: [], readArtifacts: [], writeArtifacts: ["artifacts/plan.md"], messageIds: [], attempts: 0, maxAttempts: 1 },
			implement: { status: "pending", role: "implementer", dependsOn: ["plan"], allowedFiles, readArtifacts: ["artifacts/plan.md"], writeArtifacts: ["artifacts/implementation-report.md"], messageIds: [], attempts: 0, maxAttempts: 3 },
			test: { status: "pending", role: "tester", dependsOn: ["implement"], readArtifacts: ["artifacts/implementation-report.md"], writeArtifacts: ["artifacts/test-report.md"], messageIds: [], attempts: 0, maxAttempts: 3 },
			fix: { status: "pending", role: "implementer", dependsOn: ["test"], allowedFilesFrom: "implement", readArtifacts: ["artifacts/test-report.md"], writeArtifacts: ["artifacts/fix-report.md"], messageIds: [], attempts: 0, maxAttempts: 3 },
			review: { status: "pending", role: "reviewer", dependsOn: ["test"], readArtifacts: ["artifacts/implementation-report.md", "artifacts/test-report.md"], writeArtifacts: ["artifacts/review.md"], messageIds: [], attempts: 0, maxAttempts: 2 },
			commit: { status: "pending", role: "orchestrator", dependsOn: ["review"], writeArtifacts: ["artifacts/final-summary.md"], messageIds: [], attempts: 0, terminal: true },
		},
		edges: [
			{ from: "plan", to: "implement", when: "planned" },
			{ from: "implement", to: "test", when: "implemented" },
			{ from: "test", to: "review", when: "passed" },
			{ from: "test", to: "fix", when: "failed", rework: true },
			{ from: "fix", to: "test", when: "implemented", rework: true },
			{ from: "review", to: "commit", when: "approved" },
			{ from: "review", to: "fix", when: "rejected", rework: true },
		],
		gates: {
			reviewApproved: { status: "open", by: null, artifact: null },
			testsPassed: { status: "open", by: null, artifact: null },
		},
	};
}

function edgeMatchesActivation(task: TaskState, edge: TaskEdge) {
	const from = task.nodes[edge.from];
	if (!from) return false;
	if (from.outcome !== edge.when) return false;
	if (from.status === "done") return true;
	return Boolean(edge.rework && (from.status === "failed" || from.status === "skipped"));
}

function reworkEdgeKey(edge: TaskEdge) {
	return `${edge.from}=>${edge.to}:${edge.when}:${edge.rework ? 1 : 0}`;
}

function sourceAttemptIdentity(task: TaskState, edge: TaskEdge): { attemptId: string; sourceStatus: TaskNodeStatus; sourceOutcome: string | null | undefined } | null {
	const from = task.nodes[edge.from];
	if (!from) return null;
	const latestAttemptId = from.activeAttemptId || from.attemptHistory?.[from.attemptHistory.length - 1]?.attemptId;
	if (latestAttemptId) {
		return { attemptId: latestAttemptId, sourceStatus: from.status, sourceOutcome: from.outcome };
	}
	return { attemptId: `legacy:${edge.from}:${from.status}:${from.outcome ?? ""}:${from.lastActivityAt ?? ""}`, sourceStatus: from.status, sourceOutcome: from.outcome };
}

function hasConsumedRework(task: TaskState, edge: TaskEdge, sourceAttemptId: string, reopenedNodeId: string) {
	return (task.reworkConsumption || []).some((record) => record.edgeKey === reworkEdgeKey(edge) && record.sourceNodeId === edge.from && record.sourceAttemptId === sourceAttemptId && record.reopenedNodeId === reopenedNodeId);
}

function recordReworkConsumption(task: TaskState, edge: TaskEdge, reopenedNodeId: string, sourceAttemptId: string, sourceStatus: TaskNodeStatus, sourceOutcome: string | null | undefined) {
	task.reworkConsumption ||= [];
	if (hasConsumedRework(task, edge, sourceAttemptId, reopenedNodeId)) return false;
	task.reworkConsumption.push({
		edgeKey: reworkEdgeKey(edge),
		sourceNodeId: edge.from,
		sourceAttemptId,
		reopenedNodeId,
		consumedAt: now(),
		sourceStatus,
		sourceOutcome,
	});
	return true;
}

export function activateReworkNodes(task: TaskState, tp?: TaskPaths) {
	const reopened: string[] = [];
	for (const [sourceNodeId, sourceNode] of Object.entries(task.nodes)) {
		if (!(sourceNode.status === "failed" || sourceNode.status === "skipped" || sourceNode.status === "done")) continue;
		const outgoing = task.edges.filter((edge) => edge.from === sourceNodeId && edge.rework);
		for (const activation of outgoing) {
			if (!edgeMatchesActivation(task, activation)) continue;
			const source = sourceAttemptIdentity(task, activation);
			if (!source) continue;
			const target = task.nodes[activation.to];
			if (!target) continue;
			if (hasConsumedRework(task, activation, source.attemptId, activation.to)) {
				trace(paths(process.cwd()), "task.rework.suppressed", {
					taskId: task.taskId,
					nodeId: activation.to,
					edgeKey: reworkEdgeKey(activation),
					sourceNodeId: activation.from,
					sourceAttemptId: source.attemptId,
					targetStatus: target.status,
					sourceStatus: source.sourceStatus,
					sourceOutcome: source.sourceOutcome ?? null,
				});
				continue;
			}
			if (!(target.status === "pending" || target.status === "failed" || target.status === "skipped" || target.status === "done")) {
				trace(paths(process.cwd()), "task.rework.suppressed", {
					taskId: task.taskId,
					nodeId: activation.to,
					edgeKey: reworkEdgeKey(activation),
					sourceNodeId: activation.from,
					sourceAttemptId: source.attemptId,
					targetStatus: target.status,
					sourceStatus: source.sourceStatus,
					sourceOutcome: source.sourceOutcome ?? null,
					reason: "target_not_reopenable",
				});
				continue;
			}

			const priorActiveAttemptId = target.activeAttemptId;
			const priorAttempt = priorActiveAttemptId && target.attemptHistory
				? target.attemptHistory.find((a: any) => a.attemptId === priorActiveAttemptId)
				: undefined;
			if (priorAttempt && (priorAttempt.status === "active" || priorAttempt.status === "completed" || priorAttempt.status === "failed" || priorAttempt.status === "skipped")) {
				priorAttempt.supersededAt ||= now();
				priorAttempt.supersededBy = "<rework>";
				if (priorAttempt.status === "active") {
					priorAttempt.status = "superseded";
					priorAttempt.outcome = undefined;
					priorAttempt.releasedAt ||= now();
					priorAttempt.releaseReason = "terminal";
				}
			}

			target.status = "ready";
			target.assignee = undefined;
			target.assignmentMessageId = undefined;
			delete target.activeAttemptId;
			target.outcome = null;
			delete target.staleAt;
			target.lastActivityAt = now();

			recordReworkConsumption(task, activation, activation.to, source.attemptId, source.sourceStatus, source.sourceOutcome ?? null);
			reopened.push(activation.to);
			trace(paths(process.cwd()), TRACE_TASK_ATTEMPT_REOPENED_BY_REWORK, {
				taskId: task.taskId,
				nodeId: activation.to,
				priorStatus: priorAttempt ? priorAttempt.status : (priorActiveAttemptId ? "unknown" : "done"),
				priorAttemptId: priorActiveAttemptId ?? null,
				edgeKey: reworkEdgeKey(activation),
				sourceNodeId: activation.from,
				sourceAttemptId: source.attemptId,
			});
		}
	}
	return reopened;
}

// === Issue 29 — force-reopen attempt suppression helper ===
// On orchestrator force-reopen from a terminal state, the prior attempt must be marked superseded
// and `node.activeAttemptId` must be cleared so the next claim/assign mints a fresh attempt.
export function suppressPriorAttemptForForceReopen(node: TaskNode): { priorAttemptId: string | undefined } {
	const priorActiveAttemptId = node.activeAttemptId;
	if (priorActiveAttemptId && node.attemptHistory) {
		const priorAttempt = node.attemptHistory.find((a: any) => a.attemptId === priorActiveAttemptId);
		if (priorAttempt && (priorAttempt.status === "active" || priorAttempt.status === "completed" || priorAttempt.status === "failed" || priorAttempt.status === "skipped")) {
			priorAttempt.status = "superseded";
			priorAttempt.outcome = undefined;
			priorAttempt.supersededAt ||= now();
			priorAttempt.supersededBy = "<force-reopen>";
			priorAttempt.releasedAt ||= now();
			(priorAttempt as any).releaseReason = "force-reopen";
		}
	}
	delete node.activeAttemptId;
	return { priorAttemptId: priorActiveAttemptId };
}

export function computeReadyNodes(task: TaskState) {
	const ready: string[] = [];
	const current = new Set<string>();
	const incoming = new Map<string, TaskEdge[]>();
	for (const edge of task.edges) {
		const arr = incoming.get(edge.to) || [];
		arr.push(edge);
		incoming.set(edge.to, arr);
	}
	for (const [nodeId, node] of Object.entries(task.nodes)) {
		if (node.status === "ready" || node.status === "assigned" || node.status === "in_progress" || node.status === "blocked") current.add(nodeId);
		if (node.status !== "pending") continue;
		const depsOk = (node.dependsOn || []).every((depId) => {
			const dep = task.nodes[depId];
			if (!dep) return false;
			if (dep.status === "done" || dep.status === "skipped") return true;
			return (incoming.get(nodeId) || []).some((edge) => edge.from === depId && edgeMatchesActivation(task, edge));
		});
		if (!depsOk) continue;
		if (nodeId === task.start) {
			ready.push(nodeId);
			current.add(nodeId);
			continue;
		}
		const edges = incoming.get(nodeId) || [];
		// A node whose dependsOn are all satisfied but which has no incoming branch edges is a linear
		// AND-join: ready as soon as dependencies are done/skipped. Nodes WITH branch edges still require
		// a satisfied edge (from done + outcome matches when), so outcome-based branching is preserved.
		if (!edges.length) { ready.push(nodeId); current.add(nodeId); continue; }
		const edgeOk = edges.some((edge) => edgeMatchesActivation(task, edge));
		if (edgeOk) {
			ready.push(nodeId);
			current.add(nodeId);
		}
	}
	return { ready, current: Array.from(current) };
}

export function hasOutgoingTaskEdge(task: TaskState, id: string) {
	return task.edges.some((e) => e.from === id) || Object.values(task.nodes).some((n) => (n.dependsOn || []).includes(id));
}

export function isGraphTerminalNode(task: TaskState, nodeId: string) {
	const node = task.nodes[nodeId];
	return Boolean(node && (node.terminal || !hasOutgoingTaskEdge(task, nodeId)));
}

export function buildTaskMarkdown(task: TaskState) {
	const allowed = task.allowedFiles.length ? task.allowedFiles.map((file) => `- \
\`${file}\``).join("\n") : "- None specified";
	const acceptance = task.acceptanceCriteria.length ? task.acceptanceCriteria.map((item) => `- ${item}`).join("\n") : "- None specified";
	const validation = task.validationCommands.length ? task.validationCommands.map((cmd) => `\`\`\`bash\n${cmd}\n\`\`\``).join("\n\n") : "_None specified._";
	return `# Task: ${task.title}\n\nTask ID: \`${task.taskId}\`\nWorkflow: \`${task.workflow}\`\nOwner: \`${task.owner}\`\n\n## Goal\n\n${task.goal}\n\n## Scope\n\nAllowed files:\n\n${allowed}\n\n## Acceptance Criteria\n\n${acceptance}\n\n## Validation Commands\n\n${validation}\n`;
}

// ---- Task graph validation, printing, and graph synthesis helpers ----

export function graphHasCycle(adj: Map<string, string[]>, nodes: Set<string>): boolean {
	const WHITE = 0, GRAY = 1, BLACK = 2;
	const color = new Map<string, number>();
	for (const n of nodes) color.set(n, WHITE);
	const dfs = (u: string): boolean => {
		color.set(u, GRAY);
		for (const v of adj.get(u) || []) {
			const c = color.get(v) ?? WHITE;
			if (c === GRAY) return true;
			if (c === WHITE && dfs(v)) return true;
		}
		color.set(u, BLACK);
		return false;
	};
	for (const n of nodes) if ((color.get(n) ?? WHITE) === WHITE && dfs(n)) return true;
	return false;
}

export function validateTaskGraph(task: TaskState): GraphValidation {
	const errors: string[] = [];
	const warnings: string[] = [];
	const nodeIds = new Set(Object.keys(task.nodes));

	if (!SAFE_ID_RE.test(task.taskId)) errors.push(`taskId is not a safe id: ${task.taskId}`);
	if (!task.nodes[task.start]) errors.push(`start node does not exist: ${task.start}`);
	for (const id of nodeIds) if (!SAFE_ID_RE.test(id)) errors.push(`node id is not a safe id: ${id}`);

	const incoming = new Map<string, number>();
	for (const edge of task.edges) incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
	for (const [id, node] of Object.entries(task.nodes)) {
		for (const dep of node.dependsOn || []) if (!nodeIds.has(dep)) errors.push(`node ${id} dependsOn missing node: ${dep}`);
		if (id !== task.start && (incoming.get(id) || 0) > 0 && !(node.dependsOn || []).length) errors.push(`node ${id} has incoming edge(s) but no dependsOn; non-root fan-in nodes must declare dependsOn`);
	}
	for (const edge of task.edges) {
		if (!nodeIds.has(edge.from)) errors.push(`edge from missing node: ${edge.from}`);
		if (!nodeIds.has(edge.to)) errors.push(`edge to missing node: ${edge.to}`);
	}

	// reachability from start over edges + dependsOn
	const reachable = new Set<string>(task.nodes[task.start] ? [task.start] : []);
	const queue = [...reachable];
	while (queue.length) {
		const cur = queue.shift()!;
		const next = new Set<string>();
		for (const edge of task.edges) if (edge.from === cur && nodeIds.has(edge.to)) next.add(edge.to);
		for (const [id, node] of Object.entries(task.nodes)) if ((node.dependsOn || []).includes(cur)) next.add(id);
		for (const n of next) if (!reachable.has(n)) { reachable.add(n); queue.push(n); }
	}
	for (const id of nodeIds) if (!reachable.has(id)) warnings.push(`node ${id} is not reachable from start ${task.start}`);

	// A node also has an outgoing connection if another node depends on it (dependsOn is the reverse
	// of the flow edge), so terminal detection stays correct for dependsOn-only custom graphs.
	const hasOutgoing = (id: string) => task.edges.some((e) => e.from === id) || Object.values(task.nodes).some((n) => (n.dependsOn || []).includes(id));
	const terminals = Object.keys(task.nodes).filter((id) => task.nodes[id].terminal || !hasOutgoing(id));
	if (!terminals.some((id) => reachable.has(id))) errors.push("no terminal node is reachable from start");

	// ambiguous branches: two non-parallel edges sharing from+when
	const branchKeys = new Map<string, number>();
	for (const edge of task.edges) {
		if (edge.parallel) continue;
		const key = `${edge.from}::${edge.when}`;
		branchKeys.set(key, (branchKeys.get(key) || 0) + 1);
	}
	for (const [key, count] of branchKeys) if (count > 1) errors.push(`ambiguous branch: ${count} edges share from+when "${key}" without parallel=true`);

	// cycles allowed only when cycle-forming edges are marked rework
	const nonReworkAdj = new Map<string, string[]>();
	for (const edge of task.edges) {
		if (edge.rework) continue;
		const arr = nonReworkAdj.get(edge.from) || [];
		arr.push(edge.to);
		nonReworkAdj.set(edge.from, arr);
	}
	if (graphHasCycle(nonReworkAdj, nodeIds)) errors.push("cycle detected among non-rework edges (mark cycle edges rework=true)");

	// scope/artifact path safety
	const checkPath = (label: string, id: string, value: string) => {
		if (!isSafeRelativePath(value)) errors.push(`${label} for ${id} is unsafe (must be relative, no ..): ${value}`);
	};
	for (const f of task.allowedFiles || []) checkPath("task allowedFiles", task.taskId, f);
	for (const [id, node] of Object.entries(task.nodes)) {
		for (const f of node.allowedFiles || []) checkPath(`node ${id} allowedFiles`, id, f);
		for (const a of [...(node.readArtifacts || []), ...(node.writeArtifacts || [])]) checkPath(`node ${id} artifact`, id, a);
	}

	return { errors, warnings };
}

export function collectDeclaredArtifacts(task: TaskState): string[] {
	const set = new Set<string>();
	for (const node of Object.values(task.nodes)) {
		for (const a of [...(node.readArtifacts || []), ...(node.writeArtifacts || [])]) set.add(a);
	}
	return [...set];
}

export function nodeVerdict(status: TaskNodeStatus): NodeClosureSummary["verdict"] {
	if (status === "done") return "done";
	if (status === "failed") return "failed";
	if (status === "skipped") return "skipped";
	return "open";
}

export function computeNodeClosureSummary(st: SwarmState, task: TaskState, nodeId: string, tp: TaskPaths): NodeClosureSummary {
	const node = task.nodes[nodeId];
	const verdict = nodeVerdict(node.status);
	const blocking: string[] = [];
	const agent = node.assignee ? st.agents[node.assignee] : undefined;
	if (verdict === "open") blocking.push(`status is ${node.status} (not terminal)`);
	if (node.staleAt) blocking.push(`marked stale at ${node.staleAt}`);
	if (agent) {
		ensureAgentDefaults(agent);
		if (agent.status === "stopped" || agent.health === "unhealthy") blocking.push(`assignee ${agent.id} is ${agent.status}/${agent.health}`);
	}
	let assignmentAck: NodeClosureSummary["assignmentAck"] = null;
	// Prefer the canonical (current, non-superseded) assignment message for the ack summary.
	const canonId = node.assignmentMessageId;
	if (canonId) {
		const r = st.messages[canonId];
		if (r && !r.superseded) assignmentAck = { messageId: canonId, status: r.status, acked: Boolean(r.ackedAt), ackStatus: r.lastAck?.status ?? null };
	}
	for (const msgId of node.messageIds || []) {
		const rec = st.messages[msgId];
		if (!rec) { blocking.push(`references missing message ${msgId}`); continue; }
		if (rec.superseded) continue; // superseded assignments are waived; excluded from closure blocking
		if (!assignmentAck) assignmentAck = { messageId: msgId, status: rec.status, acked: Boolean(rec.ackedAt), ackStatus: rec.lastAck?.status ?? null };
		if (rec.status === "dead_letter") blocking.push(`message ${msgId} is dead-lettered (${rec.lastError || "unknown"})`);
		if (rec.requiresAck && !rec.ackedAt) blocking.push(`assignment message ${msgId} not acknowledged`);
		if (rec.lastAck?.status === "done" && verdict === "open") blocking.push(`message ${msgId} acked done but node is still ${node.status}`);
	}
	const artifacts = (node.writeArtifacts || []).map((path) => ({ path, exists: existsSync(join(tp.root, path)) }));
	for (const a of artifacts) if (verdict === "done" && !a.exists) blocking.push(`declared artifact ${a.path} missing`);
	for (const [file, lock] of Object.entries(task.editLocks)) if (lock?.nodeId === nodeId && verdict !== "open") blocking.push(`holds editLock for ${file}`);
	const evidence = [`task.md node "${nodeId}"`, ...artifacts.filter((a) => a.exists).map((a) => a.path)];
	return { nodeId, role: node.role, assignee: node.assignee ?? null, status: node.status, closed: verdict !== "open", verdict, blocking, assignmentAck, artifacts, evidence };
}

// Task-level closure roll-up: machine-state closure + open/stale assignments + blockers. `derived`
// is computeTaskStatus applied fresh so callers see drift between stored and derived status. This is
// the pane-free done-detector: closure is knowable from task.json + swarm state alone.
export function computeTaskClosure(st: SwarmState, task: TaskState, tp: TaskPaths) {
	const nodeClosure = Object.keys(task.nodes).map((id) => computeNodeClosureSummary(st, task, id, tp));
	const openAssignments = nodeClosure.filter((n) => n.assignee && (n.status === "assigned" || n.status === "in_progress")).map((n) => ({ nodeId: n.nodeId, assignee: n.assignee as string, status: n.status }));
	const staleReason = (n: NodeClosureSummary) => n.blocking.find((b) => b.includes("stale") || b.includes("stopped") || b.includes("unhealthy") || b.includes("dead-lettered"));
	const staleAssignments = nodeClosure.filter((n) => n.assignee && staleReason(n)).map((n) => ({ nodeId: n.nodeId, assignee: n.assignee as string, reason: staleReason(n) || "stale" }));
	const derived = computeTaskStatus(task);
	const storedClosed = task.status === "done" || task.status === "failed" || task.status === "cancelled";
	const blocking: string[] = [];
	if (derived !== task.status && task.status !== "cancelled") blocking.push(`stored task.status=${task.status} but nodes derive ${derived}`);
	if (!storedClosed && openAssignments.length === 0 && nodeClosure.some((n) => n.verdict === "open")) blocking.push("task open but no active assignments (stalled)");
	return {
		taskId: task.taskId,
		storedStatus: task.status,
		derivedStatus: derived,
		closed: storedClosed,
		closedNodes: nodeClosure.filter((n) => n.closed).length,
		openNodes: nodeClosure.filter((n) => !n.closed).length,
		staleNodes: staleAssignments.length,
		openAssignments,
		staleAssignments,
		blocking,
		nodeClosure,
	};
}

export function printGraphText(task: TaskState, ready: string[], current: string[], artifactStatus?: Array<{ path: string; exists: boolean }>): string {
	const lines: string[] = [];
	lines.push(`Task: ${task.taskId} — ${task.title}`);
	lines.push(`Status: ${task.status}`);
	lines.push(`Start: ${task.start}`);
	lines.push(`Current: ${current.length ? current.join(", ") : "(none)"}`);
	lines.push("");
	lines.push("Nodes:");
	for (const [id, node] of Object.entries(task.nodes)) {
		const icon = NODE_ICON[node.status] || "?";
		const who = node.assignee || node.role;
		const outcome = node.outcome ? ` outcome=${node.outcome}` : "";
		lines.push(`  ${icon} ${id.padEnd(12)} ${String(who).padEnd(14)}${node.status.padEnd(12)}${outcome.trim()}`);
	}
	lines.push("");
	lines.push("Edges:");
	for (const edge of task.edges) {
		const flag = edge.rework ? " [rework]" : edge.parallel ? " [parallel]" : "";
		lines.push(`  ${edge.from.padEnd(10)} --${edge.when}--> ${edge.to}${flag}`);
	}
	if (artifactStatus && artifactStatus.length) {
		lines.push("");
		lines.push("Artifacts:");
		for (const a of artifactStatus) lines.push(`  ${a.exists ? "✓" : "○"} ${a.path}`);
	}
	const commitEvidence = readCommitEvidence(task);
	if (commitEvidence) {
		lines.push("");
		lines.push(`Commit evidence: ${commitEvidence.status}${commitEvidence.reason ? ` (${commitEvidence.reason})` : ""}${commitEvidence.baseline ? ` baseline=${commitEvidence.baseline}` : ""}${commitEvidence.head ? ` head=${commitEvidence.head}` : ""}${commitEvidence.nodeId && commitEvidence.nodeId !== "commit" ? ` node=${commitEvidence.nodeId}` : ""}`);
	}
	// Row 75 (fix): surface evidence for other commit-like terminal nodes (finalize, ship, ...)
	// using the read-compat legacy `.commit` alias so orchestrators don't have to query the task JSON.
	for (const [nodeId, ev] of Object.entries(task.evidence as Record<string, any> || {})) {
		if (nodeId === "commit") continue;
		if (!ev || typeof ev !== "object") continue;
		lines.push("");
		lines.push(`Commit evidence [${nodeId}]: ${ev.status}${ev.reason ? ` (${ev.reason})` : ""}${ev.baseline ? ` baseline=${ev.baseline}` : ""}${ev.head ? ` head=${ev.head}` : ""}`);
	}
	lines.push("");
	lines.push(`Ready: ${ready.length ? ready.join(", ") : "(none)"}`);
	return lines.join("\n");
}

export function printGraphMermaid(task: TaskState): string {
	const lines: string[] = ["flowchart TD"];
	for (const [id, node] of Object.entries(task.nodes)) {
		const icon = NODE_ICON[node.status] || "?";
		lines.push(`  ${id}["${id} ${icon} ${node.status}"]`);
	}
	lines.push("");
	for (const edge of task.edges) {
		lines.push(`  ${edge.from} -->|${edge.when}| ${edge.to}`);
	}
	return lines.join("\n");
}

export function graphJsonSummary(task: TaskState, ready: string[], current: string[]) {
	return {
		taskId: task.taskId, title: task.title, status: task.status, workflow: task.workflow, owner: task.owner,
		start: task.start, current, ready,
		nodes: Object.entries(task.nodes).map(([id, n]) => ({ id, role: n.role, status: n.status, assignee: n.assignee || null, outcome: n.outcome || null, terminal: Boolean(n.terminal), dependsOn: n.dependsOn })),
		edges: task.edges, gates: task.gates,
	};
}

// ---- Task lifecycle helpers (assign / update / transition) ----

export function isAllowedNodeTransition(from: TaskNodeStatus, to: TaskNodeStatus) {
	if (from === to) return true;
	if (TERMINAL_NODE_STATUSES.has(from)) return false;
	return Boolean(ALLOWED_NODE_TRANSITIONS[from]?.has(to));
}

// Release an agent's active-task pointer and advisory edit locks when a node reaches a terminal-ish
// state (done/failed/blocked/skipped/cancelled). activeTaskIds is task-granular; re-assignment re-adds it.
export function releaseNodeAssignment(st: SwarmState, task: TaskState, nodeId: string) {
	const node = task.nodes[nodeId];
	if (!node || !node.assignee) return;
	const isTerminalish = node.status === "done" || node.status === "failed" || node.status === "blocked" || node.status === "skipped" || node.status === "cancelled";
	if (!isTerminalish) return;
	const agent = st.agents[node.assignee];
	if (agent) {
		ensureAgentDefaults(agent);
		agent.activeTaskIds = agent.activeTaskIds.filter((t) => t !== task.taskId);
	}
	for (const [file, lock] of Object.entries(task.editLocks)) {
		if (lock?.nodeId === nodeId) delete task.editLocks[file];
	}
}

// True iff the task OR the named node is in the orchestrator-explicit cancelled state. Read-only;
// used by `swarm_update_task` and `swarm_send_message` to reject late mutations at the handler
// boundary before any state is touched. `nodeId` is optional; when omitted the task-level check runs.
// A cancelled task remains cancelled forever unless an orchestrator re-opens it (no automatic reopen
// path — re-open requires a deliberate swarm_update_task(force=true) + a separately-designed policy
// not in this PR).
export function isTaskOrNodeCancelled(task: TaskState, nodeId?: string): boolean {
	if (task.status === "cancelled") return true;
	if (!nodeId) return false;
	const node = task.nodes[nodeId];
	return Boolean(node && node.status === "cancelled");
}

// Derive the authoritative task status from node states. Closure is a deterministic consequence of
// the last node transition: failed if any node failed; done iff every graph-terminal node is
// done/skipped (and none failed); blocked if every active node is blocked; in_progress once any node
// has started; ready before that. `cancelled` is orchestrator-explicit and never auto-derived here;
// `cancelled` nodes are skipped from failed/done/blocked aggregations so cancellation does not infer
// semantic completion of the underlying work.
// Precedence matters: failed and done win over blocked (a task with a failed node reads "failed").
export function computeTaskStatus(task: TaskState): TaskStatus {
	const nodes = Object.values(task.nodes).filter((n) => n.status !== "cancelled");
	if (nodes.some((n) => n.status === "failed")) return "failed";
	const terminals = Object.keys(task.nodes).filter((id) => isGraphTerminalNode(task, id) && task.nodes[id].status !== "cancelled").map((id) => task.nodes[id]);
	// R11-2: `done` additionally requires that NO live assignment remains anywhere in the graph.
	// Graph-terminal completion alone is insufficient when a sub-task cycle re-arms an earlier node
	// (rework/reuse): a done terminal set + an assigned/in_progress/ready node must stay in_progress,
	// or the task-close worker sweep force-kills agents mid-assignment (6 kills, 2026-09-01).
	const liveAssignment = nodes.some((n) => n.status === "assigned" || n.status === "in_progress" || n.status === "ready");
	if (terminals.length && !liveAssignment && terminals.every((n) => n.status === "done" || n.status === "skipped")) return "done";
	// Task-level blocked: every active (non-terminal, non-pending) node is blocked => the task cannot
	// make progress. Pure (derived from node states, not the possibly-stale task.currentNodes); resumable
	// (a node leaving `blocked` returns the task to in_progress/done). Cancelled nodes are excluded.
	const active = nodes.filter((n) => n.status === "ready" || n.status === "assigned" || n.status === "in_progress" || n.status === "blocked");
	if (active.length > 0 && active.every((n) => n.status === "blocked")) return "blocked";
	const started = nodes.some((n) => n.status === "assigned" || n.status === "in_progress" || n.status === "blocked" || n.status === "done" || n.status === "failed" || n.status === "skipped");
	return started ? "in_progress" : "ready";
}

// Set task.status from node states unless the orchestrator explicitly cancelled it.
export function applyTaskStatus(task: TaskState): { changed: boolean; terminal: boolean } {
	if (task.status === "cancelled") return { changed: false, terminal: true };
	const prev = task.status;
	task.status = computeTaskStatus(task);
	const terminal = task.status === "done" || task.status === "failed" || task.status === "cancelled";
	return { changed: task.status !== prev, terminal };
}

// === Issue 24.a (B5) — mintNodeAttempt helper ===
// Consolidates the ~50 lines of attempt-mint logic previously inlined in `swarm_assign_task` so the
// new `claim` branch (and any future call site that legitimately hands a node to a worker) can mint
// or reuse attempts with one canonical implementation. The `reason` argument drives the trace
// observability and the duplicate-detection branch.
//
// Return shape:
//   - { attemptId, created: true }  — a fresh attempt was minted; prior active attempt (if any)
//     was superseded.
//   - { attemptId, created: false } — the SAME active-assignment was detected (same assignee +
//     same node + status:active attempt + non-new prevStatus). Existing attemptId is preserved so
//     duplicate assignment calls / delivery retries cannot fence the worker that already holds
//     the active token.
//
// MUST be called from inside the same `withLock(p)` the caller already holds; this helper mutates
// `node` in-place. Callers persist via writeTaskState + writeState (or equivalent) on success.
//
// `isNewAttempt` callers should compute it before calling this helper (the helper inspects
// `node` to decide, but the caller's prevStatus variable may be more up-to-date). The helper
// uses its own prevStatus probe as a defensive fallback.
export function mintNodeAttempt(args: {
	node: TaskNode;
	assignee: string;
	candidateScope: EffectiveScope;
	reason: "assign" | "claim";
}): { attemptId: string; created: boolean } {
	const { node, assignee, candidateScope } = args;
	const prevStatus = node.status;
	// Detect same-active-assignment duplicates: same assignee + same node + active attempt + non-new
	// prevStatus. Mirrors the historical branch from swarm_assign_task so a duplicate retry never
	// mints or supersedes an attempt (preserves the existing attemptId for delivery retries).
	const activeAttemptRecord = node.activeAttemptId
		? node.attemptHistory?.find((a: any) => a.attemptId === node.activeAttemptId)
		: undefined;
	const sameActiveAssignment =
		prevStatus !== "pending" && prevStatus !== "ready" && prevStatus !== "blocked" &&
		node.assignee === assignee &&
		activeAttemptRecord &&
		activeAttemptRecord.status === "active";
	if (sameActiveAssignment) {
		activeAttemptRecord!.lastActivityAt = now();
		return { attemptId: activeAttemptRecord!.attemptId, created: false };
	}
	// Genuine (re)assignment: mint a fresh attempt identity.
	const attemptId = safeId(`attempt-${Date.now().toString(36)}-${randomBytesLike()}`);
	const ts = now();
	// Supersede prior active attempt (if any) before minting the new one.
	if (node.activeAttemptId && node.attemptHistory) {
		const priorAttempt = node.attemptHistory.find((a: any) => a.attemptId === node.activeAttemptId);
		if (priorAttempt && priorAttempt.status === "active") {
			priorAttempt.status = "superseded";
			priorAttempt.supersededAt = ts;
			priorAttempt.supersededBy = attemptId;
			priorAttempt.releasedAt ||= ts;
			priorAttempt.releaseReason = "reassign";
		}
	}
	const newAttempt = {
		attemptId,
		attemptNumber: node.attempts,
		assignmentMessageId: "", // filled by caller after message delivery
		assignee,
		assignedAt: ts,
		status: "active" as const,
		lastActivityAt: ts,
		// Stamp the effective write scope at assignment time so ownership preflight + audits see what
		// this lease actually held. Unresolved inheritance is NOT stamped: absent scope makes later
		// scans re-resolve live (which returns unresolved => conservatively overlapping), never a fake
		// empty scope. Mirrors the canonical swarm_assign_task inline logic.
		...("unresolved" in candidateScope ? {} : { scope: { source: candidateScope.source, sourceNodeId: candidateScope.sourceNodeId, files: candidateScope.files } }),
	};
	node.attemptHistory = [...(node.attemptHistory || []), newAttempt];
	node.activeAttemptId = attemptId;
	return { attemptId, created: true };
}

// Tiny helper: 8 random bytes hex, mirrors `randomBytes(8).toString("hex")` and reuses the
// `node:crypto` import already in scope.
function randomBytesLike(): string {
	return randomBytes(8).toString("hex");
}

// Remove a closed task from every agent's activeTaskIds (terminal bookkeeping cleanup).
export function releaseTaskFromAllAgents(st: SwarmState, taskId: string) {
	for (const a of Object.values(st.agents)) { ensureAgentDefaults(a); a.activeTaskIds = a.activeTaskIds.filter((t) => t !== taskId); }
}

// === Issue 26 — task-close worker sweep (auto-stop task-scoped workers) ===
// Stops every worker agent whose ONLY active assignment was the closing task, leaving the
// orchestrator, agents with other active tasks, paused agents, and `PI_SWARM_KEEP_TASK_WORKERS=1`
// opt-out untouched. Idempotent: a second invocation under the same withLock computes eligibility
// from current state, so a stale sweep finds nothing to do and emits ZERO per-agent traces.
//
// HARD RULES (enforced by the sweep, not by callers):
//   1. MUST run inside the same `withLock(p)` the caller already holds. Never acquire the swarm
//      lock from inside — the mkdir lock is non-reentrant and would deadlock.
//   2. NEVER stops an agent whose `activeTaskIds` includes a task other than the closing one.
//      Release evidence (the prior activeTaskIds) is stamped on the per-agent trace.
//   3. NEVER stops the orchestrator pseudo-agent (id === "orchestrator").
//   4. NEVER stops a paused agent (`agent.paused === true`).
//   5. Honored opt-out: `PI_SWARM_KEEP_TASK_WORKERS=1` short-circuits the whole sweep (no traces).
//   6. `spawnedForTaskId` link: if set to the closing taskId, the agent is swept even when it
//      has zero remaining active tasks (it was FRESHLY SPAWNED for this task). Reuse-pool agents
//      without the link are only swept when their only active task was the closing task.
//
// Stops via the existing `stopAgent` lock-free core (`force: true, killPane: true`). Mailbox,
// identity, history persist via the stable agent id (existing semantics — no record removal).
//
// Returns the list of stopped agent ids so callers can include it in tool output; empty array
// means "no eligible workers" (most common path: cross-task agents / paused / opt-out).
export type SweepOutcome =
	| "opt_out"
	| "no_terminal"
	| { stopped: string[]; skipped: { agentId: string; reason: string }[] };

export async function sweepTaskWorkersLocked(
	pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
	cwd: string,
	st: SwarmState,
	taskId: string,
	freshTask?: TaskState,
): Promise<SweepOutcome> {
	// Opt-out check (first — short-circuit before any state read or trace).
	if (process.env[PI_SWARM_KEEP_TASK_WORKERS_OPT_OUT_ENV] === "1") {
		return "opt_out";
	}
	// Pre-release active-task reconstruction. `releaseTaskFromAllAgents(taskId)` runs BEFORE the
	// sweep at every terminal transition site, so an agent whose only active task was the closing
	// task now shows `activeTaskIds === []`. We rebuild the pre-release set per agent so the
	// eligibility rule + per-agent trace evidence stay accurate. Reconstruction rules:
	//   - cur includes taskId           -> pre-release = cur (release didn't touch them).
	//   - cur empty AND link/assignment -> pre-release = [taskId] (sole-worker closure).
	//   - cur has other tasks, no taskId -> pre-release = [taskId, ...cur] (cross-task agent).
	//   - cur empty AND no link          -> pre-release = [] (never on this task).
	const tp = taskPaths(paths(cwd), taskId);
	let task: TaskState | null = freshTask ?? null;
	// Prefer the caller's in-memory snapshot (terminal close mutates nodes AFTER the last disk
	// write in some paths — R11-2 guard must not read a stale graph). Fall back to disk read.
	if (!task) { try { task = await readTaskState(tp.taskJson); } catch { /* missing/unreadable: skip graph check */ } }
	const assignedInClosingTask = new Set<string>();
	if (task) {
		for (const n of Object.values(task.nodes)) {
			// R11-2: any node CURRENTLY OR FORMERLY assigned (assignee stamp survives closure) —
			// with the fresh in-memory snapshot, terminal nodes are already done at sweep time and
			// the old assigned/in_progress filter would drop the very workers this sweep exists for.
			if (n.assignee && n.assignee !== "orchestrator") {
				assignedInClosingTask.add(n.assignee);
			}
		}
	}
	const priorActiveByAgent = new Map<string, string[]>();
	for (const agent of Object.values(st.agents)) {
		ensureAgentDefaults(agent);
		const cur = agent.activeTaskIds.slice();
		if (cur.includes(taskId)) {
			priorActiveByAgent.set(agent.id, cur);
		} else if (cur.length === 0) {
			const wasInTask = agent.spawnedForTaskId === taskId || assignedInClosingTask.has(agent.id);
			priorActiveByAgent.set(agent.id, wasInTask ? [taskId] : []);
		} else {
			priorActiveByAgent.set(agent.id, [taskId, ...cur]);
		}
	}
	const stopped: string[] = [];
	const skipped: { agentId: string; reason: string }[] = [];
	for (const agent of Object.values(st.agents)) {
		if (agent.id === "orchestrator") { skipped.push({ agentId: agent.id, reason: "orchestrator" }); continue; }
		ensureAgentDefaults(agent);
		if (agent.paused) { skipped.push({ agentId: agent.id, reason: "paused" }); continue; }
		// Already stopped — skip (idempotent re-invocation).
		if (agent.status === "stopped") { skipped.push({ agentId: agent.id, reason: "already_stopped" }); continue; }
		const priorActive = priorActiveByAgent.get(agent.id) || [];
		const remainingAfterClose = priorActive.filter((t) => t !== taskId);
		const wasInClosingTask = priorActive.includes(taskId);
		const spawnedForThis = agent.spawnedForTaskId === taskId;
		// Eligibility:
		//   (A) Freshly spawned for this task AND no remaining other active tasks.
		//   (B) Sole active task was the closing task (sole-active-task closure).
		// Cross-task agents (in closing task + remaining other active tasks) are NEVER swept.
		// Reuse-pool workers not in the closing task are not swept either.
		const eligible = (spawnedForThis || wasInClosingTask) && remainingAfterClose.length === 0;
		if (!eligible) {
			if (wasInClosingTask && remainingAfterClose.length > 0) skipped.push({ agentId: agent.id, reason: "cross_task_active" });
			continue;
		}
		// R11-2 blast-radius guard (belt to the computeTaskStatus suspenders): never stop an
		// agent that still holds a live assignment (assigned/in_progress/ready node) in the
		// closing task's graph, whatever the roll-up derived. Re-armed sub-task cycles depend
		// on this when a stale task.status=done is repaired by a later path (reconcile mark).
		if (task) {
		const stillAssigned = Object.values(task.nodes).some(
				(n) => n.assignee === agent.id && (n.status === "assigned" || n.status === "in_progress"),
			);
			if (stillAssigned) {
				skipped.push({ agentId: agent.id, reason: "live_assignment_in_graph" });
				continue;
			}
		}
		// === Issue 82: lease-aware park-or-stop (precedes stop) ===
		// When the orchestrator stamped an explicit lease on the agent, honor it BEFORE stopping.
		//   - reuse: skip the sweep entirely (worker stays alive for cross-task reuse).
		//   - park:  pause instead of stop (pane preserved for inspection / revival).
		// Both leases auto-expire at `leaseUntil`; an expired lease falls through to default.
		const leaseKind = agent.leaseKind;
		const leaseUntilMs = agent.leaseUntil ? new Date(agent.leaseUntil).getTime() : 0;
		const leaseValid = leaseKind && leaseUntilMs > Date.now();
		if (leaseValid && leaseKind === "reuse") {
			skipped.push({ agentId: agent.id, reason: "lease_reuse" });
			continue;
		}
		if (leaseValid && leaseKind === "park") {
			agent.paused = true;
			agent.leaseReason = agent.leaseReason ?? "sweep honored park lease";
			agent.updatedAt = new Date().toISOString();
			stopped.push(agent.id); // counted as swept (paused) so the summary trace fires
			skipped.push({ agentId: agent.id, reason: "lease_park" });
			await trace(paths(cwd), TRACE_AGENT_TASK_SWEEP_PARKED, {
				agentId: agent.id,
				taskId,
				leaseKind: "park",
				leaseUntil: agent.leaseUntil,
				leaseReason: agent.leaseReason ?? null,
				by: "sweepTaskWorkersLocked",
			});
			continue;
		}
		// Stop via the lock-free core (no nested withLock). force:true so the empty-set check stays
		// authoritative even if activeTaskIds had a stale pointer.
		try {
			const res = await stopAgent(pi, paths(cwd), st, agent.id, { force: true, killPane: true });
			stopped.push(agent.id);
			await trace(paths(cwd), TRACE_AGENT_TASK_SWEEP_STOPPED, {
				agentId: agent.id,
				taskId,
				priorActiveTaskIds: priorActive,
				releaseReason: spawnedForThis ? "spawned_for_task" : "sole_active_task",
				spawnedForTaskId: agent.spawnedForTaskId ?? null,
				leaseKind: leaseKind ?? null,
				leaseValidAtSweep: Boolean(leaseValid),
				killed: res.killed,
				killMethod: res.method,
				agentStatus: agent.status,
				by: "sweepTaskWorkersLocked",
			});
		} catch (err: any) {
			skipped.push({ agentId: agent.id, reason: `stop_failed: ${String((err as Error)?.message || err).slice(0, 80)}` });
		}
	}
	if (stopped.length === 0) {
		return { stopped, skipped };
	}
	// One summary trace per successful close (idempotent: re-run sees stopped=[] and emits zero).
	await trace(paths(cwd), TRACE_TASK_WORKERS_SWEPT, {
		taskId,
		stoppedCount: stopped.length,
		stoppedAgentIds: stopped.slice(),
		skippedCount: skipped.length,
		by: "sweepTaskWorkersLocked",
	});
	return { stopped, skipped };
}


// Find non-terminal assigned/in_progress nodes still owned by an agent across its active tasks.
// Used by session_shutdown to nudge/escalate instead of silently orphaning open assignments.
export async function scanAgentOpenAssignments(p: Paths, st: SwarmState, agentId: string, taskIds: string[]): Promise<Array<{ task: TaskState; tp: TaskPaths; nodeId: string }>> {
	const out: Array<{ task: TaskState; tp: TaskPaths; nodeId: string }> = [];
	for (const rawId of taskIds) {
		const tp = taskPaths(p, safeId(rawId));
		if (!existsSync(tp.taskJson)) continue;
		const task = await readTaskState(tp.taskJson);
		for (const [nodeId, node] of Object.entries(task.nodes)) {
			// skip nodes not owned by this agent
			if (node.assignee !== agentId) continue;
			// skip non-active / terminal nodes
			if (!(node.status === "assigned" || node.status === "in_progress")) continue;
			if (TERMINAL_NODE_STATUSES.has(node.status)) continue;
			// skip non-canonical / superseded assignments: a reassigned node's canonical message now
			// points at another agent (and superseded the old one). Either signal means this agent no
			// longer canonically holds the node, so shutdown/settle must not claim it.
			const canonId = node.assignmentMessageId;
			if (canonId) {
				const rec = st.messages[canonId];
				if (!rec) continue;               // canonical message missing -> do not claim
				if (rec.superseded) continue;     // superseded -> not current
				if (rec.to !== agentId) continue; // canonical belongs to another agent
			}
			out.push({ task, tp, nodeId });
		}
	}
	return out;
}
// === Issue 83a — progress stamp helper (production entry point, called from hooks.ts:tool_execution_end) ===
// Stamps `node.lastProgressAt` when a worker (the assignee) emits a forward-progress signal:
//   - tool_execution_end (the worker is making tool calls)
//   - swarm_update_task forward transitions (in tools/tasks.ts) — not yet wired; see plan-deviations §
// Only stamps when `assignee === workerAgentId` AND status is `assigned` or `in_progress`. Returns
// true when the stamp landed (callers use this for instrumentation: 1 stamp per dirty task).
export function ensureNodeActivityStamp(task: TaskState, nodeId: string, tsIso: string, workerAgentId?: string): boolean {
	const node = task.nodes[nodeId];
	if (!node) return false;
	if (node.status !== "assigned" && node.status !== "in_progress") return false;
	if (workerAgentId && node.assignee !== workerAgentId) return false;
	node.lastProgressAt = tsIso;
	// Reset the stale-open surface cycle: progress cancels any prior surface so the next stale
	// period starts fresh.
	delete node.staleOpenSurfacedAt;
	return true;
}

// === Issue 83a — stale-open assignment scan (pump-tick phase) ===
// Cost bound (R10-1): each scan tick does 1 `readdirSync(p.tasksDir)` + 1 `readTaskState` per
// `task-*` subdirectory under the existing pump `withLock`. ZERO tmux probes, ZERO subprocess
// calls. The bound is the count of task files on disk; for a 100-task graveyard shape that is
// ~100 file reads per ~5 s tick (no interval gate yet; future PI_SWARM_STALE_OPEN_SCAN_INTERVAL_MS
// is a follow-up). The scan is wrapped in `try { ... } catch { ... }` so a single tick failure
// does not crash the pump; errors surface via the standard `trace()` events.
export async function staleOpenAssignmentScanLocked(p: Paths, st: SwarmState, nowMs: number): Promise<{ surfaced: number; inspected: number; alreadySurfaced: number; surfacedNodes: Array<{ taskId: string; nodeId: string; assignee?: string }> }> {
	const thresholdMs = Number(process.env.PI_SWARM_STALE_OPEN_THRESHOLD_MS ?? DEFAULT_STALE_OPEN_THRESHOLD_MS);
	let surfaced = 0, inspected = 0, alreadySurfaced = 0;
	const surfacedNodes: Array<{ taskId: string; nodeId: string; assignee?: string }> = [];
	// Discover tasks via the swarm's tasks dir.
	let taskDirs: string[] = [];
	try {
		const { readdirSync } = await import("node:fs");
		taskDirs = readdirSync(p.tasksDir).filter((d) => d.startsWith("task-"));
	} catch { return { surfaced, inspected, alreadySurfaced, surfacedNodes }; }
	for (const taskDir of taskDirs) {
		const tp = taskPaths(p, taskDir);
		let task: TaskState;
		try {
			task = await readTaskState(tp.taskJson);
		} catch { continue; }
		let dirty = false;
		for (const [nodeId, node] of Object.entries(task.nodes)) {
			if (node.status !== "assigned" && node.status !== "in_progress") continue;
			inspected++;
			const ts = nowMs;
			// `lastProgressAt` absent or older than threshold → candidate.
			// `staleOpenSurfacedAt` present within threshold → already surfaced this window → skip.
			// Plan §(a): stale check is `nowMs - max(lastProgressAt, lastActivityAt) > thresholdMs`.
			// A node with no `lastProgressAt` but recently assigned is NOT stale (the worker just
			// picked it up). The implementer's first pass used `lastProgressAt absent → Infinity`
			// which surfaced every un-progressed node immediately on assignment — defeated the
			// feature. Use max() to anchor on the most-recent activity timestamp.
			const lastProgressMs = node.lastProgressAt ? new Date(node.lastProgressAt).getTime() : 0;
			const lastActivityMs = node.lastActivityAt ? new Date(node.lastActivityAt).getTime() : 0;
			const anchorMs = Math.max(lastProgressMs, lastActivityMs);
			const staleAtMs = anchorMs ? ts - anchorMs : Number.POSITIVE_INFINITY;
			const surfacedMs = node.staleOpenSurfacedAt ? new Date(node.staleOpenSurfacedAt).getTime() : 0;
			if (staleAtMs <= thresholdMs) continue;
			if (surfacedMs && ts - surfacedMs <= thresholdMs) {
				alreadySurfaced++;
				continue;
			}
			const now = new Date(ts).toISOString();
			node.staleOpenSurfacedAt = now;
			dirty = true;
			surfaced++;
			surfacedNodes.push({ taskId: task.taskId, nodeId, assignee: node.assignee || undefined });
			await traceTask(tp, TRACE_STALE_OPEN_SURFACED, {
				taskId: task.taskId,
				nodeId,
				assignee: node.assignee,
				assignedAt: node.lastActivityAt,
				lastProgressAt: node.lastProgressAt ?? null,
				thresholdMs,
				staleMs: staleAtMs === Number.POSITIVE_INFINITY ? null : Math.round(staleAtMs),
			}).catch(() => {});
		}
		if (dirty) {
			const { writeTaskState } = await import("./state.ts");
			await writeTaskState(tp, task).catch(() => {});
		}
	}
	return { surfaced, inspected, alreadySurfaced, surfacedNodes };
}

// === R11-1 completion — stale-open assignment NUDGE (surfacing alone was a radar without a bell) ===
// Called by the pump right after staleOpenAssignmentScanLocked surfaces nodes. Delivers ONE
// high-priority orchestrator nudge per surfaced (task, node), idempotent within the surfacing
// window (the scan's staleOpenSurfacedAt stamp), capped + cooled down like the graph-advance
// nudge. Returns true when a nudge was emitted.
export async function staleOpenNudgeLocked(
	pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
	cwd: string,
	p: Paths,
	st: SwarmState,
	taskId: string,
	nodeId: string,
): Promise<boolean> {
	const { deliverMessageLocked, findIdempotentMessage } = await import("./mailbox.ts");
	const { formatNotifyKey, NOTIFY_KEY_STALE_OPEN } = await import("./constants.ts");
	const keyPrefix = `task:${taskId}:node:${nodeId}:nudge:stale-open:seq:`;
	// Defense-in-depth: only nudge nodes the scan ACTUALLY surfaced (staleOpenSurfacedAt fresh
	// within the threshold window). A direct call for a fresh-progress node is a no-op.
	const tp = taskPaths(paths(cwd), taskId);
	try {
		const t = await readTaskState(tp.taskJson);
		const n = t.nodes[nodeId];
		const thresholdMs = Number(process.env.PI_SWARM_STALE_OPEN_THRESHOLD_MS ?? DEFAULT_STALE_OPEN_THRESHOLD_MS);
		const surfacedMs = n?.staleOpenSurfacedAt ? new Date(n.staleOpenSurfacedAt).getTime() : 0;
		if (!surfacedMs || Date.now() - surfacedMs > thresholdMs) return false;
	} catch { return false; }
	const prior = Object.values(st.messages || {}).filter((r: any) => r.to === "orchestrator" && (r.idempotencyKey?.startsWith(keyPrefix) ?? false));
	if (prior.length >= NOTIFY_DEFAULT_MAX_NUDGES) return false; // cap
	const seq = prior.length + 1;
	const key = formatNotifyKey(NOTIFY_KEY_STALE_OPEN, { taskId, nodeId, seq: String(seq) });
	const lastSent = prior.map((r: any) => r.createdAt || "").sort().pop() || "";
	if (lastSent && Date.now() - new Date(lastSent).getTime() < NOTIFY_DEFAULT_COOLDOWN_MS) return false; // cooldown
	if (findIdempotentMessage(st, "orchestrator", "orchestrator", key) && !prior.some((r: any) => r.ackedAt)) return false; // in-flight
	try {
		await deliverMessageLocked(pi, cwd, p, st, {
			to: "orchestrator",
			priority: "high",
			subject: `STALE OPEN: node ${nodeId} of ${taskId} assigned but no progress — worker may have settled idle`,
			body: `Node \`${nodeId}\` of task ${taskId} is assigned but has shown NO progress past the stale threshold (see trace stale_open_surfaced). The assignee may have settled idle with the node open (idle-lock pattern, 5 live incidents on 2026-09-1).

Act NOW in this turn:
  1. Check the assignee pane (swarm_agent_status) — if idle with the node open, send a high-priority directive naming the exact close action (swarm_update_task to done/failed/blocked + result message).
  2. If the pane is dead, restart the agent with the brief (swarm_restart_agent) — the assignment record persists.
  3. If the node is genuinely long-running (evidence of progress in artifacts), ack this nudge done with a note; it will not re-fire within the window.

(Auto-clears when the node records progress or closes. Capped at ${NOTIFY_DEFAULT_MAX_NUDGES} nudges per node; ${Math.round(NOTIFY_DEFAULT_COOLDOWN_MS / 60000)}min cooldown.)`,
			requiresAck: true,
			idempotencyKey: key,
		});
		await trace(p, TRACE_STALE_OPEN_NUDGE_EMITTED, { taskId, nodeId, seq, cap: NOTIFY_DEFAULT_MAX_NUDGES, cooldownMs: NOTIFY_DEFAULT_COOLDOWN_MS }).catch(() => {});
		return true;
	} catch (err: any) {
		await trace(p, "stale_open.nudge_failed", { taskId, nodeId, seq, error: String((err as Error)?.message || err) }).catch(() => {});
		return false;
	}
}

// === Issue 83c — proxy metric emit (pump-tick phase) ===
// Cheap, read-only snapshot of the stale-open / hung-but-alive / supersession surface.
// The pump calls this AFTER stale-open scanning and BEFORE nudges so the snapshot reflects
// the current tick's repairs. Emission is bounded by PI_SWARM_PROXY_METRIC_INTERVAL_MS and
// is idempotent within the interval: repeated calls only refresh the in-memory snapshot.
export async function proxyMetricEmitLocked(p: Paths, st: SwarmState, nowMs: number): Promise<{ emitted: boolean; reason: string; metrics: { hungButAlive: number; staleOpen: number; supersessionChurn: number; lastEmitAt?: string } }> {
	const intervalMs = Number(process.env.PI_SWARM_PROXY_METRIC_INTERVAL_MS ?? PI_SWARM_PROXY_METRIC_INTERVAL_MS);
	const thresholdMs = Number(process.env.PI_SWARM_STALE_OPEN_THRESHOLD_MS ?? DEFAULT_STALE_OPEN_THRESHOLD_MS);
	const heartbeatStaleMs = DEFAULT_AGENT_HEARTBEAT_STALE_MS;
	const metrics = (st.proxyMetrics ||= { hungButAlive: 0, staleOpen: 0, supersessionChurn: 0 });
	const lastEmitMs = metrics.lastEmitAt ? new Date(metrics.lastEmitAt).getTime() : 0;
	if (lastEmitMs && nowMs - lastEmitMs < intervalMs) {
		return { emitted: false, reason: "interval_pending", metrics: { ...metrics } };
	}
	let staleOpen = 0;
	let supersessionChurn = 0;
	const hungCandidates = new Set<string>();
	if (existsSync(p.tasksDir)) {
		let taskDirs: string[] = [];
		try { taskDirs = await readdir(p.tasksDir); } catch { taskDirs = []; }
		for (const taskDir of taskDirs) {
			const tp = taskPaths(p, taskDir);
			if (!existsSync(tp.taskJson)) continue;
			let task: TaskState;
			try { task = await readTaskState(tp.taskJson); } catch { continue; }
			for (const node of Object.values(task.nodes)) {
				if (!node || (node.status !== "assigned" && node.status !== "in_progress")) continue;
				const lastProgressMs = node.lastProgressAt ? new Date(node.lastProgressAt).getTime() : 0;
				const lastActivityMs = node.lastActivityAt ? new Date(node.lastActivityAt).getTime() : 0;
				const anchorMs = Math.max(lastProgressMs, lastActivityMs);
				const staleAtMs = anchorMs ? nowMs - anchorMs : Number.POSITIVE_INFINITY;
				if (staleAtMs > thresholdMs) {
					staleOpen++;
					if (node.assignee) hungCandidates.add(node.assignee);
				}
				const windowStartMs = node.supersessionWindowStart ? new Date(node.supersessionWindowStart).getTime() : 0;
				if (node.supersessionCount && windowStartMs && nowMs - windowStartMs <= intervalMs) supersessionChurn += node.supersessionCount;
			}
		}
	}
	let hungButAlive = 0;
	for (const agentId of hungCandidates) {
		const agent = st.agents[agentId];
		if (!agent) continue;
		ensureAgentDefaults(agent);
		if (agent.status !== "running" || agent.runtimeStatus !== "idle") continue;
		const hbMs = agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt).getTime() : 0;
		if (!hbMs || nowMs - hbMs > heartbeatStaleMs) continue;
		if ((agent.activeTaskIds?.length ?? 0) === 0) continue;
		hungButAlive++;
	}
	metrics.hungButAlive = hungButAlive;
	metrics.staleOpen = staleOpen;
	metrics.supersessionChurn = supersessionChurn;
	metrics.lastEmitAt = new Date(nowMs).toISOString();
	await trace(p, TRACE_PROXY_METRIC_EMIT, { emitAt: metrics.lastEmitAt, hungButAlive, staleOpen, supersessionChurn, intervalMs, thresholdMs, heartbeatStaleMs }).catch(() => {});
	return { emitted: true, reason: "emitted", metrics: { ...metrics } };
}

// Apply gate updates { gateName: { status, by?, artifact? } }. `by` defaults to the acting agent.
export function applyGateUpdates(task: TaskState, gateUpdates: Record<string, { status: TaskGateStatus; by?: string; artifact?: string | null }>, by: string) {
	const ts = now();
	for (const [name, upd] of Object.entries(gateUpdates)) {
		const prev = task.gates[name] || { status: "open" as TaskGateStatus, by: null as (string | null), artifact: null as (string | null) };
		task.gates[name] = { status: upd.status, by: upd.by || by, artifact: upd.artifact !== undefined ? upd.artifact : prev.artifact };
	}
	return ts;
}

// Append durable shared-context updates (decisions/risks/openQuestions get generated ids + by/at).
export function applySharedContextUpdates(task: TaskState, upd: { summary?: string; decisions?: Array<{ text: string; severity?: string }>; risks?: Array<{ text: string; severity?: string }>; openQuestions?: Array<{ text: string }> }, by: string) {
	const ts = now();
	const ctx = task.sharedContext;
	if (upd.summary) ctx.summary = upd.summary;
	for (const d of upd.decisions || []) ctx.decisions.push({ id: `decision-${randomUUID().slice(0, 8)}`, by, at: ts, text: d.text });
	for (const r of upd.risks || []) ctx.risks.push({ id: `risk-${randomUUID().slice(0, 8)}`, by, at: ts, severity: r.severity, text: r.text, status: "open" });
	for (const q of upd.openQuestions || []) ctx.openQuestions.push({ id: `question-${randomUUID().slice(0, 8)}`, by, at: ts, text: q.text });
}

function taskAbsoluteArtifactPath(taskId: string, artifact: string) {
	if (artifact.startsWith(`.pi/swarm/tasks/${taskId}/`)) return artifact;
	const clean = artifact.replace(/^\/+/, "").replace(/^\.\/?/, "");
	return `.pi/swarm/tasks/${taskId}/${clean}`;
}

function rewriteTaskArtifactRefs(taskId: string, text: string) {
	if (!text) return text;
	// Allow optional leading ./ so references like "./artifacts/x.md" rewrite to the task-absolute
	// path. Without the optional prefix the regex would treat the leading `.` as the boundary
	// character, leaving `./artifacts/...` untouched and letting agents write to project-root
	// artifacts/ by following the note literally.
	return text.replace(/(^|[^A-Za-z0-9._/-])(\.\/)?(artifacts\/[A-Za-z0-9._/-]+)/g, (_m, prefix: string, dotPrefix: string, rel: string) => `${prefix}${dotPrefix || ""}${taskAbsoluteArtifactPath(taskId, rel)}`);
}

export async function resolveCommitNodeEvidence(pi: { exec: (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ code: number; stdout?: string; stderr?: string }> }, tp: TaskPaths) {
	let baseline = "";
	try {
		baseline = readFileSync(join(tp.root, "baseline.txt"), "utf8").trim();
	} catch {
		return { verified: false as const, reason: "baseline_missing" as const };
	}
	if (!baseline) return { verified: false as const, baseline, reason: "baseline_empty" as const };
	try {
		const r = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 5000 });
		if (r.code !== 0) return { verified: false as const, baseline, reason: "git_unavailable" as const, head: (r.stdout || "").trim() || undefined };
		const head = (r.stdout || "").trim();
		if (!head) return { verified: false as const, baseline, reason: "head_empty" as const };
		if (head === baseline) return { verified: false as const, baseline, head, reason: "head_matches_baseline" as const };
		return { verified: true as const, baseline, head };
	} catch (err: any) {
		return { verified: false as const, baseline, reason: `git_error:${String(err?.message || err)}` as const };
	}
}

// Build the assignment message body. Carries task/node pointers, scope, artifacts, and reply target
// so the assignee discovers the rest from durable files instead of a long orchestrator prompt.
export function readCommitEvidence(task: TaskState) {
	const evidence = task.evidence as Record<string, any> | undefined;
	if (!evidence) return undefined;
	for (const [nodeId, node] of Object.entries(task.nodes || {})) {
		if (inferRoleKind(nodeId, node.role) === "orchestrator" && isGraphTerminalNode(task, nodeId)) {
			const ev = evidence[nodeId];
			if (ev && typeof ev === "object") return ev;
		}
	}
	if (evidence.commit && typeof evidence.commit === "object") return evidence.commit;
	return undefined;
}

export async function autoCloseOrchestratorTerminalNodes(pi: { exec: (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ code: number; stdout?: string; stderr?: string }> }, tp: TaskPaths, task: TaskState) {
	const closed: string[] = [];
	for (;;) {
		const { ready } = computeReadyNodes(task);
		const candidate = ready.find((nodeId) => {
			const node = task.nodes[nodeId];
			return node && node.status === "pending" && inferRoleKind(nodeId, node.role) === "orchestrator" && isGraphTerminalNode(task, nodeId);
		});
		if (!candidate) break;
		const node = task.nodes[candidate];
		// Row 75 (fix): gate ANY terminal orchestrator-kind node (role text matching orchestrator
		// OR id prefixed with commit/finalize/ship/etc.) on real git evidence, not just id === "commit".
		// Otherwise custom graphs whose commit-step is named "finalize" / "commit-changes" / "ship"
		// bypass the evidence check and auto-close without verification — the same defect AC4 was
		// meant to kill, resurfacing through the naming door. Evidence is keyed by node id only;
		// the legacy `.commit` surface reads through the per-node key for back-compat.
		const isCommitLike = inferRoleKind(candidate, node.role) === "orchestrator" && isGraphTerminalNode(task, candidate);
		if (isCommitLike) {
			const evidence = await resolveCommitNodeEvidence(pi, tp);
			const record = { status: evidence.verified ? "verified" : "unverified", reason: evidence.reason, baseline: evidence.baseline, head: evidence.head, at: now(), nodeId: candidate };
			task.evidence[candidate] = record;
			if (!evidence.verified) {
				// Leave the node pending for the orchestrator to close deliberately after running git itself.
				break;
			}
		}
		node.assignee ||= "orchestrator";
		node.status = "done";
		node.lastActivityAt = now();
		closed.push(candidate);
	}
	return { closed };
}

export function buildAssignmentBody(task: TaskState, nodeId: string, replyTarget: string, note?: string, attemptId?: string) {
	const node = task.nodes[nodeId];
	const lines: string[] = [];
	lines.push(`You are assigned task ${task.taskId}, node ${nodeId} (${node.role}).`);
	lines.push(`Read .pi/swarm/tasks/${task.taskId}/task.md and .pi/swarm/tasks/${task.taskId}/task.json, plus any prior artifacts below.`);
	lines.push(`Reply to ${replyTarget} when done, blocked, or needing clarification.`);
	const scope = node.allowedFiles && node.allowedFiles.length ? node.allowedFiles.join(", ") : node.allowedFilesFrom ? `(inherit scope from node ${node.allowedFilesFrom})` : "(none specified)";
	lines.push(`Scope: ${scope}`);
	if (node.readArtifacts && node.readArtifacts.length) lines.push(`Read artifacts: ${node.readArtifacts.map((artifact) => taskAbsoluteArtifactPath(task.taskId, artifact)).join(", ")}`);
	if (node.writeArtifacts && node.writeArtifacts.length) lines.push(`Write artifacts: ${node.writeArtifacts.map((artifact) => taskAbsoluteArtifactPath(task.taskId, artifact)).join(", ")}`);
	if (task.acceptanceCriteria.length) lines.push(`Acceptance: ${task.acceptanceCriteria.join("; ")}`);
	// NEW: Include attempt token in assignment contract for fencing
	if (attemptId) lines.push(`Attempt token: ${attemptId}`);
	if (note) {
		const rewritten = rewriteTaskArtifactRefs(task.taskId, note);
		lines.push(rewritten === note ? `Note: ${rewritten}` : `Note (rewritten to task-absolute artifact paths): ${rewritten}`);
	}
	lines.push(`When finished, call swarm_update_task with taskId=${task.taskId}, nodeId=${nodeId}, status=done (or failed/blocked) and an outcome. Ack this assignment message too.`);
	return lines.join("\n");
}

// Throw a structured, machine-readable corrective error and trace it as task.tool.invalid. Always
// called BEFORE any state mutation so invalid calls leave task.json untouched (no partial writes).
export async function failTaskTool(tp: TaskPaths | null, p: Paths, code: string, message: string, details: Record<string, unknown>): Promise<never> {
	const body = JSON.stringify({ ok: false, errorCode: code, message, ...details }, null, 2);
	const traceData = { code, taskId: details.taskId, nodeId: details.nodeId, received: details.received };
	if (tp) await traceTask(tp, "task.tool.invalid", traceData);
	else await trace(p, "task.tool.invalid", traceData);
	const err = new Error(`${code}: ${message}\n${body}`);
	(err as any).errorCode = code;
	// Attach details as enumerable props (minus ok) so callers/tests can read structured fields.
	for (const [k, v] of Object.entries(details)) if (k !== "ok") (err as any)[k] = v;
	throw err;
}

export function buildGraphFromInput(input: { nodes?: Record<string, NodeInput>; edges?: Array<{ from: string; to: string; when?: string; rework?: boolean; parallel?: boolean }>; start?: string; gates?: Record<string, TaskGate> }, allowedFiles: string[]): { start: string; nodes: Record<string, TaskNode>; edges: TaskEdge[]; gates: Record<string, TaskGate> } {
	if (!input.nodes || !Object.keys(input.nodes).length) return buildDefaultGraph(allowedFiles);
	const nodes: Record<string, TaskNode> = {};
	for (const [rawId, raw] of Object.entries(input.nodes)) {
		const id = safeId(rawId);
		nodes[id] = normalizeTaskNode({
			status: (raw.status as TaskNodeStatus) || "pending",
			role: raw.role || "worker",
			dependsOn: (raw.dependsOn || []).map(safeId),
			allowedFiles: raw.allowedFiles,
			allowedFilesFrom: raw.allowedFilesFrom,
			readArtifacts: raw.readArtifacts || [],
			writeArtifacts: raw.writeArtifacts || [],
			messageIds: [],
			attempts: 0,
			maxAttempts: raw.maxAttempts,
			terminal: raw.terminal,
			assignee: raw.assignee,
			assigneePolicy: raw.assigneePolicy,
			outcome: raw.outcome ?? null,
		});
	}
	const start = input.start ? safeId(input.start) : Object.keys(nodes)[0];
	if (nodes[start] && nodes[start].status === "pending") nodes[start].status = "ready";
	// Edges are taken verbatim from input when provided. We intentionally do NOT synthesize edges
	// from dependsOn: computeReadyNodes treats a dependsOn-satisfied node with no incoming branch
	// edges as a linear AND-join (ready when deps are done), while explicit edges drive outcome-based
	// branching. Synthesizing when:"done" edges here would force every custom graph to require an
	// outcome:"done" on each dependency, which is only set by swarm_update_task in a later commit.
	const edges: TaskEdge[] = (input.edges || []).map((e) => ({ from: safeId(e.from), to: safeId(e.to), when: e.when || "done", rework: e.rework, parallel: e.parallel }));
	const gates = input.gates || {};
	return { start, nodes, edges, gates };
}
