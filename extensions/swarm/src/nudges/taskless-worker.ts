// === swarm/nudges/taskless-worker.ts — taskless-worker detector (Stage D) ===
// Plan: docs/swarm/plans/2026-10-13-worker-task-closure-gaps.md §1.4
//
// Detects running workers that have no task-graph assignment (activeTaskIds empty)
// past a grace window (default 15'). Emits:
//   1. self-nudge to the worker (cap 1 per agent record)
//   2. root notice (cap 2, cooldown 30')
//
// Cost bound: O(N) in-memory scan under the existing pump lock, throttled to one scan per
// `TASKLESS_SCAN_INTERVAL_MS` (default 60s). Zero subprocesses.
//
// De-path rule: bodies name tools + ids only, zero raw filesystem paths.
// Only LLM-callable tools named (swarm_assign_task, swarm_send_message), never slash commands.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	TASKLESS_GRACE_MS,
	TASKLESS_ROOT_COOLDOWN_MS,
	TASKLESS_SCAN_INTERVAL_MS,
	TASKLESS_ROOT_NOTICE_CAP,
	NOTIFY_KEY_TASKLESS_SELF,
	NOTIFY_KEY_TASKLESS_ROOT,
	TRACE_AGENT_TASKLESS_SELF_NUDGE,
	TRACE_AGENT_TASKLESS_ROOT_NOTICE,
	TRACE_AGENT_TASKLESS_DISABLED,
	TRACE_AGENT_TASKLESS_ERROR,
	formatNotifyKey,
} from "../constants.ts";
import type { Paths, SwarmState, SwarmTasklessNudgeState } from "../types.ts";
import { deliverMessageLocked, isResponseTrackingActive } from "../mailbox.ts";
import { isTaskReferenced } from "../agent-gc.ts";
import type { StoppedGcOptions } from "../agent-gc.ts";
import { trace, writeState } from "../state.ts";
import { logSwarmError } from "../errorlog.ts";

const SCAN_THROTTLE_KEY = "_lastScanAt";

let disabledTracedOnce = false;

export interface TasklessWorkerNudgeResult {
	scanRan: boolean;
	inspected: number;
	selfNudged: number;
	rootNotified: number;
	eligible?: string[];
	suppressed?: string[];
	reason?: "disabled" | "interval_gated" | "no_candidates";
}

/**
 * Predicate to check if an agent has any unresolved requiresResponse inbound messages.
 * Mirrors fireOrphanWarning's inbound scan + responseMissingRecords predicate.
 */
function hasUnresolvedRequiresResponse(st: SwarmState, agentId: string): boolean {
	for (const m of Object.values(st.messages || {})) {
		if (m.to !== agentId) continue;
		if (!m.requiresResponse) continue;
		if (m.superseded) continue;
		if (!isResponseTrackingActive(m)) continue;
		if (m.response?.status === "verified" || m.response?.status === "waived") continue;
		return true;
	}
	return false;
}

/**
 * Evaluate taskless worker eligibility and emit worker self-nudge and root notice.
 * MUST be called under the swarm lock (pump maintenance phase). The caller persists state.
 */
export async function evaluateTasklessWorkerNudgeLocked(
	pi: ExtensionAPI,
	cwd: string,
	p: Paths,
	st: SwarmState,
	nowMs: number,
	taskGraphs?: StoppedGcOptions["taskGraphs"],
): Promise<TasklessWorkerNudgeResult> {
	if (process.env.PI_SWARM_TASKLESS_NUDGE_OFF === "1") {
		if (!disabledTracedOnce) {
			disabledTracedOnce = true;
			try {
				await trace(p, TRACE_AGENT_TASKLESS_DISABLED, { via: "env_kill_switch" });
			} catch (err) {
				await logSwarmError(p, "taskless-worker", "taskless.disabled_trace_failed", err, {});
			}
		}
		return { scanRan: false, inspected: 0, selfNudged: 0, rootNotified: 0, reason: "disabled" };
	}

	st.tasklessNudgeState ||= {};
	const g = st.tasklessNudgeState;
	const lastScanRaw = g[SCAN_THROTTLE_KEY];
	const lastScanAt = typeof lastScanRaw === "string" ? new Date(lastScanRaw).getTime() : 0;
	if (Number.isFinite(lastScanAt) && nowMs - lastScanAt < TASKLESS_SCAN_INTERVAL_MS) {
		return { scanRan: false, inspected: 0, selfNudged: 0, rootNotified: 0, reason: "interval_gated" };
	}
	g[SCAN_THROTTLE_KEY] = new Date(nowMs).toISOString();

	// Scan non-root agents
	const eligible: string[] = [];
	const suppressed: string[] = [];
	let inspected = 0;

	for (const agent of Object.values(st.agents || {})) {
		if (agent.id === "root") continue;
		inspected++;

		// 1. status === "running"
		if (agent.status !== "running") continue;

		// 2. activeTaskIds.length === 0
		if ((agent.activeTaskIds || []).length > 0) continue;

		// 3. agent age > TASKLESS_GRACE_MS
		const createdAtMs = agent.createdAt ? new Date(agent.createdAt).getTime() : 0;
		if (createdAtMs <= 0 || nowMs - createdAtMs <= TASKLESS_GRACE_MS) continue;

		// 4. NO unresolved requiresResponse inbound message addressed to it
		if (hasUnresolvedRequiresResponse(st, agent.id)) continue;

		// 5. no open graph node assigns it
		if (taskGraphs && isTaskReferenced(agent.id, taskGraphs)) continue;

		// 6. no valid reuse/park lease, paused !== true
		if (agent.paused === true) continue;
		const leaseUntilMs = agent.leaseUntil ? new Date(agent.leaseUntil).getTime() : 0;
		if ((agent.leaseKind === "reuse" || agent.leaseKind === "park") && leaseUntilMs > nowMs) continue;

		eligible.push(agent.id);
	}

	if (eligible.length === 0) {
		await persistStateBestEffort(p, st);
		return { scanRan: true, inspected, selfNudged: 0, rootNotified: 0, eligible, suppressed, reason: "no_candidates" };
	}

	let selfNudged = 0;
	let rootNotified = 0;

	for (const agentId of eligible) {
		const perAgent = ((typeof g[agentId] === "object" ? g[agentId] : null) as SwarmTasklessNudgeState) || {
			selfNudges: 0,
			rootNotices: 0,
		};

		// 1. Self-nudge to worker: cap 1 per agent record
		if (perAgent.selfNudges < 1) {
			const selfKey = formatNotifyKey(NOTIFY_KEY_TASKLESS_SELF, { agentId });
			const selfSubject = `Notice: no task-graph assignment for agent ${agentId}`;
			const selfBody =
				`You are running with no task-graph assignment. ` +
				`If your work is done, report to root via swarm_send_message; ` +
				`if you are a message-only helper, ignore this notice.`;

			try {
				await deliverMessageLocked(pi, cwd, p, st, {
					to: agentId,
					subject: selfSubject,
					body: selfBody,
					conversationId: `agent:${agentId}:taskless-self`,
					requiresAck: false,
					requiresResponse: false,
					idempotencyKey: selfKey,
					priority: "normal",
				});
				perAgent.selfNudges += 1;
				selfNudged++;
				await trace(p, TRACE_AGENT_TASKLESS_SELF_NUDGE, { agentId, seq: perAgent.selfNudges }).catch(() => {});
			} catch (err) {
				await logSwarmError(p, "taskless-worker", "taskless.self_nudge_failed", err, { agentId, key: selfKey });
			}
		}

		// 2. Root notice: cap 2, cooldown TASKLESS_ROOT_COOLDOWN_MS
		if (perAgent.rootNotices < TASKLESS_ROOT_NOTICE_CAP) {
			const lastRootMs = perAgent.lastRootNoticeAt ? new Date(perAgent.lastRootNoticeAt).getTime() : 0;
			if (lastRootMs <= 0 || nowMs - lastRootMs >= TASKLESS_ROOT_COOLDOWN_MS) {
				const seq = perAgent.rootNotices + 1;
				const rootKey = formatNotifyKey(NOTIFY_KEY_TASKLESS_ROOT, { agentId, seq: String(seq) });
				const rootSubject = `Agent ${agentId} is running with no task-graph assignment`;
				const rootBody =
					`Agent ${agentId} has been running without a task-graph assignment past the grace period.\n\n` +
					`Action:\n` +
					`  To attach its work to a task graph:\n` +
					`    swarm_assign_task(taskId="<taskId>", nodeId="<nodeId>", agentId="${agentId}")\n` +
					`  If this is a message-only helper (no task graph), ignore this notice.`;

				try {
					await deliverMessageLocked(pi, cwd, p, st, {
						to: "root",
						subject: rootSubject,
						body: rootBody,
						conversationId: `agent:${agentId}:taskless-root`,
						requiresAck: false,
						requiresResponse: false,
						idempotencyKey: rootKey,
						priority: "normal",
					});
					perAgent.rootNotices = seq;
					perAgent.lastRootNoticeAt = new Date(nowMs).toISOString();
					rootNotified++;
					await trace(p, TRACE_AGENT_TASKLESS_ROOT_NOTICE, { agentId, seq }).catch(() => {});
				} catch (err) {
					await logSwarmError(p, "taskless-worker", "taskless.root_notice_failed", err, { agentId, key: rootKey });
				}
			} else {
				suppressed.push(agentId);
			}
		} else {
			suppressed.push(agentId);
		}

		g[agentId] = perAgent;
	}

	await persistStateBestEffort(p, st);
	return { scanRan: true, inspected, selfNudged, rootNotified, eligible, suppressed };
}

async function persistStateBestEffort(p: Paths, st: SwarmState): Promise<void> {
	try {
		await writeState(p, st);
	} catch (err) {
		await logSwarmError(p, "taskless-worker", "taskless.state_write_failed", err, {});
	}
}

export { TRACE_AGENT_TASKLESS_ERROR };
