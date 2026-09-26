// === swarm/surface/pump-phases.ts — in-lock pump maintenance phases (Phase 7) ===
// Extracted verbatim from surface/pump.ts (Phase 7 split of ../surface.ts).
//
// runPumpMaintenancePhasesLocked executes the ordered per-tick maintenance phases inside the
// pump's existing withLock (no nested lock acquisition):
//   1. Issue 82: heartbeat-driven agent GC (graveyard sweep, tmux probe gated)
//   2. Issue 83a: stale-open assignment scan + per-node root nudges
//   3. Issue 83c: proxy metric snapshot
//   4. Graph-advance + initial-ready stall safety nets
//   5. Row 68: shared idle-epoch maintenance + Issue 23/18 nudge evaluators (graph-first)
//   6. R20 artifact-progress self-nudge + Issue 21 slot recovery scan
// Every phase is individually try/caught so one failure never kills the tick; failures are
// recorded via trace(...) (choke-point-protected) — never swallowed silently.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Paths, SwarmState } from "../types.ts";
import { trace } from "../state.ts";
import { logSwarmError } from "../errorlog.ts";
import {
	agentHeartbeatGCLocked,
	evaluateArtifactProgressNudgeLocked,
	evaluateSlotRecoveryLocked,
	evaluateTaskGraphStallNudgeLocked,
	reconcileGraphAdvanceLocked,
	reconcileInitialReadyLocked,
} from "../nudges/graph-advance.ts";
import { evaluateIdleGoalNudgeLocked, updateIdleEpochLocked } from "../nudges/goal-epoch.ts";
import { proxyMetricEmitLocked, staleOpenAssignmentScanLocked, staleOpenNudgeLocked } from "../taskgraph.ts";

export async function runPumpMaintenancePhasesLocked(
	pi: ExtensionAPI,
	ctx: any,
	p: Paths,
	st: SwarmState,
	nowMs: number,
	reason: string,
): Promise<void> {
	const rootBusy = typeof ctx?.isIdle === "function" ? !ctx.isIdle() : false;
	// === Issue 82: heartbeat-driven agent GC pass (P0, R9 a3 graveyard) ===
	// Runs inside the existing pump withLock (no nested lock acquisition). Bounded cost:
	// O(N) over agents for the cheap heartbeat gate; tmux probe fires only when an agent's
	// heartbeat is older than 2× the stale window. Auto-flips `status` from "running" to
	// "stopped" for agents whose tmux pane is known-dead or freshly probed dead, so the next
	// sweepTaskWorkersLocked / swarm_prune picks them up. Lease-valid (reuse) and paused
	// agents are exempt. Idempotent across ticks.
	try {
		await agentHeartbeatGCLocked(pi, ctx.cwd, p, st, nowMs);
	} catch (err: any) {
		await trace(p, "agent.heartbeat_gc.error", { reason, error: String((err as Error)?.message || err) }).catch(() => {});
	}
	// === Issue 83a — stale-open assignment scan [R10-3 restart-required pump phase] ===
	// Pump phase: `staleOpenAssignmentScanLocked` (called from `pumpRootMailbox`).
	// Runs after heartbeat GC (so freshly-stopped agents are excluded by status) and before the
	// graph-stall safety net (so a freshly-stale-open node does not double-fire the graph-advance
	// nudge). R10-1 cost-bound: per-tick readdir of tasks dir + readTaskState per task under
	// pump lock; no subprocess/tmux. The bound is N+1 file reads per tick where N = count of
	// `task-*` subdirs; ZERO tmux subprocess calls. Surfacing is TRACE-ONLY: no root
	// mailbox nudge is sent (the plan's nudge was consciously dropped; pre-existing stall
	// nudge machinery still nudges on stalled nodes). Throws are wrapped in try/catch so a
	// scan failure never kills the tick.
	try {
		const r = await staleOpenAssignmentScanLocked(p, st, nowMs);
		// R11-1 completion: surface → nudge. Every FRESHLY surfaced node gets one high-priority
		// root nudge (capped/cooled-down inside). Trace-only surfacing left the swarm
		// idling for hours with staleOpen>0 and nobody told.
		for (const n of r.surfacedNodes || []) {
			try {
				await staleOpenNudgeLocked(pi, ctx.cwd, p, st, n.taskId, n.nodeId);
			} catch (err) {
				// Per-node best-effort (never kills the tick) — but a nudge that persistently fails
				// means surfaced nodes never reach the root. Make it durable.
				await logSwarmError(p, "surface", "stale_open.nudge_failed", err, { taskId: n.taskId, nodeId: n.nodeId });
			}
		}
	} catch (err: any) {
		await trace(p, "stale_open.scan.error", { reason, error: String((err as Error)?.message || err) }).catch(() => {});
	}
	// === Issue 83c — proxy metric snapshot phase [restart-required pump phase] ===
	// Read-only, cheap snapshot of hung-but-alive residuals + stale-open count + supersession
	// churn. Bounded by PI_SWARM_PROXY_METRIC_INTERVAL_MS, and the snapshot is stored on
	// SwarmState.proxyMetrics for `/swarm status` / `/swarm metrics` to surface.
	try {
		await proxyMetricEmitLocked(p, st, nowMs);
	} catch (err: any) {
		await trace(p, "proxy.metric_emit.error", { reason, error: String((err as Error)?.message || err) }).catch(() => {});
	}
	// Mid-graph stall safety net: nudge the root to assign any ready-but-unassigned node in an
	// in_progress task. The nudge is idempotent, so it is safe to run on every pump tick.
	try {
		await reconcileGraphAdvanceLocked(pi, ctx.cwd, p, st, nowMs);
	} catch (err: any) {
		await trace(p, "graph.reconcile_error", { error: String((err as Error)?.message || err) }).catch(() => {});
	}
	// Fresh-task stall safety net: nudge the root when a start node is still ready + unassigned
	// past the creation grace period. Also idempotent + read-only on task state.
	try {
		await reconcileInitialReadyLocked(pi, ctx.cwd, p, st, nowMs);
	} catch (err: any) {
		await trace(p, "task.initial_ready_reconcile_error", { error: String((err as Error)?.message || err) }).catch(() => {});
	}
	// === Row 68: shared idle-epoch maintenance (once per tick, before both nudge evaluators) ===
	// Anchors the busy→all-idle edge at swarm level so BOTH nudge families measure continuous idle
	// from the same anchor regardless of evaluator call order or goal presence.
	try {
		await updateIdleEpochLocked(p, st, nowMs, rootBusy);
	} catch (err: any) {
		await trace(p, "idle.epoch.error", { error: String((err as Error)?.message || err) }).catch(() => {});
	}
	// === Issue 23: task-graph-state idle nudge (graph-first ordering) ===
	// Evaluated BEFORE the goal fallback (row 68 plan §4): the graph nudge is the immediate priority
	// when an unfinished graph has actionable unassigned work and all effective agents are idle; the
	// goal nudge is a fallback only for no-actionable-graph conditions. Each evaluator internally
	// suppresses on the other's condition, so a single cycle can never double-fire for the same
	// idle state. Each is wrapped in try/catch (matches the existing reconcile-helper pattern) so a
	// throw never kills the tick.
	try {
		await evaluateTaskGraphStallNudgeLocked(pi, ctx.cwd, p, st, nowMs, rootBusy);
	} catch (err: any) {
		await trace(p, "task_stall.nudge_error", { error: String((err as Error)?.message || err) }).catch(() => {});
	}
	// === Issue 18: goal idle-streak nudge (goal fallback, runs after the graph path) ===
	// When the root has set a goal, there is no actionable graph work, and every effective
	// agent has been continuously idle for the full interval, emit the goal fallback nudge. Anti-loop
	// counter + back-off handled inside the function.
	try {
		await evaluateIdleGoalNudgeLocked(pi, ctx.cwd, p, st, nowMs, rootBusy);
	} catch (err: any) {
		await trace(p, "goal.nudge.error", { error: String((err as Error)?.message || err) }).catch(() => {});
	}
	// === R20: artifact-progress self-nudge (Issue: settled idle with open assignment) ===
	// Pump-tick phase. Fires an action-oriented nudge to the AGENT itself (not the root)
	// when fs.stat detects a fresh write to a node's allowedFiles but the node is still open.
	// Companion to the existing root-facing stale-open nudge (which targets the PM,
	// not the worker). Wrapped in try/catch so a single tick failure never kills the pump.
	try {
		await evaluateArtifactProgressNudgeLocked(pi, ctx.cwd, p, st, nowMs);
	} catch (err: any) {
		await trace(p, "worker.artifact_progress_nudge_error", { error: String((err as Error)?.message || err) }).catch(() => {});
	}
	// === Issue 21: slot recovery scan ===
	// When a slot's bench naturally expires AND lastBenchReason === "quota" AND the agent on
	// that slot still has active task assignments, emit pool.slot_recovered. NO auto-resume;
	// the root decides. Idempotent under tick storms via lastRecoveredAt dedupe.
	try {
		await evaluateSlotRecoveryLocked(pi, ctx.cwd, p, st, nowMs);
	} catch (err: any) {
		await trace(p, "pool.slot_recovered.error", { error: String((err as Error)?.message || err) }).catch(() => {});
	}
}
