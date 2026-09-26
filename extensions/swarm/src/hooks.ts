// === swarm/src/hooks.ts — facade (Phase 7 modular split) ===
// The hook machinery was decomposed into src/hooks/ submodules:
//   - hooks/streaks.ts         — rootEditStreak + swapChain + engineRetryIncidents (shared state)
//   - hooks/pump-manager.ts    — pump lifecycle: stopRootPump / armRootPumpWatchdog / surfaceAgentPending
//   - hooks/pool-swap.ts       — turn_end model-pool auto-swap (engine-retry gate + swap-chain cap)
//   - hooks/turns.ts           — SWARM_RESOLVE_TOOLS + turnEndIsResolveAction + turn_start / turn_end resolve
//   - hooks/session.ts         — session_start / before_agent_start / agent_start
//   - hooks/settled.ts         — agent_settled (transient suppression + response-missing + ack-debt)
//   - hooks/tools.ts           — tool_execution_start/end + tool_result (delegation guard)
//   - hooks/shutdown-input.ts  — session_shutdown + input (steering intercept / Issue 86 interrupt)
//
// This facade keeps the two pieces that must stay physically here:
//   1. registerSwarmHooks — the single registration point. Handler registration ORDER is load-
//      bearing (Pi Runtime Contract §8: pi runs per-event handlers in registration order):
//      turn_end(pool-swap) BEFORE turn_end(goal-resolve) so the resolve observes post-swap
//      state (binding C-2); session_shutdown AFTER tool_result.
//   2. startRootPump — with the literal watchdog error-classification statements that
//      root-wake.test.mjs:329-334 greps for (isStaleCtx / isIoTransient / isLeaderDenied).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentAgentId } from "./session.ts";
import { paths, readState, trace, withLock, writeState } from "./state.ts";
import { heartbeatRootLeader } from "./identity.ts";
import { pumpRootMailbox } from "./surface.ts";
import {
	getSwarmPi,
	setSwarmPi,
	_resetSwapChainForTests,
	bumpSwapChain,
	getEngineRetryIncident,
	getRootEditStreak,
	getSwapChainCount,
	resetRootEditStreak,
	ROOT_EDIT_STREAK_WARN_THRESHOLD,
} from "./hooks/streaks.ts";
import {
	ROOT_PUMP_INTERVAL_MS,
	armRootPumpWatchdog,
	isRootMailboxPumpRunning,
	setRootMailboxPumpRunning,
	stopRootPump,
	surfaceAgentPending,
} from "./hooks/pump-manager.ts";
import { registerPoolSwapHook } from "./hooks/pool-swap.ts";
import { SWARM_RESOLVE_TOOLS, registerTurnHooks, turnEndIsResolveAction } from "./hooks/turns.ts";
import { registerSessionHooks } from "./hooks/session.ts";
import { registerSettledHook } from "./hooks/settled.ts";
import { registerToolHooks } from "./hooks/tools.ts";
import { registerShutdownInputHooks } from "./hooks/shutdown-input.ts";

// Back-compat re-exports: the pre-split module surface (tests + commands/registration +
// commands/pool import these names from "./hooks.ts").
export {
	_resetSwapChainForTests,
	bumpSwapChain,
	getEngineRetryIncident,
	getRootEditStreak,
	getSwapChainCount,
	resetRootEditStreak,
	ROOT_EDIT_STREAK_WARN_THRESHOLD,
};
export { SWARM_RESOLVE_TOOLS, turnEndIsResolveAction };
export { ROOT_PUMP_INTERVAL_MS, stopRootPump, surfaceAgentPending };

// (Re)start the root mailbox pump for this session: one immediate surface + a self-rescheduling
// setTimeout watchdog (NOT setInterval — see hooks/pump-manager.ts module comment). No-op unless
// this session resolves to the root. Safe to call from session_start or from the
// `/swarm register here root` opt-in path. The captured ctx is session-bound; on stale-ctx errors
// the watchdog stops and the next root session_start restarts it with a fresh ctx.
//
// Multi-root policy (issue 8, strict-reject): a preflight `withLock` runs
// heartbeatRootLeader so a non-leader pane cannot install the pump. On deny we trace
// `root.pump.denied` and return without installing the interval. A second-line defense
// inside pumpRootMailbox re-checks the leader pid on each tick.
export async function startRootPump(ctx: any, reason = "session_start") {
	const pi = getSwarmPi();
	if (!pi) return;
	stopRootPump(); // clear any prior watchdog + ctx
	// Preflight gate (Category A, plan §4.4.1): claim/refresh the leader; on denial, do NOT install
	// the watchdog. The throw is converted to a trace + early-return so a guest pane doesn't crash.
	if (currentAgentId() === "root") {
		const p = paths(ctx.cwd);
		try {
			await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				heartbeatRootLeader(st, Date.now(), process.pid, "pump_install");
				await writeState(p, st);
			});
		} catch (err: any) {
			const msg = String((err as Error)?.message || err);
			if (msg.startsWith("ROOT_LEADER_DENIED")) {
				await trace(p, "root.pump.denied", { reason, error: msg }).catch(() => {});
				return;
			}
			throw err;
		}
	}
	// The auto-pump records a surfacing DECISION (per-pid set + writeState) in every root session,
	// including explicit root opt-in runs (PI_SWARM_IS_ROOT=1 or PI_SWARM_AGENT_ID=root).
	// The decision block is ctx-free file IO (see pumpRootMailbox), so it cannot hit
	// the "This extension ctx is stale after session replacement or reload" error. The delivery loop
	// (sendMessage/isIdle) and the trace that uses ctx.isIdle are now mode-gated to TUI only inside
	// pumpRootMailbox, so non-TUI sessions (print/rpc/json) never make ctx-bound calls.
	// The watchdog tick is TUI-only (print sessions exit immediately after one turn); non-TUI
	// callers read mailboxes via swarm_check_mailbox, which never touches a captured ctx.
	if (currentAgentId() !== "root") return;
	const p = paths(ctx.cwd);
	// The one-shot below is awaited (not fire-and-forget) so that a pi -p / print session — which
	// exits immediately after its single turn — actually completes the surfacing decision (writeState +
	// trace) before teardown. The watchdog remains fire-and-forget.
	const run = async (reason: string) => {
		if (pumpRunInFlight()) return;
		setPumpRunInFlight(true);
		try {
			await pumpRootMailbox(pi, ctx, p, reason);
		} catch (err: any) {
			// === Issue 11: Error classification (binding C2 + C7) ===
			// Classify the error and respond correctly: stale-ctx stops (next session_start re-arms), IO
			// + leader-denied continue without stopping, generic errors stop (safe default).
			const msg = String((err && err.message) || err);
			const code = String((err && err.code) || "");
			const isStaleCtx = /stale after session/i.test(msg);
			const isLeaderDenied = msg.startsWith("ROOT_LEADER_DENIED");
			const isIoTransient = /EACCES|ENOSPC|EROFS|EAGAIN|EBUSY|ENFILE|EMFILE/.test(code) || /EACCES|ENOSPC|EROFS/.test(msg);
			if (isStaleCtx) {
				// SAME ctx caused the throw; re-arming would busy-loop. The ONLY correct recovery is the
				// next session_start (which fires per hooks.ts) with a fresh ctx. Stop and wait.
				stopRootPump();
				await trace(p, "mailbox.root_pump_stale_stopped", { reason, error: msg }).catch(() => {});
			} else if (isLeaderDenied || isIoTransient) {
				// Don't stop the timer: the next watchdog tick retries. Trace for visibility.
				await trace(p, "mailbox.root_pump_transient", {
					reason,
					kind: isLeaderDenied ? "leader_denied" : "io",
					code,
					error: msg,
				}).catch(() => {});
			} else {
				// Unknown error class: stop (preserved safe default).
				stopRootPump();
				await trace(p, "mailbox.root_pump_error", { reason, error: msg, stale: false }).catch(() => {});
			}
		} finally {
			setPumpRunInFlight(false);
		}
	};
	await run(reason);
	if (ctx.mode === "tui") armRootPumpWatchdog(ctx);
}

// Single-flight flag for the one-shot run above (shared with the watchdog tick path in
// hooks/pump-manager.ts so a watchdog tick and an explicit startRootPump never overlap).
function pumpRunInFlight(): boolean {
	return isRootMailboxPumpRunning();
}
function setPumpRunInFlight(v: boolean): void {
	setRootMailboxPumpRunning(v);
}

export function registerSwarmHooks(pi: ExtensionAPI) {
	setSwarmPi(pi);
	// Registration ORDER is load-bearing (Pi Runtime Contract §8 — per-event handlers run in
	// registration order):
	//   - turn_end #1 (pool auto-swap) BEFORE turn_end #2 (goal resolve) — binding C-2: the
	//     resolve must observe the post-swap state.
	//   - session_shutdown registered after tool hooks (no ordering coupling, kept for diff parity).
	registerPoolSwapHook(pi);
	registerTurnHooks(pi);
	registerSessionHooks(pi, startRootPump);
	registerSettledHook(pi);
	registerToolHooks(pi);
	registerShutdownInputHooks(pi);
}
