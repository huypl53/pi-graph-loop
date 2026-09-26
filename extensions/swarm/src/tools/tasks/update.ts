// === swarm/tools/tasks/update.ts — swarm_update_task tool (real body) ===
// Extracted verbatim from the src/tools/tasks.ts monolith (Phase 6 real split); the C8 fence-stamp
// block is delegated to the stampLateResultRejectionOnInboundMessage helper (./fencing.ts) so the
// fence literals live in exactly one place.

import { Type } from "typebox";
import { ensureRoot, heartbeatRootLeader, isRootAuthority } from "../../identity.ts";
import { PI_SWARM_MINIMAL_PROTOCOL } from "../../constants.ts";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
	CANCELLATION_REASON,
	TERMINAL_NODE_STATUSES,
	TRACE_LATE_RESULT_REJECTED,
	TRACE_LIFECYCLE_DERIVED,
	TRACE_TASK_ATTEMPT_FORCE_REOPEN,
} from "../../constants.ts";
import {
	activateReworkNodes,
	computeReadyNodes,
	applyGateUpdates,
	applySharedContextUpdates,
	applyTaskStatus,
	autoCloseRootTerminalNodes,
	checkClosureNotificationStale,
	failTaskTool,
	isAllowedNodeTransition,
	isTaskOrNodeCancelled,
	mintNodeAttempt,
	releaseNodeAssignment,
	releaseTaskFromAllAgents,
	resolveNodeScope,
	suppressPriorAttemptForForceReopen,
	sweepTaskWorkersLocked,
} from "../../taskgraph.ts";
import type { TaskGateStatus, TaskNodeStatus } from "../../types.ts";
import { resolveTaskStallLocked } from "../../reconcile.ts";
import { currentAgentId } from "../../session.ts";
import {
	deliverMessageLocked,
	deriveLifecycleFromTrigger,
	responseMissingRecords,
	supersedeTaskAssignmentMessages,
	validateResultMessage,
} from "../../mailbox.ts";
import { ensureAgentDefaults, isSafeRelativePath, now, textResult } from "../../utils.ts";
import {
	ensureDirs,
	paths,
	readState,
	readTaskByRef,
	taskPaths,
	trace,
	traceTask,
	withLock,
	writeState,
	writeTaskState,
} from "../../state.ts";
import { attachGitDiffStat, validateAttestations } from "../../trace.ts";
import { tmux } from "../../tmux.ts";
import { checkLateResultRejection, stampCloseEvidenceIfMissing, stampLateResultRejectionOnInboundMessage } from "./fencing.ts";
import { wrapSwarmToolInvocation } from "../wrapper.ts";

export function registerUpdateTaskTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "swarm_update_task",
			label: "Swarm Update Task",
			description:
				"Update an assigned task node's status/outcome/note/artifact/gate/sharedContext. Enforces ownership (current agent must be the node assignee, or root via force) and allowed lifecycle transitions; releases activeTaskIds + editLocks on terminal-ish node states. Validation precedes any write, so invalid calls leave task.json untouched.",
			promptGuidelines: [
				"Use `swarm_update_task` to advance YOUR assigned node. If NODE_ASSIGNEE_MISMATCH, send a task message to the assignee instead of forcing. If OUTCOME_REQUIRED (node done with outgoing branches), retry with an outcome matching an edge `when`. If INVALID_TRANSITION, follow pending->ready->assigned->in_progress->done|failed|blocked; terminal states need the root force override.",
			],
			parameters: Type.Object({
				taskId: Type.String({ description: "Task id." }),
				nodeId: Type.String({ description: "Node id to update." }),
				status: Type.Optional(
					Type.String({ description: "New node status: pending/ready/assigned/in_progress/blocked/done/failed/skipped." }),
				),
				outcome: Type.Optional(
					Type.String({
						description:
							"Branch signal (e.g. planned/implemented/passed/failed/approved/rejected). Required when moving to done on a node with outgoing edges.",
					}),
				),
				note: Type.Optional(Type.String({ description: "Free-text update note (traced with the update)." })),
				artifact: Type.Optional(
					Type.String({ description: "Artifact path produced/referenced by this update (e.g. artifacts/review.md)." }),
				),
				gateUpdates: Type.Optional(
					Type.Record(
						Type.String(),
						Type.Object({
							status: Type.String({ description: "open/passed/failed/waived" }),
							by: Type.Optional(Type.String()),
							artifact: Type.Optional(Type.String()),
						}),
					),
				),
				sharedContextUpdates: Type.Optional(
					Type.Object({
						summary: Type.Optional(Type.String()),
						decisions: Type.Optional(Type.Array(Type.Object({ text: Type.String(), severity: Type.Optional(Type.String()) }))),
						risks: Type.Optional(Type.Array(Type.Object({ text: Type.String(), severity: Type.Optional(Type.String()) }))),
						openQuestions: Type.Optional(Type.Array(Type.Object({ text: Type.String() }))),
					}),
				),
				force: Type.Optional(
					Type.Boolean({ description: "Root override: skip ownership + transition checks. Defaults to false." }),
				),
				cancelTask: Type.Optional(
					Type.Boolean({
						description:
							"Root-only (requires force): mark the whole task cancelled. Sticky: a cancelled task stays cancelled and releases all assignments. Defaults to false.",
					}),
				),
				attemptId: Type.Optional(
					Type.String({
						description:
							"Opaque attempt token received in assignment. Required for non-root callers when node has an active attempt. Prevents stale updates from superseded attempts.",
					}),
				),
				attestations: Type.Optional(
					Type.Array(Type.Object({ claim: Type.String(), tool: Type.String(), eventId: Type.String(), ts: Type.String() })),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_update_task", async () => {
					const p = paths(ctx.cwd);
					await ensureDirs(p);
					const me = currentAgentId();
					const isOrch = isRootAuthority(me);
					// Server-side RBAC (reliability-roadmap Phase 1, P0 #1): `force` and `cancelTask` are
					// root-only escape hatches. Identity is checked against the live agent record; the
					// caller's params cannot grant authority. Validation precedes any state mutation.
					if (params.cancelTask === true) {
						if (!isRootAuthority(me)) {
							await trace(p, "task.rbac.cancel_forbidden", { taskId: params.taskId, caller: me, by: me });
							throw new Error(
								`CANCEL_FORBIDDEN: swarm_update_task(cancelTask=true) requires root authority (caller=${me}). Only the root may cancel a task.`,
							);
						}
						if (params.force !== true) {
							throw new Error(`CANCEL_REQUIRES_FORCE: cancelTask=true must accompany force=true (root-only operation).`);
						}
					}
					if (params.force === true && !isRootAuthority(me)) {
						await trace(p, "task.rbac.force_forbidden", { taskId: params.taskId, nodeId: params.nodeId, caller: me, by: me });
						throw new Error(
							`FORCE_FORBIDDEN: swarm_update_task(force=true) requires root authority (caller=${me}). Only the root may bypass ownership/transition checks.`,
						);
					}
					const result = await withLock(p, async () => {
						const st = await readState(p, ctx.cwd);
						if (isOrch) heartbeatRootLeader(st, Date.now(), process.pid, "update_task");
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
						// Cancellation fence (issue 3, fix-1): once a task is cancelled, NO caller — not even the
						// root — can mutate task or node state via this handler. The fence is the most
						// authoritative gate and runs BEFORE ownership/attempt checks so task cancellation
						// deterministically wins for any late worker mutation (a worker that isn't even the
						// assignee still gets TASK_CANCELLED, not NODE_ASSIGNEE_MISMATCH, on a cancelled task).
						// Re-open is a separately-designed policy (out of scope for this PR). Allow the
						// cancelTask request itself through (the only mutation that returns ok on a cancelled
						// task is a redundant cancel — handled below by checking `params.cancelTask` after the
						// fence).
						if (isTaskOrNodeCancelled(task, params.nodeId) && !params.cancelTask) {
							const where =
								task.status === "cancelled"
									? `Task ${taskId} is cancelled`
									: `Node ${params.nodeId} of task ${taskId} is cancelled`;
							await traceTask(tp, "task.cancel.fenced", {
								taskId,
								nodeId: params.nodeId,
								by: me,
								requestedStatus: params.status,
							});
							await failTaskTool(
								tp,
								p,
								task.status === "cancelled" ? "TASK_CANCELLED" : "NODE_CANCELLED",
								`${where}. No further task or node updates are accepted. To re-open, the root must explicitly restore the task via a separately-designed policy (out of scope).`,
								{
									taskId,
									nodeId: params.nodeId,
									taskStatus: task.status,
									nodeStatus: node.status,
									blocked: true,
									suggestedNextCall: { tool: "swarm_task_status", params: { taskId } },
								},
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
									await traceTask(tp, "task.attempt.reused", {
										taskId,
										nodeId: params.nodeId,
										attemptId,
										assignee: me,
										reason: "duplicate_claim_retry",
									});
								} else {
									const priorSuperseded = (node.attemptHistory || []).find(
										(a: any) => a.supersededBy === attemptId && a.status === "superseded",
									);
									if (priorSuperseded) {
										await traceTask(tp, "task.attempt.superseded", {
											taskId,
											nodeId: params.nodeId,
											priorAttemptId: priorSuperseded.attemptId,
											supersededBy: attemptId,
											reason: "claim",
										});
									}
									await traceTask(tp, "task.attempt.minted", {
										taskId,
										nodeId: params.nodeId,
										attemptId,
										assignee: me,
										reason: "claim",
									});
								}
								node.assignee = me;
								node.status = "assigned";
								node.lastActivityAt = now();
								if (node.staleAt) {
									const prevStaleAt = node.staleAt;
									delete node.staleAt;
									await traceTask(tp, "task.stale.cleared", {
										taskId,
										nodeId: params.nodeId,
										prevStaleAt,
										reason: "claim",
										by: me,
									});
								}
								// B7 — explicit activeTaskIds update on the claimer. Mirror the
								// swarm_assign_task path so the claimer's runtimeStatus / capacity accounting
								// doesn't drift. ensureAgentDefaults is belt-and-braces for legacy agents
								// that lack the array.
								if (!st.agents[me]) {
									// Worker claimed a node without ever being registered. Create a minimal
									// agent record so capacity accounting + tool surfaces work; the root
									// can re-register with full details (model/provider/role) later.
									st.agents[me] = {
										id: me,
										role: "",
										roleKind: "worker",
										capabilities: [],
										activeTaskIds: [],
										maxConcurrentTasks: 1,
										status: "running",
										runtimeStatus: "busy",
										health: "healthy",
										tmuxSession: st.tmuxSession,
										tmuxWindow: "",
										tmuxTarget: "unknown",
										model: "",
										provider: "",
										cwd: ctx.cwd,
										mailbox: `.pi/swarm/mailboxes/${me}.jsonl`,
										createdAt: now(),
										updatedAt: now(),
									};
								}
								ensureAgentDefaults(st.agents[me]);
								if (!st.agents[me].activeTaskIds.includes(task.taskId)) st.agents[me].activeTaskIds.push(task.taskId);
								const claimTaskStatusChange = applyTaskStatus(task);
								task.currentNodes = computeReadyNodes(task).current;
								// Issue 23 — claim resolves any stalled task-stall counter.
								resolveTaskStallLocked(p, st, task.taskId, "claim");
								// Issue 26 — task-close worker sweep (terminal transition site #3). A claim
								// that closes the task (e.g. a terminal-node claim) drives the sweep path.
								if (claimTaskStatusChange.terminal) await sweepTaskWorkersLocked(pi, ctx.cwd, st, task.taskId, task);
								await writeTaskState(tp, task);
								await writeState(p, st);
								await traceTask(tp, "task.node.claimed", {
									taskId,
									nodeId: params.nodeId,
									claimer: me,
									priorAssignee: null,
									priorStatus,
									attemptId,
									created: minted.created,
								});
								// Inject the freshly minted attemptId so the attempt-fencing check below
								// (which runs unconditionally for nodes with activeAttemptId) accepts the
								// claimer's continuation. Without this, the caller would have to supply
								// attemptId explicitly even though we just minted it.
								if (!params.attemptId) params.attemptId = attemptId;
							} else if (node.assignee === undefined && node.status === "in_progress") {
								// Issue 24.a — in-flight unassigned node: refuse with inline-string
								// OWNERSHIP_REQUIRED. Per B2, this is scoped to one tool + one path, not a
								// ERR_* engine-wide constant. The hint points the caller at the root.
								await traceTask(tp, "task.update.ownership_reject", {
									taskId,
									nodeId: params.nodeId,
									attemptedBy: me,
									priorAssignee: null,
									priorStatus: node.status,
									isRoot: false,
									remediation: "escalate_to_root",
									errorCode: "OWNERSHIP_REQUIRED",
								});
								await failTaskTool(
									tp,
									p,
									"OWNERSHIP_REQUIRED",
									`Node ${params.nodeId} is in_progress but has no assignee; claiming an in-flight node is forbidden.`,
									{
										taskId,
										nodeId: params.nodeId,
										expected: {
											assigneeRequired: true,
											allowedAction:
												"ask root to reassign via swarm_assign_task(..., force=true) or close the in-flight node",
										},
										received: { agentId: me, requestedStatus: params.status, nodeStatus: node.status },
										severity: "error",
										suggestedNextCall: {
											tool: "swarm_send_message",
											params: { to: "root", subject: `Reassign in-flight node ${params.nodeId} of ${taskId}` },
										},
									},
								);
							} else {
								// Existing reject path: node.assignee is set and !== me.
								await traceTask(tp, "task.update.ownership_reject", {
									taskId,
									nodeId: params.nodeId,
									attemptedBy: me,
									priorAssignee: node.assignee || null,
									priorStatus: node.status,
									isRoot: false,
									remediation: "escalate_to_root",
									errorCode: "NODE_ASSIGNEE_MISMATCH",
								});
								const hint = `Send a task message to the assignee (${node.assignee}), or ask the root to reassign (swarm_assign_task, force=true).`;
								await failTaskTool(
									tp,
									p,
									"NODE_ASSIGNEE_MISMATCH",
									`Node ${params.nodeId} is assigned to ${node.assignee || "(unassigned)"}, but current agent is ${me}.`,
									{
										taskId,
										nodeId: params.nodeId,
										expected: {
											assignee: node.assignee || null,
											allowedAction: "update your own assigned node or send a task message",
										},
										received: { agentId: me, requestedStatus: params.status },
										actionableHint: hint,
									},
								);
							}
						}

						// NEW: Attempt fencing validation (same-agent reassign protection)
						// This is the critical fix: caller must present the active attempt token to fence stale updates
						if (node.activeAttemptId) {
							if (!isOrch) {
								// Non-root callers must provide attempt token for nodes with active attempts
								if (!params.attemptId) {
									await failTaskTool(
										tp,
										p,
										"ATTEMPT_TOKEN_REQUIRED",
										`Node ${params.nodeId} has active attempt fencing. You must provide the attemptId parameter from your assignment contract.`,
										{
											taskId,
											nodeId: params.nodeId,
											expected: { attemptId: node.activeAttemptId },
											received: { attemptId: params.attemptId || "(missing)" },
											suggestedNextCall: {
												tool: "swarm_update_task",
												params: { ...params, attemptId: node.activeAttemptId },
											},
											actionableHint:
												"The attempt token is delivered with your assignment message — check your mailbox if you don't have it.",
										},
									);
								}
								// Verify the attempt token matches the active attempt (untrusted input validation)
								if (params.attemptId !== node.activeAttemptId) {
									// Find the attempt for error context
									const providedAttempt = node.attemptHistory?.find((a: any) => a.attemptId === params.attemptId);
									const providedStatus = providedAttempt ? providedAttempt.status : "unknown";
									const activeAttempt = node.attemptHistory?.find((a: any) => a.attemptId === node.activeAttemptId);
									const activeNumber = activeAttempt ? activeAttempt.attemptNumber : "?";

									// === Issue 83b — late-result rejection ===
									// The caller's attemptId is in attemptHistory as NON-active (e.g. superseded)
									// AND the node has a NEWER active attempt. The caller is the prior assignee
									// trying to apply a stale result. Refuse with a distinct envelope so the
									// caller can self-correct (read latest assignment) without retrying.
									// Emits TRACE_LATE_RESULT_REJECTED + (optionally) stamps lateResultRejectionCount
									// on the inbound message record. No node mutation.
									const lateRefusal = checkLateResultRejection(node, params.attemptId, now());
									if (lateRefusal && providedAttempt && providedAttempt.status !== "active") {
										await traceTask(tp, TRACE_LATE_RESULT_REJECTED, {
											taskId,
											nodeId: params.nodeId,
											providedAttemptId: lateRefusal.providedAttemptId,
											providedAttemptStatus: lateRefusal.providedAttemptStatus,
											activeAttemptId: lateRefusal.activeAttemptId,
											activeAttemptNumber: lateRefusal.activeAttemptNumber,
											supersededAt: lateRefusal.supersededAt,
											lateArrivalAt: lateRefusal.lateArrivalAt,
											attemptedBy: me,
											requestedStatus: params.status,
											reason: "superseded_attempt_late_result",
										}).catch(() => {});
										// === Issue 83b — stamp MessageRecord.lateResultRejectionCount (round-4) ===
										// Find the assignment message record that carried the caller's (now-superseded)
										// attemptId by walking `node.attemptHistory` for the matching attempt's
										// `assignmentMessageId`. Stamp `lateResultRejectionCount` + `lastLateResultRejectionAt`
										// on that record so operators can count late-arrival rejections per message.
										// Distinct from `rec.superseded` (which records the supersede event itself):
										// the counter measures REJECTION EVENTS, not the single supersede stamp.
										// Stamps MessageRecord.lateResultRejectionCount on the inbound assignment
										// (C8 fence literals live in the facade helper stampLateResultRejectionOnInboundMessage).
										await stampLateResultRejectionOnInboundMessage(
											tp,
											st,
											node,
											taskId,
											params.nodeId,
											params.attemptId,
										);
										throw new Error(`__LATE_RESULT_REFUSED__:${JSON.stringify(lateRefusal)}`);
									}

									await failTaskTool(
										tp,
										p,
										"ATTEMPT_TOKEN_MISMATCH",
										`Your attempt token ${params.attemptId} is not the active attempt for node ${params.nodeId}. Your attempt is ${providedStatus}; the current attempt is #${activeNumber} (${node.activeAttemptId}). This update is rejected as a stale write.`,
										{
											taskId,
											nodeId: params.nodeId,
											expected: { activeAttemptId: node.activeAttemptId, activeAttemptNumber: activeNumber },
											received: { attemptId: params.attemptId, attemptStatus: providedStatus },
											blocked: true,
											actionableHint:
												"Your attempt has been superseded by a new assignment. Read the latest message in your mailbox (or call swarm_next_nodes to see the current assignment) before retrying.",
										},
									);
								}

								// Verify the attempt record exists and is valid
								const activeAttempt = node.attemptHistory?.find((a: any) => a.attemptId === node.activeAttemptId);
								if (!activeAttempt) {
									await failTaskTool(
										tp,
										p,
										"ATTEMPT_NOT_FOUND",
										`Active attempt ${node.activeAttemptId} not found in attempt history for node ${params.nodeId}. State is corrupted; this is a data integrity error.`,
										{
											taskId,
											nodeId: params.nodeId,
											expected: { activeAttemptId: node.activeAttemptId },
											received: { attemptHistorySize: node.attemptHistory?.length || 0 },
											severity: "critical",
										},
									);
								}
								if (activeAttempt.status !== "active") {
									await failTaskTool(
										tp,
										p,
										"ATTEMPT_NOT_ACTIVE",
										`Attempt ${node.activeAttemptId} is not active (status=${activeAttempt.status}) for node ${params.nodeId}. This is a state inconsistency.`,
										{
											taskId,
											nodeId: params.nodeId,
											expected: { status: "active" },
											received: { status: activeAttempt.status },
											severity: "critical",
										},
									);
								}
								// Verify caller is the active attempt's assignee (additional guard beyond assignee check)
								if (activeAttempt.assignee !== me) {
									await failTaskTool(
										tp,
										p,
										"ATTEMPT_ASSIGNEE_MISMATCH",
										`Active attempt ${activeAttempt.attemptId} is assigned to ${activeAttempt.assignee}, not ${me}.`,
										{
											taskId,
											nodeId: params.nodeId,
											expected: { assignee: activeAttempt.assignee },
											received: { agentId: me },
											blocked: true,
										},
									);
								}
							} else {
								// Root with force: attempt check is bypassed (force override)
								await traceTask(tp, "task.attempt.bypassed", {
									taskId,
									nodeId: params.nodeId,
									activeAttemptId: node.activeAttemptId,
									by: me,
									reason: "root_force",
								});
							}
						} else if (!node.activeAttemptId && (!node.attemptHistory || node.attemptHistory.length === 0)) {
							// Legacy task: no attempt fencing, fall back to existing assignee check only
							// Log a migration hint but don't fail
							await traceTask(tp, "task.legacy_attempt", {
								taskId,
								nodeId: params.nodeId,
								hint: "Node has no attempt history - using legacy assignee check only. First assignment will create attempt records.",
							});
						}
						// End attempt fencing validation

						if (params.artifact && !isSafeRelativePath(params.artifact))
							await failTaskTool(
								tp,
								p,
								"PATH_OUTSIDE_TASK",
								`Artifact path is unsafe (must be relative, no ..): ${params.artifact}`,
								{ taskId, nodeId: params.nodeId, received: { artifact: params.artifact } },
							);

						const prevStatus = node.status;
						const newStatus = (params.status as TaskNodeStatus | undefined) || prevStatus;
						if (newStatus !== prevStatus && !isOrch && !isAllowedNodeTransition(prevStatus, newStatus))
							await failTaskTool(
								tp,
								p,
								"INVALID_TRANSITION",
								`Node ${params.nodeId} cannot move ${prevStatus} -> ${newStatus}.`,
								{
									taskId,
									nodeId: params.nodeId,
									expected: {
										lifecycle:
											"pending->ready->assigned->in_progress->done|failed|blocked; terminal states need root override",
									},
									received: { from: prevStatus, to: newStatus },
									actionableHint: "If you believe the transition should be allowed, escalate to the root (force=true).",
								},
							);
						const outEdges = task.edges.filter((e) => e.from === params.nodeId);
						if (newStatus === "done" && outEdges.length && !params.outcome && !node.outcome)
							await failTaskTool(
								tp,
								p,
								"OUTCOME_REQUIRED",
								`Node ${params.nodeId} has outgoing branches but no outcome was provided.`,
								{
									taskId,
									nodeId: params.nodeId,
									expected: { validOutcomes: [...new Set(outEdges.map((e) => e.when))] },
									received: { outcome: params.outcome },
									suggestedNextCall: {
										tool: "swarm_update_task",
										params: { taskId, nodeId: params.nodeId, status: "done", outcome: outEdges[0].when },
									},
								},
							);
						let attestationReport: Awaited<ReturnType<typeof validateAttestations>> | undefined;
						if (
							newStatus === "done" &&
							(params.outcome === "implemented" ||
								params.outcome === "fixed" ||
								node.outcome === "implemented" ||
								node.outcome === "fixed")
						) {
							const artifactText = params.artifact
								? await readFile(join(tp.root, params.artifact), "utf8").catch(() => "")
								: "";
							attestationReport = await validateAttestations(p, {
								note: params.note,
								artifactText,
								attestations: params.attestations as
									Array<{ claim: string; tool: string; eventId: string; ts: string }> | undefined,
							});
							if (!attestationReport.ok) {
								await traceTask(tp, "task.attestation.rejected", {
									taskId,
									nodeId: params.nodeId,
									errors: (attestationReport as any).errors,
									matchedClaims: attestationReport.matchedClaims,
								});
								await failTaskTool(tp, p, "ATTESTATION_REJECTED", (attestationReport as any).errors.join("; "), {
									taskId,
									nodeId: params.nodeId,
									rejected: (attestationReport as any).errors,
									matchedClaims: attestationReport.matchedClaims,
								});
							}
							await traceTask(tp, "task.attestation.ok", {
								taskId,
								nodeId: params.nodeId,
								checked: attestationReport.checked,
								matchedClaims: attestationReport.matchedClaims,
							});
						}

						let forceReopen: { priorAttemptId: string | undefined } | undefined;
						if (
							isOrch &&
							params.force === true &&
							TERMINAL_NODE_STATUSES.has(prevStatus) &&
							!TERMINAL_NODE_STATUSES.has(newStatus)
						) {
							forceReopen = suppressPriorAttemptForForceReopen(node);
							node.assignee = undefined;
							node.assignmentMessageId = undefined;
							node.outcome = null;
							const sup = await supersedeTaskAssignmentMessages(p, st, task, "force-reopen", me);
							await traceTask(tp, TRACE_TASK_ATTEMPT_FORCE_REOPEN, {
								taskId,
								nodeId: params.nodeId,
								priorStatus: prevStatus,
								priorAttemptId: forceReopen.priorAttemptId ?? null,
								supersededMessages: sup.supersededIds.length,
								by: me,
							});
						}

						// Validation complete; apply (no earlier writes occurred).
						node.status = newStatus;
						if ((newStatus === "assigned" || newStatus === "in_progress" || newStatus === "ready") && node.staleAt) {
							delete node.staleAt;
						}
						// === R20: forward-transition resets the artifact-progress nudge cycle ===
						// Any forward progress stamp (assigned/in_progress/ready) OR a terminal transition
						// (done/failed/blocked) signals fresh agent activity; clear the nudge bookkeeping so
						// a future re-open of the node starts from a clean counter. This mirrors the existing
						// `staleOpenSurfacedAt` clearing pattern (above) and the Issue 83a lastProgressAt stamp.
						if (
							newStatus === "assigned" ||
							newStatus === "in_progress" ||
							newStatus === "ready" ||
							newStatus === "done" ||
							newStatus === "failed" ||
							newStatus === "blocked"
						) {
							if (node.artifactProgressNudgeAt) {
								delete node.artifactProgressNudgeAt;
								await traceTask(tp, "task.artifact_progress_nudge_count_reset", {
									taskId,
									nodeId: params.nodeId,
									reason: "forward_transition",
									by: me,
								});
							}
							if (node.artifactProgressNudgeCount) {
								node.artifactProgressNudgeCount = 0;
							}
							if (node.artifactProgressCapSurfaced) {
								delete node.artifactProgressCapSurfaced;
							}
						}
						if (params.outcome !== undefined) node.outcome = params.outcome;
						node.lastActivityAt = now();

						// NEW: Update attempt status on terminal node state
						if (
							node.activeAttemptId &&
							node.attemptHistory &&
							(newStatus === "done" || newStatus === "failed" || newStatus === "skipped")
						) {
							const activeAttempt = node.attemptHistory.find((a: any) => a.attemptId === node.activeAttemptId);
							if (activeAttempt && activeAttempt.status === "active") {
								activeAttempt.status = newStatus === "done" ? "completed" : newStatus;
								activeAttempt.outcome = params.outcome || node.outcome || undefined;
								activeAttempt.lastActivityAt = now();
								// Lease release audit (issue 4): terminal attempt ends its write-scope lease.
								activeAttempt.releasedAt ||= now();
								activeAttempt.releaseReason = isOrch ? "root_override" : "terminal";
								await traceTask(tp, "task.attempt.terminal", {
									taskId,
									nodeId: params.nodeId,
									attemptId: node.activeAttemptId,
									status: activeAttempt.status,
									outcome: activeAttempt.outcome,
								});
							}
						}

						if (params.gateUpdates)
							applyGateUpdates(
								task,
								params.gateUpdates as Record<string, { status: TaskGateStatus; by?: string; artifact?: string | null }>,
								me,
							);
						if (params.sharedContextUpdates)
							applySharedContextUpdates(
								task,
								params.sharedContextUpdates as {
									summary?: string;
									decisions?: Array<{ text: string; severity?: string }>;
									risks?: Array<{ text: string; severity?: string }>;
									openQuestions?: Array<{ text: string }>;
								},
								me,
							);
						if (params.artifact) node.writeArtifacts = Array.from(new Set([...(node.writeArtifacts || []), params.artifact]));
						releaseNodeAssignment(st, task, params.nodeId);
						const reopened = activateReworkNodes(task, tp);
						const closingAssignee = node.assignee || undefined; // persisted on the node (not cleared by release)
						// Root-explicit cancellation (issue 3): sticky terminal state. Strengthened to:
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
							await traceTask(tp, "task.cancel.revoke_all", {
								taskId,
								revokedAttempts,
								supersededMessages: sup.supersededIds.length,
								skipped: sup.skipped,
								by: me,
							});
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
								if (
									n.assignee &&
									n.assignee !== "root" &&
									(n.status === "cancelled" || n.status === "assigned" || n.status === "in_progress")
								) {
									triggeringAssigneeMap.set(n.assignee, nId);
								}
							}
							const notifiees = new Set(triggeringAssigneeMap.keys());
							for (const [assigneeId, nId] of triggeringAssigneeMap) {
								const cancelStaleCheck = checkClosureNotificationStale(st, task, nId, assigneeId, Date.now());
								if (cancelStaleCheck.stale) {
									await traceTask(tp, "notification.stale.suppressed", {
										site: "swarm_update_task.cancellation",
										taskId,
										to: assigneeId,
										nodeId: nId,
										reason: cancelStaleCheck.reason,
										evidence: cancelStaleCheck.evidence,
									});
									notifiees.delete(assigneeId);
									continue;
								}
							}
							for (const assigneeId of notifiees) {
								try {
									ensureRoot(st, ctx.cwd, p);
									await deliverMessageLocked(pi, ctx.cwd, p, st, {
										to: assigneeId,
										subject: `Assignment cancelled: ${task.taskId}`,
										body: `Your work on task ${task.taskId} has been cancelled by the root (${me}). All active attempts are revoked and assignment messages are superseded.\n\nAction:\n- Stop work on this task immediately.\n- Do NOT call swarm_update_task for any node in this task — it will be rejected with TASK_CANCELLED.\n- Informational only; no acknowledgement required.`,
										conversationId: `cancel:${task.taskId}`,
										requiresAck: false,
										requiresResponse: false,
										clearReason: "swarm_assign_task",
									});
								} catch (err: any) {
									await traceTask(tp, "task.cancel.notify_failed", {
										taskId,
										to: assigneeId,
										error: String((err as Error)?.message || err),
									});
								}
							}
						}
						let taskStatusChange = applyTaskStatus(task);
						// === Issue 25 Phase 2: terminal-update lock-held inference (proposal §B.1, §J.1, plan §2.11(a)) ===
						// When node.status just transitioned to a terminal status (done/failed/skipped) under gate=1
						// AND the node has a canonical assignment message (node.assignmentMessageId set by
						// swarm_assign_task), run validateResultMessage semantics + response-debt release INSIDE this
						// same withLock(p) the caller already holds. Stamps terminalAt via the same pure helper
						// (deriveLifecycleFromTrigger) used everywhere else. No nested lock; no separate writeState
						// needed because the parent block already writes state after the closure computation.
						// Under gate=0 this branch is skipped (Phase-1 ack-path-only behavior preserved).
						if (
							PI_SWARM_MINIMAL_PROTOCOL === 1 &&
							(newStatus === "done" || newStatus === "failed" || newStatus === "skipped") &&
							node.assignmentMessageId
						) {
							const rec = st.messages[node.assignmentMessageId];
							if (
								rec &&
								rec.requiresResponse &&
								rec.response?.status !== "verified" &&
								rec.response?.status !== "waived" &&
								!rec.superseded
							) {
								// Read the most-recent resultMessageId (the worker's swarm_send_message({replyTo})).
								const resultId = rec.response?.resultMessageId;
								if (!resultId) {
									throw new Error(
										`RESPONSE_REQUIRED: Node ${params.nodeId} of ${taskId} reached terminal status but the assignment's requiresResponse=true record has no verified reply. Send swarm_send_message(to="${rec.from}", replyTo="${rec.id}", ...) first, then call swarm_update_task again.`,
									);
								}
								validateResultMessage(st, rec, resultId, me);
								rec.response = {
									...(rec.response || { status: "missing" as any }),
									status: "verified",
									resultMessageId: resultId,
									verifiedAt: now(),
									lastError: undefined,
								};
								rec.updatedAt = now();
								// Release response debt: if the assignee's runtimeStatus was "response_missing" and
								// this was their last open response, unstick it.
								if (
									rec.to &&
									st.agents[rec.to]?.runtimeStatus === "response_missing" &&
									responseMissingRecords(st, rec.to).length === 0
								) {
									st.agents[rec.to].runtimeStatus = "idle";
									st.agents[rec.to].updatedAt = now();
								}
								// Stamp terminalAt via the pure helper (reused everywhere).
								const activeAttempt = node.activeAttemptId
									? node.attemptHistory?.find((a: any) => a.attemptId === node.activeAttemptId)
									: undefined;
								const d = deriveLifecycleFromTrigger(rec, {
									kind: "task_node_terminal",
									taskId,
									nodeId: params.nodeId,
									attemptId: activeAttempt?.attemptId,
								});
								if (d.kind === "set") {
									(rec as any)[d.field] = d.value;
									rec.lifecycleStage = d.stage;
									rec.lifecycleSource = d.source;
									rec.terminalReason = d.reason;
									await traceTask(tp, TRACE_LIFECYCLE_DERIVED, {
										messageId: rec.id,
										from: rec.from,
										to: rec.to,
										field: d.field,
										source: d.source,
										stage: d.stage,
										taskId,
										nodeId: params.nodeId,
										attemptId: activeAttempt?.attemptId,
										gate: 1,
										reason: d.reason,
										via: "swarm_update_task.terminal",
									});
								}
							}
						}
						const autoClosed = await autoCloseRootTerminalNodes(pi, tp, task, ctx.cwd);
						for (const nodeId of autoClosed.closed) releaseNodeAssignment(st, task, nodeId);
						if (autoClosed.closed.length) taskStatusChange = applyTaskStatus(task);
						if (taskStatusChange.terminal) {
							releaseTaskFromAllAgents(st, task.taskId);
							// Issue 23 — terminal task transition: clear any stalled task-stall counter
							// (the predicate "task in_progress" is no longer satisfied).
							resolveTaskStallLocked(p, st, task.taskId, "task_terminal");
							// Issue 26 — task-close worker sweep (terminal transition sites #4 + #5). The
							// sweep runs AFTER releaseTaskFromAllAgents so every closed-task pointer is
							// gone from agents before eligibility is computed. Safe under concurrent
							// close because we are inside the same withLock(p) the caller holds.
							await sweepTaskWorkersLocked(pi, ctx.cwd, st, task.taskId, task);
						}
						const isNodeClosing =
							newStatus === "done" || newStatus === "failed" || newStatus === "blocked" || newStatus === "cancelled";
						if (isNodeClosing || taskStatusChange.terminal) {
							await stampCloseEvidenceIfMissing(pi, tp, task, params.nodeId, attestationReport, undefined, ctx.cwd);
						}
						const nextReady = computeReadyNodes(task);
						task.currentNodes = nextReady.current;
						await writeTaskState(tp, task);
						await writeState(p, st);
						await traceTask(tp, "task.update", {
							taskId,
							nodeId: params.nodeId,
							prevStatus,
							status: newStatus,
							outcome: params.outcome,
							note: Boolean(params.note),
							artifact: params.artifact,
							gateUpdates: params.gateUpdates ? Object.keys(params.gateUpdates) : [],
							sharedContext: Boolean(params.sharedContextUpdates),
							by: me,
							autoClosed: autoClosed.closed,
							reopened,
						});
						let diffStat: { available: boolean; baseline?: string; stat?: string; note?: string } | undefined;
						if (attestationReport) {
							diffStat = await attachGitDiffStat(pi, ctx.cwd, tp);
							await traceTask(tp, "task.attestation.diffstat", {
								taskId,
								nodeId: params.nodeId,
								baseline: diffStat.baseline || null,
								stat: diffStat.stat || null,
								note: diffStat.note || null,
							});
						}
						if (autoClosed.closed.length)
							await traceTask(tp, "task.autoclose.root", {
								taskId,
								nodeIds: autoClosed.closed,
								triggerNodeId: params.nodeId,
								by: "engine",
							});
						if (cancelled) await traceTask(tp, "task.cancel", { taskId, nodeId: params.nodeId, by: me });
						if (taskStatusChange.terminal)
							await traceTask(tp, "task.close", { taskId, status: task.status, nodeId: params.nodeId, by: me });
						// PM auto-notify (engine behavior): when a node transitions INTO a closure-ish status
						// (done|failed|blocked) the PM no longer has to poll — enqueue a concise mailbox report to the
						// mailbox-only root. On task-terminal (done|failed|cancelled) emit the stronger
						// task-close variant. Gated on the transition (not every update) so it isn't spammy;
						// mailbox-only (no tmux inject); requiresAck=false (informational; root pump surfaces
						// it). Best-effort: never fails the update. NB: node-status mutation already happened above;
						// this only sends a message.
						const closureIsh = (s: TaskNodeStatus | undefined): boolean =>
							s === "done" || s === "failed" || s === "blocked" || s === "cancelled";
						const closedNow = !closureIsh(prevStatus) && closureIsh(newStatus);
						if (closedNow) {
							// Lifecycle-fencing (issue 9, site 6): per-node closure staleness check. The predicate is
							// deliberately narrow: it does NOT consider the just-set terminal status or task status
							// as staleness — those are the trigger. Stale iff the node has since been reopened and
							// reassigned to a different agent (rework race) OR the node has been removed from the graph.
							const closeStaleCheck = checkClosureNotificationStale(st, task, params.nodeId, closingAssignee, Date.now());
							if (closeStaleCheck.stale) {
								await traceTask(tp, "notification.stale.suppressed", {
									site: "swarm_update_task.closure",
									taskId,
									nodeId: params.nodeId,
									reason: closeStaleCheck.reason,
									evidence: closeStaleCheck.evidence,
								});
							} else {
								ensureRoot(st, ctx.cwd, p);
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
									await deliverMessageLocked(pi, ctx.cwd, p, st, {
										to: "root",
										subject,
										body,
										conversationId: `task:${task.taskId}:${params.nodeId}`,
										requiresAck: false,
									});
									await traceTask(tp, "task.close.notify", {
										taskId,
										nodeId: params.nodeId,
										status: newStatus,
										taskStatus: task.status,
										to: "root",
									});
								} catch (err: any) {
									await traceTask(tp, "task.close.notify_failed", {
										taskId,
										nodeId: params.nodeId,
										error: String(err?.message || err),
									});
								}
								await writeState(p, st); // persist the notify message record + root pseudo-agent
							}
						}
						return {
							task,
							prevStatus,
							newStatus,
							taskStatus: task.status,
							cancelled,
							autoClosed: autoClosed.closed,
							reopened,
							diffStat,
						};
					}).catch((err: any) => {
						// === Issue 83b — late-result refusal conversion ===
						// The attempt-fencing block throws a marker Error when it detects a superseded-attempt
						// late-result with a newer active attempt on the node. Convert it to a refusal envelope
						// (no node mutation) and return. This catch runs INSIDE the same tool execute body so
						// the outer wrapSwarmToolInvocation still records `tool.invoked` for the call.
						if (err && typeof err.message === "string" && err.message.startsWith("__LATE_RESULT_REFUSED__:")) {
							try {
								const refusal = JSON.parse(err.message.slice("__LATE_RESULT_REFUSED__:".length));
								return { __lateResultRefused: true, refusal };
							} catch {
								throw err;
							}
						}
						throw err;
					});
					// Handle late-result refusal: convert the marker result to a refusal textResult (NO mutation).
					if ((result as any)?.__lateResultRefused) {
						const refusal = (result as any).refusal;
						return textResult(
							`Refused: late result from superseded attempt ${refusal.providedAttemptId} (status=${refusal.providedAttemptStatus}) for node ${params.nodeId} of ${params.taskId}. The active attempt is #${refusal.activeAttemptNumber} (${refusal.activeAttemptId}). Your attempt was superseded at ${refusal.supersededAt ?? "(unknown)"}; this update was rejected to prevent stale state. Read your mailbox for the latest assignment, then retry.`,
							{
								taskId: params.taskId,
								nodeId: params.nodeId,
								refused: true,
								reason: refusal.reason,
								providedAttemptId: refusal.providedAttemptId,
								activeAttemptId: refusal.activeAttemptId,
								activeAttemptNumber: refusal.activeAttemptNumber,
								lateArrivalAt: refusal.lateArrivalAt,
								actionableHint:
									"Your attempt was superseded by a newer assignment. Read your mailbox for the latest assignment message before retrying.",
							},
						);
					}
					const diffSuffix = (result as any).diffStat
						? `\n\nAttestation diffstat:\n${(result as any).diffStat.available ? (result as any).diffStat.stat : `(git diff unavailable: ${(result as any).diffStat.note || "unknown"})`}`
						: "";
					return textResult(
						`Updated node ${params.nodeId} of ${result.task.taskId}: ${result.prevStatus} -> ${result.newStatus}${params.outcome ? ` (outcome=${params.outcome})` : ""}.${result.cancelled ? " Task marked cancelled; all assignments released." : ""}${result.reopened?.length ? ` Reopened rework nodes: ${result.reopened.join(", ")}.` : ""}${params.note ? ` Note: ${params.note}` : ""}${diffSuffix}`,
						{
							taskId: result.task.taskId,
							nodeId: params.nodeId,
							status: result.newStatus,
							outcome: params.outcome,
							taskStatus: result.taskStatus,
							cancelled: result.cancelled,
							by: me,
							autoClosed: result.autoClosed,
							reopened: result.reopened,
							attestation: (result as any).diffStat || null,
						},
					);
				});
			},
		}),
	);
}
