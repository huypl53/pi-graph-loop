// === swarm/nudges/graph-advance-nudge.ts — ready-node advance nudges to root ===
// sendGraphAdvanceNudgeLocked + reconcileGraphAdvanceLocked + ack helpers (private).
// Extracted from graph-advance.ts (Phase 6 real split). Bodies verbatim.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	NOTIFY_DEFAULT_COOLDOWN_MS,
	NOTIFY_DEFAULT_MAX_NUDGES,
	NOTIFY_KEY_GRAPH_ADVANCE,
	TERMINAL_NODE_STATUSES,
	TRACE_GRAPH_ADVANCE_NUDGE_EMITTED,
	formatNotifyKey,
} from "../constants.ts";
import type { Paths, SwarmState, TaskState } from "../types.ts";
import { checkStallNotificationStale, computeReadyNodes } from "../taskgraph.ts";
import { deliverMessageLocked, findIdempotentMessage } from "../mailbox.ts";
import { logSwarmError } from "../errorlog.ts";
import { readTaskState, taskPaths, trace } from "../state.ts";
import { traceStaleSuppressedOnce } from "../surface/staleness.ts";

export async function sendGraphAdvanceNudgeLocked(
	pi: ExtensionAPI,
	cwd: string,
	p: Paths,
	st: SwarmState,
	taskId: string,
	nodeId: string,
	role: string,
): Promise<void> {
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
	const lastSent =
		prior
			.map((r) => r.createdAt || "")
			.sort()
			.pop() || "";
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
		await trace(p, TRACE_GRAPH_ADVANCE_NUDGE_EMITTED, {
			taskId,
			nodeId,
			seq: nextSeq,
			key,
			cap: NOTIFY_DEFAULT_MAX_NUDGES,
			cooldownMs: NOTIFY_DEFAULT_COOLDOWN_MS,
		}).catch(() => {});
	} catch (err: any) {
		await trace(p, "graph.advance_nudge_failed", { taskId, nodeId, seq: nextSeq, error: String((err as Error)?.message || err) }).catch(
			() => {},
		);
	}
}

export function ackRootNudgeLocked(st: SwarmState, key: string, nowMs: number, note: string): void {
	const rec =
		findIdempotentMessage(st, "root", "root", key) ||
		Object.values(st.messages || {}).find((r) => r.to === "root" && r.idempotencyKey === key);
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
	try {
		entries = await readdir(p.tasksDir);
	} catch (err: any) {
		if (err?.code !== "ENOENT") {
			await logSwarmError(p, "graph-advance", "advance.readdir_failed", err);
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
				await logSwarmError(p, "graph-advance", "advance.task_unreadable", err, { taskId });
			}
			continue;
		}
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
					await traceStaleSuppressedOnce(p, "reconcile.graph_advance_nudge", {
						messageId: keyForTrace,
						idempotencyKey: keyForTrace,
						reason: staleCheck.reason,
						evidence: staleCheck.evidence,
					});
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
