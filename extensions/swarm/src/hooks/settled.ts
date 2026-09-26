// === swarm/hooks/settled.ts — agent_settled hook (Phase 7) ===
// Extracted verbatim from ../hooks.ts (Phase 7 modular split; canonical logic unchanged).
//
// Root branch: pump + watchdog self-heal. Worker branch: catch-up surface, transient-settle
// suppression (engine-retry / swap-handoff), 2-Tier response-missing handling, R25 ack-debt
// notify (gate=0 only), settle-with-open-assignment notify with lifecycle fencing (issue 9 site 2).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import type { MessageResponseStatus } from "../types.ts";
import {
	ENGINE_RETRY_WINDOW_MS,
	NOTIFY_KEY_SETTLE_STALE,
	PI_SWARM_MINIMAL_PROTOCOL,
	SETTLE_NOTIFY_COOLDOWN_MS,
	formatNotifyKey,
} from "../constants.ts";
import { currentAgentId } from "../session.ts";
import { deliverMessageLocked, findIdempotentMessage, responseMissingRecords, unackedRequiresAckRecords } from "../mailbox.ts";
import { ensureAgentDefaults, now } from "../utils.ts";
import { paths, readState, trace, withLock, writeState } from "../state.ts";
import { logSwarmError } from "../errorlog.ts";
import { pumpRootMailbox } from "../surface.ts";
import { scanAgentOpenAssignments, checkStallNotificationStale } from "../taskgraph.ts";
import { maybeAutoFocusBusyAgent } from "../focus.ts";
import { engineRetryIncidentsMap, isAgentInPoolSwapHandoff } from "./streaks.ts";
import { armRootPumpWatchdog, getRootMailboxTimer, isRootPumpCtxFresh, surfaceAgentPending } from "./pump-manager.ts";

export function registerSettledHook(pi: ExtensionAPI) {
	pi.on("agent_settled", async (_event, ctx) => {
		const agentId = currentAgentId();
		if (agentId === "root") {
			const p = paths(ctx.cwd);
			await pumpRootMailbox(pi, ctx, p, "agent_settled");
			// === Issue 11 (rework) watchdog self-heal ===
			// If the watchdog tick has been lost (timer GC'd, single-tick throw that called stop, etc.),
			// re-install it from this hook so the chain stays alive without requiring session_start.
			// Guard: only re-arm when ctx.mode is TUI (print/rpc/json sessions don't need the watchdog).
			if (ctx.mode === "tui" && !getRootMailboxTimer() && isRootPumpCtxFresh()) {
				armRootPumpWatchdog(ctx);
			}
			return;
		}
		// Catch-up surface for workers: anything unacked that arrived (or failed injection) while busy.
		try {
			await surfaceAgentPending(pi, ctx, paths(ctx.cwd), agentId, "agent_settled");
		} catch (err) {
			// A failed catch-up surface would silently strand unacked work until the next settle — make
			// it visible in the durable error log without breaking the settle flow.
			await logSwarmError(ctx?.cwd, "hooks", "settle.surface_pending_failed", err, { agentId });
		}
		const p = paths(ctx.cwd);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[agentId];
			if (!agent) return;
			if (agent.pid && agent.pid !== process.pid) return; // pid-guard
			const ts = now();
			const nowMs = Date.now();
			agent.lastAgentSettledAt = ts;
			agent.health = "healthy";
			agent.lastHeartbeatAt = ts;
			agent.updatedAt = ts;
			ensureAgentDefaults(agent);

			// Check if this settle is a transient handoff during engine-retry or model pool rotation:
			const activeIncident = engineRetryIncidentsMap().get(agentId);
			const inEngineRetry = Boolean(activeIncident && nowMs - activeIncident.lastSeenAt <= ENGINE_RETRY_WINDOW_MS);
			const inSwapHandoff = isAgentInPoolSwapHandoff(agentId, nowMs);
			const isTransientSettle = inEngineRetry || inSwapHandoff;

			if (!inEngineRetry) {
				engineRetryIncidentsMap().delete(agentId);
			}

			if (isTransientSettle) {
				await trace(p, "agent_settled.transient_suppressed", {
					agentId,
					inEngineRetry,
					inSwapHandoff,
					activeTaskIds: agent.activeTaskIds,
				}).catch(() => {});
				await writeState(p, st);
				return;
			}

			const missingResponses = responseMissingRecords(st, agentId);
			if (missingResponses.length) {
				// Lifecycle-fencing (issue 9, site 1): skip the settle-with-missing-response notify if every
				// outstanding rec is stale (superseded by a later assignment, or no longer addressed to this
				// settling agent). Fence at emit time using durable message state — no pane liveness inference.
				const liveMissing = missingResponses.filter((rec) => !rec.superseded && rec.to === agentId);
				if (liveMissing.length === 0) {
					agent.runtimeStatus = "idle";
					await trace(p, "notification.stale.suppressed", {
						site: "agent_settled.response_missing",
						agentId,
						reason: "all_recs_superseded_or_drifted",
						dropped: missingResponses.map((m) => m.id),
					});
				} else {
					// 2-Tier Response Missing Handling:
					// Tier 1: If worker is running, first nudge the WORKER directly in its own pane so it can self-repair without bothering root.
					// Tier 2: If worker was already nudged or is stopped/dead, mark response_missing and escalate to root.
					const needsWorkerNudge = liveMissing.filter((rec) => {
						const nudgeCount = (rec.response as any)?.workerNudgeCount || 0;
						return nudgeCount < 1;
					});
					const isWorkerAlive = agent.status === "running" && agent.tmuxTarget && agent.tmuxTarget !== "unknown";

					if (needsWorkerNudge.length > 0 && isWorkerAlive) {
						for (const rec of needsWorkerNudge) {
							rec.response = {
								...(rec.response || { status: "missing" as MessageResponseStatus }),
								status: "missing",
								missingAt: rec.response?.missingAt || ts,
								lastError: `response_missing: worker settled before sending verified result (self-nudge sent)`,
								workerNudgeCount: ((rec.response as any)?.workerNudgeCount || 0) + 1,
								lastWorkerNudgeAt: ts,
							} as any;
							rec.updatedAt = ts;

							try {
								await deliverMessageLocked(pi, ctx.cwd, p, st, {
									to: agentId,
									subject: `[Swarm Reminder] Missing verified response for ${rec.id}`,
									body: `You settled without providing a verified response for assignment ${rec.id} (${rec.subject || "Task assignment"}).\n\nPlease complete your node or report your status/blocker to root (via swarm_send_message with replyTo="${rec.id}") so this task can advance.`,
									replyTo: rec.id,
									conversationId: rec.conversationId,
									requiresAck: false,
									requiresResponse: false,
									priority: "high",
								});
								await trace(p, "message.response_missing.worker_nudged", {
									agentId,
									messageId: rec.id,
									workerNudgeCount: (rec.response as any).workerNudgeCount,
								});
							} catch (err: any) {
								await trace(p, "message.response_missing.worker_nudge_failed", {
									agentId,
									messageId: rec.id,
									error: String(err?.message || err),
								});
							}
						}
						// Keep worker idle so it can act on the nudge
						agent.runtimeStatus = "idle";
					} else {
						agent.runtimeStatus = "response_missing";
						for (const rec of liveMissing) {
							rec.response = {
								...(rec.response || { status: "missing" as MessageResponseStatus }),
								status: "missing",
								missingAt: rec.response?.missingAt || ts,
								lastError: `response_missing: ${agentId} settled before sending a verified result`,
							};
							rec.updatedAt = ts;
						}
						try {
							await deliverMessageLocked(pi, ctx.cwd, p, st, {
								to: "root",
								subject: `agent ${agentId} settled with missing response(s)`,
								body: `Agent ${agentId} settled while ${liveMissing.length} requiresResponse message(s) are still missing verified result messages: ${liveMissing.map((m) => m.id).join(", ")}. The agent is marked response_missing and is blocked from reuse until it sends replies and ack done with resultMessageId.`,
								requiresAck: false,
							});
							await trace(p, "message.response_missing.settled.notify", {
								agentId,
								messageIds: liveMissing.map((m) => m.id),
							});
						} catch (err: any) {
							await trace(p, "message.response_missing.notify_failed", { agentId, error: String(err?.message || err) });
						}
					}
				}
			} else {
				agent.runtimeStatus = "idle";
			}
			// R25 — PM auto-notify for ack-debt. Under PI_SWARM_MINIMAL_PROTOCOL=1 manual acks are retired
			// (swarm_ack_message is hidden and message lifecycle is inferred from actions), so this notify is
			// active only under legacy gate=0.
			if (PI_SWARM_MINIMAL_PROTOCOL === 0) {
				const ackDebt = unackedRequiresAckRecords(st, agentId);
				if (ackDebt.length) {
					const sinceAckDebt = agent.lastAckDebtNotifyAt
						? Date.now() - new Date(agent.lastAckDebtNotifyAt).getTime()
						: Number.POSITIVE_INFINITY;
					if (sinceAckDebt > SETTLE_NOTIFY_COOLDOWN_MS) {
						const sortedIds = [...ackDebt.map((r) => r.id)].sort();
						const hash = createHash("sha1").update(sortedIds.join("|")).digest("hex").slice(0, 8);
						const idempotencyKey = `r25:ackdebt:${agentId}:${hash}`;
						agent.lastAckDebtNotifyAt = ts;
						const subjectList = ackDebt.map((r) => r.subject || "(no subject)").join("; ");
						const idList = sortedIds.join(", ");
						try {
							await deliverMessageLocked(pi, ctx.cwd, p, st, {
								to: "root",
								subject: `agent ${agentId} settled owing ${ackDebt.length} unacked ack(s)`,
								body: `Agent ${agentId} settled (agent_settled) while still holding ${ackDebt.length} unacked requiresAck message(s): ${idList}. Subjects: ${subjectList}. Ack via swarm_ack_message.`,
								requiresAck: false,
								idempotencyKey,
							});
							await trace(p, "message.ack_debt.settled.notify", { agentId, messageIds: sortedIds });
						} catch (err: any) {
							await trace(p, "message.ack_debt.notify_failed", { agentId, error: String(err?.message || err) });
						}
					} else {
						await trace(p, "message.ack_debt.settled.notify_cooldown", { agentId, cooldownMs: SETTLE_NOTIFY_COOLDOWN_MS });
					}
				}
			}
			// PM auto-notify (engine behavior): a settle while still holding open assignments is a
			// stall/idle signal the root should not have to poll for. Enqueue a mailbox notify to
			// the mailbox-only root. Loop-safe: (a) it targets the root, never the worker
			// (no self-re-trigger); (b) cooldown-guarded per agent via persisted lastSettleNotifyAt so
			// repeated settles in a window don't storm; (c) mailbox-only (no tmux inject); (d) no node
			// mutation. requiresAck=false (informational; root pump surfaces it). Done before
			// writeState so the notify record persists atomically with the settle metadata.
			if (agent.activeTaskIds.length) {
				const sinceNotify = agent.lastSettleNotifyAt
					? Date.now() - new Date(agent.lastSettleNotifyAt).getTime()
					: Number.POSITIVE_INFINITY;
				if (sinceNotify > SETTLE_NOTIFY_COOLDOWN_MS) {
					let list = agent.activeTaskIds.join(", ");
					let openCount = agent.activeTaskIds.length;
					let open: Awaited<ReturnType<typeof scanAgentOpenAssignments>> = [];
					try {
						open = await scanAgentOpenAssignments(p, st, agentId, agent.activeTaskIds);
						if (open.length) {
							list = open.map((o) => `${o.task.taskId}/${o.nodeId}`).join(", ");
							openCount = open.length;
						}
					} catch (err) {
						// Keep the activeTaskIds fallback list, but the scan failure itself is diagnosable
						// signal (why could open assignments not be enumerated?) — log it durably.
						await logSwarmError(p, "hooks", "settle.scan_open_assignments_failed", err, { agentId });
					}
					// Lifecycle-fencing (issue 9, site 2): per-node staleness check on every entry from
					// scanAgentOpenAssignments. A node that has since become terminal / reassigned / closed
					// must not produce a settle-stale notify. Per-(task,agent) dedupe key prevents repeated
					// storming across settles. Notify is suppressed iff EVERY (task,node) entry is stale.
					const liveOpen: typeof open = [];
					for (const entry of open) {
						const staleCheck = checkStallNotificationStale(st, entry.task, entry.nodeId, agentId, Date.now());
						if (staleCheck.stale) {
							await trace(p, "notification.stale.suppressed", {
								site: "agent_settled.open_assignment",
								agentId,
								taskId: entry.task.taskId,
								nodeId: entry.nodeId,
								reason: staleCheck.reason,
								evidence: staleCheck.evidence,
							});
							continue;
						}
						const key = formatNotifyKey(NOTIFY_KEY_SETTLE_STALE, { taskId: entry.task.taskId, agentId });
						if (findIdempotentMessage(st, "root", "root", key)) {
							await trace(p, "task.stale.settled.notify_cooldown", {
								agentId,
								taskId: entry.task.taskId,
								cooldownMs: SETTLE_NOTIFY_COOLDOWN_MS,
								key,
							});
							continue;
						}
						liveOpen.push(entry);
					}
					if (liveOpen.length === 0) {
						// Every open entry is stale or deduped — do NOT send a settle-stale notify at all.
						// No lastSettleNotifyAt stamp (so a real fresh open next settle is still allowed).
						await trace(p, "notification.stale.suppressed", {
							site: "agent_settled.open_assignment",
							agentId,
							reason: "all_open_stale_or_deduped",
							scanned: open.length,
						});
					} else {
						agent.lastSettleNotifyAt = ts;
						const list2 = liveOpen.map((o) => `${o.task.taskId}/${o.nodeId}`).join(", ");
						const openCount2 = liveOpen.length;
						try {
							await deliverMessageLocked(pi, ctx.cwd, p, st, {
								to: "root",
								subject: `agent ${agentId} settled idle with open assignment(s)`,
								body: `Agent ${agentId} settled (agent_settled) while still holding ${openCount2} open assignment(s): ${list2}. It may be idle or stalled; advance via swarm_next_nodes/swarm_update_task, reassign, or reconcile as needed.`,
								requiresAck: false,
							});
							await trace(p, "task.stale.settled.notify", { agentId, open: openCount2 });
						} catch (err: any) {
							await trace(p, "task.stale.settled.notify_failed", { agentId, error: String(err?.message || err) });
						}
					}
				} else {
					await trace(p, "task.stale.settled.notify_cooldown", { agentId, cooldownMs: SETTLE_NOTIFY_COOLDOWN_MS });
				}
			}
			await writeState(p, st);
			await trace(p, "agent.status", { agentId, runtimeStatus: agent.runtimeStatus, health: agent.health });
			// Loop-safe observability: a settle while still holding open assignments is a stale signal
			// (no forced inject; runtimeTaskWarnings does the active flagging).
			if (agent.activeTaskIds.length) await trace(p, "task.stale.settled", { agentId, openTaskCount: agent.activeTaskIds.length });
		});

		try {
			await maybeAutoFocusBusyAgent(pi, ctx, agentId);
		} catch (err: any) {
			await logSwarmError(ctx?.cwd, "hooks", "settle.auto_focus_failed", err, { agentId });
		}
	});
}
