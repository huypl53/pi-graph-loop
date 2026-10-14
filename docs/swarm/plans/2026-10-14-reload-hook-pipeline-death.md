# Plan: Silent hook-pipeline death after /reload — stale-ctx kills pool hooks + root pump with no durable census

> **Status:** PLAN (2026-10-14) — reproduce-first mandate applies: the RED test in §4 must be observed failing BEFORE any source fix lands.
> **Live incident:** session `01a135e8` (project `workflow-agents`, 2026-10-14 01:35Z). Root pane ran a `/reload` at 01:35:17Z (`self-reload/history.json` rel-…-evxj, trigger `manual_reload`). After it: **zero** pool hook events from root for the next ~46 min despite 5 provider-error turns (02:19, 02:39, 02:46, 03:31, 03:33) and 1 success turn (03:11) — no `pool.swap_gated`, no `pool.slot_failure`, no bench, no swap, no durable error. The root pool machinery was offline; every quota error after 01:35 hit an unprotected serving slot. Recovery only at 02:21:41Z when a manual `/swarm register` (trace `agent.root_optin via=register-command`, pid 41909) re-armed the pump.
> **Pi runtime contract:** touches `ctx.reload`/session-replacement semantics (contract §6), hook-dispatch error semantics (§9), and the root pump watchdog (§10 F6/F11 rows consulted). New §10 row **F29** added (§5). No new `pi.sendMessage` call sites → R10-1 boundary-counting test updated only if counts change (they must not).

## 0. Problem — evidence chain (all timestamps 2026-10-14 UTC, project `workflow-agents`)

| # | Fact | Evidence |
|---|---|---|
| 1 | Root pump (pid 47539) ticked normally until 01:35:14.258Z (10 ticks/sec — see §0.1 secondary defect) | `events.jsonl` `mailbox.root_pump cid=47539` |
| 2 | At 01:35:15.5Z the extension ctx went stale mid-tick: **six** pump-phase error events in the same second (`graph.reconcile_error`, `task.initial_ready_reconcile_error`, `task_stall.nudge_error`, `goal.nudge.error`, `worker.artifact_progress_nudge_error`, `pool.slot_recovered.error`), all `"This extension ctx is stale after session replacement or reload…"` | `events.jsonl` 01:35:15.540–.543; `errors.jsonl` `issues.auto_continue_failed` / `issues.footer_failed` (reason `watchdog`) |
| 3 | Cause: `/reload` in the root pane at 01:35:17.9Z (teardown invalidates the runner at `agent-session.js:1003` BEFORE the new runner is built; self-reload history entry 01:35:17.936) | `.pi/self-reload/history.json` |
| 4 | After the reload, **the root pump never came back** in that process: last 47539 pump tick 01:35:14.258Z; no `root.pump.denied` trace; no pump ticks at all until 02:21:41Z (`reason=register-root`, pid 41909) | `events.jsonl` |
| 5 | `turn_end` pool-swap hook died with the runner: 5 provider-error turns (02:19:30, 02:39:23, 02:46:49, 03:31:23, 03:33:34) produced ZERO `pool.*` events from root; a worker in the same window (p9-mount-fixer2, 02:33) fired its hooks fine — the death is per-process, not global | session jsonl vs `events.jsonl` |
| 6 | Handler throws after invalidation are **swallowed at the dispatch layer**: `runner.emit()` catches every handler error → `emitError` → TUI-only toast (`showExtensionError`). No durable trace, no `errors.jsonl` row | pi `runner.js:813-835`; TUI `onError:err=>{showExtensionError(...)}` |
| 7 | The watchdog's stale-ctx stop is by design ("next `session_start` re-arms"), and pi DOES re-emit `session_start {reason:"reload"}` after a reload — but the pump did NOT re-arm (fact 4). Either the re-fire never reached the swarm hook or it threw silently (per fact 6). **The re-arm contract is unobservable and unhealed** | `hooks/pump-manager.ts` stale-ctx branch; `agent-session.js` reload → `emit({type:"session_start", reason:"reload"})` |

**Net effect:** for 46 minutes the root agent operated with no bench, no swap, no retry, no probe round, and no durable record that anything was wrong — the exact "no silent error swallowing" class the runtime contract and the errorlog mandate target.

### §0.1 Secondary defect observed in the same traces (out of scope here, filed for follow-up)

The dead pump ran at **~10 ticks/sec for ~13 hours** (3,061 ticks in 01:30–01:35 alone; 190k+ pump events across Oct 12–14) — `ROOT_PUMP_INTERVAL_MS` is 5000 ms, so the watchdog re-arm path was multiplying timer chains (~48×). The `agent_settled` re-arm guard (`!getRootMailboxTimer()` in `hooks/settled.ts:61`) is racy against the tick's own `rootMailboxTimer = undefined` window (the handle is cleared at tick START, before the pump runs), so every settle during an in-flight tick can install a SECOND chain. Follow-up plan needed; this plan's fixes must not widen that race (R2 asserts a single chain).

## 1. Contract

### 1.1 D7 — durable census for extension hook failures

Every swarm hook handler failure currently dies in pi's `runner.emit()` catch → `emitError` → TUI toast only. The swarm extension must record these durably.

- Verify the pi `ExtensionAPI` error surface first (RED R3 pins which): if `onError` (or equivalent) is exposed, subscribe and route every extension error to `logSwarmError(cwd, "hooks", "hook_dispatch_error", err, { event })`.
- If no API surface exists, use wrapper discipline instead: every swarm `pi.on(...)` handler body is wrapped so a throw is caught, routed to `logSwarmError(..., { event, phase })`, and re-thrown (preserve pi's own toast behavior; we only ADD durability, never swallow).
- Stale-ctx errors (`/stale after session/`) are `expected(reason)`-compacted per the mandate: logged once per invalidation epoch (dedupe key `stale-ctx`), not per error turn.

### 1.2 D8 — pump and pool hooks must self-heal after session replacement/reload

- The stale-ctx stop in the watchdog tick is correct; the BUG is the re-arm dependency: only `session_start` (which the live incident shows did not reach `startRootPump`) or a manual `/swarm register` can restore it.
- Fix shape (bounded, no busy-loop):
  1. `session_start {reason:"reload"}` handler: any throw before `startRootPump` is caught, logged via `logSwarmError(cwd, "hooks", "session_start_reload_failed", err)` (D7 wrapper), and the pump is STILL armed with the fresh ctx — arming is ctx-free file IO (`startRootPump` preflight uses `withLock`/`readState`, not ctx methods).
  2. Watchdog stale-ctx stop records a durable stop stamp (`rootPumpStop {reason, at}` in swarm state). The next `agent_settled` re-arm guard drops the `isRootPumpCtxFresh()` veto when a stale stop is recorded and the settle ctx is fresh — re-arming against the FRESH settle ctx (never the dead captured one).
  3. No timer multiplication: re-arm paths still go through `armRootPumpWatchdog`'s `clearTimeout` (idempotent replace); R2 asserts one chain.

### 1.3 Invariants

- No new `pi.sendMessage` call sites (R10-1 boundary count must be unchanged).
- No silent swallowing: every new catch routes to `logSwarmError` (contract §9; mandate 2026-09-08).
- The watchdog must never busy-loop on a permanently stale ctx: stale-ctx re-arm requires a FRESH ctx (from settle/session_start), never the captured dead one (preserves Issue 11's safety intent).
- `errors.jsonl` remains the single internal-error census (no alternate sinks).
- Guests (`currentAgentId() !== "root"`) unaffected.

## 2. Files

- `extensions/swarm/src/hooks.ts` — registerSwarmHooks wrapper/subscribe (D7), session_start reload robustness (D8.1)
- `extensions/swarm/src/hooks/pump-manager.ts` — watchdog stale-stop durable stamp (D8.2)
- `extensions/swarm/src/hooks/settled.ts` — re-arm guard consumes the stale-stop record
- `extensions/swarm/src/state.ts` — `rootPumpStop` field on SwarmState + migration tolerance
- Tests: `extensions/swarm/tests/hook-stale-ctx-census.test.mjs` (new), `extensions/swarm/tests/pump-stale-rearm.test.mjs` (new)
- Docs: `docs/swarm/pi-runtime-contract.md` §10 row F29; `docs/swarm/architecture.md` hook-failure paragraph

## 3. Fixture (compulsory, mock-llm — deterministic, offline)

- `extensions/mock-llm/fixtures/pool-reload-hook-death.jsonl` — root turn A OK → scripted reload boundary (`ctx.reload` via scripted tool call) → turn B hits a canned provider error → lane asserts EITHER `pool.swap_gated` in the fresh runner's traces OR `internal.error {op:"hook_dispatch_error"}` in `errors.jsonl` — never silence.
- Reuse timing-control patterns from the 429-mid-edit fixtures (delayMs, explicit error injection, lowercase pi-builtin tool names). If the reload boundary cannot be scripted deterministically in the lane, state why in the plan artifact and use the unit tests R1–R4 as the deterministic proxy (mandate allows a named deterministic proxy).

## 4. RED tests (written first, observed red, then minimal fix; the red artifact IS the regression test)

- **R1** (`pump-stale-rearm.test.mjs`): arm watchdog → force a stale-ctx error through the tick path → assert `stopRootPump` + durable stop stamp; then simulate `agent_settled` with a FRESH ctx → assert pump re-arms (timer reinstalled). RED today: settle re-arm is blocked by `isRootPumpCtxFresh()===false` with no stamp → no re-arm, ever.
- **R2** (`pump-stale-rearm.test.mjs`): stale stop must NOT re-arm against a dead ctx and must NOT multiply timers (assert exactly one pending timer after re-arm).
- **R3** (`hook-stale-ctx-census.test.mjs`): handler throwing stale-ctx → `errors.jsonl` gains `hook_dispatch_error` with `expected` compaction (one row per epoch, not per turn). RED today: nothing is logged.
- **R4** (`hook-stale-ctx-census.test.mjs`): non-stale handler throw → logged per occurrence (no compaction).
- **R5** (mock-llm lane `pool-reload-hook-death`): full-pipeline assertion per §3.
- **R6** (R10-1 boundary-counting): count of `pi.sendMessage` / `pi.setModel` call sites in pool-swap + pump paths unchanged by the fix.

## 5. Pi runtime contract row (new)

- **F29 — hook dispatch errors had no durable census; a stale-ctx stop left the root pump dead until manual re-arm.** Claims updated: (false→fixed) "a `/reload` in a root pane re-arms the root pump via session_start"; (false→fixed) "extension hook failures are visible in traces/errors.jsonl". Four-layer accounting: L1 mailbox unaffected; L2 no new sends (the re-arm path adds none); L3 TUI toast unchanged; L4 handler consumption unchanged until re-armed.

## 6. Delivery order

1. RED R1–R4 observed red (unit, offline, ms-scale).
2. Minimal fix D7 (census) → R3/R4 green.
3. Minimal fix D8 (durable stop stamp + settle re-arm) → R1/R2 green.
4. Mock-llm fixture + lane → R5 green (cites `.pi/mock-llm/transcripts/` evidence).
5. Docs: contract F29 + architecture paragraph + CHANGELOG.

## 7. Out of scope

- §0.1 timer-multiplication runaway (separate plan; do not fix here beyond not regressing).
- The hot-loop's original trigger (why the pump ticked 10×/sec at all) — same follow-up.
- pi upstream dispatch behavior (TUI toast stays; we add durability on top).
- workflow-agents live session recovery (user handles it).
