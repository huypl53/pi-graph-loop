// === swarm/reconcile.ts — auto-extracted from index.ts (verbatim bodies) ===
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, appendFile, rm, stat, rename, readdir, realpath } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import type { IndexedTask, MessageResponseStatus, OrchestratorReceiptEntry, Paths, ReconcileAction, SwarmAgent, SwarmIdleNudgeState, SwarmMessage, SwarmState, SwarmTaskStallState, TaskPaths, TaskState } from "./types.ts";
import { ACK_MISSING_MS, formatNotifyKey, GOAL_NUDGE_BACKOFF_TICKS, GOAL_NUDGE_IDLE_INTERVAL_MS, MAX_ATTEMPTS, MAX_CONSECUTIVE_NUDGES_DEFAULT, MAX_REINJECTS, MAX_STATUS_TASKS, MAX_TASK_STALL_NUDGES, NOTIFY_DEFAULT_COOLDOWN_MS, NOTIFY_DEFAULT_MAX_NUDGES, NOTIFY_KEY_GOAL_IDLE_NUDGE, NOTIFY_KEY_GRAPH_ADVANCE, NOTIFY_KEY_INITIAL_READY, NOTIFY_KEY_PUMP_BATCH_SUPPRESSED, NOTIFY_KEY_TASK_GRAPH_STALL, PI_SWARM_MINIMAL_PROTOCOL, PUMP_RETRIGGER_DELAY_MS, PUMP_RETRIGGER_MAX, PUMP_SCAN_WINDOW, PUMP_SESSION_ID_CAP, PUMP_SESSION_TTL_MS, PUMP_STUCK_DEFER_ESCALATE_MS, REINJECT_AFTER_MS, TASK_INITIAL_READY_GRACE_MS, TASK_NUDGE_MS, TASK_STALE_MS, TASK_STALL_NUDGE_IDLE_INTERVAL_MS, TERMINAL_NODE_STATUSES, TRACE_LIFECYCLE_DERIVED, TRACE_LIFECYCLE_DERIVED_SHADOW, TRACE_MESSAGE_ATTENTION_DERIVED } from "./constants.ts";
import { capMap, ensureAgentDefaults, humanAge, inferRoleKind, now, safeId } from "./utils.ts";
import { computeReadyNodes, computeTaskStatus, checkStallNotificationStale, deriveNodeAttention } from "./taskgraph.ts";

export function resolveGoalNudgeIntervalMs(nudgeIntervalMs?: number | null): number {
	if (typeof nudgeIntervalMs === "number" && Number.isFinite(nudgeIntervalMs) && nudgeIntervalMs > 0) return Math.floor(nudgeIntervalMs);
	const raw = process.env.PI_SWARM_GOAL_NUDGE_IDLE_INTERVAL_MS;
	if (raw !== undefined && String(raw).trim() !== "") {
		const env = Number(raw);
		if (Number.isFinite(env) && env > 0) return Math.floor(env);
	}
	return 5_000;
}
import { currentAgentId } from "./session.ts";
import { deliver, deliverMessageLocked, deriveLifecycleFromTrigger, findIdempotentMessage, isResponseTrackingActive, readMailbox, readMailboxCached, upsertMessageRecord } from "./mailbox.ts";
import { claimOrchestratorLeader, ensureOrchestrator, heartbeatOrchestratorLeader, readOrchestratorLeader, requireOrchestratorAuthority } from "./identity.ts";
import { formatSwarmMessageContent, isDeliveryFailureRetryable } from "./delivery.ts";
import { isPanePiLike, isTmuxRunning, tmux } from "./tmux.ts";
import { readState, readTaskState, taskPaths, trace, traceTask, withLock, writeState, writeTaskState } from "./state.ts";
import { readPoolHealth, writePoolHealth, withPoolLock, slotKey } from "./pool.ts";

export async function runtimeTaskWarnings(pi: ExtensionAPI, st: SwarmState, task: TaskState): Promise<string[]> {
	const warnings: string[] = [];
	const nowMs = Date.now();
	for (const [id, node] of Object.entries(task.nodes)) {
		if (!node.assignee) continue;
		if (node.status !== "ready" && node.status !== "assigned" && node.status !== "in_progress") continue;
		const agent = st.agents[node.assignee];
		if (!agent && node.assignee !== "orchestrator") {
			warnings.push(`node ${id} assigned to missing agent ${node.assignee}`);
		} else if (agent) {
			ensureAgentDefaults(agent);
			if (agent.status === "stopped" || agent.health === "unhealthy") warnings.push(`node ${id} assignee ${agent.id} is ${agent.status}/${agent.health}`);
			const expectedKind = inferRoleKind(node.assignee, node.role);
			if (agent.roleKind !== expectedKind) warnings.push(`node ${id} role "${node.role}" expects ${expectedKind} but ${agent.id} is ${agent.roleKind}`);
			if (agent.activeTaskIds.length >= agent.maxConcurrentTasks && !agent.activeTaskIds.includes(task.taskId)) warnings.push(`node ${id} assignee ${agent.id} at capacity (${agent.activeTaskIds.length}/${agent.maxConcurrentTasks})`);
			if (agent.tmuxTarget && agent.tmuxTarget !== "unknown" && (node.status === "assigned" || node.status === "in_progress")) {
				const alive = await isTmuxRunning(pi, agent.tmuxTarget);
				if (!alive) warnings.push(`node ${id} assignee ${agent.id} tmux pane not alive`);
			}
		}
		for (const msgId of node.messageIds || []) {
			const rec = st.messages[msgId];
			if (!rec) { warnings.push(`node ${id} references missing message ${msgId}`); continue; }
			if (rec.superseded) continue; // superseded assignments are waived; not current work
			if (rec.status === "dead_letter") warnings.push(`node ${id} assignment/handoff message ${msgId} is dead-lettered (${rec.lastError || "unknown"})`);
			if (rec.requiresAck && !rec.ackedAt) warnings.push(`node ${id} message ${msgId} requires ack but is ${rec.status}`);
			// Assignment acked done but the node was never advanced past assigned/in_progress.
			if (rec.lastAck?.status === "done" && (node.status === "assigned" || node.status === "in_progress")) warnings.push(`node ${id} message ${msgId} acked done but node is still ${node.status}`);
		}
		if (node.status === "in_progress" && node.lastActivityAt) {
			const age = nowMs - new Date(node.lastActivityAt).getTime();
			if (age > 24 * 60 * 60 * 1000) warnings.push(`node ${id} in_progress for ${Math.round(age / 3_600_000)}h without update`);
		}
		// Terminal nodes must have released their advisory edit locks.
		if (TERMINAL_NODE_STATUSES.has(node.status)) {
			for (const [file, lock] of Object.entries(task.editLocks)) if (lock?.nodeId === id) warnings.push(`terminal node ${id} still holds editLock for ${file}`);
		}
	}
	// Attention derivation (roadmap issue 5): durable, pane-free recovery classification per node.
	// Advisory only — appended to the existing runtime=true warnings surface, zero schema change.
	for (const [id, node] of Object.entries(task.nodes)) {
		const att = deriveNodeAttention(st, task, id, nowMs);
		if (!att.workerReminderEligible) continue;
		warnings.push(`attention: node ${id} → ${att.category} (assignee ${node.assignee || "?"}) — ${att.evidence.join("; ")} — orchestrator may send one bounded reminder via /swarm remind ${task.taskId} ${id}`);
	}
	if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
		for (const agent of Object.values(st.agents)) {
			ensureAgentDefaults(agent);
			if (agent.activeTaskIds.includes(task.taskId)) warnings.push(`task ${task.taskId} is ${task.status} but still in ${agent.id}.activeTaskIds`);
		}
	}
	return warnings;
}

export function orchSession(st: SwarmState, nowMs: number): { ids: string[]; triggeredAt?: Record<string, string>; retriggerCount?: Record<string, number>; lastAt: string } | null {
	if (currentAgentId() !== "orchestrator") return null;
	st.orchestratorPumpSessions ||= {};
	const key = String(process.pid);
	if (!st.orchestratorPumpSessions[key]) st.orchestratorPumpSessions[key] = { ids: [], lastAt: new Date(nowMs).toISOString() };
	return st.orchestratorPumpSessions[key];
}

// === Graph-advance watcher: detect a READY-but-unassigned node and nudge the orchestrator to assign it. ===
// This is the mid-graph counterpart to the loop watcher. The loop watcher drives iteration boundaries
// (plan / reopen / execute); this drives the nodes IN BETWEEN. The observed failure: when a worker
// completes a node and sends a result message, the message is informational (requiresAck:false), so the
// orchestrator often DESCRIBES the next step ("implement_change now just needs to...") instead of ACTING
// (calling swarm_assign_task), and the graph stalls with the next node ready-but-unassigned and nothing
// prompting the orchestrator to move. This watcher is a safety net: after ~LOOP_RECONCILE_INTERVAL_MS of a
// node being ready-but-unassigned, it nudges the orchestrator with the exact assign call. Idempotent per
// (task,node); auto-acked once the node is assigned/terminal. The harness never assigns (the orchestrator
// is the actor) — it only surfaces the stall and the fix. Assumes the caller holds the state lock.
async function sendGraphAdvanceNudgeLocked(pi: ExtensionAPI, cwd: string, p: Paths, st: SwarmState, taskId: string, nodeId: string, role: string, key: string): Promise<void> {
	if (findIdempotentMessage(st, "orchestrator", "orchestrator", key)) return; // idempotent: one assign nudge per node
	try {
		await deliverMessageLocked(pi, cwd, p, st, {
			to: "orchestrator",
			subject: `Node ${nodeId} (${role}) is READY but unassigned — advance task ${taskId} now`,
			body: `Task ${taskId} has stalled mid-graph: node \`${nodeId}\` (${role}) is READY (its dependencies are satisfied) but it is still unassigned, so no agent is working on it.\n\nAssign it now:\n  swarm_assign_task(taskId="${taskId}", nodeId="${nodeId}")\n\nThen KEEP DRIVING the graph to completion in the same turn — do not stop to summarize. After ${nodeId} completes, call swarm_next_nodes + swarm_assign_task for the next ready node, and repeat until every node is terminal. Never end a turn by merely describing the next step — ACT on it (call the tool).\n\n(Action required; this safety net auto-acknowledges once the node is assigned.)`,
			requiresAck: true,
			idempotencyKey: key,
		});
	} catch (err: any) {
		await trace(p, "graph.advance_nudge_failed", { taskId, nodeId, error: String((err as Error)?.message || err) }).catch(() => {});
	}
}

function ackOrchestratorNudgeLocked(st: SwarmState, key: string, nowMs: number, note: string): void {
	const rec = findIdempotentMessage(st, "orchestrator", "orchestrator", key) || Object.values(st.messages || {}).find((r) => r.to === "orchestrator" && r.idempotencyKey === key);
	if (rec && rec.requiresAck && !rec.ackedAt) {
		const at = new Date(nowMs).toISOString();
		st.messages[rec.id] = { ...rec, status: "acked", ackedAt: at, updatedAt: at, lastAck: { by: "orchestrator", status: "done", note, at } };
		st.delivered["orchestrator"] = Array.from(new Set([...(st.delivered["orchestrator"] || []), rec.id]));
	}
}

// Watcher entry point for mid-graph stalls. For every active (in_progress) task, find actionable nodes
// (ready but unassigned) and nudge; ack any outstanding assign nudge whose node is no longer stalled.
// Read-only on task state (never assigns).
async function reconcileGraphAdvanceLocked(pi: ExtensionAPI, cwd: string, p: Paths, st: SwarmState, nowMs: number): Promise<void> {
	if (!existsSync(p.tasksDir)) return;
	let entries: string[] = [];
	try { entries = await readdir(p.tasksDir); } catch { return; }
	for (const taskId of entries) {
		const tp = taskPaths(p, taskId);
		if (!existsSync(tp.taskJson)) continue;
		let task: TaskState;
		try { task = await readTaskState(tp.taskJson); } catch { continue; }
		// Only drive active graphs. Done/blocked tasks have no ready work to assign.
		if (task.status !== "in_progress") continue;
		const cr = computeReadyNodes(task);
		const actionable = new Set([
			...cr.ready,
			...cr.current.filter((id) => task.nodes[id] && task.nodes[id].status === "ready" && !task.nodes[id].assignee),
		]);
		for (const nodeId of Object.keys(task.nodes)) {
			const key = formatNotifyKey(NOTIFY_KEY_GRAPH_ADVANCE, { taskId, nodeId });
			const node = task.nodes[nodeId];
			if (actionable.has(nodeId) && !node.assignee && !TERMINAL_NODE_STATUSES.has(node.status)) {
				// Lifecycle-fencing (issue 9, site 4): per-node staleness check before emitting a graph-advance
				// nudge. A node that has since become terminal / reassigned / closed must not be force-assigned
				// from this safety-net (the historical "force-assign unready nodes" bug). The predicate also
				// guards against nudging for a node whose assignee drifted (orchestrator pseudo-agent stays a
				// fine notify target — no filter on agentId=orchestrator here, since this nudge is addressed
				// to the orchestrator rather than a worker).
				const staleCheck = checkStallNotificationStale(st, task, nodeId, node.assignee || "orchestrator", nowMs);
				if (staleCheck.stale) {
					await traceStaleSuppressedOnce(p, "reconcile.graph_advance_nudge", { messageId: key, idempotencyKey: key, reason: staleCheck.reason, evidence: staleCheck.evidence });
					ackOrchestratorNudgeLocked(st, key, nowMs, "auto-acked: node stale");
					continue;
				}
				await sendGraphAdvanceNudgeLocked(pi, cwd, p, st, taskId, nodeId, node.role || "worker", key);
			} else {
				// Node assigned / terminal / not yet ready -> clear any outstanding assign nudge for it.
				ackOrchestratorNudgeLocked(st, key, nowMs, "auto-acked: node assigned/left ready");
			}
		}
	}
}

// Initial-ready watcher (reliability-roadmap Phase 1, P0 #2): for every freshly created task whose
// start node remains READY + unassigned beyond TASK_INITIAL_READY_GRACE_MS, send exactly one
// idempotent action-required nudge to the orchestrator. Never auto-assigns, never auto-spawns, and
// auto-clears as soon as the node leaves the `ready`+unassigned state. Honors the shared semantic
// dedupe + per-task cap policy (NOTIFY_DEFAULT_MAX_NUDGES). Runs alongside the graph-advance watcher.
export async function reconcileInitialReadyLocked(pi: ExtensionAPI, cwd: string, p: Paths, st: SwarmState, nowMs: number): Promise<void> {
	if (!existsSync(p.tasksDir)) return;
	let entries: string[] = [];
	try { entries = await readdir(p.tasksDir); } catch { return; }
	for (const taskId of entries) {
		const tp = taskPaths(p, taskId);
		if (!existsSync(tp.taskJson)) continue;
		let task: TaskState;
		try { task = await readTaskState(tp.taskJson); } catch { continue; }
		// Only act on tasks that have never progressed past the very first node. `in_progress` is handled
		// by the graph-advance watcher; terminal states have no actionable start node.
		if (task.status !== "ready") continue;
		const startId = task.start;
		const startNode = task.nodes[startId];
		if (!startNode) continue;
		if (startNode.status !== "ready" || startNode.assignee) continue;
		const createdAt = task.createdAt ? new Date(task.createdAt).getTime() : nowMs;
		const age = nowMs - createdAt;
		const key = formatNotifyKey(NOTIFY_KEY_INITIAL_READY, { taskId });
		if (age < TASK_INITIAL_READY_GRACE_MS) {
			ackOrchestratorNudgeLocked(st, key, nowMs, "auto-acked: still within grace period");
			continue;
		}
		// Cap: stop nudging once the orchestrator has ignored the same key MAX times.
		const existing = Object.values(st.messages || {}).filter((r) => r.to === "orchestrator" && r.idempotencyKey === key);
		if (existing.length >= NOTIFY_DEFAULT_MAX_NUDGES) continue;
		if (findIdempotentMessage(st, "orchestrator", "orchestrator", key)) continue;
		// Cooldown: never re-send within NOTIFY_DEFAULT_COOLDOWN_MS of the last send for the same key.
		const last = existing.map((r) => r.createdAt || "").sort().pop() || "";
		if (last && nowMs - new Date(last).getTime() < NOTIFY_DEFAULT_COOLDOWN_MS) continue;
		// Lifecycle-fencing (issue 9, site 5): per-node staleness check before the initial-ready nudge.
		// Task status="ready" already rules out conditions (1)/(2) — but we still run the predicate so a
		// cancelled attempt, assignee drift, or agent-stopped transition can short-circuit the emit. The
		// start node's "assignee" here is always undefined (filtered above), so the predicate agentId
		// placeholder is "orchestrator" (the only recipient of this nudge anyway).
		const staleCheck = checkStallNotificationStale(st, task, startId, startNode.assignee || "orchestrator", nowMs);
		if (staleCheck.stale) {
			await traceStaleSuppressedOnce(p, "reconcile.initial_ready_nudge", { messageId: key, idempotencyKey: key, reason: staleCheck.reason, evidence: staleCheck.evidence });
			ackOrchestratorNudgeLocked(st, key, nowMs, "auto-acked: node stale");
			continue;
		}
		await sendInitialReadyNudgeLocked(pi, cwd, p, st, task, startId, key);
	}
}

async function sendInitialReadyNudgeLocked(pi: ExtensionAPI, cwd: string, p: Paths, st: SwarmState, task: TaskState, startId: string, key: string): Promise<void> {
	const taskId = task.taskId;
	const startNode = task.nodes[startId];
	const role = startNode.role || "worker";
	try {
		await deliverMessageLocked(pi, cwd, p, st, {
			to: "orchestrator",
			subject: `Task ${taskId} start node is ready but unassigned`,
			body: `Task ${taskId} ("${task.title || taskId}") was created ${Math.max(1, Math.round((Date.now() - new Date(task.createdAt || Date.now()).getTime()) / 60000))} minute(s) ago but its start node \`${startId}\` (${role}) is still ready and unassigned.\n\nAction required:\n  swarm_assign_task(taskId="${taskId}", nodeId="${startId}")\n\nAlternative actions:\n  swarm_assign_task(taskId="${taskId}", nodeId="${startId}", force=true)   # orchestrator-only override\n  swarm_update_task(taskId="${taskId}", nodeId="${startId}", cancelTask=true, force=true)   # orchestrator-only cancel\n\n(Auto-clears once ${startId} is assigned or the task leaves the ready state.)`,
			requiresAck: true,
			idempotencyKey: key,
		});
	} catch (err: any) {
		await trace(p, "task.initial_ready_nudge_failed", { taskId, nodeId: startId, error: String((err as Error)?.message || err) }).catch(() => {});
	}
}

// === Issue 27: effective-liveness helper for idle predicates ===
// An agent participates in the goal-nudge / task-stall all-idle predicate only if its record is
// actually live: status "running", tmux not known-dead, and heartbeat within the stale window
// (default 10 min, override PI_SWARM_AGENT_HEARTBEAT_STALE_MS). Ghost records left behind by
// dead panes are excluded rather than counted as busy — previously 100+ stopped ghosts starved
// both nudges forever (goal.nudge never emitted since goal set).
const AGENT_HEARTBEAT_STALE_MS = Number(process.env.PI_SWARM_AGENT_HEARTBEAT_STALE_MS ?? 10 * 60_000);

function agentIsEffectivelyAlive(a: { status?: string; runtimeStatus?: string; tmuxAlive?: boolean; lastHeartbeatAt?: string }, nowMs: number): boolean {
	if (a.status !== "running") return false;
	if (a.tmuxAlive === false) return false;
	if (a.runtimeStatus === "stopped") return false;
	const hb = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : NaN;
	if (!Number.isFinite(hb)) return false;
	return nowMs - hb <= AGENT_HEARTBEAT_STALE_MS;
}

function allEffectiveIdleAgents(st: SwarmState, nowMs: number) {
	const idleAgents = Object.values(st.agents).filter((a) => a.id !== "orchestrator" && agentIsEffectivelyAlive(a, nowMs));
	const allIdle = idleAgents.every((a) => a.runtimeStatus === "idle");
	return { idleAgents, allIdle };
}

// Row 68 (AC1 fix): task statuses whose graphs can carry actionable work. A freshly created task is
// task-status "ready" (computeTaskStatus: started ? "in_progress" : "ready"), so Path A —
// non-terminal actionable graph + all effective agents idle — must admit BOTH, not in_progress only.
// Terminal/cancelled/blocked are excluded: blocked graphs cannot make progress (a blocked task
// re-enters "in_progress" the moment a node unblocks, re-admitting it here).
export function isActionableTaskStatus(status: TaskState["status"]): boolean {
	return status === "ready" || status === "in_progress";
}

// Row 75: terminal-but-recoverable graphs are failed tasks with ready/unassigned recovery nodes.
// They should still participate in stall/goal suppression so the orchestrator gets a bounded nudge
// instead of a silent failure.
export function isRecoverableTaskStatus(status: TaskState["status"]): boolean {
	return status === "failed";
}

export function isStallNudgeEligibleTaskStatus(status: TaskState["status"]): boolean {
	return isActionableTaskStatus(status) || isRecoverableTaskStatus(status);
}

// === Row 68: swarm-level idle epoch ===
// Maintains `st.idleNudgeState.allIdleSinceAt` — the anchor for the continuous all-idle interval
// used by BOTH nudge families (goal fallback + graph stall spacing). Called from the pump and from
// each nudge evaluator (idempotent: the second call in a tick is a no-op).
//   - On the not-all-idle→all-idle edge: stamp allIdleSinceAt (the busy→idle edge, NOT a pump tick).
//   - On any busy effective agent: clear the epoch (and per-task stall spacing, so the next
//     all-idle edge re-arms emission immediacy) and trace once.
// Stopped/stale ghost records never participate (agentIsEffectivelyAlive filters them), so they can
// neither block idle detection nor reset the epoch.
export async function updateIdleEpochLocked(p: Paths, st: SwarmState, nowMs: number): Promise<{ allIdle: boolean; idleAgents: SwarmAgent[] }> {
	const idleState: SwarmIdleNudgeState = st.idleNudgeState ||= {};
	const { idleAgents, allIdle } = allEffectiveIdleAgents(st, nowMs);
	if (!allIdle) {
		if (idleState.allIdleSinceAt || idleState.nextGoalNudgeAt) {
			// Busy edge: restart stall spacing so the next all-idle edge re-arms emission immediacy.
			const stallSlotsReset: string[] = [];
			for (const slot of Object.values(st.taskStallState || {})) {
				if (slot?.nextStallNudgeAt) { delete slot.nextStallNudgeAt; stallSlotsReset.push(slot.taskId); }
			}
			await trace(p, "idle.epoch.reset", {
				reason: "agent_busy",
				busyAgents: idleAgents.filter((a) => a.runtimeStatus !== "idle").map((a) => a.id),
				previousAllIdleSinceAt: idleState.allIdleSinceAt ?? null,
				stallSlotsReset,
			}).catch(() => {});
		}
		delete idleState.allIdleSinceAt;
		delete idleState.nextGoalNudgeAt;
		return { allIdle, idleAgents };
	}
	if (!idleState.allIdleSinceAt) {
		idleState.allIdleSinceAt = new Date(nowMs).toISOString();
		delete idleState.nextGoalNudgeAt;
		await trace(p, "idle.epoch.started", { allIdleSinceAt: idleState.allIdleSinceAt, idleAgents: idleAgents.length }).catch(() => {});
	}
	return { allIdle, idleAgents };
}

async function hasActionableGraphWork(p: Paths): Promise<{ actionable: boolean; taskId?: string; nodeId?: string; role?: string }> {
	if (!existsSync(p.tasksDir)) return { actionable: false };
	try {
		const entries = await readdir(p.tasksDir);
		for (const taskId of entries) {
			const tp = taskPaths(p, taskId);
			if (!existsSync(tp.taskJson)) continue;
			let task: TaskState;
			try { task = await readTaskState(tp.taskJson); } catch { continue; }
			// Row 68 fix (AC1): a freshly created task stays task-status "ready" until its first node
			// is assigned (computeTaskStatus: started ? in_progress : ready), so filtering on
			// in_progress-only hid never-assigned graphs from the graph nudge AND from goal suppression.
			// Path A is defined by NON-TERMINAL task + actionable ready/unassigned node.
			if (!isStallNudgeEligibleTaskStatus(task.status)) continue;
			const cr = computeReadyNodes(task);
			const actionable = new Set([
				...cr.ready,
				...cr.current.filter((id) => task.nodes[id] && task.nodes[id].status === "ready" && !task.nodes[id].assignee),
			]);
			for (const nodeId of actionable) {
				const node = task.nodes[nodeId];
				if (!node || node.assignee || TERMINAL_NODE_STATUSES.has(node.status)) continue;
				return { actionable: true, taskId, nodeId, role: node.role || "worker" };
			}
		}
	} catch { /* unreadable tasksDir */ }
	return { actionable: false };
}

// === Issue 18: Swarm goal + idle-streak nudge ===
// When the orchestrator has set a goal AND every non-orchestrator agent is runtimeStatus="idle" AND
// no task nodes are assigned/in_progress, this function emits an idempotent structured nudge to the
// orchestrator's own mailbox. Anti-loop: the consecutiveNoResolveNudges counter resets on ANY
// orchestrator turn that ends stopReason="stop" (hooks.ts turn_end branch — runs after the model-
// pool swap branch per binding C-2). Once the counter reaches MAX_CONSECUTIVE_NUDGES_DEFAULT, the
// pump enters a GOAL_NUDGE_BACKOFF_TICKS-tick back-off: each subsequent tick decrements the counter
// without emitting; the tick that hits 0 does NOT emit (it is the back-off exit gate); the FOLLOWING
// tick may re-enter the max-nudges branch and re-arm the back-off. Idle predicate filters out the
// orchestrator pseudo-agent (matches the issue 18 brief + plan §3.4). MUST be called under the
// same withLock(p) the pump already holds; never acquire the lock inside this function.
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
	const idleState: SwarmIdleNudgeState = st.idleNudgeState ||= {};
	const epoch = await updateIdleEpochLocked(p, st, nowMs);
	const { idleAgents, allIdle } = epoch;
	if (!allIdle) return { emitted: false, reason: "agent_busy" };
	const allIdleSinceMs = new Date(idleState.allIdleSinceAt!).getTime();
	if (!Number.isFinite(allIdleSinceMs)) {
		delete idleState.allIdleSinceAt;
		delete idleState.nextGoalNudgeAt;
		return { emitted: false, reason: "idle_epoch_missing" };
	}
	// Row 68: goal fallback is DOMINATED by the graph nudge. If actionable graph work exists, the
	// stall nudge handles this idle condition — never double-fire for the same idle state. The idle
	// epoch is intentionally kept so that once the graph quiets, the goal fallback still honors the
	// continuous all-idle interval measured from the busy→idle edge.
	const graphWork = await hasActionableGraphWork(p);
	if (graphWork.actionable) {
		await trace(p, "goal.nudge.suppressed_by_actionable_graph", { goalId: goal.id, taskId: graphWork.taskId, nodeId: graphWork.nodeId, role: graphWork.role }).catch(() => {});
		return { emitted: false, reason: "actionable_graph" };
	}
	const intervalMs = resolveGoalNudgeIntervalMs(goal.nudgeIntervalMs);
	// Interval gate: the goal fallback fires only after a FULL continuous all-idle interval measured
	// from the busy→all-idle edge (or from the last goal emission). Pump ticks between boundaries
	// are no-ops — no burst.
	const nextEligibleMs = idleState.nextGoalNudgeAt ? new Date(idleState.nextGoalNudgeAt).getTime() : allIdleSinceMs + intervalMs;
	if (nowMs < nextEligibleMs) {
		if (!idleState.nextGoalNudgeAt) idleState.nextGoalNudgeAt = new Date(nextEligibleMs).toISOString();
		return { emitted: false, reason: "idle_interval_pending" };
	}

	// Back-off accounting is interval-based: only when the interval boundary is reached do we consume
	// one back-off slot. This keeps pump tick rate from affecting the cadence.
	if (goal.backoffTicksRemaining && goal.backoffTicksRemaining > 0) {
		goal.backoffTicksRemaining -= 1;
		idleState.nextGoalNudgeAt = new Date(nowMs + intervalMs).toISOString();
		if (goal.backoffTicksRemaining === 0) {
			await trace(p, "goal.nudge.backoff.exhausted", { goalId: goal.id, by: 1 }).catch(() => {});
			return { emitted: false, reason: "backoff_just_exhausted" };
		}
		await trace(p, "goal.nudge.backoff.skip", { goalId: goal.id, remaining: goal.backoffTicksRemaining }).catch(() => {});
		return { emitted: false, reason: "backoff" };
	}

	// Already at cap? Arm back-off on the first *interval opportunity* after max emissions. The next
	// interval window is pushed forward so the pump cannot immediately re-enter the cap branch on the
	// following 5s tick.
	if (goal.consecutiveNoResolveNudges >= MAX_CONSECUTIVE_NUDGES_DEFAULT) {
		if (!goal.backoffTicksRemaining) {
			goal.backoffTicksRemaining = GOAL_NUDGE_BACKOFF_TICKS;
			idleState.nextGoalNudgeAt = new Date(nowMs + intervalMs).toISOString();
			await trace(p, "goal.nudge.backoff", { goalId: goal.id, nudges: goal.consecutiveNoResolveNudges, max: MAX_CONSECUTIVE_NUDGES_DEFAULT, backoffTicks: GOAL_NUDGE_BACKOFF_TICKS }).catch(() => {});
		}
		return { emitted: false, reason: "max_nudges" };
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
	if (findIdempotentMessage(st, "orchestrator", "orchestrator", key)) {
		return { emitted: false, reason: "duplicate_suppressed" };
	}

	// Emit the nudge via the standard mailbox path. deliverMessageLocked mutates st (upserts the
	// message record, appends to mailbox JSONL, returns { msg, delivery }). The orchestrator's own
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
		`All ${idleCount} non-orchestrator agent(s) are runtimeStatus=idle and no task nodes are assigned/in_progress.\n\n` +
		`This is nudge ${nudgeNumber} of ${MAX_CONSECUTIVE_NUDGES_DEFAULT} before back-off.\n\n` +
		`Action: either spawn / assign work to advance the goal, or mark it done:\n` +
		`  swarm_mark_goal_done(goalId="${goal.id}")\n\n` +
		`(Any reply you produce — including a plain /swarm status, a tool call, or an explanation — is treated as a "resolve": the consecutive counter resets and the back-off clears. Only a silent ignore keeps the counter climbing.)`;
	await deliverMessageLocked(pi, cwd, p, st, {
		to: "orchestrator",
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
	idleState.nextGoalNudgeAt = new Date(nowMs + intervalMs).toISOString();
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
		nextGoalNudgeAt: idleState.nextGoalNudgeAt,
	});
	return { emitted: true, reason: "emitted" };
}

// === Issue 23: task-graph-state idle nudge (no-goal variant) ===
// Mirror of `evaluateIdleGoalNudgeLocked` (Issue 18) keyed on task-graph state instead of a goal.
// Fires when ALL hold:
//   (1) At least one `in_progress` task exists in `p.tasksDir`.
//   (2) At least one of its nodes has `status === "ready"` AND `assignee === undefined` (the same
//       actionable set as `reconcileGraphAdvanceLocked`).
//   (3) Every non-orchestrator agent is `runtimeStatus === "idle"`.
//   (4) The task has existed for at least TASK_INITIAL_READY_GRACE_MS (60s).
//   (5) NOT firing the existing `reconcileGraphAdvanceLocked` nudge for the same node already (the
//       shared NOTIFY_KEY_GRAPH_ADVANCE dedupe key) so two concurrent nudges don't compete.
//
// Back-off + max-nudge cap mirror the goal-nudge machinery but are per-task (not global). Both
// nudges coexist; a goal set + a stalled task emits BOTH (different dedupe keys). Independent
// counters reset on different triggers: goal resolves on turn_end; task-stall resolves on graph-
// mutation events (assign / claim / terminal-transition).
//
// MUST be called under the same `withLock(p)` the pump already holds; never acquire the lock
// inside this function. Exported for direct unit testing by task-liveness.test.mjs.
export async function evaluateTaskGraphStallNudgeLocked(
	pi: ExtensionAPI,
	cwd: string,
	p: Paths,
	st: SwarmState,
	nowMs: number,
): Promise<{ emitted: boolean; reason: string; taskId?: string }> {
	// Predicate 1: at least one in_progress task exists.
	if (!existsSync(p.tasksDir)) return { emitted: false, reason: "no_active_task" };

	// Build the per-task actionable snapshot under one readdir pass. We use this list both to
	// determine whether a nudge is warranted AND to construct the actionable-node list surfaced
	// in the nudge body.
	let tasks: Array<{ task: TaskState; tp: TaskPaths }> = [];
	try {
		const entries = await readdir(p.tasksDir);
		for (const taskId of entries) {
			const tp = taskPaths(p, taskId);
			if (!existsSync(tp.taskJson)) continue;
			try {
				const t = await readTaskState(tp.taskJson);
				// Row 68 fix (AC1): include fresh status="ready" tasks (created, never assigned) —
				// non-terminal candidates only; the per-node actionable filter below still gates.
				if (isStallNudgeEligibleTaskStatus(t.status)) tasks.push({ task: t, tp });
			} catch { /* skip unreadable */ }
		}
	} catch { /* unreadable tasksDir === no active tasks */ }
	if (!tasks.length) return { emitted: false, reason: "no_active_task" };

	// Predicate 3: every non-orchestrator agent must be runtimeStatus === "idle".
	// Issue 27: mirrors evaluateIdleGoalNudgeLocked — only effectively-alive agents participate;
	// stopped/stale ghost records must not starve this nudge either.
	// Row 68: the shared idle-epoch update runs here (idempotent) so the busy→all-idle edge is
	// anchored at swarm level even with no goal set. A busy effective agent also resets per-task
	// stall spacing (inside updateIdleEpochLocked) so the next all-idle edge re-arms immediacy.
	const epoch = await updateIdleEpochLocked(p, st, nowMs);
	const { idleAgents, allIdle } = epoch;
	if (!allIdle) return { emitted: false, reason: "agent_busy" };
	const idleAnchorMs = st.idleNudgeState?.allIdleSinceAt ? new Date(st.idleNudgeState.allIdleSinceAt).getTime() : NaN;

	// Pick the first task with actionable+unassigned nodes that ALSO passes the grace period AND
	// doesn't already have a graph-advance nudge firing for the actionable node (predicate 5).
	for (const { task, tp } of tasks) {
		const taskId = task.taskId;
		// Predicate 4: task age >= TASK_INITIAL_READY_GRACE_MS.
		const createdAt = task.createdAt ? new Date(task.createdAt).getTime() : nowMs;
		const age = nowMs - createdAt;
		if (age < TASK_INITIAL_READY_GRACE_MS) return { emitted: false, reason: "within_grace" };

		// Predicate 2 + 5: actionable+unassigned AND no in-flight graph-advance nudge for any of them.
		const cr = computeReadyNodes(task);
		const actionable = new Set([
			...cr.ready,
			...cr.current.filter((id) => task.nodes[id] && task.nodes[id].status === "ready" && !task.nodes[id].assignee),
		]);
		const actionableNodes = Array.from(actionable).filter((id) => {
			const n = task.nodes[id];
			return n && !n.assignee && !TERMINAL_NODE_STATUSES.has(n.status);
		});
		if (!actionableNodes.length) continue;

		// Predicate 5: skip if a graph-advance nudge is already firing for any actionable node.
		let graphAdvanceActive = false;
		for (const nodeId of actionableNodes) {
			const advanceKey = formatNotifyKey(NOTIFY_KEY_GRAPH_ADVANCE, { taskId, nodeId });
			if (findIdempotentMessage(st, "orchestrator", "orchestrator", advanceKey)) { graphAdvanceActive = true; break; }
		}
		if (graphAdvanceActive) continue;

		// Per-task back-off + max-nudge bookkeeping (mirrors Issue 18). Row 68: emission cadence is
		// interval-spaced (nextStallNudgeAt), NOT pump-tick-spaced. The first stall nudge for a fresh
		// stall is IMMEDIATE (the graph actionable+all-idle path), then re-fires only after a full
		// continuous all-idle interval.
		const stallState: SwarmTaskStallState = st.taskStallState?.[taskId] || {
			taskId,
			consecutiveNoResolveNudges: 0,
		};
		if (!stallState.nextStallNudgeAt) {
			// Fresh stall (or epoch was reset since the last emission): fire immediately.
			stallState.nextStallNudgeAt = new Date(Math.min(nowMs, idleAnchorMs + TASK_STALL_NUDGE_IDLE_INTERVAL_MS)).toISOString();
		} else if (nowMs < new Date(stallState.nextStallNudgeAt).getTime()) {
			return { emitted: false, reason: "stall_interval_pending", taskId };
		}
		// Interval boundary reached: back-off consumes one slot per INTERVAL, not per tick. We do NOT
		// emit on the interval that drains back-off to 0 — the decrement itself is the gate.
		if (stallState.backoffTicksRemaining && stallState.backoffTicksRemaining > 0) {
			stallState.backoffTicksRemaining -= 1;
			stallState.nextStallNudgeAt = new Date(nowMs + TASK_STALL_NUDGE_IDLE_INTERVAL_MS).toISOString();
			if (!st.taskStallState) st.taskStallState = {};
			st.taskStallState[taskId] = stallState;
			if (stallState.backoffTicksRemaining === 0) {
				await trace(p, "task_stall.nudge.backoff.exhausted", { taskId, by: 1 }).catch(() => {});
				return { emitted: false, reason: "backoff_just_exhausted", taskId };
			}
			await trace(p, "task_stall.nudge.backoff.skip", { taskId, remaining: stallState.backoffTicksRemaining }).catch(() => {});
			return { emitted: false, reason: "backoff", taskId };
		}

		// Already at cap? Enter / re-arm the back-off window on the next interval opportunity. We do
		// NOT emit on this interval.
		if (stallState.consecutiveNoResolveNudges >= MAX_TASK_STALL_NUDGES) {
			if (!stallState.backoffTicksRemaining) {
				stallState.backoffTicksRemaining = GOAL_NUDGE_BACKOFF_TICKS;
				stallState.nextStallNudgeAt = new Date(nowMs + TASK_STALL_NUDGE_IDLE_INTERVAL_MS).toISOString();
				if (!st.taskStallState) st.taskStallState = {};
				st.taskStallState[taskId] = stallState;
				await trace(p, "task_stall.nudge.backoff", { taskId, nudges: stallState.consecutiveNoResolveNudges, max: MAX_TASK_STALL_NUDGES, backoffTicks: GOAL_NUDGE_BACKOFF_TICKS }).catch(() => {});
			}
			return { emitted: false, reason: "max_nudges", taskId };
		}

		// Idempotency: one nudge per (taskId, nudge-sequence). Same fix as the goal nudge — a static
		// per-task key allowed exactly one stall nudge per task ever; seq gives each emit a fresh slot
		// while still blocking double-emits within a tick.
		const nudgeSeq = (stallState.nudgeSeq ?? 0) + 1;
		const key = formatNotifyKey(NOTIFY_KEY_TASK_GRAPH_STALL, { taskId, seq: String(nudgeSeq) });
		if (findIdempotentMessage(st, "orchestrator", "orchestrator", key)) {
			return { emitted: false, reason: "duplicate_suppressed", taskId };
		}

		// Emit the nudge.
		const nudgeNumber = stallState.consecutiveNoResolveNudges + 1;
		const nodeList = actionableNodes
			.slice(0, 5)
			.map((id) => `${id} (${task.nodes[id].role || "worker"})`)
			.concat(actionableNodes.length > 5 ? [`+${actionableNodes.length - 5} more`] : []);
		const subject = `Pipeline stall: task ${taskId} has ${actionableNodes.length} actionable but unassigned node(s)`;
		const body =
			`Task ${taskId} ("${task.title || taskId}") is ${task.status || "in_progress"} but has ${actionableNodes.length} actionable-but-unassigned node(s):\n` +
			`  - ${nodeList.join("\n  - ")}\n\n` +
			`All ${idleAgents.length} non-orchestrator agent(s) are runtimeStatus=idle and no worker has claimed these nodes.\n\n` +
			`This is nudge ${nudgeNumber} of ${MAX_TASK_STALL_NUDGES} before back-off.\n\n` +
			`Action:\n` +
			`  swarm_assign_task(taskId="${taskId}", nodeId="${actionableNodes[0]}")\n\n` +
			`Alternative actions:\n` +
			`  swarm_assign_task(taskId="${taskId}", nodeId="${actionableNodes[0]}", force=true)   # orchestrator-only override\n` +
			`  swarm_update_task(taskId="${taskId}", nodeId="${actionableNodes[0]}", cancelTask=true, force=true)   # orchestrator-only abandon\n\n` +
			`(Any reassignment of an actionable node — including a worker's claim of an unassigned node via swarm_update_task — resets the counter.)`;
		await deliverMessageLocked(pi, cwd, p, st, {
			to: "orchestrator",
			subject,
			body,
			conversationId: `task:${taskId}:${actionableNodes[0]}`,
			requiresAck: true,
			idempotencyKey: key,
			priority: "normal",
		});

		stallState.consecutiveNoResolveNudges += 1;
		stallState.nudgeSeq = nudgeSeq;
		stallState.lastNudgeAt = new Date(nowMs).toISOString();
		stallState.nextStallNudgeAt = new Date(nowMs + TASK_STALL_NUDGE_IDLE_INTERVAL_MS).toISOString();
		if (!st.taskStallState) st.taskStallState = {};
		st.taskStallState[taskId] = stallState;
		await trace(p, "task_stall.nudge_emitted", {
			taskId,
			actionableCount: actionableNodes.length,
			actionable: actionableNodes,
			consecutiveCount: stallState.consecutiveNoResolveNudges,
			max: MAX_TASK_STALL_NUDGES,
			idleAgents: idleAgents.length,
			key,
		});
		return { emitted: true, reason: "emitted", taskId };
	}

	// Tasks scanned but no actionable pass-through.
	return { emitted: false, reason: "no_active_node" };
}

// === Issue 23: resolveTaskStallLocked ===
// Reset the per-task task-stall nudge counter when a stalled task graph advances (Issue 23
// "resolve detection"). Called by:
//   - swarm_assign_task (after stamping node.assignee) — resolves because an actionable node now
//     has an assignee.
//   - swarm_update_task claim branch (Issue 24.a) — same; a worker claimed an unassigned node.
//   - applyTaskStatus terminal-transition sites (Issue 23 B3 placement) — resolves because the
//     task left in_progress.
//
// Pure state mutation: deletes backoffTicksRemaining + nextStallNudgeAt, resets
// consecutiveNoResolveNudges to 0, stamps lastResolvedAt, and emits `task_stall.nudge.resolved` for
// trace visibility. Mirrors the goal-nudge reset hook (turn_end in hooks.ts:484-506) but lives next
// to the mutation sites because the task-stall counter resolves on graph-mutation events, not on
// orchestrator turn-end. Clearing nextStallNudgeAt means the next stall fires immediately (fresh
// stall → immediate nudge) rather than waiting out a stale interval window.
export function resolveTaskStallLocked(p: Paths, st: SwarmState, taskId: string, reason: string): void {
	const slot = st.taskStallState?.[taskId];
	if (!slot) return; // never stalled — nothing to reset
	const wasStalled = slot.consecutiveNoResolveNudges > 0 || (slot.backoffTicksRemaining ?? 0) > 0;
	slot.consecutiveNoResolveNudges = 0;
	delete slot.backoffTicksRemaining;
	delete slot.nextStallNudgeAt;
	slot.lastResolvedAt = new Date().toISOString();
	if (!st.taskStallState) st.taskStallState = {};
	st.taskStallState[taskId] = slot;
	if (wasStalled) {
		// Fire-and-forget: trace helper is async but the lock-held caller can't await without
		// nesting, so we schedule a tick. Idempotent + best-effort; failures are swallowed.
		trace(p, "task_stall.nudge.resolved", { taskId, reason }).catch(() => {});
	}
}

// === Issue 21 quota-reset-interval: slot recovery scan ===
// When a slot's bench naturally expires (cooldownUntil < nowMs) AND lastBenchReason === "quota"
// AND at least one agent on that slot has activeTaskIds, emit `pool.slot_recovered` so the
// orchestrator's existing dashboard/trace surface can decide whether to resume (NO auto-resume —
// the orchestrator-driven recovery contract). Manual benches (lastBenchReason undefined) and
// benches for non-quota reasons (auth/rate_limit/transient/unknown) NEVER emit recovery events —
// the gate is strict on kind === "quota" so an auth-bench slot doesn't trigger a misleading
// "recovered" trace.
//
// Dedupe: stamp lastRecoveredAt on the slot the first time we emit a recovery event; subsequent
// ticks see lastRecoveredAt and skip until a fresh bench invalidates the stamp (recordProviderError
// already deletes lastRecoveredAt on every new bench). Same idempotent contract as the goal
// idle-streak nudge.
//
// Cross-reference: the agent that triggered the bench is whichever agent was on the slot at the
// time. We do NOT persist a per-slot agentId (issue 19 plan-review's open question 1) — we resolve
// the agent(s) from st.agents[*] at recovery-scan time, matching by model+provider. Multi-match is
// fine: the trace payload carries an agentIds[] list (a single agent is the common case; the
// payload shape is array-typed to avoid future drift).
//
// File IO: pool-state.json reads/writes use the pool's own mutex (withPoolLock). The orchestrator
// pump already holds the SWARM lock (withLock(p)), and pool-state.json is independent — torn reads
// are safe because cooldownUntil only ever moves forward and lastBenchReason/lastRecoveredAt are
// write-only (never deleted except on a new bench, which we'd see). Helper is exported for direct
// unit testing by quota-reset.test.mjs (mirrors evaluateIdleGoalNudgeLocked).
export async function evaluateSlotRecoveryLocked(
	pi: ExtensionAPI,
	cwd: string,
	p: Paths,
	st: SwarmState,
	nowMs: number,
): Promise<{ emitted: number; reasons: Record<string, number> }> {
	const reasons: Record<string, number> = { expired_no_tasks: 0, expired_quota: 0, deduped: 0, no_active_agent: 0, not_quota_bench: 0 };
	const emitted: Array<{ agentId: string; slot: string; afterMs: number; remainingTasks: number; benchMs: number }> = [];

	await withPoolLock(p, async () => {
		const h = await readPoolHealth(p);
		let dirty = false;
		for (const [slotKeyStr, health] of Object.entries(h.slots)) {
			// Skip slots with no cooldown or still in cooldown.
			if (!health?.cooldownUntil) continue;
			const cooldownEnd = new Date(health.cooldownUntil).getTime();
			if (cooldownEnd > nowMs) continue; // still in bench
			// Cooldown has expired — but only "quota" benches get a recovery event.
			if (health.lastBenchReason !== "quota") { reasons.not_quota_bench++; continue; }
			// Idempotent: skip if we already emitted for this bench cycle.
			if (health.lastRecoveredAt) { reasons.deduped++; continue; }
			// Find agents on this slot. The slot key is `${provider}/${model}`; agents carry their
			// current model+provider. We do NOT filter on tmuxTarget=="unknown" — even a dead-tmux
			// agent is a candidate for the trace (the orchestrator may want to know regardless).
			// Use slotKey() for consistent key derivation (handles "(default)" provider case).
			const slotAgentKey = slotKeyStr;
			const matchingAgents = Object.values(st.agents).filter((a) => {
				if (a.id === "orchestrator") return false; // orchestrator pseudo-agent never has active tasks for slot work
				return slotKey({ model: a.model, provider: a.provider }) === slotAgentKey;
			});
			const busyAgents = matchingAgents.filter((a) => (a.activeTaskIds?.length || 0) > 0);
			if (!busyAgents.length) {
				// Silent path (per plan §4 D): bench expired but no active tasks → no recovery event.
				// Slot is healthy again for the next pickSlot; no notify needed.
				reasons.expired_no_tasks++;
				continue;
			}
			// Compute afterMs = how long the bench has been expired (nowMs - cooldownEnd). The benchMs
			// payload comes from the slot's lastBenchMs stamped by recordProviderError at bench time.
			const afterMs = Math.max(0, nowMs - cooldownEnd);
			// Emit one trace per busy agent (a slot with multiple workers on it produces multiple
			// events; the orchestrator can dedupe downstream if it cares).
			for (const agent of busyAgents) {
				emitted.push({ agentId: agent.id, slot: slotKeyStr, afterMs, remainingTasks: agent.activeTaskIds.length, benchMs: health.lastBenchMs ?? Math.max(0, cooldownEnd - (cooldownEnd - afterMs)) });
				reasons.expired_quota++;
			}
			// Stash idempotency stamp so the next tick (and all subsequent ticks until a new bench)
			// stay silent.
			health.lastRecoveredAt = new Date(nowMs).toISOString();
			dirty = true;
		}
		if (dirty) await writePoolHealth(p, h).catch(() => {});
	});

	for (const ev of emitted) {
		await trace(p, "pool.slot_recovered", {
			agentId: ev.agentId,
			slot: ev.slot,
			afterMs: ev.afterMs,
			remainingTasks: ev.remainingTasks,
			benchMs: ev.benchMs,
		}).catch(() => {});
	}

	return { emitted: emitted.length, reasons };
}

// === Issue 11: Orchestrator wake-up escalation + durable replay fencing ===

// Helper to parse taskId/nodeId from conversationId (format: "task:${taskId}:${nodeId}").
function parseTaskNodeRef(conversationId: string | undefined): { taskId?: string; nodeId?: string } | null {
	if (!conversationId) return null;
	const m = conversationId.match(/^task:([^:]+):([^:]+)$/);
	if (!m) return null;
	return { taskId: m[1], nodeId: m[2] };
}

// Actionability predicate for historical orchestrator PM messages (issue 11, §5). Returns { ok: false }
// for messages that must NOT be surfaced: acked, dead_lettered, superseded, wrong recipient, task
// terminal/cancelled/missing, node terminal/missing/reassigned, retrigger-budget-exhausted, or
// informational already consumed. The `strictForMigration` flag treats retrigger-budget-exhausted as
// non-actionable for the one-time migration back-fill (the budget resets per session). Exported
// for reuse by the migration back-fill block.
export function isActionableOrchestratorMessage(
	rec: { id: string; to: string; requiresAck?: boolean; status?: string; ackedAt?: string; superseded?: any; conversationId?: string; idempotencyKey?: string },
	taskIndex: Record<string, TaskState>,
	nowMs: number,
	retriggerCounts: Record<string, number>,
	strictForMigration: boolean,
): { ok: boolean; reason: string } {
	if (rec.ackedAt) return { ok: false, reason: "acked" };
	if (rec.status === "dead_letter") return { ok: false, reason: "dead_letter" };
	if (rec.superseded) return { ok: false, reason: "superseded" };
	if (rec.to !== "orchestrator") return { ok: false, reason: "wrong_recipient" };

	// Task-scoped predicate (covers terminal task, cancelled, terminal node, reassigned node).
	// Parse task/node reference from conversationId.
	const taskNodeRef = parseTaskNodeRef(rec.conversationId);
	if (taskNodeRef && taskNodeRef.taskId && taskNodeRef.nodeId) {
		const task = taskIndex[taskNodeRef.taskId];
		if (!task) return { ok: false, reason: "task_missing" };
		if (task.status === "done") return { ok: false, reason: "task_done" };
		if (task.status === "failed") return { ok: false, reason: "task_failed" };
		if (task.status === "cancelled") return { ok: false, reason: "task_cancelled" };
		const node = task.nodes[taskNodeRef.nodeId];
		if (!node) return { ok: false, reason: "node_missing" };
		if (TERMINAL_NODE_STATUSES.has(node.status)) return { ok: false, reason: "node_terminal" };
		// Reassign race: a later assignment message carries a newer idempotencyKey for the same
		// (task,node) and stamped `superseded` on the prior one. The rec-level superseded flag
		// catches this — but if a stale message was written before the supersede record (race),
		// cross-check by finding the latest assign handoff for the node.
		const lastAssign = [...(task.handoffs || [])].reverse().find(h => h.toNode === taskNodeRef.nodeId && h.kind === "assign");
		if (lastAssign && rec.idempotencyKey && (lastAssign as any).idempotencyKey && (lastAssign as any).idempotencyKey !== rec.idempotencyKey) {
			return { ok: false, reason: "node_reassigned" };
		}
	}

	// Bounded re-trigger gate: a requiresAck message that was surfaced but never acked gets
	// a bounded number of fresh triggerTurns (PUMP_RETRIGGER_MAX). After that, suppress until
	// the message is acked or removed.
	if (rec.requiresAck && !rec.ackedAt) {
		const retriggerCount = retriggerCounts[rec.id] ?? 0;
		if (retriggerCount >= PUMP_RETRIGGER_MAX) {
			// For migration back-fill, treat retrigger-budget-exhausted as non-actionable (the
			// budget resets per session). For the standard pump, this is session-bounded.
			if (strictForMigration) return { ok: false, reason: "retrigger_budget_exhausted" };
			// In the live pump, we still allow it (the retriggerCount is session-bounded and
			// resets on PID change).
		}
	}

	return { ok: true, reason: "actionable" };
}

// Helper to compute a fingerprint for a message record (sha256(messageId:lastUpdatedAt)). Used by
// the consumer receipt ledger to detect silent edits to message records between surfacing and
// reincarnation.
function fingerprintMessage(rec: { id: string; updatedAt?: string; createdAt?: string }): string {
	const ts = rec.updatedAt || rec.createdAt || now();
	return createHash("sha256").update(`${rec.id}:${ts}`).digest("hex");
}

// === Row 68: surface-time revalidation of deferred nudges ===
// Acceptance criterion: "Deferred stale nudge is suppressed if node was assigned or an agent became
// busy before delivery." A nudge queued while a stall condition held may be stale by the time the
// pump is idle and able to surface it. This predicate re-checks at surface time:
//   - goal-idle nudges: suppressed if any effective agent became busy, actionable graph work
//     appeared, or the idle epoch advanced past the message's creation (stale idle window);
//   - graph-stall nudges: suppressed if agents are busy or no actionable unassigned node remains;
//   - graph-advance / initial-ready nudges: suppressed via checkStallNotificationStale (node
//     assigned/terminal/reassigned/task closed).
// Pure + exported for direct unit testing by idle-nudge.test.mjs (plan §2.3 — the pump's surface
// path is not reachable in unit tests because the leader gate denies non-leader pids).
export async function staleSurfaceReason(
	p: Paths,
	st: SwarmState,
	msg: { id: string; idempotencyKey?: string; createdAt?: string },
	taskIndex: Record<string, TaskState>,
	nowMs: number,
): Promise<{ stale: boolean; reason: string | null; evidence: string[] }> {
	const liveIdle = allEffectiveIdleAgents(st, nowMs).allIdle;
	// Row 68 fix (AC1): goal-nudge surface suppression must also see fresh (status="ready")
	// actionable graphs, or a goal nudge fires instead of the graph nudge pre-first-assign.
	const liveGraphActionable = Object.values(taskIndex).some((task) => {
		if (!isStallNudgeEligibleTaskStatus(task.status)) return false;
		const cr = computeReadyNodes(task);
		const actionable = new Set([
			...cr.ready,
			...cr.current.filter((id) => task.nodes[id] && task.nodes[id].status === "ready" && !task.nodes[id].assignee),
		]);
		for (const nodeId of actionable) {
			const node = task.nodes[nodeId];
			if (node && !node.assignee && !TERMINAL_NODE_STATUSES.has(node.status)) return true;
		}
		return false;
	});
	const idleAnchorMs = st.idleNudgeState?.allIdleSinceAt ? new Date(st.idleNudgeState.allIdleSinceAt).getTime() : NaN;
	const rec = st.messages[msg.id] || msg;
	const key = String(rec.idempotencyKey || msg.idempotencyKey || "");
	const createdAt = new Date(rec.createdAt || msg.createdAt).getTime();
	const taskKey = key.match(/^task:([^:]+):(?:node:([^:]+):)?nudge:/);
	const goalKey = key.match(/^goal:([^:]+):nudge:idle-streak:(\d+)$/);
	let staleReason: string | null = null;
	let evidence: string[] = [];
	if (goalKey) {
		if (!liveIdle) {
			staleReason = "agent_busy";
			evidence = ["effective-agent-set-not-idle"];
		} else if (liveGraphActionable) {
			staleReason = "actionable_graph";
			evidence = ["actionable-graph-work-present"];
		} else if (Number.isFinite(idleAnchorMs) && createdAt < idleAnchorMs) {
			staleReason = "idle_epoch_advanced";
			evidence = [`message_created_before_idle_epoch:${new Date(createdAt).toISOString()}`, `idle_epoch:${new Date(idleAnchorMs).toISOString()}`];
		}
	} else if (taskKey) {
		const task = taskKey[1] ? taskIndex[taskKey[1]] : undefined;
		const nodeId = taskKey[2];
		if (!liveIdle) {
			staleReason = "agent_busy";
			evidence = ["effective-agent-set-not-idle"];
		} else if (!task) {
			staleReason = "task_missing";
			evidence = [`task_missing:${taskKey[1]}`];
		} else if (key.includes(":nudge:graph-stall:")) {
			const cr = computeReadyNodes(task);
			const actionable = new Set([
				...cr.ready,
				...cr.current.filter((id) => task.nodes[id] && task.nodes[id].status === "ready" && !task.nodes[id].assignee),
			]);
			const actionableNodes = Array.from(actionable).filter((id) => {
				const n = task.nodes[id];
				return n && !n.assignee && !TERMINAL_NODE_STATUSES.has(n.status);
			});
			if (!actionableNodes.length) {
				staleReason = "no_active_node";
				evidence = ["no-actionable-unassigned-node-remains"];
			}
		} else if (nodeId) {
			const node = task.nodes[nodeId];
			const check = checkStallNotificationStale(st, task, nodeId, node?.assignee || "orchestrator", nowMs);
			if (check.stale) {
				staleReason = check.reason || "stale";
				evidence = check.evidence;
			}
		} else if (key.includes(":nudge:initial-ready")) {
			const start = task.nodes[task.start];
			if (!start || start.status !== "ready" || start.assignee) {
				staleReason = "no_active_node";
				evidence = ["initial-ready-node-no-longer-eligible"];
			}
		}
	}
	return { stale: staleReason !== null, reason: staleReason, evidence };
}

function orchestratorSurfaceGroupKey(rec: { id: string; from?: string; subject?: string; conversationId?: string; replyTo?: string; requiresAck?: boolean; requiresResponse?: boolean; idempotencyKey?: string }): string {
	const rawKey = String(rec.idempotencyKey || "");
	if (rawKey) {
		const normalized = rawKey
			.replace(/^(goal:[a-z0-9_-]+:nudge:idle-streak:)\d+$/, "$1")
			.replace(/^(task:[a-z0-9_-]+:nudge:graph-stall:)\d+$/, "$1");
		return `idk:${normalized}`;
	}
	if (rec.conversationId) return `conv:${rec.conversationId}`;
	const subject = String(rec.subject || "").trim();
	if (subject) {
		return `subj:${subject}|from:${String(rec.from || "")}|replyTo:${String(rec.replyTo || "")}|ack:${rec.requiresAck ? 1 : 0}|resp:${rec.requiresResponse ? 1 : 0}`;
	}
	return `msg:${rec.id}`;
}

function compareSurfaceCandidates(a: { id: string; createdAt?: string; updatedAt?: string }, b: { id: string; createdAt?: string; updatedAt?: string }): number {
	const aTs = new Date(a.updatedAt || a.createdAt || 0).getTime();
	const bTs = new Date(b.updatedAt || b.createdAt || 0).getTime();
	if (aTs !== bTs) return aTs - bTs;
	return a.id.localeCompare(b.id);
}

const staleSuppressionTraceSeen = new Set<string>();

async function traceStaleSuppressedOnce(
	p: Paths,
	site: string,
	payload: { messageId?: string; idempotencyKey?: string | null; reason: string | null; evidence: string[] },
): Promise<boolean> {
	const key = String(payload.messageId || payload.idempotencyKey || "");
	if (staleSuppressionTraceSeen.has(key)) return false;
	staleSuppressionTraceSeen.add(key);
	await trace(p, "notification.stale.suppressed", {
		site,
		messageId: payload.messageId,
		idempotencyKey: payload.idempotencyKey,
		reason: payload.reason,
		evidence: payload.evidence,
	}).catch(() => {});
	return true;
}

export async function pumpOrchestratorMailbox(pi: ExtensionAPI, ctx: any, p: Paths, reason: string) {
	if (currentAgentId() !== "orchestrator") return { delivered: 0, ids: [] as string[] };
	// Read idle once, up front. Non-TUI modes have no live agent loop to trigger, so they are treated as
	// "busy" — the file-IO surfacing decision still runs (for trace visibility) but no ctx-bound call is made.
	const idleAtStart = ctx.mode === "tui" ? ctx.isIdle() : false;
	const result = await withLock(p, async () => {
		const st = await readState(p, ctx.cwd);
		// Second-line defense (issue 8 §4.4.8): even if env vars were set by a path the preflight
		// couldn't catch (e.g. an edge that skipped the gate), a non-leader pid must not run the
		// pump. Read the leader record INSIDE the existing withLock (atomic with the rest of the
		// pump decision block; no extra file IO); on deny, trace + return empty without firing
		// nudges or stamping any surfaced set. This check piggybacks on the per-tick readState.
		const leaderCheck = readOrchestratorLeader(st, Date.now());
		if (leaderCheck.kind !== "claimed" || leaderCheck.leader.pid !== process.pid) {
			// === STALE-LEASE SELF-HEAL ===
			// A STALE lease (heartbeat older than ORCHESTRATOR_LEADER_STALE_MS — no live orchestrator
			// refreshed it) used to deny this tick, but the pump tick is the ONLY thing that refreshes
			// the lease. After a watchdog gap (module reload, extension edit mid-session) the pump
			// deadlocked on its own stale lease: every tick denied, no tick ever heartbeating again —
			// observed live as 16+ min of orchestrator.pump.denied(state=stale) with goal nudges and
			// message surfacing frozen while all agents sat idle. Now: when the lease is stale
			// (whoever held it, including this pid), re-claim — claimOrchestratorLeader only denies when
			// a LIVE competing pid holds it — and continue the tick. Deny remains only for a genuinely
			// LIVE lease held by a DIFFERENT pid (true multi-orchestrator conflict).
			if (leaderCheck.kind === "stale") {
				const reclaimed = claimOrchestratorLeader(st, Date.now(), process.pid);
				if (reclaimed.kind === "denied") {
					await trace(p, "orchestrator.pump.denied", { reason, currentLeaderPid: reclaimed.currentLeader.pid, state: "claimed", callerPid: process.pid, heartbeatAgeMs: reclaimed.ageMs, reclaimedStale: true }).catch(() => {});
					return { toSurface: [] as SwarmMessage[], retriggered: 0 };
				}
				await trace(p, "orchestrator.pump.lease_reclaimed", { reason, previousPid: leaderCheck.leader.pid, staleForMs: Math.round(leaderCheck.ageMs), callerPid: process.pid }).catch(() => {});
			} else {
				await trace(p, "orchestrator.pump.denied", {
					reason,
					currentLeaderPid: leaderCheck.kind === "claimed" ? leaderCheck.leader.pid : null,
					state: leaderCheck.kind,
					callerPid: process.pid,
					heartbeatAgeMs: leaderCheck.kind !== "vacant" ? leaderCheck.ageMs : null,
				}).catch(() => {});
				return { toSurface: [] as SwarmMessage[], retriggered: 0 };
			}
		}
		// === Issue 11 (rework): per-tick leader heartbeat ===
		// The leader lease must stay alive between session_starts (otherwise the second-line defense
		// above starts denying ticks within ORCHESTRATOR_LEADER_STALE_MS of the last session_start).
		// Refresh it inside the existing withLock (atomic with the rest of the pump decision block;
		// no extra file IO). heartbeatOrchestratorLeader is a no-op for the current pid when the
		// lease is already held by it; if a competing pid claimed it between the read and the
		// refresh, it throws ORCHESTRATOR_LEADER_DENIED, which is propagated to the watchdog catch.
		heartbeatOrchestratorLeader(st, Date.now(), process.pid, "pump_tick");
		// ensureOrchestrator (create-only post-issue-8): no heartbeat refresh, just materialises the
		// pseudo-agent record for mailbox delivery. The heartbeat is owned by the gate.
		ensureOrchestrator(st, ctx.cwd, p);
		const nowMs = Date.now();
		// Prune dead sessions (not pumped within TTL) to bound growth from transient validation pids.
		for (const [k, v] of Object.entries(st.orchestratorPumpSessions!)) {
			if (k !== String(process.pid) && nowMs - new Date(v.lastAt).getTime() > PUMP_SESSION_TTL_MS) delete st.orchestratorPumpSessions![k];
		}
		// Mid-graph stall safety net: nudge the orchestrator to assign any ready-but-unassigned node in an
		// in_progress task. The nudge is idempotent, so it is safe to run on every pump tick.
		try { await reconcileGraphAdvanceLocked(pi, ctx.cwd, p, st, nowMs); } catch (err: any) { await trace(p, "graph.reconcile_error", { error: String((err as Error)?.message || err) }).catch(() => {}); }
		// Fresh-task stall safety net: nudge the orchestrator when a start node is still ready + unassigned
		// past the creation grace period. Also idempotent + read-only on task state.
		try { await reconcileInitialReadyLocked(pi, ctx.cwd, p, st, nowMs); } catch (err: any) { await trace(p, "task.initial_ready_reconcile_error", { error: String((err as Error)?.message || err) }).catch(() => {}); }
		// === Row 68: shared idle-epoch maintenance (once per tick, before both nudge evaluators) ===
		// Anchors the busy→all-idle edge at swarm level so BOTH nudge families measure continuous idle
		// from the same anchor regardless of evaluator call order or goal presence.
		try { await updateIdleEpochLocked(p, st, nowMs); } catch (err: any) { await trace(p, "idle.epoch.error", { error: String((err as Error)?.message || err) }).catch(() => {}); }
		// === Issue 23: task-graph-state idle nudge (graph-first ordering) ===
		// Evaluated BEFORE the goal fallback (row 68 plan §4): the graph nudge is the immediate priority
		// when an unfinished graph has actionable unassigned work and all effective agents are idle; the
		// goal nudge is a fallback only for no-actionable-graph conditions. Each evaluator internally
		// suppresses on the other's condition, so a single cycle can never double-fire for the same
		// idle state. Each is wrapped in try/catch (matches the existing reconcile-helper pattern) so a
		// throw never kills the tick.
		try { await evaluateTaskGraphStallNudgeLocked(pi, ctx.cwd, p, st, nowMs); } catch (err: any) { await trace(p, "task_stall.nudge_error", { error: String((err as Error)?.message || err) }).catch(() => {}); }
		// === Issue 18: goal idle-streak nudge (goal fallback, runs after the graph path) ===
		// When the orchestrator has set a goal, there is no actionable graph work, and every effective
		// agent has been continuously idle for the full interval, emit the goal fallback nudge. Anti-loop
		// counter + back-off handled inside the function.
		try { await evaluateIdleGoalNudgeLocked(pi, ctx.cwd, p, st, nowMs); } catch (err: any) { await trace(p, "goal.nudge.error", { error: String((err as Error)?.message || err) }).catch(() => {}); }
		// === Issue 21: slot recovery scan ===
		// When a slot's bench naturally expires AND lastBenchReason === "quota" AND the agent on
		// that slot still has active task assignments, emit pool.slot_recovered. NO auto-resume;
		// the orchestrator decides. Idempotent under tick storms via lastRecoveredAt dedupe.
		try { await evaluateSlotRecoveryLocked(pi, ctx.cwd, p, st, nowMs); } catch (err: any) { await trace(p, "pool.slot_recovered.error", { error: String((err as Error)?.message || err) }).catch(() => {}); }
		const sess = orchSession(st, nowMs)!;
		const surfaced = new Set(sess.ids);
		const triggeredAt = { ...(sess.triggeredAt ?? {}) };
		const retriggerCount = { ...(sess.retriggerCount ?? {}) };
		const keepalive = () => { sess.lastAt = new Date(nowMs).toISOString(); };
		// Session-safe surfacing keying is unchanged (per-pid, not PI_SESSION_ID, so a validation run or a
		// second orchestrator lane cannot starve this PM process). Recent window bounds work; acked messages
		// (ackedAt = "recipient processed it") are skipped. We no longer pre-filter surfaced here: surfaced
		// vs triggered vs re-trigger is decided below, because surfacing must be gated on idle.

		// === Issue 11: One-time migration back-fill (binding C4) ===
		if ((st.consumerReceipts?.orchestrator?.revision ?? 0) === 0) {
			const migrationEntries = st.consumerReceipts!.orchestrator!.entries!;
			let written = 0;
			let scanned = 0;
			// Build task index for actionability predicate.
			const taskIndex: Record<string, TaskState> = {};
			if (existsSync(p.tasksDir)) {
				try {
					const entries = await readdir(p.tasksDir);
					for (const taskId of entries) {
						const tp = taskPaths(p, taskId);
						if (!existsSync(tp.taskJson)) continue;
						try { taskIndex[taskId] = await readTaskState(tp.taskJson); } catch { /* skip unreadable */ }
					}
				} catch { /* ignore readdir errors */ }
			}
			const retriggerCounts = orchSession(st, nowMs)!.retriggerCount || {};
			for (const rec of Object.values(st.messages)) {
				scanned++;
				if (rec.to !== "orchestrator") continue;
				if (!rec.requiresAck) continue;
				// Use the actionability predicate; non-actionable messages get a receipt.
				// Note: do NOT short-circuit on rec.ackedAt here — the predicate returns reason="acked"
				// and we want the receipt entry written so a reincarnated consumer reads it.
				const v = isActionableOrchestratorMessage(rec, taskIndex, nowMs, retriggerCounts, /* strictForMigration */ true);
				if (!v.ok) {
					migrationEntries[rec.id] = {
						surfacedAt: rec.updatedAt || rec.createdAt,
						ackedAt: rec.ackedAt,
						requiresAck: true,
						conversationId: rec.conversationId,
						fingerprint: fingerprintMessage(rec),
					};
					written++;
				}
			}
			st.consumerReceipts!.orchestrator!.revision = 1;
			await trace(p, "notification.backfill.receipts_written", { written, scanned, ts: nowMs }).catch(() => {});
		}

		// === Issue 11: Durable dedupe gate + actionability filter (binding C4 + C5) ===
		const deliveredOrch = new Set(st.delivered.orchestrator || []);
		// Build task index for actionability predicate.
		const taskIndex: Record<string, TaskState> = {};
		if (existsSync(p.tasksDir)) {
			try {
				const entries = await readdir(p.tasksDir);
				for (const taskId of entries) {
					const tp = taskPaths(p, taskId);
					if (!existsSync(tp.taskJson)) continue;
					try { taskIndex[taskId] = await readTaskState(tp.taskJson); } catch { /* skip unreadable */ }
				}
			} catch { /* ignore readdir errors */ }
		}
		const retriggerCounts = orchSession(st, nowMs)!.retriggerCount || {};
		const windowMsgs = (await readMailboxCached(p, "orchestrator"))
			.slice(-PUMP_SCAN_WINDOW)
			.filter((m) => {
				const rec = st.messages[m.id];
				if (!rec) return false;

				// Durable dedupe gate (binding C4): check consumerReceipts first, then legacy delivered ledger, then per-pid surfaced.
				if (st.consumerReceipts?.orchestrator?.entries?.[m.id]) return false;
				if (rec.requiresAck === false && (rec.surfacedAt || deliveredOrch.has(m.id))) return false;
				if (surfaced.has(m.id)) return false; // per-pid surfaced (retrigger bound)

				// Actionability predicate (binding C5): skip non-actionable messages and batch-count suppressions.
				const v = isActionableOrchestratorMessage(rec, taskIndex, nowMs, retriggerCounts, /* strictForMigration */ false);
				return v.ok;
			});

		// === Issue 11: Per-tick batch suppression trace (binding C6) ===
		// Count all suppressed messages by reason before the BUSY check. Emit on EVERY tick including total===0.
		const suppressedCounts: Record<string, number> = {
			acked: 0, dead_letter: 0, superseded: 0, task_done: 0, task_failed: 0, task_cancelled: 0,
			node_terminal: 0, node_reassigned: 0, task_missing: 0, node_missing: 0,
			wrong_recipient: 0, retrigger_budget_exhausted: 0, informational_already_consumed: 0,
		};
		const allMsgs = (await readMailboxCached(p, "orchestrator")).slice(-PUMP_SCAN_WINDOW);
		for (const m of allMsgs) {
			const rec = st.messages[m.id];
			if (!rec || rec.to !== "orchestrator") continue;
			if (st.consumerReceipts?.orchestrator?.entries?.[m.id]) { suppressedCounts.informational_already_consumed++; continue; }
			if (rec.requiresAck === false && (rec.surfacedAt || deliveredOrch.has(m.id))) { suppressedCounts.informational_already_consumed++; continue; }
			if (surfaced.has(m.id)) continue; // not suppressed - already surfaced this session
			const v = isActionableOrchestratorMessage(rec, taskIndex, nowMs, retriggerCounts, false);
			if (!v.ok) {
				const key = v.reason === "retrigger_budget_exhausted" ? "retrigger_budget_exhausted" : v.reason;
				suppressedCounts[key] = (suppressedCounts[key] || 0) + 1;
				if (key === "node_reassigned" || key === "node_terminal" || key === "task_done" || key === "task_failed" || key === "task_cancelled" || key === "task_missing" || key === "node_missing") {
					await traceStaleSuppressedOnce(p, "orchestrator_pump.surface", {
						messageId: m.id,
						idempotencyKey: rec.idempotencyKey || m.idempotencyKey || null,
						reason: key,
						evidence: [key],
					});
				}
			}
		}
		const totalSuppressed = Object.values(suppressedCounts).reduce((a, b) => a + b, 0);
		await trace(p, "notification.batch.suppressed", {
			ts: nowMs,
			cid: String(process.pid),
			reason: "per-tick baseline",
			total: totalSuppressed,
			counts: suppressedCounts,
		}).catch(() => {});

		// BUSY: defer entirely. Do NOT surface, do NOT mark surfaced, do NOT deliver a dead followUp. A
		// followUp delivered while busy carries no triggerTurn, so it lands in context without prompting the
		// LLM to act; the old code still marked it "surfaced", which made every later idle pump (incl.
		// agent_settled) skip it forever — the loop-nudge-stuck-at-awaiting_plan bug. Deferring keeps the
		// message un-marked so the next idle pump (session_start / agent_settled / 5s interval) re-reads it
		// and delivers it WITH a real triggerTurn. It also stops queuing followUps that can themselves keep
		// isIdle() false (a secondary cause of the orchestrator never waking).
		//
		// STUCK-BUSY ESCALATION: ctx.isIdle() can stay false indefinitely while pi has a queued
		// continuation / auto-retry pending (e.g. provider 429 backoff, auto-compaction retry) even
		// though the orchestrator is swarm-idle (heartbeat says idle, nothing is running). Without an
		// escape hatch the deferral above is unbounded: messages pile up until the human intervenes
		// (Esc/reload) — the observed "messages only arrive when I press /reload" bug. When the oldest
		// never-displayed message has waited longer than PUMP_STUCK_DEFER_ESCALATE_MS while busy, surface
		// it with an explicit steer: steering interrupts the queued continuation and starts a fresh turn,
		// which is exactly the operator-mandated behavior for stale deferrals.
		const neverDisplayedBusy = windowMsgs.filter((m) => !surfaced.has(m.id));
		const oldestWaitMs = neverDisplayedBusy.length
			? nowMs - new Date(neverDisplayedBusy.map((m) => st.messages[m.id]?.createdAt || m.createdAt).sort()[0] || nowMs).getTime()
			: 0;
		if (!idleAtStart && oldestWaitMs < PUMP_STUCK_DEFER_ESCALATE_MS) {
			keepalive();
			if (neverDisplayedBusy.length) {
				await trace(p, "mailbox.orchestrator_pump_deferred", {
					reason, queued: neverDisplayedBusy.length, oldestWaitMs: Math.round(oldestWaitMs),
					thresholdMs: PUMP_STUCK_DEFER_ESCALATE_MS, cid: String(process.pid), sid: process.env.PI_SESSION_ID ?? null,
				});
			}
			await writeState(p, st);
			return { toSurface: [] as SwarmMessage[], retriggered: 0 };
		}
		const escalateStuck = !idleAtStart && oldestWaitMs >= PUMP_STUCK_DEFER_ESCALATE_MS;
		if (escalateStuck) {
			await trace(p, "mailbox.orchestrator_pump_stuck_escalated", {
				reason, queued: neverDisplayedBusy.length, oldestWaitMs: Math.round(oldestWaitMs),
				thresholdMs: PUMP_STUCK_DEFER_ESCALATE_MS, cid: String(process.pid), sid: process.env.PI_SESSION_ID ?? null,
			});
		}

		// IDLE: we can fire a real turn.
		// (1) Messages never displayed to this pid (highest priority — fresh work).
		// (2) Action-expected (requiresAck) messages already surfaced+triggered but still unacked and overdue
		//     (bounded re-trigger). Informational (requiresAck:false) messages are NOT re-triggered: a single
		//     triggered delivery already prompted the orchestrator once, which is sufficient.
		const neverDisplayed = windowMsgs.filter((m) => !surfaced.has(m.id));
		const overdueRetrigger = windowMsgs.filter((m) => {
			if (!surfaced.has(m.id)) return false;
			const rec = st.messages[m.id];
			if (!rec?.requiresAck || rec.ackedAt) return false;
			const last = triggeredAt[m.id];
			if (!last) return false;
			if (nowMs - new Date(last).getTime() < PUMP_RETRIGGER_DELAY_MS) return false;
			return (retriggerCount[m.id] ?? 0) < PUMP_RETRIGGER_MAX;
		});
		const surfaceCandidates = [...neverDisplayed, ...overdueRetrigger].slice(0, 10);
		// Row 68: surface-time revalidation — deferred nudges are dropped if their stall condition no
		// longer holds (node assigned / agent busy / graph quieted / epoch advanced).
		// Coalesce repeated backlog messages by logical surface key before the final send decision so a
		// compacted / replaced session replays at most one freshest eligible notification per logical
		// action.
		const surfacePlan = [...surfaceCandidates].sort(compareSurfaceCandidates).reverse().map((msg) => {
			const rec = st.messages[msg.id] || msg;
			return { msg, rec, groupKey: orchestratorSurfaceGroupKey(rec) };
		});
		const coalesced = new Map<string, { msg: SwarmMessage; dropped: string[] }>();
		for (const item of surfacePlan) {
			const v = await staleSurfaceReason(p, st, item.msg, taskIndex, nowMs);
			if (v.stale) {
				await traceStaleSuppressedOnce(p, "orchestrator_pump.surface", {
					messageId: item.msg.id,
					idempotencyKey: String(item.rec.idempotencyKey || item.msg.idempotencyKey || ""),
					reason: v.reason,
					evidence: v.evidence,
				});
				continue;
			}
			const existing = coalesced.get(item.groupKey);
			if (!existing) {
				coalesced.set(item.groupKey, { msg: item.msg, dropped: [] });
				continue;
			}
			const existingTs = new Date((existing.msg as any).updatedAt || existing.msg.createdAt || 0).getTime();
			const incomingTs = new Date((item.msg as any).updatedAt || item.msg.createdAt || 0).getTime();
			if (incomingTs >= existingTs) {
				existing.dropped.push(existing.msg.id);
				existing.msg = item.msg;
			} else {
				existing.dropped.push(item.msg.id);
			}
		}
		for (const [groupKey, entry] of coalesced.entries()) {
			if (!entry.dropped.length) continue;
			await trace(p, "notification.coalesced.suppressed", {
				site: "orchestrator_pump.surface",
				groupKey,
				keptId: entry.msg.id,
				droppedIds: entry.dropped,
				count: entry.dropped.length,
			}).catch(() => {});
		}
		let toSurface = [...coalesced.values()].map((entry) => entry.msg).sort(compareSurfaceCandidates);
		const consumedSuppressedIds = new Set<string>();
		for (const entry of coalesced.values()) {
			for (const droppedId of entry.dropped) consumedSuppressedIds.add(droppedId);
		}
		if (consumedSuppressedIds.size) {
			const ts = now();
			if (!st.consumerReceipts) st.consumerReceipts = {};
			if (!st.consumerReceipts.orchestrator) st.consumerReceipts.orchestrator = { entries: {}, revision: 0 };
			if (!st.consumerReceipts.orchestrator.entries) st.consumerReceipts.orchestrator.entries = {};
			for (const id of consumedSuppressedIds) {
				const rec = st.messages[id];
				if (!rec || rec.to !== "orchestrator") continue;
				if (rec.requiresAck === false) {
					st.delivered.orchestrator = Array.from(new Set([...(st.delivered.orchestrator || []), id]));
					if (!rec.surfacedAt) {
						rec.surfacedAt = ts;
						rec.updatedAt = ts;
					}
					continue;
				}
				if (!st.consumerReceipts.orchestrator.entries[id]) {
					st.consumerReceipts.orchestrator.entries[id] = {
						surfacedAt: ts,
						requiresAck: true,
						conversationId: rec.conversationId,
						fingerprint: fingerprintMessage(rec),
					};
					st.consumerReceipts.orchestrator.revision = (st.consumerReceipts.orchestrator.revision || 0) + 1;
				}
			}
		}
		if (!toSurface.length) {
			keepalive();
			await writeState(p, st);
			return { toSurface: [] as SwarmMessage[], retriggered: 0 };
		}
		// Mark all surfaced now; stamp triggeredAt for every delivered message (the first gets triggerTurn,
		// the rest ride that turn's wake as followUp — both count as "triggered"). Increment retriggerCount
		// only for the overdue ones (a genuine re-prompt); first-time triggers stay at 0.
		const retriggerSet = new Set(overdueRetrigger.map((m) => m.id));
		for (const m of toSurface) {
			surfaced.add(m.id);
			triggeredAt[m.id] = new Date(nowMs).toISOString();
			if (retriggerSet.has(m.id)) retriggerCount[m.id] = (retriggerCount[m.id] ?? 0) + 1;
		}
		const nextIds = [...surfaced];
		sess.ids = nextIds.length > PUMP_SESSION_ID_CAP ? nextIds.slice(nextIds.length - PUMP_SESSION_ID_CAP) : nextIds;
		// Bound the maps the same way as ids (drop oldest beyond the cap) so a long-lived session cannot
		// grow unbounded.
		sess.triggeredAt = capMap(triggeredAt, PUMP_SESSION_ID_CAP);
		sess.retriggerCount = capMap(retriggerCount, PUMP_SESSION_ID_CAP);
		keepalive();
		await writeState(p, st);
		return { toSurface, retriggered: toSurface.filter((m) => retriggerSet.has(m.id)).length, escalatedStuck: escalateStuck };
	});
	const pending = result.toSurface;
	if (!pending.length) {
		if (ctx.mode === "tui") await trace(p, "mailbox.orchestrator_pump", { reason, count: 0, deferred: !idleAtStart ? 1 : 0, cid: String(process.pid), sid: process.env.PI_SESSION_ID ?? null, idleAtStart });
		return { delivered: 0, ids: [] as string[] };
	}
	// Delivery is TUI-only (session-bound APIs: pi.sendMessage/ctx.isIdle). In print/rpc/json mode,
	// the captured ctx is invalidated on session teardown and these throw "ctx is stale" errors.
	// The decision block above (readState/writeState/trace) runs in all modes to record surfacing
	// decisions without ctx usage.
	if (ctx.mode === "tui") {
		for (let i = 0; i < pending.length; i++) {
			const msg = pending[i];
			// Stuck-busy escalation path: steer (interrupt the queued continuation and start a fresh
			// turn) instead of triggerTurn — the engine is NOT idle, so a queued turn would never fire.
			const opts = result.escalatedStuck
				? { triggerTurn: true, deliverAs: "steer" as const }
				: (i === 0 ? { triggerTurn: true } : { deliverAs: "followUp" as const });
			pi.sendMessage({
				customType: "swarm-message",
				content: formatSwarmMessageContent(msg),
				display: true,
				details: msg,
			}, opts);
		}
		// Global-consume informational PM traffic ONLY AFTER a real TUI surface succeeded. This avoids
		// losing a message on stale-ctx/sendMessage failure while still preventing a later orchestrator
		// process from replaying historical requiresAck:false notices that were already shown once.
		const surfacedInfoIds = pending
			.filter((m) => m.requiresAck === false)
			.map((m) => m.id);
		// === Issue 11: Write durable consumer receipt entries (binding C4 + C10) ===
		// For action-expected messages, write a receipt entry so a reincarnated consumer knows it was
		// surfaced. Bump revision immediately after write. For informational messages, the legacy delivered
		// ledger remains authoritative (consumerReceipts only covers actionable).
		const surfacedActionIds = pending
			.filter((m) => m.requiresAck === true)
			.map((m) => m.id);
		if (surfacedInfoIds.length || surfacedActionIds.length) {
			await withLock(p, async () => {
				const st = await readState(p, ctx.cwd);
				const ts = now();
				// Legacy informational ledger (unchanged).
				if (surfacedInfoIds.length) {
					const ledgerIds = st.delivered.orchestrator || [];
					st.delivered.orchestrator = Array.from(new Set([...ledgerIds, ...surfacedInfoIds]));
				}
				// Durable consumer receipts for actionable messages.
				if (surfacedActionIds.length) {
					const entries = st.consumerReceipts!.orchestrator!.entries!;
					let bumped = false;
					for (const id of surfacedActionIds) {
						const rec = st.messages[id];
						if (!rec || rec.to !== "orchestrator" || rec.requiresAck !== true) continue;
						// Write receipt only if not already present (TUI delivery idempotence).
						if (entries[id]) continue;
						entries[id] = {
							surfacedAt: ts,
							ackedAt: rec.ackedAt,
							requiresAck: true,
							conversationId: rec.conversationId,
							fingerprint: fingerprintMessage(rec),
						};
						bumped = true;
						}
					// Bump revision immediately after entries mutation (binding C10).
					if (bumped) st.consumerReceipts!.orchestrator!.revision = (st.consumerReceipts!.orchestrator!.revision || 0) + 1;
				}
				// Legacy informational surfacedAt stamp (unchanged).
				for (const id of surfacedInfoIds) {
					const rec = st.messages[id];
					if (!rec || rec.to !== "orchestrator" || rec.requiresAck !== false || rec.surfacedAt) continue;
					rec.surfacedAt = ts;
					rec.updatedAt = ts;
				}
				await writeState(p, st);
			});
		}
		await trace(p, "mailbox.orchestrator_pump", { reason, count: pending.length, ids: pending.map((m) => m.id), retriggered: result.retriggered, informationalConsumed: surfacedInfoIds.length, cid: String(process.pid), sid: process.env.PI_SESSION_ID ?? null, idleAtStart });
	} else {
		// In non-TUI mode, still trace pump activity (without ctx.isIdle) for visibility.
		await trace(p, "mailbox.orchestrator_pump", { reason, count: pending.length, ids: pending.map((m) => m.id), cid: String(process.pid), sid: process.env.PI_SESSION_ID ?? null, mode: ctx.mode });
	}
	return { delivered: pending.length, ids: pending.map((m) => m.id) };
}

// Sweep task.json files for closure drift and stale/nudge signals. Mark-only by default: sets
// advisory node.staleAt, traces task.stale/task.nudge, and surfaces findings as actions. With
// mark=true it also persists the recomputed task.status (repairing stored/derived drift). It NEVER
// auto-fails a node or auto-sends reminder messages (keeps reconcile idempotent and storm-free);
// the PM summary + swarm_task_status make these signals visible without re-injection.
export async function reconcileTasks(pi: ExtensionAPI, p: Paths, st: SwarmState, options: { dryRun?: boolean; mark?: boolean; nowMs: number }): Promise<ReconcileAction[]> {
	const actions: ReconcileAction[] = [];
	if (!existsSync(p.tasksDir)) return actions;
	let entries: string[] = [];
	try { entries = await readdir(p.tasksDir); } catch { return actions; }
	for (const entry of entries) {
		const taskId = entry;
		const tp = taskPaths(p, taskId);
		if (!existsSync(tp.taskJson)) continue;
		let task: TaskState;
		try { task = await readTaskState(tp.taskJson); } catch { actions.push({ messageId: taskId, action: "task_skip", reason: `unreadable task.json for ${taskId}`, taskId }); continue; }
		let dirty = false;
		const storedClosed = task.status === "done" || task.status === "failed" || task.status === "cancelled";
		const derived = computeTaskStatus(task);
		// Drift detection. `cancelled` is orchestrator-explicit and sticky, so never overwrite it.
		if (!storedClosed && derived !== task.status && task.status !== "cancelled") {
			if (options.mark && !options.dryRun) {
				const prev = task.status;
				task.status = derived;
				task.updatedAt = now();
				dirty = true;
				actions.push({ messageId: taskId, action: "task_status_repaired", reason: `stored ${prev} -> derived ${derived}`, taskId });
				await traceTask(tp, "task.reconcile.repair", { taskId, prev, derived });
			} else {
				actions.push({ messageId: taskId, action: "task_status_drift", reason: `stored ${task.status} but nodes derive ${derived} (pass mark=true to repair)`, taskId });
			}
		}
		// Only non-terminal tasks can have live stale/nudge signals.
		if (storedClosed) continue;
		// Advisory ownership drift (issue 4): active leases with no stamped write scope (legacy tasks
		// predating the ownership policy) are readable and functional, but cannot participate in
		// overlap preflight reliably — report as advisory drift; never fabricate ownership metadata.
		for (const [nodeId, node] of Object.entries(task.nodes)) {
			if (node.status !== "assigned" && node.status !== "in_progress") continue;
			if (!node.activeAttemptId || !Array.isArray(node.attemptHistory)) {
				actions.push({ messageId: `${taskId}/${nodeId}`, action: "task_node_ownership_legacy", reason: `active node ${nodeId} has no attempt ownership metadata (legacy task; first new assignment bootstraps the lease schema)`, taskId, nodeId });
				continue;
			}
			const attempt = node.attemptHistory.find((a: any) => a.attemptId === node.activeAttemptId);
			if (attempt && attempt.status === "active" && !attempt.scope) {
				actions.push({ messageId: `${taskId}/${nodeId}`, action: "task_node_ownership_legacy", reason: `active attempt ${attempt.attemptId} has no stamped write scope (pre-policy lease; scope re-resolves live at preflight)`, taskId, nodeId });
			}
		}
		for (const [nodeId, node] of Object.entries(task.nodes)) {
			if (node.status !== "assigned" && node.status !== "in_progress") continue;
			const staleReasons: string[] = [];
			const nudgeReasons: string[] = [];
			const agent = node.assignee ? st.agents[node.assignee] : undefined;
			if (agent) {
				ensureAgentDefaults(agent);
				if (agent.status === "stopped" || agent.health === "unhealthy") staleReasons.push(`assignee ${agent.id} ${agent.status}/${agent.health}`);
				else if (agent.tmuxTarget && agent.tmuxTarget !== "unknown" && !(await isTmuxRunning(pi, agent.tmuxTarget))) staleReasons.push(`assignee ${agent.id} tmux pane not alive`);
			} else if (node.assignee && node.assignee !== "orchestrator") {
				staleReasons.push(`assignee ${node.assignee} missing from state`);
			}
			if (node.status === "in_progress" && node.lastActivityAt) {
				const age = options.nowMs - new Date(node.lastActivityAt).getTime();
				if (age > TASK_STALE_MS) staleReasons.push(`in_progress ${Math.round(age / 3_600_000)}h without update`);
				else if (age > TASK_NUDGE_MS) nudgeReasons.push(`in_progress ${Math.round(age / 60_000)}min without update`);
			}
			for (const msgId of node.messageIds || []) {
				const rec = st.messages[msgId];
				if (!rec) { staleReasons.push(`references missing message ${msgId}`); continue; }
				if (rec.status === "dead_letter") staleReasons.push(`assignment message ${msgId} dead-lettered`);
				else if (rec.requiresAck && !rec.ackedAt && !st.consumerReceipts?.orchestrator?.entries?.[msgId]) {
					const sinceMs = Math.max(rec.injectedAt ? new Date(rec.injectedAt).getTime() : 0, rec.interceptedAt ? new Date(rec.interceptedAt).getTime() : 0, rec.createdAt ? new Date(rec.createdAt).getTime() : 0);
					if (options.nowMs - sinceMs > ACK_MISSING_MS) nudgeReasons.push(`assignment message ${msgId} ack_missing`);
				}
			}
			if (!staleReasons.length && !nudgeReasons.length) {
				// Attention derivation (issue 5): report-only reminder eligibility. Reconcile NEVER sends;
				// the pointer names the one explicit orchestrator surface that can.
				const att = deriveNodeAttention(st, task, nodeId, options.nowMs);
				if (att.workerReminderEligible) {
					actions.push({ messageId: `${taskId}/${nodeId}`, action: "reminder_eligible", reason: `${att.evidence.join("; ")}; one bounded reminder may be sent via /swarm remind ${taskId} ${nodeId} (orchestrator-only, informational)`, taskId, nodeId });
				}
				continue;
			}
			if (staleReasons.length) {
				if (!options.dryRun && !node.staleAt) { node.staleAt = now(); dirty = true; await traceTask(tp, "task.stale.reconcile", { taskId, nodeId, assignee: node.assignee, reasons: staleReasons }); }
				actions.push({ messageId: `${taskId}/${nodeId}`, action: "task_node_stale", reason: staleReasons.join("; "), taskId, nodeId });
			} else {
				if (!options.dryRun) await traceTask(tp, "task.nudge", { taskId, nodeId, assignee: node.assignee, reasons: nudgeReasons });
				actions.push({ messageId: `${taskId}/${nodeId}`, action: "task_node_nudge", reason: nudgeReasons.join("; "), taskId, nodeId });
			}
		}
		if (!options.dryRun && dirty) await writeTaskState(tp, task);
	}
	return actions;
}

export async function reconcile(pi: ExtensionAPI, cwd: string, p: Paths, options: { agentId?: string; dryRun?: boolean; mark?: boolean }) {
	const result = await withLock(p, async () => {
		const st = await readState(p, cwd);
		if (options.mark) requireOrchestratorAuthority(currentAgentId(), "swarm_reconcile(mark=true)");
		const nowMs = Date.now();
		const actions: Array<{ messageId: string; action: string; reason: string }> = [];
		const targetAgentId = options.agentId ? safeId(options.agentId) : undefined;

		for (const [msgId, rec] of Object.entries(st.messages)) {
			if (rec.status === "dead_letter") continue;
			if (isResponseTrackingActive(rec) && rec.response?.status !== "verified" && rec.response?.status !== "waived") {
				const agent = st.agents[rec.to];
				if (!options.dryRun) {
					rec.response = { ...(rec.response || { status: "missing" as MessageResponseStatus }), status: rec.response?.status === "sent" ? "sent" : "missing", missingAt: rec.response?.missingAt || now(), lastError: `response_missing: awaiting verified result from ${rec.to}` };
					rec.updatedAt = now();
					if (agent && agent.runtimeStatus === "idle") { agent.runtimeStatus = "response_missing"; agent.updatedAt = now(); }
				}
				actions.push({ messageId: msgId, action: "response_missing", reason: `Message requires a verified response from ${rec.to}` });
				continue;
			}
			if (rec.status === "acked") continue;
			if (targetAgentId && rec.to !== targetAgentId) continue;
			if (rec.status !== "queued" && rec.status !== "failed" && rec.status !== "mailbox_delivered" && rec.status !== "injected" && rec.status !== "intercepted") continue;

			const ageMs = nowMs - new Date(rec.createdAt).getTime();
			const expired = rec.ttlMs !== undefined ? ageMs > rec.ttlMs : false;
			const maxAttempts = rec.attempts >= MAX_ATTEMPTS;
			const actionable = Boolean((rec.requiresAck && !rec.ackedAt) || (rec.requiresResponse && rec.response?.status !== "verified" && rec.response?.status !== "waived"));
			const agent = st.agents[rec.to];
			const hasTmuxPane = Boolean(agent?.tmuxTarget) && agent.tmuxTarget !== "unknown";
			const agentRunning = agent?.status === "running" && hasTmuxPane ? await isTmuxRunning(pi, agent.tmuxTarget!) : false;
			const mailboxOnly = Boolean(agent) && !hasTmuxPane;

			// === Issue 25 Phase 2: gate-aware deadline sweep (proposal §C, plan §2.6(a)) ===
			// Under gate=0: SHADOW-ONLY trace — never writes terminalAt (Phase 1 behavior, unchanged).
			// Under gate=1: AUTHORITATIVE — stamps terminalAt/lifecycleStage/terminalReason via the
			// deriveLifecycleFromTrigger pure helper, emits TRACE_LIFECYCLE_DERIVED + the
			// consumer-facing TRACE_MESSAGE_ATTENTION_DERIVED. NEVER increments attempts;
			// NEVER dead-letters (proposal §C binding — the deadline sweep is a scheduler, not an
			// enforcer); NEVER overwrites a pre-existing terminalAt. Runs INSIDE the same withLock
			// the reconcile tick already holds — no nested lock.
			if (!options.dryRun && typeof rec.responseDeadlineMs === "number" && rec.responseDeadlineMs > 0 && ageMs > rec.responseDeadlineMs && !rec.terminalAt) {
				if (PI_SWARM_MINIMAL_PROTOCOL === 1) {
					const d = deriveLifecycleFromTrigger(rec, { kind: "deadline_exceeded", deadlineMs: rec.responseDeadlineMs });
					if (d.kind === "set") {
						rec.terminalAt = d.value;
						rec.terminalReason = d.reason;
						rec.lifecycleStage = d.stage;
						rec.lifecycleSource = d.source;
						rec.updatedAt = now();
						await trace(p, TRACE_LIFECYCLE_DERIVED, {
							messageId: msgId, from: rec.from, to: rec.to,
							field: d.field, source: d.source, stage: d.stage,
							deadlineMs: rec.responseDeadlineMs, ageMs,
							gate: 1, reason: d.reason,
							via: "reconcile.deadline_sweep",
						});
						// Consumer-facing attention category (proposal §K.2): distinct from the
						// per-message lifecycle trace so dashboards can subscribe to a category
						// instead of parsing per-message traces.
						await trace(p, TRACE_MESSAGE_ATTENTION_DERIVED, {
							messageId: msgId, source: "responseDeadlineMs", gate: 1,
							ts: now(), proposal: "§K.2",
						}).catch(() => {});
					}
				} else {
					// Gate=0: shadow trace only (Phase 1 behavior, unchanged).
					await trace(p, TRACE_LIFECYCLE_DERIVED_SHADOW, {
						messageId: msgId,
						from: rec.from,
						to: rec.to,
						field: "terminalAt",
						source: "responseDeadlineMs",
						stage: "terminal",
						deadlineMs: rec.responseDeadlineMs,
						ageMs,
						shadow: true,
						gate: 0,
						reason: "response deadline exceeded; reconciled in shadow-only mode under gate=0",
					});
				}
			}

			if (expired && actionable && !maxAttempts) {
				if (!options.dryRun) await trace(p, "reconcile.ttl.defer_actionable", { id: msgId, to: rec.to, ageMs, ttlMs: rec.ttlMs, requiresAck: rec.requiresAck, requiresResponse: rec.requiresResponse });
				actions.push({ messageId: msgId, action: "ttl_stale", reason: `TTL expired but message is still actionable; awaiting explicit resolve from ${rec.to}` });
				continue;
			}

			if (expired || maxAttempts) {
				if (!options.dryRun) {
					upsertMessageRecord(st, { id: msgId, swarmId: st.swarmId, from: rec.from, to: rec.to, priority: "normal", type: "swarm.message" as const, schemaVersion: 1, createdAt: rec.createdAt, body: "", headers: {}, requiresAck: rec.requiresAck, ttlMs: rec.ttlMs }, "dead_letter", { failedAt: now(), lastError: expired ? "TTL expired" : "Max attempts exceeded" });
					await trace(p, "reconcile.dead_letter", { id: msgId, to: rec.to, reason: expired ? "ttl_expired" : "max_attempts", attempts: rec.attempts, ageMs });
				}
				actions.push({ messageId: msgId, action: "dead_letter", reason: expired ? "TTL expired" : "Max attempts exceeded" });
				continue;
			}

			// Only re-inject genuine delivery failures (recipient never acknowledged). An acked-failed
			// message (status "failed" WITH lastAck) is terminal and must NOT be re-injected, or it loops.
			if (isDeliveryFailureRetryable(rec) && agentRunning) {
				if (!options.dryRun) {
					const msg = await readMailbox(p, rec.to).then((msgs) => msgs.find((m) => m.id === msgId));
					if (msg) {
						const delivery = await deliver(pi, p, st, msg);
						if (delivery?.delivered) {
							st.delivered[rec.to] = Array.from(new Set([...(st.delivered[rec.to] || []), msgId]));
							upsertMessageRecord(st, msg, "injected", { injectedAt: now(), attempts: rec.attempts + 1 });
							await trace(p, "reconcile.retry.ok", { id: msgId, to: rec.to, attempts: rec.attempts + 1 });
							actions.push({ messageId: msgId, action: "retried", reason: "Agent running, injection successful" });
						} else {
							upsertMessageRecord(st, msg, "failed", { failedAt: now(), attempts: rec.attempts + 1, lastError: delivery?.reason || "Injection failed" });
							await trace(p, "reconcile.retry.failed", { id: msgId, to: rec.to, attempts: rec.attempts + 1, error: delivery?.reason });
							actions.push({ messageId: msgId, action: "retry_failed", reason: delivery?.reason || "Injection failed" });
						}
					} else {
						await trace(p, "reconcile.skip", { id: msgId, to: rec.to, reason: "Message not found in mailbox" });
						actions.push({ messageId: msgId, action: "skipped", reason: "Message not found in mailbox" });
					}
				} else {
					actions.push({ messageId: msgId, action: "would_retry", reason: "Agent running (dry run)" });
				}
				continue;
			}

			// Same guard: an already-acknowledged message is not pending delivery, so do not stage it for
			// mailbox/pending re-delivery. See isDeliveryFailureRetryable.
			if (isDeliveryFailureRetryable(rec) && !agentRunning) {
				if (mailboxOnly) {
					if (!options.dryRun) {
						upsertMessageRecord(st, { id: msgId, swarmId: st.swarmId, from: rec.from, to: rec.to, priority: "normal", type: "swarm.message" as const, schemaVersion: 1, createdAt: rec.createdAt, body: "", headers: {}, requiresAck: rec.requiresAck, ttlMs: rec.ttlMs }, "mailbox_delivered", { lastError: undefined });
						await trace(p, "reconcile.mailbox_delivered", { id: msgId, to: rec.to, previousStatus: rec.status });
					}
					actions.push({ messageId: msgId, action: options.dryRun ? "would_mark_mailbox_delivered" : "mailbox_delivered", reason: `Recipient ${rec.to} is mailbox-only (no tmux pane); message awaits swarm_check_mailbox` });
				} else {
					actions.push({ messageId: msgId, action: "pending", reason: "Recipient agent not running" });
				}
				continue;
			}

			if ((rec.status === "mailbox_delivered" || rec.status === "injected" || rec.status === "intercepted") && !rec.ackedAt) {
				if (!rec.requiresAck) continue;
				// Consider the most recent delivery timestamp. Previously this only checked injectedAt, so
				// `intercepted` messages (which set interceptedAt, not injectedAt) were never detected as stale.
				const sinceMs = Math.max(
					rec.injectedAt ? new Date(rec.injectedAt).getTime() : 0,
					rec.interceptedAt ? new Date(rec.interceptedAt).getTime() : 0,
					rec.lastAck?.at ? new Date(rec.lastAck.at).getTime() : 0,
					rec.createdAt ? new Date(rec.createdAt).getTime() : 0,
				);
				const deliveredAge = nowMs - sinceMs;
				const staleThreshold = 300_000; // 5 minutes
				if (deliveredAge > staleThreshold) {
					// Issue A: an injected-but-unacked message was previously only marked ack_missing and NEVER
					// re-delivered — a message injected into a pane that pi never processed (crash, missed turn,
					// pane-alive-but-shell per issue D) was silently lost. Now: bounded re-injection (MAX_REINJECTS)
					// when the recipient's pane is alive AND pi-like, with a cooldown (REINJECT_AFTER_MS) since the
					// last delivery so an agent actively working isn't spammed. Delivery staleness keeps being
					// surfaced as ack_missing either way; attempts are NOT bumped (dead-lettering stays TTL-driven).
					const reinjects = rec.reinjects || 0;
					const sinceLast = Math.max(
						rec.lastReinjectAt ? new Date(rec.lastReinjectAt).getTime() : 0,
						sinceMs,
					);
					const cooldownOk = nowMs - sinceLast > REINJECT_AFTER_MS;
					let reinjected = false;
					if (!options.dryRun && cooldownOk && reinjects < MAX_REINJECTS && !rec.superseded) {
						const reinjectAgent = st.agents[rec.to];
						const hasPane = Boolean(reinjectAgent?.tmuxTarget) && reinjectAgent!.tmuxTarget !== "unknown";
						const alive = hasPane && reinjectAgent?.status === "running" ? await isTmuxRunning(pi, reinjectAgent!.tmuxTarget!) : false;
						const piLike = alive ? await isPanePiLike(pi, reinjectAgent!.tmuxTarget!) : { piLike: false, command: "" };
						if (alive && piLike.piLike) {
							const msg = await readMailbox(p, rec.to).then((msgs) => msgs.find((m) => m.id === msgId));
							if (msg) {
								const delivery = await deliver(pi, p, st, msg);
								if (delivery?.delivered && !delivery.mailboxOnly) {
									reinjected = true;
									st.delivered[rec.to] = Array.from(new Set([...(st.delivered[rec.to] || []), msgId]));
									upsertMessageRecord(st, msg, "injected", { injectedAt: now(), reinjects: reinjects + 1, lastReinjectAt: now() });
									await trace(p, "reconcile.reinject.ok", { id: msgId, to: rec.to, reinjects: reinjects + 1, deliveredAge });
								} else {
									await trace(p, "reconcile.reinject.skip", { id: msgId, to: rec.to, reason: delivery?.reason || "no message" });
								}
							} else {
								await trace(p, "reconcile.reinject.skip", { id: msgId, to: rec.to, reason: "Message not found in mailbox" });
							}
						} else if (alive && !piLike.piLike) {
							await trace(p, "reconcile.reinject.skip", { id: msgId, to: rec.to, reason: `pane alive but not pi (pane_current_command=${piLike.command || "?"})` });
						}
					}
					if (!options.dryRun) {
						// Surface as ack_missing: keep the injected/intercepted status intact so this is NOT
						// confused with a delivery failure (failed messages get re-injected by the retry branch
						// above). Record a clear marker + trace so it shows up in swarm_agent_status /
						// swarm_message_status instead of silently lingering. Do not bump attempts here, so an
						// unacked-but-delivered message is not accidentally escalated to dead_letter by the
						// maxAttempts check; TTL still applies for eventual cleanup.
						upsertMessageRecord(
							st,
							{ id: msgId, swarmId: st.swarmId, from: rec.from, to: rec.to, priority: "normal", type: "swarm.message" as const, schemaVersion: 1, createdAt: rec.createdAt, body: "", headers: {}, requiresAck: rec.requiresAck, ttlMs: rec.ttlMs },
							rec.status,
							{ ackMissingAt: rec.ackMissingAt || now(), lastError: `ack_missing: delivered ${Math.round(deliveredAge / 1000)}s ago, no ack from ${rec.to}` },
						);
						await trace(p, "reconcile.ack_missing", { id: msgId, to: rec.to, deliveredAge, status: rec.status, requiresAck: rec.requiresAck });
					}
					actions.push({ messageId: msgId, action: reinjected ? "reinjected" : "ack_missing", reason: `Delivered ${Math.round(deliveredAge / 1000)}s ago, no ack from ${rec.to}${reinjected ? ` (re-injected, ${reinjects + 1}/${MAX_REINJECTS})` : reinjects >= MAX_REINJECTS ? " (re-inject budget exhausted)" : ""}` });
				} else {
					actions.push({ messageId: msgId, action: "awaiting_ack", reason: "Recently delivered, awaiting ack" });
				}
				continue;
			}
		}

		// Task sweep (WS-B.3/4): closure drift + stale/nudge signals, mark-only. Shares the lock so
		// task.json writes are consistent with swarm state. Ignored when scoped to a single agent's mail.
		const taskActions = options.agentId ? [] : await reconcileTasks(pi, p, st, { dryRun: options.dryRun, mark: options.mark, nowMs });
		const allActions = [...actions, ...taskActions];

		if (!options.dryRun) {
			await writeState(p, st);
		}
		return { actions: allActions, count: allActions.length, messageCount: actions.length, taskCount: taskActions.length, dryRun: Boolean(options.dryRun) };
	});
	await trace(p, "reconcile.complete", { agentId: options.agentId, dryRun: options.dryRun, mark: options.mark, result });
	return result;
}

// PM-facing swarm rollup for `/swarm status`. Bounded: scans up to MAX_STATUS_TASKS task.json
// files, prioritizing non-terminal tasks, and emits stable prefixed lines that are grep-able so
// the test lane can assert on tool output instead of eyeballing panes. Pane capture stays fallback.
export async function buildSwarmStatusSummary(p: Paths, st: SwarmState): Promise<{ text: string; details: Record<string, unknown> }> {
	const agents = Object.values(st.agents);
	const byRuntime: Record<string, number> = {};
	const byHealth: Record<string, number> = {};
	let runningAgents = 0;
	for (const a of agents) {
		ensureAgentDefaults(a);
		byRuntime[a.runtimeStatus] = (byRuntime[a.runtimeStatus] || 0) + 1;
		byHealth[a.health] = (byHealth[a.health] || 0) + 1;
		if (a.status === "running") runningAgents++;
	}
	let ackMissing = 0;
	for (const rec of Object.values(st.messages)) {
		if (rec.requiresAck && !rec.ackedAt && rec.status !== "dead_letter" && rec.status !== "acked") ackMissing++;
	}

	const pmStatus = (task: TaskState): string => {
		if (task.status === "cancelled") return "cancelled";
		if (task.status === "done") return "done";
		if (task.status === "failed") return "failed";
		if (task.status === "blocked") return "blocked";
		if (Object.values(task.nodes).some((n) => n.staleAt)) return "stale";
		if (task.status === "in_progress") return "in_progress";
		return "open";
	};

	const taskLines: string[] = [];
	const byTaskStatus: Record<string, number> = {};
	let staleNodes = 0;
	let scanned = 0;
	if (existsSync(p.tasksDir)) {
		let entries: string[] = [];
		try { entries = await readdir(p.tasksDir); } catch { entries = []; }
		// Read all (bounded), then surface non-terminal tasks first so the operator sees live work.
		const read: Array<{ task: TaskState; pm: string }> = [];
		for (const entry of entries) {
			if (scanned >= MAX_STATUS_TASKS) break;
			const tp = taskPaths(p, entry);
			if (!existsSync(tp.taskJson)) continue;
			scanned++;
			try {
				const task = await readTaskState(tp.taskJson);
				read.push({ task, pm: pmStatus(task) });
			} catch { /* skip unreadable */ }
		}
		read.sort((a, b) => (a.pm === "done" || a.pm === "failed" || a.pm === "cancelled" ? 1 : 0) - (b.pm === "done" || b.pm === "failed" || b.pm === "cancelled" ? 1 : 0));
		for (const { task, pm } of read) {
			byTaskStatus[pm] = (byTaskStatus[pm] || 0) + 1;
			let unacked = 0;
			for (const node of Object.values(task.nodes)) {
				if (node.staleAt) staleNodes++;
				for (const msgId of node.messageIds || []) { const rec = st.messages[msgId]; if (rec && rec.requiresAck && !rec.ackedAt) unacked++; }
			}
			const { ready, current } = computeReadyNodes(task);
			taskLines.push(`task ${task.taskId} ${pm} current=[${current.join(",") || "-"}] next=[${ready.join(",") || "-"}] unacked=${unacked}`);
		}
	}
	const closureLine = `closure: ${byTaskStatus["done"] || 0} done, ${byTaskStatus["in_progress"] || 0} in_progress, ${(byTaskStatus["blocked"] || 0) + (byTaskStatus["stale"] || 0)} blocked/stale, ${byTaskStatus["failed"] || 0} failed`;
	const lines = [
		`swarm ${st.swarmId}: ${runningAgents}/${agents.length} agents running, tmux ${st.tmuxSession}`,
		`agents by runtime: ${Object.entries(byRuntime).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
		`agents by health: ${Object.entries(byHealth).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
		`tasks: ${scanned} scanned, ${Object.entries(byTaskStatus).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}; staleNodes=${staleNodes}; ackMissing=${ackMissing}`,
		st.goal ? `goal: ${st.goal.id} interval=${resolveGoalNudgeIntervalMs(st.goal.nudgeIntervalMs)}ms nudges=${st.goal.consecutiveNoResolveNudges}/${MAX_CONSECUTIVE_NUDGES_DEFAULT}` : `goal: none`,
		closureLine,
		...taskLines,
	];
	return { text: lines.join("\n"), details: { swarmId: st.swarmId, runningAgents, totalAgents: agents.length, byRuntime, byHealth, tasksScanned: scanned, byTaskStatus, staleNodes, ackMissing, closure: closureLine, taskLines } };
}

// Deterministic, indexed task list shared by `/swarm tasks` and the no-arg / number forms of
// `/swarm graph|task|next|validate`. Sort is stable (createdAt asc, taskId tiebreak) so a number
// the operator just saw in the list resolves to the SAME task on the next call. Bounded by
// MAX_STATUS_TASKS so a huge task dir can't stall the command.
export async function listTasksIndexed(p: Paths): Promise<IndexedTask[]> {
	if (!existsSync(p.tasksDir)) return [];
	let entries: string[] = [];
	try { entries = await readdir(p.tasksDir); } catch { return []; }
	const out: IndexedTask[] = [];
	for (const entry of entries) {
		if (out.length >= MAX_STATUS_TASKS) break;
		const tp = taskPaths(p, entry);
		if (!existsSync(tp.taskJson)) continue;
		let task: TaskState;
		try { task = await readTaskState(tp.taskJson); } catch { continue; }
		const { ready, current } = computeReadyNodes(task);
		const total = Object.keys(task.nodes).length;
		const done = Object.values(task.nodes).filter((n) => n.status === "done").length;
		out.push({ index: 0, taskId: task.taskId, task, tp, status: task.status, title: task.title, createdAt: task.createdAt, updatedAt: task.updatedAt, ready, current, done, total });
	}
	out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.taskId < b.taskId ? -1 : 1));
	out.forEach((t, i) => (t.index = i + 1));
	return out;
}

export function renderTasksIndexedList(list: IndexedTask[]): string {
	if (!list.length) return "No tasks found. Create one with swarm_create_task (or have the orchestrator plan one).";
	const lines: string[] = [`Tasks (${list.length}) — pick by # or task-id:  /swarm graph|task|next|validate <#|task-id>`];
	lines.push("  #  task-id                                 status       age   updated          nodes    current → next");
	for (const t of list) {
		const cur = t.current.join(",") || "-";
		const nxt = t.ready.join(",") || "-";
		const updated = t.updatedAt ? t.updatedAt.slice(5, 16).replace("T", " ") : "?          ";
		lines.push(`  ${String(t.index).padStart(2)}  ${t.taskId.padEnd(40)} ${t.status.padEnd(12)} ${humanAge(t.updatedAt).padStart(4)}  ${updated}  ${String(t.done)}/${String(t.total).padEnd(3)}    ${cur} → ${nxt}`);
	}
	return lines.join("\n");
}

// Resolve a user-supplied task reference: a bare number = list index; otherwise exact then prefix
// task-id match (so uuid, full id, or a unique prefix all work). Returns the matched task plus the
// full list so callers can re-render the list with a hint on miss/ambiguity.
export async function resolveTaskArg(p: Paths, arg?: string): Promise<{ hit?: IndexedTask; list: IndexedTask[]; missReason?: string; ambiguous?: string[] }> {
	const list = await listTasksIndexed(p);
	const trim = (arg || "").trim();
	if (!trim) return { list, missReason: "no task reference given" };
	if (/^\d+$/.test(trim)) {
		const idx = parseInt(trim, 10);
		const hit = list[idx - 1];
		if (hit) return { hit, list };
		return { list, missReason: `no task at index ${idx} (have 1..${list.length})` };
	}
	const norm = safeId(trim);
	const exact = list.find((t) => t.taskId === trim || safeId(t.taskId) === norm);
	if (exact) return { hit: exact, list };
	// Substring (not just prefix): task-ids share a long "task-swarm-..." stem, so a distinctive
	// fragment like "dashboard", "iteration-demo", or "uat" should match. Multiple hits -> ambiguous.
	const sub = list.filter((t) => t.taskId.includes(trim) || safeId(t.taskId).includes(norm));
	if (sub.length === 1) return { hit: sub[0], list };
	if (sub.length > 1) return { list, ambiguous: sub.map((t) => t.taskId) };
	return { list, missReason: `no task matches "${trim}"` };
}
