// === swarm/taskgraph.ts — auto-extracted from index.ts (verbatim bodies) ===
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { GraphValidation, NodeClosureSummary, NodeInput, Paths, SwarmState, TaskEdge, TaskGate, TaskGateStatus, TaskNode, TaskNodeStatus, TaskPaths, TaskState, TaskStatus } from "./types.ts";
import { ACK_MISSING_MS, ALLOWED_NODE_TRANSITIONS, NODE_ICON, REMINDER_NO_PROGRESS_MS, SAFE_ID_RE, SETTLE_NOTIFY_COOLDOWN_MS, TASK_NUDGE_MS, TASK_STALE_MS, TERMINAL_NODE_STATUSES } from "./constants.ts";
import type { AttentionCategory, MessageRecord, NodeAttention, ReminderRecord, SwarmAgent } from "./types.ts";
import { ensureAgentDefaults, inferRoleKind, isSafeRelativePath, normalizeTaskNode, now, safeId } from "./utils.ts";
import { readTaskState, taskPaths, trace, traceTask } from "./state.ts";

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
	}

	// (5) Assignee drift
	if (node.assignee !== agentId) {
		evidence.push(`assignee_drift: node assignee=${node.assignee || "(unassigned)"} but notifying agent=${agentId}`);
		return { stale: true, reason: "assignee_drift", evidence };
	}

	// (6) Agent stopped / unhealthy with grace (SETTLE_NOTIFY_COOLDOWN_MS per plan §2 C4).
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

export function activateReworkNodes(task: TaskState) {
	const reopened: string[] = [];
	for (const [nodeId, node] of Object.entries(task.nodes)) {
		if (!(node.status === "failed" || node.status === "skipped")) continue;
		const incoming = task.edges.filter((edge) => edge.to === nodeId);
		if (!incoming.some((edge) => edge.rework && edgeMatchesActivation(task, edge))) continue;
		node.status = "ready";
		node.assignee = undefined;
		node.assignmentMessageId = undefined;
		// NEW: Clear activeAttemptId but preserve attemptHistory for audit trail
		if (node.activeAttemptId && node.attemptHistory) {
			const priorAttempt = node.attemptHistory.find((a: any) => a.attemptId === node.activeAttemptId);
			if (priorAttempt) {
				if (priorAttempt.status === "active") {
					priorAttempt.status = "superseded";
					priorAttempt.outcome = undefined;
				}
			// Audit annotation: record that the rework reopen ended this attempt's lease. The terminal
				// status (failed/skipped/completed) is preserved; supersededBy marks how the lease ended.
				priorAttempt.supersededAt ||= now();
				priorAttempt.supersededBy = "<rework>";
				// Lease release audit (issue 4): a rework reopen releases the reopened node's write-scope lease.
				priorAttempt.releasedAt ||= now();
				priorAttempt.releaseReason = "rework";
			}
		}
		delete node.activeAttemptId;
		node.outcome = null;
		delete node.staleAt;
		node.lastActivityAt = now();
		reopened.push(nodeId);
	}
	return reopened;
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

	for (const [id, node] of Object.entries(task.nodes)) {
		for (const dep of node.dependsOn || []) if (!nodeIds.has(dep)) errors.push(`node ${id} dependsOn missing node: ${dep}`);
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
	if (terminals.length && terminals.every((n) => n.status === "done" || n.status === "skipped")) return "done";
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

// Remove a closed task from every agent's activeTaskIds (terminal bookkeeping cleanup).
export function releaseTaskFromAllAgents(st: SwarmState, taskId: string) {
	for (const a of Object.values(st.agents)) { ensureAgentDefaults(a); a.activeTaskIds = a.activeTaskIds.filter((t) => t !== taskId); }
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

// Build the assignment message body. Carries task/node pointers, scope, artifacts, and reply target
// so the assignee discovers the rest from durable files instead of a long orchestrator prompt.
export function autoCloseOrchestratorTerminalNodes(task: TaskState) {
	const closed: string[] = [];
	for (;;) {
		const { ready } = computeReadyNodes(task);
		const candidate = ready.find((nodeId) => {
			const node = task.nodes[nodeId];
			return node && node.status === "pending" && inferRoleKind(nodeId, node.role) === "orchestrator" && isGraphTerminalNode(task, nodeId);
		});
		if (!candidate) break;
		const node = task.nodes[candidate];
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
	if (node.readArtifacts && node.readArtifacts.length) lines.push(`Read artifacts: ${node.readArtifacts.join(", ")}`);
	if (node.writeArtifacts && node.writeArtifacts.length) lines.push(`Write artifacts: ${node.writeArtifacts.join(", ")}`);
	if (task.acceptanceCriteria.length) lines.push(`Acceptance: ${task.acceptanceCriteria.join("; ")}`);
	// NEW: Include attempt token in assignment contract for fencing
	if (attemptId) lines.push(`Attempt token: ${attemptId}`);
	if (note) lines.push(`Note: ${note}`);
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
