// === swarm/hooks.ts — event hooks + orchestrator mailbox pump (verbatim from index.ts) ===
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join, dirname, relative, sep } from "node:path";
import type { MessageResponseStatus, Paths } from "./types.ts";
import { SETTLE_NOTIFY_COOLDOWN_MS, SWARM_GUEST_ID, PUMP_SESSION_ID_CAP, NOTIFY_KEY_SETTLE_STALE, formatNotifyKey } from "./constants.ts";
import { currentAgentId, currentModel, currentProvider, isOrchestratorSession } from "./session.ts";
import type { ModelSlot } from "./types.ts";
import { classifyProviderError } from "./types.ts";
import { pickSlot, recordProviderError, recordSlotSuccess, slotKey } from "./pool.ts";
import { deliverMessageLocked, findIdempotentMessage, readMailbox, responseMissingRecords, upsertMessageRecord } from "./mailbox.ts";
import { ensureAgentDefaults, inferRoleKind, now } from "./utils.ts";
import { ensureDirs, identityPath, mailboxPath, paths, readState, trace, withLock, writeState, writeTaskState } from "./state.ts";
import { ensureOrchestrator, heartbeatOrchestratorLeader, readOrchestratorLeader } from "./identity.ts";
import { formatSwarmMessageContent, parseSystemDelivery } from "./delivery.ts";
import { pumpOrchestratorMailbox, reconcile, runtimeTaskWarnings } from "./reconcile.ts";
import { scanAgentOpenAssignments, checkStallNotificationStale } from "./taskgraph.ts";
import { applySwarmToolGating } from "./tools/gating.ts";
import { tmux } from "./tmux.ts";

// Orchestrator mailbox pump state. Module-level so the PM pump can be (re)started from outside the
// session_start hook — notably by `/swarm register here orchestrator`, which opts a running session in
// as the orchestrator after startup. `swarmPi` is captured once in registerSwarmHooks (always called
// first by index.ts) and reused so there is a single pump per extension load.
//
// === Issue 11 (rework): self-rescheduling watchdog chain ===
// The previous `setInterval` is fragile in long-idle Pi TUI sessions — Node may silently drop the
// interval registration when the process becomes idle (no UI focus / no user input / no LLM activity),
// and the only recovery path was a fresh `session_start` (which fires only when the user types). That
// is the exact root cause of the 04:09–04:45 UTC outage documented in the rejection review.
// Replace the `setInterval` with a self-rescheduling `setTimeout` watchdog:
//   - Each tick re-arms the next timeout from inside the run-completion path (single-flight via
//     `orchestratorMailboxPumpRunning`), so the chain survives even if a single `setTimeout` is lost.
//   - `heartbeatOrchestratorLeader` is called from inside every tick so the leader lease stays alive
//     without requiring a `session_start`.
//   - Stale-ctx errors stop the chain (the only correct recovery is a fresh session_start on a new ctx).
//   - IO / leader-denied errors keep the chain running.
//   - A captured `pumpCtx` is checked for freshness on every tick; a stale `ctx.isIdle()` / `pi.sendMessage`
//     reference stops the chain (cannot be safely re-armed against the same ctx).
// `orchestratorMailboxTimer` now holds the `setTimeout` handle (or undefined when stopped).
let swarmPi: ExtensionAPI | undefined;
let orchestratorMailboxTimer: NodeJS.Timeout | undefined;
let orchestratorMailboxPumpRunning = false;
let orchestratorPumpCtx: any = undefined;
let orchestratorPumpCtxFresh: boolean = false;

// Pump tick interval (kept identical to the previous `setInterval` cadence so dashboards/expectations
// don't shift). Exposed as a constant so tests can shorten the wait for the watchdog test.
const ORCHESTRATOR_PUMP_INTERVAL_MS = 5_000;

// Swap-chain throttle for the turn_end auto-swap: agentId -> { count of consecutive swaps, last at }.
// Caps the fail->swap->retry->fail cascade so a fully-dead pool cannot burn a turn per slot.
const swapChain = new Map<string, { count: number; at: number }>();
const MAX_SWAP_CHAIN = 2;
const SWAP_CHAIN_RESET_MS = 5 * 60_000;

export function stopOrchestratorPump() {
	if (orchestratorMailboxTimer) clearTimeout(orchestratorMailboxTimer);
	orchestratorMailboxTimer = undefined;
	// Drop the captured ctx so a stale-ctx cannot silently re-arm against a dead session. The watchdog
	// re-install path can only resume by `startOrchestratorPump` with a fresh ctx.
	orchestratorPumpCtx = undefined;
	orchestratorPumpCtxFresh = false;
}

// Re-arm the watchdog against a fresh ctx. The previous ctx is dropped (so a stale-ctx from a prior
// session cannot keep the chain alive). Idempotent: if the chain is already armed, it is replaced with
// a fresh tick scheduled from now; the old `setTimeout` is cleared.
function armOrchestratorPumpWatchdog(ctx: any) {
	if (orchestratorMailboxTimer) clearTimeout(orchestratorMailboxTimer);
	orchestratorPumpCtx = ctx;
	orchestratorPumpCtxFresh = true;
	const tick = async () => {
		// Clear the handle that fired this tick — we are about to schedule the next one.
		orchestratorMailboxTimer = undefined;
		if (!orchestratorPumpCtxFresh) return; // stop() or stale-ctx already disabled us
		if (currentAgentId() !== "orchestrator") { orchestratorPumpCtxFresh = false; return; }
		const myCtx = orchestratorPumpCtx;
		if (!myCtx) { orchestratorPumpCtxFresh = false; return; }
		if (orchestratorMailboxPumpRunning) {
			// Re-arm even if a tick is already running (do not stall the chain).
			orchestratorMailboxTimer = setTimeout(tick, ORCHESTRATOR_PUMP_INTERVAL_MS);
			return;
		}
		orchestratorMailboxPumpRunning = true;
		try {
			await pumpOrchestratorMailbox(swarmPi!, myCtx, paths((myCtx as any).cwd), "watchdog");
		} catch (err: any) {
			// === Issue 11 (rework): error classification with watchdog self-heal ===
			// The watchdog must NEVER permanently disable itself for a transient error. Distinguish:
			//   - stale-ctx: the captured ctx was invalidated by session replacement/reload. We cannot
			//     safely re-arm against the SAME ctx (would busy-loop with a thrown ctx.isIdle()). Stop
			//     the chain; the next session_start will call startOrchestratorPump with a fresh ctx.
			//   - IO transient (EACCES/ENOSPC/EROFS/EAGAIN/EBUSY/ENFILE/EMFILE) or leader-denied: keep
			//     the chain running — the next tick retries with file IO that will recover.
			//   - unknown error class: stop (safe default), trace the error so it surfaces.
			const msg = String((err && err.message) || err);
			const code = String((err && err.code) || "");
			const isStaleCtx = /stale after session/i.test(msg);
			const isLeaderDenied = msg.startsWith("ORCHESTRATOR_LEADER_DENIED");
			const isIoTransient = /EACCES|ENOSPC|EROFS|EAGAIN|EBUSY|ENFILE|EMFILE/.test(code) ||
							  /EACCES|ENOSPC|EROFS/.test(msg);
			if (isStaleCtx) {
				stopOrchestratorPump();
				trace(myCtx.cwd ? paths(myCtx.cwd) : null, "mailbox.orchestrator_pump_stale_stopped", { reason: "watchdog", error: msg }).catch(() => {});
			} else if (isLeaderDenied || isIoTransient) {
				trace(myCtx.cwd ? paths(myCtx.cwd) : null, "mailbox.orchestrator_pump_transient", { reason: "watchdog", kind: isLeaderDenied ? "leader_denied" : "io", code, error: msg }).catch(() => {});
				// keep the chain alive — schedule the next tick
			} else {
				stopOrchestratorPump();
				trace(myCtx.cwd ? paths(myCtx.cwd) : null, "mailbox.orchestrator_pump_error", { reason: "watchdog", error: msg, stale: false }).catch(() => {});
			}
		} finally {
			orchestratorMailboxPumpRunning = false;
			// Re-arm the next watchdog tick ONLY if we are still fresh + still the orchestrator + the
			// previous tick didn't stop us. This is the single-flight self-heal: a single tick failure
			// (transient IO) keeps the chain; a stop() drops it.
			if (orchestratorPumpCtxFresh && orchestratorPumpCtx && currentAgentId() === "orchestrator") {
				orchestratorMailboxTimer = setTimeout(tick, ORCHESTRATOR_PUMP_INTERVAL_MS);
			}
		}
	};
	orchestratorMailboxTimer = setTimeout(tick, ORCHESTRATOR_PUMP_INTERVAL_MS);
}

// Pull-based worker delivery: surface unacked messages addressed to this agent into its own TUI
// conversation via pi.sendMessage (no tmux). Idempotent per message via the shared agentSurfaced ledger
// (per-agent, capped), so restarts re-surface only what is still unacked. Never targets the orchestrator
// (that is pumpOrchestratorMailbox's job) and never surfaces dead-lettered or superseded messages.
export async function surfaceAgentPending(pi: ExtensionAPI, ctx: any, p: Paths, agentId: string, reason: string) {
	if (currentAgentId() !== agentId) return { surfaced: 0, ids: [] as string[] };
	const idleAtStart = ctx.mode === "tui" ? ctx.isIdle() : false;
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

// (Re)start the orchestrator mailbox pump for this session: one immediate surface + a self-rescheduling
// setTimeout watchdog (NOT setInterval — see module-level comment). No-op unless this session resolves
// to the orchestrator. Safe to call from session_start or from the `/swarm register here orchestrator`
// opt-in path. The captured ctx is session-bound; on stale-ctx errors the watchdog stops and the next
// orchestrator session_start restarts it with a fresh ctx.
//
// Multi-orchestrator policy (issue 8, strict-reject): a preflight `withLock` runs
// heartbeatOrchestratorLeader so a non-leader pane cannot install the pump. On deny we trace
// `orchestrator.pump.denied` and return without installing the interval. A second-line defense
// inside pumpOrchestratorMailbox re-checks the leader pid on each tick.
export async function startOrchestratorPump(ctx: any, reason = "session_start") {
	const pi = swarmPi;
	if (!pi) return;
	stopOrchestratorPump(); // clear any prior watchdog + ctx
	// Preflight gate (Category A, plan §4.4.1): claim/refresh the leader; on denial, do NOT install
	// the watchdog. The throw is converted to a trace + early-return so a guest pane doesn't crash.
	if (currentAgentId() === "orchestrator") {
		const p = paths(ctx.cwd);
		try {
			await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				heartbeatOrchestratorLeader(st, Date.now(), process.pid, "pump_install");
				await writeState(p, st);
			});
		} catch (err: any) {
			const msg = String((err as Error)?.message || err);
			if (msg.startsWith("ORCHESTRATOR_LEADER_DENIED")) {
				await trace(p, "orchestrator.pump.denied", { reason, error: msg }).catch(() => {});
				return;
			}
			throw err;
		}
	}
	// The auto-pump records a surfacing DECISION (per-pid set + writeState) in every orchestrator session,
	// including explicit orchestrator opt-in runs (PI_SWARM_IS_ORCHESTRATOR=1 or PI_SWARM_AGENT_ID=orchestrator).
	// The decision block is ctx-free file IO (see pumpOrchestratorMailbox), so it cannot hit
	// the "This extension ctx is stale after session replacement or reload" error. The delivery loop
	// (sendMessage/isIdle) and the trace that uses ctx.isIdle are now mode-gated to TUI only inside
	// pumpOrchestratorMailbox, so non-TUI sessions (print/rpc/json) never make ctx-bound calls.
	// The watchdog tick is TUI-only (print sessions exit immediately after one turn); non-TUI
	// callers read mailboxes via swarm_check_mailbox, which never touches a captured ctx.
	if (currentAgentId() !== "orchestrator") return;
	const p = paths(ctx.cwd);
	// The one-shot below is awaited (not fire-and-forget) so that a pi -p / print session — which
	// exits immediately after its single turn — actually completes the surfacing decision (writeState +
	// trace) before teardown. The watchdog remains fire-and-forget.
	const run = async (reason: string) => {
		if (orchestratorMailboxPumpRunning) return;
		orchestratorMailboxPumpRunning = true;
		try {
			await pumpOrchestratorMailbox(pi, ctx, p, reason);
		} catch (err: any) {
			// === Issue 11: Error classification (binding C2 + C7) ===
			// Classify the error and respond correctly: stale-ctx stops (next session_start re-arms), IO
			// + leader-denied continue without stopping, generic errors stop (safe default).
			const msg = String((err && err.message) || err);
			const code = String((err && err.code) || "");
			const isStaleCtx = /stale after session/i.test(msg);
			const isLeaderDenied = msg.startsWith("ORCHESTRATOR_LEADER_DENIED");
			const isIoTransient = /EACCES|ENOSPC|EROFS|EAGAIN|EBUSY|ENFILE|EMFILE/.test(code) ||
							  /EACCES|ENOSPC|EROFS/.test(msg);
			if (isStaleCtx) {
				// SAME ctx caused the throw; re-arming would busy-loop. The ONLY correct recovery is the
				// next session_start (which fires per hooks.ts) with a fresh ctx. Stop and wait.
				stopOrchestratorPump();
				await trace(p, "mailbox.orchestrator_pump_stale_stopped", { reason, error: msg }).catch(() => {});
			} else if (isLeaderDenied || isIoTransient) {
				// Don't stop the timer: the next watchdog tick retries. Trace for visibility.
				await trace(p, "mailbox.orchestrator_pump_transient", { reason, kind: isLeaderDenied ? "leader_denied" : "io", code, error: msg }).catch(() => {});
			} else {
				// Unknown error class: stop (preserved safe default).
				stopOrchestratorPump();
				await trace(p, "mailbox.orchestrator_pump_error", { reason, error: msg, stale: false }).catch(() => {});
			}
		} finally { orchestratorMailboxPumpRunning = false; }
	};
	await run(reason);
	if (ctx.mode === "tui") armOrchestratorPumpWatchdog(ctx);
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
		await recordProviderError(p, currentSlot, kind, errorText).catch(() => {});
		const picked = await pickSlot(p, { stickyKey: agentId, avoidKey: slotKey(currentSlot) }).catch(() => undefined);
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
		if (okSwap) { swapChain.set(agentId, { count: chain.count + 1, at: nowMs }); }
		await trace(p, okSwap ? "pool.swap" : "pool.swap_failed", { agentId, from: slotKey(currentSlot), to: slotKey(picked.slot), kind, reason: picked.reason, target: `${target.provider}/${target.id}` }).catch(() => {});
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

	pi.on("session_start", async (_event, ctx) => {
		const p = paths(ctx.cwd);
		await ensureDirs(p);
		const agentId = currentAgentId();
		const guest = agentId === SWARM_GUEST_ID;
		// Identity-gated tool visibility: a guest session loses the swarm tool surface (it is a plain coding
		// session, not a swarm participant); registered agents and the orchestrator keep it. The /swarm slash
		// command is unaffected, so a guest can still opt in via `/swarm register here <role>`. Re-applied on
		// opt-in (command.ts) so an in-session identity change re-enables the swarm tools immediately.
		applySwarmToolGating(pi);
		const ts = now();
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			await trace(p, "session.start", { agentId, guest, mode: ctx.mode, state: relative(ctx.cwd, p.state) });
			if (guest) {
				// Anonymous swarm session (no PI_SWARM_AGENT_ID and no explicit orchestrator opt-in): stay
				// inert. Do NOT register an agent record, do NOT call ensureOrchestrator (which would refresh
				// the orchestrator pseudo-agent heartbeat and mask a dead/stalled PM), and do NOT start the
				// orchestrator mailbox pump (which would surface orchestrator mail here). The swarm tool surface
				// is gated off (see applySwarmToolGating above) — this session cannot act as or consume the
				// orchestrator. It can still opt in via `/swarm register here <role>` (the slash command is
				// unaffected by tool gating), which re-applies gating to re-enable the swarm tools. See
				// isOrchestratorSession() for the explicit opt-in path.
				return;
			}
			if (agentId === "orchestrator") {
				ensureOrchestrator(st, ctx.cwd, p);
				// Multi-orchestrator policy (issue 8): the heartbeat is now driven by the gate, not by
				// ensureOrchestrator. Layer the heartbeatOrchestratorLeader call here so an orchestrator
				// session_start both materialises the record and refreshes the leader lease.
				try {
					heartbeatOrchestratorLeader(st, Date.now(), process.pid, "session_start");
				} catch (err: any) {
					// A non-leader orchestrator session_start must NOT crash the session; trace + skip the
					// pump install (handled at startOrchestratorPump preflight below).
					await trace(p, "session.orchestrator_denied", { agentId, callerPid: process.pid, error: String((err as Error)?.message || err) }).catch(() => {});
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
		if (agentId === "orchestrator") {
			await startOrchestratorPump(ctx);
		} else if (ctx.mode === "tui") {
			// Pull-based delivery for workers (root fix for the restart/injection-loss class): on session
			// start, surface any unacked, non-dead-letter, non-superseded messages addressed to THIS agent
			// directly into its conversation — no tmux injection, no reconcile, no orchestrator involvement.
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
		if (agentId === "orchestrator") return;
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
		if (agentId === "orchestrator") return;
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
		if (agentId === "orchestrator") {
			const p = paths(ctx.cwd);
			await pumpOrchestratorMailbox(pi, ctx, p, "agent_settled");
			// === Issue 11 (rework) watchdog self-heal ===
			// If the watchdog tick has been lost (timer GC'd, single-tick throw that called stop, etc.),
			// re-install it from this hook so the chain stays alive without requiring session_start.
			// Guard: only re-arm when ctx.mode is TUI (print/rpc/json sessions don't need the watchdog).
			if (ctx.mode === "tui" && !orchestratorMailboxTimer && orchestratorPumpCtxFresh) {
				armOrchestratorPumpWatchdog(ctx);
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
						await deliverMessageLocked(pi, ctx.cwd, p, st, { to: "orchestrator", subject: `agent ${agentId} settled with missing response(s)`, body: `Agent ${agentId} settled while ${liveMissing.length} requiresResponse message(s) are still missing verified result messages: ${liveMissing.map((m) => m.id).join(", ")}. The agent is marked response_missing and is blocked from reuse until it sends replies and ack done with resultMessageId.`, requiresAck: false });
						await trace(p, "message.response_missing.settled.notify", { agentId, messageIds: liveMissing.map((m) => m.id) });
					} catch (err: any) {
						await trace(p, "message.response_missing.notify_failed", { agentId, error: String(err?.message || err) });
					}
				}
			}
			// PM auto-notify (engine behavior): a settle while still holding open assignments is a
			// stall/idle signal the orchestrator should not have to poll for. Enqueue a mailbox notify to
			// the mailbox-only orchestrator. Loop-safe: (a) it targets the orchestrator, never the worker
			// (no self-re-trigger); (b) cooldown-guarded per agent via persisted lastSettleNotifyAt so
			// repeated settles in a window don't storm; (c) mailbox-only (no tmux inject); (d) no node
			// mutation. requiresAck=false (informational; orchestrator pump surfaces it). Done before
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
						if (findIdempotentMessage(st, "orchestrator", "orchestrator", key)) {
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
							await deliverMessageLocked(pi, ctx.cwd, p, st, { to: "orchestrator", subject: `agent ${agentId} settled idle with open assignment(s)`, body: `Agent ${agentId} settled (agent_settled) while still holding ${openCount2} open assignment(s): ${list2}. It may be idle or stalled; advance via swarm_next_nodes/swarm_update_task, reassign, or reconcile as needed.`, requiresAck: false });
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
		if (agentId === "orchestrator") return;
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
		if (agentId === "orchestrator") return;
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
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const agentId = currentAgentId();
		if (agentId === "orchestrator") {
			stopOrchestratorPump();
			return;
		}
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
			// nodes, mark them stale and nudge the orchestrator (mailbox-only) instead of orphaning them.
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
					// latest `assign` handoff `by`) when registered and not this dying agent; else orchestrator
					// (mailbox-only). Stamps node.lastActivityAt so the shutdown itself is recorded as activity.
					const nudgeTargets = new Set<string>();
					for (const { task, nodeId } of liveOpen) {
						const assigner = [...task.handoffs].reverse().find((h: any) => h?.toNode === nodeId && h?.kind === "assign")?.by as string | undefined;
						if (assigner && assigner !== agentId && st.agents[assigner]) nudgeTargets.add(assigner);
						else nudgeTargets.add("orchestrator");
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
		pi.sendMessage({
			customType: "swarm-message",
			content: formatSwarmMessageContent(msg),
			display: true,
			details: msg,
		}, { triggerTurn: true, deliverAs: ctx.isIdle() ? "steer" : "followUp" });
		return { action: "handled" };
	});

}
