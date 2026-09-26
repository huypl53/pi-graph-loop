// === swarm/hooks/shutdown-input.ts — session_shutdown + input hooks (Phase 7) ===
// Extracted verbatim from ../hooks.ts (Phase 7 modular split; canonical logic unchanged).
//
// session_shutdown: root branch stops the pump + clears streak/incidents; worker branch pid-guarded
// stop stamp + Issue 9 site 3 lifecycle-fenced stale stamps + assigner/root nudges.
// input: steering-intercept — parseSystemDelivery, gate=1 seenAt derivation, Issue 86
// priority-high interrupt-on-delivery (ctx.abort, rate-limited), triggerTurn delivery.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_SWARM_MINIMAL_PROTOCOL, SWARM_GUEST_ID, TRACE_LIFECYCLE_DERIVED } from "../constants.ts";
import { currentAgentId } from "../session.ts";
import { deliverMessageLocked, upsertMessageRecord } from "../mailbox.ts";
import { formatSwarmMessageContent, parseSystemDelivery } from "../delivery.ts";
import { ensureAgentDefaults, now } from "../utils.ts";
import { ensureDirs, paths, readState, trace, withLock, writeState, writeTaskState } from "../state.ts";
import { scanAgentOpenAssignments, checkStallNotificationStale } from "../taskgraph.ts";
import { engineRetryIncidentsMap, setRootEditStreak } from "./streaks.ts";
import { stopRootPump } from "./pump-manager.ts";

export function registerShutdownInputHooks(pi: ExtensionAPI) {
	pi.on("session_shutdown", async (_event, ctx) => {
		const agentId = currentAgentId();
		if (agentId === "root") {
			stopRootPump();
			setRootEditStreak(0);
			// Issue 17 (binding C1 — symmetry with session_start): clear any open incident for the
			// root on shutdown. Defense-in-depth — the process is going away anyway, but
			// explicit symmetry keeps the invariant visible to readers.
			engineRetryIncidentsMap().delete(agentId);
			return;
		}
		// Issue 17 (binding C1 — symmetry with session_start): clear any open incident for this agent
		// on shutdown so the next session_start (in this or another process) starts with an empty map.
		engineRetryIncidentsMap().delete(agentId);
		const p = paths(ctx.cwd);
		await ensureDirs(p);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[agentId];
			if (!agent) return;
			// pid-guard: only the owning process may mark this agent stopped. A transient process sharing
			// the agentId (e.g. `pi --mode print`) must not poison a live agent's record.
			if (agent.pid && agent.pid !== process.pid) {
				await trace(p, "agent.shutdown.skip_pid_guard", { agentId, ownerPid: agent.pid, callerPid: process.pid });
				return;
			}
			const ts = now();
			agent.lastShutdownAt = ts;
			agent.runtimeStatus = "stopped";
			agent.health = "unhealthy";
			agent.status = "stopped";
			agent.updatedAt = ts;
			// Engine-enforced closure: if this agent is dying while it still owns open assigned/in_progress
			// nodes, mark them stale and nudge the root (mailbox-only) instead of orphaning them.
			ensureAgentDefaults(agent);
			if (agent.activeTaskIds.length) {
				const open = await scanAgentOpenAssignments(p, st, agentId, agent.activeTaskIds);
				// Lifecycle-fencing (issue 9, site 3): per-node staleness check before stamping staleAt and
				// emitting the shutdown-with-open notify. A node that has since become terminal / reassigned
				// / closed must NOT receive a stale stamp nor a shutdown notify.
				const liveOpen: typeof open = [];
				const nowMs = Date.now();
				for (const entry of open) {
					const staleCheck = checkStallNotificationStale(st, entry.task, entry.nodeId, agentId, nowMs);
					if (staleCheck.stale) {
						await trace(p, "notification.stale.suppressed", {
							site: "session_shutdown.open_node",
							agentId,
							taskId: entry.task.taskId,
							nodeId: entry.nodeId,
							reason: staleCheck.reason,
							evidence: staleCheck.evidence,
						});
						continue;
					}
					liveOpen.push(entry);
				}
				for (const { task, tp, nodeId } of liveOpen) {
					task.nodes[nodeId].staleAt = ts;
					task.nodes[nodeId].lastActivityAt = ts;
					await writeTaskState(tp, task);
				}
				if (liveOpen.length) {
					await trace(p, "task.stale.shutdown", {
						agentId,
						open: liveOpen.map((o) => ({ taskId: o.task.taskId, nodeId: o.nodeId })),
					});
					const list = liveOpen.map((o) => `${o.task.taskId}/${o.nodeId}`).join(", ");
					// Nudge the reassignment authority: prefer each open node's assigner (replyTarget, from its
					// latest `assign` handoff `by`) when registered and not this dying agent; else root
					// (mailbox-only). Stamps node.lastActivityAt so the shutdown itself is recorded as activity.
					const nudgeTargets = new Set<string>();
					for (const { task, nodeId } of liveOpen) {
						const assigner = [...task.handoffs].reverse().find((h: any) => h?.toNode === nodeId && h?.kind === "assign")?.by as
							string | undefined;
						if (assigner && assigner !== agentId && st.agents[assigner]) nudgeTargets.add(assigner);
						else nudgeTargets.add("root");
					}
					for (const target of nudgeTargets) {
						try {
							await deliverMessageLocked(pi, ctx.cwd, p, st, {
								to: target,
								subject: `agent ${agentId} shut down with open task node(s)`,
								body: `Agent ${agentId} shut down (session_shutdown) while still assigned ${liveOpen.length} non-terminal node(s): ${list}. Those nodes were marked stale (staleAt) and lastActivityAt stamped. Reassign via swarm_assign_task or reconcile as needed.`,
								requiresAck: false,
							});
						} catch (err: any) {
							await trace(p, "task.stale.shutdown.nudge_failed", { agentId, target, error: String(err?.message || err) });
						}
					}
				}
			}
			await writeState(p, st);
			await trace(p, "agent.status", { agentId, runtimeStatus: agent.runtimeStatus, health: agent.health });
		});
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const msg = parseSystemDelivery(event.text);
		if (!msg) return { action: "continue" };
		const p = paths(ctx.cwd);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			upsertMessageRecord(st, msg, "intercepted", { interceptedAt: now() });
			if (PI_SWARM_MINIMAL_PROTOCOL === 1) {
				const rec = st.messages[msg.id];
				if (rec && !rec.seenAt) {
					const ts = now();
					rec.seenAt = ts;
					rec.lifecycleStage = "seen";
					rec.lifecycleSource = "steering_intercept";
					rec.updatedAt = ts;
					await trace(p, TRACE_LIFECYCLE_DERIVED, {
						messageId: msg.id,
						from: rec.from,
						to: rec.to,
						field: "seenAt",
						source: "steering_intercept",
						stage: "seen",
						gate: 1,
						reason: "message intercepted and steered into agent session",
						via: "input_intercept",
					}).catch(() => {});
				}
			}
			await writeState(p, st);
		});
		await trace(p, "message.input_intercept", {
			id: msg.id,
			from: msg.from,
			to: msg.to,
			agentId: currentAgentId(),
			status: "intercepted",
		});

		const isHigh = msg.priority === "high";
		const midTurn = !ctx.isIdle();

		// === Issue 86: priority-high interrupt-on-delivery ===
		// When a high-priority swarm message is intercepted mid-turn, call ctx.abort() (TUI-level
		// interrupt, same channel as manual Escape) so urgent directives are consumed at the next-turn
		// boundary instead of sitting intercepted for 20+ minutes (live incident 2026-08-31: STOP sat
		// 23 min). Rate-limited per agent (~1/30s default) so a chatty root cannot livelock
		// a worker. Graceful degrade on ctx.abort() failure: still queue the message as followUp so it
		// lands at the next-turn boundary regardless.
		if (isHigh && midTurn) {
			const WINDOW_MS = Number(process.env.PI_SWARM_HIGH_INTERRUPT_WINDOW_MS ?? 30_000);
			const me = currentAgentId();
			let allowed = true;
			let lastInterruptAt: string | undefined;
			await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				// Root pseudo-agent is exempt from the ledger; the root has no in-flight
				// turn in the TUI sense, and rate-limiting would block legitimate nudges.
				const self = me === "root" ? undefined : st.agents[me];
				lastInterruptAt = self?.lastHighInterruptAt;
				if (lastInterruptAt && Date.now() - new Date(lastInterruptAt).getTime() < WINDOW_MS) {
					allowed = false;
				} else if (self) {
					self.lastHighInterruptAt = new Date().toISOString();
					self.updatedAt = new Date().toISOString();
					await writeState(p, st);
				}
			});

			if (!allowed) {
				await trace(p, "message.interrupt_suppressed", {
					id: msg.id,
					from: msg.from,
					to: msg.to,
					agentId: me,
					reason: "rate_limited",
					windowMs: WINDOW_MS,
					lastInterruptAt,
				}).catch(() => {});
				// Still queue as followUp so the message is consumed at the next-turn boundary — just
				// don't burn an extra interrupt budget on the second directive.
				pi.sendMessage(
					{
						customType: "swarm-message",
						content: formatSwarmMessageContent(msg),
						display: true,
						details: msg,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				return { action: "handled" };
			}

			await trace(p, "message.interrupt_requested", { id: msg.id, from: msg.from, to: msg.to, agentId: me }).catch(() => {});
			let interruptEffective = false;
			try {
				await ctx.abort();
				interruptEffective = true;
			} catch (err) {
				await trace(p, "message.interrupt_failed", {
					id: msg.id,
					from: msg.from,
					to: msg.to,
					agentId: me,
					error: String((err as Error)?.message || err),
				}).catch(() => {});
				// Graceful degrade: still queue the message as followUp so it lands at the next-turn
				// boundary even if the abort itself failed (matches the manual-Escape fallback pattern).
			}
			if (interruptEffective) {
				await trace(p, "message.interrupt_effective", { id: msg.id, from: msg.from, to: msg.to, agentId: me }).catch(() => {});
			}
			pi.sendMessage(
				{
					customType: "swarm-message",
					content: formatSwarmMessageContent(msg),
					display: true,
					details: msg,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			return { action: "handled" };
		}

		// === Existing behavior (preserved verbatim) ===
		pi.sendMessage(
			{
				customType: "swarm-message",
				content: formatSwarmMessageContent(msg),
				display: true,
				details: msg,
			},
			{ triggerTurn: true, deliverAs: ctx.isIdle() ? "steer" : "followUp" },
		);
		return { action: "handled" };
	});
}
