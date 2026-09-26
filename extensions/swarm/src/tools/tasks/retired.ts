// === swarm/tools/tasks/retired.ts — retired task tools (commented-out, verbatim) ===
// swarm_confirm_qualification, swarm_validate_graph, swarm_print_graph, swarm_next_nodes,
// swarm_task_message were retired from the live surface. Bodies preserved as comments verbatim
// from the src/tools/tasks.ts monolith (Phase 6 real split) for archaeology.

/*
	pi.registerTool(
		defineTool({
			name: "swarm_confirm_qualification",
			label: "Swarm Confirm Qualification",
			description:
				"Record root's human-discuss confirmation for a task qualification gate, allowing implementation assignment to begin.",
			promptGuidelines: [
				"Use `swarm_confirm_qualification` only after the human has discussed and confirmed the qualification gate.",
			],
			parameters: Type.Object({
				taskId: Type.String({ description: "Task id." }),
				note: Type.String({ description: "Short record of the human-confirmed outcome, trade-offs, or scope." }),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_confirm_qualification", async () => {
					const p = paths(ctx.cwd);
					requireRootAuthority(currentAgentId(), "swarm_confirm_qualification");
					const result = await withLock(p, async () => {
						const st = await readState(p, ctx.cwd);
						heartbeatRootLeader(st, Date.now(), process.pid, "confirm_qualification");
						const { task, tp } = await readTaskByRef(p, { taskId: params.taskId });
						if (!task.qualification)
							await failTaskTool(
								tp,
								p,
								"QUALIFICATION_NOT_CONFIGURED",
								`Task ${task.taskId} has no qualification gate (legacy task).`,
								{ taskId: task.taskId },
							);
						if (task.qualification.mode !== "human-discuss")
							await failTaskTool(
								tp,
								p,
								"QUALIFICATION_CONFIRMATION_NOT_REQUIRED",
								`Task ${task.taskId} uses auto qualification; its gate is already ready.`,
								{ taskId: task.taskId, qualification: task.qualification },
							);
						task.qualification.status = "confirmed";
						task.qualification.confirmedAt = now();
						task.qualification.confirmationNote = params.note;
						await writeTaskState(tp, task);
						await writeFile(tp.taskMd, buildTaskMarkdown(task), "utf8");
						await writeFile(
							join(tp.root, task.qualification.artifact),
							`\n## Human confirmation\n\n- Confirmed at: ${task.qualification.confirmedAt}\n- Note: ${params.note}\n`,
							{ encoding: "utf8", flag: "a" },
						);
						await writeState(p, st);
						await traceTask(tp, "task.qualification.confirmed", {
							taskId: task.taskId,
							by: currentAgentId(),
							note: params.note,
						});
						return { task, tp };
					});
					return textResult(`Qualification confirmed for ${result.task.taskId}. Implementation may now be assigned.`, {
						taskId: result.task.taskId,
						qualification: result.task.qualification,
					});
				});
			},
		}),
	);
	*/

/*
	pi.registerTool(
		defineTool({
			name: "swarm_validate_graph",
			label: "Swarm Validate Graph",
			description:
				"Validate task/workflow structure (ids, edges, reachability, terminals, ambiguous branches, rework cycles, path safety) and optionally runtime consistency (agents, capacity, message acks).",
			promptGuidelines: ["Use `swarm_validate_graph` before/during execution to catch broken or inconsistent task graphs."],
			parameters: Type.Object({
				taskId: Type.Optional(Type.String({ description: "Task id." })),
				path: Type.Optional(Type.String({ description: "Direct path to a task.json." })),
				runtime: Type.Optional(Type.Boolean({ description: "Include agent/message/liveness checks. Defaults to false." })),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_validate_graph", async () => {
					const p = paths(ctx.cwd);
					const { task, tp, taskId } = await readTaskByRef(p, { taskId: params.taskId, path: params.path });
					const { errors, warnings } = validateTaskGraph(task);
					let runtimeWarnings: string[] = [];
					if (params.runtime) {
						const st = await readState(p, ctx.cwd);
						runtimeWarnings = await runtimeTaskWarnings(pi, st, task);
					}
					const ok = errors.length === 0;
					await traceTask(tp, "task.validate", {
						taskId,
						ok,
						errors: errors.length,
						warnings: warnings.length,
						runtime: Boolean(params.runtime),
					});
					const lines: string[] = [];
					lines.push(
						`Validation: ${ok ? "PASS" : "FAIL"} (${errors.length} errors, ${warnings.length + runtimeWarnings.length} warnings)`,
					);
					for (const e of errors) lines.push(`  ✗ ${e}`);
					for (const w of [...warnings, ...runtimeWarnings]) lines.push(`  ⚠ ${w}`);
					return textResult(lines.join("\n"), { taskId, ok, errors, warnings, runtimeWarnings });
				});
			},
		}),
	);

	pi.registerTool(
		defineTool({
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
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_print_graph", async () => {
					const p = paths(ctx.cwd);
					const { task, tp, taskId } = await readTaskByRef(p, { taskId: params.taskId, path: params.path });
					const format = (params.format || "text").toLowerCase();
					const { ready, current } = computeReadyNodes(task);
					await traceTask(tp, "task.print", { taskId, format });
					if (format === "mermaid") return textResult(printGraphMermaid(task), { taskId, format });
					if (format === "json")
						return textResult(JSON.stringify(graphJsonSummary(task, ready, current), null, 2), {
							taskId,
							format,
							summary: graphJsonSummary(task, ready, current),
						});
					return textResult(printGraphText(task, ready, current), { taskId, format });
				});
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "swarm_next_nodes",
			label: "Swarm Next Nodes",
			description:
				"Compute ready/next nodes from task graph state and suggest a reusable agent per ready node. Read-only in V1 (assignment is handled by swarm_assign_task).",
			promptGuidelines: ["Use `swarm_next_nodes` to decide what work is ready next and which agent could take it."],
			parameters: Type.Object({
				taskId: Type.String({ description: "Task id." }),
				autoAssign: Type.Optional(
					Type.Boolean({ description: "Reserved for V1; suggestions are returned but assignment is not mutated." }),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_next_nodes", async () => {
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
					const actionable = Array.from(
						new Set([
							...result.ready,
							...result.current.filter(
								(id) => task.nodes[id] && task.nodes[id].status === "ready" && !task.nodes[id].assignee,
							),
						]),
					);
					const suggestions: Array<{
						nodeId: string;
						role: string;
						suggestedAssignee?: string;
						candidates: ReusableAgentMatch[];
					}> = [];
					for (const nodeId of actionable) {
						const node = task.nodes[nodeId];
						const kind = inferRoleKind(nodeId, node.role);
						const found = await findReusableAgent(pi, st, {
							roleKind: kind,
							requireIdle: false,
							includeBusy: false,
							excludeTaskId: taskId,
						});
						await trace(p, "agent.find", {
							taskId,
							nodeId,
							roleKind: kind,
							recommended: found.recommended,
							candidates: found.matches.length,
						});
						suggestions.push({ nodeId, role: node.role, suggestedAssignee: found.recommended, candidates: found.matches });
					}
					await traceTask(tp, "task.next_nodes", {
						taskId,
						ready: result.ready,
						actionable,
						current: result.current,
						autoAssign: Boolean(params.autoAssign),
					});
					const lines: string[] = [
						`Ready: ${actionable.length ? actionable.join(", ") : "(none)"}`,
						`Current: ${result.current.length ? result.current.join(", ") : "(none)"}`,
					];
					for (const s of suggestions)
						lines.push(`  ${s.nodeId} (${s.role}) -> ${s.suggestedAssignee || "(no reusable agent; spawn needed)"}`);
					return textResult(lines.join("\n"), {
						taskId,
						ready: actionable,
						current: result.current,
						suggestions,
						autoAssign: Boolean(params.autoAssign),
					});
				});
			},
		}),
	);
	*/

/*
	pi.registerTool(
		defineTool({
			name: "swarm_task_message",
			label: "Swarm Task Message",
			description:
				"Send a task-scoped discussion/handoff message that wraps swarm_send_message and records a handoff + attaches taskId/fromNode/toNode/conversationId/artifactRefs. The graph advances only via swarm_update_task; this is for clarification/handoff chat between nodes.",
			promptGuidelines: [
				"Use `swarm_task_message` for task-scoped clarification or handoff between nodes. It records handoffs and attaches task metadata. Do NOT use it to advance node status (use swarm_update_task for that).",
			],
			parameters: Type.Object({
				taskId: Type.String({ description: "Task id." }),
				fromNode: Type.String({ description: "Node id the message originates from." }),
				to: Type.String({ description: "Recipient agent id (or 'root')." }),
				subject: Type.Optional(Type.String({ description: "Short subject." })),
				body: Type.String({ description: "Message body." }),
				toNode: Type.Optional(Type.String({ description: "Target node id, when this is a node-to-node handoff." })),
				artifactRefs: Type.Optional(
					Type.Array(Type.String({ description: "Artifact paths to reference (e.g. artifacts/test-report.md)." })),
				),
				replyExpected: Type.Optional(Type.Boolean({ description: "Whether the recipient should ack. Defaults to true." })),
				priority: Type.Optional(Type.String({ description: "low, normal, high. Defaults to normal." })),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_task_message", async () => {
					const p = paths(ctx.cwd);
					await ensureDirs(p);
					const me = currentAgentId();
					const result = await withLock(p, async () => {
						const st = await readState(p, ctx.cwd);
						const { task, tp } = await readTaskByRef(p, { taskId: params.taskId });
						const taskId = task.taskId;
						if (!task.nodes[params.fromNode])
							await failTaskTool(
								tp,
								p,
								"TASK_NODE_NOT_FOUND",
								`fromNode ${params.fromNode} does not exist in task ${taskId}.`,
								{ taskId, nodeId: params.fromNode, received: { fromNode: params.fromNode } },
							);
						if (params.toNode && !task.nodes[params.toNode])
							await failTaskTool(tp, p, "TASK_NODE_NOT_FOUND", `toNode ${params.toNode} does not exist in task ${taskId}.`, {
								taskId,
								nodeId: params.toNode,
								received: { toNode: params.toNode },
							});
						for (const ref of params.artifactRefs || [])
							if (!isSafeRelativePath(ref))
								await failTaskTool(tp, p, "PATH_OUTSIDE_TASK", `Artifact ref is unsafe (must be relative, no ..): ${ref}`, {
									taskId,
									nodeId: params.fromNode,
									received: { artifactRef: ref },
								});
						ensureRoot(st, ctx.cwd, p);
						const toId = safeId(params.to);
						if (!st.agents[toId])
							await failTaskTool(tp, p, "AGENT_NOT_FOUND", `Recipient ${toId} is not registered.`, {
								taskId,
								nodeId: params.fromNode,
								received: { to: toId },
								suggestedNextCall: { tool: "swarm_list_agents", params: {} },
							});

						const conversationId = `task:${taskId}:${params.fromNode}${params.toNode ? `->${params.toNode}` : ""}`;
						let body = params.body;
						if (params.artifactRefs && params.artifactRefs.length)
							body += `\n\nArtifact refs: ${params.artifactRefs.join(", ")}`;
						const { msg, delivery } = await deliverMessageLocked(pi, ctx.cwd, p, st, {
							to: toId,
							body,
							subject: params.subject,
							conversationId,
							requiresAck: PI_SWARM_MINIMAL_PROTOCOL === 1 ? false : params.replyExpected !== false,
							requiresResponse: params.replyExpected !== false,
							priority: params.priority,
						});
						task.nodes[params.fromNode].messageIds = Array.from(
							new Set([...(task.nodes[params.fromNode].messageIds || []), msg.id]),
						);
						if (params.toNode)
							task.handoffs.push({
								fromNode: params.fromNode,
								toNode: params.toNode,
								fromAgent: me,
								toAgent: toId,
								messageId: msg.id,
								at: now(),
								artifactRefs: params.artifactRefs || [],
								status: delivery?.delivered ? (delivery.mailboxOnly ? "mailbox_only" : "delivered") : "queued",
							});
						await writeTaskState(tp, task);
						await writeState(p, st);
						await traceTask(tp, "task.message", {
							taskId,
							fromNode: params.fromNode,
							toNode: params.toNode,
							to: toId,
							messageId: msg.id,
							artifactRefs: params.artifactRefs || [],
							replyExpected: params.replyExpected !== false,
						});
						return { task, msg, delivery };
					});
					const delivery = result.delivery;
					return textResult(
						`Sent task message ${result.msg.id} from node ${params.fromNode} to ${params.to}${params.toNode ? ` (node ${params.toNode})` : ""}. ${delivery?.delivered ? (delivery.mailboxOnly ? "Queued (mailbox-only)." : "Delivered.") : "Queued (agent not running; reconcile will retry)."}`,
						{
							taskId: result.task.taskId,
							messageId: result.msg.id,
							fromNode: params.fromNode,
							toNode: params.toNode,
							to: params.to,
							delivery,
						},
					);
				});
			},
		}),
	);	*/
