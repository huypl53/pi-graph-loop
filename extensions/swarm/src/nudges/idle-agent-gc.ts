// === swarm/nudges/idle-agent-gc.ts — idle-agent GC nudge (root decides, no auto-kill) ===
// Plan: docs/swarm/plans/2026-10-13-idle-agent-gc-nudge.md
//
// Long-lived swarms accumulate workers that are `status:"running"` but idle forever after
// their work dried up: pane alive, memory burned, nobody told the root. The heartbeat GC only
// LABELS them health:"stale"; the task-close sweep only fires on task terminal transitions.
// This evaluator closes the gap: it nudges the ROOT (via the durable mailbox → pump-delivery
// path, same as the task-stall/goal nudges) listing eligible idle workers, and the ROOT LLM
// then decides and calls the `swarm_stop_agent` TOOL itself. There is deliberately NO
// auto-kill path and NO slash command in the nudge body (slash commands are user-run-only;
// the root agent cannot execute them). Reuse pools and parked panes are intentional idleness
// — valid leases are exempt.
//
// Terminal-manager agnostic: eligibility rides the driver-agnostic heartbeat-GC evidence
// (lastHeartbeatAt + cached tmuxAlive from the heartbeat GC probe ledger). This module makes
// ZERO terminal subprocess calls. Historical `tmux*` field names are kept for state
// compatibility; tmux | herdr | mock all flow through the same fields.
//
// Cost bound: O(N) in-memory scan under the existing pump lock, throttled to one scan per
// `intervalMs` (default 60s). One durable message per eligible agent per cooldown window
// (default 30'), capped at `maxNudges` (default 3) per agent.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	TRACE_AGENT_IDLE_GC_CAP,
	TRACE_AGENT_IDLE_GC_DISABLED,
	TRACE_AGENT_IDLE_GC_ERROR,
	TRACE_AGENT_IDLE_GC_NUDGE,
	NOTIFY_KEY_IDLE_GC_NUDGE,
	formatNotifyKey,
} from "../constants.ts";
import type { Paths, SwarmIdleGcNudgeState, SwarmState } from "../types.ts";
import { deliverMessageLocked, findIdempotentMessage } from "../mailbox.ts";
import { isTaskReferenced } from "../agent-gc.ts";
import { trace, writeState } from "../state.ts";
import { logSwarmError } from "../errorlog.ts";
import { readAgentGcConfig } from "../agent-gc-auto.ts";
import type { StoppedGcOptions } from "../agent-gc.ts";

// Whole-scan throttle key. Agent ids are safeId-validated (lowercase alnum, dash, underscore),
// so a leading-underscore key can never collide with a real agent.
const SCAN_THROTTLE_KEY = "_lastScanAt";

function humanAge(ms: number): string {
	if (!Number.isFinite(ms)) return "unknown";
	const m = Math.floor(ms / 60_000);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
	return `${Math.floor(h / 24)}d`;
}

export interface IdleGcNudgeResult {
	scanRan: boolean;
	nudged: number;
	eligible: string[];
	suppressed: string[];
	reason?: "disabled" | "interval_gated" | "no_candidates";
}

/**
 * Evaluate idle-agent GC eligibility and nudge the root about eligible workers.
 * MUST be called under the swarm lock (pump maintenance phase). The caller persists state.
 */
export async function evaluateIdleAgentGcNudgeLocked(
	pi: ExtensionAPI,
	cwd: string,
	p: Paths,
	st: SwarmState,
	nowMs: number,
	taskGraphs?: StoppedGcOptions["taskGraphs"],
): Promise<IdleGcNudgeResult> {
	const cfg = readAgentGcConfig(cwd).idleNudge;
	if (cfg.enabled === false || process.env.PI_SWARM_IDLE_GC_NUDGE_OFF === "1") {
		// One trace per process per disabled state would still be spammy across ticks; the
		// disabled trace is emitted only when the scan would otherwise have run (interval gate
		// below re-checks first). Cheap enough: one trace per intervalMs window.
		try {
			await maybeScanThrottledTrace(p, st, nowMs, cfg.intervalMs, () =>
				trace(p, TRACE_AGENT_IDLE_GC_DISABLED, { via: "config_or_env" }),
			);
		} catch (err) {
			await logSwarmError(p, "idle-agent-gc", "idle_gc.disabled_trace_failed", err, {});
		}
		return { scanRan: false, nudged: 0, eligible: [], suppressed: [], reason: "disabled" };
	}

	st.idleGcNudgeState ||= {};
	const g = st.idleGcNudgeState;
	const lastScanRaw = g[SCAN_THROTTLE_KEY];
	const lastScanAt = typeof lastScanRaw === "string" ? new Date(lastScanRaw).getTime() : 0;
	if (Number.isFinite(lastScanAt) && nowMs - lastScanAt < cfg.intervalMs) {
		return { scanRan: false, nudged: 0, eligible: [], suppressed: [], reason: "interval_gated" };
	}
	g[SCAN_THROTTLE_KEY] = new Date(nowMs).toISOString();

	// Eligibility scan — cheap O(N), no subprocess.
	const eligible: string[] = [];
	const suppressed: string[] = [];
	for (const agent of Object.values(st.agents)) {
		if (agent.id === "root") continue;
		if (agent.status !== "running" || agent.runtimeStatus !== "idle") continue;
		if (agent.paused === true) continue;
		if ((agent.activeTaskIds || []).length > 0) continue;
		// Valid reuse/park leases exempt (intentional idleness). Expired leases fall through.
		const leaseUntilMs = agent.leaseUntil ? new Date(agent.leaseUntil).getTime() : 0;
		if ((agent.leaseKind === "reuse" || agent.leaseKind === "park") && leaseUntilMs > nowMs) continue;
		// Heartbeat age gate (absent heartbeat = infinitely old).
		const hbMs = agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt).getTime() : 0;
		const hbAge = hbMs > 0 ? nowMs - hbMs : Number.POSITIVE_INFINITY;
		if (!(hbAge > cfg.afterMs)) continue;
		// Open graph assignment gate — same non-terminal-assignee closure as the stopped purge.
		if (taskGraphs && isTaskReferenced(agent.id, taskGraphs)) continue;
		eligible.push(agent.id);
	}

	if (eligible.length === 0) {
		await persistStateBestEffort(p, st);
		return { scanRan: true, nudged: 0, eligible, suppressed, reason: "no_candidates" };
	}

	let nudged = 0;
	for (const agentId of eligible) {
		const perAgent = (g[agentId] as SwarmIdleGcNudgeState) || { nudges: 0, nudgeSeq: 0 };
		if (perAgent.nudges >= cfg.maxNudges) {
			suppressed.push(agentId);
			if (!perAgent.capTraced) {
				perAgent.capTraced = true;
				await trace(p, TRACE_AGENT_IDLE_GC_CAP, { agentId, nudges: perAgent.nudges, max: cfg.maxNudges, suppressed: true }).catch(
					() => {},
				);
			}
			g[agentId] = perAgent;
			continue;
		}
		const lastMs = perAgent.lastNudgeAt ? new Date(perAgent.lastNudgeAt).getTime() : 0;
		if (lastMs > 0 && nowMs - lastMs < cfg.cooldownMs) {
			suppressed.push(agentId);
			continue;
		}
		const nudgeSeq = (perAgent.nudgeSeq || 0) + 1;
		const key = formatNotifyKey(NOTIFY_KEY_IDLE_GC_NUDGE, { agentId, seq: String(nudgeSeq) });
		if (findIdempotentMessage(st, "root", "root", key)) {
			suppressed.push(agentId);
			continue;
		}
		const agent = st.agents[agentId];
		const hbMs = agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt).getTime() : 0;
		const idleMs = hbMs > 0 ? nowMs - hbMs : Number.POSITIVE_INFINITY;
		const subject = `Idle agent GC: ${agentId} idle ${humanAge(idleMs)} — reclaim it?`;
		const body =
			`Agent ${agentId} is status=running / runtimeStatus=idle with a heartbeat ${humanAge(idleMs)} old, ` +
			`no active tasks, and no valid lease. It is holding a live terminal pane and process.\n\n` +
			`Action (choose one):\n` +
			`  swarm_stop_agent(agentId="${agentId}")           # kill the pane + mark stopped; mailbox and history persist\n` +
			`  swarm_assign_task(...)                            # give it work instead\n\n` +
			`If you stop it: the stopped record is purge-eligible later (age-gated) via the agent GC` +
			`(auto mode or the operator's purge command) — no further action needed from you now.\n\n` +
			`This is idle-GC nudge ${perAgent.nudges + 1} of ${cfg.maxNudges} for this agent.`;
		try {
			await deliverMessageLocked(pi, cwd, p, st, {
				to: "root",
				subject,
				body,
				conversationId: `agent:${agentId}:idle-gc`,
				requiresAck: false,
				idempotencyKey: key,
				priority: "normal",
			});
		} catch (err) {
			await logSwarmError(p, "idle-agent-gc", "idle_gc.nudge_delivery_failed", err, { agentId, key });
			suppressed.push(agentId);
			continue;
		}
		perAgent.nudges += 1;
		perAgent.nudgeSeq = nudgeSeq;
		perAgent.lastNudgeAt = new Date(nowMs).toISOString();
		g[agentId] = perAgent;
		nudged++;
		await trace(p, TRACE_AGENT_IDLE_GC_NUDGE, { agentId, idleMs: Number.isFinite(idleMs) ? idleMs : null, nudgeSeq, key }).catch(
			() => {},
		);
	}
	await persistStateBestEffort(p, st);
	return { scanRan: true, nudged, eligible, suppressed };
}

// Persist only when something actually changed (nudges/cap/throttle stamps). The throttle stamp
// alone is a change, so every real scan persists — same write cadence as the idle-epoch phase.
async function persistStateBestEffort(p: Paths, st: SwarmState): Promise<void> {
	try {
		await writeState(p, st);
	} catch (err) {
		await logSwarmError(p, "idle-agent-gc", "idle_gc.state_write_failed", err, {});
	}
}

// Run fn at most once per interval window (uses the same throttle key slot). Used for the
// disabled-state trace so a disabled phase doesn't trace on every 5s pump tick.
async function maybeScanThrottledTrace(
	p: Paths,
	st: SwarmState,
	nowMs: number,
	intervalMs: number,
	fn: () => Promise<unknown>,
): Promise<void> {
	st.idleGcNudgeState ||= {};
	const g = st.idleGcNudgeState;
	const lastScanRaw = g[SCAN_THROTTLE_KEY];
	const lastScanAt = typeof lastScanRaw === "string" ? new Date(lastScanRaw).getTime() : 0;
	if (Number.isFinite(lastScanAt) && nowMs - lastScanAt < intervalMs) return;
	g[SCAN_THROTTLE_KEY] = new Date(nowMs).toISOString();
	await fn();
	await persistStateBestEffort(p, st);
}

// Re-exported error trace name for the pump-phase wrapper (single source of truth).
export { TRACE_AGENT_IDLE_GC_ERROR };
