// === swarm/src/reconcile-core.ts ===
// Module boundary: the swarm-level reconcile runner (`reconcile` + `reconcileTasks`).
//   - `reconcileTasks` — sweep task.json files for closure drift + stale/nudge signals
//   - `reconcile`      — orchestrator-facing entry point: claim lock, read state, dispatch
//
// Why co-located: both functions are the only two callers of `evaluateIdleGoalNudgeLocked`
// + `evaluateTaskGraphStallNudgeLocked` + `agentHeartbeatGCLocked` (from nudges/*) and
// `pumpOrchestratorMailbox` (from surface.ts) — they are the pump harness.
//
// Moved verbatim from reconcile.ts (lines 2471-2788) as part of the R24 structure refactor.
// No behavior change.

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Paths, ReconcileAction, SwarmState, TaskState } from "./types.ts";
import { ACK_MISSING_MS, MAX_ATTEMPTS, MAX_CONSECUTIVE_NUDGES_DEFAULT, MAX_REINJECTS, MAX_STATUS_TASKS, REINJECT_AFTER_MS, TASK_NUDGE_MS, TASK_STALE_MS } from "./constants.ts";
import { ensureAgentDefaults, humanAge, now } from "./utils.ts";
import { computeTaskStatus } from "./taskgraph.ts";
import { claimOrchestratorLeader, ensureOrchestrator, heartbeatOrchestratorLeader, requireOrchestratorAuthority } from "./identity.ts";
import { readState, readTaskState, taskPaths, trace, traceTask, withLock, writeState, writeTaskState } from "./state.ts";
import { currentAgentId } from "./session.ts";
import { deliver, deriveLifecycleFromTrigger, findIdempotentMessage, isResponseTrackingActive, readMailbox, upsertMessageRecord } from "./mailbox.ts";
import { formatSwarmMessageContent, isDeliveryFailureRetryable } from "./delivery.ts";
import { isPanePiLike, isTmuxRunning, tmux } from "./tmux.ts";
import { deriveNodeAttention } from "./taskgraph.ts";
import { pumpOrchestratorMailbox } from "./surface.ts";


export async function reconcileTasks(pi: ExtensionAPI, p: Paths, st: SwarmState, options: { dryRun?: boolean; mark?: boolean; nowMs: number }): Promise<ReconcileAction[]> {
	const actions: ReconcileAction[] = [];
	if (!existsSync(p.tasksDir)) return actions;
	let entries: string[] = [];
	try { entries = await readdir(p.tasksDir); } catch { return actions; }
	for (const entry of entries) {
		const taskId = entry;
		const tp = taskPaths(p, taskId);
		if (!existsSync(tp.taskJson)) continue;
		let task: TaskState;
		try { task = await readTaskState(tp.taskJson); } catch { actions.push({ messageId: taskId, action: "task_skip", reason: `unreadable task.json for ${taskId}`, taskId }); continue; }
		let dirty = false;
		const storedClosed = task.status === "done" || task.status === "failed" || task.status === "cancelled";
		const derived = computeTaskStatus(task);
		// Drift detection. `cancelled` is orchestrator-explicit and sticky, so never overwrite it.
		if (!storedClosed && derived !== task.status && task.status !== "cancelled") {
			if (options.mark && !options.dryRun) {
				const prev = task.status;
				task.status = derived;
				task.updatedAt = now();
				dirty = true;
				actions.push({ messageId: taskId, action: "task_status_repaired", reason: `stored ${prev} -> derived ${derived}`, taskId });
				await traceTask(tp, "task.reconcile.repair", { taskId, prev, derived });
			} else {
				actions.push({ messageId: taskId, action: "task_status_drift", reason: `stored ${task.status} but nodes derive ${derived} (pass mark=true to repair)`, taskId });
			}
		}
		// Only non-terminal tasks can have live stale/nudge signals.
		if (storedClosed) continue;
		// Advisory ownership drift (issue 4): active leases with no stamped write scope (legacy tasks
		// predating the ownership policy) are readable and functional, but cannot participate in
		// overlap preflight reliably — report as advisory drift; never fabricate ownership metadata.
		for (const [nodeId, node] of Object.entries(task.nodes)) {
			if (node.status !== "assigned" && node.status !== "in_progress") continue;
			if (!node.activeAttemptId || !Array.isArray(node.attemptHistory)) {
				actions.push({ messageId: `${taskId}/${nodeId}`, action: "task_node_ownership_legacy", reason: `active node ${nodeId} has no attempt ownership metadata (legacy task; first new assignment bootstraps the lease schema)`, taskId, nodeId });
				continue;
			}
			const attempt = node.attemptHistory.find((a: any) => a.attemptId === node.activeAttemptId);
			if (attempt && attempt.status === "active" && !attempt.scope) {
				actions.push({ messageId: `${taskId}/${nodeId}`, action: "task_node_ownership_legacy", reason: `active attempt ${attempt.attemptId} has no stamped write scope (pre-policy lease; scope re-resolves live at preflight)`, taskId, nodeId });
			}
		}
		for (const [nodeId, node] of Object.entries(task.nodes)) {
			if (node.status !== "assigned" && node.status !== "in_progress") continue;
			const staleReasons: string[] = [];
			const nudgeReasons: string[] = [];
			const agent = node.assignee ? st.agents[node.assignee] : undefined;
			if (agent) {
				ensureAgentDefaults(agent);
				if (agent.status === "stopped" || agent.health === "unhealthy") staleReasons.push(`assignee ${agent.id} ${agent.status}/${agent.health}`);
				else if (agent.tmuxTarget && agent.tmuxTarget !== "unknown" && !(await isTmuxRunning(pi, agent.tmuxTarget))) staleReasons.push(`assignee ${agent.id} tmux pane not alive`);
			} else if (node.assignee && node.assignee !== "orchestrator") {
				staleReasons.push(`assignee ${node.assignee} missing from state`);
			}
			if (node.status === "in_progress" && node.lastActivityAt) {
				const age = options.nowMs - new Date(node.lastActivityAt).getTime();
				if (age > TASK_STALE_MS) staleReasons.push(`in_progress ${Math.round(age / 3_600_000)}h without update`);
				else if (age > TASK_NUDGE_MS) nudgeReasons.push(`in_progress ${Math.round(age / 60_000)}min without update`);
			}
			for (const msgId of node.messageIds || []) {
				const rec = st.messages[msgId];
				if (!rec) { staleReasons.push(`references missing message ${msgId}`); continue; }
				if (rec.status === "dead_letter") staleReasons.push(`assignment message ${msgId} dead-lettered`);
				else if (rec.requiresAck && !rec.ackedAt && !st.consumerReceipts?.orchestrator?.entries?.[msgId]) {
					const sinceMs = Math.max(rec.injectedAt ? new Date(rec.injectedAt).getTime() : 0, rec.interceptedAt ? new Date(rec.interceptedAt).getTime() : 0, rec.createdAt ? new Date(rec.createdAt).getTime() : 0);
					if (options.nowMs - sinceMs > ACK_MISSING_MS) nudgeReasons.push(`assignment message ${msgId} ack_missing`);
				}
			}
			if (!staleReasons.length && !nudgeReasons.length) {
				// Attention derivation (issue 5): report-only reminder eligibility. Reconcile NEVER sends;
				// the pointer names the one explicit orchestrator surface that can.
				const att = deriveNodeAttention(st, task, nodeId, options.nowMs);
				if (att.workerReminderEligible) {
					actions.push({ messageId: `${taskId}/${nodeId}`, action: "reminder_eligible", reason: `${att.evidence.join("; ")}; one bounded reminder may be sent via /swarm remind ${taskId} ${nodeId} (orchestrator-only, informational)`, taskId, nodeId });
				}
				continue;
			}
			if (staleReasons.length) {
				if (!options.dryRun && !node.staleAt) { node.staleAt = now(); dirty = true; await traceTask(tp, "task.stale.reconcile", { taskId, nodeId, assignee: node.assignee, reasons: staleReasons }); }
				actions.push({ messageId: `${taskId}/${nodeId}`, action: "task_node_stale", reason: staleReasons.join("; "), taskId, nodeId });
			} else {
				if (!options.dryRun) await traceTask(tp, "task.nudge", { taskId, nodeId, assignee: node.assignee, reasons: nudgeReasons });
				actions.push({ messageId: `${taskId}/${nodeId}`, action: "task_node_nudge", reason: nudgeReasons.join("; "), taskId, nodeId });
			}
		}
		if (!options.dryRun && dirty) await writeTaskState(tp, task);
	}
	return actions;
}

export async function reconcile(pi: ExtensionAPI, cwd: string, p: Paths, options: { agentId?: string; dryRun?: boolean; mark?: boolean }) {
	const result = await withLock(p, async () => {
		const st = await readState(p, cwd);
		if (options.mark) requireOrchestratorAuthority(currentAgentId(), "swarm_reconcile(mark=true)");
		const nowMs = Date.now();
		const actions: Array<{ messageId: string; action: string; reason: string }> = [];
		const targetAgentId = options.agentId ? safeId(options.agentId) : undefined;

		for (const [msgId, rec] of Object.entries(st.messages)) {
			if (rec.status === "dead_letter") continue;
			if (isResponseTrackingActive(rec) && rec.response?.status !== "verified" && rec.response?.status !== "waived") {
				const agent = st.agents[rec.to];
				if (!options.dryRun) {
					rec.response = { ...(rec.response || { status: "missing" as MessageResponseStatus }), status: rec.response?.status === "sent" ? "sent" : "missing", missingAt: rec.response?.missingAt || now(), lastError: `response_missing: awaiting verified result from ${rec.to}` };
					rec.updatedAt = now();
					if (agent && agent.runtimeStatus === "idle") { agent.runtimeStatus = "response_missing"; agent.updatedAt = now(); }
				}
				actions.push({ messageId: msgId, action: "response_missing", reason: `Message requires a verified response from ${rec.to}` });
				continue;
			}
			if (rec.status === "acked") continue;
			if (targetAgentId && rec.to !== targetAgentId) continue;
			if (rec.status !== "queued" && rec.status !== "failed" && rec.status !== "mailbox_delivered" && rec.status !== "injected" && rec.status !== "intercepted") continue;

			const ageMs = nowMs - new Date(rec.createdAt).getTime();
			const expired = rec.ttlMs !== undefined ? ageMs > rec.ttlMs : false;
			const maxAttempts = rec.attempts >= MAX_ATTEMPTS;
			const actionable = Boolean((rec.requiresAck && !rec.ackedAt) || (rec.requiresResponse && rec.response?.status !== "verified" && rec.response?.status !== "waived"));
			const agent = st.agents[rec.to];
			const hasTmuxPane = Boolean(agent?.tmuxTarget) && agent.tmuxTarget !== "unknown";
			const agentRunning = agent?.status === "running" && hasTmuxPane ? await isTmuxRunning(pi, agent.tmuxTarget!) : false;
			const mailboxOnly = Boolean(agent) && !hasTmuxPane;

			// === Issue 25 Phase 2: gate-aware deadline sweep (proposal §C, plan §2.6(a)) ===
			// Under gate=0: SHADOW-ONLY trace — never writes terminalAt (Phase 1 behavior, unchanged).
			// Under gate=1: AUTHORITATIVE — stamps terminalAt/lifecycleStage/terminalReason via the
			// deriveLifecycleFromTrigger pure helper, emits TRACE_LIFECYCLE_DERIVED + the
			// consumer-facing TRACE_MESSAGE_ATTENTION_DERIVED. NEVER increments attempts;
			// NEVER dead-letters (proposal §C binding — the deadline sweep is a scheduler, not an
			// enforcer); NEVER overwrites a pre-existing terminalAt. Runs INSIDE the same withLock
			// the reconcile tick already holds — no nested lock.
			if (!options.dryRun && typeof rec.responseDeadlineMs === "number" && rec.responseDeadlineMs > 0 && ageMs > rec.responseDeadlineMs && !rec.terminalAt) {
				if (PI_SWARM_MINIMAL_PROTOCOL === 1) {
					const d = deriveLifecycleFromTrigger(rec, { kind: "deadline_exceeded", deadlineMs: rec.responseDeadlineMs });
					if (d.kind === "set") {
						rec.terminalAt = d.value;
						rec.terminalReason = d.reason;
						rec.lifecycleStage = d.stage;
						rec.lifecycleSource = d.source;
						rec.updatedAt = now();
						await trace(p, TRACE_LIFECYCLE_DERIVED, {
							messageId: msgId, from: rec.from, to: rec.to,
							field: d.field, source: d.source, stage: d.stage,
							deadlineMs: rec.responseDeadlineMs, ageMs,
							gate: 1, reason: d.reason,
							via: "reconcile.deadline_sweep",
						});
						// Consumer-facing attention category (proposal §K.2): distinct from the
						// per-message lifecycle trace so dashboards can subscribe to a category
						// instead of parsing per-message traces.
						await trace(p, TRACE_MESSAGE_ATTENTION_DERIVED, {
							messageId: msgId, source: "responseDeadlineMs", gate: 1,
							ts: now(), proposal: "§K.2",
						}).catch(() => {});
					}
				} else {
					// Gate=0: shadow trace only (Phase 1 behavior, unchanged).
					await trace(p, TRACE_LIFECYCLE_DERIVED_SHADOW, {
						messageId: msgId,
						from: rec.from,
						to: rec.to,
						field: "terminalAt",
						source: "responseDeadlineMs",
						stage: "terminal",
						deadlineMs: rec.responseDeadlineMs,
						ageMs,
						shadow: true,
						gate: 0,
						reason: "response deadline exceeded; reconciled in shadow-only mode under gate=0",
					});
				}
			}

			if (expired && actionable && !maxAttempts) {
				if (!options.dryRun) await trace(p, "reconcile.ttl.defer_actionable", { id: msgId, to: rec.to, ageMs, ttlMs: rec.ttlMs, requiresAck: rec.requiresAck, requiresResponse: rec.requiresResponse });
				actions.push({ messageId: msgId, action: "ttl_stale", reason: `TTL expired but message is still actionable; awaiting explicit resolve from ${rec.to}` });
				continue;
			}

			if (expired || maxAttempts) {
				if (!options.dryRun) {
					upsertMessageRecord(st, { id: msgId, swarmId: st.swarmId, from: rec.from, to: rec.to, priority: "normal", type: "swarm.message" as const, schemaVersion: 1, createdAt: rec.createdAt, body: "", headers: {}, requiresAck: rec.requiresAck, ttlMs: rec.ttlMs }, "dead_letter", { failedAt: now(), lastError: expired ? "TTL expired" : "Max attempts exceeded" });
					await trace(p, "reconcile.dead_letter", { id: msgId, to: rec.to, reason: expired ? "ttl_expired" : "max_attempts", attempts: rec.attempts, ageMs });
				}
				actions.push({ messageId: msgId, action: "dead_letter", reason: expired ? "TTL expired" : "Max attempts exceeded" });
				continue;
			}

			// Only re-inject genuine delivery failures (recipient never acknowledged). An acked-failed
			// message (status "failed" WITH lastAck) is terminal and must NOT be re-injected, or it loops.
			if (isDeliveryFailureRetryable(rec) && agentRunning) {
				if (!options.dryRun) {
					const msg = await readMailbox(p, rec.to).then((msgs) => msgs.find((m) => m.id === msgId));
					if (msg) {
						const delivery = await deliver(pi, p, st, msg);
						if (delivery?.delivered) {
							st.delivered[rec.to] = Array.from(new Set([...(st.delivered[rec.to] || []), msgId]));
							upsertMessageRecord(st, msg, "injected", { injectedAt: now(), attempts: rec.attempts + 1 });
							await trace(p, "reconcile.retry.ok", { id: msgId, to: rec.to, attempts: rec.attempts + 1 });
							actions.push({ messageId: msgId, action: "retried", reason: "Agent running, injection successful" });
						} else {
							upsertMessageRecord(st, msg, "failed", { failedAt: now(), attempts: rec.attempts + 1, lastError: delivery?.reason || "Injection failed" });
							await trace(p, "reconcile.retry.failed", { id: msgId, to: rec.to, attempts: rec.attempts + 1, error: delivery?.reason });
							actions.push({ messageId: msgId, action: "retry_failed", reason: delivery?.reason || "Injection failed" });
						}
					} else {
						await trace(p, "reconcile.skip", { id: msgId, to: rec.to, reason: "Message not found in mailbox" });
						actions.push({ messageId: msgId, action: "skipped", reason: "Message not found in mailbox" });
					}
				} else {
					actions.push({ messageId: msgId, action: "would_retry", reason: "Agent running (dry run)" });
				}
				continue;
			}

			// Same guard: an already-acknowledged message is not pending delivery, so do not stage it for
			// mailbox/pending re-delivery. See isDeliveryFailureRetryable.
			if (isDeliveryFailureRetryable(rec) && !agentRunning) {
				if (mailboxOnly) {
					if (!options.dryRun) {
						upsertMessageRecord(st, { id: msgId, swarmId: st.swarmId, from: rec.from, to: rec.to, priority: "normal", type: "swarm.message" as const, schemaVersion: 1, createdAt: rec.createdAt, body: "", headers: {}, requiresAck: rec.requiresAck, ttlMs: rec.ttlMs }, "mailbox_delivered", { lastError: undefined });
						await trace(p, "reconcile.mailbox_delivered", { id: msgId, to: rec.to, previousStatus: rec.status });
					}
					actions.push({ messageId: msgId, action: options.dryRun ? "would_mark_mailbox_delivered" : "mailbox_delivered", reason: `Recipient ${rec.to} is mailbox-only (no tmux pane); message awaits swarm_check_mailbox` });
				} else {
					actions.push({ messageId: msgId, action: "pending", reason: "Recipient agent not running" });
				}
				continue;
			}

			if ((rec.status === "mailbox_delivered" || rec.status === "injected" || rec.status === "intercepted") && !rec.ackedAt) {
				if (!rec.requiresAck) continue;
				// Consider the most recent delivery timestamp. Previously this only checked injectedAt, so
				// `intercepted` messages (which set interceptedAt, not injectedAt) were never detected as stale.
				const sinceMs = Math.max(
					rec.injectedAt ? new Date(rec.injectedAt).getTime() : 0,
					rec.interceptedAt ? new Date(rec.interceptedAt).getTime() : 0,
					rec.lastAck?.at ? new Date(rec.lastAck.at).getTime() : 0,
					rec.createdAt ? new Date(rec.createdAt).getTime() : 0,
				);
				const deliveredAge = nowMs - sinceMs;
				const staleThreshold = 300_000; // 5 minutes
				if (deliveredAge > staleThreshold) {
					// Issue A: an injected-but-unacked message was previously only marked ack_missing and NEVER
					// re-delivered — a message injected into a pane that pi never processed (crash, missed turn,
					// pane-alive-but-shell per issue D) was silently lost. Now: bounded re-injection (MAX_REINJECTS)
					// when the recipient's pane is alive AND pi-like, with a cooldown (REINJECT_AFTER_MS) since the
					// last delivery so an agent actively working isn't spammed. Delivery staleness keeps being
					// surfaced as ack_missing either way; attempts are NOT bumped (dead-lettering stays TTL-driven).
					const reinjects = rec.reinjects || 0;
					const sinceLast = Math.max(
						rec.lastReinjectAt ? new Date(rec.lastReinjectAt).getTime() : 0,
						sinceMs,
					);
					const cooldownOk = nowMs - sinceLast > REINJECT_AFTER_MS;
					let reinjected = false;
					if (!options.dryRun && cooldownOk && reinjects < MAX_REINJECTS && !rec.superseded) {
						const reinjectAgent = st.agents[rec.to];
						const hasPane = Boolean(reinjectAgent?.tmuxTarget) && reinjectAgent!.tmuxTarget !== "unknown";
						const alive = hasPane && reinjectAgent?.status === "running" ? await isTmuxRunning(pi, reinjectAgent!.tmuxTarget!) : false;
						const piLike = alive ? await isPanePiLike(pi, reinjectAgent!.tmuxTarget!) : { piLike: false, command: "" };
						if (alive && piLike.piLike) {
							const msg = await readMailbox(p, rec.to).then((msgs) => msgs.find((m) => m.id === msgId));
							if (msg) {
								const delivery = await deliver(pi, p, st, msg);
								if (delivery?.delivered && !delivery.mailboxOnly) {
									reinjected = true;
									st.delivered[rec.to] = Array.from(new Set([...(st.delivered[rec.to] || []), msgId]));
									upsertMessageRecord(st, msg, "injected", { injectedAt: now(), reinjects: reinjects + 1, lastReinjectAt: now() });
									await trace(p, "reconcile.reinject.ok", { id: msgId, to: rec.to, reinjects: reinjects + 1, deliveredAge });
								} else {
									await trace(p, "reconcile.reinject.skip", { id: msgId, to: rec.to, reason: delivery?.reason || "no message" });
								}
							} else {
								await trace(p, "reconcile.reinject.skip", { id: msgId, to: rec.to, reason: "Message not found in mailbox" });
							}
						} else if (alive && !piLike.piLike) {
							await trace(p, "reconcile.reinject.skip", { id: msgId, to: rec.to, reason: `pane alive but not pi (pane_current_command=${piLike.command || "?"})` });
						}
					}
					if (!options.dryRun) {
						// Surface as ack_missing: keep the injected/intercepted status intact so this is NOT
						// confused with a delivery failure (failed messages get re-injected by the retry branch
						// above). Record a clear marker + trace so it shows up in swarm_agent_status /
						// swarm_message_status instead of silently lingering. Do not bump attempts here, so an
						// unacked-but-delivered message is not accidentally escalated to dead_letter by the
						// maxAttempts check; TTL still applies for eventual cleanup.
						upsertMessageRecord(
							st,
							{ id: msgId, swarmId: st.swarmId, from: rec.from, to: rec.to, priority: "normal", type: "swarm.message" as const, schemaVersion: 1, createdAt: rec.createdAt, body: "", headers: {}, requiresAck: rec.requiresAck, ttlMs: rec.ttlMs },
							rec.status,
							{ ackMissingAt: rec.ackMissingAt || now(), lastError: `ack_missing: delivered ${Math.round(deliveredAge / 1000)}s ago, no ack from ${rec.to}` },
						);
						await trace(p, "reconcile.ack_missing", { id: msgId, to: rec.to, deliveredAge, status: rec.status, requiresAck: rec.requiresAck });
					}
					actions.push({ messageId: msgId, action: reinjected ? "reinjected" : "ack_missing", reason: `Delivered ${Math.round(deliveredAge / 1000)}s ago, no ack from ${rec.to}${reinjected ? ` (re-injected, ${reinjects + 1}/${MAX_REINJECTS})` : reinjects >= MAX_REINJECTS ? " (re-inject budget exhausted)" : ""}` });
				} else {
					actions.push({ messageId: msgId, action: "awaiting_ack", reason: "Recently delivered, awaiting ack" });
				}
				continue;
			}
		}

		// Task sweep (WS-B.3/4): closure drift + stale/nudge signals, mark-only. Shares the lock so
		// task.json writes are consistent with swarm state. Ignored when scoped to a single agent's mail.
		const taskActions = options.agentId ? [] : await reconcileTasks(pi, p, st, { dryRun: options.dryRun, mark: options.mark, nowMs });
		const allActions = [...actions, ...taskActions];

		if (!options.dryRun) {
			await writeState(p, st);
		}
		return { actions: allActions, count: allActions.length, messageCount: actions.length, taskCount: taskActions.length, dryRun: Boolean(options.dryRun) };
	});
	await trace(p, "reconcile.complete", { agentId: options.agentId, dryRun: options.dryRun, mark: options.mark, result });
	return result;
}

