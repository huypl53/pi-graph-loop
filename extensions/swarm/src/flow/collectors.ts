import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expected, logSwarmError } from "../errorlog.ts";
import { readRecentEvents } from "../observability.ts";
import { computeReadyNodes, computeTaskClosure, hasOutgoingTaskEdge } from "../taskgraph.ts";
import type { Paths, SwarmState, TaskPaths, TaskState } from "../types.ts";
import { now } from "../utils.ts";
import {
	freshnessLabel,
	isDeadRuntime,
	messageLifecyclePhrase,
	safeHint,
	sanitizeUntrustedText,
	severityRank,
} from "./formatting.ts";
import type { FlowAttentionItem, FlowDialogData, FlowHandoffLine, FlowLaneItem, NodeMessage } from "./types.ts";
import { WATCH_AGE_MS } from "./types.ts";

export function readMailboxLine(p: Paths, agentId: string, messageId: string): { subject?: string; body?: string } | null {
	try {
		const mailboxPath = join(p.mailboxes, `${agentId.replace(/[^a-z0-9_-]/gi, "_")}.jsonl`);
		if (!existsSync(mailboxPath)) return null;
		const content = readFileSync(mailboxPath, "utf-8");
		const lines = content.split("\n").reverse();
		const SCAN_LIMIT = 500;
		for (let i = 0; i < Math.min(lines.length, SCAN_LIMIT); i++) {
			const line = lines[i].trim();
			if (!line) continue;
			try {
				const msg = JSON.parse(line);
				if (msg.id === messageId) {
					return {
						subject: sanitizeUntrustedText(msg.subject),
						body: sanitizeUntrustedText(msg.body),
					};
				}
			} catch (err: any) {
				expected("corrupt_mailbox_json_line", err);
				continue;
			}
		}
		return null;
	} catch (err) {
		void logSwarmError(p, "flow-dialog", "mailbox_preview.read_failed", err);
		return null;
	}
}

export function isEventEchoMsg(subject: string, body?: string): boolean {
	if (/^task \S+ node \S+ (->|moved)/.test(subject)) return true;
	if (/^Node \S+ of \S+ moved /.test(body || "")) return true;
	if (/^Node `?\S+`? (of|→|->) /.test(body || "") && /moved|-> done|-> done\)/.test(body || "")) return true;
	if (/^Node \S+ .*(moved|-> done)/.test(body || "")) return true;
	if (/node \S+ -> done\)$/.test(subject)) return true;
	return false;
}

export async function collectNodeMessages(p: Paths, task: TaskState, st: SwarmState, nodeId: string): Promise<NodeMessage[]> {
	const messages: NodeMessage[] = [];
	const node = task.nodes[nodeId];
	if (!node) return messages;
	const push = (messageId: string, rec: any, subjectFallback: string): void => {
		const mailboxData =
			readMailboxLine(p, rec.to || rec.from || "", messageId) || readMailboxLine(p, rec.from || rec.to || "", messageId);
		messages.push({
			from: sanitizeUntrustedText(rec.from) || "?",
			to: sanitizeUntrustedText(rec.to) || "?",
			subject: sanitizeUntrustedText(mailboxData?.subject || rec.subject || subjectFallback),
			body: sanitizeUntrustedText(mailboxData?.body),
			messageId,
			lifecycle: messageLifecyclePhrase(rec),
			timestamp: rec.createdAt || "",
		});
	};

	for (const msgId of node.messageIds || []) {
		const rec = st.messages[msgId];
		if (rec) push(msgId, rec, "(no subject)");
	}
	if (node.assignmentMessageId) {
		const rec = st.messages[node.assignmentMessageId];
		if (rec && !messages.find((m) => m.messageId === node.assignmentMessageId))
			push(node.assignmentMessageId, rec, `assignment: ${nodeId}`);
	}
	const baseFiltered = messages.filter((m) => !isEventEchoMsg(m.subject || "", m.body));
	messages.length = 0;
	messages.push(...baseFiltered);
	for (const handoff of task.handoffs || []) {
		if (handoff.toNode === nodeId || handoff.fromNode === nodeId) {
			const handoffId = typeof handoff.messageId === "string" ? handoff.messageId : "";
			if (!handoffId) continue;
			const rec = st.messages[handoffId];
			if (rec && !messages.find((m) => m.messageId === handoffId))
				push(handoffId, rec, `handoff: ${handoff.fromNode || "?"} → ${handoff.toNode || "?"}`);
		}
	}
	let frontier = messages.map((m) => m.messageId);
	const linked = new Set(frontier);
	for (let hop = 0; hop < 3; hop++) {
		const next: string[] = [];
		for (const [mid, rec] of Object.entries(st.messages || {})) {
			const r = rec as Record<string, any>;
			if (linked.has(mid) || !r?.replyTo || !frontier.includes(r.replyTo)) continue;
			if (isEventEchoMsg(String(r.subject || ""), String(r.body || ""))) continue;
			linked.add(mid);
			next.push(mid);
			const mb = (await readMailboxLine(p, r.to || "", mid)) || (await readMailboxLine(p, r.from || "", mid));
			messages[messages.length - 1].subject = sanitizeUntrustedText(mb?.subject || `(reply)`);
			messages[messages.length - 1].body = sanitizeUntrustedText(mb?.body);
			messages.push({
				from: sanitizeUntrustedText(r.from) || "?",
				to: sanitizeUntrustedText(r.to) || "?",
				subject: sanitizeUntrustedText(r.subject || `(reply)`),
				body: undefined,
				messageId: mid,
				lifecycle: messageLifecyclePhrase(r),
				timestamp: r.createdAt || "",
			});
		}
		if (!next.length) break;
		frontier = next;
	}
	messages.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
	return messages;
}

export function collectNodeMessageRefs(task: TaskState, nodeId: string): string[] {
	const ids = new Set<string>();
	const node = task.nodes[nodeId];
	if (!node) return [];
	if (node.assignmentMessageId) ids.add(node.assignmentMessageId);
	for (const id of node.messageIds || []) ids.add(id);
	for (const handoff of task.handoffs || []) {
		const h = handoff as Record<string, any>;
		if ((h?.toNode === nodeId || h?.fromNode === nodeId) && typeof h?.messageId === "string") ids.add(h.messageId);
	}
	return [...ids];
}

export function latestNonSupersededMessage(task: TaskState, st: SwarmState, nodeId: string): { id?: string; rec?: any } {
	const node = task.nodes[nodeId];
	if (!node) return {};
	const pickLatest = (ids: string[]): { id?: string; rec?: any } => {
		const ordered = ids.map((id) => ({ id, rec: st.messages[id] })).filter((item) => item.rec);
		ordered.sort((a, b) => Date.parse(a.rec.updatedAt || a.rec.createdAt) - Date.parse(b.rec.updatedAt || b.rec.createdAt));
		for (let i = ordered.length - 1; i >= 0; i--) {
			if (!ordered[i].rec.superseded) return ordered[i];
		}
		return ordered[ordered.length - 1] || {};
	};
	const preferred = new Set<string>();
	if (node.assignmentMessageId) preferred.add(node.assignmentMessageId);
	for (const handoff of task.handoffs || []) {
		const h = handoff as Record<string, any>;
		if ((h?.toNode === nodeId || h?.fromNode === nodeId) && typeof h?.messageId === "string") preferred.add(h.messageId);
	}
	const preferredPick = pickLatest([...preferred]);
	if (preferredPick.rec) return preferredPick;
	return pickLatest(collectNodeMessageRefs(task, nodeId));
}

export function buildHandoffLines(task: TaskState, st: SwarmState): FlowHandoffLine[] {
	const lines: FlowHandoffLine[] = [];
	for (const edge of task.edges) {
		const target = latestNonSupersededMessage(task, st, edge.to);
		const source = latestNonSupersededMessage(task, st, edge.from);
		const chosen = target.rec || source.rec;
		lines.push({
			edge: `${edge.from}→${edge.to}`,
			messageId: chosen?.id,
			text: `handoff: ${edge.from}→${edge.to} ${messageLifecyclePhrase(chosen)}`,
			nodeId: edge.to,
		});
	}
	return lines;
}

export function buildAttentionItems(task: TaskState, _tp: TaskPaths, st: SwarmState): FlowAttentionItem[] {
	const items: FlowAttentionItem[] = [];
	const push = (item: FlowAttentionItem) => items.push(item);
	for (const [nodeId, node] of Object.entries(task.nodes)) {
		if (node.status === "failed" || node.status === "blocked") {
			push({
				severity: "act",
				kind: "node",
				title: nodeId,
				summary: `${nodeId} is ${node.status}${node.assignee ? ` (${node.assignee})` : ""}`,
				detail: `${nodeId}\nStatus: ${node.status}\nAssignee: ${node.assignee || "-"}\nRole: ${node.role}\nOutcome: ${node.outcome || "-"}\nHints: /swarm task ${task.taskId} runtime`,
				hint: safeHint(`/swarm task ${task.taskId} runtime`),
				taskId: task.taskId,
				nodeId,
			});
		}
		if (node.status === "done" && hasOutgoingTaskEdge(task, nodeId) && !node.outcome) {
			push({
				severity: "act",
				kind: "node",
				title: nodeId,
				summary: `${nodeId} is done but missing an outcome`,
				detail: `${nodeId}\nStatus: done\nAssignee: ${node.assignee || "-"}\nRole: ${node.role}\nOutcome: -\nHints: /swarm next ${task.taskId} · /swarm task ${task.taskId}`,
				hint: safeHint(`/swarm task ${task.taskId}`),
				taskId: task.taskId,
				nodeId,
			});
		}
		if (node.staleAt) {
			push({
				severity: "watch",
				kind: "node",
				title: nodeId,
				summary: `${nodeId} is stale`,
				detail: `${nodeId}\nStale at: ${node.staleAt}\nHints: /swarm task ${task.taskId} runtime`,
				hint: safeHint(`/swarm task ${task.taskId} runtime`),
				taskId: task.taskId,
				nodeId,
			});
		}
	}

	const msgIds = new Set<string>();
	for (const node of Object.values(task.nodes)) {
		for (const id of node.messageIds || []) msgIds.add(id);
		if (node.assignmentMessageId) msgIds.add(node.assignmentMessageId);
	}
	for (const messageId of msgIds) {
		const rec = st.messages[messageId];
		if (!rec) continue;
		const age = Date.now() - new Date(rec.updatedAt || rec.createdAt).getTime();
		const watchAge = age > WATCH_AGE_MS;
		if (rec.status === "failed" || rec.status === "dead_letter") {
			push({
				severity: "act",
				kind: "message",
				title: messageId,
				summary: `message to ${rec.to} is stuck${rec.lastError ? ` (${rec.lastError})` : ""}`,
				detail: `${messageId}\nStatus: ${rec.status}\nCreated: ${rec.createdAt}\nUpdated: ${rec.updatedAt}\nLast error: ${rec.lastError || "-"}\nHints: /swarm task ${task.taskId}`,
				hint: safeHint(`/swarm task ${task.taskId}`),
				taskId: task.taskId,
				messageId,
			});
			continue;
		}
		if (rec.ackMissingAt || (rec.requiresAck && !rec.ackedAt && watchAge)) {
			push({
				severity: rec.ackMissingAt ? "act" : "watch",
				kind: "message",
				title: messageId,
				summary: `message to ${rec.to} is waiting for ACK`,
				detail: `${messageId}\nStatus: ${rec.status}\nRequires ACK: yes\nAck missing: ${rec.ackMissingAt || "-"}\nHints: /swarm task ${task.taskId}`,
				hint: safeHint(`/swarm task ${task.taskId}`),
				taskId: task.taskId,
				messageId,
			});
		}
		if (rec.requiresResponse && !rec.response?.resultMessageId) {
			push({
				severity: rec.response?.status === "missing" ? "act" : "watch",
				kind: "message",
				title: messageId,
				summary: `message to ${rec.to} is waiting for a response`,
				detail: `${messageId}\nStatus: ${rec.status}\nRequires response: yes\nResponse state: ${rec.response?.status || "missing"}\nHints: /swarm task ${task.taskId}`,
				hint: safeHint(`/swarm task ${task.taskId}`),
				taskId: task.taskId,
				messageId,
			});
		}
		if (["queued", "mailbox_delivered", "injected", "intercepted"].includes(rec.status) && watchAge) {
			push({
				severity: "watch",
				kind: "message",
				title: messageId,
				summary: `message to ${rec.to} is in flight (${rec.status})`,
				detail: `${messageId}\nStatus: ${rec.status}\nAge: ${humanAge(rec.updatedAt || rec.createdAt)}\nHints: /swarm task ${task.taskId}`,
				hint: safeHint(`/swarm task ${task.taskId}`),
				taskId: task.taskId,
				messageId,
			});
		}
	}

	for (const [nodeId, node] of Object.entries(task.nodes)) {
		if (node.status !== "assigned" && node.status !== "in_progress") continue;
		if (!node.assignee) continue;
		const agent = st.agents[node.assignee];
		if (!agent || isDeadRuntime(agent)) {
			push({
				severity: "watch",
				kind: "agent",
				title: node.assignee,
				summary: `${nodeId} is assigned to ${node.assignee} (${agent ? `${agent.status}/${agent.health}/${agent.runtimeStatus}` : "missing agent"}; runtime evidence only)`,
				detail: `${node.assignee}\nNode: ${nodeId}\nAgent: ${agent ? `${agent.status}/${agent.health}/${agent.runtimeStatus}` : "missing"}\nHints: /swarm capture ${node.assignee} · /swarm attach ${node.assignee}`,
				hint: safeHint(`/swarm capture ${node.assignee}`),
				taskId: task.taskId,
				nodeId,
				agentId: node.assignee,
			});
		}
	}

	return items;
}

export function buildLanes(
	task: TaskState,
	st: SwarmState,
	attention: FlowAttentionItem[],
	expandOthers: boolean,
): { lanes: FlowLaneItem[]; otherAgentsCount: number } {
	const relevant = new Set<string>();
	for (const node of Object.values(task.nodes)) {
		if ((node.status === "assigned" || node.status === "in_progress" || node.status === "ready") && node.assignee)
			relevant.add(node.assignee);
	}
	for (const item of attention) if (item.agentId) relevant.add(item.agentId);
	const nodeIdsByAgent = new Map<string, string[]>();
	for (const [nodeId, node] of Object.entries(task.nodes)) {
		if (!node.assignee) continue;
		const arr = nodeIdsByAgent.get(node.assignee) || [];
		arr.push(nodeId);
		nodeIdsByAgent.set(node.assignee, arr);
	}
	const lanes: FlowLaneItem[] = [];
	for (const id of [...relevant].sort()) {
		const agent = st.agents[id];
		lanes.push({
			id,
			status: agent?.status || "missing",
			runtimeStatus: agent?.runtimeStatus || "unknown",
			health: agent?.health || "unknown",
			roleKind: agent?.roleKind || "unknown",
			activeTaskIds: agent?.activeTaskIds || [],
			nodeIds: nodeIdsByAgent.get(id) || [],
			missing: !agent,
		});
	}
	if (expandOthers) {
		for (const agent of Object.values(st.agents).sort((a, b) => a.id.localeCompare(b.id))) {
			if (relevant.has(agent.id)) continue;
			lanes.push({
				id: agent.id,
				status: agent.status,
				runtimeStatus: agent.runtimeStatus,
				health: agent.health,
				roleKind: agent.roleKind,
				activeTaskIds: agent.activeTaskIds,
				nodeIds: nodeIdsByAgent.get(agent.id) || [],
				missing: false,
			});
		}
	}
	return { lanes, otherAgentsCount: Object.keys(st.agents).filter((id) => !relevant.has(id)).length };
}

export async function collectFlowData(
	p: Paths,
	cwd: string,
	task: TaskState,
	tp: TaskPaths,
	st: SwarmState,
	eventLimit: number,
): Promise<FlowDialogData> {
	const { ready, current } = computeReadyNodes(task);
	const closure = computeTaskClosure(st, task, tp);
	const attention = buildAttentionItems(task, tp, st).sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
	const { lanes, otherAgentsCount } = buildLanes(task, st, attention, false);
	const events = await readRecentEvents(p, tp, eventLimit);
	const refreshedAt = now();
	const fresh = freshnessLabel(refreshedAt);
	return {
		refreshedAt,
		freshnessLabel: fresh.label,
		stale: fresh.stale,
		task,
		tp,
		st,
		open: closure.openNodes,
		staleCount: closure.staleNodes,
		ready,
		current,
		attention,
		lanes,
		otherAgentsCount,
		events,
		eventLimit,
		closure,
	};
}
