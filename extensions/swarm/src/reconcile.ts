// === swarm/src/reconcile.ts — barrel ===

export {
  resolveGoalNudgeIntervalMs,
  updateIdleEpochLocked,
  evaluateIdleGoalNudgeLocked,
  agentIsEffectivelyAlive,
  allEffectiveIdleAgents,
} from "./nudges/goal-epoch.ts";

export {
  reconcileInitialReadyLocked,
  evaluateTaskGraphStallNudgeLocked,
  evaluateArtifactProgressNudgeLocked,
  agentHeartbeatGCLocked,
  resolveTaskStallLocked,
  evaluateSlotRecoveryLocked,
} from "./nudges/graph-advance.ts";

export {
  isActionableTaskStatus,
  isRecoverableTaskStatus,
  isStallNudgeEligibleTaskStatus,
  isTerminalOrAbandonedTaskStatus,
} from "./nudges/status-predicates.ts";

export {
  isActionableOrchestratorMessage,
  staleSurfaceReason,
  pumpOrchestratorMailbox,
  orchSession,
  runtimeTaskWarnings,
  traceStaleSuppressedOnce,
} from "./surface.ts";

export {
  buildSwarmStatusSummary,
  listTasksIndexed,
  renderTasksIndexedList,
  resolveTaskArg,
} from "./tasks-index.ts";

export { reconcileTasks, reconcile } from "./reconcile-core.ts";
