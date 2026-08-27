// === swarm/types.ts — auto-extracted from index.ts (verbatim bodies) ===
import { reconcile } from "./reconcile.ts";
import { tmux } from "./tmux.ts";
import { writeEffectiveIdentity } from "./identity.ts";

export type AgentStatus = "running" | "stopped" | "unknown";

export type RuntimeStatus = "starting" | "idle" | "busy" | "tool_running" | "response_missing" | "shutting_down" | "stopped";

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export type MessageStatus = "queued" | "mailbox_delivered" | "injected" | "intercepted" | "acked" | "failed" | "dead_letter";

export type MessageResponseStatus = "not_required" | "missing" | "sent" | "verified" | "waived";

export type SwarmSettings = {
	defaultModel?: string;
	defaultProvider?: string;
	// Model pool: multiple model/provider candidates with weights and rotation. When present,
	// spawn/restart pick from the pool (respecting health/cooldown) instead of the single default.
	modelPool?: ModelSlot[];
	rotation?: RotationConfig;
};

export type ModelSlot = {
	model: string;
	provider?: string;
	weight?: number; // default 1; 0 = fallback-only (used only when all weighted slots are down)
	label?: string;
};

export type RotationStrategy = "weighted" | "round-robin" | "sticky";

// Classify a provider/turn error message. Quota/auth failures are the rotation triggers;
// transient errors are tolerated a few times before benching.
export type ProviderErrorKind = "quota" | "auth" | "rate_limit" | "transient" | "unknown";

export function classifyProviderError(message: string): ProviderErrorKind {
	const m = (message || "").toLowerCase();
	if (/quota|insufficient|billing|balance|exceeded your current quota|prepaid/.test(m)) return "quota";
	if (/rate.?limit|too many requests|429|overloaded/.test(m)) return "rate_limit";
	if (/invalid api key|unauthorized|forbidden|401|403|authentication|api key/.test(m)) return "auth";
	if (/timeout|timed out|econnrefused|econnreset|enotfound|5\d\d|network|connection/.test(m)) return "transient";
	return "unknown";
}

export type RotationConfig = {
	strategy?: RotationStrategy; // default weighted
	cooldownMs?: number; // default 15min: a failing slot is benched this long after maxRetries
	maxRetries?: number; // default 2 consecutive failures before cooldown
};

// Preflight classification — used by `preflightSpawn` and surfaced verbatim by spawn/restart
// callers. Each `kind` carries enough context for `formatPreflightError` to render a concrete
// corrective action. New variants must be added in lock-step with the formatter switch in pool.ts.
export type PreflightError =
	| { kind: "unknown_model"; model: string; suggestion: string }
	| { kind: "provider_not_found"; provider: string; suggestion: string }
	| { kind: "pool_exhausted"; message: string; suggestion: string }
	| { kind: "tmux_not_running"; message: string; suggestion: string }
	| { kind: "tmux_create_failed"; message: string; suggestion: string }
	| { kind: "invalid_settings"; message: string; suggestion: string; errors: string[] };

export type PreflightResult =
	| { ok: true; resolved: { model: string; provider: string; fromPool: boolean } }
	| { ok: false; error: PreflightError };

// Persisted per-slot health, keyed by `${provider}/${model}`. Stored in .pi/swarm/pool-state.json.
export type PoolSlotHealth = {
	failures: number;
	lastError?: string;
	lastErrorAt?: string;
	// True when the recorded error was deduplicated (pi-internal retry of the same incident within
	// 30s did not bump the streak). Informational only.
	deduped?: boolean;
	cooldownUntil?: string; // ISO; slot excluded from picking while in the future
	benchStreak?: number; // consecutive benches without an intervening success (drives exponential backoff)
};

export type PoolHealthState = {
	slots: Record<string, PoolSlotHealth>;
	// round-robin cursor (index into the configured slot list)
	rrCursor?: number;
};

// Per-agent engine-retry observation (Issue 17 model-pool-respect-pi-retries). The pi engine
// retries a failed provider request up to retry.maxRetries (default 3) times before giving up.
// The extension cannot subscribe to engine retry events directly (`auto_retry_*` is not in the
// extension event allowlist — see agent-session.js:_emitExtensionEvent). Instead we count
// consecutive `turn_end { stopReason: "error" }` events on the SAME providerKey + errorMessage
// within ENGINE_RETRY_WINDOW_MS; when the count reaches ENGINE_MAX_RETRIES (or the burst ages out),
// we conclude the engine has exhausted retries on this slot and gate the swap path on that signal.
// In-process only — never persisted. See pool-retry.test.mjs for fixture coverage.
export type EngineRetryIncident = {
	providerKey: string;    // `${provider}/${model}` of the slot being retried by the engine
	errorMessage: string;   // normalized (slice 0..200) for comparison
	firstSeenAt: number;    // ms epoch — first turn_end {error} for this incident
	lastSeenAt: number;     // ms epoch — most recent turn_end {error} for this incident
	count: number;          // number of consecutive turn_end {error} events in this incident
};

export type MessageRecord = {
	id: string;
	from: string;
	to: string;
	status: MessageStatus;
	createdAt: string;
	updatedAt: string;
	queuedAt?: string;
	injectedAt?: string;
	interceptedAt?: string;
	ackedAt?: string;
	surfacedAt?: string;
	failedAt?: string;
	ackMissingAt?: string;
	// Bounded re-injection of delivered-but-unacked messages (issue A): count of re-injections since
	// the original delivery, capped by MAX_REINJECTS so an unresponsive-but-alive agent is not spammed.
	reinjects?: number;
	lastReinjectAt?: string;
	attempts: number;
	requiresAck: boolean;
	requiresResponse?: boolean;
	response?: {
		status: MessageResponseStatus;
		resultMessageId?: string;
		missingAt?: string;
		sentAt?: string;
		verifiedAt?: string;
		waivedAt?: string;
		waivedBy?: string;
		lastError?: string;
	};
	conversationId?: string;
	replyTo?: string;
	lastError?: string;
	lastAck?: { by: string; status: string; note?: string; resultMessageId?: string; at: string };
	subject?: string;
	ttlMs?: number;
	idempotencyKey?: string;
	// Set when a newer assignment supersedes this open assignment message (idempotency/supersede fix).
	superseded?: { at: string; by: string; supersededBy: string };
};

export type SwarmAgent = {
	id: string;
	role: string;
	roleKind: string;
	roleKindExplicit?: boolean;
	capabilities: string[];
	activeTaskIds: string[];
	maxConcurrentTasks: number;
	status: AgentStatus;
	runtimeStatus: RuntimeStatus;
	health: HealthStatus;
	lastHeartbeatAt?: string;
	lastSessionStartAt?: string;
	lastAgentStartAt?: string;
	lastAgentSettledAt?: string;
	lastSettleNotifyAt?: string; // persisted cooldown for agent_settled->orchestrator idle/open-work notify
	lastToolAt?: string;
	lastShutdownAt?: string;
	pid?: number;
	// Park/drain flag: a paused agent is skipped by the reuse pool (findReusableAgent) but is NOT killed
	// and still appears in status/list. Cleared by resume (delete) so absent == not paused.
	paused?: boolean;
	tmuxSession: string;
	tmuxWindow: string;
	tmuxTarget: string;
	model: string;
	provider: string;
	cwd: string;
	mailbox: string;
	// Identity provenance (additive, optional). Stamped whenever the EFFECTIVE identity file is
	// (re)generated by writeEffectiveIdentity (spawn / swarm_agent_identity refresh / swarm_reload_identity).
	identityVersion?: number;       // monotonically bumps when the effective content (base+override) changes
	identityHash?: string;          // sha256 hex of the effective content (base + override body)
	identityLoadedAt?: string;      // ISO timestamp of the last effective-identity write
	createdAt: string;
	updatedAt: string;
};

// Multi-orchestrator policy (roadmap issue 8, strict-reject): a single durable leader record on
// SwarmState identifies the live orchestrator. Every orchestrator-authoritative mutation must
// refresh lastHeartbeatAt via heartbeatOrchestratorLeader; a second concurrent orchestrator is
// rejected with ORCHESTRATOR_LEADER_DENIED. Absent or stale = vacant.
export type OrchestratorLeader = {
	pid: number;
	sessionStartedAt: string;
	claimedAt: string;
	lastHeartbeatAt: string;
	agentRecordId?: string;
};

// Durable recipient receipt entry for the orchestrator mailbox consumer (issue 11). Populated
// when a TUI-side delivery succeeds (surfacedAt stamped) OR by the one-time migration back-fill
// for legacy `requiresAck: true` messages that are no longer actionable. Per-message fingerprint
// (sha256(messageId + lastUpdatedAt)) protects a reincarnated consumer against silent message
// record edits. Primary dedupe gate for the orchestrator pump across PID recycle / restart.
// conversationId stores the raw "task:taskId:nodeId" reference for later parsing.
export type OrchestratorReceiptEntry = {
	surfacedAt: string;
	ackedAt?: string;
	requiresAck: boolean;
	conversationId?: string;
	fingerprint: string;
};

// Durable goal the orchestrator wants the swarm to advance toward (Issue 18). Set via
// `swarm_set_goal` / `/swarm goal set <text>`; cleared via `swarm_mark_goal_done` / `/swarm goal done`.
// While set and ALL non-orchestrator agents are runtimeStatus="idle" with zero active task nodes,
// the orchestrator pump emits an idempotent idle-streak nudge (anti-loop: at most
// MAX_CONSECUTIVE_NUDGES_DEFAULT consecutive, then a GOAL_NUDGE_BACKOFF_TICKS-tick back-off). Any
// orchestrator turn that ends stopReason="stop" resets the consecutiveNoResolveNudges counter and
// clears back-off (turn_end branch in hooks.ts).
export type SwarmGoal = {
	id: string;                         // stable goalId (e.g. "goal-<ms>-<rand6>")
	text: string;                       // the goal text the orchestrator set
	setAt: string;                      // ISO; durable on set
	setBy: string;                      // agentId that set it (orchestrator in practice; recorded for audit)
	consecutiveNoResolveNudges: number; // monotonic; reset on orchestrator turn_end {stop} resolve
	lastNudgeAt?: string;               // ISO; set on every successful nudge emission
	lastResolvedAt?: string;            // ISO; set on every successful counter reset
	backoffTicksRemaining?: number;     // 0..GOAL_NUDGE_BACKOFF_TICKS; when >0 the pump skips the next tick(s)
};

// In-flight orphan-spawn watchdog entry (Issue 14). Pushed when swarm_spawn_agent mints a NEW agent
// record (not restart/register/pool-reuse) and removed when the engine either (a) detects a follow-up
// delivery within the ORPHAN_SPAWN_WARNING_TIMEOUT_MS window or (b) the timer fires and emits
// `agent.spawn.orphan_warning` (or `orphan_resolved_late`). Persisted on SwarmState so process
// restart can audit stranded entries; the in-process timer handle lives on a module-level Map
// (NOT on this record) because NodeJS.Timeout is not JSON-serializable.
export type RecentSpawn = {
	agentId: string;
	spawnedAt: string;     // ISO; mirrors agent.createdAt for the just-created record
	deadlineAt: string;    // ISO; spawnedAt + ORPHAN_SPAWN_WARNING_TIMEOUT_MS
	// Issue 16: identity of the spawning orchestrator session, stamped unconditionally at
	// armOrphanWatch time. The pre-clear predicate in swarm_assign_task compares these against
	// process.pid + process.env.PI_SWARM_SESSION_STARTED_AT at compare time. Both fields are
	// optional only for backward-compat reads of legacy state (no production code path leaves
	// them undefined for entries armed after this change).
	spawnedByPid?: number;
	spawnedBySessionStartedAt?: string;
};

export type SwarmState = {
	version: number;
	swarmId: string;
	cwd: string;
	tmuxSession: string;
	agents: Record<string, SwarmAgent>;
	delivered: Record<string, string[]>;
	// Multi-orchestrator leader lease (issue 8). Addditive; readState back-fills undefined for
	// pre-policy swarms so first mutation claims vacant. See identity.ts:readOrchestratorLeader /
	// heartbeatOrchestratorLeader / claimOrchestratorLeader for the gate semantics.
	orchestratorLeader?: OrchestratorLeader;
	// Per-session surfaced-id ledgers for the orchestrator auto-pump, keyed by consumer pid. Each
	// orchestrator-context session (the long-lived PM, a validation `pi -p` run, another PM lane) tracks
	// the ids IT has surfaced, so one session cannot mark a notification consumed and starve a different
	// PM session. Separate from `delivered` (the check_mailbox/ack ledger).
	orchestratorPumpSessions?: Record<string, { ids: string[]; triggeredAt?: Record<string, string>; retriggerCount?: Record<string, number>; lastAt: string }>;
	// Per-worker surfaced ledger for the session-start mailbox auto-surface (idempotent per message).
	agentSurfaced?: Record<string, string[]>;
	// Durable recipient receipt ledger for the orchestrator mailbox consumer (issue 11). Primary
	// dedupe gate that survives PID restart/recycle; replaces the per-pid `orchestratorPumpSessions[*].ids`
	// (which is now session-bounded and only counts retriggers). `revision` bumps on every write so a
	// stale read can detect concurrent consumer activity; `0` = no writes yet (triggers one-time
	// migration back-fill on first pump).
	consumerReceipts?: {
		orchestrator?: {
			entries?: Record<string, OrchestratorReceiptEntry>;
			revision?: number;
		};
	};
	lastLoopReconcileAt?: string; // throttle for the loop-watcher reconcile (detect "plan recorded but graph still closed")
	// Incremental mailbox read checkpoint for the orchestrator pump (issue B): byte offset already
	// parsed per agent. Reset (full re-read) if the file shrank. Absent = no checkpoint yet.
	mailboxReadOffset?: Record<string, number>;
	// Lazily-built index: `${from}\u0000${to}\u0000${idempotencyKey}` -> messageId (issue C). Rebuilt
	// when the message count changes; consulted for O(1) idempotency lookups inside the lock.
	idempotencyIndex?: Record<string, string>;
	idempotencyIndexCount?: number; // messages.length when the index was built
	// Orphan-spawn watchdog ledger (Issue 14): one entry per freshly-spawned agent awaiting a
	// follow-up delivery. Cleared on a follow-up delivery, by swarm_stop_agent, or by the watchdog
	// itself when the timer fires. ReadState back-fills `[]` so pre-policy swarms boot cleanly.
	recentSpawns?: RecentSpawn[];
	// Durable swarm goal (Issue 18): set by the orchestrator via swarm_set_goal / /swarm goal set;
	// cleared by swarm_mark_goal_done / /swarm goal done. While set + all non-orchestrator agents
	// idle + no active task nodes, the orchestrator pump emits an idempotent idle-streak nudge with
	// an anti-loop counter and 2-tick back-off. Optional; absent (== no goal) is the default. The
	// readState back-fill intentionally leaves this field as-is on legacy swarms: a JSON file with
	// no `goal` key parses to `undefined`, which is the correct initial state — a future maintainer
	// MUST NOT add `st.goal ||= {}` here, since that would replace undefined with an empty object
	// and crash `goal.id` access in the pump.
	goal?: SwarmGoal;
	messages: Record<string, MessageRecord>;
	createdAt: string;
	updatedAt: string;
};

export type SwarmMessage = {
	id: string;
	swarmId: string;
	from: string;
	to: string;
	subject?: string;
	priority: string;
	type: "swarm.message";
	schemaVersion: number;
	createdAt: string;
	body: string;
	conversationId?: string;
	replyTo?: string;
	requiresAck: boolean;
	requiresResponse?: boolean;
	ttlMs?: number;
	idempotencyKey?: string;
	headers: Record<string, string>;
};

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
	// True when the category requires an explicit orchestrator choice (assign/escalate/reassign).
	orchestratorDecision: boolean;
};

export type TaskNodeStatus = "pending" | "ready" | "assigned" | "in_progress" | "blocked" | "done" | "failed" | "skipped" | "cancelled";

export type TaskGateStatus = "open" | "passed" | "failed" | "waived";

// Worker reminder record (reliability roadmap issue 5). Additive: legacy attempts simply lack the
// field, and its presence never changes task semantics — a reminder is informational only.
export type ReminderRecord = {
	reminderId: string;
	sentAt: string;
	messageId: string;          // the reminder message sent to the assignee
	attemptId: string;          // ties the reminder to one attempt lease
	noProgressSince: string;    // anchor timestamp evidence at send time
};

export type TaskNodeAttempt = {
	attemptId: string;           // Unique lease identity (UUID), server-generated
	attemptNumber: number;       // Monotonic counter (1, 2, 3...)
	assignmentMessageId: string; // Message that carried this assignment
	assignee: string;            // Agent who was assigned
	assignedAt: string;           // ISO timestamp
	supersededAt?: string;       // When this attempt was superseded (if applicable)
	supersededBy?: string;        // Attempt ID or "<rework>" that superseded this one
	status: "active" | "superseded" | "completed" | "failed" | "cancelled" | "skipped";
	outcome?: string;             // Final outcome if terminal
	lastActivityAt?: string;      // Last update timestamp
	// Additive lease-audit fields (file-ownership policy, roadmap issue 4). `status` remains the
	// authoritative lifecycle field; these are optional audit annotations only.
	releasedAt?: string;          // When the attempt's write-scope lease ended (any reason)
	releaseReason?: "reassign" | "rework" | "terminal" | "cancel" | "orchestrator_override";
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

export type TaskGate = {
	status: TaskGateStatus;
	by?: string | null;
	artifact?: string | null;
};

// V1.5 opt-in post-iteration proposal loop. Metadata only: it does NOT change node routing,
// branch logic, or task closure rules. When absent or enabled !== true, the graph behaves exactly
// as it does today. Loop state lives under .pi/swarm/loops/<taskId>.json (see loop helpers).
export type LoopConfig = {
	enabled: boolean;
	proposalAgents: string[];
	refreshAgents?: string[];
	maxRounds?: number;
};

export type LoopPhase = "idle" | "collecting_proposals" | "awaiting_plan" | "planned" | "refreshing" | "executing";

export type LoopProposalStatus = "requested" | "received" | "skipped" | "failed";

export type LoopProposal = {
	agentId: string;
	messageId?: string;
	status: LoopProposalStatus;
	receivedAt?: string;
	summary?: string;
	body?: string;
	error?: string;
};

export type LoopRefreshMode = "tmux_new" | "identity_reload" | "skipped";

export type LoopRefreshResult = {
	agentId: string;
	mode: LoopRefreshMode;
	tmuxAlive?: boolean;
	injected?: boolean;
	error?: string;
};

export type LoopPlan = {
	artifact: string;
	summary: string;
	nextSteps?: string;
	createdAt: string;
	createdBy: string;
};

export type LoopRound = {
	round: number;
	phase: LoopPhase;
	startedAt: string;
	endedAt?: string;
	proposalMessageIds: string[];
	proposals: LoopProposal[];
	plan?: LoopPlan;
	refreshResults: LoopRefreshResult[];
};

export type LoopState = {
	taskId: string;
	enabled: boolean;
	config: LoopConfig;
	currentRound: number;
	phase: LoopPhase;
	rounds: LoopRound[];
	createdAt: string;
	updatedAt: string;
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
	// V1.5 opt-in post-iteration loop config. Absent or enabled !== true => no behavior change.
	loop?: LoopConfig;
};

export type TaskPaths = {
	root: string;
	taskMd: string;
	taskJson: string;
	events: string;
	artifacts: string;
};

export type Paths = {
	root: string;
	state: string;
	lock: string;
	mailboxes: string;
	agentsDir: string;
	tasksDir: string;
	traces: string;
	tmuxTraces: string;
	events: string;
	metricsDir: string;
	runsDir: string;
	runArtifactsDir: string;
	memoryDir: string;
	iterationsDir: string;
	loopsDir: string;
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
	status?: string; role?: string; dependsOn?: string[]; allowedFiles?: string[]; allowedFilesFrom?: string;
	readArtifacts?: string[]; writeArtifacts?: string[]; maxAttempts?: number; terminal?: boolean;
	assignee?: string; assigneePolicy?: string; outcome?: string;
};

export type MetricContract = {
	id: string;
	title: string;
	version?: number;
	primaryMetric: {
		id: string;
		direction: string; // maximize | minimize | target | passfail
		valueType: string; // number | boolean | string
		source: { type: string; artifactPath?: string; jsonPath?: string; command?: string };
		minimumMeaningfulChange?: number;
		target?: number; // goal value for direction=target
	};
	validityRules?: string[];
	evidenceRequired?: string[];
	notes?: string;
	status?: string;
	createdAt?: string;
	updatedAt?: string;
};

export type EvidenceDigest = { ref: string; sha256: string; size: number };

export type RunRecord = {
	runId: string;
	metricContractId?: string;
	metricContractVersion?: number;
	taskId?: string;
	nodeId?: string;
	agentId?: string;
	model?: string;
	provider?: string;
	status: string; // running | done | blocked | failed
	verdict?: string; // pass | fail | approved | rejected | blocked
	metrics?: Record<string, number | boolean | string>;
	inputs?: Record<string, unknown>;
	evidenceRefs?: string[];
	evidenceDigests?: EvidenceDigest[];
	notes?: string;
	startedAt?: string;
	endedAt?: string;
	git?: { available?: boolean; baseCommit?: string; headCommit?: string };
	recordedAt?: string;
};

export type MemoryRecord = {
	memoryId: string;
	claim: string;
	sourceRunId: string;
	evidenceRefs: string[];
	scope?: { kind?: string; id?: string };
	confidence?: number;
	status: string; // proposed | active | rejected | expired
	reviewedBy?: string;
	rejectionReason?: string;
	notes?: string;
	createdAt?: string;
	updatedAt?: string;
};

export type IterationEntry = {
	index: number;
	runId: string;
	label?: string;
	recordedAt: string;
};

export type IterationSession = {
	iterationId: string;
	metricContractId: string;
	goal?: string;
	scope?: { kind?: string; id?: string };
	baselineRunId?: string;
	iterations: IterationEntry[];
	bestRunId?: string;
	pinnedMemoryIds: string[];
	status: string; // active | archived
	notes?: string;
	createdAt: string;
	updatedAt: string;
};

export type IterationBest = {
	metricId: string;
	direction: string;
	target?: number;
	bestRunId?: string;
	bestValue?: number | boolean;
	baselineRunId?: string;
	baselineValue?: number | boolean;
	improvement?: number; // signed in the favored direction (positive = better); for target, reduction in distance
	passingCount?: number; // passfail only
	meaningful: boolean;
	missingCount: number;
	invalidCount: number;
	perRun: { runId: string; label?: string; value?: number | boolean; present: boolean; eligible: boolean; exclusionReasons: string[] }[];
	warnings: string[];
};

// Internal reusable-agent lookup used by task tooling (not a public worker tool).
// Recommends the idle, healthy, tmux-alive agent with the fewest active tasks.
// `matchKind` is the rationale for inclusion (roadmap issue 10, reuse-misroute fix):
//   "exact" = role-kind check + capabilities intersect cleanly
//   "substring-collapsed" = re-derived roleKind matches but agent id contains a different role keyword
//                           (caller may want to log/skip these)
//   "fallback" = no role-kind match; matched via capabilities or agentId escape-hatch
export type ReusableAgentMatch = {
	agentId: string;
	roleKind: string;
	runtimeStatus: string;
	health: HealthStatus;
	tmuxAlive: boolean;
	activeTaskIds: string[];
	capabilities: string[];
	matchKind?: "exact" | "substring-collapsed" | "fallback";
};

export type ReconcileAction = { messageId: string; action: string; reason: string; taskId?: string; nodeId?: string };

export type IndexedTask = {
	index: number;
	taskId: string;
	task: TaskState;
	tp: TaskPaths;
	status: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	ready: string[];
	current: string[];
	done: number;
	total: number;
};
