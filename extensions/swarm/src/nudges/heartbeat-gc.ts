// === swarm/nudges/heartbeat-gc.ts — agent heartbeat GC (calls driver.isTargetAlive) ===
// agentHeartbeatGCLocked.
// Extracted from graph-advance.ts (Phase 6 real split). Bodies verbatim.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_AGENT_HEARTBEAT_STALE_MS,
	TRACE_AGENT_HEARTBEAT_GC_EXPIRED_PARK_FLIPPED,
	TRACE_AGENT_HEARTBEAT_GC_PROBE_THROTTLED,
	TRACE_AGENT_HEARTBEAT_GC_STALE,
	TRACE_AGENT_HEARTBEAT_GC_STOPPED,
	TRACE_AGENT_TMUX_LIVENESS_CORRECTION,
} from "../constants.ts";
import type { Paths, SwarmState } from "../types.ts";
import { isTmuxRunning } from "../tmux.ts";
import { trace, writeState } from "../state.ts";

export async function agentHeartbeatGCLocked(
	pi: ExtensionAPI,
	cwd: string,
	p: Paths,
	st: SwarmState,
	nowMs: number,
): Promise<{
	stopped: number;
	stale: number;
	corrected: number;
	probesFired: number;
	probesThrottled: number;
	expiredParkFlipped: number;
}> {
	// Source the threshold from constants (single source of truth; env override is operator-only).
	const staleWindow = Number(process.env.PI_SWARM_AGENT_HEARTBEAT_STALE_MS ?? DEFAULT_AGENT_HEARTBEAT_STALE_MS);
	const probeAfterMs = staleWindow * 2;
	let stopped = 0,
		stale = 0,
		corrected = 0,
		probesFired = 0,
		probesThrottled = 0,
		expiredParkFlipped = 0;
	for (const agent of Object.values(st.agents)) {
		if (agent.id === "root") continue;
		const leaseKind = agent.leaseKind;
		const leaseUntilMs = agent.leaseUntil ? new Date(agent.leaseUntil).getTime() : 0;
		// Both `reuse` and `park` leases exempt the agent from the heartbeat GC: `reuse` because
		// the root wants the worker kept alive for cross-task reuse; `park` because parking
		// is the sweep's job (the GC must not flip a parked agent to stopped — the parked pane is
		// intentionally dormant and may be revived by the operator). Lease validity requires both
		// `leaseKind` set AND `leaseUntil > now`.
		const leaseValid = (leaseKind === "reuse" || leaseKind === "park") && leaseUntilMs > nowMs;
		if (leaseValid) continue;
		// Review item 3 fix: a paused agent is normally exempt (skip). BUT if the agent has an
		// EXPIRED lease (lease fields set + leaseUntil <= now), the pause no longer represents
		// an intentional operator hold — it's a stranded zombie. Fall through to the gates so
		// gate 1 can still flip a dead-pane expired-park agent to stopped. Without this fix, an
		// expired-park agent whose pane died post-expiry stays status:running forever, immune to
		// both heartbeat GC and the task-close sweep (which also exempts paused).
		const paused = agent.paused === true;
		const expiredLease = !leaseValid && (leaseKind === "reuse" || leaseKind === "park");
		if (paused && !expiredLease) continue;
		const hb = agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt).getTime() : 0;
		const hbAge = hb ? nowMs - hb : Number.POSITIVE_INFINITY;
		const lastProbeAtMs = agent.lastProbeAt ? new Date(agent.lastProbeAt).getTime() : 0;
		// Cheap gate 1: pane known-dead (carried over from a previous probe) + running -> mark stopped.
		// (A stopped agent that stays `tmuxAlive:false` is left alone — it was already counted.)
		if (agent.tmuxAlive === false && agent.status === "running") {
			agent.status = "stopped";
			agent.runtimeStatus = "stopped";
			agent.health = "unhealthy";
			agent.lastShutdownAt ||= new Date(nowMs).toISOString();
			agent.updatedAt = new Date(nowMs).toISOString();
			stopped++;
			if (paused && expiredLease) {
				expiredParkFlipped++;
				await trace(p, TRACE_AGENT_HEARTBEAT_GC_EXPIRED_PARK_FLIPPED, {
					agentId: agent.id,
					reason: "tmux_dead_after_lease_expiry",
					hbAgeMs: hbAge === Number.POSITIVE_INFINITY ? null : hbAge,
				}).catch(() => {});
			} else {
				await trace(p, TRACE_AGENT_HEARTBEAT_GC_STOPPED, {
					agentId: agent.id,
					reason: "tmux_dead",
					hbAgeMs: hbAge === Number.POSITIVE_INFINITY ? null : hbAge,
				}).catch(() => {});
			}
			continue;
		}
		// Cheap gate 2: heartbeat too old AND tmuxTarget set AND plausibly alive (status:running +
		// tmuxAlive !== false) AND probe ledger permits (lastProbeAt older than probeAfterMs).
		// The plausibly-alive guard is the review item 1 fix: a stopped agent with a stale
		// heartbeat must NOT be probed every tick (the original bug — would re-probe the entire
		// graveyard forever, holding the swarm lock for seconds per tick).
		// The probe ledger is the cost-bound the plan/implementation-report claimed: each agent
		// is probed at most once per `probeAfterMs` window (~20 min default), regardless of how
		// stale its heartbeat is.
		if (
			hbAge > probeAfterMs &&
			agent.tmuxTarget &&
			agent.tmuxTarget !== "unknown" &&
			agent.status === "running" &&
			agent.tmuxAlive !== false &&
			nowMs - lastProbeAtMs > probeAfterMs
		) {
			agent.lastProbeAt = new Date(nowMs).toISOString();
			probesFired++;
			const alive = await isTmuxRunning(pi, agent.tmuxTarget);
			if (alive !== agent.tmuxAlive) {
				const previous = agent.tmuxAlive ?? null;
				agent.tmuxAlive = alive;
				corrected++;
				await trace(p, TRACE_AGENT_TMUX_LIVENESS_CORRECTION, {
					agentId: agent.id,
					alive,
					previous,
					hbAgeMs: hbAge === Number.POSITIVE_INFINITY ? null : hbAge,
				}).catch(() => {});
			}
			if (!alive && agent.status === "running") {
				agent.status = "stopped";
				agent.runtimeStatus = "stopped";
				agent.health = "unhealthy";
				agent.lastShutdownAt ||= new Date(nowMs).toISOString();
				agent.updatedAt = new Date(nowMs).toISOString();
				stopped++;
				await trace(p, TRACE_AGENT_HEARTBEAT_GC_STOPPED, {
					agentId: agent.id,
					reason: "tmux_dead_after_probe",
					hbAgeMs: hbAge === Number.POSITIVE_INFINITY ? null : hbAge,
				}).catch(() => {});
				continue;
			}
		} else if (hbAge > probeAfterMs && agent.tmuxTarget && agent.tmuxTarget !== "unknown" && nowMs - lastProbeAtMs <= probeAfterMs) {
			// Review item 1 evidence trace: emit a throttle-skip counter when gate 2 conditions
			// are met but the probe ledger blocks the probe. Cheap (one trace per skipped agent
			// per tick); dashboards can chart probe-skip rates without re-reading state.
			probesThrottled++;
			await trace(p, TRACE_AGENT_HEARTBEAT_GC_PROBE_THROTTLED, {
				agentId: agent.id,
				hbAgeMs: hbAge === Number.POSITIVE_INFINITY ? null : hbAge,
				lastProbeAtMs: lastProbeAtMs || null,
				probeAfterMs,
			}).catch(() => {});
		}
		// Cheap gate 3: heartbeat too old AND idle -> mark stale (downgrade; don't stop).
		if (hbAge > staleWindow && agent.runtimeStatus === "idle") {
			if (agent.health !== "stale") {
				agent.health = "stale";
				agent.updatedAt = new Date(nowMs).toISOString();
				stale++;
				await trace(p, TRACE_AGENT_HEARTBEAT_GC_STALE, { agentId: agent.id, hbAgeMs: hbAge }).catch(() => {});
			}
		}
	}
	if (stopped || stale || corrected) {
		await writeState(p, st);
	}
	return { stopped, stale, corrected, probesFired, probesThrottled, expiredParkFlipped };
}

//
// Pure state mutation: deletes backoffTicksRemaining + nextStallNudgeAt, resets
// consecutiveNoResolveNudges to 0, stamps lastResolvedAt, and emits `task_stall.nudge.resolved` for
// trace visibility. Mirrors the goal-nudge reset hook (turn_end in hooks.ts:484-506) but lives next
// to the mutation sites because the task-stall counter resolves on graph-mutation events, not on
// root turn-end. Clearing nextStallNudgeAt means the next stall fires immediately (fresh
// stall → immediate nudge) rather than waiting out a stale interval window.
