// === swarm/tools/tasks/update.ts — swarm_update_task submodule ===
// The swarm_update_task handler + state transition engine lives in ../tasks.ts.
// This module exists for organizational clarity; the canonical implementation is there.
// Late result rejection (lateResultRejectionCount) and attempt fencing are
// implemented in ../tasks.ts and re-exported via ./fencing.ts.

export { registerTasksTools } from "../tasks.ts";
export type { LateResultRefusal, ReassignRateLimited } from "./fencing.ts";
export { checkLateResultRejection, checkReassignRateLimit, stampSupersessionCount } from "./fencing.ts";
