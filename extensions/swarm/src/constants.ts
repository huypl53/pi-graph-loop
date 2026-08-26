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
