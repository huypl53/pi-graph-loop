// === swarm/hooks/tools.ts — tool_execution_start/end + tool_result hooks (Phase 7) ===
// Extracted verbatim from ../hooks.ts (Phase 7 modular split; canonical logic unchanged).
//
// tool_execution_start: pid-guarded tool_running stamp + idle-epoch reset + inferred-lifecycle
// processingAt derivation (gate=1) + auto-focus.
// tool_execution_end: busy stamp + Issue 83a lastProgressAt stamp per open node
// (ensureNodeActivityStamp is the single production entry point; C9 wraps the bare catch).
// tool_result (root): root-delegation guard — consecutive direct-edit streak advisory +
// swarm-tool reset.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { PI_SWARM_MINIMAL_PROTOCOL, SWARM_GUEST_ID, TRACE_LIFECYCLE_DERIVED } from "../constants.ts";
import { currentAgentId } from "../session.ts";
import { ensureAgentDefaults, now } from "../utils.ts";
import { paths, readState, readTaskState, taskPaths, trace, withLock, writeState, writeTaskState } from "../state.ts";
import { logSwarmError } from "../errorlog.ts";
import { resetIdleEpochState } from "../reconcile.ts";
import { ensureNodeActivityStamp } from "../taskgraph.ts";
import { maybeAutoFocusOnBusy } from "../focus.ts";
import { ROOT_EDIT_STREAK_WARN_THRESHOLD, bumpRootEditStreak, engineRetryIncidentsMap, setRootEditStreak } from "./streaks.ts";
import { SWARM_RESOLVE_TOOLS } from "./turns.ts";

export function registerToolHooks(pi: ExtensionAPI) {
	pi.on("tool_execution_start", async (_event, ctx) => {
		const agentId = currentAgentId();
		if (agentId === "root") return;
		const p = paths(ctx.cwd);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[agentId];
			if (!agent) return;
			if (agent.pid && agent.pid !== process.pid) return; // pid-guard
			const ts = now();
			const resurrect = agent.status === "stopped" || agent.health === "unhealthy";
			agent.lastToolAt = ts;
			agent.runtimeStatus = "tool_running";
			agent.status = "running";
			agent.health = "healthy";
			agent.lastHeartbeatAt = ts;
			agent.updatedAt = ts;
			if (st.idleNudgeState) {
				resetIdleEpochState(st.idleNudgeState, [agentId]);
			}
			// === Inferred lifecycle: derive processingAt for active messages to this agent ===
			if (PI_SWARM_MINIMAL_PROTOCOL === 1) {
				for (const [mid, m] of Object.entries(st.messages || {})) {
					if (m.to === agentId && !m.processingAt && !m.respondedAt && !m.terminalAt) {
						m.processingAt = ts;
						if (!m.seenAt) m.seenAt = ts;
						m.lifecycleStage = "processing";
						m.lifecycleSource = "tool_execution";
						m.updatedAt = ts;
						await trace(p, TRACE_LIFECYCLE_DERIVED, {
							messageId: mid,
							from: m.from,
							to: m.to,
							field: "processingAt",
							source: "tool_execution",
							stage: "processing",
							gate: 1,
							reason: `agent ${agentId} started tool execution`,
							via: "tool_execution_start",
						}).catch(() => {});
					}
				}
			}
			await writeState(p, st);
			await trace(p, "agent.status", { agentId, runtimeStatus: agent.runtimeStatus, health: agent.health, resurrect });
		});

		try {
			await maybeAutoFocusOnBusy(pi, ctx, agentId);
		} catch (err: any) {
			await logSwarmError(ctx?.cwd, "hooks", "tool_start.auto_focus_failed", err, { agentId });
		}
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		const agentId = currentAgentId();
		if (agentId === "root") return;
		const p = paths(ctx.cwd);
		await withLock(p, async () => {
			const st = await readState(p, ctx.cwd);
			const agent = st.agents[agentId];
			if (!agent) return;
			if (agent.pid && agent.pid !== process.pid) return; // pid-guard
			const ts = now();
			agent.runtimeStatus = "busy";
			agent.lastHeartbeatAt = ts;
			agent.updatedAt = ts;
			await writeState(p, st);
		});
		// === Issue 83a — stamp lastProgressAt on every tool execution (worker is making forward progress) ===
		// I/O cost per tool call: 1 `withLock`+`readState` (swarm state) + N `readTaskState` (one per
		// active task file) + M `writeTaskState` (one per dirty task). Where N = agent.activeTaskIds
		// length, M ≤ N (only dirty tasks written). Bounded by agent load; agent load is bounded by
		// `maxConcurrentTasks`. This is an EXTRA I/O cost vs the pre-83a baseline (which did not
		// stamp on tool calls); the cost is honest and bounded, NOT free. The read-then-stamp is
		// idempotent and safe under concurrent task-file writes because TaskNode.lastProgressAt is
		// monotone non-decreasing per node. Calls the exported `ensureNodeActivityStamp` helper per
		// node (single source of truth for the stamp invariant; unit tests exercise the same helper,
		// so the helper is the production entry point). R10-KR5 compliance: even the bare-catch
		// inner try/catch is wrapped in a test (C9) that asserts the durable side-effect; if the
		// wrapped body throws, C9 fails loudly instead of silently no-opping.
		{
			const _ids = await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const a = st.agents[agentId];
				return a?.activeTaskIds ?? [];
			});
			for (const taskId of _ids) {
				try {
					const tp = taskPaths(p, taskId);
					if (!existsSync(tp.taskJson)) continue;
					const task = await readTaskState(tp.taskJson);
					const ts = new Date().toISOString();
					let dirty = false;
					for (const nodeId of Object.keys(task.nodes)) {
						if (ensureNodeActivityStamp(task, nodeId, ts, agentId)) dirty = true;
					}
					if (dirty) await writeTaskState(tp, task).catch((err) => logSwarmError(tp, "hooks", "writeTaskState.failed", err));
				} catch (err) {
					// The stamp is advisory (the agent may legitimately not be bound to the task), but an
					// unreadable task.json on an EXISTING file is the corrupt-task symptom — surface it.
					await logSwarmError(p, "hooks", "progress.stamp_failed", err, { agentId, taskId });
				}
			}
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const agentId = currentAgentId();
		if (agentId !== "root") return;
		try {
			const toolName = (event as any)?.toolName;
			if (toolName === "edit" || toolName === "write") {
				const streak = bumpRootEditStreak();
				if (streak >= ROOT_EDIT_STREAK_WARN_THRESHOLD) {
					const notice = `\n\n[Root Orchestrator Advisory]: You have performed ${streak} consecutive direct file edits.\n- If this is an intentional quick edit, proceed.\n- If you are implementing a feature or fixing bugs, remember your role as Root: please delegate work to swarm workers via \`swarm_create_task\` and \`swarm_assign_task\`.`;
					const content = (event as any).content;
					if (Array.isArray(content) && content.length > 0) {
						const last = content[content.length - 1];
						if (last && typeof last === "object" && typeof last.text === "string") {
							last.text += notice;
						} else {
							content.push({ type: "text", text: notice });
						}
						return { content };
					}
				}
			} else if (typeof toolName === "string" && (toolName.startsWith("swarm_") || SWARM_RESOLVE_TOOLS.has(toolName))) {
				setRootEditStreak(0);
			}
		} catch (err) {
			await logSwarmError(ctx?.cwd, "hooks", "tool_result.streak_failed", err);
		}
	});
}
