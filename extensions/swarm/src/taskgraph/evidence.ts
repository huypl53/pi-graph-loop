// === swarm/taskgraph/evidence.ts — proxy metrics, commit evidence, auto-close root nodes ===
// Extracted from taskgraph.ts (Phase 6 real split).

import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
	DEFAULT_AGENT_HEARTBEAT_STALE_MS,
	DEFAULT_STALE_OPEN_THRESHOLD_MS,
	PI_SWARM_PROXY_METRIC_INTERVAL_MS,
	TRACE_PROXY_METRIC_EMIT,
} from "../constants.ts";
import type { Paths, SwarmState, TaskPaths, TaskState } from "../types.ts";
import { ensureAgentDefaults, inferRoleKind, now } from "../utils.ts";
import { expected, logSwarmError } from "../errorlog.ts";
import { paths, readTaskState, taskPaths, trace } from "../state.ts";
import { computeReadyNodes, hasOutgoingTaskEdge, isGraphTerminalNode } from "./graph.ts";

// === Issue 83c — proxy metric emit (pump-tick phase) ===
// Cheap, read-only snapshot of the stale-open / hung-but-alive / supersession surface.
// The pump calls this AFTER stale-open scanning and BEFORE nudges so the snapshot reflects
// the current tick's repairs. Emission is bounded by PI_SWARM_PROXY_METRIC_INTERVAL_MS and
// is idempotent within the interval: repeated calls only refresh the in-memory snapshot.

export async function proxyMetricEmitLocked(
	p: Paths,
	st: SwarmState,
	nowMs: number,
): Promise<{
	emitted: boolean;
	reason: string;
	metrics: { hungButAlive: number; staleOpen: number; supersessionChurn: number; lastEmitAt?: string };
}> {
	const intervalMs = Number(process.env.PI_SWARM_PROXY_METRIC_INTERVAL_MS ?? PI_SWARM_PROXY_METRIC_INTERVAL_MS);
	const thresholdMs = Number(process.env.PI_SWARM_STALE_OPEN_THRESHOLD_MS ?? DEFAULT_STALE_OPEN_THRESHOLD_MS);
	const heartbeatStaleMs = DEFAULT_AGENT_HEARTBEAT_STALE_MS;
	const metrics = (st.proxyMetrics ||= { hungButAlive: 0, staleOpen: 0, supersessionChurn: 0 });
	const lastEmitMs = metrics.lastEmitAt ? new Date(metrics.lastEmitAt).getTime() : 0;
	if (lastEmitMs && nowMs - lastEmitMs < intervalMs) {
		return { emitted: false, reason: "interval_pending", metrics: { ...metrics } };
	}
	let staleOpen = 0;
	let supersessionChurn = 0;
	const hungCandidates = new Set<string>();
	if (existsSync(p.tasksDir)) {
		let taskDirs: string[] = [];
		try {
			taskDirs = await readdir(p.tasksDir);
		} catch (err: any) {
			// ENOENT: fresh project, nothing to scan (expected). Anything else is diagnosable.
			if (err?.code !== "ENOENT") {
				await logSwarmError(p, "taskgraph", "liveness.readdir_failed", err);
			}
			taskDirs = [];
		}
		for (const taskDir of taskDirs) {
			const tp = taskPaths(p, taskDir);
			if (!existsSync(tp.taskJson)) continue;
			let task: TaskState;
			try {
				task = await readTaskState(tp.taskJson);
			} catch (err: any) {
				if (err?.code !== "ENOENT") {
					await logSwarmError(p, "taskgraph", "liveness.task_unreadable", err, { taskDir });
				}
				continue;
			}
			for (const node of Object.values(task.nodes)) {
				if (!node || (node.status !== "assigned" && node.status !== "in_progress")) continue;
				const lastProgressMs = node.lastProgressAt ? new Date(node.lastProgressAt).getTime() : 0;
				const lastActivityMs = node.lastActivityAt ? new Date(node.lastActivityAt).getTime() : 0;
				const anchorMs = Math.max(lastProgressMs, lastActivityMs);
				const staleAtMs = anchorMs ? nowMs - anchorMs : Number.POSITIVE_INFINITY;
				if (staleAtMs > thresholdMs) {
					staleOpen++;
					if (node.assignee) hungCandidates.add(node.assignee);
				}
				const windowStartMs = node.supersessionWindowStart ? new Date(node.supersessionWindowStart).getTime() : 0;
				if (node.supersessionCount && windowStartMs && nowMs - windowStartMs <= intervalMs)
					supersessionChurn += node.supersessionCount;
			}
		}
	}
	let hungButAlive = 0;
	for (const agentId of hungCandidates) {
		const agent = st.agents[agentId];
		if (!agent) continue;
		ensureAgentDefaults(agent);
		if (agent.status !== "running" || agent.runtimeStatus !== "idle") continue;
		const hbMs = agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt).getTime() : 0;
		if (!hbMs || nowMs - hbMs > heartbeatStaleMs) continue;
		if ((agent.activeTaskIds?.length ?? 0) === 0) continue;
		hungButAlive++;
	}
	metrics.hungButAlive = hungButAlive;
	metrics.staleOpen = staleOpen;
	metrics.supersessionChurn = supersessionChurn;
	metrics.lastEmitAt = new Date(nowMs).toISOString();
	await trace(p, TRACE_PROXY_METRIC_EMIT, {
		emitAt: metrics.lastEmitAt,
		hungButAlive,
		staleOpen,
		supersessionChurn,
		intervalMs,
		thresholdMs,
		heartbeatStaleMs,
	}).catch(() => {});
	return { emitted: true, reason: "emitted", metrics: { ...metrics } };
}

// Apply gate updates { gateName: { status, by?, artifact? } }. `by` defaults to the acting agent.

export async function resolveCommitNodeEvidence(
	pi: { exec: (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ code: number; stdout?: string; stderr?: string }> },
	tp: TaskPaths,
	cwd?: string,
) {
	let baseline = "";
	try {
		baseline = readFileSync(join(tp.root, "baseline.txt"), "utf8").trim();
	} catch {
		// Expected branch: baseline not captured (task created before baseline writes existed).
		expected("baseline_absent_promotion_gate_reports");
		return { verified: false as const, reason: "baseline_missing" as const };
	}
	if (!baseline) return { verified: false as const, baseline, reason: "baseline_empty" as const };
	try {
		const r = await pi.exec("git", ["rev-parse", "HEAD"], { timeout: 5000 });
		if (r.code !== 0) {
			await logSwarmError(
				cwd || process.cwd(),
				"taskgraph",
				"evidence.git_exec_failed",
				new Error(`git rev-parse exited ${r.code}`),
				{
					taskId: basename(tp.root),
				},
			);
			return { verified: false as const, baseline, reason: "git_unavailable" as const, head: (r.stdout || "").trim() || undefined };
		}
		const head = (r.stdout || "").trim();
		if (!head) return { verified: false as const, baseline, reason: "head_empty" as const };
		if (head === baseline) return { verified: false as const, baseline, head, reason: "head_matches_baseline" as const };
		return { verified: true as const, baseline, head };
	} catch (err: any) {
		await logSwarmError(cwd || process.cwd(), "taskgraph", "evidence.git_exec_failed", err, { taskId: basename(tp.root) });
		return { verified: false as const, baseline, reason: `git_error:${String(err?.message || err)}` as const };
	}
}

// Build the assignment message body. Carries task/node pointers, scope, artifacts, and reply target
// so the assignee discovers the rest from durable files instead of a long root prompt.
export function readCommitEvidence(task: TaskState) {
	const evidence = task.evidence as Record<string, any> | undefined;
	if (!evidence) return undefined;
	for (const [nodeId, node] of Object.entries(task.nodes || {})) {
		if (inferRoleKind(nodeId, node.role) === "root" && isGraphTerminalNode(task, nodeId)) {
			const ev = evidence[nodeId];
			if (ev && typeof ev === "object") return ev;
		}
	}
	if (evidence.commit && typeof evidence.commit === "object") return evidence.commit;
	return undefined;
}

export async function autoCloseRootTerminalNodes(
	pi: { exec: (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ code: number; stdout?: string; stderr?: string }> },
	tp: TaskPaths,
	task: TaskState,
	cwd?: string,
) {
	const closed: string[] = [];
	for (;;) {
		const { ready } = computeReadyNodes(task);
		const candidate = ready.find((nodeId) => {
			const node = task.nodes[nodeId];
			return node && node.status === "pending" && inferRoleKind(nodeId, node.role) === "root" && isGraphTerminalNode(task, nodeId);
		});
		if (!candidate) break;
		const node = task.nodes[candidate];
		// Row 75 (fix): gate ANY terminal root-kind node (role text matching root
		// OR id prefixed with commit/finalize/ship/etc.) on real git evidence, not just id === "commit".
		// Otherwise custom graphs whose commit-step is named "finalize" / "commit-changes" / "ship"
		// bypass the evidence check and auto-close without verification — the same defect AC4 was
		// meant to kill, resurfacing through the naming door. Evidence is keyed by node id only;
		// the legacy `.commit` surface reads through the per-node key for back-compat.
		const isCommitLike = inferRoleKind(candidate, node.role) === "root" && isGraphTerminalNode(task, candidate);
		if (isCommitLike) {
			const evidence = await resolveCommitNodeEvidence(pi, tp, cwd);
			const record = {
				status: evidence.verified ? "verified" : "unverified",
				reason: evidence.reason,
				baseline: evidence.baseline,
				head: evidence.head,
				at: now(),
				nodeId: candidate,
			};
			task.evidence[candidate] = record;
			if (!evidence.verified) {
				// Leave the node pending for the root to close deliberately after running git itself.
				break;
			}
		}
		node.assignee ||= "root";
		node.status = "done";
		node.lastActivityAt = now();
		closed.push(candidate);
	}
	return { closed };
}
