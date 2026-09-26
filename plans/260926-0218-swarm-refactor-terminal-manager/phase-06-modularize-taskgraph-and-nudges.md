---
title: "Phase 6: Modularize Task Graph & Graph Advance Nudges"
status: completed
completedAt: "2026-09-26"
---

# Phase 6: Modularize Task Graph & Graph Advance Nudges

## Overview

Decompose `taskgraph.ts` (2,203 LOC) into focused graph algorithm and state transition modules under `extensions/swarm/src/taskgraph/` (<300 LOC each). Decompose `nudges/graph-advance.ts` (1,073 LOC) into dedicated nudge engines under `extensions/swarm/src/nudges/` (<250 LOC each). Verify and protect `agentIsEffectivelyAlive` in `nudges/goal-epoch.ts` against false dead-worker escalations.

## Requirements

- [ ] Decompose `taskgraph.ts` into `src/taskgraph/`:
  - `taskgraph/index.ts`: backward-compatible facade re-exporting all functions.
  - `taskgraph/scope.ts`: scope resolution, pattern normalization, active lease collisions.
  - `taskgraph/attention.ts`: node attention scoring, staleness checks.
  - `taskgraph/graph.ts`: graph construction, cycle checks, rework node activations.
  - `taskgraph/lifecycle.ts`: task and node status transitions, attempt minting.
  - `taskgraph/sweep.ts`: `sweepTaskWorkersLocked`, release tasks from agents.
  - `taskgraph/stale-assignments.ts`: stale open assignment scan & nudge logic.
  - `taskgraph/closure.ts`: node closure summaries, commit evidence resolution.
  - `taskgraph/formatting.ts`: Mermaid & ASCII graph formatting.
  - `taskgraph/evidence.ts`: proxy metric emissions, artifact rewrites.
- [ ] Decompose `nudges/graph-advance.ts` into `src/nudges/`:
  - `nudges/graph-advance-nudge.ts`: `sendGraphAdvanceNudgeLocked`, `reconcileGraphAdvanceLocked`.
  - `nudges/initial-ready.ts`: initial ready nudges.
  - `nudges/task-stall.ts`: `evaluateTaskGraphStallNudgeLocked`, `resolveTaskStallLocked`.
  - `nudges/artifact-progress.ts`: `evaluateArtifactProgressNudgeLocked`.
  - `nudges/heartbeat-gc.ts`: `agentHeartbeatGCLocked` (calls `driver.isTargetAlive()`).
  - `nudges/slot-recovery.ts`: `evaluateSlotRecoveryLocked`.
  - `nudges/ack.ts`: canonical `ackRootNudgeLocked` and `ackRootGraphAdvanceNudgesLocked`.
- [ ] Audit & Protect `nudges/goal-epoch.ts`:
  - Ensure `agentIsEffectivelyAlive` properly evaluates driver liveness and maintains `a.tmuxAlive` consistency to prevent false dead-worker escalations.
- [ ] Convert `taskgraph.ts` and `nudges/graph-advance.ts` to clean re-export facades.
- [ ] Verify `graph-advance.validate.mjs`, `task-liveness.test.mjs`, `functional.test.mjs`, `r29-spawn-boot-grace-false-escalation.test.mjs`.

## Related Code Files

- Modify: `extensions/swarm/src/taskgraph.ts` (convert to facade)
- Modify: `extensions/swarm/src/nudges/graph-advance.ts` (convert to facade)
- Modify: `extensions/swarm/src/nudges/goal-epoch.ts` (verify liveness predicate)
- Create: `extensions/swarm/src/taskgraph/*.ts`
- Create: `extensions/swarm/src/nudges/*.ts`

## Implementation Steps

1. Extract `src/taskgraph/` submodules:
   - Scope logic -> `taskgraph/scope.ts`.
   - Graph validation & topological sorting -> `taskgraph/graph.ts`.
   - Transitions & attempt logic -> `taskgraph/lifecycle.ts`.
   - Worker sweep -> `taskgraph/sweep.ts`.
   - Wire facade in `src/taskgraph.ts`.
   - Run `node extensions/swarm/tests/functional.test.mjs` and `state.test.mjs`.
2. Extract `src/nudges/` submodules:
   - Separate heartbeat GC, stall nudges, and advance nudges.
   - Extract canonical `ackRootNudgeLocked` into `nudges/ack.ts`.
   - Verify `goal-epoch.ts` liveness predicate with `r29-spawn-boot-grace-false-escalation.test.mjs`.
   - Wire facade in `nudges/graph-advance.ts`.
   - Run `node extensions/swarm/tests/graph-advance.validate.mjs` and `heartbeat-gc.test.mjs`.
3. Verify zero bare catches.
4. Run full test suite.

## Todo

- [ ] Extract `src/taskgraph/*.ts` modules
- [ ] Convert `src/taskgraph.ts` to facade
- [ ] Extract `src/nudges/*.ts` modules
- [ ] Convert `src/nudges/graph-advance.ts` to facade
- [ ] Verify `goal-epoch.ts` liveness integrity
- [ ] Run test suite verification

## Success Criteria

- Both original monoliths reduced to clean <150 LOC facades.
- Every new submodule is <300 LOC.
- `r29-spawn-boot-grace-false-escalation.test.mjs` and `heartbeat-gc.test.mjs` pass.
