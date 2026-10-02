// === swarm/focus.ts — auto-focus tmux window on settled to busy pi agent ===
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SwarmAgent, SwarmState } from "./types.ts";
import { paths, readState, withLock, writeState, trace } from "./state.ts";
import { tmux } from "./tmux.ts";
import { logSwarmError } from "./errorlog.ts";
import { getTerminalDriver } from "./terminal/index.ts";
import { now } from "./utils.ts";

export const AUTO_FOCUS_COOLDOWN_MS = 2_500;
// D4 (task herdr-autofocus-parity-20260927): the settle path uses a short PER-TARGET cooldown
// instead of the global busy cooldown. 250ms is just enough to debounce identical-target
// re-fires without silently dropping a legitimate handoff between workers settling <2.5s apart.
export const AUTO_FOCUS_SETTLE_COOLDOWN_MS = 250;

/**
 * Stable auto-focus skip reasons (focus.skip trace, task herdr-autofocus-parity-20260927 D5).
 * Every skip site emits exactly one focus.skip trace with one of these values so the
 * events.jsonl census is diagnosable without forensics.
 */
export type FocusSkipReason =
	| "root_excluded"
	| "disabled"
	| "root_or_unknown_agent"
	| "already_focused"
	| "already-focused-live"
	| "cooldown"
	| "user-focused-outside-agents-workspace"
	| "root-busy-hold"
	| "active_window_mismatch"
	| "no_busy_agent"
	| "agent_not_busy"
	| "switch_failed";

/**
 * D5: durably record one auto-focus skip. Never throws — a trace failure must not turn a
 * skip into a crash; failures route through logSwarmError (no-silent-swallow mandate).
 */
async function traceFocusSkip(
	p: ReturnType<typeof paths>,
	cwd: string,
	path: "busy" | "settle",
	agentId: string,
	reason: FocusSkipReason,
	extra?: Record<string, unknown>,
): Promise<void> {
	try {
		await trace(p, "focus.skip", { path, agentId, reason, ...extra });
	} catch (err: any) {
		await logSwarmError(cwd, "focus", "trace_skip.failed", err, { path, agentId, reason });
	}
}

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
 * Compare two workspace id strings for equality. Lenient on trim + case so callers
 * don't need to normalize input; both undefined / empty / whitespace → equal (vacuously
 * true, callers should already have handled undefined). Used by the cross-workspace
 * focus guard.
 */
function isSameWorkspaceId(a: string | undefined, b: string | undefined): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	return a.trim().toLowerCase() === b.trim().toLowerCase();
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
		// H6: was raw tmux display-message; now driver-routed (TmuxDriver emits the identical argv).
		const driver = getTerminalDriver();
		const status = await driver.getFocusStatus(pi, session, { order: "name-first" });
		if (!status.sessionAlive) return false;
		const curWinName = status.activeWindowName;
		const curWinIndex = status.activeWindowIndex;
		const curPaneId = status.activePaneId;

		if (agent) {
			if (agent.tmuxWindow && agent.tmuxWindow !== "unknown") {
				if (agent.tmuxWindow === curWinName || agent.tmuxWindow === curWinIndex) return true;
			}
			if (agent.tmuxTarget && agent.tmuxTarget !== "unknown") {
				if (agent.tmuxTarget === curPaneId || agent.tmuxTarget.endsWith(`:${curWinIndex}.0`)) return true;
			}
			if (agent.id && (agent.id === curWinName || agent.id === curWinIndex)) return true;
			// D3 (task herdr-autofocus-parity-20260927): /swarm register here agents store the
			// pane component ("p9") in tmuxWindow, which can never match a herdr tab id/label —
			// herdr 0.8.2 tab rows expose no active_pane_id. Resolve pane→owning tab at the
			// driver seam (a67e351 parity with focusWindow) and compare against the focused tab id.
			if (agent.tmuxTarget && agent.tmuxTarget !== "unknown") {
				const owningTab = await driver.resolveOwningTabId(pi, agent.tmuxTarget);
				if (owningTab && (owningTab === curWinIndex || owningTab === curWinName)) return true;
			}
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
		// H6: was raw tmux select-window/select-pane; now driver-routed (TmuxDriver emits the
		// identical argv; herdr maps to tab focus).
		const res = await getTerminalDriver().focusWindow(pi, {
			target: agent.tmuxTarget,
			session: agent.tmuxSession,
			window: agent.tmuxWindow,
			paneId: agent.tmuxTarget,
		});
		if (!res.ok) {
			// a67e351 regression fix: driver.focusWindow logs internally at process.cwd(), which is
			// the WRONG project when the swarm cwd differs (multi-root / scratch lanes). Re-log the
			// failure durably at the CALLER's cwd so the no-silent-swallow census stays per-project.
			const err = new Error(res.error || "focusWindow failed");
			await logSwarmError(cwd, "focus", "select_window.failed", err, { target: winTarget });
			return { ok: false, target: winTarget, error: res.error };
		}
		return { ok: true, target: winTarget };
	} catch (err: any) {
		const msg = String(err?.message || err);
		await logSwarmError(cwd, "focus", "select_window.failed", err, { target: winTarget });
		return { ok: false, target: winTarget, error: msg };
	}
}

/**
 * D1 (task herdr-autofocus-parity-20260927): is the root session mid-turn? In follow mode the
 * busy path may pull the user into the agents workspace ONLY when root is idle. Root is
 * considered mid-turn when it is runtimeStatus busy/tool_running, has a recent heartbeat, or
 * sent a message within the heartbeat window — a conservative proxy for "an LLM turn is in
 * flight". Unknown/absent root state counts as idle (fail-open matches the guard's fail-open).
 */
const ROOT_MID_TURN_HEARTBEAT_WINDOW_MS = 5_000;
export function isRootMidTurn(st: SwarmState, nowMs = Date.now()): boolean {
	const root = st.agents?.root;
	if (!root) return false;
	if (root.runtimeStatus === "busy" || root.runtimeStatus === "tool_running") return true;
	const recent = (ts?: string) => {
		if (!ts) return false;
		const t = new Date(ts).getTime();
		return Number.isFinite(t) && nowMs - t < ROOT_MID_TURN_HEARTBEAT_WINDOW_MS;
	};
	return recent(root.lastToolAt) || recent(root.lastHeartbeatAt);
}

function getAutoFocusPolicy(st: SwarmState): "follow" | "steal" | "suppress" {
	return st.autoFocusPolicy === "steal" || st.autoFocusPolicy === "suppress" ? st.autoFocusPolicy : "follow";
}

/**
 * Automatically focus on a specific worker agent when it becomes busy (agent_start / tool_execution_start).
 */
export async function maybeAutoFocusOnBusy(
	pi: ExtensionAPI,
	ctx: { cwd: string },
	agentId: string,
	options?: { force?: boolean; bypassCooldown?: boolean; bypassActiveGuard?: boolean },
): Promise<{ switched: boolean; targetAgentId?: string; reason: string }> {
	if (agentId === "root") {
		const pRoot = paths(ctx.cwd);
		await traceFocusSkip(pRoot, ctx.cwd, "busy", agentId, "root_excluded");
		return { switched: false, reason: "root_excluded" };
	}

	const p = paths(ctx.cwd);
	const st = await readState(p, ctx.cwd);

	if (!isAutoFocusEnabled(st) && !options?.force) {
		await traceFocusSkip(p, ctx.cwd, "busy", agentId, "disabled");
		return { switched: false, reason: "disabled" };
	}

	const agent = st.agents[agentId];
	if (!agent || agent.roleKind === "root") {
		await traceFocusSkip(p, ctx.cwd, "busy", agentId, "root_or_unknown_agent");
		return { switched: false, reason: "root_or_unknown_agent" };
	}

	// S1 fix (task swarm-autofocus-focus-steal): the busy-event hook seam fires on EVERY
	// tool_execution_start / agent_start, but the CALLING agent's runtimeStatus is stamped by
	// later lifecycle events — an idle agent reaching this path stole focus on each tool-call
	// burst (live RED: repro-s1.js). Only genuinely busy/tool-running agents may pull focus;
	// pickNextBusyAgent's own candidate filter is the same contract.
	if (agent.runtimeStatus !== "busy" && agent.runtimeStatus !== "tool_running" && !options?.force) {
		await traceFocusSkip(p, ctx.cwd, "busy", agentId, "agent_not_busy", { runtimeStatus: agent.runtimeStatus ?? null });
		return { switched: false, targetAgentId: agent.id, reason: "agent_not_busy" };
	}

	// D2 (task herdr-autofocus-parity-20260927): the sticky lastFocusedAgentId comparison is
	// superseded by a live-focus check. Manual navigation away from a previously auto-focused
	// agent used to make this skip permanently wrong. Compare the DRIVER's current global
	// focus target against the busy agent instead. Under herdr, `tab list` exposes the focused
	// tab; under tmux/mock the workspace-level check below degrades to the legacy sticky check
	// only when a live query is impossible (tmux is session-scoped, so the sticky check remains
	// a safe anti-flap there).
	if (st.lastFocusedAgentId === agentId && !options?.force) {
		const driver = getTerminalDriver();
		let liveFocusTabId: string | undefined;
		try {
			const status = await driver.getFocusStatus(pi, agent.tmuxSession || st.tmuxSession, { order: "name-first" });
			liveFocusTabId = status.activeWindowIndex || status.activeWindowName;
		} catch (err: any) {
			await logSwarmError(ctx.cwd, "focus", "live_focus_check.query_failed", err, { agentId });
		}
		if (liveFocusTabId) {
			// Live query succeeded: decide on LIVE focus, not sticky state.
			let owningTab: string | undefined;
			try {
				owningTab = await driver.resolveOwningTabId(pi, agent.tmuxTarget || agent.tmuxWindow || "");
			} catch (err: any) {
				await logSwarmError(ctx.cwd, "focus", "live_focus_check.owning_tab_failed", err, { agentId });
			}
			const isLiveFocused = owningTab
				? owningTab === liveFocusTabId
				: liveFocusTabId === agent.tmuxWindow || liveFocusTabId === agent.id;
			if (isLiveFocused) {
				await traceFocusSkip(p, ctx.cwd, "busy", agentId, "already-focused-live");
				return { switched: false, reason: "already-focused-live" };
			}
			// Live check shows the user is elsewhere — fall through and re-focus.
		} else {
			// No live signal (tmux without display info / query failure): keep legacy sticky skip.
			await traceFocusSkip(p, ctx.cwd, "busy", agentId, "already_focused");
			return { switched: false, reason: "already_focused" };
		}
	}

	// Cooldown check (prevent rapid window flapping)
	if (st.lastFocusAt && !options?.bypassCooldown) {
		const elapsed = Date.now() - new Date(st.lastFocusAt).getTime();
		if (elapsed < AUTO_FOCUS_COOLDOWN_MS) {
			await traceFocusSkip(p, ctx.cwd, "busy", agentId, "cooldown", { elapsedMs: elapsed });
			return { switched: false, reason: "cooldown" };
		}
	}

	// Cross-workspace guard — D1 policy switch (task herdr-autofocus-parity-20260927).
	// Herdr-only (herdr `tab focus` is GLOBAL; tmux `select-window` is session-scoped, guard
	// is a no-op under tmux). Policies:
	//   follow   (default): S2 fix (task swarm-autofocus-focus-steal) — the user must already be
	//             inside the agents workspace to be pulled along; a user in a DIFFERENT herdr
	//             workspace is never stolen (the old root-idle carve-out was the dominant steal:
	//             root is between turns most of the time). Guard query failures fail CLOSED.
	//   steal:    guard dropped entirely (pre-05d7df9 behavior).
	//   suppress: guard always vetoes with "user-focused-outside-agents-workspace" (05d7df9).
	// force/bypassActiveGuard unchanged; explicit /swarm focus unaffected.
	if (!options?.force && !options?.bypassActiveGuard) {
		const driver = getTerminalDriver();
		if (driver.id === "herdr") {
			const targetAgentsWorkspace = agent.tmuxSession || st.tmuxSession;
			if (targetAgentsWorkspace) {
				let currentFocusedWorkspace: string | undefined;
				let workspaceQueryFailed = false;
				try {
					currentFocusedWorkspace = await driver.getFocusedWorkspaceId(pi);
				} catch (err: any) {
					await logSwarmError(ctx.cwd, "focus", "cross_workspace_guard.query_failed", err, {
						agentId,
						targetAgentsWorkspace,
					});
					// S2 fix: fail CLOSED under follow/suppress — a broken `herdr tab list` used to
					// silently disable the cross-workspace guard (fail-open). steal proceeds by contract.
					workspaceQueryFailed = true;
				}
				if (workspaceQueryFailed && getAutoFocusPolicy(st) !== "steal") {
					await traceFocusSkip(p, ctx.cwd, "busy", agentId, "user-focused-outside-agents-workspace", {
						policy: getAutoFocusPolicy(st),
						guardQueryFailed: true,
					});
					return { switched: false, targetAgentId: agent.id, reason: "user-focused-outside-agents-workspace" };
				}
				const userOutsideAgentsWorkspace =
					currentFocusedWorkspace &&
					currentFocusedWorkspace !== targetAgentsWorkspace &&
					!isSameWorkspaceId(currentFocusedWorkspace, targetAgentsWorkspace);
				if (userOutsideAgentsWorkspace) {
					const policy = getAutoFocusPolicy(st);
					if (policy === "suppress") {
						await traceFocusSkip(p, ctx.cwd, "busy", agentId, "user-focused-outside-agents-workspace", { policy });
						return { switched: false, targetAgentId: agent.id, reason: "user-focused-outside-agents-workspace" };
					}
					if (policy === "follow") {
						// S2 fix (task swarm-autofocus-focus-steal): follow NEVER pulls a user out of a
						// different herdr workspace — the old root-idle carve-out was the dominant steal
						// (root is between turns most of the time). Reason string distinguishes the kept
						// mid-turn veto from the new root-idle veto for the trace census.
						const reason = isRootMidTurn(st) ? "root-busy-hold" : "user-focused-outside-agents-workspace";
						await traceFocusSkip(p, ctx.cwd, "busy", agentId, reason, { policy });
						return { switched: false, targetAgentId: agent.id, reason };
					}
					// policy === "steal": allow the pull (explicit opt-in).
				}
			}
		}
	}

	const res = await focusAgentWindow(pi, agent, ctx.cwd);
	if (!res.ok) {
		const reason = res.error || "switch_failed";
		await traceFocusSkip(p, ctx.cwd, "busy", agent.id, "switch_failed", { error: res.error });
		return { switched: false, targetAgentId: agent.id, reason };
	}

	const ts = now();
	await withLock(p, async () => {
		const latestSt = await readState(p, ctx.cwd);
		latestSt.lastFocusAt = ts;
		latestSt.lastFocusedAgentId = agent.id;
		latestSt.lastFocusByTarget = { ...(latestSt.lastFocusByTarget || {}), [agent.id]: ts };
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
		await traceFocusSkip(p, ctx.cwd, "settle", settlingAgentId, "disabled");
		return { switched: false, reason: "disabled" };
	}

	// 2. Cooldown check — D4 (task herdr-autofocus-parity-20260927): the settle path uses a
	// PER-TARGET cooldown instead of the global busy cooldown. Workers finishing near-
	// simultaneously hand off focus to DIFFERENT targets, and a global 2.5s cooldown silently
	// dropped every handoff after the first. 250ms per-target just debounces identical-target
	// re-fires.
	const settlingAgentEarly = st.agents[settlingAgentId];
	if (settlingAgentEarly && !options?.bypassCooldown) {
		const candidateSession = settlingAgentEarly.tmuxSession || st.tmuxSession;
		const nextCandidate = pickNextBusyAgent(st, settlingAgentId, candidateSession);
		if (nextCandidate) {
			const lastForTarget = st.lastFocusByTarget?.[nextCandidate.id];
			if (lastForTarget) {
				const elapsed = Date.now() - new Date(lastForTarget).getTime();
				if (elapsed < AUTO_FOCUS_SETTLE_COOLDOWN_MS) {
					await traceFocusSkip(p, ctx.cwd, "settle", settlingAgentId, "cooldown", {
						targetAgentId: nextCandidate.id,
						elapsedMs: elapsed,
						cooldownMs: AUTO_FOCUS_SETTLE_COOLDOWN_MS,
					});
					return { switched: false, reason: "cooldown" };
				}
			}
		}
	}

	// Guard: Root is the human coordinating session, never a worker window.
	// Auto-focus operates strictly between worker windows within the shared worker tmux session.
	if (settlingAgentId === "root") {
		await traceFocusSkip(p, ctx.cwd, "settle", settlingAgentId, "root_excluded");
		return { switched: false, reason: "root_excluded" };
	}

	const settlingAgent = st.agents[settlingAgentId];
	if (!settlingAgent || settlingAgent.roleKind === "root") {
		await traceFocusSkip(p, ctx.cwd, "settle", settlingAgentId, "root_or_unknown_agent");
		return { switched: false, reason: "root_or_unknown_agent" };
	}

	const session = settlingAgent.tmuxSession || st.tmuxSession;

	// 3. Active window guard: only switch if the user is currently looking at the settling agent's window
	if (!options?.bypassActiveGuard) {
		const isActive = await isCurrentActiveTmuxWindow(pi, session, settlingAgent);
		if (!isActive) {
			await traceFocusSkip(p, ctx.cwd, "settle", settlingAgentId, "active_window_mismatch");
			return { switched: false, reason: "active_window_mismatch" };
		}
	}

	// 4. Candidate selection (strictly within the same worker session)
	const targetAgent = pickNextBusyAgent(st, settlingAgentId, session);
	if (!targetAgent) {
		await traceFocusSkip(p, ctx.cwd, "settle", settlingAgentId, "no_busy_agent");
		return { switched: false, reason: "no_busy_agent" };
	}

	// 5. Execute switch
	const res = await focusAgentWindow(pi, targetAgent, ctx.cwd);
	if (!res.ok) {
		await traceFocusSkip(p, ctx.cwd, "settle", settlingAgentId, "switch_failed", {
			targetAgentId: targetAgent.id,
			error: res.error,
		});
		return { switched: false, targetAgentId: targetAgent.id, reason: res.error || "switch_failed" };
	}

	// 6. Record state & trace event
	const ts = now();
	await withLock(p, async () => {
		const latestSt = await readState(p, ctx.cwd);
		latestSt.lastFocusAt = ts;
		latestSt.lastFocusedAgentId = targetAgent.id;
		latestSt.lastFocusByTarget = { ...(latestSt.lastFocusByTarget || {}), [targetAgent.id]: ts };
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
	let session = st.tmuxSession;
	let sessionAlive = false;
	let activeWindowIndex: string | undefined;
	let activeWindowName: string | undefined;
	let activePaneId: string | undefined;

	try {
		// H6: was raw tmux display-message; now driver-routed (TmuxDriver emits the identical argv).
		const driver = getTerminalDriver();
		const status = await driver.getFocusStatus(pi, session);
		if (driver.id === "herdr" && status.session) session = status.session;
		if (status.sessionAlive) {
			// A live Herdr workspace may have no focused tab; that is still an alive session, not
			// a NOT RUNNING result. HerdrDriver leaves the active fields undefined in that case.
			sessionAlive = true;
			activeWindowIndex = status.activeWindowIndex;
			activeWindowName = status.activeWindowName;
			activePaneId = status.activePaneId;
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
