// === swarm/taskgraph/stale.ts — stale-open assignment scan + stale-open nudge ===
// Pump-tick phases (Issue 83a/83b). Extracted from taskgraph.ts (Phase 6 real split).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_AGENT_HEARTBEAT_STALE_MS,
	DEFAULT_STALE_OPEN_THRESHOLD_MS,
	NOTIFY_DEFAULT_COOLDOWN_MS,
	NOTIFY_DEFAULT_MAX_NUDGES,
	PI_SWARM_MINIMAL_PROTOCOL,
	TRACE_STALE_OPEN_NUDGE_EMITTED,
	TRACE_STALE_OPEN_SURFACED,
} from "../constants.ts";
import type { Paths, SwarmState, TaskState } from "../types.ts";
import { logSwarmError } from "../errorlog.ts";
import { paths, readTaskState, taskPaths, trace, traceTask, writeTaskState } from "../state.ts";

export async function staleOpenAssignmentScanLocked(
	p: Paths,
	st: SwarmState,
	nowMs: number,
): Promise<{
	surfaced: number;
	inspected: number;
	alreadySurfaced: number;
	surfacedNodes: Array<{ taskId: string; nodeId: string; assignee?: string }>;
}> {
	const thresholdMs = Number(process.env.PI_SWARM_STALE_OPEN_THRESHOLD_MS ?? DEFAULT_STALE_OPEN_THRESHOLD_MS);
	let surfaced = 0,
		inspected = 0,
		alreadySurfaced = 0;
	const surfacedNodes: Array<{ taskId: string; nodeId: string; assignee?: string }> = [];
	// Discover tasks via the swarm's tasks dir.
	let taskDirs: string[] = [];
	try {
		const { readdirSync } = await import("node:fs");
		taskDirs = readdirSync(p.tasksDir).filter((d) => d.startsWith("task-"));
	} catch (err) {
		// tasksDir disappearing mid-run would silently zero the whole stale-open scan — surface it.
		await logSwarmError(p, "taskgraph", "stale_open.readdir_failed", err);
		return { surfaced, inspected, alreadySurfaced, surfacedNodes };
	}
	for (const taskDir of taskDirs) {
		const tp = taskPaths(p, taskDir);
		let task: TaskState;
		try {
			task = await readTaskState(tp.taskJson);
		} catch (err: any) {
			if (err?.code !== "ENOENT") {
				await logSwarmError(p, "taskgraph", "stale_open.task_unreadable", err, { taskDir });
			}
			continue;
		}
		let dirty = false;
		for (const [nodeId, node] of Object.entries(task.nodes)) {
			if (node.status !== "assigned" && node.status !== "in_progress") continue;

			// Active worker gate: an agent that has NOT settled (tool_running, or busy with fresh heartbeat)
			// is actively working and must NOT be surfaced as stale open.
			// Only agents that have actually settled (runtimeStatus === "idle") or whose heartbeat is
			// dead (hung > DEFAULT_AGENT_HEARTBEAT_STALE_MS) are candidates for stale open.
			const assigneeAgent = node.assignee ? st.agents[node.assignee] : undefined;
			if (assigneeAgent && assigneeAgent.status === "running") {
				if (assigneeAgent.runtimeStatus === "tool_running") {
					continue;
				}
				if (assigneeAgent.runtimeStatus === "busy") {
					const hb = assigneeAgent.lastHeartbeatAt ? new Date(assigneeAgent.lastHeartbeatAt).getTime() : 0;
					if (nowMs - hb <= DEFAULT_AGENT_HEARTBEAT_STALE_MS) {
						continue;
					}
				}
				if (assigneeAgent.runtimeStatus === "idle" && assigneeAgent.lastAgentSettledAt) {
					const settledMs = new Date(assigneeAgent.lastAgentSettledAt).getTime();
					if (settledMs && nowMs - settledMs <= thresholdMs) {
						continue; // Grace period: settled within threshold window
					}
				}
			}

			inspected++;
			const ts = nowMs;
			// `lastProgressAt` absent or older than threshold → candidate.
			// `staleOpenSurfacedAt` present within threshold → already surfaced this window → skip.
			// Plan §(a): stale check is `nowMs - max(lastProgressAt, lastActivityAt) > thresholdMs`.
			// A node with no `lastProgressAt` but recently assigned is NOT stale (the worker just
			// picked it up). The implementer's first pass used `lastProgressAt absent → Infinity`
			// which surfaced every un-progressed node immediately on assignment — defeated the
			// feature. Use max() to anchor on the most-recent activity timestamp.
			const lastProgressMs = node.lastProgressAt ? new Date(node.lastProgressAt).getTime() : 0;
			const lastActivityMs = node.lastActivityAt ? new Date(node.lastActivityAt).getTime() : 0;
			const anchorMs = Math.max(lastProgressMs, lastActivityMs);
			const staleAtMs = anchorMs ? ts - anchorMs : Number.POSITIVE_INFINITY;
			const surfacedMs = node.staleOpenSurfacedAt ? new Date(node.staleOpenSurfacedAt).getTime() : 0;
			if (staleAtMs <= thresholdMs) continue;
			if (surfacedMs && ts - surfacedMs <= thresholdMs) {
				alreadySurfaced++;
				continue;
			}
			const now = new Date(ts).toISOString();
			node.staleOpenSurfacedAt = now;
			dirty = true;
			surfaced++;
			surfacedNodes.push({ taskId: task.taskId, nodeId, assignee: node.assignee || undefined });
			await traceTask(tp, TRACE_STALE_OPEN_SURFACED, {
				taskId: task.taskId,
				nodeId,
				assignee: node.assignee,
				assignedAt: node.lastActivityAt,
				lastProgressAt: node.lastProgressAt ?? null,
				thresholdMs,
				staleMs: staleAtMs === Number.POSITIVE_INFINITY ? null : Math.round(staleAtMs),
			}).catch(() => {});
		}
		if (dirty) {
			const { writeTaskState } = await import("../state.ts");
			await writeTaskState(tp, task).catch((err) => logSwarmError(tp, "taskgraph", "writeTaskState.failed", err));
		}
	}
	return { surfaced, inspected, alreadySurfaced, surfacedNodes };
}

// === R11-1 completion — stale-open assignment NUDGE (surfacing alone was a radar without a bell) ===
// Called by the pump right after staleOpenAssignmentScanLocked surfaces nodes. Delivers ONE
// high-priority root nudge per surfaced (task, node), idempotent within the surfacing
// window (the scan's staleOpenSurfacedAt stamp), capped + cooled down like the graph-advance
// nudge. Returns true when a nudge was emitted.
export async function staleOpenNudgeLocked(
	pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
	cwd: string,
	p: Paths,
	st: SwarmState,
	taskId: string,
	nodeId: string,
): Promise<boolean> {
	const { deliverMessageLocked, findIdempotentMessage } = await import("../mailbox.ts");
	const { formatNotifyKey, NOTIFY_KEY_STALE_OPEN } = await import("../constants.ts");
	const keyPrefix = `task:${taskId}:node:${nodeId}:nudge:stale-open:seq:`;
	// Defense-in-depth: only nudge nodes the scan ACTUALLY surfaced (staleOpenSurfacedAt fresh
	// within the threshold window). A direct call for a fresh-progress node is a no-op.
	const tp = taskPaths(paths(cwd), taskId);
	try {
		const t = await readTaskState(tp.taskJson);
		const n = t.nodes[nodeId];
		const thresholdMs = Number(process.env.PI_SWARM_STALE_OPEN_THRESHOLD_MS ?? DEFAULT_STALE_OPEN_THRESHOLD_MS);
		const surfacedMs = n?.staleOpenSurfacedAt ? new Date(n.staleOpenSurfacedAt).getTime() : 0;
		if (!surfacedMs || Date.now() - surfacedMs > thresholdMs) return false;
	} catch {
		return false;
	}
	const prior = Object.values(st.messages || {}).filter(
		(r: any) => r.to === "root" && (r.idempotencyKey?.startsWith(keyPrefix) ?? false),
	);
	if (prior.length >= NOTIFY_DEFAULT_MAX_NUDGES) return false; // cap
	const seq = prior.length + 1;
	const key = formatNotifyKey(NOTIFY_KEY_STALE_OPEN, { taskId, nodeId, seq: String(seq) });
	const lastSent =
		prior
			.map((r: any) => r.createdAt || "")
			.sort()
			.pop() || "";
	if (lastSent && Date.now() - new Date(lastSent).getTime() < NOTIFY_DEFAULT_COOLDOWN_MS) return false; // cooldown
	if (findIdempotentMessage(st, "root", "root", key) && !prior.some((r: any) => r.ackedAt)) return false; // in-flight
	try {
		await deliverMessageLocked(pi, cwd, p, st, {
			to: "root",
			priority: "high",
			subject: `STALE OPEN: node ${nodeId} of ${taskId} assigned but no progress — worker may have settled idle`,
			body: `Node \`${nodeId}\` of task ${taskId} is assigned but has shown NO progress past the stale threshold (see trace stale_open_surfaced). The assignee may have settled idle with the node open (idle-lock pattern, 5 live incidents on 2026-09-1).

Act NOW in this turn:
  1. Check the assignee pane (swarm_agent_status) — if idle with the node open, send a high-priority directive naming the exact close action (swarm_update_task to done/failed/blocked + result message).
  2. If the pane is dead, restart the agent with the brief (swarm_restart_agent) — the assignment record persists.
  3. If the node is genuinely long-running (evidence of progress in artifacts), ack this nudge done with a note; it will not re-fire within the window.

(Auto-clears when the node records progress or closes. Capped at ${NOTIFY_DEFAULT_MAX_NUDGES} nudges per node; ${Math.round(NOTIFY_DEFAULT_COOLDOWN_MS / 60000)}min cooldown.)`,
			requiresAck: PI_SWARM_MINIMAL_PROTOCOL === 1 ? false : true,
			idempotencyKey: key,
		});
		await trace(p, TRACE_STALE_OPEN_NUDGE_EMITTED, {
			taskId,
			nodeId,
			seq,
			cap: NOTIFY_DEFAULT_MAX_NUDGES,
			cooldownMs: NOTIFY_DEFAULT_COOLDOWN_MS,
		}).catch(() => {});
		return true;
	} catch (err: any) {
		await trace(p, "stale_open.nudge_failed", { taskId, nodeId, seq, error: String((err as Error)?.message || err) }).catch(() => {});
		return false;
	}
}
