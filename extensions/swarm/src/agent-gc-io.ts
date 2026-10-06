// === swarm/agent-gc-io.ts — I/O adapter for agent-gc task-graph loading ===
// Pure predicates live in agent-gc.ts (no I/O); this adapter reads every task.json under
// .pi/swarm/tasks/ and shapes them for stoppedGcCandidates({taskGraphs}). Read errors are
// routed to logSwarmError (ENOENT/absent dir is expected-absence, compacted per mandate).

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readTaskState, taskPaths } from "./state.ts";
import type { Paths } from "./types.ts";
import { logSwarmError, expected } from "./errorlog.ts";

export async function loadTaskGraphsForGc(p: Paths): Promise<Array<{ taskId: string; nodes: Record<string, { assignee?: string | null; status?: string }> }>> {
	if (!existsSync(p.tasksDir)) return [];
	let entries: string[] = [];
	try {
		entries = await readdir(p.tasksDir);
	} catch (err: any) {
		if (err?.code !== "ENOENT") {
			await logSwarmError(p, "agent-gc-io", "taskgraph_readdir_failed", err);
		}
		return [];
	}
	const out: Array<{ taskId: string; nodes: Record<string, { assignee?: string | null; status?: string }> }> = [];
	for (const entry of entries) {
		const taskJson = taskPaths(p, entry).taskJson;
		if (!existsSync(taskJson)) continue;
		try {
			const task = await readTaskState(taskJson);
			out.push({ taskId: task.taskId ?? entry, nodes: task.nodes as any });
		} catch (err: any) {
			if (err?.code !== "ENOENT") {
				await logSwarmError(p, "agent-gc-io", "taskgraph_unreadable", err, { taskId: entry });
			} else {
				expected("task_json_absent", err);
			}
		}
	}
	return out;
}
