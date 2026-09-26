// === swarm/surface/pump.ts — the per-tick root mailbox surface pump (Phase 7) ===
// Extracted verbatim from ../surface.ts (Phase 7 modular split; canonical logic unchanged).
//
// Module boundary: pumpRootMailbox — the R10-1 boundary. The ONLY pi.sendMessage call sites
// for root surfacing live here: batched delivery via formatSwarmBatchMessageContent (R30,
// single L2 sendMessage per tick when N>1) or per-message triggerTurn delivery. Pi Runtime
// Contract layers crossed: L2 (Pi queue acceptance via pi.sendMessage — fire-and-forget,
// triggerTurn only when idle/escalating), L3/L4 ride on Pi. The leader lease + stale-lease
// self-heal + surfacing decision block are durable L1 file IO under withLock and run in ALL
// session modes; ctx-bound delivery is TUI-only (print/rpc/json sessions never touch ctx).
//
// Depends on: identity (leader lease), mailbox (mailbox reads + consumer receipts),
// delivery (message/batch formatting), surface/actionable + surface/staleness +
// surface/session + surface/ranking (predicates and helpers), nudges/* (in-lock pump phases),
// state (withLock/readState/writeState/trace/readTaskState/taskPaths), errorlog (logSwarmError).
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MessageRecord, Paths, SwarmMessage, TaskState } from "../types.ts";
import {
	PUMP_RETRIGGER_DELAY_MS,
	PUMP_RETRIGGER_MAX,
	PUMP_SCAN_WINDOW,
	PUMP_SESSION_ID_CAP,
	PUMP_SESSION_TTL_MS,
	PUMP_STUCK_DEFER_ESCALATE_MS,
	ROOT_BUSY_ACTIVE_EXECUTION_MS,
	TERMINAL_NODE_STATUSES,
} from "../constants.ts";
import { capMap, now } from "../utils.ts";
import { readMailboxCached } from "../mailbox.ts";
import { claimRootLeader, ensureRoot, heartbeatRootLeader, readRootLeader } from "../identity.ts";
import { formatSwarmBatchMessageContent, formatSwarmMessageContent } from "../delivery.ts";
import { readState, readTaskState, taskPaths, trace, withLock, writeState } from "../state.ts";
import { logSwarmError } from "../errorlog.ts";
import {
	agentHeartbeatGCLocked,
	evaluateArtifactProgressNudgeLocked,
	evaluateSlotRecoveryLocked,
	evaluateTaskGraphStallNudgeLocked,
	reconcileGraphAdvanceLocked,
	reconcileInitialReadyLocked,
} from "../nudges/graph-advance.ts";
import { evaluateIdleGoalNudgeLocked, updateIdleEpochLocked } from "../nudges/goal-epoch.ts";
import { proxyMetricEmitLocked, staleOpenAssignmentScanLocked, staleOpenNudgeLocked } from "../taskgraph.ts";
import { currentAgentId } from "../session.ts";
import { orchSession } from "./session.ts";
import { isActionableRootMessage, parseTaskNodeRef } from "./actionable.ts";
import { staleSurfaceReason, traceStaleSuppressedOnce } from "./staleness.ts";
import { runPumpMaintenancePhasesLocked } from "./pump-phases.ts";
import { decideSurfaceLocked } from "./pump-decision.ts";
import { fingerprintMessage } from "./pump-shared.ts";

export async function pumpRootMailbox(pi: ExtensionAPI, ctx: any, p: Paths, reason: string) {
	if (currentAgentId() !== "root") return { delivered: 0, ids: [] as string[] };
	// Read idle once, up front. Non-TUI modes have no live agent loop to trigger, so they are treated as
	// "busy" — the file-IO surfacing decision still runs (for trace visibility) but no ctx-bound call is made.
	const idleAtStart = ctx.mode === "tui" ? ctx.isIdle() : false;
	const result = await withLock(p, async () => {
		const st = await readState(p, ctx.cwd);
		// Second-line defense (issue 8 §4.4.8): even if env vars were set by a path the preflight
		// couldn't catch (e.g. an edge that skipped the gate), a non-leader pid must not run the
		// pump. Read the leader record INSIDE the existing withLock (atomic with the rest of the
		// pump decision block; no extra file IO); on deny, trace + return empty without firing
		// nudges or stamping any surfaced set. This check piggybacks on the per-tick readState.
		const leaderCheck = readRootLeader(st, Date.now());
		if (leaderCheck.kind !== "claimed" || leaderCheck.leader.pid !== process.pid) {
			// === STALE-LEASE SELF-HEAL ===
			// A STALE lease (heartbeat older than ROOT_LEADER_STALE_MS — no live root
			// refreshed it) used to deny this tick, but the pump tick is the ONLY thing that refreshes
			// the lease. After a watchdog gap (module reload, extension edit mid-session) the pump
			// deadlocked on its own stale lease: every tick denied, no tick ever heartbeating again —
			// observed live as 16+ min of root.pump.denied(state=stale) with goal nudges and
			// message surfacing frozen while all agents sat idle. Now: when the lease is stale
			// (whoever held it, including this pid), re-claim — claimRootLeader only denies when
			// a LIVE competing pid holds it — and continue the tick. Deny remains only for a genuinely
			// LIVE lease held by a DIFFERENT pid (true multi-root conflict).
			if (leaderCheck.kind === "stale") {
				const reclaimed = claimRootLeader(st, Date.now(), process.pid);
				if (reclaimed.kind === "denied") {
					await trace(p, "root.pump.denied", {
						reason,
						currentLeaderPid: reclaimed.currentLeader.pid,
						state: "claimed",
						callerPid: process.pid,
						heartbeatAgeMs: reclaimed.ageMs,
						reclaimedStale: true,
					}).catch(() => {});
					return { toSurface: [] as SwarmMessage[], retriggered: 0 };
				}
				await trace(p, "root.pump.lease_reclaimed", {
					reason,
					previousPid: leaderCheck.leader.pid,
					staleForMs: Math.round(leaderCheck.ageMs),
					callerPid: process.pid,
				}).catch(() => {});
			} else {
				await trace(p, "root.pump.denied", {
					reason,
					currentLeaderPid: leaderCheck.kind === "claimed" ? leaderCheck.leader.pid : null,
					state: leaderCheck.kind,
					callerPid: process.pid,
					heartbeatAgeMs: leaderCheck.kind !== "vacant" ? leaderCheck.ageMs : null,
				}).catch(() => {});
				return { toSurface: [] as SwarmMessage[], retriggered: 0 };
			}
		}
		// === Issue 11 (rework): per-tick leader heartbeat ===
		// The leader lease must stay alive between session_starts (otherwise the second-line defense
		// above starts denying ticks within ROOT_LEADER_STALE_MS of the last session_start).
		// Refresh it inside the existing withLock (atomic with the rest of the pump decision block;
		// no extra file IO). heartbeatRootLeader is a no-op for the current pid when the
		// lease is already held by it; if a competing pid claimed it between the read and the
		// refresh, it throws ROOT_LEADER_DENIED, which is propagated to the watchdog catch.
		heartbeatRootLeader(st, Date.now(), process.pid, "pump_tick");
		// ensureRoot (create-only post-issue-8): no heartbeat refresh, just materialises the
		// pseudo-agent record for mailbox delivery. The heartbeat is owned by the gate.
		ensureRoot(st, ctx.cwd, p);
		const nowMs = Date.now();
		// Prune dead sessions (not pumped within TTL) to bound growth from transient validation pids.
		for (const [k, v] of Object.entries(st.rootPumpSessions!)) {
			if (k !== String(process.pid) && nowMs - new Date(v.lastAt).getTime() > PUMP_SESSION_TTL_MS) delete st.rootPumpSessions![k];
		}
		// Maintenance phases (heartbeat GC, stale-open scan, proxy metrics, stall nets,
		// idle-epoch + nudge evaluators, artifact-progress, slot recovery) — see pump-phases.ts.
		await runPumpMaintenancePhasesLocked(pi, ctx, p, st, nowMs, reason);
		// Session-safe surfacing keying is unchanged (per-pid, not PI_SESSION_ID, so a validation run or a
		// second root lane cannot starve this PM process). Recent window bounds work; acked messages
		// (ackedAt = "recipient processed it") are skipped. We no longer pre-filter surfaced here: surfaced
		// vs triggered vs re-trigger is decided below, because surfacing must be gated on idle.

		const sess = orchSession(st, nowMs)!;
		const surfaced = new Set(sess.ids);
		const triggeredAt = { ...(sess.triggeredAt ?? {}) };
		const retriggerCount = { ...(sess.retriggerCount ?? {}) };
		const keepalive = () => {
			sess.lastAt = new Date(nowMs).toISOString();
		};
		// Session-safe surfacing keying is unchanged (per-pid, not PI_SESSION_ID, so a validation run or a
		// second root lane cannot starve this PM process). Recent window bounds work; acked messages
		// (ackedAt = "recipient processed it") are skipped. We no longer pre-filter surfaced here: surfaced
		// vs triggered vs re-trigger is decided below, because surfacing must be gated on idle.

		// Surfacing decision (migration back-fill, dedupe gate, suppression census, busy defer /
		// stuck-busy escalation, idle candidate selection, coalescing, receipt write-back) — see
		// pump-decision.ts. Returns the toSurface plan inside the same withLock.
		return decideSurfaceLocked(ctx, p, st, nowMs, reason, idleAtStart);
	});
	const pending = result.toSurface;
	if (!pending.length) {
		if (ctx.mode === "tui")
			await trace(p, "mailbox.root_pump", {
				reason,
				count: 0,
				deferred: !idleAtStart ? 1 : 0,
				cid: String(process.pid),
				sid: process.env.PI_SESSION_ID ?? null,
				idleAtStart,
			});
		return { delivered: 0, ids: [] as string[] };
	}
	// Delivery is TUI-only (session-bound APIs: pi.sendMessage/ctx.isIdle). In print/rpc/json mode,
	// the captured ctx is invalidated on session teardown and these throw "ctx is stale" errors.
	// The decision block above (readState/writeState/trace) runs in all modes to record surfacing
	// decisions without ctx usage.
	if (ctx.mode === "tui") {
		const isBatch = pending.length > 1;
		if (isBatch) {
			const opts = result.escalatedStuck ? { triggerTurn: true, deliverAs: "steer" as const } : { triggerTurn: true };
			pi.sendMessage(
				{
					customType: "swarm-batch-message",
					content: formatSwarmBatchMessageContent(pending),
					display: true,
					details: {
						batch: true,
						count: pending.length,
						ids: pending.map((m) => m.id),
						messages: pending,
					},
				},
				opts,
			);
			await trace(p, "notification.batch.surfaced", {
				count: pending.length,
				ids: pending.map((m) => m.id),
				isBatch: true,
			}).catch(() => {});
		} else {
			for (let i = 0; i < pending.length; i++) {
				const msg = pending[i];
				// Stuck-busy escalation path: steer (interrupt the queued continuation and start a fresh
				// turn) instead of triggerTurn — the engine is NOT idle, so a queued turn would never fire.
				const opts = result.escalatedStuck
					? { triggerTurn: true, deliverAs: "steer" as const }
					: i === 0
						? { triggerTurn: true }
						: { deliverAs: "followUp" as const };
				pi.sendMessage(
					{
						customType: "swarm-message",
						content: formatSwarmMessageContent(msg),
						display: true,
						details: msg,
					},
					opts,
				);
			}
		}
		// Global-consume informational PM traffic ONLY AFTER a real TUI surface succeeded. This avoids
		// losing a message on stale-ctx/sendMessage failure while still preventing a later root
		// process from replaying historical requiresAck:false notices that were already shown once.
		const surfacedInfoIds = pending.filter((m) => m.requiresAck === false).map((m) => m.id);
		// === Issue 11: Write durable consumer receipt entries (binding C4 + C10) ===
		// For action-expected messages, write a receipt entry so a reincarnated consumer knows it was
		// surfaced. Bump revision immediately after write. For informational messages, the legacy delivered
		// ledger remains authoritative (consumerReceipts only covers actionable).
		const surfacedActionIds = pending.filter((m) => m.requiresAck === true).map((m) => m.id);
		if (surfacedInfoIds.length || surfacedActionIds.length) {
			await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const ts = now();
				// Legacy informational ledger (unchanged).
				if (surfacedInfoIds.length) {
					const ledgerIds = st.delivered.root || [];
					st.delivered.root = Array.from(new Set([...ledgerIds, ...surfacedInfoIds]));
				}
				// Durable consumer receipts for actionable messages.
				if (surfacedActionIds.length) {
					const entries = st.consumerReceipts!.root!.entries!;
					let bumped = false;
					for (const id of surfacedActionIds) {
						const rec = st.messages[id];
						if (!rec || rec.to !== "root" || rec.requiresAck !== true) continue;
						// Write receipt only if not already present (TUI delivery idempotence).
						if (entries[id]) continue;
						entries[id] = {
							surfacedAt: ts,
							ackedAt: rec.ackedAt,
							requiresAck: true,
							conversationId: rec.conversationId,
							fingerprint: fingerprintMessage(rec),
						};
						bumped = true;
					}
					// Bump revision immediately after entries mutation (binding C10).
					if (bumped) st.consumerReceipts!.root!.revision = (st.consumerReceipts!.root!.revision || 0) + 1;
				}
				// Legacy informational surfacedAt stamp (unchanged).
				for (const id of surfacedInfoIds) {
					const rec = st.messages[id];
					if (!rec || rec.to !== "root" || rec.requiresAck !== false || rec.surfacedAt) continue;
					rec.surfacedAt = ts;
					rec.updatedAt = ts;
				}
				await writeState(p, st);
			});
		}
		await trace(p, "mailbox.root_pump", {
			reason,
			count: pending.length,
			ids: pending.map((m) => m.id),
			retriggered: result.retriggered,
			informationalConsumed: surfacedInfoIds.length,
			cid: String(process.pid),
			sid: process.env.PI_SESSION_ID ?? null,
			idleAtStart,
		});
	} else {
		// In non-TUI mode, still trace pump activity (without ctx.isIdle) for visibility.
		await trace(p, "mailbox.root_pump", {
			reason,
			count: pending.length,
			ids: pending.map((m) => m.id),
			cid: String(process.pid),
			sid: process.env.PI_SESSION_ID ?? null,
			mode: ctx.mode,
		});
	}
	return { delivered: pending.length, ids: pending.map((m) => m.id) };
}
