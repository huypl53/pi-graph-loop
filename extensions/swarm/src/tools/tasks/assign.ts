// === swarm/tools/tasks/assign.ts — swarm_assign_task tool (real body) ===
// Extracted verbatim from the src/tools/tasks.ts monolith (Phase 6 real split).

import { Type } from "typebox";
import { PI_SWARM_MINIMAL_PROTOCOL } from "../../constants.ts";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
	PREFLIGHT_ASSIGN_GRACE_MS,
	REASSIGN_RATE_LIMITED,
	TERMINAL_NODE_STATUSES,
	TRACE_REASSIGN_RATE_LIMITED,
	TRACE_TASK_LEASE_STAMPED,
} from "../../constants.ts";
import {
	applyTaskStatus,
	buildAssignmentBody,
	checkStallNotificationStale,
	collectActiveLeases,
	computeReadyNodes,
	failTaskTool,
	mintNodeAttempt,
	resolveNodeScope,
	scopesOverlap,
	sweepTaskWorkersLocked,
	type EffectiveScope,
} from "../../taskgraph.ts";
import type { ReusableAgentMatch, TaskState } from "../../types.ts";
import { currentAgentId } from "../../session.ts";
import { deliverMessageLocked, supersedeOpenAssignments } from "../../mailbox.ts";
import { ensureAgentDefaults, inferRoleKind, now, safeId, textResult } from "../../utils.ts";
import {
	ensureDirs,
	paths,
	readState,
	readTaskByRef,
	readTaskState,
	taskPaths,
	trace,
	traceTask,
	withLock,
	writeState,
	writeTaskState,
} from "../../state.ts";
import { logSwarmError } from "../../errorlog.ts";
import { clearOrphanWatch, findReusableAgent, isSameRootLeader, spawnAgent } from "../../agents.ts";
import { ensureRoot, heartbeatRootLeader, requireRootAuthority } from "../../identity.ts";
import { reconcile, resolveTaskStallLocked } from "../../reconcile.ts";
import { checkReassignRateLimit, stampSupersessionCount } from "./fencing.ts";
import { wrapSwarmToolInvocation } from "../wrapper.ts";

export function registerAssignTaskTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "swarm_assign_task",
			label: "Swarm Assign Task",
			description:
				"Assign a task graph node to an agent: reuse an idle role-matching agent by default, optionally spawn, update node assignment state + activeTaskIds, and send a structured assignment message carrying taskId/nodeId/replyTarget. task.json is the source of truth. Root-level tool.",
			promptGuidelines: [
				"Use `swarm_assign_task` to assign a ready node; it reuses an idle role-matching agent unless autoSpawn/spawnIsolated is set. If it returns NODE_NOT_READY, call swarm_next_nodes first. If NO_AVAILABLE_AGENT, enable autoSpawn or pass an explicit agentId.",
			],
			parameters: Type.Object({
				taskId: Type.String({ description: "Task id." }),
				nodeId: Type.String({ description: "Node id to assign." }),
				agentId: Type.Optional(Type.String({ description: "Exact existing agent id to assign to. Bypasses reuse lookup." })),
				reusePolicy: Type.Optional(Type.String({ description: "prefer_idle_existing (default). Reserved for future policies." })),
				autoSpawn: Type.Optional(
					Type.Boolean({ description: "Spawn a new long-lived role agent when no reusable agent exists. Defaults to false." }),
				),
				spawnIsolated: Type.Optional(
					Type.Boolean({ description: "Force a fresh agent for this node instead of reusing. Defaults to false." }),
				),
				replyTarget: Type.Optional(
					Type.String({ description: "Agent id the assignee should reply to. Defaults to the assigning agent (sender)." }),
				),
				note: Type.Optional(Type.String({ description: "Optional extra assignment note appended to the message body." })),
				// === Issue 82: explicit reuse lease + park mechanism (stamp at assignment time) ===
				// When passed, the assignee's record is stamped with the lease; the task-close sweep
				// will honor it (reuse = skip, park = pause). Default: lease is absent and the
				// worker is auto-stopped on task close unless a later /swarm agent lease call sets one.
				lease: Type.Optional(
					Type.Object(
						{
							kind: Type.Union([Type.Literal("reuse"), Type.Literal("park")], {
								description: "Lease kind: 'reuse' = skip task-close sweep; 'park' = pause (preserve pane) on sweep.",
							}),
							until: Type.Optional(
								Type.String({ description: "ISO timestamp; lease auto-expires past this. Default: now+1h." }),
							),
							reason: Type.Optional(Type.String({ description: "Free-text reason recorded on the lease + trace." })),
						},
						{
							description:
								"Optional lease stamp at assignment time (Issue 82). When set, the task-close sweep honors the lease instead of stopping the worker.",
						},
					),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_assign_task", async () => {
					const p = paths(ctx.cwd);
					await ensureDirs(p);
					const me = currentAgentId();
					requireRootAuthority(me, "swarm_assign_task");
					const reusePolicy = params.reusePolicy || "prefer_idle_existing";
					let spawned = false;
					const result = await withLock(p, async () => {
						const st = await readState(p, ctx.cwd);
						heartbeatRootLeader(st, Date.now(), process.pid, "assign_task");
						const { task, tp } = await readTaskByRef(p, { taskId: params.taskId });
						const taskId = task.taskId;
						const node = task.nodes[params.nodeId];
						if (!node)
							await failTaskTool(tp, p, "TASK_NODE_NOT_FOUND", `Node ${params.nodeId} does not exist in task ${taskId}.`, {
								taskId,
								nodeId: params.nodeId,
								expected: { validNodes: Object.keys(task.nodes) },
								received: { nodeId: params.nodeId },
								actionableHint: "Valid node ids are listed in task.json. Run swarm_task_status or swarm_graph to inspect.",
							});
						if (TERMINAL_NODE_STATUSES.has(node.status))
							await failTaskTool(
								tp,
								p,
								"INVALID_TRANSITION",
								`Node ${params.nodeId} is terminal (${node.status}); cannot assign.`,
								{ taskId, nodeId: params.nodeId, received: { nodeStatus: node.status } },
							);
						// Qualification is prepared at task creation. If qualification is present but not ready/confirmed, auto-confirm it since swarm_confirm_qualification is retired.
						if (
							task.qualification &&
							inferRoleKind(params.nodeId, node.role) === "implementer" &&
							!["ready", "confirmed"].includes(task.qualification.status)
						) {
							task.qualification.status = "confirmed";
							task.qualification.confirmedAt = now();
							task.qualification.confirmationNote = "Auto-confirmed (swarm_confirm_qualification retired)";
						}
						// Readiness: assignable when actionable (ready, or unassigned ready-status current) or already active (reassign).
						const cr = computeReadyNodes(task);
						const actionable = new Set([
							...cr.ready,
							...cr.current.filter((id) => task.nodes[id].status === "ready" && !task.nodes[id].assignee),
						]);
						if (node.status === "pending" && !actionable.has(params.nodeId))
							await failTaskTool(
								tp,
								p,
								"NODE_NOT_READY",
								`Node ${params.nodeId} is not ready yet (dependencies/gates not satisfied).`,
								{
									taskId,
									nodeId: params.nodeId,
									expected: { ready: cr.ready, current: cr.current },
									received: { nodeStatus: node.status },
									suggestedNextCall: { tool: "swarm_next_nodes", params: { taskId } },
									actionableHint:
										"The node's dependencies have not all reached a terminal state. Run swarm_task_status to inspect the blocking nodes, or wait for the root to advance the graph.",
								},
							);

						ensureRoot(st, ctx.cwd, p);
						const expectedKind = inferRoleKind(params.nodeId, node.role);
						let candidates: ReusableAgentMatch[] = [];
						let assigneeId: string | undefined;
						if (params.agentId) {
							const aid = safeId(params.agentId);
							if (!st.agents[aid])
								await failTaskTool(tp, p, "AGENT_NOT_FOUND", `Agent ${aid} is not registered.`, {
									taskId,
									nodeId: params.nodeId,
									received: { agentId: aid },
									suggestedNextCall: { tool: "swarm_spawn_agent", params: { id: aid, role: node.role } },
								});
							assigneeId = aid;
						} else if (expectedKind === "root") {
							// Root-role nodes (e.g. commit) are owned by the root pseudo-agent.
							assigneeId = "root";
						} else {
							const found = await findReusableAgent(pi, st, {
								roleKind: expectedKind,
								requireIdle: false,
								requireTmuxAlive: false,
								includeBusy: false,
								excludeTaskId: taskId,
							});
							candidates = found.matches;
							if (found.recommended) assigneeId = found.recommended;
							else if (params.autoSpawn || params.spawnIsolated) {
								const r = await spawnAgent(pi, ctx.cwd, p, st, { id: `${expectedKind}-01`, role: node.role });
								assigneeId = r.agent.id;
								spawned = true;
							} else
								await failTaskTool(
									tp,
									p,
									"NO_AVAILABLE_AGENT",
									`No reusable ${expectedKind} agent for node ${params.nodeId}.`,
									{
										taskId,
										nodeId: params.nodeId,
										expected: { roleKind: expectedKind },
										received: { reusePolicy },
										suggestedNextCall: {
											tool: "swarm_assign_task",
											params: { taskId, nodeId: params.nodeId, autoSpawn: true },
										},
									},
								);
						}
						const assignee = assigneeId ? st.agents[assigneeId] : undefined;
						if (!assignee)
							await failTaskTool(tp, p, "AGENT_NOT_FOUND", `Resolved agent is missing for node ${params.nodeId}.`, {
								taskId,
								nodeId: params.nodeId,
								received: { agentId: assigneeId },
							});
						ensureAgentDefaults(assignee);
						// Issue 26 — spawnedForTaskId (additive durable link). Stamp when this assign path
						// freshly spawned an agent for the task; reuse-pool agents keep their absent field
						// (never overwritten with unrelated task ids). Read by sweepTaskWorkersLocked to
						// decide sweep eligibility when the task closes. Idempotent: a duplicate retry that
						// does NOT spawn does not touch the field.
						if (spawned && !assignee.spawnedForTaskId) assignee.spawnedForTaskId = task.taskId;

						// ---- Preflight auto-clear (Issue 16) ----
						// When this assign resolves to a freshly-spawned agent AND the caller is the same
						// root session that armed the spawn entry AND the spawn was within the grace
						// window, cancel the orphan watchdog early so a slow assign never trips the warning.
						// This is a no-op when any predicate fails — true orphans and cross-root
						// assigns fall through to the normal timer path. The delivery-side
						// clearReason='swarm_assign_task' backstop inside deliverMessageLocked remains intact.
						if (Array.isArray(st.recentSpawns) && st.recentSpawns.length > 0) {
							const entry = st.recentSpawns.find((s) => s.agentId === assignee.id);
							if (entry) {
								const ageMs = Date.now() - new Date(entry.spawnedAt).getTime();
								const callerLeader = {
									pid: process.pid,
									sessionStartedAt: process.env.PI_SWARM_SESSION_STARTED_AT || undefined,
								};
								if (ageMs < PREFLIGHT_ASSIGN_GRACE_MS && isSameRootLeader(entry, callerLeader)) {
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
							let conflict: {
								lease: { taskId: string; nodeId: string; assignee: string; attemptId: string; scope: EffectiveScope };
								relation: string;
							} | null = null;
							let entries: string[] = [];
							try {
								entries = await readdir(p.tasksDir);
							} catch (err: any) {
								if (err?.code !== "ENOENT") {
									await logSwarmError(p, "tasks", "lease_conflict.readdir_failed", err, {
										taskId,
										nodeId: params.nodeId,
									});
								}
							}
							outer: for (const entry of entries) {
								const otherTp = taskPaths(p, entry);
								if (!existsSync(otherTp.taskJson)) continue;
								let other: TaskState;
								try {
									other = await readTaskState(otherTp.taskJson);
								} catch (err: any) {
									if (err?.code !== "ENOENT") {
										await logSwarmError(p, "tasks", "lease_conflict.task_unreadable", err, { taskId: entry });
									}
									continue;
								}
								for (const lease of collectActiveLeases(other)) {
									if (lease.taskId === taskId && lease.nodeId === params.nodeId) continue; // self-exclusion
									const rel = scopesOverlap(candidateScope, lease.scope);
									if (rel.overlap) {
										conflict = { lease, relation: rel.relation };
										break outer;
									}
								}
							}
							if (conflict) {
								const rel = scopesOverlap(candidateScope, conflict.lease.scope) as { relation: string };
								const reqFiles =
									"unresolved" in candidateScope ? [`(unresolved: ${candidateScope.reason})`] : candidateScope.files;
								const confFiles =
									"unresolved" in conflict.lease.scope
										? [`(unresolved: ${conflict.lease.scope.reason})`]
										: conflict.lease.scope.files;
								const reqSource = "unresolved" in candidateScope ? "unresolved" : candidateScope.source;
								const confSource = "unresolved" in conflict.lease.scope ? "unresolved" : conflict.lease.scope.source;
								await traceTask(tp, "task.assign.conflict", {
									taskId,
									nodeId: params.nodeId,
									requestedAssignee: assignee.id,
									requestedScope: reqFiles,
									requestedScopeSource: reqSource,
									conflictingTaskId: conflict.lease.taskId,
									conflictingNodeId: conflict.lease.nodeId,
									conflictingAssignee: conflict.lease.assignee,
									conflictingAttemptId: conflict.lease.attemptId,
									conflictingScope: confFiles,
									conflictingScopeSource: confSource,
									relation: rel.relation,
								});
								await failTaskTool(
									tp,
									p,
									"ACTIVE_SCOPE_CONFLICT",
									`Cannot assign node ${params.nodeId} of ${taskId}: its write scope overlaps the active assignment of node ${conflict.lease.nodeId} in task ${conflict.lease.taskId} (attempt ${conflict.lease.attemptId}, held by ${conflict.lease.assignee}). No state was modified.`,
									{
										taskId,
										nodeId: params.nodeId,
										requestedAssignee: assignee.id,
										requestedScope: reqFiles,
										requestedScopeSource: reqSource,
										conflictingTaskId: conflict.lease.taskId,
										conflictingNodeId: conflict.lease.nodeId,
										conflictingAssignee: conflict.lease.assignee,
										conflictingAttemptId: conflict.lease.attemptId,
										conflictingScope: confFiles,
										conflictingScopeSource: confSource,
										relation: rel.relation,
										actionableHint: `Wait for node ${conflict.lease.nodeId} of ${conflict.lease.taskId} to reach a terminal state (its lease is released then), or narrow this node's allowedFiles so the write scopes are disjoint (e.g. a node-scoped file list instead of the task-wide default).`,
									},
								);
							}
						}
						// ---- end ownership preflight ----

						const prevStatus = node.status;
						// Reassignment bookkeeping: free the previous assignee's active-task pointer.
						if (node.assignee && node.assignee !== assignee.id) {
							const old = st.agents[node.assignee];
							if (old) {
								ensureAgentDefaults(old);
								old.activeTaskIds = old.activeTaskIds.filter((t) => t !== task.taskId);
							}
						}
						// Count a fresh work attempt when (re)entering assigned from a non-active state.
						const isNewAttempt = ["pending", "ready", "blocked"].includes(prevStatus);
						if (isNewAttempt) {
							if (node.maxAttempts && node.attempts >= node.maxAttempts)
								await failTaskTool(
									tp,
									p,
									"INVALID_TRANSITION",
									`Node ${params.nodeId} reached maxAttempts (${node.maxAttempts}); cannot reassign.`,
									{ taskId, nodeId: params.nodeId, received: { attempts: node.attempts, maxAttempts: node.maxAttempts } },
								);
							node.attempts += 1;
						}

						// === Issue 83b — per-node supersession rate-limit gate ===
						// Fixed-window per-node counter. The gate opens (resets the window) when the previous
						// window has expired; otherwise it counts the current window's supersessions and refuses
						// further reassigns once the limit is reached. Run BEFORE mintNodeAttempt so we never
						// mint an attempt we'll then refuse. Duplicate retries (same-active-assignment) bypass
						// the gate because `mintNodeAttempt` will return `created: false` and we never stamp.
						{
							const nowMs = Date.now();
							const nowIso = new Date(nowMs).toISOString();
							const rateRefusal = checkReassignRateLimit(node, nowMs, nowIso);
							if (rateRefusal) {
								await traceTask(tp, TRACE_REASSIGN_RATE_LIMITED, {
									taskId,
									nodeId: params.nodeId,
									requestedAssignee: assignee.id,
									currentCount: rateRefusal.currentCount,
									limit: rateRefusal.limit,
									windowMs: rateRefusal.windowMs,
									windowStart: rateRefusal.windowStart,
									windowResetAt: rateRefusal.windowResetAt,
									by: me,
								}).catch(() => {});
								await failTaskTool(
									tp,
									p,
									REASSIGN_RATE_LIMITED,
									`Cannot reassign node ${params.nodeId} of ${taskId}: supersession rate limit reached (${rateRefusal.currentCount}/${rateRefusal.limit} in the last ${rateRefusal.windowMs}ms). Window resets at ${rateRefusal.windowResetAt}. No state was modified.`,
									{
										taskId,
										nodeId: params.nodeId,
										requestedAssignee: assignee.id,
										currentCount: rateRefusal.currentCount,
										limit: rateRefusal.limit,
										windowMs: rateRefusal.windowMs,
										windowResetAt: rateRefusal.windowResetAt,
										actionableHint: `Wait until the rate-limit window expires at ${rateRefusal.windowResetAt} before reassigning this node again. The gate is hard: refusals do not queue.`,
									},
								);
							}
						}

						// Mint or reuse the attempt (Issue 24.a B5 — extracted helper). The helper inspects the
						// prior state and returns { attemptId, created: false } when the existing active attempt
						// can be preserved (duplicate retry), or { attemptId, created: true } on a genuine mint
						// (which has already superseded any prior active attempt in-place).
						const minted = mintNodeAttempt({ node, assignee: assignee.id, candidateScope, reason: "assign" });
						const attemptId = minted.attemptId;
						if (!minted.created) {
							await traceTask(tp, "task.attempt.reused", {
								taskId,
								nodeId: params.nodeId,
								attemptId,
								assignee: assignee.id,
								reason: "duplicate_assignment_retry",
							});
						} else {
							// The helper already superseded the prior attempt (if any); emit the audit trace
							// here so the caller sees one canonical "superseded" event per supersede.
							const priorSuperseded = (node.attemptHistory || []).find(
								(a: any) => a.supersededBy === attemptId && a.status === "superseded",
							);
							if (priorSuperseded) {
								await traceTask(tp, "task.attempt.superseded", {
									taskId,
									nodeId: params.nodeId,
									priorAttemptId: priorSuperseded.attemptId,
									supersededBy: attemptId,
									reason: "reassign",
								});
							}
							await traceTask(tp, "task.attempt.minted", {
								taskId,
								nodeId: params.nodeId,
								attemptId,
								assignee: assignee.id,
								reason: "assign",
							});
							// === Issue 83b — stamp per-node supersession counter ===
							// Fresh mint = genuine supersession (not duplicate retry). Stamp count + window.
							stampSupersessionCount(node, Date.now(), now());
						}
						node.assignee = assignee.id;
						node.status = "assigned";
						node.lastActivityAt = now();
						if (node.staleAt) {
							const prevStaleAt = node.staleAt;
							delete node.staleAt;
							await traceTask(tp, "task.stale.cleared", {
								taskId,
								nodeId: params.nodeId,
								prevStaleAt,
								reason: "assign",
								by: currentAgentId(),
							});
						}
						if (!assignee.activeTaskIds.includes(task.taskId)) assignee.activeTaskIds.push(task.taskId);
						// === Issue 82: stamp lease on the assignee at assignment time (optional) ===
						// When the caller passes a `lease` parameter, stamp the assignee's record with the
						// lease fields so the task-close sweep honors it (reuse = skip, park = pause).
						// Default behavior unchanged when lease is absent.
						if (params.lease) {
							const leaseUntil =
								params.lease.until && !Number.isNaN(new Date(params.lease.until).getTime())
									? new Date(params.lease.until).toISOString()
									: new Date(Date.now() + 3_600_000).toISOString();
							const leaseReason = params.lease.reason || `assigned with ${params.lease.kind} lease`;
							assignee.leaseKind = params.lease.kind;
							assignee.leaseUntil = leaseUntil;
							assignee.leaseReason = leaseReason;
							assignee.updatedAt = now();
							await traceTask(tp, TRACE_TASK_LEASE_STAMPED, {
								taskId,
								nodeId: params.nodeId,
								assignee: assignee.id,
								leaseKind: params.lease.kind,
								leaseUntil,
								leaseReason,
							});
						}
						const assignTaskStatusChange = applyTaskStatus(task);
						task.currentNodes = computeReadyNodes(task).current;
						// Issue 23 — resolve any stalled task-stall counter for this task (an actionable node
						// now has an assignee, so the predicate is no longer satisfied).
						resolveTaskStallLocked(p, st, task.taskId, "assigned");
						// Issue 26 — task-close worker sweep (terminal transition site #2). Auto-closing an
						// root terminal node via this assign (e.g. a one-node graph or terminal-edge
						// node) drives the task terminal; sweep the freshly-spawned exclusive workers.
						if (assignTaskStatusChange.terminal) await sweepTaskWorkersLocked(pi, ctx.cwd, st, task.taskId, task);

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
						const assignStaleCheck = checkStallNotificationStale(st, task, params.nodeId, assignee.id, Date.now(), {
							freshAssignment: true,
						});
						if (assignStaleCheck.stale) {
							await traceTask(tp, "notification.stale.suppressed", {
								site: "swarm_assign_task.assignment",
								taskId,
								nodeId: params.nodeId,
								reason: assignStaleCheck.reason,
								evidence: assignStaleCheck.evidence,
							});
							const fencedKey = `${idempotencyKey}:fenced`;
							const { msg: fmsg, delivery: fdelivery } = await deliverMessageLocked(pi, ctx.cwd, p, st, {
								to: assignee.id,
								body: `Assignment to node ${params.nodeId} of ${task.taskId} is stale (${assignStaleCheck.reason}: ${assignStaleCheck.evidence.join("; ")}). The assignment record persists but no canonical assignment message was sent.`,
								subject: `Task ${task.taskId} / node ${params.nodeId} assignment FENCED`,
								conversationId,
								requiresAck: false,
								requiresResponse: false,
								idempotencyKey: fencedKey,
								clearReason: "swarm_assign_task",
							});
							const activeAttemptFenced = node.attemptHistory?.find((a: any) => a.attemptId === attemptId);
							if (activeAttemptFenced) activeAttemptFenced.assignmentMessageId = fmsg.id;
							node.assignmentMessageId = fmsg.id;
							node.messageIds = Array.from(new Set([...(node.messageIds || []), fmsg.id]));
							task.handoffs.push({
								fromNode: null,
								toNode: params.nodeId,
								by: me,
								toAgent: assignee.id,
								messageId: fmsg.id,
								at: now(),
								kind: "assign",
								status: fdelivery?.delivered ? (fdelivery.mailboxOnly ? "mailbox_only" : "delivered") : "queued",
								fenced: true,
							});
							await writeTaskState(tp, task);
							await writeState(p, st);
							await traceTask(tp, "task.assign.fenced", {
								taskId,
								nodeId: params.nodeId,
								assignee: assignee.id,
								messageId: fmsg.id,
								reason: assignStaleCheck.reason,
							});
							return {
								task,
								tp,
								msg: fmsg,
								delivery: fdelivery,
								candidates,
								assigneeId: assignee.id,
								fenced: true,
								reason: assignStaleCheck.reason,
							};
						}
						const { msg, delivery } = await deliverMessageLocked(pi, ctx.cwd, p, st, {
							to: assignee.id,
							body,
							subject: `Task ${task.taskId} / node ${params.nodeId} assigned`,
							conversationId,
							requiresAck: PI_SWARM_MINIMAL_PROTOCOL === 1 ? false : true,
							requiresResponse: true,
							idempotencyKey,
							clearReason: "swarm_assign_task",
						});
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
							task.handoffs.push({
								fromNode: null,
								toNode: params.nodeId,
								by: me,
								toAgent: assignee.id,
								messageId: msg.id,
								at: now(),
								kind: "assign",
								status: delivery?.delivered ? (delivery.mailboxOnly ? "mailbox_only" : "delivered") : "queued",
							});
						}

						await writeTaskState(tp, task);
						await writeState(p, st);
						await traceTask(tp, "task.assign", {
							taskId,
							nodeId: params.nodeId,
							assignee: assignee.id,
							messageId: msg.id,
							spawned,
							reusePolicy,
							prevStatus,
							delivered: Boolean(delivery?.delivered),
							mailboxOnly: Boolean(delivery?.mailboxOnly),
							reused: Boolean(delivery?.reused),
							superseded: supersededIds.length,
						});
						return { task, tp, msg, delivery, candidates, assigneeId: assignee.id };
					});
					const delivery = result.delivery;
					const injected = Boolean(delivery?.delivered) && !delivery?.mailboxOnly;
					const fencedSuffix = (result as any).fenced
						? ` Message ${result.msg.id} FENCED (${(result as any).reason}) — informational trace only.`
						: "";
					return textResult(
						`Assigned node ${params.nodeId} of ${result.task.taskId} to ${result.assigneeId}${spawned ? " (spawned)" : ""}. Message ${result.msg.id} ${delivery?.delivered ? (delivery.mailboxOnly ? "queued (mailbox-only)" : "delivered") : "queued (agent not running; reconcile will retry)"}.${fencedSuffix}`,
						{
							taskId: result.task.taskId,
							nodeId: params.nodeId,
							assignee: result.assigneeId,
							spawned,
							messageId: result.msg.id,
							injected,
							delivery,
							candidates: result.candidates,
							fenced: Boolean((result as any).fenced),
							reason: (result as any).reason ?? null,
						},
					);
				});
			},
		}),
	);
}
