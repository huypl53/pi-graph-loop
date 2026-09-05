// === swarm/hooks.ts — event hooks + root mailbox pump (verbatim from index.ts) ===
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join, dirname, relative, sep } from "node:path";
import { existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import type { MessageResponseStatus, Paths } from "./types.ts";
import { SETTLE_NOTIFY_COOLDOWN_MS, SWARM_GUEST_ID, PUMP_SESSION_ID_CAP, NOTIFY_KEY_SETTLE_STALE, ENGINE_MAX_RETRIES, ENGINE_RETRY_WINDOW_MS, formatNotifyKey } from "./constants.ts";
import { currentAgentId, currentModel, currentProvider, isRootSession } from "./session.ts";
import type { ModelSlot } from "./types.ts";
import { classifyProviderError, scrubErrorIdentity, type EngineRetryIncident } from "./types.ts";
import { pickSlot, recordProviderError, recordSlotSuccess, slotKey, validateSwarmSettings } from "./pool.ts";
import { deliverMessageLocked, findIdempotentMessage, readMailbox, responseMissingRecords, unackedRequiresAckRecords, upsertMessageRecord } from "./mailbox.ts";
import { ensureAgentDefaults, inferRoleKind, now } from "./utils.ts";
import { ensureDirs, identityPath, mailboxPath, paths, readState, readTaskState, taskPaths, trace, withLock, writeState, writeTaskState } from "./state.ts";
import { ensureRoot, heartbeatRootLeader, readRootLeader } from "./identity.ts";
import { formatSwarmMessageContent, parseSystemDelivery } from "./delivery.ts";
import { pumpRootMailbox, reconcile, runtimeTaskWarnings } from "./reconcile.ts";
import { ensureNodeActivityStamp, scanAgentOpenAssignments, checkStallNotificationStale } from "./taskgraph.ts";
import { applySwarmToolGating } from "./tools/gating.ts";
import { tmux } from "./tmux.ts";
import { ensurePoolScaffold } from "./pool-scaffold.ts";
import { maybeRotateTraces } from "./tools/audit.ts";
import { DEFAULT_TRACE_ROTATE_BYTES } from "./constants.ts";

// === R16 (2026-09-02): turn-end resolve-action detector (module-scope export) ===
// A turn_end{stop, role=assistant} is a RESOLVE only if the root ADVANCED the goal
// in that turn — i.e., the message contains a swarm tool call (swarm_spawn_agent /
// swarm_assign_task / swarm_mark_goal_done / swarm_set_goal / swarm_restart_agent /
// swarm_send_message / swarm_reconcile / swarm_update_task / swarm_create_task /
// swarm_stop_agent / swarm_release_agent_task) OR an explicit user-direction message
// was sent via a tool call in the same turn. Pure ack text does NOT count.
// Exported for direct unit testing by r16-idle-goal-regression.test.mjs.
export const SWARM_RESOLVE_TOOLS: ReadonlySet<string> = new Set([
	"swarm_spawn_agent",
	"swarm_assign_task",
	"swarm_mark_goal_done",
	"swarm_set_goal",
	"swarm_restart_agent",
	"swarm_send_message",
	"swarm_reconcile",
	"swarm_update_task",
	"swarm_create_task",
	"swarm_stop_agent",
	"swarm_release_agent_task",
]);
export function turnEndIsResolveAction(event: any): { resolve: boolean; reason: string; toolNames?: string[] } {
	const msg: any = event?.message;
	const toolResults: any[] = Array.isArray(event?.toolResults) ? event.toolResults : [];
	// Path A: content blocks expose tool_use calls.
	const blocks: any[] = Array.isArray(msg?.content) ? msg.content : [];
	const toolNamesFromContent: string[] = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const t = block.type;
		if (t === "tool_use" || t === "toolCall") {
			const name = block.name || block.toolName;
			if (typeof name === "string" && SWARM_RESOLVE_TOOLS.has(name)) toolNamesFromContent.push(name);
		}
	}
	// Path B: toolResults carry the toolName too.
	const toolNamesFromResults: string[] = [];
	for (const tr of toolResults) {
		const name = tr?.toolName || tr?.name;
		if (typeof name === "string" && SWARM_RESOLVE_TOOLS.has(name)) toolNamesFromResults.push(name);
	}
	const swarmToolNames = Array.from(new Set([...toolNamesFromContent, ...toolNamesFromResults]));
	if (swarmToolNames.length > 0) return { resolve: true, reason: "swarm_tool_call", toolNames: swarmToolNames };
	// No tool calls: NOT a resolve (pure ack text or silent turn).
	return { resolve: false, reason: "no_resolve_action" };
}

// Root mailbox pump state. Module-level so the PM pump can be (re)started from outside the
// session_start hook — notably by `/swarm register here root`, which opts a running session in
// as the root after startup. `swarmPi` is captured once in registerSwarmHooks (always called
// first by index.ts) and reused so there is a single pump per extension load.
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
let swarmPi: ExtensionAPI | undefined;
let rootMailboxTimer: NodeJS.Timeout | undefined;
let rootMailboxPumpRunning = false;
let rootPumpCtx: any = undefined;
let rootPumpCtxFresh: boolean = false;
let traceRotationInFlight = false;

// Pump tick interval (kept identical to the previous `setInterval` cadence so dashboards/expectations
// don't shift). Exposed as a constant so tests can shorten the wait for the watchdog test.
const ROOT_PUMP_INTERVAL_MS = 5_000;

// Swap-chain throttle for the turn_end auto-swap: agentId -> { count of consecutive swaps, last at }.
// Caps the fail->swap->retry->fail cascade so a fully-dead pool cannot burn a turn per slot.
const swapChain = new Map<string, { count: number; at: number }>();
const MAX_SWAP_CHAIN = 2;
const SWAP_CHAIN_RESET_MS = 5 * 60_000;

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

// Exposed for tests only — clears the swap-chain entry for a given agent so each fixture can
// start with a clean chain count. NOT used in production (the in-process chain is intentionally
// persistent across root turns within a single session).
export function _resetSwapChainForTests(agentId: string) {
	swapChain.delete(agentId);
}

// === Issue 17 (model-pool-respect-pi-retries): engine-retry gate ===
// The pi engine retries a failed provider request up to `retry.maxRetries` (default 3) times with
// exponential backoff (2s, 4s, 8s — see @earendil-works/pi-coding-agent/docs/settings.md). The
// engine does NOT forward `auto_retry_*` events to extensions (allowlist-gated in
// agent-session.js:_emitExtensionEvent), so we observe retries indirectly: each retry attempt
// re-enters via `agent.continue()` and emits a fresh `turn_end { stopReason: "error" }` with the
// same providerKey + errorMessage. We count consecutive same-error turn_ends; when the count
// reaches ENGINE_MAX_RETRIES (or the burst ages past ENGINE_RETRY_WINDOW_MS after the last error),
// we conclude the engine has exhausted retries and let the swap path fire.
//
// Issue 19: ENGINE_MAX_RETRIES + ENGINE_RETRY_WINDOW_MS moved to constants.ts so they share a
// single source of truth with the rest of the gate/pool constants. The values are unchanged.

// Per-agent engine-retry incident (Issue 70: the runtime shape IS the shared
// EngineRetryIncident type from types.ts — identity = providerKey + kind + scrubbed message).
// Cleared on session_start, session_shutdown, agent_settled, and any successful turn_end (the
// engine recovered on a later retry attempt). NEVER persisted — persistence would create a stuck
// "exhausted" gate across restarts that have lost the engine retry context.
const engineRetryIncidents = new Map<string, EngineRetryIncident>();

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
function armRootPumpWatchdog(ctx: any) {
	if (rootMailboxTimer) clearTimeout(rootMailboxTimer);
	rootPumpCtx = ctx;
	rootPumpCtxFresh = true;
	const tick = async () => {
		// Clear the handle that fired this tick — we are about to schedule the next one.
		rootMailboxTimer = undefined;
		if (!rootPumpCtxFresh) return; // stop() or stale-ctx already disabled us
		if (currentAgentId() !== "root") { rootPumpCtxFresh = false; return; }
		const myCtx = rootPumpCtx;
		if (!myCtx) { rootPumpCtxFresh = false; return; }
		if (rootMailboxPumpRunning) {
			// Re-arm even if a tick is already running (do not stall the chain).
			rootMailboxTimer = setTimeout(tick, ROOT_PUMP_INTERVAL_MS);
			return;
		}
		rootMailboxPumpRunning = true;
		try {
			await pumpRootMailbox(swarmPi!, myCtx, paths((myCtx as any).cwd), "watchdog");
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
			const isIoTransient = /EACCES|ENOSPC|EROFS|EAGAIN|EBUSY|ENFILE|EMFILE/.test(code) ||
							  /EACCES|ENOSPC|EROFS/.test(msg);
			if (isStaleCtx) {
				stopRootPump();
				trace(myCtx.cwd ? paths(myCtx.cwd) : null, "mailbox.root_pump_stale_stopped", { reason: "watchdog", error: msg }).catch(() => {});
			} else if (isLeaderDenied || isIoTransient) {
				trace(myCtx.cwd ? paths(myCtx.cwd) : null, "mailbox.root_pump_transient", { reason: "watchdog", kind: isLeaderDenied ? "leader_denied" : "io", code, error: msg }).catch(() => {});
				// keep the chain alive — schedule the next tick
			} else {
				stopRootPump();
				trace(myCtx.cwd ? paths(myCtx.cwd) : null, "mailbox.root_pump_error", { reason: "watchdog", error: msg, stale: false }).catch(() => {});
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
			void maybeRotateTraces(p, {}).catch((err: any) => trace(p, "trace.retention.rotate_error", { reason, error: String((err as Error)?.message || err) }).catch(() => {})).finally(() => { traceRotationInFlight = false; });
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
		pi.sendMessage({
			customType: "swarm-message",
			content: formatSwarmMessageContent(m),
			display: true,
			details: m,
		}, i === 0 && idleAtStart ? { triggerTurn: true } : { deliverAs: "followUp" });
		delivered++;
	}
	await trace(p, "mailbox.agent_surface", { agentId, reason, count: delivered, ids: result.ids, idleAtStart });
	return { surfaced: delivered, ids: result.ids };
}

// (Re)start the root mailbox pump for this session: one immediate surface + a self-rescheduling
// setTimeout watchdog (NOT setInterval — see module-level comment). No-op unless this session resolves
// to the root. Safe to call from session_start or from the `/swarm register here root`
// opt-in path. The captured ctx is session-bound; on stale-ctx errors the watchdog stops and the next
// root session_start restarts it with a fresh ctx.
//
// Multi-root policy (issue 8, strict-reject): a preflight `withLock` runs
// heartbeatRootLeader so a non-leader pane cannot install the pump. On deny we trace
// `root.pump.denied` and return without installing the interval. A second-line defense
// inside pumpRootMailbox re-checks the leader pid on each tick.
export async function startRootPump(ctx: any, reason = "session_start") {
	const pi = swarmPi;
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
		if (rootMailboxPumpRunning) return;
		rootMailboxPumpRunning = true;
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
			const isIoTransient = /EACCES|ENOSPC|EROFS|EAGAIN|EBUSY|ENFILE|EMFILE/.test(code) ||
							  /EACCES|ENOSPC|EROFS/.test(msg);
			if (isStaleCtx) {
				// SAME ctx caused the throw; re-arming would busy-loop. The ONLY correct recovery is the
				// next session_start (which fires per hooks.ts) with a fresh ctx. Stop and wait.
				stopRootPump();
				await trace(p, "mailbox.root_pump_stale_stopped", { reason, error: msg }).catch(() => {});
			} else if (isLeaderDenied || isIoTransient) {
				// Don't stop the timer: the next watchdog tick retries. Trace for visibility.
				await trace(p, "mailbox.root_pump_transient", { reason, kind: isLeaderDenied ? "leader_denied" : "io", code, error: msg }).catch(() => {});
			} else {
				// Unknown error class: stop (preserved safe default).
				stopRootPump();
				await trace(p, "mailbox.root_pump_error", { reason, error: msg, stale: false }).catch(() => {});
			}
		} finally { rootMailboxPumpRunning = false; }
	};
	await run(reason);
	if (ctx.mode === "tui") armRootPumpWatchdog(ctx);
}

export function registerSwarmHooks(pi: ExtensionAPI) {
	swarmPi = pi;

	// === In-process model-pool auto-swap (Option 1: the agent fixes itself, no respawn) ===
	// pi does NOT exit on provider errors — the turn fails with stopReason "error" and the
	// process keeps running. So the RIGHT detection point is here, inside the agent's own pi
	// process, not a tmux pane watcher. On a provider/quota error turn:
	//   1. classify the error (quota/auth/rate_limit/transient) from errorMessage;
	//   2. record it against the CURRENT slot in the shared pool health (quota/auth bench the
	//      slot immediately — retrying will not fix an exhausted quota or a bad key);
	//   3. pick a different healthy slot and pi.setModel() to it IN-PROCESS — the conversation,
	//      context, mailbox and identity are all preserved. The next turn simply runs on the
	//      new model. A system note is appended so the agent (and the transcript) know why.
	pi.on("turn_end", async (event, ctx) => {
		const msg: any = (event as any)?.message;
		if (!msg || msg.role !== "assistant") return;
		const agentId = currentAgentId();
		if (agentId === SWARM_GUEST_ID) return; // plain coding session: nothing to rotate
		const p = paths(ctx.cwd);
		// Healthy turn: reset this slot's failure streak. Without this, a slot that transient-failed
		// once and then served hundreds of OK turns would still bench on its NEXT transient (streak
		// never decays). Only "stop" counts — toolUse turns continue within the same agent loop and
		// would over-credit; aborted/error are handled below.
		if (msg.stopReason === "stop") {
			const okSlot: ModelSlot = { model: String(msg.model || ctx.model?.id || ""), provider: String(msg.provider || ctx.model?.provider || "") || undefined };
			if (okSlot.model) await recordSlotSuccess(p, okSlot).catch(() => {});
			// Issue 17: a successful turn after a burst of engine retries means the engine RECOVERED.
			// Clear any open incident for this agent so the next failure starts a fresh observation.
			// Without this, a stale incident would survive and the next error turn_end would miscount
			// against the previous burst.
			if (engineRetryIncidents.has(agentId)) {
				const incident = engineRetryIncidents.get(agentId);
				engineRetryIncidents.delete(agentId);
				await trace(p, "pool.engine_retry_recovered", { agentId, providerKey: incident?.providerKey, count: incident?.count ?? 0 }).catch(() => {});
			}
			return;
		}
		if (msg.stopReason !== "error") return;
		const errorText = String(msg.errorMessage || "");
		const kind = classifyProviderError(errorText);
		// Non-provider-looking errors (e.g. context overflow, tool bugs) are traced but do NOT
		// pollute the slot's failure streak and never trigger a swap.
		if (kind === "unknown") {
			await trace(p, "pool.turn_error_unclassified", { agentId, error: errorText.slice(0, 200) }).catch(() => {});
			return;
		}
		// Swap-chain cap: one failing prompt can cascade (fail -> swap -> retry -> fail -> swap ...),
		// burning a turn per dead slot and firing triggerTurn notes. Cap consecutive swaps per agent;
		// beyond the cap the turn is left to fail naturally (the agent/user can act).
		const nowMs = Date.now();
		const chain = swapChain.get(agentId) || { count: 0, at: 0 };
		// A quiet gap (no swap for 5 minutes) starts a fresh chain.
		if (nowMs - chain.at > SWAP_CHAIN_RESET_MS) chain.count = 0;
		if (chain.count >= MAX_SWAP_CHAIN) {
			await trace(p, "pool.swap_chain_capped", { agentId, count: chain.count, kind, error: errorText.slice(0, 120) }).catch(() => {});
			return;
		}
		const currentSlot: ModelSlot = { model: String(msg.model || ctx.model?.id || ""), provider: String(msg.provider || ctx.model?.provider || "") || undefined };
		if (!currentSlot.model) return;
		// === Issue 17: engine-retry gate ===
		// The pi engine retries a failed provider request up to ENGINE_MAX_RETRIES times with
		// exponential backoff before giving up. Each retry emits a fresh turn_end {error} with the
		// SAME providerKey + errorMessage. We count consecutive same-error turn_ends within
		// ENGINE_RETRY_WINDOW_MS; only when the count reaches ENGINE_MAX_RETRIES do we conclude the
		// engine has exhausted retries on this slot and allow the swap path to fire. Below the
		// threshold, we trace the gated event and return — no swap, no bench, no streak bump.
		// A different providerKey OR a gap > ENGINE_RETRY_WINDOW_MS starts a FRESH incident (the old
		// one aged out via the window check, not via a timer that could miss).
		// Issue 70: the incident identity is the STABLE classification (providerKey + kind +
		// digit-scrubbed message), NOT raw error-text equality. Provider 429 usage_limit_reached
		// bodies embed a per-second-mutating resets_in_seconds; raw equality started a fresh
		// incident at count:1 every turn so the threshold was never reached and quota-exhausted
		// slots were never benched/rotated (live: 39x gated count:1, 0x exhausted). Scrubbed
		// identity + kind keeps distinct transient messages distinct while collapsing mutating
		// quota bodies into one incident.
		const providerKey = slotKey(currentSlot);
		const scrubErr = scrubErrorIdentity(errorText);
		const prevIncident = engineRetryIncidents.get(agentId);
		let engineExhausted = false;
		let incidentCount = 1;
		if (prevIncident
			&& prevIncident.providerKey === providerKey
			&& prevIncident.kind === kind
			&& prevIncident.errorMessage === scrubErr
			&& (nowMs - prevIncident.lastSeenAt) <= ENGINE_RETRY_WINDOW_MS) {
			prevIncident.count++;
			prevIncident.lastSeenAt = nowMs;
			incidentCount = prevIncident.count;
			if (prevIncident.count >= ENGINE_MAX_RETRIES) engineExhausted = true;
		} else {
			engineRetryIncidents.set(agentId, {
				providerKey,
				kind,
				errorMessage: scrubErr,
				firstSeenAt: nowMs,
				lastSeenAt: nowMs,
				count: 1,
			});
		}
		if (!engineExhausted) {
			// Transient within the engine's retry budget — DO NOT swap, DO NOT bench, DO NOT pollute
			// the streak. Trace for visibility and return. The engine may still recover on a later
			// retry; if it does, the successful turn_end clears the incident (see `stop` branch).
			await trace(p, "pool.swap_gated_by_engine_retry", {
				agentId,
				providerKey,
				kind,
				count: incidentCount,
				windowMs: ENGINE_RETRY_WINDOW_MS,
				threshold: ENGINE_MAX_RETRIES,
				error: errorText.slice(0, 120),
			}).catch(() => {});
			return;
		}
		// Engine exhausted: this is the terminal strike. Clear the incident so the next failure
		// (on the new slot, after the swap) starts a fresh observation. Trace the exhaustion so
		// dashboards can distinguish "engine retried and recovered" from "engine gave up".
		engineRetryIncidents.delete(agentId);
		await trace(p, "pool.engine_retry_exhausted", { agentId, providerKey, kind, count: incidentCount }).catch(() => {});
		await recordProviderError(p, currentSlot, kind, errorText).catch(() => {});
		// Issue 22 roles-filter: read the agent's roleKind from state under lock so a mid-life
		// setAgentRole change is observed on the next swap (no caching layer).
		const roleKind = await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			return st.agents[agentId]?.roleKind;
		}).catch(() => undefined);
		const picked = await pickSlot(p, {
			stickyKey: agentId,
			avoidKey: slotKey(currentSlot),
			roleKind,
		}).catch(() => undefined);
		if (!picked) {
			await trace(p, "pool.swap_no_candidate", { agentId, from: slotKey(currentSlot), kind }).catch(() => {});
			return;
		}
		// Resolve the picked slot to a registered Model object and switch in-process. Require the
		// slot's provider explicitly — find(model-without-provider) can match an unrelated provider
		// sharing the same model id (gpt-5.4-mini exists on several providers), landing on one with
		// no API key and a swap_failed every error turn. A pool slot without a resolvable provider is
		// a config error; trace it clearly instead of guessing.
		const target = picked.slot.provider
			? ctx.modelRegistry?.find?.(picked.slot.provider, picked.slot.model)
			: undefined;
		if (!target) {
			await trace(p, "pool.swap_model_not_found", { agentId, slot: slotKey(picked.slot), reason: picked.reason, hint: picked.slot.provider ? "model not registered under the slot's provider" : "pool slot has no explicit provider; add one in settings.json modelPool" }).catch(() => {});
			return;
		}
		const okSwap = await pi.setModel(target).catch(() => false);
		if (okSwap) { bumpSwapChain(agentId, nowMs); }
		// Issue 22: record role-filter context on every auto-swap so dashboards can tell whether
		// the swap honored the agent's roleKind constraint or fell back.
		const swapTrace = { agentId, from: slotKey(currentSlot), to: slotKey(picked.slot), kind, reason: picked.reason, target: `${target.provider}/${target.id}`, roleKind: roleKind ?? null, rolesFilterMatched: picked.slot.roles === undefined || picked.slot.roles.length === 0 || (typeof roleKind === "string" && picked.slot.roles.includes(roleKind)) };
		await trace(p, okSwap ? "pool.swap" : "pool.swap_failed", swapTrace).catch(() => {});
		if (okSwap) {
			// Tell the agent (and the transcript) what happened so it can retry the failed work
		// knowing it now runs on a different model.
			pi.sendMessage({
				customType: "swarm-message",
				content: `[PI-SWARM MODEL POOL] The previous turn failed with a ${kind} error from ${slotKey(currentSlot)} (${errorText.slice(0, 160)}). That slot was benched and this session was switched to ${slotKey(picked.slot)} in-place. Continue your current task — your context and mailbox are intact.`,
				display: true,
			}, ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "followUp" });
		}
	});

	// === Root-busy resets the shared idle epoch (Row 68 semantics fix, 2026-08-31) ===
	// The idle-streak nudge measures "all agents + ROOT idle for a full interval". Workers
	// are covered by updateIdleEpochLocked (runtimeStatus busy/idle edges), but the ROOT's
	// own activity was invisible to it: while the PM was busy answering the human (turns running),
	// the epoch stayed anchored at the old all-idle edge, so a 30s interval elapsed "during" the
	// PM's work and the nudge fired ~30s after every turn end (live: nudge 1/3 following each reply
	// even though the PM had been busy the whole time). turn_start = busy edge for the root:
	// drop the epoch (and pending boundary); turn_end (below) re-arms it via the next pump tick's
	// fresh allIdleSinceAt, so the interval is measured from the END of the root's work.
	pi.on("turn_start", async (_event, ctx) => {
		if (currentAgentId() !== "root") return;
		const p = paths(ctx.cwd);
		try {
			await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const idleState = st.idleNudgeState;
				if (!idleState?.allIdleSinceAt && !idleState?.nextGoalNudgeAt && !idleState?.lastGoalNudgeAt) return;
				const prev = idleState.allIdleSinceAt ?? null;
				// === R23C (2026-09-03) — stamp root provenance at the turn_start clear site ===
				// turn_start is the root's busy edge (the live R23 storm source — `agent_settled`
				// fires at every root turn boundary, briefly marking the root busy/idle).
				// The cap branch's worker-breaker guard reads `lastEpochBusyAgents` to distinguish a
				// worker-driven fresh epoch (qualifies for reset) from root-turn churn (must
				// NOT qualify). Without this stamp, every turn_start-cleared anchor reaches the cap
				// branch with breaker=undefined → absent→reset legacy default → STORM. Stamping
				// `["root"]` here lets the breaker reject root-churn anchors. Live
				// evidence: tester-turnstart-probe.mjs (R23C artifacts; pre-fix RED 2 resets/4 emissions
				// seq 4→7, post-fix GREEN ≤1 emission).
				idleState.lastEpochBusyAgents = ["root"];
				delete idleState.allIdleSinceAt;
				delete idleState.nextGoalNudgeAt;
				await trace(p, "idle.epoch.reset", { reason: "root_busy", previousAllIdleSinceAt: prev, busyAgents: ["root"] }).catch(() => {});
				await writeState(p, st);
			});
		} catch (err: any) {
			await trace(p, "idle.epoch.reset_error", { error: String((err as Error)?.message || err) }).catch(() => {});
		}
	});

	// === Issue 18 + R16: Goal idle-streak resolve detection ===
	// Registered AFTER the model-pool swap branch above so pi's per-event handler loop runs the
	// resolve AFTER any in-process swap (binding C-2 of the plan review). Both handlers acquire the
	// same withLock independently, so they serialise; source order ensures the resolve observes the
	// post-swap state.
	//
	// R16 fix: a turn_end{stop, role=assistant} is a RESOLVE only if the root actually
	// ADVANCED the goal in that turn — i.e., the message contains a swarm tool call
	// (swarm_spawn_agent / swarm_assign_task / swarm_mark_goal_done / swarm_set_goal /
	// swarm_restart_agent / swarm_send_message / swarm_reconcile / swarm_update_task /
	// swarm_create_task / swarm_stop_agent / swarm_release_agent_task) OR an explicit user-
	// direction message was sent via a tool call in the same turn.
	//
	// Pure ack text ("Got it, will continue", "Acknowledged", "Will keep going") does NOT count:
	// it would let an idle root reset the counter forever on the same template, never
	// reaching MAX_CONSECUTIVE_NUDGES_DEFAULT, never engaging back-off, never surfacing the
	// bounded escalation chain. Live incident 2026-09-02: 47 idle_nudge / 36 resolved in 10 min
	// for goal-1788266039522-6eae40.
	//
	// A turn_end {error} is intentionally NOT a resolve: tool/model failures are not "I addressed
	// the goal". A non-root turn_end is also NOT a resolve: workers don't decide the goal.
	// An empty-message turn_end (silent) is NOT a resolve either — unchanged from pre-fix.
	//
	// The action detector is exported at module scope (SWARM_RESOLVE_TOOLS + turnEndIsResolveAction)
	// so r16-idle-goal-regression.test.mjs can drive the PRODUCTION detector end-to-end. The
	// turn_end handler below calls `turnEndIsResolveAction(event)` to gate the counter reset.
	pi.on("turn_end", async (event, ctx) => {
		const msg: any = (event as any)?.message;
		if (!msg || msg.role !== "assistant" || msg.stopReason !== "stop") return;
		if (currentAgentId() !== "root") return;
		const action = turnEndIsResolveAction(event);
		const p = paths(ctx.cwd);
		try {
			await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const goal = st.goal;
				if (!goal) return;
				const nudges = goal.consecutiveNoResolveNudges;
				const hadBackoff = Boolean(goal.backoffTicksRemaining && goal.backoffTicksRemaining > 0);
				if (nudges === 0 && !hadBackoff) return; // nothing to resolve
				// R16: pure ack text does NOT count as a resolve. Track when a turn was a
				// non-resolve so the trace distinguishes ack vs resolve clearly for ops/dashboards.
				if (!action.resolve) {
					goal.lastNonResolveTurnAt = new Date().toISOString();
					await trace(p, "goal.nudge.turn_no_resolve_action", {
						goalId: goal.id,
						nudges,
						hadBackoff,
						detectionReason: action.reason,
					}).catch(() => {});
					await writeState(p, st);
					return;
				}
				goal.consecutiveNoResolveNudges = 0;
				delete goal.backoffTicksRemaining;
				goal.lastResolvedAt = new Date().toISOString();
				goal.lastResolveActionAt = new Date().toISOString();
				goal.lastResolveActionTools = action.toolNames;
				await trace(p, "goal.nudge.resolved", {
					goalId: goal.id,
					nudges,
					hadBackoff,
					by: "turn_end",
					actionReason: action.reason,
					actionTools: action.toolNames,
				});
				await writeState(p, st);
			});
		} catch (err: any) {
			await trace(p, "goal.nudge.resolve_error", { error: String((err as Error)?.message || err) }).catch(() => {});
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		// Issue 16 (C2 + B1 fix): stamp the session's start time as a process-wide env var so
		// RecentSpawn stamps + isSameRootLeader comparisons can detect pid recycling under a
		// different session. Guarded so a second session_start in the same process (e.g. after
		// /reload) doesn't churn the value mid-flight. Lives at the top of registerSwarmHooks's
		// session_start handler (NOT index.ts, which has no pi.on(...) and would create
		// non-deterministic ordering with this handler).
		if (!process.env.PI_SWARM_SESSION_STARTED_AT) {
			process.env.PI_SWARM_SESSION_STARTED_AT = new Date().toISOString();
		}
		// Issue 17 (binding C1 — symmetry): clear the per-agent engine-retry incident on session_start.
		// A stale incident from a prior session cannot survive a fresh session (the engine retry context
		// is lost across restarts); clearing here prevents a stuck "exhausted" gate from leaking forward.
		// The Map is keyed by agentId so we only delete the entry for THIS session's agent (other agents'
		// incidents are process-shared state and survive; their sessions are independent processes).
		const agentIdEarly = currentAgentId();
		if (agentIdEarly !== SWARM_GUEST_ID) engineRetryIncidents.delete(agentIdEarly);
		const p = paths(ctx.cwd);
		await ensureDirs(p);
		const agentId = agentIdEarly;
		const guest = agentId === SWARM_GUEST_ID;
		// Identity-gated tool visibility: a guest session loses the swarm tool surface (it is a plain coding
		// session, not a swarm participant); registered agents and the root keep it. The /swarm slash
		// command is unaffected, so a guest can still opt in via `/swarm register here <role>`. Re-applied on
		// opt-in (command.ts) so an in-session identity change re-enables the swarm tools immediately.
		applySwarmToolGating(pi);
		// === Issue 20: pool-scaffold on root session_start ===
		// Runs ONLY for the root identity (PM). The durable `poolScaffoldNotifiedAt` flag on
		// SwarmState makes the notify write-once-per-swarm: subsequent session_starts (and /reload
		// invocations) suppress the notify but the scaffold itself remains idempotent (writes the same
		// payload if `modelPool` is still absent, no-ops if present). Errors are swallowed + traced so a
		// scaffold failure never blocks session_start.
		if (agentId === "root") {
			try {
				const result = await ensurePoolScaffold(ctx.cwd, {});
				if (result.wrote) {
					await withLock(p, async () => {
						const locked = await readState(p, ctx.cwd);
						if (!locked.poolScaffoldNotifiedAt) {
							locked.poolScaffoldNotifiedAt = now();
							await writeState(p, locked);
						}
					});
					// Notify ONLY when the durable flag was absent BEFORE this call. We re-read state here
					// (outside the lock is safe — the lock above already stamped the flag, and the user-facing
					// notify is one-shot idempotent by construction). If `ctx.hasUI` is false (print/json
					// sessions) the notify is skipped but the file write + flag stamp still happen, so a later
					// TUI session_start correctly sees the flag set and stays quiet.
					if (ctx.hasUI && result.notify) {
						try { ctx.ui.notify(result.notify, "info"); } catch { /* notify is best-effort */ }
					}
				}
			} catch (err: any) {
				await trace(p, "pool.scaffold_error", { error: String((err as Error)?.message || err) }).catch(() => {});
			}
		// === Follow-up F3 (2026-09-05): launch-time pool health warning ===
		// The PM launches a session whose spawn pool may be entirely dead (unresolvable models /
		// missing credentials). Surfacing that NOW beats discovering it at the first spawn failure.
		// Uses the live registry probe when available; without one, only structural checks run.
		// Degrades silently (never blocks session_start); traced as pool.launch_health.
		try {
			const validation = validateSwarmSettings(ctx.cwd, { registryProbe: ctx.modelRegistry as any });
			if (!validation.ok) {
				const lines = [`Swarm pool config has ${validation.errors.length} issue(s) — /swarm pool validate for details:`];
				for (const e of validation.errors.slice(0, 3)) lines.push(`  \u2717 ${e.field || "config"}: ${e.message}`);
				if (validation.errors.length > 3) lines.push(`  … and ${validation.errors.length - 3} more`);
				if (ctx.hasUI) { try { ctx.ui.notify(lines.join("\n"), "warning"); } catch { /* best-effort */ } }
				await trace(p, "pool.launch_health", { ok: false, errors: validation.errors.length, warnings: validation.warnings.length }).catch(() => {});
			} else if (validation.warnings.length && ctx.hasUI) {
				// Advisory-only: surface the first warning (e.g. both_sources_present / swarm_yml_empty)
				// once at launch so the operator knows which file is actually in effect.
				const w = validation.warnings[0];
				try { ctx.ui.notify(`Swarm pool: ${w.message}`, "warning"); } catch { /* best-effort */ }
				await trace(p, "pool.launch_health", { ok: true, errors: 0, warnings: validation.warnings.length }).catch(() => {});
			}
		} catch { /* launch-health check must never break session_start */ }
		}
		const ts = now();
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			await trace(p, "session.start", { agentId, guest, mode: ctx.mode, state: relative(ctx.cwd, p.state) });
			if (guest) {
				// Anonymous swarm session (no PI_SWARM_AGENT_ID and no explicit root opt-in): stay
				// inert. Do NOT register an agent record, do NOT call ensureRoot (which would refresh
				// the root pseudo-agent heartbeat and mask a dead/stalled PM), and do NOT start the
				// root mailbox pump (which would surface root mail here). The swarm tool surface
				// is gated off (see applySwarmToolGating above) — this session cannot act as or consume the
				// root. It can still opt in via `/swarm register here <role>` (the slash command is
				// unaffected by tool gating), which re-applies gating to re-enable the swarm tools. See
				// isRootSession() for the explicit opt-in path.
				return;
			}
			if (agentId === "root") {
				ensureRoot(st, ctx.cwd, p);
				// Multi-root policy (issue 8): the heartbeat is now driven by the gate, not by
				// ensureRoot. Layer the heartbeatRootLeader call here so an root
				// session_start both materialises the record and refreshes the leader lease.
				try {
					heartbeatRootLeader(st, Date.now(), process.pid, "session_start");
				} catch (err: any) {
					// A non-leader root session_start must NOT crash the session; trace + skip the
					// pump install (handled at startRootPump preflight below).
					await trace(p, "session.root_denied", { agentId, callerPid: process.pid, error: String((err as Error)?.message || err) }).catch(() => {});
				}
				await writeState(p, st);
			} else if (!st.agents[agentId]) {
				st.agents[agentId] = {
					id: agentId, role: "Externally started swarm agent", status: "running",
					roleKind: inferRoleKind(agentId, "Externally started swarm agent"), capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1,
					runtimeStatus: "starting", health: "healthy",
					lastSessionStartAt: ts, lastAgentStartAt: ts, pid: process.pid,
					tmuxSession: st.tmuxSession, tmuxWindow: agentId, tmuxTarget: "unknown",
					model: currentModel(), provider: currentProvider(), cwd: ctx.cwd,
					mailbox: relative(ctx.cwd, mailboxPath(p, agentId)), createdAt: ts, updatedAt: ts,
				};
				await writeState(p, st);
			} else if (st.agents[agentId]) {
				st.agents[agentId].lastSessionStartAt = ts;
				st.agents[agentId].lastHeartbeatAt = ts;
				st.agents[agentId].status = "running";
				st.agents[agentId].runtimeStatus = responseMissingRecords(st, agentId).length ? "response_missing" : "idle";
				st.agents[agentId].health = "healthy";
				st.agents[agentId].pid = process.pid;
				st.agents[agentId].updatedAt = ts;
				await writeState(p, st);
				await trace(p, "agent.status", { agentId, runtimeStatus: st.agents[agentId].runtimeStatus, health: st.agents[agentId].health });
			}
		});
		if (ctx.hasUI) ctx.ui.setStatus("swarm", `swarm:${agentId}`);
		if (agentId === "root") {
			await startRootPump(ctx);
		} else if (ctx.mode === "tui") {
			// Pull-based delivery for workers (root fix for the restart/injection-loss class): on session
			// start, surface any unacked, non-dead-letter, non-superseded messages addressed to THIS agent
			// directly into its conversation — no tmux injection, no reconcile, no root involvement.
			// Mailbox is the source of truth; tmux injection stays as an opportunistic fast-path.
			try {
				await surfaceAgentPending(pi, ctx, p, agentId, "session_start");
			// Re-check on settle: a message may have arrived (or a failed injection skipped) while the
			// agent was busy; settling idle is the natural moment to catch up.
			// (hook registered below; the surface here covers the startup gap)
			} catch (err: any) { await trace(p, "agent.surface_error", { agentId, phase: "session_start", error: String((err as Error)?.message || err) }).catch(() => {}); }
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const agentId = currentAgentId();
		if (agentId === "root") return;
		const p = paths(ctx.cwd);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[agentId];
			if (agent) {
				agent.pid = process.pid;
				agent.updatedAt = now();
				await writeState(p, st);
			}
		});
		const st = await readState(p, ctx.cwd);
		const agent = st.agents[agentId];
		if (!agent) return;
		const identityRel = relative(ctx.cwd, identityPath(p, agentId));
		return {
			systemPrompt: `${event.systemPrompt}\n\nPi Swarm identity: you are agent \`${agentId}\` (${agent.role}). Your durable role card is \`${identityRel}\`. Follow it as your agent-specific AGENT.md. Use swarm tools for peer coordination.`,
		};
	});


	pi.on("agent_start", async (_event, ctx) => {
		const agentId = currentAgentId();
		if (agentId === "root") return;
		const p = paths(ctx.cwd);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[agentId];
			if (!agent) return;
			if (agent.pid && agent.pid !== process.pid) return; // pid-guard
			const ts = now();
			const resurrect = agent.status === "stopped" || agent.health === "unhealthy";
			agent.lastAgentStartAt = ts;
			agent.runtimeStatus = "busy";
			agent.health = "healthy";
			agent.status = "running";
			agent.lastHeartbeatAt = ts;
			agent.pid = process.pid;
			agent.updatedAt = ts;
			await writeState(p, st);
			await trace(p, "agent.status", { agentId, runtimeStatus: agent.runtimeStatus, health: agent.health, resurrect });
		});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const agentId = currentAgentId();
		// Issue 17: clear any open engine-retry incident on settle. A settled agent is not in a retry
		// window (the engine either resolved the last turn or gave up before settling). Stale incidents
		// from a burst that ended mid-settle must not leak forward into the next failure.
		engineRetryIncidents.delete(agentId);
		if (agentId === "root") {
			const p = paths(ctx.cwd);
			await pumpRootMailbox(pi, ctx, p, "agent_settled");
			// === Issue 11 (rework) watchdog self-heal ===
			// If the watchdog tick has been lost (timer GC'd, single-tick throw that called stop, etc.),
			// re-install it from this hook so the chain stays alive without requiring session_start.
			// Guard: only re-arm when ctx.mode is TUI (print/rpc/json sessions don't need the watchdog).
			if (ctx.mode === "tui" && !rootMailboxTimer && rootPumpCtxFresh) {
				armRootPumpWatchdog(ctx);
			}
			return;
		}
		// Catch-up surface for workers: anything unacked that arrived (or failed injection) while busy.
		try { await surfaceAgentPending(pi, ctx, paths(ctx.cwd), agentId, "agent_settled"); } catch {}
		const p = paths(ctx.cwd);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[agentId];
			if (!agent) return;
			if (agent.pid && agent.pid !== process.pid) return; // pid-guard
			const ts = now();
			agent.lastAgentSettledAt = ts;
			agent.health = "healthy";
			agent.lastHeartbeatAt = ts;
			agent.updatedAt = ts;
			ensureAgentDefaults(agent);
			const missingResponses = responseMissingRecords(st, agentId);
			agent.runtimeStatus = missingResponses.length ? "response_missing" : "idle";
			if (missingResponses.length) {
				// Lifecycle-fencing (issue 9, site 1): skip the settle-with-missing-response notify if every
				// outstanding rec is stale (superseded by a later assignment, or no longer addressed to this
				// settling agent). Fence at emit time using durable message state — no pane liveness inference.
				const liveMissing = missingResponses.filter((rec) => !rec.superseded && rec.to === agentId);
				if (liveMissing.length === 0) {
					await trace(p, "notification.stale.suppressed", { site: "agent_settled.response_missing", agentId, reason: "all_recs_superseded_or_drifted", dropped: missingResponses.map((m) => m.id) });
				} else {
					for (const rec of liveMissing) {
						rec.response = { ...(rec.response || { status: "missing" as MessageResponseStatus }), status: "missing", missingAt: rec.response?.missingAt || ts, lastError: `response_missing: ${agentId} settled before sending a verified result` };
						rec.updatedAt = ts;
					}
					try {
						await deliverMessageLocked(pi, ctx.cwd, p, st, { to: "root", subject: `agent ${agentId} settled with missing response(s)`, body: `Agent ${agentId} settled while ${liveMissing.length} requiresResponse message(s) are still missing verified result messages: ${liveMissing.map((m) => m.id).join(", ")}. The agent is marked response_missing and is blocked from reuse until it sends replies and ack done with resultMessageId.`, requiresAck: false });
						await trace(p, "message.response_missing.settled.notify", { agentId, messageIds: liveMissing.map((m) => m.id) });
					} catch (err: any) {
						await trace(p, "message.response_missing.notify_failed", { agentId, error: String(err?.message || err) });
					}
				}
			}
			// R25 — PM auto-notify for ack-debt (separate from response-missing + open-assignment
			// cases). A worker that settles owing live, non-superseded requiresAck messages is
			// invisible to the root today; this closes that gap. Storm guards mirror the
			// response-missing branch: per-agent cooldown (`lastAckDebtNotifyAt`, distinct from
			// `lastSettleNotifyAt` so the open-assignment cooldown is not coupled) +
			// idempotencyKey=r25:ackdebt:<agent>:<sha8(sorted ids)> reused across settles.
			// requiresAck=false (informational). deliverMessageLocked derives from=currentAgentId()
			// which is the worker in this hook context — the correct author for the notify.
			const ackDebt = unackedRequiresAckRecords(st, agentId);
			if (ackDebt.length) {
				const sinceAckDebt = agent.lastAckDebtNotifyAt ? Date.now() - new Date(agent.lastAckDebtNotifyAt).getTime() : Number.POSITIVE_INFINITY;
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
			// PM auto-notify (engine behavior): a settle while still holding open assignments is a
			// stall/idle signal the root should not have to poll for. Enqueue a mailbox notify to
			// the mailbox-only root. Loop-safe: (a) it targets the root, never the worker
			// (no self-re-trigger); (b) cooldown-guarded per agent via persisted lastSettleNotifyAt so
			// repeated settles in a window don't storm; (c) mailbox-only (no tmux inject); (d) no node
			// mutation. requiresAck=false (informational; root pump surfaces it). Done before
			// writeState so the notify record persists atomically with the settle metadata.
			if (agent.activeTaskIds.length) {
				const sinceNotify = agent.lastSettleNotifyAt ? Date.now() - new Date(agent.lastSettleNotifyAt).getTime() : Number.POSITIVE_INFINITY;
				if (sinceNotify > SETTLE_NOTIFY_COOLDOWN_MS) {
					let list = agent.activeTaskIds.join(", ");
					let openCount = agent.activeTaskIds.length;
					let open: Awaited<ReturnType<typeof scanAgentOpenAssignments>> = [];
					try {
						open = await scanAgentOpenAssignments(p, st, agentId, agent.activeTaskIds);
						if (open.length) { list = open.map((o) => `${o.task.taskId}/${o.nodeId}`).join(", "); openCount = open.length; }
					} catch { /* keep activeTaskIds fallback list */ }
					// Lifecycle-fencing (issue 9, site 2): per-node staleness check on every entry from
					// scanAgentOpenAssignments. A node that has since become terminal / reassigned / closed
					// must not produce a settle-stale notify. Per-(task,agent) dedupe key prevents repeated
					// storming across settles. Notify is suppressed iff EVERY (task,node) entry is stale.
					const liveOpen: typeof open = [];
					for (const entry of open) {
						const staleCheck = checkStallNotificationStale(st, entry.task, entry.nodeId, agentId, Date.now());
						if (staleCheck.stale) {
							await trace(p, "notification.stale.suppressed", { site: "agent_settled.open_assignment", agentId, taskId: entry.task.taskId, nodeId: entry.nodeId, reason: staleCheck.reason, evidence: staleCheck.evidence });
							continue;
						}
						const key = formatNotifyKey(NOTIFY_KEY_SETTLE_STALE, { taskId: entry.task.taskId, agentId });
						if (findIdempotentMessage(st, "root", "root", key)) {
							await trace(p, "task.stale.settled.notify_cooldown", { agentId, taskId: entry.task.taskId, cooldownMs: SETTLE_NOTIFY_COOLDOWN_MS, key });
							continue;
						}
						liveOpen.push(entry);
					}
					if (liveOpen.length === 0) {
						// Every open entry is stale or deduped — do NOT send a settle-stale notify at all.
						// No lastSettleNotifyAt stamp (so a real fresh open next settle is still allowed).
						await trace(p, "notification.stale.suppressed", { site: "agent_settled.open_assignment", agentId, reason: "all_open_stale_or_deduped", scanned: open.length });
					} else {
						agent.lastSettleNotifyAt = ts;
						const list2 = liveOpen.map((o) => `${o.task.taskId}/${o.nodeId}`).join(", ");
						const openCount2 = liveOpen.length;
						try {
							await deliverMessageLocked(pi, ctx.cwd, p, st, { to: "root", subject: `agent ${agentId} settled idle with open assignment(s)`, body: `Agent ${agentId} settled (agent_settled) while still holding ${openCount2} open assignment(s): ${list2}. It may be idle or stalled; advance via swarm_next_nodes/swarm_update_task, reassign, or reconcile as needed.`, requiresAck: false });
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
	});

	pi.on("tool_execution_start", async (_event, ctx) => {
		const agentId = currentAgentId();
		if (agentId === "root") return;
		const p = paths(ctx.cwd);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[agentId];
			if (!agent) return;
			if (agent.pid && agent.pid !== process.pid) return; // pid-guard
			const ts = now();
			const resurrect = agent.status === "stopped" || agent.health === "unhealthy";
			agent.lastToolAt = ts;
			agent.runtimeStatus = "tool_running";
			agent.status = "running";
			agent.health = "healthy";
			agent.lastHeartbeatAt = ts;
			agent.updatedAt = ts;
			await writeState(p, st);
			await trace(p, "agent.status", { agentId, runtimeStatus: agent.runtimeStatus, health: agent.health, resurrect });
		});
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		const agentId = currentAgentId();
		if (agentId === "root") return;
		const p = paths(ctx.cwd);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[agentId];
			if (!agent) return;
			if (agent.pid && agent.pid !== process.pid) return; // pid-guard
			const ts = now();
			agent.runtimeStatus = "busy";
			agent.lastHeartbeatAt = ts;
			agent.updatedAt = ts;
			await writeState(p, st);
		});
		// === Issue 83a — stamp lastProgressAt on every tool execution (worker is making forward progress) ===
		// I/O cost per tool call: 1 `withLock`+`readState` (swarm state) + N `readTaskState` (one per
		// active task file) + M `writeTaskState` (one per dirty task). Where N = agent.activeTaskIds
		// length, M ≤ N (only dirty tasks written). Bounded by agent load; agent load is bounded by
		// `maxConcurrentTasks`. This is an EXTRA I/O cost vs the pre-83a baseline (which did not
		// stamp on tool calls); the cost is honest and bounded, NOT free. The read-then-stamp is
		// idempotent and safe under concurrent task-file writes because TaskNode.lastProgressAt is
		// monotone non-decreasing per node. Calls the exported `ensureNodeActivityStamp` helper per
		// node (single source of truth for the stamp invariant; unit tests exercise the same helper,
		// so the helper is the production entry point). R10-KR5 compliance: even the bare-catch
		// inner try/catch is wrapped in a test (C9) that asserts the durable side-effect; if the
		// wrapped body throws, C9 fails loudly instead of silently no-opping.
		{
			const _ids = await withLock(p, async () => { const st = await readState(p, ctx.cwd); const a = st.agents[agentId]; return a?.activeTaskIds ?? []; });
			for (const taskId of _ids) {
				try {
					const tp = taskPaths(p, taskId);
					if (!existsSync(tp.taskJson)) continue;
					const task = await readTaskState(tp.taskJson);
					const ts = new Date().toISOString();
					let dirty = false;
					for (const nodeId of Object.keys(task.nodes)) {
						if (ensureNodeActivityStamp(task, nodeId, ts, agentId)) dirty = true;
					}
					if (dirty) await writeTaskState(tp, task).catch(() => {});
				} catch { /* no progress stamp on this task; the agent may not be bound to it */ }
			}
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const agentId = currentAgentId();
		if (agentId === "root") {
			stopRootPump();
			// Issue 17 (binding C1 — symmetry with session_start): clear any open incident for the
			// root on shutdown. Defense-in-depth — the process is going away anyway, but
			// explicit symmetry keeps the invariant visible to readers.
			engineRetryIncidents.delete(agentId);
			return;
		}
		// Issue 17 (binding C1 — symmetry with session_start): clear any open incident for this agent
		// on shutdown so the next session_start (in this or another process) starts with an empty map.
		engineRetryIncidents.delete(agentId);
		const p = paths(ctx.cwd);
		await ensureDirs(p);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[agentId];
			if (!agent) return;
			// pid-guard: only the owning process may mark this agent stopped. A transient process sharing
			// the agentId (e.g. `pi --mode print`) must not poison a live agent's record.
			if (agent.pid && agent.pid !== process.pid) { await trace(p, "agent.shutdown.skip_pid_guard", { agentId, ownerPid: agent.pid, callerPid: process.pid }); return; }
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
						await trace(p, "notification.stale.suppressed", { site: "session_shutdown.open_node", agentId, taskId: entry.task.taskId, nodeId: entry.nodeId, reason: staleCheck.reason, evidence: staleCheck.evidence });
						continue;
					}
					liveOpen.push(entry);
				}
				for (const { task, tp, nodeId } of liveOpen) { task.nodes[nodeId].staleAt = ts; task.nodes[nodeId].lastActivityAt = ts; await writeTaskState(tp, task); }
				if (liveOpen.length) {
					await trace(p, "task.stale.shutdown", { agentId, open: liveOpen.map((o) => ({ taskId: o.task.taskId, nodeId: o.nodeId })) });
					const list = liveOpen.map((o) => `${o.task.taskId}/${o.nodeId}`).join(", ");
					// Nudge the reassignment authority: prefer each open node's assigner (replyTarget, from its
					// latest `assign` handoff `by`) when registered and not this dying agent; else root
					// (mailbox-only). Stamps node.lastActivityAt so the shutdown itself is recorded as activity.
					const nudgeTargets = new Set<string>();
					for (const { task, nodeId } of liveOpen) {
						const assigner = [...task.handoffs].reverse().find((h: any) => h?.toNode === nodeId && h?.kind === "assign")?.by as string | undefined;
						if (assigner && assigner !== agentId && st.agents[assigner]) nudgeTargets.add(assigner);
						else nudgeTargets.add("root");
					}
					for (const target of nudgeTargets) {
						try { await deliverMessageLocked(pi, ctx.cwd, p, st, { to: target, subject: `agent ${agentId} shut down with open task node(s)`, body: `Agent ${agentId} shut down (session_shutdown) while still assigned ${liveOpen.length} non-terminal node(s): ${list}. Those nodes were marked stale (staleAt) and lastActivityAt stamped. Reassign via swarm_assign_task or reconcile as needed.`, requiresAck: false }); }
						catch (err: any) { await trace(p, "task.stale.shutdown.nudge_failed", { agentId, target, error: String(err?.message || err) }); }
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
			await writeState(p, st);
		});
		await trace(p, "message.input_intercept", { id: msg.id, from: msg.from, to: msg.to, agentId: currentAgentId(), status: "intercepted" });

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
				if (lastInterruptAt && (Date.now() - new Date(lastInterruptAt).getTime()) < WINDOW_MS) {
					allowed = false;
				} else if (self) {
					self.lastHighInterruptAt = new Date().toISOString();
					self.updatedAt = new Date().toISOString();
					await writeState(p, st);
				}
			});

			if (!allowed) {
				await trace(p, "message.interrupt_suppressed", {
					id: msg.id, from: msg.from, to: msg.to, agentId: me,
					reason: "rate_limited", windowMs: WINDOW_MS, lastInterruptAt,
				}).catch(() => {});
				// Still queue as followUp so the message is consumed at the next-turn boundary — just
				// don't burn an extra interrupt budget on the second directive.
				pi.sendMessage({
					customType: "swarm-message",
					content: formatSwarmMessageContent(msg),
					display: true,
					details: msg,
				}, { triggerTurn: true, deliverAs: "followUp" });
				return { action: "handled" };
			}

			await trace(p, "message.interrupt_requested", { id: msg.id, from: msg.from, to: msg.to, agentId: me }).catch(() => {});
			let interruptEffective = false;
			try {
				await ctx.abort();
				interruptEffective = true;
			} catch (err) {
				await trace(p, "message.interrupt_failed", { id: msg.id, from: msg.from, to: msg.to, agentId: me, error: String((err as Error)?.message || err) }).catch(() => {});
				// Graceful degrade: still queue the message as followUp so it lands at the next-turn
				// boundary even if the abort itself failed (matches the manual-Escape fallback pattern).
			}
			if (interruptEffective) {
				await trace(p, "message.interrupt_effective", { id: msg.id, from: msg.from, to: msg.to, agentId: me }).catch(() => {});
			}
			pi.sendMessage({
				customType: "swarm-message",
				content: formatSwarmMessageContent(msg),
				display: true,
				details: msg,
			}, { triggerTurn: true, deliverAs: "followUp" });
			return { action: "handled" };
		}

		// === Existing behavior (preserved verbatim) ===
		pi.sendMessage({
			customType: "swarm-message",
			content: formatSwarmMessageContent(msg),
			display: true,
			details: msg,
		}, { triggerTurn: true, deliverAs: ctx.isIdle() ? "steer" : "followUp" });
		return { action: "handled" };
	});

}
