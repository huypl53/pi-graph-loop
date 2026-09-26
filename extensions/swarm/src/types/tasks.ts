import type { LoopConfig } from "./loops.ts";

export type TaskStatus = "draft" | "ready" | "in_progress" | "blocked" | "reviewing" | "validating" | "done" | "failed" | "cancelled";

// Durable attention classification for a task node (roadmap issue 5). Derived PURELY from
// persisted state (task graph, assignment attempt, mailbox records) — never from tmux/process/
// pane idle state. Advisory only: categories never mutate node status or infer outcome.
export type AttentionCategory =
	| "transport_unavailable"
	| "delivery_failed"
	| "dead_letter"
	| "ack_missing"
	| "response_missing"
	| "stale_assignment"
	| "unassigned_ready"
	| "no_progress"
	| "reminder_eligible"
	| "reminder_sent"
	| "superseded"
	| "cancelled"
	| "terminal"
	| "none";

export type NodeAttention = {
	category: AttentionCategory;
	evidence: string[];
	// True when ALL reminder-eligibility rules hold right now (attempt-fenced, receipt confirmed,
	// no-progress interval elapsed, budget unconsumed). Advisory; sending is a separate explicit step.
	workerReminderEligible: boolean;
	// True when the category requires an explicit root choice (assign/escalate/reassign).
	rootDecision: boolean;
};

export type TaskNodeStatus = "pending" | "ready" | "assigned" | "in_progress" | "blocked" | "done" | "failed" | "skipped" | "cancelled";

export type TaskGateStatus = "open" | "passed" | "failed" | "waived";

// Worker reminder record (reliability roadmap issue 5). Additive: legacy attempts simply lack the
// field, and its presence never changes task semantics — a reminder is informational only.
export type ReminderRecord = {
	reminderId: string;
	sentAt: string;
	messageId: string; // the reminder message sent to the assignee
	attemptId: string; // ties the reminder to one attempt lease
	noProgressSince: string; // anchor timestamp evidence at send time
};

export type TaskNodeAttempt = {
	attemptId: string; // Unique lease identity (UUID), server-generated
	attemptNumber: number; // Monotonic counter (1, 2, 3...)
	assignmentMessageId: string; // Message that carried this assignment
	assignee: string; // Agent who was assigned
	assignedAt: string; // ISO timestamp
	supersededAt?: string; // When this attempt was superseded (if applicable)
	supersededBy?: string; // Attempt ID or "<rework>" that superseded this one
	status: "active" | "superseded" | "completed" | "failed" | "cancelled" | "skipped";
	outcome?: string; // Final outcome if terminal
	lastActivityAt?: string; // Last update timestamp
	// Additive lease-audit fields (file-ownership policy, roadmap issue 4). `status` remains the
	// authoritative lifecycle field; these are optional audit annotations only.
	releasedAt?: string; // When the attempt's write-scope lease ended (any reason)
	releaseReason?: "reassign" | "rework" | "terminal" | "cancel" | "root_override";
	// Bounded worker reminder (roadmap issue 5): at most one per attempt, permanently. Presence of
	// this record means the one-reminder budget for this attempt is consumed; it never mutates node
	// status/outcome/readiness and creates no ack/response debt (the message requiresAck:false and
	// requiresResponse:false by construction).
	reminder?: ReminderRecord;
	// Effective write scope stamped at assignment time; used by the ownership preflight to detect
	// overlapping active write scopes across all tasks. Absent on pre-policy attempts (readable legacy).
	scope?: { source: "node-explicit" | "node-inherited" | "task-default"; sourceNodeId?: string; files: string[] };
};

export type TaskNode = {
	status: TaskNodeStatus;
	outcome?: string | null;
	role: string;
	assignee?: string;
	assigneePolicy?: string;
	dependsOn: string[];
	allowedFiles?: string[];
	allowedFilesFrom?: string;
	readArtifacts?: string[];
	writeArtifacts?: string[];
	messageIds: string[];
	// Canonical current-assignment message id (the single completable assignment for this node).
	assignmentMessageId?: string;
	attempts: number;
	maxAttempts?: number;
	terminal?: boolean;
	lastActivityAt?: string;
	staleAt?: string;
	// NEW: Active attempt identity (set on assignment, cleared on reassign/rework)
	activeAttemptId?: string;
	// NEW: Audit history of all attempts (never cleared, append-only)
	attemptHistory?: TaskNodeAttempt[];
	// === Issue 83a — liveness/progress detection + stale-open surfacing ===
	// ISO timestamp of the most recent forward-progress signal on this node. Stamped by
	// `ensureNodeActivityStamp` from the `tool_execution_end` hook (the worker is making tool
	// calls) and from `tools/tasks.ts:swarm_update_task` (forward state transitions). NOT
	// stamped on `agent_settled` / pure-idle events (those are NOT progress). Consumed by
	// the `staleOpenAssignmentScanLocked` pump-tick phase: a node in `assigned`/`in_progress`
	// past `PI_SWARM_STALE_OPEN_THRESHOLD_MS` (default 5 min) without a `lastProgressAt` is
	// surfaced once per window to the root mailbox. Absent on pre-policy nodes
	// (== never seen progress; the scan treats absent as the oldest possible timestamp).
	lastProgressAt?: string;
	// Last time the root was nudged about this node's stale-open state. Idempotent
	// gate for the pump-tick scan: absent or older than the threshold => surface; otherwise
	// skip (already surfaced within the window). Cleared on `swarm_update_task` forward
	// transitions so progress resets the surface cycle.
	staleOpenSurfacedAt?: string;
	// === Issue 83b — supersession fencing ===
	// Per-node fixed-window supersession counter. Incremented on every fresh mintNodeAttempt
	// (genuine reassign, not duplicate retry). Reset when `supersessionWindowStart` is older
	// than `PI_SWARM_REASSIGN_RATE_WINDOW_MS` ms. Read+written by the per-node rate-limit gate
	// in `swarm_assign_task` (refuses with REASSIGN_RATE_LIMITED when count > PI_SWARM_REASSIGN_RATE_LIMIT).
	supersessionCount?: number;
	// ISO timestamp anchoring the current rate-limit window. Set on first supersession within a
	// window; reset when the window expires (`now - supersessionWindowStart > window`).
	supersessionWindowStart?: string;
	// === R20 — artifact-progress self-nudge bookkeeping ===
	// ISO timestamp of the most recent artifact-progress nudge delivered for this node. Acts as
	// the backoff dedupe gate: subsequent nudges are suppressed until
	// `nowMs - artifactProgressNudgeAt > ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS`. Pendant of
	// `staleOpenSurfacedAt` (root-facing surfacing) but agent-facing (the nudge targets
	// the worker, not the root). Cleared on `swarm_update_task` forward transitions in
	// tools/tasks.ts so a successful close resets the nudge cycle for future node re-opens.
	artifactProgressNudgeAt?: string;
	// Per-node monotonic count of artifact-progress nudges emitted. Reset to 0 on forward
	// transitions (alongside `lastProgressAt`/`staleOpenSurfacedAt`). When this exceeds
	// `ARTIFACT_PROGRESS_NUDGE_CAP` the trigger short-circuits to a one-line root
	// escalation (`worker.artifact_progress_cap_exceeded`) instead of a worker nudge.
	artifactProgressNudgeCount?: number;
	// One-shot flag: true after the cap-exceeded escalation has fired for this cycle. Cleared
	// on forward transitions (same pattern as the other R20 bookkeeping). Prevents repeated
	// escalations within a single stalled cycle (each nudge count past the cap would otherwise
	// re-emit the trace; cap_exceeded is per-cycle, not per-nudge).
	artifactProgressCapSurfaced?: boolean;
};

export type TaskEdge = {
	from: string;
	to: string;
	when: string;
	rework?: boolean;
	parallel?: boolean;
	handoff?: {
		toRole?: string;
		assigneePolicy?: string;
		message?: string;
	};
};

export type ReworkConsumptionRecord = {
	edgeKey: string;
	sourceNodeId: string;
	sourceAttemptId: string;
	reopenedNodeId: string;
	consumedAt: string;
	sourceStatus?: TaskNodeStatus;
	sourceOutcome?: string | null;
};

export type TaskGate = {
	status: TaskGateStatus;
	by?: string | null;
	artifact?: string | null;
};

export type QualificationMode = "auto" | "human-discuss";
export type QualificationStatus = "ready" | "awaiting-confirmation" | "confirmed";

export type QualificationGate = {
	mode: QualificationMode;
	status: QualificationStatus;
	artifact: string;
	preparedAt: string;
	confirmedAt?: string;
	confirmationNote?: string;
};

export type TaskState = {
	version: number;
	taskId: string;
	title: string;
	goal: string;
	status: TaskStatus;
	priority: string;
	createdAt: string;
	updatedAt: string;
	owner: string;
	workflow: string;
	allowedFiles: string[];
	acceptanceCriteria: string[];
	validationCommands: string[];
	start: string;
	currentNodes: string[];
	sharedContext: {
		summary: string;
		decisions: Array<{ id: string; by: string; at: string; text: string }>;
		openQuestions: Array<{ id: string; by: string; at: string; text: string }>;
		risks: Array<{ id: string; by: string; at: string; severity?: string; text: string; status?: string }>;
	};
	nodes: Record<string, TaskNode>;
	edges: TaskEdge[];
	handoffs: Array<Record<string, unknown>>;
	gates: Record<string, TaskGate>;
	editLocks: Record<string, { nodeId: string; by: string; at: string; expiresAt?: string }>;
	evidence: Record<string, unknown>;
	// Present on newly-created tasks. Absent on legacy tasks so historical work remains assignable.
	qualification?: QualificationGate;
	reworkConsumption?: ReworkConsumptionRecord[];
	// V1.5 opt-in post-iteration loop config. Absent or enabled !== true => no behavior change.
	loop?: LoopConfig;
};

export type GraphValidation = { errors: string[]; warnings: string[] };

// Per-node closure summary derived purely from machine state (assignment contract + message ack +
// task state + artifact existence + runtime health). ACK-done is NOT sufficient: a node is closed
// only when its lifecycle status is terminal; ACK-done-without-terminal-node is a surfaced blocker.
export type NodeClosureSummary = {
	nodeId: string;
	role: string;
	assignee: string | null;
	status: TaskNodeStatus;
	closed: boolean;
	verdict: "done" | "failed" | "skipped" | "open";
	blocking: string[];
	assignmentAck: { messageId: string; status: string; acked: boolean; ackStatus: string | null } | null;
	artifacts: Array<{ path: string; exists: boolean }>;
	evidence: string[];
};

export type NodeInput = {
	status?: string;
	role?: string;
	dependsOn?: string[];
	allowedFiles?: string[];
	allowedFilesFrom?: string;
	readArtifacts?: string[];
	writeArtifacts?: string[];
	maxAttempts?: number;
	terminal?: boolean;
	assignee?: string;
	assigneePolicy?: string;
	outcome?: string;
};
