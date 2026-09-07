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

// === R27 (2026-09-04): task-independent goal floor — check-streak debounce resolvers ===
// The goal nudge no longer consults task state OR a single interval-anchor. Instead the pump
// samples the all-idle predicate once per GOAL_IDLE_CHECK_INTERVAL_MS; after
// GOAL_IDLE_CHECKS_REQUIRED consecutive true samples it emits. Defaults: 10s x 3
// (user direction 2026-09-04: "cách 10s lại check, check 3 lần, sau 3 lần mà thấy trạng thái
// vẫn là ko có swarm agents nào làm việc thì mới nudge"). Both knobs are env-tunable so
// tests can compress the debounce into milliseconds.
export function resolveGoalIdleCheckIntervalMs(): number {
	const raw = process.env.PI_SWARM_GOAL_IDLE_CHECK_INTERVAL_MS;
	if (raw !== undefined && String(raw).trim() !== "") {
		const env = Number(raw);
		if (Number.isFinite(env) && env > 0) return Math.floor(env);
	}
	return 10_000;
}

export function resolveGoalIdleChecksRequired(): number {
	const raw = process.env.PI_SWARM_GOAL_IDLE_CHECKS_REQUIRED;
	if (raw !== undefined && String(raw).trim() !== "") {
		const env = Number(raw);
		if (Number.isFinite(env) && env > 0) return Math.floor(env);
	}
	return 3;
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
	const idleAgents = Object.values(st.agents).filter((a) => a.id !== "root" && agentIsEffectivelyAlive(a, nowMs));
	// Issue 85 (task-202608310905, bug #3): when zero effective non-root agents remain (post-prune,
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

// R27 (2026-09-04): the task-dir active-work scan (scanTaskDirsForActiveWork +
// findAssignedOrInProgressTaskWork) was REMOVED — the goal floor no longer consults task
// state. The only "is the swarm running" signals are the agent records themselves
// (runtimeStatus + activeTaskIds pointers). See evaluateIdleGoalNudgeLocked.

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
			// The cap-branch reset is gated on `lastEpochBusyAgents?.some(id => id !== "root")`
			// so the breaker can tell a worker-driven fresh epoch (qualifies) from root-turn
			// churn that briefly flipped a worker busy/idle (does NOT qualify). `busyAgents` is the
			// same array already passed to the `idle.epoch.reset` trace below; persisting it lets the
			// next fresh-epoch evaluator distinguish worker-busy breaks from root-driven
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
		// === R27 (2026-09-04): busy edge resets the idle-check streak ===
		// Any busy/vacuous/in-flight sample must restart the N-consecutive-check debounce
		// from zero ("một nhịp busy giữa chừng → reset về 0, đếm lại từ đầu"). The check
		// timestamp is kept — the NEXT idle sample still respects the check-interval spacing.
		delete idleState.goalIdleCheckCount;
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
		// real sessions where `agent_settled` re-stamps the anchor at every root
		// turn boundary. Live: implementer lane 2026-09-02T15:19:06..15:21:46Z —
		// `goal.nudge.saturation_reset_on_epoch` ×12, `goal.idle_nudge` seq 4→38,
		// `mailbox.root_pump_stuck_escalated` ×34. The cap branch (memo-checked)
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
		//   - `hooks.ts` turn_start → now stamps `["root"]` → root-turn churn
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
		// reset; root-turn churn anchors are also rejected by the worker-breaker
		// guard above. Probe evidence: tester-memo-probe.{mjs,out.txt}.
		delete (idleState as { r23LastEpochAnchor?: string }).r23LastEpochAnchor;
		await trace(p, "idle.epoch.started", { allIdleSinceAt: idleState.allIdleSinceAt, idleAgents: idleAgents.length }).catch(() =>{});
	}
	return { allIdle, idleAgents, vacuous };
}

// R27 (2026-09-04): hasActionableGraphWork (the R19 one-interval goal defer) was REMOVED —
// the goal floor is task-state-independent. The graph-stall nudge family in graph-advance.ts
// still owns actionable-graph surfacing; the goal floor no longer defers to it.

// === Issue 18: Swarm goal + idle-streak nudge ===
// When the root has set a goal AND every effective (non-root, alive) agent is
// runtimeStatus="idle" with no activeTaskIds pointer, the pump samples this predicate
// once per check-interval; after CONSECUTIVE idle checks (R27 default 3) it emits an
// idempotent structured nudge to the root's own mailbox. R27 (2026-09-04, user direction):
// the goal floor is TASK-STATE-INDEPENDENT — no assigned/in_progress node scan and no
// actionable-graph defer may silence it. A task.json may legitimately carry open
// assigned nodes while every agent idles (a worker settled on an open node): that is
// exactly the "swarm is doing nothing" state the user wants surfaced. The ONLY agent-state
// gates are (a) vacuous pool (zero effective workers — held with no_live_workers + the
// bounded pool-empty escalation), (b) an idle agent still carrying an activeTaskIds
// pointer (assignment_in_flight — the post-assign pre-pickup window counts as "running"),
// and (c) any busy effective agent (agent_busy).
// Debounce: `idleState.goalIdleCheckCount` accumulates one per consecutive idle sample
// spaced at least GOAL_IDLE_CHECK_INTERVAL_MS apart (pump ticks closer than that advance
// nothing). Any busy/vacuous/in-flight sample resets the streak to 0. An emission also
// resets the streak, so the next nudge needs a fresh full streak — consecutive nudges are
// spaced >= N x CHECK_INTERVAL_MS. Anti-loop: the consecutiveNoResolveNudges counter still
// resets on any root turn that ends stopReason="stop" WITH a swarm resolve action (hooks.ts
// turn_end branch, R16). Once the counter reaches MAX_CONSECUTIVE_NUDGES_DEFAULT, the pump
// enters a GOAL_NUDGE_BACKOFF_TICKS-round back-off; each COMPLETED check-round consumes one
// back-off slot.
// MUST be called under the same withLock(p) the pump already holds; never acquire the lock
// inside this function.
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
	// with distinct reasons + traces so the root sees WHY the nudge was held.
	const idleState: SwarmIdleNudgeState = st.idleNudgeState ||= {};
	const epoch = await updateIdleEpochLocked(p, st, nowMs);
	const { idleAgents, allIdle, vacuous } = epoch;
	if (vacuous) {
		// Bug #3 evidence: hold the goal nudge when zero effective non-root agents remain.
		// R14 Fix B (2026-09-02): trace fires only on the `idleAgents.length > 0` → `0`
		// transition (the once-per-transition promise in the comment above was never
		// enforced — the code fired every tick of vacuous state, producing 7_278 spam
		// traces for goal-1788266039522-6eae40 over ~16h). The transition flag lives on
		// `idleNudgeState.lastWasVacuous` so it persists across the swarm→root
		// restarts. Cleared in updateIdleEpochLocked's not-all-idle branch (the
		// pool-recovered edge).
		//
		// R16 Fix B (2026-09-02): decouple the dedupe flag's persistence from the pump tail
		// writeState (reconcile.ts:1929). Even after the root /reload's, the
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
		// R14 Fix C (2026-09-02): bounded, durable, high-priority root recovery
		// nudge for an active USER-ORIGIN goal whose pool is genuinely vacuous. Cooldown-
		// bounded by NOTIFY_DEFAULT_COOLDOWN_MS (5min). Stops emitting when the goal
		// clears/cancels (consult `st.goal` at the top of the evaluator; the no_goal
		// guard short-circuits before this branch). Bypasses idle gates via the R13 P0
		// high-priority surface — the root's tmuxTarget is `unknown` so the
		// message is durably enqueued in the mailbox and the pump surfaces it once the
		// root is idle (R13 P0 path; unchanged).
		if (goal.origin === "user" || goal.origin === "system" || goal.origin === "batch") {
			const cooldownUntilMs = idleStateVac.lastPoolEmptyEscalationAt
				? new Date(idleStateVac.lastPoolEmptyEscalationAt).getTime() + NOTIFY_DEFAULT_COOLDOWN_MS
				: 0;
			if (nowMs >= cooldownUntilMs) {
				const poolDiag = Object.values(st.agents)
					.filter((a) => a.id !== "root")
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
				// per the root's note: "Nudges must be action-oriented per user direction:
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
					to: "root",
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
		// root /reload right after the pump). The pump tail writeState at
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
	// === R27 (2026-09-04): N-consecutive-idle-check debounce ===
	// Replaces the Row 68 interval-anchor gate (max(allIdleSince, lastEmit) + interval) and
	// REMOVES both task-state gates (findAssignedOrInProgressTaskWork active_task scan +
	// hasActionableGraphWork defer). The goal floor is now task-state-independent per user
	// direction: "always nudge when no swarm agent is running, regardless of task state".
	// The only timing machinery is the check streak: one sample per CHECK_INTERVAL_MS with
	// the predicate true; a busy/vacuous/in-flight sample resets it (updateIdleEpochLocked's
	// busy edge clears goalIdleCheckCount — see the reset site below). Pump ticks closer than
	// CHECK_INTERVAL_MS do not advance the streak (rate-safety preserved: a 5s pump on a
	// 10s check-interval cannot compress the debounce).
	const checkIntervalMs = resolveGoalIdleCheckIntervalMs();
	const checksRequired = resolveGoalIdleChecksRequired();
	const lastCheckMs = idleState.goalIdleLastCheckAt ? new Date(idleState.goalIdleLastCheckAt).getTime() : 0;
	const isFreshSample = nowMs - lastCheckMs >= checkIntervalMs;
	if (!isFreshSample) {
		return { emitted: false, reason: "idle_interval_pending" };
	}
	idleState.goalIdleLastCheckAt = new Date(nowMs).toISOString();
	idleState.goalIdleCheckCount = (idleState.goalIdleCheckCount ?? 0) + 1;
	await trace(p, "goal.idle_check", {
		goalId: goal.id,
		count: idleState.goalIdleCheckCount,
		required: checksRequired,
		checkIntervalMs,
	}).catch(() => {});
	if (idleState.goalIdleCheckCount < checksRequired) {
		return { emitted: false, reason: "idle_interval_pending" };
	}
	// The streak is complete — consume it. Whether or not this tick emits (back-off / cap
	// below may still hold it), a fresh full streak is required before the next nudge, so
	// consecutive nudges are spaced >= checksRequired x checkIntervalMs.
	idleState.goalIdleCheckCount = 0;


	// Back-off accounting is round-based: each COMPLETED check-round consumes one back-off
	// slot. This keeps pump tick rate from affecting the cadence (R27: rounds, not intervals).
	if (goal.backoffTicksRemaining && goal.backoffTicksRemaining > 0) {
		goal.backoffTicksRemaining -= 1;
		idleState.goalBackoffTicksRemaining = goal.backoffTicksRemaining;
		if (goal.backoffTicksRemaining === 0) {
			await trace(p, "goal.nudge.backoff.exhausted", { goalId: goal.id, by: 1 }).catch(() => {});
			return { emitted: false, reason: "backoff_just_exhausted" };
		}
		await trace(p, "goal.nudge.backoff.skip", { goalId: goal.id, remaining: goal.backoffTicksRemaining }).catch(() => {});
		return { emitted: false, reason: "backoff" };
	}

	// Already at cap? Arm back-off on the first *check-round opportunity* after max emissions.
	if (goal.consecutiveNoResolveNudges >= MAX_CONSECUTIVE_NUDGES_DEFAULT) {
		// === R23 (2026-09-02) — post-saturation fresh-epoch re-arm (cap branch) ===
		// When the current all-idle anchor POSTDATES the last goal emission, the prior epoch's
		// nudges are already invalidated at surface time (`idle_epoch_advanced`, R21) and no
		// root turn_end resolve could fire while the floor was starved (the cap loop
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
		// caused by a WORKER (any busy agent id !== "root"). This stops root-
		// turn churn (the worker briefly flipping busy between turns, then back to idle)
		// from minting a fresh anchor that defeats MAX+backoff. Live storm:
		// 2026-09-02T15:19:06..15:21:46Z — reset ×12, seq 4→38. With this guard, only the
		// first edge (worker-a taking the R23 incident's task) qualifies; later
		// root-churn edges are rejected and the cap+backoff loop re-engages.
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
		// contains ONLY root ids → REJECT (storm guard). Present and contains a
		// non-root id → worker-driven break, RESET.
		const breakerAgents = idleState.lastEpochBusyAgents;
		const workerCaused = !breakerAgents || breakerAgents.some((id) => id !== "root");
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
				idleState.goalBackoffTicksRemaining = GOAL_NUDGE_BACKOFF_TICKS;
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
	if (findIdempotentMessage(st, "root", "root", key)) {
		return { emitted: false, reason: "duplicate_suppressed" };
	}

	// Emit the nudge via the standard mailbox path. deliverMessageLocked mutates st (upserts the
	// message record, appends to mailbox JSONL, returns { msg, delivery }). The root's own
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
		`All ${idleCount} non-root agent(s) have been idle for ${checksRequired} consecutive checks (${Math.round(checkIntervalMs / 1000)}s apart), independent of task state.\n\n` +
		`This is nudge ${nudgeNumber} of ${MAX_CONSECUTIVE_NUDGES_DEFAULT} before back-off.\n\n` +
		`Action: either spawn / assign work to advance the goal, or mark it done:\n` +
		`  swarm_mark_goal_done(goalId="${goal.id}")\n\n` +
		`(Any reply you produce — including a plain /swarm status, a tool call, or an explanation — is treated as a "resolve": the consecutive counter resets and the back-off clears. Only a silent ignore keeps the counter climbing.)`;
	await deliverMessageLocked(pi, cwd, p, st, {
		to: "root",
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
		checkIntervalMs,
		checksRequired,
	});
	return { emitted: true, reason: "emitted" };
}

// === Issue 23: task-graph-state idle nudge (no-goal variant) ===
// Mirror of `evaluateIdleGoalNudgeLocked` (Issue 18) keyed on task-graph state instead of a goal.
// Fires when ALL hold:
//   (1) At least one `in_progress` task exists in `p.tasksDir`.
//   (2) At least one of its nodes has `status === "ready"` AND `assignee === undefined` (the same
//       actionable set as `reconcileGraphAdvanceLocked`).
//   (3) Every non-root agent is `runtimeStatus === "idle"`.
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
