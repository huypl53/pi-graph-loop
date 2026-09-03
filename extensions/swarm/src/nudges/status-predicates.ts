// === swarm/src/nudges/status-predicates.ts ===
// Module boundary: pure predicates over TaskState["status"] used by the nudge evaluators in
// goal-epoch.ts and graph-advance.ts. No IO, no side effects, no dependencies beyond
// ./types.ts. Safe to import from any other module without cycle risk.
//
// Source of truth for which statuses are eligible for what kind of nudge:
//   isActionableTaskStatus      -> ready / in_progress (root can act on this task)
//   isRecoverableTaskStatus     -> failed (terminal-but-recoverable, Row 75)
//   isStallNudgeEligibleTask    -> union of the two (what the stall/goal nudges consider)
//   isTerminalOrAbandonedTaskStatus -> failed / cancelled / blocked (Row R19 — orphan rework
//                                     nodes that can never auto-advance, must be excluded from
//                                     the goal-fallback gate)
//
// Moved verbatim from reconcile.ts (lines 410-441) as part of the R24 structure refactor.
// No behavior change.

import type { TaskState } from "../types.ts";

export function isActionableTaskStatus(status: TaskState["status"]): boolean {
	return status === "ready" || status === "in_progress";
}

// Row 75: terminal-but-recoverable graphs are failed tasks with ready/unassigned recovery nodes.
// They should still participate in stall/goal suppression so the root gets a bounded nudge
// instead of a silent failure.
export function isRecoverableTaskStatus(status: TaskState["status"]): boolean {
	return status === "failed";
}

export function isStallNudgeEligibleTaskStatus(status: TaskState["status"]): boolean {
	return isActionableTaskStatus(status) || isRecoverableTaskStatus(status);
}

// Row R19 (2026-09-02): terminal or abandoned tasks whose orphan rework nodes can never auto-advance.
// A failed/cancelled/blocked task cannot be unblocked by engine action alone — the root
// must force-reopen (swarm_update_task force=true) to re-activate it. These tasks should be excluded
// from `hasActionableGraphWork`'s goal-fallback gate so the orphan does not permanently silence
// the goal floor. Graph-stall nudge still admits `failed` for its OWN first emission (Row 75).
export function isTerminalOrAbandonedTaskStatus(status: TaskState["status"]): boolean {
	return status === "failed" || status === "cancelled" || status === "blocked";
}
