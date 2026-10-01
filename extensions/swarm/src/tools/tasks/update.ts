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
import { ensureAgentDefaults, isSafeRelativePath, now, safeId, textResult } from "../../utils.ts";
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
import { updateTaskCore } from "../../primitives/task-core.ts";

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
						// swarm-issues b1 (2026-10-01, incident run-mup15r16-epimos): root cancelled the
						// ACTIVE linked task of a running issue run (work already delivered via commit);
						// the run silently froze and the terminal notice recommended a command that was
						// refused from that state. Refuse linkage-scoped (non-linked tasks unchanged;
						// force:true still proceeds — downstream freeze semantics byte-identical).
						const preLink = await readState(p, ctx.cwd);
						const preRun = preLink.issueRun;
						const linkedEntry =
							preRun?.activeIssueId && preRun.status === "running"
								? (preRun.queue ?? []).find(
									(q) => q.issueId === preRun.activeIssueId && q.status === "active" && q.taskId === safeId(String(params.taskId)),
								  )
								: undefined;
						if (linkedEntry) {
							await trace(p, "task.cancel.linked_guard_refused", { taskId: params.taskId, runId: preRun.runId, issueId: linkedEntry.issueId, by: me });
							throw new Error(
								`LINKED_TASK_CANCEL_REFUSED: task ${params.taskId} is the ACTIVE linked task of running issue run ${preRun.runId} (issue "${linkedEntry.issueId}"). Cancelling instead of completing silently freezes the run. Complete the work: mark the terminal node done via swarm_update_task (status=done). If the run must end now, use /swarm issues stop (run-level stop; the child task is never cancelled). Note: this refusal also holds with force:true — a linked task of a running run is never cancellable; complete it or stop the run.`,
							);
						}
					}
					if (params.force === true && !isRootAuthority(me)) {
						await trace(p, "task.rbac.force_forbidden", { taskId: params.taskId, nodeId: params.nodeId, caller: me, by: me });
						throw new Error(
							`FORCE_FORBIDDEN: swarm_update_task(force=true) requires root authority (caller=${me}). Only the root may bypass ownership/transition checks.`,
						);
					}
					const result = await withLock(p, async () => {
						return updateTaskCore(p, {
							readState,
							writeState,
							trace,
							deliverMessageLocked,
							pi,
							cwd: ctx.cwd,
						}, params, me, isOrch);
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
					// tool-output-slim §6: the model-visible text carries only a one-line summary
					// (files: N (+X −Y)); the full diffstat table stays in details.attestation.stat
					// and the task trace. Status line + RESPONSE_REQUIRED/supersession texts untouched.
					const diffSuffix = (result as any).diffStat
						? (() => {
								const d = (result as any).diffStat;
								if (!d.available) return `\n\nAttestation diffstat: (unavailable: ${d.note || "unknown"})`;
								const lines = String(d.stat || "")
									.split("\n")
									.filter(Boolean);
								const totalLine = lines.find((l: string) => /changed|insertion|deletion/i.test(l)) || "";
								const filesChanged = Number((totalLine.match(/^(\d+) files? changed/i) || [])[1] || 0) || lines.length;
								const ins = (totalLine.match(/(\d+) insertion/i) || [])[1] || "?";
								const del = (totalLine.match(/(\d+) deletion/i) || [])[1] || "?";
								return `\n\nAttestation diffstat: files: ${filesChanged} (+${ins} \u2212${del}) (full diffstat in details)`;
							})()
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
