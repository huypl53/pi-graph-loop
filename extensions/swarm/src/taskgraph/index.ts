// === swarm/taskgraph/index.ts — taskgraph barrel (Phase 6) ===
// Backward-compatible re-export facade for all taskgraph functions.
// The canonical implementation resides in ../taskgraph.ts.
// Submodule files (scope.ts, graph.ts, lifecycle.ts, etc.) are organizational
// stubs that delegate to this barrel or to ../taskgraph.ts directly.

export {
	// Graph construction
	buildGraphFromInput,
	buildTaskMarkdown,

	// Graph validation
	validateTaskGraph,

	// Scope resolution
	resolveNodeScope,
	scopesOverlap,
	collectActiveLeases,
	type EffectiveScope,

	// Node lifecycle
	mintNodeAttempt,
	isAllowedNodeTransition,
	isGraphTerminalNode,
	isTaskOrNodeCancelled,
	releaseNodeAssignment,
	releaseTaskFromAllAgents,
	suppressPriorAttemptForForceReopen,
	activateReworkNodes,
	applyTaskStatus,
	computeReadyNodes,
	computeTaskClosure,

	// Worker sweep
	sweepTaskWorkersLocked,

	// Status application
	applyGateUpdates,
	applySharedContextUpdates,

	// Nudges
	checkClosureNotificationStale,
	checkStallNotificationStale,

	// Formatting
	buildAssignmentBody,
	graphJsonSummary,
	printGraphMermaid,
	printGraphText,

	// Evidence / artifacts
	resolveCommitNodeEvidence,
	collectDeclaredArtifacts,

	// Stale assignment scan
	staleOpenAssignmentScanLocked,
	staleOpenNudgeLocked,
	autoCloseRootTerminalNodes,
	failTaskTool,
} from "../taskgraph.ts";
