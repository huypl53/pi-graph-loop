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
import { logSwarmError, expected } from "../errorlog.ts";
import {
	agentHeartbeatGCLocked,
	evaluateArtifactProgressNudgeLocked,
	evaluateIdleAgentGcNudgeLocked,
	evaluateSlotRecoveryLocked,
	evaluateTaskGraphStallNudgeLocked,
	evaluateTasklessWorkerNudgeLocked,
	reconcileGraphAdvanceLocked,
	reconcileInitialReadyLocked,
} from "../nudges/graph-advance.ts";
import { evaluateIdleGoalNudgeLocked, updateIdleEpochLocked } from "../nudges/goal-epoch.ts";
import { proxyMetricEmitLocked, staleOpenAssignmentScanLocked, staleOpenNudgeLocked } from "../taskgraph.ts";
import { observeLinkedTaskLocked, autoContinueCompletedRunLocked } from "../issues/controller.ts";

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
	// sweepTaskWorkersLocked pass picks them up. Lease-valid (reuse) and paused
	// agents are exempt. Idempotent across ticks.
	try {
		await agentHeartbeatGCLocked(pi, ctx.cwd, p, st, nowMs);
	} catch (err: any) {
		await trace(p, "agent.heartbeat_gc.error", { reason, error: String((err as Error)?.message || err) }).catch(() => {});
	}
	// === Idle-agent GC nudge (idle-agent-gc plan, 2026-10-13) [restart-required pump phase] ===
	// Runs AFTER heartbeat GC: freshly-flipped stopped records are excluded by status; only
	// still-running idle workers are nudged about. The root is NUDGED — it decides and calls
	// swarm_stop_agent itself; there is no auto-kill path. Cooldown/cap/throttle are enforced
	// inside the evaluator; task-graph reference gating uses the same closure the stopped purge
	// uses (isTaskReferenced). Task-graph reads: bounded to the same loadTaskGraphsForGc scan the
	// auto-GC uses — but only when the scan actually runs (interval-gated inside the evaluator),
	// so the common tick pays zero extra file IO: the eligibility pre-scan below skips the load
	// when no candidate exists.
	try {
		const hasRunningIdleCandidate = Object.values(st.agents).some(
			(a) =>
				a.id !== "root" &&
				a.status === "running" &&
				a.runtimeStatus === "idle" &&
				!a.paused &&
				(a.activeTaskIds || []).length === 0,
		);
		if (hasRunningIdleCandidate) {
			const { loadTaskGraphsForGc } = await import("../agent-gc-io.ts");
			const taskGraphs = await loadTaskGraphsForGc(p);
			await evaluateIdleAgentGcNudgeLocked(pi, ctx.cwd, p, st, nowMs, taskGraphs);
		} else {
			// Still advance the scan throttle so the next real scan is interval-spaced from now.
			await evaluateIdleAgentGcNudgeLocked(pi, ctx.cwd, p, st, nowMs, []);
		}
	} catch (err: any) {
		await trace(p, "agent.idle_gc.error", { reason, error: String((err as Error)?.message || err) }).catch(() => {});
	}
	// === Stage D — taskless-worker detector [restart-required pump phase] ===
	// Runs AFTER idle-agent GC: detects running workers with no task-graph assignment past grace.
	try {
		const hasRunningTasklessCandidate = Object.values(st.agents).some(
			(a) => a.id !== "root" && a.status === "running" && !a.paused && (a.activeTaskIds || []).length === 0,
		);
		if (hasRunningTasklessCandidate) {
			const { loadTaskGraphsForGc } = await import("../agent-gc-io.ts");
			const taskGraphs = await loadTaskGraphsForGc(p);
			await evaluateTasklessWorkerNudgeLocked(pi, ctx.cwd, p, st, nowMs, taskGraphs);
		} else {
			await evaluateTasklessWorkerNudgeLocked(pi, ctx.cwd, p, st, nowMs, []);
		}
	} catch (err: any) {
		await logSwarmError(p, "surface", "taskless_worker.scan_failed", err, { reason });
		await trace(p, "agent.taskless.error", { reason, error: String((err as Error)?.message || err) }).catch(() => {});
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
	// === D5 (plan 2026-10-14 §1.4): probe-round due wake ===
	// When an agent's probe round exhausted (every configured slot failed once), the durable
	// nextProbeAt fences further probes until due (earliest cooldown, ≤ benchMaxMs — D4). At
	// due time, wake the agent ONCE with the existing minimal continuation shape so the next
	// turn's failure re-opens a FRESH round (advanceProbeRound sees due passed) instead of the
	// pool sitting dark until an operator pokes it. Exactly-one across ticks AND reloads via
	// wakeSentAt stamped durably BEFORE the L2 send (R10: same pattern as the goal nudge).
	// R10-1: this is a NEW pi.sendMessage call site by design — it IS the designated root-pump
	// wake owner for D5; the static grep guard in the lane test pins it to exactly this site.
	try {
		await evaluateProbeRoundWakeLocked(pi, ctx, p, st, nowMs);
	} catch (err: any) {
		await trace(p, "pool.probe_round_wake.error", { error: String((err as Error)?.message || err) }).catch(() => {});
	}
	// === swarm-issues Phase 3b (fix P0-A): single idempotent issue-run tick ===
	// The plan's reconcileIssueRunTick design, piggybacked on this existing in-lock phase
	// runner (NO new timers/intervals). Reads the active linked task's durable task.json once
	// and hands terminal statuses to observeLinkedTaskLocked (which enforces provenance,
	// safe-idle, freeze silence, and idempotent replays internally). Inactive/running-with-no-
	// active runs are no-ops; non-issue swarms pay one getIssueRun check per tick.
	// R10-1: no new pi.sendMessage call sites — notices stay on deliverMessageLocked (L1);
	// the root pump remains the only L2 boundary.
	try {
		const run = (st as any).issueRun;
		// b3-posthold (2026-10-01, incident run-mup15r16-epimos @ 04:50:25): a safe_idle_hold can
		// leave the run running with activeIssueId cleared and a done queue entry; the old
		// activeIssueId-only guard made the tick a permanent no-op (hang with no advance/notice).
		// Route that shape into observeLinkedTaskLocked's existing post-hold replay branch —
		// it re-checks computeSafeIdle internally (held runs stay untouched) and advancing
		// removes the done-entry precondition, so the replay is exactly-once.
		const postHoldOrphan = run?.status === "running" && !run.activeIssueId && (run.queue ?? []).some((q: any) => q.status === "done");
		if (postHoldOrphan) {
			const doneEntry = (run.queue ?? []).find((q: any) => q.status === "done");
			if (doneEntry?.taskId) {
				await observeLinkedTaskLocked(p, { cwd: ctx.cwd }, st, { taskId: doneEntry.taskId, status: "done" });
			}
		}
		if (run && (run.status === "running" || run.status === "paused") && run.activeIssueId) {
			const { taskPaths, readTaskState } = await import("../state.ts");
			const entry = (run.queue ?? []).find((q: any) => q.issueId === run.activeIssueId);
			if (entry?.taskId) {
				// absent task.json (never linked / pre-creation) is the expected probe miss (ENOENT);
				// anything else routes to the durable error log (no silent swallow)
				let ts: any = null;
				try {
					ts = await readTaskState(taskPaths(p, entry.taskId).taskJson);
				} catch (err: any) {
					if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
						void expected("linked_task_json_not_yet_created");
					} else {
						await logSwarmError(p, "surface", "issues.tick_task_read_failed", err, { taskId: entry.taskId });
					}
				}
				if (ts) {
					const statuses = new Set<string>();
					if (ts.status === "done" || ts.status === "failed" || ts.status === "cancelled") statuses.add(ts.status);
					else {
						const nodeStatuses = Object.values(ts.nodes ?? {}).map((n: any) => n?.status);
						if (nodeStatuses.length > 0 && nodeStatuses.every((s) => s === "done")) statuses.add("done");
						if (nodeStatuses.some((s) => s === "blocked")) statuses.add("blocked");
						if (nodeStatuses.some((s) => s === "failed")) statuses.add("failed");
						if (nodeStatuses.some((s) => s === "cancelled")) statuses.add("cancelled");
					}
					const terminal = statuses.has("done")
						? "done"
						: statuses.has("blocked")
							? "blocked"
							: statuses.has("failed")
								? "failed"
								: statuses.has("cancelled")
									? "cancelled"
									: undefined;
					if (terminal) {
						await observeLinkedTaskLocked(p, { cwd: ctx.cwd }, st, { taskId: entry.taskId, status: terminal });
					}
				}
			}
		}
	} catch (err: any) {
		await logSwarmError(p, "surface", "issues.tick_failed", err, { reason });
	}
	// Opt-in cross-run continuation is evaluated inside the same pump lock after issue observation.
	try {
		if ((st as any).issueRun?.status === "complete" && (st as any).issueRun?.runId)
			await autoContinueCompletedRunLocked(p, { cwd: ctx.cwd }, st, { pi });
	} catch (err: unknown) {
		await logSwarmError(p, "surface", "issues.auto_continue_failed", err, { reason });
	}
	// === footer-status (2026-10-01): advisory issue-run line after the issues tick phase ===
	// L3 visible surface (contract §1); hasUI-guarded, never throws into the tick.
	try {
		const { setIssueFooter } = await import("../issues/footer.ts");
		await setIssueFooter(pi, ctx, st, p);
	} catch (err: any) {
		await logSwarmError(p, "surface", "issues.footer_failed", err, { reason });
	}
}

// === D5 (§1.4): probe-round due wake evaluator (runs INSIDE the pump's withLock — Locked suffix) ===
// For each agent with an exhausted probe round whose nextProbeAt has come due and no wake was
// sent yet: stamp wakeSentAt durably, then send exactly ONE hidden continuation
// (customType "swarm-message", triggerTurn) so the agent retries and re-opens a fresh round.
// Bounded: one wake per exhausted round (wakeSentAt fence survives reload); the fresh round's
// exhaustion re-arms it. Non-root agents get the same wake via their own pump-less path — the
// root pump sends to the AGENT's pane through pi only when the agent IS this session; for
// workers in other panes the wake rides the mailbox continuation below (no-op here).
export async function evaluateProbeRoundWakeLocked(pi: ExtensionAPI, ctx: any, p: Paths, st: SwarmState, nowMs: number) {
	const rounds = st.poolProbeRounds ?? {};
	let dirty = false;
	// Persist happens once at the end (writeState) — the pump already holds the state lock here
	// (Locked suffix contract), and the in-memory st is the caller's shared object, so the
	// stamp survives even if the write fails only via the next tick's re-read-and-retry.
	for (const [agentId, round] of Object.entries(rounds)) {
		if (!round?.exhaustedAt || !round.nextProbeAt || round.wakeSentAt) continue;
		const dueMs = new Date(round.nextProbeAt).getTime();
		if (!Number.isFinite(dueMs) || nowMs < dueMs) continue;
		// Stamp durably FIRST (crash after stamp but before send sacrifices one wake — never
		// duplicates it; the same trade advanceProbeRound makes for triedSlots).
		round.wakeSentAt = new Date(nowMs).toISOString();
		dirty = true;
		await trace(p, "pool.probe_round_wake", {
			agentId,
			roundId: round.roundId,
			nextProbeAt: round.nextProbeAt,
			lateMs: Math.max(0, nowMs - dueMs),
		}).catch(() => {});
		// L2 wake: exactly one per exhausted round. The root session sends to ITSELF
		// (idle-gated triggerTurn); the D5 contract row (pi-runtime-contract §10, R-D5) pins
		// this as the single wake boundary.
		if (agentId === "root") {
			pi.sendMessage(
				{ customType: "swarm-message", content: "Continue your current task.", display: false },
				ctx?.isIdle && typeof ctx.isIdle === "function" && ctx.isIdle()
					? { triggerTurn: true }
					: { deliverAs: "followUp", triggerTurn: true },
			);
		} else {
			// Workers: deliver through the durable mailbox (L1) so the worker's own pump-less
			// session surfaces it on its next turn boundary; no direct pane injection from root.
			const { deliverMessageLocked } = await import("../mailbox.ts");
			await deliverMessageLocked(pi, ctx?.cwd ?? st.cwd, p, st, {
				to: agentId,
				subject: "Pool probe round due — retry now",
				body: `Your model-pool probe round (id ${round.roundId}) exhausted earlier; the next-probe deadline (${round.nextProbeAt}) has passed. Retry your current task now so the pool can open a fresh probe round and find a serving model.`,
				idempotencyKey: `probe-wake-${round.roundId}`,
			}).catch((err: any) => {
				logSwarmError(p, "surface", "probe_round_wake_delivery_failed", err, { agentId });
			});
		}
	}
	if (dirty) {
		const { writeState } = await import("../state.ts");
		await writeState(p, st).catch((err: any) => logSwarmError(p, "surface", "probe_round_wake_write_failed", err));
	}
	return dirty;
}
