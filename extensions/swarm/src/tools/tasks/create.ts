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
						const st = await readState(p, ctx.cwd);
						heartbeatRootLeader(st, Date.now(), process.pid, "create_task");
						await writeState(p, st);
						const ts = now();
						const slug = safeId(params.title).slice(0, 24);
						const taskId = safeId(params.taskId || `task-${ts.replace(/[-:.TZ]/g, "").slice(0, 12)}-${slug}`);
						const tp = taskPaths(p, taskId);
						if (existsSync(tp.taskJson)) throw new Error(`Task already exists: ${taskId}`);
						const qualificationMode = params.qualificationMode === "human-discuss" ? "human-discuss" : "auto";
						if (params.qualificationMode && !["auto", "human-discuss"].includes(params.qualificationMode))
							throw new Error(`Invalid qualificationMode \`${params.qualificationMode}\`; use auto or human-discuss.`);
						const qualification = {
							mode: qualificationMode,
							status: "ready",
							artifact: "artifacts/qualification-gate.md",
							preparedAt: ts,
						} as const;
						const graph = buildGraphFromInput(
							{
								nodes: params.nodes as Record<string, NodeInput> | undefined,
								edges: params.edges,
								start: params.start,
								gates: params.gates as Record<string, TaskGate> | undefined,
							},
							params.allowedFiles || [],
						);
						const task: TaskState = {
							version: 1,
							taskId,
							title: params.title,
							goal: params.goal,
							status: "ready",
							priority: params.priority || "normal",
							createdAt: ts,
							updatedAt: ts,
							owner: currentAgentId(),
							workflow: params.workflow || "feature-dev",
							allowedFiles: params.allowedFiles || [],
							acceptanceCriteria: params.acceptanceCriteria || [],
							validationCommands: params.validationCommands || [],
							start: graph.start,
							currentNodes: [],
							sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
							nodes: graph.nodes,
							edges: graph.edges,
							handoffs: [],
							gates: graph.gates,
							editLocks: {},
							evidence: {},
							qualification,
						};
						// Reject structurally-invalid graphs at creation (hard errors only; soft warnings are still allowed)
						// so a broken task can't be written and linger. Run swarm_validate_graph for the full report.
						const createValidation = validateTaskGraph(task);
						if (createValidation.errors.length) {
							throw new Error(
								`Task graph is structurally invalid; refusing to create. Fix these and retry:\n${createValidation.errors.map((e) => `  ✗ ${e}`).join("\n")}`,
							);
						}
						const { ready, current } = computeReadyNodes(task);
						task.currentNodes = current;
						let createTaskStatusChange = applyTaskStatus(task); // engine-enforced closure: a fresh task derives `ready`
						await mkdir(tp.root, { recursive: true });
						await mkdir(tp.artifacts, { recursive: true });
						await writeBaselineCommit(pi, tp, ctx.cwd);
						const autoClosed = await autoCloseRootTerminalNodes(pi, tp, task, ctx.cwd);
						if (autoClosed.closed.length) {
							createTaskStatusChange = applyTaskStatus(task);
							task.currentNodes = computeReadyNodes(task).current;
						}
						// Issue 23 — resolve any stale task-stall counter for this task if it was already in_progress
						// (rare: legacy swarm with an in_progress task that got recreated; auto-close via terminal
						// nodes flips it to done/failed/cancelled below).
						if (createTaskStatusChange.terminal) resolveTaskStallLocked(p, st, taskId, "task_terminal");
						// Issue 26 — task-close worker sweep (terminal transition site #1). A freshly-created task
						// may auto-close via `autoCloseRootTerminalNodes` (e.g. a one-node graph); when
						// that happens the auto-close path already released assignments via releaseNodeAssignment,
						// but workers spawned-for-task with empty active-task sets still linger. The sweep runs
						// only on terminal transitions and is a no-op when nothing is eligible.
						if (createTaskStatusChange.terminal) await sweepTaskWorkersLocked(pi, ctx.cwd, st, taskId, task);
						// Actionable = newly-ready nodes PLUS already-ready unassigned nodes (e.g. a fresh task's start node,
						// which is born status:"ready" and lands in `current`, not the raw `ready` set). Keeps the "Ready:"
						// report consistent with swarm_next_nodes so roots see what is assignable right now.
						const actionable = Array.from(
							new Set([
								...ready,
								...current.filter((id) => task.nodes[id] && task.nodes[id].status === "ready" && !task.nodes[id].assignee),
							]),
						);
						await writeTaskState(tp, task);
						await writeFile(tp.taskMd, buildTaskMarkdown(task), "utf8");
						const hardGates = task.acceptanceCriteria.length ? task.acceptanceCriteria : [task.goal];
						const commands = task.validationCommands.length
							? task.validationCommands.map((command) => `- [ ] Run: \`${command}\``).join("\n")
							: "- [ ] Add and run deterministic evidence appropriate to this change.";
						const discussion =
							qualification.mode === "human-discuss"
								? "\n## Human discussion required\n\nBefore implementation, confirm the intended outcome, scope trade-offs, and any visible behavior that only the user can decide. Root records that confirmation with `swarm_confirm_qualification`.\n"
								: "\n## Auto-mode challenge\n\nRoot must draft this gate using `extensions/swarm/qualification-skills/qualification-gate/SKILL.md`, ask one reviewer/auditor to challenge missing negative cases, regressions, and evidence, then revise this artifact once before implementation.\n";
						await writeFile(
							join(tp.root, qualification.artifact),
							`# Qualification Gate\n\n## Requested outcome\n\n${task.goal}\n\n## Hard gates\n\n${hardGates.map((item) => `- [ ] ${item}`).join("\n")}\n\n## Evidence plan\n\n${commands}\n- [ ] Independent reviewer/auditor checks that the evidence proves these gates.\n\n## Scope / non-goals\n\n- Use the task allowed-files list and explicit user request; record any change here.\n${discussion}`,
							"utf8",
						);
						await traceTask(tp, "task.create", {
							taskId,
							title: task.title,
							workflow: task.workflow,
							owner: task.owner,
							start: task.start,
							nodeCount: Object.keys(task.nodes).length,
							ready,
							actionable,
							autoClosed: autoClosed.closed,
							qualificationMode: qualification.mode,
							qualificationStatus: qualification.status,
						});
						if (autoClosed.closed.length)
							await traceTask(tp, "task.autoclose.root", { taskId, nodeIds: autoClosed.closed, by: "engine" });
						return { taskId, task, tp, ready, actionable, autoClosed: autoClosed.closed };
					});
					return textResult(
						`Created task ${result.taskId} at ${relative(ctx.cwd, result.tp.root)}\nStart: ${result.task.start}\nReady: ${result.actionable.join(", ") || "(none)"}${result.autoClosed?.length ? `\nAuto-closed root terminal nodes: ${result.autoClosed.join(", ")}` : ""}`,
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
