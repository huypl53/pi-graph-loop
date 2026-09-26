// === swarm/tools/tasks/fencing.ts — late result rejection & rate-limit fencing ===
// Re-exports from the canonical implementation in ../tasks.ts (Phase 5 modular split).
// The supersession-fencing.test.mjs AST assertions (C8.a/b/c) read ../tasks.ts directly
// and must pass there; this module is the submodule face for import-based use.

export type { LateResultRefusal, ReassignRateLimited } from "../tasks.ts";
export { checkLateResultRejection, checkReassignRateLimit, stampSupersessionCount } from "../tasks.ts";
