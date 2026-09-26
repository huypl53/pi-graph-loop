// === swarm/nudges/task-stall.ts — task-stall nudge + stall resolution ===
// evaluateTaskGraphStallNudgeLocked + resolveTaskStallLocked.
// Extracted from graph-advance.ts (Phase 6 real split). Bodies verbatim.

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ARTIFACT_PROGRESS_ACTIVE_AGENT_SKIP_MS,
	TASK_INITIAL_READY_GRACE_MS,
	ARTIFACT_PROGRESS_GRACE_MS,
	ARTIFACT_PROGRESS_MAX_FILES,
	ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS,
	ARTIFACT_PROGRESS_NUDGE_CAP,
	GOAL_NUDGE_BACKOFF_TICKS,
	MAX_TASK_STALL_NUDGES,
	NOTIFY_DEFAULT_COOLDOWN_MS,
	NOTIFY_DEFAULT_MAX_NUDGES,
	NOTIFY_KEY_TASK_GRAPH_STALL,
	TERMINAL_NODE_STATUSES,
	TASK_STALL_NUDGE_IDLE_INTERVAL_MS,
	formatNotifyKey,
} from "../constants.ts";
import type { Paths, SwarmState, SwarmTaskStallState, TaskPaths, TaskState } from "../types.ts";
import { computeReadyNodes } from "../taskgraph.ts";
import { deliverMessageLocked, findIdempotentMessage } from "../mailbox.ts";
import { logSwarmError } from "../errorlog.ts";
import { readState, readTaskState, taskPaths, trace, withLock, writeState } from "../state.ts";
import { isStallNudgeEligibleTaskStatus } from "./status-predicates.ts";
import { updateIdleEpochLocked } from "./goal-epoch.ts";

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
	rootBusy: boolean = false,
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
			} catch (err: any) {
				if (err?.code !== "ENOENT") {
					await logSwarmError(p, "graph-advance", "stall.task_unreadable", err, { taskId });
				}
			}
		}
	} catch (err: any) {
		/* unreadable tasksDir === no active tasks (designed skip); ENOENT is the expected flavor */
		if (err?.code !== "ENOENT") {
			await logSwarmError(p, "graph-advance", "stall.readdir_failed", err);
		}
	}
	if (!tasks.length) return { emitted: false, reason: "no_active_task" };

	// Predicate 3: every non-root agent must be runtimeStatus === "idle".
	// Issue 27: mirrors evaluateIdleGoalNudgeLocked — only effectively-alive agents participate;
	// stopped/stale ghost records must not starve this nudge either.
	// Row 68: the shared idle-epoch update runs here (idempotent) so the busy→all-idle edge is
	// anchored at swarm level even with no goal set. A busy effective agent also resets per-task
	// stall spacing (inside updateIdleEpochLocked) so the next all-idle edge re-arms immediacy.
	const epoch = await updateIdleEpochLocked(p, st, nowMs, rootBusy);
	const { idleAgents, allIdle } = epoch;
	if (!allIdle) return { emitted: false, reason: rootBusy ? "root_busy" : "agent_busy" };
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
			const hasActive = Object.values(st.messages || {}).some(
				(r) => r.to === "root" && !r.ackedAt && (r.idempotencyKey?.startsWith(advanceKeyPrefix) ?? false),
			);
			if (hasActive) {
				graphAdvanceActive = true;
				break;
			}
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
				await trace(p, "task_stall.nudge.backoff", {
					taskId,
					nudges: stallState.consecutiveNoResolveNudges,
					max: MAX_TASK_STALL_NUDGES,
					backoffTicks: GOAL_NUDGE_BACKOFF_TICKS,
				}).catch(() => {});
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
