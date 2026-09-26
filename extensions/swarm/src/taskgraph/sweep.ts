// === swarm/taskgraph/sweep.ts — sweepTaskWorkersLocked worker cleanup (Phase 6) ===
// Task-close worker sweep (terminal-transition sites #1-#5) lives in ../taskgraph.ts.
// This module re-exports the sweep surface for modular imports.

export { sweepTaskWorkersLocked } from "../taskgraph.ts";
