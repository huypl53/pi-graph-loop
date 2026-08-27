// === swarm/tools/agents.ts — tool registrations (verbatim from index.ts) ===
import { Type } from "typebox";
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, appendFile, rm, stat, rename, readdir, realpath } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { capturePane, isTmuxRunning, tmux } from "../tmux.ts";
import { currentAgentId, currentModel, currentProvider } from "../session.ts";
import { ensureDirs, identityPath, paths, readState, taskPaths, readTaskState, trace, withLock, writeState } from "../state.ts";
import { isDeliveryFailureRetryable } from "../delivery.ts";
import { now, safeId, textResult, truncate } from "../utils.ts";
import { heartbeatOrchestratorLeader, overridePath, requireOrchestratorAuthority, writeEffectiveIdentity } from "../identity.ts";
import { attachTarget, registerAgent, reloadIdentity, restartAgent, sendKeys, setAgentPaused, setAgentRole, spawnAgent, stopAgent } from "../agents.ts";
import { FAST_MODEL, FAST_PROVIDER } from "../constants.ts";
import { responseMissingRecords, verifiedResponseCount } from "../mailbox.ts";

export function registerAgentsTools(pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		name: "swarm_agent_status",
		label: "Swarm Agent Status",
		description: "Report runtime/liveness status for swarm agents using pi lifecycle state, tmux pane liveness, and mailbox message counts.",
		promptGuidelines: ["Use `swarm_agent_status` to inspect which swarm agents are idle, busy, tool-running, stopped, alive in tmux, or have pending/unacked/dead-letter messages."],
		parameters: Type.Object({
			agentId: Type.Optional(Type.String({ description: "Optional agent id. If omitted, returns all agents." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const st = await readState(p, ctx.cwd);
			const filter = params.agentId ? safeId(params.agentId) : undefined;
			const agents = Object.values(st.agents).filter((a) => !filter || a.id === filter);
			const rows = [];
			for (const agent of agents) {
				const tmuxAlive = agent.tmuxTarget && agent.tmuxTarget !== "unknown" ? await isTmuxRunning(pi, agent.tmuxTarget) : false;
				const records = Object.values(st.messages || {}).filter((m) => m.to === agent.id);
				// Pending = awaiting delivery/retry. A message the recipient already acknowledged (incl.
				// acked-failed) is not pending; only never-acknowledged queued/failed count.
				const pendingMessages = records.filter((m) => isDeliveryFailureRetryable(m)).length;
				const mailboxDelivered = records.filter((m) => m.status === "mailbox_delivered").length;
				const unackedMessages = records.filter((m) => m.requiresAck && !m.ackedAt && (m.status === "mailbox_delivered" || m.status === "injected" || m.status === "intercepted")).length;
				const ackMissing = records.filter((m) => m.requiresAck && Boolean(m.ackMissingAt) && !m.ackedAt).length;
				const deadLetters = records.filter((m) => m.status === "dead_letter").length;
				const responseMissing = responseMissingRecords(st, agent.id).length;
				const responsesVerified = verifiedResponseCount(st, agent.id);
				const blockedFromReuse = responseMissing > 0;
				const lastHeartbeatAgeSec = agent.lastHeartbeatAt ? Math.round((Date.now() - new Date(agent.lastHeartbeatAt).getTime()) / 1000) : undefined;
				rows.push({
					agentId: agent.id,
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
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_prune",
		label: "Swarm Prune",
		description: "Orchestrator/admin cleanup tool. Dry-run by default. Marks zombie agents whose tmux panes are gone and can optionally remove stopped agent records from state.",
		promptGuidelines: ["Use `swarm_prune` only for orchestrator/admin cleanup. Do not use it for normal worker tasks. Run dryRun first before mutating state."],
		parameters: Type.Object({
			dryRun: Type.Optional(Type.Boolean({ description: "Preview actions without modifying state. Defaults to true." })),
			markDead: Type.Optional(Type.Boolean({ description: "Mark running agents with missing tmux panes as stopped. Defaults to true." })),
			removeStopped: Type.Optional(Type.Boolean({ description: "Remove stopped agent records from swarm state. Does not delete mailboxes/traces. Defaults to false." })),
			stoppedOlderThanMs: Type.Optional(Type.Number({ description: "Only remove stopped agent records older than this age. Defaults to 0." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			requireOrchestratorAuthority(currentAgentId(), "swarm_prune");
			const dryRun = params.dryRun !== false;
			const markDead = params.markDead !== false;
			const removeStopped = Boolean(params.removeStopped);
			const stoppedOlderThanMs = Math.max(0, params.stoppedOlderThanMs || 0);
			const actions: Array<{ agentId: string; action: string; reason: string }> = [];
			await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const ts = now();
				const nowMs = Date.now();
				for (const [agentId, agent] of Object.entries(st.agents)) {
					if (agentId === "orchestrator") continue;
					const hasPane = Boolean(agent.tmuxTarget) && agent.tmuxTarget !== "unknown";
					const tmuxAlive = hasPane ? await isTmuxRunning(pi, agent.tmuxTarget) : false;
					if (markDead && agent.status === "running" && !tmuxAlive) {
						actions.push({ agentId, action: "mark_stopped", reason: "tmux pane is not alive" });
						if (!dryRun) {
							agent.status = "stopped";
							agent.runtimeStatus = "stopped";
							agent.health = "unhealthy";
							agent.lastShutdownAt ||= ts;
							agent.updatedAt = ts;
						}
					}
					const stoppedAt = agent.lastShutdownAt || agent.updatedAt || agent.createdAt;
					const stoppedAge = stoppedAt ? nowMs - new Date(stoppedAt).getTime() : Number.POSITIVE_INFINITY;
					if (removeStopped && agent.status === "stopped" && stoppedAge >= stoppedOlderThanMs) {
						actions.push({ agentId, action: "remove_agent_record", reason: `stopped for ${Math.round(stoppedAge / 1000)}s` });
						if (!dryRun) {
							delete st.agents[agentId];
							delete st.delivered[agentId];
						}
					}
				}
				if (!dryRun && actions.length) await writeState(p, st);
			});
			await trace(p, "swarm.prune", { dryRun, markDead, removeStopped, stoppedOlderThanMs, actions });
			return textResult(JSON.stringify({ dryRun, count: actions.length, actions }, null, 2), { dryRun, actions });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_list_agents",
		label: "Swarm List",
		description: "List pi swarm agents for this project, including tmux targets and mailbox paths.",
		promptGuidelines: ["Use `swarm_list_agents` before sending swarm messages when you are unsure which agents exist."],
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const st = await readState(p, ctx.cwd);
			return textResult(JSON.stringify({ swarmId: st.swarmId, tmuxSession: st.tmuxSession, agents: Object.values(st.agents) }, null, 2), { state: st });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_spawn_agent",
		label: "Swarm Spawn",
		description: "Spawn a new pi agent in a tmux window in the same working directory. The new agent shares project extensions and skills. Requires tmux.",
		promptGuidelines: ["Use `swarm_spawn_agent` when the user asks to create a pi agent/swarm worker for parallel planning, review, or coding."],
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Stable agent id, e.g. planner or reviewer. Lowercase letters, digits, dash and underscore are safest." })),
			role: Type.String({ description: "Role/instructions for the agent." }),
			roleKind: Type.Optional(Type.String({ description: "Explicit role kind override (orchestrator/planner/reviewer/tester/observer/implementer/worker). Pinned so it is not re-derived from id/role. Defaults to inference (id-first, then role text)." })),
			model: Type.Optional(Type.String({ description: "pi model id, or the preset alias 'fast' (expands to gpt-5.4-mini/openai). Defaults to PI_SWARM_DEFAULT_MODEL/current session model, fallback glm-5.1." })),
			provider: Type.Optional(Type.String({ description: "pi provider id. Defaults to PI_SWARM_DEFAULT_PROVIDER or model preset provider (zai-coding-cn for glm-5.1, openai for gpt-5.4-mini)." })),
			initialPrompt: Type.Optional(Type.String({ description: "Optional first prompt to send into the spawned agent after pi starts." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				await trace(p, "agent.spawn.request", { requestedBy: currentAgentId(), ...params });
				// Explicit model / 'fast' preset pin the slot; otherwise spawnAgent consults the
				// model pool (if configured) before falling back to the single default.
				const model = params.model === "fast" ? FAST_MODEL : params.model || undefined;
				const provider = params.provider || (params.model === "fast" ? FAST_PROVIDER : undefined);
				const r = await spawnAgent(pi, ctx.cwd, p, st, { ...params, model, provider });
				await writeState(p, st);
				return { swarmId: st.swarmId, tmuxSession: st.tmuxSession, ...r };
			});
			return textResult(`Spawned ${result.agent.id} at ${result.agent.tmuxTarget}\nIdentity: ${relative(ctx.cwd, result.identity)}\nSnapshot: ${relative(ctx.cwd, result.snapshot)}`, result);
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_agent_identity",
		label: "Swarm Identity",
		description: "Read or refresh a swarm agent's durable Markdown identity card under .pi/swarm/agents/<agent-id>.md.",
		promptGuidelines: ["Use `swarm_agent_identity` when you need a swarm agent's role, protocol, mailbox, or identity file path."],
		parameters: Type.Object({
			agentId: Type.Optional(Type.String({ description: "Agent id. Defaults to current PI_SWARM_AGENT_ID or orchestrator." })),
			refresh: Type.Optional(Type.Boolean({ description: "Regenerate the identity markdown from current swarm state before reading. Defaults to false." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const agentId = safeId(params.agentId || currentAgentId());
			const ov = overridePath(p, agentId);
			// Rebuild the EFFECTIVE identity (generated base + optional override + provenance) when refreshing
			// or when no effective file exists yet. The override file is only ever READ, never generated.
			if (params.refresh || !existsSync(identityPath(p, agentId))) {
				await withLock(p, async () => {
					const st = await readState(p, ctx.cwd);
					const agent = st.agents[agentId];
					if (!agent) throw new Error(`Unknown swarm agent: ${agentId}`);
					await writeEffectiveIdentity(ctx.cwd, p, st, agent, { reason: params.refresh ? "refresh" : "initial" });
					await writeState(p, st);
				});
			}
			const file = identityPath(p, agentId);
			const markdown = await readFile(file, "utf8");
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[agentId];
			await trace(p, "agent.identity.read", { agentId, file: relative(ctx.cwd, file), refresh: Boolean(params.refresh), overridePresent: existsSync(ov) });
			return textResult(markdown, { agent, identity: relative(ctx.cwd, file), override: relative(ctx.cwd, ov), identityVersion: agent?.identityVersion, identityHash: agent?.identityHash, identityLoadedAt: agent?.identityLoadedAt });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_reload_identity",
		label: "Swarm Reload Identity",
		description: "Regenerate the effective identity (generated card + optional .override.md) for an agent, stamp identityVersion/identityHash/identityLoadedAt, and (if its tmux pane is alive) inject a [PI-SWARM IDENTITY RELOAD] instruction so the agent re-reads its identity now. Best-effort tmux injection never fails the reload; if the pane is dead the new identity takes effect on the next session_start.",
		promptGuidelines: ["Use `swarm_reload_identity` after editing an agent's .override.md or when a running agent should pick up new identity instructions."],
		parameters: Type.Object({
			agentId: Type.String({ description: "Agent id whose effective identity should be regenerated." }),
			note: Type.Optional(Type.String({ description: "Optional reason/note appended to the injected reload instruction and traced." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const agentId = safeId(params.agentId);
			const r = await reloadIdentity(pi, ctx.cwd, p, agentId, { note: params.note, source: "tool" });
			return textResult(
				`Reloaded identity for ${agentId}: version=${r.provenance.version}, hash=${r.provenance.shortHash}, override=${r.provenance.overridePresent}, tmuxAlive=${r.tmuxAlive}, injected=${r.injected}. Effective file: ${relative(ctx.cwd, r.file)}`,
				{ agentId, version: r.provenance.version, hash: r.provenance.hash, shortHash: r.provenance.shortHash, loadedAt: r.provenance.loadedAt, overridePresent: r.provenance.overridePresent, tmuxAlive: r.tmuxAlive, injected: r.injected, file: relative(ctx.cwd, r.file) }
			);
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_trace",
		label: "Swarm Trace",
		description: "Read recent structured pi-swarm trace events. Output is truncated to pi's default limits.",
		promptGuidelines: ["Use `swarm_trace` to debug swarm spawning, mailbox, or tmux injection behavior."],
		parameters: Type.Object({ limit: Type.Optional(Type.Number({ description: "Number of recent trace lines. Defaults to 80." })) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			if (!existsSync(p.events)) return textResult("No swarm trace file yet.", { path: relative(ctx.cwd, p.events) });
			const lines = (await readFile(p.events, "utf8")).trim().split("\n").filter(Boolean);
			const selected = lines.slice(-Math.max(1, Math.min(500, params.limit || 80))).join("\n");
			return textResult(truncate(selected), { path: relative(ctx.cwd, p.events), totalLines: lines.length });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_capture_agent_pane",
		label: "Swarm Capture",
		description: "Capture the tmux pane history for a swarm agent and save it under .pi/swarm/traces/tmux for debugging.",
		promptGuidelines: ["Use `swarm_capture_agent_pane` to debug what a spawned agent is currently seeing or doing in tmux."],
		parameters: Type.Object({ agentId: Type.String({ description: "Agent id to capture." }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[safeId(params.agentId)];
			if (!agent) throw new Error(`Unknown swarm agent: ${params.agentId}`);
			const file = await capturePane(pi, p, agent.id, agent.tmuxTarget, `manual-${Date.now()}`);
			await trace(p, "tmux.capture", { agentId: agent.id, target: agent.tmuxTarget, file: relative(ctx.cwd, file) });
			return textResult(`Captured ${agent.id} pane to ${relative(ctx.cwd, file)}`, { file, agent });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_dead_letters",
		label: "Swarm Dead Letters",
		description: "List or inspect dead-lettered swarm messages that exceeded max attempts or TTL.",
		promptGuidelines: ["Use `swarm_dead_letters` to review messages that failed permanently and may require manual intervention."],
		parameters: Type.Object({
			agentId: Type.Optional(Type.String({ description: "Filter by recipient agent id." })),
			messageId: Type.Optional(Type.String({ description: "Specific dead-letter message id to inspect." })),
			limit: Type.Optional(Type.Number({ description: "Maximum records to return. Defaults to 20." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const st = await readState(p, ctx.cwd);
			let records = Object.values(st.messages || {}).filter((r) => r.status === "dead_letter");
			if (params.messageId) records = records.filter((r) => r.id === params.messageId);
			if (params.agentId) records = records.filter((r) => r.to === safeId(params.agentId!));
			records = records.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(-Math.max(1, Math.min(100, params.limit || 20)));
			return textResult(JSON.stringify({ count: records.length, records }, null, 2), { records });
		},
	}))

	// === Agent lifecycle manipulation tools (register / stop / restart / set_role / pause / send_keys / attach / release) ===

	pi.registerTool(defineTool({
		name: "swarm_register_agent",
		label: "Swarm Register",
		description: "Adopt an EXISTING tmux pane into the swarm under a role WITHOUT spawning a new pi. Upsert by id: re-registering with a different tmuxTarget retargets the agent (fixes the 'tmuxTarget: unknown' ghost-agent case for externally-started agents). The operator asserts the pane is available for the role. The reserved 'orchestrator' id is refused here — opt a session in as the PM via '/swarm register here orchestrator' or PI_SWARM_IS_ORCHESTRATOR=1.",
		promptGuidelines: ["Use `swarm_register_agent` to bring an already-running pi pane (or shell pane you will start pi in) into the swarm as a role, instead of spawning a fresh agent. Prefer `swarm_spawn_agent` when you need a brand new pi."],
		parameters: Type.Object({
			tmuxTarget: Type.String({ description: "Tmux target of the pane to adopt, e.g. session:window.pane, session:window, %paneid, or =session. Pass the special token 'here' (also 'self'/'current'/'.') to adopt the CURRENT pane the tool is running in — useful to register this very pi session without first discovering its target." }),
			id: Type.Optional(Type.String({ description: "Stable agent id. If the pane already runs pi with PI_SWARM_AGENT_ID set, pass that same id so the record matches." })),
			role: Type.String({ description: "Role/instructions for the agent." }),
			roleKind: Type.Optional(Type.String({ description: "Explicit role kind override (orchestrator/planner/reviewer/tester/observer/implementer/worker). Pinned; otherwise derived from id+role, or preserved from an existing pin." })),
			model: Type.Optional(Type.String({ description: "pi model id. Defaults to the existing agent's model, then session default." })),
			provider: Type.Optional(Type.String({ description: "pi provider id." })),
			initialPrompt: Type.Optional(Type.String({ description: "Optional first prompt injected into the adopted pane (defaults to a role/identity kickoff)." })),
			inject: Type.Optional(Type.Boolean({ description: "Inject the identity kickoff into the pane. Defaults to true; set false to register bookkeeping only." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				await trace(p, "agent.register.request", { requestedBy: currentAgentId(), ...params });
				const r = await registerAgent(pi, ctx.cwd, p, st, params);
				await writeState(p, st);
				return r;
			});
			const a = result.agent;
			return textResult(
				`Registered ${a.id} at ${a.tmuxTarget} (alive=${result.tmuxAlive} piRunning=${result.piRunning} injected=${result.injected}). Identity: ${relative(ctx.cwd, result.identity)}`,
				{ ...result }
			);
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_stop_agent",
		label: "Swarm Stop",
		description: "Stop a swarm agent: kill its tmux pane/window and mark it stopped. Refuses if the agent has active tasks unless force=true. Mailbox, identity, and history persist via the stable id.",
		promptGuidelines: ["Use `swarm_stop_agent` to retire an agent. For a non-destructive park that keeps the pane alive, use `swarm_set_agent_paused` instead."],
		parameters: Type.Object({
			agentId: Type.String({ description: "Agent id to stop." }),
			force: Type.Optional(Type.Boolean({ description: "Stop even if the agent has active tasks. Defaults to false." })),
			killPane: Type.Optional(Type.Boolean({ description: "Kill the tmux pane/window. Defaults to true; set false to mark stopped without touching tmux." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			requireOrchestratorAuthority(currentAgentId(), "swarm_stop_agent");
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				heartbeatOrchestratorLeader(st, Date.now(), process.pid, "stop_agent");
				const r = await stopAgent(pi, p, st, safeId(params.agentId), { force: params.force, killPane: params.killPane });
				await writeState(p, st);
				return r;
			});
			return textResult(`Stopped ${result.agent.id}: killed=${result.killed} method=${result.method}.`, result);
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_restart_agent",
		label: "Swarm Restart",
		description: "Stop and respawn a fresh pi at the SAME id so mailbox, identity, and history persist. Reuses the recorded role/model/provider. Useful after a crash or to clear context.",
		promptGuidelines: ["Use `swarm_restart_agent` to reset an agent's pi process without losing its swarm identity/mailbox. This force-stops first (any active tasks are released to the fresh process). Default kills the pane; pass `killPane=false` to keep it alive (the agent record still flips to `running`). The freshly started pi reuses the same id, mailbox, and identity."],
		parameters: Type.Object({
			agentId: Type.String({ description: "Agent id to restart." }),
			model: Type.Optional(Type.String({ description: "Optional model override for the respawned pi (defaults to the agent's recorded model)." })),
			provider: Type.Optional(Type.String({ description: "Optional provider override for the respawned pi (defaults to the agent's recorded provider)." })),
			initialPrompt: Type.Optional(Type.String({ description: "Optional first prompt sent into the respawned pi." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const r = await restartAgent(pi, ctx.cwd, p, st, safeId(params.agentId), { initialPrompt: params.initialPrompt, model: params.model, provider: params.provider });
				await writeState(p, st);
				return r;
			});
			return textResult(`Restarted ${result.agent.id} at ${result.agent.tmuxTarget} (kill=${result.kill.method}). Snapshot: ${relative(ctx.cwd, result.snapshot)}`, result);
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_set_role",
		label: "Swarm Set Role",
		description: "Change an agent's role/roleKind/capabilities at runtime and regenerate + inject its identity, WITHOUT respawning. roleKind is re-derived from the new role unless roleKind is explicitly passed (then pinned).",
		promptGuidelines: ["Use `swarm_set_role` to repurpose an idle agent for a different role instead of spawning a new one. After a role change the agent may leave the reuse pool for the previous role kind and enter it for the new one; subsequent `swarm_assign_task` reuse calls will pick it up under the new role."],
		parameters: Type.Object({
			agentId: Type.String({ description: "Agent id to repurpose." }),
			role: Type.Optional(Type.String({ description: "New role/instructions text." })),
			roleKind: Type.Optional(Type.String({ description: "New role kind (pinned)." })),
			capabilities: Type.Optional(Type.Array(Type.String(), { description: "New capabilities list (replaces existing)." })),
			note: Type.Optional(Type.String({ description: "Optional note appended to the injected identity reload prompt." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const r = await setAgentRole(pi, ctx.cwd, p, st, safeId(params.agentId), params);
				await writeState(p, st);
				return r;
			});
			const a = result.agent;
			return textResult(`Set role for ${a.id}: role=${a.role} roleKind=${a.roleKind} caps=[${a.capabilities.join(",")}] (v${result.provenance.version} injected=${result.injected}).`, result);
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_set_agent_paused",
		label: "Swarm Pause/Resume",
		description: "Park (paused=true) or resume (paused=false) an agent in the reuse pool WITHOUT killing its pane. Paused agents are skipped by reuse/assignment suggestions but still appear in status/list and keep running.",
		promptGuidelines: ["Use `swarm_set_agent_paused` with paused=true to drain an agent from new assignments while keeping its pane alive; use paused=false to resume."],
		parameters: Type.Object({
			agentId: Type.String({ description: "Agent id to pause/resume." }),
			paused: Type.Boolean({ description: "true to pause (drain from reuse), false to resume." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const agent = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const a = setAgentPaused(st, safeId(params.agentId), params.paused);
				await trace(p, "agent.set_paused", { agentId: a.id, paused: Boolean(a.paused) });
				await writeState(p, st);
				return a;
			});
			return textResult(`${agent.id} ${agent.paused ? "paused" : "resumed"}.`, { agent });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_send_keys",
		label: "Swarm Send Keys",
		description: "Send raw tmux keys to an agent's pane: interrupt (C-c), dismiss, navigate, or type text. Non-literal mode interprets tmux key names; literal mode sends exact text. Powerful/destructive — use to unstick a runaway agent.",
		promptGuidelines: ["Use `swarm_send_keys` to send raw tmux input to an agent pane, e.g. C-c to interrupt. Prefer the normal mailbox/identity tools for coordination; this is an escape hatch. Targets another agent's pane by id — never use to send keys into the orchestrator pane from a worker."],
		parameters: Type.Object({
			agentId: Type.String({ description: "Agent id whose pane to send keys to." }),
			keys: Type.String({ description: "Keys to send. Non-literal: space-separated tmux key names (C-c, Up, Enter). Literal: exact text." }),
			literal: Type.Optional(Type.Boolean({ description: "Send keys as literal text via send-keys -l. Defaults to false (interpret tmux key names)." })),
			enter: Type.Optional(Type.Boolean({ description: "Append an Enter after the keys. Defaults to false." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[safeId(params.agentId)];
			if (!agent) throw new Error(`Unknown swarm agent: ${params.agentId}`);
			await sendKeys(pi, p, agent.tmuxTarget, params.keys, { literal: params.literal, enter: params.enter });
			await trace(p, "agent.send_keys", { agentId: agent.id, target: agent.tmuxTarget, literal: Boolean(params.literal), enter: Boolean(params.enter) });
			return textResult(`Sent keys to ${agent.id} (${agent.tmuxTarget}).`, { agent });
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_attach_agent",
		label: "Swarm Attach",
		description: "Return the tmux commands to attach to / select an agent's pane so a human can jump into it. Read-only convenience; does not run tmux.",
		promptGuidelines: ["Use `swarm_attach_agent` to get the tmux attach/select commands for an agent's pane when the user wants to observe or interact with it directly."],
		parameters: Type.Object({ agentId: Type.String({ description: "Agent id." }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[safeId(params.agentId)];
			if (!agent) throw new Error(`Unknown swarm agent: ${params.agentId}`);
			const cmds = attachTarget(agent);
			return textResult(`${cmds.attach}\n${cmds.selectWindow}\n${cmds.selectPane}`, cmds);
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_release_agent_task",
		label: "Swarm Release Task",
		description: "Remove an active-task pointer from an agent when automatic release needs repair. By default only releases pointers whose task is terminal (done/failed/cancelled) or missing; pass force=true to release any. Does not change task/node state.",
		promptGuidelines: ["Use `swarm_release_agent_task` to clear a stale activeTaskIds pointer left after a task closed, when reconcile Swarm_update_task did not self-heal. Prefer `swarm_reconcile` first."],
		parameters: Type.Object({
			agentId: Type.String({ description: "Agent id whose active-task pointer to release." }),
			taskId: Type.Optional(Type.String({ description: "Specific task id to release. If omitted, all of the agent's active tasks are considered." })),
			force: Type.Optional(Type.Boolean({ description: "Release even non-terminal tasks. Defaults to false." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			requireOrchestratorAuthority(currentAgentId(), "swarm_release_agent_task");
			const result = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				heartbeatOrchestratorLeader(st, Date.now(), process.pid, "release_agent_task");
				const agent = st.agents[safeId(params.agentId)];
				if (!agent) throw new Error(`Unknown swarm agent: ${params.agentId}`);
				const candidate = (agent.activeTaskIds || []).slice().filter((tid) => !params.taskId || tid === safeId(params.taskId));
				const removed: string[] = [];
				const refused: { taskId: string; status: string }[] = [];
				for (const tid of candidate) {
					let status = "unknown";
					const tp = taskPaths(p, tid);
					if (existsSync(tp.taskJson)) { try { status = (await readTaskState(tp.taskJson)).status; } catch { /* unknown */ } }
					const terminal = status === "done" || status === "failed" || status === "cancelled" || status === "unknown";
					if (terminal || params.force) { agent.activeTaskIds = agent.activeTaskIds.filter((t) => t !== tid); removed.push(tid); }
					else refused.push({ taskId: tid, status });
				}
				agent.updatedAt = now();
				await trace(p, "agent.release_task", { agentId: agent.id, removed, refused, force: Boolean(params.force) });
				await writeState(p, st);
				return { removed, refused };
			});
			return textResult(JSON.stringify({ agentId: safeId(params.agentId), ...result }, null, 2), result);
		},
	}))
}
