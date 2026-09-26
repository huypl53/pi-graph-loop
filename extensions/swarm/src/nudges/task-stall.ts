// === swarm/nudges/task-stall.ts — task graph stall detection (Phase 6) ===
// evaluateTaskGraphStallNudgeLocked and resolveTaskStallLocked live in graph-advance.ts.
// This module re-exports the stall nudge surface.

export { evaluateTaskGraphStallNudgeLocked, resolveTaskStallLocked } from "./graph-advance.ts";
