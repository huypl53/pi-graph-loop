// === swarm/src/surface.ts ===
// Module boundary: root-facing message surface machinery.
//   - orchSession              — session gate + retrigger counter source-of-truth
//   - runtimeTaskWarnings      — task.json closure/warning extractor
//   - isActionableRootMessage — predicate gating root-visible PM surfacing
//   - staleSurfaceReason       — actionable→stale edge reasoning (fingerprint + reason code)
//   - pumpRootMailbox  — the per-tick surface pump (R10-1 boundary)
//   - traceStaleSuppressedOnce — dedupe helper for the stale→suppressed transition
//
// Why co-located: the root surface is a single end-to-end path (predicate → pump →
// deliver), and each step hands off the next step's inputs.
//
// Depends on: status-predicates (for terminal/abandoned task check), goal-epoch (for
// allEffectiveIdleAgents — the pump consults the live idle pool before stamping surfaces),
// mailbox (for deliverMessageLocked), identity (for leader lease), tmux (for probe).
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RootReceiptEntry, Paths, SwarmMessage, SwarmState, TaskState } from "./types.ts";
import {
  ACK_MISSING_MS, ARTIFACT_PROGRESS_ACTIVE_AGENT_SKIP_MS, ARTIFACT_PROGRESS_GRACE_MS, ARTIFACT_PROGRESS_MAX_FILES, ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS, ARTIFACT_PROGRESS_NUDGE_CAP, DEFAULT_AGENT_HEARTBEAT_STALE_MS, DEFAULT_STALE_OPEN_THRESHOLD_MS, formatNotifyKey, GOAL_NUDGE_BACKOFF_TICKS, GOAL_NUDGE_IDLE_INTERVAL_MS, MAX_ATTEMPTS, MAX_CONSECUTIVE_NUDGES_DEFAULT, MAX_REINJECTS, MAX_STATUS_TASKS, MAX_TASK_STALL_NUDGES, NOTIFY_DEFAULT_COOLDOWN_MS, NOTIFY_DEFAULT_MAX_NUDGES, NOTIFY_KEY_GOAL_IDLE_NUDGE, NOTIFY_KEY_GRAPH_ADVANCE, NOTIFY_KEY_INITIAL_READY, NOTIFY_KEY_PUMP_BATCH_SUPPRESSED, NOTIFY_KEY_TASK_GRAPH_STALL, PI_SWARM_MINIMAL_PROTOCOL, PUMP_RETRIGGER_DELAY_MS, PUMP_RETRIGGER_MAX, PUMP_SCAN_WINDOW, PUMP_SESSION_ID_CAP, PUMP_SESSION_TTL_MS, PUMP_STUCK_DEFER_ESCALATE_MS, REINJECT_AFTER_MS, TASK_INITIAL_READY_GRACE_MS, TASK_NUDGE_MS, TASK_STALE_MS, TASK_STALL_NUDGE_IDLE_INTERVAL_MS, TERMINAL_NODE_STATUSES, TRACE_AGENT_HEARTBEAT_GC_EXPIRED_PARK_FLIPPED, TRACE_AGENT_HEARTBEAT_GC_PROBE_THROTTLED, TRACE_AGENT_HEARTBEAT_GC_STALE, TRACE_AGENT_HEARTBEAT_GC_STOPPED, TRACE_AGENT_TMUX_LIVENESS_CORRECTION, TRACE_ARTIFACT_PROGRESS_CAP_EXCEEDED, TRACE_ARTIFACT_PROGRESS_NUDGE, TRACE_GRAPH_ADVANCE_NUDGE_EMITTED, TRACE_LATE_RESULT_REJECTED, TRACE_LIFECYCLE_DERIVED, TRACE_LIFECYCLE_DERIVED_SHADOW, TRACE_MESSAGE_ATTENTION_DERIVED, TRACE_STALE_OPEN_SURFACED } from "./constants.ts";
import { capMap, ensureAgentDefaults, inferRoleKind, now } from "./utils.ts";
import { computeReadyNodes, computeTaskStatus, deriveNodeAttention, proxyMetricEmitLocked, staleOpenAssignmentScanLocked, staleOpenNudgeLocked } from "./taskgraph.ts";
import { currentAgentId } from "./session.ts";
import { deliver, deliverMessageLocked, deriveLifecycleFromTrigger, findIdempotentMessage, isResponseTrackingActive, readMailbox, readMailboxCached, upsertMessageRecord } from "./mailbox.ts";
import { claimRootLeader, ensureRoot, heartbeatRootLeader, readRootLeader, requireRootAuthority } from "./identity.ts";
import { formatSwarmMessageContent, isDeliveryFailureRetryable } from "./delivery.ts";
import { isPanePiLike, isTmuxRunning, tmux } from "./tmux.ts";
import { readState, readTaskState, taskPaths, trace, traceTask, withLock, writeState, writeTaskState } from "./state.ts";
import { agentHeartbeatGCLocked, evaluateArtifactProgressNudgeLocked, evaluateSlotRecoveryLocked, evaluateTaskGraphStallNudgeLocked, reconcileGraphAdvanceLocked, reconcileInitialReadyLocked, sendGraphAdvanceNudgeLocked } from "./nudges/graph-advance.ts";
import { allEffectiveIdleAgents, updateIdleEpochLocked } from "./nudges/goal-epoch.ts";


import { isStallNudgeEligibleTaskStatus, isTerminalOrAbandonedTaskStatus } from "./nudges/status-predicates.ts";

// Module boundary: root-facing message surface machinery.
//   - orchSession              — session gate + retrigger counter source-of-truth
//   - runtimeTaskWarnings      — task.json closure/warning extractor
//   - isActionableRootMessage — predicate gating root-visible PM surfacing
//   - staleSurfaceReason       — actionable→stale edge reasoning (fingerprint + reason code)
//   - pumpRootMailbox  — the per-tick surface pump (R10-1 boundary)
//   - traceStaleSuppressedOnce — dedupe helper for the stale→suppressed transition

// Why co-located: the root surface is a single end-to-end path (predicate → pump →
// deliver), and each step hands off the next step's inputs.

// Depends on: status-predicates (for terminal/abandoned task check), goal-epoch (for
// allEffectiveIdleAgents — the pump consults the live idle pool before stamping surfaces),
// mailbox (for deliverMessageLocked), identity (for leader lease), tmux (for probe).




export async function runtimeTaskWarnings(pi: ExtensionAPI, st: SwarmState, task: TaskState): Promise<string[]> {
	const warnings: string[] = [];
	const nowMs = Date.now();
	for (const [id, node] of Object.entries(task.nodes)) {
		if (!node.assignee) continue;
		if (node.status !== "ready" && node.status !== "assigned" && node.status !== "in_progress") continue;
		const agent = st.agents[node.assignee];
		if (!agent && node.assignee !== "root") {
			warnings.push(`node ${id} assigned to missing agent ${node.assignee}`);
		} else if (agent) {
			ensureAgentDefaults(agent);
			if (agent.status === "stopped" || agent.health === "unhealthy") warnings.push(`node ${id} assignee ${agent.id} is ${agent.status}/${agent.health}`);
			const expectedKind = inferRoleKind(node.assignee, node.role);
			if (agent.roleKind !== expectedKind) warnings.push(`node ${id} role "${node.role}" expects ${expectedKind} but ${agent.id} is ${agent.roleKind}`);
			if (agent.activeTaskIds.length >= agent.maxConcurrentTasks && !agent.activeTaskIds.includes(task.taskId)) warnings.push(`node ${id} assignee ${agent.id} at capacity (${agent.activeTaskIds.length}/${agent.maxConcurrentTasks})`);
			if (agent.tmuxTarget && agent.tmuxTarget !== "unknown" && (node.status === "assigned" || node.status === "in_progress")) {
				const alive = await isTmuxRunning(pi, agent.tmuxTarget);
				if (!alive) warnings.push(`node ${id} assignee ${agent.id} tmux pane not alive`);
			}
		}
		for (const msgId of node.messageIds || []) {
			const rec = st.messages[msgId];
			if (!rec) { warnings.push(`node ${id} references missing message ${msgId}`); continue; }
			if (rec.superseded) continue; // superseded assignments are waived; not current work
			if (rec.status === "dead_letter") warnings.push(`node ${id} assignment/handoff message ${msgId} is dead-lettered (${rec.lastError || "unknown"})`);
			if (rec.requiresAck && !rec.ackedAt) warnings.push(`node ${id} message ${msgId} requires ack but is ${rec.status}`);
			// Assignment acked done but the node was never advanced past assigned/in_progress.
			if (rec.lastAck?.status === "done" && (node.status === "assigned" || node.status === "in_progress")) warnings.push(`node ${id} message ${msgId} acked done but node is still ${node.status}`);
		}
		if (node.status === "in_progress" && node.lastActivityAt) {
			const age = nowMs - new Date(node.lastActivityAt).getTime();
			if (age > 24 * 60 * 60 * 1000) warnings.push(`node ${id} in_progress for ${Math.round(age / 3_600_000)}h without update`);
		}
		// Terminal nodes must have released their advisory edit locks.
		if (TERMINAL_NODE_STATUSES.has(node.status)) {
			for (const [file, lock] of Object.entries(task.editLocks)) if (lock?.nodeId === id) warnings.push(`terminal node ${id} still holds editLock for ${file}`);
		}
	}
	// Attention derivation (roadmap issue 5): durable, pane-free recovery classification per node.
	// Advisory only — appended to the existing runtime=true warnings surface, zero schema change.
	for (const [id, node] of Object.entries(task.nodes)) {
		const att = deriveNodeAttention(st, task, id, nowMs);
		if (!att.workerReminderEligible) continue;
		warnings.push(`attention: node ${id} → ${att.category} (assignee ${node.assignee || "?"}) — ${att.evidence.join("; ")} — root may send one bounded reminder via /swarm remind ${task.taskId} ${id}`);
	}
	if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
		for (const agent of Object.values(st.agents)) {
			ensureAgentDefaults(agent);
			if (agent.activeTaskIds.includes(task.taskId)) warnings.push(`task ${task.taskId} is ${task.status} but still in ${agent.id}.activeTaskIds`);
		}
	}
	return warnings;
}

export function orchSession(st: SwarmState, nowMs: number): { ids: string[]; triggeredAt?: Record<string, string>; retriggerCount?: Record<string, number>; lastAt: string } | null {
	if (currentAgentId() !== "root") return null;
	st.rootPumpSessions ||= {};
	const key = String(process.pid);
	if (!st.rootPumpSessions[key]) st.rootPumpSessions[key] = { ids: [], lastAt: new Date(nowMs).toISOString() };
	return st.rootPumpSessions[key];
}

// === Graph-advance watcher: detect a READY-but-unassigned node and nudge the root to assign it. ===
// This is the mid-graph counterpart to the loop watcher. The loop watcher drives iteration boundaries
// (plan / reopen / execute); this drives the nodes IN BETWEEN. The observed failure: when a worker
// completes a node and sends a result message, the message is informational (requiresAck:false), so the
// root often DESCRIBES the next step ("implement_change now just needs to...") instead of ACTING
// (calling swarm_assign_task), and the graph stalls with the next node ready-but-unassigned and nothing
// prompting the root to move. This watcher is a safety net: after ~LOOP_RECONCILE_INTERVAL_MS of a
// node being ready-but-unassigned, it nudges the root with the exact assign call. Idempotent per
// (task,node); auto-acked once the node is assigned/terminal. The harness never assigns (the root
// Issue F2 (task-202608310422): graph-advance nudge key now carries a per-(taskId, nodeId) monotonic
// seq suffix. The pre-fix static key allowed exactly one mailbox nudge per (taskId, nodeId) for the
// node's lifetime (mailbox.ts:237-245 dedupes on from+to+idempotencyKey regardless of ackedAt), so
// the re-arm policy (cap + cooldown + acked-not-in-flight gate chain, added in 7994451) was reachable
// but never produced a NEW message — only `message.idempotent_reuse` traces. The seq-suffix mirrors
// the goal-nudge `nudgeSeq` (reconcile.ts:528) and task-stall `nudgeSeq` (reconcile.ts:715) patterns:
// `seq` advances only on a successful emit, so same-tick double-emits still dedupe via
// `findIdempotentMessage`, while a fresh tick after ack + cooldown gets a fresh slot.
//
// Cap + cooldown semantics unchanged — only the per-emit key uniqueness changed. Cap is still
// NOTIFY_DEFAULT_MAX_NUDGES sends per (taskId, nodeId) across the node's lifetime (the prior-scan now

function ackRootNudgeLocked(st: SwarmState, key: string, nowMs: number, note: string): void {
	const rec = findIdempotentMessage(st, "root", "root", key) || Object.values(st.messages || {}).find((r) => r.to === "root" && r.idempotencyKey === key);
	if (rec && rec.requiresAck && !rec.ackedAt) {
		const at = new Date(nowMs).toISOString();
		st.messages[rec.id] = { ...rec, status: "acked", ackedAt: at, updatedAt: at, lastAck: { by: "root", status: "done", note, at } };
		st.delivered["root"] = Array.from(new Set([...(st.delivered["root"] || []), rec.id]));
	}
}

// Issue F2 (task-202608310422): with the seq-suffixed graph-advance key, there is no single static key
// to clear when a node leaves ready+unassigned — there can be up to NOTIFY_DEFAULT_MAX_NUDGES open
// records (each at a different seq) for the same (taskId, nodeId). This helper auto-acks every open
// seq-suffixed record for the pair. Idempotent w.r.t. already-acked records (the inner guard skips
// records with `ackedAt`). Mirror of ackRootNudgeLocked but matching the seq-prefix set.
function ackRootGraphAdvanceNudgesLocked(st: SwarmState, taskId: string, nodeId: string, nowMs: number, note: string): void {
	const keyPrefix = `task:${taskId}:node:${nodeId}:nudge:assign:seq:`;
	const at = new Date(nowMs).toISOString();
	const ids: string[] = [];
	for (const rec of Object.values(st.messages || {})) {
		if (rec.to !== "root") continue;
		if (!(rec.idempotencyKey?.startsWith(keyPrefix) ?? false)) continue;
		if (!rec.requiresAck || rec.ackedAt) continue;
		st.messages[rec.id] = { ...rec, status: "acked", ackedAt: at, updatedAt: at, lastAck: { by: "root", status: "done", note, at } };
		ids.push(rec.id);
	}
	if (ids.length) {
		st.delivered["root"] = Array.from(new Set([...(st.delivered["root"] || []), ...ids]));
	}
}

// Watcher entry point for mid-graph stalls. For every active (in_progress) task, find actionable nodes

// Initial-ready watcher (reliability-roadmap Phase 1, P0 #2): for every freshly created task whose
// start node remains READY + unassigned beyond TASK_INITIAL_READY_GRACE_MS, send exactly one
// Helper to parse taskId/nodeId from conversationId (format: "task:${taskId}:${nodeId}").
function parseTaskNodeRef(conversationId: string | undefined): { taskId?: string; nodeId?: string } | null {
	if (!conversationId) return null;
	// Canonical formats observed in production:
	//   - "task:{taskId}:{nodeId}"                — graph-advance nudge (line 844)
	//   - "task:{taskId}:node:{nodeId}:nudge:{kind}:seq:{n}" — stale-open / pool_depleted variants
	// The compact form must be matched first so a 3-segment conversationId is not mis-parsed as
	// the long form (where nodeId would be the literal "node").
	const compact = conversationId.match(/^task:([^:]+):([^:]+)$/);
	if (compact && !["node", "pool_depleted", "nudge"].includes(compact[2])) {
		return { taskId: compact[1], nodeId: compact[2] };
	}
	const long = conversationId.match(/^task:([^:]+):(?:node:([^:]+):nudge:|pool_depleted(?:$|:))/);
	if (long) return { taskId: long[1], nodeId: long[2] || null };
	// Last-resort: any leading "task:{taskId}:" — return taskId without a nodeId so the predicate
	// can still gate on task-terminal status even when the node ref is absent or unknown.
	const taskOnly = conversationId.match(/^task:([^:]+):/);
	if (taskOnly) return { taskId: taskOnly[1], nodeId: undefined };
	return null;
}

// Actionability predicate for historical root PM messages (issue 11, §5). Returns { ok: false }
// for messages that must NOT be surfaced: acked, dead_lettered, superseded, wrong recipient, task
// terminal/cancelled/missing, node terminal/missing/reassigned, retrigger-budget-exhausted, or
// informational already consumed. The `strictForMigration` flag treats retrigger-budget-exhausted as
// non-actionable for the one-time migration back-fill (the budget resets per session). Exported
// for reuse by the migration back-fill block.
export function isActionableRootMessage(
	rec: { id: string; to: string; requiresAck?: boolean; status?: string; ackedAt?: string; superseded?: any; conversationId?: string; idempotencyKey?: string },
	taskIndex: Record<string, TaskState>,
	nowMs: number,
	retriggerCounts: Record<string, number>,
	strictForMigration: boolean,
	p?: Paths,
): { ok: boolean; reason: string } {
	if (rec.ackedAt) return { ok: false, reason: "acked" };
	if (rec.status === "dead_letter") return { ok: false, reason: "dead_letter" };
	if (rec.superseded) {
		// === Issue 83b — rec-level late-result trace (round-4 KR5 fix) ===
		// Mirror the tool-layer TRACE_LATE_RESULT_REJECTED so the rec-level guard (the path that
		// runs in `reconcile` / pump re-trigger / migration back-fill) is also observable in the
		// trace census. The caller MUST thread `p: Paths` so the trace writes through the real
		// `taskPaths(p, taskId)` and lands in the durable events.jsonl. No silent swallow: if the
		// durable write fails we surface it as `swarm.rec_late_result_trace_failed` so the failure
		// is observable in the trace census. The predicate itself never throws.
		if (p) {
			const taskNodeRef = parseTaskNodeRef(rec.conversationId);
			if (taskNodeRef && taskNodeRef.taskId && taskNodeRef.nodeId) {
				const task = taskIndex[taskNodeRef.taskId];
				if (task) {
					const tp = taskPaths(p, task.taskId);
					traceTask(tp, TRACE_LATE_RESULT_REJECTED, { taskId: task.taskId, nodeId: taskNodeRef.nodeId, messageId: rec.id, supersededBy: rec.superseded?.supersededBy, reason: "rec_superseded" })
						.catch((err: any) => {
							// KR5: surface durable-write failure instead of silent swallow.
							return trace(p, "swarm.rec_late_result_trace_failed", { taskId: task.taskId, nodeId: taskNodeRef.nodeId, messageId: rec.id, error: String(err?.message || err) });
						});
				}
			}
		}
		return { ok: false, reason: "superseded" };
	}
	if (rec.to !== "root") return { ok: false, reason: "wrong_recipient" };

	// Task-scoped predicate (covers terminal task, cancelled, terminal node, reassigned node).
	// Parse task/node reference from conversationId, falling back to the canonical
	// idempotencyKey format `task:{taskId}:node:{nodeId}:nudge:{kind}:seq:{n}` (production
	// stale-open / pool_depleted don't always set conversationId, but the idempotencyKey
	// always encodes the task+node ref).
	let taskNodeRef = parseTaskNodeRef(rec.conversationId);
	if ((!taskNodeRef || !taskNodeRef.taskId) && rec.idempotencyKey) {
		const idem = String(rec.idempotencyKey).match(/^task:([^:]+):(?:node:([^:]+):)?/);
		if (idem) taskNodeRef = { taskId: idem[1], nodeId: idem[2] || undefined };
	}
	if (taskNodeRef && taskNodeRef.taskId && taskNodeRef.nodeId) {
		// === R24 result-class exemption (2026-09-03) — task-scoped RESULT messages are not
		// suppressed by node_terminal/task_terminal. The pump's per-tick actionability gate
		// misclassifies these as moot historical alerts (the node they report on IS done), but
		// the recipient — typically the root PM — needs the result visible at the
		// surface to advance the task graph. Live incident 2026-09-02T15:26:06Z:
		// msg-1788362766708-64f55b39 (R23 implement-done result) was durably enqueued
		// (L1/C1 + L1/C2 mailbox_delivered) and durably classified node_terminal in
		// `isActionableRootMessage`, suppressing every pump tick for 5+ minutes
		// (notification.stale.suppressed reason:node_terminal) and only surfacing via a
		// manual swarm_check_mailbox at 15:31:09.993Z. The fix: detect result-class by the
		// minimal fingerprint (requiresAck && !requiresResponse && replyTo set) and treat the
		// message as actionable so the surface plan carries it. Nudges (canonical
		// `task:<id>:node:<id>:nudge:...` idempotencyKey) keep full gating — only the close-out
		// shape is exempted. This predicate is also called from migration back-fill (strictForMigration
		// = true) and re-trigger (false), so the exemption applies uniformly across the call sites
		// that filter the per-tick surface plan.
		// Predicate order: check `isResultClass` FIRST so nudges (which also lack replyTo in our
		// fingerprint) keep falling through to the existing task/node terminal gates.
		const isResultClass = Boolean(rec.requiresAck) && rec.requiresResponse === false && Boolean(rec.replyTo);
		const task = taskIndex[taskNodeRef.taskId];
		if (!task) return { ok: false, reason: "task_missing" };
		if (isResultClass) {
			if (task.status === "done") return { ok: true, reason: "result_class_exempt_task_done" };
			if (task.status === "failed") return { ok: true, reason: "result_class_exempt_task_failed" };
			if (task.status === "cancelled") return { ok: true, reason: "result_class_exempt_task_cancelled" };
		}
		if (task.status === "done") return { ok: false, reason: "task_done" };
		if (task.status === "failed") return { ok: false, reason: "task_failed" };
		if (task.status === "cancelled") return { ok: false, reason: "task_cancelled" };
		const node = task.nodes[taskNodeRef.nodeId];
		if (!node) return { ok: false, reason: "node_missing" };
		if (isResultClass) return { ok: true, reason: "result_class_exempt_node_terminal" };
		if (TERMINAL_NODE_STATUSES.has(node.status)) return { ok: false, reason: "node_terminal" };
		// Reassign race: a later assignment message carries a newer idempotencyKey for the same
		// (task,node) and stamped `superseded` on the prior one. The rec-level superseded flag
		// catches this — but if a stale message was written before the supersede record (race),
		// cross-check by finding the latest assign handoff for the node.
		const lastAssign = [...(task.handoffs || [])].reverse().find(h => h.toNode === taskNodeRef.nodeId && h.kind === "assign");
		if (lastAssign && rec.idempotencyKey && (lastAssign as any).idempotencyKey && (lastAssign as any).idempotencyKey !== rec.idempotencyKey) {
			return { ok: false, reason: "node_reassigned" };
		}
	}

	// Bounded re-trigger gate: a requiresAck message that was surfaced but never acked gets
	// a bounded number of fresh triggerTurns (PUMP_RETRIGGER_MAX). After that, suppress until
	// the message is acked or removed.
	if (rec.requiresAck && !rec.ackedAt) {
		const retriggerCount = retriggerCounts[rec.id] ?? 0;
		if (retriggerCount >= PUMP_RETRIGGER_MAX) {
			// For migration back-fill, treat retrigger-budget-exhausted as non-actionable (the
			// budget resets per session). For the standard pump, this is session-bounded.
			if (strictForMigration) return { ok: false, reason: "retrigger_budget_exhausted" };
			// In the live pump, we still allow it (the retriggerCount is session-bounded and
			// resets on PID change).
		}
	}

	return { ok: true, reason: "actionable" };
}

// Helper to compute a fingerprint for a message record (sha256(messageId:lastUpdatedAt)). Used by
// the consumer receipt ledger to detect silent edits to message records between surfacing and
// reincarnation.
function fingerprintMessage(rec: { id: string; updatedAt?: string; createdAt?: string }): string {
	const ts = rec.updatedAt || rec.createdAt || now();
	return createHash("sha256").update(`${rec.id}:${ts}`).digest("hex");
}

// === Row 68: surface-time revalidation of deferred nudges ===
// Acceptance criterion: "Deferred stale nudge is suppressed if node was assigned or an agent became
// busy before delivery." A nudge queued while a stall condition held may be stale by the time the
// pump is idle and able to surface it. This predicate re-checks at surface time:
//   - goal-idle nudges: suppressed if actionable graph work appeared on a LIVE task, or
//     the idle epoch advanced past the message's creation (stale idle window). R22
//     (2026-09-02): the previous "any effective agent became busy" leg was REMOVED — see
//     the goalKey branch comment below for the emission-vs-surface starvation rationale.
//   - graph-stall nudges: suppressed if agents are busy or no actionable unassigned node remains;
//   - graph-advance / initial-ready nudges: suppressed via checkStallNotificationStale (node
//     assigned/terminal/reassigned/task closed).
// Pure + exported for direct unit testing by idle-nudge.test.mjs (plan §2.3 — the pump's surface
// path is not reachable in unit tests because the leader gate denies non-leader pids).
export async function staleSurfaceReason(
	p: Paths,
	st: SwarmState,
	msg: { id: string; idempotencyKey?: string; createdAt?: string },
	taskIndex: Record<string, TaskState>,
	nowMs: number,
): Promise<{ stale: boolean; reason: string | null; evidence: string[] }> {
	const liveIdle = allEffectiveIdleAgents(st, nowMs).allIdle;
	// Row 68 fix (AC1): goal-nudge surface suppression must also see fresh (status="ready")
	// actionable graphs, or a goal nudge fires instead of the graph nudge pre-first-assign.
	const liveGraphActionable = Object.values(taskIndex).some((task) => {
		if (!isStallNudgeEligibleTaskStatus(task.status)) return false;
		// Goal-surface suppression must ignore terminal/abandoned tasks so orphan
		// rework nodes on failed/cancelled/blocked graphs do not permanently
		// silence the goal floor at surface time. LIVE tasks still count below.
		if (isTerminalOrAbandonedTaskStatus(task.status)) return false;
		const cr = computeReadyNodes(task);
		const actionable = new Set([
			...cr.ready,
			...cr.current.filter((id) => task.nodes[id] && task.nodes[id].status === "ready" && !task.nodes[id].assignee),
		]);
		for (const nodeId of actionable) {
			const node = task.nodes[nodeId];
			if (node && !node.assignee && !TERMINAL_NODE_STATUSES.has(node.status)) return true;
		}
		return false;
	});
	const idleAnchorMs = st.idleNudgeState?.allIdleSinceAt ? new Date(st.idleNudgeState.allIdleSinceAt).getTime() : NaN;
	const rec = st.messages[msg.id] || msg;
	const key = String(rec.idempotencyKey || msg.idempotencyKey || "");
	const createdAt = new Date(rec.createdAt || msg.createdAt).getTime();
	const taskKey = key.match(/^task:([^:]+):(?:node:([^:]+):)?nudge:/);
	const goalKey = key.match(/^goal:([^:]+):nudge:idle-streak:(\d+)$/);
	let staleReason: string | null = null;
	let evidence: string[] = [];
	if (goalKey) {
		// === R22 (2026-09-02) — the agent_busy leg is REMOVED for goal keys. ===
		// Emission (evaluateIdleGoalNudgeLocked) already required
		// allEffectiveIdleAgents().allIdle, so a worker that turned busy AFTER emission is
		// the nudge's own requested action succeeding (the root assigned work), not
		// message staleness. Re-checking it here contradicted the emission-time gate and
		// starved every queued goal nudge at surface time: live incident
		// 2026-09-02T12:03:36..12:30Z — nudges goal-1788350610025-7efafe
		// (msg-1788350616129-691b4e7c / -0aea3216 / -c6f752b8) suppressed with
		// `notification.stale.suppressed site=root_pump.surface reason=agent_busy`,
		// mailbox.root_pump_stuck_escalated every tick for 26+ min, ZERO
		// pi.sendMessage at the boundary, while consecutiveNoResolveNudges burned to
		// max+backoff on messages the root LLM never saw. R21 principle: surface
		// revalidation must AGREE with emission-time gating, never contradict it.
		// The legs that can make the MESSAGE itself false remain:
		//   - LIVE actionable graph work (R21 C-R21-3 preserved);
		//   - idle-epoch advanced past creation (the busy→idle edge after emission anchors a
		//     NEW epoch — this is the anti-immortality guard that bounds nudge lifetime).
		// The R10 anti-storm gate is unaffected: it lives at EMISSION time
		// (goal.nudge.suppressed_by_active_task in evaluateIdleGoalNudgeLocked).
		if (liveGraphActionable) {
			staleReason = "actionable_graph";
			evidence = ["actionable-graph-work-present"];
		} else if (Number.isFinite(idleAnchorMs) && createdAt < idleAnchorMs) {
			staleReason = "idle_epoch_advanced";
			evidence = [`message_created_before_idle_epoch:${new Date(createdAt).toISOString()}`, `idle_epoch:${new Date(idleAnchorMs).toISOString()}`];
		}
	} else if (taskKey) {
		const task = taskKey[1] ? taskIndex[taskKey[1]] : undefined;
		const nodeId = taskKey[2];
		if (!liveIdle) {
			staleReason = "agent_busy";
			evidence = ["effective-agent-set-not-idle"];
		} else if (!task) {
			staleReason = "task_missing";
			evidence = [`task_missing:${taskKey[1]}`];
		} else if (key.includes(":nudge:graph-stall:")) {
			const cr = computeReadyNodes(task);
			const actionable = new Set([
				...cr.ready,
				...cr.current.filter((id) => task.nodes[id] && task.nodes[id].status === "ready" && !task.nodes[id].assignee),
			]);
			const actionableNodes = Array.from(actionable).filter((id) => {
				const n = task.nodes[id];
				return n && !n.assignee && !TERMINAL_NODE_STATUSES.has(n.status);
			});
			if (!actionableNodes.length) {
				staleReason = "no_active_node";
				evidence = ["no-actionable-unassigned-node-remains"];
			}
		} else if (nodeId) {
			const node = task.nodes[nodeId];
			const check = checkStallNotificationStale(st, task, nodeId, node?.assignee || "root", nowMs);
			if (check.stale) {
				staleReason = check.reason || "stale";
				evidence = check.evidence;
			}
		} else if (key.includes(":nudge:initial-ready")) {
			const start = task.nodes[task.start];
			if (!start || start.status !== "ready" || start.assignee) {
				staleReason = "no_active_node";
				evidence = ["initial-ready-node-no-longer-eligible"];
			}
		}
	}
	return { stale: staleReason !== null, reason: staleReason, evidence };
}

function rootSurfaceGroupKey(rec: { id: string; from?: string; subject?: string; conversationId?: string; replyTo?: string; requiresAck?: boolean; requiresResponse?: boolean; idempotencyKey?: string }): string {
	const rawKey = String(rec.idempotencyKey || "");
	if (rawKey) {
		const normalized = rawKey
			.replace(/^(goal:[a-z0-9_-]+:nudge:idle-streak:)\d+$/, "$1")
			.replace(/^(task:[a-z0-9_-]+:nudge:graph-stall:)\d+$/, "$1");
		return `idk:${normalized}`;
	}
	if (rec.conversationId) return `conv:${rec.conversationId}`;
	const subject = String(rec.subject || "").trim();
	if (subject) {
		return `subj:${subject}|from:${String(rec.from || "")}|replyTo:${String(rec.replyTo || "")}|ack:${rec.requiresAck ? 1 : 0}|resp:${rec.requiresResponse ? 1 : 0}`;
	}
	return `msg:${rec.id}`;
}

function compareSurfaceCandidates(a: { id: string; createdAt?: string; updatedAt?: string }, b: { id: string; createdAt?: string; updatedAt?: string }): number {
	const aTs = new Date(a.updatedAt || a.createdAt || 0).getTime();
	const bTs = new Date(b.updatedAt || b.createdAt || 0).getTime();
	if (aTs !== bTs) return aTs - bTs;
	return a.id.localeCompare(b.id);
}

const staleSuppressionTraceSeen = new Set<string>();

export async function traceStaleSuppressedOnce(
	p: Paths,
	site: string,
	payload: { messageId?: string; idempotencyKey?: string | null; reason: string | null; evidence: string[] },
): Promise<boolean> {
	const key = String(payload.messageId || payload.idempotencyKey || "");
	if (staleSuppressionTraceSeen.has(key)) return false;
	staleSuppressionTraceSeen.add(key);
	await trace(p, "notification.stale.suppressed", {
		site,
		messageId: payload.messageId,
		idempotencyKey: payload.idempotencyKey,
		reason: payload.reason,
		evidence: payload.evidence,
	}).catch(() => {});
	return true;
}
export async function pumpRootMailbox(pi: ExtensionAPI, ctx: any, p: Paths, reason: string) {
	if (currentAgentId() !== "root") return { delivered: 0, ids: [] as string[] };
	// Read idle once, up front. Non-TUI modes have no live agent loop to trigger, so they are treated as
	// "busy" — the file-IO surfacing decision still runs (for trace visibility) but no ctx-bound call is made.
	const idleAtStart = ctx.mode === "tui" ? ctx.isIdle() : false;
	const result = await withLock(p, async () => {
		const st = await readState(p, ctx.cwd);
		// Second-line defense (issue 8 §4.4.8): even if env vars were set by a path the preflight
		// couldn't catch (e.g. an edge that skipped the gate), a non-leader pid must not run the
		// pump. Read the leader record INSIDE the existing withLock (atomic with the rest of the
		// pump decision block; no extra file IO); on deny, trace + return empty without firing
		// nudges or stamping any surfaced set. This check piggybacks on the per-tick readState.
		const leaderCheck = readRootLeader(st, Date.now());
		if (leaderCheck.kind !== "claimed" || leaderCheck.leader.pid !== process.pid) {
			// === STALE-LEASE SELF-HEAL ===
			// A STALE lease (heartbeat older than ROOT_LEADER_STALE_MS — no live root
			// refreshed it) used to deny this tick, but the pump tick is the ONLY thing that refreshes
			// the lease. After a watchdog gap (module reload, extension edit mid-session) the pump
			// deadlocked on its own stale lease: every tick denied, no tick ever heartbeating again —
			// observed live as 16+ min of root.pump.denied(state=stale) with goal nudges and
			// message surfacing frozen while all agents sat idle. Now: when the lease is stale
			// (whoever held it, including this pid), re-claim — claimRootLeader only denies when
			// a LIVE competing pid holds it — and continue the tick. Deny remains only for a genuinely
			// LIVE lease held by a DIFFERENT pid (true multi-root conflict).
			if (leaderCheck.kind === "stale") {
				const reclaimed = claimRootLeader(st, Date.now(), process.pid);
				if (reclaimed.kind === "denied") {
					await trace(p, "root.pump.denied", { reason, currentLeaderPid: reclaimed.currentLeader.pid, state: "claimed", callerPid: process.pid, heartbeatAgeMs: reclaimed.ageMs, reclaimedStale: true }).catch(() => {});
					return { toSurface: [] as SwarmMessage[], retriggered: 0 };
				}
				await trace(p, "root.pump.lease_reclaimed", { reason, previousPid: leaderCheck.leader.pid, staleForMs: Math.round(leaderCheck.ageMs), callerPid: process.pid }).catch(() => {});
			} else {
				await trace(p, "root.pump.denied", {
					reason,
					currentLeaderPid: leaderCheck.kind === "claimed" ? leaderCheck.leader.pid : null,
					state: leaderCheck.kind,
					callerPid: process.pid,
					heartbeatAgeMs: leaderCheck.kind !== "vacant" ? leaderCheck.ageMs : null,
				}).catch(() => {});
				return { toSurface: [] as SwarmMessage[], retriggered: 0 };
			}
		}
		// === Issue 11 (rework): per-tick leader heartbeat ===
		// The leader lease must stay alive between session_starts (otherwise the second-line defense
		// above starts denying ticks within ROOT_LEADER_STALE_MS of the last session_start).
		// Refresh it inside the existing withLock (atomic with the rest of the pump decision block;
		// no extra file IO). heartbeatRootLeader is a no-op for the current pid when the
		// lease is already held by it; if a competing pid claimed it between the read and the
		// refresh, it throws ROOT_LEADER_DENIED, which is propagated to the watchdog catch.
		heartbeatRootLeader(st, Date.now(), process.pid, "pump_tick");
		// ensureRoot (create-only post-issue-8): no heartbeat refresh, just materialises the
		// pseudo-agent record for mailbox delivery. The heartbeat is owned by the gate.
		ensureRoot(st, ctx.cwd, p);
		const nowMs = Date.now();
		// Prune dead sessions (not pumped within TTL) to bound growth from transient validation pids.
		for (const [k, v] of Object.entries(st.rootPumpSessions!)) {
			if (k !== String(process.pid) && nowMs - new Date(v.lastAt).getTime() > PUMP_SESSION_TTL_MS) delete st.rootPumpSessions![k];
		}
		// === Issue 82: heartbeat-driven agent GC pass (P0, R9 a3 graveyard) ===
		// Runs inside the existing pump withLock (no nested lock acquisition). Bounded cost:
		// O(N) over agents for the cheap heartbeat gate; tmux probe fires only when an agent's
		// heartbeat is older than 2× the stale window. Auto-flips `status` from "running" to
		// "stopped" for agents whose tmux pane is known-dead or freshly probed dead, so the next
		// sweepTaskWorkersLocked / swarm_prune picks them up. Lease-valid (reuse) and paused
		// agents are exempt. Idempotent across ticks.
		try { await agentHeartbeatGCLocked(pi, ctx.cwd, p, st, nowMs); }
		catch (err: any) { await trace(p, "agent.heartbeat_gc.error", { reason, error: String((err as Error)?.message || err) }).catch(() => {}); }
		// === Issue 83a — stale-open assignment scan [R10-3 restart-required pump phase] ===
		// Pump phase: `staleOpenAssignmentScanLocked` (called from `pumpRootMailbox`).
		// Runs after heartbeat GC (so freshly-stopped agents are excluded by status) and before the
		// graph-stall safety net (so a freshly-stale-open node does not double-fire the graph-advance
		// nudge). R10-1 cost-bound: per-tick readdir of tasks dir + readTaskState per task under
		// pump lock; no subprocess/tmux. The bound is N+1 file reads per tick where N = count of
		// `task-*` subdirs; ZERO tmux subprocess calls. Surfacing is TRACE-ONLY: no root
		// mailbox nudge is sent (the plan's nudge was consciously dropped; pre-existing stall
		// nudge machinery still nudges on stalled nodes). Throws are wrapped in try/catch so a
		// scan failure never kills the tick.
		try {
			const r = await staleOpenAssignmentScanLocked(p, st, nowMs);
			// R11-1 completion: surface → nudge. Every FRESHLY surfaced node gets one high-priority
			// root nudge (capped/cooled-down inside). Trace-only surfacing left the swarm
			// idling for hours with staleOpen>0 and nobody told.
			for (const n of r.surfacedNodes || []) {
				try { await staleOpenNudgeLocked(pi, ctx.cwd, p, st, n.taskId, n.nodeId); }
				catch { /* per-node best-effort; never kills the tick */ }
			}
		}
		catch (err: any) { await trace(p, "stale_open.scan.error", { reason, error: String((err as Error)?.message || err) }).catch(() => {}); }
		// === Issue 83c — proxy metric snapshot phase [restart-required pump phase] ===
		// Read-only, cheap snapshot of hung-but-alive residuals + stale-open count + supersession
		// churn. Bounded by PI_SWARM_PROXY_METRIC_INTERVAL_MS, and the snapshot is stored on
		// SwarmState.proxyMetrics for `/swarm status` / `/swarm metrics` to surface.
		try { await proxyMetricEmitLocked(p, st, nowMs); }
		catch (err: any) { await trace(p, "proxy.metric_emit.error", { reason, error: String((err as Error)?.message || err) }).catch(() => {}); }
		// Mid-graph stall safety net: nudge the root to assign any ready-but-unassigned node in an
		// in_progress task. The nudge is idempotent, so it is safe to run on every pump tick.
		try { await reconcileGraphAdvanceLocked(pi, ctx.cwd, p, st, nowMs); } catch (err: any) { await trace(p, "graph.reconcile_error", { error: String((err as Error)?.message || err) }).catch(() => {}); }
		// Fresh-task stall safety net: nudge the root when a start node is still ready + unassigned
		// past the creation grace period. Also idempotent + read-only on task state.
		try { await reconcileInitialReadyLocked(pi, ctx.cwd, p, st, nowMs); } catch (err: any) { await trace(p, "task.initial_ready_reconcile_error", { error: String((err as Error)?.message || err) }).catch(() => {}); }
		// === Row 68: shared idle-epoch maintenance (once per tick, before both nudge evaluators) ===
		// Anchors the busy→all-idle edge at swarm level so BOTH nudge families measure continuous idle
		// from the same anchor regardless of evaluator call order or goal presence.
		try { await updateIdleEpochLocked(p, st, nowMs); } catch (err: any) { await trace(p, "idle.epoch.error", { error: String((err as Error)?.message || err) }).catch(() => {}); }
		// === Issue 23: task-graph-state idle nudge (graph-first ordering) ===
		// Evaluated BEFORE the goal fallback (row 68 plan §4): the graph nudge is the immediate priority
		// when an unfinished graph has actionable unassigned work and all effective agents are idle; the
		// goal nudge is a fallback only for no-actionable-graph conditions. Each evaluator internally
		// suppresses on the other's condition, so a single cycle can never double-fire for the same
		// idle state. Each is wrapped in try/catch (matches the existing reconcile-helper pattern) so a
		// throw never kills the tick.
		try { await evaluateTaskGraphStallNudgeLocked(pi, ctx.cwd, p, st, nowMs); } catch (err: any) { await trace(p, "task_stall.nudge_error", { error: String((err as Error)?.message || err) }).catch(() => {}); }
		// === Issue 18: goal idle-streak nudge (goal fallback, runs after the graph path) ===
		// When the root has set a goal, there is no actionable graph work, and every effective
		// agent has been continuously idle for the full interval, emit the goal fallback nudge. Anti-loop
		// counter + back-off handled inside the function.
		try { await evaluateIdleGoalNudgeLocked(pi, ctx.cwd, p, st, nowMs); } catch (err: any) { await trace(p, "goal.nudge.error", { error: String((err as Error)?.message || err) }).catch(() => {}); }
		// === R20: artifact-progress self-nudge (Issue: settled idle with open assignment) ===
		// Pump-tick phase. Fires an action-oriented nudge to the AGENT itself (not the root)
		// when fs.stat detects a fresh write to a node's allowedFiles but the node is still open.
		// Companion to the existing root-facing stale-open nudge (which targets the PM,
		// not the worker). Wrapped in try/catch so a single tick failure never kills the pump.
		try { await evaluateArtifactProgressNudgeLocked(pi, ctx.cwd, p, st, nowMs); } catch (err: any) { await trace(p, "worker.artifact_progress_nudge_error", { error: String((err as Error)?.message || err) }).catch(() => {}); }
		// === Issue 21: slot recovery scan ===
		// When a slot's bench naturally expires AND lastBenchReason === "quota" AND the agent on
		// that slot still has active task assignments, emit pool.slot_recovered. NO auto-resume;
		// the root decides. Idempotent under tick storms via lastRecoveredAt dedupe.
		try { await evaluateSlotRecoveryLocked(pi, ctx.cwd, p, st, nowMs); } catch (err: any) { await trace(p, "pool.slot_recovered.error", { error: String((err as Error)?.message || err) }).catch(() => {}); }
		const sess = orchSession(st, nowMs)!;
		const surfaced = new Set(sess.ids);
		const triggeredAt = { ...(sess.triggeredAt ?? {}) };
		const retriggerCount = { ...(sess.retriggerCount ?? {}) };
		const keepalive = () => { sess.lastAt = new Date(nowMs).toISOString(); };
		// Session-safe surfacing keying is unchanged (per-pid, not PI_SESSION_ID, so a validation run or a
		// second root lane cannot starve this PM process). Recent window bounds work; acked messages
		// (ackedAt = "recipient processed it") are skipped. We no longer pre-filter surfaced here: surfaced
		// vs triggered vs re-trigger is decided below, because surfacing must be gated on idle.

		// === Issue 11: One-time migration back-fill (binding C4) ===
		if ((st.consumerReceipts?.root?.revision ?? 0) === 0) {
			const migrationEntries = st.consumerReceipts!.root!.entries!;
			let written = 0;
			let scanned = 0;
			// Build task index for actionability predicate.
			const taskIndex: Record<string, TaskState> = {};
			if (existsSync(p.tasksDir)) {
				try {
					const entries = await readdir(p.tasksDir);
					for (const taskId of entries) {
						const tp = taskPaths(p, taskId);
						if (!existsSync(tp.taskJson)) continue;
						try { taskIndex[taskId] = await readTaskState(tp.taskJson); } catch { /* skip unreadable */ }
					}
				} catch { /* ignore readdir errors */ }
			}
			const retriggerCounts = orchSession(st, nowMs)!.retriggerCount || {};
			for (const rec of Object.values(st.messages)) {
				scanned++;
				if (rec.to !== "root") continue;
				if (!rec.requiresAck) continue;
				// Use the actionability predicate; non-actionable messages get a receipt.
				// Note: do NOT short-circuit on rec.ackedAt here — the predicate returns reason="acked"
				// and we want the receipt entry written so a reincarnated consumer reads it.
				const v = isActionableRootMessage(rec, taskIndex, nowMs, retriggerCounts, /* strictForMigration */ true, p);
				if (!v.ok) {
					migrationEntries[rec.id] = {
						surfacedAt: rec.updatedAt || rec.createdAt,
						ackedAt: rec.ackedAt,
						requiresAck: true,
						conversationId: rec.conversationId,
						fingerprint: fingerprintMessage(rec),
					};
					written++;
				}
			}
			st.consumerReceipts!.root!.revision = 1;
			await trace(p, "notification.backfill.receipts_written", { written, scanned, ts: nowMs }).catch(() => {});
		}

		// === Issue 11: Durable dedupe gate + actionability filter (binding C4 + C5) ===
		const deliveredOrch = new Set(st.delivered.root || []);
		// Build task index for actionability predicate.
		const taskIndex: Record<string, TaskState> = {};
		if (existsSync(p.tasksDir)) {
			try {
				const entries = await readdir(p.tasksDir);
				for (const taskId of entries) {
					const tp = taskPaths(p, taskId);
					if (!existsSync(tp.taskJson)) continue;
					try { taskIndex[taskId] = await readTaskState(tp.taskJson); } catch { /* skip unreadable */ }
				}
			} catch { /* ignore readdir errors */ }
		}
		const retriggerCounts = orchSession(st, nowMs)!.retriggerCount || {};
		const windowMsgs = (await readMailboxCached(p, "root"))
			.slice(-PUMP_SCAN_WINDOW)
			.filter((m) => {
				const rec = st.messages[m.id];
				if (!rec) return false;

				// Durable dedupe gate (binding C4): check consumerReceipts first, then legacy delivered ledger, then per-pid surfaced.
				if (st.consumerReceipts?.root?.entries?.[m.id]) return false;
				if (rec.requiresAck === false && (rec.surfacedAt || deliveredOrch.has(m.id))) return false;
				if (surfaced.has(m.id)) return false; // per-pid surfaced (retrigger bound)

				// Actionability predicate (binding C5): skip non-actionable messages and batch-count suppressions.
				const v = isActionableRootMessage(rec, taskIndex, nowMs, retriggerCounts, /* strictForMigration */ false, p);
				return v.ok;
			});

		// === Issue 11: Per-tick batch suppression trace (binding C6) ===
		// Count all suppressed messages by reason before the BUSY check. Emit on EVERY tick including total===0.
		const suppressedCounts: Record<string, number> = {
			acked: 0, dead_letter: 0, superseded: 0, task_done: 0, task_failed: 0, task_cancelled: 0,
			node_terminal: 0, node_reassigned: 0, task_missing: 0, node_missing: 0,
			wrong_recipient: 0, retrigger_budget_exhausted: 0, informational_already_consumed: 0,
		};
		const allMsgs = (await readMailboxCached(p, "root")).slice(-PUMP_SCAN_WINDOW);
		for (const m of allMsgs) {
			const rec = st.messages[m.id];
			if (!rec || rec.to !== "root") continue;
			if (st.consumerReceipts?.root?.entries?.[m.id]) { suppressedCounts.informational_already_consumed++; continue; }
			if (rec.requiresAck === false && (rec.surfacedAt || deliveredOrch.has(m.id))) { suppressedCounts.informational_already_consumed++; continue; }
			if (surfaced.has(m.id)) continue; // not suppressed - already surfaced this session
			const v = isActionableRootMessage(rec, taskIndex, nowMs, retriggerCounts, false, p);
			if (!v.ok) {
				const key = v.reason === "retrigger_budget_exhausted" ? "retrigger_budget_exhausted" : v.reason;
				suppressedCounts[key] = (suppressedCounts[key] || 0) + 1;
				if (key === "node_reassigned" || key === "node_terminal" || key === "task_done" || key === "task_failed" || key === "task_cancelled" || key === "task_missing" || key === "node_missing") {
					await traceStaleSuppressedOnce(p, "root_pump.surface", {
						messageId: m.id,
						idempotencyKey: rec.idempotencyKey || m.idempotencyKey || null,
						reason: key,
						evidence: [key],
					});
				}
			}
		}
		const totalSuppressed = Object.values(suppressedCounts).reduce((a, b) => a + b, 0);
		await trace(p, "notification.batch.suppressed", {
			ts: nowMs,
			cid: String(process.pid),
			reason: "per-tick baseline",
			total: totalSuppressed,
			counts: suppressedCounts,
		}).catch(() => {});

		// BUSY: defer entirely. Do NOT surface, do NOT mark surfaced, do NOT deliver a dead followUp. A
		// followUp delivered while busy carries no triggerTurn, so it lands in context without prompting the
		// LLM to act; the old code still marked it "surfaced", which made every later idle pump (incl.
		// agent_settled) skip it forever — the loop-nudge-stuck-at-awaiting_plan bug. Deferring keeps the
		// message un-marked so the next idle pump (session_start / agent_settled / 5s interval) re-reads it
		// and delivers it WITH a real triggerTurn. It also stops queuing followUps that can themselves keep
		// isIdle() false (a secondary cause of the root never waking).
		//
		// STUCK-BUSY ESCALATION: ctx.isIdle() can stay false indefinitely while pi has a queued
		// continuation / auto-retry pending (e.g. provider 429 backoff, auto-compaction retry) even
		// though the root is swarm-idle (heartbeat says idle, nothing is running). Without an
		// escape hatch the deferral above is unbounded: messages pile up until the human intervenes
		// (Esc/reload) — the observed "messages only arrive when I press /reload" bug. When the oldest
		// never-displayed message has waited longer than PUMP_STUCK_DEFER_ESCALATE_MS while busy, surface
		// it with an explicit steer: steering interrupts the queued continuation and starts a fresh turn,
		// which is exactly the operator-mandated behavior for stale deferrals.
		const neverDisplayedBusy = windowMsgs.filter((m) => !surfaced.has(m.id));
		const oldestWaitMs = neverDisplayedBusy.length
			? nowMs - new Date(neverDisplayedBusy.map((m) => st.messages[m.id]?.createdAt || m.createdAt).sort()[0] || nowMs).getTime()
			: 0;
		if (!idleAtStart && oldestWaitMs < PUMP_STUCK_DEFER_ESCALATE_MS) {
			keepalive();
			if (neverDisplayedBusy.length) {
				await trace(p, "mailbox.root_pump_deferred", {
					reason, queued: neverDisplayedBusy.length, oldestWaitMs: Math.round(oldestWaitMs),
					thresholdMs: PUMP_STUCK_DEFER_ESCALATE_MS, cid: String(process.pid), sid: process.env.PI_SESSION_ID ?? null,
				});
			}
			await writeState(p, st);
			return { toSurface: [] as SwarmMessage[], retriggered: 0 };
		}
		const escalateStuck = !idleAtStart && oldestWaitMs >= PUMP_STUCK_DEFER_ESCALATE_MS;
		if (escalateStuck) {
			await trace(p, "mailbox.root_pump_stuck_escalated", {
				reason, queued: neverDisplayedBusy.length, oldestWaitMs: Math.round(oldestWaitMs),
				thresholdMs: PUMP_STUCK_DEFER_ESCALATE_MS, cid: String(process.pid), sid: process.env.PI_SESSION_ID ?? null,
			});
		}

		// IDLE: we can fire a real turn.
		// (1) Messages never displayed to this pid (highest priority — fresh work).
		// (2) Action-expected (requiresAck) messages already surfaced+triggered but still unacked and overdue
		//     (bounded re-trigger). Informational (requiresAck:false) messages are NOT re-triggered: a single
		//     triggered delivery already prompted the root once, which is sufficient.
		const neverDisplayed = windowMsgs.filter((m) => !surfaced.has(m.id));
		const overdueRetrigger = windowMsgs.filter((m) => {
			if (!surfaced.has(m.id)) return false;
			const rec = st.messages[m.id];
			if (!rec?.requiresAck || rec.ackedAt) return false;
			const last = triggeredAt[m.id];
			if (!last) return false;
			if (nowMs - new Date(last).getTime() < PUMP_RETRIGGER_DELAY_MS) return false;
			return (retriggerCount[m.id] ?? 0) < PUMP_RETRIGGER_MAX;
		});
		const surfaceCandidates = [...neverDisplayed, ...overdueRetrigger].slice(0, 10);
		// Row 68: surface-time revalidation — deferred nudges are dropped if their stall condition no
		// longer holds (node assigned / agent busy / graph quieted / epoch advanced).
		// Coalesce repeated backlog messages by logical surface key before the final send decision so a
		// compacted / replaced session replays at most one freshest eligible notification per logical
		// action.
		const surfacePlan = [...surfaceCandidates].sort(compareSurfaceCandidates).reverse().map((msg) => {
			const rec = st.messages[msg.id] || msg;
			return { msg, rec, groupKey: rootSurfaceGroupKey(rec) };
		});
		const coalesced = new Map<string, { msg: SwarmMessage; dropped: string[] }>();
		for (const item of surfacePlan) {
			const v = await staleSurfaceReason(p, st, item.msg, taskIndex, nowMs);
			if (v.stale) {
				// === R13 P0 (2026-09-01) — priority-high unknown-target root safety-net bypass ===
				// The root pseudo-agent has tmuxTarget === "unknown" by design (identity.ts:69)
				// and a worker in `tool_running` state causes `staleSurfaceReason` to return
				// `{stale: true, reason: "agent_busy"}` — suppressing the durable nudge so the user
				// never sees it even though `deliverMessageLocked` reported success via mailbox_only.
				// Live incident 2026-09-01T13:10:27 trace: priority-high STALE-OPEN nudge durably
				// enqueued, mailbox_only logged, then `notification.stale.suppressed site=
				// root_pump.surface reason=agent_busy` with zero `pi.sendMessage` calls at the
				// reconcile.ts:1763-1773 boundary. Fix: for priority-high nudges bound for the
				// unknown-target root pseudo-agent, BYPASS the busy-suppression gate so the
				// safety nudge still surfaces locally. Normal-priority traffic still respects the
				// gate (otherwise the `goal.nudge.suppressed_by_active_task` storm from R10 returns).
				const recForBypass = item.rec;
				// Priority lives on the mailbox entry (item.msg — what windowMsgs read from the JSONL),
				// NOT on the st.messages record (upsertMessageRecord does not persist priority). Fall
				// back to the raw mailbox entry when the record's priority is absent.
				const bypassPriority = String((recForBypass.priority ?? (item.msg as any)?.priority) || "").toLowerCase();
				const isHighPriority = bypassPriority === "high";
				const recipient = st.agents[recForBypass.to];
				const isUnknownTargetRoot = recipient?.id === "root" && (!recipient.tmuxTarget || recipient.tmuxTarget === "unknown");
				// === R13 P1 (2026-09-02) — liveness gate: the bypass MUST NOT rescue nudges whose
				// referenced task/node is already terminal. Live incident 2026-09-02: pre-R13
				// priority-high stale-open nudges that were durably enqueued on 2026-09-01
				// (when their tasks/nodes were still live) began re-surfacing on 2026-09-02
				// after those tasks/nodes closed overnight — the bypass converted a moot
				// historical alert into a user-visible "act now" message. Gate the bypass on
				// referenced-task liveness by parsing the canonical idempotencyKey format
				// (task:taskId:node:nodeId:nudge:*:seq:*) and reading taskIndex; fall back to
				// conversationId via parseTaskNodeRef for the production pool_depleted shape
				// (task:taskId:pool_depleted).
				const idemForLiveness = String(recForBypass.idempotencyKey || (item.msg as any)?.idempotencyKey || "");
				const idemMatch = idemForLiveness.match(/^task:([^:]+):(?:node:([^:]+):)?nudge:/);
				let liveTaskId: string | null = idemMatch ? idemMatch[1] : null;
				let liveNodeId: string | null = idemMatch ? (idemMatch[2] || null) : null;
				if (!liveTaskId) {
					const convRef = parseTaskNodeRef(recForBypass.conversationId || (item.msg as any)?.conversationId);
					if (convRef?.taskId) {
						liveTaskId = convRef.taskId;
						liveNodeId = convRef.nodeId || null;
					}
				}
				let liveTaskIsTerminal = false;
				let liveTerminalReason: string | null = null;
				if (liveTaskId) {
					const task = taskIndex[liveTaskId];
					if (!task) {
						liveTaskIsTerminal = true;
						liveTerminalReason = "task_missing";
					} else if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
						liveTaskIsTerminal = true;
						liveTerminalReason = `task_${task.status}`;
					} else if (liveNodeId && task.nodes[liveNodeId] && TERMINAL_NODE_STATUSES.has(task.nodes[liveNodeId].status)) {
						liveTaskIsTerminal = true;
						liveTerminalReason = "node_terminal";
					}
				}
				const bypassBusyForHigh = isHighPriority && isUnknownTargetRoot && v.reason === "agent_busy" && !liveTaskIsTerminal;
				if (liveTaskIsTerminal) {
					// Do NOT bypass — surface the historical nudge's terminal state via the
					// standard suppression trace + counters so it is observable in the
					// notification.batch.suppressed census (task_done / node_terminal).
					await traceStaleSuppressedOnce(p, "root_pump.surface", {
						messageId: item.msg.id,
						idempotencyKey: String(recForBypass.idempotencyKey || ""),
						reason: liveTerminalReason || "task_terminal",
						evidence: [liveTerminalReason || "task_terminal", "r13_p1_liveness_gate"],
					});
					continue;
				}
				if (bypassBusyForHigh) {
					await trace(p, "notification.surface.bypass_high_unknown_target", {
						messageId: item.msg.id,
						idempotencyKey: String(recForBypass.idempotencyKey || ""),
						suppressedReason: v.reason,
						suppressedEvidence: v.evidence,
						by: "R13 P0",
					}).catch(() => {});
					// Fall through to the coalescing path (do NOT continue past this item).
				} else {
					await traceStaleSuppressedOnce(p, "root_pump.surface", {
						messageId: item.msg.id,
						idempotencyKey: String(item.rec.idempotencyKey || item.msg.idempotencyKey || ""),
						reason: v.reason,
						evidence: v.evidence,
					});
					continue;
				}
			}
			const existing = coalesced.get(item.groupKey);
			if (!existing) {
				coalesced.set(item.groupKey, { msg: item.msg, dropped: [] });
				continue;
			}
			const existingTs = new Date((existing.msg as any).updatedAt || existing.msg.createdAt || 0).getTime();
			const incomingTs = new Date((item.msg as any).updatedAt || item.msg.createdAt || 0).getTime();
			if (incomingTs >= existingTs) {
				existing.dropped.push(existing.msg.id);
				existing.msg = item.msg;
			} else {
				existing.dropped.push(item.msg.id);
			}
		}
		for (const [groupKey, entry] of coalesced.entries()) {
			if (!entry.dropped.length) continue;
			await trace(p, "notification.coalesced.suppressed", {
				site: "root_pump.surface",
				groupKey,
				keptId: entry.msg.id,
				droppedIds: entry.dropped,
				count: entry.dropped.length,
			}).catch(() => {});
		}
		let toSurface = [...coalesced.values()].map((entry) => entry.msg).sort(compareSurfaceCandidates);
		const consumedSuppressedIds = new Set<string>();
		for (const entry of coalesced.values()) {
			for (const droppedId of entry.dropped) consumedSuppressedIds.add(droppedId);
		}
		if (consumedSuppressedIds.size) {
			const ts = now();
			if (!st.consumerReceipts) st.consumerReceipts = {};
			if (!st.consumerReceipts.root) st.consumerReceipts.root = { entries: {}, revision: 0 };
			if (!st.consumerReceipts.root.entries) st.consumerReceipts.root.entries = {};
			for (const id of consumedSuppressedIds) {
				const rec = st.messages[id];
				if (!rec || rec.to !== "root") continue;
				if (rec.requiresAck === false) {
					st.delivered.root = Array.from(new Set([...(st.delivered.root || []), id]));
					if (!rec.surfacedAt) {
						rec.surfacedAt = ts;
						rec.updatedAt = ts;
					}
					continue;
				}
				if (!st.consumerReceipts.root.entries[id]) {
					st.consumerReceipts.root.entries[id] = {
						surfacedAt: ts,
						requiresAck: true,
						conversationId: rec.conversationId,
						fingerprint: fingerprintMessage(rec),
					};
					st.consumerReceipts.root.revision = (st.consumerReceipts.root.revision || 0) + 1;
				}
			}
		}
		if (!toSurface.length) {
			keepalive();
			await writeState(p, st);
			return { toSurface: [] as SwarmMessage[], retriggered: 0 };
		}
		// Mark all surfaced now; stamp triggeredAt for every delivered message (the first gets triggerTurn,
		// the rest ride that turn's wake as followUp — both count as "triggered"). Increment retriggerCount
		// only for the overdue ones (a genuine re-prompt); first-time triggers stay at 0.
		const retriggerSet = new Set(overdueRetrigger.map((m) => m.id));
		for (const m of toSurface) {
			surfaced.add(m.id);
			triggeredAt[m.id] = new Date(nowMs).toISOString();
			if (retriggerSet.has(m.id)) retriggerCount[m.id] = (retriggerCount[m.id] ?? 0) + 1;
		}
		const nextIds = [...surfaced];
		sess.ids = nextIds.length > PUMP_SESSION_ID_CAP ? nextIds.slice(nextIds.length - PUMP_SESSION_ID_CAP) : nextIds;
		// Bound the maps the same way as ids (drop oldest beyond the cap) so a long-lived session cannot
		// grow unbounded.
		sess.triggeredAt = capMap(triggeredAt, PUMP_SESSION_ID_CAP);
		sess.retriggerCount = capMap(retriggerCount, PUMP_SESSION_ID_CAP);
		keepalive();
		await writeState(p, st);
		return { toSurface, retriggered: toSurface.filter((m) => retriggerSet.has(m.id)).length, escalatedStuck: escalateStuck };
	});
	const pending = result.toSurface;
	if (!pending.length) {
		if (ctx.mode === "tui") await trace(p, "mailbox.root_pump", { reason, count: 0, deferred: !idleAtStart ? 1 : 0, cid: String(process.pid), sid: process.env.PI_SESSION_ID ?? null, idleAtStart });
		return { delivered: 0, ids: [] as string[] };
	}
	// Delivery is TUI-only (session-bound APIs: pi.sendMessage/ctx.isIdle). In print/rpc/json mode,
	// the captured ctx is invalidated on session teardown and these throw "ctx is stale" errors.
	// The decision block above (readState/writeState/trace) runs in all modes to record surfacing
	// decisions without ctx usage.
	if (ctx.mode === "tui") {
		for (let i = 0; i < pending.length; i++) {
			const msg = pending[i];
			// Stuck-busy escalation path: steer (interrupt the queued continuation and start a fresh
			// turn) instead of triggerTurn — the engine is NOT idle, so a queued turn would never fire.
			const opts = result.escalatedStuck
				? { triggerTurn: true, deliverAs: "steer" as const }
				: (i === 0 ? { triggerTurn: true } : { deliverAs: "followUp" as const });
			pi.sendMessage({
				customType: "swarm-message",
				content: formatSwarmMessageContent(msg),
				display: true,
				details: msg,
			}, opts);
		}
		// Global-consume informational PM traffic ONLY AFTER a real TUI surface succeeded. This avoids
		// losing a message on stale-ctx/sendMessage failure while still preventing a later root
		// process from replaying historical requiresAck:false notices that were already shown once.
		const surfacedInfoIds = pending
			.filter((m) => m.requiresAck === false)
			.map((m) => m.id);
		// === Issue 11: Write durable consumer receipt entries (binding C4 + C10) ===
		// For action-expected messages, write a receipt entry so a reincarnated consumer knows it was
		// surfaced. Bump revision immediately after write. For informational messages, the legacy delivered
		// ledger remains authoritative (consumerReceipts only covers actionable).
		const surfacedActionIds = pending
			.filter((m) => m.requiresAck === true)
			.map((m) => m.id);
		if (surfacedInfoIds.length || surfacedActionIds.length) {
			await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const ts = now();
				// Legacy informational ledger (unchanged).
				if (surfacedInfoIds.length) {
					const ledgerIds = st.delivered.root || [];
					st.delivered.root = Array.from(new Set([...ledgerIds, ...surfacedInfoIds]));
				}
				// Durable consumer receipts for actionable messages.
				if (surfacedActionIds.length) {
					const entries = st.consumerReceipts!.root!.entries!;
					let bumped = false;
					for (const id of surfacedActionIds) {
						const rec = st.messages[id];
						if (!rec || rec.to !== "root" || rec.requiresAck !== true) continue;
						// Write receipt only if not already present (TUI delivery idempotence).
						if (entries[id]) continue;
						entries[id] = {
							surfacedAt: ts,
							ackedAt: rec.ackedAt,
							requiresAck: true,
							conversationId: rec.conversationId,
							fingerprint: fingerprintMessage(rec),
						};
						bumped = true;
						}
					// Bump revision immediately after entries mutation (binding C10).
					if (bumped) st.consumerReceipts!.root!.revision = (st.consumerReceipts!.root!.revision || 0) + 1;
				}
				// Legacy informational surfacedAt stamp (unchanged).
				for (const id of surfacedInfoIds) {
					const rec = st.messages[id];
					if (!rec || rec.to !== "root" || rec.requiresAck !== false || rec.surfacedAt) continue;
					rec.surfacedAt = ts;
					rec.updatedAt = ts;
				}
				await writeState(p, st);
			});
		}
		await trace(p, "mailbox.root_pump", { reason, count: pending.length, ids: pending.map((m) => m.id), retriggered: result.retriggered, informationalConsumed: surfacedInfoIds.length, cid: String(process.pid), sid: process.env.PI_SESSION_ID ?? null, idleAtStart });
	} else {
		// In non-TUI mode, still trace pump activity (without ctx.isIdle) for visibility.
		await trace(p, "mailbox.root_pump", { reason, count: pending.length, ids: pending.map((m) => m.id), cid: String(process.pid), sid: process.env.PI_SESSION_ID ?? null, mode: ctx.mode });
	}
	return { delivered: pending.length, ids: pending.map((m) => m.id) };
}
