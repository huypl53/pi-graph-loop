import { visibleWidth } from "@earendil-works/pi-tui";
import type { computeTaskClosure } from "../taskgraph.ts";
import type { SwarmAgent, TaskState } from "../types.ts";
import { humanAge } from "../utils.ts";
import { collectGraphPaths, outgoingEdgeCount } from "./tree.ts";
import type { FlowEventGroup, GraphTreeEntry, Severity } from "./types.ts";
import { FRESHNESS_MS } from "./types.ts";

/**
 * Red Team Finding 4: Strip ANSI escape codes, OSC sequences, and unsafe terminal control characters
 * to prevent terminal injection from untrusted message bodies, task descriptions, or agent outputs.
 */
export function sanitizeUntrustedText(text: string | undefined | null): string {
	if (!text) return "";
	return text
		// Strip OSC (Operating System Command) sequences: ESC ] ... (BEL or ST)
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
		// Strip CSI escape sequences: ESC [ ... [command byte]
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
		// Strip other ESC sequences (e.g., ESC N, ESC O, etc.)
		.replace(/\x1b[@-Z\\-_]/g, "")
		// Strip any remaining bare ESC or dangerous control characters except tab, newline, carriage return
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x1b]/g, "");
}

export function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

export function clock(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "??:??:??";
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function rowKey(v: string): string {
	return v.toLowerCase();
}

export function statusIcon(status: string): string {
	switch (status) {
		case "done":
			return "✓";
		case "in_progress":
		case "assigned":
			return "▶";
		case "ready":
			return "○";
		case "blocked":
		case "failed":
		case "skipped":
			return "✗";
		default:
			return "○";
	}
}

export function laneIcon(agent?: SwarmAgent, missing = false): string {
	if (missing) return "!";
	if (!agent) return "·";
	if (agent.runtimeStatus === "busy" || agent.runtimeStatus === "tool_running") return "●";
	if (agent.runtimeStatus === "idle" || agent.runtimeStatus === "starting") return "○";
	if (agent.status === "stopped" || agent.runtimeStatus === "stopped") return "✗";
	return "·";
}

export function freshnessLabel(refreshedAt: string): { label: string; stale: boolean } {
	const age = Date.now() - new Date(refreshedAt).getTime();
	if (!Number.isFinite(age)) return { label: `refreshed ${clock(refreshedAt)}`, stale: false };
	if (age > FRESHNESS_MS) return { label: `refreshed ${clock(refreshedAt)} · stale ${humanAge(refreshedAt)}`, stale: true };
	return { label: `refreshed ${clock(refreshedAt)} · fresh ${humanAge(refreshedAt)}`, stale: false };
}

export function severityRank(s: Severity): number {
	return s === "act" ? 0 : s === "watch" ? 1 : 2;
}

export function isDeadRuntime(agent?: SwarmAgent): boolean {
	if (!agent) return true;
	return (
		agent.status === "stopped" ||
		agent.health === "unhealthy" ||
		agent.runtimeStatus === "stopped" ||
		agent.runtimeStatus === "shutting_down"
	);
}

export function safeHint(command: string): string {
	return command;
}

export function nodeAge(node: TaskState["nodes"][string]): string {
	const ts = node.lastActivityAt || node.staleAt;
	return ts ? humanAge(ts) : "-";
}

export function formatNodeBadge(task: TaskState, nodeId: string, current: Set<string>): string {
	const node = task.nodes[nodeId];
	if (!node) return nodeId;
	const icon = current.has(nodeId) ? "▶" : statusIcon(node.status);
	return `${icon} ${nodeId}`;
}

export function nodeDisplayLabel(
	task: TaskState,
	entry: GraphTreeEntry,
	currentIds: Set<string>,
	attentionIds: Set<string>,
	focused = false,
): string {
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

export function buildStoryLine(
	task: TaskState,
	closure: ReturnType<typeof computeTaskClosure>,
	ready: string[],
	currentIds: string[],
	attentionCount: number,
): string {
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

export function messageLifecyclePhrase(rec?: any): string {
	if (!rec) return "no handoff record";
	if (rec.superseded) return "superseded";
	if (rec.status === "dead_letter" || rec.status === "failed") return `stuck${rec.lastError ? ` (${rec.lastError})` : ""}`;
	if (rec.ackMissingAt || (rec.requiresAck && !rec.ackedAt)) return "waiting ACK";
	if (rec.requiresResponse && !rec.response?.resultMessageId) return "waiting response";
	if (rec.status === "queued" || rec.status === "mailbox_delivered" || rec.status === "injected" || rec.status === "intercepted")
		return "in flight";
	if (rec.status === "acked" || rec.response?.status === "verified") return "delivered ✓ acked";
	return rec.status || "unknown";
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
		const key = line.replace(/\s+/g, " ").trim();
		if (seenLines.has(key)) {
			lineCount.set(key, (lineCount.get(key) || 1) + 1);
			continue;
		}
		seenLines.add(key);
		lines.push(line);
	}
	const out = lines.map((l) => {
		const key = l.replace(/\s+/g, " ").trim();
		const n = lineCount.get(key) || 1;
		return n > 1 ? `${l} (x${n})` : l;
	});
	return out.slice(0, 6);
}

export function truncateLeft(s: string, cols: number): string {
	let out = "";
	let w = 0;
	let i = 0;
	while (i < s.length) {
		if (s[i] === "\x1b") {
			const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
			if (m) {
				i += m[0].length;
				continue;
			}
		}
		const ch = Array.from(s.slice(i))[0] || "";
		const cw = visibleWidth(ch);
		if (w + cw > cols) {
			out = s.slice(i);
			return out;
		}
		w += cw;
		i += ch.length;
	}
	return "";
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
