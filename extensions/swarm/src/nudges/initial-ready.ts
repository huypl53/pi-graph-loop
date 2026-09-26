// === swarm/nudges/initial-ready.ts — initial ready nudge for unassigned start nodes ===
// reconcileInitialReadyLocked + sendInitialReadyNudgeLocked (private).
// Extracted from graph-advance.ts (Phase 6 real split). Bodies verbatim.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	NOTIFY_DEFAULT_COOLDOWN_MS,
	NOTIFY_DEFAULT_MAX_NUDGES,
	NOTIFY_KEY_INITIAL_READY,
	TASK_INITIAL_READY_GRACE_MS,
	formatNotifyKey,
} from "../constants.ts";
import type { Paths, SwarmState, TaskState } from "../types.ts";
import { checkStallNotificationStale } from "../taskgraph.ts";
import { ackRootNudgeLocked } from "./graph-advance-nudge.ts";
import { deliverMessageLocked, findIdempotentMessage } from "../mailbox.ts";
import { logSwarmError } from "../errorlog.ts";
import { readTaskState, taskPaths, trace } from "../state.ts";
import { traceStaleSuppressedOnce } from "../surface/staleness.ts";

export async function reconcileInitialReadyLocked(pi: ExtensionAPI, cwd: string, p: Paths, st: SwarmState, nowMs: number): Promise<void> {
	if (!existsSync(p.tasksDir)) return;
	let entries: string[] = [];
	try {
		entries = await readdir(p.tasksDir);
	} catch (err: any) {
		if (err?.code !== "ENOENT") {
			await logSwarmError(p, "graph-advance", "initial_ready.readdir_failed", err);
		}
		return;
	}
	for (const taskId of entries) {
		const tp = taskPaths(p, taskId);
		if (!existsSync(tp.taskJson)) continue;
		let task: TaskState;
		try {
			task = await readTaskState(tp.taskJson);
		} catch (err: any) {
			if (err?.code !== "ENOENT") {
				await logSwarmError(p, "graph-advance", "initial_ready.task_unreadable", err, { taskId });
			}
			continue;
		}
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
		const last =
			existing
				.map((r) => r.createdAt || "")
				.sort()
				.pop() || "";
		if (last && nowMs - new Date(last).getTime() < NOTIFY_DEFAULT_COOLDOWN_MS) continue;
		// Lifecycle-fencing (issue 9, site 5): per-node staleness check before the initial-ready nudge.
		// Task status="ready" already rules out conditions (1)/(2) — but we still run the predicate so a
		// cancelled attempt, assignee drift, or agent-stopped transition can short-circuit the emit. The
		// start node's "assignee" here is always undefined (filtered above), so the predicate agentId
		// placeholder is "root" (the only recipient of this nudge anyway).
		const staleCheck = checkStallNotificationStale(st, task, startId, startNode.assignee || "root", nowMs);
		if (staleCheck.stale) {
			await traceStaleSuppressedOnce(p, "reconcile.initial_ready_nudge", {
				messageId: key,
				idempotencyKey: key,
				reason: staleCheck.reason,
				evidence: staleCheck.evidence,
			});
			ackRootNudgeLocked(st, key, nowMs, "auto-acked: node stale");
			continue;
		}
		await sendInitialReadyNudgeLocked(pi, cwd, p, st, task, startId, key);
	}
}

async function sendInitialReadyNudgeLocked(
	pi: ExtensionAPI,
	cwd: string,
	p: Paths,
	st: SwarmState,
	task: TaskState,
	startId: string,
	key: string,
): Promise<void> {
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
		await trace(p, "task.initial_ready_nudge_failed", { taskId, nodeId: startId, error: String((err as Error)?.message || err) }).catch(
			() => {},
		);
	}
}

// === Issue 27: effective-liveness helper for idle predicates ===
// An agent participates in the goal-nudge / task-stall all-idle predicate only if its record is
