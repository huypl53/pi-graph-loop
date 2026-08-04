// === swarm/tools/tasks.ts — tool registrations (verbatim from index.ts) ===
import { Type } from "typebox";
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, appendFile, rm, stat, rename, readdir, realpath } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import type { LoopConfig, NodeInput, ReusableAgentMatch, TaskGate, TaskGateStatus, TaskNodeStatus, TaskState } from "../types.ts";
import { TERMINAL_NODE_STATUSES } from "../constants.ts";
import { applyGateUpdates, applySharedContextUpdates, applyTaskStatus, autoCloseOrchestratorTerminalNodes, buildAssignmentBody, buildGraphFromInput, buildTaskMarkdown, collectDeclaredArtifacts, computeReadyNodes, computeTaskClosure, failTaskTool, graphJsonSummary, isAllowedNodeTransition, printGraphMermaid, printGraphText, releaseNodeAssignment, releaseTaskFromAllAgents, validateTaskGraph } from "../taskgraph.ts";
import { currentAgentId } from "../session.ts";
import { deliverMessageLocked, supersedeOpenAssignments } from "../mailbox.ts";
import { ensureAgentDefaults, inferRoleKind, isSafeRelativePath, now, safeId, textResult } from "../utils.ts";
import { ensureDirs, paths, readState, readTaskByRef, taskPaths, trace, traceTask, withLock, writeState, writeTaskState } from "../state.ts";
import { ensureOrchestrator } from "../identity.ts";
import { findReusableAgent, spawnAgent } from "../agents.ts";
import { getLoopConfig, kickoffLoopIfEnabled } from "../loop.ts";
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
			loop: Type.Optional(Type.Object({
				enabled: Type.Boolean({ description: "Opt-in V1.5 post-iteration loop. Must be true to enable; absent/false = no behavior change." }),
				proposalAgents: Type.Optional(Type.Array(Type.String({ description: "Fixed agent pool to request next-iteration proposals from after terminal-done close." }))),
				refreshAgents: Type.Optional(Type.Array(Type.String({ description: "Agents to best-effort refresh (tmux /new + identity reload) after a plan is recorded." }))),
				maxRounds: Type.Optional(Type.Number({ description: "Optional cap on rounds (defensive; V1.5 is one round per task)." })),
			})),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			const result = await withLock(p, async () => {
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
				// V1.5 opt-in loop config: normalize + persist only when enabled. Metadata only — it does not
				// affect node routing, branch logic, closure, or readiness. getLoopConfig returns undefined otherwise.
				const loopCfg = getLoopConfig(params.loop as Partial<LoopConfig> | undefined);
				if (loopCfg) task.loop = loopCfg;
				// Reject structurally-invalid graphs at creation (hard errors only; soft warnings are still allowed)
				// so a broken task can't be written and linger. Run swarm_validate_graph for the full report.
				const createValidation = validateTaskGraph(task);
				if (createValidation.errors.length) {
					throw new Error(`Task graph is structurally invalid; refusing to create. Fix these and retry:\n${createValidation.errors.map((e) => `  ✗ ${e}`).join("\n")}`);
				}
				const { ready, current } = computeReadyNodes(task);
				task.currentNodes = current;
				applyTaskStatus(task); // engine-enforced closure: a fresh task derives `ready`
				const autoClosed = autoCloseOrchestratorTerminalNodes(task);
				if (autoClosed.closed.length) {
					applyTaskStatus(task);
					task.currentNodes = computeReadyNodes(task).current;
				}
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
				const found = await findReusableAgent(pi, st, { roleKind: kind, requireIdle: false, includeBusy: false });
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
			const reusePolicy = params.reusePolicy || "prefer_idle_existing";
			let spawned = false;
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const { task, tp } = await readTaskByRef(p, { taskId: params.taskId });
				const taskId = task.taskId;
				const node = task.nodes[params.nodeId];
				if (!node) await failTaskTool(tp, p, "TASK_NODE_NOT_FOUND", `Node ${params.nodeId} does not exist in task ${taskId}.`, { taskId, nodeId: params.nodeId, expected: { validNodes: Object.keys(task.nodes) }, received: { nodeId: params.nodeId } });
				if (TERMINAL_NODE_STATUSES.has(node.status)) await failTaskTool(tp, p, "INVALID_TRANSITION", `Node ${params.nodeId} is terminal (${node.status}); cannot assign.`, { taskId, nodeId: params.nodeId, received: { nodeStatus: node.status } });
				// Readiness: assignable when actionable (ready, or unassigned ready-status current) or already active (reassign).
				const cr = computeReadyNodes(task);
				const actionable = new Set([...cr.ready, ...cr.current.filter((id) => task.nodes[id].status === "ready" && !task.nodes[id].assignee)]);
				if (node.status === "pending" && !actionable.has(params.nodeId)) await failTaskTool(tp, p, "NODE_NOT_READY", `Node ${params.nodeId} is not ready yet (dependencies/gates not satisfied).`, { taskId, nodeId: params.nodeId, expected: { ready: cr.ready, current: cr.current }, received: { nodeStatus: node.status }, suggestedNextCall: { tool: "swarm_next_nodes", params: { taskId } } });

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
					const found = await findReusableAgent(pi, st, { roleKind: expectedKind, requireIdle: false, requireTmuxAlive: false, includeBusy: false });
					candidates = found.matches;
					if (found.recommended) assigneeId = found.recommended;
					else if (params.autoSpawn || params.spawnIsolated) { const r = await spawnAgent(pi, ctx.cwd, p, st, { id: `${expectedKind}-01`, role: node.role }); assigneeId = r.agent.id; spawned = true; }
					else await failTaskTool(tp, p, "NO_AVAILABLE_AGENT", `No reusable ${expectedKind} agent for node ${params.nodeId}.`, { taskId, nodeId: params.nodeId, expected: { roleKind: expectedKind }, received: { reusePolicy }, suggestedNextCall: { tool: "swarm_assign_task", params: { taskId, nodeId: params.nodeId, autoSpawn: true } } });
				}
				const assignee = assigneeId ? st.agents[assigneeId] : undefined;
				if (!assignee) await failTaskTool(tp, p, "AGENT_NOT_FOUND", `Resolved agent is missing for node ${params.nodeId}.`, { taskId, nodeId: params.nodeId, received: { agentId: assigneeId } });
				ensureAgentDefaults(assignee);

				const prevStatus = node.status;
				// Reassignment bookkeeping: free the previous assignee's active-task pointer.
				if (node.assignee && node.assignee !== assignee.id) {
					const old = st.agents[node.assignee];
					if (old) { ensureAgentDefaults(old); old.activeTaskIds = old.activeTaskIds.filter((t) => t !== task.taskId); }
				}
				// Count a fresh work attempt when (re)entering assigned from a non-active state.
				if (["pending", "ready", "blocked"].includes(prevStatus)) {
					if (node.maxAttempts && node.attempts >= node.maxAttempts) await failTaskTool(tp, p, "INVALID_TRANSITION", `Node ${params.nodeId} reached maxAttempts (${node.maxAttempts}); cannot reassign.`, { taskId, nodeId: params.nodeId, received: { attempts: node.attempts, maxAttempts: node.maxAttempts } });
					node.attempts += 1;
				}
				node.assignee = assignee.id;
				node.status = "assigned";
				node.lastActivityAt = now();
				if (node.staleAt) { const prevStaleAt = node.staleAt; delete node.staleAt; await traceTask(tp, "task.stale.cleared", { taskId, nodeId: params.nodeId, prevStaleAt, reason: "assign", by: currentAgentId() }); }
				if (!assignee.activeTaskIds.includes(task.taskId)) assignee.activeTaskIds.push(task.taskId);
				applyTaskStatus(task);
				task.currentNodes = computeReadyNodes(task).current;

				const replyTarget = params.replyTarget || me;
				const conversationId = `task:${task.taskId}:${params.nodeId}`;
				const body = buildAssignmentBody(task, params.nodeId, replyTarget, params.note);
				// Deterministic idempotency key: same task/node/assignee/attempt -> same message (no duplicate on retry).
				const idempotencyKey = `assign:${task.taskId}:${params.nodeId}:${assignee.id}:${node.attempts}`;
				const { msg, delivery } = await deliverMessageLocked(pi, ctx.cwd, p, st, { to: assignee.id, body, subject: `Task ${task.taskId} / node ${params.nodeId} assigned`, conversationId, requiresAck: true, requiresResponse: true, idempotencyKey });
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
			return textResult(`Assigned node ${params.nodeId} of ${result.task.taskId} to ${result.assigneeId}${spawned ? " (spawned)" : ""}. Message ${result.msg.id} ${delivery?.delivered ? (delivery.mailboxOnly ? "queued (mailbox-only)" : "delivered") : "queued (agent not running; reconcile will retry)"}.`, { taskId: result.task.taskId, nodeId: params.nodeId, assignee: result.assigneeId, spawned, messageId: result.msg.id, injected, delivery, candidates: result.candidates });
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
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			const me = currentAgentId();
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const { task, tp } = await readTaskByRef(p, { taskId: params.taskId });
				const taskId = task.taskId;
				const node = task.nodes[params.nodeId];
				if (!node) await failTaskTool(tp, p, "TASK_NODE_NOT_FOUND", `Node ${params.nodeId} does not exist in task ${taskId}.`, { taskId, nodeId: params.nodeId, expected: { validNodes: Object.keys(task.nodes) }, received: { nodeId: params.nodeId } });
				const isOrch = me === "orchestrator" || Boolean(params.force);
				if (!isOrch && node.assignee !== me) await failTaskTool(tp, p, "NODE_ASSIGNEE_MISMATCH", `Node ${params.nodeId} is assigned to ${node.assignee || "(unassigned)"}, but current agent is ${me}.`, { taskId, nodeId: params.nodeId, expected: { assignee: node.assignee || null, allowedAction: "update your own assigned node or send a task message" }, received: { agentId: me, requestedStatus: params.status } });
				if (params.artifact && !isSafeRelativePath(params.artifact)) await failTaskTool(tp, p, "PATH_OUTSIDE_TASK", `Artifact path is unsafe (must be relative, no ..): ${params.artifact}`, { taskId, nodeId: params.nodeId, received: { artifact: params.artifact } });

				const prevStatus = node.status;
				const newStatus = (params.status as TaskNodeStatus | undefined) || prevStatus;
				if (newStatus !== prevStatus && !isOrch && !isAllowedNodeTransition(prevStatus, newStatus)) await failTaskTool(tp, p, "INVALID_TRANSITION", `Node ${params.nodeId} cannot move ${prevStatus} -> ${newStatus}.`, { taskId, nodeId: params.nodeId, expected: { lifecycle: "pending->ready->assigned->in_progress->done|failed|blocked; terminal states need orchestrator override" }, received: { from: prevStatus, to: newStatus } });
				const outEdges = task.edges.filter((e) => e.from === params.nodeId);
				if (newStatus === "done" && outEdges.length && !params.outcome && !node.outcome) await failTaskTool(tp, p, "OUTCOME_REQUIRED", `Node ${params.nodeId} has outgoing branches but no outcome was provided.`, { taskId, nodeId: params.nodeId, expected: { validOutcomes: [...new Set(outEdges.map((e) => e.when))] }, received: { outcome: params.outcome }, suggestedNextCall: { tool: "swarm_update_task", params: { taskId, nodeId: params.nodeId, status: "done", outcome: outEdges[0].when } } });

				// Validation complete; apply (no earlier writes occurred).
				node.status = newStatus;
				if ((newStatus === "assigned" || newStatus === "in_progress" || newStatus === "ready") && node.staleAt) { delete node.staleAt; }
				if (params.outcome !== undefined) node.outcome = params.outcome;
				node.lastActivityAt = now();
				if (params.gateUpdates) applyGateUpdates(task, params.gateUpdates as Record<string, { status: TaskGateStatus; by?: string; artifact?: string | null }>, me);
				if (params.sharedContextUpdates) applySharedContextUpdates(task, params.sharedContextUpdates as { summary?: string; decisions?: Array<{ text: string; severity?: string }>; risks?: Array<{ text: string; severity?: string }>; openQuestions?: Array<{ text: string }> }, me);
				if (params.artifact) node.writeArtifacts = Array.from(new Set([...(node.writeArtifacts || []), params.artifact]));
				releaseNodeAssignment(st, task, params.nodeId);
				const closingAssignee = node.assignee || undefined; // persisted on the node (not cleared by release)
				// Orchestrator-explicit cancellation: sticky terminal state. applyTaskStatus preserves an
				// existing `cancelled`, so setting it here then calling applyTaskStatus keeps it cancelled and
				// releases every agent's active-task pointer for this task.
				const cancelled = Boolean(params.cancelTask) && (me === "orchestrator" || Boolean(params.force));
				if (cancelled) task.status = "cancelled";
				let taskStatusChange = applyTaskStatus(task);
				const autoClosed = autoCloseOrchestratorTerminalNodes(task);
				for (const nodeId of autoClosed.closed) releaseNodeAssignment(st, task, nodeId);
				if (autoClosed.closed.length) taskStatusChange = applyTaskStatus(task);
				if (taskStatusChange.terminal) releaseTaskFromAllAgents(st, task.taskId);
				const nextReady = computeReadyNodes(task);
				task.currentNodes = nextReady.current;
				await writeTaskState(tp, task);
				await writeState(p, st);
				await traceTask(tp, "task.update", { taskId, nodeId: params.nodeId, prevStatus, status: newStatus, outcome: params.outcome, note: Boolean(params.note), artifact: params.artifact, gateUpdates: params.gateUpdates ? Object.keys(params.gateUpdates) : [], sharedContext: Boolean(params.sharedContextUpdates), by: me, autoClosed: autoClosed.closed });
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
				const closureIsh = (s: TaskNodeStatus | undefined): boolean => s === "done" || s === "failed" || s === "blocked";
				const closedNow = !closureIsh(prevStatus) && closureIsh(newStatus);
				if (closedNow) {
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
				// V1.5 opt-in post-iteration loop: when a loop-enabled task reaches terminal DONE, kick off the
				// proposal round (best-effort; never alters default graph behavior). Runs inside this lock so
				// proposal fanout is atomic with the close; failures are traced, not thrown.
				if (taskStatusChange.terminal && task.status === "done") {
					try {
						await kickoffLoopIfEnabled(pi, ctx.cwd, p, st, task, tp);
					} catch (err: any) {
						await traceTask(tp, "task.loop.kickoff_failed", { taskId: task.taskId, nodeId: params.nodeId, error: String((err as Error)?.message || err) });
					}
				}
				return { task, prevStatus, newStatus, taskStatus: task.status, cancelled, autoClosed: autoClosed.closed };
			});
			return textResult(`Updated node ${params.nodeId} of ${result.task.taskId}: ${result.prevStatus} -> ${result.newStatus}${params.outcome ? ` (outcome=${params.outcome})` : ""}.${result.cancelled ? " Task marked cancelled; all assignments released." : ""}${result.autoClosed?.length ? ` Auto-closed orchestrator terminal nodes: ${result.autoClosed.join(", ")}.` : ""}${params.note ? ` Note: ${params.note}` : ""}`, { taskId: result.task.taskId, nodeId: params.nodeId, status: result.newStatus, outcome: params.outcome, taskStatus: result.taskStatus, cancelled: result.cancelled, by: me, autoClosed: result.autoClosed });
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
