import type { SwarmState, TaskState } from "../types.ts";
import { collectNodeMessageRefs, latestNonSupersededMessage } from "./collectors.ts";
import { laneIcon, messageLifecyclePhrase, nodeAge, rowKey, statusIcon } from "./formatting.ts";
import type { FlowAttentionItem, FlowLaneItem, Row, Section } from "./types.ts";

export function collectAttentionRows(attention: FlowAttentionItem[]): Row[] {
	return attention.map((item, i) => ({
		section: "ATTENTION",
		id: `att-${i}`,
		title: item.title,
		summary: `${item.severity === "act" ? "!" : item.severity === "watch" ? "⚠" : "·"} ${item.summary}`,
		detail: item.detail,
		hint: item.hint,
		search: rowKey(`${item.title} ${item.summary} ${item.detail} ${item.hint}`),
		severity: item.severity,
		nodeId: item.nodeId,
		agentId: item.agentId,
		messageId: item.messageId,
	}));
}

export function collectNodeRows(task: TaskState, st: SwarmState): Row[] {
	return Object.entries(task.nodes).map(([nodeId, node]) => {
		const incoming = task.edges.filter((edge) => edge.to === nodeId).map((edge) => `${edge.from}${edge.when ? ` [${edge.when}]` : ""}`);
		const outgoing = task.edges.filter((edge) => edge.from === nodeId).map((edge) => `${edge.to}${edge.when ? ` [${edge.when}]` : ""}`);
		const refs = collectNodeMessageRefs(task, nodeId);
		const records = refs.map((id) => ({ id, rec: st.messages[id] })).filter((item) => item.rec);
		records.sort((a, b) => Date.parse(a.rec.updatedAt || a.rec.createdAt) - Date.parse(b.rec.updatedAt || b.rec.createdAt));
		const latest = [...records].reverse().find((item) => !item.rec.superseded) || records[records.length - 1];
		const lane = node.assignee ? st.agents[node.assignee] : undefined;
		const gateEntries =
			Object.entries(task.gates || {})
				.map(([gateId, gate]) => `${gateId}:${gate.status}`)
				.join(", ") || "-";
		const messageChain = records.length
			? records
					.map((item) => `${item.id} ${messageLifecyclePhrase(item.rec)}${item.rec.superseded ? " (superseded)" : ""}`)
					.join(" · ")
			: "-";
		return {
			section: "FLOW",
			id: nodeId,
			title: node.status,
			summary: `${statusIcon(node.status)} ${nodeId} ${node.status}${node.assignee ? ` → ${node.assignee}` : ""}${node.dependsOn.length ? ` deps:${node.dependsOn.join(",")}` : ""}${node.outcome ? ` outcome=${node.outcome}` : ""}${node.staleAt ? " stale" : ""}`,
			detail: `Node: ${nodeId}\nTask: ${task.taskId}\nStatus: ${node.status}\nRole: ${node.role}\nAssignee: ${node.assignee || "-"}\nOwner age: ${nodeAge(node)}\nDepends on: ${node.dependsOn.join(", ") || "-"}\nIncoming edges: ${incoming.join(", ") || "-"}\nOutgoing edges: ${outgoing.join(", ") || "-"}\nOutcome: ${node.outcome || "-"}\nStale at: ${node.staleAt || "-"}\nMessages: ${messageChain}\nLatest message: ${latest ? `${latest.id} ${messageLifecyclePhrase(latest.rec)}` : "-"}\nLane health: ${lane ? `${lane.status}/${lane.runtimeStatus}/${lane.health}` : "unavailable"}\nGates: ${gateEntries}\nAttempts: ${node.attempts ?? "-"}`,
			hint: node.assignee ? `/swarm attach ${node.assignee}` : `/swarm next ${task.taskId}`,
			search: rowKey(
				`${nodeId} ${node.status} ${node.assignee || ""} ${node.role} ${node.dependsOn.join(" ")} ${node.outcome || ""} ${node.staleAt || ""} ${messageChain} ${gateEntries}`,
			),
			severity: node.status === "failed" || node.status === "blocked" ? "act" : node.staleAt ? "watch" : "info",
			nodeId,
		};
	});
}

export function collectLaneRows(
	task: TaskState,
	lanes: FlowLaneItem[],
	expandOthers: boolean,
	otherAgentsCount: number,
	st?: SwarmState,
): Row[] {
	const rows: Row[] = lanes.map((lane) => ({
		section: "LANES" as Section,
		id: lane.id,
		title: lane.id,
		summary: `${laneIcon(undefined, Boolean(lane.missing))} ${lane.id} ${lane.status} · ${lane.roleKind} · ${lane.health}${lane.nodeIds.length ? ` · node=${lane.nodeIds.join(",")}` : ""}${lane.activeTaskIds.length ? ` · active=${lane.activeTaskIds.join(",")}` : ""}`,
		detail: `Agent ${lane.id} — task lane\nStatus: ${lane.status}\nRuntime: ${lane.runtimeStatus}\nHealth: ${lane.health}\nRole kind: ${lane.roleKind}\nActive tasks: ${lane.activeTaskIds.join(", ") || "-"}\nTask nodes: ${lane.nodeIds.join(", ") || "-"}\n\nWhat this means: this agent owns the listed nodes in this task.\nHints: /swarm attach ${lane.id} · /swarm capture ${lane.id}`,
		hint: `/swarm attach ${lane.id}`,
		search: rowKey(
			`${lane.id} ${lane.status} ${lane.runtimeStatus} ${lane.health} ${lane.roleKind} ${lane.activeTaskIds.join(" ")} ${lane.nodeIds.join(" ")}`,
		),
		severity: lane.status === "stopped" || lane.health === "unhealthy" ? "watch" : "info",
		agentId: lane.id,
	}));
	if (expandOthers && st) {
		const shown = new Set(lanes.map((lane) => lane.id));
		for (const agent of Object.values(st.agents).sort((a, b) => a.id.localeCompare(b.id))) {
			if (shown.has(agent.id)) continue;
			rows.push({
				section: "LANES",
				id: `other:${agent.id}`,
				title: agent.id,
				summary: `${laneIcon(agent)} ${agent.id} ${agent.status} · ${agent.roleKind} · ${agent.health}${agent.activeTaskIds.length ? ` · active=${agent.activeTaskIds.join(",")}` : ""}`,
				detail: `Agent ${agent.id} (not assigned to any node in this task)\nStatus: ${agent.status}\nRuntime: ${agent.runtimeStatus}\nHealth: ${agent.health}\nRole kind: ${agent.roleKind}\nActive tasks: ${agent.activeTaskIds.join(", ") || "-"}\n\nWhat this means: this agent is idle/unrelated to this task.\nHints: /swarm attach ${agent.id} · /swarm capture ${agent.id}`,
				hint: `/swarm attach ${agent.id}`,
				search: rowKey(`${agent.id} ${agent.status} ${agent.roleKind} ${agent.health}`),
				severity: agent.status === "stopped" || agent.health === "unhealthy" ? "watch" : "info",
				agentId: agent.id,
			});
		}
	}
	if (!expandOthers && otherAgentsCount > 0) {
		rows.push({
			section: "LANES",
			id: "lanes-collapsed",
			title: "other-agents",
			summary: `+ ${otherAgentsCount} other agents collapsed (j/Enter/o to expand)`,
			detail: `${otherAgentsCount} other agents are collapsed in this read-only snapshot.\n\nWhat this means: these agents are not assigned to any node in this task.\nPress j, Enter, or o to reveal them.`,
			hint: "o",
			search: rowKey(`collapsed other agents ${otherAgentsCount}`),
			severity: "info",
		});
	}
	return rows;
}

export function collectEventRows(events: Array<{ text: string; raw: Record<string, any> }>): Row[] {
	return events.map((ev, i) => ({
		section: "EVENTS",
		id: `event-${i}`,
		title: `event ${i + 1}`,
		summary: ev.text,
		detail: `${ev.text}\n\nRaw:\n${JSON.stringify(ev.raw, null, 2)}`,
		hint: "r",
		search: rowKey(`${ev.text} ${JSON.stringify(ev.raw)}`),
		severity: "info",
	}));
}
