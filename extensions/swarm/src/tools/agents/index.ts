// === swarm/tools/agents/index.ts — agent tool registration barrel (Phase 5) ===
// Delegates to the canonical implementation in ../agents.ts.
// Registers the active agent tools (swarm_agent_status, swarm_list_agents,
// swarm_spawn_agent, swarm_stop_agent) plus observability tools.
// Goal tools (swarm_set_goal, swarm_mark_goal_done) live in ../goals.ts.

export { registerAgentsTools } from "../agents.ts";
