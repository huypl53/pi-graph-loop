---
title: "Phase 3: Types Breakdown & Circular Dependency Cleanup"
status: completed
---

# Phase 3: Types Breakdown & Circular Dependency Cleanup

## Overview

Decompose monolithic `extensions/swarm/src/types.ts` (1,038 LOC) into focused type definition files under `extensions/swarm/src/types/`. Remove phantom unused imports across `types.ts`, `utils.ts`, `session.ts`, and `delivery.ts` that create artificial cycles. Extract settings management into `src/config.ts` to sever the `session.ts <-> pool.ts` cycle. Reduce circular dependency cycles in `src/` from 23 down to 0.

## Requirements

- [x] Create `src/types/` directory:
  - `types/agents.ts`
  - `types/tasks.ts`
  - `types/messages.ts`
  - `types/pool.ts`
  - `types/state.ts`
  - `types/loops.ts`
- [x] Turn `src/types.ts` into a backward-compatible barrel re-exporting all types.
- [x] Move runtime functions (`classifyProviderError`, `scrubErrorIdentity`) out of `types.ts` into `src/pool.ts` or `src/errorlog.ts`.
- [x] Remove phantom unused imports:
  - `types.ts:2-4`: remove unused imports of `reconcile`, `tmux`, and `writeEffectiveIdentity`.
  - `utils.ts:15`: remove unused import of `trace` from `state.ts`.
  - `session.ts:16`: remove unused import of `ensureRoot` from `identity.ts`.
  - `delivery.ts:8`: remove unused imports of `deliver` and `reconcile`.
- [x] Resolve remaining cycles:
  - Move settings parsing to `src/config.ts` so `session.ts` and `pool.ts` don't depend on each other.
- [x] Verify circular dependency count drops to 0 using a cycle check.

## Related Code Files

- Modify: `extensions/swarm/src/types.ts` (convert to barrel)
- Modify: `extensions/swarm/src/utils.ts` (remove phantom import)
- Modify: `extensions/swarm/src/session.ts` (remove phantom import)
- Modify: `extensions/swarm/src/delivery.ts` (remove phantom import)
- Modify: `extensions/swarm/src/config.ts` (consolidate settings parsers)
- Create: `extensions/swarm/src/types/agents.ts`
- Create: `extensions/swarm/src/types/tasks.ts`
- Create: `extensions/swarm/src/types/messages.ts`
- Create: `extensions/swarm/src/types/pool.ts`
- Create: `extensions/swarm/src/types/state.ts`
- Create: `extensions/swarm/src/types/loops.ts`

## Implementation Steps

1. Create modular files in `src/types/`:
   - Group interfaces cleanly by domain.
   - Keep field definitions intact.
2. In `src/types.ts`, export `* from "./types/..."`.
3. Strip unused imports in `types.ts`, `utils.ts`, `session.ts`, `delivery.ts`.
4. Relocate `classifyProviderError` to `src/pool.ts` and re-export from `types.ts` for backward compatibility.
5. Run automated cycle check to confirm 0 circular dependencies.
6. Run `npm run test:swarm` to confirm all 117 tests pass.

## Todo

- [x] Create `src/types/*.ts` modules
- [x] Convert `src/types.ts` to barrel re-export
- [x] Strip phantom imports
- [x] Verify 0 circular dependency cycles
- [x] Run test suite verification

## Success Criteria

- Circular dependency cycles in `extensions/swarm/src` = 0.
- All 117 tests in `extensions/swarm/tests` pass without errors.
- Every type file in `src/types/` is under 300 LOC.
