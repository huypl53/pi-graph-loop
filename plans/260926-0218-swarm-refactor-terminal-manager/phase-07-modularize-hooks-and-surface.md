---
title: "Phase 7: Modularize Runtime Hooks & Root Mailbox Surface"
status: completed
completed: 2026-09-26
---

# Phase 7: Modularize Runtime Hooks & Root Mailbox Surface

## Overview

Decompose `hooks.ts` (1,681 LOC) into structured hook listeners under `extensions/swarm/src/hooks/` (<300 LOC each). Decompose `surface.ts` (1,369 LOC) into root message routing and pump submodules under `extensions/swarm/src/surface/` (<350 LOC each). Maintain all Pi Runtime Contract invariants (batch coalescing, single-turn triggers) and preserve static regex assertions required by `r27b-pump-import-guards.test.mjs` and `root-wake.test.mjs`.

## Requirements

- [x] Decompose `hooks.ts` into `src/hooks/`:
  - `hooks/pump-manager.ts`: root pump interval watchdog (stopRootPump / armRootPumpWatchdog / surfaceAgentPending, ROOT_PUMP_INTERVAL_MS=5_000, watchdog state accessors).
  - `hooks/streaks.ts`: edit streak tracking, swap chain limiter (swapChain Map, MAX_SWAP_CHAIN=2, SWAP_CHAIN_RESET_MS), engineRetryIncidents map + `engineRetryIncidentsMap()` accessor, swarmPi get/set.
  - `hooks/settled.ts`: `agent_settled` handler (reconciliation, goal epoch, idle nudges, auto-focus).
  - `hooks/session.ts`: `session_start`, `before_agent_start`, `agent_start` (`session_shutdown` + `input` live in `hooks/shutdown-input.ts` — structural deviation from plan, all hooks still registered).
  - `hooks/tools.ts`: `tool_execution_start`, `tool_execution_end`, `tool_result`.
  - `hooks/turns.ts`: `SWARM_RESOLVE_TOOLS` + `turnEndIsResolveAction`, `turn_start`, `turn_end` goal-resolve (pool-swap `turn_end` lives in `hooks/pool-swap.ts` and registers BEFORE turns — R30-adjacent order preserved).
  - `hooks/shutdown-input.ts` (additional module): `session_shutdown` + `input` (steering intercept / Issue 86 interrupt).
  - `hooks/pool-swap.ts` (additional module): turn_end model-pool auto-swap with engine-retry gate + MAX_SWAP_CHAIN cap.
  - NOTE: no separate `hooks/index.ts` — `src/hooks.ts` facade itself performs `registerSwarmHooks` in the load-bearing order (pool-swap → turns → session → settled → tools → shutdown-input).
- [x] Preserve literal error classification statements in `src/hooks.ts` facade (startRootPump implementation stays on the facade):
  - Physically contains (verified by `root-wake.test.mjs` C2/C7 static check, 31/3 fail-multiset IDENTICAL to HEAD baseline):
    - `/const isStaleCtx = \/stale after session\/i\.test\(msg\)/`
    - `/const isIoTransient = \/EACCES\|ENOSPC\|EROFS\|EAGAIN\|EBUSY\|ENFILE\|EMFILE\//`
    - `/const isLeaderDenied = msg\.startsWith\("ROOT_LEADER_DENIED"\)/`
- [x] Decompose `surface.ts` into `src/surface/`:
  - `surface/pump.ts` (283): `pumpRootMailbox` loop, leader lease, L2 batch delivery via `pi.sendMessage` (R30 single-send preserved, r30 13/13).
  - `surface/pump-phases.ts` (148): `runPumpMaintenancePhasesLocked` (GC, stale-open, stall nets).
  - `surface/pump-decision.ts` (309): migration back-fill + dedupe gate + busy-defer + census (owns sess/surfaced/triggeredAt/retriggerCount/keepalive state).
  - `surface/coalesce.ts` (210): Row 68 revalidation, R13 P0 bypass + P1 liveness gate, groupKey coalescing, receipt write-back.
  - `surface/pump-shared.ts` (12): `fingerprintMessage`.
  - `surface/actionable.ts` (181): message actionability rules, task node reference parsing.
  - `surface/staleness.ts` (156): `staleSurfaceReason`, suppression trace deduplication (also owns `traceStaleSuppressedOnce` retargeted from nudges/graph-advance).
  - `surface/ranking.ts` (19): candidate priority sorting and group keys.
  - `surface/warnings.ts` (46): `runtimeTaskWarnings`.
  - `surface/session.ts` (78): orchSession per-pid surface session gate.
- [x] Maintain static imports in `src/surface.ts` facade for `r27b-pump-import-guards.test.mjs`:
  - Physically declares `checkStallNotificationStale`, `evaluateIdleGoalNudgeLocked`, `updateIdleEpochLocked`, `allEffectiveIdleAgents` imports (Guard 3, r27b 9/9).
- [x] Verify `r30-root-message-batching.test.mjs` (13/13), `root-wake.test.mjs` (fail-multiset IDENTICAL), and `r27b-pump-import-guards.test.mjs` (9/9).

## Related Code Files

- Modify: `extensions/swarm/src/hooks.ts` (converted to 172-LOC facade preserving classification regexes)
- Modify: `extensions/swarm/src/surface.ts` (converted to facade preserving static imports)
- Create: `extensions/swarm/src/hooks/*.ts` (8 modules)
- Create: `extensions/swarm/src/surface/*.ts` (10 modules)
- Create: `extensions/swarm/src/orphan-watch.ts` (cycle-break: shared ORPHAN_TIMERS map + clearOrphanWatch extracted from agents.ts; mailbox.ts dynamic import retargeted from `./agents.ts` → `./orphan-watch.ts`)

## Implementation Steps

1. ✅ Extract `src/surface/` submodules; wire facade keeping explicit import statements for `r27b-pump-import-guards.test.mjs`; `r30` + `r27b` green.
2. ✅ Extract `src/hooks/` submodules; singletons live in `hooks/streaks.ts` / `hooks/pump-manager.ts` with accessor functions (`bumpRootEditStreak`, `setRootEditStreak`, `getSwarmPi`, `engineRetryIncidentsMap`, `peekSwapChain`, `bumpSwapChain`); facade retains startRootPump + error classification regex block; `root-wake` + `pump-retrigger.validate` green.
3. ✅ Zero bare catches in new code (`grep -rnE "catch\s*\{\s*\}" src/hooks/ src/hooks.ts src/surface/ src/surface.ts src/orphan-watch.ts` → 0; all 51 `.catch(() => {})` nets in new modules verified trace/logSwarmError-protected within a 10-line window).
4. ✅ Full test suite run (ledger parity, below).

## Todo

- [x] Extract `src/surface/*.ts` modules
- [x] Convert `src/surface.ts` to facade preserving static imports
- [x] Extract `src/hooks/*.ts` modules
- [x] Convert `src/hooks.ts` to facade preserving error classification
- [x] Run test suite verification

## Success Criteria

- ✅ Both original files reduced to clean facades (hooks.ts 172 LOC, surface.ts ~150 LOC; largest submodule hooks/settled.ts 312, surface/pump-decision.ts 309).
- ✅ All Pi Runtime Contract tests pass green with zero extra turns or dropped messages (r30 13/13, r27b 9/9, high-priority-interrupt 36/36, liveness-progress 40/40, register-adopt 25/25, mailbox-kickoff 8/8, r31 12/12, pool-override 42/42, pool-retry-settle-nudge 6/6, pool-swap-nudge-content 6/6, idle-streak-reset 6/6, lifecycle-fencing 28/28, inferred-lifecycle 10/10, tool-gating 14/14, pump-retrigger + graph-advance validate ALL PASS).
- ✅ Static regex assertions in `r27b` and `root-wake` pass (root-wake fail-multiset IDENTICAL to HEAD baseline: 31 passed, 3 failed — same 3).

## Verification Evidence (2026-09-26)

- **Cycle count**: madge over all 116 modules → **0 circular dependencies** (HEAD: 39). Added `src/orphan-watch.ts` (ORPHAN_TIMERS shared map + `clearOrphanWatch` + `OrphanClearKind`) so `agents.ts` and `mailbox.ts` no longer reference each other; `hooks/session.ts` receives `startRootPump` via DI from the facade instead of importing it (breaks facade↔submodule cycle).
- **tsc parity**: `npx tsc --noEmit … src/hooks.ts src/hooks/*.ts src/surface.ts src/surface/*.ts` → 13 errors, all pre-existing classes identical to HEAD (tmuxAlive ×8, actionableGraphDeferredAt ×2, HealthStatus "stale" ×2 +1); `src/agents.ts` → 3 errors = HEAD-identical tmuxAlive class (was 5 pre-phase incl. 2 nudges errors now in nudges modules).
- **Full-suite ledger parity** (`/tmp/swarm-current/ledger.txt` vs pristine-HEAD `/tmp/swarm-head-baseline/ledger.txt`): 117 common suites; only shared-suite diff `pool-config.test.mjs` 1→0 (pre-existing uncommitted env fix in worktree test copy, disclosed in phase-2); 30 pre-existing red suites fail IDENTICALLY (fail-multiset diff-verified per-suite: root-wake, idle-nudge, supersession-fencing, cancellation, heartbeat-gc, pool-quota/retry/swap, minimal-protocol-shadow, model-routing, ct-contract-probes, r17-ct2-real-lane, r25, reconcile-reinject, send-keys-*, …); phase-2 driver suites herdr-driver 16/0 + terminal-driver 4/0 green post-split.
- **tmux mock-LLM lane** (AGENTS.md extension-validation checklist):
  - tmux target: session `pgl-phase7-validation` (dedicated, destroyed after capture)
  - command: `pi --provider mock-llm --model root-message-batching -e ./extensions/mock-llm -e ./extensions/swarm`
  - actions: loaded extension (banner: `background-tasks, cron, deps, mock-llm, provider.ts, swarm, tool-timeout.ts, utils`), sent `hi`, fixture ran to completion
  - result: PASS — "Lane complete: multiple worker messages successfully processed via batched delivery with single turn trigger"; swarm registered 14 tools / 5 commands / 11 hooks; smoke.test.mjs independently prints `registered 14 tools, 5 commands, 11 hooks / SMOKE PASS`
  - logs: pane capture `/tmp/phase7-pane-final.txt`; transcripts `.pi/mock-llm/transcripts/root-message-batching/`; traces `.pi/swarm/traces/events.jsonl` (observed `mailbox.root_pump` + `notification.batch.suppressed`).

## Disclosures / Deviations

- **Dead code dropped**: duplicate `ackRootNudgeLocked` / `ackRootGraphAdvanceNudgesLocked` copies in old surface.ts were unreachable (live copies remain in `src/nudges/graph-advance.ts`).
- **Structural deviations from plan**: `session_shutdown` + `input` live in `hooks/shutdown-input.ts` rather than session.ts/turns.ts; pool-swap `turn_end` in its own module; no `hooks/index.ts` (facade is the registration entry). All hooks still registered; registration order preserved.
- **LOC caps**: hooks submodules ≤312 (`settled.ts` 312 vs <300 target — disclosed, kept single-file for coherence; rest ≤285). Surface submodules ≤309 vs <350 ✅.
- **Pre-existing failures not fixed** (per phase-2/6 disclosures): 30 suites red at pristine HEAD remain red with identical fail-multisets (retired `swarm_register_agent` tools, RESPONSE_REQUIRED gate default, ROOT_AUTHORITY_REQUIRED functional lane, missing r17-ct2 fixture).
- **Mock-LLM fixture**: no new fixture authored — Phase 7 is a pure refactor; the existing `root-message-batching.jsonl` scenario exercises the changed pump/session surface end-to-end (per plan Phase 8 deferral note).
