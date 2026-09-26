// === swarm/taskgraph/lifecycle.ts — task/node status transitions, attempt minting (Phase 6) ===
// Node lifecycle transitions, attempt minting, assignment release, and status
// application live in the canonical ../taskgraph.ts. This module re-exports the lifecycle surface.

export {
	mintNodeAttempt,
	isAllowedNodeTransition,
	isGraphTerminalNode,
	isTaskOrNodeCancelled,
	releaseNodeAssignment,
	releaseTaskFromAllAgents,
	suppressPriorAttemptForForceReopen,
	applyTaskStatus,
	computeReadyNodes,
	computeTaskClosure,
	applyGateUpdates,
	applySharedContextUpdates,
	checkClosureNotificationStale,
	checkStallNotificationStale,
	failTaskTool,
} from "../taskgraph.ts";
