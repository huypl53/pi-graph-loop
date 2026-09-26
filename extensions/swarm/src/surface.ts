// === swarm/src/surface.ts — facade (Phase 7 modular split) ===
// The root surface machinery was decomposed into src/surface/ submodules:
//   - surface/session.ts      — orchSession (per-pid session gate + retrigger counters)
//   - surface/warnings.ts     — runtimeTaskWarnings (task.json closure/warning extractor)
//   - surface/actionable.ts   — isActionableRootMessage + parseTaskNodeRef (actionability predicate)
//   - surface/staleness.ts    — staleSurfaceReason + traceStaleSuppressedOnce (revalidation)
//   - surface/ranking.ts      — rootSurfaceGroupKey + compareSurfaceCandidates (pure sort/group)
//   - surface/pump.ts         — pumpRootMailbox (the per-tick R10-1 surface pump; R30 batching)
//   - surface/pump-phases.ts  — runPumpMaintenancePhasesLocked (in-lock maintenance phases)
//   - surface/pump-decision.ts — decideSurfaceLocked (back-fill, dedupe gate, busy defer, census)
//   - surface/coalesce.ts     — coalesceSurfacePlanLocked (R13 bypass + coalescing + receipts)
//   - surface/pump-shared.ts  — fingerprintMessage (consumer-receipt fingerprint helper)
//
// This facade re-exports the original public surface so `src/reconcile.ts`, `src/hooks.ts`,
// `src/tools/*`, `src/commands/*`, and 20+ test suites that import "./surface.ts" (or via the
// reconcile barrel) keep working unchanged.
//
// === R27-B Guard 3 contract (r27b-pump-import-guards.test.mjs:140-146) ===
// This file MUST physically declare static imports of the pump-callable identifiers below
// (`checkStallNotificationStale`, `evaluateIdleGoalNudgeLocked`, `updateIdleEpochLocked`,
// `allEffectiveIdleAgents` from ./nudges/...) — the guard greps THIS file's source for those
// import statements. They are re-exported for the same reason: historical importers resolved
// these names through this module.
// === R16/Pump-retrigger contract ===
// `orchSession`, `runtimeTaskWarnings`, `isActionableRootMessage`, `staleSurfaceReason`,
// `traceStaleSuppressedOnce`, and `pumpRootMailbox` are the long-stable public surface of this
// module (reconcile barrel + root-wake/idle-nudge/r28 tests import them from here).
import { evaluateIdleGoalNudgeLocked, updateIdleEpochLocked, allEffectiveIdleAgents } from "./nudges/goal-epoch.ts";
import { checkStallNotificationStale } from "./taskgraph.ts";

export { checkStallNotificationStale, evaluateIdleGoalNudgeLocked, updateIdleEpochLocked, allEffectiveIdleAgents };
export { orchSession } from "./surface/session.ts";
export { runtimeTaskWarnings } from "./surface/warnings.ts";
export { isActionableRootMessage, parseTaskNodeRef } from "./surface/actionable.ts";
export { staleSurfaceReason, traceStaleSuppressedOnce } from "./surface/staleness.ts";
export { rootSurfaceGroupKey, compareSurfaceCandidates } from "./surface/ranking.ts";
export { pumpRootMailbox } from "./surface/pump.ts";
