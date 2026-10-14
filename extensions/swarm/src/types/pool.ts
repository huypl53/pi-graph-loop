export type ModelSlot = {
	model: string;
	provider?: string;
	weight?: number; // default 1; 0 = fallback-only (used only when all weighted slots are down)
	label?: string;
	// Issue 21 quota-reset-interval: optional per-slot floor for quota benches. When a quota error
	// benches this slot, the effective bench = max(rotation.cooldownMs, quotaResetMs ?? env-default).
	// QuotaResetMs is a base floor before the final ceiling (rotation.benchMaxMs, default 1h)
	// and exponential backoff are applied; a 24h quotaReset is clamped to the 1h ceiling. Absent or
	// 0 falls back to rotation.cooldownMs (unchanged behavior).
	// NOTE: this is the INTERNAL field — always parsed milliseconds. In CONFIG, the canonical key
	// is `quotaReset` (duration-friendly: "30m", "2h"); `quotaResetMs` is a legacy alias that
	// parseModelPool/readQuotaResetMsFor still accept (quotaReset wins when both are set).
	quotaResetMs?: number;
	// Issue 22 roles-filter: optional allow-list of roleKind names; when set & non-empty, the slot
	// is only eligible for pickSlot() when the agent's roleKind is in the list. Absent / empty =
	// available for ALL roleKinds (default). Closed roleKind set: completion.ts ROLE_KINDS.
	roles?: string[];
};

export type RotationStrategy = "weighted" | "round-robin" | "sticky";

// Classify a provider/turn error message. Quota/auth and deterministic request-limit failures
// trigger immediate rotation; retryable transient errors are tolerated through engine retries.
export type ProviderErrorKind = "quota" | "auth" | "request_limit" | "rate_limit" | "transient" | "unknown";

export type RotationConfig = {
	strategy?: RotationStrategy; // default weighted
	cooldownMs?: number; // default 15min: a failing slot is benched this long after maxRetries
	maxRetries?: number; // default 2 consecutive failures before cooldown
	// D4 (plan 2026-10-14): ceiling for all benches (including auth). Backoff stops growing past this so a
	// benched slot is always re-probed within benchMaxMs — the pool keeps rotating. Default 1h.
	benchMaxMs?: number;
	// D3 (plan 2026-10-14): a slot that stays healthy for this long after its last bench has its
	// benchStreak reset to 0 on the next recordSlotSuccess (stale outages stop compounding). 0 = off.
	benchStreakDecayMs?: number;
	// D2 (plan 2026-10-14): when a role-filtered pickSlot finds no candidate (all tagged slots
	// benched), retry once with bypassRolesFilter so a healthy untagged slot can serve the turn.
	roleFallbackOnSwap?: boolean;
	// D5 (plan 2026-10-14 §1.4): forced model probe round. When a slot's error path is exhausted,
	// round-robin every distinct configured provider/model ONCE — bypassing cooldown AND roles —
	// before waiting for the earliest cooldown (≤ benchMaxMs). A proxy provider (cliproxyapi) is
	// transport only; each model under it has an independent quota window. Env off-switch:
	// PI_SWARM_FORCE_PROBE_ROUND_OFF=1.
	forceProbeRound?: boolean;
};

// Preflight classification — used by `preflightSpawn` and surfaced verbatim by spawn/restart
// callers. Each `kind` carries enough context for `formatPreflightError` to render a concrete
// corrective action. New variants must be added in lock-step with the formatter switch in pool.ts.
export type PreflightError =
	| { kind: "unknown_model"; model: string; suggestion: string }
	| { kind: "provider_not_found"; provider: string; suggestion: string }
	| { kind: "pool_exhausted"; message: string; suggestion: string }
	| { kind: "tmux_not_running"; message: string; suggestion: string }
	| { kind: "tmux_create_failed"; message: string; suggestion: string }
	| { kind: "invalid_settings"; message: string; suggestion: string; errors: string[] };

export type PreflightResult =
	{ ok: true; resolved: { model: string; provider: string; fromPool: boolean } } | { ok: false; error: PreflightError };

// Persisted per-slot health, keyed by `${provider}/${model}`. Stored in .pi/swarm/pool-state.json.
// D5 (plan 2026-10-14 §1.4): durable per-agent forced probe-round state. A round opens when a
// slot's error path is exhausted and swarm must probe every distinct configured provider/model
// once (cooldown + roles BYPASSED — a proxy provider is transport only; each model has its own
// quota window). Survives /reload and crash so a restarted session never re-probes a slot the
// round already burned. Cleared on a successful stop turn or /swarm pool clear.
export type PoolProbeRound = {
	roundId: string;
	startedAt: string;
	// provider/model keys, de-duplicated: a slot can receive at most one forced probe per round.
	triedSlots: string[];
	// Canonical modelPool order position immediately after the last selected slot.
	cursor: number;
	// Set when every configured slot has been tried and failed: the round is exhausted and no
	// further probe may fire before nextProbeAt (earliest cooldown, capped by benchMaxMs — D4).
	exhaustedAt?: string;
	nextProbeAt?: string;
	wakeSentAt?: string;
};

export type PoolSlotHealth = {
	failures: number;
	lastError?: string;
	lastErrorAt?: string;
	// True when the recorded error was deduplicated (pi-internal retry of the same incident within
	// 30s did not bump the streak). Informational only.
	deduped?: boolean;
	cooldownUntil?: string; // ISO; slot excluded from picking while in the future
	benchStreak?: number; // consecutive benches without an intervening success (drives exponential backoff)
	// Issue 21 quota-reset-interval: kind of the most recent bench event (quota/auth/etc.). Stamped
	// on every bench so the root pump's recovery scan can filter on "quota" (no point
	// emitting slot_recovered for an auth bench). Preserved across recordSlotSuccess (see B-3) so
	// the recovery gate stays accurate even if a successful turn is followed by a re-bench.
	lastBenchReason?: ProviderErrorKind;
	// Issue 21 quota-reset-interval: original bench duration in ms (the cap-adjusted value before
	// the rotation.benchMaxMs ceiling and exponential backoff were applied — actually the FINAL value written to
	// cooldownUntil). Stamped at bench time so the recovery trace can report how long the slot
	// was actually benched. Preserved across recordSlotSuccess for the same reason as lastBenchReason.
	lastBenchMs?: number;
	// Issue 21 quota-reset-interval: timestamp of the last emitted pool.slot_recovered trace for
	// this slot. Used as the idempotent dedupe gate (same contract as goal.idle_nudge's notify key).
	// Pre-policy slots simply lack the field, which the recovery scan treats as "never recovered".
	lastRecoveredAt?: string;
	// D3 (plan 2026-10-14): when the current bench was applied. Drives recordSlotSuccess's streak
	// decay (healthy for >= benchStreakDecayMs since the last bench → benchStreak resets to 0).
	// Stamped by every bench: recordProviderError (incl. severity escalations) and setSlotCooldown
	// manual benches; deleted by manual clear (fresh-start semantics).
	lastBenchAt?: string;
};

export type PoolHealthState = {
	slots: Record<string, PoolSlotHealth>;
	// round-robin cursor (index into the configured slot list)
	rrCursor?: number;
};

// Per-agent engine-retry observation (Issue 17 model-pool-respect-pi-retries). The pi engine
// retries a failed provider request up to retry.maxRetries (default 3) times before giving up.
// The extension cannot subscribe to engine retry events directly (`auto_retry_*` is not in the
// extension event allowlist — see agent-session.js:_emitExtensionEvent). Instead we count
// consecutive `turn_end { stopReason: "error" }` events on the SAME providerKey + errorMessage
// within ENGINE_RETRY_WINDOW_MS; when the count reaches ENGINE_MAX_RETRIES (or the burst ages out),
// we conclude the engine has exhausted retries on this slot and gate the swap path on that signal.
// In-process only — never persisted. See pool-retry.test.mjs for fixture coverage.
export type EngineRetryIncident = {
	providerKey: string; // `${provider}/${model}` of the slot being retried by the engine
	kind: ProviderErrorKind; // Issue 70: classified error kind — part of the incident identity
	errorMessage: string; // Issue 70: scrubErrorIdentity() output (digits erased, lowercase) for
	// comparison — raw text equality broke on mutating 429 bodies
	firstSeenAt: number; // ms epoch — first turn_end {error} for this incident
	lastSeenAt: number; // ms epoch — most recent turn_end {error} for this incident
	count: number; // number of consecutive turn_end {error} events in this incident
};
