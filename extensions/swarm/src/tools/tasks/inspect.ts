// === swarm/tools/tasks/inspect.ts — swarm_task_status tool (real body) ===
// Extracted verbatim from the src/tools/tasks.ts monolith (Phase 6 real split).

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { collectDeclaredArtifacts, computeReadyNodes, computeTaskClosure, graphJsonSummary } from "../../taskgraph.ts";
import { paths, readState, readTaskByRef, taskPaths, traceTask } from "../../state.ts";
import { now, textResult } from "../../utils.ts";
import { runtimeTaskWarnings } from "../../reconcile.ts";
import { wrapSwarmToolInvocation } from "../wrapper.ts";

// === tool-output-slim §4 — summary view (compact graph verdict + pointers) ===
function taskSummaryView(
	task: ReturnType<typeof graphJsonSummary> extends infer T ? any : any,
	ready: string[],
	current: string[],
	runtimeWarnings?: string[],
) {
	const progress = { done: 0, inProgress: 0, ready: 0, pending: 0 };
	for (const n of Object.values(task.nodes)) {
		const s = (n as any).status;
		if (s === "done" || s === "failed" || s === "skipped" || s === "cancelled") progress.done++;
		else if (s === "in_progress") progress.inProgress++;
		else if (s === "assigned" || s === "ready") progress.ready++;
		else progress.pending++;
	}
	const summary: Record<string, unknown> = {
		taskId: task.taskId,
		title: task.title,
		status: task.status,
		progress,
		current: current.map((nodeId) => ({
			node: nodeId,
			assignee: (task.nodes as any)[nodeId]?.assignee || null,
			status: (task.nodes as any)[nodeId]?.status,
		})),
		ready,
	};
	if (runtimeWarnings?.length) summary.warnings = runtimeWarnings;
	return summary;
}

export function registerTaskStatusTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "swarm_task_status",
			label: "Swarm Task Status",
			description:
				"Read task.json and summarize task/node/gate state. Optionally include artifact listing and runtime liveness/message warnings.",
			promptGuidelines: ["Use `swarm_task_status` to inspect assigned task state and current/ready nodes."],
			parameters: Type.Object({
				taskId: Type.String({ description: "Task id." }),
				includeArtifacts: Type.Optional(
					Type.Boolean({ description: "List declared artifacts and whether they exist. Defaults to false." }),
				),
				detail: Type.Optional(
					Type.Union([Type.Literal("summary"), Type.Literal("graph")], {
						description:
							"Output view. Defaults to 'summary' (compact progress + current/ready pointers). 'graph' returns the full nodes/edges/gates JSON summary.",
					}),
				),
				runtime: Type.Optional(
					Type.Boolean({ description: "Include agent/message/liveness warnings from swarm state. Defaults to false." }),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_task_status", async () => {
					const p = paths(ctx.cwd);
					const { task, tp, taskId } = await readTaskByRef(p, { taskId: params.taskId });
					const { ready, current } = computeReadyNodes(task);
					const summary = graphJsonSummary(task, ready, current);
					let artifacts: Array<{ path: string; exists: boolean }> | undefined;
					if (params.includeArtifacts)
						artifacts = collectDeclaredArtifacts(task).map((path) => ({ path, exists: existsSync(join(tp.root, path)) }));
					let runtimeWarnings: string[] | undefined;
					let closure: ReturnType<typeof computeTaskClosure> | undefined;
					if (params.runtime) {
						const st = await readState(p, ctx.cwd);
						runtimeWarnings = await runtimeTaskWarnings(pi, st, task);
						closure = computeTaskClosure(st, task, tp);
					}
					await traceTask(tp, "task.status.read", {
						taskId,
						includeArtifacts: Boolean(params.includeArtifacts),
						runtime: Boolean(params.runtime),
						detail: params.detail === "graph" ? "graph" : "summary",
					});
					// === tool-output-slim §4 — summary/graph split ===
					if (params.detail !== "graph") {
						const summaryView = taskSummaryView(task, ready, current, runtimeWarnings);
						if (artifacts) summaryView.artifacts = artifacts;
						return textResult(JSON.stringify(summaryView), { ...summaryView, closure });
					}
					const closureBlock = closure
						? `\n\nClosure: storedStatus=${closure.storedStatus} derivedStatus=${closure.derivedStatus} closed=${closure.closedNodes}/${closure.nodeClosure.length} open=${closure.openNodes} stale=${closure.staleNodes}` +
							(closure.openAssignments.length
								? `\n  Open assignments: ${closure.openAssignments.map((a) => `${a.nodeId}→${a.assignee}(${a.status})`).join(", ")}`
								: "") +
							(closure.staleAssignments.length
								? `\n  Stale assignments: ${closure.staleAssignments.map((a) => `${a.nodeId}→${a.assignee} (${a.reason})`).join(", ")}`
								: "") +
							(closure.blocking.length ? `\n  Task blockers: ${closure.blocking.join("; ")}` : "")
						: "";
					// detail:"graph" — the legacy JSON graph summary (nodes/edges/gates arrays), which is
					// also what main's `details` carried. printGraphText remains available via the
					// /swarm graph command surface, not this tool.
					return textResult(JSON.stringify(summary), { task: summary, taskId, artifacts, runtimeWarnings, closure });
				});
			},
		}),
	);
}
