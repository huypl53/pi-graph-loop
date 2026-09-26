// === swarm/hooks/turns.ts — resolve-action detector + turn_start/turn_end goal hooks (Phase 7) ===
// Extracted verbatim from ../hooks.ts (Phase 7 modular split; canonical logic unchanged).
//
// R16: a turn_end{stop, role=assistant} is a RESOLVE only if the root ADVANCED the goal in that
// turn (a swarm tool call). SWARM_RESOLVE_TOOLS + turnEndIsResolveAction are exported at module
// scope so r16-idle-goal-regression.test.mjs can drive the PRODUCTION detector end-to-end.
//
// R23C: turn_start is the root's busy edge — stamps ["root"] provenance into the idle-epoch
// reset so the cap branch's worker-breaker guard can reject root-turn churn anchors.
//
// Binding C-2: the goal-resolve turn_end handler is registered AFTER the model-pool swap turn_end
// (see hooks/index.ts registration order) so the resolve observes the post-swap state.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SWARM_GUEST_ID } from "../constants.ts";
import { currentAgentId } from "../session.ts";
import { paths, readState, trace, withLock, writeState } from "../state.ts";
import { resetIdleEpochState } from "../reconcile.ts";

// === R16 (2026-09-02): turn-end resolve-action detector (module-scope export) ===
// A turn_end{stop, role=assistant} is a RESOLVE only if the root ADVANCED the goal
// in that turn — i.e., the message contains a swarm tool call (swarm_spawn_agent /
// swarm_assign_task / swarm_mark_goal_done / swarm_set_goal / swarm_restart_agent /
// swarm_send_message / swarm_reconcile / swarm_update_task / swarm_create_task /
// swarm_stop_agent / swarm_release_agent_task) OR an explicit user-direction message
// was sent via a tool call in the same turn.
export const SWARM_RESOLVE_TOOLS: ReadonlySet<string> = new Set([
	"swarm_spawn_agent",
	"swarm_assign_task",
	"swarm_mark_goal_done",
	"swarm_set_goal",
	"swarm_restart_agent",
	"swarm_send_message",
	"swarm_reconcile",
	"swarm_update_task",
	"swarm_create_task",
	"swarm_stop_agent",
	"swarm_release_agent_task",
]);
export function turnEndIsResolveAction(event: any): { resolve: boolean; reason: string; toolNames?: string[] } {
	const msg: any = event?.message;
	const toolResults: any[] = Array.isArray(event?.toolResults) ? event.toolResults : [];
	// Path A: content blocks expose tool_use calls.
	const blocks: any[] = Array.isArray(msg?.content) ? msg.content : [];
	const toolNamesFromContent: string[] = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const t = block.type;
		if (t === "tool_use" || t === "toolCall") {
			const name = block.name || block.toolName;
			if (typeof name === "string" && SWARM_RESOLVE_TOOLS.has(name)) toolNamesFromContent.push(name);
		}
	}
	// Path B: toolResults carry the toolName too.
	const toolNamesFromResults: string[] = [];
	for (const tr of toolResults) {
		const name = tr?.toolName || tr?.name;
		if (typeof name === "string" && SWARM_RESOLVE_TOOLS.has(name)) toolNamesFromResults.push(name);
	}
	const swarmToolNames = Array.from(new Set([...toolNamesFromContent, ...toolNamesFromResults]));
	if (swarmToolNames.length > 0) return { resolve: true, reason: "swarm_tool_call", toolNames: swarmToolNames };
	// No tool calls: NOT a resolve (pure ack text or silent turn).
	return { resolve: false, reason: "no_resolve_action" };
}

export function registerTurnHooks(pi: ExtensionAPI) {
	// === Root-busy resets the shared idle epoch (Row 68 semantics fix, 2026-08-31) ===
	// The idle-streak nudge measures "all agents + ROOT idle for a full interval". Workers
	// are covered by updateIdleEpochLocked (runtimeStatus busy/idle edges), but the ROOT's
	// own activity was invisible to it: while the PM was busy answering the human (turns running),
	// the epoch stayed anchored at the old all-idle edge, so a 30s interval elapsed "during" the
	// PM's work and the nudge fired ~30s after every turn end (live: nudge 1/3 following each reply
	// even though the PM had been busy the whole time). turn_start = busy edge for the root:
	// drop the epoch (and pending boundary); turn_end (below) re-arms it via the next pump tick's
	// fresh allIdleSinceAt, so the interval is measured from the END of the root's work.
	pi.on("turn_start", async (_event, ctx) => {
		if (currentAgentId() !== "root") return;
		const p = paths(ctx.cwd);
		try {
			await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const idleState = st.idleNudgeState;
				if (
					!idleState?.allIdleSinceAt &&
					!idleState?.nextGoalNudgeAt &&
					!idleState?.lastGoalNudgeAt &&
					!idleState?.goalIdleCheckCount
				)
					return;
				const prev = idleState.allIdleSinceAt ?? null;
				// === R23C (2026-09-03) — stamp root provenance at the turn_start clear site ===
				// turn_start is the root's busy edge (the live R23 storm source — `agent_settled`
				// fires at every root turn boundary, briefly marking the root busy/idle).
				// The cap branch's worker-breaker guard reads `lastEpochBusyAgents` to distinguish a
				// worker-driven fresh epoch (qualifies for reset) from root-turn churn (must
				// NOT qualify). Without this stamp, every turn_start-cleared anchor reaches the cap
				// branch with breaker=undefined → absent→reset legacy default → STORM. Stamping
				// `["root"]` here lets the breaker reject root-churn anchors. Live
				// evidence: tester-turnstart-probe.mjs (R23C artifacts; pre-fix RED 2 resets/4 emissions
				// seq 4→7, post-fix GREEN ≤1 emission).
				resetIdleEpochState(idleState, ["root"]);
				await trace(p, "idle.epoch.reset", { reason: "root_busy", previousAllIdleSinceAt: prev, busyAgents: ["root"] }).catch(
					() => {},
				);
				await writeState(p, st);
			});
		} catch (err: any) {
			await trace(p, "idle.epoch.reset_error", { error: String((err as Error)?.message || err) }).catch(() => {});
		}
	});

	// === Issue 18 + R16: Goal idle-streak resolve detection ===
	// Registered AFTER the model-pool swap branch above so pi's per-event handler loop runs the
	// resolve AFTER any in-process swap (binding C-2 of the plan review). Both handlers acquire the
	// same withLock independently, so they serialise; source order ensures the resolve observes the
	// post-swap state.
	//
	// R16 fix: a turn_end{stop, role=assistant} is a RESOLVE only if the root actually
	// ADVANCED the goal in that turn — i.e., the message contains a swarm tool call
	// (swarm_spawn_agent / swarm_assign_task / swarm_mark_goal_done / swarm_set_goal /
	// swarm_restart_agent / swarm_send_message / swarm_reconcile / swarm_update_task /
	// swarm_create_task / swarm_stop_agent / swarm_release_agent_task) OR an explicit user-
	// direction message was sent via a tool call in the same turn.
	//
	// Pure ack text ("Got it, will continue", "Acknowledged", "Will keep going") does NOT count:
	// it would let an idle root reset the counter forever on the same template, never
	// reaching MAX_CONSECUTIVE_NUDGES_DEFAULT, never engaging back-off, never surfacing the
	// bounded escalation chain. Live incident 2026-09-02: 47 idle_nudge / 36 resolved in 10 min
	// for goal-1788266039522-6eae40.
	//
	// A turn_end {error} is intentionally NOT a resolve: tool/model failures are not "I addressed
	// the goal". A non-root turn_end is also NOT a resolve: workers don't decide the goal.
	// An empty-message turn_end (silent) is NOT a resolve either — unchanged from pre-fix.
	//
	// The action detector is exported at module scope (SWARM_RESOLVE_TOOLS + turnEndIsResolveAction)
	// so r16-idle-goal-regression.test.mjs can drive the PRODUCTION detector end-to-end. The
	// turn_end handler below calls `turnEndIsResolveAction(event)` to gate the counter reset.
	pi.on("turn_end", async (event, ctx) => {
		const msg: any = (event as any)?.message;
		if (!msg || msg.role !== "assistant" || msg.stopReason !== "stop") return;
		if (currentAgentId() !== "root") return;
		const action = turnEndIsResolveAction(event);
		const p = paths(ctx.cwd);
		try {
			await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const goal = st.goal;
				if (!goal) return;
				const nudges = goal.consecutiveNoResolveNudges;
				const hadBackoff = Boolean(goal.backoffTicksRemaining && goal.backoffTicksRemaining > 0);
				if (nudges === 0 && !hadBackoff) return; // nothing to resolve
				// R16: pure ack text does NOT count as a resolve. Track when a turn was a
				// non-resolve so the trace distinguishes ack vs resolve clearly for ops/dashboards.
				if (!action.resolve) {
					goal.lastNonResolveTurnAt = new Date().toISOString();
					await trace(p, "goal.nudge.turn_no_resolve_action", {
						goalId: goal.id,
						nudges,
						hadBackoff,
						detectionReason: action.reason,
					}).catch(() => {});
					await writeState(p, st);
					return;
				}
				goal.consecutiveNoResolveNudges = 0;
				delete goal.backoffTicksRemaining;
				goal.lastResolvedAt = new Date().toISOString();
				goal.lastResolveActionAt = new Date().toISOString();
				goal.lastResolveActionTools = action.toolNames;
				await trace(p, "goal.nudge.resolved", {
					goalId: goal.id,
					nudges,
					hadBackoff,
					by: "turn_end",
					actionReason: action.reason,
					actionTools: action.toolNames,
				});
				await writeState(p, st);
			});
		} catch (err: any) {
			await trace(p, "goal.nudge.resolve_error", { error: String((err as Error)?.message || err) }).catch(() => {});
		}
	});

}
