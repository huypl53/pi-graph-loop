import type { Component, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readRecentEvents } from "./observability.ts";
import { readState, readTaskState, taskPaths } from "./state.ts";
import { computeReadyNodes, computeTaskClosure, hasOutgoingTaskEdge } from "./taskgraph.ts";
import type { Paths, SwarmAgent, SwarmState, TaskPaths, TaskState } from "./types.ts";
import { humanAge, now } from "./utils.ts";

const FLOW_OVERLAY_OPTIONS = { width: "96%", minWidth: 60, maxHeight: "78%", anchor: "center", margin: { top: 1, bottom: 1 } } as const;
const PICKER_OVERLAY_OPTIONS = { width: "70%", minWidth: 58, maxHeight: "68%", anchor: "center", margin: { top: 1, bottom: 1 } } as const;
const DEFAULT_EVENT_LIMIT = 20;
const WATCH_AGE_MS = 2 * 60 * 1000;
const FRESHNESS_MS = 60 * 1000;

type Severity = "act" | "watch" | "info";
type Section = "ATTENTION" | "FLOW" | "LANES" | "EVENTS";

export interface FlowAttentionItem {
	severity: Severity;
	kind: "node" | "message" | "agent";
	title: string;
	summary: string;
	detail: string;
	hint: string;
	taskId?: string;
	nodeId?: string;
	agentId?: string;
	messageId?: string;
}

export interface FlowLaneItem {
	id: string;
	status: string;
	runtimeStatus: string;
	health: string;
	roleKind: string;
	activeTaskIds: string[];
	nodeIds: string[];
	missing?: boolean;
}

export interface FlowDialogData {
	refreshedAt: string;
	freshnessLabel: string;
	stale: boolean;
	task: TaskState;
	tp: TaskPaths;
	st: SwarmState;
	open: number;
	staleCount: number;
	ready: string[];
	current: string[];
	attention: FlowAttentionItem[];
	lanes: FlowLaneItem[];
	otherAgentsCount: number;
	events: Array<{ text: string; raw: Record<string, any> }>;
	eventLimit: number;
	closure: ReturnType<typeof computeTaskClosure>;
}

export interface FlowDialogOpts { eventLimit?: number; }

interface PickerEntry {
	index: number;
	taskId: string;
	title: string;
	status: string;
	updatedAt: string;
	attentionCount: number;
	priority: number;
}

interface Row {
	section: Section;
	id: string;
	title: string;
	summary: string;
	detail: string;
	hint: string;
	search: string;
	severity: Severity;
	nodeId?: string;
	agentId?: string;
	messageId?: string;
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }
function clock(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "??:??:??";
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
function rowKey(v: string): string { return v.toLowerCase(); }
function statusIcon(status: string): string {
	switch (status) {
		case "done": return "✓";
		case "in_progress": return "▶";
		case "assigned": return "▶";
		case "ready": return "○";
		case "blocked": return "✗";
		case "failed": return "✗";
		case "skipped": return "✗";
		default: return "○";
	}
}
function laneIcon(agent?: SwarmAgent, missing = false): string {
	if (missing) return "!";
	if (!agent) return "·";
	if (agent.runtimeStatus === "busy" || agent.runtimeStatus === "tool_running") return "●";
	if (agent.runtimeStatus === "idle" || agent.runtimeStatus === "starting") return "○";
	if (agent.status === "stopped" || agent.runtimeStatus === "stopped") return "✗";
	return "·";
}
function freshnessLabel(refreshedAt: string): { label: string; stale: boolean } {
	const age = Date.now() - new Date(refreshedAt).getTime();
	if (!Number.isFinite(age)) return { label: `refreshed ${clock(refreshedAt)}`, stale: false };
	if (age > FRESHNESS_MS) return { label: `refreshed ${clock(refreshedAt)} · stale ${humanAge(refreshedAt)}`, stale: true };
	return { label: `refreshed ${clock(refreshedAt)} · fresh ${humanAge(refreshedAt)}`, stale: false };
}
function severityRank(s: Severity): number { return s === "act" ? 0 : s === "watch" ? 1 : 2; }
function isDeadRuntime(agent?: SwarmAgent): boolean {
	if (!agent) return true;
	return agent.status === "stopped" || agent.health === "unhealthy" || agent.runtimeStatus === "stopped" || agent.runtimeStatus === "shutting_down";
}
function safeHint(command: string): string { return command; }

interface FlowHandoffLine {
	edge: string;
	messageId?: string;
	text: string;
	nodeId?: string;
}

interface FlowEventGroup {
	title: string;
	items: Array<{ text: string; raw: Record<string, any> }>;
}

interface GraphTreeEntry {
	index: number;
	nodeId: string;
	depth: number;
	parentIndex: number | null;
	edgeFrom?: string;
	edgeWhen?: string;
	edgeRework?: boolean;
	repeated: boolean;
	children: number[];
}

interface GraphTreeModel {
	entries: GraphTreeEntry[];
	firstIndexByNodeId: Map<string, number>;
}

function outgoingEdges(task: TaskState, nodeId: string) {
	return task.edges.filter((edge) => edge.from === nodeId);
}

export function buildGraphTree(task: TaskState): GraphTreeModel {
	const entries: GraphTreeEntry[] = [];
	const firstIndexByNodeId = new Map<string, number>();
	const inOrderRoots = task.nodes[task.start] ? [task.start] : Object.keys(task.nodes).filter((id) => !task.edges.some((edge) => edge.to === id));
	const roots = inOrderRoots.length ? inOrderRoots : Object.keys(task.nodes);
	const visit = (nodeId: string, depth: number, parentIndex: number | null, edge?: { from: string; when: string; rework?: boolean }, path = new Set<string>()): number => {
		const node = task.nodes[nodeId];
		if (!node) return -1;
		const repeated = firstIndexByNodeId.has(nodeId);
		const index = entries.length;
		entries.push({ index, nodeId, depth, parentIndex, edgeFrom: edge?.from, edgeWhen: edge?.when, edgeRework: edge?.rework, repeated, children: [] });
		if (!firstIndexByNodeId.has(nodeId)) firstIndexByNodeId.set(nodeId, index);
		if (path.has(nodeId)) return index;
		const nextPath = new Set(path);
		nextPath.add(nodeId);
		for (const childEdge of outgoingEdges(task, nodeId)) {
			const childIndex = visit(childEdge.to, depth + 1, index, childEdge, nextPath);
			if (childIndex >= 0) entries[index].children.push(childIndex);
		}
		return index;
	};
	for (const root of roots) visit(root, 0, null, undefined, new Set());
	return { entries, firstIndexByNodeId };
}

function nodeDisplayLabel(task: TaskState, entry: GraphTreeEntry, currentIds: Set<string>, attentionIds: Set<string>, focused = false): string {
	const node = task.nodes[entry.nodeId];
	if (!node) return entry.nodeId;
	const icon = statusIcon(node.status);
	const attention = attentionIds.has(entry.nodeId) ? " !" : "";
	const edge = entry.parentIndex == null ? "" : entry.edgeRework ? "↺ " : "└─▶ ";
	const owner = node.assignee || node.role || "unowned";
	const age = nodeAge(node);
	const focus = focused ? " ◀" : "";
	return `${"  ".repeat(entry.depth)}${edge}${icon} ${entry.nodeId}${attention}${focus} · ${owner} · ${age}`;
}


function buildNodeDetail(task: TaskState, st: SwarmState, entry: GraphTreeEntry, attention: FlowAttentionItem[]): string[] {
	const node = task.nodes[entry.nodeId];
	if (!node) return [`${entry.nodeId} not found`];
	const owner = node.assignee || node.role || "unowned";
	const lines: string[] = [];
	
	// Status: per-status logic
	if (node.status === "pending") {
		const deps = node.dependsOn || [];
		const pendingDeps = deps.filter((depId) => {
			const depNode = task.nodes[depId];
			return depNode && depNode.status !== "done";
		});
		if (pendingDeps.length) {
			lines.push(`Status: PENDING — waiting for upstream nodes (${pendingDeps.join(", ")})`);
		} else {
			lines.push(`Status: PENDING — waiting for upstream nodes`);
		}
	} else if (node.status === "in_progress") {
		const age = nodeAge(node);
		const h = latestNonSupersededMessage(task, st, entry.nodeId);
		const msgInfo = h.rec ? ` · msg ${h.rec.id || "?"}` : "";
		lines.push(`Status: IN_PROGRESS — ${owner} running · ${age}${msgInfo}`);
	} else if (node.status === "assigned") {
		const age = nodeAge(node);
		lines.push(`Status: ASSIGNED — ${owner} assigned · ${age}`);
	} else if (node.status === "blocked") {
		const blocker = attention.find((item) => item.nodeId === entry.nodeId && item.severity === "act");
		const reason = blocker ? blocker.summary : "no clear reason";
		const blockingAgent = blocker && blocker.hint ? blocker.hint : "unknown";
		lines.push(`Status: BLOCKED — ${reason} · ${blockingAgent} holding`);
	} else if (node.status === "failed") {
		lines.push(`Status: FAILED — ${owner} failed · ${nodeAge(node)}`);
	} else if (node.status === "done") {
		const outcome = node.outcome || "completed";
		lines.push(`Status: DONE — ${outcome}`);
	} else if (node.status === "ready") {
		lines.push(`Status: READY — waiting for assign`);
	} else {
		lines.push(`Status: ${node.status} · ${owner} · ${nodeAge(node)}`);
	}
	
	// Waiting on?
	if (node.status === "pending") {
		lines.push("Waiting on: upstream nodes to complete");
	} else if (node.status === "assigned" || node.status === "in_progress") {
		lines.push(`Waiting on: ${owner} to complete`);
	} else if (node.status === "blocked") {
		lines.push("Waiting on: resolve block");
	} else if (node.status === "ready") {
		lines.push("Waiting on: assign agent");
	} else if (node.status === "done") {
		lines.push("Waiting on: none");
	} else {
		lines.push("Waiting on: none");
	}
	
	// Messages: msg with partner + delivered/ack/response
	const h = latestNonSupersededMessage(task, st, entry.nodeId);
	if (h.rec) {
		const partner = h.rec.from === "root" ? "root" : h.rec.from;
		const delivered = h.rec.status === "delivered" || h.rec.status === "injected" || h.rec.status === "intercepted";
		const acked = h.rec.ackedAt !== undefined;
		const responded = h.rec.response && h.rec.response.status !== "missing";
		const ticks = `${delivered ? "delivered ✓" : "not delivered ✗"}, ${acked ? "acked ✓" : "not acked ✗"}, ${responded ? "responded ✓" : "not responded ✗"}`;
		lines.push(`Messages: msg with ${partner} · ${ticks}`);
	} else {
		lines.push("Messages: no record");
	}
	
	// Next action: actionable hints
	if (node.status === "blocked") {
		if (owner && owner !== "unowned") {
			lines.push(`Next action: c copy /swarm capture ${owner}`);
		} else {
			lines.push("Next action: resolve block");
		}
	} else if (node.status === "ready") {
		if (owner) {
			lines.push(`Next action: assign to ${owner}`);
		} else {
			lines.push("Next action: assign agent");
		}
	} else if (node.status === "failed") {
		lines.push("Next action: fix and retry");
	} else if (node.status === "done") {
		lines.push("Next action: none");
	} else if (node.status === "assigned" || node.status === "in_progress") {
		lines.push(`Next action: ${owner} complete task`);
	} else if (node.status === "pending") {
		lines.push("Next action: none");
	} else {
		lines.push("Next action: none");
	}
	
	return lines;
}

interface NodeMessage {
	from: string;
	to: string;
	subject?: string;
	body?: string;
	messageId: string;
	lifecycle: string;
	timestamp: string;
}

function readMailboxLine(p: Paths, agentId: string, messageId: string): { subject?: string; body?: string } | null {
	try {
		const mailboxPath = join(p.mailboxes, `${agentId.replace(/[^a-z0-9_-]/gi, "_")}.jsonl`);
		if (!existsSync(mailboxPath)) return null;
		const content = readFileSync(mailboxPath, "utf-8");
		const lines = content.split("\n").reverse(); // Scan from end
		const SCAN_LIMIT = 500;
		for (let i = 0; i < Math.min(lines.length, SCAN_LIMIT); i++) {
			const line = lines[i].trim();
			if (!line) continue;
			try {
				const msg = JSON.parse(line);
				if (msg.id === messageId) return { subject: msg.subject, body: msg.body };
			} catch {
				continue;
			}
		}
		return null;
	} catch {
		return null;
	}
}

function isEventEchoMsg(subject: string, body?: string): boolean {
	// Auto-generated lifecycle echoes (e.g. "task X node Y -> done") — noise for humans.
	if (/^task \S+ node \S+ (->|moved)/.test(subject)) return true;
	if (/^Node \S+ of \S+ moved /.test(body || "")) return true;
	if (/^Node `?\S+`? (of|→|->) /.test(body || "") && /moved|-> done|-> done\)/.test(body || "")) return true;
	if (/^Node \S+ .*(moved|-> done)/.test(body || "")) return true;
	if (/node \S+ -> done\)$/.test(subject)) return true;
	return false;
}

async function collectNodeMessages(p: Paths, task: TaskState, st: SwarmState, nodeId: string): Promise<NodeMessage[]> {
	const messages: NodeMessage[] = [];
	const node = task.nodes[nodeId];
	if (!node) return messages;
	const push = (messageId: string, rec: any, subjectFallback: string): void => {
		const mailboxData = readMailboxLine(p, rec.to || rec.from || "", messageId) || readMailboxLine(p, rec.from || rec.to || "", messageId);
		messages.push({
			from: rec.from || "?",
			to: rec.to || "?",
			subject: mailboxData?.subject || rec.subject || subjectFallback,
			body: mailboxData?.body,
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
		if (rec && !messages.find((m) => m.messageId === node.assignmentMessageId)) push(node.assignmentMessageId, rec, `assignment: ${nodeId}`);
	}
	const baseFiltered = messages.filter((m) => !isEventEchoMsg(m.subject || "", m.body));
	messages.length = 0;
	messages.push(...baseFiltered);
	for (const handoff of task.handoffs || []) {
		if (handoff.toNode === nodeId || handoff.fromNode === nodeId) {
			const handoffId = typeof handoff.messageId === "string" ? handoff.messageId : "";
			if (!handoffId) continue;
			const rec = st.messages[handoffId];
			if (rec && !messages.find((m) => m.messageId === handoffId)) push(handoffId, rec, `handoff: ${handoff.fromNode || "?"} → ${handoff.toNode || "?"}`);
		}
	}
	// Reverse direction: pull replies (replyTo chains) from st.messages so the conversation shows both sides.
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
			messages[messages.length - 1].subject = mb?.subject || `(reply)`;
			messages[messages.length - 1].body = mb?.body;
			messages.push({
				from: r.from || "?",
				to: r.to || "?",
				subject: r.subject || `(reply)`,
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

export function deriveCurrentNodeIds(task: TaskState): string[] {
	const explicit = (task.currentNodes || []).filter((id) => Boolean(task.nodes[id]));
	if (explicit.length) return explicit;
	const inProgress = Object.entries(task.nodes).filter(([, node]) => node.status === "in_progress").map(([id]) => id);
	if (inProgress.length) return inProgress;
	const assigned = Object.entries(task.nodes).filter(([, node]) => node.status === "assigned").map(([id]) => id);
	if (assigned.length) return assigned;
	return Object.entries(task.nodes).filter(([, node]) => node.status === "ready").map(([id]) => id);
}

function nodeAge(node: TaskState["nodes"][string]): string {
	const ts = node.lastActivityAt || node.staleAt;
	return ts ? humanAge(ts) : "-";
}

function formatNodeBadge(task: TaskState, nodeId: string, current: Set<string>): string {
	const node = task.nodes[nodeId];
	if (!node) return nodeId;
	const icon = current.has(nodeId) ? "▶" : statusIcon(node.status);
	return `${icon} ${nodeId}`;
}

export function buildStoryLine(task: TaskState, closure: ReturnType<typeof computeTaskClosure>, ready: string[], currentIds: string[], attentionCount: number): string {
	const total = Object.keys(task.nodes).length;
	const pct = total > 0 ? Math.round((closure.closedNodes / total) * 100) : 0;
	const next = ready[0] || "none";
	const current = currentIds[0];
	if (!current) return `${task.taskId} · ${pct}% · no current node · next: ${next} · ${attentionCount} needs attention`;
	const node = task.nodes[current];
	const owner = node?.assignee || node?.role || "unowned";
	const age = node ? nodeAge(node) : "-";
	const currentLabel = currentIds.length > 1 ? `parallel current (${currentIds.length})` : `${current} running`;
	return `${task.taskId} · ${pct}% · ${currentLabel} (${owner}, ${age}) · next: ${next} · ${attentionCount} needs attention`;
}

function collectNodeMessageRefs(task: TaskState, nodeId: string): string[] {
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

export function messageLifecyclePhrase(rec?: any): string {
	if (!rec) return "no handoff record";
	if (rec.superseded) return "superseded";
	if (rec.status === "dead_letter" || rec.status === "failed") return `stuck${rec.lastError ? ` (${rec.lastError})` : ""}`;
	if (rec.ackMissingAt || (rec.requiresAck && !rec.ackedAt)) return "waiting ACK";
	if (rec.requiresResponse && !rec.response?.resultMessageId) return "waiting response";
	if (rec.status === "queued" || rec.status === "mailbox_delivered" || rec.status === "injected" || rec.status === "intercepted") return "in flight";
	if (rec.status === "acked" || rec.response?.status === "verified") return "delivered ✓ acked";
	return rec.status || "unknown";
}

function latestNonSupersededMessage(task: TaskState, st: SwarmState, nodeId: string): { id?: string; rec?: any } {
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

function collectGraphPaths(task: TaskState): Array<{ nodes: string[]; edges: Array<{ from: string; to: string; when: string; rework?: boolean }> }> {
	const outgoing = new Map<string, Array<{ from: string; to: string; when: string; rework?: boolean }>>();
	for (const edge of task.edges) {
		const arr = outgoing.get(edge.from) || [];
		arr.push(edge);
		outgoing.set(edge.from, arr);
	}
	for (const edges of outgoing.values()) edges.sort((a, b) => (a.when || "").localeCompare(b.when || "") || a.to.localeCompare(b.to));
	const roots = task.nodes[task.start] ? [task.start] : Object.keys(task.nodes).filter((id) => !task.edges.some((edge) => edge.to === id));
	const paths: Array<{ nodes: string[]; edges: Array<{ from: string; to: string; when: string; rework?: boolean }> }> = [];
	const walk = (nodeId: string, nodes: string[], edges: Array<{ from: string; to: string; when: string; rework?: boolean }>, seen: Set<string>) => {
		const next = outgoing.get(nodeId) || [];
		const nextNodes = [...nodes, nodeId];
		if (!next.length || seen.has(nodeId) || nextNodes.length > Object.keys(task.nodes).length + 3) {
			paths.push({ nodes: nextNodes, edges });
			return;
		}
		for (const edge of next) walk(edge.to, nextNodes, [...edges, edge], new Set([...seen, nodeId]));
	};
	for (const root of roots) walk(root, [], [], new Set());
	return paths.length ? paths : Object.keys(task.nodes).map((id) => ({ nodes: [id], edges: [] }));
}

export function renderGraphOverview(task: TaskState, currentIds: string[], width: number): string[] {
	const current = new Set(currentIds);
	const lines: string[] = [];
	const paths = collectGraphPaths(task);
	const seenLines = new Set<string>();
	const lineCount = new Map<string, number>();
	for (const path of paths) {
		if (!path.nodes.length) continue;
		let line = formatNodeBadge(task, path.nodes[0], current);
		for (let i = 0; i < path.edges.length; i++) {
			const edge = path.edges[i];
			// Only label branch edges (node has multiple outgoing edges) to reduce noise.
			const isBranch = (outgoingEdgeCount(task, edge.from) || 1) > 1;
			const label = isBranch && edge.when ? `[${edge.when}]` : "";
			line += ` ${edge.rework ? "↺" : "─"}${label}▶ ${formatNodeBadge(task, edge.to, current)}`;
		}
		if (width > 0 && visibleWidth(line) > width) {
			const currentIndex = path.nodes.findIndex((id) => current.has(id));
			if (currentIndex > 1) {
				const suffixNodes = path.nodes.slice(currentIndex);
				const suffix = suffixNodes.map((id) => formatNodeBadge(task, id, current)).join(" ──▶ ");
				const prefixStatus = task.nodes[path.nodes[0]]?.status === "done" ? "✓…" : "…";
				line = `${prefixStatus} ──▶ ${suffix}`;
			}
		}
		// Dedupe identical rendered lines (parallel paths through same nodes).
		const key = line.replace(/\s+/g, " ").trim();
		if (seenLines.has(key)) { lineCount.set(key, (lineCount.get(key) || 1) + 1); continue; }
		seenLines.add(key);
		lines.push(line);
	}
	// Annotate duplicated paths with xN instead of repeating.
	const out = lines.map((l) => {
		const key = l.replace(/\s+/g, " ").trim();
		const n = lineCount.get(key) || 1;
		return n > 1 ? `${l} (x${n})` : l;
	});
	return out.slice(0, 6);
}
function truncateLeft(s: string, cols: number): string {
	// Strip ANSI, slice from column offset, return plain slice (ANSI already removed by caller paths that need it).
	// Simple visible-width-aware left slice: walk chars, counting visible width, skip ANSI escapes whole.
	let out = "";
	let w = 0;
	let i = 0;
	while (i < s.length) {
		if (s[i] === "\x1b") { const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i)); if (m) { i += m[0].length; continue; } }
		const ch = Array.from(s.slice(i))[0] || "";
		const cw = visibleWidth(ch);
		if (w + cw > cols) { out = s.slice(i); return out; }
		w += cw;
		i += ch.length;
	}
	return "";
}
function outgoingEdgeCount(task: TaskState, nodeId: string): number {
	return task.edges.filter((e) => e.from === nodeId).length;
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

export function groupFlowEvents(events: Array<{ text: string; raw: Record<string, any> }>): FlowEventGroup[] {
	const groups = new Map<string, Array<{ text: string; raw: Record<string, any> }>>();
	const categorize = (event: string, text: string): string => {
		const hay = `${event} ${text}`.toLowerCase();
		if (/(dead_letter|failed|error|warn|blocked|stale)/.test(hay)) return "errors";
		if (/(assign|handoff|plan|reviewed|implemented|passed|rejected|approved|task\.)/.test(hay)) return "graph transitions";
		if (/(message|delivery|ack|response|mailbox|injected|intercepted)/.test(hay)) return "delivery / response";
		return "other";
	};
	for (const ev of events) {
		const title = categorize(ev.raw.event || ev.text, ev.text);
		const arr = groups.get(title) || [];
		arr.push(ev);
		groups.set(title, arr);
	}
	return [...groups.entries()].map(([title, items]) => ({ title, items }));
}

async function listTaskSummaries(p: Paths): Promise<PickerEntry[]> {
	const out: PickerEntry[] = [];
	let dirs: string[] = [];
	try { dirs = await readdir(p.tasksDir); } catch { return out; }
	for (const dir of dirs.sort()) {
		const tp = taskPaths(p, dir);
		if (!existsSync(tp.taskJson)) continue;
		try {
			const task = await readTaskState(tp.taskJson);
			out.push({ index: 0, taskId: task.taskId, title: task.title, status: task.status, updatedAt: task.updatedAt, attentionCount: 0, priority: 4 });
		} catch { /* ignore */ }
	}
	out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.taskId.localeCompare(b.taskId));
	return out.map((item, i) => ({ ...item, index: i + 1 }));
}

async function resolveTaskRefLocal(p: Paths, ref: string): Promise<{ hit?: { task: TaskState; tp: TaskPaths; index: number }; list: PickerEntry[]; missReason?: string; ambiguous?: string[] }> {
	const list = await listTaskSummaries(p);
	const trim = ref.trim();
	if (!trim) return { list, missReason: "no task reference given" };
	if (/^\d+$/.test(trim)) {
		const idx = parseInt(trim, 10);
		const hit = list[idx - 1];
		if (!hit) return { list, missReason: `no task at index ${idx} (have 1..${list.length})` };
		const tp = taskPaths(p, hit.taskId);
		return { hit: { task: await readTaskState(tp.taskJson), tp, index: hit.index }, list };
	}
	const norm = trim.toLowerCase();
	const exact = list.find((t) => t.taskId === trim || t.taskId.toLowerCase() === norm);
	if (exact) {
		const tp = taskPaths(p, exact.taskId);
		return { hit: { task: await readTaskState(tp.taskJson), tp, index: exact.index }, list };
	}
	const sub = list.filter((t) => t.taskId.includes(trim) || t.taskId.toLowerCase().includes(norm));
	if (sub.length === 1) {
		const tp = taskPaths(p, sub[0].taskId);
		return { hit: { task: await readTaskState(tp.taskJson), tp, index: sub[0].index }, list };
	}
	if (sub.length > 1) return { list, ambiguous: sub.map((t) => t.taskId) };
	return { list, missReason: `no task matches "${trim}"` };
}

function buildAttentionItems(task: TaskState, tp: TaskPaths, st: SwarmState): FlowAttentionItem[] {
	const items: FlowAttentionItem[] = [];
	const push = (item: FlowAttentionItem) => items.push(item);
	for (const [nodeId, node] of Object.entries(task.nodes)) {
		if (node.status === "failed" || node.status === "blocked") {
			push({ severity: "act", kind: "node", title: nodeId, summary: `${nodeId} is ${node.status}${node.assignee ? ` (${node.assignee})` : ""}`, detail: `${nodeId}\nStatus: ${node.status}\nAssignee: ${node.assignee || "-"}\nRole: ${node.role}\nOutcome: ${node.outcome || "-"}\nHints: /swarm task ${task.taskId} runtime`, hint: safeHint(`/swarm task ${task.taskId} runtime`), taskId: task.taskId, nodeId });
		}
		if (node.status === "done" && hasOutgoingTaskEdge(task, nodeId) && !node.outcome) {
			push({ severity: "act", kind: "node", title: nodeId, summary: `${nodeId} is done but missing an outcome`, detail: `${nodeId}\nStatus: done\nAssignee: ${node.assignee || "-"}\nRole: ${node.role}\nOutcome: -\nHints: /swarm next ${task.taskId} · /swarm task ${task.taskId}`, hint: safeHint(`/swarm task ${task.taskId}`), taskId: task.taskId, nodeId });
		}
		if (node.staleAt) {
			push({ severity: "watch", kind: "node", title: nodeId, summary: `${nodeId} is stale`, detail: `${nodeId}\nStale at: ${node.staleAt}\nHints: /swarm task ${task.taskId} runtime`, hint: safeHint(`/swarm task ${task.taskId} runtime`), taskId: task.taskId, nodeId });
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
			push({ severity: "act", kind: "message", title: messageId, summary: `message to ${rec.to} is stuck${rec.lastError ? ` (${rec.lastError})` : ""}`, detail: `${messageId}\nStatus: ${rec.status}\nCreated: ${rec.createdAt}\nUpdated: ${rec.updatedAt}\nLast error: ${rec.lastError || "-"}\nHints: /swarm task ${task.taskId}`, hint: safeHint(`/swarm task ${task.taskId}`), taskId: task.taskId, messageId });
			continue;
		}
		if (rec.ackMissingAt || (rec.requiresAck && !rec.ackedAt && watchAge)) {
			push({ severity: rec.ackMissingAt ? "act" : "watch", kind: "message", title: messageId, summary: `message to ${rec.to} is waiting for ACK`, detail: `${messageId}\nStatus: ${rec.status}\nRequires ACK: yes\nAck missing: ${rec.ackMissingAt || "-"}\nHints: /swarm task ${task.taskId}`, hint: safeHint(`/swarm task ${task.taskId}`), taskId: task.taskId, messageId });
		}
		if (rec.requiresResponse && !rec.response?.resultMessageId) {
			push({ severity: rec.response?.status === "missing" ? "act" : "watch", kind: "message", title: messageId, summary: `message to ${rec.to} is waiting for a response`, detail: `${messageId}\nStatus: ${rec.status}\nRequires response: yes\nResponse state: ${rec.response?.status || "missing"}\nHints: /swarm task ${task.taskId}`, hint: safeHint(`/swarm task ${task.taskId}`), taskId: task.taskId, messageId });
		}
		if (["queued", "mailbox_delivered", "injected", "intercepted"].includes(rec.status) && watchAge) {
			push({ severity: "watch", kind: "message", title: messageId, summary: `message to ${rec.to} is in flight (${rec.status})`, detail: `${messageId}\nStatus: ${rec.status}\nAge: ${humanAge(rec.updatedAt || rec.createdAt)}\nHints: /swarm task ${task.taskId}`, hint: safeHint(`/swarm task ${task.taskId}`), taskId: task.taskId, messageId });
		}
	}

	for (const [nodeId, node] of Object.entries(task.nodes)) {
		if (node.status !== "assigned" && node.status !== "in_progress") continue;
		if (!node.assignee) continue;
		const agent = st.agents[node.assignee];
		if (!agent || isDeadRuntime(agent)) {
			push({ severity: "watch", kind: "agent", title: node.assignee, summary: `${nodeId} is assigned to ${node.assignee} (${agent ? `${agent.status}/${agent.health}/${agent.runtimeStatus}` : "missing agent"}; runtime evidence only)`, detail: `${node.assignee}\nNode: ${nodeId}\nAgent: ${agent ? `${agent.status}/${agent.health}/${agent.runtimeStatus}` : "missing"}\nHints: /swarm capture ${node.assignee} · /swarm attach ${node.assignee}`, hint: safeHint(`/swarm capture ${node.assignee}`), taskId: task.taskId, nodeId, agentId: node.assignee });
		}
	}

	return items;
}

function buildLanes(task: TaskState, st: SwarmState, attention: FlowAttentionItem[], expandOthers: boolean): { lanes: FlowLaneItem[]; otherAgentsCount: number } {
	const relevant = new Set<string>();
	for (const node of Object.values(task.nodes)) {
		if ((node.status === "assigned" || node.status === "in_progress" || node.status === "ready") && node.assignee) relevant.add(node.assignee);
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
		lanes.push({ id, status: agent?.status || "missing", runtimeStatus: agent?.runtimeStatus || "unknown", health: agent?.health || "unknown", roleKind: agent?.roleKind || "unknown", activeTaskIds: agent?.activeTaskIds || [], nodeIds: nodeIdsByAgent.get(id) || [], missing: !agent });
	}
	if (expandOthers) {
		for (const agent of Object.values(st.agents).sort((a, b) => a.id.localeCompare(b.id))) {
			if (relevant.has(agent.id)) continue;
			lanes.push({ id: agent.id, status: agent.status, runtimeStatus: agent.runtimeStatus, health: agent.health, roleKind: agent.roleKind, activeTaskIds: agent.activeTaskIds, nodeIds: nodeIdsByAgent.get(agent.id) || [], missing: false });
		}
	}
	return { lanes, otherAgentsCount: Object.keys(st.agents).filter((id) => !relevant.has(id)).length };
}

function collectAttentionRows(attention: FlowAttentionItem[]): Row[] {
	return attention.map((item, i) => ({ section: "ATTENTION", id: `att-${i}`, title: item.title, summary: `${item.severity === "act" ? "!" : item.severity === "watch" ? "⚠" : "·"} ${item.summary}`, detail: item.detail, hint: item.hint, search: rowKey(`${item.title} ${item.summary} ${item.detail} ${item.hint}`), severity: item.severity, nodeId: item.nodeId, agentId: item.agentId, messageId: item.messageId }));
}

function collectNodeRows(task: TaskState, st: SwarmState): Row[] {
	return Object.entries(task.nodes).map(([nodeId, node]) => {
		const incoming = task.edges.filter((edge) => edge.to === nodeId).map((edge) => `${edge.from}${edge.when ? ` [${edge.when}]` : ""}`);
		const outgoing = task.edges.filter((edge) => edge.from === nodeId).map((edge) => `${edge.to}${edge.when ? ` [${edge.when}]` : ""}`);
		const refs = collectNodeMessageRefs(task, nodeId);
		const records = refs.map((id) => ({ id, rec: st.messages[id] })).filter((item) => item.rec);
		records.sort((a, b) => Date.parse(a.rec.updatedAt || a.rec.createdAt) - Date.parse(b.rec.updatedAt || b.rec.createdAt));
		const latest = [...records].reverse().find((item) => !item.rec.superseded) || records[records.length - 1];
		const lane = node.assignee ? st.agents[node.assignee] : undefined;
		const gateEntries = Object.entries(task.gates || {}).map(([gateId, gate]) => `${gateId}:${gate.status}`).join(", ") || "-";
		const messageChain = records.length ? records.map((item) => `${item.id} ${messageLifecyclePhrase(item.rec)}${item.rec.superseded ? " (superseded)" : ""}`).join(" · ") : "-";
		return {
			section: "FLOW",
			id: nodeId,
			title: node.status,
			summary: `${statusIcon(node.status)} ${nodeId} ${node.status}${node.assignee ? ` → ${node.assignee}` : ""}${node.dependsOn.length ? ` deps:${node.dependsOn.join(",")}` : ""}${node.outcome ? ` outcome=${node.outcome}` : ""}${node.staleAt ? " stale" : ""}`,
			detail: `Node: ${nodeId}\nTask: ${task.taskId}\nStatus: ${node.status}\nRole: ${node.role}\nAssignee: ${node.assignee || "-"}\nOwner age: ${nodeAge(node)}\nDepends on: ${node.dependsOn.join(", ") || "-"}\nIncoming edges: ${incoming.join(", ") || "-"}\nOutgoing edges: ${outgoing.join(", ") || "-"}\nOutcome: ${node.outcome || "-"}\nStale at: ${node.staleAt || "-"}\nMessages: ${messageChain}\nLatest message: ${latest ? `${latest.id} ${messageLifecyclePhrase(latest.rec)}` : "-"}\nLane health: ${lane ? `${lane.status}/${lane.runtimeStatus}/${lane.health}` : "unavailable"}\nGates: ${gateEntries}\nAttempts: ${node.attempts ?? "-"}`,
			hint: node.assignee ? `/swarm attach ${node.assignee}` : `/swarm next ${task.taskId}`,
			search: rowKey(`${nodeId} ${node.status} ${node.assignee || ""} ${node.role} ${node.dependsOn.join(" ")} ${node.outcome || ""} ${node.staleAt || ""} ${messageChain} ${gateEntries}`),
			severity: node.status === "failed" || node.status === "blocked" ? "act" : node.staleAt ? "watch" : "info",
			nodeId,
		};
	});
}

function collectLaneRows(task: TaskState, lanes: FlowLaneItem[], expandOthers: boolean, otherAgentsCount: number, st?: SwarmState): Row[] {
	const rows: Row[] = lanes.map((lane) => ({
		section: "LANES" as Section,
		id: lane.id,
		title: lane.id,
		summary: `${laneIcon(undefined, Boolean(lane.missing))} ${lane.id} ${lane.status} · ${lane.roleKind} · ${lane.health}${lane.nodeIds.length ? ` · node=${lane.nodeIds.join(",")}` : ""}${lane.activeTaskIds.length ? ` · active=${lane.activeTaskIds.join(",")}` : ""}`,
		detail: `Agent ${lane.id} — task lane\nStatus: ${lane.status}\nRuntime: ${lane.runtimeStatus}\nHealth: ${lane.health}\nRole kind: ${lane.roleKind}\nActive tasks: ${lane.activeTaskIds.join(", ") || "-"}\nTask nodes: ${lane.nodeIds.join(", ") || "-"}\n\nWhat this means: this agent owns the listed nodes in this task.\nHints: /swarm attach ${lane.id} · /swarm capture ${lane.id}`,
		hint: `/swarm attach ${lane.id}`,
		search: rowKey(`${lane.id} ${lane.status} ${lane.runtimeStatus} ${lane.health} ${lane.roleKind} ${lane.activeTaskIds.join(" ")} ${lane.nodeIds.join(" ")}`),
		severity: lane.status === "stopped" || lane.health === "unhealthy" ? "watch" : "info",
		agentId: lane.id,
	}));
	if (expandOthers && st) {
		// Expanded view: reveal the collapsed "other agents" lanes from live state.
		const shown = new Set(lanes.map((lane) => lane.id));
		const nodeIdsByAgent = new Map<string, string[]>();
		for (const [nodeId, node] of Object.entries(task.nodes)) {
			if (!node.assignee) continue;
			const arr = nodeIdsByAgent.get(node.assignee) || [];
			arr.push(nodeId);
			nodeIdsByAgent.set(node.assignee, arr);
		}
		for (const agent of Object.values(st.agents).sort((a, b) => a.id.localeCompare(b.id))) {
			if (shown.has(agent.id)) continue;
			rows.push({ section: "LANES", id: `other:${agent.id}`, title: agent.id, summary: `${laneIcon(agent)} ${agent.id} ${agent.status} · ${agent.roleKind} · ${agent.health}${agent.activeTaskIds.length ? ` · active=${agent.activeTaskIds.join(",")}` : ""}`, detail: `Agent ${agent.id} (not assigned to any node in this task)\nStatus: ${agent.status}\nRuntime: ${agent.runtimeStatus}\nHealth: ${agent.health}\nRole kind: ${agent.roleKind}\nActive tasks: ${agent.activeTaskIds.join(", ") || "-"}\n\nWhat this means: this agent is idle/unrelated to this task.\nHints: /swarm attach ${agent.id} · /swarm capture ${agent.id}`, hint: `/swarm attach ${agent.id}`, search: rowKey(`${agent.id} ${agent.status} ${agent.roleKind} ${agent.health}`), severity: agent.status === "stopped" || agent.health === "unhealthy" ? "watch" : "info", agentId: agent.id });
		}
	}
	if (!expandOthers && otherAgentsCount > 0) {
		rows.push({ section: "LANES", id: "lanes-collapsed", title: "other-agents", summary: `+ ${otherAgentsCount} other agents collapsed (j/Enter/o to expand)`, detail: `${otherAgentsCount} other agents are collapsed in this read-only snapshot.\n\nWhat this means: these agents are not assigned to any node in this task.\nPress j, Enter, or o to reveal them.`, hint: "o", search: rowKey(`collapsed other agents ${otherAgentsCount}`), severity: "info" });
	}
	return rows;
}

function collectEventRows(events: Array<{ text: string; raw: Record<string, any> }>): Row[] {
	return events.map((ev, i) => ({ section: "EVENTS", id: `event-${i}`, title: `event ${i + 1}`, summary: ev.text, detail: `${ev.text}\n\nRaw:\n${JSON.stringify(ev.raw, null, 2)}`, hint: "r", search: rowKey(`${ev.text} ${JSON.stringify(ev.raw)}`), severity: "info" }));
}

async function buildPickerEntries(p: Paths, cwd: string): Promise<PickerEntry[]> {
	const list = await listTaskSummaries(p);
	if (!list.length) return [];
	const st = await readState(p, cwd);
	const out: PickerEntry[] = [];
	for (const item of list) {
		const tp = taskPaths(p, item.taskId);
		if (!existsSync(tp.taskJson)) continue;
		try {
			const task = await readTaskState(tp.taskJson);
			const attention = buildAttentionItems(task, tp, st);
			const rank = attention.some((a) => a.severity === "act" && a.kind === "node") || Object.values(task.nodes).some((n) => n.status === "failed" || n.status === "blocked") ? 0 : Object.values(task.nodes).some((n) => n.staleAt) || attention.some((a) => a.kind !== "node" && a.severity !== "info") ? 1 : task.status === "in_progress" || Object.values(task.nodes).some((n) => n.status === "assigned" || n.status === "in_progress") ? 2 : task.status === "ready" || Object.values(task.nodes).some((n) => n.status === "ready") ? 3 : 4;
			out.push({ ...item, attentionCount: attention.length, priority: rank });
		} catch { out.push({ ...item, attentionCount: 0, priority: 4 }); }
	}
	return out.sort((a, b) => a.priority - b.priority || b.attentionCount - a.attentionCount || b.updatedAt.localeCompare(a.updatedAt) || a.taskId.localeCompare(b.taskId));
}

export async function collectFlowData(p: Paths, cwd: string, task: TaskState, tp: TaskPaths, st: SwarmState, eventLimit: number): Promise<FlowDialogData> {
	const { ready, current } = computeReadyNodes(task);
	const closure = computeTaskClosure(st, task, tp);
	const attention = buildAttentionItems(task, tp, st).sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
	const { lanes, otherAgentsCount } = buildLanes(task, st, attention, false);
	const events = await readRecentEvents(p, tp, eventLimit);
	const refreshedAt = now();
	const fresh = freshnessLabel(refreshedAt);
	return { refreshedAt, freshnessLabel: fresh.label, stale: fresh.stale, task, tp, st, open: closure.openNodes, staleCount: closure.staleNodes, ready, current, attention, lanes, otherAgentsCount, events, eventLimit, closure };
}

type MaybeSnap = FlowDialogData | null;

class PickerDialog implements Component {
	private selected = 0;
	private filter = "";
	private filterMode = false;
	private help = false;
	private tui: TUI;
	private theme: any;
	private entries: PickerEntry[];
	private done: (v: unknown) => void;
	constructor(tui: TUI, theme: any, entries: PickerEntry[], done: (v: unknown) => void) {
		this.tui = tui;
		this.theme = theme;
		this.entries = entries;
		this.done = done;
	}
	private fg(c: string, s: string): string { try { return this.theme.fg(c, s); } catch { return s; } }
	private bg(c: string, s: string): string { try { return this.theme.bg(c, s); } catch { return s; } }
	private row(inner: string): string { return this.fg("border", "│ ") + inner + this.fg("border", " │"); }
	private pad(s: string, w: number): string { const vw = visibleWidth(s); return vw > w ? truncateToWidth(s, Math.max(0, w)) : s + " ".repeat(Math.max(0, w - vw)); }
	private current(): PickerEntry[] { const f = this.filter.trim().toLowerCase(); return this.entries.filter((e) => !f || `${e.taskId} ${e.title} ${e.status}`.toLowerCase().includes(f)); }
	handleInput(data: string): void {
		if (this.help) { this.help = false; this.tui.requestRender(); return; }
		if (this.filterMode) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) { this.filterMode = false; this.tui.requestRender(); return; }
			if (matchesKey(data, Key.backspace)) { this.filter = this.filter.slice(0, -1); this.selected = 0; this.tui.requestRender(); return; }
			if (data.length === 1 && data.charCodeAt(0) >= 32) { this.filter += data; this.selected = 0; this.tui.requestRender(); return; }
			return;
		}
		const vis = this.current();
		if (matchesKey(data, Key.escape) || data === "q") { this.done(undefined); return; }
		if (data === "/") { this.filterMode = true; this.filter = ""; this.tui.requestRender(); return; }
		if (data === "?") { this.help = true; this.tui.requestRender(); return; }
		if (matchesKey(data, Key.up) || data === "k") { if (vis.length) this.selected = (this.selected - 1 + vis.length) % vis.length; this.tui.requestRender(); return; }
		if (matchesKey(data, Key.down) || data === "j") { if (vis.length) this.selected = (this.selected + 1) % vis.length; this.tui.requestRender(); return; }
		if (matchesKey(data, Key.enter)) { this.done(vis[this.selected]?.taskId); return; }
	}
	invalidate(): void { /* no-op */ }
	dispose(): void { /* no timers */ }
	render(width: number): string[] {
		const W = Math.max(40, width);
		if (this.help) return this.renderHelp(W);
		const innerW = W - 4;
		const out: string[] = [];
		const title = " swarm flow picker ";
		out.push(this.fg("border", "╭─") + this.fg("accent", title) + this.fg("border", "─".repeat(Math.max(1, W - 3 - visibleWidth(title))) + "╮"));
		const header = `${this.fg("dim", "choose a task")} ${this.filter ? this.fg("accent", `· /${this.filter}${this.filterMode ? "▏" : ""}`) : ""}`;
		out.push(this.row(this.pad(header, innerW)));
		const vis = this.current();
		if (!vis.length) out.push(this.row(this.pad(this.fg("muted", this.filter ? `no tasks match "${this.filter}"` : "no tasks yet"), innerW)));
		else {
			// Sliding window so the focused entry is always visible.
			const limit = 12;
			const sel = Math.min(this.selected, vis.length - 1);
			let start = 0;
			if (sel >= limit) start = sel - limit + 1;
			if (start > 0) out.push(this.row(this.pad(this.fg("muted", `  ↑ +${start} earlier`), innerW)));
			for (let i = start; i < Math.min(vis.length, start + limit); i++) {
				const entry = vis[i];
				const badge = entry.attentionCount > 0 ? this.fg(entry.priority === 0 ? "error" : "warning", ` !${entry.attentionCount}`) : "";
				const line = `${String(entry.index).padStart(2)}  ${entry.taskId.padEnd(38)} ${entry.status.padEnd(11)} ${humanAge(entry.updatedAt).padStart(4)}${badge ? `  ${badge}` : ""}${entry.title ? `  ${truncateToWidth(entry.title, 40)}` : ""}`;
				const content = i === this.selected ? this.bg("selectedBg", this.pad(line, innerW)) : this.pad(line, innerW);
				out.push(this.row(content));
			}
			if (start + limit < vis.length) out.push(this.row(this.pad(this.fg("muted", `  ↓ +${vis.length - start - limit} more`), innerW)));
		}
		out.push(this.row(this.pad(this.fg("dim", "↑↓/jk nav · Enter open · / filter · Esc close"), innerW)));
		out.push(this.fg("border", "╰") + this.fg("border", "─".repeat(Math.max(0, W - 2)) + "╯"));
		return out;
	}
	private renderHelp(W: number): string[] {
		const innerW = W - 4;
		const out: string[] = [];
		out.push(this.fg("border", "╭─") + this.fg("accent", " flow picker help ") + this.fg("border", "─".repeat(Math.max(1, W - 3 - visibleWidth(" flow picker help "))) + "╮"));
		for (const [k, v] of [["navigate", "↑↓ or j / k"], ["open", "Enter"], ["filter", "/"], ["close", "Esc or q"], ["help", "?"]] as Array<[string, string]>) out.push(this.row(this.pad(`${this.fg("accent", k)} · ${this.fg("dim", v)}`, innerW)));
		out.push(this.fg("border", "╰") + this.fg("border", "─".repeat(Math.max(0, W - 2)) + "╯"));
		return out;
	}
}

export class FlowDialog implements Component {
	private data: FlowDialogData | null = null;
	private selected = 0;
	private expandLanes = false;
	private filter = "";
	private filterMode = false;
	private help = false;
	private detail: Row | null = null;
	private nextIndex = 0;
	private nextText = "";
	private debugRaw = false;
	private focusPane: "graph" | "detail" = "graph";
	private graphModel: GraphTreeModel = { entries: [], firstIndexByNodeId: new Map() };
	private graphSelected = 0;
	private graphScroll = 0;
	private messageViewNodeId: string | null = null;
	private nodeMsgCache: Map<string, NodeMessage[]> = new Map();
	private messageScroll = 0;
	private messageViewScroll = 0;
	private fullBodyMessageId: string | null = null;
	private cachedMessages: NodeMessage[] = [];
	private cachedMessagesNodeId: string | null = null;
	private tui: TUI;
	private theme: any;
	private opts: { p: Paths; cwd: string; task: TaskState; tp: TaskPaths; st: SwarmState; eventLimit: number };
	private done: (v: unknown) => void;
	constructor(tui: TUI, theme: any, opts: { p: Paths; cwd: string; task: TaskState; tp: TaskPaths; st: SwarmState; eventLimit: number }, done: (v: unknown) => void) {
		this.tui = tui;
		this.theme = theme;
		this.opts = opts;
		this.done = done;
		void this.refresh();
	}
	private fg(c: string, s: string): string { try { return this.theme.fg(c, s); } catch { return s; } }
	private bg(c: string, s: string): string { try { return this.theme.bg(c, s); } catch { return s; } }
	private pad(s: string, w: number): string { const vw = visibleWidth(s); return vw > w ? truncateToWidth(s, Math.max(0, w)) : s + " ".repeat(Math.max(0, w - vw)); }
	// Horizontal scroll: shift content left by hOffset visible columns, then pad to width.
	private hOffset = 0;
	private hMax = 0;
	private hScroll(s: string, w: number): string {
		if (this.hOffset > 0) s = truncateLeft(s, this.hOffset);
		const vw = visibleWidth(s);
		if (vw > w) s = truncateToWidth(s, w);
		return this.pad(s, w);
	}
	private async refresh() {
		try {
			const st = await readState(this.opts.p, this.opts.cwd);
			const task = await readTaskState(this.opts.tp.taskJson);
			this.opts.st = st;
			this.opts.task = task;
			this.data = await collectFlowData(this.opts.p, this.opts.cwd, task, this.opts.tp, st, this.opts.eventLimit || DEFAULT_EVENT_LIMIT);
			this.graphModel = buildGraphTree(task);
			this.nodeMsgCache = new Map();
			for (const nid of Object.keys(task.nodes)) this.nodeMsgCache.set(nid, await collectNodeMessages(this.opts.p, task, st, nid));
			const currentIds = deriveCurrentNodeIds(task);
			const preferred = currentIds.map((id) => this.graphModel.firstIndexByNodeId.get(id)).find((v) => typeof v === "number") ?? 0;
			this.graphSelected = Math.max(0, Math.min(preferred, Math.max(0, this.graphModel.entries.length - 1)));
			this.selected = Math.min(this.selected, Math.max(0, this.rows().length - 1));
			this.tui.requestRender();
		} catch {
			this.tui.requestRender();
		}
	}
	private rows(): Row[] {
		if (!this.data) return [];
		const rows: Row[] = [
			...collectAttentionRows(this.data.attention),
			...collectNodeRows(this.data.task, this.data.st),
			...collectLaneRows(this.data.task, this.data.lanes, this.expandLanes, this.data.otherAgentsCount, this.data.st),
			...collectEventRows(this.data.events),
		];
		const f = this.filter.trim().toLowerCase();
		return f ? rows.filter((r) => r.search.includes(f)) : rows;
	}
	private jumpSection(dir: 1 | -1): void {
		const rows = this.rows();
		if (!rows.length) return;
		const sections: Section[] = ["ATTENTION", "FLOW", "LANES", "EVENTS"];
		const present = sections.filter((s) => rows.some((r) => r.section === s));
		if (present.length < 2) { this.selected = 0; return; }
		const cur = rows[this.selected];
		const curIdx = cur ? present.indexOf(cur.section) : 0;
		const next = present[(curIdx + dir + present.length) % present.length];
		const first = rows.findIndex((r) => r.section === next);
		this.selected = first >= 0 ? first : this.selected;
	}
	private selectedRow(): Row | undefined { const rows = this.rows(); return rows[Math.min(this.selected, Math.max(0, rows.length - 1))]; }
	handleInput(data: string): void { if (!this.debugRaw) { this.handleInputV3(data); return; } this.handleLegacyInput(data); }
	private handleLegacyInput(data: string): void {
		if (this.help) { this.help = false; this.tui.requestRender(); return; }
		if (this.detail) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.backspace) || data === "q") { this.detail = null; this.tui.requestRender(); }
			return;
		}
		if (this.filterMode) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) { this.filterMode = false; this.selected = 0; this.tui.requestRender(); return; }
			if (matchesKey(data, Key.backspace)) { this.filter = this.filter.slice(0, -1); this.selected = 0; this.tui.requestRender(); return; }
			if (data.length === 1 && data.charCodeAt(0) >= 32) { this.filter += data; this.selected = 0; this.tui.requestRender(); return; }
			return;
		}
		const rows = this.rows();
		if (matchesKey(data, Key.escape) || data === "q") { this.done(undefined); return; }
		if (matchesKey(data, Key.tab) || matchesKey(data, "shift+tab")) { this.jumpSection(matchesKey(data, "shift+tab") ? -1 : 1); this.tui.requestRender(); return; }
		if (matchesKey(data, Key.up) || data === "k") { if (rows.length) this.selected = (this.selected - 1 + rows.length) % rows.length; this.tui.requestRender(); return; }
		if (matchesKey(data, Key.left) || data === "h") { if (this.hOffset > 0) { this.hOffset = Math.max(0, this.hOffset - 10); this.tui.requestRender(); } return; }
		if (matchesKey(data, Key.right) || data === "l") { this.hOffset += 10; this.tui.requestRender(); return; }
		if (matchesKey(data, Key.down) || data === "j") {
			// Auto-expand collapsed other-agents when navigating into them, so j/k can walk every agent.
			const cur = rows[this.selected];
			if (cur && cur.id === "lanes-collapsed" && !this.expandLanes) {
				this.expandLanes = true;
				const next = this.rows().findIndex((r) => r.section === "LANES" && r.id.startsWith("other:"));
				if (next >= 0) this.selected = next;
				this.tui.requestRender(); return;
			}
			if (rows.length) this.selected = (this.selected + 1) % rows.length; this.tui.requestRender(); return;
		}
		if (matchesKey(data, Key.enter)) {
			const cur = rows[this.selected];
			if (cur && cur.id === "lanes-collapsed" && !this.expandLanes) { this.expandLanes = true; const next = this.rows().findIndex((r) => r.section === "LANES" && r.id.startsWith("other:")); if (next >= 0) this.selected = next; this.tui.requestRender(); return; }
			this.detail = cur || null; this.tui.requestRender(); return;
		}
		if (data === "r") { void this.refresh(); return; }
		if (data === "/") { this.filterMode = true; this.filter = ""; this.tui.requestRender(); return; }
		if (data === "o") { this.expandLanes = !this.expandLanes; this.selected = 0; this.tui.requestRender(); return; }
		if (data === "n") { if (this.data?.events.length) { this.nextIndex = (this.nextIndex + 1) % this.data.events.length; this.nextText = this.data.events[this.nextIndex].text; } this.tui.requestRender(); return; }
		if (data === "d") { this.debugRaw = !this.debugRaw; this.tui.requestRender(); return; }
		if (data === "?") { this.help = true; this.tui.requestRender(); return; }
	}
	private selectedGraphEntry(): GraphTreeEntry | undefined { return this.graphModel.entries[this.graphSelected]; }
	private clampGraphSelection(indices: number[]): void {
		if (!indices.length) { this.graphSelected = 0; return; }
		if (!indices.includes(this.graphSelected)) this.graphSelected = indices[0];
	}
	private moveGraph(delta: 1 | -1): void {
		const vis = this.graphModel.entries.map((entry) => entry.index);
		this.clampGraphSelection(vis);
		if (!vis.length) return;
		const pos = vis.indexOf(this.graphSelected);
		const next = vis[(pos + delta + vis.length) % vis.length];
		if (typeof next === "number") this.graphSelected = next;
	}
	private branchGraph(delta: 1 | -1): void {
		const entry = this.selectedGraphEntry();
		if (!entry) return;
		let cur = entry;
		while (cur.parentIndex != null) {
			const parent = this.graphModel.entries[cur.parentIndex];
			if (parent && parent.children.length > 1) {
				const sibs = parent.children;
				const pos = sibs.indexOf(cur.index);
				const next = sibs[(pos + delta + sibs.length) % sibs.length];
				if (typeof next === "number") this.graphSelected = next;
				return;
			}
			cur = parent;
		}
	}
	private handleInputV3(data: string): void {
		// Esc stack behavior: pop one level at a time (3 tiers: full-body → message-list → graph)
		if (data === "\x1b" || data === "q") {
			if (this.fullBodyMessageId !== null) {
				// Pop full-body view (tier 3) back to message list
				this.fullBodyMessageId = null;
				this.messageViewScroll = 0;
				this.tui.requestRender();
				return;
			}
			if (this.messageViewNodeId !== null) {
				// Pop message list view (tier 2) back to graph
				this.messageViewNodeId = null;
				this.messageScroll = 0;
				this.tui.requestRender();
				return;
			}
			if (this.help) {
				// Pop help view
				this.help = false;
				this.tui.requestRender();
				return;
			}
			if (this.filterMode) {
				// Pop filter mode
				this.filterMode = false;
				this.tui.requestRender();
				return;
			}
			if (this.detail) {
				// Pop detail view
				this.detail = null;
				this.tui.requestRender();
				return;
			}
			// At graph level - close dialog
			this.done(undefined);
			return;
		}
		
		if (this.help) { return; } // Help mode only responds to Esc
		if (this.filterMode) {
			if (matchesKey(data, Key.backspace)) { this.filter = this.filter.slice(0, -1); this.tui.requestRender(); return; }
			if (data.length === 1 && data.charCodeAt(0) >= 32) { this.filter += data; this.tui.requestRender(); return; }
			return;
		}
		if (this.messageViewNodeId !== null) {
			// Message list view
			if (data === "j") {
				const nodeMessages = this.nodeMsgCache.get(this.messageViewNodeId) || [];
				if (nodeMessages.length > 0) {
					this.messageScroll = Math.min(this.messageScroll + 1, nodeMessages.length - 1);
				}
				this.tui.requestRender();
				return;
			}
			if (data === "k") {
				this.messageScroll = Math.max(0, this.messageScroll - 1);
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				// Enter on message opens full-body view (tier 3)
				const nodeMessages = this.nodeMsgCache.get(this.messageViewNodeId || "") || [];
				if (this.messageScroll >= 0 && this.messageScroll < nodeMessages.length) {
					this.fullBodyMessageId = nodeMessages[this.messageScroll].messageId;
					this.messageViewScroll = 0;
				}
				this.tui.requestRender();
				return;
			}
			if (data === "r") { void this.refresh(); return; }
			return;
		}
		
		if (this.fullBodyMessageId !== null) {
			// Full-body message view (tier 3)
			if (data === "j") { this.messageViewScroll += 1; this.tui.requestRender(); return; }
			if (data === "k") { this.messageViewScroll = Math.max(0, this.messageViewScroll - 1); this.tui.requestRender(); return; }
			if (data === "r") { void this.refresh(); return; }
			return;
		}
		
		if (data === "r") { void this.refresh(); return; }
		if (data === "d") { this.debugRaw = !this.debugRaw; this.tui.requestRender(); return; }
		if (data === "c") { const entry = this.selectedGraphEntry(); if (entry) { const cmd = `/swarm task ${this.opts.task.taskId}`; try { this.tui.requestRender(); } catch {} this.theme?.notify?.(`copy: ${cmd}`); } return; }
		if (data === "/") { this.filterMode = true; this.filter = ""; this.tui.requestRender(); return; }
		if (data === "?") { this.help = true; this.tui.requestRender(); return; }
		
		// Graph navigation (always active, not dependent on focusPane)
		if (matchesKey(data, Key.up)) { this.moveGraph(-1); this.tui.requestRender(); return; }
		if (matchesKey(data, Key.down)) { this.moveGraph(1); this.tui.requestRender(); return; }
		if (matchesKey(data, Key.tab)) { this.branchGraph(1); this.tui.requestRender(); return; }
		if (matchesKey(data, "shift+tab")) { this.branchGraph(-1); this.tui.requestRender(); return; }
		if (matchesKey(data, Key.left) || data === "h") { this.moveGraph(-1); this.tui.requestRender(); return; }
		if (matchesKey(data, Key.right) || data === "l") { this.moveGraph(1); this.tui.requestRender(); return; }
		if (data === "j") { this.moveGraph(1); this.tui.requestRender(); return; }
		if (data === "k") { this.moveGraph(-1); this.tui.requestRender(); return; }
		
		// Enter on node opens message view
		if (matchesKey(data, Key.enter)) {
			const entry = this.selectedGraphEntry();
			if (entry) {
				this.messageViewNodeId = entry.nodeId;
				this.messageScroll = 0;
				this.tui.requestRender();
			}
			return;
		}
	}
	invalidate(): void { /* state-driven */ }
	dispose(): void { /* manual refresh only */ }
	private renderHeader(W: number): string[] {
		const snap = this.data;
		const innerW = W - 4;
		if (!snap) return [this.fg("border", "╭" + "─".repeat(Math.max(0, W - 2)) + "╮"), this.fg("border", "│ ") + this.pad(this.fg("muted", "loading…"), innerW) + this.fg("border", " │"), this.fg("border", "╰" + "─".repeat(Math.max(0, W - 2)) + "╯")];
		const title = ` swarm flow · ${snap.task.taskId} · ${snap.task.status} · ${snap.freshnessLabel}${snap.stale ? " · stale" : ""} `;
		const ttl = title.length + 8 > W ? ` swarm flow · ${snap.task.taskId.slice(0, Math.max(8, W - 58))}… · ${snap.task.status} ` : title;
		const out: string[] = [];
		out.push(this.fg("border", "╭─") + this.fg("accent", ttl) + this.fg("border", "─".repeat(Math.max(1, W - 3 - visibleWidth(ttl))) + "╮"));
		out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", `open=${snap.open} stale=${snap.staleCount}`), innerW) + this.fg("border", " │"));
		if (this.filterMode || this.filter) out.push(this.fg("border", "│ ") + this.pad(this.fg("accent", `/ ${this.filter}${this.filterMode ? "▏" : ""}`), innerW) + this.fg("border", " │"));
		return out;
	}
	render(width: number): string[] { return this.debugRaw ? this.renderLegacy(width) : this.renderV3(width); }
	private renderV2(width: number): string[] {
		const W = Math.max(40, width);
		if (this.help) return this.renderHelp(W);
		if (this.detail) return this.renderDetail(W, this.detail);
		const snap = this.data;
		const innerW = W - 4;
		const out = this.renderHeader(W);
		if (!snap) return out;
		const currentIds = deriveCurrentNodeIds(snap.task);
		const story = buildStoryLine(snap.task, snap.closure, snap.ready, currentIds, snap.attention.length);
		out.push(this.fg("border", "│ ") + this.hScroll(this.fg("accent", story), innerW) + this.fg("border", " │"));
		out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", `refreshed ${clock(snap.refreshedAt)} · ${snap.freshnessLabel}`), innerW) + this.fg("border", " │"));
		out.push(this.fg("border", "│ ") + this.pad(this.fg("accent", "GRAPH"), innerW) + this.fg("border", " │"));
		const graphLines = renderGraphOverview(snap.task, currentIds, Math.max(24, innerW - 2));
		if (!graphLines.length) out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", "  (no nodes)"), innerW) + this.fg("border", " │"));
		for (const line of graphLines) { const full = `  ${line}`; this.hMax = Math.max(this.hMax, visibleWidth(full)); out.push(this.fg("border", "│ ") + this.hScroll(full, innerW) + this.fg("border", " │")); }
		for (const line of buildHandoffLines(snap.task, snap.st).slice(0, 4)) out.push(this.fg("border", "│ ") + this.hScroll(this.fg("dim", `  ${line.text}`), innerW) + this.fg("border", " │"));
		if (currentIds.length) {
			const current = currentIds.map((id) => {
				const node = snap.task.nodes[id];
				const owner = node?.assignee || node?.role || "unowned";
				return `${id} · ${owner} · ${node ? nodeAge(node) : "-"}`;
			}).join(" | ");
			out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", `current: ${currentIds.length > 1 ? "parallel current · " : ""}${current}`), innerW) + this.fg("border", " │"));
		}
		const rows = this.rows();
		const attRows = collectAttentionRows(snap.attention).sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
		out.push(this.fg("border", "│ ") + this.pad(this.fg("accent", "ATTENTION"), innerW) + this.fg("border", " │"));
		if (!attRows.length) out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", "  (none)"), innerW) + this.fg("border", " │"));
		// Sliding window + selected highlight for attention rows (V2).
		{
			const rowsAll = rows;
			const limit = 4;
			const selIdxInSec = attRows.findIndex((r) => rowsAll[this.selected] && r.id === rowsAll[this.selected].id && r.section === rowsAll[this.selected].section);
			let start = 0;
			if (selIdxInSec >= limit) start = selIdxInSec - limit + 1;
			if (start > 0) out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", `  ↑ +${start} earlier in attention`), innerW) + this.fg("border", " │"));
			for (const row of attRows.slice(start, start + limit)) {
				const selected = rowsAll[this.selected] && rowsAll[this.selected].id === row.id && rowsAll[this.selected].section === row.section;
				const body = this.fg(row.severity === "act" ? "error" : row.severity === "watch" ? "warning" : "muted", `  ${row.summary}`);
				out.push(this.fg("border", "│ ") + (selected ? this.bg("selectedBg", this.pad(body, innerW)) : this.pad(body, innerW)) + this.fg("border", " │"));
			}
			if (start + limit < attRows.length) out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", `  ↓ +${attRows.length - start - limit} more in attention`), innerW) + this.fg("border", " │"));
		}
		for (const section of ["FLOW", "LANES"] as Section[]) {
			out.push(this.fg("border", "│ ") + this.pad(this.fg("accent", section), innerW) + this.fg("border", " │"));
			const secRows = rows.filter((r) => r.section === section);
			if (!secRows.length) { out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", "  (none)"), innerW) + this.fg("border", " │")); continue; }
			const limit = section === "LANES" ? 6 : 5;
			// Sliding window + selected highlight so j/k focus is always visible (V2).
			const selIdxInSec = secRows.findIndex((r) => rows[this.selected] && r.id === rows[this.selected].id && r.section === rows[this.selected].section);
			let start = 0;
			if (selIdxInSec >= limit) start = selIdxInSec - limit + 1;
			if (start > 0) out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", `  ↑ +${start} earlier in ${section.toLowerCase()}`), innerW) + this.fg("border", " │"));
			for (const row of secRows.slice(start, start + limit)) {
				const idx = rows.findIndex((r) => r.section === row.section && r.id === row.id);
				const icon = row.section === "FLOW" ? statusIcon(row.title) : laneIcon(undefined, row.id === "lanes-collapsed");
				const label = `${String(idx + 1).padStart(2)} ${icon} ${row.summary}`;
				const selected = rows[this.selected] && rows[this.selected].id === row.id && rows[this.selected].section === row.section;
				out.push(this.fg("border", "│ ") + (selected ? this.bg("selectedBg", this.pad(`  ${label}`, innerW)) : this.pad(`  ${label}`, innerW)) + this.fg("border", " │"));
			}
			if (start + limit < secRows.length) out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", `  ↓ +${secRows.length - start - limit} more in ${section.toLowerCase()}`), innerW) + this.fg("border", " │"));
			if (section === "LANES" && !this.expandLanes && snap.otherAgentsCount > 0) out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", `  + ${snap.otherAgentsCount} other agents collapsed (press o to expand)`), innerW) + this.fg("border", " │"));
		}
		{
			out.push(this.fg("border", "│ ") + this.pad(this.fg("accent", "EVENTS"), innerW) + this.fg("border", " │"));
			const groups = groupFlowEvents(snap.events);
			if (!groups.length) out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", "  (none)"), innerW) + this.fg("border", " │"));
			// Flat event rows with sliding window + highlight so j/k can scroll every event.
			const evRows = rows.filter((r) => r.section === "EVENTS");
			const limit = 6;
			const selIdxInSec = evRows.findIndex((r) => rows[this.selected] && r.id === rows[this.selected].id && r.section === rows[this.selected].section);
			let start = 0;
			if (selIdxInSec >= limit) start = selIdxInSec - limit + 1;
			if (start > 0) out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", `  ↑ +${start} earlier in events`), innerW) + this.fg("border", " │"));
			const groupTitleById = new Map<string, string>();
			for (const group of groups) {
				for (const item of group.items) {
					const match = evRows.find((r) => r.summary === item.text);
					if (match) groupTitleById.set(match.id, group.title);
				}
			}
			for (const row of evRows.slice(start, start + limit)) {
				const idx = rows.findIndex((r) => r.section === row.section && r.id === row.id);
				const groupTitle = groupTitleById.get(row.id);
				const prefix = groupTitle && groupTitleById.get(evRows[start]?.id || "") !== groupTitle ? this.fg("dim", `  ${groupTitle}: `) : this.fg("dim", "  ");
				const label = `${prefix}${String(idx + 1).padStart(2)} ${row.summary}`;
				const selected = rows[this.selected] && rows[this.selected].id === row.id && rows[this.selected].section === row.section;
				out.push(this.fg("border", "│ ") + (selected ? this.bg("selectedBg", this.pad(label, innerW)) : this.pad(label, innerW)) + this.fg("border", " │"));
			}
			if (start + limit < evRows.length) out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", `  ↓ +${evRows.length - start - limit} more in events`), innerW) + this.fg("border", " │"));
		}
		if (this.nextText) out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", `NEXT: ${this.nextText}`), innerW) + this.fg("border", " │"));
		const hInfo = this.hOffset > 0 ? `◀${this.hOffset} ` : "";
		out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", `${hInfo}↑↓jk nav · ←→hl scroll · Tab section · Enter detail · / filter · o lanes · d raw · r refresh · ? help · Esc`), innerW) + this.fg("border", " │"));
		out.push(this.fg("border", "╰" + "─".repeat(Math.max(0, W - 2)) + "╯"));
		return out;
	}
	private renderV3(width: number): string[] {
		const W = Math.max(40, width);
		if (this.help) return this.renderHelp(W);
		const snap = this.data;
		const out = this.renderHeader(W);
		const innerW = W - 4;
		if (!snap) return out;
		
		// Full-body message view (tier 3) takes precedence over the message list
		if (this.fullBodyMessageId !== null && this.messageViewNodeId !== null) {
			const nodeMessages = this.nodeMsgCache.get(this.messageViewNodeId) || [];
			const msg = nodeMessages.find((m) => m.messageId === this.fullBodyMessageId);
			if (msg) {
				const header = `Message · ${msg.from} → ${msg.to}`;
				out.push(this.fg("border", "╭─") + this.fg("accent", header) + this.fg("border", "─".repeat(Math.max(1, W - 3 - visibleWidth(header))) + "╮"));
				const subject = msg.subject || "(no subject)";
				out.push(this.fg("border", "│ ") + this.pad(this.fg("accent", subject), innerW) + this.fg("border", " │"));
				out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", "─".repeat(Math.max(0, innerW - 2))), innerW) + this.fg("border", " │"));
				const bodyLines = msg.body ? wrapTextWithAnsi(msg.body.replace(/\r/g, ""), Math.max(20, innerW - 4)) : ["(empty body)"];
				const limit = 14;
				let bodyStart = Math.max(0, Math.min(this.messageViewScroll, Math.max(0, bodyLines.length - limit)));
				if (bodyStart > 0) out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", `  ↑ +${bodyStart} earlier`), innerW) + this.fg("border", " │"));
				for (let i = bodyStart; i < Math.min(bodyLines.length, bodyStart + limit); i++) out.push(this.fg("border", "│ ") + this.pad(bodyLines[i], innerW) + this.fg("border", " │"));
				if (bodyStart + limit < bodyLines.length) out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", `  ↓ +${bodyLines.length - bodyStart - limit} more`), innerW) + this.fg("border", " │"));
				out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", "j/k scroll · Esc back to message list"), innerW) + this.fg("border", " │"));
				out.push(this.fg("border", "╰" + "─".repeat(Math.max(0, W - 2)) + "╯"));
				return out;
			}
		}
		// Message view overlay
		if (this.messageViewNodeId !== null) {
			const nodeMessages = this.nodeMsgCache.get(this.messageViewNodeId) || [];
			const header = `Messages · ${this.messageViewNodeId} · ${nodeMessages.length} msgs`;
			out.push(this.fg("border", "╭─") + this.fg("accent", header) + this.fg("border", "─".repeat(Math.max(1, W - 3 - visibleWidth(header))) + "╮"));
			if (nodeMessages.length === 0) {
				out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", "no messages for this node"), innerW) + this.fg("border", " │"));
			} else {
				const limit = 8;
				let start = Math.max(0, Math.min(this.messageScroll, nodeMessages.length - limit));
				if (start > 0) out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", `  ↑ +${start} earlier`), innerW) + this.fg("border", " │"));
				for (let i = start; i < Math.min(nodeMessages.length, start + limit); i++) {
					const msg = nodeMessages[i];
					const subject = truncateToWidth(msg.subject || "(no subject)", Math.max(20, innerW - 50));
					const bodyPreview = msg.body ? truncateToWidth(msg.body.split("\n")[0], 30) : "";
					const line = `${msg.from} → ${msg.to} · ${subject} · ${msg.lifecycle} · ${bodyPreview}`;
					const isFocused = i === this.messageScroll;
					const rendered = isFocused ? this.bg("selectedBg", this.pad(line, innerW)) : this.pad(line, innerW);
					out.push(this.fg("border", "│ ") + rendered + this.fg("border", " │"));
				}
				if (start + limit < nodeMessages.length) {
					out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", `  ↓ +${nodeMessages.length - start - limit} more`), innerW) + this.fg("border", " │"));
				}
			}
			out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", "j/k scroll · Enter msg body · Esc back to graph"), innerW) + this.fg("border", " │"));
			out.push(this.fg("border", "╰" + "─".repeat(Math.max(0, W - 2)) + "╯"));
			return out;
		}
		
		// Full-body message view (tier 3)
		if (this.fullBodyMessageId !== null) {
			const nodeMessages = this.nodeMsgCache.get(this.messageViewNodeId || "") || [];
			const msg = nodeMessages.find((m) => m.messageId === this.fullBodyMessageId);
			const header = `Message · ${msg?.from || "?"} → ${msg?.to || "?"}`;
			out.push(this.fg("border", "╭─") + this.fg("accent", header) + this.fg("border", "─".repeat(Math.max(1, W - 3 - visibleWidth(header))) + "╮"));
			if (msg) {
				const subject = msg.subject || "(no subject)";
				out.push(this.fg("border", "│ ") + this.pad(this.fg("accent", subject), innerW) + this.fg("border", " │"));
				out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", "─".repeat(Math.max(0, innerW - 2))), innerW) + this.fg("border", " │"));
				const bodyLines = msg.body ? wrapTextWithAnsi(msg.body, innerW - 4) : ["(empty body)"];
				let bodyStart = Math.max(0, Math.min(this.messageViewScroll, bodyLines.length - 10));
				if (bodyStart > 0) out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", `  ↑ +${bodyStart} earlier`), innerW) + this.fg("border", " │"));
				for (let i = bodyStart; i < Math.min(bodyLines.length, bodyStart + 10); i++) {
					out.push(this.fg("border", "│ ") + this.pad(bodyLines[i], innerW) + this.fg("border", " │"));
				}
				if (bodyStart + 10 < bodyLines.length) {
					out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", `  ↓ +${bodyLines.length - bodyStart - 10} more`), innerW) + this.fg("border", " │"));
				}
			} else {
				out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", "message not found"), innerW) + this.fg("border", " │"));
			}
			out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", "j/k scroll · Esc back to message list"), innerW) + this.fg("border", " │"));
			out.push(this.fg("border", "╰" + "─".repeat(Math.max(0, W - 2)) + "╯"));
			return out;
		}
		
		// Normal graph + detail view
		const model = this.graphModel.entries.length ? this.graphModel : buildGraphTree(snap.task);
		const currentIds = new Set(deriveCurrentNodeIds(snap.task));
		const attentionIds = new Set(snap.attention.map((item) => item.nodeId).filter(Boolean) as string[]);
		const visibleEntries = model.entries;
		this.clampGraphSelection(visibleEntries.map((entry) => entry.index));
		const story = buildStoryLine(snap.task, snap.closure, snap.ready, [...currentIds], snap.attention.length);
		out.push(this.fg("border", "│ ") + this.hScroll(this.fg("accent", story), innerW) + this.fg("border", " │"));
		out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", `refreshed ${clock(snap.refreshedAt)} · ${snap.freshnessLabel}`), innerW) + this.fg("border", " │"));
		out.push(this.fg("border", "│ ") + this.pad(this.fg("accent", "GRAPH"), innerW) + this.fg("border", " │"));
		for (const entry of visibleEntries) {
			const selected = entry.index === this.graphSelected;
			const line = nodeDisplayLabel(snap.task, entry, currentIds, attentionIds, selected);
			const rendered = selected ? this.bg("selectedBg", this.pad(line, innerW)) : this.pad(line, innerW);
			out.push(this.fg("border", "│ ") + rendered + this.fg("border", " │"));
		}
		out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", "──────── detail ────────"), innerW) + this.fg("border", " │"));
		const selectedEntry = this.selectedGraphEntry() || model.entries[0];
		const detailLines = selectedEntry ? buildNodeDetail(snap.task, snap.st, selectedEntry, snap.attention) : ["no node selected"];
		for (const line of detailLines) {
			for (const ln of wrapTextWithAnsi(line, Math.max(20, innerW))) out.push(this.fg("border", "│ ") + this.pad(ln, innerW) + this.fg("border", " │"));
		}
		out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", "j/k navigate · Enter messages · ? help · d raw · r refresh · Esc close"), innerW) + this.fg("border", " │"));
		out.push(this.fg("border", "╰" + "─".repeat(Math.max(0, W - 2)) + "╯"));
		return out;
	}
	private renderLegacy(width: number): string[] {
		const W = Math.max(40, width);
		if (this.help) return this.renderHelp(W);
		if (this.detail) return this.renderDetail(W, this.detail);
		const snap = this.data;
		const innerW = W - 4;
		const out = this.renderHeader(W);
		if (!snap) return out;
		const rows = this.rows();
		for (const section of ["ATTENTION", "FLOW", "LANES", "EVENTS"] as Section[]) {

			out.push(this.fg("border", "│ ") + this.pad(this.fg("accent", section), innerW) + this.fg("border", " │"));
			const secRows = rows.filter((r) => r.section === section);
			if (!secRows.length) { out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", "  (none)"), innerW) + this.fg("border", " │")); continue; }
			const limit = section === "EVENTS" ? 6 : 10;
			// Sliding window: keep the selected row of this section visible so j/k focus never disappears.
			const selIdxInSec = secRows.findIndex((r) => rows[this.selected] && r.id === rows[this.selected].id && r.section === rows[this.selected].section);
			let start = 0;
			if (selIdxInSec >= limit) start = selIdxInSec - limit + 1;
			if (start > 0) out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", `  ↑ +${start} earlier in ${section.toLowerCase()}`), innerW) + this.fg("border", " │"));
			for (const row of secRows.slice(start, start + limit)) {
				const idx = rows.findIndex((r) => r.section === row.section && r.id === row.id);
			const icon = row.section === "ATTENTION" ? (row.severity === "act" ? "!" : row.severity === "watch" ? "⚠" : "·") : row.section === "FLOW" ? statusIcon(row.title) : row.section === "LANES" ? laneIcon(undefined, row.id === "lanes-collapsed") : "·";
				const label = `${String(idx + 1).padStart(2)} ${icon} ${row.summary}`;
				const selected = rows[this.selected] && rows[this.selected].id === row.id && rows[this.selected].section === row.section;
				out.push(this.fg("border", "│ ") + (selected ? this.bg("selectedBg", this.pad(label, innerW)) : this.pad(label, innerW)) + this.fg("border", " │"));
			}
			if (start + limit < secRows.length) out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", `  ↓ +${secRows.length - start - limit} more in ${section.toLowerCase()}`), innerW) + this.fg("border", " │"));
			if (section === "FLOW") out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", `Ready: ${snap.ready.join(", ") || "(none)"} · Current: ${snap.current.join(", ") || "(none)"}`), innerW) + this.fg("border", " │"));
			if (section === "LANES" && !this.expandLanes && snap.otherAgentsCount > 0) out.push(this.fg("border", "│ ") + this.pad(this.fg("muted", `+ ${snap.otherAgentsCount} other agents collapsed (press o to expand)`), innerW) + this.fg("border", " │"));
		}
		if (this.nextText) out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", `NEXT: ${this.nextText}`), innerW) + this.fg("border", " │"));
		out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", "↑↓/jk nav · Tab section · Enter detail · a attention-only · / filter · o expand lanes · r refresh · n next-hint · ? help · Esc close"), innerW) + this.fg("border", " │"));
		out.push(this.fg("border", "╰" + "─".repeat(Math.max(0, W - 2)) + "╯"));
		return out;
	}
	private renderHelp(W: number): string[] {
		const innerW = W - 4;
		const out: string[] = [];
		out.push(this.fg("border", "╭─") + this.fg("accent", " swarm flow help ") + this.fg("border", "─".repeat(Math.max(1, W - 3 - visibleWidth(" swarm flow help "))) + "╮"));
		for (const [k, v] of [["navigate", "↑↓ or j / k"], ["next section", "Tab / Shift-Tab"], ["detail", "Enter"], ["attention only", "a"], ["expand lanes", "o"], ["next hint", "n"], ["refresh", "r"], ["filter", "/"], ["close", "Esc or q"]] as Array<[string, string]>) out.push(this.fg("border", "│ ") + this.pad(`${this.fg("accent", k)} · ${this.fg("dim", v)}`, innerW) + this.fg("border", " │"));
		out.push(this.fg("border", "╰" + "─".repeat(Math.max(0, W - 2)) + "╯"));
		return out;
	}
	private renderDetail(W: number, item: Row): string[] {
		const innerW = W - 4;
		const out: string[] = [];
		const title = ` ${item.section.toLowerCase()} · ${item.title} `;
		out.push(this.fg("border", "╭─") + this.fg("accent", title) + this.fg("border", "─".repeat(Math.max(1, W - 3 - visibleWidth(title))) + "╮"));
		for (const ln of wrapTextWithAnsi(item.detail, Math.max(20, innerW))) out.push(this.fg("border", "│ ") + this.pad(truncateToWidth(ln, innerW), innerW) + this.fg("border", " │"));
		out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", `Hint: ${item.hint}`), innerW) + this.fg("border", " │"));
		out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", `Task: /swarm task ${this.data?.task.taskId || "?"} runtime`), innerW) + this.fg("border", " │"));
		out.push(this.fg("border", "│ ") + this.pad(this.fg("dim", "Esc back · r refresh · ? help"), innerW) + this.fg("border", " │"));
		out.push(this.fg("border", "╰" + "─".repeat(Math.max(0, W - 2)) + "╯"));
		return out;
	}
}

// TUI picker returning the selected task (does NOT open the dialog). Returns undefined when the
// user cancels, there are no tasks, or ctx is not an interactive TUI.
export async function pickFlowTask(ctx: any, cwd: string, p: Paths): Promise<{ task: TaskState; tp: TaskPaths } | undefined> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		try { ctx.ui.notify("/swarm flow requires interactive (TUI) mode for the picker; falling back to text task listing.", "info"); } catch {}
		return undefined;
	}
	try {
		const entries = await buildPickerEntries(p, cwd);
		if (!entries.length) {
			try { ctx.ui.notify("No tasks found — create one with swarm_create_task or /swarm graph.", "info"); } catch {}
			return undefined;
		}
		const picked = await new Promise<string | undefined>((resolve) => {
			void ctx.ui.custom(
				(tui: TUI, theme: any, _kb: any, done: (v: unknown) => void) => new PickerDialog(tui, theme, entries, (v) => { done(v); resolve(typeof v === "string" ? v : undefined); }),
				{ overlay: true, overlayOptions: PICKER_OVERLAY_OPTIONS as any },
			).catch((err: any) => {
				try { ctx.ui.notify(`/swarm flow picker failed: ${String((err && err.message) || err)}`, "warning"); } catch {}
				resolve(undefined);
			});
		});
		if (!picked) return undefined;
		const resolved = await resolveTaskRefLocal(p, picked);
		return resolved.hit ? { task: resolved.hit.task, tp: resolved.hit.tp } : undefined;
	} catch (err: any) {
		try { ctx.ui.notify(`/swarm flow picker failed: ${String((err && err.message) || err)}`, "warning"); } catch {}
		return undefined;
	}
}

export async function openFlowPicker(ctx: any, cwd: string, p: Paths): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		try { ctx.ui.notify("/swarm flow requires interactive (TUI) mode for the picker; falling back to text task listing.", "info"); } catch {}
		return;
	}
	try {
		const entries = await buildPickerEntries(p, cwd);
		const picked = await new Promise<string | undefined>((resolve) => {
			void ctx.ui.custom(
				(tui: TUI, theme: any, _kb: any, done: (v: unknown) => void) => new PickerDialog(tui, theme, entries, (v) => { done(v); resolve(typeof v === "string" ? v : undefined); }),
				{ overlay: true, overlayOptions: PICKER_OVERLAY_OPTIONS as any },
			).catch((err: any) => {
				try { ctx.ui.notify(`/swarm flow picker failed: ${String((err && err.message) || err)}`, "warning"); } catch {}
				resolve(undefined);
			});
		});
		if (picked) {
			const resolved = await resolveTaskRefLocal(p, picked);
			if (resolved.hit) await openFlowDialog(ctx, cwd, p, resolved.hit.task, resolved.hit.tp, {});
		}
	} catch (err: any) {
		try { ctx.ui.notify(`/swarm flow picker failed: ${String((err && err.message) || err)}`, "warning"); } catch {}
	}
}

export async function openFlowDialog(ctx: any, cwd: string, p: Paths, task: TaskState, tp: TaskPaths, opts: FlowDialogOpts = {}): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		try { ctx.ui.notify("/swarm flow: dialog requires interactive (TUI) mode", "info"); } catch {}
		return;
	}
	try {
		const st = await readState(p, cwd);
		await ctx.ui.custom(
			(tui: TUI, theme: any, _kb: any, done: (v: unknown) => void) => new FlowDialog(tui, theme, { p, cwd, task, tp, st, eventLimit: opts.eventLimit || DEFAULT_EVENT_LIMIT }, done),
			{ overlay: true, overlayOptions: FLOW_OVERLAY_OPTIONS as any },
		);
	} catch (err: any) {
		try { ctx.ui.notify(`/swarm flow dialog failed: ${String((err && err.message) || err)}`, "warning"); } catch {}
	}
}
