// === swarm/nudges/guest-goal.ts — guest-goal v1 evaluator + watchdog (task guest-goal, 2026-10-30) ===
//
// A plain `pi` session that loads the swarm extension without PI_SWARM_AGENT_ID and without a
// root opt-in resolves to the anonymous SWARM_GUEST_ID. Guests are inert for swarm COORDINATION
// (tools/gating.ts drops the swarm_* surface; no pump, no root authority) — but the
// vacuous-user-goal-nudge fix (2026-10-29) gave the ROOT a standing-goal floor for solo work,
// and a guest session doing solo work has NO equivalent: `/swarm goal` is root-only and nothing
// ever evaluates a guest's goal. This module closes that parity gap with a MINIMAL surface:
//
//   - storage: st.guestGoal (SwarmGoal shape, origin "user", setBy "swarm-guest") — a SEPARATE
//     slot from st.goal (root-owned); single slot per project (two concurrent guest sessions
//     share it — documented limitation, parity with the root's single slot);
//   - surface: `/swarm guest-goal set|show|done` — human-driven only; the guest keeps its
//     no-tool-surface gating (a guest model cannot spawn/swarm, so it also cannot set goals);
//   - evaluator: evalGuestGoalNudgeLocked — the R27 check-streak debounce with its OWN counter
//     fields (guestGoalIdleCheckCount/guestGoalIdleLastCheckAt; the shared fields are owned by
//     the root pump's idle-epoch machinery), the standard cap (MAX_CONSECUTIVE_NUDGES_DEFAULT,
//     overridable per-goal via maxNudges) and backoff (GOAL_NUDGE_BACKOFF_TICKS);
//   - emission: direct pi.sendMessage (L2) with customType "swarm-message" + display:true —
//     the same worker-surface pattern as surfaceAgentPending (pump-manager.ts). NO mailbox
//     write (L1): the nudge is session-local (the guest has no swarm peers; a durable record
//     would just accumulate unacked rows nobody consumes). Idempotency is instead the
//     nudgeSeq-keyed trace + the cap+backoff machinery;
//   - reset: the guest's own turn_end {stop} resets consecutiveNoResolveNudges (registered in
//     hooks/turns.ts — guests have no swarm tools, so the R16 resolve-action detector cannot
//     apply; ending a turn IS the resolve, matching the root's pre-R16 semantic);
//   - surface timing: a one-shot evaluation on agent_settled (ALL modes — this is the surface
//     a `pi -p` lane observes) + a self-rescheduling 5s watchdog in TUI mode only (mirrors the
//     root pump's Issue-11 setTimeout chain: survives single-tick failures, stops on stale ctx).
//
// Pi runtime contract layers crossed (see docs/swarm/pi-runtime-contract.md §1, row F32):
//   L2 pi.sendMessage (fire-and-forget, F1: do NOT await) — counted at the real boundary in
//      tests/guest-goal-nudge.test.mjs (mock pi.sent) and the mock-llm lane;
//   L3 the message renders via the existing "swarm-message" renderer;
//   L4 the nudge lands in the guest's next model request.
// NO L1 mailbox write, NO root involvement, NO new authority surface.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GOAL_NUDGE_BACKOFF_TICKS } from "../constants.ts";
import { resolveGoalIdleCheckIntervalMs, resolveGoalIdleChecksRequired, resolveGoalMaxNudges } from "./goal-epoch.ts";
import { currentAgentId } from "../session.ts";
import { trace, withLock, readState, writeState, paths } from "../state.ts";
import type { Paths, SwarmGoal, SwarmState } from "../types.ts";
import { now } from "../utils.ts";
import { logSwarmError } from "../errorlog.ts";

// Guest watchdog cadence — same value as ROOT_PUMP_INTERVAL_MS (pump-manager.ts); duplicated
// deliberately so the two chains can evolve independently (the guest chain is far cheaper).
export const GUEST_GOAL_WATCHDOG_INTERVAL_MS = 5_000;

export function isGuestSession(): boolean {
	return currentAgentId() === "swarm-guest";
}

// The nudge body. Solo-aware like the vacuous-user-goal fix: continue the goal yourself or
// mark it done — no swarm hints (a guest has no swarm surface to act on).
function guestGoalNudgeBody(goal: SwarmGoal, checksRequired: number, intervalMs: number): string {
	return [
		`⏰ Standing goal (guest session) — you have been idle for ${checksRequired} consecutive checks (${Math.round(intervalMs / 1000)}s apart).`,
		``,
		`Goal ${goal.id}: ${goal.text}`,
		``,
		`This session has no swarm agents. If the goal is not finished, continue working on it now (solo). When it is achieved or abandoned, mark it done: /swarm guest-goal done.`,
	].join("\n");
}

// === The evaluator (runs INSIDE withLock; caller owns readState/writeState) ===
// Returns the emission decision for observability/tests. Never throws for a missing goal
// (a cleared goal is the normal stop condition, not an error).
export interface GuestGoalEvalResult {
	emitted: boolean;
	reason:
		| "no_goal" // no st.guestGoal — nothing to evaluate
		| "not_guest" // caller is not the guest (authority fence)
		| "busy" // guest session is mid-run (isIdle() === false) — resets the streak
		| "interval_pending" // streak sample accepted but not yet at checksRequired
		| "emitted" // nudge sent at L2
		| "max_nudges" // cap reached; backoff armed/draining
		| "backoff"; // backoff ticks remaining
	checkCount?: number;
	nudgeSeq?: number;
}

export function evalGuestGoalNudgeLocked(
	pi: ExtensionAPI | null,
	ctx: any,
	p: Paths,
	st: SwarmState,
	nowMs: number,
	busy: boolean,
): GuestGoalEvalResult {
	if (!isGuestSession()) return { emitted: false, reason: "not_guest" };
	const goal = st.guestGoal;
	if (!goal) return { emitted: false, reason: "no_goal" };
	const idle = (st.idleNudgeState ||= {});
	// Busy sample resets the streak (mirrors the root floor's busy-edge reset): a guest that
	// just finished a turn starts a FRESH streak, so the nudge only fires on sustained idleness.
	if (busy) {
		idle.guestGoalIdleCheckCount = 0;
		delete idle.guestGoalIdleLastCheckAt;
		return { emitted: false, reason: "busy" };
	}
	// Cap + backoff (same semantics as the root floor: cap → arm backoff; the draining tick
	// does not emit; the tick that drains to 0 exits without emitting; maxNudges === -1 is
	// uncapped and never enters backoff).
	const effectiveMax = resolveGoalMaxNudges(goal.maxNudges);
	if (effectiveMax !== -1 && goal.consecutiveNoResolveNudges >= effectiveMax) {
		const backoffTicks = goal.backoffTicksRemaining ?? GOAL_NUDGE_BACKOFF_TICKS;
		if (backoffTicks > 0) {
			goal.backoffTicksRemaining = backoffTicks - 1;
			return { emitted: false, reason: "backoff" };
		}
		// Backoff drained: re-arm (the next eligible streak may fire again — matches the root
		// floor's re-arm-able backoff).
		goal.backoffTicksRemaining = GOAL_NUDGE_BACKOFF_TICKS;
		return { emitted: false, reason: "max_nudges" };
	}
	// Check-streak debounce with spacing (R27 semantics on the guest's own fields).
	const intervalMs = resolveGoalIdleCheckIntervalMs();
	const checksRequired = resolveGoalIdleChecksRequired();
	const last = idle.guestGoalIdleLastCheckAt ? new Date(idle.guestGoalIdleLastCheckAt).getTime() : 0;
	if (nowMs - last < intervalMs) return { emitted: false, reason: "interval_pending" };
	idle.guestGoalIdleCheckCount = (idle.guestGoalIdleCheckCount ?? 0) + 1;
	idle.guestGoalIdleLastCheckAt = new Date(nowMs).toISOString();
	const count = idle.guestGoalIdleCheckCount;
	if (count < checksRequired) return { emitted: false, reason: "interval_pending", checkCount: count };
	// Streak complete → emit.
	idle.guestGoalIdleCheckCount = 0;
	delete idle.guestGoalIdleLastCheckAt;
	goal.consecutiveNoResolveNudges += 1;
	goal.nudgeSeq = (goal.nudgeSeq ?? 0) + 1;
	goal.lastNudgeAt = new Date(nowMs).toISOString();
	if (effectiveMax !== -1 && goal.consecutiveNoResolveNudges >= effectiveMax) {
		goal.backoffTicksRemaining = GOAL_NUDGE_BACKOFF_TICKS;
	}
	const body = guestGoalNudgeBody(goal, checksRequired, intervalMs);
	// L2 (fire-and-forget per contract F1 — never await). Session-local: no mailbox record.
	// Delivery is TUI-only in production; in -p/print mode the settle surface may still record
	// the streak without sending (the ctx is torn down at process exit) — guard both.
	if (pi && (ctx?.mode ?? "tui") === "tui") {
		try {
			// triggerTurn:true — the nudge must not just render (L3), it must START a turn so the
			// goal is actually worked (L4) — the same contract as the root pump's surface send
			// (surface/pump.ts). Safe because this evaluator only runs on idle/settle surfaces.
			pi.sendMessage(
				{
					customType: "swarm-message",
					content: body,
					display: true,
					details: { guestGoal: true, goalId: goal.id, nudgeSeq: goal.nudgeSeq },
				},
				{ triggerTurn: true },
			);
		} catch (err: any) {
			// sendMessage may throw synchronously on a stale ctx (contract §2). The goal
			// accounting above already ran — record durably and DO NOT rethrow into the settle
			// path (a failed nudge must never break the session).
			void logSwarmError(p ?? null, "guest-goal", "nudge_send_failed", err, { goalId: goal.id });
		}
	}
	void trace(p, "goal.idle_nudge", {
		goalId: goal.id,
		route: "guest_solo",
		consecutiveCount: goal.consecutiveNoResolveNudges,
		max: effectiveMax,
		nudgeSeq: goal.nudgeSeq,
		checksRequired,
		checkIntervalMs: intervalMs,
		guest: true,
		// Delivery provenance: the L2 sendMessage carries triggerTurn (the nudge must START a
		// turn, not just render). Recorded here because a `pi -p` lane exits before the
		// triggered turn can run — the durable trace is the delivery evidence in that mode
		// (same scope decision as the vacuous-user-goal-nudge live lane).
		triggerTurn: true,
	}).catch(() => {
		/* trace() is the choke point: on append failure it logs to the durable error census
		   before rejecting; this net only stops an unhandled rejection in the settle path. */
	});
	return { emitted: true, reason: "emitted", nudgeSeq: goal.nudgeSeq };
}

// === Settle/watchdog surfaces ===
// One-shot evaluation callable from agent_settled in ANY mode (print sessions exit after the
// turn; this surface is what a `pi -p` lane observes). Runs its own withLock.
export async function evaluateGuestGoalOnSettle(pi: ExtensionAPI, ctx: any): Promise<GuestGoalEvalResult | null> {
	let mode = "tui";
	try {
		mode = ctx?.mode ?? "tui";
	} catch {
		mode = "tui";
	}
	let busy = false;
	if (mode === "tui") {
		try {
			busy = typeof ctx?.isIdle === "function" ? !ctx.isIdle() : false;
		} catch {
			// Stale ctx: treat as busy (safe — no nudge on a dead session).
			return null;
		}
	}
	let cwd = "";
	try {
		cwd = ctx?.cwd;
	} catch {
		cwd = process.cwd();
	}
	const p = paths(cwd);
	let result: GuestGoalEvalResult | null = null;
	try {
		await withLock(p, async () => {
			const st = await readState(p, cwd);
			result = evalGuestGoalNudgeLocked(pi, ctx, p, st, Date.now(), busy);
			await writeState(p, st);
		});
	} catch (err: any) {
		// A settle hook must never throw into Pi (contract §7 handles extension errors, but a
		// throw here would also skip the watchdog re-arm below). Record durably and continue.
		await logSwarmError(cwd, "guest-goal", "settle_evaluate_failed", err, {});
	}
	// TUI: arm the background watchdog chain (idempotent re-arm, fresh ctx each settle —
	// the same self-heal pattern as the root pump's agent_settled branch).
	if (mode === "tui") armGuestGoalWatchdog(pi, ctx);
	return result;
}

// === Issue-11-style self-rescheduling watchdog (TUI only) ===
// A single lost setTimeout must not kill the chain: each tick re-arms from the run-completion
// path. Stops when: the guest goal clears, the session identity changes away from guest, the
// ctx goes stale (checked defensively), or stopGuestGoalWatchdog() runs (session_shutdown).
let guestGoalTimer: NodeJS.Timeout | undefined;
let guestGoalRunning = false;

export function stopGuestGoalWatchdog(): void {
	if (guestGoalTimer) clearTimeout(guestGoalTimer);
	guestGoalTimer = undefined;
}

export function armGuestGoalWatchdog(pi: ExtensionAPI, ctx: any): void {
	if (guestGoalTimer) return; // already armed
	let fresh = true;
	const tick = async () => {
		guestGoalTimer = undefined;
		if (!fresh) return;
		if (!isGuestSession()) return;
		if (guestGoalRunning) {
			guestGoalTimer = setTimeout(tick, GUEST_GOAL_WATCHDOG_INTERVAL_MS);
			return;
		}
		guestGoalRunning = true;
		try {
			let cwd = "";
			try {
				cwd = ctx?.cwd;
			} catch {
				return; // stale ctx — stop the chain (a fresh settle re-arms with a new ctx)
			}
			let busy = false;
			try {
				busy = typeof ctx?.isIdle === "function" ? !ctx.isIdle() : false;
			} catch {
				return; // stale ctx
			}
			const p = paths(cwd);
			let stillGuest = false;
			await withLock(p, async () => {
				const st = await readState(p, cwd);
				stillGuest = Boolean(st.guestGoal);
				if (st.guestGoal) {
					evalGuestGoalNudgeLocked(pi, ctx, p, st, Date.now(), busy);
					await writeState(p, st);
				}
			});
			if (!stillGuest) return; // goal cleared — stop the chain (re-armed on next set)
		} catch (err: any) {
			const msg = String((err as Error)?.message || err);
			if (/stale after session/i.test(msg)) {
				// stop (fresh session_start/settle re-arms with a new ctx); record durably.
				void logSwarmError(process.cwd(), "guest-goal", "watchdog_stale_ctx_stopped", err, {});
				return;
			}
			// IO/transient: keep the chain alive (bounded retries; trace the census event).
			void trace(paths(process.cwd()), "guest_goal.watchdog_transient", { error: msg }).catch(() => {
				/* choke-point-protected net (see evalGuestGoalNudgeLocked) */
			});
		} finally {
			guestGoalRunning = false;
			if (fresh && isGuestSession() && !guestGoalTimer) {
				guestGoalTimer = setTimeout(tick, GUEST_GOAL_WATCHDOG_INTERVAL_MS);
			}
		}
	};
	guestGoalTimer = setTimeout(tick, GUEST_GOAL_WATCHDOG_INTERVAL_MS);
}
