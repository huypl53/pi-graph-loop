// === swarm/src/tasks-index.ts ===
// Module boundary: PM-facing rollup + indexer for `.pi/swarm/tasks/*.task.json`.
// Three concerns live here together because they share one shape (`IndexedTask`):
//   1. `buildSwarmStatusSummary`  — `/swarm status` text rollup (agent census + task table)
//   2. `listTasksIndexed`         — scans tasks dir, returns IndexedTask[] (prefixed, prioritized)
//   3. `renderTasksIndexedList`   — pure formatter for the list (stable grep-able lines)
//   4. `resolveTaskArg`           — accepts "#", task-id, or fragment, returns hit/list/miss
//
// Why co-located: all four are PM surface consumers; splitting them across modules would scatter
// the `IndexedTask` contract. They do not own nudge policy or surface-time gating (those live in
// ./nudges/* and ./surface.ts respectively). IO is bounded to `.pi/swarm/tasks/` reads.
//
// Moved verbatim from reconcile.ts (lines 2789-2924) as part of the R24 structure refactor.
// No behavior change.

import { existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import type { IndexedTask, Paths, SwarmState, TaskState } from "./types.ts";
import { MAX_CONSECUTIVE_NUDGES_DEFAULT, MAX_STATUS_TASKS } from "./constants.ts";
import { ensureAgentDefaults, humanAge, safeId } from "./utils.ts";
import { computeReadyNodes } from "./taskgraph.ts";
import { readTaskState } from "./state.ts";
import { resolveGoalNudgeIntervalMs } from "./nudges/goal-epoch.ts";
import { taskPaths } from "./state.ts";

// PM-facing swarm rollup for `/swarm status`. Bounded: scans up to MAX_STATUS_TASKS task.json
// files, prioritizing non-terminal tasks, and emits stable prefixed lines that are grep-able so
// the test lane can assert on tool output instead of eyeballing panes. Pane capture stays fallback.
export async function buildSwarmStatusSummary(p: Paths, st: SwarmState): Promise<{ text: string; details: Record<string, unknown> }> {
	const agents = Object.values(st.agents);
	const byRuntime: Record<string, number> = {};
	const byHealth: Record<string, number> = {};
	let runningAgents = 0;
	for (const a of agents) {
		ensureAgentDefaults(a);
		byRuntime[a.runtimeStatus] = (byRuntime[a.runtimeStatus] || 0) + 1;
		byHealth[a.health] = (byHealth[a.health] || 0) + 1;
		if (a.status === "running") runningAgents++;
	}
	let ackMissing = 0;
	for (const rec of Object.values(st.messages)) {
		if (rec.requiresAck && !rec.ackedAt && rec.status !== "dead_letter" && rec.status !== "acked") ackMissing++;
	}

	const pmStatus = (task: TaskState): string => {
		if (task.status === "cancelled") return "cancelled";
		if (task.status === "done") return "done";
		if (task.status === "failed") return "failed";
		if (task.status === "blocked") return "blocked";
		if (Object.values(task.nodes).some((n) => n.staleAt)) return "stale";
		if (task.status === "in_progress") return "in_progress";
		return "open";
	};

	const taskLines: string[] = [];
	const byTaskStatus: Record<string, number> = {};
	let staleNodes = 0;
	let scanned = 0;
	if (existsSync(p.tasksDir)) {
		let entries: string[] = [];
		try { entries = await readdir(p.tasksDir); } catch { entries = []; }
		// Read all (bounded), then surface non-terminal tasks first so the operator sees live work.
		const read: Array<{ task: TaskState; pm: string }> = [];
		for (const entry of entries) {
			if (scanned >= MAX_STATUS_TASKS) break;
			const tp = taskPaths(p, entry);
			if (!existsSync(tp.taskJson)) continue;
			scanned++;
			try {
				const task = await readTaskState(tp.taskJson);
				read.push({ task, pm: pmStatus(task) });
			} catch { /* skip unreadable */ }
		}
		read.sort((a, b) => (a.pm === "done" || a.pm === "failed" || a.pm === "cancelled" ? 1 : 0) - (b.pm === "done" || b.pm === "failed" || b.pm === "cancelled" ? 1 : 0));
		for (const { task, pm } of read) {
			byTaskStatus[pm] = (byTaskStatus[pm] || 0) + 1;
			let unacked = 0;
			for (const node of Object.values(task.nodes)) {
				if (node.staleAt) staleNodes++;
				for (const msgId of node.messageIds || []) { const rec = st.messages[msgId]; if (rec && rec.requiresAck && !rec.ackedAt) unacked++; }
			}
			const { ready, current } = computeReadyNodes(task);
			taskLines.push(`task ${task.taskId} ${pm} current=[${current.join(",") || "-"}] next=[${ready.join(",") || "-"}] unacked=${unacked}`);
		}
	}
	const proxy = st.proxyMetrics || { hungButAlive: 0, staleOpen: 0, supersessionChurn: 0 };
	const closureLine = `closure: ${byTaskStatus["done"] || 0} done, ${byTaskStatus["in_progress"] || 0} in_progress, ${(byTaskStatus["blocked"] || 0) + (byTaskStatus["stale"] || 0)} blocked/stale, ${byTaskStatus["failed"] || 0} failed`;
	const lines = [
		`swarm ${st.swarmId}: ${runningAgents}/${agents.length} agents running, tmux ${st.tmuxSession}`,
		`agents by runtime: ${Object.entries(byRuntime).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
		`agents by health: ${Object.entries(byHealth).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
		`tasks: ${scanned} scanned, ${Object.entries(byTaskStatus).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}; staleNodes=${staleNodes}; ackMissing=${ackMissing}`,
		`proxy metrics: hungButAlive=${proxy.hungButAlive} staleOpen=${proxy.staleOpen} supersessionChurn=${proxy.supersessionChurn}${proxy.lastEmitAt ? ` lastEmitAt=${proxy.lastEmitAt}` : ""}`,
		st.goal ? `goal: ${st.goal.id} interval=${resolveGoalNudgeIntervalMs(st.goal.nudgeIntervalMs)}ms nudges=${st.goal.consecutiveNoResolveNudges}/${MAX_CONSECUTIVE_NUDGES_DEFAULT}` : `goal: none`,
		closureLine,
		...taskLines,
	];
	return { text: lines.join("\n"), details: { swarmId: st.swarmId, runningAgents, totalAgents: agents.length, byRuntime, byHealth, tasksScanned: scanned, byTaskStatus, staleNodes, ackMissing, proxyMetrics: proxy, closure: closureLine, taskLines } };
}

// Deterministic, indexed task list shared by `/swarm tasks` and the no-arg / number forms of
// `/swarm graph|task|next|validate`. Sort is stable (createdAt asc, taskId tiebreak) so a number
// the operator just saw in the list resolves to the SAME task on the next call. Bounded by
// MAX_STATUS_TASKS so a huge task dir can't stall the command.
export async function listTasksIndexed(p: Paths): Promise<IndexedTask[]> {
	if (!existsSync(p.tasksDir)) return [];
	let entries: string[] = [];
	try { entries = await readdir(p.tasksDir); } catch { return []; }
	const out: IndexedTask[] = [];
	for (const entry of entries) {
		if (out.length >= MAX_STATUS_TASKS) break;
		const tp = taskPaths(p, entry);
		if (!existsSync(tp.taskJson)) continue;
		let task: TaskState;
		try { task = await readTaskState(tp.taskJson); } catch { continue; }
		const { ready, current } = computeReadyNodes(task);
		const total = Object.keys(task.nodes).length;
		const done = Object.values(task.nodes).filter((n) => n.status === "done").length;
		out.push({ index: 0, taskId: task.taskId, task, tp, status: task.status, title: task.title, createdAt: task.createdAt, updatedAt: task.updatedAt, ready, current, done, total });
	}
	out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.taskId < b.taskId ? -1 : 1));
	out.forEach((t, i) => (t.index = i + 1));
	return out;
}

export function renderTasksIndexedList(list: IndexedTask[]): string {
	if (!list.length) return "No tasks found. Create one with swarm_create_task (or have the root plan one).";
	const lines: string[] = [`Tasks (${list.length}) — pick by # or task-id:  /swarm graph|task|next|validate <#|task-id>`];
	lines.push("  #  task-id                                 status       age   updated          nodes    current → next");
	for (const t of list) {
		const cur = t.current.join(",") || "-";
		const nxt = t.ready.join(",") || "-";
		const updated = t.updatedAt ? t.updatedAt.slice(5, 16).replace("T", " ") : "?          ";
		lines.push(`  ${String(t.index).padStart(2)}  ${t.taskId.padEnd(40)} ${t.status.padEnd(12)} ${humanAge(t.updatedAt).padStart(4)}  ${updated}  ${String(t.done)}/${String(t.total).padEnd(3)}    ${cur} → ${nxt}`);
	}
	return lines.join("\n");
}

// Resolve a user-supplied task reference: a bare number = list index; otherwise exact then prefix
// task-id match (so uuid, full id, or a unique prefix all work). Returns the matched task plus the
// full list so callers can re-render the list with a hint on miss/ambiguity.
export async function resolveTaskArg(p: Paths, arg?: string): Promise<{ hit?: IndexedTask; list: IndexedTask[]; missReason?: string; ambiguous?: string[] }> {
	const list = await listTasksIndexed(p);
	const trim = (arg || "").trim();
	if (!trim) return { list, missReason: "no task reference given" };
	if (/^\d+$/.test(trim)) {
		const idx = parseInt(trim, 10);
		const hit = list[idx - 1];
		if (hit) return { hit, list };
		return { list, missReason: `no task at index ${idx} (have 1..${list.length})` };
	}
	const norm = safeId(trim);
	const exact = list.find((t) => t.taskId === trim || safeId(t.taskId) === norm);
	if (exact) return { hit: exact, list };
	// Substring (not just prefix): task-ids share a long "task-swarm-..." stem, so a distinctive
	// fragment like "dashboard", "iteration-demo", or "uat" should match. Multiple hits -> ambiguous.
	const sub = list.filter((t) => t.taskId.includes(trim) || safeId(t.taskId).includes(norm));
	if (sub.length === 1) return { hit: sub[0], list };
	if (sub.length > 1) return { list, ambiguous: sub.map((t) => t.taskId) };
	return { list, missReason: `no task matches "${trim}"` };
}
