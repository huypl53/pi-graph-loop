// === swarm/hooks/session.ts — session_start / before_agent_start / agent_start (Phase 7) ===
// Extracted verbatim from ../hooks.ts (Phase 7 modular split; canonical logic unchanged).
//
// session_start: identity stamping (PI_SWARM_SESSION_STARTED_AT), engine-retry incident clear
// (Issue 17 binding C1), tool gating, pool scaffold + launch health (root-only), agent record
// materialise/refresh, root leader lease refresh + startRootPump, worker pull-surface.
// before_agent_start: root orchestrator prompt injection / worker identity-card prompt.
// agent_start: pid-guarded busy stamp + idle-epoch reset + auto-focus.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { relative } from "node:path";
import type { ModelSlot } from "../types.ts";
import { SWARM_GUEST_ID } from "../constants.ts";
import { currentAgentId, currentModel, currentProvider } from "../session.ts";
import { validateSwarmSettings } from "../pool.ts";
import { responseMissingRecords } from "../mailbox.ts";
import { ensureAgentDefaults, inferRoleKind, now } from "../utils.ts";
import { ensureDirs, identityPath, mailboxPath, paths, readState, trace, withLock, writeState } from "../state.ts";
import { logSwarmError } from "../errorlog.ts";
import { ensureRoot, heartbeatRootLeader } from "../identity.ts";
import { resetIdleEpochState } from "../reconcile.ts";
import { applySwarmToolGating } from "../tools/gating.ts";
import { ensurePoolScaffold, ensureGlobalPoolScaffold, runRootPoolScaffoldAndHealth } from "../pool-scaffold.ts";
import { maybeAutoFocusOnBusy } from "../focus.ts";
import { engineRetryIncidentsMap } from "./streaks.ts";
import { surfaceAgentPending } from "./pump-manager.ts";

export function registerSessionHooks(
	pi: ExtensionAPI,
	// DI: startRootPump lives on the ../hooks.ts facade (its literal watchdog classification
	// block is pinned there by root-wake C2/C7). Injected here so this module does not import
	// the facade (avoids a static hooks.ts <-> hooks/session.ts import cycle).
	startRootPump: (ctx: any, reason?: string) => Promise<void>,
) {
	pi.on("session_start", async (_event, ctx) => {
		// Issue 16 (C2 + B1 fix): stamp the session's start time as a process-wide env var so
		// RecentSpawn stamps + isSameRootLeader comparisons can detect pid recycling under a
		// different session. Guarded so a second session_start in the same process (e.g. after
		// /reload) doesn't churn the value mid-flight. Lives at the top of registerSwarmHooks's
		// session_start handler (NOT index.ts, which has no pi.on(...) and would create
		// non-deterministic ordering with this handler).
		if (!process.env.PI_SWARM_SESSION_STARTED_AT) {
			process.env.PI_SWARM_SESSION_STARTED_AT = new Date().toISOString();
		}
		// Issue 17 (binding C1 — symmetry): clear the per-agent engine-retry incident on session_start.
		// A stale incident from a prior session cannot survive a fresh session (the engine retry context
		// is lost across restarts); clearing here prevents a stuck "exhausted" gate from leaking forward.
		// The Map is keyed by agentId so we only delete the entry for THIS session's agent (other agents'
		// incidents are process-shared state and survive; their sessions are independent processes).
		const agentIdEarly = currentAgentId();
		if (agentIdEarly !== SWARM_GUEST_ID) engineRetryIncidentsMap().delete(agentIdEarly);
		const p = paths(ctx.cwd);
		await ensureDirs(p);
		const agentId = agentIdEarly;
		const guest = agentId === SWARM_GUEST_ID;
		// Identity-gated tool visibility: a guest session loses the swarm tool surface (it is a plain coding
		// session, not a swarm participant); registered agents and the root keep it. The /swarm slash
		// command is unaffected, so a guest can still opt in via `/swarm register here <role>`. Re-applied on
		// opt-in (command.ts) so an in-session identity change re-enables the swarm tools immediately.
		applySwarmToolGating(pi);
		// === Issue 20 + v4.2: pool-scaffold on root session_start ===
		if (agentId === "root") {
			await runRootPoolScaffoldAndHealth(ctx, p);
		}
		const ts = now();
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			await trace(p, "session.start", { agentId, guest, mode: ctx.mode, state: relative(ctx.cwd, p.state) });
			if (guest) {
				// Anonymous swarm session (no PI_SWARM_AGENT_ID and no explicit root opt-in): stay
				// inert. Do NOT register an agent record, do NOT call ensureRoot (which would refresh
				// the root pseudo-agent heartbeat and mask a dead/stalled PM), and do NOT start the
				// root mailbox pump (which would surface root mail here). The swarm tool surface
				// is gated off (see applySwarmToolGating above) — this session cannot act as or consume the
				// root. It can still opt in via `/swarm register here <role>` (the slash command is
				// unaffected by tool gating), which re-applies gating to re-enable the swarm tools. See
				// isRootSession() for the explicit opt-in path.
				return;
			}
			if (agentId === "root") {
				ensureRoot(st, ctx.cwd, p);
				// Multi-root policy (issue 8): the heartbeat is now driven by the gate, not by
				// ensureRoot. Layer the heartbeatRootLeader call here so an root
				// session_start both materialises the record and refreshes the leader lease.
				try {
					heartbeatRootLeader(st, Date.now(), process.pid, "session_start");
				} catch (err: any) {
					// A non-leader root session_start must NOT crash the session; trace + skip the
					// pump install (handled at startRootPump preflight below).
					await trace(p, "session.root_denied", {
						agentId,
						callerPid: process.pid,
						error: String((err as Error)?.message || err),
					}).catch(() => {});
				}
				await writeState(p, st);
			} else if (!st.agents[agentId]) {
				st.agents[agentId] = {
					id: agentId,
					role: "Externally started swarm agent",
					status: "running",
					roleKind: inferRoleKind(agentId, "Externally started swarm agent"),
					capabilities: [],
					activeTaskIds: [],
					maxConcurrentTasks: 1,
					runtimeStatus: "starting",
					health: "healthy",
					lastSessionStartAt: ts,
					lastAgentStartAt: ts,
					pid: process.pid,
					tmuxSession: st.tmuxSession,
					tmuxWindow: agentId,
					tmuxTarget: "unknown",
					model: currentModel(),
					provider: currentProvider(),
					cwd: ctx.cwd,
					mailbox: relative(ctx.cwd, mailboxPath(p, agentId)),
					createdAt: ts,
					updatedAt: ts,
				};
				await writeState(p, st);
			} else if (st.agents[agentId]) {
				st.agents[agentId].lastSessionStartAt = ts;
				st.agents[agentId].lastHeartbeatAt = ts;
				st.agents[agentId].status = "running";
				st.agents[agentId].runtimeStatus = responseMissingRecords(st, agentId).length ? "response_missing" : "idle";
				st.agents[agentId].health = "healthy";
				st.agents[agentId].pid = process.pid;
				st.agents[agentId].updatedAt = ts;
				await writeState(p, st);
				await trace(p, "agent.status", {
					agentId,
					runtimeStatus: st.agents[agentId].runtimeStatus,
					health: st.agents[agentId].health,
				});
			}
		});
		if (ctx.hasUI) ctx.ui.setStatus("swarm", `swarm:${agentId}`);
		if (agentId === "root") {
			await startRootPump(ctx);
		} else if (ctx.mode === "tui") {
			// Pull-based delivery for workers (root fix for the restart/injection-loss class): on session
			// start, surface any unacked, non-dead-letter, non-superseded messages addressed to THIS agent
			// directly into its conversation — no tmux injection, no reconcile, no root involvement.
			// Mailbox is the source of truth; tmux injection stays as an opportunistic fast-path.
			try {
				await surfaceAgentPending(pi, ctx, p, agentId, "session_start");
				// Re-check on settle: a message may have arrived (or a failed injection skipped) while the
				// agent was busy; settling idle is the natural moment to catch up.
				// (hook registered below; the surface here covers the startup gap)
			} catch (err: any) {
				await trace(p, "agent.surface_error", {
					agentId,
					phase: "session_start",
					error: String((err as Error)?.message || err),
				}).catch(() => {});
			}
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const agentId = currentAgentId();
		if (agentId === "root") {
			return {
				systemPrompt: `${event.systemPrompt}\n\n[PI-SWARM ROOT ORCHESTRATOR]\nYou are agent \`root\`, the Swarm Root Orchestrator. Your primary role is planning, decomposing tasks, spawning/managing agents, and delegating work using swarm tools (\`swarm_create_task\`, \`swarm_assign_task\`, \`swarm_send_message\`). You may perform quick direct file edits when optimal, but substantial code implementation and bug fixes should be delegated to swarm worker agents.\n[/PI-SWARM ROOT ORCHESTRATOR]`,
			};
		}
		const p = paths(ctx.cwd);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[agentId];
			if (agent) {
				agent.pid = process.pid;
				agent.updatedAt = now();
				await writeState(p, st);
			}
		});
		const st = await readState(p, ctx.cwd);
		const agent = st.agents[agentId];
		if (!agent) return;
		const identityRel = relative(ctx.cwd, identityPath(p, agentId));
		return {
			systemPrompt: `${event.systemPrompt}\n\nPi Swarm identity: you are agent \`${agentId}\` (${agent.role}). Your durable role card is \`${identityRel}\`. Follow it as your agent-specific AGENT.md. Use swarm tools for peer coordination.`,
		};
	});

	pi.on("agent_start", async (_event, ctx) => {
		const agentId = currentAgentId();
		if (agentId === "root") return;
		const p = paths(ctx.cwd);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[agentId];
			if (!agent) return;
			if (agent.pid && agent.pid !== process.pid) return; // pid-guard
			const ts = now();
			const resurrect = agent.status === "stopped" || agent.health === "unhealthy";
			agent.lastAgentStartAt = ts;
			agent.runtimeStatus = "busy";
			agent.health = "healthy";
			agent.status = "running";
			agent.lastHeartbeatAt = ts;
			agent.pid = process.pid;
			agent.updatedAt = ts;
			if (st.idleNudgeState) {
				resetIdleEpochState(st.idleNudgeState, [agentId]);
			}
			await writeState(p, st);
			await trace(p, "agent.status", { agentId, runtimeStatus: agent.runtimeStatus, health: agent.health, resurrect });
		});

		try {
			await maybeAutoFocusOnBusy(pi, ctx, agentId);
		} catch (err: any) {
			await logSwarmError(ctx?.cwd, "hooks", "agent_start.auto_focus_failed", err, { agentId });
		}
	});
}
