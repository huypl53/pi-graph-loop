// === swarm/tools/tasks/create.ts — swarm_create_task tool (real body) ===
// Extracted verbatim from the src/tools/tasks.ts monolith (Phase 6 real split).

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import {
	applyTaskStatus,
	autoCloseRootTerminalNodes,
	buildGraphFromInput,
	buildTaskMarkdown,
	computeReadyNodes,
	releaseNodeAssignment,
	sweepTaskWorkersLocked,
	validateTaskGraph,
} from "../../taskgraph.ts";
import { resolveTaskStallLocked } from "../../reconcile.ts";
import type { NodeInput, TaskGate, TaskState } from "../../types.ts";
import { currentAgentId } from "../../session.ts";
import { ensureDirs, paths, readState, taskPaths, traceTask, withLock, writeState, writeTaskState } from "../../state.ts";
import { now, safeId, textResult } from "../../utils.ts";
import { heartbeatRootLeader, requireRootAuthority } from "../../identity.ts";
import { registerEvidenceHooks, writeBaselineCommit } from "../../trace.ts";
import { createTaskCore } from "../../primitives/task-core.ts";
import { wrapSwarmToolInvocation } from "../wrapper.ts";

export function registerCreateTaskTool(pi: ExtensionAPI): void {
	registerEvidenceHooks(pi);
	pi.registerTool(
		defineTool({
			name: "swarm_create_task",
			label: "Swarm Create Task",
			description:
				"Create a task graph under .pi/swarm/tasks/<task-id>/ with task.md, task.json, events.jsonl, and artifacts/. Synthesizes the built-in feature-dev graph unless a custom nodes/edges graph is supplied.",
			promptGuidelines: ["Use `swarm_create_task` to define a new durable task graph before assigning work."],
			parameters: Type.Object({
				title: Type.String({ description: "Human-readable task title." }),
				goal: Type.String({ description: "One-paragraph goal/outcome for the task." }),
				workflow: Type.Optional(Type.String({ description: "Workflow/template name. Defaults to feature-dev." })),
				allowedFiles: Type.Optional(Type.Array(Type.String({ description: "Project-relative file paths the task may touch." }))),
				acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
				validationCommands: Type.Optional(Type.Array(Type.String())),
				qualificationMode: Type.Optional(
					Type.String({
						description:
							"Qualification preparation mode: auto (root/auditor challenge) or human-discuss (wait for human confirmation). Defaults to auto.",
					}),
				),
				priority: Type.Optional(Type.String({ description: "low, normal, high. Defaults to normal." })),
				taskId: Type.Optional(
					Type.String({ description: "Optional explicit task id; otherwise generated as task-<timestamp>-<slug>." }),
				),
				start: Type.Optional(Type.String({ description: "Start node id when supplying a custom graph." })),
				nodes: Type.Optional(
					Type.Record(
						Type.String(),
						Type.Object({
							status: Type.Optional(Type.String()),
							role: Type.Optional(Type.String()),
							dependsOn: Type.Optional(Type.Array(Type.String())),
							allowedFiles: Type.Optional(Type.Array(Type.String())),
							allowedFilesFrom: Type.Optional(Type.String()),
							readArtifacts: Type.Optional(Type.Array(Type.String())),
							writeArtifacts: Type.Optional(Type.Array(Type.String())),
							maxAttempts: Type.Optional(Type.Number()),
							terminal: Type.Optional(Type.Boolean()),
							assignee: Type.Optional(Type.String()),
							assigneePolicy: Type.Optional(Type.String()),
							outcome: Type.Optional(Type.String()),
						}),
					),
				),
				edges: Type.Optional(
					Type.Array(
						Type.Object({
							from: Type.String(),
							to: Type.String(),
							when: Type.Optional(Type.String()),
							rework: Type.Optional(Type.Boolean()),
							parallel: Type.Optional(Type.Boolean()),
						}),
					),
				),
				gates: Type.Optional(Type.Record(Type.String(), Type.Any())),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_create_task", async () => {
					const p = paths(ctx.cwd);
					await ensureDirs(p);
					const me = currentAgentId();
					requireRootAuthority(currentAgentId(), "swarm_create_task");
					const result = await withLock(p, async () => {
						return createTaskCore(p, {
							readState,
							writeState,
							deliverMessageLocked: async () => ({}),
							pi,
							cwd: ctx.cwd,
						}, params);
					});
					return textResult(
						`Created task ${result.taskId} at ${relative(ctx.cwd, result.tp.root)}\nStart: ${result.task.start}\nReady: ${result.actionable.join(", ") || "(none)"}${result.autoClosed?.length ? `\nAuto-closed root terminal nodes: ${result.autoClosed.join(", ")}` : ""}\nHint: use task-role-staffing.`,
						{
							taskId: result.taskId,
							task: result.task,
							taskMd: relative(ctx.cwd, result.tp.taskMd),
							taskJson: relative(ctx.cwd, result.tp.taskJson),
							autoClosed: result.autoClosed,
						},
					);
				});
			},
		}),
	);
}
