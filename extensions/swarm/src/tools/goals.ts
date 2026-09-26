// === swarm/tools/goals.ts — swarm_set_goal + swarm_mark_goal_done (real bodies) ===
// Extracted verbatim from the src/tools/agents.ts monolith (Phase 5/6 real split).

import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { currentAgentId } from "../session.ts";
import { paths, readState, trace, withLock, writeState } from "../state.ts";
import { classifyGoalClearAuthority, GOAL_ORIGIN_ROOT, GOAL_ORIGIN_VALUES } from "../goals.ts";
import { now, safeId, textResult } from "../utils.ts";
import { requireRootAuthority } from "../identity.ts";
import { resolveGoalNudgeIntervalMs } from "../reconcile.ts";
import { wrapSwarmToolInvocation } from "./wrapper.ts";

export function registerGoalTools(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "swarm_set_goal",
			label: "Swarm Set Goal",
			description:
				"Persist a swarm-level goal. While a goal is set and every non-root agent is idle with no active task nodes, the root pump emits an idle-streak nudge (anti-loop: max MAX_CONSECUTIVE_NUDGES_DEFAULT consecutive, then 2-tick back-off). Root-only.",
			promptGuidelines: [
				"Use `swarm_set_goal` to record or update the swarm's current goal in durable state.",
				"Pass `intervalMs` when you want a durable per-goal idle interval override.",
				"Pass `update: true` to update the existing goal in place without resetting counters.",
				"Pair with `swarm_mark_goal_done` when the goal is achieved or abandoned.",
			],
			parameters: Type.Object({
				text: Type.Optional(
					Type.String({
						description: "Goal text. Required for create mode; optional for update mode when only interval changes.",
					}),
				),
				id: Type.Optional(Type.String({ description: "Optional explicit goalId. Omit to auto-generate." })),
				intervalMs: Type.Optional(
					Type.Number({ description: "Optional durable idle interval override in milliseconds; positive values only." }),
				),
				maxNudges: Type.Optional(
					Type.Integer({
						description: "Optional max consecutive unresolved nudges before back-off (-1 for infinite, or positive integer).",
					}),
				),
				update: Type.Optional(
					Type.Boolean({ description: "When true, update the current goal in place without resetting counters or goalId." }),
				),
				// Issue 81: durable origin metadata. Default "root" (backwards-compatible).
				// "user" marks the goal as user-intent (refuses clear/replace without approval).
				origin: Type.Optional(
					Type.String({
						description:
							"Goal origin provenance: 'user' | 'root' | 'system' | 'batch'. Default 'root'. User-origin goals refuse clear/replace without explicit approval.",
					}),
				),
				setByScope: Type.Optional(
					Type.String({
						description: "Human-readable provenance hint (e.g. 'pm-cli', 'batch-worker-r80'). Optional, audit only.",
					}),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_set_goal", async () => {
					const p = paths(ctx.cwd);
					requireRootAuthority(currentAgentId(), "swarm_set_goal");
					const isUpdate = Boolean(params.update);
					const text = String(params.text || "").trim();
					if (!isUpdate && !text) throw new Error("swarm_set_goal: text must be non-empty");
					const requestedId = params.id ? safeId(String(params.id)) : `goal-${Date.now()}-${randomUUID().slice(0, 6)}`;
					const result = await withLock(p, async () => {
						const st = await readState(p, ctx.cwd);
						const previousId = st.goal?.id;
						const ts = now();
						const hasInterval = params.intervalMs !== undefined;
						const requestedInterval = Number(params.intervalMs);
						if (
							hasInterval &&
							(!Number.isFinite(requestedInterval) || requestedInterval <= 0 || !Number.isInteger(requestedInterval))
						) {
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
							throw new Error(
								`swarm_set_goal: invalid maxNudges ${params.maxNudges} (must be -1 for infinite or positive integer)`,
							);
						}
						const maxNudges = hasMaxNudges ? requestedMaxNudges : undefined;
						// Issue 81: validate origin parameter against the allowed set; default "root".
						const requestedOrigin = params.origin;
						if (requestedOrigin !== undefined && !GOAL_ORIGIN_VALUES.has(requestedOrigin as any)) {
							throw new Error(
								`swarm_set_goal: invalid origin ${params.origin} (must be one of: ${[...GOAL_ORIGIN_VALUES].join(", ")})`,
							);
						}
						const newOrigin = (requestedOrigin ?? GOAL_ORIGIN_ROOT) as import("../goals.ts").GoalOrigin;
						const requestedSetByScope = params.setByScope ? String(params.setByScope) : undefined;
						if (isUpdate) {
							if (!st.goal) return { updated: false, noop: true };
							// Issue 81: allow origin update on the update path (explicit provenance correction);
							// do NOT trigger the replace guard for an in-place update (same id, no text replace).
							if (text) st.goal.text = text;
							if (nudgeIntervalMs !== undefined && st.goal.nudgeIntervalMs !== nudgeIntervalMs) {
								st.goal.nudgeIntervalMs = nudgeIntervalMs;
								// Re-anchor the idle gate so the NEW interval applies immediately (command.ts parity).
								// Only pull EARLIER (min) - a longer interval must never fire sooner than scheduled.
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
							await trace(p, "goal.updated", {
								goalId: st.goal.id,
								previousId,
								via: "tool",
								updatedText: Boolean(text),
								updatedInterval: nudgeIntervalMs !== undefined,
								updatedMaxNudges: maxNudges !== undefined,
								maxNudges: st.goal.maxNudges,
								origin: st.goal.origin,
								setByScope: st.goal.setByScope,
							});
							await writeState(p, st);
							return { updated: true, goalId: st.goal.id, previousId, goal: st.goal };
						}
						// Issue 81: REPLACE path on an existing user-origin goal must REFUSE unless the caller
						// has explicit approval (the new origin is irrelevant — the replace is what fires the
						// guard, because the user-origin goal is being implicitly retired).
						if (previousId) {
							const guard = classifyGoalClearAuthority({
								currentGoal: st.goal,
								action: "replace",
								actor: currentAgentId(),
								params: { origin: newOrigin },
							});
							if (!guard.allowed) {
								await trace(p, "goal.clear_refused", {
									goalId: previousId,
									origin: guard.origin,
									reason: guard.reason,
									actor: currentAgentId(),
									action: "replace",
									via: "tool",
								});
								return {
									refused: true,
									reason: guard.reason,
									origin: guard.origin,
									goalId: previousId,
								};
							}
						}
						const goalId = requestedId;
						const inheritSeq = previousId === requestedId ? (st.goal?.nudgeSeq ?? 0) : 0;
						// Issue 85 (task-202608310905, bug #1): on a fresh set that REPLACES an existing goal,
						// inherit the prior intervalMs when the caller did NOT pass an explicit interval. Without
						// this, `swarm_set_goal({ text })` after a tuned (e.g. 600 000 ms) goal resets the cadence
						// back to the 5 s default and the pump emits 3 nudges in 15 s (live incident 2026-08-31
						// 09:00). Only inherit when `nudgeIntervalMs === undefined`; an explicit value (including
						// explicit null / zero) MUST keep its "override" semantics. No interval inheritance on
						// the update path — update leaves the existing interval untouched.
						const inheritedIntervalMs = nudgeIntervalMs === undefined ? st.goal?.nudgeIntervalMs : undefined;
						const resolvedIntervalMs = nudgeIntervalMs ?? inheritedIntervalMs ?? defaultIntervalMs;
						const inheritedMaxNudges = maxNudges === undefined ? st.goal?.maxNudges : undefined;
						const resolvedMaxNudges = maxNudges ?? inheritedMaxNudges;
						st.goal = {
							id: goalId,
							text,
							setAt: ts,
							setBy: currentAgentId(),
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
						await trace(p, "goal.set", {
							goalId,
							previousId,
							setBy: currentAgentId(),
							length: text.length,
							via: "tool",
							nudgeIntervalMs: st.goal.nudgeIntervalMs,
							maxNudges: st.goal.maxNudges,
							inheritedIntervalMs: inheritedIntervalMs ?? null,
							inheritedMaxNudges: inheritedMaxNudges ?? null,
							origin: newOrigin,
							setByScope: requestedSetByScope,
						});
						await writeState(p, st);
						return { updated: false, goalId, previousId, goal: st.goal };
					});
					if (result.refused)
						return textResult(
							`Goal clear refused: ${result.reason} (origin=${result.origin}, goalId=${result.goalId}). Use swarm_mark_goal_done({ approvedByUser: true }) to clear an explicit user-origin goal first.`,
							result,
						);
					if (result.noop) return textResult("No active goal to update.", result);
					if (result.updated) return textResult(`Goal updated: ${result.goalId}`, result);
					return textResult(`Goal set: ${result.goalId}`, result);
				});
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "swarm_mark_goal_done",
			label: "Swarm Mark Goal Done",
			description: "Clear the swarm-level goal and stop the idle-streak nudge loop. Root-only.",
			promptGuidelines: [
				"Use `swarm_mark_goal_done` once the goal is achieved or abandoned — it stops the root pump's idle nudge entirely.",
			],
			parameters: Type.Object({
				goalId: Type.Optional(
					Type.String({
						description: "Optional goalId to clear (safety fence; clear fails if it does not match the current goal).",
					}),
				),
				// Issue 81: explicit user-approval signal. Without this, swarm_mark_goal_done refuses on
				// a user-origin goal (the R9 a2 incident shape — a standing user goal silently cleared by
				// batch workflow). Pass `approvedByUser: true` only when the user has explicitly
				// authorized the clear.
				approvedByUser: Type.Optional(
					Type.Boolean({
						description:
							"Explicit user-approval signal. Required to clear a user-origin goal. Defaults to false (refuses on user-origin).",
					}),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return wrapSwarmToolInvocation(pi, ctx.cwd, "swarm_mark_goal_done", async () => {
					const p = paths(ctx.cwd);
					requireRootAuthority(currentAgentId(), "swarm_mark_goal_done");
					const result = await withLock(p, async () => {
						const st = await readState(p, ctx.cwd);
						if (!st.goal) return { cleared: true, noop: true };
						if (params.goalId && safeId(params.goalId) !== st.goal.id) {
							throw new Error(`swarm_mark_goal_done: goalId ${params.goalId} does not match current goal ${st.goal.id}`);
						}
						// Issue 81: classify clear authority against the current goal's origin.
						const guard = classifyGoalClearAuthority({
							currentGoal: st.goal,
							action: "clear",
							actor: currentAgentId(),
							params: { approvedByUser: Boolean(params.approvedByUser) },
						});
						if (!guard.allowed) {
							await trace(p, "goal.clear_refused", {
								goalId: st.goal.id,
								origin: guard.origin,
								reason: guard.reason,
								actor: currentAgentId(),
								action: "clear",
								via: "tool",
								approvedByUser: Boolean(params.approvedByUser),
							});
							return {
								cleared: false,
								refused: true,
								reason: guard.reason,
								origin: guard.origin,
								goalId: st.goal.id,
							};
						}
						const clearedId = st.goal.id;
						const nudges = st.goal.consecutiveNoResolveNudges;
						const clearedOrigin = guard.origin;
						delete st.goal;
						await trace(p, "goal.cleared", {
							goalId: clearedId,
							nudges,
							by: currentAgentId(),
							via: "tool",
							origin: clearedOrigin,
						});
						await writeState(p, st);
						return { cleared: true, clearedId, nudges };
					});
					if (result.refused)
						return textResult(
							`Goal clear refused: ${result.reason} (origin=${result.origin}, goalId=${result.goalId}). Pass approvedByUser: true to clear a user-origin goal.`,
							result,
						);
					return textResult(result.noop ? "No active goal to clear." : `Goal ${result.clearedId} cleared.`, result);
				});
			},
		}),
	);
}
