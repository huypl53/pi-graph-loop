// === swarm/taskgraph/lifecycle.ts — node/task status transitions, attempt minting, gates ===
// Extracted from taskgraph.ts (Phase 6 real split).

import { randomBytes, randomUUID } from "node:crypto";
import { ALLOWED_NODE_TRANSITIONS, TERMINAL_NODE_STATUSES } from "../constants.ts";
import type { EffectiveScope } from "./scope.ts";
import type { Paths, SwarmState, TaskGateStatus, TaskNode, TaskNodeStatus, TaskPaths, TaskState, TaskStatus } from "../types.ts";
import { ensureAgentDefaults, now, safeId } from "../utils.ts";
import { trace, traceTask } from "../state.ts";
import { isGraphTerminalNode } from "./graph.ts";

export function isAllowedNodeTransition(from: TaskNodeStatus, to: TaskNodeStatus) {
	if (from === to) return true;
	if (TERMINAL_NODE_STATUSES.has(from)) return false;
	return Boolean(ALLOWED_NODE_TRANSITIONS[from]?.has(to));
}

// Release an agent's active-task pointer and advisory edit locks when a node reaches a terminal-ish
// state (done/failed/blocked/skipped/cancelled). activeTaskIds is task-granular; re-assignment re-adds it.
export function releaseNodeAssignment(st: SwarmState, task: TaskState, nodeId: string) {
	const node = task.nodes[nodeId];
	if (!node || !node.assignee) return;
	const isTerminalish =
		node.status === "done" ||
		node.status === "failed" ||
		node.status === "blocked" ||
		node.status === "skipped" ||
		node.status === "cancelled";
	if (!isTerminalish) return;
	const agent = st.agents[node.assignee];
	if (agent) {
		ensureAgentDefaults(agent);
		agent.activeTaskIds = agent.activeTaskIds.filter((t) => t !== task.taskId);
	}
	for (const [file, lock] of Object.entries(task.editLocks)) {
		if (lock?.nodeId === nodeId) delete task.editLocks[file];
	}
}

// True iff the task OR the named node is in the root-explicit cancelled state. Read-only;
// used by `swarm_update_task` and `swarm_send_message` to reject late mutations at the handler
// boundary before any state is touched. `nodeId` is optional; when omitted the task-level check runs.
// A cancelled task remains cancelled forever unless an root re-opens it (no automatic reopen
// path — re-open requires a deliberate swarm_update_task(force=true) + a separately-designed policy
// not in this PR).
export function isTaskOrNodeCancelled(task: TaskState, nodeId?: string): boolean {
	if (task.status === "cancelled") return true;
	if (!nodeId) return false;
	const node = task.nodes[nodeId];
	return Boolean(node && node.status === "cancelled");
}

// Derive the authoritative task status from node states. Closure is a deterministic consequence of
// the last node transition: failed if any node failed; done iff every graph-terminal node is
// done/skipped (and none failed); blocked if every active node is blocked; in_progress once any node
// has started; ready before that. `cancelled` is root-explicit and never auto-derived here;
// `cancelled` nodes are skipped from failed/done/blocked aggregations so cancellation does not infer
// semantic completion of the underlying work.
// Precedence matters: failed and done win over blocked (a task with a failed node reads "failed").
export function computeTaskStatus(task: TaskState): TaskStatus {
	const nodes = Object.values(task.nodes).filter((n) => n.status !== "cancelled");
	if (nodes.some((n) => n.status === "failed")) return "failed";
	const terminals = Object.keys(task.nodes)
		.filter((id) => isGraphTerminalNode(task, id) && task.nodes[id].status !== "cancelled")
		.map((id) => task.nodes[id]);
	// R11-2: `done` additionally requires that NO live assignment remains anywhere in the graph.
	// Graph-terminal completion alone is insufficient when a sub-task cycle re-arms an earlier node
	// (rework/reuse): a done terminal set + an assigned/in_progress/ready node must stay in_progress,
	// or the task-close worker sweep force-kills agents mid-assignment (6 kills, 2026-09-01).
	const liveAssignment = nodes.some((n) => n.status === "assigned" || n.status === "in_progress" || n.status === "ready");
	if (terminals.length && !liveAssignment && terminals.every((n) => n.status === "done" || n.status === "skipped")) return "done";
	// Task-level blocked: every active (non-terminal, non-pending) node is blocked => the task cannot
	// make progress. Pure (derived from node states, not the possibly-stale task.currentNodes); resumable
	// (a node leaving `blocked` returns the task to in_progress/done). Cancelled nodes are excluded.
	const active = nodes.filter(
		(n) => n.status === "ready" || n.status === "assigned" || n.status === "in_progress" || n.status === "blocked",
	);
	if (active.length > 0 && active.every((n) => n.status === "blocked")) return "blocked";
	const started = nodes.some(
		(n) =>
			n.status === "assigned" ||
			n.status === "in_progress" ||
			n.status === "blocked" ||
			n.status === "done" ||
			n.status === "failed" ||
			n.status === "skipped",
	);
	return started ? "in_progress" : "ready";
}

// Set task.status from node states unless the root explicitly cancelled it.
export function applyTaskStatus(task: TaskState): { changed: boolean; terminal: boolean } {
	if (task.status === "cancelled") return { changed: false, terminal: true };
	const prev = task.status;
	task.status = computeTaskStatus(task);
	const terminal = task.status === "done" || task.status === "failed" || task.status === "cancelled";
	return { changed: task.status !== prev, terminal };
}

// === Issue 24.a (B5) — mintNodeAttempt helper ===
// Consolidates the ~50 lines of attempt-mint logic previously inlined in `swarm_assign_task` so the
// new `claim` branch (and any future call site that legitimately hands a node to a worker) can mint
// or reuse attempts with one canonical implementation. The `reason` argument drives the trace
// observability and the duplicate-detection branch.
//
// Return shape:
//   - { attemptId, created: true }  — a fresh attempt was minted; prior active attempt (if any)
//     was superseded.
//   - { attemptId, created: false } — the SAME active-assignment was detected (same assignee +
//     same node + status:active attempt + non-new prevStatus). Existing attemptId is preserved so
//     duplicate assignment calls / delivery retries cannot fence the worker that already holds
//     the active token.
//
// MUST be called from inside the same `withLock(p)` the caller already holds; this helper mutates
// `node` in-place. Callers persist via writeTaskState + writeState (or equivalent) on success.
//
// `isNewAttempt` callers should compute it before calling this helper (the helper inspects
// `node` to decide, but the caller's prevStatus variable may be more up-to-date). The helper
// uses its own prevStatus probe as a defensive fallback.
export function mintNodeAttempt(args: { node: TaskNode; assignee: string; candidateScope: EffectiveScope; reason: "assign" | "claim" }): {
	attemptId: string;
	created: boolean;
} {
	const { node, assignee, candidateScope } = args;
	const prevStatus = node.status;
	// Detect same-active-assignment duplicates: same assignee + same node + active attempt + non-new
	// prevStatus. Mirrors the historical branch from swarm_assign_task so a duplicate retry never
	// mints or supersedes an attempt (preserves the existing attemptId for delivery retries).
	const activeAttemptRecord = node.activeAttemptId
		? node.attemptHistory?.find((a: any) => a.attemptId === node.activeAttemptId)
		: undefined;
	const sameActiveAssignment =
		prevStatus !== "pending" &&
		prevStatus !== "ready" &&
		prevStatus !== "blocked" &&
		node.assignee === assignee &&
		activeAttemptRecord &&
		activeAttemptRecord.status === "active";
	if (sameActiveAssignment) {
		activeAttemptRecord!.lastActivityAt = now();
		return { attemptId: activeAttemptRecord!.attemptId, created: false };
	}
	// Genuine (re)assignment: mint a fresh attempt identity.
	const attemptId = safeId(`attempt-${Date.now().toString(36)}-${randomBytesLike()}`);
	const ts = now();
	// Supersede prior active attempt (if any) before minting the new one.
	if (node.activeAttemptId && node.attemptHistory) {
		const priorAttempt = node.attemptHistory.find((a: any) => a.attemptId === node.activeAttemptId);
		if (priorAttempt && priorAttempt.status === "active") {
			priorAttempt.status = "superseded";
			priorAttempt.supersededAt = ts;
			priorAttempt.supersededBy = attemptId;
			priorAttempt.releasedAt ||= ts;
			priorAttempt.releaseReason = "reassign";
		}
	}
	const newAttempt = {
		attemptId,
		attemptNumber: node.attempts,
		assignmentMessageId: "", // filled by caller after message delivery
		assignee,
		assignedAt: ts,
		status: "active" as const,
		lastActivityAt: ts,
		// Stamp the effective write scope at assignment time so ownership preflight + audits see what
		// this lease actually held. Unresolved inheritance is NOT stamped: absent scope makes later
		// scans re-resolve live (which returns unresolved => conservatively overlapping), never a fake
		// empty scope. Mirrors the canonical swarm_assign_task inline logic.
		...("unresolved" in candidateScope
			? {}
			: { scope: { source: candidateScope.source, sourceNodeId: candidateScope.sourceNodeId, files: candidateScope.files } }),
	};
	node.attemptHistory = [...(node.attemptHistory || []), newAttempt];
	node.activeAttemptId = attemptId;
	return { attemptId, created: true };
}

// Tiny helper: 8 random bytes hex, mirrors `randomBytes(8).toString("hex")` and reuses the
// `node:crypto` import already in scope.
function randomBytesLike(): string {
	return randomBytes(8).toString("hex");
}

// Remove a closed task from every agent's activeTaskIds (terminal bookkeeping cleanup).
export function releaseTaskFromAllAgents(st: SwarmState, taskId: string) {
	for (const a of Object.values(st.agents)) {
		ensureAgentDefaults(a);
		a.activeTaskIds = a.activeTaskIds.filter((t) => t !== taskId);
	}
}

// === Issue 26 — task-close worker sweep (auto-stop task-scoped workers) ===
// Stops every worker agent whose ONLY active assignment was the closing task, leaving the
// root, agents with other active tasks, paused agents, and `PI_SWARM_KEEP_TASK_WORKERS=1`
// opt-out untouched. Idempotent: a second invocation under the same withLock computes eligibility
// from current state, so a stale sweep finds nothing to do and emits ZERO per-agent traces.
//
// HARD RULES (enforced by the sweep, not by callers):
//   1. MUST run inside the same `withLock(p)` the caller already holds. Never acquire the swarm
//      lock from inside — the mkdir lock is non-reentrant and would deadlock.
//   2. NEVER stops an agent whose `activeTaskIds` includes a task other than the closing one.
//      Release evidence (the prior activeTaskIds) is stamped on the per-agent trace.
//   3. NEVER stops the root pseudo-agent (id === "root").
//   4. NEVER stops a paused agent (`agent.paused === true`).
//   5. Honored opt-out: `PI_SWARM_KEEP_TASK_WORKERS=1` short-circuits the whole sweep (no traces).
//   6. `spawnedForTaskId` link: if set to the closing taskId, the agent is swept even when it
//      has zero remaining active tasks (it was FRESHLY SPAWNED for this task). Reuse-pool agents
//      without the link are only swept when their only active task was the closing task.
//
// Stops via the existing `stopAgent` lock-free core (`force: true, killPane: true`). Mailbox,
// identity, history persist via the stable agent id (existing semantics — no record removal).
//
// Returns the list of stopped agent ids so callers can include it in tool output; empty array
// means "no eligible workers" (most common path: cross-task agents / paused / opt-out).

export function ensureNodeActivityStamp(task: TaskState, nodeId: string, tsIso: string, workerAgentId?: string): boolean {
	const node = task.nodes[nodeId];
	if (!node) return false;
	if (node.status !== "assigned" && node.status !== "in_progress") return false;
	if (workerAgentId && node.assignee !== workerAgentId) return false;
	node.lastProgressAt = tsIso;
	// Reset the stale-open surface cycle: progress cancels any prior surface so the next stale
	// period starts fresh.
	delete node.staleOpenSurfacedAt;
	return true;
}

// === Issue 83a — stale-open assignment scan (pump-tick phase) ===
// Cost bound (R10-1): each scan tick does 1 `readdirSync(p.tasksDir)` + 1 `readTaskState` per
// `task-*` subdirectory under the existing pump `withLock`. ZERO tmux probes, ZERO subprocess
// calls. The bound is the count of task files on disk; for a 100-task graveyard shape that is
// ~100 file reads per ~5 s tick (no interval gate yet; future PI_SWARM_STALE_OPEN_SCAN_INTERVAL_MS
// is a follow-up). The scan is wrapped in `try { ... } catch { ... }` so a single tick failure
// does not crash the pump; errors surface via the standard `trace()` events.

export function applyGateUpdates(
	task: TaskState,
	gateUpdates: Record<string, { status: TaskGateStatus; by?: string; artifact?: string | null }>,
	by: string,
) {
	const ts = now();
	for (const [name, upd] of Object.entries(gateUpdates)) {
		const prev = task.gates[name] || { status: "open" as TaskGateStatus, by: null as string | null, artifact: null as string | null };
		task.gates[name] = { status: upd.status, by: upd.by || by, artifact: upd.artifact !== undefined ? upd.artifact : prev.artifact };
	}
	return ts;
}

// Append durable shared-context updates (decisions/risks/openQuestions get generated ids + by/at).
export function applySharedContextUpdates(
	task: TaskState,
	upd: {
		summary?: string;
		decisions?: Array<{ text: string; severity?: string }>;
		risks?: Array<{ text: string; severity?: string }>;
		openQuestions?: Array<{ text: string }>;
	},
	by: string,
) {
	const ts = now();
	const ctx = task.sharedContext;
	if (upd.summary) ctx.summary = upd.summary;
	for (const d of upd.decisions || []) ctx.decisions.push({ id: `decision-${randomUUID().slice(0, 8)}`, by, at: ts, text: d.text });
	for (const r of upd.risks || [])
		ctx.risks.push({ id: `risk-${randomUUID().slice(0, 8)}`, by, at: ts, severity: r.severity, text: r.text, status: "open" });
	for (const q of upd.openQuestions || [])
		ctx.openQuestions.push({ id: `question-${randomUUID().slice(0, 8)}`, by, at: ts, text: q.text });
}

export async function failTaskTool(
	tp: TaskPaths | null,
	p: Paths,
	code: string,
	message: string,
	details: Record<string, unknown>,
): Promise<never> {
	const body = JSON.stringify({ ok: false, errorCode: code, message, ...details }, null, 2);
	const traceData = { code, taskId: details.taskId, nodeId: details.nodeId, received: details.received };
	if (tp) await traceTask(tp, "task.tool.invalid", traceData);
	else await trace(p, "task.tool.invalid", traceData);
	const err = new Error(`${code}: ${message}\n${body}`);
	(err as any).errorCode = code;
	// Attach details as enumerable props (minus ok) so callers/tests can read structured fields.
	for (const [k, v] of Object.entries(details)) if (k !== "ok") (err as any)[k] = v;
	throw err;
}

// === Issue 83a — progress stamp helper (production entry point, called from hooks.ts:tool_execution_end) ===
// Stamps `node.lastProgressAt` when a worker (the assignee) emits a forward-progress signal:
//   - tool_execution_end (the worker is making tool calls)
//   - swarm_update_task forward transitions (in tools/tasks.ts) — not yet wired; see plan-deviations §
// Only stamps when `assignee === workerAgentId` AND status is `assigned` or `in_progress`. Returns
// true when the stamp landed (callers use this for instrumentation: 1 stamp per dirty task).
