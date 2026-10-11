// === swarm/taskgraph/formatting.ts — task markdown + graph rendering (text/Mermaid/JSON) ===
// Includes assignment-body composition and task-absolute artifact path rewriting.
// Extracted from taskgraph.ts (Phase 6 real split).

import { NODE_ICON, PI_SWARM_MINIMAL_PROTOCOL } from "../constants.ts";
import { readCommitEvidence } from "./evidence.ts";
import type { TaskState } from "../types.ts";

// === task-role-playbooks ===
import { inferRoleKind } from "../utils.ts";
import { resolveRolePlaybook } from "../config.ts";

export function buildTaskMarkdown(task: TaskState) {
	const allowed = task.allowedFiles.length
		? task.allowedFiles
				.map(
					(file) => `- \
\`${file}\``,
				)
				.join("\n")
		: "- None specified";
	const acceptance = task.acceptanceCriteria.length ? task.acceptanceCriteria.map((item) => `- ${item}`).join("\n") : "- None specified";
	const validation = task.validationCommands.length
		? task.validationCommands.map((cmd) => `\`\`\`bash\n${cmd}\n\`\`\``).join("\n\n")
		: "_None specified._";
	const qualification = task.qualification
		? `\n## Qualification Gate\n\n- Mode: \`${task.qualification.mode}\`\n- Status: \`${task.qualification.status}\`\n- Artifact: \`${task.qualification.artifact}\`\n`
		: "";
	return `# Task: ${task.title}\n\nTask ID: \`${task.taskId}\`\nWorkflow: \`${task.workflow}\`\nOwner: \`${task.owner}\`\n\n## Goal\n\n${task.goal}\n\n## Scope\n\nAllowed files:\n\n${allowed}\n\n## Acceptance Criteria\n\n${acceptance}\n\n## Validation Commands\n\n${validation}${qualification}`;
}

// ---- Task graph validation, printing, and graph synthesis helpers ----

export function printGraphText(
	task: TaskState,
	ready: string[],
	current: string[],
	artifactStatus?: Array<{ path: string; exists: boolean }>,
): string {
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
	const commitEvidence = readCommitEvidence(task);
	if (commitEvidence) {
		lines.push("");
		lines.push(
			`Commit evidence: ${commitEvidence.status}${commitEvidence.reason ? ` (${commitEvidence.reason})` : ""}${commitEvidence.baseline ? ` baseline=${commitEvidence.baseline}` : ""}${commitEvidence.head ? ` head=${commitEvidence.head}` : ""}${commitEvidence.nodeId && commitEvidence.nodeId !== "commit" ? ` node=${commitEvidence.nodeId}` : ""}`,
		);
	}
	// Row 75 (fix): surface evidence for other commit-like terminal nodes (finalize, ship, ...)
	// using the read-compat legacy `.commit` alias so roots don't have to query the task JSON.
	for (const [nodeId, ev] of Object.entries((task.evidence as Record<string, any>) || {})) {
		if (nodeId === "commit") continue;
		if (!ev || typeof ev !== "object") continue;
		lines.push("");
		lines.push(
			`Commit evidence [${nodeId}]: ${ev.status}${ev.reason ? ` (${ev.reason})` : ""}${ev.baseline ? ` baseline=${ev.baseline}` : ""}${ev.head ? ` head=${ev.head}` : ""}`,
		);
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
		taskId: task.taskId,
		title: task.title,
		status: task.status,
		workflow: task.workflow,
		owner: task.owner,
		start: task.start,
		current,
		ready,
		nodes: Object.entries(task.nodes).map(([id, n]) => ({
			id,
			role: n.role,
			status: n.status,
			assignee: n.assignee || null,
			outcome: n.outcome || null,
			terminal: Boolean(n.terminal),
			dependsOn: n.dependsOn,
		})),
		edges: task.edges,
		gates: task.gates,
	};
}

// ---- Task lifecycle helpers (assign / update / transition) ----

function taskAbsoluteArtifactPath(taskId: string, artifact: string) {
	if (artifact.startsWith(`.pi/swarm/tasks/${taskId}/`)) return artifact;
	const clean = artifact.replace(/^\/+/, "").replace(/^\.\/?/, "");
	return `.pi/swarm/tasks/${taskId}/${clean}`;
}

function rewriteTaskArtifactRefs(taskId: string, text: string) {
	if (!text) return text;
	// Allow optional leading ./ so references like "./artifacts/x.md" rewrite to the task-absolute
	// path. Without the optional prefix the regex would treat the leading `.` as the boundary
	// character, leaving `./artifacts/...` untouched and letting agents write to project-root
	// artifacts/ by following the note literally.
	return text.replace(
		/(^|[^A-Za-z0-9._/-])(\.\/)?(artifacts\/[A-Za-z0-9._/-]+)/g,
		(_m, prefix: string, dotPrefix: string, rel: string) => `${prefix}${dotPrefix || ""}${taskAbsoluteArtifactPath(taskId, rel)}`,
	);
}

export function buildAssignmentBody(
	task: TaskState,
	nodeId: string,
	replyTarget: string,
	note?: string,
	attemptId?: string,
	assignmentMessageId?: string,
) {
	const node = task.nodes[nodeId];
	const lines: string[] = [];
	lines.push(`You are assigned task ${task.taskId}, node ${nodeId} (${node.role}).`);
	lines.push(`Read .pi/swarm/tasks/${task.taskId}/task.md and .pi/swarm/tasks/${task.taskId}/task.json, plus any prior artifacts below.`);
	// Ergonomics Fix 3 (task-202610031216): one-line graph-state summary so the worker does not
	// need to read task.json just to learn the graph shape. Counts are by exact status; the
	// position suffix is this node's 1-based ordinal in the node map.
	{
		const statuses = Object.values(task.nodes).map((n) => n.status);
		const doneCount = statuses.filter((s) => s === "done").length;
		const inProgressCount = statuses.filter((s) => s === "in_progress" || s === "assigned").length;
		const pendingCount = statuses.filter((s) => s === "pending" || s === "ready" || s === "blocked").length;
		const nodeIds = Object.keys(task.nodes);
		const position = nodeIds.indexOf(nodeId) + 1;
		lines.push(
			`Graph: ${doneCount} done / ${inProgressCount} in-progress / ${pendingCount} pending — you are node ${nodeId} (${position} of ${nodeIds.length})`,
		);
	}
	// Ergonomics Fix 2: the reply contract must name THIS assignment message, not just the agent
	// id — the live probe showed completion replies landing on the PREVIOUS node's assignment id
	// because nothing told the worker which id to target. When the id is threaded (assign path
	// pre-mints it), the body names it literally.
	if (assignmentMessageId) {
		lines.push(
			`Reply to THIS assignment message: replyTo=${assignmentMessageId} conversationId=task:${task.taskId}:${nodeId}.`,
		);
	} else {
		lines.push(`Reply to ${replyTarget} when done, blocked, or needing clarification.`);
	}
	// task-role-playbooks: the playbook reference line. Belt-and-braces for adopted panes
	// and PI_SWARM_CHILD_ARGS overrides (which skip spawn-time --skill injection): the
	// assignment body re-fires on every reassign, guaranteeing mid-task consistency.
	{
		const roleKind = inferRoleKind(nodeId, node.role || "");
		const playbook = resolveRolePlaybook(roleKind, { nodeId, role: node.role });
		if (playbook) lines.push(`Role playbook: ${playbook} — read it before starting this node.`);
	}
	const scope =
		node.allowedFiles && node.allowedFiles.length
			? node.allowedFiles.join(", ")
			: node.allowedFilesFrom
				? `(inherit scope from node ${node.allowedFilesFrom})`
				: "(none specified)";
	lines.push(`Scope: ${scope}`);
	if (node.readArtifacts && node.readArtifacts.length)
		lines.push(`Read artifacts: ${node.readArtifacts.map((artifact) => taskAbsoluteArtifactPath(task.taskId, artifact)).join(", ")}`);
	if (node.writeArtifacts && node.writeArtifacts.length)
		lines.push(`Write artifacts: ${node.writeArtifacts.map((artifact) => taskAbsoluteArtifactPath(task.taskId, artifact)).join(", ")}`);
	// Ergonomics Fix 2: task.json is the durable source for acceptance criteria — the full echo
	// made the assignment body redundant boilerplate (worker review note, task-202610031143).
	if (task.acceptanceCriteria.length)
		lines.push(`Acceptance: ${task.acceptanceCriteria.length} criteria — see .pi/swarm/tasks/${task.taskId}/task.json (acceptanceCriteria).`);
	// NEW: Include attempt token in assignment contract for fencing
	if (attemptId) lines.push(`Attempt token: ${attemptId}`);
	if (note) {
		const rewritten = rewriteTaskArtifactRefs(task.taskId, note);
		lines.push(rewritten === note ? `Note: ${rewritten}` : `Note (rewritten to task-absolute artifact paths): ${rewritten}`);
	}
	// Ergonomics Fix 2 + Fix 4: under minimal protocol the closing line states the fencing
	// contract in workflow terms (reply to this assignment BEFORE the terminal node close) —
	// no tool catalog, and no instruction about the unregistered ack tool. Under gate=0 the
	// legacy line is preserved (Phase-1 byte-identical contract, mirroring delivery.ts showAckHint).
	if (PI_SWARM_MINIMAL_PROTOCOL === 1) {
		const replyClause = assignmentMessageId
			? `Reply to this assignment message (replyTo=${assignmentMessageId}) BEFORE`
			: `Reply to ${replyTarget} BEFORE`;
		lines.push(
			`When finished: ${replyClause} closing the node — send your result first, then close with done/failed/blocked and an outcome (the reply must land first so the assignment response is verified).`,
		);
	} else {
		const replyClause = assignmentMessageId
			? `Reply to this assignment message (replyTo=${assignmentMessageId}) BEFORE`
			: `Reply to ${replyTarget} BEFORE`;
		lines.push(
			`When finished: ${replyClause} closing the node — send your result first, then close with done/failed/blocked and an outcome (the reply must land first so the assignment response is verified).`,
		);
	}
	return lines.join("\n");
}

// Throw a structured, machine-readable corrective error and trace it as task.tool.invalid. Always
// called BEFORE any state mutation so invalid calls leave task.json untouched (no partial writes).
