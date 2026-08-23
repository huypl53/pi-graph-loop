// === swarm/hooks.ts — event hooks + orchestrator mailbox pump (verbatim from index.ts) ===
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join, dirname, relative, sep } from "node:path";
import type { MessageResponseStatus } from "./types.ts";
import { SETTLE_NOTIFY_COOLDOWN_MS, SWARM_GUEST_ID, PUMP_SESSION_ID_CAP, POOL_WATCH_INTERVAL_MS, POOL_WATCH_RESPAWN_COOLDOWN_MS } from "./constants.ts";
import { currentAgentId, currentModel, currentProvider, isOrchestratorSession } from "./session.ts";
import { deliverMessageLocked, readMailbox, responseMissingRecords, upsertMessageRecord } from "./mailbox.ts";
import { ensureAgentDefaults, inferRoleKind, now } from "./utils.ts";
import { ensureDirs, identityPath, mailboxPath, paths, readState, trace, withLock, writeState, writeTaskState } from "./state.ts";
import { ensureOrchestrator } from "./identity.ts";
import { formatSwarmMessageContent, parseSystemDelivery } from "./delivery.ts";
import { pumpOrchestratorMailbox, reconcile, runtimeTaskWarnings } from "./reconcile.ts";
import { scanAgentOpenAssignments } from "./taskgraph.ts";
import { applySwarmToolGating } from "./tools/gating.ts";
import { recordSlotFailure } from "./pool.ts";
import { restartAgent } from "./agents.ts";
import type { SwarmAgent } from "./types.ts";
import { isPanePiLike, isTmuxRunning, tmux } from "./tmux.ts";

// Orchestrator mailbox pump state. Module-level so the PM pump can be (re)started from outside the
// session_start hook — notably by `/swarm register here orchestrator`, which opts a running session in
// as the orchestrator after startup. `swarmPi` is captured once in registerSwarmHooks (always called
// first by index.ts) and reused so there is a single pump per extension load.
let swarmPi: ExtensionAPI | undefined;
let orchestratorMailboxTimer: NodeJS.Timeout | undefined;
let orchestratorMailboxPumpRunning = false;
let poolWatchTimer: NodeJS.Timeout | undefined;
let poolWatchRunning = false;

// Pool auto-rotation (fully automatic — no manual command needed): scan the agents this swarm
// manages; when a running agent's pane is dead or not running pi (crashed, exited on quota/API
// error), bench its model slot and respawn the SAME agent id (mailbox/identity/history preserved)
// on a different healthy slot. Runs as a TUI interval in the orchestrator PM session — the one
// long-lived process that owns the swarm — so failover happens even while workers are down.
// Per-agent throttle: POOL_WATCH_RESPAWN_COOLDOWN_MS between respawn attempts so a hopeless slot
// doesn't produce a spawn loop.
export async function watchPoolOnce(pi: ExtensionAPI, cwd: string, p: Paths): Promise<{ checked: number; respawned: string[]; benched: string[] }> {
	const respawned: string[] = [];
	const benched: string[] = [];
	// Snapshot candidates under NO lock (tmux probes are slow); re-check under the lock before acting.
	const candidates: SwarmAgent[] = [];
	{
		const st = await readState(p, cwd);
		for (const agent of Object.values(st.agents)) {
			ensureAgentDefaults(agent);
			if (agent.paused || agent.id === "orchestrator") continue;
			// Running agents with a dead/not-pi pane crashed (quota/API error exit): rotate them.
			// Stopped agents are eligible ONLY if the stop was a crash (session_shutdown marked them
			// stopped when the pane died), not an intentional /swarm stop (manualStop).
			if (agent.manualStop) continue;
			if (agent.status !== "running" && agent.status !== "stopped") continue;
			if (!agent.tmuxTarget || agent.tmuxTarget === "unknown") continue;
			candidates.push(agent);
		}
	}
	let checked = 0;
	for (const snap of candidates) {
		const alive = await isTmuxRunning(pi, snap.tmuxTarget).catch(() => false);
		let piLike = { piLike: true, command: "" };
		if (alive) {
			piLike = await isPanePiLike(pi, snap.tmuxTarget).catch(() => ({ piLike: false, command: "error" }));
		}
		checked++;
		if (alive && piLike.piLike) continue;
		const reason = alive ? `pane alive but not pi (pane_current_command=${piLike.command || "?"})` : "pane dead";
		const result = await withLock(p, async () => {
			const st = await readState(p, cwd);
			const agent = st.agents[snap.id];
			if (!agent || agent.paused || agent.manualStop) return undefined;
			if (agent.status !== "running" && agent.status !== "stopped") return undefined;
			if (!agent.tmuxTarget || agent.tmuxTarget === "unknown") return undefined;
			// Re-probe under the lock: state may have changed while we probed other agents.
			const stillAlive = await isTmuxRunning(pi, agent.tmuxTarget).catch(() => false);
			const stillPi = stillAlive ? (await isPanePiLike(pi, agent.tmuxTarget).catch(() => ({ piLike: false, command: "error" }))).piLike : false;
			if (stillAlive && stillPi) return undefined;
			// Throttle per agent: don't respawn the same agent more than once per cooldown window.
			const last = agent.lastPoolRespawnAt ? new Date(agent.lastPoolRespawnAt).getTime() : 0;
		if (Date.now() - last < POOL_WATCH_RESPAWN_COOLDOWN_MS) return undefined;
			agent.lastPoolRespawnAt = new Date().toISOString();
			// Bench the slot the agent was running on (its pane died; quota/API errors are the common cause).
			const { effectiveConfig } = await import("./pool.ts");
			const { slots } = effectiveConfig();
			const slot = slots.find((s) => s.model === agent.model);
			if (slot) {
				await recordSlotFailure(p, slot, `agent ${agent.id} pane down: ${reason}`);
				benched.push(`${slot.provider || "(default)"}/${slot.model}`);
			}
			// Respawn on a different healthy slot (restartAgent re-picks; mailbox pending is re-surfaced
			// by spawnAgent's kickoff). Pass rotateFromSlot so a benched-slot check definitely rotates.
			await restartAgent(pi, cwd, p, st, agent.id, { rotateFromSlot: slot ? `${slot.provider || "(default)"}/${slot.model}` : undefined });
			await writeState(p, st);
			return agent.id;
		});
		if (result) respawned.push(result);
	}
	if (respawned.length || benched.length) {
		await trace(p, "pool.watch", { checked, respawned, benched }).catch(() => {});
	}
	return { checked, respawned, benched };
}

export function startPoolWatch(pi: ExtensionAPI, cwd: string) {
	if (poolWatchTimer) return;
	const p = paths(cwd);
	poolWatchTimer = setInterval(() => {
		if (poolWatchRunning) return;
		poolWatchRunning = true;
		watchPoolOnce(pi, cwd, p).catch(() => {}).finally(() => { poolWatchRunning = false; });
	}, POOL_WATCH_INTERVAL_MS);
}

export function stopPoolWatch() {
	if (poolWatchTimer) clearInterval(poolWatchTimer);
	poolWatchTimer = undefined;
}

export function stopOrchestratorPump() {
	if (orchestratorMailboxTimer) clearInterval(orchestratorMailboxTimer);
	orchestratorMailboxTimer = undefined;
	stopPoolWatch();
}

// Pull-based worker delivery: surface unacked messages addressed to this agent into its own TUI
// conversation via pi.sendMessage (no tmux). Idempotent per message via the shared agentSurfaced ledger
// (per-agent, capped), so restarts re-surface only what is still unacked. Never targets the orchestrator
// (that is pumpOrchestratorMailbox's job) and never surfaces dead-lettered or superseded messages.
export async function surfaceAgentPending(pi: ExtensionAPI, ctx: any, p: Paths, agentId: string, reason: string) {
	if (currentAgentId() !== agentId) return { surfaced: 0, ids: [] as string[] };
	const idleAtStart = ctx.mode === "tui" ? ctx.isIdle() : false;
	const result = await withLock(p, async () => {
		const st = await readState(p, ctx.cwd);
		st.agentSurfaced ||= {};
		const surfaced = new Set(st.agentSurfaced[agentId] || []);
		const pending = Object.values(st.messages || {})
			.filter((r) => r.to === agentId && !r.ackedAt && r.status !== "dead_letter" && !r.superseded && !surfaced.has(r.id))
			.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
			.slice(0, 10);
		if (pending.length) {
			st.agentSurfaced[agentId] = [...surfaced, ...pending.map((r) => r.id)].slice(-PUMP_SESSION_ID_CAP);
		}
		await writeState(p, st);
		return { ids: pending.map((r) => r.id) };
	});
	if (!result.ids.length) return { surfaced: 0, ids: [] };
	if (ctx.mode !== "tui") {
		await trace(p, "mailbox.agent_surface_skip", { agentId, reason, count: result.ids.length, mode: ctx.mode });
		return { surfaced: 0, ids: result.ids };
	}
	// Read bodies from the mailbox (records carry no body).
	const msgs = await readMailbox(p, agentId);
	let delivered = 0;
	for (let i = 0; i < result.ids.length; i++) {
		const m = msgs.find((x) => x.id === result.ids[i]);
		if (!m) continue;
		// A requiresAck message is action-expected: trigger a real turn so the agent acts, not just sees.
		pi.sendMessage({
			customType: "swarm-message",
			content: formatSwarmMessageContent(m),
			display: true,
			details: m,
		}, i === 0 && idleAtStart ? { triggerTurn: true } : { deliverAs: "followUp" });
		delivered++;
	}
	await trace(p, "mailbox.agent_surface", { agentId, reason, count: delivered, ids: result.ids, idleAtStart });
	return { surfaced: delivered, ids: result.ids };
}

// (Re)start the orchestrator mailbox pump for this session: one immediate surface + a 5s TUI interval.
// No-op unless this session resolves to the orchestrator. Safe to call from session_start or from the
// `/swarm register here orchestrator` opt-in path. The captured ctx is session-bound; on stale-ctx
// errors the run() guard stops the pump cleanly (the next orchestrator session_start restarts it).
export async function startOrchestratorPump(ctx: any, reason = "session_start") {
	const pi = swarmPi;
	if (!pi) return;
	stopOrchestratorPump();
	// The auto-pump records a surfacing DECISION (per-pid set + writeState) in every orchestrator session,
	// including explicit orchestrator opt-in runs (PI_SWARM_IS_ORCHESTRATOR=1 or PI_SWARM_AGENT_ID=orchestrator).
	// The decision block is ctx-free file IO (see pumpOrchestratorMailbox), so it cannot hit
	// the "This extension ctx is stale after session replacement or reload" error. The delivery loop
	// (sendMessage/isIdle) and the trace that uses ctx.isIdle are now mode-gated to TUI only inside
	// pumpOrchestratorMailbox, so non-TUI sessions (print/rpc/json) never make ctx-bound calls.
	// The 5s polling interval is TUI-only (print sessions exit immediately after one turn); non-TUI
	// callers read mailboxes via swarm_check_mailbox, which never touches a captured ctx.
	if (currentAgentId() !== "orchestrator") return;
	const p = paths(ctx.cwd);
	// NOTE: the one-shot below is awaited (not fire-and-forget) so that a pi -p / print session — which
	// exits immediately after its single turn — actually completes the surfacing decision (writeState +
	// trace) before teardown. The interval timer remains fire-and-forget.
	const run = async (reason: string) => {
		if (orchestratorMailboxPumpRunning) return;
		orchestratorMailboxPumpRunning = true;
		try {
			await pumpOrchestratorMailbox(pi, ctx, p, reason);
		} catch (err: any) {
			// Session-safe resilience: if the captured ctx/pi was invalidated (session replacement/reload)
			// the pump's ctx-bound calls throw. Stop the pump cleanly instead of spamming stderr every 5s;
			// the next interactive orchestrator session_start restarts a fresh pump with a live ctx.
			const msg = String((err && err.message) || err);
			stopOrchestratorPump();
			await trace(p, "mailbox.orchestrator_pump_error", { reason, error: msg, stale: /stale after session/i.test(msg) }).catch(() => {});
		} finally { orchestratorMailboxPumpRunning = false; }
	};
	await run(reason);
	if (ctx.mode === "tui") orchestratorMailboxTimer = setInterval(() => { void run("interval"); }, 5_000);
}

export function registerSwarmHooks(pi: ExtensionAPI) {
	swarmPi = pi;

	pi.on("session_start", async (_event, ctx) => {
		const p = paths(ctx.cwd);
		await ensureDirs(p);
		const agentId = currentAgentId();
		const guest = agentId === SWARM_GUEST_ID;
		// Identity-gated tool visibility: a guest session loses the swarm tool surface (it is a plain coding
		// session, not a swarm participant); registered agents and the orchestrator keep it. The /swarm slash
		// command is unaffected, so a guest can still opt in via `/swarm register here <role>`. Re-applied on
		// opt-in (command.ts) so an in-session identity change re-enables the swarm tools immediately.
		applySwarmToolGating(pi);
		const ts = now();
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			await trace(p, "session.start", { agentId, guest, mode: ctx.mode, state: relative(ctx.cwd, p.state) });
			if (guest) {
				// Anonymous swarm session (no PI_SWARM_AGENT_ID and no explicit orchestrator opt-in): stay
				// inert. Do NOT register an agent record, do NOT call ensureOrchestrator (which would refresh
				// the orchestrator pseudo-agent heartbeat and mask a dead/stalled PM), and do NOT start the
				// orchestrator mailbox pump (which would surface orchestrator mail here). The swarm tool surface
				// is gated off (see applySwarmToolGating above) — this session cannot act as or consume the
				// orchestrator. It can still opt in via `/swarm register here <role>` (the slash command is
				// unaffected by tool gating), which re-applies gating to re-enable the swarm tools. See
				// isOrchestratorSession() for the explicit opt-in path.
				return;
			}
			if (agentId === "orchestrator") {
				ensureOrchestrator(st, ctx.cwd, p);
				await writeState(p, st);
			} else if (!st.agents[agentId]) {
				st.agents[agentId] = {
					id: agentId, role: "Externally started swarm agent", status: "running",
					roleKind: inferRoleKind(agentId, "Externally started swarm agent"), capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1,
					runtimeStatus: "starting", health: "healthy",
					lastSessionStartAt: ts, lastAgentStartAt: ts, pid: process.pid,
					tmuxSession: st.tmuxSession, tmuxWindow: agentId, tmuxTarget: "unknown",
					model: currentModel(), provider: currentProvider(), cwd: ctx.cwd,
					mailbox: relative(ctx.cwd, mailboxPath(p, agentId)), createdAt: ts, updatedAt: ts,
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
				await trace(p, "agent.status", { agentId, runtimeStatus: st.agents[agentId].runtimeStatus, health: st.agents[agentId].health });
			}
		});
		if (ctx.hasUI) ctx.ui.setStatus("swarm", `swarm:${agentId}`);
		if (agentId === "orchestrator") {
			await startOrchestratorPump(ctx);
			// Automatic model-pool rotation: the orchestrator PM is the long-lived owner of the swarm;
			// its background watcher benches failing slots and respawns dead agents on healthy ones.
			startPoolWatch(pi, ctx.cwd);
		} else if (ctx.mode === "tui") {
			// Pull-based delivery for workers (root fix for the restart/injection-loss class): on session
			// start, surface any unacked, non-dead-letter, non-superseded messages addressed to THIS agent
			// directly into its conversation — no tmux injection, no reconcile, no orchestrator involvement.
			// Mailbox is the source of truth; tmux injection stays as an opportunistic fast-path.
			try {
				await surfaceAgentPending(pi, ctx, p, agentId, "session_start");
			// Re-check on settle: a message may have arrived (or a failed injection skipped) while the
			// agent was busy; settling idle is the natural moment to catch up.
			// (hook registered below; the surface here covers the startup gap)
			} catch (err: any) { await trace(p, "agent.surface_error", { agentId, phase: "session_start", error: String((err as Error)?.message || err) }).catch(() => {}); }
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const agentId = currentAgentId();
		if (agentId === "orchestrator") return;
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
		if (agentId === "orchestrator") return;
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
			await writeState(p, st);
			await trace(p, "agent.status", { agentId, runtimeStatus: agent.runtimeStatus, health: agent.health, resurrect });
		});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const agentId = currentAgentId();
		if (agentId === "orchestrator") {
			const p = paths(ctx.cwd);
			await pumpOrchestratorMailbox(pi, ctx, p, "agent_settled");
			return;
		}
		// Catch-up surface for workers: anything unacked that arrived (or failed injection) while busy.
		try { await surfaceAgentPending(pi, ctx, paths(ctx.cwd), agentId, "agent_settled"); } catch {}
		const p = paths(ctx.cwd);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[agentId];
			if (!agent) return;
			if (agent.pid && agent.pid !== process.pid) return; // pid-guard
			const ts = now();
			agent.lastAgentSettledAt = ts;
			agent.health = "healthy";
			agent.lastHeartbeatAt = ts;
			agent.updatedAt = ts;
			ensureAgentDefaults(agent);
			const missingResponses = responseMissingRecords(st, agentId);
			agent.runtimeStatus = missingResponses.length ? "response_missing" : "idle";
			if (missingResponses.length) {
				for (const rec of missingResponses) {
					rec.response = { ...(rec.response || { status: "missing" as MessageResponseStatus }), status: "missing", missingAt: rec.response?.missingAt || ts, lastError: `response_missing: ${agentId} settled before sending a verified result` };
					rec.updatedAt = ts;
				}
				try {
					await deliverMessageLocked(pi, ctx.cwd, p, st, { to: "orchestrator", subject: `agent ${agentId} settled with missing response(s)`, body: `Agent ${agentId} settled while ${missingResponses.length} requiresResponse message(s) are still missing verified result messages: ${missingResponses.map((m) => m.id).join(", ")}. The agent is marked response_missing and is blocked from reuse until it sends replies and ack done with resultMessageId.`, requiresAck: false });
					await trace(p, "message.response_missing.settled.notify", { agentId, messageIds: missingResponses.map((m) => m.id) });
				} catch (err: any) {
					await trace(p, "message.response_missing.notify_failed", { agentId, error: String(err?.message || err) });
				}
			}
			// PM auto-notify (engine behavior): a settle while still holding open assignments is a
			// stall/idle signal the orchestrator should not have to poll for. Enqueue a mailbox notify to
			// the mailbox-only orchestrator. Loop-safe: (a) it targets the orchestrator, never the worker
			// (no self-re-trigger); (b) cooldown-guarded per agent via persisted lastSettleNotifyAt so
			// repeated settles in a window don't storm; (c) mailbox-only (no tmux inject); (d) no node
			// mutation. requiresAck=false (informational; orchestrator pump surfaces it). Done before
			// writeState so the notify record persists atomically with the settle metadata.
			if (agent.activeTaskIds.length) {
				const sinceNotify = agent.lastSettleNotifyAt ? Date.now() - new Date(agent.lastSettleNotifyAt).getTime() : Number.POSITIVE_INFINITY;
				if (sinceNotify > SETTLE_NOTIFY_COOLDOWN_MS) {
					agent.lastSettleNotifyAt = ts;
					let list = agent.activeTaskIds.join(", ");
					let openCount = agent.activeTaskIds.length;
					try {
						const open = await scanAgentOpenAssignments(p, st, agentId, agent.activeTaskIds);
						if (open.length) { list = open.map((o) => `${o.task.taskId}/${o.nodeId}`).join(", "); openCount = open.length; }
					} catch { /* keep activeTaskIds fallback list */ }
					try {
						await deliverMessageLocked(pi, ctx.cwd, p, st, { to: "orchestrator", subject: `agent ${agentId} settled idle with open assignment(s)`, body: `Agent ${agentId} settled (agent_settled) while still holding ${openCount} open assignment(s): ${list}. It may be idle or stalled; advance via swarm_next_nodes/swarm_update_task, reassign, or reconcile as needed.`, requiresAck: false });
						await trace(p, "task.stale.settled.notify", { agentId, open: openCount });
					} catch (err: any) {
						await trace(p, "task.stale.settled.notify_failed", { agentId, error: String(err?.message || err) });
					}
				} else {
					await trace(p, "task.stale.settled.notify_cooldown", { agentId, cooldownMs: SETTLE_NOTIFY_COOLDOWN_MS });
				}
			}
			await writeState(p, st);
			await trace(p, "agent.status", { agentId, runtimeStatus: agent.runtimeStatus, health: agent.health });
			// Loop-safe observability: a settle while still holding open assignments is a stale signal
			// (no forced inject; runtimeTaskWarnings does the active flagging).
			if (agent.activeTaskIds.length) await trace(p, "task.stale.settled", { agentId, openTaskCount: agent.activeTaskIds.length });
		});
	});

	pi.on("tool_execution_start", async (_event, ctx) => {
		const agentId = currentAgentId();
		if (agentId === "orchestrator") return;
		const p = paths(ctx.cwd);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[agentId];
			if (!agent) return;
			if (agent.pid && agent.pid !== process.pid) return; // pid-guard
			const ts = now();
			const resurrect = agent.status === "stopped" || agent.health === "unhealthy";
			agent.lastToolAt = ts;
			agent.runtimeStatus = "tool_running";
			agent.status = "running";
			agent.health = "healthy";
			agent.lastHeartbeatAt = ts;
			agent.updatedAt = ts;
			await writeState(p, st);
			await trace(p, "agent.status", { agentId, runtimeStatus: agent.runtimeStatus, health: agent.health, resurrect });
		});
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		const agentId = currentAgentId();
		if (agentId === "orchestrator") return;
		const p = paths(ctx.cwd);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[agentId];
			if (!agent) return;
			if (agent.pid && agent.pid !== process.pid) return; // pid-guard
			const ts = now();
			agent.runtimeStatus = "busy";
			agent.lastHeartbeatAt = ts;
			agent.updatedAt = ts;
			await writeState(p, st);
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const agentId = currentAgentId();
		if (agentId === "orchestrator") {
			stopOrchestratorPump();
			return;
		}
		const p = paths(ctx.cwd);
		await ensureDirs(p);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[agentId];
			if (!agent) return;
			// pid-guard: only the owning process may mark this agent stopped. A transient process sharing
			// the agentId (e.g. `pi --mode print`) must not poison a live agent's record.
			if (agent.pid && agent.pid !== process.pid) { await trace(p, "agent.shutdown.skip_pid_guard", { agentId, ownerPid: agent.pid, callerPid: process.pid }); return; }
			const ts = now();
			agent.lastShutdownAt = ts;
			agent.runtimeStatus = "stopped";
			agent.health = "unhealthy";
			agent.status = "stopped";
			agent.updatedAt = ts;
			// Engine-enforced closure: if this agent is dying while it still owns open assigned/in_progress
			// nodes, mark them stale and nudge the orchestrator (mailbox-only) instead of orphaning them.
			ensureAgentDefaults(agent);
			if (agent.activeTaskIds.length) {
				const open = await scanAgentOpenAssignments(p, st, agentId, agent.activeTaskIds);
				for (const { task, tp, nodeId } of open) { task.nodes[nodeId].staleAt = ts; task.nodes[nodeId].lastActivityAt = ts; await writeTaskState(tp, task); }
				if (open.length) {
					await trace(p, "task.stale.shutdown", { agentId, open: open.map((o) => ({ taskId: o.task.taskId, nodeId: o.nodeId })) });
					const list = open.map((o) => `${o.task.taskId}/${o.nodeId}`).join(", ");
					// Nudge the reassignment authority: prefer each open node's assigner (replyTarget, from its
					// latest `assign` handoff `by`) when registered and not this dying agent; else orchestrator
					// (mailbox-only). Stamps node.lastActivityAt so the shutdown itself is recorded as activity.
					const nudgeTargets = new Set<string>();
					for (const { task, nodeId } of open) {
						const assigner = [...task.handoffs].reverse().find((h: any) => h?.toNode === nodeId && h?.kind === "assign")?.by as string | undefined;
						if (assigner && assigner !== agentId && st.agents[assigner]) nudgeTargets.add(assigner);
						else nudgeTargets.add("orchestrator");
					}
					for (const target of nudgeTargets) {
						try { await deliverMessageLocked(pi, ctx.cwd, p, st, { to: target, subject: `agent ${agentId} shut down with open task node(s)`, body: `Agent ${agentId} shut down (session_shutdown) while still assigned ${open.length} non-terminal node(s): ${list}. Those nodes were marked stale (staleAt) and lastActivityAt stamped. Reassign via swarm_assign_task or reconcile as needed.`, requiresAck: false }); }
						catch (err: any) { await trace(p, "task.stale.shutdown.nudge_failed", { agentId, target, error: String(err?.message || err) }); }
					}
				}
			}
			await writeState(p, st);
			await trace(p, "agent.status", { agentId, runtimeStatus: agent.runtimeStatus, health: agent.health });
		});
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const msg = parseSystemDelivery(event.text);
		if (!msg) return { action: "continue" };
		const p = paths(ctx.cwd);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			upsertMessageRecord(st, msg, "intercepted", { interceptedAt: now() });
			await writeState(p, st);
		});
		await trace(p, "message.input_intercept", { id: msg.id, from: msg.from, to: msg.to, agentId: currentAgentId(), status: "intercepted" });
		pi.sendMessage({
			customType: "swarm-message",
			content: formatSwarmMessageContent(msg),
			display: true,
			details: msg,
		}, { triggerTurn: true, deliverAs: ctx.isIdle() ? "steer" : "followUp" });
		return { action: "handled" };
	});

}
