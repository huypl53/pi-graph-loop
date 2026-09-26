// === swarm/taskgraph/scope.ts — scope resolution, lease collision detection (Phase 6) ===
// Scope resolution (resolveNodeScope, scopesOverlap, collectActiveLeases) lives in
// the canonical ../taskgraph.ts. This module re-exports the scope surface.

export { resolveNodeScope, scopesOverlap, collectActiveLeases, type EffectiveScope } from "../taskgraph.ts";
