# Plan: Pool dead-slot stickiness + bench-streak runaway — no re-bench while benched, roles-bypass swap fallback, streak decay

> **Status:** AMENDED-2 (2026-10-14) — added **D4: configurable bench ceiling `benchMaxMs` (default 1h) replacing the hard 24h cap** (user mandate: "max bench là 1h — tối đa 1h sau thì kiểu gì cũng phải reset và gọi LLM thử lại"; the 24h cap exceeded every real provider recovery window and starved the pool's rotation thesis). Also incorporates red-team findings R1–R10 (agy review): recordSlotSuccess early-return guard + lastBenchAt preservation (R1, was BLOCKER); failures=0 while benched (R2); severity-escalation exception in the D1 guard (R3); pool-swap.ts snippet correctness — `let picked`, explicit avoidKey, ctx.hasUI guard, logSwarmError-routed bypass pick (R4); setSlotCooldown lastBenchAt stamping both directions (R5); noCandidateNotify test reset helper (R6); effectiveConfig() resolves the new rotation keys + env overrides (R7); rolesFilterMatched corrected to `!rolesBypassed && …` (R8); scaffold templates document the new keys (R9); RECOGNIZED_KEYS untouched, parseRotationConfig only (R10). Plan artifact written before any source change, per the reproduce-first mandate.
> **Live incident:** session `01a1241f` (project `workflow-agents`, 2026-10-13) — root stuck on `cliproxyapi/gpt-5.6-terra` for ~4 minutes of continuous quota errors (225 × `pool.swap_no_candidate`, 1,138 error turns), manual model switch required at 23:34:32Z. `pool-state.json` forensics: terra `benchStreak: 540` (→ 24h cap bench), glm-5.3 `benchStreak: 7` (→ 16h bench, `57600000ms` = 900000 × 2^6, exact match to the backoff formula).
> **Pi runtime contract:** this change touches the `pi.setModel` swap path in `hooks/pool-swap.ts`. Consulted: `docs/swarm/pi-runtime-contract.md` §2 (sendMessage shapes), §9 (error handling), §10 row **F16** (engine-retry gate / single-strike quota — the upstream fix that makes the error path reach `recordProviderError` at all). No new Pi-runtime *claims* are introduced, removed, or modified → **no new §10 row**; but the roles-bypass branch is a NEW code path reaching the existing `pi.setModel` + follow-up `pi.sendMessage` call sites → **R10-1 boundary-counting assertions required** (§4.3).

## 0. Problem — three stacked defects, all reproduced from live state

Timeline (from `.pi/swarm/traces/events.jsonl` + `pool-state.json` + session jsonl):

1. 13:28Z — glm-5.3 (root slot, `roles:[root]`) hits ChatGPT quota → bench (streak 7 → 16h) → auto-swap to terra works. **The pool machinery is NOT dead** — it swapped correctly 4× that day.
2. 23:30Z — terra (the OTHER root slot, same cliproxyapi upstream ⇒ same shared ChatGPT quota) hits the same quota. Engine-retry gate exhausts (2 strikes) → terra benched (streak ~315 → 24h cap).
3. `pickSlot({roleKind:"root"})`: tagged slots = {glm-5.3 benched-until-05:28+1d, terra benched} → strict-roles filter (Issue 22) → **no candidate** → `swap_no_candidate` → pool **keeps terra as the serving model**.
4. Every subsequent error turn re-enters `recordProviderError` on the benched-but-serving terra → quota = immediate bench → `benchStreak++` and `cooldownUntil = now + 24h` **again**. 225 iterations in 4 minutes: streak inflated 315→540 and the bench window rolled forward forever. Only escape: manual switch / `/swarm pool clear`.

Three distinct defects:

| # | Defect | Code site | Live evidence |
|---|---|---|---|
| **D1** | Rolling re-bench: a slot that is benched but still serving (because no swap candidate existed) is re-benched on every error turn — streak inflates within a single outage and `cooldownUntil` never expires | `pool.ts` `recordProviderError` (no "already in cooldown" guard) | streak 315→540 in 4 min; 225 `swap_no_candidate` in one evening |
| **D2** | Swap no-candidate is terminal: when all role-tagged slots are benched but healthy untagged slots exist, the swap hook gives up — spawn has a roles-filter fallback (`pool.role_filter_all_filtered_fallback`, agents.ts:230) but the swap path never got one | `hooks/pool-swap.ts:222` (`if (!picked) … return`) | 225 × `swap_no_candidate` while glm-4.7 / gpt-6-luna / claude-fable-5 sat idle and healthy |
| **D3** | `benchStreak` never decays: `recordSlotSuccess` deliberately preserves it (Issue 21 B-3) with no health-proportional reset, so days-old outages keep compounding the next bench (7 → 16h for a slot that had served fine for hours) | `pool.ts` `recordSlotSuccess` | glm-5.3 streak 7 → 57600000ms bench |
| **D4** | Bench ceiling is 24h — far beyond every real provider recovery window (ChatGPT quota ~5h, SSE blips ~minutes). A high-streak slot is effectively removed from the pool for a day; the pool's whole rotation thesis ("eventually a slot comes back") breaks when the cap is larger than any outage | `pool.ts:824` `Math.min(base × 2^(streak-1), 24 × 60 × 60_000)` | terra benchStreak 540 → 24h cap while its quota would reset in ~5h; glm-5.3 16h for the same reason |
| **D5** | Cooldown is treated as a hard exclusion by `pickSlot`: one quota failure cannot deliberately test a different *model* which happens to be cooling from an old incident. This is wrong for `cliproxyapi`: it is transport only; `cliproxyapi/glm-5.3`, `…/terra`, `…/fable` may have independent quota windows and must each be probed once before waiting | `pool.ts:pickSlot` health filter; `hooks/pool-swap.ts` no-candidate branch | terra/glm-5.3 both cooling led to `swap_no_candidate` while other model slots were never tried; manual `/model` bypassed health and proved an old-cooldown model could work |

## 1. Contract

### 1.1 D1 — no re-bench while already benched (`recordProviderError`)

In `recordProviderError(p, slot, kind, error)`, before the bench branch:

```
prevCooldownEnd := prev.cooldownUntil ? new Date(prev.cooldownUntil).getTime() : 0
alreadyBenched := prevCooldownEnd > Date.now()
```

- If `alreadyBenched` AND the new bench would NOT be strictly more severe (see below): write `lastError` / `lastErrorAt` (+ the 30s same-incident failure dedupe continues to apply), but **do NOT** re-bench — carry over `cooldownUntil`, `benchStreak`, `lastBenchReason`, `lastBenchMs`, `lastRecoveredAt`, `lastBenchAt` unchanged AND **force `failures: 0`** (R2: while benched, error turns carry no probe-failure information — accumulating them would make the first post-cooldown probe instantly re-bench via `failures >= maxRetries`, violating the "fresh chance after cooldown" reset at pool.ts:826). The bench already happened; repeat errors on a benched-but-serving slot carry no new information.
- **Severity escalation is the exception (R3):** compute what the NEW bench end would be (`newEnd = now + min(base(kind) × 2^streak, rotation.benchMaxMs)`). If `newEnd > prevCooldownEnd` — e.g. slot benched 15m for `rate_limit`, now hits `auth` / `quota` with longer duration or higher streak — apply the NEW bench: `cooldownUntil = newEnd`, `lastBenchReason = kind`, `lastBenchMs = newEnd - now`, `lastBenchAt = now`, streak++ (escalation is a real new bench event; the recovery-scan's `lastBenchReason === "quota"` gate at nudges/slot-recovery.ts:30 must see the upgraded kind). Equal-or-shorter severity → plain carry-over. 
- Manual benches (`lastBenchReason` absent): a quota/auth error while manually benched ESCALATES if the error-driven end is later (it always is vs a short manual bench) — this converts the bench to error-driven and is correct: the slot genuinely failed quota/auth. A `rate_limit`/`transient` error while manually benched does not convert it (no extension; stays manual).
- An EXPIRED bench (`cooldownUntil` in the past) takes the normal path: streak++ and a fresh bench — the post-cooldown probe failed, which is exactly what backoff models.
- Trace: `pool.slot_failure` keeps its shape; add `"benchedAlready": true` on the skip path so dashboards can distinguish probe-fail re-benches from serving-while-benched noise.

Invariant: a slot's `cooldownUntil` never moves while the slot is continuously benched; `benchStreak` increments at most once per bench cycle (one expiry → one probe → one re-bench).

### 1.2 D2 — roles-bypass swap fallback (`hooks/pool-swap.ts`)

After the primary `pickSlot({ stickyKey: agentId, avoidKey: slotKey(currentSlot), roleKind })` returns `undefined` (note: `pool-swap.ts` has no local `avoidKey` binding — pass `avoidKey: slotKey(currentSlot)` explicitly, and the primary `picked` must become `let`):

```
let rolesBypassed = false;
if (!picked && roleKind !== undefined && effectiveConfig().rotation.roleFallbackOnSwap) {
    picked = await pickSlot(p, { stickyKey: agentId, avoidKey: slotKey(currentSlot), bypassRolesFilter: true })
        .catch((err) => { logSwarmError(p, "hooks", "pick_slot_bypass_failed", err); return undefined; });
    rolesBypassed = !!picked;
}
```

- Uses the EXISTING `bypassRolesFilter` escape hatch (same one `/swarm pool rotate now` uses, commands/pool.ts:305) — no new pickSlot surface. `pickSlot` applies the health/cooldown filter AFTER the roles filter (pool.ts `eligible`/`fallbacks` arrays), so the bypass can never land on another benched slot, and `filterAvoiding` still excludes the just-failed slot in both candidate pools.
- If the bypass also finds nothing (genuinely all slots benched / single-slot pool): keep current model (existing honest no-swap behavior) + **operator notify** — guarded `if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify("Pool: no healthy slot to rotate to — all slots benched …", "error")` (same guard as the existing notify at pool-swap.ts:183; `pi -ne` headless lanes have `ctx.ui === undefined`), TUI-only (NOT LLM context, no `pi.sendMessage`), throttled per agent to once per `SWAP_CHAIN_RESET_MS` (5 min) via a new `noCandidateNotify` map in `hooks/streaks.ts` (with `_resetNoCandidateNotifyForTests()` matching the existing `_resetSwapChainForTests` / `_resetTurnStartForTests` pattern), so a dead-pool evening produces one warning per 5 min, not one per error turn.
- A successful bypass swap goes through the SAME `pi.setModel(target)` call site and the SAME two follow-up `pi.sendMessage` notes (operator event + "Continue your current task." trigger) — zero new L2 call sites. `bumpSwapChain` applies (cascade cap covers bypass swaps too).
- Strict-roles mandate (2026-08-31) honored in spirit: untagged slots are no longer a *silent* fallback — every bypass swap is loud:
  - `pool.swap` trace gains `rolesIgnored: true`, and the existing `rolesFilterMatched` field is corrected to `!rolesBypassed && (…)` (R8: today an untagged bypass pick would compute `rolesFilterMatched: true` from the `picked.slot.roles === undefined` branch at pool-swap.ts:258-262, producing the contradictory `{rolesFilterMatched: true, rolesIgnored: true}`);
  - operator event text becomes `⚠ Pool: {kind} error on {from} — switched to {to} (roles fallback).`
- Config gate: `rotation.roleFallbackOnSwap` (boolean, **default `true`**), env off-switch `PI_SWARM_ROLE_FALLBACK_OFF=1`. Precedence: env > yaml (project) > yaml (global) > default — resolved in `effectiveConfig()` (pool.ts:231-243, R7: the rotation object is constructed there and must gain both new keys + env overrides; `config.ts` only needs `parseRotationConfig` extended, NOT `RECOGNIZED_KEYS` — that list is top-level keys only).

### 1.3 D3 — bench-streak decay (`recordSlotSuccess`)

- **D4 supersedes the hard 24h cap with a configurable bench ceiling, default 1h:** `ms = Math.min(base × 2^(streak-1), rotation.benchMaxMs)` with `benchMaxMs` default `3_600_000` (1h), config `rotation.benchMaxMs`, env override `PI_SWARM_BENCH_MAX_MS`, validated as a positive duration. The operator invariant (user mandate 2026-10-14): **a slot is never benched longer than `benchMaxMs` — worst case, 1h after the last bench the slot gets a fresh probe, so a pool of N slots cycles and some slot always recovers**. The backoff ladder still exists (15m → 30m → 1h ceiling for the default config) — it just stops growing past the ceiling. The 24h rationale ("monthly quota reset costs one probe per doubling") is obsolete: probes are cheap, idempotent (one failed turn, engine-retry gated, does not thrash), and D1 guarantees repeat failures while benched cannot re-roll the window — so a ceiling of 1h costs at most one wasted probe attempt per hour per benched slot.
- New health field `lastBenchAt?: string` (ISO), stamped in `recordProviderError` whenever a bench is applied (including §1.1 severity escalations) **and in `setSlotCooldown` when a manual bench is applied** (R5: `pool.ts:896` sets `cooldownUntil` without stamping — an unstamped manual bench would either never decay or decay off a stale stamp from days earlier); manual clear (`ms === null`) deletes `lastBenchAt` alongside the existing wipe set (fresh-start semantics).
  - **Auth stays exceptional:** ~~an auth bench ignores `benchMaxMs`~~ **REMOVED at implementation time (2026-10-14):** the "auth 6h floor" existed only in a code comment — the Issue 21 refactor dropped it from the actual formula, and two regression suites (`pool-single-strike-nonretryable` F2, `pool-retry-preserve-cache-no-6h`) pin auth bench === `cooldownMs` (deliberately "NOT 6-hour floor"). Implementing the 6h exemption would have REGRESSED those suites. Final semantics: **every kind, auth included, follows the same D4-capped backoff** — auth escalations while benched still extend the bench (R3), high-streak auth caps at `benchMaxMs` like everything else.
- In `recordSlotSuccess` (R1 — the insertion must beat the early-return): the current guard `if (!prev || (!prev.failures && !prev.cooldownUntil && !prev.lastError)) return;` (pool.ts:864) fires on the SECOND and later healthy turns (the first success already cleared failures/cooldownUntil/lastError), so naive decay placement would never run. Amend to:

```ts
const decay = decayBenchStreak(prev); // { fire: boolean } — benchStreak > 0 && lastBenchAt && decayMs > 0 && now - lastBenchAt >= decayMs
if (!prev || (!prev.failures && !prev.cooldownUntil && !prev.lastError && !decay.fire)) return;
h.slots[key] = {
    failures: 0,
    lastBenchReason: prev.lastBenchReason,
    lastBenchMs: prev.lastBenchMs,
    benchStreak: decay.fire ? 0 : prev.benchStreak,   // D3
    lastBenchAt: prev.lastBenchAt,                     // R1: must be preserved, not wiped
    lastRecoveredAt: prev.lastRecoveredAt,
};
```

  `lastBenchReason` / `lastBenchMs` / `lastRecoveredAt` remain preserved (Issue 21 B-3 recovery-scan gate untouched — it keys on `lastBenchReason`, not on `benchStreak`).
- Config: `rotation.benchStreakDecayMs` (number, **default `21_600_000` = 6h**, roughly the ChatGPT 5h quota window plus margin), `0` disables. Env override `PI_SWARM_BENCH_STREAK_DECAY_MS`. Validation: non-negative number, else `slot_bad_rotation`-style reject in `validateSwarmSettings`.
- Rationale: after one healthy window ≥ a quota cycle, the world that caused the streak is gone; the next quota error starts at base bench, not at 2^n × base.

### 1.4 D5 — forced model probe round, cooldown is a hint not a wall

**User contract (2026-10-14):** when a model's pool error path is exhausted, swarm must round-robin through every distinct configured **`provider/model` slot** once, even when a candidate has `cooldownUntil` in the future. `cliproxyapi` is a proxy transport, not a quota group: each model under it is independently probe-worthy. Only after the complete round fails may swarm wait for the earliest cooldown; D4 guarantees that wake/probe happens in ≤1h.

#### Durable state

Add optional `SwarmState.poolProbeRounds?: Record<string, PoolProbeRound>` keyed by agent id:

```ts
type PoolProbeRound = {
  roundId: string;
  startedAt: string;
  // provider/model keys, de-duplicated: a slot can receive at most one forced probe per round.
  triedSlots: string[];
  // canonical modelPool order position immediately after the last selected slot.
  cursor: number;
  // all configured model slots exhausted; root-pump one-shot wake is due at this time.
  exhaustedAt?: string;
  nextProbeAt?: string;
  wakeSentAt?: string;
};
```

It is intentionally **durable**, not a module-local map: `/reload`, root session replacement, or crash must not restart a fresh full probe cycle and re-burn the same models. Clear it only after a successful `stop` turn on a slot in the round, explicit `/swarm pool clear`, or when a newer non-probe incident begins after `nextProbeAt`.

#### Candidate semantics

- D5 begins **only after** the existing engine retry gate has exhausted; light stream disconnects still get pi retry + swarm gated retry first.
- The current failed slot is appended to `triedSlots` by `slotKey(currentSlot)` before selection.
- `pickProbeRoundSlot()` is new and deliberately **does not call normal `pickSlot`**: it walks canonical `modelPool` order from `cursor`, de-duplicates by provider/model key, skips only (a) the current slot, (b) already-tried slots, and (c) unresolvable `ctx.modelRegistry` models. It ignores **both `cooldownUntil` and `roles`**. `weight`, sticky selection, and fallback-only semantics do not participate: this is a bounded diagnostic/probe ring, not normal scheduling.
- Each selected slot is marked `triedSlots` **under the same state lock before `pi.setModel`**. A crash after selection may sacrifice one probe, but can never duplicate it after reload.
- `MAX_SWAP_CHAIN=2` must **not** truncate a D5 round. D5 has its own hard cap: `uniqueConfiguredSlots - 1` swaps (the failed current slot already counts). This is finite and testable; normal non-probe swaps retain `MAX_SWAP_CHAIN` unchanged.
- A D5 swap emits one loud operator event and trace:
  ```json
  {
    "event": "pool.probe_round_swap",
    "agentId": "root",
    "roundId": "…",
    "from": "cliproxyapi/gpt-5.6-terra",
    "to": "cliproxyapi/glm-5.3",
    "attempt": 2,
    "total": 5,
    "ignoredCooldown": true,
    "ignoredRoles": true
  }
  ```
  The existing `pool.swap` trace remains the source of `pi.setModel` outcome; add `probeRoundId`, `probeAttempt`, `ignoredCooldown`, and `ignoredRoles` fields. TUI text: `⚠ Pool probe 2/5: … switched to … (cooldown/roles override).`
- A successful turn (`recordSlotSuccess`) clears the whole round and restores normal `pickSlot` behavior. A failed probe follows the same engine-gate path; after exhaustion it benches that model normally (D1 prevents rolling re-bench), then advances to the next untried model.

#### Full-round exhaustion and automatic retry

- If every distinct configured slot has been tried and failed, set:
  ```ts
  nextProbeAt = min(slot.cooldownUntil for tried slots) ?? now + benchMaxMs
  exhaustedAt = now
  ```
  Do **not** clear the round or retry a slot immediately. Emit `pool.probe_round_exhausted` with `{roundId, triedSlots, nextProbeAt}` and one TUI error notification.
- The root pump owns a bounded one-shot wake for `nextProbeAt` (on boot/reload, schedule remaining delay; overdue means schedule immediate). At due time it sends **exactly one** existing-shape hidden continuation `pi.sendMessage({customType:"swarm-message", content:"Continue your current task."}, {triggerTurn:true})`, stamps `wakeSentAt` durably first, starts a new round with empty `triedSlots`, and lets the normal current/next failure begin the next probe sweep. This is what makes the 1h D4 ceiling an actual automatic re-probe guarantee rather than merely an eligibility change.
- No polling interval and no N-per-slot timers: one durable due timestamp / one one-shot root-pump wake per exhausted round. Session shutdown/reload cancels process-local timer; session start reconstructs it from durable `nextProbeAt`.

#### Config

```yaml
rotation:
  forceProbeRound: true       # default true; use each provider/model once despite cooldown/roles
```

Env opt-out: `PI_SWARM_FORCE_PROBE_ROUND_OFF=1`. This gate is only for an emergency incident; ordinary spawn/manual picks retain strict roles + cooldown semantics.

### 1.5 Invariants kept

- **D4 operator invariant:** `cooldownUntil − benchStart ≤ benchMaxMs (1h default)` for every bench — testable directly from pool-state.json at any moment. (Auth exemption removed — see §1.3 amendment.)
- Issue 21 recovery scan (`nudges/slot-recovery.ts`) unchanged: `lastBenchReason` / `lastBenchMs` / `lastRecoveredAt` lifecycle identical.
- Issue 17/70 engine-retry gate unchanged (D1 sits downstream of exhaustion).
- 30s same-incident dedupe unchanged.
- Swap-chain cap `MAX_SWAP_CHAIN=2` unchanged and now also bounds bypass swaps.
- `types/pool.ts` `PoolSlotHealth` gains only the optional `lastBenchAt` — additive, no migration.

## 2. Files

| File | Change |
|---|---|
| `extensions/swarm/src/pool.ts` | D1 guard (carry-over + severity escalation + `failures:0` while benched) in `recordProviderError`; D3 decay in `recordSlotSuccess` (early-return amendment + `lastBenchAt` preservation); **D4 `benchMaxMs` ceiling replaces the 24h constant at pool.ts:824 (auth included, no 6h floor)**; D5 `pickProbeRoundSlot()` canonical-order, cooldown/roles-bypassing selection; `lastBenchAt` stamping incl. `setSlotCooldown` manual bench/clear; `effectiveConfig()` resolves `forceProbeRound` + existing rotation keys/env overrides; validation accepts the new flag |
| `extensions/swarm/src/hooks/pool-swap.ts` | D2 bypass branch (`let picked`, explicit `avoidKey: slotKey(currentSlot)`, `ctx.hasUI`-guarded throttled notify, `logSwarmError`-routed bypass pick) + D5 durable probe-round advancement / `pool.probe_round_swap` trace + corrected trace flags / operator event text |
| `extensions/swarm/src/hooks/streaks.ts` | `noCandidateNotify` throttle map (per-agent, 5 min) + `_resetNoCandidateNotifyForTests()` (R6: matches `_resetSwapChainForTests` pattern — without a reset, sequential sub-cases throttle each other); D5 remains durable state, not another module-local retry map |
| `extensions/swarm/src/types/pool.ts` | `PoolSlotHealth.lastBenchAt?`; rotation config type gains `roleFallbackOnSwap?`, `benchStreakDecayMs?`, `forceProbeRound?` |
| `extensions/swarm/src/types/state.ts` | D5 `PoolProbeRound` + optional `SwarmState.poolProbeRounds?` (durable reload/crash fence) |
| `extensions/swarm/src/surface/pump-phases.ts` (or existing root-pump timer owner) | D5 reconstruct/cancel bounded one-shot due wake; on due, durable `wakeSentAt` stamp then exactly one `pi.sendMessage` continuation |
| `extensions/swarm/src/constants.ts` | defaults (`ROLE_FALLBACK_ON_SWAP`, `BENCH_STREAK_DECAY_MS`) + env names |
| `extensions/swarm/src/config.ts` | `parseRotationConfig` parses four new rotation sub-keys (`roleFallbackOnSwap`, `benchStreakDecayMs`, `benchMaxMs`, `forceProbeRound`) (NOT `RECOGNIZED_KEYS` — R10: that list is top-level only, config.ts:141) |
| `extensions/swarm/src/commands/pool.ts` | `/swarm pool validate` renders the new keys; `/swarm pool list` cooldown line shows `benchStreak` when > 1 (observability for D1/D3) |
| `extensions/swarm/src/constants.ts` | defaults (`ROLE_FALLBACK_ON_SWAP`, `BENCH_STREAK_DECAY_MS`, `BENCH_MAX_MS = 3_600_000`) + env names; R9: `POOL_SCAFFOLD_YML_PLACEHOLDER` + `POOL_SCAFFOLD_GLOBAL_YML_PLACEHOLDER` gain commented `# roleFallbackOnSwap: true` / `# benchStreakDecayMs: 21600000` / `# benchMaxMs: 3600000` lines in the rotation block (same comments-only pattern the agentGc scaffold used) |
| `docs/swarm/tools.md` | §configuration: D5 `forceProbeRound`, full-round semantics, ≤1h automatic probe guarantee, and explicit statement that proxy provider identity does NOT group model quotas |
| `docs/swarm/pi-runtime-contract.md` | no §10 row (no claim change); note R10-1 tests added for the bypass path in the PR description |
| `CHANGELOG.md` | entry after green |

## 3. Fixtures (compulsory, mock-llm — deterministic, offline)

1. **`pool-roles-fallback-swap.jsonl`** (D2, Pattern: `pool-upstream-buffer-limit.jsonl`) — model id = stem, `roles:[root]`, provider `mock-llm`. Turn 1: single 429 `usage_limit_reached` error (the F16 single-strike shape). Companion **`pool-roles-fallback-alt.jsonl`** — the healthy untagged slot the bypass must land on; its turn 1 completes the task (calls `swarm_check_mailbox` + `swarm_send_message` + stop). Lane setup seeds: `.pi/swarm.yml` pool = [main (roles root), other-root (roles root, **pre-benched** via seeded `pool-state.json` with future `cooldownUntil`), alt (untagged)]; seeded `swarm-state.json` root agent `roleKind:"root"`. Expected green: `pool.swap` trace with `rolesIgnored:true` to `mock-llm/pool-roles-fallback-alt`; turn 2 transcript exists under the alt model; main slot benched exactly once (D1 also observable: its `cooldownUntil` equals the first bench, `benchStreak` === 1).
2. **`pool-rebench-while-benched.jsonl`** (D1 terminal case) — pool = [main (roles root), other-root (roles root, pre-benched long)] and NO untagged slot ⇒ true no-candidate even after bypass. Turn 1: 429 error (bench applied). Turn 2 (user retry, still on benched main): 429 again. Green assertions: `cooldownUntil` after turn 2 **identical** to after turn 1; `benchStreak` still 1; one throttled `no_candidate` notify; `pool.swap_no_candidate` traced. **[Deferred 2026-10-14, design-review note: D1 carry-over is covered by the pure suite 4.1 S1 (plus S2c manual-conversion) and the D2 lane's single-bench assertion; the terminal no-candidate throttle path is covered by pure 4.2 S2. Revisit before Stage 3 D5 lands, since D5 changes the no-candidate branch itself.]**
3. **`pool-bench-streak-decay.jsonl`** (D3) — single healthy scripted turn. Lane pre-seeds `pool-state.json` for the running model: `benchStreak: 5`, `lastBenchAt = now - 7h`, `lastBenchReason: "quota"`. Green: after the run `benchStreak === 0`, `lastBenchReason` still `"quota"` (recovery-gate preservation), trace `pool.slot_success`. **[Deferred 2026-10-14, design-review note: covered by pure suite S4/S4b in 4.1 instead; revisit if a runtime-only decay regression appears.]**
4. **`pool-probe-round-a.jsonl` / `pool-probe-round-b.jsonl` / `pool-probe-round-c.jsonl`** (D5, compulsory E2E): seeded root begins on A; B and C are both pre-benched with future cooldowns. A emits quota error, B emits quota error, C succeeds. Expected transcript/trace: A → B → C in canonical modelPool order, exactly one `pi.setModel` per transition; B was selected despite `cooldownUntil`; C success clears durable `poolProbeRounds.root`; no slot repeats. Companion all-fail variant A/B/C errors: emits exactly one `pool.probe_round_exhausted`, persists `nextProbeAt <= now+1h`, and root-pump wake starts the next round once (not an immediate loop).
5. Companion lane tests **`extensions/mock-llm/tests/pool-roles-fallback-swap.test.mjs`**, **`pool-rebench-while-benched.test.mjs`**, **`pool-bench-streak-decay.test.mjs`**, **`pool-probe-round.test.mjs`** — real `pi -ne -e ./extensions/mock-llm -e ./extensions/swarm --provider mock-llm --model <stem>` in scratch cwd (pattern `pool-upstream-buffer-limit.test.mjs`), asserting pool-state + durable round state + traces + transcripts.

## 4. RED tests (written first, observed red, land minimal fix, green — the red artifact IS the regression test)

### 4.1 `extensions/swarm/tests/pool-bench-streak.test.mjs` (D1 + D3, pure, pattern `pool-quota.test.mjs`)

- **S1 THE REPRODUCTION (D1):** seed health `{benchStreak: 3, cooldownUntil: now+2h, lastBenchReason:"quota", lastBenchMs:…}`; call `recordProviderError(quota)`; assert `cooldownUntil` unchanged AND `benchStreak` still 3 AND `failures === 0` (R2) AND `lastErrorAt` updated AND trace carries `benchedAlready:true`. (RED today: cooldown rolls + streak → 4 + failures climbs.)
- S2: expired bench (`cooldownUntil: now-1s`) → normal path: streak 3→4, fresh `cooldownUntil` ≈ base × 2³ **capped at `benchMaxMs`** (with default 1h ceiling: expected exactly 1h).
- **S2d (D4 ceiling):** with defaults, streak 3 re-bench → bench length exactly `benchMaxMs` (1h), not base × 2³ = 2h; streak 100 → still 1h; `auth` kind → capped at `benchMaxMs` (auth included, no 6h floor); custom `rotation.benchMaxMs: 7200000` respected; `PI_SWARM_BENCH_MAX_MS` env override respected; invalid (`benchMaxMs: 0` / negative) → `validateSwarmSettings` reject.
- S2b (R3 severity escalation): seed `{cooldownUntil: now+15m, lastBenchReason:"rate_limit", benchStreak:1}`; `recordProviderError(auth)` → cooldownUntil extends past the 15m rate_limit bench, `lastBenchReason === "auth"`, streak 2, `lastBenchAt` stamped. And the mirror: seed quota bench now+1h, error `rate_limit` → carried over unchanged (15m new bench is shorter).
- S2c (R3 manual conversion): seed manual bench `{cooldownUntil: now+5m}` (no reason); quota error → converts to error-driven, extends. rate_limit error → stays manual.
- S3: manual bench (`lastBenchReason` absent) + `rate_limit` error while benched → stays manual (no reason stamp, no extension) (folded into S2c).
- S4 (D3, R1-aware): decay must fire on the SECOND healthy turn too — seed `{benchStreak:5, lastBenchAt: now-7h, lastBenchReason:"quota", lastError:"…"}` (the `lastError` keeps the FIRST success past the existing early-return); call `recordSlotSuccess` twice; after the 2nd call assert `benchStreak === 0`, `lastBenchReason` preserved, `lastBenchAt` preserved (not wiped). Additional: seed with early-return shape `{benchStreak:5, lastBenchAt: now-7h}` and NO lastError → the AMENDED guard must still decay (this is the R1 regression case: today's code early-returns and skips decay). With `lastBenchAt: now-1h` → streak stays 5; with `PI_SWARM_BENCH_STREAK_DECAY_MS=0` → decay off.
- S4b (R5 manual stamping): `setSlotCooldown(key, 3600000)` stamps `lastBenchAt`; `setSlotCooldown(key, null)` deletes it.
- S5: `validateSwarmSettings` accepts/rejects the new rotation keys (`roleFallbackOnSwap:"yes"` → reject; negative `benchStreakDecayMs` → reject).

### 4.2 `extensions/swarm/tests/pool-roles-swap-fallback.test.mjs` (D2, pure, pattern `pool-roles.test.mjs` case E)

- **S1 THE REPRODUCTION (D2):** pool [A(roles root, =current, erroring), B(roles root, benched), C(untagged healthy)]; drive `turn_end {stopReason:"error", quota}` through the registered hook with a stub `pi` capturing `setModel`; assert `setModel` called once with C, `pool.swap` trace has `rolesIgnored:true`. (RED today: `swap_no_candidate`, zero `setModel`.)
- S2: all slots benched → bypass also empty → no `setModel`, `swap_no_candidate` traced, `ctx.ui.notify` fired exactly once per 5-min window across 3 consecutive error turns (throttle; call `_resetNoCandidateNotifyForTests()` between sub-cases, R6), zero `pi.sendMessage`; headless shape (`ctx.hasUI === false`) does not throw (R4).
- S3: `rotation.roleFallbackOnSwap: false` + env off → old behavior (no candidate, no bypass attempt).
- S4: bypass swap bumps the swap chain (3rd bypass within 5 min → `pool.swap_chain_capped`).
- S5: bypass pick may land on a differently-tagged slot (e.g. `[reviewer]`) — allowed, traced `rolesIgnored:true`.

### 4.3 `extensions/swarm/tests/pool-probe-round.test.mjs` (D5, RED first)

- **S1 THE REPRODUCTION:** seed A=root current, B/C future-cooldown; role tags restrict root to A/B; drive exhausted quota on A. Assert desired result A→B, despite B cooldown and role restriction; current code fails red with `pool.swap_no_candidate` or ordinary D2 fallback skips B.
- S2: A→B→C: A/B error, C success. Assert canonical order, each slot appears once, all `triedSlots` marks are written before corresponding fake `setModel`, success clears `poolProbeRounds.root`, cooldown on successful C clears through `recordSlotSuccess`.
- S3: A/B/C all fail. Assert no duplicate `setModel`, one `pool.probe_round_exhausted`, durable `nextProbeAt` equals earliest cooldown and ≤now+1h under D4; no immediate fourth probe.
- S4: restart/reload between B selection and its error: rehydrate `poolProbeRounds` and assert C next (B cannot be retried); state with stale `nextProbeAt` emits one wake then opens a new round.
- S5: `forceProbeRound:false` and `PI_SWARM_FORCE_PROBE_ROUND_OFF=1` retain D1/D2 behavior.
- S6: unresolvable registry slot is durably skipped with `pool.probe_round_slot_unresolvable`, does not consume a `pi.setModel`, and round continues.
- S7: a healthy normal `stop` turn clears a round; a gated transient first strike does not create/advance a round.

### 4.4 R10-1 boundary counting (per AGENTS.md Pi-runtime rule 4)

D2 existing counter remains. D5 adds real-boundary counters: A→B→C probe scenario has `pi.setModel === 2`, exactly one visible operator event + one hidden continuation per successful switch, and `triedSlots` cardinality equals 3; all-fail scenario has `pi.setModel === 2` then one due-time continuation `pi.sendMessage` (not N timers / no repeated wake). Restart before due must result in one total wake, counted at the real `pi.sendMessage` boundary. Static guard: new wake call site is confined to the designated root-pump owner; `pool.ts` remains Pi-API-free.

**Pi runtime contract update:** D5 adds a new L2 `pi.sendMessage({triggerTurn:true})` path from a durable due-time root-pump wake. Before implementation, update `docs/swarm/pi-runtime-contract.md §10` with a D5/R-row: L1 `poolProbeRounds.nextProbeAt/wakeSentAt` is written before L2; L2 has exactly one continuation per exhausted round across reload; L3 is hidden (no visible chat noise); L4 consumes the existing minimal continuation. Cite this row in the implementation diff.

### 4.5 Existing suites stay green

`pool-quota`, `pool-roles`, `pool-swap`, `pool-single-strike-nonretryable`, `pool-upstream-buffer-limit` (lane), `r12-pool-depleted-nudge`, `pool-bench-cooldown-recovery` fixture lane — the bench-semantics change must not regress Issue 17/21/22 behaviors.

## 5. Validation lane (tmux, per AGENTS.md)

Dedicated session `ext-validate-pool-fix-<hhmmss>`: `pi --provider mock-llm --model pool-roles-fallback-swap -e ./extensions/mock-llm -e ./extensions/swarm` in a scratch cwd seeded as §3.1; run the scripted quota strike; capture before/after pane (expect the `⚠ Pool … (roles fallback)` operator line and the post-swap completion); cite transcript dir + `pool-state.json` in the report.

## 6. Delivery order

1. Stage 1 (P0, one red-green cycle each): D4 (ceiling — smallest, unblocks the operator immediately) → D1 → D2 (D2's fixture reuses D1's single-bench assertion).
2. Stage 2 (P1): D3 decay + `/swarm pool list` observability + docs.
3. **Stage 3 (P0, new user-directed policy): D5 forced probe round** — add RED pure + mock-LLM fixtures first, then durable round state/selection, then due-time root-pump wake + R10 contract row/counters.
4. CHANGELOG after each green stage.

## 7. Out of scope

- Changing bench base durations, `MAX_SWAP_CHAIN`, `ENGINE_MAX_RETRIES`, or the engine-retry gate.
- ~~Lowering the auth bench floor or applying the `benchMaxMs` ceiling to auth benches~~ (superseded — the 6h floor never existed in code; see §1.3 amendment).
- Auto-`/swarm pool clear` or any un-benching automation (recovery scan + operator remain the un-bench paths).
- Making the roles filter non-strict for spawn (Issue 22 semantics untouched).
- Provider-level quota grouping/isolation. D5 deliberately treats every configured `provider/model` as independently probe-worthy even under the same proxy provider (`cliproxyapi`); the user states proxy models have distinct quota windows.
- Persisting `engineRetryIncidents` (deliberately ephemeral, see streaks.ts header).
