// === swarm/taskgraph.ts — auto-extracted from index.ts (verbatim bodies) ===
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { GraphValidation, NodeClosureSummary, NodeInput, Paths, SwarmState, TaskEdge, TaskGate, TaskGateStatus, TaskNode, TaskNodeStatus, TaskPaths, TaskState, TaskStatus } from "./types.ts";
import { ALLOWED_NODE_TRANSITIONS, NODE_ICON, SAFE_ID_RE, TERMINAL_NODE_STATUSES } from "./constants.ts";
import { ensureAgentDefaults, inferRoleKind, isSafeRelativePath, normalizeTaskNode, now, safeId } from "./utils.ts";
import { readTaskState, taskPaths, trace, traceTask } from "./state.ts";

export function buildDefaultGraph(allowedFiles: string[]): { start: string; nodes: Record<string, TaskNode>; edges: TaskEdge[]; gates: Record<string, TaskGate> } {
	return {
		start: "plan",
		nodes: {
			plan: { status: "ready", role: "planner", dependsOn: [], readArtifacts: [], writeArtifacts: ["artifacts/plan.md"], messageIds: [], attempts: 0, maxAttempts: 1 },
			implement: { status: "pending", role: "implementer", dependsOn: ["plan"], allowedFiles, readArtifacts: ["artifacts/plan.md"], writeArtifacts: ["artifacts/implementation-report.md"], messageIds: [], attempts: 0, maxAttempts: 3 },
			test: { status: "pending", role: "tester", dependsOn: ["implement"], readArtifacts: ["artifacts/implementation-report.md"], writeArtifacts: ["artifacts/test-report.md"], messageIds: [], attempts: 0, maxAttempts: 3 },
			fix: { status: "pending", role: "implementer", dependsOn: ["test"], allowedFilesFrom: "implement", readArtifacts: ["artifacts/test-report.md"], writeArtifacts: ["artifacts/fix-report.md"], messageIds: [], attempts: 0, maxAttempts: 3 },
			review: { status: "pending", role: "reviewer", dependsOn: ["test"], readArtifacts: ["artifacts/implementation-report.md", "artifacts/test-report.md"], writeArtifacts: ["artifacts/review.md"], messageIds: [], attempts: 0, maxAttempts: 2 },
			commit: { status: "pending", role: "orchestrator", dependsOn: ["review"], writeArtifacts: ["artifacts/final-summary.md"], messageIds: [], attempts: 0, terminal: true },
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
		if (node.status === "ready" || node.status === "assigned" || node.status === "in_progress" || node.status === "blocked") current.add(nodeId);
		if (node.status !== "pending") continue;
		const depsOk = (node.dependsOn || []).every((depId) => {
			const dep = task.nodes[depId];
			return dep && (dep.status === "done" || dep.status === "skipped");
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
		if (!edges.length) { ready.push(nodeId); current.add(nodeId); continue; }
		const edgeOk = edges.some((edge) => {
			const from = task.nodes[edge.from];
			return from && from.status === "done" && from.outcome === edge.when;
		});
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

export function buildTaskMarkdown(task: TaskState) {
	const allowed = task.allowedFiles.length ? task.allowedFiles.map((file) => `- \
\`${file}\``).join("\n") : "- None specified";
	const acceptance = task.acceptanceCriteria.length ? task.acceptanceCriteria.map((item) => `- ${item}`).join("\n") : "- None specified";
	const validation = task.validationCommands.length ? task.validationCommands.map((cmd) => `\`\`\`bash\n${cmd}\n\`\`\``).join("\n\n") : "_None specified._";
	return `# Task: ${task.title}\n\nTask ID: \`${task.taskId}\`\nWorkflow: \`${task.workflow}\`\nOwner: \`${task.owner}\`\n\n## Goal\n\n${task.goal}\n\n## Scope\n\nAllowed files:\n\n${allowed}\n\n## Acceptance Criteria\n\n${acceptance}\n\n## Validation Commands\n\n${validation}\n`;
}

// ---- Task graph validation, printing, and graph synthesis helpers ----

export function graphHasCycle(adj: Map<string, string[]>, nodes: Set<string>): boolean {
	const WHITE = 0, GRAY = 1, BLACK = 2;
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

export function validateTaskGraph(task: TaskState): GraphValidation {
	const errors: string[] = [];
	const warnings: string[] = [];
	const nodeIds = new Set(Object.keys(task.nodes));

	if (!SAFE_ID_RE.test(task.taskId)) errors.push(`taskId is not a safe id: ${task.taskId}`);
	if (!task.nodes[task.start]) errors.push(`start node does not exist: ${task.start}`);
	for (const id of nodeIds) if (!SAFE_ID_RE.test(id)) errors.push(`node id is not a safe id: ${id}`);

	for (const [id, node] of Object.entries(task.nodes)) {
		for (const dep of node.dependsOn || []) if (!nodeIds.has(dep)) errors.push(`node ${id} dependsOn missing node: ${dep}`);
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
		for (const n of next) if (!reachable.has(n)) { reachable.add(n); queue.push(n); }
	}
	for (const id of nodeIds) if (!reachable.has(id)) warnings.push(`node ${id} is not reachable from start ${task.start}`);

	// A node also has an outgoing connection if another node depends on it (dependsOn is the reverse
	// of the flow edge), so terminal detection stays correct for dependsOn-only custom graphs.
	const hasOutgoing = (id: string) => task.edges.some((e) => e.from === id) || Object.values(task.nodes).some((n) => (n.dependsOn || []).includes(id));
	const terminals = Object.keys(task.nodes).filter((id) => task.nodes[id].terminal || !hasOutgoing(id));
	if (!terminals.some((id) => reachable.has(id))) errors.push("no terminal node is reachable from start");

	// ambiguous branches: two non-parallel edges sharing from+when
	const branchKeys = new Map<string, number>();
	for (const edge of task.edges) {
		if (edge.parallel) continue;
		const key = `${edge.from}::${edge.when}`;
		branchKeys.set(key, (branchKeys.get(key) || 0) + 1);
	}
	for (const [key, count] of branchKeys) if (count > 1) errors.push(`ambiguous branch: ${count} edges share from+when "${key}" without parallel=true`);

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

export function nodeVerdict(status: TaskNodeStatus): NodeClosureSummary["verdict"] {
	if (status === "done") return "done";
	if (status === "failed") return "failed";
	if (status === "skipped") return "skipped";
	return "open";
}

export function computeNodeClosureSummary(st: SwarmState, task: TaskState, nodeId: string, tp: TaskPaths): NodeClosureSummary {
	const node = task.nodes[nodeId];
	const verdict = nodeVerdict(node.status);
	const blocking: string[] = [];
	const agent = node.assignee ? st.agents[node.assignee] : undefined;
	if (verdict === "open") blocking.push(`status is ${node.status} (not terminal)`);
	if (node.staleAt) blocking.push(`marked stale at ${node.staleAt}`);
	if (agent) {
		ensureAgentDefaults(agent);
		if (agent.status === "stopped" || agent.health === "unhealthy") blocking.push(`assignee ${agent.id} is ${agent.status}/${agent.health}`);
	}
	let assignmentAck: NodeClosureSummary["assignmentAck"] = null;
	// Prefer the canonical (current, non-superseded) assignment message for the ack summary.
	const canonId = node.assignmentMessageId;
	if (canonId) {
		const r = st.messages[canonId];
		if (r && !r.superseded) assignmentAck = { messageId: canonId, status: r.status, acked: Boolean(r.ackedAt), ackStatus: r.lastAck?.status ?? null };
	}
	for (const msgId of node.messageIds || []) {
		const rec = st.messages[msgId];
		if (!rec) { blocking.push(`references missing message ${msgId}`); continue; }
		if (rec.superseded) continue; // superseded assignments are waived; excluded from closure blocking
		if (!assignmentAck) assignmentAck = { messageId: msgId, status: rec.status, acked: Boolean(rec.ackedAt), ackStatus: rec.lastAck?.status ?? null };
		if (rec.status === "dead_letter") blocking.push(`message ${msgId} is dead-lettered (${rec.lastError || "unknown"})`);
		if (rec.requiresAck && !rec.ackedAt) blocking.push(`assignment message ${msgId} not acknowledged`);
		if (rec.lastAck?.status === "done" && verdict === "open") blocking.push(`message ${msgId} acked done but node is still ${node.status}`);
	}
	const artifacts = (node.writeArtifacts || []).map((path) => ({ path, exists: existsSync(join(tp.root, path)) }));
	for (const a of artifacts) if (verdict === "done" && !a.exists) blocking.push(`declared artifact ${a.path} missing`);
	for (const [file, lock] of Object.entries(task.editLocks)) if (lock?.nodeId === nodeId && verdict !== "open") blocking.push(`holds editLock for ${file}`);
	const evidence = [`task.md node "${nodeId}"`, ...artifacts.filter((a) => a.exists).map((a) => a.path)];
	return { nodeId, role: node.role, assignee: node.assignee ?? null, status: node.status, closed: verdict !== "open", verdict, blocking, assignmentAck, artifacts, evidence };
}

// Task-level closure roll-up: machine-state closure + open/stale assignments + blockers. `derived`
// is computeTaskStatus applied fresh so callers see drift between stored and derived status. This is
// the pane-free done-detector: closure is knowable from task.json + swarm state alone.
export function computeTaskClosure(st: SwarmState, task: TaskState, tp: TaskPaths) {
	const nodeClosure = Object.keys(task.nodes).map((id) => computeNodeClosureSummary(st, task, id, tp));
	const openAssignments = nodeClosure.filter((n) => n.assignee && (n.status === "assigned" || n.status === "in_progress")).map((n) => ({ nodeId: n.nodeId, assignee: n.assignee as string, status: n.status }));
	const staleReason = (n: NodeClosureSummary) => n.blocking.find((b) => b.includes("stale") || b.includes("stopped") || b.includes("unhealthy") || b.includes("dead-lettered"));
	const staleAssignments = nodeClosure.filter((n) => n.assignee && staleReason(n)).map((n) => ({ nodeId: n.nodeId, assignee: n.assignee as string, reason: staleReason(n) || "stale" }));
	const derived = computeTaskStatus(task);
	const storedClosed = task.status === "done" || task.status === "failed" || task.status === "cancelled";
	const blocking: string[] = [];
	if (derived !== task.status && task.status !== "cancelled") blocking.push(`stored task.status=${task.status} but nodes derive ${derived}`);
	if (!storedClosed && openAssignments.length === 0 && nodeClosure.some((n) => n.verdict === "open")) blocking.push("task open but no active assignments (stalled)");
	return {
		taskId: task.taskId,
		storedStatus: task.status,
		derivedStatus: derived,
		closed: storedClosed,
		closedNodes: nodeClosure.filter((n) => n.closed).length,
		openNodes: nodeClosure.filter((n) => !n.closed).length,
		staleNodes: staleAssignments.length,
		openAssignments,
		staleAssignments,
		blocking,
		nodeClosure,
	};
}

export function printGraphText(task: TaskState, ready: string[], current: string[], artifactStatus?: Array<{ path: string; exists: boolean }>): string {
	const lines: string[] = [];
	lines.push(`Task: ${task.taskId} — ${task.title}`);
	lines.push(`Status: ${task.status}`);
	lines.push(`Start: ${task.start}`);
	lines.push(`Current: ${current.length ? current.join(", ") : "(none)"}`);
	lines.push("");
	lines.push("Nodes:");
	for (const [id, node] of Object.entries(task.nodes)) {
		const icon = NODE_ICON[node.status] || "?";
		const who = node.assignee || node.role;
		const outcome = node.outcome ? ` outcome=${node.outcome}` : "";
		lines.push(`  ${icon} ${id.padEnd(12)} ${String(who).padEnd(14)}${node.status.padEnd(12)}${outcome.trim()}`);
	}
	lines.push("");
	lines.push("Edges:");
	for (const edge of task.edges) {
		const flag = edge.rework ? " [rework]" : edge.parallel ? " [parallel]" : "";
		lines.push(`  ${edge.from.padEnd(10)} --${edge.when}--> ${edge.to}${flag}`);
	}
	if (artifactStatus && artifactStatus.length) {
		lines.push("");
		lines.push("Artifacts:");
		for (const a of artifactStatus) lines.push(`  ${a.exists ? "✓" : "○"} ${a.path}`);
	}
	lines.push("");
	lines.push(`Ready: ${ready.length ? ready.join(", ") : "(none)"}`);
	return lines.join("\n");
}

export function printGraphMermaid(task: TaskState): string {
	const lines: string[] = ["flowchart TD"];
	for (const [id, node] of Object.entries(task.nodes)) {
		const icon = NODE_ICON[node.status] || "?";
		lines.push(`  ${id}["${id} ${icon} ${node.status}"]`);
	}
	lines.push("");
	for (const edge of task.edges) {
		lines.push(`  ${edge.from} -->|${edge.when}| ${edge.to}`);
	}
	return lines.join("\n");
}

export function graphJsonSummary(task: TaskState, ready: string[], current: string[]) {
	return {
		taskId: task.taskId, title: task.title, status: task.status, workflow: task.workflow, owner: task.owner,
		start: task.start, current, ready,
		nodes: Object.entries(task.nodes).map(([id, n]) => ({ id, role: n.role, status: n.status, assignee: n.assignee || null, outcome: n.outcome || null, terminal: Boolean(n.terminal), dependsOn: n.dependsOn })),
		edges: task.edges, gates: task.gates,
	};
}

// ---- Task lifecycle helpers (assign / update / transition) ----

export function isAllowedNodeTransition(from: TaskNodeStatus, to: TaskNodeStatus) {
	if (from === to) return true;
	if (TERMINAL_NODE_STATUSES.has(from)) return false;
	return Boolean(ALLOWED_NODE_TRANSITIONS[from]?.has(to));
}

// Release an agent's active-task pointer and advisory edit locks when a node reaches a terminal-ish
// state (done/failed/blocked/skipped). activeTaskIds is task-granular; re-assignment re-adds it.
export function releaseNodeAssignment(st: SwarmState, task: TaskState, nodeId: string) {
	const node = task.nodes[nodeId];
	if (!node || !node.assignee) return;
	const isTerminalish = node.status === "done" || node.status === "failed" || node.status === "blocked" || node.status === "skipped";
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

// Derive the authoritative task status from node states. Closure is a deterministic consequence of
// Derive the authoritative task status from node states. Closure is a deterministic consequence of
// the last node transition: failed if any node failed; done iff every graph-terminal node is
// done/skipped (and none failed); blocked if every active node is blocked; in_progress once any node
// has started; ready before that. `cancelled` is orchestrator-explicit and never auto-derived here.
// Precedence matters: failed and done win over blocked (a task with a failed node reads "failed").
export function computeTaskStatus(task: TaskState): TaskStatus {
	const nodes = Object.values(task.nodes);
	if (nodes.some((n) => n.status === "failed")) return "failed";
	const terminals = Object.keys(task.nodes).filter((id) => isGraphTerminalNode(task, id)).map((id) => task.nodes[id]);
	if (terminals.length && terminals.every((n) => n.status === "done" || n.status === "skipped")) return "done";
	// Task-level blocked: every active (non-terminal, non-pending) node is blocked => the task cannot
	// make progress. Pure (derived from node states, not the possibly-stale task.currentNodes); resumable
	// (a node leaving `blocked` returns the task to in_progress/done).
	const active = nodes.filter((n) => n.status === "ready" || n.status === "assigned" || n.status === "in_progress" || n.status === "blocked");
	if (active.length > 0 && active.every((n) => n.status === "blocked")) return "blocked";
	const started = nodes.some((n) => n.status === "assigned" || n.status === "in_progress" || n.status === "blocked" || n.status === "done" || n.status === "failed" || n.status === "skipped");
	return started ? "in_progress" : "ready";
}

// Set task.status from node states unless the orchestrator explicitly cancelled it.
export function applyTaskStatus(task: TaskState): { changed: boolean; terminal: boolean } {
	if (task.status === "cancelled") return { changed: false, terminal: true };
	const prev = task.status;
	task.status = computeTaskStatus(task);
	const terminal = task.status === "done" || task.status === "failed";
	return { changed: task.status !== prev, terminal };
}

// Remove a closed task from every agent's activeTaskIds (terminal bookkeeping cleanup).
export function releaseTaskFromAllAgents(st: SwarmState, taskId: string) {
	for (const a of Object.values(st.agents)) { ensureAgentDefaults(a); a.activeTaskIds = a.activeTaskIds.filter((t) => t !== taskId); }
}

// Find non-terminal assigned/in_progress nodes still owned by an agent across its active tasks.
// Used by session_shutdown to nudge/escalate instead of silently orphaning open assignments.
export async function scanAgentOpenAssignments(p: Paths, st: SwarmState, agentId: string, taskIds: string[]): Promise<Array<{ task: TaskState; tp: TaskPaths; nodeId: string }>> {
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
				if (!rec) continue;               // canonical message missing -> do not claim
				if (rec.superseded) continue;     // superseded -> not current
				if (rec.to !== agentId) continue; // canonical belongs to another agent
			}
			out.push({ task, tp, nodeId });
		}
	}
	return out;
}

// Apply gate updates { gateName: { status, by?, artifact? } }. `by` defaults to the acting agent.
export function applyGateUpdates(task: TaskState, gateUpdates: Record<string, { status: TaskGateStatus; by?: string; artifact?: string | null }>, by: string) {
	const ts = now();
	for (const [name, upd] of Object.entries(gateUpdates)) {
		const prev = task.gates[name] || { status: "open" as TaskGateStatus, by: null as (string | null), artifact: null as (string | null) };
		task.gates[name] = { status: upd.status, by: upd.by || by, artifact: upd.artifact !== undefined ? upd.artifact : prev.artifact };
	}
	return ts;
}

// Append durable shared-context updates (decisions/risks/openQuestions get generated ids + by/at).
export function applySharedContextUpdates(task: TaskState, upd: { summary?: string; decisions?: Array<{ text: string; severity?: string }>; risks?: Array<{ text: string; severity?: string }>; openQuestions?: Array<{ text: string }> }, by: string) {
	const ts = now();
	const ctx = task.sharedContext;
	if (upd.summary) ctx.summary = upd.summary;
	for (const d of upd.decisions || []) ctx.decisions.push({ id: `decision-${randomUUID().slice(0, 8)}`, by, at: ts, text: d.text });
	for (const r of upd.risks || []) ctx.risks.push({ id: `risk-${randomUUID().slice(0, 8)}`, by, at: ts, severity: r.severity, text: r.text, status: "open" });
	for (const q of upd.openQuestions || []) ctx.openQuestions.push({ id: `question-${randomUUID().slice(0, 8)}`, by, at: ts, text: q.text });
}

// Build the assignment message body. Carries task/node pointers, scope, artifacts, and reply target
// so the assignee discovers the rest from durable files instead of a long orchestrator prompt.
export function autoCloseOrchestratorTerminalNodes(task: TaskState) {
	const closed: string[] = [];
	for (;;) {
		const { ready } = computeReadyNodes(task);
		const candidate = ready.find((nodeId) => {
			const node = task.nodes[nodeId];
			return node && node.status === "pending" && inferRoleKind(nodeId, node.role) === "orchestrator" && isGraphTerminalNode(task, nodeId);
		});
		if (!candidate) break;
		const node = task.nodes[candidate];
		node.assignee ||= "orchestrator";
		node.status = "done";
		node.lastActivityAt = now();
		closed.push(candidate);
	}
	return { closed };
}

export function buildAssignmentBody(task: TaskState, nodeId: string, replyTarget: string, note?: string) {
	const node = task.nodes[nodeId];
	const lines: string[] = [];
	lines.push(`You are assigned task ${task.taskId}, node ${nodeId} (${node.role}).`);
	lines.push(`Read .pi/swarm/tasks/${task.taskId}/task.md and .pi/swarm/tasks/${task.taskId}/task.json, plus any prior artifacts below.`);
	lines.push(`Reply to ${replyTarget} when done, blocked, or needing clarification.`);
	const scope = node.allowedFiles && node.allowedFiles.length ? node.allowedFiles.join(", ") : node.allowedFilesFrom ? `(inherit scope from node ${node.allowedFilesFrom})` : "(none specified)";
	lines.push(`Scope: ${scope}`);
	if (node.readArtifacts && node.readArtifacts.length) lines.push(`Read artifacts: ${node.readArtifacts.join(", ")}`);
	if (node.writeArtifacts && node.writeArtifacts.length) lines.push(`Write artifacts: ${node.writeArtifacts.join(", ")}`);
	if (task.acceptanceCriteria.length) lines.push(`Acceptance: ${task.acceptanceCriteria.join("; ")}`);
	if (note) lines.push(`Note: ${note}`);
	lines.push(`When finished, call swarm_update_task with taskId=${task.taskId}, nodeId=${nodeId}, status=done (or failed/blocked) and an outcome. Ack this assignment message too.`);
	return lines.join("\n");
}

// Throw a structured, machine-readable corrective error and trace it as task.tool.invalid. Always
// called BEFORE any state mutation so invalid calls leave task.json untouched (no partial writes).
export async function failTaskTool(tp: TaskPaths | null, p: Paths, code: string, message: string, details: Record<string, unknown>): Promise<never> {
	const body = JSON.stringify({ ok: false, errorCode: code, message, ...details }, null, 2);
	const traceData = { code, taskId: details.taskId, nodeId: details.nodeId, received: details.received };
	if (tp) await traceTask(tp, "task.tool.invalid", traceData);
	else await trace(p, "task.tool.invalid", traceData);
	const err = new Error(`${code}: ${message}\n${body}`);
	(err as any).errorCode = code;
	throw err;
}

export function buildGraphFromInput(input: { nodes?: Record<string, NodeInput>; edges?: Array<{ from: string; to: string; when?: string; rework?: boolean; parallel?: boolean }>; start?: string; gates?: Record<string, TaskGate> }, allowedFiles: string[]): { start: string; nodes: Record<string, TaskNode>; edges: TaskEdge[]; gates: Record<string, TaskGate> } {
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
	const edges: TaskEdge[] = (input.edges || []).map((e) => ({ from: safeId(e.from), to: safeId(e.to), when: e.when || "done", rework: e.rework, parallel: e.parallel }));
	const gates = input.gates || {};
	return { start, nodes, edges, gates };
}
