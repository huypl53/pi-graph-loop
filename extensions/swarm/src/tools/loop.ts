// === swarm/tools/loop.ts — tool registrations (verbatim from index.ts) ===
import { Type } from "typebox";
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureDirs, loopStateFile, paths, trace } from "../state.ts";
import { loopStatusSnapshot, recordLoopPlan } from "../loop.ts";
import { textResult } from "../utils.ts";
import { tmux } from "../tmux.ts";

export function registerLoopTools(pi: ExtensionAPI) {
	pi.registerTool(defineTool({
		name: "swarm_loop_status",
		label: "Swarm Loop Status",
		description: "Read-only V1.5 iteration-loop status for a task: loop config snapshot, current phase/round, proposal request + ack/response/reply state, plan artifact path, refresh results, and loop history path. Returns 'no loop configured' when the task has no enabled loop. Does not mutate anything.",
		promptGuidelines: ["Use `swarm_loop_status` to inspect an opt-in iteration proposal loop without mutating it. Loop mode is opt-in per task (task.loop.enabled)."],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			const snap = await loopStatusSnapshot(p, ctx.cwd, params.taskId);
			if (!snap.enabled) {
				return textResult(`Task ${params.taskId} has no enabled iteration loop (task.loop absent or disabled). Default task behavior is unchanged.`, { taskId: params.taskId, enabled: false, started: false, paths: snap.paths });
			}
			if (!snap.started || !snap.loop || !snap.round) {
				return textResult(`Task ${params.taskId} has an enabled loop but it has not started yet: close the task terminal-done to begin the proposal round.`, { taskId: params.taskId, enabled: true, started: false, config: snap.config, paths: snap.paths });
			}
			const summary = {
				taskId: snap.taskId,
				enabled: true,
				config: snap.config,
				currentRound: snap.loop.currentRound,
				phase: snap.loop.phase,
				proposalState: snap.proposalState,
				roundCount: snap.loop.rounds.length,
				round: snap.round ? { round: snap.round.round, phase: snap.round.phase, startedAt: snap.round.startedAt, endedAt: snap.round.endedAt, proposals: snap.proposals, plan: snap.round.plan, refreshResults: snap.round.refreshResults } : undefined,
				loopStateFile: snap.paths.loopStateFile,
				historyFile: snap.paths.historyFile,
				proposalsArtifact: snap.paths.proposalsArtifact,
				planArtifact: snap.paths.planArtifact,
			};
			await trace(p, "loop.status", { taskId: params.taskId, phase: snap.loop.phase, proposalState: snap.proposalState, round: snap.loop.currentRound, proposals: snap.proposals?.length || 0 });
			const stateLabel = snap.proposalState === "collecting_proposals" ? "collecting proposals" : snap.proposalState === "ready_to_plan" ? "ready to plan — call swarm_loop_plan to synthesize the next plan" : snap.proposalState === "planned" ? "plan recorded" : snap.proposalState === "executing" ? "round executing (graph reopened — let it run)" : snap.proposalState || "unknown";
			return textResult(`Task ${params.taskId} loop — round ${snap.loop.currentRound}, phase=${snap.loop.phase}, state=${stateLabel}.\n\n${JSON.stringify(summary, null, 2)}`, summary);
		},
	}))

	pi.registerTool(defineTool({
		name: "swarm_loop_plan",
		label: "Swarm Loop Plan",
		description: "Orchestrator-facing V1.5 write: record/synthesize the next-iteration plan for a loop-enabled task. Writes artifacts/next-plan.md, advances loop state to 'planned', appends a durable round record to loop history, and (optionally) best-effort refreshes configured agents via tmux /new + identity reload. Refresh failures are recorded but never corrupt loop state. No daemon, no automatic next cycle.",
		promptGuidelines: ["Use `swarm_loop_plan` to synthesize the next-iteration plan after collecting proposals. Refresh defaults to true when refreshAgents are configured; failures are best-effort."],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id with an enabled loop." }),
			summary: Type.String({ description: "Short next-iteration plan summary." }),
			nextSteps: Type.Optional(Type.String({ description: "Optional concrete next steps / notes." })),
			artifact: Type.Optional(Type.String({ description: "Plan artifact path. Defaults to artifacts/next-plan.md." })),
			refresh: Type.Optional(Type.Boolean({ description: "Best-effort refresh configured refreshAgents after recording the plan. Defaults to true when refreshAgents are configured." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			const r = await recordLoopPlan(pi, ctx.cwd, p, params.taskId, { summary: params.summary, nextSteps: params.nextSteps, artifact: params.artifact, refresh: params.refresh });
			const ok = r.refreshResults.filter((x) => !x.error).length;
			const failed = r.refreshResults.filter((x) => x.error).length;
			return textResult(`Recorded next-iteration plan for ${params.taskId} (round ${r.round}) at ${r.artifact}. Loop phase=${r.phase}.${r.refreshResults.length ? ` Refresh: ${ok} ok, ${failed} failed (best-effort; loop state intact).` : ""}`, { taskId: params.taskId, round: r.round, phase: r.phase, planArtifact: r.artifact, loopStateFile: r.loopStateFile, historyFile: r.historyFile, refreshResults: r.refreshResults });
		},
	}))
}
