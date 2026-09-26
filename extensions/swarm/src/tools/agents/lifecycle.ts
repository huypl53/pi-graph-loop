// === swarm/tools/agents/lifecycle.ts — swarm_spawn_agent + swarm_stop_agent (real bodies) ===
// Extracted verbatim from the src/tools/agents.ts monolith (Phase 5/6 real split).

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { relative } from "node:path";
import { currentAgentId } from "../../session.ts";
import { ensureDirs, paths, readState, trace, withLock, writeState } from "../../state.ts";
import { logSwarmError } from "../../errorlog.ts";
import { now, safeId, textResult } from "../../utils.ts";
import { heartbeatRootLeader, requireRootAuthority } from "../../identity.ts";
import { readSwarmRawConfig } from "../../config.ts";
import { spawnAgent, stopAgent } from "../../agents.ts";
import { tmux } from "../../tmux.ts";
import { wrapSwarmToolInvocation } from "../wrapper.ts";

export function registerAgentLifecycleTools(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "swarm_spawn_agent",
			label: "Swarm Spawn",
			description:
				"Spawn a new pi agent in a tmux window in the same working directory. The new agent shares project extensions and skills. Requires tmux.",
			promptGuidelines: [
				"Use `swarm_spawn_agent` when the user asks to create a pi agent/swarm worker for parallel planning, review, or coding.",
				"Do NOT specify provider or model when spawning agents. Model and provider are configured by the user in .pi/swarm.yaml. Only specify id, role, roleKind, and initialPrompt unless the user explicitly requested a specific model/provider.",
			],
			parameters: Type.Object({
				id: Type.Optional(
					Type.String({
						description:
							"Stable agent id, e.g. planner or reviewer. Lowercase letters, digits, dash and underscore are safest.",
					}),
				),
				role: Type.String({ description: "Role/instructions for the agent." }),
				roleKind: Type.Optional(
					Type.String({
						description:
							"Explicit role kind override (root/planner/reviewer/tester/observer/implementer/worker). Pinned so it is not re-derived from id/role. Defaults to inference (id-first, then role text).",
					}),
				),
				model: Type.Optional(
					Type.String({
						description:
							"Optional model override. Omit this parameter; swarm agents automatically inherit model from .pi/swarm.yaml.",
					}),
				),
				provider: Type.Optional(
					Type.String({
						description:
							"Optional provider override. Omit this parameter; swarm agents automatically inherit provider from .pi/swarm.yaml.",
					}),
				),
				initialPrompt: Type.Optional(
					Type.String({ description: "Optional first prompt to send into the spawned agent after pi starts." }),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_spawn_agent", async () => {
					const p = paths(ctx.cwd);
					await ensureDirs(p);
					const rawConfig = readSwarmRawConfig(ctx.cwd);
					const hasUserConfig = Boolean(
						rawConfig.cfg && (rawConfig.cfg.modelPool || rawConfig.cfg.defaultModel || rawConfig.cfg.defaultProvider),
					);
					if (!hasUserConfig && ctx.hasUI) {
						try {
							ctx.ui.notify(
								"[Swarm] Warning: .pi/swarm.yaml is not configured. Spawning with fallback defaults. Please configure .pi/swarm.yaml.",
								"warning",
							);
						} catch (err) {
							await logSwarmError(p, "spawn_agent", "ui_notify_failed", err);
						}
					}
					const result = await withLock(p, async () => {
						const st = await readState(p, ctx.cwd);
						await trace(p, "agent.spawn.request", { requestedBy: currentAgentId(), ...params });
						// Otherwise spawnAgent consults the model pool (if configured) before falling back to the single default.
						const model = params.model || undefined;
						const provider = params.provider || undefined;
						const r = await spawnAgent(pi, ctx.cwd, p, st, { ...params, model, provider });
						await writeState(p, st);
						return { swarmId: st.swarmId, tmuxSession: st.tmuxSession, ...r };
					});
					const warnHeader = !hasUserConfig
						? "[WARNING: .pi/swarm.yaml is not configured. Worker spawned with fallback defaults. Configure .pi/swarm.yaml to set model & provider.]\n\n"
						: "";
					return textResult(
						`${warnHeader}Spawned ${result.agent.id} at ${result.agent.tmuxTarget}\nIdentity: ${relative(ctx.cwd, result.identity)}\nSnapshot: ${relative(ctx.cwd, result.snapshot)}`,
						result,
					);
				});
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "swarm_stop_agent",
			label: "Swarm Stop",
			description:
				"Stop a swarm agent: kill its tmux pane/window and mark it stopped. Refuses if the agent has active tasks unless force=true. Mailbox, identity, and history persist via the stable id.",
			promptGuidelines: [
				"Use `swarm_stop_agent` to retire an agent. For a non-destructive park that keeps the pane alive, use `swarm_set_agent_paused` instead.",
			],
			parameters: Type.Object({
				agentId: Type.String({ description: "Agent id to stop." }),
				force: Type.Optional(Type.Boolean({ description: "Stop even if the agent has active tasks. Defaults to false." })),
				killPane: Type.Optional(
					Type.Boolean({
						description: "Kill the tmux pane/window. Defaults to true; set false to mark stopped without touching tmux.",
					}),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_stop_agent", async () => {
					const p = paths(ctx.cwd);
					requireRootAuthority(currentAgentId(), "swarm_stop_agent");
					const result = await withLock(p, async () => {
						const st = await readState(p, ctx.cwd);
						heartbeatRootLeader(st, Date.now(), process.pid, "stop_agent");
						const r = await stopAgent(pi, ctx.cwd, p, st, safeId(params.agentId), {
							force: params.force,
							killPane: params.killPane,
						});
						await writeState(p, st);
						return r;
					});
					return textResult(`Stopped ${result.agent.id}: killed=${result.killed} method=${result.method}.`, result);
				});
			},
		}),
	);
}
