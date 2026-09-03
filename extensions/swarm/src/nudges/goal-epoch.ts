// === swarm/src/nudges/goal-epoch.ts ===
// Module boundary: goal-floor emission + swarm-level idle epoch.
//   - `resolveGoalNudgeIntervalMs` — env-aware interval resolver for the goal floor
//   - `agentIsEffectivelyAlive`  — liveness filter (excludes stopped/stale ghosts)
//   - `allEffectiveIdleAgents`   — derived view used by both nudge families
//   - `updateIdleEpochLocked`    — maintains the swarm-level all-idle anchor
//   - `evaluateIdleGoalNudgeLocked` — cap+backoff goal floor machinery
//
// Why co-located: goal floor + epoch edge belong together — they share
// `allEffectiveIdleAgents` and the r23B/r23C storm guard state (`r23LastEpochAnchor`,
// `lastEpochBusyAgents`) is anchored in `updateIdleEpochLocked` and the busy→idle edge.
// The stall nudge in graph-advance.ts re-uses these helpers via barrel re-export.
//
// Moved verbatim from reconcile.ts (lines 12-28, 308-409, 443-1004) as part of the R24
// structure refactor. No behavior change.

import { existsSync, writeFile } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Paths, SwarmAgent, SwarmIdleNudgeState, SwarmMessage, SwarmState } from "../types.ts";
import {
  GOAL_NUDGE_BACKOFF_TICKS, GOAL_NUDGE_IDLE_INTERVAL_MS, MAX_CONSECUTIVE_NUDGES_DEFAULT, NOTIFY_DEFAULT_COOLDOWN_MS, NOTIFY_KEY_GOAL_IDLE_NUDGE,
  TASK_NUDGE_MS, TASK_STALE_MS, formatNotifyKey,
} from "../constants.ts";

import { ensureAgentDefaults, now } from "../utils.ts";
import { tmux } from "../tmux.ts";
import { computeReadyNodes, computeTaskStatus, checkStallNotificationStale } from "../taskgraph.ts";
import { deliverMessageLocked, findIdempotentMessage, readMailbox } from "../mailbox.ts";
import { readState, readTaskState, taskPaths, trace, traceTask, withLock, writeState } from "../state.ts";
const AGENT_HEARTBEAT_STALE_MS = Number(process.env.PI_SWARM_AGENT_HEARTBEAT_STALE_MS ?? 10 * 60_000);

import { currentAgentId } from "../session.ts";
import { TERMINAL_NODE_STATUSES } from "../constants.ts";
import { isStallNudgeEligibleTaskStatus, isTerminalOrAbandonedTaskStatus } from "./status-predicates.ts";

export function resolveGoalNudgeIntervalMs(nudgeIntervalMs?: number | null): number {
	if (typeof nudgeIntervalMs === "number" && Number.isFinite(nudgeIntervalMs) && nudgeIntervalMs > 0) return Math.floor(nudgeIntervalMs);
	const raw = process.env.PI_SWARM_GOAL_NUDGE_IDLE_INTERVAL_MS;
	if (raw !== undefined && String(raw).trim() !== "") {
		const env = Number(raw);
		if (Number.isFinite(env) && env > 0) return Math.floor(env);
	}
	return 5_000;
}


export function agentIsEffectivelyAlive(a: { status?: string; runtimeStatus?: string; tmuxAlive?: boolean; lastHeartbeatAt?: string }, nowMs: number): boolean {
	if (a.status !== "running") return false;
	if (a.tmuxAlive === false) return false;
	if (a.runtimeStatus === "stopped") return false;
	const hb = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : NaN;
	const hbFresh = Number.isFinite(hb) && nowMs - hb <= AGENT_HEARTBEAT_STALE_MS;
	// R14 Fix A (2026-09-02): settled-but-alive workers whose heartbeat is stale (the
	// 10-min default window) but whose tmux pane is alive AND whose runtimeStatus is
	// "idle" were being misclassified as dead, producing false vacuous pools and
	// spammed held_no_live_workers traces. The pane-alive + idle signal is the freshest
	// liveness check we have for a settled worker; honor it. The `tmuxAlive === false`
	// early-return above is the genuine ghost-eviction signal and stays. The
	// `status !== "running"` early-return above is the explicit stopped/retired signal
	// and stays. The `runtimeStatus === "busy"` case is intentionally NOT rescued by
	// the tmuxAlive fallback — a busy worker with a stale heartbeat is in the
	// "stuck" shape; we want the goal nudge to surface (the worker's runtimeStatus
	// is the authoritative signal for liveness during an in-flight tool call).
	if (a.tmuxAlive === true && a.runtimeStatus === "idle") return true;
	if (hbFresh) return true;
	return false;
}

export function allEffectiveIdleAgents(st: SwarmState, nowMs: number) {
	const idleAgents = Object.values(st.agents).filter((a) => a.id !== "orchestrator" && agentIsEffectivelyAlive(a, nowMs));
	// Issue 85 (task-202608310905, bug #3): when zero effective non-orchestrator agents remain (post-prune,
	// all stopped, all stale), there's nothing to nudge about. Vacuous-idle: report allIdle=false so the
	// pump short-circuits the goal nudge with reason "no_live_workers" (see evaluateIdleGoalNudgeLocked
	// below) instead of firing forever into an empty swarm. `vacuous: true` lets callers distinguish
	// "no workers exist" from "workers exist and one is busy" — the goal evaluator needs the distinction
	// to trace `goal.nudge.held_no_live_workers` exactly once per transition.
	if (idleAgents.length === 0) return { idleAgents, allIdle: false, vacuous: true };
	// Issue 85 (task-202608310905, bug #2): an effective agent with `activeTaskIds.length > 0` carries an
	// assignment pointer even when its `runtimeStatus` is still `idle` (the post-assign / pre-pickup
	// window before the worker has consumed the assignment message). The pump must treat the swarm as
	// NOT idle in that window so the goal nudge does not race ahead of the throttled task-dir scan
	// (findAssignedOrInProgressTaskWork) — the assignment pointer is durable in-memory state and is the
	// faster, more accurate signal. `assignmentInFlight: true` lets the goal evaluator emit the more
	// diagnostic `goal.nudge.suppressed_by_assignment_in_flight` trace instead of the generic
	// `agent_busy` from updateIdleEpochLocked. The check must be specifically for idle+pointer agents
	// (not busy+pointer): when a worker is mid-tool AND carrying an assignment pointer, the
	// runtimeStatus="busy" signal is the more informative cause and the goal evaluator should surface
	// `agent_busy` rather than `assignment_in_flight`.
	const idleWithPointer = idleAgents.filter((a) => a.runtimeStatus === "idle" && (a.activeTaskIds?.length ?? 0) > 0);
	if (idleWithPointer.length > 0) return { idleAgents, allIdle: false, vacuous: false };
	const allIdle = idleAgents.every((a) => a.runtimeStatus === "idle");
	return { idleAgents, allIdle, vacuous: false };
}

async function scanTaskDirsForActiveWork(p: Paths, taskIds?: Iterable<string>): Promise<{ taskId: string; nodeId: string; assignee?: string; status: "assigned" | "in_progress" } | null> {
	const ids = taskIds ? Array.from(new Set(taskIds)) : null;
	const _dirs = ids ?? await readdir(p.tasksDir, { withFileTypes: true }).then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)).catch(() => []);
	const candidateDirs = _dirs;
	for (const taskId of candidateDirs) {
		const taskJson = join(p.tasksDir, taskId, "task.json");
		let task: TaskState | null = null;
		try {
			task = JSON.parse(await readFile(taskJson, "utf8")) as TaskState;
		} catch (e) {
			continue;
		}
		for (const [nodeId, node] of Object.entries(task.nodes || {})) {
			if (node && (node.status === "assigned" || node.status === "in_progress")) {
				return { taskId: task.taskId || taskId, nodeId, assignee: node.assignee, status: node.status as "assigned" | "in_progress" };
			}
		}
	}
	return null;
}

async function findAssignedOrInProgressTaskWork(st: SwarmState, p: Paths, idleState: SwarmIdleNudgeState, nowMs: number, scanThrottleMs: number): Promise<{ taskId: string; nodeId: string; assignee?: string; status: "assigned" | "in_progress" } | null> {
	// Goal suppression is a prompt-time concern, so keep it cheap: inspect in-memory agent.activeTaskIds
	// first, then fall back to a throttled task-dir scan only if the fast path finds nothing.
	const candidateTaskIds = new Set<string>();
	for (const agent of Object.values(st.agents)) {
		ensureAgentDefaults(agent);
		for (const taskId of agent.activeTaskIds || []) candidateTaskIds.add(taskId);
	}
	if (candidateTaskIds.size) {
		const hit = await scanTaskDirsForActiveWork(p, candidateTaskIds);
		if (hit) return hit;
	}
	const lastScanMs = idleState.lastGoalActiveTaskScanAt ? new Date(idleState.lastGoalActiveTaskScanAt).getTime() : NaN;
	const cacheValid = Number.isFinite(lastScanMs) && nowMs - lastScanMs < scanThrottleMs;
	if (cacheValid) {
		const cached = idleState.lastGoalActiveTaskWork;
		if (!cached) return null;
		const confirmed = await scanTaskDirsForActiveWork(p, [cached.taskId]);
		if (confirmed && confirmed.nodeId === cached.nodeId && confirmed.status === cached.status) return confirmed;
		idleState.lastGoalActiveTaskWork = null;
		idleState.lastGoalActiveTaskScanAt = new Date(nowMs).toISOString();
		return await scanTaskDirsForActiveWork(p);
	}
	idleState.lastGoalActiveTaskScanAt = new Date(nowMs).toISOString();
	const scanned = await scanTaskDirsForActiveWork(p);
	idleState.lastGoalActiveTaskWork = scanned;
	return scanned;
}

// Row 68 (AC1 fix): task statuses whose graphs can carry actionable work. A freshly created task is
// task-status "ready" (computeTaskStatus: started ? "in_progress" : "ready"), so Path A —
// non-terminal actionable graph + all effective agents idle — must admit BOTH, not in_progress only.
// Terminal/cancelled/blocked are excluded: blocked graphs cannot make progress (a blocked task
// re-enters "in_progress" the moment a node unblocks, re-admitting it here).

export async function updateIdleEpochLocked(p: Paths, st: SwarmState, nowMs: number): Promise<{ allIdle: boolean; idleAgents: SwarmAgent[]; vacuous?: boolean }> {
	const idleState: SwarmIdleNudgeState = st.idleNudgeState ||= {};
	const { idleAgents, allIdle, vacuous } = allEffectiveIdleAgents(st, nowMs);
	if (!allIdle) {
		// R14 Fix B (2026-09-02): clearing lastWasVacuous on the all-idle→busy edge
		// ensures the next vacuous transition (busy→idle-but-no-workers) re-fires the
		// held_no_live_workers trace exactly once. We only clear when `vacuous` is
		// FALSE — when `vacuous` is TRUE the pool is still empty and the trace must
		// stay suppressed (already fired on the false→true edge). Clearing on the
		// vacuous branch would defeat the dedupe gate.
		if (!vacuous && idleState.lastWasVacuous) idleState.lastWasVacuous = false;
		if (idleState.allIdleSinceAt || idleState.nextGoalNudgeAt) {
			// Busy edge: restart stall spacing so the next all-idle edge re-arms emission immediacy.
			const stallSlotsReset: string[] = [];
			for (const slot of Object.values(st.taskStallState || {})) {
				if (slot?.nextStallNudgeAt) { delete slot.nextStallNudgeAt; stallSlotsReset.push(slot.taskId); }
			}
			// === R23B (2026-09-02) — stamp the cause of every anchor-clearing ===
			// The cap-branch reset is gated on `lastEpochBusyAgents?.some(id => id !== "orchestrator")`
			// so the breaker can tell a worker-driven fresh epoch (qualifies) from orchestrator-turn
			// churn that briefly flipped a worker busy/idle (does NOT qualify). `busyAgents` is the
			// same array already passed to the `idle.epoch.reset` trace below; persisting it lets the
			// next fresh-epoch evaluator distinguish worker-busy breaks from orchestrator-driven
			// ones without a second scan over `st.agents`.
			const busyAgents = idleAgents.filter((a) => a.runtimeStatus !== "idle").map((a) => a.id);
			await trace(p, "idle.epoch.reset", {
				reason: "agent_busy",
				busyAgents,
				previousAllIdleSinceAt: idleState.allIdleSinceAt ?? null,
				stallSlotsReset,
			}).catch(() => {});
			idleState.lastEpochBusyAgents = busyAgents;
		}
		delete idleState.allIdleSinceAt;
		delete idleState.nextGoalNudgeAt;
		delete idleState.actionableGraphDeferredAt;
		return { allIdle, idleAgents, vacuous };
	}
	// R14 Fix B (2026-09-02): the vacuous→non-vacuous edge also clears the dedupe
	// gate so the next false→true transition re-fires the held trace exactly once.
	// When allIdle is true AND vacuous is false the pool is non-empty; we always
	// clear regardless of whether the edge was just crossed, because the flag
	// only persists across genuinely-vacuous ticks (the vacuous branch sets it).
	if (!vacuous && idleState.lastWasVacuous) idleState.lastWasVacuous = false;
	if (!idleState.allIdleSinceAt) {
		idleState.allIdleSinceAt = new Date(nowMs).toISOString();
		delete idleState.nextGoalNudgeAt;
		// Row R19 (2026-09-02): clear the once-per-epoch actionable-graph defer guard on the
		// busy→idle edge so a new epoch can defer one more time (Fix A semantics).
		delete idleState.actionableGraphDeferredAt;
		// === R23B (2026-09-02) — delete the edge-site reset. Storm-safety fix: ===
		// The original R23 fix also reset the counter at the busy→idle EDGE in this
		// function (when `if (!idleState.allIdleSinceAt)` was true and the goal was
		// saturated). That edge site never consulted the `r23LastEpochAnchor` memo, so
		// it fired on EVERY busy→idle edge while saturated — defeating MAX+backoff in
		// real sessions where `agent_settled` re-stamps the anchor at every orchestrator
		// turn boundary. Live: implementer lane 2026-09-02T15:19:06..15:21:46Z —
		// `goal.nudge.saturation_reset_on_epoch` ×12, `goal.idle_nudge` seq 4→38,
		// `mailbox.orchestrator_pump_stuck_escalated` ×34. The cap branch (memo-checked)
		// is now the SOLE reset site; the edge site only stamps the memo.
		//
		// The fresh nudge still emits on the first eligible tick past the cap because
		// `r23LastEpochAnchor` was just stamped above — the cap branch's
		// `notYetAppliedR23 (memo !== anchor)` predicate fails on this same tick, so
		// no double-reset. (The previous R23 cap-branch path reset the counter and
		// emitted on the same tick; with the edge site deleted, the very first eligible
		// tick past the new anchor enters the cap branch and the same code path runs.)
		//
		// === R23C (2026-09-03) — PRESERVE `lastEpochBusyAgents` at mint (don't clear) ===
		// The original R23B mint branch DELETED the breaker (`delete idleState.lastEpochBusyAgents;`)
		// on the rationale "keeps the data fresh by construction". That was wrong: every production
		// anchor passes through this mint branch, so deleting the breaker at every mint meant the
		// cap branch ALWAYS saw `breaker = undefined` → absent→reset legacy default → STORM rerouted
		// through here once the edge site was gone (live storm continued even with edge-site
		// deletion). The correct invariant is: `lastEpochBusyAgents` is provenance — it carries the
		// cause of the most recent anchor CLEAR (the busy edge that caused the prior anchor to be
		// invalidated) and must SURVIVE from the clear site to the next atCap eval that uses it.
		// Clear sites that stamp:
		//   - busy edge in `updateIdleEpochLocked` (`!allIdle` branch, above) → stamps real worker
		//     agent ids → legitimate R23 re-arm preserved.
		//   - `hooks.ts` turn_start → now stamps `["orchestrator"]` → orchestrator-turn churn
		//     rejected by the breaker guard.
		// Anything else (legacy state file, fresh seed) → breaker absent → absent→reset default
		// (probe C semantics preserved).
		// R23B-tester (2026-09-03) — DELETED stamp, not set. The original R23B draft
		// stamped `r23LastEpochAnchor = allIdleSinceAt` at mint; every production anchor
		// passes through here, so once minted `memo === anchor` permanently, the cap branch's
		// `notYetAppliedR23 (memo !== anchor)` check is never true, and the reset never fires
		// in production (R23 starvation returns). Clear at mint instead: the first
		// atCap-eligible tick past the cap then sees `memo !== anchor` → reset+emit exactly
		// once per fresh epoch; later ticks in the same epoch see `memo === anchor` → no
		// reset; orchestrator-turn churn anchors are also rejected by the worker-breaker
		// guard above. Probe evidence: tester-memo-probe.{mjs,out.txt}.
		delete (idleState as { r23LastEpochAnchor?: string }).r23LastEpochAnchor;
		await trace(p, "idle.epoch.started", { allIdleSinceAt: idleState.allIdleSinceAt, idleAgents: idleAgents.length }).catch(() =>{});
	}
	return { allIdle, idleAgents, vacuous };
}

// Row R19 (2026-09-02): `excludeTerminalTaskOrphans` controls whether terminal/abandoned tasks
// (failed/cancelled/blocked) participate in the actionable-graph scan. When called from the
// goal-fallback gate (evaluateIdleGoalNudgeLocked), terminal tasks are EXCLUDED so their orphan
// rework nodes cannot permanently silence the goal floor (Fix B). When called from graph-stall
// or stale-open surfaces, terminal tasks are ADMITTED (Row 75 preserved).
async function hasActionableGraphWork(p: Paths, excludeTerminalTaskOrphans?: boolean): Promise<{ actionable: boolean; taskId?: string; nodeId?: string; role?: string }> {
	if (!existsSync(p.tasksDir)) return { actionable: false };
	try {
		const entries = await readdir(p.tasksDir);
		for (const taskId of entries) {
			const tp = taskPaths(p, taskId);
			if (!existsSync(tp.taskJson)) continue;
			let task: TaskState;
			try { task = await readTaskState(tp.taskJson); } catch { continue; }
			// Row 68 fix (AC1): a freshly created task stays task-status "ready" until its first node
			// is assigned (computeTaskStatus: started ? in_progress : ready), so filtering on
			// in_progress-only hid never-assigned graphs from the graph nudge AND from goal suppression.
			// Path A is defined by NON-TERMINAL task + actionable ready/unassigned node.
			if (!isStallNudgeEligibleTaskStatus(task.status)) continue;
			// Row R19 (Fix B): when excludeTerminalTaskOrphans is true, skip terminal/abandoned tasks
			// whose orphan rework nodes can never auto-advance without orchestrator force-reopen.
			// The graph-stall call site (Row 75) preserves `failed` admission; only the goal-fallback
			// call site excludes terminal tasks.
			if (excludeTerminalTaskOrphans && isTerminalOrAbandonedTaskStatus(task.status)) continue;
			const cr = computeReadyNodes(task);
			const actionable = new Set([
				...cr.ready,
				...cr.current.filter((id) => task.nodes[id] && task.nodes[id].status === "ready" && !task.nodes[id].assignee),
			]);
			for (const nodeId of actionable) {
				const node = task.nodes[nodeId];
				if (!node || node.assignee || TERMINAL_NODE_STATUSES.has(node.status)) continue;
				return { actionable: true, taskId, nodeId, role: node.role || "worker" };
			}
		}
	} catch { /* unreadable tasksDir */ }
	return { actionable: false };
}

// === Issue 18: Swarm goal + idle-streak nudge ===
// When the orchestrator has set a goal AND every non-orchestrator agent is runtimeStatus="idle" AND
// no task nodes are assigned/in_progress, this function emits an idempotent structured nudge to the
// orchestrator's own mailbox. Anti-loop: the consecutiveNoResolveNudges counter resets on ANY
// orchestrator turn that ends stopReason="stop" (hooks.ts turn_end branch — runs after the model-
// pool swap branch per binding C-2). Once the counter reaches MAX_CONSECUTIVE_NUDGES_DEFAULT, the
// pump enters a GOAL_NUDGE_BACKOFF_TICKS-tick back-off: each subsequent tick decrements the counter
// without emitting; the tick that hits 0 does NOT emit (it is the back-off exit gate); the FOLLOWING
// tick may re-enter the max-nudges branch and re-arm the back-off. Idle predicate filters out the
// orchestrator pseudo-agent (matches the issue 18 brief + plan §3.4). MUST be called under the
// same withLock(p) the pump already holds; never acquire the lock inside this function.
//
// Exported for direct unit testing by idle-nudge.test.mjs. Tests pass synthetic nowMs / st /
// orchestration flags so they can drive every branch deterministically.
export async function evaluateIdleGoalNudgeLocked(
	pi: ExtensionAPI,
	cwd: string,
	p: Paths,
	st: SwarmState,
	nowMs: number,
): Promise<{ emitted: boolean; reason: string }> {
	const goal = st.goal;
	// No goal set: idle predicate irrelevant. Pre-policy swarms with no `goal` key parse to undefined
	// here (binding C-1) — this is the most common branch on legacy state and is intentionally cheap.
	if (!goal) return { emitted: false, reason: "no_goal" };

	// Row 68: the idle epoch is maintained by the SHARED helper (the pump also runs it, so this is
	// idempotent within a tick) so the busy→all-idle edge anchors to the swarm-level state, not to
	// goal presence. Ghosts excluded; a busy effective agent resets the epoch.
	// Issue 85 (task-202608310905, bug #2 + bug #3): `updateIdleEpochLocked` (via `allEffectiveIdleAgents`)
	// now also flips `allIdle=false` when (a) zero effective agents remain (vacuous — bug #3) or (b) any
	// effective agent carries an assignment pointer (bug #2). The pump evaluator distinguishes the two
	// with distinct reasons + traces so the orchestrator sees WHY the nudge was held.
	const idleState: SwarmIdleNudgeState = st.idleNudgeState ||= {};
	const epoch = await updateIdleEpochLocked(p, st, nowMs);
	const { idleAgents, allIdle, vacuous } = epoch;
	if (vacuous) {
		// Bug #3 evidence: hold the goal nudge when zero effective non-orchestrator agents remain.
		// R14 Fix B (2026-09-02): trace fires only on the `idleAgents.length > 0` → `0`
		// transition (the once-per-transition promise in the comment above was never
		// enforced — the code fired every tick of vacuous state, producing 7_278 spam
		// traces for goal-1788266039522-6eae40 over ~16h). The transition flag lives on
		// `idleNudgeState.lastWasVacuous` so it persists across the swarm→orchestrator
		// restarts. Cleared in updateIdleEpochLocked's not-all-idle branch (the
		// pool-recovered edge).
		//
		// R16 Fix B (2026-09-02): decouple the dedupe flag's persistence from the pump tail
		// writeState (reconcile.ts:1929). Even after the orchestrator /reload's, the
		// `lastWasVacuous` + `lastPoolEmptyEscalationAt` mutations MUST survive an immediate
		// readState. We persist via the dedicated writeState at the end of this vacuous
		// branch (added below) so the dedupe survives independently of whether the pump
		// tail writeState runs. The pump tail is still the source of truth for OTHER
		// mutations; this is the minimum additional write that closes the persistence gap.
		const idleStateVac: SwarmIdleNudgeState = st.idleNudgeState ||= {};
		const wasVacuous = idleStateVac.lastWasVacuous === true;
		if (!wasVacuous) {
			await trace(p, "goal.nudge.held_no_live_workers", { goalId: goal.id, effectiveAgentCount: 0 }).catch(() => {});
		}
		idleStateVac.lastWasVacuous = true;
		// R14 Fix C (2026-09-02): bounded, durable, high-priority orchestrator recovery
		// nudge for an active USER-ORIGIN goal whose pool is genuinely vacuous. Cooldown-
		// bounded by NOTIFY_DEFAULT_COOLDOWN_MS (5min). Stops emitting when the goal
		// clears/cancels (consult `st.goal` at the top of the evaluator; the no_goal
		// guard short-circuits before this branch). Bypasses idle gates via the R13 P0
		// high-priority surface — the orchestrator's tmuxTarget is `unknown` so the
		// message is durably enqueued in the mailbox and the pump surfaces it once the
		// orchestrator is idle (R13 P0 path; unchanged).
		if (goal.origin === "user" || goal.origin === "system" || goal.origin === "batch") {
			const cooldownUntilMs = idleStateVac.lastPoolEmptyEscalationAt
				? new Date(idleStateVac.lastPoolEmptyEscalationAt).getTime() + NOTIFY_DEFAULT_COOLDOWN_MS
				: 0;
			if (nowMs >= cooldownUntilMs) {
				const poolDiag = Object.values(st.agents)
					.filter((a) => a.id !== "orchestrator")
					.map((a) => {
						const hb = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : NaN;
						const ageSec = Number.isFinite(hb) ? Math.round((nowMs - hb) / 1000) : null;
						return { id: a.id, tmuxAlive: a.tmuxAlive ?? null, runtimeStatus: a.runtimeStatus, heartbeatAgeSec: ageSec };
					});
				await trace(p, "goal.escalation.pool_empty", {
					goalId: goal.id,
					origin: goal.origin,
					effectiveAgentCount: 0,
					poolDiag,
					cooldownMs: NOTIFY_DEFAULT_COOLDOWN_MS,
				}).catch(() => {});
				idleStateVac.lastPoolEmptyEscalationAt = new Date(nowMs).toISOString();
				// === R16 Fix C (2026-09-02): action-oriented nudge body ===
				// Replace the generic diagnostic dump with condition-specific next-action hints
				// per the orchestrator's note: "Nudges must be action-oriented per user direction:
				// condition-specific next-action hints." The poolDiag already classifies agents
				// by tmuxAlive/runtimeStatus/heartbeatAgeSec; we classify the actionable subset
				// into the four hint buckets and join the relevant ones into the body.
				const deadAgents = poolDiag.filter((d) => d.tmuxAlive === false);
				const stoppedAgents = poolDiag.filter((d) => d.runtimeStatus === "stopped");
				const staleAgents = poolDiag.filter((d) => d.heartbeatAgeSec !== null && d.heartbeatAgeSec > 600 && d.tmuxAlive !== false && d.runtimeStatus !== "stopped");
				const hints: string[] = [];
				if (deadAgents.length > 0) {
					const ids = deadAgents.map((a) => a.id).join(", ");
					hints.push(`Dead panes (${deadAgents.length}): ${ids}. Run \`swarm_spawn_agent(role=..., roleKind=worker)\` to replace, or \`swarm_restart_agent(agentId=...)\` if panes are recoverable.`);
				}
				if (stoppedAgents.length > 0 && deadAgents.length === 0) {
					const ids = stoppedAgents.map((a) => a.id).join(", ");
					hints.push(`Stopped agents (${stoppedAgents.length}): ${ids}. Run \`swarm_restart_agent(agentId=...)\` for each, or spawn fresh.`);
				}
				if (staleAgents.length > 0 && deadAgents.length === 0 && stoppedAgents.length === 0) {
					hints.push(`All agents stale (>10min no heartbeat). Run \`swarm_spawn_agent(role=..., roleKind=worker)\` to mint a fresh worker.`);
				}
				if (hints.length === 0) {
					hints.push(`No live workers but no clear ghost classification. Run \`swarm_spawn_agent(role=..., roleKind=worker)\` or ask the user for direction.`);
				}
				hints.push(`Or scope a step: \`swarm_create_task(title=..., goal=..., workflow=feature-dev)\` and assign to a fresh worker.`);
				hints.push(`Or clear the goal if it is no longer relevant: \`swarm_mark_goal_done(goalId="${goal.id}")\`.`);
				await deliverMessageLocked(pi, cwd, p, st, {
					to: "orchestrator",
					priority: "high",
					subject: `Goal escalation: worker pool empty (goal ${goal.id})`,
					body: `User-origin goal is held with zero effective live workers (cooldown: ${Math.round(NOTIFY_DEFAULT_COOLDOWN_MS / 1000)}s).\n` +
						`Goal text: ${String(goal.text || "").slice(0, 200)}.\n\n` +
						`Pool diag: ${JSON.stringify(poolDiag)}.\n\n` +
						`Next action (one of):\n` +
						hints.map((h, i) => `  ${i + 1}. ${h}`).join("\n"),
					requiresAck: true,
					requiresResponse: false,
					conversationId: `goal:${goal.id}:escalation:pool-empty:cooldown:${NOTIFY_DEFAULT_COOLDOWN_MS}`,
					idempotencyKey: `goal:${goal.id}:escalation:pool-empty:${new Date(nowMs).toISOString().slice(0, 13)}`,
				});
			}
		}

		// R16 Fix B (2026-09-02): persist the vacuous-branch mutations IMMEDIATELY so the
		// dedupe flag + cooldown timestamp survive an immediate readState (e.g., an
		// orchestrator /reload right after the pump). The pump tail writeState at
		// reconcile.ts:1929 still runs (it's the source of truth for ALL pump mutations),
		// but this explicit write closes the persistence gap discovered by R16: the
		// pre-R14-+-no-tail shape meant a re-entering pump saw lastWasVacuous=undefined
		// and re-fired the held trace every tick.
		await writeState(p, st);
		return { emitted: false, reason: "no_live_workers" };
	}
	if (!allIdle) {
		// Bug #2 evidence: distinguish "worker just got an assignment but hasn't picked it up yet" from
		// "worker is mid-tool". The assignment-pointer fast path lives in `allEffectiveIdleAgents`; here
		// we only need to know whether the pointer OR a busy runtimeStatus caused the all-idle break.
		// If any IDLE-BY-RUNTIME-STATUS agent carries a pointer, that was the cause. If only BUSY agents
		// are present (with or without pointers), the diagnostic is the generic `agent_busy`.
		const pointerAssignee = idleAgents.find((a) => a.runtimeStatus === "idle" && (a.activeTaskIds?.length ?? 0) > 0);
		if (pointerAssignee) {
			await trace(p, "goal.nudge.suppressed_by_assignment_in_flight", { goalId: goal.id, assignee: pointerAssignee.id, taskIds: pointerAssignee.activeTaskIds }).catch(() => {});
			return { emitted: false, reason: "assignment_in_flight" };
		}
		return { emitted: false, reason: "agent_busy" };
	}
	const allIdleSinceMs = new Date(idleState.allIdleSinceAt!).getTime();
	if (!Number.isFinite(allIdleSinceMs)) {
		delete idleState.allIdleSinceAt;
		delete idleState.nextGoalNudgeAt;
		return { emitted: false, reason: "idle_epoch_missing" };
	}
	// Row 68: goal fallback is DOMINATED by task activity. If any task node is already assigned or
	// in_progress, the swarm is not truly idle and the goal nudge must stay suppressed. The graph
	// stall nudge still handles actionable unassigned work — never double-fire for the same idle
	// state. The idle epoch is intentionally kept so that once the graph quiets, the goal fallback
	// still honors the continuous all-idle interval measured from the busy→idle edge.
	const intervalMs = resolveGoalNudgeIntervalMs(goal.nudgeIntervalMs);
	const activeTaskWork = await findAssignedOrInProgressTaskWork(st, p, idleState, nowMs, intervalMs);
	if (activeTaskWork) {
		await trace(p, "goal.nudge.suppressed_by_active_task", { goalId: goal.id, taskId: activeTaskWork.taskId, nodeId: activeTaskWork.nodeId, assignee: activeTaskWork.assignee, status: activeTaskWork.status, scanAt: idleState.lastGoalActiveTaskScanAt ?? null }).catch(() => {});
		return { emitted: false, reason: "active_task" };
	}
	// Row R19 (Fix A + Fix B, 2026-09-02): graph state is a HINT, not a BLOCK.
	// hasActionableGraphWork with excludeTerminalTaskOrphans=true skips terminal/abandoned tasks
	// (Fix B) so orphan rework nodes on failed/cancelled/blocked tasks cannot permanently silence
	// the goal floor. When actionable work IS found (LIVE tasks), the goal is DEFERRED by one
	// interval (not fully blocked) so the graph-stall nudge can surface first, then the goal floor
	// fires unconditionally on the next interval boundary (Fix A).
	// LIVE-task case retains the "suppressed_by_actionable_graph" trace (the plan §6.2 preserves it);
	// terminal-task case never reaches this branch thanks to Fix B.
	const graphWork = await hasActionableGraphWork(p, /*excludeTerminalTaskOrphans=*/ true);
	if (graphWork.actionable) {
		await trace(p, "goal.nudge.suppressed_by_actionable_graph", { goalId: goal.id, taskId: graphWork.taskId, nodeId: graphWork.nodeId, role: graphWork.role }).catch(() => {});
		// Fix A: defer by ONE interval (rate-only, not a full block). The defer applies AT MOST
		// ONCE per idle epoch — after one defer, the goal floor fires unconditionally on the next
		// legitimate boundary, even if the actionable graph work is still there. This guarantees
		// "floor fires within ONE interval of the all-idle edge" (plan §2.2 behavioral guarantee)
		// without the goal being able to perpetually defer on a persistently-actionable LIVE task.
		//
		// The defer must be anchored relative to the LEGITIMATE next-boundary
		// (max(allIdleSinceMs, lastEmitMs) + intervalMs), NOT raw nowMs. Anchoring to raw nowMs
		// would let the schedule_reanchored clamp (below) pull the defer DOWN to the legitimate
		// boundary when the all-idle epoch predates nowMs, defeating the defer. Anchoring to
		// max(nowMs, correctNextMs) + intervalMs gives us a future boundary that the clamp respects.
		//
		// The once-per-epoch guard lives on `idleState.actionableGraphDeferredAt` — stamped on the
		// first defer and cleared on the busy→idle edge (epoch start) via `updateIdleEpochLocked`.
		// If the defer was already applied for this epoch, fall through to the interval/back-off/emit
		// chain (no further defer — the goal floor is unconditional w.r.t. graph state).
		if (idleState.actionableGraphDeferredAt !== idleState.allIdleSinceAt) {
			const lastEmitMsForDefer = idleState.lastGoalNudgeAt ? new Date(idleState.lastGoalNudgeAt).getTime() : 0;
			const correctNextMsForDefer = Math.max(allIdleSinceMs, lastEmitMsForDefer) + intervalMs;
			const deferBase = Math.max(nowMs, correctNextMsForDefer);
			const deferredUntilMs = deferBase + intervalMs;
			idleState.nextGoalNudgeAt = new Date(deferredUntilMs).toISOString();
			idleState.actionableGraphDeferredAt = idleState.allIdleSinceAt ?? new Date(nowMs).toISOString();
			await trace(p, "goal.nudge.deferred_by_actionable_graph", { goalId: goal.id, taskId: graphWork.taskId, nodeId: graphWork.nodeId, role: graphWork.role, deferredUntil: idleState.nextGoalNudgeAt, intervalMs, deferBase: new Date(deferBase).toISOString() }).catch(() => {});
			return { emitted: false, reason: "deferred_actionable_graph" };
		}
		// Defer already applied for this epoch — fall through to the interval/back-off/emit chain.
		// The actionable graph work continues to be hinted via the suppressed_by_actionable_graph
		// trace above but no longer blocks/deferrs the floor.
	}
	// Interval gate: the goal fallback fires only after a FULL continuous all-idle interval measured
	// from the busy→all-idle edge (or from the last goal emission). Pump ticks between boundaries
	// are no-ops — no burst.
	// Self-heal (live bug, round 2+3): a nextGoalNudgeAt anchored under an OLD interval (or corrupted
	// by the round-2 min-only clamp, which pulled it into the past against a fresh lastGoalNudgeAt and
	// re-fired the nudge every tick) must converge to the legitimate boundary. Row 68 semantics: the
	// interval is measured from max(allIdleSince, lastGoalNudgeAt). Convergence rules per tick:
	//   - pinned FUTURE boundary: clamp DOWN only (min) — matches the goal-update re-anchor policy
	//     (a longer interval never fires sooner than already legitimately scheduled).
	//   - pinned PAST boundary: replace with the legitimate boundary — a past boundary older than
	//     lastEmit+interval is stale by definition (nothing legitimate schedules a nudge before
	//     lastEmit+interval). If the legitimate boundary is also past, the nudge is simply due now.
	// Cap/back-off own their schedule: while at MAX consecutive nudges or in back-off, the
	// cap/back-off branches deliberately manage nextGoalNudgeAt (nowMs + interval per slot) —
	// clamping here would fight them every tick (live: schedule_reanchored + backoff trace spam
	// each 5s pump tick, discovered 2026-08-31 03:13Z). The clamp only heals schedules that the
	// EMIT path will consume (below cap, no back-off).
	const atCap = goal.consecutiveNoResolveNudges >= MAX_CONSECUTIVE_NUDGES_DEFAULT || (goal.backoffTicksRemaining ?? 0) > 0;
	const lastEmitMs = idleState.lastGoalNudgeAt ? new Date(idleState.lastGoalNudgeAt).getTime() : 0;
	const correctNextMs = Math.max(allIdleSinceMs, lastEmitMs) + intervalMs;
	const pinnedMs = idleState.nextGoalNudgeAt ? new Date(idleState.nextGoalNudgeAt).getTime() : null;
	let clampedNextMs: number;
	if (pinnedMs === null) clampedNextMs = correctNextMs;
	else if (pinnedMs > nowMs) clampedNextMs = atCap ? pinnedMs : Math.min(pinnedMs, correctNextMs);
	else clampedNextMs = atCap ? pinnedMs : correctNextMs;
	if (pinnedMs !== null && clampedNextMs !== pinnedMs) {
		await trace(p, "goal.nudge.schedule_reanchored", { goalId: goal.id, from: idleState.nextGoalNudgeAt, to: new Date(clampedNextMs).toISOString(), intervalMs, anchor: lastEmitMs ? "last_nudge" : "idle_epoch", stale: pinnedMs <= nowMs }).catch(() => {});
		idleState.nextGoalNudgeAt = new Date(clampedNextMs).toISOString();
	}
	const nextEligibleMs = clampedNextMs;
	if (nowMs < nextEligibleMs) {
		if (!idleState.nextGoalNudgeAt) idleState.nextGoalNudgeAt = new Date(nextEligibleMs).toISOString();
		return { emitted: false, reason: "idle_interval_pending" };
	}

	// Back-off accounting is interval-based: only when the interval boundary is reached do we consume
	// one back-off slot. This keeps pump tick rate from affecting the cadence.
	if (goal.backoffTicksRemaining && goal.backoffTicksRemaining > 0) {
		goal.backoffTicksRemaining -= 1;
		idleState.nextGoalNudgeAt = new Date(nowMs + intervalMs).toISOString();
		if (goal.backoffTicksRemaining === 0) {
			await trace(p, "goal.nudge.backoff.exhausted", { goalId: goal.id, by: 1 }).catch(() => {});
			return { emitted: false, reason: "backoff_just_exhausted" };
		}
		await trace(p, "goal.nudge.backoff.skip", { goalId: goal.id, remaining: goal.backoffTicksRemaining }).catch(() => {});
		return { emitted: false, reason: "backoff" };
	}

	// Already at cap? Arm back-off on the first *interval opportunity* after max emissions. The next
	// interval window is pushed forward so the pump cannot immediately re-enter the cap branch on the
	// following 5s tick.
	if (goal.consecutiveNoResolveNudges >= MAX_CONSECUTIVE_NUDGES_DEFAULT) {
		// === R23 (2026-09-02) — post-saturation fresh-epoch re-arm (cap branch) ===
		// When the current all-idle anchor POSTDATES the last goal emission, the prior epoch's
		// nudges are already invalidated at surface time (`idle_epoch_advanced`, R21) and no
		// orchestrator turn_end resolve could fire while the floor was starved (the cap loop
		// emits nothing, so there was no turn to resolve) — the "unresolved" count is stale
		// saturation carried across an epoch boundary (live 2026-09-02T14:44:37..14:45:17Z,
		// goal goal-1788350610025-7efafe: backoff.skip → backoff_just_exhausted → max_nudges
		// re-arm loop, ZERO goal.idle_nudge / C3 sends). Reset ONCE per anchor and fall through
		// so the fresh nudge emits on this same eligible tick. Within ONE uninterrupted
		// no-resolve epoch the anchor predates every emission, so this never fires and
		// MAX + backoff stay fully enforced (no goal-nudge storm).
		//
		// === R23B (2026-09-02) — worker-breaker guard ===
		// The reset is ONLY applied when the most recent anchor-clearing busy edge was
		// caused by a WORKER (any busy agent id !== "orchestrator"). This stops orchestrator-
		// turn churn (the worker briefly flipping busy between turns, then back to idle)
		// from minting a fresh anchor that defeats MAX+backoff. Live storm:
		// 2026-09-02T15:19:06..15:21:46Z — reset ×12, seq 4→38. With this guard, only the
		// first edge (worker-a taking the R23 incident's task) qualifies; later
		// orchestrator-churn edges are rejected and the cap+backoff loop re-engages.
		const anchorR23 = idleState.allIdleSinceAt ?? null;
		const memoR23 = idleState;
		const lastEmitR23 = idleState.lastGoalNudgeAt ? Date.parse(idleState.lastGoalNudgeAt) : (goal.lastNudgeAt ? Date.parse(goal.lastNudgeAt) : NaN);
		const anchorIsFreshR23 = Boolean(anchorR23 && Number.isFinite(lastEmitR23) && Date.parse(anchorR23) > lastEmitR23);
		// === R23B-rework (2026-09-03) — STALE-MEMO CLEAR (production-mint shape) ===
		// The original R23 code stamped `r23LastEpochAnchor = allIdleSinceAt` at mint,
		// leaving production states where the memo equals the anchor. After the R23B
		// mint-branch delete, NEW mints leave the memo cleared — but legacy state files
		// (or any non-edge anchor transition that re-stamps both atomically) still hold
		// `memo === anchor`. The cap branch must NOT be fooled: if anchorIsFreshR23 is
		// true AND the memo equals the anchor (the stale-shape), the memo is from a prior
		// reset attempt OR from a legacy state — in either case it does not represent
		// "this session's cap branch has already reset for this anchor". Clear it once
		// here so `notYetAppliedR23` becomes true and the reset fires (subject to the
		// worker-breaker guard below). Crucially, this only fires when anchorIsFreshR23
		// is true; within the same anchor after a reset, the most-recent emit lands
		// AFTER the anchor, so anchorIsFreshR23 becomes false and the clear is a no-op
		// on subsequent ticks — storm guard preserved.
		if (anchorIsFreshR23 && memoR23.r23LastEpochAnchor === anchorR23) {
			delete (memoR23 as { r23LastEpochAnchor?: string }).r23LastEpochAnchor;
		}
		const notYetAppliedR23 = Boolean(anchorR23 && memoR23.r23LastEpochAnchor !== anchorR23);
		// lastEpochBusyAgents is stamped by updateIdleEpochLocked on the busy edge (the
		// ONLY edge that clears the anchor). Absent (== legacy state, never seen a busy
		// edge) → the R23 incident default is to RESET, matching pre-R23B behavior for
		// uninterrupted no-resolve epochs that crossed a worker break. Present and
		// contains ONLY orchestrator ids → REJECT (storm guard). Present and contains a
		// non-orchestrator id → worker-driven break, RESET.
		const breakerAgents = idleState.lastEpochBusyAgents;
		const workerCaused = !breakerAgents || breakerAgents.some((id) => id !== "orchestrator");
		if (anchorIsFreshR23 && notYetAppliedR23 && workerCaused) {
			await trace(p, "goal.nudge.saturation_reset_on_epoch", {
				goalId: goal.id,
				consecutiveNoResolveNudges: goal.consecutiveNoResolveNudges,
				backoffTicksRemaining: goal.backoffTicksRemaining ?? null,
				newEpochAnchor: anchorR23,
				lastEmitAt: idleState.lastGoalNudgeAt ?? goal.lastNudgeAt ?? null,
				lastEpochBusyAgents: breakerAgents ?? null,
				by: "R23B",
				site: "cap_branch",
			}).catch(() => {});
			goal.consecutiveNoResolveNudges = 0;
			delete goal.backoffTicksRemaining;
			goal.lastResolvedAt = new Date(nowMs).toISOString();
			goal.lastResolveActionAt = goal.lastResolvedAt;
			goal.lastResolveActionTools = ["epoch_advance_saturation_reset"];
			idleState.goalConsecutiveNoResolveNudges = 0;
			delete idleState.goalBackoffTicksRemaining;
			memoR23.r23LastEpochAnchor = anchorR23;
			// fall through: counter is now 0 < MAX, the emit chain below runs on this tick.
		} else {
			if (!goal.backoffTicksRemaining) {
				goal.backoffTicksRemaining = GOAL_NUDGE_BACKOFF_TICKS;
				idleState.nextGoalNudgeAt = new Date(nowMs + intervalMs).toISOString();
				await trace(p, "goal.nudge.backoff", { goalId: goal.id, nudges: goal.consecutiveNoResolveNudges, max: MAX_CONSECUTIVE_NUDGES_DEFAULT, backoffTicks: GOAL_NUDGE_BACKOFF_TICKS }).catch(() => {});
			}
			return { emitted: false, reason: "max_nudges" };
		}
	}

	// Idempotency: one nudge per (goal, nudge-sequence) emission. The notify key uses goalId plus a
	// MONOTONIC nudgeSeq that never resets (survives resolve / counter reset). A static per-goal key
	// would allow exactly ONE nudge per goal for its entire lifetime: after the first emit the
	// message record lingers in state and every later tick returns duplicate_suppressed forever —
	// the production bug where a set goal never re-nudged after its first reminder (max-3 + back-off
	// machinery never engaged). With seq, the idempotency check still blocks double-emits within the
	// same tick / streak (seq only advances on a successful emit), while a fresh nudge gets a fresh slot.
	const nudgeSeq = (goal.nudgeSeq ?? 0) + 1;
	const key = formatNotifyKey(NOTIFY_KEY_GOAL_IDLE_NUDGE, { goalId: goal.id, seq: String(nudgeSeq) });
	if (findIdempotentMessage(st, "orchestrator", "orchestrator", key)) {
		return { emitted: false, reason: "duplicate_suppressed" };
	}

	// Emit the nudge via the standard mailbox path. deliverMessageLocked mutates st (upserts the
	// message record, appends to mailbox JSONL, returns { msg, delivery }). The orchestrator's own
	// pump on the NEXT tick surfaces it to the TUI via the existing customType:"swarm-message" path.
	const sinceSetMs = nowMs - new Date(goal.setAt).getTime();
	const subjectText = goal.text.slice(0, 60);
	const bodyText = goal.text.slice(0, 240);
	const sinceSec = Math.max(0, Math.round(sinceSetMs / 1000));
	const idleCount = idleAgents.length;
	const nudgeNumber = goal.consecutiveNoResolveNudges + 1;
	const subject = `Idle streak: goal "${subjectText}" has no active work`;
	const body =
		`Goal ${goal.id} was set ${sinceSec}s ago: "${bodyText}".\n\n` +
		`All ${idleCount} non-orchestrator agent(s) are runtimeStatus=idle and no task nodes are assigned/in_progress.\n\n` +
		`This is nudge ${nudgeNumber} of ${MAX_CONSECUTIVE_NUDGES_DEFAULT} before back-off.\n\n` +
		`Action: either spawn / assign work to advance the goal, or mark it done:\n` +
		`  swarm_mark_goal_done(goalId="${goal.id}")\n\n` +
		`(Any reply you produce — including a plain /swarm status, a tool call, or an explanation — is treated as a "resolve": the consecutive counter resets and the back-off clears. Only a silent ignore keeps the counter climbing.)`;
	await deliverMessageLocked(pi, cwd, p, st, {
		to: "orchestrator",
		subject,
		body,
		requiresAck: true,
		idempotencyKey: key,
		priority: "normal",
	});

	goal.consecutiveNoResolveNudges += 1;
	goal.nudgeSeq = nudgeSeq;
	goal.lastNudgeAt = new Date(nowMs).toISOString();
	idleState.lastGoalNudgeAt = goal.lastNudgeAt;
	idleState.nextGoalNudgeAt = new Date(nowMs + intervalMs).toISOString();
	idleState.goalConsecutiveNoResolveNudges = goal.consecutiveNoResolveNudges;
	idleState.goalBackoffTicksRemaining = goal.backoffTicksRemaining;
	await trace(p, "goal.idle_nudge", {
		goalId: goal.id,
		text: bodyText,
		setAt: goal.setAt,
		consecutiveCount: goal.consecutiveNoResolveNudges,
		max: MAX_CONSECUTIVE_NUDGES_DEFAULT,
		sinceSetMs,
		idleAgents: idleCount,
		customType: "goal.idle_nudge",
		key,
		allIdleSinceAt: idleState.allIdleSinceAt,
		nextGoalNudgeAt: idleState.nextGoalNudgeAt,
	});
	return { emitted: true, reason: "emitted" };
}

// === Issue 23: task-graph-state idle nudge (no-goal variant) ===
// Mirror of `evaluateIdleGoalNudgeLocked` (Issue 18) keyed on task-graph state instead of a goal.
// Fires when ALL hold:
//   (1) At least one `in_progress` task exists in `p.tasksDir`.
//   (2) At least one of its nodes has `status === "ready"` AND `assignee === undefined` (the same
//       actionable set as `reconcileGraphAdvanceLocked`).
//   (3) Every non-orchestrator agent is `runtimeStatus === "idle"`.
//   (4) The task has existed for at least TASK_INITIAL_READY_GRACE_MS (60s).
//   (5) NOT firing the existing `reconcileGraphAdvanceLocked` nudge for the same node already (any
//       unacked record in the seq-suffixed NOTIFY_KEY_GRAPH_ADVANCE set for that (taskId, nodeId))
//       so two concurrent nudges don't compete.
//
// Back-off + max-nudge cap mirror the goal-nudge machinery but are per-task (not global). Both
// nudges coexist; a goal set + a stalled task emits BOTH (different dedupe keys). Independent
// counters reset on different triggers: goal resolves on turn_end; task-stall resolves on graph-
// mutation events (assign / claim / terminal-transition).
//
// MUST be called under the same `withLock(p)` the pump already holds; never acquire the lock
// inside this function. Exported for direct unit testing by task-liveness.test.mjs.
