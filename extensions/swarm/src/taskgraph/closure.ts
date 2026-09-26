// === swarm/taskgraph/closure.ts — node/task closure summaries ===
// Extracted from taskgraph.ts (Phase 6 real split).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { PI_SWARM_MINIMAL_PROTOCOL } from "../constants.ts";
import type { NodeClosureSummary, SwarmState, TaskNodeStatus, TaskPaths, TaskState } from "../types.ts";
export type { NodeClosureSummary };
import { ensureAgentDefaults } from "../utils.ts";
import { computeTaskStatus } from "./lifecycle.ts";

export function nodeVerdict(status: TaskNodeStatus): NodeClosureSummary["verdict"] {
	if (status === "done") return "done";
	if (status === "failed") return "failed";
	if (status === "skipped") return "skipped";
	return "open";
}

export function computeNodeClosureSummary(st: SwarmState, task: TaskState, nodeId: string, tp: TaskPaths): NodeClosureSummary {
	const node = task.nodes[nodeId];
	const verdict = nodeVerdict(node.status);
	const blocking: string[] = [];
	const agent = node.assignee ? st.agents[node.assignee] : undefined;
	if (verdict === "open") blocking.push(`status is ${node.status} (not terminal)`);
	if (node.staleAt) blocking.push(`marked stale at ${node.staleAt}`);
	if (agent) {
		ensureAgentDefaults(agent);
		if (agent.status === "stopped" || agent.health === "unhealthy")
			blocking.push(`assignee ${agent.id} is ${agent.status}/${agent.health}`);
	}
	let assignmentAck: NodeClosureSummary["assignmentAck"] = null;
	// Prefer the canonical (current, non-superseded) assignment message for the ack summary.
	const canonId = node.assignmentMessageId;
	if (canonId) {
		const r = st.messages[canonId];
		if (r && !r.superseded)
			assignmentAck = { messageId: canonId, status: r.status, acked: Boolean(r.ackedAt), ackStatus: r.lastAck?.status ?? null };
	}
	for (const msgId of node.messageIds || []) {
		const rec = st.messages[msgId];
		if (!rec) {
			blocking.push(`references missing message ${msgId}`);
			continue;
		}
		if (rec.superseded) continue; // superseded assignments are waived; excluded from closure blocking
		if (!assignmentAck)
			assignmentAck = { messageId: msgId, status: rec.status, acked: Boolean(rec.ackedAt), ackStatus: rec.lastAck?.status ?? null };
		if (rec.status === "dead_letter") blocking.push(`message ${msgId} is dead-lettered (${rec.lastError || "unknown"})`);
		if (PI_SWARM_MINIMAL_PROTOCOL === 0 && rec.requiresAck && !rec.ackedAt)
			blocking.push(`assignment message ${msgId} not acknowledged`);
		if (rec.lastAck?.status === "done" && verdict === "open")
			blocking.push(`message ${msgId} acked done but node is still ${node.status}`);
	}
	const artifacts = (node.writeArtifacts || []).map((path) => ({ path, exists: existsSync(join(tp.root, path)) }));
	for (const a of artifacts) if (verdict === "done" && !a.exists) blocking.push(`declared artifact ${a.path} missing`);
	for (const [file, lock] of Object.entries(task.editLocks))
		if (lock?.nodeId === nodeId && verdict !== "open") blocking.push(`holds editLock for ${file}`);
	const evidence = [`task.md node "${nodeId}"`, ...artifacts.filter((a) => a.exists).map((a) => a.path)];
	return {
		nodeId,
		role: node.role,
		assignee: node.assignee ?? null,
		status: node.status,
		closed: verdict !== "open",
		verdict,
		blocking,
		assignmentAck,
		artifacts,
		evidence,
	};
}

// Task-level closure roll-up: machine-state closure + open/stale assignments + blockers. `derived`
// is computeTaskStatus applied fresh so callers see drift between stored and derived status. This is
// the pane-free done-detector: closure is knowable from task.json + swarm state alone.
export function computeTaskClosure(st: SwarmState, task: TaskState, tp: TaskPaths) {
	const nodeClosure = Object.keys(task.nodes).map((id) => computeNodeClosureSummary(st, task, id, tp));
	const openAssignments = nodeClosure
		.filter((n) => n.assignee && (n.status === "assigned" || n.status === "in_progress"))
		.map((n) => ({ nodeId: n.nodeId, assignee: n.assignee as string, status: n.status }));
	const staleReason = (n: NodeClosureSummary) =>
		n.blocking.find((b) => b.includes("stale") || b.includes("stopped") || b.includes("unhealthy") || b.includes("dead-lettered"));
	const staleAssignments = nodeClosure
		.filter((n) => n.assignee && staleReason(n))
		.map((n) => ({ nodeId: n.nodeId, assignee: n.assignee as string, reason: staleReason(n) || "stale" }));
	const derived = computeTaskStatus(task);
	const storedClosed = task.status === "done" || task.status === "failed" || task.status === "cancelled";
	const blocking: string[] = [];
	if (derived !== task.status && task.status !== "cancelled")
		blocking.push(`stored task.status=${task.status} but nodes derive ${derived}`);
	if (!storedClosed && openAssignments.length === 0 && nodeClosure.some((n) => n.verdict === "open"))
		blocking.push("task open but no active assignments (stalled)");
	return {
		taskId: task.taskId,
		storedStatus: task.status,
		derivedStatus: derived,
		closed: storedClosed,
		closedNodes: nodeClosure.filter((n) => n.closed).length,
		openNodes: nodeClosure.filter((n) => !n.closed).length,
		staleNodes: staleAssignments.length,
		openAssignments,
		staleAssignments,
		blocking,
		nodeClosure,
	};
}
