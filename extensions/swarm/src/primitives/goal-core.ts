// === swarm/primitives/goal-core.ts — lock-free goal mutation cores (Phase 3a) ===
// Moved VERBATIM from the withLock bodies of src/tools/goals.ts (swarm_set_goal /
// swarm_mark_goal_done) so the future issue controller can invoke the same mutation
// logic inside its own held lock. Contract (plan artifacts/plan.md §3):
//   - a core ASSUMES the caller holds the swarm lock and NEVER calls withLock;
//   - no authority gates, no wrapSwarmToolInvocation, no ensureDirs, no Pi calls;
//   - wrappers keep their own authority/lock/trace/result-shaping behavior.
// Trace events remain in the cores (durable business events, identical pre/post).

import type { SwarmState } from "../types/state.ts";
import { randomUUID } from "node:crypto";
import { readState, trace, writeState, type Paths } from "../state.ts";
import { classifyGoalClearAuthority, GOAL_ORIGIN_ROOT, GOAL_ORIGIN_VALUES, type GoalOrigin } from "../goals.ts";
import { now, safeId } from "../utils.ts";
import { resolveGoalNudgeIntervalMs } from "../reconcile.ts";

export interface GoalCoreDeps {
	readState: typeof readState;
	writeState: typeof writeState;
	trace: typeof trace;
	/** actor id (root at both real call sites today) */
	actor: string;
	/** trace provenance: "tool" | "command" (event `via` field) */
	via: "tool" | "command";
	/** command set uses a caller-provided goalId scheme; default matches the tool */
	newGoalId?: () => string;
}

export type SetGoalInput = {
	id?: string;
	text?: string;
	update?: boolean;
	intervalMs?: number;
	maxNudges?: number;
	origin?: string;
	setByScope?: string;
};

/** Move-only body of swarm_set_goal's withLock callback (tools/goals.ts:69). */
export async function setGoalCore(p: Paths, cwd: string, params: SetGoalInput, deps: GoalCoreDeps) {
	const st = await deps.readState(p, cwd);
	const previousId = st.goal?.id;
	const ts = now();
	const isUpdate = Boolean(params.update);
	const text = String(params.text || "").trim();
	const requestedId = params.id ? safeId(String(params.id)) : (deps.newGoalId?.() ?? `goal-${Date.now()}-${randomUUID().slice(0, 6)}`);
	const hasInterval = params.intervalMs !== undefined;
	const requestedInterval = Number(params.intervalMs);
	if (!isUpdate && !text) throw new Error("swarm_set_goal: text must be non-empty");
	if (hasInterval && (!Number.isFinite(requestedInterval) || requestedInterval <= 0 || !Number.isInteger(requestedInterval))) {
		throw new Error(`swarm_set_goal: invalid intervalMs ${params.intervalMs}`);
	}
	const nudgeIntervalMs = hasInterval ? Math.floor(requestedInterval) : undefined;
	const defaultIntervalMs = resolveGoalNudgeIntervalMs();
	const hasMaxNudges = params.maxNudges !== undefined;
	const requestedMaxNudges = Number(params.maxNudges);
	if (
		hasMaxNudges &&
		(!Number.isInteger(requestedMaxNudges) || (requestedMaxNudges <= 0 && requestedMaxNudges !== -1))
	) {
		throw new Error(`swarm_set_goal: invalid maxNudges ${params.maxNudges} (must be -1 for infinite or positive integer)`);
	}
	const maxNudges = hasMaxNudges ? requestedMaxNudges : undefined;
	const requestedOrigin = params.origin;
	if (requestedOrigin !== undefined && !GOAL_ORIGIN_VALUES.has(requestedOrigin as any)) {
		throw new Error(`swarm_set_goal: invalid origin ${params.origin} (must be one of: ${[...GOAL_ORIGIN_VALUES].join(", ")})`);
	}
	const newOrigin = (requestedOrigin ?? GOAL_ORIGIN_ROOT) as GoalOrigin;
	const requestedSetByScope = params.setByScope ? String(params.setByScope) : undefined;
	if (isUpdate) {
		if (!st.goal) return { updated: false, noop: true };
		if (text) st.goal.text = text;
		if (nudgeIntervalMs !== undefined && st.goal.nudgeIntervalMs !== nudgeIntervalMs) {
			st.goal.nudgeIntervalMs = nudgeIntervalMs;
			const idle = (st.idleNudgeState ||= {});
			const anchor = idle.allIdleSinceAt ? new Date(idle.allIdleSinceAt).getTime() : Date.now();
			const fresh = anchor + nudgeIntervalMs;
			idle.nextGoalNudgeAt = idle.nextGoalNudgeAt
				? new Date(Math.min(new Date(idle.nextGoalNudgeAt).getTime(), fresh)).toISOString()
				: new Date(fresh).toISOString();
		}
		if (maxNudges !== undefined && st.goal.maxNudges !== maxNudges) {
			st.goal.maxNudges = maxNudges;
			if (maxNudges === -1 || maxNudges > st.goal.consecutiveNoResolveNudges) {
				delete st.goal.backoffTicksRemaining;
				delete st.idleNudgeState?.goalBackoffTicksRemaining;
			}
		}
		if (requestedOrigin !== undefined) st.goal.origin = newOrigin;
		if (requestedSetByScope !== undefined) st.goal.setByScope = requestedSetByScope;
		await deps.trace(p, "goal.updated", {
			goalId: st.goal.id,
			previousId,
			via: deps.via,
			updatedText: Boolean(text),
			updatedInterval: nudgeIntervalMs !== undefined,
			updatedMaxNudges: maxNudges !== undefined,
			maxNudges: st.goal.maxNudges,
			origin: st.goal.origin,
			setByScope: st.goal.setByScope,
		});
		await deps.writeState(p, st);
		return { updated: true, goalId: st.goal.id, previousId, goal: st.goal };
	}
	// Issue 81: REPLACE path on an existing user-origin goal must REFUSE unless the caller
	// has explicit approval.
	if (previousId) {
		const guard = classifyGoalClearAuthority({
			currentGoal: st.goal,
			action: "replace",
			actor: deps.actor,
			params: { origin: newOrigin },
		});
		if (!guard.allowed) {
			await deps.trace(p, "goal.clear_refused", {
				goalId: previousId,
				origin: guard.origin,
				reason: guard.reason,
				actor: deps.actor,
				action: "replace",
				via: deps.via,
			});
			return { refused: true, reason: guard.reason, origin: guard.origin, goalId: previousId };
		}
	}
	const goalId = requestedId;
	const inheritSeq = previousId === requestedId ? (st.goal?.nudgeSeq ?? 0) : 0;
	const inheritedIntervalMs = nudgeIntervalMs === undefined ? st.goal?.nudgeIntervalMs : undefined;
	const resolvedIntervalMs = nudgeIntervalMs ?? inheritedIntervalMs ?? defaultIntervalMs;
	const inheritedMaxNudges = maxNudges === undefined ? st.goal?.maxNudges : undefined;
	const resolvedMaxNudges = maxNudges ?? inheritedMaxNudges;
	st.goal = {
		id: goalId,
		text,
		setAt: ts,
		setBy: deps.actor,
		origin: newOrigin,
		setByScope: requestedSetByScope,
		consecutiveNoResolveNudges: 0,
		nudgeSeq: inheritSeq,
		nudgeIntervalMs: resolvedIntervalMs,
		maxNudges: resolvedMaxNudges,
	};
	delete st.goal.lastNudgeAt;
	delete st.goal.lastResolvedAt;
	delete st.goal.backoffTicksRemaining;
	await deps.trace(p, "goal.set", {
		goalId,
		previousId,
		setBy: deps.actor,
		length: text.length,
		via: deps.via,
		nudgeIntervalMs: st.goal.nudgeIntervalMs,
		maxNudges: st.goal.maxNudges,
		inheritedIntervalMs: inheritedIntervalMs ?? null,
		inheritedMaxNudges: inheritedMaxNudges ?? null,
		origin: newOrigin,
		setByScope: requestedSetByScope,
	});
	await deps.writeState(p, st);
	return { updated: false, goalId, previousId, goal: st.goal };
}

export type MarkGoalDoneInput = { goalId?: string; approvedByUser?: boolean };

/** Move-only body of swarm_mark_goal_done's withLock callback (tools/goals.ts:255). */
export async function markGoalDoneCore(p: Paths, cwd: string, params: MarkGoalDoneInput, deps: GoalCoreDeps) {
	const st = await deps.readState(p, cwd);
	if (!st.goal) return { cleared: true, noop: true };
	if (params.goalId && safeId(params.goalId) !== st.goal.id) {
		throw new Error(`swarm_mark_goal_done: goalId ${params.goalId} does not match current goal ${st.goal.id}`);
	}
	// Issue 81: classify clear authority against the current goal's origin.
	const guard = classifyGoalClearAuthority({
		currentGoal: st.goal,
		action: "clear",
		actor: deps.actor,
		params: { approvedByUser: Boolean(params.approvedByUser) },
	});
	if (!guard.allowed) {
		await deps.trace(p, "goal.clear_refused", {
			goalId: st.goal.id,
			origin: guard.origin,
			reason: guard.reason,
			actor: deps.actor,
			action: "clear",
			via: deps.via,
			approvedByUser: Boolean(params.approvedByUser),
		});
		return { cleared: false, refused: true, reason: guard.reason, origin: guard.origin, goalId: st.goal.id };
	}
	const clearedId = st.goal.id;
	const nudges = st.goal.consecutiveNoResolveNudges;
	const clearedOrigin = guard.origin;
	delete st.goal;
	await deps.trace(p, "goal.cleared", {
		goalId: clearedId,
		nudges,
		by: deps.actor,
		via: deps.via,
		origin: clearedOrigin,
	});
	await deps.writeState(p, st);
	return { cleared: true, clearedId, nudges };
}
