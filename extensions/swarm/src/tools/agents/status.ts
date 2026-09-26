// === swarm/tools/agents/status.ts — swarm_agent_status + swarm_list_agents (real bodies) ===
// Extracted verbatim from the src/tools/agents.ts monolith (Phase 5/6 real split).

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_SWARM_MINIMAL_PROTOCOL } from "../../constants.ts";
import { deriveTaskProgressState } from "../../agents.ts";
import { isTmuxRunning, tmux } from "../../tmux.ts";
import { paths, readState, trace } from "../../state.ts";
import { isDeliveryFailureRetryable } from "../../delivery.ts";
import { now, safeId, textResult } from "../../utils.ts";
import { responseMissingRecords, verifiedResponseCount } from "../../mailbox.ts";
import { wrapSwarmToolInvocation } from "../wrapper.ts";

export function registerAgentStatusTools(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "swarm_agent_status",
			label: "Swarm Agent Status",
			description:
				"Report runtime/liveness status for swarm agents using pi lifecycle state, tmux pane liveness, and mailbox message counts.",
			promptGuidelines: [
				"Use `swarm_agent_status` to inspect which swarm agents are idle, busy, tool-running, stopped, alive in tmux, or have pending/unacked/dead-letter messages.",
			],
			parameters: Type.Object({
				agentId: Type.Optional(Type.String({ description: "Optional agent id. If omitted, returns all agents." })),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_agent_status", async () => {
					const p = paths(ctx.cwd);
					const st = await readState(p, ctx.cwd);
					const filter = params.agentId ? safeId(params.agentId) : undefined;
					const agents = Object.values(st.agents).filter((a) => !filter || a.id === filter);
					const rows = [];
					for (const agent of agents) {
						const tmuxAlive =
							agent.tmuxTarget && agent.tmuxTarget !== "unknown" ? await isTmuxRunning(pi, agent.tmuxTarget) : false;
						const records = Object.values(st.messages || {}).filter((m) => m.to === agent.id);
						// Pending = awaiting delivery/retry. A message the recipient already acknowledged (incl.
						// acked-failed) is not pending; only never-acknowledged queued/failed count.
						const pendingMessages = records.filter((m) => isDeliveryFailureRetryable(m)).length;
						const mailboxDelivered = records.filter((m) => m.status === "mailbox_delivered").length;
						const unackedMessages =
							PI_SWARM_MINIMAL_PROTOCOL === 1
								? 0
								: records.filter(
										(m) =>
											m.requiresAck &&
											!m.ackedAt &&
											(m.status === "mailbox_delivered" || m.status === "injected" || m.status === "intercepted"),
									).length;
						const ackMissing =
							PI_SWARM_MINIMAL_PROTOCOL === 1
								? 0
								: records.filter((m) => m.requiresAck && Boolean(m.ackMissingAt) && !m.ackedAt).length;
						const deadLetters = records.filter((m) => m.status === "dead_letter").length;
						const responseMissing = responseMissingRecords(st, agent.id).length;
						const responsesVerified = verifiedResponseCount(st, agent.id);
						const blockedFromReuse = responseMissing > 0;
						const lastHeartbeatAgeSec = agent.lastHeartbeatAt
							? Math.round((Date.now() - new Date(agent.lastHeartbeatAt).getTime()) / 1000)
							: undefined;
						// R20: derive the single mutually-exclusive taskProgressState at the top level.
						// tmuxAlive is freshly probed here so the live pane state beats any stale cached value.
						const taskProgressState = deriveTaskProgressState(agent, st, { nowMs: Date.now(), tmuxAlive });
						rows.push({
							agentId: agent.id,
							taskProgressState,
							status: agent.status,
							runtimeStatus: agent.runtimeStatus || "idle",
							health: agent.health || (tmuxAlive ? "healthy" : "degraded"),
							paused: Boolean(agent.paused),
							tmuxAlive,
							pid: agent.pid,
							lastHeartbeatAt: agent.lastHeartbeatAt,
							lastHeartbeatAgeSec,
							lastSessionStartAt: agent.lastSessionStartAt,
							lastAgentStartAt: agent.lastAgentStartAt,
							lastAgentSettledAt: agent.lastAgentSettledAt,
							lastToolAt: agent.lastToolAt,
							lastShutdownAt: agent.lastShutdownAt,
							pendingMessages,
							mailboxDelivered,
							unackedMessages,
							ackMissing,
							deadLetters,
							responseMissing,
							responsesVerified,
							blockedFromReuse,
							tmuxTarget: agent.tmuxTarget,
						});
					}
					await trace(p, "agent.status.read", { agentId: filter, count: rows.length });
					return textResult(JSON.stringify({ count: rows.length, agents: rows }, null, 2), { agents: rows });
				});
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "swarm_list_agents",
			label: "Swarm List",
			description: "List pi swarm agents for this project, including tmux targets and mailbox paths.",
			promptGuidelines: ["Use `swarm_list_agents` before sending swarm messages when you are unsure which agents exist."],
			parameters: Type.Object({}),
			async execute(_id, _params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_list_agents", async () => {
					const p = paths(ctx.cwd);
					const st = await readState(p, ctx.cwd);
					return textResult(
						JSON.stringify({ swarmId: st.swarmId, tmuxSession: st.tmuxSession, agents: Object.values(st.agents) }, null, 2),
						{ state: st },
					);
				});
			},
		}),
	);
}
