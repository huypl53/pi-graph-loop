// === swarm/surface/warnings.ts — runtimeTaskWarnings extractor (Phase 7) ===
// Extracted verbatim from ../surface.ts (Phase 7 modular split; canonical logic unchanged).
//
// Module boundary: task.json closure/warning extractor consumed by `/swarm status`,
// `swarm_task_status`, and the reconcile rollup. Advisory-only surface (L1 read + tmux
// liveness probe); never sends messages and never calls pi.sendMessage.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SwarmState, TaskState } from "../types.ts";
import { PI_SWARM_MINIMAL_PROTOCOL, TERMINAL_NODE_STATUSES } from "../constants.ts";
import { ensureAgentDefaults, inferRoleKind } from "../utils.ts";
import { deriveNodeAttention } from "../taskgraph.ts";
import { isTmuxRunning } from "../tmux.ts";

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
			if (agent.status === "stopped" || agent.health === "unhealthy")
				warnings.push(`node ${id} assignee ${agent.id} is ${agent.status}/${agent.health}`);
			const expectedKind = inferRoleKind(node.assignee, node.role);
			if (agent.roleKind !== expectedKind)
				warnings.push(`node ${id} role "${node.role}" expects ${expectedKind} but ${agent.id} is ${agent.roleKind}`);
			if (agent.activeTaskIds.length >= agent.maxConcurrentTasks && !agent.activeTaskIds.includes(task.taskId))
				warnings.push(`node ${id} assignee ${agent.id} at capacity (${agent.activeTaskIds.length}/${agent.maxConcurrentTasks})`);
			if (agent.tmuxTarget && agent.tmuxTarget !== "unknown" && (node.status === "assigned" || node.status === "in_progress")) {
				const alive = await isTmuxRunning(pi, agent.tmuxTarget);
				if (!alive) warnings.push(`node ${id} assignee ${agent.id} tmux pane not alive`);
			}
		}
		for (const msgId of node.messageIds || []) {
			const rec = st.messages[msgId];
			if (!rec) {
				warnings.push(`node ${id} references missing message ${msgId}`);
				continue;
			}
			if (rec.superseded) continue; // superseded assignments are waived; not current work
			if (rec.status === "dead_letter")
				warnings.push(`node ${id} assignment/handoff message ${msgId} is dead-lettered (${rec.lastError || "unknown"})`);
			if (PI_SWARM_MINIMAL_PROTOCOL === 0 && rec.requiresAck && !rec.ackedAt)
				warnings.push(`node ${id} message ${msgId} requires ack but is ${rec.status}`);
			// Assignment acked done but the node was never advanced past assigned/in_progress.
			if (rec.lastAck?.status === "done" && (node.status === "assigned" || node.status === "in_progress"))
				warnings.push(`node ${id} message ${msgId} acked done but node is still ${node.status}`);
		}
		if (node.status === "in_progress" && node.lastActivityAt) {
			const age = nowMs - new Date(node.lastActivityAt).getTime();
			if (age > 24 * 60 * 60 * 1000) warnings.push(`node ${id} in_progress for ${Math.round(age / 3_600_000)}h without update`);
		}
		// Terminal nodes must have released their advisory edit locks.
		if (TERMINAL_NODE_STATUSES.has(node.status)) {
			for (const [file, lock] of Object.entries(task.editLocks))
				if (lock?.nodeId === id) warnings.push(`terminal node ${id} still holds editLock for ${file}`);
		}
	}
	// Attention derivation (roadmap issue 5): durable, pane-free recovery classification per node.
	// Advisory only — appended to the existing runtime=true warnings surface, zero schema change.
	for (const [id, node] of Object.entries(task.nodes)) {
		const att = deriveNodeAttention(st, task, id, nowMs);
		if (!att.workerReminderEligible) continue;
		warnings.push(
			`attention: node ${id} → ${att.category} (assignee ${node.assignee || "?"}) — ${att.evidence.join("; ")} — root may send one bounded reminder via /swarm remind ${task.taskId} ${id}`,
		);
	}
	if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
		for (const agent of Object.values(st.agents)) {
			ensureAgentDefaults(agent);
			if (agent.activeTaskIds.includes(task.taskId))
				warnings.push(`task ${task.taskId} is ${task.status} but still in ${agent.id}.activeTaskIds`);
		}
	}
	return warnings;
}
