// === swarm/tools/goals.ts — swarm_set_goal + swarm_mark_goal_done tools (Phase 5) ===
// Goal tools are registered as part of registerAgentsTools in tools/agents.ts.
// This module re-exports the registration function for callers who want to import
// goal-domain tools explicitly. The swarm_set_goal and swarm_mark_goal_done tools
// are the final 2 of the 14-tool minimal protocol (ROOT_TOOL_ALLOWLIST in constants.ts).
//
// Goal surface (2 tools):
//   - swarm_set_goal: Persist a swarm-level goal; drives idle-streak nudge loop.
//   - swarm_mark_goal_done: Clear the goal and stop the idle nudge.
//
// Both tools require root authority (requireRootAuthority in agents.ts).

export { registerAgentsTools as registerGoalsTools } from "./agents.ts";
