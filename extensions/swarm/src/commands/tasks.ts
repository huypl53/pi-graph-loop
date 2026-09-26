import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { findReusableAgent } from "../agents.ts";
import { listTasksIndexed, renderTasksIndexedList, resolveTaskArg, runtimeTaskWarnings } from "../reconcile.ts";
import { currentAgentId } from "../session.ts";
import { readState, trace, traceTask } from "../state.ts";
import {
	collectDeclaredArtifacts,
	computeReadyNodes,
	computeTaskClosure,
	graphJsonSummary,
	printGraphMermaid,
	printGraphText,
	validateTaskGraph,
} from "../taskgraph.ts";
import type { Paths } from "../types.ts";
import { inferRoleKind, safeId } from "../utils.ts";

export async function handleTasksCommand(
	cmd: "graph" | "tasks" | "task" | "next" | "validate",
	rest: string[],
	ctx: any,
	p: Paths,
	pi: ExtensionAPI,
): Promise<void> {
	if (cmd === "graph") {
		const arg = rest.shift();
		const format = (rest.shift() || "text").toLowerCase();
		if (!["text", "mermaid", "json"].includes(format)) {
			ctx.ui.notify("Graph format must be text, mermaid, or json", "warning");
			return;
		}
		if (!arg) {
			const list = await listTasksIndexed(p);
			await trace(p, "swarm.tasks", { by: currentAgentId(), count: list.length, via: "graph-noarg" });
			ctx.ui.notify(`${renderTasksIndexedList(list)}\n\nUsage: /swarm graph <#|task-id> [text|mermaid|json]`, "info");
			return;
		}
		const { hit, list, missReason, ambiguous } = await resolveTaskArg(p, arg);
		if (!hit) {
			const hint = ambiguous ? `Ambiguous "${arg}" matches: ${ambiguous.join(", ")}` : missReason || "task not found";
			ctx.ui.notify(`${hint}\n\n${renderTasksIndexedList(list)}`, "warning");
			return;
		}
		const task = hit.task;
		const tp = hit.tp;
		const { ready, current } = computeReadyNodes(task);
		const out =
			format === "mermaid"
				? printGraphMermaid(task)
				: format === "json"
					? JSON.stringify(graphJsonSummary(task, ready, current), null, 2)
					: printGraphText(task, ready, current);
		const graphsDir = join(p.traces, "graphs");
		await mkdir(graphsDir, { recursive: true });
		const ext = format === "mermaid" ? "mmd" : format === "json" ? "json" : "txt";
		const outFile = join(graphsDir, `${safeId(task.taskId)}.${ext}`);
		await writeFile(outFile, `${out}\n`, "utf8");
		await traceTask(tp, "task.print", { taskId: task.taskId, format });
		ctx.ui.notify(`Wrote ${format} graph for #${hit.index} ${task.taskId} to ${relative(ctx.cwd, outFile)}`, "info");
		return;
	}

	if (cmd === "tasks") {
		const list = await listTasksIndexed(p);
		await trace(p, "swarm.tasks", { by: currentAgentId(), count: list.length });
		ctx.ui.notify(renderTasksIndexedList(list), "info");
		return;
	}

	if (cmd === "task") {
		const arg = rest.shift();
		if (!arg) {
			const list = await listTasksIndexed(p);
			ctx.ui.notify(`${renderTasksIndexedList(list)}\n\nUsage: /swarm task <#|task-id> [runtime]`, "info");
			return;
		}
		const withRuntime = rest.some((t) => t === "runtime" || t === "--runtime" || t === "-r");
		const { hit, list, missReason, ambiguous } = await resolveTaskArg(p, arg);
		if (!hit) {
			const hint = ambiguous ? `Ambiguous "${arg}" matches: ${ambiguous.join(", ")}` : missReason || "task not found";
			ctx.ui.notify(`${hint}\n\n${renderTasksIndexedList(list)}`, "warning");
			return;
		}
		const task = hit.task;
		const tp = hit.tp;
		const { ready, current } = computeReadyNodes(task);
		const artifacts = collectDeclaredArtifacts(task).map((path) => ({ path, exists: existsSync(join(tp.root, path)) }));
		const blocks: string[] = [printGraphText(task, ready, current, artifacts)];
		if (withRuntime) {
			const st = await readState(p, ctx.cwd);
			const warnings = await runtimeTaskWarnings(pi, st, task);
			const closure = computeTaskClosure(st, task, tp);
			blocks.push(
				`Closure: stored=${closure.storedStatus} derived=${closure.derivedStatus} closed=${closure.closedNodes}/${closure.nodeClosure.length} open=${closure.openNodes} stale=${closure.staleNodes}`,
			);
			if (closure.openAssignments.length)
				blocks.push(`  Open: ${closure.openAssignments.map((a) => `${a.nodeId}->${a.assignee}(${a.status})`).join(", ")}`);
			if (closure.staleAssignments.length)
				blocks.push(`  Stale: ${closure.staleAssignments.map((a) => `${a.nodeId}->${a.assignee} (${a.reason})`).join(", ")}`);
			if (closure.blocking.length) blocks.push(`  Blockers: ${closure.blocking.join("; ")}`);
			if (warnings.length) blocks.push(`Runtime warnings:\n${warnings.map((w) => `  \u26a0 ${w}`).join("\n")}`);
		}
		const out = blocks.join("\n\n");
		const graphsDir = join(p.traces, "graphs");
		await mkdir(graphsDir, { recursive: true });
		const outFile = join(graphsDir, `${safeId(task.taskId)}.task.txt`);
		await writeFile(outFile, `${out}\n`, "utf8");
		await traceTask(tp, "task.status.read", { taskId: task.taskId, via: "command", runtime: withRuntime });
		ctx.ui.notify(`${out}\n\n#${hit.index} ${task.taskId} (written to ${relative(ctx.cwd, outFile)})`.slice(0, 4000), "info");
		return;
	}

	if (cmd === "next") {
		const arg = rest.shift();
		if (!arg) {
			const list = await listTasksIndexed(p);
			ctx.ui.notify(`${renderTasksIndexedList(list)}\n\nUsage: /swarm next <#|task-id>`, "info");
			return;
		}
		const { hit, list, missReason, ambiguous } = await resolveTaskArg(p, arg);
		if (!hit) {
			const hint = ambiguous ? `Ambiguous "${arg}" matches: ${ambiguous.join(", ")}` : missReason || "task not found";
			ctx.ui.notify(`${hint}\n\n${renderTasksIndexedList(list)}`, "warning");
			return;
		}
		const task = hit.task;
		const tp = hit.tp;
		const { ready, current } = computeReadyNodes(task);
		const actionable = Array.from(
			new Set([...ready, ...current.filter((id) => task.nodes[id] && task.nodes[id].status === "ready" && !task.nodes[id].assignee)]),
		);
		const st = await readState(p, ctx.cwd);
		const lines: string[] = [
			`Task #${hit.index} ${task.taskId} (${task.status})`,
			`Ready: ${actionable.length ? actionable.join(", ") : "(none)"}`,
			`Current: ${current.length ? current.join(", ") : "(none)"}`,
		];
		for (const nodeId of actionable) {
			const node = task.nodes[nodeId];
			const kind = inferRoleKind(nodeId, node.role);
			const found = await findReusableAgent(pi, st, {
				roleKind: kind,
				requireIdle: false,
				includeBusy: false,
				excludeTaskId: task.taskId,
			});
			await trace(p, "agent.find", { taskId: task.taskId, nodeId, roleKind: kind, recommended: found.recommended });
			lines.push(`  ${nodeId} (${node.role}) -> ${found.recommended || "(no reusable agent; spawn needed)"}`);
		}
		await traceTask(tp, "task.next_nodes", { taskId: task.taskId, ready: actionable, current, via: "command" });
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	if (cmd === "validate") {
		const arg = rest.shift();
		if (!arg) {
			const list = await listTasksIndexed(p);
			ctx.ui.notify(`${renderTasksIndexedList(list)}\n\nUsage: /swarm validate <#|task-id> [runtime]`, "info");
			return;
		}
		const withRuntime = rest.some((t) => t === "runtime" || t === "--runtime" || t === "-r");
		const { hit, list, missReason, ambiguous } = await resolveTaskArg(p, arg);
		if (!hit) {
			const hint = ambiguous ? `Ambiguous "${arg}" matches: ${ambiguous.join(", ")}` : missReason || "task not found";
			ctx.ui.notify(`${hint}\n\n${renderTasksIndexedList(list)}`, "warning");
			return;
		}
		const task = hit.task;
		const tp = hit.tp;
		const { errors, warnings } = validateTaskGraph(task);
		let runtimeWarnings: string[] = [];
		if (withRuntime) {
			const st = await readState(p, ctx.cwd);
			runtimeWarnings = await runtimeTaskWarnings(pi, st, task);
		}
		const ok = errors.length === 0;
		const lines: string[] = [
			`Validation #${hit.index} ${task.taskId}: ${ok ? "PASS" : "FAIL"} (${errors.length} errors, ${warnings.length + runtimeWarnings.length} warnings)`,
		];
		for (const e of errors) lines.push(`  \u2717 ${e}`);
		for (const w of [...warnings, ...runtimeWarnings]) lines.push(`  \u26a0 ${w}`);
		await traceTask(tp, "task.validate", { taskId: task.taskId, ok, via: "command", runtime: withRuntime });
		ctx.ui.notify(lines.join("\n"), ok ? "info" : "warning");
		return;
	}
}
