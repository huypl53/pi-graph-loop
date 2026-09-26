// === swarm/focus.ts — auto-focus tmux window on settled to busy pi agent ===
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SwarmAgent, SwarmState } from "./types.ts";
import { paths, readState, withLock, writeState, trace } from "./state.ts";
import { tmux } from "./tmux.ts";
import { logSwarmError } from "./errorlog.ts";
import { now } from "./utils.ts";

export const AUTO_FOCUS_COOLDOWN_MS = 2_500;

/**
 * Select the highest-priority busy agent to focus on.
 * Candidates must be running, have runtimeStatus in ["busy", "tool_running"],
 * have a valid tmux window or target, differ from excludeAgentId,
 * NOT be root (human coordinator), and belong to the same worker tmuxSession.
 */
export function pickNextBusyAgent(st: SwarmState, excludeAgentId?: string, targetSession?: string): SwarmAgent | null {
	const session = targetSession || st.tmuxSession;
	const candidates = Object.values(st.agents || {}).filter((a) => {
		if (!a || a.id === excludeAgentId) return false;
		if (a.id === "root" || a.roleKind === "root") return false; // Root coordinator is never a window candidate
		if (a.status !== "running") return false;
		if (a.runtimeStatus !== "busy" && a.runtimeStatus !== "tool_running") return false;
		const aSession = a.tmuxSession || st.tmuxSession;
		if (aSession !== session) return false; // Must belong to the same worker tmux session
		const hasTarget = (a.tmuxWindow && a.tmuxWindow !== "unknown") || (a.tmuxTarget && a.tmuxTarget !== "unknown");
		return Boolean(hasTarget);
	});

	if (candidates.length === 0) return null;

	// Sort candidates:
	// 1. Most recent active work: max(lastToolAt, lastAgentStartAt, lastHeartbeatAt)
	// 2. Tie-breaker: has active in-flight tasks
	candidates.sort((a, b) => {
		const aTime = Math.max(
			a.lastToolAt ? new Date(a.lastToolAt).getTime() : 0,
			a.lastAgentStartAt ? new Date(a.lastAgentStartAt).getTime() : 0,
			a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : 0,
		);
		const bTime = Math.max(
			b.lastToolAt ? new Date(b.lastToolAt).getTime() : 0,
			b.lastAgentStartAt ? new Date(b.lastAgentStartAt).getTime() : 0,
			b.lastHeartbeatAt ? new Date(b.lastHeartbeatAt).getTime() : 0,
		);
		if (bTime !== aTime) return bTime - aTime;

		const aTasks = a.activeTaskIds?.length || 0;
		const bTasks = b.activeTaskIds?.length || 0;
		return bTasks - aTasks;
	});

	return candidates[0] || null;
}

/**
 * Check if auto-focus is enabled via state flag or environment variable.
 * Default is ENABLED (true) unless explicitly disabled via PI_SWARM_AUTO_FOCUS=0/false
 * or state autoFocusBusy === false.
 */
export function isAutoFocusEnabled(st?: SwarmState | null): boolean {
	if (process.env.PI_SWARM_AUTO_FOCUS === "0" || process.env.PI_SWARM_AUTO_FOCUS === "false") {
		return false;
	}
	if (process.env.PI_SWARM_AUTO_FOCUS === "1" || process.env.PI_SWARM_AUTO_FOCUS === "true") {
		return true;
	}
	if (st && typeof st.autoFocusBusy === "boolean") {
		return st.autoFocusBusy;
	}
	return true;
}

/**
 * Check if the tmux window for the given agent is currently the active window of its session.
 * This prevents focus stealing when the user is working or viewing a different window.
 */
export async function isCurrentActiveTmuxWindow(pi: ExtensionAPI, session: string, agent?: SwarmAgent): Promise<boolean> {
	if (!process.env.TMUX && (!agent?.tmuxTarget || agent.tmuxTarget === "unknown")) {
		return false;
	}

	try {
		const out = await tmux(pi, ["display-message", "-p", "-t", session, "#{window_name}\t#{window_index}\t#{pane_id}"], 3_000);
		const parts = out.trim().split("\t");
		const curWinName = parts[0];
		const curWinIndex = parts[1];
		const curPaneId = parts[2];

		if (agent) {
			if (agent.tmuxWindow && agent.tmuxWindow !== "unknown") {
				if (agent.tmuxWindow === curWinName || agent.tmuxWindow === curWinIndex) return true;
			}
			if (agent.tmuxTarget && agent.tmuxTarget !== "unknown") {
				if (agent.tmuxTarget === curPaneId || agent.tmuxTarget.endsWith(`:${curWinIndex}.0`)) return true;
			}
			if (agent.id && (agent.id === curWinName || agent.id === curWinIndex)) return true;
			return false;
		}

		return Boolean(curWinName || curWinIndex);
	} catch (err: any) {
		await logSwarmError(process.cwd(), "focus", "is_current_active.session_check_failed", err, {
			session,
			agentId: agent?.id,
		});
		return false;
	}
}

/**
 * Switch the tmux active window and pane to the target agent.
 */
export async function focusAgentWindow(
	pi: ExtensionAPI,
	agent: SwarmAgent,
	cwd = process.cwd(),
): Promise<{ ok: boolean; target: string; error?: string }> {
	const winTarget = agent.tmuxWindow && agent.tmuxWindow !== "unknown" ? `${agent.tmuxSession}:${agent.tmuxWindow}` : agent.tmuxTarget;

	if (!winTarget || winTarget === "unknown") {
		return { ok: false, target: "unknown", error: "Target agent has no valid tmux window or target" };
	}

	try {
		await tmux(pi, ["select-window", "-t", winTarget], 5_000);
		if (agent.tmuxTarget && agent.tmuxTarget !== "unknown") {
			try {
				await tmux(pi, ["select-pane", "-t", agent.tmuxTarget], 3_000);
			} catch (err: any) {
				// Non-fatal if pane selection fails as long as window was selected
				await logSwarmError(cwd, "focus", "select_pane.failed", err, { target: agent.tmuxTarget });
			}
		}
		return { ok: true, target: winTarget };
	} catch (err: any) {
		const msg = String(err?.message || err);
		await logSwarmError(cwd, "focus", "select_window.failed", err, { target: winTarget });
		return { ok: false, target: winTarget, error: msg };
	}
}

/**
 * Automatically focus on a specific worker agent when it becomes busy (agent_start / tool_execution_start).
 */
export async function maybeAutoFocusOnBusy(
	pi: ExtensionAPI,
	ctx: { cwd: string },
	agentId: string,
	options?: { force?: boolean; bypassCooldown?: boolean },
): Promise<{ switched: boolean; targetAgentId?: string; reason: string }> {
	if (agentId === "root") return { switched: false, reason: "root_excluded" };

	const p = paths(ctx.cwd);
	const st = await readState(p, ctx.cwd);

	if (!isAutoFocusEnabled(st) && !options?.force) {
		return { switched: false, reason: "disabled" };
	}

	const agent = st.agents[agentId];
	if (!agent || agent.roleKind === "root") {
		return { switched: false, reason: "root_or_unknown_agent" };
	}

	// Don't switch if already focused on this agent
	if (st.lastFocusedAgentId === agentId) {
		return { switched: false, reason: "already_focused" };
	}

	// Cooldown check (prevent rapid window flapping)
	if (st.lastFocusAt && !options?.bypassCooldown) {
		const elapsed = Date.now() - new Date(st.lastFocusAt).getTime();
		if (elapsed < AUTO_FOCUS_COOLDOWN_MS) {
			return { switched: false, reason: "cooldown" };
		}
	}

	const res = await focusAgentWindow(pi, agent, ctx.cwd);
	if (!res.ok) {
		return { switched: false, targetAgentId: agent.id, reason: res.error || "switch_failed" };
	}

	const ts = now();
	await withLock(p, async () => {
		const latestSt = await readState(p, ctx.cwd);
		latestSt.lastFocusAt = ts;
		latestSt.lastFocusedAgentId = agent.id;
		latestSt.updatedAt = ts;
		await writeState(p, latestSt);
	});

	try {
		await trace(p, "tmux.focus.switch", {
			to: agent.id,
			trigger: "busy",
			target: res.target,
		});
	} catch (err: any) {
		await logSwarmError(ctx.cwd, "focus", "trace_switch.failed", err, { to: agent.id });
	}

	return { switched: true, targetAgentId: agent.id, reason: "ok" };
}

/**
 * Evaluate auto-focus policy and conditionally switch tmux window to a busy pi agent on settle.
 */
export async function maybeAutoFocusBusyAgent(
	pi: ExtensionAPI,
	ctx: { cwd: string },
	settlingAgentId: string,
	options?: { force?: boolean; bypassCooldown?: boolean; bypassActiveGuard?: boolean },
): Promise<{ switched: boolean; targetAgentId?: string; reason: string }> {
	const p = paths(ctx.cwd);
	const st = await readState(p, ctx.cwd);

	// 1. Feature flag check
	if (!isAutoFocusEnabled(st) && !options?.force) {
		return { switched: false, reason: "disabled" };
	}

	// 2. Cooldown check (prevent rapid window flapping)
	if (st.lastFocusAt && !options?.bypassCooldown) {
		const elapsed = Date.now() - new Date(st.lastFocusAt).getTime();
		if (elapsed < AUTO_FOCUS_COOLDOWN_MS) {
			return { switched: false, reason: "cooldown" };
		}
	}

	// Guard: Root is the human coordinating session, never a worker window.
	// Auto-focus operates strictly between worker windows within the shared worker tmux session.
	if (settlingAgentId === "root") {
		return { switched: false, reason: "root_excluded" };
	}

	const settlingAgent = st.agents[settlingAgentId];
	if (!settlingAgent || settlingAgent.roleKind === "root") {
		return { switched: false, reason: "root_or_unknown_agent" };
	}

	const session = settlingAgent.tmuxSession || st.tmuxSession;

	// 3. Active window guard: only switch if the user is currently looking at the settling agent's window
	if (!options?.bypassActiveGuard) {
		const isActive = await isCurrentActiveTmuxWindow(pi, session, settlingAgent);
		if (!isActive) {
			return { switched: false, reason: "active_window_mismatch" };
		}
	}

	// 4. Candidate selection (strictly within the same worker session)
	const targetAgent = pickNextBusyAgent(st, settlingAgentId, session);
	if (!targetAgent) {
		return { switched: false, reason: "no_busy_agent" };
	}

	// 5. Execute switch
	const res = await focusAgentWindow(pi, targetAgent, ctx.cwd);
	if (!res.ok) {
		return { switched: false, targetAgentId: targetAgent.id, reason: res.error || "switch_failed" };
	}

	// 6. Record state & trace event
	const ts = now();
	await withLock(p, async () => {
		const latestSt = await readState(p, ctx.cwd);
		latestSt.lastFocusAt = ts;
		latestSt.lastFocusedAgentId = targetAgent.id;
		latestSt.updatedAt = ts;
		await writeState(p, latestSt);
	});

	try {
		await trace(p, "tmux.focus.switch", {
			from: settlingAgentId,
			to: targetAgent.id,
			target: res.target,
		});
	} catch (err: any) {
		await logSwarmError(ctx.cwd, "focus", "trace_switch.failed", err, {
			from: settlingAgentId,
			to: targetAgent.id,
		});
	}

	return { switched: true, targetAgentId: targetAgent.id, reason: "ok" };
}

export interface FocusStatusInfo {
	enabled: boolean;
	session: string;
	sessionAlive: boolean;
	activeWindowIndex?: string;
	activeWindowName?: string;
	activePaneId?: string;
	focusedAgent?: SwarmAgent;
	busyAgents: SwarmAgent[];
	lastFocusAt?: string;
	lastFocusedAgentId?: string;
}

/**
 * Retrieve comprehensive focus status across tmux worker windows and swarm state.
 */
export async function getFocusStatus(pi: ExtensionAPI, cwd: string): Promise<FocusStatusInfo> {
	const p = paths(cwd);
	const st = await readState(p, cwd);
	const session = st.tmuxSession;
	let sessionAlive = false;
	let activeWindowIndex: string | undefined;
	let activeWindowName: string | undefined;
	let activePaneId: string | undefined;

	try {
		const out = await tmux(pi, ["display-message", "-p", "-t", session, "#{window_index}\t#{window_name}\t#{pane_id}"], 3_000);
		const parts = out.trim().split("\t");
		if (parts.length >= 2) {
			sessionAlive = true;
			activeWindowIndex = parts[0];
			activeWindowName = parts[1];
			activePaneId = parts[2];
		}
	} catch (err: any) {
		await logSwarmError(cwd, "focus", "get_focus_status.tmux_check_failed", err, { session });
	}

	// Identify focused agent in st.agents
	let focusedAgent: SwarmAgent | undefined;
	if (sessionAlive && activeWindowName) {
		focusedAgent = Object.values(st.agents || {}).find(
			(a) =>
				a.tmuxSession === session &&
				(a.tmuxWindow === activeWindowName || a.tmuxWindow === activeWindowIndex || a.id === activeWindowName),
		);
	}

	// Identify other busy agents
	const busyAgents = Object.values(st.agents || {}).filter(
		(a) =>
			a.id !== "root" &&
			a.roleKind !== "root" &&
			a.status === "running" &&
			(a.runtimeStatus === "busy" || a.runtimeStatus === "tool_running") &&
			a.id !== focusedAgent?.id,
	);

	return {
		enabled: isAutoFocusEnabled(st),
		session,
		sessionAlive,
		activeWindowIndex,
		activeWindowName,
		activePaneId,
		focusedAgent,
		busyAgents,
		lastFocusAt: st.lastFocusAt,
		lastFocusedAgentId: st.lastFocusedAgentId,
	};
}

/**
 * Format FocusStatusInfo into a clear human-readable string.
 */
export function formatFocusStatus(info: FocusStatusInfo): string {
	const status = info.enabled ? "ENABLED" : "DISABLED";
	const lines: string[] = [
		`Auto-focus busy pi: ${status} (cooldown: ${AUTO_FOCUS_COOLDOWN_MS / 1000}s)`,
		`Worker tmux session: ${info.session} [${info.sessionAlive ? "ALIVE" : "NOT RUNNING"}]`,
	];

	if (info.sessionAlive) {
		const agentStr = info.focusedAgent
			? `➔ agent: ${info.focusedAgent.id} [${info.focusedAgent.runtimeStatus}]`
			: "(no matching swarm agent record)";
		lines.push(`Currently focused window: ${info.activeWindowIndex}: ${info.activeWindowName} ${agentStr}`);
	} else {
		lines.push("Currently focused window: (tmux session not started yet)");
	}

	if (info.busyAgents.length > 0) {
		const busyList = info.busyAgents.map((a) => `${a.id} (${a.runtimeStatus}, win: ${a.tmuxWindow || "unknown"})`).join(", ");
		lines.push(`Other busy workers (${info.busyAgents.length}): ${busyList}`);
	} else {
		lines.push("Other busy workers: none (all other agents idle)");
	}

	if (info.lastFocusAt) {
		const targetStr = info.lastFocusedAgentId ? ` to ${info.lastFocusedAgentId}` : "";
		lines.push(`Last auto-focus transition: at ${info.lastFocusAt}${targetStr}`);
	}

	lines.push("\nCommands: /swarm auto-focus [on|off|toggle|status] | /swarm focus");
	return lines.join("\n");
}
