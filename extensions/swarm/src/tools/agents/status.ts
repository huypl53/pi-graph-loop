// === swarm/tools/agents/status.ts — swarm_agent_status + swarm_list_agents (real bodies) ===
// Extracted verbatim from the src/tools/agents.ts monolith (Phase 5/6 real split).
// tool-output-slim (2026-09-28): swarm_agent_status gains an attention/census default view
// (view:"full" / verbose:true preserve the legacy 24-field rows); swarm_list_agents becomes a
// compact phonebook (details carry the same compact rows — the full-agent-array details leak dies).

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_SWARM_MINIMAL_PROTOCOL } from "../../constants.ts";
import { deriveTaskProgressState } from "../../agents.ts";
import { isTmuxRunning, tmux } from "../../tmux.ts";
import { getTerminalDriver } from "../../terminal/index.ts";
import { paths, readState, trace } from "../../state.ts";
import { isDeliveryFailureRetryable } from "../../delivery.ts";
import { humanAge, now, safeId, textResult } from "../../utils.ts";
import { responseMissingRecords, verifiedResponseCount } from "../../mailbox.ts";
import { wrapSwarmToolInvocation } from "../wrapper.ts";

// === tool-output-slim §3 — phonebook row (first role line, ≤80 bytes) ===
function roleFirstLine(role: string | undefined): string {
	const first = String(role || "")
		.split("\n", 1)[0]
		.trim();
	if (Buffer.byteLength(first, "utf8") <= 60) return first;
	// hard-truncate to ≤60 bytes without splitting a multi-byte char
	let out = first;
	while (Buffer.byteLength(out, "utf8") > 59) out = out.slice(0, -1);
	return out + "…";
}

// Per-agent driver id + target (H2/G2 vocabulary). herdr-pane agents render driver:"herdr"
// with the herdr pane id as target; everyone else falls back to the resolved default driver.
function agentDriverAndTarget(agent: any): { driver: string; target: string } {
	const target = agent.tmuxTarget || "unknown";
	if (agent.herdrPaneId || /^w[A-Za-z0-9_-]+:p[A-Za-z0-9]+$/.test(target)) return { driver: "herdr", target };
	return { driver: getTerminalDriver().id, target };
}

function agentSlot(agent: any): string {
	return `${agent.provider || "?"}/${agent.model || "?"}`;
}

export function registerAgentStatusTools(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "swarm_agent_status",
			label: "Swarm Agent Status",
			description:
				"Report runtime/liveness status for swarm agents using pi lifecycle state, tmux pane liveness, and mailbox message counts. Default view is a compact attention/census summary; view:'full' (or verbose:true) returns the legacy 24-field rows; pass agentId for a targeted full-row query.",
			promptGuidelines: [
				"Use `swarm_agent_status` to inspect which swarm agents are idle, busy, tool-running, stopped, alive in tmux, or have pending/unacked/dead-letter messages. The default attention view summarizes the whole swarm; pass agentId (or view:'full') for per-agent detail.",
			],
			parameters: Type.Object({
				agentId: Type.Optional(Type.String({ description: "Optional agent id. If omitted, returns all agents." })),
				view: Type.Optional(
					Type.Union([Type.Literal("attention"), Type.Literal("census"), Type.Literal("full")], {
						description:
							"Output view. Defaults to 'attention' (census + non-healthy rows). 'full' returns legacy detailed rows.",
					}),
				),
				verbose: Type.Optional(Type.Boolean({ description: "Legacy alias for view:'full'. Defaults to false." })),
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
							// tool-output-slim §2 additions (renames + driver/slot vocabulary)
							paneAlive: tmuxAlive,
							...agentDriverAndTarget(agent),
							slot: agentSlot(agent),
						});
					}
					await trace(p, "agent.status.read", { agentId: filter, count: rows.length });
					// === tool-output-slim §2 — attention/census default view ===
					// Targeted queries and view:"full"/verbose:true keep the legacy envelope.
					const view =
						params.agentId || params.view === "full" || params.verbose === true
							? "full"
							: params.view === "census"
								? "census"
								: "attention";
					if (view === "full") {
						return textResult(JSON.stringify({ count: rows.length, agents: rows }, null, 2), { agents: rows });
					}
					// Census buckets from taskProgressState. Healthy-idle = active|awaiting_input agents with
					// no pending/dead-letter/response debt. Everything else lands in attention.
					const census = { idle: 0, busy: 0, stopped: 0, stalled: 0 };
					const attention: Array<Record<string, unknown>> = [];
					for (const row of rows as any[]) {
						const unhealthy =
							row.status === "stopped" ||
							row.paused ||
							row.taskProgressState === "dead" ||
							row.taskProgressState === "idle_blocked" ||
							row.taskProgressState === "stalled" ||
							row.taskProgressState === "completed_unverified" ||
							row.pendingMessages > 0 ||
							row.deadLetters > 0 ||
							row.responseMissing > 0;
						if (row.taskProgressState === "active" || row.runtimeStatus === "busy" || row.runtimeStatus === "tool_running")
							census.busy++;
						else if (row.status === "stopped" || row.taskProgressState === "dead") census.stopped++;
						else if (row.taskProgressState === "stalled" || row.taskProgressState === "idle_blocked") census.stalled++;
						else census.idle++;
						if (!unhealthy) continue;
						// why: first matching derived fact wins (one sentence).
						let why: string;
						if (row.status === "stopped" && row.paneAlive) why = "pane alive but agent stopped";
						else if (row.status === "stopped") why = "agent stopped";
						else if (row.taskProgressState === "dead") why = "no pane / stale heartbeat";
						else if (row.deadLetters > 0) why = `${row.deadLetters} dead-letter message(s)`;
						else if (row.responseMissing > 0) why = `${row.responseMissing} response(s) missing (blocked from reuse)`;
						else if (row.pendingMessages > 0) why = `${row.pendingMessages} pending message(s)`;
						else if (row.paused) why = "paused";
						else if (row.taskProgressState === "stalled") why = "stalled (active task, no recent tool activity)";
						else if (row.taskProgressState === "completed_unverified") why = "artifact fresh but result unverified";
						else why = row.taskProgressState;
						const slim: Record<string, unknown> = {
							agentId: row.agentId,
							taskProgressState: row.taskProgressState,
							status: row.status,
							paneAlive: row.paneAlive,
							driver: row.driver,
							target: row.target,
							heartbeatAge: row.lastHeartbeatAgeSec,
							slot: row.slot,
						};
						const settledAgeSec = row.lastAgentSettledAt
							? Math.round((Date.now() - new Date(row.lastAgentSettledAt).getTime()) / 1000)
							: undefined;
						if (settledAgeSec !== undefined) slim.settledAge = settledAgeSec;
						if (row.deadLetters > 0) slim.deadLetters = row.deadLetters;
						if (row.pendingMessages > 0) slim.pendingMessages = row.pendingMessages;
						if (row.responseMissing > 0) slim.responseMissing = row.responseMissing;
						if (row.unackedMessages > 0) slim.unackedMessages = row.unackedMessages;
						if (row.ackMissing > 0) slim.ackMissing = row.ackMissing;
						if (row.responsesVerified > 0) slim.responsesVerified = row.responsesVerified;
						if (row.paused) slim.paused = true;
						slim.why = why;
						attention.push(slim);
					}
					const hint =
						census.stopped > 0
							? `${census.stopped} stopped agent(s) need attention; use view:"full" or agentId for detail.`
							: attention.length
								? `${attention.length} agent(s) need attention; use view:"full" or agentId for detail.`
								: 'All agents healthy; use view:"full" or agentId for detail.';
					return textResult(JSON.stringify({ census, attention, hint }), { census, attention });
				});
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "swarm_list_agents",
			label: "Swarm List",
			description:
				"List pi swarm agents for this project as a compact phonebook: ids, role first lines, status, driver target, slot, and mailbox paths.",
			promptGuidelines: ["Use `swarm_list_agents` before sending swarm messages when you are unsure which agents exist."],
			parameters: Type.Object({}),
			async execute(_id, _params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_list_agents", async () => {
					const p = paths(ctx.cwd);
					const st = await readState(p, ctx.cwd);
					const driver = getTerminalDriver().id;
					// tool-output-slim §3: compact phonebook rows. details carries the SAME compact rows —
					// the full-agent-array details leak (multi-MB per session) dies here. Legacy full records
					// remain reachable per-agent via swarm_agent_status({agentId, view:"full"}).
					const rows = Object.values(st.agents).map((agent) => {
						const { driver: agentDriver, target } = agentDriverAndTarget(agent);
						// tool-output-slim §3 (root review trim): `mailbox` dropped from default rows —
						// it is derivable as .pi/swarm/mailboxes/<id>.jsonl; full records stay reachable
						// via swarm_agent_status({agentId, view:"full"}).
						return {
							id: agent.id,
							roleFirstLine: roleFirstLine(agent.role),
							roleKind: agent.roleKind,
							status: agent.status,
							driver: agentDriver,
							target,
							slot: agentSlot(agent),
						};
					});
					return textResult(JSON.stringify({ swarmId: st.swarmId, driver, agents: rows }), { agents: rows });
				});
			},
		}),
	);
}
