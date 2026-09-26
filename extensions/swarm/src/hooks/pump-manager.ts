// === swarm/hooks/pump-manager.ts — root pump lifecycle + watchdog + agent surfacing ===
// Extracted verbatim from ../hooks.ts (Phase 7 modular split; canonical logic unchanged).
//
// Module boundary: the root mailbox pump LIFECYCLE (start/stop/watchdog) and the worker-side
// pull-delivery (surfaceAgentPending). The pump tick body itself is surface/pump.ts
// (pumpRootMailbox); the classify-and-react error handling that keeps the watchdog chain alive
// lives with startRootPump in ../hooks.ts (root-wake.test.mjs:329-334 pins its literal
// classification statements).
//
// === Issue 11 (rework): self-rescheduling watchdog chain ===
// The previous `setInterval` is fragile in long-idle Pi TUI sessions — Node may silently drop the
// interval registration when the process becomes idle (no UI focus / no user input / no LLM activity),
// and the only recovery path was a fresh `session_start` (which fires only when the user types). That
// is the exact root cause of the 04:09–04:45 UTC outage documented in the rejection review.
// Replace the `setInterval` with a self-rescheduling `setTimeout` watchdog:
//   - Each tick re-arms the next timeout from inside the run-completion path (single-flight via
//     `rootMailboxPumpRunning`), so the chain survives even if a single `setTimeout` is lost.
//   - `heartbeatRootLeader` is called from inside every tick so the leader lease stays alive
//     without requiring a `session_start`.
//   - Stale-ctx errors stop the chain (the only correct recovery is a fresh session_start on a new ctx).
//   - IO / leader-denied errors keep the chain running.
//   - A captured `pumpCtx` is checked for freshness on every tick; a stale `ctx.isIdle()` / `pi.sendMessage`
//     reference stops the chain (cannot be safely re-armed against the same ctx).
// `rootMailboxTimer` now holds the `setTimeout` handle (or undefined when stopped).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import type { Paths } from "../types.ts";
import { DEFAULT_TRACE_ROTATE_BYTES, PUMP_SESSION_ID_CAP } from "../constants.ts";
import { currentAgentId } from "../session.ts";
import { readMailbox } from "../mailbox.ts";
import { paths, readState, trace, withLock, writeState } from "../state.ts";
import { formatSwarmMessageContent } from "../delivery.ts";
import { maybeRotateTraces } from "../tools/audit.ts";
import { pumpRootMailbox } from "../surface.ts";
import { getSwarmPi } from "./streaks.ts";

// Root mailbox pump state. Module-level so the PM pump can be (re)started from outside the
// session_start hook — notably by `/swarm register here root`, which opts a running session in
// as the root after startup. `swarmPi` is captured once in registerSwarmHooks (always called
// first by index.ts) and reused so there is a single pump per extension load.
let rootMailboxTimer: NodeJS.Timeout | undefined;
let rootMailboxPumpRunning = false;
let rootPumpCtx: any = undefined;
let rootPumpCtxFresh: boolean = false;
let traceRotationInFlight = false;

// Pump tick interval (kept identical to the previous `setInterval` cadence so dashboards/expectations
// don't shift). Exposed as a constant so tests can shorten the wait for the watchdog test.
export const ROOT_PUMP_INTERVAL_MS = 5_000;

export function isRootMailboxPumpRunning(): boolean {
	return rootMailboxPumpRunning;
}
export function setRootMailboxPumpRunning(v: boolean): void {
	rootMailboxPumpRunning = v;
}
export function isRootPumpCtxFresh(): boolean {
	return rootPumpCtxFresh;
}
export function setRootPumpCtxFresh(v: boolean): void {
	rootPumpCtxFresh = v;
}
export function getRootMailboxTimer(): NodeJS.Timeout | undefined {
	return rootMailboxTimer;
}
export function setRootMailboxTimer(t: NodeJS.Timeout | undefined): void {
	rootMailboxTimer = t;
}
export function getRootPumpCtx(): any {
	return rootPumpCtx;
}
export function setRootPumpCtx(ctx: any): void {
	rootPumpCtx = ctx;
}

export function stopRootPump() {
	if (rootMailboxTimer) clearTimeout(rootMailboxTimer);
	rootMailboxTimer = undefined;
	// Drop the captured ctx so a stale-ctx cannot silently re-arm against a dead session. The watchdog
	// re-install path can only resume by `startRootPump` with a fresh ctx.
	rootPumpCtx = undefined;
	rootPumpCtxFresh = false;
}

// Re-arm the watchdog against a fresh ctx. The previous ctx is dropped (so a stale-ctx from a prior
// session cannot keep the chain alive). Idempotent: if the chain is already armed, it is replaced with
// a fresh tick scheduled from now; the old `setTimeout` is cleared.
export function armRootPumpWatchdog(ctx: any) {
	if (rootMailboxTimer) clearTimeout(rootMailboxTimer);
	rootPumpCtx = ctx;
	rootPumpCtxFresh = true;
	const tick = async () => {
		// Clear the handle that fired this tick — we are about to schedule the next one.
		rootMailboxTimer = undefined;
		if (!rootPumpCtxFresh) return; // stop() or stale-ctx already disabled us
		if (currentAgentId() !== "root") {
			rootPumpCtxFresh = false;
			return;
		}
		const myCtx = rootPumpCtx;
		if (!myCtx) {
			rootPumpCtxFresh = false;
			return;
		}
		if (rootMailboxPumpRunning) {
			// Re-arm even if a tick is already running (do not stall the chain).
			rootMailboxTimer = setTimeout(tick, ROOT_PUMP_INTERVAL_MS);
			return;
		}
		rootMailboxPumpRunning = true;
		try {
			await pumpRootMailbox(getSwarmPi()!, myCtx, paths((myCtx as any).cwd), "watchdog");
		} catch (err: any) {
			// === Issue 11 (rework): error classification with watchdog self-heal ===
			// The watchdog must NEVER permanently disable itself for a transient error. Distinguish:
			//   - stale-ctx: the captured ctx was invalidated by session replacement/reload. We cannot
			//     safely re-arm against the SAME ctx (would busy-loop with a thrown ctx.isIdle()). Stop
			//     the chain; the next session_start will call startRootPump with a fresh ctx.
			//   - IO transient (EACCES/ENOSPC/EROFS/EAGAIN/EBUSY/ENFILE/EMFILE) or leader-denied: keep
			//     the chain running — the next tick retries with file IO that will recover.
			//   - unknown error class: stop (safe default), trace the error so it surfaces.
			const msg = String((err && err.message) || err);
			const code = String((err && err.code) || "");
			const isStaleCtx = /stale after session/i.test(msg);
			const isLeaderDenied = msg.startsWith("ROOT_LEADER_DENIED");
			const isIoTransient = /EACCES|ENOSPC|EROFS|EAGAIN|EBUSY|ENFILE|EMFILE/.test(code) || /EACCES|ENOSPC|EROFS/.test(msg);
			if (isStaleCtx) {
				stopRootPump();
				trace(myCtx.cwd ? paths(myCtx.cwd) : null, "mailbox.root_pump_stale_stopped", { reason: "watchdog", error: msg }).catch(
					() => {},
				);
			} else if (isLeaderDenied || isIoTransient) {
				trace(myCtx.cwd ? paths(myCtx.cwd) : null, "mailbox.root_pump_transient", {
					reason: "watchdog",
					kind: isLeaderDenied ? "leader_denied" : "io",
					code,
					error: msg,
				}).catch(() => {});
				// keep the chain alive — schedule the next tick
			} else {
				stopRootPump();
				trace(myCtx.cwd ? paths(myCtx.cwd) : null, "mailbox.root_pump_error", {
					reason: "watchdog",
					error: msg,
					stale: false,
				}).catch(() => {});
			}
		} finally {
			rootMailboxPumpRunning = false;
			// Re-arm the next watchdog tick ONLY if we are still fresh + still the root + the
			// previous tick didn't stop us. This is the single-flight self-heal: a single tick failure
			// (transient IO) keeps the chain; a stop() drops it.
			if (rootPumpCtxFresh && rootPumpCtx && currentAgentId() === "root") {
				rootMailboxTimer = setTimeout(tick, ROOT_PUMP_INTERVAL_MS);
			}
		}
	};
	rootMailboxTimer = setTimeout(tick, ROOT_PUMP_INTERVAL_MS);
}

// Pull-based worker delivery: surface unacked messages addressed to this agent into its own TUI
// conversation via pi.sendMessage (no tmux). Idempotent per message via the shared agentSurfaced ledger
// (per-agent, capped), so restarts re-surface only what is still unacked. Never targets the root
// (that is pumpRootMailbox's job) and never surfaces dead-lettered or superseded messages.
export async function surfaceAgentPending(pi: ExtensionAPI, ctx: any, p: Paths, agentId: string, reason: string) {
	if (currentAgentId() !== agentId) return { surfaced: 0, ids: [] as string[] };
	const idleAtStart = ctx.mode === "tui" ? ctx.isIdle() : false;
	try {
		if (existsSync(p.events) && statSync(p.events).size >= DEFAULT_TRACE_ROTATE_BYTES && !traceRotationInFlight) {
			traceRotationInFlight = true;
			void maybeRotateTraces(p, {})
				.catch((err: any) =>
					trace(p, "trace.retention.rotate_error", { reason, error: String((err as Error)?.message || err) }).catch(() => {}),
				)
				.finally(() => {
					traceRotationInFlight = false;
				});
		}
	} catch (err: any) {
		await trace(p, "trace.retention.rotate_probe_error", { reason, error: String((err as Error)?.message || err) }).catch(() => {});
	}
	const result = await withLock(p, async () => {
		const st = await readState(p, ctx.cwd);
		st.agentSurfaced ||= {};
		const surfaced = new Set(st.agentSurfaced[agentId] || []);
		const pending = Object.values(st.messages || {})
			.filter((r) => r.to === agentId && !r.ackedAt && r.status !== "dead_letter" && !r.superseded && !surfaced.has(r.id))
			.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
			.slice(0, 10);
		if (pending.length) {
			st.agentSurfaced[agentId] = [...surfaced, ...pending.map((r) => r.id)].slice(-PUMP_SESSION_ID_CAP);
		}
		await writeState(p, st);
		return { ids: pending.map((r) => r.id) };
	});
	if (!result.ids.length) return { surfaced: 0, ids: [] };
	if (ctx.mode !== "tui") {
		await trace(p, "mailbox.agent_surface_skip", { agentId, reason, count: result.ids.length, mode: ctx.mode });
		return { surfaced: 0, ids: result.ids };
	}
	// Read bodies from the mailbox (records carry no body).
	const msgs = await readMailbox(p, agentId);
	let delivered = 0;
	for (let i = 0; i < result.ids.length; i++) {
		const m = msgs.find((x) => x.id === result.ids[i]);
		if (!m) continue;
		// A requiresAck message is action-expected: trigger a real turn so the agent acts, not just sees.
		pi.sendMessage(
			{
				customType: "swarm-message",
				content: formatSwarmMessageContent(m),
				display: true,
				details: m,
			},
			i === 0 && idleAtStart ? { triggerTurn: true } : { deliverAs: "followUp" },
		);
		delivered++;
	}
	await trace(p, "mailbox.agent_surface", { agentId, reason, count: delivered, ids: result.ids, idleAtStart });
	return { surfaced: delivered, ids: result.ids };
}
