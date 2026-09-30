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
import { setGoalCore, markGoalDoneCore } from "../primitives/goal-core.ts";
import { isFencedLinkedGoal } from "../issues/controller.ts";

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
					// swarm-issues Phase 3b: linked-goal fence (composes on top of classifyGoalClearAuthority;
					// approvedByUser does not bypass it). Only the exact active linked goalId is fenced;
					// standalone goals are never affected. Pre-lock, post-authority.
					{
						const pre = await readState(p, ctx.cwd);
						if (isFencedLinkedGoal(pre, params.id ? safeId(String(params.id)) : undefined) && !params.update) {
							// replacing the active linked goal (new id or no id) while the run holds it
							throw new Error("swarm_set_goal: fenced_linked_goal — the goal is the active issue run's linked goal; only the issue controller may clear/replace it (/swarm issues status)");
						}
					}
					const result = await withLock(p, async () => {
						const preFence = await readState(p, ctx.cwd);
						if (isFencedLinkedGoal(preFence, preFence.goal?.id) && !params.update) {
							throw new Error("swarm_set_goal: fenced_linked_goal — the current goal is the active issue run's linked goal; only the issue controller may clear/replace it (/swarm issues status)");
						}
						return setGoalCore(p, ctx.cwd, params, {
							readState,
							writeState,
							trace,
							actor: currentAgentId(),
							via: "tool",
						});
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
						// swarm-issues Phase 3b: linked-goal fence — refuse non-controller clears of the
						// active linked goal (approvedByUser does NOT bypass; standalone goals unaffected).
						const preFence = await readState(p, ctx.cwd);
						if (isFencedLinkedGoal(preFence, preFence.goal?.id)) {
							return {
								cleared: false,
								refused: true,
								reason: "fenced_linked_goal",
								origin: "root" as const,
								goalId: preFence.goal?.id,
							};
						}
						return markGoalDoneCore(p, ctx.cwd, params, {
							readState,
							writeState,
							trace,
							actor: currentAgentId(),
							via: "tool",
						});
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
