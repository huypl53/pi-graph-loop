// === swarm/tools/tasks/index.ts — task tool registration barrel ===
// Delegates to the canonical implementation in ../tasks.ts (Phase 5 modular split).
// Registers exactly 4 active task tools: swarm_create_task, swarm_task_status,
// swarm_assign_task, swarm_update_task. Retired tools remain commented out in ../tasks.ts.

export { registerTasksTools } from "../tasks.ts";
