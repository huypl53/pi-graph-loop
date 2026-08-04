// === swarm/reconcile.ts — auto-extracted from index.ts (verbatim bodies) ===
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, appendFile, rm, stat, rename, readdir, realpath } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import type { IndexedTask, MessageResponseStatus, Paths, ReconcileAction, SwarmMessage, SwarmState, TaskState } from "./types.ts";
import { ACK_MISSING_MS, LOOP_RECONCILE_INTERVAL_MS, MAX_ATTEMPTS, MAX_STATUS_TASKS, PUMP_RETRIGGER_DELAY_MS, PUMP_RETRIGGER_MAX, PUMP_SCAN_WINDOW, PUMP_SESSION_ID_CAP, PUMP_SESSION_TTL_MS, TASK_NUDGE_MS, TASK_STALE_MS, TERMINAL_NODE_STATUSES } from "./constants.ts";
import { capMap, ensureAgentDefaults, humanAge, inferRoleKind, now, safeId } from "./utils.ts";
import { computeReadyNodes, computeTaskStatus } from "./taskgraph.ts";
import { currentAgentId } from "./session.ts";
import { deliver, deliverMessageLocked, readMailbox, upsertMessageRecord } from "./mailbox.ts";
import { ensureOrchestrator } from "./identity.ts";
import { formatSwarmMessageContent, isDeliveryFailureRetryable } from "./delivery.ts";
import { isTmuxRunning, tmux } from "./tmux.ts";
import { readState, readTaskState, taskPaths, trace, traceTask, withLock, writeState, writeTaskState } from "./state.ts";
import { ackLoopNudgeLocked, reconcileLoopNudgesLocked } from "./loop.ts";

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
async function sendGraphAdvanceNudgeLocked(pi: ExtensionAPI, cwd: string, p: Paths, st: SwarmState, taskId: string, nodeId: string, role: string): Promise<void> {
	const key = `task:${taskId}:node:${nodeId}:nudge:assign`;
	if (Object.values(st.messages || {}).some((r) => r.to === "orchestrator" && r.idempotencyKey === key)) return; // idempotent: one assign nudge per node
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

// Watcher entry point for mid-graph stalls. For every active (in_progress) task, find actionable nodes
// (ready but unassigned) and nudge; ack any outstanding assign nudge whose node is no longer stalled.
// Runs in the same throttled tick as the loop watcher. Read-only on task state (never assigns).
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
			const key = `task:${taskId}:node:${nodeId}:nudge:assign`;
			const node = task.nodes[nodeId];
			if (actionable.has(nodeId) && !node.assignee && !TERMINAL_NODE_STATUSES.has(node.status)) {
				await sendGraphAdvanceNudgeLocked(pi, cwd, p, st, taskId, nodeId, node.role || "worker");
			} else {
				// Node assigned / terminal / not yet ready -> clear any outstanding assign nudge for it.
				ackLoopNudgeLocked(st, key, nowMs, "auto-acked: node assigned/left ready");
			}
		}
	}
}

export async function pumpOrchestratorMailbox(pi: ExtensionAPI, ctx: any, p: Paths, reason: string) {
	if (currentAgentId() !== "orchestrator") return { delivered: 0, ids: [] as string[] };
	// Read idle once, up front. Non-TUI modes have no live agent loop to trigger, so they are treated as
	// "busy" — the file-IO surfacing decision still runs (for trace visibility) but no ctx-bound call is made.
	const idleAtStart = ctx.mode === "tui" ? ctx.isIdle() : false;
	const result = await withLock(p, async () => {
		const st = await readState(p, ctx.cwd);
		ensureOrchestrator(st, ctx.cwd, p);
		const nowMs = Date.now();
		// Prune dead sessions (not pumped within TTL) to bound growth from transient validation pids.
		for (const [k, v] of Object.entries(st.orchestratorPumpSessions!)) {
			if (k !== String(process.pid) && nowMs - new Date(v.lastAt).getTime() > PUMP_SESSION_TTL_MS) delete st.orchestratorPumpSessions![k];
		}
		// Harness-as-watcher: throttled loop reconcile — detect "plan recorded but task graph still closed"
		// (and auto-ack once reopened). Runs every tick but scans task.json files at most every
		// LOOP_RECONCILE_INTERVAL_MS. The harness never changes task/loop state; it only nudges the
		// orchestrator (an agent) to act. Placed before the mailbox read so freshly-created nudges surface
		// in the same tick.
		if (!st.lastLoopReconcileAt || nowMs - new Date(st.lastLoopReconcileAt).getTime() > LOOP_RECONCILE_INTERVAL_MS) {
			st.lastLoopReconcileAt = new Date(nowMs).toISOString();
			try { await reconcileLoopNudgesLocked(pi, ctx.cwd, p, st, nowMs); } catch (err: any) { await trace(p, "loop.reconcile_error", { error: String((err as Error)?.message || err) }).catch(() => {}); }
			// Mid-graph stall safety net: nudge the orchestrator to assign any ready-but-unassigned node in an
			// in_progress task (the loop watcher drives iteration boundaries; this drives the nodes in between).
			try { await reconcileGraphAdvanceLocked(pi, ctx.cwd, p, st, nowMs); } catch (err: any) { await trace(p, "graph.reconcile_error", { error: String((err as Error)?.message || err) }).catch(() => {}); }
		}
		const sess = orchSession(st, nowMs)!;
		const surfaced = new Set(sess.ids);
		const triggeredAt = { ...(sess.triggeredAt ?? {}) };
		const retriggerCount = { ...(sess.retriggerCount ?? {}) };
		const keepalive = () => { sess.lastAt = new Date(nowMs).toISOString(); };
		// Session-safe surfacing keying is unchanged (per-pid, not PI_SESSION_ID, so a validation run or a
		// second orchestrator lane cannot starve this PM process). Recent window bounds work; acked messages
		// (ackedAt = "recipient processed it") are skipped. We no longer pre-filter surfaced here: surfaced
		// vs triggered vs re-trigger is decided below, because surfacing must be gated on idle.
		const windowMsgs = (await readMailbox(p, "orchestrator"))
			.slice(-PUMP_SCAN_WINDOW)
			.filter((m) => !(st.messages[m.id]?.ackedAt));

		// BUSY: defer entirely. Do NOT surface, do NOT mark surfaced, do NOT deliver a dead followUp. A
		// followUp delivered while busy carries no triggerTurn, so it lands in context without prompting the
		// LLM to act; the old code still marked it "surfaced", which made every later idle pump (incl.
		// agent_settled) skip it forever — the loop-nudge-stuck-at-awaiting_plan bug. Deferring keeps the
		// message un-marked so the next idle pump (session_start / agent_settled / 5s interval) re-reads it
		// and delivers it WITH a real triggerTurn. It also stops queuing followUps that can themselves keep
		// isIdle() false (a secondary cause of the orchestrator never waking).
		if (!idleAtStart) {
			keepalive();
			await writeState(p, st);
			return { toSurface: [] as SwarmMessage[], retriggered: 0 };
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
		const toSurface = [...neverDisplayed, ...overdueRetrigger].slice(0, 10);
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
		return { toSurface, retriggered: toSurface.filter((m) => retriggerSet.has(m.id)).length };
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
			pi.sendMessage({
				customType: "swarm-message",
				content: formatSwarmMessageContent(msg),
				display: true,
				details: msg,
			}, i === 0 ? { triggerTurn: true } : { deliverAs: "followUp" });
		}
		await trace(p, "mailbox.orchestrator_pump", { reason, count: pending.length, ids: pending.map((m) => m.id), retriggered: result.retriggered, cid: String(process.pid), sid: process.env.PI_SESSION_ID ?? null, idleAtStart });
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
				else if (rec.requiresAck && !rec.ackedAt) {
					const sinceMs = Math.max(rec.injectedAt ? new Date(rec.injectedAt).getTime() : 0, rec.interceptedAt ? new Date(rec.interceptedAt).getTime() : 0, rec.createdAt ? new Date(rec.createdAt).getTime() : 0);
					if (options.nowMs - sinceMs > ACK_MISSING_MS) nudgeReasons.push(`assignment message ${msgId} ack_missing`);
				}
			}
			if (!staleReasons.length && !nudgeReasons.length) continue;
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
		const nowMs = Date.now();
		const actions: Array<{ messageId: string; action: string; reason: string }> = [];
		const targetAgentId = options.agentId ? safeId(options.agentId) : undefined;

		for (const [msgId, rec] of Object.entries(st.messages)) {
			if (rec.status === "dead_letter") continue;
			if (rec.requiresResponse && rec.status !== "queued" && rec.status !== "failed" && rec.response?.status !== "verified" && rec.response?.status !== "waived") {
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
			const agent = st.agents[rec.to];
			const hasTmuxPane = Boolean(agent?.tmuxTarget) && agent.tmuxTarget !== "unknown";
			const agentRunning = agent?.status === "running" && hasTmuxPane ? await isTmuxRunning(pi, agent.tmuxTarget!) : false;
			const mailboxOnly = Boolean(agent) && !hasTmuxPane;

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
					actions.push({ messageId: msgId, action: "ack_missing", reason: `Delivered ${Math.round(deliveredAge / 1000)}s ago, no ack from ${rec.to}` });
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
