// === swarm/goals.ts — Issue 81: goal-clear authority guard ===
// Pure predicate: classify whether a goal clear / replace is allowed given the current goal's
// origin and the caller's params. NO I/O — no `withLock`, no `readState`, no `writeState`,
// no trace emission. The caller (tools/agents.ts: swarm_set_goal, swarm_mark_goal_done;
// command.ts: /swarm goal done|set|update) is responsible for emitting the
// `goal.clear_refused` trace and translating the refusal into the tool/command refusal result.
//
// Pre-policy default is LENIENT: a goal with no `origin` field (legacy swarms from before this
// change) is treated as origin="orchestrator" for the guard. This keeps existing swarms working
// and makes the guard tight only on NEW user-origin goals going forward. New `swarm_set_goal`
// calls stamp `origin` explicitly via the new optional `origin` parameter (default "orchestrator").

export type GoalOrigin = "user" | "orchestrator" | "system" | "batch";

export const GOAL_ORIGIN_USER: GoalOrigin = "user";
export const GOAL_ORIGIN_ORCHESTRATOR: GoalOrigin = "orchestrator";
export const GOAL_ORIGIN_SYSTEM: GoalOrigin = "system";
export const GOAL_ORIGIN_BATCH: GoalOrigin = "batch";

// Allowed origin values for the `origin` parameter on swarm_set_goal and --origin flag on /swarm
// goal set. Kept as a Set so callers can validate against a single source of truth.
export const GOAL_ORIGIN_VALUES: ReadonlySet<GoalOrigin> = new Set([
	GOAL_ORIGIN_USER,
	GOAL_ORIGIN_ORCHESTRATOR,
	GOAL_ORIGIN_SYSTEM,
	GOAL_ORIGIN_BATCH,
]);

// Reason codes for a refused clear / replace. Stable strings (used in `goal.clear_refused` trace
// payloads and tool refusal results). NEVER interpolated; safe to grep on.
export type RefuseClearReason =
	| "user_origin_active"             // swarm_mark_goal_done on a user-origin goal without approvedByUser
	| "user_origin_replace_blocked";   // swarm_set_goal (replace) on a user-origin active goal

export type ClassifyGoalClearInput = {
	currentGoal: Pick<{ id: string; origin?: GoalOrigin }, "id" | "origin"> | null | undefined;
	action: "clear" | "replace";
	actor: string;                 // agentId of the caller (orchestrator in practice)
	params: {
		approvedByUser?: boolean;  // explicit user-approval signal on clear
		origin?: GoalOrigin;       // NEW origin being set on replace (informational only — the replace is what triggers the guard, not the new origin value)
	};
};

export type ClassifyGoalClearResult =
	| { allowed: true; origin?: GoalOrigin }
	| { allowed: false; reason: RefuseClearReason; origin?: GoalOrigin };

export function classifyGoalClearAuthority(input: ClassifyGoalClearInput): ClassifyGoalClearResult {
	const origin: GoalOrigin = input.currentGoal?.origin ?? GOAL_ORIGIN_ORCHESTRATOR;
	// Non-user-origin goals are freely clearable / replaceable by the orchestrator.
	if (origin !== GOAL_ORIGIN_USER) return { allowed: true, origin };
	// User-origin clear with explicit approval: bypass.
	if (input.action === "clear" && input.params.approvedByUser === true) return { allowed: true, origin };
	// User-origin clear without approval: refuse.
	if (input.action === "clear") return { allowed: false, reason: "user_origin_active", origin };
	// User-origin replace (regardless of the new origin value): refuse. The replace is what
	// fires the guard — the user-origin goal is being implicitly retired by a new goal text.
	// The caller must explicitly clear first (with approvedByUser: true), then set the new goal.
	return { allowed: false, reason: "user_origin_replace_blocked", origin };
}
