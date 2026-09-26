// === swarm/surface/pump-decision.ts — pump surfacing decision block (Phase 7) ===
// Extracted verbatim from surface/pump.ts (Phase 7 split of ../surface.ts).
//
// decideSurfaceLocked runs inside the pump's withLock and returns the per-tick surfacing plan:
//   - Issue 11 one-time migration back-fill (binding C4)
//   - durable dedupe gate + actionability filter (binding C4 + C5)
//   - per-tick batch suppression census (binding C6)
//   - BUSY defer + stuck-busy escalation (R13/PUMP_STUCK_DEFER_ESCALATE_MS)
//   - IDLE candidate selection + bounded re-trigger
// Mutates the caller's per-pid orchSession (surfaced/triggeredAt/retriggerCount) via sess.
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type { MessageRecord, Paths, SwarmMessage, SwarmState, TaskState } from "../types.ts";
import {
	PUMP_RETRIGGER_DELAY_MS,
	PUMP_RETRIGGER_MAX,
	PUMP_SCAN_WINDOW,
	PUMP_SESSION_ID_CAP,
	TERMINAL_NODE_STATUSES,
	PUMP_STUCK_DEFER_ESCALATE_MS,
	ROOT_BUSY_ACTIVE_EXECUTION_MS,
} from "../constants.ts";
import { capMap, now } from "../utils.ts";
import { readMailboxCached } from "../mailbox.ts";
import { readTaskState, taskPaths, trace, writeState } from "../state.ts";
import { logSwarmError } from "../errorlog.ts";
import { orchSession } from "./session.ts";
import { isActionableRootMessage, parseTaskNodeRef } from "./actionable.ts";
import { staleSurfaceReason, traceStaleSuppressedOnce } from "./staleness.ts";
import { compareSurfaceCandidates } from "./ranking.ts";
import { coalesceSurfacePlanLocked } from "./coalesce.ts";
import { fingerprintMessage } from "./pump-shared.ts";

export async function decideSurfaceLocked(
	ctx: any,
	p: Paths,
	st: SwarmState,
	nowMs: number,
	reason: string,
	idleAtStart: boolean,
): Promise<{ toSurface: SwarmMessage[]; retriggered: number; escalatedStuck?: boolean }> {
	const sess = orchSession(st, nowMs)!;
	const surfaced = new Set(sess.ids);
	const triggeredAt = { ...(sess.triggeredAt ?? {}) };
	const retriggerCount = { ...(sess.retriggerCount ?? {}) };
	const keepalive = () => {
		sess.lastAt = new Date(nowMs).toISOString();
	};

	// === Issue 11: One-time migration back-fill (binding C4) ===
	if ((st.consumerReceipts?.root?.revision ?? 0) === 0) {
		const migrationEntries = st.consumerReceipts!.root!.entries!;
		let written = 0;
		let scanned = 0;
		// Build task index for actionability predicate.
		const taskIndex: Record<string, TaskState> = {};
		if (existsSync(p.tasksDir)) {
			try {
				const entries = await readdir(p.tasksDir);
				for (const taskId of entries) {
					const tp = taskPaths(p, taskId);
					if (!existsSync(tp.taskJson)) continue;
					try {
						taskIndex[taskId] = await readTaskState(tp.taskJson);
					} catch (err: any) {
						if (err?.code !== "ENOENT") {
							await logSwarmError(p, "surface", "task_index.unreadable", err, { taskId });
						}
					}
				}
			} catch (err: any) {
				if (err?.code !== "ENOENT") {
					await logSwarmError(p, "surface", "task_index.readdir_failed", err);
				}
			}
		}
		const retriggerCounts = orchSession(st, nowMs)!.retriggerCount || {};
		for (const rec of Object.values(st.messages)) {
			scanned++;
			if (rec.to !== "root") continue;
			if (!rec.requiresAck) continue;
			// Use the actionability predicate; non-actionable messages get a receipt.
			// Note: do NOT short-circuit on rec.ackedAt here — the predicate returns reason="acked"
			// and we want the receipt entry written so a reincarnated consumer reads it.
			const v = isActionableRootMessage(rec, taskIndex, nowMs, retriggerCounts, /* strictForMigration */ true, p);
			if (!v.ok) {
				migrationEntries[rec.id] = {
					surfacedAt: rec.updatedAt || rec.createdAt,
					ackedAt: rec.ackedAt,
					requiresAck: true,
					conversationId: rec.conversationId,
					fingerprint: fingerprintMessage(rec),
				};
				written++;
			}
		}
		st.consumerReceipts!.root!.revision = 1;
		await trace(p, "notification.backfill.receipts_written", { written, scanned, ts: nowMs }).catch(() => {});
	}

	// === Issue 11: Durable dedupe gate + actionability filter (binding C4 + C5) ===
	const deliveredOrch = new Set(st.delivered.root || []);
	// Build task index for actionability predicate.
	const taskIndex: Record<string, TaskState> = {};
	if (existsSync(p.tasksDir)) {
		try {
			const entries = await readdir(p.tasksDir);
			for (const taskId of entries) {
				const tp = taskPaths(p, taskId);
				if (!existsSync(tp.taskJson)) continue;
				try {
					taskIndex[taskId] = await readTaskState(tp.taskJson);
				} catch (err: any) {
					if (err?.code !== "ENOENT") {
						await logSwarmError(p, "surface", "task_index.unreadable", err, { taskId });
					}
				}
			}
		} catch (err: any) {
			if (err?.code !== "ENOENT") {
				await logSwarmError(p, "surface", "task_index.readdir_failed", err);
			}
		}
	}
	const retriggerCounts = orchSession(st, nowMs)!.retriggerCount || {};
	const windowMsgs = (await readMailboxCached(p, "root")).slice(-PUMP_SCAN_WINDOW).filter((m) => {
		const rec = st.messages[m.id];
		if (!rec) return false;

		// Durable dedupe gate (binding C4): check consumerReceipts first, then legacy delivered ledger, then per-pid surfaced.
		if (st.consumerReceipts?.root?.entries?.[m.id]) return false;
		if (rec.requiresAck === false && (rec.surfacedAt || deliveredOrch.has(m.id))) return false;
		if (surfaced.has(m.id)) return false; // per-pid surfaced (retrigger bound)

		// Actionability predicate (binding C5): skip non-actionable messages and batch-count suppressions.
		const v = isActionableRootMessage(rec, taskIndex, nowMs, retriggerCounts, /* strictForMigration */ false, p);
		return v.ok;
	});

	// === Issue 11: Per-tick batch suppression trace (binding C6) ===
	// Count all suppressed messages by reason before the BUSY check. Emit on EVERY tick including total===0.
	const suppressedCounts: Record<string, number> = {
		acked: 0,
		dead_letter: 0,
		superseded: 0,
		task_done: 0,
		task_failed: 0,
		task_cancelled: 0,
		node_terminal: 0,
		node_reassigned: 0,
		task_missing: 0,
		node_missing: 0,
		wrong_recipient: 0,
		retrigger_budget_exhausted: 0,
		informational_already_consumed: 0,
	};
	const allMsgs = (await readMailboxCached(p, "root")).slice(-PUMP_SCAN_WINDOW);
	for (const m of allMsgs) {
		const rec = st.messages[m.id];
		if (!rec || rec.to !== "root") continue;
		if (st.consumerReceipts?.root?.entries?.[m.id]) {
			suppressedCounts.informational_already_consumed++;
			continue;
		}
		if (rec.requiresAck === false && (rec.surfacedAt || deliveredOrch.has(m.id))) {
			suppressedCounts.informational_already_consumed++;
			continue;
		}
		if (surfaced.has(m.id)) continue; // not suppressed - already surfaced this session
		const v = isActionableRootMessage(rec, taskIndex, nowMs, retriggerCounts, false, p);
		if (!v.ok) {
			const key = v.reason === "retrigger_budget_exhausted" ? "retrigger_budget_exhausted" : v.reason;
			suppressedCounts[key] = (suppressedCounts[key] || 0) + 1;
			if (
				key === "node_reassigned" ||
				key === "node_terminal" ||
				key === "task_done" ||
				key === "task_failed" ||
				key === "task_cancelled" ||
				key === "task_missing" ||
				key === "node_missing"
			) {
				await traceStaleSuppressedOnce(p, "root_pump.surface", {
					messageId: m.id,
					idempotencyKey: rec.idempotencyKey || m.idempotencyKey || null,
					reason: key,
					evidence: [key],
				});
			}
		}
	}
	const totalSuppressed = Object.values(suppressedCounts).reduce((a, b) => a + b, 0);
	await trace(p, "notification.batch.suppressed", {
		ts: nowMs,
		cid: String(process.pid),
		reason: "per-tick baseline",
		total: totalSuppressed,
		counts: suppressedCounts,
	}).catch(() => {});

	// BUSY: defer entirely. Do NOT surface, do NOT mark surfaced, do NOT deliver a dead followUp. A
	// followUp delivered while busy carries no triggerTurn, so it lands in context without prompting the
	// LLM to act; the old code still marked it "surfaced", which made every later idle pump (incl.
	// agent_settled) skip it forever — the loop-nudge-stuck-at-awaiting_plan bug. Deferring keeps the
	// message un-marked so the next idle pump (session_start / agent_settled / 5s interval) re-reads it
	// and delivers it WITH a real triggerTurn. It also stops queuing followUps that can themselves keep
	// isIdle() false (a secondary cause of the root never waking).
	//
	// STUCK-BUSY ESCALATION: ctx.isIdle() can stay false indefinitely while pi has a queued
	// continuation / auto-retry pending (e.g. provider 429 backoff, auto-compaction retry) even
	// though the root is swarm-idle (heartbeat says idle, nothing is running). Without an
	// escape hatch the deferral above is unbounded: messages pile up until the human intervenes
	// (Esc/reload) — the observed "messages only arrive when I press /reload" bug. When the oldest
	// never-displayed message has waited longer than PUMP_STUCK_DEFER_ESCALATE_MS while busy, surface
	// it with an explicit steer: steering interrupts the queued continuation and starts a fresh turn,
	// which is exactly the operator-mandated behavior for stale deferrals.
	const neverDisplayedBusy = windowMsgs.filter((m) => !surfaced.has(m.id));
	const activeGoalId = st.goal?.id;
	const activeNudgeSeq = Number(st.goal?.nudgeSeq);
	const actionableBusyMsgs = neverDisplayedBusy.filter((m) => {
		const rec = st.messages[m.id] || m;
		const key = String(rec.idempotencyKey || m.idempotencyKey || "");
		const goalKey = key.match(/^goal:([^:]+):nudge:idle-streak:(\d+)$/);
		if (goalKey && activeGoalId && goalKey[1] === activeGoalId && Number.isFinite(activeNudgeSeq)) {
			const seq = Number(goalKey[2]);
			if (Number.isFinite(seq) && seq < activeNudgeSeq) {
				return false;
			}
		}
		return true;
	});
	const oldestWaitMs = actionableBusyMsgs.length
		? nowMs - new Date(actionableBusyMsgs.map((m) => st.messages[m.id]?.createdAt || m.createdAt).sort()[0] || nowMs).getTime()
		: 0;
	const lastToolMs = st.agents.root?.lastToolAt ? new Date(st.agents.root.lastToolAt).getTime() : 0;
	const isRootActivelyExecuting = Number.isFinite(lastToolMs) && nowMs - lastToolMs < ROOT_BUSY_ACTIVE_EXECUTION_MS;
	const shouldEscalate = !idleAtStart && oldestWaitMs >= PUMP_STUCK_DEFER_ESCALATE_MS && !isRootActivelyExecuting;
	if (!idleAtStart && !shouldEscalate) {
		keepalive();
		if (neverDisplayedBusy.length) {
			await trace(p, "mailbox.root_pump_deferred", {
				reason,
				queued: neverDisplayedBusy.length,
				actionableQueued: actionableBusyMsgs.length,
				oldestWaitMs: Math.round(oldestWaitMs),
				thresholdMs: PUMP_STUCK_DEFER_ESCALATE_MS,
				cid: String(process.pid),
				sid: process.env.PI_SESSION_ID ?? null,
				rootActivelyExecuting: isRootActivelyExecuting,
			});
		}
		await writeState(p, st);
		return { toSurface: [] as SwarmMessage[], retriggered: 0 };
	}
	const escalateStuck = shouldEscalate;
	if (escalateStuck) {
		await trace(p, "mailbox.root_pump_stuck_escalated", {
			reason,
			queued: neverDisplayedBusy.length,
			actionableQueued: actionableBusyMsgs.length,
			oldestWaitMs: Math.round(oldestWaitMs),
			thresholdMs: PUMP_STUCK_DEFER_ESCALATE_MS,
			cid: String(process.pid),
			sid: process.env.PI_SESSION_ID ?? null,
		});
	}

	// IDLE: we can fire a real turn.
	// (1) Messages never displayed to this pid (highest priority — fresh work).
	// (2) Action-expected (requiresAck) messages already surfaced+triggered but still unacked and overdue
	//     (bounded re-trigger). Informational (requiresAck:false) messages are NOT re-triggered: a single
	//     triggered delivery already prompted the root once, which is sufficient.
	const neverDisplayed = windowMsgs.filter((m) => !surfaced.has(m.id));
	const overdueRetrigger = windowMsgs.filter((m) => {
		if (!surfaced.has(m.id)) return false;
		const rec = st.messages[m.id];
		if (!rec?.requiresAck || rec.ackedAt) return false;
		const last = triggeredAt[m.id];
		if (!last) return false;
		if (nowMs - new Date(last).getTime() < PUMP_RETRIGGER_DELAY_MS) return false;
		return (retriggerCount[m.id] ?? 0) < PUMP_RETRIGGER_MAX;
	});
	const surfaceCandidates = [...neverDisplayed, ...overdueRetrigger].slice(0, 10);
	// Coalescing + R13 bypass + receipt write-back — see coalesce.ts.
	const toSurface = await coalesceSurfacePlanLocked(surfaceCandidates, p, st, { taskIndex, surfaced, nowMs, sess });
	if (!toSurface.length) {
		keepalive();
		await writeState(p, st);
		return { toSurface: [] as SwarmMessage[], retriggered: 0 };
	}
	// Mark all surfaced now; stamp triggeredAt for every delivered message (the first gets triggerTurn,
	// the rest ride that turn's wake as followUp — both count as "triggered"). Increment retriggerCount
	// only for the overdue ones (a genuine re-prompt); first-time triggers stay at 0.
	const retriggerSet = new Set(overdueRetrigger.map((m) => m.id));
	for (const m of toSurface) {
		surfaced.add(m.id);
		triggeredAt[m.id] = new Date(nowMs).toISOString();
		if (retriggerSet.has(m.id)) retriggerCount[m.id] = (retriggerCount[m.id] ?? 0) + 1;
	}
	const nextIds = [...surfaced];
	sess.ids = nextIds.length > PUMP_SESSION_ID_CAP ? nextIds.slice(nextIds.length - PUMP_SESSION_ID_CAP) : nextIds;
	// Bound the maps the same way as ids (drop oldest beyond the cap) so a long-lived session cannot
	// grow unbounded.
	sess.triggeredAt = capMap(triggeredAt, PUMP_SESSION_ID_CAP);
	sess.retriggerCount = capMap(retriggerCount, PUMP_SESSION_ID_CAP);
	keepalive();
	await writeState(p, st);
	return { toSurface, retriggered: toSurface.filter((m) => retriggerSet.has(m.id)).length, escalatedStuck: escalateStuck };
}
