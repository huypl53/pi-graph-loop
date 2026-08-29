// === swarm/constants.ts — auto-extracted from index.ts (verbatim bodies) ===
import { join, dirname, relative, sep } from "node:path";
import type { TaskNodeStatus } from "./types.ts";

export const EXT = "swarm";

// Cancellation reason: stamped on supersession records + traces when an orchestrator cancels a task.
// Stable, never interpolated — used as a search key in audits.
export const CANCELLATION_REASON = "task_cancellation";
// Per-message supersession `by` value: also stable, search-friendly.
export const MESSAGE_SUPERSEDED_BY_TASK_CANCELLATION = CANCELLATION_REASON;

export const STATE_VERSION = 1;

export const LOCK_STALE_MS = 60_000;

// Multi-orchestrator leader staleness TTL (roadmap issue 8, strict-reject). A leader whose
// lastHeartbeatAt is older than this is considered dead and may be replaced by a fresh claim.
// Defaults to LOCK_STALE_MS so the leader lease shares the lock-staleness contract; this is a
// deliberate trade-off documented in operations.md (60s crash-recovery blind spot).
export const ORCHESTRATOR_LEADER_STALE_MS = LOCK_STALE_MS;

// Stable error code for the orchestrator-leader gate. Surfaced verbatim by every category A/B
// call site so callers / ops can act on it. NOT a new model-facing tool.
export const ERR_ORCHESTRATOR_LEADER_DENIED = "ORCHESTRATOR_LEADER_DENIED";

// Stable error code for orchestrator-authority-required tools that today have no authority check.
// Thrown by tools that this issue elevates to orchestrator-only (swarm_create_task,
// swarm_stop_agent, swarm_release_agent_task, swarm_reconcile(mark=true)). NOT a new tool.
export const ERR_ORCHESTRATOR_AUTHORITY_REQUIRED = "ORCHESTRATOR_AUTHORITY_REQUIRED";

// Stable error code for the orchestrator-pane reject guard in swarm_send_keys (issue 12 C6 micro-fix).
// Thrown when the resolved tmux target equals the orchestrator record's tmuxTarget (typically
// "unknown"), so a future refactor cannot silently route raw keystrokes into the orchestrator host
// pane. Principle-based: fires on target equality, not on agentId, so ghost agents mis-stamped to
// "unknown" are also rejected. NOT a new tool.
export const ERR_ORCHESTRATOR_PANE_REJECTED = "ORCHESTRATOR_PANE_REJECTED";

export const SEND_SETTLE_MS = 700;

export const SPAWN_SETTLE_MS = 2_500;

export const SYSTEM_START = "[PI-SWARM SYSTEM MESSAGE]";

export const SYSTEM_END = "[/PI-SWARM SYSTEM MESSAGE]";

export const DEFAULT_MODEL = "glm-5.1";

export const DEFAULT_PROVIDER = "zai-coding-cn";

export const FAST_MODEL = "gpt-5.4-mini";

export const FAST_PROVIDER = "openai";

// Model pool defaults.
export const POOL_COOLDOWN_MS = 15 * 60 * 1000; // bench a failing slot for 15 minutes

export const POOL_MAX_RETRIES = 2; // consecutive failures before cooldown

// === Issue 20: pool-scaffold on orchestrator session_start ===
// Placeholder written into `.pi/settings.json` when `swarm.modelPool` (or
// `extensions.swarm.modelPool` — runtime precedence) is absent. Deliberately
// `null` so validateSwarmSettings flags it (`slot_empty_model`) and the user
// is steered toward replacing it with a real slot. The shape follows
// ModelSlot (extra fields omitted) so the JSON parses cleanly; the type
// assertion narrows `null` past ModelSlot's `model: string` invariant.
export const POOL_SCAFFOLD_PLACEHOLDER = [{ model: null as any, provider: null as any }];

// One-shot notify text surfaced to the orchestrator TUI on first scaffold.
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
// orchestrator. Such a session is inert for swarm coordination (no agent record, no orchestrator pump,
// no orchestrator heartbeat refresh); it is a stable, clearly-non-orchestrator id so tool defaults
// (e.g. swarm_check_mailbox / swarm_send_message) cannot leak or impersonate orchestrator traffic.
export const SWARM_GUEST_ID = "swarm-guest";

export const NODE_ICON: Record<TaskNodeStatus, string> = {
	done: "✓", ready: "●", assigned: "●", in_progress: "●", blocked: "⚠", failed: "✗", skipped: "⊘", pending: "○", cancelled: "⊗",
};

export const SAFE_ID_RE = /^[a-z0-9_-]+$/;

// Allowed non-orchestrator node status transitions. Terminal states (done/failed/skipped/cancelled) cannot
// regress without an orchestrator override. The orchestrator bypasses this map entirely.
// `cancelled` is reachable from every non-terminal state by an orchestrator-explicit cancelTask
// (a worker CANNOT cancel; cancelTask requires orchestrator authority + force). Workers attempting to
// transition INTO cancelled are rejected with NODE_TRANSITION_FORBIDDEN.
export const ALLOWED_NODE_TRANSITIONS: Record<string, Set<string>> = {
	pending: new Set(["ready", "assigned", "blocked", "skipped", "failed", "cancelled"]),
	ready: new Set(["assigned", "blocked", "skipped", "cancelled"]),
	assigned: new Set(["in_progress", "done", "failed", "blocked", "ready", "cancelled"]),
	in_progress: new Set(["done", "failed", "blocked", "cancelled"]),
	blocked: new Set(["assigned", "in_progress", "ready", "skipped", "cancelled"]),
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

// Cooldown for the agent_settled->orchestrator "settled with open work" notify, so repeated settles in
// a window don't multiply into a message storm. Loop-safe: notify targets the mailbox-only
// orchestrator (never the worker), and is rate-limited per agent via persisted lastSettleNotifyAt.
export const SETTLE_NOTIFY_COOLDOWN_MS = 2 * 60 * 1000;

// Orchestrator auto-pump session-safety bounds. Each orchestrator-context session surfaces a message
// at most once (per-session dedup); the scan window bounds work + re-surface blast radius, the id cap
// bounds a long-lived session's ledger, and the TTL prunes dead validation-session pids.
export const PUMP_SCAN_WINDOW = 50;

export const PUMP_SESSION_ID_CAP = 200;

export const PUMP_SESSION_TTL_MS = 60 * 60 * 1000;

// Bounded re-trigger of action-expected (requiresAck) orchestrator notifications. A message surfaced +
// triggered once but still unacked is re-delivered with a fresh triggerTurn after this delay, up to MAX
// times, so a nudge that landed while the orchestrator was busy (and thus only ever followUp-delivered,
// or triggered once and then ignored) is not silently lost. Informational (requiresAck:false) messages
// get exactly one triggered delivery — sufficient, since the orchestrator was already prompted. Caps
// prevent spam; the per-tick pump + agent_settled hook supply the retry cadence.
export const PUMP_RETRIGGER_DELAY_MS = 60 * 1000;

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
// the same orchestrator session that armed the spawn entry calls swarm_assign_task within this
// window, the orphan watch is pre-cleared and the timer is cancelled.
//
// Default relationship: PREFLIGHT_ASSIGN_GRACE_MS = max(5_000, ORPHAN_SPAWN_WARNING_TIMEOUT_MS - 1_000).
//   - The 1_000 ms safety margin keeps the pre-clear strictly inside the warning window so the
//     timer can never fire for a same-orchestrator flow under any test/env combination of the
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
// orchestrator. `sendNotifyLocked` in reconcile.ts is the single enforcement point: a nudge is only
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
export const NOTIFY_KEY_GRAPH_ADVANCE = "task:{taskId}:node:{nodeId}:nudge:assign";
// Lifecycle-fencing (issue 9): per-(task,agent) dedupe for the agent_settled -> orchestrator
// "settled with open assignment(s)" notify so repeated settles in a window don't storm. Reused by
// the session_shutdown site too via the same predicate gating.
export const NOTIFY_KEY_SETTLE_STALE = "task:{taskId}:agent:{agentId}:nudge:settle-stale";

// Orchestrator pump per-tick batch suppression trace key (issue 11 / binding C6). Emitted on
// EVERY pump tick including total===0 so dashboards counting silent-tick baselines render
// correctly. The trace shape is { ts, cid, total, counts: { reason -> n, ... } }.
export const NOTIFY_KEY_PUMP_BATCH_SUPPRESSED = "swarm.pump.batch_suppressed";

// === Issue 25 Phase 1: minimal-protocol feature gate ===
// Read once at module load (mirrors ORPHAN_SPAWN_WARNING_TIMEOUT_MS pattern). Default 0 — the
// existing explicit ACK/requiresAck/reconcile semantics remain authoritative and no durable
// lifecycle mutations happen until the rollout review flips gate=1.
export const PI_SWARM_MINIMAL_PROTOCOL =
	(process.env.PI_SWARM_MINIMAL_PROTOCOL === "1" || process.env.PI_SWARM_MINIMAL_PROTOCOL === "true") ? 1 : 0;

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
// filtered. Execution-time authority checks (requireOrchestratorAuthority) remain authoritative —
// tier-gating is the first gate, authority is the second.
export const WORKER_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
	"swarm_check_mailbox",
	"swarm_send_message",
	"swarm_update_task",
	"swarm_task_status",
	"swarm_reconcile", // worker surface limits this to dryRun:true + scope:"self" at execution time
]);

export const ORCHESTRATOR_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
	// Worker surface (inherited):
	"swarm_check_mailbox",
	"swarm_send_message",
	"swarm_update_task",
	"swarm_task_status",
	"swarm_reconcile",
	// Orchestration surface (5 additional):
	"swarm_agent_status",
	"swarm_list_agents",
	"swarm_spawn_agent",
	"swarm_create_task",
	"swarm_assign_task",
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

// Back-off window after MAX_CONSECUTIVE_NUDGES_DEFAULT nudges without a resolve. The pump skips the
// next N ticks (decrementing each tick) before re-evaluating; if the counter is still at cap and the
// goal is still set + idle, the pump re-enters the back-off cycle.
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

// Semantic dedupe key template for the task-graph-state idle nudge. Per-(taskId) key so the pump
// never emits a duplicate nudge for the same stalled task. Validated via SAFE_ID_RE inside
// formatNotifyKey; the `taskId` substitution must satisfy /^[a-z0-9_-]+$/.
export const NOTIFY_KEY_TASK_GRAPH_STALL = "task:{taskId}:nudge:graph-stall";

// Semantic dedupe key template for the goal idle-streak nudge. One nudge per (goal, idle-streak)
// so the orchestrator mailbox never sees duplicate nudges for the same goal emission. Validated via
// SAFE_ID_RE inside formatNotifyKey; the `goalId` substitution must satisfy /^[a-z0-9_-]+$/.
export const NOTIFY_KEY_GOAL_IDLE_NUDGE = "goal:{goalId}:nudge:idle-streak";

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
