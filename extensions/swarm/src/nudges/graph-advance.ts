// === swarm/src/nudges/graph-advance.ts ===
// Module boundary: per-task graph-advance nudges + stall/artifact/heartbeat recovery.
//   - `reconcileInitialReadyLocked`     — fires the very-first unassigned-start-node nudge
//   - `evaluateTaskGraphStallNudgeLocked` — task-stall floor (mid-graph)
//   - `evaluateArtifactProgressNudgeLocked` — file-progress reminder
//   - `agentHeartbeatGCLocked`           — agent-liveness GC + tmux liveness correction
//   - `resolveTaskStallLocked`           — stall threshold resolver
//   - `evaluateSlotRecoveryLocked`       — slot-recovery nudge for stalled graph
//
// Why co-located: all four nudge families share per-(taskId, nodeId) seq-suffixed keys
// (NOTIFY_KEY_GRAPH_ADVANCE, NOTIFY_KEY_INITIAL_READY, NOTIFY_KEY_TASK_GRAPH_STALL) and
// the seq-counter machine in goal-epoch.ts. The heartbeat GC re-uses the task-stall machinery
// to probe stale agents without duplicating the seq/lifecycle logic.
//
// Moved verbatim from reconcile.ts (lines 116-307, 1005-1597) as part of the R24 structure
// refactor. No behavior change.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Paths, SwarmAgent, SwarmState, TaskPaths, TaskState } from "../types.ts";
import {
  ARTIFACT_PROGRESS_ACTIVE_AGENT_SKIP_MS, ARTIFACT_PROGRESS_GRACE_MS, ARTIFACT_PROGRESS_MAX_FILES,
  ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS, ARTIFACT_PROGRESS_NUDGE_CAP, DEFAULT_AGENT_HEARTBEAT_STALE_MS,
  MAX_TASK_STALL_NUDGES, GOAL_NUDGE_BACKOFF_TICKS, NOTIFY_DEFAULT_COOLDOWN_MS, NOTIFY_DEFAULT_MAX_NUDGES, NOTIFY_KEY_GRAPH_ADVANCE,
  NOTIFY_KEY_INITIAL_READY, NOTIFY_KEY_TASK_GRAPH_STALL, TASK_INITIAL_READY_GRACE_MS,
  TASK_STALL_NUDGE_IDLE_INTERVAL_MS, TERMINAL_NODE_STATUSES,
  TRACE_AGENT_HEARTBEAT_GC_EXPIRED_PARK_FLIPPED, TRACE_AGENT_HEARTBEAT_GC_PROBE_THROTTLED,
  TRACE_AGENT_HEARTBEAT_GC_STALE, TRACE_AGENT_HEARTBEAT_GC_STOPPED, TRACE_AGENT_TMUX_LIVENESS_CORRECTION,
  TRACE_ARTIFACT_PROGRESS_CAP_EXCEEDED, TRACE_ARTIFACT_PROGRESS_NUDGE, TRACE_GRAPH_ADVANCE_NUDGE_EMITTED,
  formatNotifyKey,
} from "../constants.ts";
import { ensureAgentDefaults, inferRoleKind, safeId } from "../utils.ts";
import { checkStallNotificationStale, computeReadyNodes, computeTaskStatus, deriveNodeAttention, proxyMetricEmitLocked } from "../taskgraph.ts";
import { deliverMessageLocked, findIdempotentMessage } from "../mailbox.ts";
import { isTmuxRunning } from "../tmux.ts";
import { readState, readTaskState, taskPaths, trace, traceTask, withLock, writeState, writeTaskState } from "../state.ts";
import { readPoolHealth, slotKey, withPoolLock, writePoolHealth } from "../pool.ts";
import { isStallNudgeEligibleTaskStatus } from "./status-predicates.ts";
import { updateIdleEpochLocked } from "./goal-epoch.ts";
import { traceStaleSuppressedOnce } from "../surface.ts";

export async function sendGraphAdvanceNudgeLocked(pi: ExtensionAPI, cwd: string, p: Paths, st: SwarmState, taskId: string, nodeId: string, role: string): Promise<void> {
	// Per-(taskId, nodeId) monotonic seq store. Lazily initialized so pre-policy swarms boot cleanly.
	const graphAdvanceState = (st.graphAdvanceNudgeState ||= {});
	const perTask = (graphAdvanceState[taskId] ||= {});
	const perNode = (perTask[nodeId] ||= {});
	const priorSeq = perNode.nudgeSeq ?? 0;
	const nextSeq = priorSeq + 1;
	const key = formatNotifyKey(NOTIFY_KEY_GRAPH_ADVANCE, { taskId, nodeId, seq: String(nextSeq) });

	// Cap: count ALL prior sends for this (taskId, nodeId) across all seqs — the seq-prefix set.
	const keyPrefix = `task:${taskId}:node:${nodeId}:nudge:assign:seq:`;
	const prior = Object.values(st.messages || {}).filter((r) => r.to === "root" && (r.idempotencyKey?.startsWith(keyPrefix) ?? false));
	if (prior.length >= NOTIFY_DEFAULT_MAX_NUDGES) return; // cap: root has ignored the stall
	const lastSent = prior.map((r) => r.createdAt || "").sort().pop() || "";
	if (lastSent && Date.now() - new Date(lastSent).getTime() < NOTIFY_DEFAULT_COOLDOWN_MS) return; // cooldown
	if (findIdempotentMessage(st, "root", "root", key) && !prior.some((r) => r.ackedAt)) return; // in-flight, unacked: idempotent
	try {
		await deliverMessageLocked(pi, cwd, p, st, {
			to: "root",
			subject: `Node ${nodeId} (${role}) is READY but unassigned — advance task ${taskId} now`,
			body: `Task ${taskId} has stalled mid-graph: node \`${nodeId}\` (${role}) is READY (its dependencies are satisfied) but it is still unassigned, so no agent is working on it.\n\nAssign it now:\n  swarm_assign_task(taskId="${taskId}", nodeId="${nodeId}")\n\nThen KEEP DRIVING the graph to completion in the same turn — do not stop to summarize. After ${nodeId} completes, call swarm_next_nodes + swarm_assign_task for the next ready node, and repeat until every node is terminal. Never end a turn by merely describing the next step — ACT on it (call the tool).\n\n(Action required; this safety net auto-acknowledges once the node is assigned. If you cannot assign yet — e.g. scope conflict with an in-flight lease — ack and note the blocker; the nudge will re-arm after the cooldown, up to the cap.)`,
			requiresAck: true,
			idempotencyKey: key,
		});
		// Persist the seq ONLY after a successful emit (mirrors goal-nudge reconcile.ts:560 + task-stall
		// reconcile.ts:749). If deliverMessageLocked throws we want the next attempt to retry the same
		// seq, not skip ahead.
		perNode.nudgeSeq = nextSeq;
		perNode.lastNudgeAt = new Date().toISOString();
		await trace(p, TRACE_GRAPH_ADVANCE_NUDGE_EMITTED, { taskId, nodeId, seq: nextSeq, key, cap: NOTIFY_DEFAULT_MAX_NUDGES, cooldownMs: NOTIFY_DEFAULT_COOLDOWN_MS }).catch(() => {});
	} catch (err: any) {
		await trace(p, "graph.advance_nudge_failed", { taskId, nodeId, seq: nextSeq, error: String((err as Error)?.message || err) }).catch(() => {});
	}
}

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
// (ready but unassigned) and nudge; ack any outstanding assign nudge whose node is no longer stalled.
// Read-only on task state (never assigns).
export async function reconcileGraphAdvanceLocked(pi: ExtensionAPI, cwd: string, p: Paths, st: SwarmState, nowMs: number): Promise<void> {
	if (!existsSync(p.tasksDir)) return;
	let entries: string[] = [];
	try { entries = await readdir(p.tasksDir); } catch { return; }
	for (const taskId of entries) {
		const tp = taskPaths(p, taskId);
		if (!existsSync(tp.taskJson)) continue;
		let task: TaskState;
		try { task = await readTaskState(tp.taskJson); } catch { continue; }
		// Only drive active graphs. Done/blocked tasks have no ready work to assign.
		if (task.status !== "in_progress") continue;
		const cr = computeReadyNodes(task);
		const actionable = new Set([
			...cr.ready,
			...cr.current.filter((id) => task.nodes[id] && task.nodes[id].status === "ready" && !task.nodes[id].assignee),
		]);
		for (const nodeId of Object.keys(task.nodes)) {
			const node = task.nodes[nodeId];
			if (actionable.has(nodeId) && !node.assignee && !TERMINAL_NODE_STATUSES.has(node.status)) {
				// Lifecycle-fencing (issue 9, site 4): per-node staleness check before emitting a graph-advance
				// nudge. A node that has since become terminal / reassigned / closed must not be force-assigned
				// from this safety-net (the historical "force-assign unready nodes" bug). The predicate also
				// guards against nudging for a node whose assignee drifted (root pseudo-agent stays a
				// fine notify target — no filter on agentId=root here, since this nudge is addressed
				// to the root rather than a worker).
				const staleCheck = checkStallNotificationStale(st, task, nodeId, node.assignee || "root", nowMs);
				if (staleCheck.stale) {
					const keyForTrace = formatNotifyKey(NOTIFY_KEY_GRAPH_ADVANCE, { taskId, nodeId, seq: "1" });
					await traceStaleSuppressedOnce(p, "reconcile.graph_advance_nudge", { messageId: keyForTrace, idempotencyKey: keyForTrace, reason: staleCheck.reason, evidence: staleCheck.evidence });
					ackRootGraphAdvanceNudgesLocked(st, taskId, nodeId, nowMs, "auto-acked: node stale");
					continue;
				}
				await sendGraphAdvanceNudgeLocked(pi, cwd, p, st, taskId, nodeId, node.role || "worker");
			} else {
				// Node assigned / terminal / not yet ready -> clear any outstanding assign nudges for it.
				// Issue F2 (task-202608310422): clear ALL seq-suffixed records for this (taskId, nodeId),
				// not just the static key — with the new key shape there is no single static key to clear.
				ackRootGraphAdvanceNudgesLocked(st, taskId, nodeId, nowMs, "auto-acked: node assigned/left ready");
				// Stamp lastResolvedAt on the durable per-(task,node) seq store (seq survives; only the
				// resolved marker is set). Keeps the store consistent with the auto-ack.
				const graphAdvanceState = (st.graphAdvanceNudgeState ||= {});
				const perTask = (graphAdvanceState[taskId] ||= {});
				const perNode = (perTask[nodeId] ||= {});
				if (perNode.nudgeSeq !== undefined) perNode.lastResolvedAt = new Date(nowMs).toISOString();
			}
		}
	}
}

// Initial-ready watcher (reliability-roadmap Phase 1, P0 #2): for every freshly created task whose
// start node remains READY + unassigned beyond TASK_INITIAL_READY_GRACE_MS, send exactly one
// idempotent action-required nudge to the root. Never auto-assigns, never auto-spawns, and
// auto-clears as soon as the node leaves the `ready`+unassigned state. Honors the shared semantic
// dedupe + per-task cap policy (NOTIFY_DEFAULT_MAX_NUDGES). Runs alongside the graph-advance watcher.

export async function reconcileInitialReadyLocked(pi: ExtensionAPI, cwd: string, p: Paths, st: SwarmState, nowMs: number): Promise<void> {
	if (!existsSync(p.tasksDir)) return;
	let entries: string[] = [];
	try { entries = await readdir(p.tasksDir); } catch { return; }
	for (const taskId of entries) {
		const tp = taskPaths(p, taskId);
		if (!existsSync(tp.taskJson)) continue;
		let task: TaskState;
		try { task = await readTaskState(tp.taskJson); } catch { continue; }
		// Only act on tasks that have never progressed past the very first node. `in_progress` is handled
		// by the graph-advance watcher; terminal states have no actionable start node.
		if (task.status !== "ready") continue;
		const startId = task.start;
		const startNode = task.nodes[startId];
		if (!startNode) continue;
		if (startNode.status !== "ready" || startNode.assignee) continue;
		const createdAt = task.createdAt ? new Date(task.createdAt).getTime() : nowMs;
		const age = nowMs - createdAt;
		const key = formatNotifyKey(NOTIFY_KEY_INITIAL_READY, { taskId });
		if (age < TASK_INITIAL_READY_GRACE_MS) {
			ackRootNudgeLocked(st, key, nowMs, "auto-acked: still within grace period");
			continue;
		}
		// Cap: stop nudging once the root has ignored the same key MAX times.
		const existing = Object.values(st.messages || {}).filter((r) => r.to === "root" && r.idempotencyKey === key);
		if (existing.length >= NOTIFY_DEFAULT_MAX_NUDGES) continue;
		if (findIdempotentMessage(st, "root", "root", key)) continue;
		// Cooldown: never re-send within NOTIFY_DEFAULT_COOLDOWN_MS of the last send for the same key.
		const last = existing.map((r) => r.createdAt || "").sort().pop() || "";
		if (last && nowMs - new Date(last).getTime() < NOTIFY_DEFAULT_COOLDOWN_MS) continue;
		// Lifecycle-fencing (issue 9, site 5): per-node staleness check before the initial-ready nudge.
		// Task status="ready" already rules out conditions (1)/(2) — but we still run the predicate so a
		// cancelled attempt, assignee drift, or agent-stopped transition can short-circuit the emit. The
		// start node's "assignee" here is always undefined (filtered above), so the predicate agentId
		// placeholder is "root" (the only recipient of this nudge anyway).
		const staleCheck = checkStallNotificationStale(st, task, startId, startNode.assignee || "root", nowMs);
		if (staleCheck.stale) {
			await traceStaleSuppressedOnce(p, "reconcile.initial_ready_nudge", { messageId: key, idempotencyKey: key, reason: staleCheck.reason, evidence: staleCheck.evidence });
			ackRootNudgeLocked(st, key, nowMs, "auto-acked: node stale");
			continue;
		}
		await sendInitialReadyNudgeLocked(pi, cwd, p, st, task, startId, key);
	}
}

async function sendInitialReadyNudgeLocked(pi: ExtensionAPI, cwd: string, p: Paths, st: SwarmState, task: TaskState, startId: string, key: string): Promise<void> {
	const taskId = task.taskId;
	const startNode = task.nodes[startId];
	const role = startNode.role || "worker";
	try {
		await deliverMessageLocked(pi, cwd, p, st, {
			to: "root",
			subject: `Task ${taskId} start node is ready but unassigned`,
			body: `Task ${taskId} ("${task.title || taskId}") was created ${Math.max(1, Math.round((Date.now() - new Date(task.createdAt || Date.now()).getTime()) / 60000))} minute(s) ago but its start node \`${startId}\` (${role}) is still ready and unassigned.\n\nAction required:\n  swarm_assign_task(taskId="${taskId}", nodeId="${startId}")\n\nAlternative actions:\n  swarm_assign_task(taskId="${taskId}", nodeId="${startId}", force=true)   # root-only override\n  swarm_update_task(taskId="${taskId}", nodeId="${startId}", cancelTask=true, force=true)   # root-only cancel\n\n(Auto-clears once ${startId} is assigned or the task leaves the ready state.)`,
			requiresAck: true,
			idempotencyKey: key,
		});
	} catch (err: any) {
		await trace(p, "task.initial_ready_nudge_failed", { taskId, nodeId: startId, error: String((err as Error)?.message || err) }).catch(() => {});
	}
}

// === Issue 27: effective-liveness helper for idle predicates ===
// An agent participates in the goal-nudge / task-stall all-idle predicate only if its record is
// actually live: status "running", tmux not known-dead, and heartbeat within the stale window
// (default 10 min, override PI_SWARM_AGENT_HEARTBEAT_STALE_MS). Ghost records left behind by
// dead panes are excluded rather than counted as busy — previously 100+ stopped ghosts starved
// both nudges forever (goal.nudge never emitted since goal set).
const AGENT_HEARTBEAT_STALE_MS = Number(process.env.PI_SWARM_AGENT_HEARTBEAT_STALE_MS ?? 10 * 60_000);


export async function evaluateTaskGraphStallNudgeLocked(
	pi: ExtensionAPI,
	cwd: string,
	p: Paths,
	st: SwarmState,
	nowMs: number,
): Promise<{ emitted: boolean; reason: string; taskId?: string }> {
	// Predicate 1: at least one in_progress task exists.
	if (!existsSync(p.tasksDir)) return { emitted: false, reason: "no_active_task" };

	// Build the per-task actionable snapshot under one readdir pass. We use this list both to
	// determine whether a nudge is warranted AND to construct the actionable-node list surfaced
	// in the nudge body.
	let tasks: Array<{ task: TaskState; tp: TaskPaths }> = [];
	try {
		const entries = await readdir(p.tasksDir);
		for (const taskId of entries) {
			const tp = taskPaths(p, taskId);
			if (!existsSync(tp.taskJson)) continue;
			try {
				const t = await readTaskState(tp.taskJson);
				// Row 68 fix (AC1): include fresh status="ready" tasks (created, never assigned) —
				// non-terminal candidates only; the per-node actionable filter below still gates.
				if (isStallNudgeEligibleTaskStatus(t.status)) tasks.push({ task: t, tp });
			} catch { /* skip unreadable */ }
		}
	} catch { /* unreadable tasksDir === no active tasks */ }
	if (!tasks.length) return { emitted: false, reason: "no_active_task" };

	// Predicate 3: every non-root agent must be runtimeStatus === "idle".
	// Issue 27: mirrors evaluateIdleGoalNudgeLocked — only effectively-alive agents participate;
	// stopped/stale ghost records must not starve this nudge either.
	// Row 68: the shared idle-epoch update runs here (idempotent) so the busy→all-idle edge is
	// anchored at swarm level even with no goal set. A busy effective agent also resets per-task
	// stall spacing (inside updateIdleEpochLocked) so the next all-idle edge re-arms immediacy.
	const epoch = await updateIdleEpochLocked(p, st, nowMs);
	const { idleAgents, allIdle } = epoch;
	if (!allIdle) return { emitted: false, reason: "agent_busy" };
	const idleAnchorMs = st.idleNudgeState?.allIdleSinceAt ? new Date(st.idleNudgeState.allIdleSinceAt).getTime() : NaN;

	// Pick the first task with actionable+unassigned nodes that ALSO passes the grace period AND
	// doesn't already have a graph-advance nudge firing for the actionable node (predicate 5).
	for (const { task, tp } of tasks) {
		const taskId = task.taskId;
		// Predicate 4: task age >= TASK_INITIAL_READY_GRACE_MS.
		const createdAt = task.createdAt ? new Date(task.createdAt).getTime() : nowMs;
		const age = nowMs - createdAt;
		if (age < TASK_INITIAL_READY_GRACE_MS) return { emitted: false, reason: "within_grace" };

		// Predicate 2 + 5: actionable+unassigned AND no in-flight graph-advance nudge for any of them.
		const cr = computeReadyNodes(task);
		const actionable = new Set([
			...cr.ready,
			...cr.current.filter((id) => task.nodes[id] && task.nodes[id].status === "ready" && !task.nodes[id].assignee),
		]);
		const actionableNodes = Array.from(actionable).filter((id) => {
			const n = task.nodes[id];
			return n && !n.assignee && !TERMINAL_NODE_STATUSES.has(n.status);
		});
		if (!actionableNodes.length) continue;

		// Predicate 5: skip if a graph-advance nudge is already firing for any actionable node.
		// Issue F2 (task-202608310422): with the seq-suffixed key, "already firing" means ANY seq
		// record for that (taskId, nodeId) is unacked — match the seq-prefix set, not a static key.
		let graphAdvanceActive = false;
		for (const nodeId of actionableNodes) {
			const advanceKeyPrefix = `task:${taskId}:node:${nodeId}:nudge:assign:seq:`;
			const hasActive = Object.values(st.messages || {}).some((r) => r.to === "root" && !r.ackedAt && (r.idempotencyKey?.startsWith(advanceKeyPrefix) ?? false));
			if (hasActive) { graphAdvanceActive = true; break; }
		}
		if (graphAdvanceActive) continue;

		// Per-task back-off + max-nudge bookkeeping (mirrors Issue 18). Row 68: emission cadence is
		// interval-spaced (nextStallNudgeAt), NOT pump-tick-spaced. The first stall nudge for a fresh
		// stall is IMMEDIATE (the graph actionable+all-idle path), then re-fires only after a full
		// continuous all-idle interval.
		const stallState: SwarmTaskStallState = st.taskStallState?.[taskId] || {
			taskId,
			consecutiveNoResolveNudges: 0,
		};
		if (!stallState.nextStallNudgeAt) {
			// Fresh stall (or epoch was reset since the last emission): fire immediately.
			stallState.nextStallNudgeAt = new Date(Math.min(nowMs, idleAnchorMs + TASK_STALL_NUDGE_IDLE_INTERVAL_MS)).toISOString();
		} else if (nowMs < new Date(stallState.nextStallNudgeAt).getTime()) {
			return { emitted: false, reason: "stall_interval_pending", taskId };
		}
		// Interval boundary reached: back-off consumes one slot per INTERVAL, not per tick. We do NOT
		// emit on the interval that drains back-off to 0 — the decrement itself is the gate.
		if (stallState.backoffTicksRemaining && stallState.backoffTicksRemaining > 0) {
			stallState.backoffTicksRemaining -= 1;
			stallState.nextStallNudgeAt = new Date(nowMs + TASK_STALL_NUDGE_IDLE_INTERVAL_MS).toISOString();
			if (!st.taskStallState) st.taskStallState = {};
			st.taskStallState[taskId] = stallState;
			if (stallState.backoffTicksRemaining === 0) {
				await trace(p, "task_stall.nudge.backoff.exhausted", { taskId, by: 1 }).catch(() => {});
				return { emitted: false, reason: "backoff_just_exhausted", taskId };
			}
			await trace(p, "task_stall.nudge.backoff.skip", { taskId, remaining: stallState.backoffTicksRemaining }).catch(() => {});
			return { emitted: false, reason: "backoff", taskId };
		}

		// Already at cap? Enter / re-arm the back-off window on the next interval opportunity. We do
		// NOT emit on this interval.
		if (stallState.consecutiveNoResolveNudges >= MAX_TASK_STALL_NUDGES) {
			if (!stallState.backoffTicksRemaining) {
				stallState.backoffTicksRemaining = GOAL_NUDGE_BACKOFF_TICKS;
				stallState.nextStallNudgeAt = new Date(nowMs + TASK_STALL_NUDGE_IDLE_INTERVAL_MS).toISOString();
				if (!st.taskStallState) st.taskStallState = {};
				st.taskStallState[taskId] = stallState;
				await trace(p, "task_stall.nudge.backoff", { taskId, nudges: stallState.consecutiveNoResolveNudges, max: MAX_TASK_STALL_NUDGES, backoffTicks: GOAL_NUDGE_BACKOFF_TICKS }).catch(() => {});
			}
			return { emitted: false, reason: "max_nudges", taskId };
		}

		// Idempotency: one nudge per (taskId, nudge-sequence). Same fix as the goal nudge — a static
		// per-task key allowed exactly one stall nudge per task ever; seq gives each emit a fresh slot
		// while still blocking double-emits within a tick.
		const nudgeSeq = (stallState.nudgeSeq ?? 0) + 1;
		const key = formatNotifyKey(NOTIFY_KEY_TASK_GRAPH_STALL, { taskId, seq: String(nudgeSeq) });
		if (findIdempotentMessage(st, "root", "root", key)) {
			return { emitted: false, reason: "duplicate_suppressed", taskId };
		}

		// Emit the nudge.
		const nudgeNumber = stallState.consecutiveNoResolveNudges + 1;
		const nodeList = actionableNodes
			.slice(0, 5)
			.map((id) => `${id} (${task.nodes[id].role || "worker"})`)
			.concat(actionableNodes.length > 5 ? [`+${actionableNodes.length - 5} more`] : []);
		const subject = `Pipeline stall: task ${taskId} has ${actionableNodes.length} actionable but unassigned node(s)`;
		const body =
			`Task ${taskId} ("${task.title || taskId}") is ${task.status || "in_progress"} but has ${actionableNodes.length} actionable-but-unassigned node(s):\n` +
			`  - ${nodeList.join("\n  - ")}\n\n` +
			`All ${idleAgents.length} non-root agent(s) are runtimeStatus=idle and no worker has claimed these nodes.\n\n` +
			`This is nudge ${nudgeNumber} of ${MAX_TASK_STALL_NUDGES} before back-off.\n\n` +
			`Action:\n` +
			`  swarm_assign_task(taskId="${taskId}", nodeId="${actionableNodes[0]}")\n\n` +
			`Alternative actions:\n` +
			`  swarm_assign_task(taskId="${taskId}", nodeId="${actionableNodes[0]}", force=true)   # root-only override\n` +
			`  swarm_update_task(taskId="${taskId}", nodeId="${actionableNodes[0]}", cancelTask=true, force=true)   # root-only abandon\n\n` +
			`(Any reassignment of an actionable node — including a worker's claim of an unassigned node via swarm_update_task — resets the counter.)`;
		await deliverMessageLocked(pi, cwd, p, st, {
			to: "root",
			subject,
			body,
			conversationId: `task:${taskId}:${actionableNodes[0]}`,
			requiresAck: true,
			idempotencyKey: key,
			priority: "normal",
		});

		stallState.consecutiveNoResolveNudges += 1;
		stallState.nudgeSeq = nudgeSeq;
		stallState.lastNudgeAt = new Date(nowMs).toISOString();
		stallState.nextStallNudgeAt = new Date(nowMs + TASK_STALL_NUDGE_IDLE_INTERVAL_MS).toISOString();
		if (!st.taskStallState) st.taskStallState = {};
		st.taskStallState[taskId] = stallState;
		await trace(p, "task_stall.nudge_emitted", {
			taskId,
			actionableCount: actionableNodes.length,
			actionable: actionableNodes,
			consecutiveCount: stallState.consecutiveNoResolveNudges,
			max: MAX_TASK_STALL_NUDGES,
			idleAgents: idleAgents.length,
			key,
		});
		return { emitted: true, reason: "emitted", taskId };
	}

	// Tasks scanned but no actionable pass-through.
	return { emitted: false, reason: "no_active_node" };
}

// === Issue 23: resolveTaskStallLocked ===
// Reset the per-task task-stall nudge counter when a stalled task graph advances (Issue 23
// "resolve detection"). Called by:
//   - swarm_assign_task (after stamping node.assignee) — resolves because an actionable node now
//     has an assignee.
//   - swarm_update_task claim branch (Issue 24.a) — same; a worker claimed an unassigned node.
//   - applyTaskStatus terminal-transition sites (Issue 23 B3 placement) — resolves because the
//     task left in_progress.
// === R20 — artifact-progress self-nudge (Issue: "settled idle with open assignment") ===
// Pump-tick phase. Detects when an agent has written an artifact (fs.stat mtime > baseline +
// grace) but the task node is still open (status in {assigned, in_progress}). Delivers a high-
// priority, action-oriented nudge to the agent itself (NOT the root) BEFORE it can
// settle, naming the exact close-action triple:
//
//   swarm_update_task(taskId=..., nodeId=..., status=done|failed|blocked, outcome=...)
//   swarm_send_message(to="root", replyTo="<assignment msg id>", subject=..., body=...)
//   swarm_ack_message(messageId="<assignment msg id>", status=done, resultMessageId=...)
//
// The triple is the canonical R16/R19 lesson: the failure mode that R20 fixes is the worker
// completing real work but never issuing close calls. The body tells the agent, step by step,
// what to call — with explicit `<assignment msg id>` placeholders the worker can substitute
// from its own mailbox.
//
// Tunables (env-overridable via constants.ts):
//   - ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS (default 5min): dedupe gate between consecutive nudges.
//   - ARTIFACT_PROGRESS_NUDGE_CAP (default 3): per-node counter; once exceeded, escalate to the
//     root (one-line `worker.artifact_progress_cap_exceeded` trace + stop nudging).
//   - ARTIFACT_PROGRESS_GRACE_MS (default 60s): mtime must exceed baseline by at least this.
//   - ARTIFACT_PROGRESS_MAX_FILES (default 50): hard cap on allowedFiles fs.stat calls per node.
//   - ARTIFACT_PROGRESS_ACTIVE_AGENT_SKIP_MS (default 60s): skip when agent.lastToolAt is fresh.
//
// Baseline: reuses node.lastProgressAt (Issue 83a) — the existing forward-progress stamp. The
// trigger predicate is: maxMtimeMs > max(lastProgressAt, artifactProgressNudgeAt ?? 0) +
// ARTIFACT_PROGRESS_GRACE_MS. This anchors on real agent activity; a worker that just stamped
// lastProgressAt is NOT eligible until a NEW write lands.
//
// Output: returns an inspectable summary `{ inspected, nudged, escalated, scannedFiles }` so the
// pump loop + tests can verify behavior without poking into private state.
export async function evaluateArtifactProgressNudgeLocked(pi: ExtensionAPI, cwd: string, p: Paths, st: SwarmState, nowMs: number): Promise<{ inspected: number; nudged: number; escalated: number; scannedFiles: number }> {
	let inspected = 0, nudged = 0, escalated = 0, scannedFiles = 0;
	if (!existsSync(p.tasksDir)) return { inspected, nudged, escalated, scannedFiles };
	let taskDirs: string[] = [];
	try { taskDirs = await readdir(p.tasksDir); } catch { return { inspected, nudged, escalated, scannedFiles }; }
	const dirtyTaskPaths = new Set<TaskPaths>();
	const tpToTask = new Map<TaskPaths, TaskState>();
	for (const taskDir of taskDirs) {
		const tp = taskPaths(p, taskDir);
		if (!existsSync(tp.taskJson)) continue;
		let task: TaskState;
		try { task = await readTaskState(tp.taskJson); } catch { continue; }
		tpToTask.set(tp, task);
		for (const [nodeId, node] of Object.entries(task.nodes)) {
			if (!node) continue;
			if (node.status !== "assigned" && node.status !== "in_progress") continue;
			// Root self-nudge suppression (OQ2): skip when the assignee is the root
			// pseudo-agent (no real worker pane to nudge; the root drives its own work).
			if (!node.assignee || node.assignee === "root") continue;
			// Skip when the node has no allowedFiles (OQ3 default: too noisy to track whole-project mtime).
			const effectiveAllowed: string[] = node.allowedFiles && node.allowedFiles.length > 0 ? node.allowedFiles : (task.allowedFiles && task.allowedFiles.length > 0 ? task.allowedFiles : []);
			if (effectiveAllowed.length === 0) continue;
			inspected++;
			// fs.stat each allowed file; cap at ARTIFACT_PROGRESS_MAX_FILES. The "max mtime across
			// the node's allowed scope" is the artifact-progress signal.
			let maxMtimeMs = 0;
			let contributingFile: string | null = null;
			const files = effectiveAllowed.slice(0, ARTIFACT_PROGRESS_MAX_FILES);
			scannedFiles += files.length;
			for (const rel of files) {
				try {
					const s = await stat(join(cwd, rel));
					const mt = s.mtimeMs || (s.mtime ? s.mtime.getTime() : 0);
					if (mt > maxMtimeMs) { maxMtimeMs = mt; contributingFile = rel; }
				} catch { /* file not on disk yet (worker hasn't created it) — skip */ }
			}
			if (!contributingFile) continue;
			// Baseline: max(lastProgressAt, artifactProgressNudgeAt). A worker that just got nudged
			// is NOT eligible for another nudge unless NEW progress lands (the backoff gate).
			const baselineMs = Math.max(
				node.lastProgressAt ? new Date(node.lastProgressAt).getTime() : 0,
				node.artifactProgressNudgeAt ? new Date(node.artifactProgressNudgeAt).getTime() : 0,
			);
			if (maxMtimeMs <= baselineMs + ARTIFACT_PROGRESS_GRACE_MS) continue;
			// Active-agent skip (R20-S5): if the worker is still making tool calls, no nudge.
			const agent = st.agents[node.assignee];
			if (!agent) continue;
			const lastToolMs = agent.lastToolAt ? new Date(agent.lastToolAt).getTime() : 0;
			if (lastToolMs && nowMs - lastToolMs <= ARTIFACT_PROGRESS_ACTIVE_AGENT_SKIP_MS) continue;
			// Cap exceeded: emit one-line root escalation + dedupe-gated trace.
			// Cap-exceeded fires AT MOST ONCE per node per forward-progress cycle (the
			// forward-transition reset in tools/tasks.ts clears artifactProgressNudgeAt). This
			// keeps the root's mailbox uncluttered while still surfacing the cap breach.
			const priorCount = node.artifactProgressNudgeCount ?? 0;
			if (priorCount >= ARTIFACT_PROGRESS_NUDGE_CAP) {
				// Idempotent dedupe via a dedicated flag: only emit the cap-exceeded trace once per
				// cycle. Subsequent ticks within the same stalled cycle stay silent — the
				// root already has the escalation; more repeats would just clutter traces.
				if (!node.artifactProgressCapSurfaced) {
					await trace(p, TRACE_ARTIFACT_PROGRESS_CAP_EXCEEDED, { taskId: task.taskId, nodeId, assignee: node.assignee, nudgeCount: priorCount, cap: ARTIFACT_PROGRESS_NUDGE_CAP, contributingFile, maxMtimeMs, lastProgressAt: node.lastProgressAt ?? null, lastToolAt: agent.lastToolAt ?? null }).catch(() => {});
					// Lightweight root escalation: durable mailbox delivery so the root
					// sees the "node stalled with N ignored nudges" line on its next pump tick.
					try {
						await deliverMessageLocked(pi, cwd, p, st, {
							to: "root",
							priority: "high",
							subject: `ARTIFACT-PROGRESS CAP: node ${nodeId} of ${task.taskId} stalled after ${priorCount} nudges`,
							body: `Node \`${nodeId}\` of task \`${task.taskId}\` has artifact progress on disk (${contributingFile}, mtime ${new Date(maxMtimeMs).toISOString()}) but the worker has ignored ${priorCount} artifact-progress nudges (cap ${ARTIFACT_PROGRESS_NUDGE_CAP}). Worker \`${node.assignee}\` is still assigned. Recommend: restart the agent or force-close the node (swarm_update_task force=true).`,
							requiresAck: false,
							requiresResponse: false,
							idempotencyKey: `r20:cap:${task.taskId}:${nodeId}`,
						});
					} catch { /* escalation is informational; never throw out of the tick */ }
					node.artifactProgressNudgeAt = new Date(nowMs).toISOString();
					node.artifactProgressCapSurfaced = true;
					escalated++;
					dirtyTaskPaths.add(tp);
				}
				continue;
			}
			// Compose the action-oriented nudge body. The exact close-action triple is the payload.
			const lastProgressIso = node.lastProgressAt ?? "never";
			const fileMtimeIso = new Date(maxMtimeMs).toISOString();
			const assignmentMsgId = node.assignmentMessageId ?? `<assignment msg id for ${task.taskId}:${nodeId}>`;
			const body = [
				`[PI-SWARM ARTIFACT-PROGRESS NUDGE] (high-priority)`,
				`File detected: ${contributingFile} (mtime ${fileMtimeIso})`,
				`Node ${nodeId} still ${node.status}. Last update: ${lastProgressIso}.`,
				``,
				`You are 1 step from closing the task. To finish:`,
				``,
				`  swarm_update_task(taskId="${task.taskId}", nodeId="${nodeId}", status=done|failed|blocked, outcome=<one of: planned|implemented|tested|reviewed|approved|rejected|failed>)`,
				``,
				`  swarm_send_message(`,
				`    to="root",`,
				`    replyTo="${assignmentMsgId}",`,
				`    subject="${task.taskId}:${nodeId} done",`,
				`    body="<1-line summary>"`,
				`  )`,
				``,
				`  swarm_ack_message(messageId="${assignmentMsgId}", status=done, resultMessageId="<result msg id>")`,
				``,
				`If the work is genuinely incomplete, call swarm_update_task(status=blocked, note=<reason>) instead.`,
				`(Auto-backoff: ${Math.round(ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS / 60000)} min between nudges; cap ${ARTIFACT_PROGRESS_NUDGE_CAP} then escalate to root.)`,
			].join("\n");
			try {
				await deliverMessageLocked(pi, cwd, p, st, {
					to: node.assignee,
					priority: "high",
					subject: `ARTIFACT-PROGRESS: close ${task.taskId}:${nodeId} now`,
					body,
					conversationId: `task:${task.taskId}:${nodeId}`,
					replyTo: node.assignmentMessageId,
					requiresAck: true,
					requiresResponse: true,
					idempotencyKey: `r20:nudge:${task.taskId}:${nodeId}:${priorCount + 1}`,
				});
				node.artifactProgressNudgeAt = new Date(nowMs).toISOString();
				node.artifactProgressNudgeCount = priorCount + 1;
				await trace(p, TRACE_ARTIFACT_PROGRESS_NUDGE, { taskId: task.taskId, nodeId, assignee: node.assignee, contributingFile, maxMtimeMs, baselineMs, lastProgressAt: node.lastProgressAt ?? null, lastToolAt: agent.lastToolAt ?? null, nudgeCount: node.artifactProgressNudgeCount, cap: ARTIFACT_PROGRESS_NUDGE_CAP, backoffMs: ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS, gracefulMs: ARTIFACT_PROGRESS_GRACE_MS }).catch(() => {});
				nudged++;
				dirtyTaskPaths.add(tp);
			} catch (err: any) {
				await trace(p, "worker.artifact_progress_nudge_failed", { taskId: task.taskId, nodeId, assignee: node.assignee, error: String((err as Error)?.message || err) }).catch(() => {});
			}
		}
	}
	// Persist any task.json mutations (node.artifactProgressNudgeAt / Count). The in-memory
	// `task` reference holds our mutations; writeTaskState serializes the LIVE object (no
	// fresh re-read, which would lose the in-memory mutations because readTaskState deserializes
	// a new copy). Updated updatedAt is stamped inside writeTaskState.
	for (const tp of Array.from(dirtyTaskPaths)) {
		try { await writeTaskState(tp, tpToTask.get(tp)!); } catch { /* best-effort */ }
	}
	if (nudged || escalated || inspected) {
		await writeState(p, st).catch(() => {});
	}
	return { inspected, nudged, escalated, scannedFiles };
}
// === Issue 82: heartbeat-driven agent GC pass (P0, R9 a3 graveyard) ===
// Runs once per pump tick under the existing withLock. Bounded cost:
//   - O(N) over agents for the cheap heartbeat gate (no I/O).
//   - tmux probes ONLY for agents whose lastHeartbeatAt is older than 2× the stale window
//     (we can't tell from lastHeartbeatAt alone whether the pane is gone — we sample tmux).
// Hard rules:
//   - Root pseudo-agent is exempt (its heartbeat is owned by the leader lease).
//   - Paused agents: status/health untouched (they're dormant by design; the lease honors park).
//   - Lease-valid agents (reuse): status/health untouched (root wants them around).
//   - When the tmux probe disagrees with the in-memory `tmuxAlive` field, we update the field
//     and emit `agent.tmux_liveness_correction`. The field is otherwise stale-by-design (refreshed
//     on tool calls / hook events; this GC pass picks up the stragglers).
//   - Mark-stopped is non-destructive: stopAgent is NOT called here (we leave that to the next
//     sweepTaskWorkersLocked or explicit /swarm stop). The GC just flips the status flag so
//     downstream sweeps / prunes can pick it up.
export async function agentHeartbeatGCLocked(pi: ExtensionAPI, cwd: string, p: Paths, st: SwarmState, nowMs: number): Promise<{ stopped: number; stale: number; corrected: number; probesFired: number; probesThrottled: number; expiredParkFlipped: number }> {
	// Source the threshold from constants (single source of truth; env override is operator-only).
	const staleWindow = Number(process.env.PI_SWARM_AGENT_HEARTBEAT_STALE_MS ?? DEFAULT_AGENT_HEARTBEAT_STALE_MS);
	const probeAfterMs = staleWindow * 2;
	let stopped = 0, stale = 0, corrected = 0, probesFired = 0, probesThrottled = 0, expiredParkFlipped = 0;
	for (const agent of Object.values(st.agents)) {
		if (agent.id === "root") continue;
		const leaseKind = agent.leaseKind;
		const leaseUntilMs = agent.leaseUntil ? new Date(agent.leaseUntil).getTime() : 0;
		// Both `reuse` and `park` leases exempt the agent from the heartbeat GC: `reuse` because
		// the root wants the worker kept alive for cross-task reuse; `park` because parking
		// is the sweep's job (the GC must not flip a parked agent to stopped — the parked pane is
		// intentionally dormant and may be revived by the operator). Lease validity requires both
		// `leaseKind` set AND `leaseUntil > now`.
		const leaseValid = (leaseKind === "reuse" || leaseKind === "park") && leaseUntilMs > nowMs;
		if (leaseValid) continue;
		// Review item 3 fix: a paused agent is normally exempt (skip). BUT if the agent has an
		// EXPIRED lease (lease fields set + leaseUntil <= now), the pause no longer represents
		// an intentional operator hold — it's a stranded zombie. Fall through to the gates so
		// gate 1 can still flip a dead-pane expired-park agent to stopped. Without this fix, an
		// expired-park agent whose pane died post-expiry stays status:running forever, immune to
		// both heartbeat GC and the task-close sweep (which also exempts paused).
		const paused = agent.paused === true;
		const expiredLease = !leaseValid && (leaseKind === "reuse" || leaseKind === "park");
		if (paused && !expiredLease) continue;
		const hb = agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt).getTime() : 0;
		const hbAge = hb ? nowMs - hb : Number.POSITIVE_INFINITY;
		const lastProbeAtMs = agent.lastProbeAt ? new Date(agent.lastProbeAt).getTime() : 0;
		// Cheap gate 1: pane known-dead (carried over from a previous probe) + running -> mark stopped.
		// (A stopped agent that stays `tmuxAlive:false` is left alone — it was already counted.)
		if (agent.tmuxAlive === false && agent.status === "running") {
			agent.status = "stopped";
			agent.runtimeStatus = "stopped";
			agent.health = "unhealthy";
			agent.lastShutdownAt ||= new Date(nowMs).toISOString();
			agent.updatedAt = new Date(nowMs).toISOString();
			stopped++;
			if (paused && expiredLease) {
				expiredParkFlipped++;
				await trace(p, TRACE_AGENT_HEARTBEAT_GC_EXPIRED_PARK_FLIPPED, { agentId: agent.id, reason: "tmux_dead_after_lease_expiry", hbAgeMs: hbAge === Number.POSITIVE_INFINITY ? null : hbAge }).catch(() => {});
			} else {
				await trace(p, TRACE_AGENT_HEARTBEAT_GC_STOPPED, { agentId: agent.id, reason: "tmux_dead", hbAgeMs: hbAge === Number.POSITIVE_INFINITY ? null : hbAge }).catch(() => {});
			}
			continue;
		}
		// Cheap gate 2: heartbeat too old AND tmuxTarget set AND plausibly alive (status:running +
		// tmuxAlive !== false) AND probe ledger permits (lastProbeAt older than probeAfterMs).
		// The plausibly-alive guard is the review item 1 fix: a stopped agent with a stale
		// heartbeat must NOT be probed every tick (the original bug — would re-probe the entire
		// graveyard forever, holding the swarm lock for seconds per tick).
		// The probe ledger is the cost-bound the plan/implementation-report claimed: each agent
		// is probed at most once per `probeAfterMs` window (~20 min default), regardless of how
		// stale its heartbeat is.
		if (
			hbAge > probeAfterMs &&
			agent.tmuxTarget &&
			agent.tmuxTarget !== "unknown" &&
			agent.status === "running" &&
			agent.tmuxAlive !== false &&
			(nowMs - lastProbeAtMs > probeAfterMs)
		) {
			agent.lastProbeAt = new Date(nowMs).toISOString();
			probesFired++;
			const alive = await isTmuxRunning(pi, agent.tmuxTarget);
			if (alive !== agent.tmuxAlive) {
				const previous = agent.tmuxAlive ?? null;
				agent.tmuxAlive = alive;
				corrected++;
				await trace(p, TRACE_AGENT_TMUX_LIVENESS_CORRECTION, { agentId: agent.id, alive, previous, hbAgeMs: hbAge === Number.POSITIVE_INFINITY ? null : hbAge }).catch(() => {});
			}
			if (!alive && agent.status === "running") {
				agent.status = "stopped";
				agent.runtimeStatus = "stopped";
				agent.health = "unhealthy";
				agent.lastShutdownAt ||= new Date(nowMs).toISOString();
				agent.updatedAt = new Date(nowMs).toISOString();
				stopped++;
				await trace(p, TRACE_AGENT_HEARTBEAT_GC_STOPPED, { agentId: agent.id, reason: "tmux_dead_after_probe", hbAgeMs: hbAge === Number.POSITIVE_INFINITY ? null : hbAge }).catch(() => {});
				continue;
			}
		} else if (
			hbAge > probeAfterMs &&
			agent.tmuxTarget &&
			agent.tmuxTarget !== "unknown" &&
			(nowMs - lastProbeAtMs <= probeAfterMs)
		) {
			// Review item 1 evidence trace: emit a throttle-skip counter when gate 2 conditions
			// are met but the probe ledger blocks the probe. Cheap (one trace per skipped agent
			// per tick); dashboards can chart probe-skip rates without re-reading state.
			probesThrottled++;
			await trace(p, TRACE_AGENT_HEARTBEAT_GC_PROBE_THROTTLED, { agentId: agent.id, hbAgeMs: hbAge === Number.POSITIVE_INFINITY ? null : hbAge, lastProbeAtMs: lastProbeAtMs || null, probeAfterMs }).catch(() => {});
		}
		// Cheap gate 3: heartbeat too old AND idle -> mark stale (downgrade; don't stop).
		if (hbAge > staleWindow && agent.runtimeStatus === "idle") {
			if (agent.health !== "stale") {
				agent.health = "stale";
				agent.updatedAt = new Date(nowMs).toISOString();
				stale++;
				await trace(p, TRACE_AGENT_HEARTBEAT_GC_STALE, { agentId: agent.id, hbAgeMs: hbAge }).catch(() => {});
			}
		}
	}
	if (stopped || stale || corrected) {
		await writeState(p, st);
	}
	return { stopped, stale, corrected, probesFired, probesThrottled, expiredParkFlipped };
}

//
// Pure state mutation: deletes backoffTicksRemaining + nextStallNudgeAt, resets
// consecutiveNoResolveNudges to 0, stamps lastResolvedAt, and emits `task_stall.nudge.resolved` for
// trace visibility. Mirrors the goal-nudge reset hook (turn_end in hooks.ts:484-506) but lives next
// to the mutation sites because the task-stall counter resolves on graph-mutation events, not on
// root turn-end. Clearing nextStallNudgeAt means the next stall fires immediately (fresh
// stall → immediate nudge) rather than waiting out a stale interval window.
export function resolveTaskStallLocked(p: Paths, st: SwarmState, taskId: string, reason: string): void {
	const slot = st.taskStallState?.[taskId];
	if (!slot) return; // never stalled — nothing to reset
	const wasStalled = slot.consecutiveNoResolveNudges > 0 || (slot.backoffTicksRemaining ?? 0) > 0;
	slot.consecutiveNoResolveNudges = 0;
	delete slot.backoffTicksRemaining;
	delete slot.nextStallNudgeAt;
	slot.lastResolvedAt = new Date().toISOString();
	if (!st.taskStallState) st.taskStallState = {};
	st.taskStallState[taskId] = slot;
	if (wasStalled) {
		// Fire-and-forget: trace helper is async but the lock-held caller can't await without
		// nesting, so we schedule a tick. Idempotent + best-effort; failures are swallowed.
		trace(p, "task_stall.nudge.resolved", { taskId, reason }).catch(() => {});
	}
}

// === Issue 21 quota-reset-interval: slot recovery scan ===
// When a slot's bench naturally expires (cooldownUntil < nowMs) AND lastBenchReason === "quota"
// AND at least one agent on that slot has activeTaskIds, emit `pool.slot_recovered` so the
// root's existing dashboard/trace surface can decide whether to resume (NO auto-resume —
// the root-driven recovery contract). Manual benches (lastBenchReason undefined) and
// benches for non-quota reasons (auth/rate_limit/transient/unknown) NEVER emit recovery events —
// the gate is strict on kind === "quota" so an auth-bench slot doesn't trigger a misleading
// "recovered" trace.
//
// Dedupe: stamp lastRecoveredAt on the slot the first time we emit a recovery event; subsequent
// ticks see lastRecoveredAt and skip until a fresh bench invalidates the stamp (recordProviderError
// already deletes lastRecoveredAt on every new bench). Same idempotent contract as the goal
// idle-streak nudge.
//
// Cross-reference: the agent that triggered the bench is whichever agent was on the slot at the
// time. We do NOT persist a per-slot agentId (issue 19 plan-review's open question 1) — we resolve
// the agent(s) from st.agents[*] at recovery-scan time, matching by model+provider. Multi-match is
// fine: the trace payload carries an agentIds[] list (a single agent is the common case; the
// payload shape is array-typed to avoid future drift).
//
// File IO: pool-state.json reads/writes use the pool's own mutex (withPoolLock). The root
// pump already holds the SWARM lock (withLock(p)), and pool-state.json is independent — torn reads
// are safe because cooldownUntil only ever moves forward and lastBenchReason/lastRecoveredAt are
// write-only (never deleted except on a new bench, which we'd see). Helper is exported for direct
// unit testing by quota-reset.test.mjs (mirrors evaluateIdleGoalNudgeLocked).
export async function evaluateSlotRecoveryLocked(
	pi: ExtensionAPI,
	cwd: string,
	p: Paths,
	st: SwarmState,
	nowMs: number,
): Promise<{ emitted: number; reasons: Record<string, number> }> {
	const reasons: Record<string, number> = { expired_no_tasks: 0, expired_quota: 0, deduped: 0, no_active_agent: 0, not_quota_bench: 0 };
	const emitted: Array<{ agentId: string; slot: string; afterMs: number; remainingTasks: number; benchMs: number }> = [];

	await withPoolLock(p, async () => {
		const h = await readPoolHealth(p);
		let dirty = false;
		for (const [slotKeyStr, health] of Object.entries(h.slots)) {
			// Skip slots with no cooldown or still in cooldown.
			if (!health?.cooldownUntil) continue;
			const cooldownEnd = new Date(health.cooldownUntil).getTime();
			if (cooldownEnd > nowMs) continue; // still in bench
			// Cooldown has expired — but only "quota" benches get a recovery event.
			if (health.lastBenchReason !== "quota") { reasons.not_quota_bench++; continue; }
			// Idempotent: skip if we already emitted for this bench cycle.
			if (health.lastRecoveredAt) { reasons.deduped++; continue; }
			// Find agents on this slot. The slot key is `${provider}/${model}`; agents carry their
			// current model+provider. We do NOT filter on tmuxTarget=="unknown" — even a dead-tmux
			// agent is a candidate for the trace (the root may want to know regardless).
			// Use slotKey() for consistent key derivation (handles "(default)" provider case).
			const slotAgentKey = slotKeyStr;
			const matchingAgents = Object.values(st.agents).filter((a) => {
				if (a.id === "root") return false; // root pseudo-agent never has active tasks for slot work
				return slotKey({ model: a.model, provider: a.provider }) === slotAgentKey;
			});
			const busyAgents = matchingAgents.filter((a) => (a.activeTaskIds?.length || 0) > 0);
			if (!busyAgents.length) {
				// Silent path (per plan §4 D): bench expired but no active tasks → no recovery event.
				// Slot is healthy again for the next pickSlot; no notify needed.
				reasons.expired_no_tasks++;
				continue;
			}
			// Compute afterMs = how long the bench has been expired (nowMs - cooldownEnd). The benchMs
			// payload comes from the slot's lastBenchMs stamped by recordProviderError at bench time.
			const afterMs = Math.max(0, nowMs - cooldownEnd);
			// Emit one trace per busy agent (a slot with multiple workers on it produces multiple
			// events; the root can dedupe downstream if it cares).
			for (const agent of busyAgents) {
				emitted.push({ agentId: agent.id, slot: slotKeyStr, afterMs, remainingTasks: agent.activeTaskIds.length, benchMs: health.lastBenchMs ?? Math.max(0, cooldownEnd - (cooldownEnd - afterMs)) });
				reasons.expired_quota++;
			}
			// Stash idempotency stamp so the next tick (and all subsequent ticks until a new bench)
			// stay silent.
			health.lastRecoveredAt = new Date(nowMs).toISOString();
			dirty = true;
		}
		if (dirty) await writePoolHealth(p, h).catch(() => {});
	});

	for (const ev of emitted) {
		await trace(p, "pool.slot_recovered", {
			agentId: ev.agentId,
			slot: ev.slot,
			afterMs: ev.afterMs,
			remainingTasks: ev.remainingTasks,
			benchMs: ev.benchMs,
		}).catch(() => {});
	}

	return { emitted: emitted.length, reasons };
}

// === Issue 11: Root wake-up escalation + durable replay fencing ===

// Helper to parse taskId/nodeId from conversationId (format: "task:${taskId}:${nodeId}").
