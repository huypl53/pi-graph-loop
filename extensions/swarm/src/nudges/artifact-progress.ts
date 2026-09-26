// === swarm/nudges/artifact-progress.ts — artifact-progress nudge engine ===
// evaluateArtifactProgressNudgeLocked.
// Extracted from graph-advance.ts (Phase 6 real split). Bodies verbatim.

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ARTIFACT_PROGRESS_ACTIVE_AGENT_SKIP_MS,
	ARTIFACT_PROGRESS_GRACE_MS,
	ARTIFACT_PROGRESS_MAX_FILES,
	ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS,
	ARTIFACT_PROGRESS_NUDGE_CAP,
	TRACE_ARTIFACT_PROGRESS_CAP_EXCEEDED,
	TRACE_ARTIFACT_PROGRESS_NUDGE,
} from "../constants.ts";
import type { Paths, SwarmState, TaskPaths, TaskState } from "../types.ts";
import { deliverMessageLocked, findIdempotentMessage } from "../mailbox.ts";
import { logSwarmError } from "../errorlog.ts";
import { readTaskState, taskPaths, trace, withLock, writeState, writeTaskState } from "../state.ts";

export async function evaluateArtifactProgressNudgeLocked(
	pi: ExtensionAPI,
	cwd: string,
	p: Paths,
	st: SwarmState,
	nowMs: number,
): Promise<{ inspected: number; nudged: number; escalated: number; scannedFiles: number }> {
	let inspected = 0,
		nudged = 0,
		escalated = 0,
		scannedFiles = 0;
	if (!existsSync(p.tasksDir)) return { inspected, nudged, escalated, scannedFiles };
	let taskDirs: string[] = [];
	try {
		taskDirs = await readdir(p.tasksDir);
	} catch (err: any) {
		if (err?.code !== "ENOENT") {
			await logSwarmError(p, "graph-advance", "artifact_progress.readdir_failed", err);
		}
		return { inspected, nudged, escalated, scannedFiles };
	}
	const dirtyTaskPaths = new Set<TaskPaths>();
	const tpToTask = new Map<TaskPaths, TaskState>();
	for (const taskDir of taskDirs) {
		const tp = taskPaths(p, taskDir);
		if (!existsSync(tp.taskJson)) continue;
		let task: TaskState;
		try {
			task = await readTaskState(tp.taskJson);
		} catch (err: any) {
			if (err?.code !== "ENOENT") {
				await logSwarmError(p, "graph-advance", "artifact_progress.task_unreadable", err, { taskDir });
			}
			continue;
		}
		tpToTask.set(tp, task);
		for (const [nodeId, node] of Object.entries(task.nodes)) {
			if (!node) continue;
			if (node.status !== "assigned" && node.status !== "in_progress") continue;
			// Root self-nudge suppression (OQ2): skip when the assignee is the root
			// pseudo-agent (no real worker pane to nudge; the root drives its own work).
			if (!node.assignee || node.assignee === "root") continue;
			// Skip when the node has no allowedFiles (OQ3 default: too noisy to track whole-project mtime).
			const effectiveAllowed: string[] =
				node.allowedFiles && node.allowedFiles.length > 0
					? node.allowedFiles
					: task.allowedFiles && task.allowedFiles.length > 0
						? task.allowedFiles
						: [];
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
					if (mt > maxMtimeMs) {
						maxMtimeMs = mt;
						contributingFile = rel;
					}
				} catch (err: any) {
					/* file not on disk yet (worker hasn't created it) — expected branch */
					if (err?.code !== "ENOENT") {
						await logSwarmError(p, "graph-advance", "artifact_progress.stat_failed", err, { rel });
					}
				}
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
					await trace(p, TRACE_ARTIFACT_PROGRESS_CAP_EXCEEDED, {
						taskId: task.taskId,
						nodeId,
						assignee: node.assignee,
						nudgeCount: priorCount,
						cap: ARTIFACT_PROGRESS_NUDGE_CAP,
						contributingFile,
						maxMtimeMs,
						lastProgressAt: node.lastProgressAt ?? null,
						lastToolAt: agent.lastToolAt ?? null,
					}).catch(() => {});
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
					} catch (err) {
						/* escalation is informational; never throw out of the tick — but a persistently
						   failing CAP escalation means nobody ever hears that a worker is ignoring
						   nudges. Log it. */
						await logSwarmError(p, "graph-advance", "artifact_progress.cap_escalation_failed", err, {
							taskId: task.taskId,
							nodeId,
						});
					}
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
				await trace(p, TRACE_ARTIFACT_PROGRESS_NUDGE, {
					taskId: task.taskId,
					nodeId,
					assignee: node.assignee,
					contributingFile,
					maxMtimeMs,
					baselineMs,
					lastProgressAt: node.lastProgressAt ?? null,
					lastToolAt: agent.lastToolAt ?? null,
					nudgeCount: node.artifactProgressNudgeCount,
					cap: ARTIFACT_PROGRESS_NUDGE_CAP,
					backoffMs: ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS,
					gracefulMs: ARTIFACT_PROGRESS_GRACE_MS,
				}).catch(() => {});
				nudged++;
				dirtyTaskPaths.add(tp);
			} catch (err: any) {
				await trace(p, "worker.artifact_progress_nudge_failed", {
					taskId: task.taskId,
					nodeId,
					assignee: node.assignee,
					error: String((err as Error)?.message || err),
				}).catch(() => {});
			}
		}
	}
	// Persist any task.json mutations (node.artifactProgressNudgeAt / Count). The in-memory
	// `task` reference holds our mutations; writeTaskState serializes the LIVE object (no
	// fresh re-read, which would lose the in-memory mutations because readTaskState deserializes
	// a new copy). Updated updatedAt is stamped inside writeTaskState.
	for (const tp of Array.from(dirtyTaskPaths)) {
		try {
			await writeTaskState(tp, tpToTask.get(tp)!);
		} catch (err) {
			// Losing a nudge-timestamp write re-triggers the nudge next tick (visible); losing it
			// SILENTLY would also hide systemic write failures. Log it.
			await logSwarmError(p, "graph-advance", "artifact_progress.persist_failed", err, { taskRoot: tp.root });
		}
	}
	if (nudged || escalated || inspected) {
		await writeState(p, st).catch((err) => logSwarmError(p, "nudges.graph-advance", "writeState.failed", err));
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
