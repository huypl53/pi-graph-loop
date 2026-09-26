// === swarm/src/nudges/graph-advance.ts ===
// Facade: re-exports the per-task graph-advance nudge families from their real
// submodules (Phase 6 real split). All four nudge families share per-(taskId, nodeId)
// seq-suffixed keys (NOTIFY_KEY_GRAPH_ADVANCE, NOTIFY_KEY_INITIAL_READY,
// NOTIFY_KEY_TASK_GRAPH_STALL) and the seq-counter machine in goal-epoch.ts.
//
// Submodules:
//   graph-advance-nudge.ts  — sendGraphAdvanceNudgeLocked + reconcileGraphAdvanceLocked + ack helpers
//   initial-ready.ts        — reconcileInitialReadyLocked (+ private start-node nudge sender)
//   task-stall.ts           — evaluateTaskGraphStallNudgeLocked + resolveTaskStallLocked
//   artifact-progress.ts    — evaluateArtifactProgressNudgeLocked
//   heartbeat-gc.ts         — agentHeartbeatGCLocked
//   slot-recovery.ts        — evaluateSlotRecoveryLocked
//
// This module is a pure barrel: no behavior, no imports of its own.

export { reconcileGraphAdvanceLocked, sendGraphAdvanceNudgeLocked } from "./graph-advance-nudge.ts";

export { reconcileInitialReadyLocked } from "./initial-ready.ts";

export { evaluateTaskGraphStallNudgeLocked, resolveTaskStallLocked } from "./task-stall.ts";

export { evaluateArtifactProgressNudgeLocked } from "./artifact-progress.ts";

export { agentHeartbeatGCLocked } from "./heartbeat-gc.ts";

export { evaluateSlotRecoveryLocked } from "./slot-recovery.ts";
