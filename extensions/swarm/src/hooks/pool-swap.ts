// === swarm/hooks/pool-swap.ts — turn_end model-pool auto-swap hook (Phase 7) ===
// Extracted verbatim from ../hooks.ts (Phase 7 modular split; canonical logic unchanged).
//
// In-process model-pool auto-swap (Option 1: the agent fixes itself, no respawn):
// pi does NOT exit on provider errors — the turn fails with stopReason "error" and the
// process keeps running. On a provider/quota error turn: classify the error, record it against
// the CURRENT slot in shared pool health, then pi.setModel() to a healthy slot IN-PROCESS.
// Gated by the Issue 17/70 engine-retry incident tracker and the swap-chain cap.
//
// R30/Pi-runtime: the swap notice is a single fire-and-forget pi.sendMessage (followUp);
// the agent trigger is a second sendMessage with triggerTurn (idle) or followUp+triggerTurn.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelSlot } from "../types.ts";
import { classifyProviderError, scrubErrorIdentity } from "../types.ts";
import { ENGINE_MAX_RETRIES, ENGINE_RETRY_WINDOW_MS, SWARM_GUEST_ID } from "../constants.ts";
import { currentAgentId } from "../session.ts";
import { pickSlot, recordProviderError, recordSlotSuccess, slotKey } from "../pool.ts";
import { paths, readState, trace, withLock } from "../state.ts";
import { logSwarmError } from "../errorlog.ts";
import { bumpSwapChain, engineRetryIncidentsMap, MAX_SWAP_CHAIN, peekSwapChain, SWAP_CHAIN_RESET_MS } from "./streaks.ts";

export function registerPoolSwapHook(pi: ExtensionAPI) {
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
			const okSlot: ModelSlot = {
				model: String(msg.model || ctx.model?.id || ""),
				provider: String(msg.provider || ctx.model?.provider || "") || undefined,
			};
			if (okSlot.model) await recordSlotSuccess(p, okSlot).catch((err) => logSwarmError(p, "hooks", "recordSlotSuccess.failed", err));
			// Issue 17: a successful turn after a burst of engine retries means the engine RECOVERED.
			// Clear any open incident for this agent so the next failure starts a fresh observation.
			// Without this, a stale incident would survive and the next error turn_end would miscount
			// against the previous burst.
			if (engineRetryIncidentsMap().has(agentId)) {
				const incident = engineRetryIncidentsMap().get(agentId);
				engineRetryIncidentsMap().delete(agentId);
				await trace(p, "pool.engine_retry_recovered", {
					agentId,
					providerKey: incident?.providerKey,
					count: incident?.count ?? 0,
				}).catch(() => {});
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
		const chain = peekSwapChain(agentId) || { count: 0, at: 0 };
		// A quiet gap (no swap for 5 minutes) starts a fresh chain.
		if (nowMs - chain.at > SWAP_CHAIN_RESET_MS) chain.count = 0;
		if (chain.count >= MAX_SWAP_CHAIN) {
			await trace(p, "pool.swap_chain_capped", { agentId, count: chain.count, kind, error: errorText.slice(0, 120) }).catch(() => {});
			return;
		}
		const currentSlot: ModelSlot = {
			model: String(msg.model || ctx.model?.id || ""),
			provider: String(msg.provider || ctx.model?.provider || "") || undefined,
		};
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
		const prevIncident = engineRetryIncidentsMap().get(agentId);
		let engineExhausted = false;
		let incidentCount = 1;
		if (
			prevIncident &&
			prevIncident.providerKey === providerKey &&
			prevIncident.kind === kind &&
			prevIncident.errorMessage === scrubErr &&
			nowMs - prevIncident.lastSeenAt <= ENGINE_RETRY_WINDOW_MS
		) {
			prevIncident.count++;
			prevIncident.lastSeenAt = nowMs;
			incidentCount = prevIncident.count;
			if (prevIncident.count >= ENGINE_MAX_RETRIES) engineExhausted = true;
		} else {
			engineRetryIncidentsMap().set(agentId, {
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
		engineRetryIncidentsMap().delete(agentId);
		await trace(p, "pool.engine_retry_exhausted", { agentId, providerKey, kind, count: incidentCount }).catch(() => {});
		await recordProviderError(p, currentSlot, kind, errorText).catch((err) =>
			logSwarmError(p, "hooks", "recordProviderError.failed", err),
		);
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
		const target = picked.slot.provider ? ctx.modelRegistry?.find?.(picked.slot.provider, picked.slot.model) : undefined;
		if (!target) {
			await trace(p, "pool.swap_model_not_found", {
				agentId,
				slot: slotKey(picked.slot),
				reason: picked.reason,
				hint: picked.slot.provider
					? "model not registered under the slot's provider"
					: "pool slot has no explicit provider; add one in settings.json modelPool",
			}).catch(() => {});
			return;
		}
		const okSwap = await pi.setModel(target).catch(() => false);
		if (okSwap) {
			bumpSwapChain(agentId, nowMs);
		}
		// Issue 22: record role-filter context on every auto-swap so dashboards can tell whether
		// the swap honored the agent's roleKind constraint or fell back.
		const swapTrace = {
			agentId,
			from: slotKey(currentSlot),
			to: slotKey(picked.slot),
			kind,
			reason: picked.reason,
			target: `${target.provider}/${target.id}`,
			roleKind: roleKind ?? null,
			rolesFilterMatched:
				picked.slot.roles === undefined ||
				picked.slot.roles.length === 0 ||
				(typeof roleKind === "string" && picked.slot.roles.includes(roleKind)),
		};
		await trace(p, okSwap ? "pool.swap" : "pool.swap_failed", swapTrace).catch(() => {});
		if (okSwap) {
			// User-facing pool event notice (operator sees it in TUI; NOT the LLM's trigger turn).
			// Carries the old/new slot + error kind so the operator can monitor rotation without
			// digging into traces. deliverAs:"followUp" so it doesn't consume a turn.
			pi.sendMessage(
				{
					customType: "swarm-pool-event",
					content: `⚠ Pool: ${kind} error on ${slotKey(currentSlot)} — switched to ${slotKey(picked.slot)}.`,
					display: true,
				},
				{ deliverAs: "followUp" },
			);
			// Minimal agent trigger: the LLM only needs to know to continue.
			// No model name, no error body, no slot details — those add noise that wastes a turn.
			pi.sendMessage(
				{
					customType: "swarm-message",
					content: "Continue your current task.",
					display: false,
				},
				ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "followUp", triggerTurn: true },
			);
		}
	});
}
