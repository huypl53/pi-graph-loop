import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { GoalOrigin } from "../goals.ts";
import { classifyGoalClearAuthority, GOAL_ORIGIN_ROOT, GOAL_ORIGIN_VALUES } from "../goals.ts";
import { resolveGoalMaxNudges, resolveGoalNudgeIntervalMs } from "../reconcile.ts";
import { currentAgentId } from "../session.ts";
import { readState, trace, withLock, writeState } from "../state.ts";
import type { Paths } from "../types.ts";
import { now, safeId } from "../utils.ts";
import { parseFlags, parseGoalMaxNudges, parseGoalSetInterval } from "./parser.ts";

export async function handleGoalCommand(
	cmd: "goal",
	rest: string[],
	ctx: any,
	p: Paths,
	_pi: ExtensionAPI,
): Promise<void> {
	if (currentAgentId() !== "root") {
		ctx.ui.notify(
			"goal is root-only: run it in the PM session (PI_SWARM_IS_ROOT=1 or /swarm register here root)",
			"warning",
		);
		return;
	}
	const sub = rest.shift();
	if (sub === "show" || !sub) {
		const s = await readState(p, ctx.cwd);
		const g = s.goal;
		if (!g) {
			ctx.ui.notify("No active swarm goal.", "info");
			return;
		}
		const age = Math.round((Date.now() - Date.parse(g.setAt)) / 60000);
		const backoff = g.backoffTicksRemaining ? `, backoff ${g.backoffTicksRemaining} tick(s)` : "";
		const lastNudge = g.lastNudgeAt ? `, last nudge ${g.lastNudgeAt}` : "";
		const maxDisplay = g.maxNudges === -1 ? "∞ (infinite)" : `${resolveGoalMaxNudges(g.maxNudges)}`;
		ctx.ui.notify(
			`Goal ${g.id}
  text: ${g.text}
  set: ${g.setAt} by ${g.setBy} (${age} min ago)
  nudge interval: ${resolveGoalNudgeIntervalMs(g.nudgeIntervalMs)}ms${g.nudgeIntervalMs ? ` (durable override ${g.nudgeIntervalMs}ms)` : " (default)"}
  idle-streak nudges: ${g.consecutiveNoResolveNudges}/${maxDisplay}${lastNudge}${backoff}`,
			"info",
		);
		return;
	}
	if (sub === "nudges" || sub === "max-nudges") {
		const arg = rest[0];
		if (!arg) {
			const s = await readState(p, ctx.cwd);
			if (!s.goal) {
				ctx.ui.notify("No active swarm goal.", "info");
				return;
			}
			const maxDisplay = s.goal.maxNudges === -1 ? "infinite (-1)" : `${resolveGoalMaxNudges(s.goal.maxNudges)}`;
			ctx.ui.notify(`Goal ${s.goal.id} max nudges: ${maxDisplay}`, "info");
			return;
		}
		const parsed = parseGoalMaxNudges(arg);
		if (!parsed.ok) {
			ctx.ui.notify(`Usage: /swarm goal nudges <count> (${parsed.error})`, "warning");
			return;
		}
		const count = parsed.count;
		const stU = await withLock(p, async () => {
			const s = await readState(p, ctx.cwd);
			if (!s.goal) return { noop: true, updated: false };
			s.goal.maxNudges = count;
			if (count === -1 || count > s.goal.consecutiveNoResolveNudges) {
				delete s.goal.backoffTicksRemaining;
				const idle = (s.idleNudgeState ||= {});
				delete idle.goalBackoffTicksRemaining;
			}
			await trace(p, "goal.updated", {
				goalId: s.goal.id,
				via: "command(nudges)",
				updatedText: false,
				updatedInterval: false,
				updatedMaxNudges: true,
				maxNudges: count,
			});
			await writeState(p, s);
			return { updated: true, goal: s.goal };
		});
		if (stU.noop) {
			ctx.ui.notify("No active swarm goal to update.", "info");
			return;
		}
		const maxStr = count === -1 ? "infinite (-1)" : `${count}`;
		ctx.ui.notify(`Goal ${stU.goal!.id} max nudges updated to ${maxStr}.`, "info");
		return;
	}
	if (sub === "set" || sub === "update") {
		const isUpdate = sub === "update";
		const flags = parseFlags(rest);
		const text = flags.rest.join(" ").trim();
		const rawInterval = flags.interval !== undefined ? String(flags.interval).trim() : "";
		const hasInterval = rawInterval.length > 0;
		const parsedInterval = hasInterval ? parseGoalSetInterval(rawInterval) : null;
		const rawNudges = flags.nudges !== undefined ? String(flags.nudges).trim() : "";
		const hasNudges = rawNudges.length > 0;
		const parsedNudges = hasNudges ? parseGoalMaxNudges(rawNudges) : null;
		const requestedOrigin = flags.origin ? String(flags.origin).trim() : undefined;
		if (requestedOrigin !== undefined && !GOAL_ORIGIN_VALUES.has(requestedOrigin as any)) {
			ctx.ui.notify(`/swarm goal set --origin must be one of: ${[...GOAL_ORIGIN_VALUES].join(", ")}`, "warning");
			return;
		}
		const newOrigin = (requestedOrigin ?? GOAL_ORIGIN_ROOT) as GoalOrigin;
		const requestedSetByScope = flags["set-by-scope"] ? String(flags["set-by-scope"]).trim() : undefined;
		if (hasInterval && !parsedInterval?.ok) {
			ctx.ui.notify(
				`Usage: /swarm goal ${isUpdate ? "update" : "set"} [-i|--interval <time>] [<text>] (${parsedInterval?.error}; time accepts raw ms, s, m, h)`,
				"warning",
			);
			return;
		}
		if (hasNudges && !parsedNudges?.ok) {
			ctx.ui.notify(
				`Usage: /swarm goal ${isUpdate ? "update" : "set"} [-n|--max-nudges <count>] (${parsedNudges?.error})`,
				"warning",
			);
			return;
		}
		const maxNudges = hasNudges ? parsedNudges!.count : undefined;
		if (!isUpdate && !text) {
			if ((hasInterval && parsedInterval?.ok) || (hasNudges && parsedNudges?.ok)) {
				const setMs = hasInterval ? parsedInterval!.ms : undefined;
				const setNudges = hasNudges ? parsedNudges!.count : undefined;
				const stU = await withLock(p, async () => {
					const s = await readState(p, ctx.cwd);
					if (!s.goal) return { noop: true, updated: false };
					if (setMs !== undefined && s.goal.nudgeIntervalMs !== setMs) {
						s.goal.nudgeIntervalMs = setMs;
						const idle = (s.idleNudgeState ||= {});
						const anchor = idle.allIdleSinceAt ? new Date(idle.allIdleSinceAt).getTime() : Date.now();
						idle.nextGoalNudgeAt = idle.nextGoalNudgeAt
							? new Date(Math.min(new Date(idle.nextGoalNudgeAt).getTime(), anchor + setMs)).toISOString()
							: new Date(anchor + setMs).toISOString();
					}
					if (setNudges !== undefined && s.goal.maxNudges !== setNudges) {
						s.goal.maxNudges = setNudges;
						if (setNudges === -1 || setNudges > s.goal.consecutiveNoResolveNudges) {
							delete s.goal.backoffTicksRemaining;
							const idle = (s.idleNudgeState ||= {});
							delete idle.goalBackoffTicksRemaining;
						}
					}
					await trace(p, "goal.updated", {
						goalId: s.goal.id,
						via: "command(set-as-update)",
						updatedText: false,
						updatedInterval: setMs !== undefined,
						updatedMaxNudges: setNudges !== undefined,
						maxNudges: s.goal.maxNudges,
					});
					await writeState(p, s);
					return { updated: true, goal: s.goal };
				});
				if (stU.updated) {
					ctx.ui.notify(
						`Goal ${stU.goal!.id} updated${setMs !== undefined ? ` interval=${setMs}ms` : ""}${setNudges !== undefined ? ` maxNudges=${setNudges === -1 ? "infinite (-1)" : setNudges}` : ""}.`,
						"info",
					);
					return;
				}
			}
			ctx.ui.notify(
				"Usage: /swarm goal set [-i|--interval <time>] [-n|--max-nudges <count>] <text> (interval/nudges change on an existing goal: use 'update' or 'goal nudges')",
				"warning",
			);
			return;
		}
		if (isUpdate && !text && !hasInterval && !hasNudges) {
			ctx.ui.notify("Usage: /swarm goal update [-i|--interval <time>] [-n|--max-nudges <count>] [<text>]", "warning");
			return;
		}
		const intervalMs = hasInterval ? parsedInterval!.ms : undefined;
		const st = await withLock(p, async () => {
			const s = await readState(p, ctx.cwd);
			if (isUpdate) {
				if (!s.goal) return { noop: true, updated: false };
				if (text) s.goal.text = text;
				if (intervalMs !== undefined && s.goal.nudgeIntervalMs !== intervalMs) {
					s.goal.nudgeIntervalMs = intervalMs;
					const idle = (s.idleNudgeState ||= {});
					const anchor = idle.allIdleSinceAt ? new Date(idle.allIdleSinceAt).getTime() : Date.now();
					const fresh = anchor + intervalMs;
					idle.nextGoalNudgeAt = idle.nextGoalNudgeAt
						? new Date(Math.min(new Date(idle.nextGoalNudgeAt).getTime(), fresh)).toISOString()
						: new Date(fresh).toISOString();
				}
				if (maxNudges !== undefined && s.goal.maxNudges !== maxNudges) {
					s.goal.maxNudges = maxNudges;
					if (maxNudges === -1 || maxNudges > s.goal.consecutiveNoResolveNudges) {
						delete s.goal.backoffTicksRemaining;
						const idle = (s.idleNudgeState ||= {});
						delete idle.goalBackoffTicksRemaining;
					}
				}
				if (requestedOrigin !== undefined) s.goal.origin = newOrigin;
				if (requestedSetByScope !== undefined) s.goal.setByScope = requestedSetByScope;
				await trace(p, "goal.updated", {
					goalId: s.goal.id,
					via: "command",
					updatedText: Boolean(text),
					updatedInterval: intervalMs !== undefined,
					updatedMaxNudges: maxNudges !== undefined,
					maxNudges: s.goal.maxNudges,
					origin: s.goal.origin,
					setByScope: s.goal.setByScope,
				});
				await writeState(p, s);
				return { updated: true, goal: s.goal };
			}
			if (s.goal) {
				const guard = classifyGoalClearAuthority({
					currentGoal: s.goal,
					action: "replace",
					actor: "root",
					params: { origin: newOrigin },
				});
				if (!guard.allowed) {
					await trace(p, "goal.clear_refused", {
						goalId: s.goal.id,
						origin: guard.origin,
						reason: guard.reason,
						actor: "root",
						action: "replace",
						via: "command",
					});
					return {
						refused: true,
						reason: guard.reason,
						origin: guard.origin,
						goalId: s.goal.id,
					};
				}
			}
			const ts = now();
			const goalId = `goal-${Date.now()}-${randomUUID().slice(0, 6)}`;
			const previousId = s.goal?.id;
			const inheritedIntervalMs = !hasInterval ? s.goal?.nudgeIntervalMs : undefined;
			const resolvedIntervalMs = intervalMs ?? inheritedIntervalMs ?? resolveGoalNudgeIntervalMs();
			const inheritedMaxNudges = !hasNudges ? s.goal?.maxNudges : undefined;
			const resolvedMaxNudges = maxNudges !== undefined ? maxNudges : inheritedMaxNudges;
			s.goal = {
				id: goalId,
				text,
				setAt: ts,
				setBy: "root",
				origin: newOrigin,
				setByScope: requestedSetByScope,
				consecutiveNoResolveNudges: 0,
				nudgeSeq: previousId === goalId ? (s.goal?.nudgeSeq ?? 0) : 0,
				nudgeIntervalMs: resolvedIntervalMs,
				maxNudges: resolvedMaxNudges,
			};
			delete s.goal.lastNudgeAt;
			delete s.goal.lastResolvedAt;
			delete s.goal.backoffTicksRemaining;
			await trace(p, "goal.set", {
				goalId,
				previousId,
				via: "command",
				length: text.length,
				nudgeIntervalMs: s.goal.nudgeIntervalMs,
				maxNudges: s.goal.maxNudges,
				inheritedIntervalMs: inheritedIntervalMs ?? null,
				inheritedMaxNudges: inheritedMaxNudges ?? null,
				origin: newOrigin,
				setByScope: requestedSetByScope,
			});
			await writeState(p, s);
			return { updated: false, goal: s.goal, goalId, previousId };
		});
		if (st.refused) {
			ctx.ui.notify(
				`Goal clear refused: ${st.reason} (origin=${st.origin}, goalId=${st.goalId}). Clear first with /swarm goal done --force-user-clear, then set the new goal.`,
				"warning",
			);
			return;
		}
		if (st.noop) {
			ctx.ui.notify("No active swarm goal to update.", "info");
			return;
		}
		if (isUpdate) {
			ctx.ui.notify(
				`Goal updated: ${st.goal.id} — "${st.goal.text.slice(0, 80)}${st.goal.text.length > 80 ? "…" : ""}"${st.goal.nudgeIntervalMs ? ` (nudge interval ${st.goal.nudgeIntervalMs}ms)` : ""}${st.goal.maxNudges !== undefined ? ` (max nudges: ${st.goal.maxNudges === -1 ? "infinite (-1)" : st.goal.maxNudges})` : ""}`,
				"info",
			);
			return;
		}
		ctx.ui.notify(
			`Goal set: ${st.goalId} — "${st.goal.text.slice(0, 80)}${st.goal.text.length > 80 ? "…" : ""}"${st.goal.nudgeIntervalMs ? ` (nudge interval ${st.goal.nudgeIntervalMs}ms)` : ""}${st.goal.maxNudges !== undefined ? ` (max nudges: ${st.goal.maxNudges === -1 ? "infinite (-1)" : st.goal.maxNudges})` : ""}`,
			"info",
		);
		return;
	}
	if (sub === "done") {
		const forceUserClear = rest.includes("--force-user-clear");
		const goalIdArg = rest.find((t) => t !== "--force-user-clear");
		const result = await withLock(p, async () => {
			const s = await readState(p, ctx.cwd);
			if (!s.goal) return { cleared: true, noop: true };
			if (goalIdArg && safeId(goalIdArg) !== s.goal.id) {
				throw new Error(`goalId ${goalIdArg} does not match current goal ${s.goal.id}`);
			}
			const guard = classifyGoalClearAuthority({
				currentGoal: s.goal,
				action: "clear",
				actor: "root",
				params: { approvedByUser: forceUserClear },
			});
			if (!guard.allowed) {
				await trace(p, "goal.clear_refused", {
					goalId: s.goal.id,
					origin: guard.origin,
					reason: guard.reason,
					actor: "root",
					action: "clear",
					via: "command",
					approvedByUser: forceUserClear,
				});
				return {
					cleared: false,
					refused: true,
					reason: guard.reason,
					origin: guard.origin,
					goalId: s.goal.id,
				};
			}
			const clearedId = s.goal.id;
			const nudges = s.goal.consecutiveNoResolveNudges;
			const clearedOrigin = guard.origin;
			delete s.goal;
			await trace(p, "goal.cleared", { goalId: clearedId, nudges, via: "command", origin: clearedOrigin });
			await writeState(p, s);
			return { cleared: true, clearedId, nudges };
		});
		if (result.refused) {
			ctx.ui.notify(
				`Goal clear refused: ${result.reason} (origin=${result.origin}). Use --force-user-clear to clear a user-origin goal.`,
				"warning",
			);
			return;
		}
		ctx.ui.notify(result.noop ? "No active goal to clear." : `Goal ${result.clearedId} cleared.`, "info");
		return;
	}
	ctx.ui.notify(
		"Usage: /swarm goal show | set [-i|--interval <time>] <text> | update [-i|--interval <time>] [<text>] | done [<goalId>]",
		"warning",
	);
}
