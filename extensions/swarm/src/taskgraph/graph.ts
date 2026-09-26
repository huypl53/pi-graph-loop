// === swarm/taskgraph/graph.ts — graph construction, validation, rework activation, readiness ===
// Extracted from taskgraph.ts (Phase 6 real split).

import { SAFE_ID_RE, TRACE_TASK_ATTEMPT_REOPENED_BY_REWORK } from "../constants.ts";
import type { GraphValidation, NodeInput, TaskEdge, TaskGate, TaskNode, TaskNodeStatus, TaskPaths, TaskState } from "../types.ts";
import { isSafeRelativePath, normalizeTaskNode, now, safeId } from "../utils.ts";
import { paths, trace } from "../state.ts";

export function buildDefaultGraph(allowedFiles: string[]): {
	start: string;
	nodes: Record<string, TaskNode>;
	edges: TaskEdge[];
	gates: Record<string, TaskGate>;
} {
	return {
		start: "plan",
		nodes: {
			plan: {
				status: "ready",
				role: "planner",
				dependsOn: [],
				readArtifacts: [],
				writeArtifacts: ["artifacts/plan.md"],
				messageIds: [],
				attempts: 0,
				maxAttempts: 1,
			},
			implement: {
				status: "pending",
				role: "implementer",
				dependsOn: ["plan"],
				allowedFiles,
				readArtifacts: ["artifacts/plan.md"],
				writeArtifacts: ["artifacts/implementation-report.md"],
				messageIds: [],
				attempts: 0,
				maxAttempts: 3,
			},
			test: {
				status: "pending",
				role: "tester",
				dependsOn: ["implement"],
				readArtifacts: ["artifacts/implementation-report.md"],
				writeArtifacts: ["artifacts/test-report.md"],
				messageIds: [],
				attempts: 0,
				maxAttempts: 3,
			},
			fix: {
				status: "pending",
				role: "implementer",
				dependsOn: ["test"],
				allowedFilesFrom: "implement",
				readArtifacts: ["artifacts/test-report.md"],
				writeArtifacts: ["artifacts/fix-report.md"],
				messageIds: [],
				attempts: 0,
				maxAttempts: 3,
			},
			review: {
				status: "pending",
				role: "reviewer",
				dependsOn: ["test"],
				readArtifacts: ["artifacts/implementation-report.md", "artifacts/test-report.md"],
				writeArtifacts: ["artifacts/review.md"],
				messageIds: [],
				attempts: 0,
				maxAttempts: 2,
			},
			commit: {
				status: "pending",
				role: "root",
				dependsOn: ["review"],
				writeArtifacts: ["artifacts/final-summary.md"],
				messageIds: [],
				attempts: 0,
				terminal: true,
			},
		},
		edges: [
			{ from: "plan", to: "implement", when: "planned" },
			{ from: "implement", to: "test", when: "implemented" },
			{ from: "test", to: "review", when: "passed" },
			{ from: "test", to: "fix", when: "failed", rework: true },
			{ from: "fix", to: "test", when: "implemented", rework: true },
			{ from: "review", to: "commit", when: "approved" },
			{ from: "review", to: "fix", when: "rejected", rework: true },
		],
		gates: {
			reviewApproved: { status: "open", by: null, artifact: null },
			testsPassed: { status: "open", by: null, artifact: null },
		},
	};
}

function edgeMatchesActivation(task: TaskState, edge: TaskEdge) {
	const from = task.nodes[edge.from];
	if (!from) return false;
	if (from.outcome !== edge.when) return false;
	if (from.status === "done") return true;
	return Boolean(edge.rework && (from.status === "failed" || from.status === "skipped"));
}

function reworkEdgeKey(edge: TaskEdge) {
	return `${edge.from}=>${edge.to}:${edge.when}:${edge.rework ? 1 : 0}`;
}

function sourceAttemptIdentity(
	task: TaskState,
	edge: TaskEdge,
): { attemptId: string; sourceStatus: TaskNodeStatus; sourceOutcome: string | null | undefined } | null {
	const from = task.nodes[edge.from];
	if (!from) return null;
	const latestAttemptId = from.activeAttemptId || from.attemptHistory?.[from.attemptHistory.length - 1]?.attemptId;
	if (latestAttemptId) {
		return { attemptId: latestAttemptId, sourceStatus: from.status, sourceOutcome: from.outcome };
	}
	return {
		attemptId: `legacy:${edge.from}:${from.status}:${from.outcome ?? ""}:${from.lastActivityAt ?? ""}`,
		sourceStatus: from.status,
		sourceOutcome: from.outcome,
	};
}

function hasConsumedRework(task: TaskState, edge: TaskEdge, sourceAttemptId: string, reopenedNodeId: string) {
	return (task.reworkConsumption || []).some(
		(record) =>
			record.edgeKey === reworkEdgeKey(edge) &&
			record.sourceNodeId === edge.from &&
			record.sourceAttemptId === sourceAttemptId &&
			record.reopenedNodeId === reopenedNodeId,
	);
}

function recordReworkConsumption(
	task: TaskState,
	edge: TaskEdge,
	reopenedNodeId: string,
	sourceAttemptId: string,
	sourceStatus: TaskNodeStatus,
	sourceOutcome: string | null | undefined,
) {
	task.reworkConsumption ||= [];
	if (hasConsumedRework(task, edge, sourceAttemptId, reopenedNodeId)) return false;
	task.reworkConsumption.push({
		edgeKey: reworkEdgeKey(edge),
		sourceNodeId: edge.from,
		sourceAttemptId,
		reopenedNodeId,
		consumedAt: now(),
		sourceStatus,
		sourceOutcome,
	});
	return true;
}

export function activateReworkNodes(task: TaskState, tp?: TaskPaths) {
	const reopened: string[] = [];
	for (const [sourceNodeId, sourceNode] of Object.entries(task.nodes)) {
		if (!(sourceNode.status === "failed" || sourceNode.status === "skipped" || sourceNode.status === "done")) continue;
		const outgoing = task.edges.filter((edge) => edge.from === sourceNodeId && edge.rework);
		for (const activation of outgoing) {
			if (!edgeMatchesActivation(task, activation)) continue;
			const source = sourceAttemptIdentity(task, activation);
			if (!source) continue;
			const target = task.nodes[activation.to];
			if (!target) continue;
			if (hasConsumedRework(task, activation, source.attemptId, activation.to)) {
				trace(paths(process.cwd()), "task.rework.suppressed", {
					taskId: task.taskId,
					nodeId: activation.to,
					edgeKey: reworkEdgeKey(activation),
					sourceNodeId: activation.from,
					sourceAttemptId: source.attemptId,
					targetStatus: target.status,
					sourceStatus: source.sourceStatus,
					sourceOutcome: source.sourceOutcome ?? null,
				});
				continue;
			}
			if (!(target.status === "pending" || target.status === "failed" || target.status === "skipped" || target.status === "done")) {
				trace(paths(process.cwd()), "task.rework.suppressed", {
					taskId: task.taskId,
					nodeId: activation.to,
					edgeKey: reworkEdgeKey(activation),
					sourceNodeId: activation.from,
					sourceAttemptId: source.attemptId,
					targetStatus: target.status,
					sourceStatus: source.sourceStatus,
					sourceOutcome: source.sourceOutcome ?? null,
					reason: "target_not_reopenable",
				});
				continue;
			}

			const priorActiveAttemptId = target.activeAttemptId;
			const priorAttempt =
				priorActiveAttemptId && target.attemptHistory
					? target.attemptHistory.find((a: any) => a.attemptId === priorActiveAttemptId)
					: undefined;
			if (
				priorAttempt &&
				(priorAttempt.status === "active" ||
					priorAttempt.status === "completed" ||
					priorAttempt.status === "failed" ||
					priorAttempt.status === "skipped")
			) {
				priorAttempt.supersededAt ||= now();
				priorAttempt.supersededBy = "<rework>";
				if (priorAttempt.status === "active") {
					priorAttempt.status = "superseded";
					priorAttempt.outcome = undefined;
					priorAttempt.releasedAt ||= now();
					priorAttempt.releaseReason = "terminal";
				}
			}

			target.status = "ready";
			target.assignee = undefined;
			target.assignmentMessageId = undefined;
			delete target.activeAttemptId;
			target.outcome = null;
			delete target.staleAt;
			target.lastActivityAt = now();

			recordReworkConsumption(task, activation, activation.to, source.attemptId, source.sourceStatus, source.sourceOutcome ?? null);
			reopened.push(activation.to);
			trace(paths(process.cwd()), TRACE_TASK_ATTEMPT_REOPENED_BY_REWORK, {
				taskId: task.taskId,
				nodeId: activation.to,
				priorStatus: priorAttempt ? priorAttempt.status : priorActiveAttemptId ? "unknown" : "done",
				priorAttemptId: priorActiveAttemptId ?? null,
				edgeKey: reworkEdgeKey(activation),
				sourceNodeId: activation.from,
				sourceAttemptId: source.attemptId,
			});
		}
	}
	return reopened;
}

// === Issue 29 — force-reopen attempt suppression helper ===
// On root force-reopen from a terminal state, the prior attempt must be marked superseded
// and `node.activeAttemptId` must be cleared so the next claim/assign mints a fresh attempt.
export function suppressPriorAttemptForForceReopen(node: TaskNode): { priorAttemptId: string | undefined } {
	const priorActiveAttemptId = node.activeAttemptId;
	if (priorActiveAttemptId && node.attemptHistory) {
		const priorAttempt = node.attemptHistory.find((a: any) => a.attemptId === priorActiveAttemptId);
		if (
			priorAttempt &&
			(priorAttempt.status === "active" ||
				priorAttempt.status === "completed" ||
				priorAttempt.status === "failed" ||
				priorAttempt.status === "skipped")
		) {
			priorAttempt.status = "superseded";
			priorAttempt.outcome = undefined;
			priorAttempt.supersededAt ||= now();
			priorAttempt.supersededBy = "<force-reopen>";
			priorAttempt.releasedAt ||= now();
			(priorAttempt as any).releaseReason = "force-reopen";
		}
	}
	delete node.activeAttemptId;
	return { priorAttemptId: priorActiveAttemptId };
}

export function computeReadyNodes(task: TaskState) {
	const ready: string[] = [];
	const current = new Set<string>();
	const incoming = new Map<string, TaskEdge[]>();
	for (const edge of task.edges) {
		const arr = incoming.get(edge.to) || [];
		arr.push(edge);
		incoming.set(edge.to, arr);
	}
	for (const [nodeId, node] of Object.entries(task.nodes)) {
		if (node.status === "ready" || node.status === "assigned" || node.status === "in_progress" || node.status === "blocked")
			current.add(nodeId);
		if (node.status !== "pending") continue;
		const depsOk = (node.dependsOn || []).every((depId) => {
			const dep = task.nodes[depId];
			if (!dep) return false;
			if (dep.status === "done" || dep.status === "skipped") return true;
			return (incoming.get(nodeId) || []).some((edge) => edge.from === depId && edgeMatchesActivation(task, edge));
		});
		if (!depsOk) continue;
		if (nodeId === task.start) {
			ready.push(nodeId);
			current.add(nodeId);
			continue;
		}
		const edges = incoming.get(nodeId) || [];
		// A node whose dependsOn are all satisfied but which has no incoming branch edges is a linear
		// AND-join: ready as soon as dependencies are done/skipped. Nodes WITH branch edges still require
		// a satisfied edge (from done + outcome matches when), so outcome-based branching is preserved.
		if (!edges.length) {
			ready.push(nodeId);
			current.add(nodeId);
			continue;
		}
		const edgeOk = edges.some((edge) => edgeMatchesActivation(task, edge));
		if (edgeOk) {
			ready.push(nodeId);
			current.add(nodeId);
		}
	}
	return { ready, current: Array.from(current) };
}

export function hasOutgoingTaskEdge(task: TaskState, id: string) {
	return task.edges.some((e) => e.from === id) || Object.values(task.nodes).some((n) => (n.dependsOn || []).includes(id));
}

export function isGraphTerminalNode(task: TaskState, nodeId: string) {
	const node = task.nodes[nodeId];
	return Boolean(node && (node.terminal || !hasOutgoingTaskEdge(task, nodeId)));
}

export function graphHasCycle(adj: Map<string, string[]>, nodes: Set<string>): boolean {
	const WHITE = 0,
		GRAY = 1,
		BLACK = 2;
	const color = new Map<string, number>();
	for (const n of nodes) color.set(n, WHITE);
	const dfs = (u: string): boolean => {
		color.set(u, GRAY);
		for (const v of adj.get(u) || []) {
			const c = color.get(v) ?? WHITE;
			if (c === GRAY) return true;
			if (c === WHITE && dfs(v)) return true;
		}
		color.set(u, BLACK);
		return false;
	};
	for (const n of nodes) if ((color.get(n) ?? WHITE) === WHITE && dfs(n)) return true;
	return false;
}

export type { GraphValidation };

export function validateTaskGraph(task: TaskState): GraphValidation {
	const errors: string[] = [];
	const warnings: string[] = [];
	const nodeIds = new Set(Object.keys(task.nodes));

	if (!SAFE_ID_RE.test(task.taskId)) errors.push(`taskId is not a safe id: ${task.taskId}`);
	if (!task.nodes[task.start]) errors.push(`start node does not exist: ${task.start}`);
	for (const id of nodeIds) if (!SAFE_ID_RE.test(id)) errors.push(`node id is not a safe id: ${id}`);

	const incoming = new Map<string, number>();
	for (const edge of task.edges) incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
	for (const [id, node] of Object.entries(task.nodes)) {
		for (const dep of node.dependsOn || []) if (!nodeIds.has(dep)) errors.push(`node ${id} dependsOn missing node: ${dep}`);
		if (id !== task.start && (incoming.get(id) || 0) > 0 && !(node.dependsOn || []).length)
			errors.push(`node ${id} has incoming edge(s) but no dependsOn; non-root fan-in nodes must declare dependsOn`);
	}
	for (const edge of task.edges) {
		if (!nodeIds.has(edge.from)) errors.push(`edge from missing node: ${edge.from}`);
		if (!nodeIds.has(edge.to)) errors.push(`edge to missing node: ${edge.to}`);
	}

	// reachability from start over edges + dependsOn
	const reachable = new Set<string>(task.nodes[task.start] ? [task.start] : []);
	const queue = [...reachable];
	while (queue.length) {
		const cur = queue.shift()!;
		const next = new Set<string>();
		for (const edge of task.edges) if (edge.from === cur && nodeIds.has(edge.to)) next.add(edge.to);
		for (const [id, node] of Object.entries(task.nodes)) if ((node.dependsOn || []).includes(cur)) next.add(id);
		for (const n of next)
			if (!reachable.has(n)) {
				reachable.add(n);
				queue.push(n);
			}
	}
	for (const id of nodeIds) if (!reachable.has(id)) warnings.push(`node ${id} is not reachable from start ${task.start}`);

	// A node also has an outgoing connection if another node depends on it (dependsOn is the reverse
	// of the flow edge), so terminal detection stays correct for dependsOn-only custom graphs.
	const hasOutgoing = (id: string) =>
		task.edges.some((e) => e.from === id) || Object.values(task.nodes).some((n) => (n.dependsOn || []).includes(id));
	const terminals = Object.keys(task.nodes).filter((id) => task.nodes[id].terminal || !hasOutgoing(id));
	if (!terminals.some((id) => reachable.has(id))) errors.push("no terminal node is reachable from start");

	// ambiguous branches: two non-parallel edges sharing from+when
	const branchKeys = new Map<string, number>();
	for (const edge of task.edges) {
		if (edge.parallel) continue;
		const key = `${edge.from}::${edge.when}`;
		branchKeys.set(key, (branchKeys.get(key) || 0) + 1);
	}
	for (const [key, count] of branchKeys)
		if (count > 1) errors.push(`ambiguous branch: ${count} edges share from+when "${key}" without parallel=true`);

	// cycles allowed only when cycle-forming edges are marked rework
	const nonReworkAdj = new Map<string, string[]>();
	for (const edge of task.edges) {
		if (edge.rework) continue;
		const arr = nonReworkAdj.get(edge.from) || [];
		arr.push(edge.to);
		nonReworkAdj.set(edge.from, arr);
	}
	if (graphHasCycle(nonReworkAdj, nodeIds)) errors.push("cycle detected among non-rework edges (mark cycle edges rework=true)");

	// scope/artifact path safety
	const checkPath = (label: string, id: string, value: string) => {
		if (!isSafeRelativePath(value)) errors.push(`${label} for ${id} is unsafe (must be relative, no ..): ${value}`);
	};
	for (const f of task.allowedFiles || []) checkPath("task allowedFiles", task.taskId, f);
	for (const [id, node] of Object.entries(task.nodes)) {
		for (const f of node.allowedFiles || []) checkPath(`node ${id} allowedFiles`, id, f);
		for (const a of [...(node.readArtifacts || []), ...(node.writeArtifacts || [])]) checkPath(`node ${id} artifact`, id, a);
	}

	return { errors, warnings };
}

export function collectDeclaredArtifacts(task: TaskState): string[] {
	const set = new Set<string>();
	for (const node of Object.values(task.nodes)) {
		for (const a of [...(node.readArtifacts || []), ...(node.writeArtifacts || [])]) set.add(a);
	}
	return [...set];
}

export function buildGraphFromInput(
	input: {
		nodes?: Record<string, NodeInput>;
		edges?: Array<{ from: string; to: string; when?: string; rework?: boolean; parallel?: boolean }>;
		start?: string;
		gates?: Record<string, TaskGate>;
	},
	allowedFiles: string[],
): { start: string; nodes: Record<string, TaskNode>; edges: TaskEdge[]; gates: Record<string, TaskGate> } {
	if (!input.nodes || !Object.keys(input.nodes).length) return buildDefaultGraph(allowedFiles);
	const nodes: Record<string, TaskNode> = {};
	for (const [rawId, raw] of Object.entries(input.nodes)) {
		const id = safeId(rawId);
		nodes[id] = normalizeTaskNode({
			status: (raw.status as TaskNodeStatus) || "pending",
			role: raw.role || "worker",
			dependsOn: (raw.dependsOn || []).map(safeId),
			allowedFiles: raw.allowedFiles,
			allowedFilesFrom: raw.allowedFilesFrom,
			readArtifacts: raw.readArtifacts || [],
			writeArtifacts: raw.writeArtifacts || [],
			messageIds: [],
			attempts: 0,
			maxAttempts: raw.maxAttempts,
			terminal: raw.terminal,
			assignee: raw.assignee,
			assigneePolicy: raw.assigneePolicy,
			outcome: raw.outcome ?? null,
		});
	}
	const start = input.start ? safeId(input.start) : Object.keys(nodes)[0];
	if (nodes[start] && nodes[start].status === "pending") nodes[start].status = "ready";
	// Edges are taken verbatim from input when provided. We intentionally do NOT synthesize edges
	// from dependsOn: computeReadyNodes treats a dependsOn-satisfied node with no incoming branch
	// edges as a linear AND-join (ready when deps are done), while explicit edges drive outcome-based
	// branching. Synthesizing when:"done" edges here would force every custom graph to require an
	// outcome:"done" on each dependency, which is only set by swarm_update_task in a later commit.
	const edges: TaskEdge[] = (input.edges || []).map((e) => ({
		from: safeId(e.from),
		to: safeId(e.to),
		when: e.when || "done",
		rework: e.rework,
		parallel: e.parallel,
	}));
	const gates = input.gates || {};
	return { start, nodes, edges, gates };
}
