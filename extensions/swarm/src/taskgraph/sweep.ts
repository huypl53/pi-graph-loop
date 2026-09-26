// === swarm/taskgraph/sweep.ts — task-close worker sweep + open-assignment scan ===
// Extracted from taskgraph.ts (Phase 6 real split). Sweep stops workers via agents.stopAgent core.

import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	PI_SWARM_KEEP_TASK_WORKERS_OPT_OUT_ENV,
	PI_SWARM_MINIMAL_PROTOCOL,
	TERMINAL_NODE_STATUSES,
	TRACE_AGENT_TASK_SWEEP_PARKED,
	TRACE_AGENT_TASK_SWEEP_STOPPED,
	TRACE_POOL_DEPLETED_NUDGE,
	TRACE_TASK_WORKERS_SWEPT,
} from "../constants.ts";
import type { Paths, SwarmState, TaskPaths, TaskState } from "../types.ts";
import { ensureAgentDefaults, safeId } from "../utils.ts";
import { logSwarmError } from "../errorlog.ts";
import { paths, readTaskState, taskPaths, trace } from "../state.ts";
import { stopAgent } from "../agents.ts";

export type SweepOutcome = "opt_out" | "no_terminal" | { stopped: string[]; skipped: { agentId: string; reason: string }[] };

export async function sweepTaskWorkersLocked(
	pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
	cwd: string,
	st: SwarmState,
	taskId: string,
	freshTask?: TaskState,
): Promise<SweepOutcome> {
	// Opt-out check (first — short-circuit before any state read or trace).
	if (process.env[PI_SWARM_KEEP_TASK_WORKERS_OPT_OUT_ENV] === "1") {
		return "opt_out";
	}
	// Pre-release active-task reconstruction. `releaseTaskFromAllAgents(taskId)` runs BEFORE the
	// sweep at every terminal transition site, so an agent whose only active task was the closing
	// task now shows `activeTaskIds === []`. We rebuild the pre-release set per agent so the
	// eligibility rule + per-agent trace evidence stay accurate. Reconstruction rules:
	//   - cur includes taskId                          -> pre-release = cur (release didn't touch).
	//   - cur empty AND spawnedForTaskId === taskId    -> pre-release = [taskId] (sole-worker closure
	//                                                     of a task-spawned worker).
	//   - cur has other tasks (no taskId post-release) -> pre-release = [taskId, ...cur] (cross-task
	//                                                     agent: keeps the closing task on its
	//                                                     history so `cross_task_active` skip fires).
	//   - cur empty AND no durable ownership link      -> pre-release = [] (never on this task —
	//                                                     shared-pool agents belong to the role pool,
	//                                                     not the task; node.assignee stamps are role
	//                                                     evidence, not ownership evidence).
	//
	// R12 P0 (2026-09-01 mass-sweep fix): the previous branch-B also synthesized `[taskId]` when
	// the agent appeared in `task.nodes[*].assignee` AND `cur.length === 0`. That synthesis
	// conflated role evidence (the worker did the work) with ownership evidence (the worker belongs
	// to this task) and made shared-pool workers (no `spawnedForTaskId` link) appear eligible for
	// sweep, killing the entire role pool on a single task close. The fix removes the assignee-stamp
	// synthesis from the empty-active-set branch; ownership is the durable `spawnedForTaskId` link
	// only. Cross-task agents (with other active tasks beyond the closing one) still get the
	// `[taskId, ...cur]` reconstruction so the `cross_task_active` skip reason remains accurate.
	const tp = taskPaths(paths(cwd), taskId);
	let task: TaskState | null = freshTask ?? null;
	// Prefer the caller's in-memory snapshot (terminal close mutates nodes AFTER the last disk
	// write in some paths — R11-2 guard must not read a stale graph). Fall back to disk read.
	if (!task) {
		try {
			task = await readTaskState(tp.taskJson);
		} catch (err) {
			// Missing task.json on a fresh task is the normal cold path; only the UNREADABLE case
			// hides a real problem from the R11-2 guard — surface that one.
			if ((err as any)?.code !== "ENOENT") {
				await logSwarmError(cwd ? paths(cwd) : process.cwd(), "taskgraph", "closure.task_unreadable", err, { taskId });
			}
		}
	}
	const priorActiveByAgent = new Map<string, string[]>();
	for (const agent of Object.values(st.agents)) {
		ensureAgentDefaults(agent);
		const cur = agent.activeTaskIds.slice();
		if (cur.includes(taskId)) {
			// Race: release didn't strip taskId from this agent yet (concurrent path).
			priorActiveByAgent.set(agent.id, cur);
		} else if (cur.length > 0) {
			// Cross-task: agent has other active tasks beyond the closing one. Reconstructed
			// pre-release = [taskId, ...cur] so the cross_task_active skip reason + per-agent
			// trace evidence remain accurate when the agent has the durable ownership link
			// (spawnedForTaskId === taskId) but is currently also serving another task.
			priorActiveByAgent.set(agent.id, [taskId, ...cur]);
		} else if (agent.spawnedForTaskId === taskId) {
			// Sole-worker closure: agent was freshly spawned for this task and no other tasks
			// remain. The durable ownership link is the only signal that makes this worker
			// task-scoped (R12: node.assignee stamps alone are NOT sufficient).
			priorActiveByAgent.set(agent.id, [taskId]);
		} else {
			// cur empty AND no durable ownership link: shared-pool agent. NEVER synthesized as
			// sole-active-task from assignee stamps (R12 fix). Pre-release is empty.
			priorActiveByAgent.set(agent.id, []);
		}
	}
	const stopped: string[] = [];
	const skipped: { agentId: string; reason: string }[] = [];
	for (const agent of Object.values(st.agents)) {
		if (agent.id === "root") {
			skipped.push({ agentId: agent.id, reason: "root" });
			continue;
		}
		ensureAgentDefaults(agent);
		if (agent.paused) {
			skipped.push({ agentId: agent.id, reason: "paused" });
			continue;
		}
		// Already stopped — skip (idempotent re-invocation).
		if (agent.status === "stopped") {
			skipped.push({ agentId: agent.id, reason: "already_stopped" });
			continue;
		}
		const priorActive = priorActiveByAgent.get(agent.id) || [];
		const remainingAfterClose = priorActive.filter((t) => t !== taskId);
		const wasInClosingTask = priorActive.includes(taskId);
		const spawnedForThis = agent.spawnedForTaskId === taskId;
		// Eligibility:
		//   (A) Freshly spawned for this task AND no remaining other active tasks.
		//   (B) Sole active task was the closing task (sole-active-task closure).
		// Cross-task agents (in closing task + remaining other active tasks) are NEVER swept.
		// Reuse-pool workers not in the closing task are not swept either.
		const eligible = (spawnedForThis || wasInClosingTask) && remainingAfterClose.length === 0;
		if (!eligible) {
			if (wasInClosingTask && remainingAfterClose.length > 0) skipped.push({ agentId: agent.id, reason: "cross_task_active" });
			continue;
		}
		// R11-2 blast-radius guard (belt to the computeTaskStatus suspenders): never stop an
		// agent that still holds a live assignment (assigned/in_progress/ready node) in the
		// closing task's graph, whatever the roll-up derived. Re-armed sub-task cycles depend
		// on this when a stale task.status=done is repaired by a later path (reconcile mark).
		if (task) {
			const stillAssigned = Object.values(task.nodes).some(
				(n) => n.assignee === agent.id && (n.status === "assigned" || n.status === "in_progress"),
			);
			if (stillAssigned) {
				skipped.push({ agentId: agent.id, reason: "live_assignment_in_graph" });
				continue;
			}
		}
		// === Issue 82: lease-aware park-or-stop (precedes stop) ===
		// When the root stamped an explicit lease on the agent, honor it BEFORE stopping.
		//   - reuse: skip the sweep entirely (worker stays alive for cross-task reuse).
		//   - park:  pause instead of stop (pane preserved for inspection / revival).
		// Both leases auto-expire at `leaseUntil`; an expired lease falls through to default.
		const leaseKind = agent.leaseKind;
		const leaseUntilMs = agent.leaseUntil ? new Date(agent.leaseUntil).getTime() : 0;
		const leaseValid = leaseKind && leaseUntilMs > Date.now();
		if (leaseValid && leaseKind === "reuse") {
			skipped.push({ agentId: agent.id, reason: "lease_reuse" });
			continue;
		}
		if (leaseValid && leaseKind === "park") {
			agent.paused = true;
			agent.leaseReason = agent.leaseReason ?? "sweep honored park lease";
			agent.updatedAt = new Date().toISOString();
			stopped.push(agent.id); // counted as swept (paused) so the summary trace fires
			skipped.push({ agentId: agent.id, reason: "lease_park" });
			await trace(paths(cwd), TRACE_AGENT_TASK_SWEEP_PARKED, {
				agentId: agent.id,
				taskId,
				leaseKind: "park",
				leaseUntil: agent.leaseUntil,
				leaseReason: agent.leaseReason ?? null,
				by: "sweepTaskWorkersLocked",
			});
			continue;
		}
		// Stop via the lock-free core (no nested withLock). force:true so the empty-set check stays
		// authoritative even if activeTaskIds had a stale pointer.
		try {
			const res = await stopAgent(pi, cwd, paths(cwd), st, agent.id, { force: true, killPane: true });
			stopped.push(agent.id);
			await trace(paths(cwd), TRACE_AGENT_TASK_SWEEP_STOPPED, {
				agentId: agent.id,
				taskId,
				priorActiveTaskIds: priorActive,
				releaseReason: spawnedForThis ? "spawned_for_task" : "sole_active_task",
				spawnedForTaskId: agent.spawnedForTaskId ?? null,
				leaseKind: leaseKind ?? null,
				leaseValidAtSweep: Boolean(leaseValid),
				killed: res.killed,
				killMethod: res.method,
				agentStatus: agent.status,
				by: "sweepTaskWorkersLocked",
			});
		} catch (err: any) {
			skipped.push({ agentId: agent.id, reason: `stop_failed: ${String((err as Error)?.message || err).slice(0, 80)}` });
		}
	}
	if (stopped.length === 0) {
		return { stopped, skipped };
	}
	// One summary trace per successful close (idempotent: re-run sees stopped=[] and emits zero).
	await trace(paths(cwd), TRACE_TASK_WORKERS_SWEPT, {
		taskId,
		stoppedCount: stopped.length,
		stoppedAgentIds: stopped.slice(),
		skippedCount: skipped.length,
		by: "sweepTaskWorkersLocked",
	});

	// === R12 P0 — pool-depletion nudge ===
	// When a task close transitions the effective live non-root agent pool from ≥1 to 0,
	// wake the root with a high-priority nudge (mailbox + Issue 86 interrupt machinery)
	// so it can either re-spawn workers or downgrade the goal. The transition is computed at
	// sweep time: we know exactly which agent ids were stopped/parked in this call (the `stopped`
	// list); the live count is taken from `st.agents` AFTER the loop, so any just-stopped agent
	// already reflects `status: "stopped"` or `paused: true`.
	//
	// Transitions that DO NOT nudge:
	//   - 0 → 0 (pool was already empty before this close — nothing to convey; also covers
	//          idempotent re-invocations on a closed task where stopped.length === 0 anyway).
	//   - ≥1 → ≥1 (sweep stopped some, but ≥1 non-root still running afterwards).
	//
	// Idempotency: a re-invoked sweep sees stopped=[] and returns at the guard above without
	// nudging. The threshold is "≥1 → 0" only, so any single close call emits at most one nudge.
	try {
		const liveNonRoot = Object.values(st.agents).filter((a) => a.id !== "root" && a.status !== "stopped" && !a.paused).length;
		if (liveNonRoot === 0) {
			const key = `pool_depleted:${taskId}`;
			// Compute pre-sweep live count by adding back the just-stopped set (stopped[] includes
			// both freshly-stopped agents and lease_parked agents; both were 'running' pre-sweep).
			const stoppedSet = new Set(stopped);
			const preSweepLive =
				Object.values(st.agents).filter((a) => a.id !== "root" && a.status !== "stopped" && !a.paused).length +
				Array.from(stoppedSet).filter((id) => {
					const ag = st.agents[id];
					return ag && ag.id !== "root";
				}).length;
			const stoppedForReport = Array.from(stoppedSet);
			const p = paths(cwd);
			await trace(p, TRACE_POOL_DEPLETED_NUDGE, {
				taskId,
				preSweepLive,
				postSweepLive: liveNonRoot,
				stoppedAgentIds: stoppedForReport,
				by: "sweepTaskWorkersLocked",
			});
			// Only emit the root nudge when there was actually a ≥1 → 0 transition
			// (the pre-sweep live count was ≥1, the post-sweep is 0). A close that doesn't
			// change the live count never reaches this branch because liveNonRoot would
			// still be ≥1 here. The 0 → 0 case is naturally suppressed by the liveNonRoot
			// === 0 guard combined with the preSweepLive check below.
			if (preSweepLive >= 1) {
				const { deliverMessageLocked } = await import("../mailbox.ts");
				await deliverMessageLocked(pi, cwd, p, st, {
					to: "root",
					priority: "high",
					subject: "swarm pool depleted",
					body: `Task \`${taskId}\` closed and the task-close sweep drained the live non-root agent pool to 0.

Stopped in this call: ${JSON.stringify(stoppedForReport)}.
Live non-root agents remaining: ${liveNonRoot}.

R12 P0 contract: the sweep no longer force-kills shared-pool workers, but a task-scoped worker drain can still empty the pool. Decide now in this turn:
  1. Re-spawn the role workers needed for the next task (swarm_spawn_agent for each missing role, or rely on swarm_assign_task autoSpawn).
  2. If no more tasks are expected, mark the goal done (swarm_mark_goal_done) so the idle-streak pump stops nudging.

(Idempotent within the sweep call: at most one nudge per close call. Not emitted on \`≥1 → ≥1\` or \`0 → 0\` transitions.)`,
					idempotencyKey: key,
					requiresAck: PI_SWARM_MINIMAL_PROTOCOL === 1 ? false : true,
					requiresResponse: true,
					conversationId: `task:${taskId}:pool_depleted`,
				}).catch((err: any) => {
					// Best-effort nudge delivery: a transient mailbox failure must not block the
					// sweep outcome. Surface as a warning trace so observability still has a hook.
					trace(p, "pool.depleted_nudge.delivery_failed", {
						taskId,
						error: String((err as Error)?.message || err).slice(0, 200),
						by: "sweepTaskWorkersLocked",
					}).catch(() => {});
				});
			}
		}
	} catch (err: any) {
		// Nudge path is best-effort; the sweep outcome is already determined by the per-agent loop.
		await trace(paths(cwd), "pool.depleted_nudge.error", {
			taskId,
			error: String((err as Error)?.message || err).slice(0, 200),
			by: "sweepTaskWorkersLocked",
		}).catch(() => {});
	}

	return { stopped, skipped };
}

// Find non-terminal assigned/in_progress nodes still owned by an agent across its active tasks.
// Used by session_shutdown to nudge/escalate instead of silently orphaning open assignments.
export async function scanAgentOpenAssignments(
	p: Paths,
	st: SwarmState,
	agentId: string,
	taskIds: string[],
): Promise<Array<{ task: TaskState; tp: TaskPaths; nodeId: string }>> {
	const out: Array<{ task: TaskState; tp: TaskPaths; nodeId: string }> = [];
	for (const rawId of taskIds) {
		const tp = taskPaths(p, safeId(rawId));
		if (!existsSync(tp.taskJson)) continue;
		const task = await readTaskState(tp.taskJson);
		for (const [nodeId, node] of Object.entries(task.nodes)) {
			// skip nodes not owned by this agent
			if (node.assignee !== agentId) continue;
			// skip non-active / terminal nodes
			if (!(node.status === "assigned" || node.status === "in_progress")) continue;
			if (TERMINAL_NODE_STATUSES.has(node.status)) continue;
			// skip non-canonical / superseded assignments: a reassigned node's canonical message now
			// points at another agent (and superseded the old one). Either signal means this agent no
			// longer canonically holds the node, so shutdown/settle must not claim it.
			const canonId = node.assignmentMessageId;
			if (canonId) {
				const rec = st.messages[canonId];
				if (!rec) continue; // canonical message missing -> do not claim
				if (rec.superseded) continue; // superseded -> not current
				if (rec.to !== agentId) continue; // canonical belongs to another agent
			}
			out.push({ task, tp, nodeId });
		}
	}
	return out;
}
