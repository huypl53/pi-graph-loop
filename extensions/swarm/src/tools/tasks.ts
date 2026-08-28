// === swarm/tools/tasks.ts — tool registrations (verbatim from index.ts) ===
import { Type } from "typebox";
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, appendFile, rm, stat, rename, readdir, realpath } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { NodeInput, ReusableAgentMatch, TaskGate, TaskGateStatus, TaskNodeStatus, TaskState } from "../types.ts";
import { TERMINAL_NODE_STATUSES, CANCELLATION_REASON, PREFLIGHT_ASSIGN_GRACE_MS } from "../constants.ts";
import { activateReworkNodes, applyGateUpdates, applySharedContextUpdates, applyTaskStatus, autoCloseOrchestratorTerminalNodes, buildAssignmentBody, buildGraphFromInput, buildTaskMarkdown, collectActiveLeases, collectDeclaredArtifacts, computeReadyNodes, computeTaskClosure, failTaskTool, graphJsonSummary, isAllowedNodeTransition, isTaskOrNodeCancelled, mintNodeAttempt, printGraphMermaid, printGraphText, releaseNodeAssignment, releaseTaskFromAllAgents, resolveNodeScope, scopesOverlap, validateTaskGraph, checkClosureNotificationStale, checkStallNotificationStale, type EffectiveScope } from "../taskgraph.ts";
import { resolveTaskStallLocked } from "../reconcile.ts";
import { currentAgentId } from "../session.ts";
import { deliverMessageLocked, supersedeOpenAssignments, supersedeTaskAssignmentMessages } from "../mailbox.ts";
import { ensureAgentDefaults, inferRoleKind, isSafeRelativePath, now, safeId, textResult } from "../utils.ts";
import { ensureDirs, paths, readState, readTaskByRef, readTaskState, taskPaths, trace, traceTask, withLock, writeState, writeTaskState } from "../state.ts";
import { ensureOrchestrator, heartbeatOrchestratorLeader, isOrchestratorAuthority, requireOrchestratorAuthority } from "../identity.ts";
import { findReusableAgent, spawnAgent, clearOrphanWatch, isSameOrchestratorLeader } from "../agents.ts";
import { reconcile, runtimeTaskWarnings } from "../reconcile.ts";
import { tmux } from "../tmux.ts";

export function registerTasksTools(pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		name: "swarm_create_task",
		label: "Swarm Create Task",
		description: "Create a task graph under .pi/swarm/tasks/<task-id>/ with task.md, task.json, events.jsonl, and artifacts/. Synthesizes the built-in feature-dev graph unless a custom nodes/edges graph is supplied.",
		promptGuidelines: ["Use `swarm_create_task` to define a new durable task graph before assigning work."],
		parameters: Type.Object({
			title: Type.String({ description: "Human-readable task title." }),
			goal: Type.String({ description: "One-paragraph goal/outcome for the task." }),
			workflow: Type.Optional(Type.String({ description: "Workflow/template name. Defaults to feature-dev." })),
			allowedFiles: Type.Optional(Type.Array(Type.String({ description: "Project-relative file paths the task may touch." }))),
			acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
			validationCommands: Type.Optional(Type.Array(Type.String())),
			priority: Type.Optional(Type.String({ description: "low, normal, high. Defaults to normal." })),
			taskId: Type.Optional(Type.String({ description: "Optional explicit task id; otherwise generated as task-<timestamp>-<slug>." })),
			start: Type.Optional(Type.String({ description: "Start node id when supplying a custom graph." })),
			nodes: Type.Optional(Type.Record(Type.String(), Type.Object({
				status: Type.Optional(Type.String()), role: Type.Optional(Type.String()), dependsOn: Type.Optional(Type.Array(Type.String())),
				allowedFiles: Type.Optional(Type.Array(Type.String())), allowedFilesFrom: Type.Optional(Type.String()),
				readArtifacts: Type.Optional(Type.Array(Type.String())), writeArtifacts: Type.Optional(Type.Array(Type.String())),
				maxAttempts: Type.Optional(Type.Number()), terminal: Type.Optional(Type.Boolean()),
				assignee: Type.Optional(Type.String()), assigneePolicy: Type.Optional(Type.String()), outcome: Type.Optional(Type.String()),
			}))),
			edges: Type.Optional(Type.Array(Type.Object({
				from: Type.String(), to: Type.String(), when: Type.Optional(Type.String()),
				rework: Type.Optional(Type.Boolean()), parallel: Type.Optional(Type.Boolean()),
			}))),
			gates: Type.Optional(Type.Record(Type.String(), Type.Any())),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			const me = currentAgentId();
			requireOrchestratorAuthority(currentAgentId(), "swarm_create_task");
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				heartbeatOrchestratorLeader(st, Date.now(), process.pid, "create_task");
				await writeState(p, st);
				const ts = now();
				const slug = safeId(params.title).slice(0, 24);
				const taskId = safeId(params.taskId || `task-${ts.replace(/[-:.TZ]/g, "").slice(0, 12)}-${slug}`);
				const tp = taskPaths(p, taskId);
				if (existsSync(tp.taskJson)) throw new Error(`Task already exists: ${taskId}`);
				const graph = buildGraphFromInput({ nodes: params.nodes as Record<string, NodeInput> | undefined, edges: params.edges, start: params.start, gates: params.gates as Record<string, TaskGate> | undefined }, params.allowedFiles || []);
				const task: TaskState = {
					version: 1, taskId, title: params.title, goal: params.goal, status: "ready",
					priority: params.priority || "normal", createdAt: ts, updatedAt: ts, owner: currentAgentId(),
					workflow: params.workflow || "feature-dev", allowedFiles: params.allowedFiles || [],
					acceptanceCriteria: params.acceptanceCriteria || [], validationCommands: params.validationCommands || [],
					start: graph.start, currentNodes: [],
					sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
					nodes: graph.nodes, edges: graph.edges, handoffs: [], gates: graph.gates, editLocks: {}, evidence: {},
				};
				// Reject structurally-invalid graphs at creation (hard errors only; soft warnings are still allowed)
				// so a broken task can't be written and linger. Run swarm_validate_graph for the full report.
				const createValidation = validateTaskGraph(task);
				if (createValidation.errors.length) {
					throw new Error(`Task graph is structurally invalid; refusing to create. Fix these and retry:\n${createValidation.errors.map((e) => `  ✗ ${e}`).join("\n")}`);
				}
				const { ready, current } = computeReadyNodes(task);
				task.currentNodes = current;
				let createTaskStatusChange = applyTaskStatus(task); // engine-enforced closure: a fresh task derives `ready`
				const autoClosed = autoCloseOrchestratorTerminalNodes(task);
				if (autoClosed.closed.length) {
					createTaskStatusChange = applyTaskStatus(task);
					task.currentNodes = computeReadyNodes(task).current;
				}
				// Issue 23 — resolve any stale task-stall counter for this task if it was already in_progress
				// (rare: legacy swarm with an in_progress task that got recreated; auto-close via terminal
				// nodes flips it to done/failed/cancelled below).
				if (createTaskStatusChange.terminal) resolveTaskStallLocked(p, st, taskId, "task_terminal");
				// Actionable = newly-ready nodes PLUS already-ready unassigned nodes (e.g. a fresh task's start node,
				// which is born status:"ready" and lands in `current`, not the raw `ready` set). Keeps the "Ready:"
				// report consistent with swarm_next_nodes so orchestrators see what is assignable right now.
				const actionable = Array.from(new Set([
					...ready,
					...current.filter((id) => task.nodes[id] && task.nodes[id].status === "ready" && !task.nodes[id].assignee),
				]));
				await mkdir(tp.root, { recursive: true });
				await mkdir(tp.artifacts, { recursive: true });
				await writeTaskState(tp, task);
				await writeFile(tp.taskMd, buildTaskMarkdown(task), "utf8");
				await traceTask(tp, "task.create", { taskId, title: task.title, workflow: task.workflow, owner: task.owner, start: task.start, nodeCount: Object.keys(task.nodes).length, ready, actionable, autoClosed: autoClosed.closed });
				if (autoClosed.closed.length) await traceTask(tp, "task.autoclose.orchestrator", { taskId, nodeIds: autoClosed.closed, by: "engine" });
				return { taskId, task, tp, ready, actionable, autoClosed: autoClosed.closed };
			});
			return textResult(`Created task ${result.taskId} at ${relative(ctx.cwd, result.tp.root)}\nStart: ${result.task.start}\nReady: ${result.actionable.join(", ") || "(none)"}${result.autoClosed?.length ? `\nAuto-closed orchestrator terminal nodes: ${result.autoClosed.join(", ")}` : ""}`, { taskId: result.taskId, task: result.task, taskMd: relative(ctx.cwd, result.tp.taskMd), taskJson: relative(ctx.cwd, result.tp.taskJson), autoClosed: result.autoClosed });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_task_status",
		label: "Swarm Task Status",
		description: "Read task.json and summarize task/node/gate state. Optionally include artifact listing and runtime liveness/message warnings.",
		promptGuidelines: ["Use `swarm_task_status` to inspect assigned task state and current/ready nodes."],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id." }),
			includeArtifacts: Type.Optional(Type.Boolean({ description: "List declared artifacts and whether they exist. Defaults to false." })),
			runtime: Type.Optional(Type.Boolean({ description: "Include agent/message/liveness warnings from swarm state. Defaults to false." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const { task, tp, taskId } = await readTaskByRef(p, { taskId: params.taskId });
			const { ready, current } = computeReadyNodes(task);
			const summary = graphJsonSummary(task, ready, current);
			let artifacts: Array<{ path: string; exists: boolean }> | undefined;
			if (params.includeArtifacts) artifacts = collectDeclaredArtifacts(task).map((path) => ({ path, exists: existsSync(join(tp.root, path)) }));
			let runtimeWarnings: string[] | undefined;
			let closure: ReturnType<typeof computeTaskClosure> | undefined;
			if (params.runtime) {
				const st = await readState(p, ctx.cwd);
				runtimeWarnings = await runtimeTaskWarnings(pi, st, task);
				closure = computeTaskClosure(st, task, tp);
			}
			await traceTask(tp, "task.status.read", { taskId, includeArtifacts: Boolean(params.includeArtifacts), runtime: Boolean(params.runtime) });
			const closureBlock = closure
				? `\n\nClosure: storedStatus=${closure.storedStatus} derivedStatus=${closure.derivedStatus} closed=${closure.closedNodes}/${closure.nodeClosure.length} open=${closure.openNodes} stale=${closure.staleNodes}`
					+ (closure.openAssignments.length ? `\n  Open assignments: ${closure.openAssignments.map((a) => `${a.nodeId}→${a.assignee}(${a.status})`).join(", ")}` : "")
					+ (closure.staleAssignments.length ? `\n  Stale assignments: ${closure.staleAssignments.map((a) => `${a.nodeId}→${a.assignee} (${a.reason})`).join(", ")}` : "")
					+ (closure.blocking.length ? `\n  Task blockers: ${closure.blocking.join("; ")}` : "")
				: "";
			const text = printGraphText(task, ready, current, artifacts) + (runtimeWarnings?.length ? `\n\nRuntime warnings:\n${runtimeWarnings.map((w) => `  ⚠ ${w}`).join("\n")}` : "") + closureBlock;
			return textResult(text, { task: summary, taskId, artifacts, runtimeWarnings, closure });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_validate_graph",
		label: "Swarm Validate Graph",
		description: "Validate task/workflow structure (ids, edges, reachability, terminals, ambiguous branches, rework cycles, path safety) and optionally runtime consistency (agents, capacity, message acks).",
		promptGuidelines: ["Use `swarm_validate_graph` before/during execution to catch broken or inconsistent task graphs."],
		parameters: Type.Object({
			taskId: Type.Optional(Type.String({ description: "Task id." })),
			path: Type.Optional(Type.String({ description: "Direct path to a task.json." })),
			runtime: Type.Optional(Type.Boolean({ description: "Include agent/message/liveness checks. Defaults to false." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const { task, tp, taskId } = await readTaskByRef(p, { taskId: params.taskId, path: params.path });
			const { errors, warnings } = validateTaskGraph(task);
			let runtimeWarnings: string[] = [];
			if (params.runtime) {
				const st = await readState(p, ctx.cwd);
				runtimeWarnings = await runtimeTaskWarnings(pi, st, task);
			}
			const ok = errors.length === 0;
			await traceTask(tp, "task.validate", { taskId, ok, errors: errors.length, warnings: warnings.length, runtime: Boolean(params.runtime) });
			const lines: string[] = [];
			lines.push(`Validation: ${ok ? "PASS" : "FAIL"} (${errors.length} errors, ${warnings.length + runtimeWarnings.length} warnings)`);
			for (const e of errors) lines.push(`  ✗ ${e}`);
			for (const w of [...warnings, ...runtimeWarnings]) lines.push(`  ⚠ ${w}`);
			return textResult(lines.join("\n"), { taskId, ok, errors, warnings, runtimeWarnings });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_print_graph",
		label: "Swarm Print Graph",
		description: "Print a task graph as text, Mermaid, or JSON summary.",
		promptGuidelines: ["Use `swarm_print_graph` to visualize task graph state and handoffs."],
		parameters: Type.Object({
			taskId: Type.Optional(Type.String({ description: "Task id." })),
			path: Type.Optional(Type.String({ description: "Direct path to a task.json." })),
			format: Type.Optional(Type.String({ description: "text, mermaid, or json. Defaults to text." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const { task, tp, taskId } = await readTaskByRef(p, { taskId: params.taskId, path: params.path });
			const format = (params.format || "text").toLowerCase();
			const { ready, current } = computeReadyNodes(task);
			await traceTask(tp, "task.print", { taskId, format });
			if (format === "mermaid") return textResult(printGraphMermaid(task), { taskId, format });
			if (format === "json") return textResult(JSON.stringify(graphJsonSummary(task, ready, current), null, 2), { taskId, format, summary: graphJsonSummary(task, ready, current) });
			return textResult(printGraphText(task, ready, current), { taskId, format });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_next_nodes",
		label: "Swarm Next Nodes",
		description: "Compute ready/next nodes from task graph state and suggest a reusable agent per ready node. Read-only in V1 (assignment is handled by swarm_assign_task).",
		promptGuidelines: ["Use `swarm_next_nodes` to decide what work is ready next and which agent could take it."],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id." }),
			autoAssign: Type.Optional(Type.Boolean({ description: "Reserved for V1; suggestions are returned but assignment is not mutated." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const { task, tp, taskId } = await readTaskByRef(p, { taskId: params.taskId });
			const result = await withLock(p, async () => {
				const { ready, current } = computeReadyNodes(task);
				task.currentNodes = current;
				await writeTaskState(tp, task);
				return { ready, current };
			});
			const st = await readState(p, ctx.cwd);
			// Actionable = newly-ready nodes PLUS already-ready/assigned nodes that still have no assignee.
			// (computeReadyNodes only flags newly-activatable pending nodes as `ready`; a freshly created
			// task's start node is already in `ready` status and lands in `current`, so surface it here too.)
			const actionable = Array.from(new Set([
				...result.ready,
				...result.current.filter((id) => task.nodes[id] && task.nodes[id].status === "ready" && !task.nodes[id].assignee),
			]));
			const suggestions: Array<{ nodeId: string; role: string; suggestedAssignee?: string; candidates: ReusableAgentMatch[] }> = [];
			for (const nodeId of actionable) {
				const node = task.nodes[nodeId];
				const kind = inferRoleKind(nodeId, node.role);
				const found = await findReusableAgent(pi, st, { roleKind: kind, requireIdle: false, includeBusy: false, excludeTaskId: taskId });
				await trace(p, "agent.find", { taskId, nodeId, roleKind: kind, recommended: found.recommended, candidates: found.matches.length });
				suggestions.push({ nodeId, role: node.role, suggestedAssignee: found.recommended, candidates: found.matches });
			}
			await traceTask(tp, "task.next_nodes", { taskId, ready: result.ready, actionable, current: result.current, autoAssign: Boolean(params.autoAssign) });
			const lines: string[] = [`Ready: ${actionable.length ? actionable.join(", ") : "(none)"}`, `Current: ${result.current.length ? result.current.join(", ") : "(none)"}`];
			for (const s of suggestions) lines.push(`  ${s.nodeId} (${s.role}) -> ${s.suggestedAssignee || "(no reusable agent; spawn needed)"}`);
			return textResult(lines.join("\n"), { taskId, ready: actionable, current: result.current, suggestions, autoAssign: Boolean(params.autoAssign) });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_assign_task",
		label: "Swarm Assign Task",
		description: "Assign a task graph node to an agent: reuse an idle role-matching agent by default, optionally spawn, update node assignment state + activeTaskIds, and send a structured assignment message carrying taskId/nodeId/replyTarget. task.json is the source of truth. Orchestrator-level tool.",
		promptGuidelines: ["Use `swarm_assign_task` to assign a ready node; it reuses an idle role-matching agent unless autoSpawn/spawnIsolated is set. If it returns NODE_NOT_READY, call swarm_next_nodes first. If NO_AVAILABLE_AGENT, enable autoSpawn or pass an explicit agentId."],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id." }),
			nodeId: Type.String({ description: "Node id to assign." }),
			agentId: Type.Optional(Type.String({ description: "Exact existing agent id to assign to. Bypasses reuse lookup." })),
			reusePolicy: Type.Optional(Type.String({ description: "prefer_idle_existing (default). Reserved for future policies." })),
			autoSpawn: Type.Optional(Type.Boolean({ description: "Spawn a new long-lived role agent when no reusable agent exists. Defaults to false." })),
			spawnIsolated: Type.Optional(Type.Boolean({ description: "Force a fresh agent for this node instead of reusing. Defaults to false." })),
			replyTarget: Type.Optional(Type.String({ description: "Agent id the assignee should reply to. Defaults to the assigning agent (sender)." })),
			note: Type.Optional(Type.String({ description: "Optional extra assignment note appended to the message body." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			const me = currentAgentId();
			requireOrchestratorAuthority(me, "swarm_assign_task");
			const reusePolicy = params.reusePolicy || "prefer_idle_existing";
			let spawned = false;
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				heartbeatOrchestratorLeader(st, Date.now(), process.pid, "assign_task");
				const { task, tp } = await readTaskByRef(p, { taskId: params.taskId });
				const taskId = task.taskId;
				const node = task.nodes[params.nodeId];
				if (!node) await failTaskTool(tp, p, "TASK_NODE_NOT_FOUND", `Node ${params.nodeId} does not exist in task ${taskId}.`, { taskId, nodeId: params.nodeId, expected: { validNodes: Object.keys(task.nodes) }, received: { nodeId: params.nodeId }, actionableHint: "Valid node ids are listed in task.json. Run swarm_task_status or swarm_graph to inspect." });
				if (TERMINAL_NODE_STATUSES.has(node.status)) await failTaskTool(tp, p, "INVALID_TRANSITION", `Node ${params.nodeId} is terminal (${node.status}); cannot assign.`, { taskId, nodeId: params.nodeId, received: { nodeStatus: node.status } });
				// Readiness: assignable when actionable (ready, or unassigned ready-status current) or already active (reassign).
				const cr = computeReadyNodes(task);
				const actionable = new Set([...cr.ready, ...cr.current.filter((id) => task.nodes[id].status === "ready" && !task.nodes[id].assignee)]);
				if (node.status === "pending" && !actionable.has(params.nodeId)) await failTaskTool(tp, p, "NODE_NOT_READY", `Node ${params.nodeId} is not ready yet (dependencies/gates not satisfied).`, { taskId, nodeId: params.nodeId, expected: { ready: cr.ready, current: cr.current }, received: { nodeStatus: node.status }, suggestedNextCall: { tool: "swarm_next_nodes", params: { taskId } }, actionableHint: "The node's dependencies have not all reached a terminal state. Run swarm_task_status to inspect the blocking nodes, or wait for the orchestrator to advance the graph." });

				ensureOrchestrator(st, ctx.cwd, p);
				const expectedKind = inferRoleKind(params.nodeId, node.role);
				let candidates: ReusableAgentMatch[] = [];
				let assigneeId: string | undefined;
				if (params.agentId) {
					const aid = safeId(params.agentId);
					if (!st.agents[aid]) await failTaskTool(tp, p, "AGENT_NOT_FOUND", `Agent ${aid} is not registered.`, { taskId, nodeId: params.nodeId, received: { agentId: aid }, suggestedNextCall: { tool: "swarm_spawn_agent", params: { id: aid, role: node.role } } });
					assigneeId = aid;
				} else if (expectedKind === "orchestrator") {
					// Orchestrator-role nodes (e.g. commit) are owned by the orchestrator pseudo-agent.
					assigneeId = "orchestrator";
				} else {
					const found = await findReusableAgent(pi, st, { roleKind: expectedKind, requireIdle: false, requireTmuxAlive: false, includeBusy: false, excludeTaskId: taskId });
					candidates = found.matches;
					if (found.recommended) assigneeId = found.recommended;
					else if (params.autoSpawn || params.spawnIsolated) { const r = await spawnAgent(pi, ctx.cwd, p, st, { id: `${expectedKind}-01`, role: node.role }); assigneeId = r.agent.id; spawned = true; }
					else await failTaskTool(tp, p, "NO_AVAILABLE_AGENT", `No reusable ${expectedKind} agent for node ${params.nodeId}.`, { taskId, nodeId: params.nodeId, expected: { roleKind: expectedKind }, received: { reusePolicy }, suggestedNextCall: { tool: "swarm_assign_task", params: { taskId, nodeId: params.nodeId, autoSpawn: true } } });
				}
				const assignee = assigneeId ? st.agents[assigneeId] : undefined;
				if (!assignee) await failTaskTool(tp, p, "AGENT_NOT_FOUND", `Resolved agent is missing for node ${params.nodeId}.`, { taskId, nodeId: params.nodeId, received: { agentId: assigneeId } });
				ensureAgentDefaults(assignee);

				// ---- Preflight auto-clear (Issue 16) ----
				// When this assign resolves to a freshly-spawned agent AND the caller is the same
				// orchestrator session that armed the spawn entry AND the spawn was within the grace
				// window, cancel the orphan watchdog early so a slow assign never trips the warning.
				// This is a no-op when any predicate fails — true orphans and cross-orchestrator
				// assigns fall through to the normal timer path. The delivery-side
				// clearReason='swarm_assign_task' backstop inside deliverMessageLocked remains intact.
				if (Array.isArray(st.recentSpawns) && st.recentSpawns.length > 0) {
					const entry = st.recentSpawns.find((s) => s.agentId === assignee.id);
					if (entry) {
						const ageMs = Date.now() - new Date(entry.spawnedAt).getTime();
						const callerLeader = { pid: process.pid, sessionStartedAt: process.env.PI_SWARM_SESSION_STARTED_AT || undefined };
						if (ageMs < PREFLIGHT_ASSIGN_GRACE_MS && isSameOrchestratorLeader(entry, callerLeader)) {
							await clearOrphanWatch(p, st, assignee.id, "swarm_assign_task", "preflight");
						}
					}
				}

				// ---- File-scope ownership preflight (roadmap issue 4) ----
				// Before ANY mutation: compute the candidate node's effective write scope and compare it
				// against every ACTIVE lease across all task.json files (scan under the same lock). A conflict
				// fails with ACTIVE_SCOPE_CONFLICT and leaves task.json / swarm-state.json / mailboxes untouched.
				// Self-exclusion: the candidate node's own current active lease is skipped so idempotent
				// retries and same-node reassignment never conflict with themselves.
				const candidateScope: EffectiveScope = resolveNodeScope(task, params.nodeId);
				{
					let conflict: { lease: { taskId: string; nodeId: string; assignee: string; attemptId: string; scope: EffectiveScope }; relation: string } | null = null;
					let entries: string[] = [];
					try { entries = await readdir(p.tasksDir); } catch {}
					outer: for (const entry of entries) {
						const otherTp = taskPaths(p, entry);
						if (!existsSync(otherTp.taskJson)) continue;
						let other: TaskState;
						try { other = await readTaskState(otherTp.taskJson); } catch { continue; }
						for (const lease of collectActiveLeases(other)) {
							if (lease.taskId === taskId && lease.nodeId === params.nodeId) continue; // self-exclusion
							const rel = scopesOverlap(candidateScope, lease.scope);
							if (rel.overlap) { conflict = { lease, relation: rel.relation }; break outer; }
						}
					}
					if (conflict) {
						const rel = scopesOverlap(candidateScope, conflict.lease.scope) as { relation: string };
						const reqFiles = "unresolved" in candidateScope ? [`(unresolved: ${candidateScope.reason})`] : candidateScope.files;
						const confFiles = "unresolved" in conflict.lease.scope ? [`(unresolved: ${conflict.lease.scope.reason})`] : conflict.lease.scope.files;
						const reqSource = "unresolved" in candidateScope ? "unresolved" : candidateScope.source;
						const confSource = "unresolved" in conflict.lease.scope ? "unresolved" : conflict.lease.scope.source;
						await traceTask(tp, "task.assign.conflict", {
							taskId, nodeId: params.nodeId, requestedAssignee: assignee.id, requestedScope: reqFiles, requestedScopeSource: reqSource,
							conflictingTaskId: conflict.lease.taskId, conflictingNodeId: conflict.lease.nodeId,
							conflictingAssignee: conflict.lease.assignee, conflictingAttemptId: conflict.lease.attemptId,
							conflictingScope: confFiles, conflictingScopeSource: confSource, relation: rel.relation,
						});
						await failTaskTool(tp, p, "ACTIVE_SCOPE_CONFLICT",
							`Cannot assign node ${params.nodeId} of ${taskId}: its write scope overlaps the active assignment of node ${conflict.lease.nodeId} in task ${conflict.lease.taskId} (attempt ${conflict.lease.attemptId}, held by ${conflict.lease.assignee}). No state was modified.`,
							{
								taskId, nodeId: params.nodeId,
								requestedAssignee: assignee.id, requestedScope: reqFiles, requestedScopeSource: reqSource,
								conflictingTaskId: conflict.lease.taskId, conflictingNodeId: conflict.lease.nodeId,
								conflictingAssignee: conflict.lease.assignee, conflictingAttemptId: conflict.lease.attemptId,
								conflictingScope: confFiles, conflictingScopeSource: confSource, relation: rel.relation,
								actionableHint: `Wait for node ${conflict.lease.nodeId} of ${conflict.lease.taskId} to reach a terminal state (its lease is released then), or narrow this node's allowedFiles so the write scopes are disjoint (e.g. a node-scoped file list instead of the task-wide default).`,
							}
						);
					}
				}
				// ---- end ownership preflight ----

				const prevStatus = node.status;
				// Reassignment bookkeeping: free the previous assignee's active-task pointer.
				if (node.assignee && node.assignee !== assignee.id) {
					const old = st.agents[node.assignee];
					if (old) { ensureAgentDefaults(old); old.activeTaskIds = old.activeTaskIds.filter((t) => t !== task.taskId); }
				}
				// Count a fresh work attempt when (re)entering assigned from a non-active state.
				const isNewAttempt = ["pending", "ready", "blocked"].includes(prevStatus);
				if (isNewAttempt) {
					if (node.maxAttempts && node.attempts >= node.maxAttempts) await failTaskTool(tp, p, "INVALID_TRANSITION", `Node ${params.nodeId} reached maxAttempts (${node.maxAttempts}); cannot reassign.`, { taskId, nodeId: params.nodeId, received: { attempts: node.attempts, maxAttempts: node.maxAttempts } });
					node.attempts += 1;
				}

				// Mint or reuse the attempt (Issue 24.a B5 — extracted helper). The helper inspects the
				// prior state and returns { attemptId, created: false } when the existing active attempt
				// can be preserved (duplicate retry), or { attemptId, created: true } on a genuine mint
				// (which has already superseded any prior active attempt in-place).
				const minted = mintNodeAttempt({ node, assignee: assignee.id, candidateScope, reason: "assign" });
				const attemptId = minted.attemptId;
				if (!minted.created) {
					await traceTask(tp, "task.attempt.reused", { taskId, nodeId: params.nodeId, attemptId, assignee: assignee.id, reason: "duplicate_assignment_retry" });
				} else {
					// The helper already superseded the prior attempt (if any); emit the audit trace
					// here so the caller sees one canonical "superseded" event per supersede.
					const priorSuperseded = (node.attemptHistory || []).find((a: any) => a.supersededBy === attemptId && a.status === "superseded");
					if (priorSuperseded) {
						await traceTask(tp, "task.attempt.superseded", { taskId, nodeId: params.nodeId, priorAttemptId: priorSuperseded.attemptId, supersededBy: attemptId, reason: "reassign" });
					}
					await traceTask(tp, "task.attempt.minted", { taskId, nodeId: params.nodeId, attemptId, assignee: assignee.id, reason: "assign" });
				}
				node.assignee = assignee.id;
				node.status = "assigned";
				node.lastActivityAt = now();
				if (node.staleAt) { const prevStaleAt = node.staleAt; delete node.staleAt; await traceTask(tp, "task.stale.cleared", { taskId, nodeId: params.nodeId, prevStaleAt, reason: "assign", by: currentAgentId() }); }
				if (!assignee.activeTaskIds.includes(task.taskId)) assignee.activeTaskIds.push(task.taskId);
				applyTaskStatus(task);
				task.currentNodes = computeReadyNodes(task).current;
				// Issue 23 — resolve any stalled task-stall counter for this task (an actionable node
				// now has an assignee, so the predicate is no longer satisfied).
				resolveTaskStallLocked(p, st, task.taskId, "assigned");

				const replyTarget = params.replyTarget || me;
				const conversationId = `task:${task.taskId}:${params.nodeId}`;
				const body = buildAssignmentBody(task, params.nodeId, replyTarget, params.note, attemptId);
				// Deterministic idempotency key: same task/node/assignee/attempt -> same message (no duplicate on retry).
				const idempotencyKey = `assign:${task.taskId}:${params.nodeId}:${assignee.id}:${node.attempts}`;
				// Lifecycle-fencing (issue 9, site 8, defense-in-depth): per-node staleness check right
				// before delivering the assignment message. By construction the just-mutated node is
				// fresh, so this is a defensive belt-and-suspenders check that catches (a) a task that
				// became terminal between the readiness gate and here, or (b) any future caller mutation
				// sequence that leaves the node in an inconsistent state. The assignment record still
				// mutates (the worker holds the lease) but the canonical assignment message is suppressed
				// and replaced with an informational fence trace.
				const assignStaleCheck = checkStallNotificationStale(st, task, params.nodeId, assignee.id, Date.now());
				if (assignStaleCheck.stale) {
					await traceTask(tp, "notification.stale.suppressed", { site: "swarm_assign_task.assignment", taskId, nodeId: params.nodeId, reason: assignStaleCheck.reason, evidence: assignStaleCheck.evidence });
					const fencedKey = `${idempotencyKey}:fenced`;
					const { msg: fmsg, delivery: fdelivery } = await deliverMessageLocked(pi, ctx.cwd, p, st, { to: assignee.id, body: `Assignment to node ${params.nodeId} of ${task.taskId} is stale (${assignStaleCheck.reason}: ${assignStaleCheck.evidence.join("; ")}). The assignment record persists but no canonical assignment message was sent.`, subject: `Task ${task.taskId} / node ${params.nodeId} assignment FENCED`, conversationId, requiresAck: false, requiresResponse: false, idempotencyKey: fencedKey, clearReason: "swarm_assign_task" });
					const activeAttemptFenced = node.attemptHistory?.find((a: any) => a.attemptId === attemptId);
					if (activeAttemptFenced) activeAttemptFenced.assignmentMessageId = fmsg.id;
					node.assignmentMessageId = fmsg.id;
					node.messageIds = Array.from(new Set([...(node.messageIds || []), fmsg.id]));
					task.handoffs.push({ fromNode: null, toNode: params.nodeId, by: me, toAgent: assignee.id, messageId: fmsg.id, at: now(), kind: "assign", status: fdelivery?.delivered ? (fdelivery.mailboxOnly ? "mailbox_only" : "delivered") : "queued", fenced: true });
					await writeTaskState(tp, task);
					await writeState(p, st);
					await traceTask(tp, "task.assign.fenced", { taskId, nodeId: params.nodeId, assignee: assignee.id, messageId: fmsg.id, reason: assignStaleCheck.reason });
					return { task, tp, msg: fmsg, delivery: fdelivery, candidates, assigneeId: assignee.id, fenced: true, reason: assignStaleCheck.reason };
				}
				const { msg, delivery } = await deliverMessageLocked(pi, ctx.cwd, p, st, { to: assignee.id, body, subject: `Task ${task.taskId} / node ${params.nodeId} assigned`, conversationId, requiresAck: true, requiresResponse: true, idempotencyKey, clearReason: "swarm_assign_task" });
				// Update attempt record with the actual message ID
				const activeAttempt = node.attemptHistory?.find((a: any) => a.attemptId === attemptId);
				if (activeAttempt) activeAttempt.assignmentMessageId = msg.id;
				// Canonical current-assignment pointer (set on both new and idempotent-reuse).
				node.assignmentMessageId = msg.id;
				let supersededIds: string[] = [];
				if (!delivery?.reused) {
					// A genuinely new assignment supersedes prior OPEN assignments for this node (e.g. after stale repair / reassign).
					supersededIds = await supersedeOpenAssignments(p, st, task, params.nodeId, msg.id, me);
					node.messageIds = Array.from(new Set([...(node.messageIds || []), msg.id]));
					task.handoffs.push({ fromNode: null, toNode: params.nodeId, by: me, toAgent: assignee.id, messageId: msg.id, at: now(), kind: "assign", status: delivery?.delivered ? (delivery.mailboxOnly ? "mailbox_only" : "delivered") : "queued" });
				}

				await writeTaskState(tp, task);
				await writeState(p, st);
				await traceTask(tp, "task.assign", { taskId, nodeId: params.nodeId, assignee: assignee.id, messageId: msg.id, spawned, reusePolicy, prevStatus, delivered: Boolean(delivery?.delivered), mailboxOnly: Boolean(delivery?.mailboxOnly), reused: Boolean(delivery?.reused), superseded: supersededIds.length });
				return { task, tp, msg, delivery, candidates, assigneeId: assignee.id };
			});
			const delivery = result.delivery;
			const injected = Boolean(delivery?.delivered) && !delivery?.mailboxOnly;
			const fencedSuffix = (result as any).fenced ? ` Message ${result.msg.id} FENCED (${(result as any).reason}) — informational trace only.` : "";
			return textResult(`Assigned node ${params.nodeId} of ${result.task.taskId} to ${result.assigneeId}${spawned ? " (spawned)" : ""}. Message ${result.msg.id} ${delivery?.delivered ? (delivery.mailboxOnly ? "queued (mailbox-only)" : "delivered") : "queued (agent not running; reconcile will retry)"}.${fencedSuffix}`, { taskId: result.task.taskId, nodeId: params.nodeId, assignee: result.assigneeId, spawned, messageId: result.msg.id, injected, delivery, candidates: result.candidates, fenced: Boolean((result as any).fenced), reason: (result as any).reason ?? null });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_update_task",
		label: "Swarm Update Task",
		description: "Update an assigned task node's status/outcome/note/artifact/gate/sharedContext. Enforces ownership (current agent must be the node assignee, or orchestrator via force) and allowed lifecycle transitions; releases activeTaskIds + editLocks on terminal-ish node states. Validation precedes any write, so invalid calls leave task.json untouched.",
		promptGuidelines: ["Use `swarm_update_task` to advance YOUR assigned node. If NODE_ASSIGNEE_MISMATCH, send a task message to the assignee instead of forcing. If OUTCOME_REQUIRED (node done with outgoing branches), retry with an outcome matching an edge `when`. If INVALID_TRANSITION, follow pending->ready->assigned->in_progress->done|failed|blocked; terminal states need the orchestrator force override."],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id." }),
			nodeId: Type.String({ description: "Node id to update." }),
			status: Type.Optional(Type.String({ description: "New node status: pending/ready/assigned/in_progress/blocked/done/failed/skipped." })),
			outcome: Type.Optional(Type.String({ description: "Branch signal (e.g. planned/implemented/passed/failed/approved/rejected). Required when moving to done on a node with outgoing edges." })),
			note: Type.Optional(Type.String({ description: "Free-text update note (traced with the update)." })),
			artifact: Type.Optional(Type.String({ description: "Artifact path produced/referenced by this update (e.g. artifacts/review.md)." })),
			gateUpdates: Type.Optional(Type.Record(Type.String(), Type.Object({ status: Type.String({ description: "open/passed/failed/waived" }), by: Type.Optional(Type.String()), artifact: Type.Optional(Type.String()) }))),
			sharedContextUpdates: Type.Optional(Type.Object({
				summary: Type.Optional(Type.String()),
				decisions: Type.Optional(Type.Array(Type.Object({ text: Type.String(), severity: Type.Optional(Type.String()) }))),
				risks: Type.Optional(Type.Array(Type.Object({ text: Type.String(), severity: Type.Optional(Type.String()) }))),
				openQuestions: Type.Optional(Type.Array(Type.Object({ text: Type.String() }))),
			})),
			force: Type.Optional(Type.Boolean({ description: "Orchestrator override: skip ownership + transition checks. Defaults to false." })),
			cancelTask: Type.Optional(Type.Boolean({ description: "Orchestrator-only (requires force): mark the whole task cancelled. Sticky: a cancelled task stays cancelled and releases all assignments. Defaults to false." })),
			attemptId: Type.Optional(Type.String({ description: "Opaque attempt token received in assignment. Required for non-orchestrator callers when node has an active attempt. Prevents stale updates from superseded attempts." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			const me = currentAgentId();
			const isOrch = isOrchestratorAuthority(me);
			// Server-side RBAC (reliability-roadmap Phase 1, P0 #1): `force` and `cancelTask` are
			// orchestrator-only escape hatches. Identity is checked against the live agent record; the
			// caller's params cannot grant authority. Validation precedes any state mutation.
			if (params.cancelTask === true) {
				if (!isOrchestratorAuthority(me)) {
					await trace(p, "task.rbac.cancel_forbidden", { taskId: params.taskId, caller: me, by: me });
					throw new Error(`CANCEL_FORBIDDEN: swarm_update_task(cancelTask=true) requires orchestrator authority (caller=${me}). Only the orchestrator may cancel a task.`);
				}
				if (params.force !== true) {
					throw new Error(`CANCEL_REQUIRES_FORCE: cancelTask=true must accompany force=true (orchestrator-only operation).`);
				}
			}
			if (params.force === true && !isOrchestratorAuthority(me)) {
				await trace(p, "task.rbac.force_forbidden", { taskId: params.taskId, nodeId: params.nodeId, caller: me, by: me });
				throw new Error(`FORCE_FORBIDDEN: swarm_update_task(force=true) requires orchestrator authority (caller=${me}). Only the orchestrator may bypass ownership/transition checks.`);
			}
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				if (isOrch) heartbeatOrchestratorLeader(st, Date.now(), process.pid, "update_task");
				const { task, tp } = await readTaskByRef(p, { taskId: params.taskId });
				const taskId = task.taskId;
				const node = task.nodes[params.nodeId];
				if (!node) await failTaskTool(tp, p, "TASK_NODE_NOT_FOUND", `Node ${params.nodeId} does not exist in task ${taskId}.`, { taskId, nodeId: params.nodeId, expected: { validNodes: Object.keys(task.nodes) }, received: { nodeId: params.nodeId }, actionableHint: "Valid node ids are listed in task.json. Run swarm_task_status or swarm_graph to inspect." });
				// Cancellation fence (issue 3, fix-1): once a task is cancelled, NO caller — not even the
				// orchestrator — can mutate task or node state via this handler. The fence is the most
				// authoritative gate and runs BEFORE ownership/attempt checks so task cancellation
				// deterministically wins for any late worker mutation (a worker that isn't even the
				// assignee still gets TASK_CANCELLED, not NODE_ASSIGNEE_MISMATCH, on a cancelled task).
				// Re-open is a separately-designed policy (out of scope for this PR). Allow the
				// cancelTask request itself through (the only mutation that returns ok on a cancelled
				// task is a redundant cancel — handled below by checking `params.cancelTask` after the
				// fence).
				if (isTaskOrNodeCancelled(task, params.nodeId) && !params.cancelTask) {
					const where = task.status === "cancelled" ? `Task ${taskId} is cancelled` : `Node ${params.nodeId} of task ${taskId} is cancelled`;
					await traceTask(tp, "task.cancel.fenced", { taskId, nodeId: params.nodeId, by: me, requestedStatus: params.status });
					await failTaskTool(tp, p, task.status === "cancelled" ? "TASK_CANCELLED" : "NODE_CANCELLED",
						`${where}. No further task or node updates are accepted. To re-open, the orchestrator must explicitly restore the task via a separately-designed policy (out of scope).`,
						{ taskId, nodeId: params.nodeId, taskStatus: task.status, nodeStatus: node.status, blocked: true, suggestedNextCall: { tool: "swarm_task_status", params: { taskId } } }
					);
				}

				if (!isOrch && node.assignee !== me) {
					// Issue 24.a — node ownership self-heal: when node.assignee is undefined AND the node
					// is non-terminal-and-non-`in_progress`, allow the caller to CLAIM the node. The
					// claim branch unconditionally stamps status="assigned" + assignee=me (per the B6
					// committed strategy: no hybrid ready+assignee state). If the node is in flight
					// without an assignee (rare reassign-drift), refuse with OWNERSHIP_REQUIRED.
					if (node.assignee === undefined && node.status !== "in_progress" && !TERMINAL_NODE_STATUSES.has(node.status)) {
						const priorStatus = node.status;
						const candidateScope = resolveNodeScope(task, params.nodeId);
						// B5 + B6 — bump node.attempts first (mirrors swarm_assign_task path) so the
						// minted attempt carries the right attemptNumber after a rework reopen
						// (node.attempts is preserved across rework). The helper reads node.attempts
						// at mint time, so the bump must happen first.
						if (["pending", "ready", "blocked"].includes(node.status)) {
							node.attempts += 1;
						}
						const minted = mintNodeAttempt({ node, assignee: me, candidateScope, reason: "claim" });
						const attemptId = minted.attemptId;
						if (!minted.created) {
							await traceTask(tp, "task.attempt.reused", { taskId, nodeId: params.nodeId, attemptId, assignee: me, reason: "duplicate_claim_retry" });
						} else {
							const priorSuperseded = (node.attemptHistory || []).find((a: any) => a.supersededBy === attemptId && a.status === "superseded");
							if (priorSuperseded) {
								await traceTask(tp, "task.attempt.superseded", { taskId, nodeId: params.nodeId, priorAttemptId: priorSuperseded.attemptId, supersededBy: attemptId, reason: "claim" });
							}
							await traceTask(tp, "task.attempt.minted", { taskId, nodeId: params.nodeId, attemptId, assignee: me, reason: "claim" });
						}
						node.assignee = me;
						node.status = "assigned";
						node.lastActivityAt = now();
						if (node.staleAt) { const prevStaleAt = node.staleAt; delete node.staleAt; await traceTask(tp, "task.stale.cleared", { taskId, nodeId: params.nodeId, prevStaleAt, reason: "claim", by: me }); }
						// B7 — explicit activeTaskIds update on the claimer. Mirror the
						// swarm_assign_task path so the claimer's runtimeStatus / capacity accounting
						// doesn't drift. ensureAgentDefaults is belt-and-braces for legacy agents
						// that lack the array.
						if (!st.agents[me]) {
							// Worker claimed a node without ever being registered. Create a minimal
							// agent record so capacity accounting + tool surfaces work; the orchestrator
							// can re-register with full details (model/provider/role) later.
							st.agents[me] = {
								id: me, role: "", roleKind: "worker", capabilities: [],
								activeTaskIds: [], maxConcurrentTasks: 1,
								status: "running", runtimeStatus: "busy", health: "healthy",
								tmuxSession: st.tmuxSession, tmuxWindow: "", tmuxTarget: "unknown",
								model: "", provider: "",
								cwd: ctx.cwd, mailbox: `.pi/swarm/mailboxes/${me}.jsonl`,
								createdAt: now(), updatedAt: now(),
							};
						}
						ensureAgentDefaults(st.agents[me]);
						if (!st.agents[me].activeTaskIds.includes(task.taskId)) st.agents[me].activeTaskIds.push(task.taskId);
						applyTaskStatus(task);
						task.currentNodes = computeReadyNodes(task).current;
						// Issue 23 — claim resolves any stalled task-stall counter.
						resolveTaskStallLocked(p, st, task.taskId, "claim");
						await writeTaskState(tp, task);
						await writeState(p, st);
						await traceTask(tp, "task.node.claimed", { taskId, nodeId: params.nodeId, claimer: me, priorAssignee: null, priorStatus, attemptId, created: minted.created });
						// Inject the freshly minted attemptId so the attempt-fencing check below
						// (which runs unconditionally for nodes with activeAttemptId) accepts the
						// claimer's continuation. Without this, the caller would have to supply
						// attemptId explicitly even though we just minted it.
						if (!params.attemptId) params.attemptId = attemptId;
					} else if (node.assignee === undefined && node.status === "in_progress") {
						// Issue 24.a — in-flight unassigned node: refuse with inline-string
						// OWNERSHIP_REQUIRED. Per B2, this is scoped to one tool + one path, not a
						// ERR_* engine-wide constant. The hint points the caller at the orchestrator.
						await traceTask(tp, "task.update.ownership_reject", { taskId, nodeId: params.nodeId, attemptedBy: me, priorAssignee: null, priorStatus: node.status, isOrchestrator: false, remediation: "escalate_to_orchestrator", errorCode: "OWNERSHIP_REQUIRED" });
						await failTaskTool(tp, p, "OWNERSHIP_REQUIRED",
							`Node ${params.nodeId} is in_progress but has no assignee; claiming an in-flight node is forbidden.`,
							{
								taskId, nodeId: params.nodeId,
								expected: { assigneeRequired: true, allowedAction: "ask orchestrator to reassign via swarm_assign_task(..., force=true) or close the in-flight node" },
								received: { agentId: me, requestedStatus: params.status, nodeStatus: node.status },
								severity: "error",
								suggestedNextCall: { tool: "swarm_send_message", params: { to: "orchestrator", subject: `Reassign in-flight node ${params.nodeId} of ${taskId}` } },
							}
						);
					} else {
						// Existing reject path: node.assignee is set and !== me.
						await traceTask(tp, "task.update.ownership_reject", { taskId, nodeId: params.nodeId, attemptedBy: me, priorAssignee: node.assignee || null, priorStatus: node.status, isOrchestrator: false, remediation: "escalate_to_orchestrator", errorCode: "NODE_ASSIGNEE_MISMATCH" });
						const hint = `Send a task message to the assignee (${node.assignee}), or ask the orchestrator to reassign (swarm_assign_task, force=true).`;
						await failTaskTool(tp, p, "NODE_ASSIGNEE_MISMATCH",
							`Node ${params.nodeId} is assigned to ${node.assignee || "(unassigned)"}, but current agent is ${me}.`,
							{ taskId, nodeId: params.nodeId, expected: { assignee: node.assignee || null, allowedAction: "update your own assigned node or send a task message" }, received: { agentId: me, requestedStatus: params.status }, actionableHint: hint }
						);
					}
				}

				// NEW: Attempt fencing validation (same-agent reassign protection)
				// This is the critical fix: caller must present the active attempt token to fence stale updates
				if (node.activeAttemptId) {
					if (!isOrch) {
						// Non-orchestrator callers must provide attempt token for nodes with active attempts
						if (!params.attemptId) {
							await failTaskTool(tp, p, "ATTEMPT_TOKEN_REQUIRED", `Node ${params.nodeId} has active attempt fencing. You must provide the attemptId parameter from your assignment contract.`, { taskId, nodeId: params.nodeId, expected: { attemptId: node.activeAttemptId }, received: { attemptId: params.attemptId || "(missing)" }, suggestedNextCall: { tool: "swarm_update_task", params: { ...params, attemptId: node.activeAttemptId } }, actionableHint: "The attempt token is delivered with your assignment message — check your mailbox if you don't have it." });
						}
						// Verify the attempt token matches the active attempt (untrusted input validation)
						if (params.attemptId !== node.activeAttemptId) {
							// Find the attempt for error context
							const providedAttempt = node.attemptHistory?.find((a: any) => a.attemptId === params.attemptId);
							const providedStatus = providedAttempt ? providedAttempt.status : "unknown";
							const activeAttempt = node.attemptHistory?.find((a: any) => a.attemptId === node.activeAttemptId);
							const activeNumber = activeAttempt ? activeAttempt.attemptNumber : "?";
							
							await failTaskTool(tp, p, "ATTEMPT_TOKEN_MISMATCH", `Your attempt token ${params.attemptId} is not the active attempt for node ${params.nodeId}. Your attempt is ${providedStatus}; the current attempt is #${activeNumber} (${node.activeAttemptId}). This update is rejected as a stale write.`, { taskId, nodeId: params.nodeId, expected: { activeAttemptId: node.activeAttemptId, activeAttemptNumber: activeNumber }, received: { attemptId: params.attemptId, attemptStatus: providedStatus }, blocked: true, actionableHint: "Your attempt has been superseded by a new assignment. Read the latest message in your mailbox (or call swarm_next_nodes to see the current assignment) before retrying." });
						}
						
						// Verify the attempt record exists and is valid
						const activeAttempt = node.attemptHistory?.find((a: any) => a.attemptId === node.activeAttemptId);
						if (!activeAttempt) {
							await failTaskTool(tp, p, "ATTEMPT_NOT_FOUND", `Active attempt ${node.activeAttemptId} not found in attempt history for node ${params.nodeId}. State is corrupted; this is a data integrity error.`, { taskId, nodeId: params.nodeId, expected: { activeAttemptId: node.activeAttemptId }, received: { attemptHistorySize: node.attemptHistory?.length || 0 }, severity: "critical" });
						}
						if (activeAttempt.status !== "active") {
							await failTaskTool(tp, p, "ATTEMPT_NOT_ACTIVE", `Attempt ${node.activeAttemptId} is not active (status=${activeAttempt.status}) for node ${params.nodeId}. This is a state inconsistency.`, { taskId, nodeId: params.nodeId, expected: { status: "active" }, received: { status: activeAttempt.status }, severity: "critical" });
						}
						// Verify caller is the active attempt's assignee (additional guard beyond assignee check)
						if (activeAttempt.assignee !== me) {
							await failTaskTool(tp, p, "ATTEMPT_ASSIGNEE_MISMATCH", `Active attempt ${activeAttempt.attemptId} is assigned to ${activeAttempt.assignee}, not ${me}.`, { taskId, nodeId: params.nodeId, expected: { assignee: activeAttempt.assignee }, received: { agentId: me }, blocked: true });
						}
					} else {
						// Orchestrator with force: attempt check is bypassed (force override)
						await traceTask(tp, "task.attempt.bypassed", { taskId, nodeId: params.nodeId, activeAttemptId: node.activeAttemptId, by: me, reason: "orchestrator_force" });
					}
				} else if (!node.activeAttemptId && (!node.attemptHistory || node.attemptHistory.length === 0)) {
					// Legacy task: no attempt fencing, fall back to existing assignee check only
					// Log a migration hint but don't fail
					await traceTask(tp, "task.legacy_attempt", { taskId, nodeId: params.nodeId, hint: "Node has no attempt history - using legacy assignee check only. First assignment will create attempt records." });
				}
				// End attempt fencing validation

				if (params.artifact && !isSafeRelativePath(params.artifact)) await failTaskTool(tp, p, "PATH_OUTSIDE_TASK", `Artifact path is unsafe (must be relative, no ..): ${params.artifact}`, { taskId, nodeId: params.nodeId, received: { artifact: params.artifact } });

				const prevStatus = node.status;
				const newStatus = (params.status as TaskNodeStatus | undefined) || prevStatus;
				if (newStatus !== prevStatus && !isOrch && !isAllowedNodeTransition(prevStatus, newStatus)) await failTaskTool(tp, p, "INVALID_TRANSITION", `Node ${params.nodeId} cannot move ${prevStatus} -> ${newStatus}.`, { taskId, nodeId: params.nodeId, expected: { lifecycle: "pending->ready->assigned->in_progress->done|failed|blocked; terminal states need orchestrator override" }, received: { from: prevStatus, to: newStatus }, actionableHint: "If you believe the transition should be allowed, escalate to the orchestrator (force=true)." });
				const outEdges = task.edges.filter((e) => e.from === params.nodeId);
				if (newStatus === "done" && outEdges.length && !params.outcome && !node.outcome) await failTaskTool(tp, p, "OUTCOME_REQUIRED", `Node ${params.nodeId} has outgoing branches but no outcome was provided.`, { taskId, nodeId: params.nodeId, expected: { validOutcomes: [...new Set(outEdges.map((e) => e.when))] }, received: { outcome: params.outcome }, suggestedNextCall: { tool: "swarm_update_task", params: { taskId, nodeId: params.nodeId, status: "done", outcome: outEdges[0].when } } });

				// Validation complete; apply (no earlier writes occurred).
				node.status = newStatus;
				if ((newStatus === "assigned" || newStatus === "in_progress" || newStatus === "ready") && node.staleAt) { delete node.staleAt; }
				if (params.outcome !== undefined) node.outcome = params.outcome;
				node.lastActivityAt = now();

				// NEW: Update attempt status on terminal node state
				if (node.activeAttemptId && node.attemptHistory && (newStatus === "done" || newStatus === "failed" || newStatus === "skipped")) {
					const activeAttempt = node.attemptHistory.find((a: any) => a.attemptId === node.activeAttemptId);
					if (activeAttempt && activeAttempt.status === "active") {
						activeAttempt.status = newStatus === "done" ? "completed" : newStatus;
						activeAttempt.outcome = params.outcome || node.outcome || undefined;
						activeAttempt.lastActivityAt = now();
						// Lease release audit (issue 4): terminal attempt ends its write-scope lease.
						activeAttempt.releasedAt ||= now();
						activeAttempt.releaseReason = isOrch ? "orchestrator_override" : "terminal";
						await traceTask(tp, "task.attempt.terminal", { taskId, nodeId: params.nodeId, attemptId: node.activeAttemptId, status: activeAttempt.status, outcome: activeAttempt.outcome });
					}
				}

				if (params.gateUpdates) applyGateUpdates(task, params.gateUpdates as Record<string, { status: TaskGateStatus; by?: string; artifact?: string | null }>, me);
				if (params.sharedContextUpdates) applySharedContextUpdates(task, params.sharedContextUpdates as { summary?: string; decisions?: Array<{ text: string; severity?: string }>; risks?: Array<{ text: string; severity?: string }>; openQuestions?: Array<{ text: string }> }, me);
				if (params.artifact) node.writeArtifacts = Array.from(new Set([...(node.writeArtifacts || []), params.artifact]));
				releaseNodeAssignment(st, task, params.nodeId);
				const reopened = activateReworkNodes(task);
				const closingAssignee = node.assignee || undefined; // persisted on the node (not cleared by release)
				// Orchestrator-explicit cancellation (issue 3): sticky terminal state. Strengthened to:
				//   1. mark every active attempt in the task as `cancelled` (revoke the lease)
				//   2. supersede every assignment-class message (waive response debt; late ACKs rejected)
				//   3. transition every non-terminal node to `cancelled` so worker-side attempts fencing
				//      + read-only task/graph renders reflect the new state immediately
				//   4. notify each assignee (informational, requiresAck:false)
				// applyTaskStatus preserves an existing `cancelled`, so we set it here and the rest of the
				// derive path leaves it alone. releaseTaskFromAllAgents clears every assignee's activeTaskIds.
				const cancelled = Boolean(params.cancelTask) && isOrch;
				if (cancelled) {
					task.status = "cancelled";
					// Revoke every active attempt in the task. Cancelled attempts are NOT terminal in the
					// success/failure sense — they're lease revocations; the audit trail stays intact.
					let revokedAttempts = 0;
					for (const [nId, n] of Object.entries(task.nodes)) {
						if (n.activeAttemptId && Array.isArray(n.attemptHistory)) {
							const activeAttempt = n.attemptHistory.find((a: any) => a.attemptId === n.activeAttemptId);
							if (activeAttempt && activeAttempt.status === "active") {
								activeAttempt.status = "cancelled";
								activeAttempt.lastActivityAt = now();
								activeAttempt.releasedAt ||= now();
								activeAttempt.releaseReason = "cancel";
								revokedAttempts++;
							}
						}
						// Transition non-terminal nodes to cancelled; leave already-terminal nodes (done/failed/skipped)
						// alone so a node that genuinely finished before cancellation is NOT mutated — cancellation
						// must not retroactively un-do real work.
						if (n.status !== "done" && n.status !== "failed" && n.status !== "skipped" && n.status !== "cancelled") {
							n.status = "cancelled";
							n.lastActivityAt = now();
							// Release the assignee's active-task pointer + advisory edit locks NOW that the node
							// is terminal-ish (releaseNodeAssignment at the top ran before the status flip, so it
							// skipped; we release here per-node as each is cancelled).
							releaseNodeAssignment(st, task, nId);
						}
					}
					// Supersede every assignment-class message in the task so late ACK/result attempts are
					// rejected at the swarm_ack_message / swarm_send_message handler boundary.
					const sup = await supersedeTaskAssignmentMessages(p, st, task, CANCELLATION_REASON, me);
					await traceTask(tp, "task.cancel.revoke_all", { taskId, revokedAttempts, supersededMessages: sup.supersededIds.length, skipped: sup.skipped, by: me });
					// Informational cancel notifications to each assignee — requiresAck:false so workers
					// never accumulate response debt on a cancelled assignment. We only notify assignees
					// of nodes that were active before cancellation; never on already-terminal nodes.
					// Lifecycle-fencing (issue 9, site 7): build Map<assigneeId, nodeId> so each notifiee
					// gets its OWN triggering-assignee for the predicate lookup. The predicate is narrow
					// by design: it does NOT consider the just-set task.status="cancelled" or terminal node
					// status as staleness — those are the trigger. Stale iff the node has since been
					// reopened (status=ready) and reassigned to a different agent.
					const triggeringAssigneeMap = new Map<string, string>();
					for (const [nId, n] of Object.entries(task.nodes)) {
						if (n.assignee && n.assignee !== "orchestrator" && (n.status === "cancelled" || n.status === "assigned" || n.status === "in_progress")) {
							triggeringAssigneeMap.set(n.assignee, nId);
						}
					}
					const notifiees = new Set(triggeringAssigneeMap.keys());
					for (const [assigneeId, nId] of triggeringAssigneeMap) {
						const cancelStaleCheck = checkClosureNotificationStale(st, task, nId, assigneeId, Date.now());
						if (cancelStaleCheck.stale) {
							await traceTask(tp, "notification.stale.suppressed", { site: "swarm_update_task.cancellation", taskId, to: assigneeId, nodeId: nId, reason: cancelStaleCheck.reason, evidence: cancelStaleCheck.evidence });
							notifiees.delete(assigneeId);
							continue;
						}
					}
					for (const assigneeId of notifiees) {
						try {
							ensureOrchestrator(st, ctx.cwd, p);
							await deliverMessageLocked(pi, ctx.cwd, p, st, {
								to: assigneeId,
								subject: `Assignment cancelled: ${task.taskId}`,
								body: `Your work on task ${task.taskId} has been cancelled by the orchestrator (${me}). All active attempts are revoked and assignment messages are superseded.\n\nAction:\n- Stop work on this task immediately.\n- Do NOT call swarm_update_task for any node in this task — it will be rejected with TASK_CANCELLED.\n- Informational only; no acknowledgement required.`,
								conversationId: `cancel:${task.taskId}`,
								requiresAck: false,
								requiresResponse: false,
								clearReason: "swarm_assign_task",
							});
						} catch (err: any) {
							await traceTask(tp, "task.cancel.notify_failed", { taskId, to: assigneeId, error: String((err as Error)?.message || err) });
						}
					}
				}
				let taskStatusChange = applyTaskStatus(task);
				const autoClosed = autoCloseOrchestratorTerminalNodes(task);
				for (const nodeId of autoClosed.closed) releaseNodeAssignment(st, task, nodeId);
				if (autoClosed.closed.length) taskStatusChange = applyTaskStatus(task);
				if (taskStatusChange.terminal) {
					releaseTaskFromAllAgents(st, task.taskId);
					// Issue 23 — terminal task transition: clear any stalled task-stall counter
					// (the predicate "task in_progress" is no longer satisfied).
					resolveTaskStallLocked(p, st, task.taskId, "task_terminal");
				}
				const nextReady = computeReadyNodes(task);
				task.currentNodes = nextReady.current;
				await writeTaskState(tp, task);
				await writeState(p, st);
				await traceTask(tp, "task.update", { taskId, nodeId: params.nodeId, prevStatus, status: newStatus, outcome: params.outcome, note: Boolean(params.note), artifact: params.artifact, gateUpdates: params.gateUpdates ? Object.keys(params.gateUpdates) : [], sharedContext: Boolean(params.sharedContextUpdates), by: me, autoClosed: autoClosed.closed, reopened });
				if (autoClosed.closed.length) await traceTask(tp, "task.autoclose.orchestrator", { taskId, nodeIds: autoClosed.closed, triggerNodeId: params.nodeId, by: "engine" });
				if (cancelled) await traceTask(tp, "task.cancel", { taskId, nodeId: params.nodeId, by: me });
				if (taskStatusChange.terminal) await traceTask(tp, "task.close", { taskId, status: task.status, nodeId: params.nodeId, by: me });
				// PM auto-notify (engine behavior): when a node transitions INTO a closure-ish status
				// (done|failed|blocked) the PM no longer has to poll — enqueue a concise mailbox report to the
				// mailbox-only orchestrator. On task-terminal (done|failed|cancelled) emit the stronger
				// task-close variant. Gated on the transition (not every update) so it isn't spammy;
				// mailbox-only (no tmux inject); requiresAck=false (informational; orchestrator pump surfaces
				// it). Best-effort: never fails the update. NB: node-status mutation already happened above;
				// this only sends a message.
				const closureIsh = (s: TaskNodeStatus | undefined): boolean => s === "done" || s === "failed" || s === "blocked" || s === "cancelled";
				const closedNow = !closureIsh(prevStatus) && closureIsh(newStatus);
				if (closedNow) {
					// Lifecycle-fencing (issue 9, site 6): per-node closure staleness check. The predicate is
					// deliberately narrow: it does NOT consider the just-set terminal status or task status
					// as staleness — those are the trigger. Stale iff the node has since been reopened and
					// reassigned to a different agent (rework race) OR the node has been removed from the graph.
					const closeStaleCheck = checkClosureNotificationStale(st, task, params.nodeId, closingAssignee, Date.now());
					if (closeStaleCheck.stale) {
						await traceTask(tp, "notification.stale.suppressed", { site: "swarm_update_task.closure", taskId, nodeId: params.nodeId, reason: closeStaleCheck.reason, evidence: closeStaleCheck.evidence });
					} else {
						ensureOrchestrator(st, ctx.cwd, p);
						const nextLabel = nextReady.ready.length ? nextReady.ready.join(", ") : "(none)";
						const outcomeLabel = params.outcome ? ` (outcome=${params.outcome})` : "";
						const who = closingAssignee ? ` assignee=${closingAssignee}.` : "";
						const art = params.artifact ? ` artifact=${params.artifact}.` : "";
						let subject: string, body: string;
						if (taskStatusChange.terminal) {
							subject = `task ${task.taskId} closed (${task.status})`;
							body = `Task ${task.taskId} closed with status ${task.status}. Triggering node ${params.nodeId} moved ${prevStatus} -> ${newStatus}${outcomeLabel} by ${me}.${who}${art} Next ready: ${nextLabel}.`;
						} else {
							subject = `task ${task.taskId} node ${params.nodeId} -> ${newStatus}`;
							body = `Node ${params.nodeId} of ${task.taskId} moved ${prevStatus} -> ${newStatus}${outcomeLabel} by ${me}.${who}${art} Task status=${task.status}. Next ready: ${nextLabel}.${newStatus === "blocked" ? " (blocked is resumable.)" : ""}`;
						}
						try {
							await deliverMessageLocked(pi, ctx.cwd, p, st, { to: "orchestrator", subject, body, conversationId: `task:${task.taskId}:${params.nodeId}`, requiresAck: false });
							await traceTask(tp, "task.close.notify", { taskId, nodeId: params.nodeId, status: newStatus, taskStatus: task.status, to: "orchestrator" });
						} catch (err: any) {
							await traceTask(tp, "task.close.notify_failed", { taskId, nodeId: params.nodeId, error: String(err?.message || err) });
						}
						await writeState(p, st); // persist the notify message record + orchestrator pseudo-agent
					}
				}
				return { task, prevStatus, newStatus, taskStatus: task.status, cancelled, autoClosed: autoClosed.closed, reopened };
			});
			return textResult(`Updated node ${params.nodeId} of ${result.task.taskId}: ${result.prevStatus} -> ${result.newStatus}${params.outcome ? ` (outcome=${params.outcome})` : ""}.${result.cancelled ? " Task marked cancelled; all assignments released." : ""}${result.reopened?.length ? ` Reopened rework nodes: ${result.reopened.join(", ")}.` : ""}${params.note ? ` Note: ${params.note}` : ""}`, { taskId: result.task.taskId, nodeId: params.nodeId, status: result.newStatus, outcome: params.outcome, taskStatus: result.taskStatus, cancelled: result.cancelled, by: me, autoClosed: result.autoClosed, reopened: result.reopened });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_task_message",
		label: "Swarm Task Message",
		description: "Send a task-scoped discussion/handoff message that wraps swarm_send_message and records a handoff + attaches taskId/fromNode/toNode/conversationId/artifactRefs. The graph advances only via swarm_update_task; this is for clarification/handoff chat between nodes.",
		promptGuidelines: ["Use `swarm_task_message` for task-scoped clarification or handoff between nodes. It records handoffs and attaches task metadata. Do NOT use it to advance node status (use swarm_update_task for that)."],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id." }),
			fromNode: Type.String({ description: "Node id the message originates from." }),
			to: Type.String({ description: "Recipient agent id (or 'orchestrator')." }),
			subject: Type.Optional(Type.String({ description: "Short subject." })),
			body: Type.String({ description: "Message body." }),
			toNode: Type.Optional(Type.String({ description: "Target node id, when this is a node-to-node handoff." })),
			artifactRefs: Type.Optional(Type.Array(Type.String({ description: "Artifact paths to reference (e.g. artifacts/test-report.md)." }))),
			replyExpected: Type.Optional(Type.Boolean({ description: "Whether the recipient should ack. Defaults to true." })),
			priority: Type.Optional(Type.String({ description: "low, normal, high. Defaults to normal." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			const me = currentAgentId();
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const { task, tp } = await readTaskByRef(p, { taskId: params.taskId });
				const taskId = task.taskId;
				if (!task.nodes[params.fromNode]) await failTaskTool(tp, p, "TASK_NODE_NOT_FOUND", `fromNode ${params.fromNode} does not exist in task ${taskId}.`, { taskId, nodeId: params.fromNode, received: { fromNode: params.fromNode } });
				if (params.toNode && !task.nodes[params.toNode]) await failTaskTool(tp, p, "TASK_NODE_NOT_FOUND", `toNode ${params.toNode} does not exist in task ${taskId}.`, { taskId, nodeId: params.toNode, received: { toNode: params.toNode } });
				for (const ref of params.artifactRefs || []) if (!isSafeRelativePath(ref)) await failTaskTool(tp, p, "PATH_OUTSIDE_TASK", `Artifact ref is unsafe (must be relative, no ..): ${ref}`, { taskId, nodeId: params.fromNode, received: { artifactRef: ref } });
				ensureOrchestrator(st, ctx.cwd, p);
				const toId = safeId(params.to);
				if (!st.agents[toId]) await failTaskTool(tp, p, "AGENT_NOT_FOUND", `Recipient ${toId} is not registered.`, { taskId, nodeId: params.fromNode, received: { to: toId }, suggestedNextCall: { tool: "swarm_list_agents", params: {} } });

				const conversationId = `task:${taskId}:${params.fromNode}${params.toNode ? `->${params.toNode}` : ""}`;
				let body = params.body;
				if (params.artifactRefs && params.artifactRefs.length) body += `\n\nArtifact refs: ${params.artifactRefs.join(", ")}`;
				const { msg, delivery } = await deliverMessageLocked(pi, ctx.cwd, p, st, { to: toId, body, subject: params.subject, conversationId, requiresAck: params.replyExpected !== false, requiresResponse: params.replyExpected !== false, priority: params.priority });
				task.nodes[params.fromNode].messageIds = Array.from(new Set([...(task.nodes[params.fromNode].messageIds || []), msg.id]));
				if (params.toNode) task.handoffs.push({ fromNode: params.fromNode, toNode: params.toNode, fromAgent: me, toAgent: toId, messageId: msg.id, at: now(), artifactRefs: params.artifactRefs || [], status: delivery?.delivered ? (delivery.mailboxOnly ? "mailbox_only" : "delivered") : "queued" });
				await writeTaskState(tp, task);
				await writeState(p, st);
				await traceTask(tp, "task.message", { taskId, fromNode: params.fromNode, toNode: params.toNode, to: toId, messageId: msg.id, artifactRefs: params.artifactRefs || [], replyExpected: params.replyExpected !== false });
				return { task, msg, delivery };
			});
			const delivery = result.delivery;
			return textResult(`Sent task message ${result.msg.id} from node ${params.fromNode} to ${params.to}${params.toNode ? ` (node ${params.toNode})` : ""}. ${delivery?.delivered ? (delivery.mailboxOnly ? "Queued (mailbox-only)." : "Delivered.") : "Queued (agent not running; reconcile will retry)."}`, { taskId: result.task.taskId, messageId: result.msg.id, fromNode: params.fromNode, toNode: params.toNode, to: params.to, delivery });
		},
	}))
}
