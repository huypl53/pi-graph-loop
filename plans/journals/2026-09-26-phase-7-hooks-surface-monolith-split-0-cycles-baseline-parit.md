---
title: "Phase 7 hooks/surface monolith split — 0 cycles, baseline parity"
date: 2026-09-26
summary: Decomposed swarm hooks.ts (1681→172 LOC facade + 8 submodules) and surface.ts (1369→~150 LOC facade + 10 submodules); extracted orphan-watch.ts to reach 0 madge cycles (HEAD had 39); full-suite ledger parity vs pristine-HEAD baseline; tmux mock-LLM R30 lane green
---

# Phase 7 hooks/surface monolith split — 0 cycles, baseline parity

## What happened

Executed Phase 7 of plans/260926-0218-swarm-refactor-terminal-manager via /ak:cook: split the two remaining runtime monoliths in extensions/swarm.

- src/hooks.ts (1,681 LOC) → 172-LOC facade + 8 submodules: hooks/{streaks,pump-manager,pool-swap,turns,session,settled,tools,shutdown-input}.ts. Shared mutable state (rootEditStreak, swapChain, engineRetryIncidents, swarmPi ref) consolidated in streaks.ts with accessor functions; watchdog/pump lifecycle in pump-manager.ts (startRootPump stays on the facade because root-wake.test.mjs C2/C7 greps hooks.ts source for the three literal error-classification statements — isStaleCtx/isIoTransient/isLeaderDenied).
- src/surface.ts (1,369 LOC) → facade + 10 submodules: surface/{session,warnings,actionable,staleness,ranking,pump,pump-phases,pump-decision,coalesce,pump-shared}.ts. pump.ts was itself 825 LOC so it got a second-level split (pump-phases/pump-decision/coalesce/pump-shared). r27b Guard-3 imports stay physically on the facade.
- src/orphan-watch.ts extracted (ORPHAN_TIMERS shared map + clearOrphanWatch + OrphanClearKind) and mailbox.ts dynamic import retargeted ./agents.ts → ./orphan-watch.ts; hooks/session.ts receives startRootPump via DI — madge now reports 0 circular dependencies across all 116 modules (HEAD: 39).

## Decision

- Map accessors instead of direct module-locals so pool-swap/session/settled/tools/shutdown-input share streaks.ts state without cycles.
- startRootPump kept as facade implementation + DI into registerSessionHooks (dynamic import also worked but madge follows dynamic imports, so DI was the honest cycle break).
- No new mock-LLM fixture: pure refactor phase; existing root-message-batching.jsonl exercises the changed pump/session surface (Phase 8 owns fixture work).
- Pre-existing red suites (30) NOT fixed here — fail-multisets diff-verified identical to pristine HEAD baseline (/tmp/swarm-head-baseline/ledger.txt vs /tmp/swarm-current/ledger.txt); only shared-suite diff is pool-config 1→0 from the pre-existing uncommitted env fix.

## Next steps

- Phase 8: verification, mock-LLM fixture & live validation.
- Watch items: hooks/settled.ts is 312 LOC (over the <300 target, disclosed); 14 tools/5 commands/11 hooks registration must stay stable in Phase 8 checks.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
