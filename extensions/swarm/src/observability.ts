import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { Paths, TaskPaths, TaskState, SwarmAgent, SwarmState } from "./types.ts";
import { computeReadyNodes, computeTaskClosure } from "./taskgraph.ts";
import { loopStatusSnapshot } from "./loop.ts";

export type EventSource = "swarm" | "task";

export type EventLine = {
	ts: string;
	event: string;
	source: EventSource;
	text: string;
	raw: Record<string, any>;
};

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function clock(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "??:??:??";
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtValue(value: unknown): string {
	if (value == null) return "";
	if (Array.isArray(value)) return `[${value.map((item) => fmtValue(item)).filter(Boolean).join(", ")}]`;
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function summarizeEvent(rec: Record<string, any>, _source: EventSource): string {
	const ts = typeof rec.ts === "string" ? rec.ts : new Date().toISOString();
	const event = String(rec.event || "event");
	const parts: string[] = [];
	const push = (label: string, value: unknown) => {
		if (value === undefined || value === null || value === "") return;
		const text = fmtValue(value);
		if (!text) return;
		parts.push(`${label}=${text}`);
	};
	push("taskId", rec.taskId);
	push("node", rec.nodeId);
	push("agentId", rec.agentId);
	push("from", rec.from);
	push("to", rec.to);
	push("status", rec.status);
	push("phase", rec.phase);
	push("round", rec.round);
	push("via", rec.via);
	push("format", rec.format);
	push("runtime", typeof rec.runtime === "boolean" ? String(rec.runtime) : rec.runtime);
	push("count", rec.count);
	push("ready", rec.ready);
	push("current", rec.current);
	push("outcome", rec.outcome);
	push("artifact", rec.artifact);
	push("messageId", rec.messageId);
	push("by", rec.by);
	push("replyTo", rec.replyTo);
	push("reason", rec.reason);
	push("error", rec.error);
	push("details", rec.details);
	const arrow = rec.assignee ? ` -> ${rec.assignee}` : rec.recommended ? ` -> ${rec.recommended}` : "";
	const suffix = parts.length ? ` ${parts.join(" ")}` : "";
	return `${clock(ts)} ${event}${suffix}${arrow}`.trimEnd();
}

async function readTailJsonl(file: string, limitBytes = 65536): Promise<Record<string, any>[]> {
	if (!existsSync(file)) return [];
	let size = 0;
	try {
		size = (await stat(file)).size;
	} catch {
		return [];
	}
	const start = Math.max(0, size - limitBytes);
	const readStart = start > 0 ? start - 1 : 0;
	const fh = await open(file, "r");
	try {
		const buffer = Buffer.allocUnsafe(size - readStart);
		const { bytesRead } = await fh.read(buffer, 0, buffer.length, readStart);
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		const slice = start > 0 ? (() => {
			const idx = text.indexOf("\n");
			return idx >= 0 ? text.slice(idx + 1) : "";
		})() : text;
		const lines = slice.split(/\n/).map((l) => l.trim()).filter(Boolean);
		const records: Record<string, any>[] = [];
		for (const line of lines) {
			try {
				const rec = JSON.parse(line) as Record<string, any>;
				if (!rec || typeof rec !== "object") continue;
				if (typeof rec.ts !== "string" || typeof rec.event !== "string") continue;
				records.push(rec);
			} catch {
				// tolerate malformed lines
			}
		}
		return records;
	} finally {
		await fh.close();
	}
}

export async function readRecentEvents(p: Paths, tp: TaskPaths, limit: number): Promise<EventLine[]> {
	if (!Number.isFinite(limit) || limit <= 0) return [];
	const [swarmRecords, taskRecords] = await Promise.all([
		readTailJsonl(p.events),
		readTailJsonl(tp.events),
	]);
	const merged = [
		...swarmRecords.map((raw, seq) => ({ raw, source: "swarm" as const, seq })),
		...taskRecords.map((raw, seq) => ({ raw, source: "task" as const, seq })),
	]
		.map(({ raw, source, seq }) => ({
			ts: raw.ts,
			tsMs: Date.parse(raw.ts),
			event: String(raw.event),
			source,
			seq,
			raw,
		} as const))
		.filter((rec) => Number.isFinite(rec.tsMs));
	merged.sort((a, b) => (a.tsMs - b.tsMs) || (a.seq - b.seq) || a.source.localeCompare(b.source));
	return merged.slice(Math.max(0, merged.length - limit)).map((rec) => ({
		ts: rec.ts,
		event: rec.event,
		source: rec.source,
		raw: rec.raw,
		text: summarizeEvent(rec.raw, rec.source),
	}));
}

function renderNodeLine(id: string, node: TaskState["nodes"][string]): string {
	const status = node.status.padEnd(8);
	const bits: string[] = [];
	if (node.assignee) bits.push(`-> ${node.assignee}`);
	if (!node.assignee && node.role) bits.push(`(role: ${node.role})`);
	if (node.assignee && node.role) bits.push(`(${node.role})`);
	if (!node.assignee && node.dependsOn.length) bits.push(`depends: ${node.dependsOn.join(", ")}`);
	if (node.assignee && node.dependsOn.length) bits.push(`depends: ${node.dependsOn.join(", ")}`);
	if (node.outcome) bits.push(`outcome=${node.outcome}`);
	if (node.staleAt) bits.push(`stale@${node.staleAt}`);
	return `  ${id.padEnd(12)} [${status}] ${bits.join(" ")}`.trimEnd();
}

function renderAgentLine(task: TaskState, agent: SwarmAgent): string {
	const activeHere = Object.entries(task.nodes)
		.filter(([, node]) => node.assignee === agent.id && (node.status === "assigned" || node.status === "in_progress" || node.status === "ready"))
		.map(([id]) => id);
	const active = (agent.activeTaskIds || []).map((taskId) => {
		if (taskId !== task.taskId) return taskId;
		return activeHere.length ? `${taskId}#${activeHere.join(",")}` : taskId;
	});
	return `  ${agent.id.padEnd(12)} ${agent.status.padEnd(8)} ${agent.roleKind.padEnd(12)} active: ${active.length ? active.join(", ") : "-"}`;
}

export function renderFlowSnapshot(
	task: TaskState,
	ready: string[],
	current: string[],
	agents: Record<string, SwarmAgent>,
	events: EventLine[],
	opts: { index?: number; open?: number; stale?: number; loopLine?: string; eventLimit?: number } = {},
): string {
	const lines: string[] = [];
	const header = `Flow${opts.index != null ? ` #${opts.index}` : ""} ${task.taskId} — ${task.title} [${task.status}] open=${opts.open ?? 0} stale=${opts.stale ?? 0}`;
	lines.push(header);
	lines.push("Nodes:");
	for (const [id, node] of Object.entries(task.nodes)) lines.push(renderNodeLine(id, node));
	lines.push("Agents (lanes):");
	const agentList = Object.values(agents).sort((a, b) => a.id.localeCompare(b.id));
	if (agentList.length) {
		for (const agent of agentList) lines.push(renderAgentLine(task, agent));
	} else {
		lines.push("  (none)");
	}
	if (opts.loopLine) lines.push(`Loop: ${opts.loopLine}`);
	lines.push(`Ready: ${ready.length ? ready.join(", ") : "(none)"}`);
	lines.push(`Current: ${current.length ? current.join(", ") : "(none)"}`);
	lines.push(`Events (last ${opts.eventLimit ?? events.length}):`);
	for (const event of events) lines.push(`  ${event.text}`);
	return lines.join("\n");
}

export async function buildFlowSnapshot(
	p: Paths,
	cwd: string,
	task: TaskState,
	tp: TaskPaths,
	st: SwarmState,
	limit: number,
	index?: number,
): Promise<string> {
	const { ready, current } = computeReadyNodes(task);
	const closure = computeTaskClosure(st, task, tp);
	let loopLine: string | undefined;
	if (task.loop?.enabled) {
		try {
			const loop = await loopStatusSnapshot(p, cwd, task.taskId);
			if (loop.enabled) {
				const phase = loop.loop ? `round=${loop.loop.currentRound} phase=${loop.loop.phase}` : loop.proposalState || "not_started";
				loopLine = `${phase}${loop.paths.planArtifact ? ` plan=${loop.paths.planArtifact}` : ""}`;
			}
		} catch {
			// read-only best effort
		}
	}
	const events = await readRecentEvents(p, tp, limit);
	return renderFlowSnapshot(task, ready, current, st.agents, events, { index, open: closure.openNodes, stale: closure.staleNodes, loopLine, eventLimit: limit });
}
