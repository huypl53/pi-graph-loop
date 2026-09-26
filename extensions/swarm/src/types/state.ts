import type { RecentSpawn, SwarmAgent } from "./agents.ts";
import type { MessageRecord, RootReceiptEntry } from "./messages.ts";
import type { ModelSlot, RotationConfig } from "./pool.ts";
import type { TaskState } from "./tasks.ts";

export type SwarmSettings = {
	defaultModel?: string;
	defaultProvider?: string;
	// Model pool: multiple model/provider candidates with weights and rotation. When present,
	// spawn/restart pick from the pool (respecting health/cooldown) instead of the single default.
	modelPool?: ModelSlot[];
	rotation?: RotationConfig;
	// Terminal manager override ("herdr" | "tmux"). Precedence at the driver factory:
	// env PI_SWARM_TERMINAL_MANAGER > this cfg > tmux default. Live-wired 2026-09-26 (H2);
	// previously declared-but-unwired (the yml key was silently ignored).
	terminalManager?: string;
};

// Multi-root policy (roadmap issue 8, strict-reject): a single durable leader record on
// SwarmState identifies the live root. Every root-authoritative mutation must
// refresh lastHeartbeatAt via heartbeatRootLeader; a second concurrent root is
// rejected with ROOT_LEADER_DENIED. Absent or stale = vacant.
export type RootLeader = {
	pid: number;
	sessionStartedAt: string;
	claimedAt: string;
	lastHeartbeatAt: string;
	agentRecordId?: string;
};

// Per-task task-graph-state idle nudge state (Issue 23). One entry per stalled task; the root
// pump increments consecutiveNoResolveNudges on each emitted nudge and resets the counter when the
// task graph advances (reassignment, claim, or task leaving in_progress). Anti-loop cap at
// MAX_TASK_STALL_NUDGES; back-off at GOAL_NUDGE_BACKOFF_TICKS. Mirrors SwarmGoal's shape.
// Row 68: emissions and back-off decrements are interval-spaced via nextStallNudgeAt — pump tick
// rate no longer drives the cadence (mirrors the goal nudge's nextGoalNudgeAt gate).
export type SwarmTaskStallState = {
	taskId: string; // safe-id (validated by formatNotifyKey)
	consecutiveNoResolveNudges: number; // monotonic; reset when node leaves ready+unassigned or task leaves in_progress
	nudgeSeq?: number; // monotonic emit counter (NEVER reset) — idempotency key component so each nudge gets a fresh dedupe slot
	lastNudgeAt?: string; // ISO; set on every successful nudge emission
	lastResolvedAt?: string; // ISO; set on every successful counter reset
	backoffTicksRemaining?: number; // 0..GOAL_NUDGE_BACKOFF_TICKS; when >0 the pump skips the next interval opportunit(ies)
	nextStallNudgeAt?: string; // ISO; earliest ts the next stall nudge/backoff decrement may fire (interval spacing)
};

// Per-(taskId, nodeId) monotonic seq store for the graph-advance safety net (Issue F2,
// task-202608310422). Mirrors the per-task shape of SwarmTaskStallState but at node granularity so a
// single task with multiple ready-but-unassigned nodes keeps independent counters. The seq is the
// `{seq}` slot in NOTIFY_KEY_GRAPH_ADVANCE — it is NEVER reset (survives acks + node-leaves/re-enters
// ready) so a future re-stall still climbs past the cap rather than starting over. lastResolvedAt is
// stamped (without resetting nudgeSeq) when the node leaves ready+unassigned — see
// reconcileGraphAdvanceLocked:170-180. Bounded by active task surface; pruned alongside the message
// ledger by swarm_gc.
export type SwarmGraphAdvanceNudgeState = {
	[taskId: string]: {
		[nodeId: string]: {
			nudgeSeq?: number; // monotonic emit counter (NEVER reset)
			lastNudgeAt?: string; // ISO; set on every successful emit
			lastResolvedAt?: string; // ISO; set when node leaves ready+unassigned (seq survives)
		};
	};
};

// Durable goal the root wants the swarm to advance toward (Issue 18). Set via
// `swarm_set_goal` / `/swarm goal set <text>`; cleared via `swarm_mark_goal_done` / `/swarm goal done`.
// While set and ALL non-root agents are runtimeStatus="idle" with zero active task nodes,
// the root pump emits an idempotent idle-streak nudge (anti-loop: at most
// MAX_CONSECUTIVE_NUDGES_DEFAULT consecutive, then a GOAL_NUDGE_BACKOFF_TICKS-tick back-off). Any
// root turn that ends stopReason="stop" resets the consecutiveNoResolveNudges counter and
// clears back-off (turn_end branch in hooks.ts).
export type SwarmGoal = {
	id: string; // stable goalId (e.g. "goal-<ms>-<rand6>")
	text: string; // the goal text the root set
	setAt: string; // ISO; durable on set
	setBy: string; // agentId that set it (root in practice; recorded for audit)
	// Issue 81: durable origin metadata so a standing user goal cannot be silently cleared by
	// batch workflow. Absent on pre-policy goals (== historical default; legacy goals treat as
	// origin="root" for the guard, which is the LENIENT pre-policy path). New goals stamp
	// origin explicitly via swarm_set_goal({ origin }) or default to "root" for backwards-
	// compatible tool behavior. See classifyGoalClearAuthority in goals.ts.
	origin?: "user" | "root" | "system" | "batch";
	// Human-readable provenance hint ("pm-cli", "batch-worker-r80", etc.) — not enforced by the
	// guard but useful for audit traces. Optional; absent on pre-policy goals.
	setByScope?: string;
	consecutiveNoResolveNudges: number; // monotonic; reset on root turn_end {stop} resolve
	nudgeSeq?: number; // monotonic emit counter (NEVER reset, survives resolve) — idempotency key component so each nudge gets a fresh dedupe slot
	nudgeIntervalMs?: number; // optional durable per-goal idle interval override; positive integer milliseconds only
	maxNudges?: number; // optional durable per-goal max consecutive nudges before back-off (-1 for infinite, or positive integer)
	lastNudgeAt?: string; // ISO; set on every successful nudge emission
	lastResolvedAt?: string; // ISO; set on every successful counter reset
	backoffTicksRemaining?: number; // 0..GOAL_NUDGE_BACKOFF_TICKS; when >0 the pump skips the next tick(s)
	// R16 (2026-09-02): track root turns that did NOT resolve the goal (pure ack text or
	// silent) so dashboards can distinguish ack from resolve. Not used by the evaluator — purely
	// observational metadata that mirrors the `goal.nudge.turn_no_resolve_action` trace.
	lastNonResolveTurnAt?: string;
	lastResolveActionAt?: string;
	lastResolveActionTools?: string[];
};

// Row 68 idle-nudge state. `allIdleSinceAt` anchors the continuous all-idle interval used by the
// goal fallback; `lastGoalNudgeAt` and `goalConsecutiveNoResolveNudges` keep the emission/backoff
// accounting on actual nudge emissions rather than pump ticks.
// R14 (2026-09-02): `lastWasVacuous` is the once-per-transition dedupe gate for the
// `goal.nudge.held_no_live_workers` trace; `lastPoolEmptyEscalationAt` is the cooldown
// anchor for the bounded user-origin escalation nudge.
// R23 (2026-09-02): `r23LastEpochAnchor` is the once-per-anchor memo for the cap-branch
// saturation reset. Cleared at the anchor mint (updateIdleEpochLocked — R23C) and stamped
// by the cap branch itself only AFTER a reset, so the reset fires at most once per anchor
// (a legacy memo===anchor state is also cleared by the cap branch's stale-memo check).
// R23B (2026-09-02): `lastEpochBusyAgents` is the worker-breaker guard for the cap-branch
// reset — the PROVENANCE of the most recent anchor clear. Stamped at every anchor-clear
// site (the busy edge in updateIdleEpochLocked stamps real worker ids; since R23C the
// hooks.ts turn_start handler stamps ["root"]) and PRESERVED across the anchor
// mint (R23C — the previous mint-clear left the cap branch blind to provenance), so it
// survives from the clear site to the next atCap evaluation. The reset fires only when
// this array contains at least one NON-root id (a worker caused the break) —
// root-turn churn does NOT qualify. Absent (legacy state that never saw a clear)
// → reset, matching pre-R23B behavior.
export type SwarmIdleNudgeState = {
	allIdleSinceAt?: string;
	nextGoalNudgeAt?: string;
	lastGoalNudgeAt?: string;
	goalConsecutiveNoResolveNudges?: number;
	goalBackoffTicksRemaining?: number;
	lastGoalActiveTaskScanAt?: string;
	lastGoalActiveTaskWork?: { taskId: string; nodeId: string; assignee?: string; status: "assigned" | "in_progress" } | null;
	lastWasVacuous?: boolean;
	lastPoolEmptyEscalationAt?: string;
	r23LastEpochAnchor?: string;
	lastEpochBusyAgents?: string[];
	// === R27 (2026-09-04): task-independent goal floor — check-streak debounce state ===
	// goalIdleCheckCount accumulates one per consecutive all-idle sample spaced
	// GOAL_IDLE_CHECK_INTERVAL_MS apart; a busy/vacuous/in-flight sample (or an emission)
	// resets it to zero. goalIdleLastCheckAt enforces the check spacing — pump ticks
	// closer than the check interval do NOT advance the streak.
	goalIdleCheckCount?: number;
	goalIdleLastCheckAt?: string;
	lastLongRunningToolNudges?: Record<string, string>;
};

// Checkpoint marker created via /swarm mark / /swarm-mark for timeline debugging.
export type SwarmMarker = {
	id: string;
	label: string;
	ts: string;
	updatedAt?: string;
	note?: string;
	gitHead?: string;
	activeAgents: string[];
	inFlightTasks: string[];
	by: string;
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

export type SwarmState = {
	version: number;
	swarmId: string;
	cwd: string;
	tmuxSession: string;
	agents: Record<string, SwarmAgent>;
	delivered: Record<string, string[]>;
	markers?: Record<string, SwarmMarker>;
	// Multi-root leader lease (issue 8). Addditive; readState back-fills undefined for
	// pre-policy swarms so first mutation claims vacant. See identity.ts:readRootLeader /
	// heartbeatRootLeader / claimRootLeader for the gate semantics.
	rootLeader?: RootLeader;
	// Per-session surfaced-id ledgers for the root auto-pump, keyed by consumer pid. Each
	// root-context session (the long-lived PM, a validation `pi -p` run, another PM lane) tracks
	// the ids IT has surfaced, so one session cannot mark a notification consumed and starve a different
	// PM session. Separate from `delivered` (the check_mailbox/ack ledger).
	rootPumpSessions?: Record<
		string,
		{ ids: string[]; triggeredAt?: Record<string, string>; retriggerCount?: Record<string, number>; lastAt: string }
	>;
	// Per-worker surfaced ledger for the session-start mailbox auto-surface (idempotent per message).
	agentSurfaced?: Record<string, string[]>;
	// Durable recipient receipt ledger for the root mailbox consumer (issue 11). Primary
	// dedupe gate that survives PID restart/recycle; replaces the per-pid `rootPumpSessions[*].ids`
	// (which is now session-bounded and only counts retriggers). `revision` bumps on every write so a
	// stale read can detect concurrent consumer activity; `0` = no writes yet (triggers one-time
	// migration back-fill on first pump).
	consumerReceipts?: {
		root?: {
			entries?: Record<string, RootReceiptEntry>;
			revision?: number;
		};
	};
	lastLoopReconcileAt?: string; // throttle for the loop-watcher reconcile (detect "plan recorded but graph still closed")
	// Incremental mailbox read checkpoint for the root pump (issue B): byte offset already
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
	// Durable swarm goal (Issue 18): set by the root via swarm_set_goal / /swarm goal set;
	// cleared by swarm_mark_goal_done / /swarm goal done. While set + all non-root agents
	// idle + no active task nodes, the root pump emits an idempotent idle-streak nudge with
	// an anti-loop counter and 2-tick back-off. Optional; absent (== no goal) is the default. The
	// readState back-fill intentionally leaves this field as-is on legacy swarms: a JSON file with
	// no `goal` key parses to `undefined`, which is the correct initial state — a future maintainer
	// MUST NOT add `st.goal ||= {}` here, since that would replace undefined with an empty object
	// and crash `goal.id` access in the pump.
	goal?: SwarmGoal;
	// Row 68 idle-epoch bookkeeping (swarm-level, not goal-level): tracks when the effective-live
	// non-root set last became all-idle and the interval anchor for the goal fallback
	// backoff loop.
	idleNudgeState?: SwarmIdleNudgeState;
	// Issue 23 — task-graph-state idle nudge. Per-(taskId) counter + back-off so a stalled
	// task graph doesn't spam the root's mailbox. Reset on first reassignment of the
	// actionable node OR on the task leaving `in_progress` state.
	taskStallState?: Record<string, SwarmTaskStallState>;
	// Issue F2 (task-202608310422): per-(taskId, nodeId) monotonic nudgeSeq store for the graph-advance
	// safety net. The seq is the `{seq}` slot in NOTIFY_KEY_GRAPH_ADVANCE so each successful emit gets a
	// fresh dedupe slot. NEVER reset (survives acks + node-leaves/re-enters ready); the durable map is
	// bounded by the active task surface and pruned alongside the message ledger by swarm_gc. Absent on
	// pre-policy swarms — lazily initialized inside reconcileGraphAdvanceLocked's lock.
	graphAdvanceNudgeState?: SwarmGraphAdvanceNudgeState;
	// Issue 83c — proxy metric snapshot surfaced by the pump + /swarm metrics.
	proxyMetrics?: { hungButAlive: number; staleOpen: number; supersessionChurn: number; lastEmitAt?: string };
	// Issue 20: pool-scaffold write-once flag. Set by the root session_start hook AFTER the
	// first successful `.pi/settings.json` scaffold + notify emission. Absent === never notified, which
	// is the correct initial state. `readState` does NOT back-fill this field (mirrors `goal`): a
	// pre-policy swarm-state.json file parses absent keys to `undefined`, and `undefined` means
	// "next session_start should scaffold + notify". Setting this to a non-empty string suppresses the
	// notify on every subsequent session_start and /reload until the swarm dir is cleared (clean slate).
	poolScaffoldNotifiedAt?: string;
	// Auto-focus busy agent in tmux when an agent settles. Toggled via /swarm auto-focus.
	autoFocusBusy?: boolean;
	lastFocusAt?: string;
	lastFocusedAgentId?: string;
	messages: Record<string, MessageRecord>;
	createdAt: string;
	updatedAt: string;
};
