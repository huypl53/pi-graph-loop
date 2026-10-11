// === swarm/hooks/streaks.ts — root edit streak + swap chain + engine-retry incidents ===
// Extracted verbatim from ../hooks.ts (Phase 7 modular split; canonical logic unchanged).
//
// Three module-local pieces of hook state live here so the hook handlers (hooks/pool-swap.ts,
// hooks/session.ts, hooks/settled.ts, hooks/tools.ts) and the facade can share them without
// import cycles through the facade:
//   - rootEditStreak: consecutive direct root edits (tool_result) — drives the delegation advisory.
//   - swapChain: per-agent consecutive model-pool auto-swap counter (turn_end pool-swap cap).
//   - engineRetryIncidents: per-agent engine-retry bursts (Issue 17/70 — Issue 70: the runtime
//     shape IS the shared EngineRetryIncident type; identity = providerKey + kind + scrubbed
//     message). NEVER persisted — persistence would create a stuck "exhausted" gate across
//     restarts that have lost the engine retry context.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EngineRetryIncident } from "../types.ts";
import { POOL_SWAP_SETTLE_GRACE_MS } from "../constants.ts";

// === Root delegation guard & edit streak tracking ===
export const ROOT_EDIT_STREAK_WARN_THRESHOLD = 3;
let rootEditStreak = 0;
export function getRootEditStreak(): number {
	return rootEditStreak;
}
export function resetRootEditStreak(): void {
	rootEditStreak = 0;
}
/** Used by hooks/tools.ts tool_result and hooks/pool-swap.ts to mutate the streak directly. */
export function setRootEditStreak(v: number): void {
	rootEditStreak = v;
}
export function bumpRootEditStreak(): number {
	return ++rootEditStreak;
}

// Captured pi (registerSwarmHooks) — needed by hooks that surface messages outside an event's
// own `pi` reference. Stored here (not in pump-manager) so settled/input hooks can import it
// without touching pump machinery.
let swarmPi: ExtensionAPI | undefined;
export function setSwarmPi(pi: ExtensionAPI | undefined): void {
	swarmPi = pi;
}
export function getSwarmPi(): ExtensionAPI | undefined {
	return swarmPi;
}

// Swap-chain throttle for the turn_end auto-swap: agentId -> { count of consecutive swaps, last at }.
// Caps the fail->swap->retry->fail cascade so a fully-dead pool cannot burn a turn per slot.
const swapChain = new Map<string, { count: number; at: number }>();
export const MAX_SWAP_CHAIN = 2;
export const SWAP_CHAIN_RESET_MS = 5 * 60_000;

// Exposed for /swarm pool rotate now — manual override is operator-accountable for the same
// chain cap as the auto-swap path. Called by command.ts after a successful manual setModel so
// the next auto-swap on the new slot can still hit the cap if the new slot is also dead.
// Mirrors the reset semantics used inside the auto-swap branch (a quiet gap > SWAP_CHAIN_RESET_MS
// starts a fresh chain). Returns the new count for testability.
export function bumpSwapChain(agentId: string, nowMs = Date.now()): number {
	const chain = swapChain.get(agentId) || { count: 0, at: 0 };
	if (nowMs - chain.at > SWAP_CHAIN_RESET_MS) chain.count = 0;
	chain.count += 1;
	chain.at = nowMs;
	swapChain.set(agentId, chain);
	return chain.count;
}

// Exposed for tests + manual-rotate introspection so a caller can ask "did the manual path honor
// the swap-chain cap?" without poking the module-local Map directly.
export function getSwapChainCount(agentId: string, nowMs = Date.now()): number {
	const chain = swapChain.get(agentId);
	if (!chain) return 0;
	if (nowMs - chain.at > SWAP_CHAIN_RESET_MS) return 0;
	return chain.count;
}

export function isAgentInPoolSwapHandoff(agentId: string, nowMs = Date.now()): boolean {
	const chain = swapChain.get(agentId);
	if (!chain) return false;
	return nowMs - chain.at <= POOL_SWAP_SETTLE_GRACE_MS;
}

// Exposed for tests only — clears the swap-chain entry for a given agent so each fixture can
// start with a clean chain count. NOT used in production (the in-process chain is intentionally
// persistent across root turns within a single session).
export function _resetSwapChainForTests(agentId: string) {
	swapChain.delete(agentId);
}
/** Direct map access for hooks/pool-swap.ts (same module-family, no facade round-trip). */
export function peekSwapChain(agentId: string): { count: number; at: number } | undefined {
	return swapChain.get(agentId);
}

// Per-agent engine-retry incident (Issue 70). Cleared on session_start, session_shutdown,
// agent_settled, and any successful turn_end (the engine recovered on a later retry attempt).
const engineRetryIncidents = new Map<string, EngineRetryIncident>();

// Incident 2026-10-11 (slow-attempt liveness): timestamp of the agent's most recent turn_start.
// pi's engine retry re-enters through agent.continue() → runAgentLoopContinue, which emits a
// fresh agent_start + turn_start BEFORE each retry attempt (verified in pi-agent-core
// agent-loop.js). So a turn_start observed AFTER an error strike proves a NEW attempt on the
// SAME incident started — the incident is live no matter how long that attempt takes. This
// repairs the 14s window for slow errors ("Codex SSE response headers timed out after
// 300000ms": strikes ~302s apart previously aged out into count:1 forever — live session
// 01a12883 needed a MANUAL model change). Stamped by hooks/pool-swap.ts's turn_start handler
// (registered first, so it runs before turns.ts's heavier handler). In-process only.
const lastTurnStartAt = new Map<string, number>();

/** Record that a new attempt (turn) started for this agent. Called from the turn_start hook. */
export function noteTurnStart(agentId: string, nowMs = Date.now()): void {
	lastTurnStartAt.set(agentId, nowMs);
}

/**
 * True when a turn_start was observed strictly AFTER the incident's last error strike — i.e.
 * the engine started another attempt on the same incident. Such an incident is "live" and
 * must keep accumulating even beyond ENGINE_RETRY_WINDOW_MS (a 300s-timeout attempt cannot
 * fit a window calibrated for backoff delays alone).
 */
export function hasAttemptSinceIncident(agentId: string, incidentLastSeenAt: number): boolean {
	const at = lastTurnStartAt.get(agentId);
	return typeof at === "number" && at > incidentLastSeenAt;
}

/** Test-only: clear turn-start stamps so fixtures start with clean liveness state. */
export function _resetTurnStartForTests(): void {
	lastTurnStartAt.clear();
}

// Exposed for tests + the `/swarm pool rotate` manual-override path so a caller can verify the
// engine-retry gate owns its own incident lifecycle (manual override does NOT clear it). Returns
// a plain copy so callers cannot mutate the module-local Map.
export function getEngineRetryIncident(agentId: string) {
	const inc = engineRetryIncidents.get(agentId);
	if (!inc) return undefined;
	return {
		providerKey: inc.providerKey,
		errorMessage: inc.errorMessage,
		firstSeenAt: inc.firstSeenAt,
		lastSeenAt: inc.lastSeenAt,
		count: inc.count,
	};
}
/** Direct map access for hooks/pool-swap.ts / hooks/session.ts / hooks/settled.ts / hooks/tools.ts. */
export function engineRetryIncidentsMap(): Map<string, EngineRetryIncident> {
	return engineRetryIncidents;
}
