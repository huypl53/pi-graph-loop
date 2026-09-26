// === swarm/taskgraph.ts — backward-compatible facade (Phase 6 real split) ===
// The canonical bodies live in ./taskgraph/{scope,attention,graph,closure,formatting,lifecycle,sweep,stale,evidence}.ts.
// This facade re-exports the complete public surface so every existing `from "../taskgraph.ts"` import
// (26 in-tree consumers) keeps working unchanged. Tests import symbols from this module
// (file-ownership, liveness-progress, proxy-metrics, ...).

export type { ActiveLease, EffectiveScope, ScopeRelation, ScopeSegment, ScopeSource } from "./taskgraph/scope.ts";
export { collectActiveLeases, normalizeScopePattern, resolveNodeScope, scopePatternsOverlap, scopesOverlap } from "./taskgraph/scope.ts";

export type { NotificationStaleness } from "./taskgraph/attention.ts";
export { checkClosureNotificationStale, checkStallNotificationStale, deriveNodeAttention } from "./taskgraph/attention.ts";

export type { GraphValidation } from "./taskgraph/graph.ts";
export {
	activateReworkNodes,
	buildDefaultGraph,
	buildGraphFromInput,
	collectDeclaredArtifacts,
	computeReadyNodes,
	graphHasCycle,
	hasOutgoingTaskEdge,
	isGraphTerminalNode,
	suppressPriorAttemptForForceReopen,
	validateTaskGraph,
} from "./taskgraph/graph.ts";

export type { NodeClosureSummary } from "./taskgraph/closure.ts";
export { computeNodeClosureSummary, computeTaskClosure, nodeVerdict } from "./taskgraph/closure.ts";

export { buildAssignmentBody, buildTaskMarkdown, graphJsonSummary, printGraphMermaid, printGraphText } from "./taskgraph/formatting.ts";

export type { SweepOutcome } from "./taskgraph/sweep.ts";
export { scanAgentOpenAssignments, sweepTaskWorkersLocked } from "./taskgraph/sweep.ts";

export {
	applyGateUpdates,
	applySharedContextUpdates,
	applyTaskStatus,
	computeTaskStatus,
	ensureNodeActivityStamp,
	failTaskTool,
	isAllowedNodeTransition,
	isTaskOrNodeCancelled,
	mintNodeAttempt,
	releaseNodeAssignment,
	releaseTaskFromAllAgents,
} from "./taskgraph/lifecycle.ts";

export { staleOpenAssignmentScanLocked, staleOpenNudgeLocked } from "./taskgraph/stale.ts";

export { autoCloseRootTerminalNodes, proxyMetricEmitLocked, readCommitEvidence, resolveCommitNodeEvidence } from "./taskgraph/evidence.ts";
