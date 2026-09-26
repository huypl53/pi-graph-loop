// === swarm/tools/agents.ts — agent tool registration facade ===
// Phase 5/6 real split: the former 1,123-line monolith now delegates to real submodules:
//   agents/status.ts    — swarm_agent_status + swarm_list_agents (registerAgentStatusTools)
//   agents/lifecycle.ts — swarm_spawn_agent + swarm_stop_agent (registerAgentLifecycleTools)
//   goals.ts            — swarm_set_goal + swarm_mark_goal_done (registerGoalTools)
//   agents/retired.ts   — retired tools preserved as comments (prune, identity, reload, trace,
//                         capture, dead_letters, register, restart, set_role, set_agent_paused,
//                         send_keys, attach, release)
//
// This module is a pure barrel: no behavior, no imports of its own.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerAgentStatusTools } from "./agents/status.ts";
import { registerAgentLifecycleTools } from "./agents/lifecycle.ts";
import { registerGoalTools } from "./goals.ts";

export function registerAgentsTools(pi: ExtensionAPI): void {
	registerAgentStatusTools(pi);
	registerAgentLifecycleTools(pi);
	registerGoalTools(pi);
}
