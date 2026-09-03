// === swarm/constants.ts — auto-extracted from index.ts (verbatim bodies) ===
import { join, dirname, relative, sep } from "node:path";
import type { TaskNodeStatus } from "./types.ts";

export const EXT = "swarm";

// Cancellation reason: stamped on supersession records + traces when an root cancels a task.
// Stable, never interpolated — used as a search key in audits.
export const CANCELLATION_REASON = "task_cancellation";
// Per-message supersession `by` value: also stable, search-friendly.
export const MESSAGE_SUPERSEDED_BY_TASK_CANCELLATION = CANCELLATION_REASON;

export const STATE_VERSION = 1;

export const LOCK_STALE_MS = 60_000;

// Multi-root leader staleness TTL (roadmap issue 8, strict-reject). A leader whose
// lastHeartbeatAt is older than this is considered dead and may be replaced by a fresh claim.
// Defaults to LOCK_STALE_MS so the leader lease shares the lock-staleness contract; this is a
// deliberate trade-off documented in operations.md (60s crash-recovery blind spot).
export const ROOT_LEADER_STALE_MS = LOCK_STALE_MS;

// Stable error code for the root-leader gate. Surfaced verbatim by every category A/B
// call site so callers / ops can act on it. NOT a new model-facing tool.
export const ERR_ROOT_LEADER_DENIED = "ROOT_LEADER_DENIED";

// Stable error code for root-authority-required tools that today have no authority check.
// Thrown by tools that this issue elevates to root-only (swarm_create_task,
// swarm_stop_agent, swarm_release_agent_task, swarm_reconcile(mark=true)). NOT a new tool.
export const ERR_ROOT_AUTHORITY_REQUIRED = "ROOT_AUTHORITY_REQUIRED";

// Stable error code for the root-pane reject guard in swarm_send_keys (issue 12 C6 micro-fix).
// Thrown when the resolved tmux target equals the root record's tmuxTarget (typically
// "unknown"), so a future refactor cannot silently route raw keystrokes into the root host
// pane. Principle-based: fires on target equality, not on agentId, so ghost agents mis-stamped to
// "unknown" are also rejected. NOT a new tool.
export const ERR_ROOT_PANE_REJECTED = "ROOT_PANE_REJECTED";

export const SEND_SETTLE_MS = 700;

export const SPAWN_SETTLE_MS = 2_500;

export const SYSTEM_START = "[PI-SWARM SYSTEM MESSAGE]";

export const SYSTEM_END = "[/PI-SWARM SYSTEM MESSAGE]";

export const DEFAULT_MODEL = "glm-5.1";

export const DEFAULT_PROVIDER = "zai-coding-cn";

// Model pool defaults.
export const POOL_COOLDOWN_MS = 15 * 60 * 1000; // bench a failing slot for 15 minutes

export const POOL_MAX_RETRIES = 2; // consecutive failures before cooldown

// === Issue 20: pool-scaffold on root session_start ===
// Placeholder written into `.pi/settings.json` when `swarm.modelPool` (or
// `extensions.swarm.modelPool` — runtime precedence) is absent. Deliberately
// `null` so validateSwarmSettings flags it (`slot_empty_model`) and the user
// is steered toward replacing it with a real slot. The shape follows
// ModelSlot (extra fields omitted) so the JSON parses cleanly; the type
// assertion narrows `null` past ModelSlot's `model: string` invariant.
export const POOL_SCAFFOLD_PLACEHOLDER = [{ model: null as any, provider: null as any }];

// One-shot notify text surfaced to the root TUI on first scaffold.
// Stable so tests + locale passes can match/swap it without touching hooks.ts.
export const POOL_SCAFFOLD_NOTIFY_TEXT =
	"Created swarm.modelPool placeholder in .pi/settings.json — fill in your model/provider. See docs/swarm/tools.md.";

// Stable doc anchor the notify links to. Kept as a constant so the deep-link
// can be updated in one place.
export const POOL_SCAFFOLD_DOC_HINT = "docs/swarm/tools.md#configuration";

// === Issue 17: engine-retry gate constants (extracted to constants.ts in Issue 19) ===
// The pi engine retries a failed provider request up to retry.maxRetries (default 3) times with
// exponential backoff (2s, 4s, 8s — see @earendil-works/pi-coding-agent/docs/settings.md). These
// constants size the engine-retry gate in hooks.ts. Values mirror pi's defaults and are stable;
// engine policy belongs to the engine, so we do not read retry.maxRetries at runtime.
export const ENGINE_MAX_RETRIES = 3;            // mirrors pi's default retry.maxRetries
export const ENGINE_RETRY_WINDOW_MS = 14_000;   // pi's retry budget = baseDelay * (2^N - 1) for N=maxRetries=3

// Identity used for an anonymous swarm session that neither sets PI_SWARM_AGENT_ID nor opts in as the
// root. Such a session is inert for swarm coordination (no agent record, no root pump,
// no root heartbeat refresh); it is a stable, clearly-non-root id so tool defaults
// (e.g. swarm_check_mailbox / swarm_send_message) cannot leak or impersonate root traffic.
export const SWARM_GUEST_ID = "swarm-guest";

export const NODE_ICON: Record<TaskNodeStatus, string> = {
	done: "✓", ready: "●", assigned: "●", in_progress: "●", blocked: "⚠", failed: "✗", skipped: "⊘", pending: "○", cancelled: "⊗",
};

export const SAFE_ID_RE = /^[a-z0-9_-]+$/;

// Allowed non-root node status transitions. Terminal states (done/failed/skipped/cancelled) cannot
// regress without an root override. The root bypasses this map entirely.
// `cancelled` is reachable from every non-terminal state by an root-explicit cancelTask
// (a worker CANNOT cancel; cancelTask requires root authority + force). Workers attempting to
// transition INTO cancelled are rejected with NODE_TRANSITION_FORBIDDEN.
export const ALLOWED_NODE_TRANSITIONS: Record<string, Set<string>> = {
	pending: new Set(["ready", "assigned", "blocked", "skipped", "failed", "cancelled"]),
	ready: new Set(["assigned", "blocked", "skipped", "cancelled"]),
	assigned: new Set(["in_progress", "done", "failed", "blocked", "ready", "cancelled"]),
	in_progress: new Set(["done", "failed", "blocked", "cancelled"]),
	blocked: new Set(["assigned", "in_progress", "ready", "skipped", "cancelled"]),
	// Issue 28: rework activation may reopen a previously-done node back to ready (root force
	// path / rework reopen path). No other terminal regressions are enabled here.
	done: new Set(["ready"]),
};

export const TERMINAL_NODE_STATUSES = new Set<TaskNodeStatus>(["done", "failed", "skipped", "cancelled"]);

export const METRIC_ID_RE = /^[a-z0-9_-]+$/;

export const RUN_STATUSES = new Set(["running", "done", "blocked", "failed"]);

export const RUN_VERDICTS = new Set(["pass", "fail", "approved", "rejected", "blocked"]);

// Shared path to the project memory policy (a committed doc; agents read it relative to repo root).
// Declared in the memory-surface region; the identity region references this constant when appending
// the `## Memory protocol` link to generated agent identity. The dedicated policy file defines the
// read/propose/accept triggers, claim-quality rules, evidence requirements, and role permissions.
export const MEMORY_POLICY_DOC = "docs/swarm-memory.md";

export const MAX_ATTEMPTS = 5;

// Bounded re-injection of INJECTED-but-unacked messages (issue A): after this many re-injections the
// message keeps its ack_missing marker but is no longer re-sent; dead-lettering still happens via TTL.
export const MAX_REINJECTS = 2;

// An injected-but-unacked message becomes eligible for re-injection only after this age past the
// LAST delivery/re-injection attempt (avoids re-injecting a message the agent is actively working).
export const REINJECT_AFTER_MS = 300_000;

// Task staleness thresholds for the reconcile task sweep (advisory; never auto-fail nodes).
export const TASK_STALE_MS = 24 * 60 * 60 * 1000; // in_progress node with no activity bump -> stale

export const TASK_NUDGE_MS = 30 * 60 * 1000; // in_progress node with no activity bump -> nudge reminder

export const ACK_MISSING_MS = 300_000; // delivered-but-unacked assignment -> ack_missing (mirrors mailbox)

// Worker reminder policy (reliability roadmap issue 5). After confirmed assignment receipt/processing
// (durable ack `seen`/`processing`) and this long without progress, the node becomes reminder-eligible.
// At most ONE reminder per attempt, permanently — there is no cooldown re-send; a fresh reminder is
// only possible after a reassign/rework mints a new attempt. The reminder is informational only.
export const REMINDER_NO_PROGRESS_MS = 60 * 60 * 1000;

// Cooldown for the agent_settled->root "settled with open work" notify, so repeated settles in
// a window don't multiply into a message storm. Loop-safe: notify targets the mailbox-only
// root (never the worker), and is rate-limited per agent via persisted lastSettleNotifyAt.
export const SETTLE_NOTIFY_COOLDOWN_MS = 2 * 60 * 1000;

// Root auto-pump session-safety bounds. Each root-context session surfaces a message
// at most once (per-session dedup); the scan window bounds work + re-surface blast radius, the id cap
// bounds a long-lived session's ledger, and the TTL prunes dead validation-session pids.
export const PUMP_SCAN_WINDOW = 50;

export const PUMP_SESSION_ID_CAP = 200;

export const PUMP_SESSION_TTL_MS = 60 * 60 * 1000;

// Bounded re-trigger of action-expected (requiresAck) root notifications. A message surfaced +
// triggered once but still unacked is re-delivered with a fresh triggerTurn after this delay, up to MAX
// times, so a nudge that landed while the root was busy (and thus only ever followUp-delivered,
// or triggered once and then ignored) is not silently lost. Informational (requiresAck:false) messages
// get exactly one triggered delivery — sufficient, since the root was already prompted. Caps
// prevent spam; the per-tick pump + agent_settled hook supply the retry cadence.
export const PUMP_RETRIGGER_DELAY_MS = 60 * 1000;

// Stuck-busy escalation threshold: when ctx.isIdle() has been false (queued continuation /
// auto-retry pending) but the oldest never-displayed root message has waited this long,
// the pump surfaces it with deliverAs "steer" (interrupting the stuck continuation) instead of
// deferring forever. Override via PI_SWARM_STUCK_DEFER_ESCALATE_MS.
export const PUMP_STUCK_DEFER_ESCALATE_MS = Number(process.env.PI_SWARM_STUCK_DEFER_ESCALATE_MS ?? 120 * 1000);

export const PUMP_RETRIGGER_MAX = 3;

export const MAX_STATUS_TASKS = 100;

// Orphan-spawn watchdog timeout (Issue 14). When swarm_spawn_agent returns and no follow-up delivery
// (swarm_send_message, swarm_assign_task which sends internally, or swarm_stop_agent) occurs within
// this window, the engine emits a single `agent.spawn.orphan_warning` trace event — observable by ops
// and dashboards via swarm_trace, never exposed as a new public tool. Override for testing via the
// `PI_SWARM_ORPHAN_TIMEOUT_MS` env var (tests set it to ~50ms to exercise the timer path in real time).
export const ORPHAN_SPAWN_WARNING_TIMEOUT_MS =
	Number(process.env.PI_SWARM_ORPHAN_TIMEOUT_MS) > 0 ? Math.floor(Number(process.env.PI_SWARM_ORPHAN_TIMEOUT_MS)) : 30_000;

// Pre-flight auto-clear window for Issue 16. When swarm_assign_task resolves to a fresh agentId AND
// the same root session that armed the spawn entry calls swarm_assign_task within this
// window, the orphan watch is pre-cleared and the timer is cancelled.
//
// Default relationship: PREFLIGHT_ASSIGN_GRACE_MS = max(5_000, ORPHAN_SPAWN_WARNING_TIMEOUT_MS - 1_000).
//   - The 1_000 ms safety margin keeps the pre-clear strictly inside the warning window so the
//     timer can never fire for a same-root flow under any test/env combination of the
//     two env vars.
//   - The 5_000 ms floor guarantees a useful grace even when an operator dials
//     ORPHAN_SPAWN_WARNING_TIMEOUT_MS very low for testing (e.g. PI_SWARM_ORPHAN_TIMEOUT_MS=50).
//   - For the production defaults (ORPHAN_SPAWN_WARNING_TIMEOUT_MS = 30_000) the grace window
//     becomes 29_000 ms — large enough to absorb slow CI / container spawn latencies without
//     tripping the warning.
//
// Override for tests via PI_SWARM_PREFLIGHT_GRACE_MS (set BEFORE module import; the module-load-
// time read happens once, same as PI_SWARM_ORPHAN_TIMEOUT_MS).
const RAW_PREFLIGHT_GRACE_MS =
	Number(process.env.PI_SWARM_PREFLIGHT_GRACE_MS) > 0
		? Math.floor(Number(process.env.PI_SWARM_PREFLIGHT_GRACE_MS))
		: Math.max(5_000, ORPHAN_SPAWN_WARNING_TIMEOUT_MS - 1_000);
export const PREFLIGHT_ASSIGN_GRACE_MS = RAW_PREFLIGHT_GRACE_MS;

// === Recovery notification policy (reliability-roadmap Phase 1) ===
// Unified, actually-enforced dedupe/cooldown/cap contract for recovery nudges sent to the
// root. `sendNotifyLocked` in reconcile.ts is the single enforcement point: a nudge is only
// sent when (a) a message with the same semantic key is not already open, (b) the sender-level
// cooldown for that key template has elapsed, and (c) the per-task nudge cap is not exceeded.

// Grace period: a freshly created task whose start node is ready + unassigned may stay quiet this
// long before the initial-ready nudge fires.
export const TASK_INITIAL_READY_GRACE_MS = 60_000;

export const NOTIFY_DEFAULT_COOLDOWN_MS = 300_000; // 5 minutes between nudges of the same template

export const NOTIFY_DEFAULT_MAX_NUDGES = 3; // per task+template cap before we stop reminding

// Semantic dedupe key templates. Templates are formatted by formatNotifyKey (never interpolated at
// runtime) so every code path shares one identifier space and cannot accidentally collide or drift.
export const NOTIFY_KEY_INITIAL_READY = "task:{taskId}:nudge:initial-ready";
// Issue F2 (task-202608310422): include a `{seq}` slot so each successful emit gets a fresh dedupe
// slot. Pre-fix the key was static per (taskId, nodeId), so mailbox.ts:237-245 dedupe
// (`findIdempotentMessage` over `from + to + idempotencyKey`) returned the original message on every
// later tick regardless of ackedAt — cap/cooldown gates were reachable but no second mailbox nudge
// was ever delivered. The seq-suffix mirrors NOTIFY_KEY_GOAL_IDLE_NUDGE and NOTIFY_KEY_TASK_GRAPH_STALL
// (same `{seq}` shape). `seq` is monotonic per (taskId, nodeId), stored in
// SwarmGraphAdvanceNudgeState — see reconcile.ts:sendGraphAdvanceNudgeLocked.
export const NOTIFY_KEY_GRAPH_ADVANCE = "task:{taskId}:node:{nodeId}:nudge:assign:seq:{seq}";
// Lifecycle-fencing (issue 9): per-(task,agent) dedupe for the agent_settled -> root
// "settled with open assignment(s)" notify so repeated settles in a window don't storm. Reused by
// the session_shutdown site too via the same predicate gating.
export const NOTIFY_KEY_SETTLE_STALE = "task:{taskId}:agent:{agentId}:nudge:settle-stale";

// R11-1 completion — stale-open assignment nudge (surfacing was trace-only; the root
// had to poll proxyMetrics by hand, and the swarm idled for hours). Same template family as the
// graph-advance nudge: idempotent by seq, capped, cooled down.
export const NOTIFY_KEY_STALE_OPEN = "task:{taskId}:node:{nodeId}:nudge:stale-open:seq:{seq}";
export const TRACE_STALE_OPEN_NUDGE_EMITTED = "stale_open.nudge_emitted";

// Root pump per-tick batch suppression trace key (issue 11 / binding C6). Emitted on
// EVERY pump tick including total===0 so dashboards counting silent-tick baselines render
// correctly. The trace shape is { ts, cid, total, counts: { reason -> n, ... } }.
export const NOTIFY_KEY_PUMP_BATCH_SUPPRESSED = "swarm.pump.batch_suppressed";

// === Issue 25 Phase 1: minimal-protocol feature gate ===
// Read once at module load (mirrors ORPHAN_SPAWN_WARNING_TIMEOUT_MS pattern). Default 0 — the
// existing explicit ACK/requiresAck/reconcile semantics remain authoritative and no durable
// lifecycle mutations happen until the rollout review flips gate=1.
export const PI_SWARM_MINIMAL_PROTOCOL =
	(process.env.PI_SWARM_MINIMAL_PROTOCOL === "1" || process.env.PI_SWARM_MINIMAL_PROTOCOL === "true") ? 1 : 0;

// === Issue F2 (task-202608310422): stable telemetry trace event name for graph-advance emits ===
// Exported so tests + dashboards import the same string the engine emits. Payload:
// { taskId, nodeId, seq, key, cap, cooldownMs }.
export const TRACE_GRAPH_ADVANCE_NUDGE_EMITTED = "graph.advance_nudge_emitted";

// === Issue 81 (task-202608310900): goal-clear authority guard ===
// Emitted by swarm_mark_goal_done / swarm_set_goal / /swarm goal done|set|update when the goal-
// clear authority guard refuses an operation on a user-origin goal. Payload:
// { goalId, origin, reason, actor, action: "clear"|"replace", via: "tool"|"command",
//   approvedByUser?: boolean }. Distinct from goal.cleared (success path) so dashboards can split
// refusals vs. legitimate clears.
export const TRACE_GOAL_CLEAR_REFUSED = "goal.clear_refused";

// === Issue 25 Phase 1: stable telemetry trace event names ===
// Exported as constants so tests and dashboards import the same string the engine emits.
export const TRACE_TOOL_INVOKED = "tool.invoked";
export const TRACE_LIFECYCLE_DERIVED = "message.lifecycle_derived";
export const TRACE_LIFECYCLE_DERIVED_SHADOW = "message.lifecycle_derived_shadow"; // gate=0 only
export const TRACE_PROTOCOL_MIGRATION_COMPLETED = "protocol.migration.completed";
export const TRACE_PROTOCOL_MIGRATION_RECORD = "protocol.migration.record";

// === Issue 25 Phase 1: worker reconcile rate budget (proposal §E + §K.1) ===
// Workers calling swarm_reconcile({dryRun:true}) are constrained to the `self` scope and rate-limited
// to PI_SWARM_RECONCILE_DRYRUN_WORKER_RATE_MS between invocations so a stuck worker can't repeatedly
// scan the whole swarm. Reads at module load (mirrors PI_SWARM_ORPHAN_TIMEOUT_MS). Phase 2 CONSUMES
// this constant at the swarm_reconcile handler boundary (it was declared in Phase 1 as a no-op).
export const PI_SWARM_RECONCILE_DRYRUN_WORKER_RATE_MS =
	Number(process.env.PI_SWARM_RECONCILE_DRYRUN_WORKER_RATE_MS) > 0
		? Math.floor(Number(process.env.PI_SWARM_RECONCILE_DRYRUN_WORKER_RATE_MS))
		: 60_000;

// === Issue 25 Phase 2: profile gating (proposal §E + §K.3) ===
// Allow-lists consulted by applySwarmToolGating at runtime under PI_SWARM_MINIMAL_PROTOCOL=1. Tools
// remain registered (UX §N5) so getAllTools() / smoke test stay stable; only the active set is
// filtered. Execution-time authority checks (requireRootAuthority) remain authoritative —
// tier-gating is the first gate, authority is the second.
export const WORKER_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
	"swarm_check_mailbox",
	"swarm_send_message",
	"swarm_update_task",
	"swarm_task_status",
	"swarm_reconcile", // worker surface limits this to dryRun:true + scope:"self" at execution time
]);

export const ROOT_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
	// Worker surface (inherited):
	"swarm_check_mailbox",
	"swarm_send_message",
	"swarm_update_task",
	"swarm_task_status",
	"swarm_reconcile",
	"swarm_audit",
	// Orchestration surface (5 additional):
	"swarm_agent_status",
	"swarm_list_agents",
	"swarm_spawn_agent",
	"swarm_create_task",
	"swarm_assign_task",
	"swarm_audit",
	// Goal tools (2):
	"swarm_set_goal",
	"swarm_mark_goal_done",
]);

// === Issue 25 Phase 2: stable error codes (NOT new tools) ===
// Worker calling swarm_reconcile with scope other than "self" -> SCOPE_FORBIDDEN.
// Worker calling swarm_reconcile too fast -> RECONCILE_RATE_LIMITED.
export const ERR_SCOPE_FORBIDDEN = "SCOPE_FORBIDDEN";
export const ERR_RECONCILE_RATE_LIMITED = "RECONCILE_RATE_LIMITED";

// === Issue 25 Phase 2: stable reply-fencing trace event (proposal §B.3) ===
// Emitted on `swarm_send_message({ replyTo })` when the original record is superseded, cancelled,
// or otherwise not current — the original response.status is NOT flipped and debt is NOT cleared.
export const TRACE_REPLY_REJECTED_SUPERSEDED = "message.reply_rejected_superseded";

// === Issue 25 Phase 2: consumer-facing attention trace (proposal §K.2) ===
// Emitted on the deadline sweep under gate=1 so dashboards can subscribe to a derived attention
// category without parsing the per-message lifecycle trace.
export const TRACE_MESSAGE_ATTENTION_DERIVED = "message.attention.derived";

// === Issue 26 — task-close worker sweep (auto-stop task-scoped workers) ===
// Per-agent trace emitted from `taskgraph.ts:sweepTaskWorkersLocked` for every agent that the
// sweep actually stopped. Includes the taskId and release evidence (prior activeTaskIds, the
// path that drove the eligibility decision — spawnedForTaskId link vs. sole-active-task closure).
// Sweep idempotence: a second invocation finds nothing to stop and emits ZERO per-agent traces.
export const TRACE_AGENT_TASK_SWEEP_STOPPED = "agent.task_sweep_stopped";

// Summary trace emitted ONCE per close call from `taskgraph.ts:sweepTaskWorkersLocked`. Includes
// the taskId and the count of agents stopped (so dashboards can chart sweep yield per task).
export const TRACE_TASK_WORKERS_SWEPT = "task.workers_swept";

// === Issue 82: heartbeat-driven agent GC + lease-aware park-or-stop ===
// Emitted from reconcile.ts:agentHeartbeatGCLocked when the cheap-gate sweep marks a running
// agent whose tmux pane is dead (carried over from a previous probe) as stopped. Includes the
// reason so dashboards can distinguish "known-dead cached" from "freshly probed dead".
export const TRACE_AGENT_HEARTBEAT_GC_STOPPED = "agent.heartbeat_gc.stopped";

// Emitted from reconcile.ts:agentHeartbeatGCLocked when an idle agent's heartbeat is older than
// PI_SWARM_AGENT_HEARTBEAT_STALE_MS and the gate downgrades health to "stale" WITHOUT flipping
// status (a busy agent without fresh heartbeat is not necessarily dead). The gate also drops a
// flag so the goal-nudge `agent_busy` predicate (Issue 85) does NOT see this as a busy signal.
export const TRACE_AGENT_HEARTBEAT_GC_STALE = "agent.heartbeat_gc.stale";

// Emitted from reconcile.ts:agentHeartbeatGCLocked when a tmux probe disagrees with the cached
// `tmuxAlive` field on the agent record. The cached field is otherwise stale-by-design (refreshed
// on tool calls / hook events); this trace + field update is the GC's reconciliation step.
export const TRACE_AGENT_TMUX_LIVENESS_CORRECTION = "agent.tmux_liveness_correction";

// Emitted from taskgraph.ts:sweepTaskWorkersLocked when an eligible worker was paused (instead
// of stopped) because of a valid `leaseKind: "park"` lease. Companion to TRACE_AGENT_TASK_SWEEP_STOPPED.
export const TRACE_AGENT_TASK_SWEEP_PARKED = "agent.task_sweep_parked";

// === R12 P0: pool-depletion nudge (companion to task-close sweep) ===
// Emitted from taskgraph.ts:sweepTaskWorkersLocked when a close CALL actually transitions the
// effective live non-root agent pool from ≥1 to 0. Exactly one per depleting close call;
// not emitted on `0 → 0` or `≥1 → ≥1` transitions; not emitted on idempotent re-invocations
// (`stopped.length === 0`). Companion message: a high-priority root nudge is delivered
// via deliverMessageLocked at the same call site so the Issue 86 interrupt machinery wakes the
// root and either re-spawns workers or downgrades the goal.
export const TRACE_POOL_DEPLETED_NUDGE = "pool.depleted_nudge";

// === Issue 82: lease stamping trace (tools/tasks.ts:swarm_assign_task) ===
// Emitted when the root passes a `lease` parameter to swarm_assign_task and the assignee's
// record is stamped with the lease fields. Carries the lease kind, until timestamp, and reason
// so dashboards can chart which assignments carry an explicit reuse/park lease.
export const TRACE_TASK_LEASE_STAMPED = "task.lease_stamped";

// === Issue 82: lease set/clear via /swarm agent lease (command.ts) ===
// Emitted when the root runs `/swarm agent lease <id> [--reuse|--park] ...`. Carries the
// kind/until/reason so the lease ledger is auditable end-to-end (assignment-tool stamps and
// command-tool stamps are unified by both writing the same `agent.leaseKind/leaseUntil/leaseReason`
// fields, but the trace event source differs).
export const TRACE_AGENT_LEASE_SET = "agent.lease_set";
export const TRACE_AGENT_LEASE_CLEARED = "agent.lease_cleared";

// Default stale-heartbeat window for agentHeartbeatGCLocked: an agent whose lastHeartbeatAt is
// older than this AND is idle gets health downgraded to "stale" (not stopped). tmux probes fire
// after 2× this window. Mirrors the existing reconcile.ts default of 600_000; env override
// PI_SWARM_AGENT_HEARTBEAT_STALE_MS lets operators tighten / loosen the window.
export const DEFAULT_AGENT_HEARTBEAT_STALE_MS = 600_000; // 10 minutes

// === Issue 83a — stale-open surfacing threshold ===
// Window (ms) after which an `assigned`/`in_progress` node WITHOUT a `lastProgressAt` update
// is surfaced to the root via `stale_open_surfaced` + an root mailbox nudge.
// Mirrors the existing task-liveness 5-minute threshold; env override
// PI_SWARM_STALE_OPEN_THRESHOLD_MS lets operators tighten / loosen. The scan is idempotent
// within the window: re-running before threshold expiry produces 0 additional surfaces.
export const DEFAULT_STALE_OPEN_THRESHOLD_MS = 30_000; // 30s — interactive swarm liveness (user directive 2026-09-01: 5min meant ≥5min of silence before the first nudge; real work updates lastProgressAt on every tool_execution_end, so 30s idle+no-progress is a settled worker with near-certainty). Env PI_SWARM_STALE_OPEN_THRESHOLD_MS still overrides for long-running tools.

// === Issue 82 (review item 1): tmux-probe throttle ledger trace ===
// Emitted by `agentHeartbeatGCLocked` gate 2 whenever a tmux probe is skipped because the agent's
// `lastProbeAt` is younger than `probeAfterMs` (the throttle ledger). Carries the throttle fields
// so dashboards can chart the probe-skip rate without re-reading the state file. Counts toward
// the cheap-gate 1/2/3 totals emitted alongside the gate-2 skip.
export const TRACE_AGENT_HEARTBEAT_GC_PROBE_THROTTLED = "agent.heartbeat_gc.probe_throttled";

// === Issue 82 (review item 3): expired-lease dead-pane flip trace ===
// Emitted by `agentHeartbeatGCLocked` when a paused-with-expired-lease agent's pane is detected
// dead (gate 1 path) and is therefore eligible for the zombie-reclamation flip. Companion to
// TRACE_AGENT_HEARTBEAT_GC_STOPPED — distinguishes "the normal dead-pane flip" from
// "the previously-orphaned expired-park zombie we just reclaimed".
export const TRACE_AGENT_HEARTBEAT_GC_EXPIRED_PARK_FLIPPED = "agent.heartbeat_gc.expired_park_flipped";

// === Issue 83a — stale-open surfacing trace ===
// Emitted by the `staleOpenAssignmentScanLocked` pump-tick phase when an `assigned`/`in_progress`
// node has not received a progress signal for >`PI_SWARM_STALE_OPEN_THRESHOLD_MS`. Carries the
// taskId + nodeId + lastProgressAt + assignedAt so the root can decide whether to reassign,
// escalate, or wait. Idempotent within the window (one surface per threshold window per node).
export const TRACE_STALE_OPEN_SURFACED = "stale_open_surfaced";

// === Issue 83b — supersession fencing for late results + reassign churn ===
// Fixed-window per-node supersession rate limit. A `swarm_assign_task` that would push the node
// past `PI_SWARM_REASSIGN_RATE_LIMIT` reassigns within `PI_SWARM_REASSIGN_RATE_WINDOW_MS` is
// refused with `REASSIGN_RATE_LIMITED` + emits this trace. Distinct from `task.attempt.superseded`
// (which fires per supersede event) — this trace is the gate refusal itself, used by ops to
// distinguish "real supersede churn" from "caller hitting the rate cap".
export const TRACE_REASSIGN_RATE_LIMITED = "reassign.rate_limited";
export const REASSIGN_RATE_LIMITED = "REASSIGN_RATE_LIMITED";

// Window (ms) for the supersession rate-limit gate. Reset to `nowMs` when the window expires
// (fixed-window semantics: simple O(1) per reassign). Default 60s (one minute); operators can
// override via PI_SWARM_REASSIGN_RATE_WINDOW_MS.
export const DEFAULT_REASSIGN_RATE_WINDOW_MS = 60_000;

// Maximum reassigns per node per window. Mirrors the root's tolerance for churn before
// we suspect an automation loop; default 5/min per node. Operators can override via
// PI_SWARM_REASSIGN_RATE_LIMIT. The gate is HARD: refusals do not queue — the caller must wait
// for the window to expire.
export const DEFAULT_REASSIGN_RATE_LIMIT = 5;

// Env-evaluated values (read once at module load, same pattern as PI_SWARM_ORPHAN_TIMEOUT_MS).
// PI_SWARM_REASSIGN_RATE_LIMIT: integer > 0 (else falls back to DEFAULT_REASSIGN_RATE_LIMIT).
// PI_SWARM_REASSIGN_RATE_WINDOW_MS: integer > 0 (else falls back to DEFAULT_REASSIGN_RATE_WINDOW_MS).
export const PI_SWARM_REASSIGN_RATE_LIMIT =
	Number(process.env.PI_SWARM_REASSIGN_RATE_LIMIT) > 0
		? Math.floor(Number(process.env.PI_SWARM_REASSIGN_RATE_LIMIT))
		: DEFAULT_REASSIGN_RATE_LIMIT;
export const PI_SWARM_REASSIGN_RATE_WINDOW_MS =
	Number(process.env.PI_SWARM_REASSIGN_RATE_WINDOW_MS) > 0
		? Math.floor(Number(process.env.PI_SWARM_REASSIGN_RATE_WINDOW_MS))
		: DEFAULT_REASSIGN_RATE_WINDOW_MS;

// === Issue 83b — late-result rejection trace ===
// Emitted when a worker (the previous assignee) attempts `swarm_update_task` after the node has
// been reassigned: the caller's `attemptId` is a SUPERSEDED attempt and the node has a NEWER active
// attempt. Distinct from `message.reply_rejected_superseded` (which guards message-layer replies):
// this guards the tool-layer `swarm_update_task` late-result path. Payload includes the
// superseded attemptId + the current activeAttemptId + lateArrivalAt (so ops can compute the
// late-window). No node mutation occurs.
export const TRACE_LATE_RESULT_REJECTED = "message.late_result_rejected";
// Error code returned by the `swarm_update_task` tool when a late-result is rejected. Surfaced
// in the tool result envelope as `{ refused: true, reason: "supersession", ... }` so the caller
// can self-correct (read the latest assignment message) without an unbounded retry loop.
export const LATE_RESULT_REFUSAL_REASON = "supersession";

// === Issue 83c — proxy metric emit trace ===
// Emitted by the new proxy-metric pump phase after it snapshots the cheap counters into
// `SwarmState.proxyMetrics`. The emission is bounded by PI_SWARM_PROXY_METRIC_INTERVAL_MS
// (default 60s) so the trace census stays cheap while still surfacing hung-but-alive residuals,
// stale-open assignment counts, and supersession churn.
export const TRACE_PROXY_METRIC_EMIT = "proxy.metric_emit";
export const DEFAULT_PROXY_METRIC_INTERVAL_MS = 60_000;
export const PI_SWARM_PROXY_METRIC_INTERVAL_MS =
	Number(process.env.PI_SWARM_PROXY_METRIC_INTERVAL_MS) > 0
		? Math.floor(Number(process.env.PI_SWARM_PROXY_METRIC_INTERVAL_MS))
		: DEFAULT_PROXY_METRIC_INTERVAL_MS;

// === Issue 84: trace audit + rotation retention policy ===
// Audit reads stay bounded even on very large trace ledgers. Rotation trims the hot trace file
// outside the swarm lock and keeps only a few days / a few generations of compressed history.
export const DEFAULT_TRACE_ROTATE_BYTES =
	Number(process.env.PI_SWARM_TRACE_ROTATE_BYTES) > 0
		? Math.floor(Number(process.env.PI_SWARM_TRACE_ROTATE_BYTES))
		: 50 * 1024 * 1024;
export const DEFAULT_TRACE_RETENTION_MS =
	Number(process.env.PI_SWARM_TRACE_RETENTION_MS) > 0
		? Math.floor(Number(process.env.PI_SWARM_TRACE_RETENTION_MS))
		: 3 * 24 * 60 * 60 * 1000;
export const DEFAULT_TRACE_KEEP_GENERATIONS =
	Number(process.env.PI_SWARM_TRACE_KEEP_GENERATIONS) > 0
		? Math.floor(Number(process.env.PI_SWARM_TRACE_KEEP_GENERATIONS))
		: 5;

// === Issue 28 — rework reopen trace ===
// Emitted when activateReworkNodes reopens a previously-done/failed/skipped node because a rework
// edge activated. Payload includes priorAttemptId so operators can correlate with the canonical
// task.attempt.superseded emitted by the next mintNodeAttempt call.
export const TRACE_TASK_ATTEMPT_REOPENED_BY_REWORK = "task.attempt.reopened_by_rework";

// === Issue 29 — force reopen trace ===
// Emitted when swarm_update_task(force=true) reopens a terminal node back to a non-terminal state.
// Distinct from the rework reopen trace above: this path is root-explicit and does not
// flow through activateReworkNodes.
export const TRACE_TASK_ATTEMPT_FORCE_REOPEN = "task.attempt.force_reopen";

// Stable env-var opt-out: when set to "1" the task-close sweep is suppressed entirely (no traces,
// no stops). Default ON; this is NOT gated behind PI_SWARM_MINIMAL_PROTOCOL.
export const PI_SWARM_KEEP_TASK_WORKERS_OPT_OUT_ENV = "PI_SWARM_KEEP_TASK_WORKERS";

// === Issue 18: Swarm goal + idle-streak nudge ===
// Max consecutive unresolved nudges before the pump enters a 2-tick back-off. Configurable via the
// PI_SWARM_MAX_NUDGES env var (read at module-load time, mirrors the ORPHAN_SPAWN_WARNING_TIMEOUT_MS
// pattern). Defaults to 3, matching the reliability-roadmap plan.
export const MAX_CONSECUTIVE_NUDGES_DEFAULT =
	Number(process.env.PI_SWARM_MAX_NUDGES) > 0
		? Math.floor(Number(process.env.PI_SWARM_MAX_NUDGES))
		: 3;

// Goal idle interval: the fallback nudge is anchored to the BUSY→ALL-IDLE edge and only re-fires
// after a full continuous idle interval has elapsed. The pump may run more often, but it must not
// turn that into repeated goal nudges.
export const GOAL_NUDGE_IDLE_INTERVAL_MS =
	Number(process.env.PI_SWARM_GOAL_NUDGE_IDLE_INTERVAL_MS) > 0
		? Math.floor(Number(process.env.PI_SWARM_GOAL_NUDGE_IDLE_INTERVAL_MS))
		: 60_000;

// Back-off window after MAX_CONSECUTIVE_NUDGES_DEFAULT nudges without a resolve. The pump skips the
// next N interval opportunities before re-evaluating; if the counter is still at cap and the goal is
// still set + idle, the pump re-enters the back-off cycle.
export const GOAL_NUDGE_BACKOFF_TICKS = 2;

// === Issue 23: task-graph-state idle nudge (no-goal variant) ===
// Max consecutive unresolved task-stall nudges before the pump enters a 2-tick back-off. Mirrors
// the Issue 18 goal-nudge cap but is keyed on a different condition (task-graph state, not a goal).
// Configurable via the PI_SWARM_MAX_TASK_STALL_NUDGES env var (read at module-load time, mirroring
// the ORPHAN_SPAWN_WARNING_TIMEOUT_MS pattern). Defaults to 3, matching the goal-nudge default.
export const MAX_TASK_STALL_NUDGES =
	Number(process.env.PI_SWARM_MAX_TASK_STALL_NUDGES) > 0
		? Math.floor(Number(process.env.PI_SWARM_MAX_TASK_STALL_NUDGES))
		: 3;

// Graph-stall interval (row 68): the actionable-graph nudge fires immediately on the all-idle edge
// but re-fires only after a full continuous all-idle interval — pump tick rate must not turn it
// into a per-tick burst. Mirrors GOAL_NUDGE_IDLE_INTERVAL_MS; both share the env override pattern.
export const TASK_STALL_NUDGE_IDLE_INTERVAL_MS =
	Number(process.env.PI_SWARM_TASK_STALL_NUDGE_IDLE_INTERVAL_MS) > 0
		? Math.floor(Number(process.env.PI_SWARM_TASK_STALL_NUDGE_IDLE_INTERVAL_MS))
		: 60_000;

// Semantic dedupe key template for the task-graph-state idle nudge. Per-(taskId) key so the pump
// never emits a duplicate nudge for the same stalled task. Validated via SAFE_ID_RE inside
// formatNotifyKey; the `taskId` substitution must satisfy /^[a-z0-9_-]+$/.
export const NOTIFY_KEY_TASK_GRAPH_STALL = "task:{taskId}:nudge:graph-stall:{seq}";

// Semantic dedupe key template for the goal idle-streak nudge. One nudge per (goal, idle-streak)
// so the root mailbox never sees duplicate nudges for the same goal emission. Validated via
// SAFE_ID_RE inside formatNotifyKey; the `goalId` substitution must satisfy /^[a-z0-9_-]+$/.
export const NOTIFY_KEY_GOAL_IDLE_NUDGE = "goal:{goalId}:nudge:idle-streak:{seq}";

// Format a NOTIFY_KEY_* template with validated (safe-id) substitutions.
export function formatNotifyKey(template: string, params: Record<string, string>): string {
	let out = template;
	for (const [k, v] of Object.entries(params)) {
		if (!SAFE_ID_RE.test(v)) throw new Error(`UNSAFE_NOTIFY_KEY_PARAM: ${k}=${v}`);
		out = out.replace(`{${k}}`, v);
	}
	if (out.includes("{")) throw new Error(`UNRESOLVED_NOTIFY_KEY_PARAM: ${out}`);
	return out;
}

// === R20 — artifact-progress self-nudge (Issue: "settled idle with open assignment") ===
// Worker wrote an artifact (fs.stat mtime > node.lastProgressAt) but the node is still open.
// The pump-tick deliver-and-trace function evaluateArtifactProgressNudgeLocked fires an
// action-oriented nudge to the agent itself (not the root) before it settles, naming
// the exact close-action triple: swarm_update_task + swarm_send_message replyTo + swarm_ack_message.
// Tunables:
//   - ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS: dedupe gate between consecutive nudges on the same node.
//   - ARTIFACT_PROGRESS_NUDGE_CAP:        per-node counter; once exceeded we emit cap_exceeded + one-line root escalation instead.
//   - ARTIFACT_PROGRESS_GRACE_MS:         mtime must exceed lastProgressAt by at least this much.
//   - ARTIFACT_PROGRESS_MAX_FILES:        hard cap on allowedFiles fs.stat calls per node per tick (cost bound).
//   - ARTIFACT_PROGRESS_ACTIVE_AGENT_SKIP_MS: skip when agent.lastToolAt is fresher than this (active worker, no noise).

export const ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS =
	Number(process.env.PI_SWARM_ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS) > 0
		? Math.floor(Number(process.env.PI_SWARM_ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS))
		: 5 * 60_000;

export const ARTIFACT_PROGRESS_NUDGE_CAP =
	Number(process.env.PI_SWARM_ARTIFACT_PROGRESS_NUDGE_CAP) > 0
		? Math.floor(Number(process.env.PI_SWARM_ARTIFACT_PROGRESS_NUDGE_CAP))
		: 3;

export const ARTIFACT_PROGRESS_GRACE_MS =
	Number(process.env.PI_SWARM_ARTIFACT_PROGRESS_GRACE_MS) > 0
		? Math.floor(Number(process.env.PI_SWARM_ARTIFACT_PROGRESS_GRACE_MS))
		: 60_000;

export const ARTIFACT_PROGRESS_MAX_FILES =
	Number(process.env.PI_SWARM_ARTIFACT_PROGRESS_MAX_FILES) > 0
		? Math.floor(Number(process.env.PI_SWARM_ARTIFACT_PROGRESS_MAX_FILES))
		: 50;

export const ARTIFACT_PROGRESS_ACTIVE_AGENT_SKIP_MS =
	Number(process.env.PI_SWARM_ARTIFACT_PROGRESS_ACTIVE_AGENT_SKIP_MS) > 0
		? Math.floor(Number(process.env.PI_SWARM_ARTIFACT_PROGRESS_ACTIVE_AGENT_SKIP_MS))
		: 60_000;

// R20 trace event names. Stable so dashboards + tests import the same strings the engine emits.
export const TRACE_ARTIFACT_PROGRESS_NUDGE = "worker.artifact_progress_no_status_update";
export const TRACE_ARTIFACT_PROGRESS_CAP_EXCEEDED = "worker.artifact_progress_cap_exceeded";

