import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SwarmState, TaskState } from "../types.ts";
import { latestNonSupersededMessage } from "./collectors.ts";
import {
	clock,
	laneIcon,
	nodeAge,
	nodeDisplayLabel,
	renderGraphOverview,
	sanitizeUntrustedText,
	statusIcon,
} from "./formatting.ts";
import type {
	FlowAttentionItem,
	FlowDialogData,
	GraphTreeEntry,
	GraphTreeModel,
	NodeMessage,
	Row,
	Section,
} from "./types.ts";

export interface FlowRenderHost {
	fg(c: string, s: string): string;
	bg(c: string, s: string): string;
	pad(s: string, w: number): string;
	hScroll(s: string, w: number): string;
	data: FlowDialogData | null;
	filter: string;
	filterMode: boolean;
	help: boolean;
	detail: Row | null;
	selected: number;
	rows(): Row[];
	expandLanes: boolean;
	nextText: string;
	hOffset: number;
	graphModel: GraphTreeModel;
	graphSelected: number;
	clampGraphSelection(indices: number[]): void;
	selectedGraphEntry(): GraphTreeEntry | undefined;
	messageViewNodeId: string | null;
	nodeMsgCache: Map<string, NodeMessage[]>;
	messageScroll: number;
	messageViewScroll: number;
	fullBodyMessageId: string | null;
}

export function buildNodeDetail(task: TaskState, st: SwarmState, entry: GraphTreeEntry, attention: FlowAttentionItem[]): string[] {
	const node = task.nodes[entry.nodeId];
	if (!node) return [`${entry.nodeId} not found`];
	const owner = node.assignee || node.role || "unowned";
	const lines: string[] = [];

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

export function renderFlowHeader(host: FlowRenderHost, W: number): string[] {
	const snap = host.data;
	const innerW = W - 4;
	if (!snap) {
		return [
			host.fg("border", "╭" + "─".repeat(Math.max(0, W - 2)) + "╮"),
			host.fg("border", "│ ") + host.pad(host.fg("muted", "loading…"), innerW) + host.fg("border", " │"),
			host.fg("border", "╰" + "─".repeat(Math.max(0, W - 2)) + "╯"),
		];
	}
	const title = ` swarm flow · ${snap.task.taskId} · ${snap.task.status} · ${snap.freshnessLabel}${snap.stale ? " · stale" : ""} `;
	const ttl =
		title.length + 8 > W ? ` swarm flow · ${snap.task.taskId.slice(0, Math.max(8, W - 58))}… · ${snap.task.status} ` : title;
	const out: string[] = [];
	out.push(
		host.fg("border", "╭─") + host.fg("accent", ttl) + host.fg("border", "─".repeat(Math.max(1, W - 3 - visibleWidth(ttl))) + "╮"),
	);
	out.push(
		host.fg("border", "│ ") +
			host.pad(host.fg("dim", `open=${snap.open} stale=${snap.staleCount}`), innerW) +
			host.fg("border", " │"),
	);
	if (host.filterMode || host.filter) {
		out.push(
			host.fg("border", "│ ") +
				host.pad(host.fg("accent", `/ ${host.filter}${host.filterMode ? "▏" : ""}`), innerW) +
				host.fg("border", " │"),
		);
	}
	return out;
}

export function renderFlowHelp(host: FlowRenderHost, W: number): string[] {
	const innerW = W - 4;
	const out: string[] = [];
	out.push(
		host.fg("border", "╭─") +
			host.fg("accent", " swarm flow help ") +
			host.fg("border", "─".repeat(Math.max(1, W - 3 - visibleWidth(" swarm flow help "))) + "╮"),
	);
	for (const [k, v] of [
		["navigate", "↑↓ or j / k"],
		["next section", "Tab / Shift-Tab"],
		["detail", "Enter"],
		["attention only", "a"],
		["expand lanes", "o"],
		["next hint", "n"],
		["refresh", "r"],
		["filter", "/"],
		["close", "Esc or q"],
	] as Array<[string, string]>) {
		out.push(
			host.fg("border", "│ ") + host.pad(`${host.fg("accent", k)} · ${host.fg("dim", v)}`, innerW) + host.fg("border", " │"),
		);
	}
	out.push(host.fg("border", "╰" + "─".repeat(Math.max(0, W - 2)) + "╯"));
	return out;
}

export function renderFlowDetail(host: FlowRenderHost, W: number, item: Row): string[] {
	const innerW = W - 4;
	const out: string[] = [];
	const title = ` ${item.section.toLowerCase()} · ${item.title} `;
	out.push(
		host.fg("border", "╭─") +
			host.fg("accent", title) +
			host.fg("border", "─".repeat(Math.max(1, W - 3 - visibleWidth(title))) + "╮"),
	);
	for (const ln of wrapTextWithAnsi(item.detail, Math.max(20, innerW))) {
		out.push(host.fg("border", "│ ") + host.pad(truncateToWidth(ln, innerW), innerW) + host.fg("border", " │"));
	}
	out.push(host.fg("border", "│ ") + host.pad(host.fg("dim", `Hint: ${item.hint}`), innerW) + host.fg("border", " │"));
	out.push(
		host.fg("border", "│ ") +
			host.pad(host.fg("dim", `Task: /swarm task ${host.data?.task.taskId || "?"} runtime`), innerW) +
			host.fg("border", " │"),
	);
	out.push(host.fg("border", "│ ") + host.pad(host.fg("dim", "Esc back · r refresh · ? help"), innerW) + host.fg("border", " │"));
	out.push(host.fg("border", "╰" + "─".repeat(Math.max(0, W - 2)) + "╯"));
	return out;
}

export function renderFlowLegacy(host: FlowRenderHost, width: number): string[] {
	const W = Math.max(40, width);
	if (host.help) return renderFlowHelp(host, W);
	if (host.detail) return renderFlowDetail(host, W, host.detail);
	const snap = host.data;
	const innerW = W - 4;
	const out = renderFlowHeader(host, W);
	if (!snap) return out;
	const rows = host.rows();
	for (const section of ["ATTENTION", "FLOW", "LANES", "EVENTS"] as Section[]) {
		out.push(host.fg("border", "│ ") + host.pad(host.fg("accent", section), innerW) + host.fg("border", " │"));
		const secRows = rows.filter((r) => r.section === section);
		if (!secRows.length) {
			out.push(host.fg("border", "│ ") + host.pad(host.fg("muted", "  (none)"), innerW) + host.fg("border", " │"));
			continue;
		}
		const limit = section === "EVENTS" ? 6 : 10;
		const selIdxInSec = secRows.findIndex(
			(r) => rows[host.selected] && r.id === rows[host.selected].id && r.section === rows[host.selected].section,
		);
		let start = 0;
		if (selIdxInSec >= limit) start = selIdxInSec - limit + 1;
		if (start > 0) {
			out.push(
				host.fg("border", "│ ") +
					host.pad(host.fg("muted", `  ↑ +${start} earlier in ${section.toLowerCase()}`), innerW) +
					host.fg("border", " │"),
			);
		}
		for (const row of secRows.slice(start, start + limit)) {
			const idx = rows.findIndex((r) => r.section === row.section && r.id === row.id);
			const icon =
				row.section === "ATTENTION"
					? row.severity === "act"
						? "!"
						: row.severity === "watch"
							? "⚠"
							: "·"
					: row.section === "FLOW"
						? statusIcon(row.title)
						: row.section === "LANES"
							? laneIcon(undefined, row.id === "lanes-collapsed")
							: "·";
			const label = `${String(idx + 1).padStart(2)} ${icon} ${row.summary}`;
			const selected = rows[host.selected] && rows[host.selected].id === row.id && rows[host.selected].section === row.section;
			out.push(
				host.fg("border", "│ ") +
					(selected ? host.bg("selectedBg", host.pad(label, innerW)) : host.pad(label, innerW)) +
					host.fg("border", " │"),
			);
		}
		if (start + limit < secRows.length) {
			out.push(
				host.fg("border", "│ ") +
					host.pad(host.fg("muted", `  ↓ +${secRows.length - start - limit} more in ${section.toLowerCase()}`), innerW) +
					host.fg("border", " │"),
			);
		}
		if (section === "FLOW") {
			out.push(
				host.fg("border", "│ ") +
					host.pad(
						host.fg("dim", `Ready: ${snap.ready.join(", ") || "(none)"} · Current: ${snap.current.join(", ") || "(none)"}`),
						innerW,
					) +
					host.fg("border", " │"),
			);
		}
		if (section === "LANES" && !host.expandLanes && snap.otherAgentsCount > 0) {
			out.push(
				host.fg("border", "│ ") +
					host.pad(host.fg("muted", `+ ${snap.otherAgentsCount} other agents collapsed (press o to expand)`), innerW) +
					host.fg("border", " │"),
			);
		}
	}
	if (host.nextText) {
		out.push(host.fg("border", "│ ") + host.pad(host.fg("dim", `NEXT: ${host.nextText}`), innerW) + host.fg("border", " │"));
	}
	out.push(
		host.fg("border", "│ ") +
			host.pad(
				host.fg(
					"dim",
					"↑↓/jk nav · Tab section · Enter detail · a attention-only · / filter · o expand lanes · r refresh · n next-hint · ? help · Esc close",
				),
				innerW,
			) +
			host.fg("border", " │"),
	);
	out.push(host.fg("border", "╰" + "─".repeat(Math.max(0, W - 2)) + "╯"));
	return out;
}

export function renderFlowV3(host: FlowRenderHost, width: number): string[] {
	const W = Math.max(40, width);
	if (host.help) return renderFlowHelp(host, W);
	const snap = host.data;
	const out = renderFlowHeader(host, W);
	const innerW = W - 4;
	if (!snap) return out;

	// Full-body message view (tier 3)
	if (host.fullBodyMessageId !== null && host.messageViewNodeId !== null) {
		const nodeMessages = host.nodeMsgCache.get(host.messageViewNodeId) || [];
		const msg = nodeMessages.find((m) => m.messageId === host.fullBodyMessageId);
		if (msg) {
			const header = `Message · ${msg.from} → ${msg.to}`;
			out.push(
				host.fg("border", "╭─") +
					host.fg("accent", header) +
					host.fg("border", "─".repeat(Math.max(1, W - 3 - visibleWidth(header))) + "╮"),
			);
			const subject = msg.subject || "(no subject)";
			out.push(host.fg("border", "│ ") + host.pad(host.fg("accent", subject), innerW) + host.fg("border", " │"));
			out.push(
				host.fg("border", "│ ") +
					host.pad(host.fg("dim", "─".repeat(Math.max(0, innerW - 2))), innerW) +
					host.fg("border", " │"),
			);
			const rawBody = msg.body ? sanitizeUntrustedText(msg.body).replace(/\r/g, "") : "";
			const bodyLines = rawBody ? wrapTextWithAnsi(rawBody, Math.max(20, innerW - 4)) : ["(empty body)"];
			const limit = 14;
			const bodyStart = Math.max(0, Math.min(host.messageViewScroll, Math.max(0, bodyLines.length - limit)));
			if (bodyStart > 0) {
				out.push(
					host.fg("border", "│ ") + host.pad(host.fg("muted", `  ↑ +${bodyStart} earlier`), innerW) + host.fg("border", " │"),
				);
			}
			for (let i = bodyStart; i < Math.min(bodyLines.length, bodyStart + limit); i++) {
				out.push(host.fg("border", "│ ") + host.pad(bodyLines[i], innerW) + host.fg("border", " │"));
			}
			if (bodyStart + limit < bodyLines.length) {
				out.push(
					host.fg("border", "│ ") +
						host.pad(host.fg("muted", `  ↓ +${bodyLines.length - bodyStart - limit} more`), innerW) +
						host.fg("border", " │"),
				);
			}
			out.push(
				host.fg("border", "│ ") +
					host.pad(host.fg("dim", "j/k scroll · Esc back to message list"), innerW) +
					host.fg("border", " │"),
			);
			out.push(host.fg("border", "╰" + "─".repeat(Math.max(0, W - 2)) + "╯"));
			return out;
		}
	}

	// Message view overlay
	if (host.messageViewNodeId !== null) {
		const nodeMessages = host.nodeMsgCache.get(host.messageViewNodeId) || [];
		const header = `Messages · ${host.messageViewNodeId} · ${nodeMessages.length} msgs`;
		out.push(
			host.fg("border", "╭─") +
				host.fg("accent", header) +
				host.fg("border", "─".repeat(Math.max(1, W - 3 - visibleWidth(header))) + "╮"),
		);
		if (nodeMessages.length === 0) {
			out.push(
				host.fg("border", "│ ") + host.pad(host.fg("muted", "no messages for this node"), innerW) + host.fg("border", " │"),
			);
		} else {
			const limit = 8;
			const start = Math.max(0, Math.min(host.messageScroll, nodeMessages.length - limit));
			if (start > 0) {
				out.push(
					host.fg("border", "│ ") + host.pad(host.fg("muted", `  ↑ +${start} earlier`), innerW) + host.fg("border", " │"),
				);
			}
			for (let i = start; i < Math.min(nodeMessages.length, start + limit); i++) {
				const msg = nodeMessages[i];
				const subject = truncateToWidth(msg.subject || "(no subject)", Math.max(20, innerW - 50));
				const bodyPreview = msg.body ? truncateToWidth(sanitizeUntrustedText(msg.body).split("\n")[0], 30) : "";
				const line = `${msg.from} → ${msg.to} · ${subject} · ${msg.lifecycle} · ${bodyPreview}`;
				const isFocused = i === host.messageScroll;
				const rendered = isFocused ? host.bg("selectedBg", host.pad(line, innerW)) : host.pad(line, innerW);
				out.push(host.fg("border", "│ ") + rendered + host.fg("border", " │"));
			}
			if (start + limit < nodeMessages.length) {
				out.push(
					host.fg("border", "│ ") +
						host.pad(host.fg("muted", `  ↓ +${nodeMessages.length - start - limit} more`), innerW) +
						host.fg("border", " │"),
				);
			}
		}
		out.push(
			host.fg("border", "│ ") +
				host.pad(host.fg("dim", "j/k scroll · Enter msg body · Esc back to graph"), innerW) +
				host.fg("border", " │"),
		);
		out.push(host.fg("border", "╰" + "─".repeat(Math.max(0, W - 2)) + "╯"));
		return out;
	}

	// Normal graph + detail view
	const model = host.graphModel.entries.length ? host.graphModel : host.graphModel;
	const currentIds = new Set(snap.current);
	const attentionIds = new Set(snap.attention.map((item) => item.nodeId).filter(Boolean) as string[]);
	const visibleEntries = model.entries;
	host.clampGraphSelection(visibleEntries.map((entry) => entry.index));
	const story = `${snap.task.taskId} · ${Math.round((snap.closure.closedNodes / Math.max(1, Object.keys(snap.task.nodes).length)) * 100)}% · ${snap.current[0] ? `${snap.current.length > 1 ? `parallel current (${snap.current.length})` : `${snap.current[0]} running`} (${snap.task.nodes[snap.current[0]]?.assignee || snap.task.nodes[snap.current[0]]?.role || "unowned"}, ${nodeAge(snap.task.nodes[snap.current[0]])})` : "no current node"} · next: ${snap.ready[0] || "none"} · ${snap.attention.length} needs attention`;
	out.push(host.fg("border", "│ ") + host.hScroll(host.fg("accent", story), innerW) + host.fg("border", " │"));
	out.push(
		host.fg("border", "│ ") +
			host.pad(host.fg("dim", `refreshed ${clock(snap.refreshedAt)} · ${snap.freshnessLabel}`), innerW) +
			host.fg("border", " │"),
	);
	out.push(host.fg("border", "│ ") + host.pad(host.fg("accent", "GRAPH"), innerW) + host.fg("border", " │"));
	for (const entry of visibleEntries) {
		const selected = entry.index === host.graphSelected;
		const line = nodeDisplayLabel(snap.task, entry, currentIds, attentionIds, selected);
		const rendered = selected ? host.bg("selectedBg", host.pad(line, innerW)) : host.pad(line, innerW);
		out.push(host.fg("border", "│ ") + rendered + host.fg("border", " │"));
	}
	out.push(host.fg("border", "│ ") + host.pad(host.fg("dim", "──────── detail ────────"), innerW) + host.fg("border", " │"));
	const selectedEntry = host.selectedGraphEntry() || model.entries[0];
	const detailLines = selectedEntry ? buildNodeDetail(snap.task, snap.st, selectedEntry, snap.attention) : ["no node selected"];
	for (const line of detailLines) {
		for (const ln of wrapTextWithAnsi(line, Math.max(20, innerW))) {
			out.push(host.fg("border", "│ ") + host.pad(ln, innerW) + host.fg("border", " │"));
		}
	}
	out.push(
		host.fg("border", "│ ") +
			host.pad(host.fg("dim", "j/k navigate · Enter messages · ? help · d raw · r refresh · Esc close"), innerW) +
			host.fg("border", " │"),
	);
	out.push(host.fg("border", "╰" + "─".repeat(Math.max(0, W - 2)) + "╯"));
	return out;
}
