// === swarm/command.ts — /swarm slash command (verbatim from index.ts) ===
import { mkdir, readFile, writeFile, appendFile, rm, stat, rename, readdir, realpath } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { buildSwarmStatusSummary, listTasksIndexed, renderTasksIndexedList, resolveTaskArg, runtimeTaskWarnings } from "./reconcile.ts";
import { capturePane, tmux } from "./tmux.ts";
import { collectDeclaredArtifacts, computeReadyNodes, computeTaskClosure, graphJsonSummary, printGraphMermaid, printGraphText, validateTaskGraph } from "./taskgraph.ts";
import { currentAgentId, currentModel, currentProvider } from "./session.ts";
import { enqueueAndDeliver } from "./mailbox.ts";
import { ensureDirs, identityPath, loopStateFile, paths, readState, readTaskState, taskPaths, trace, traceTask, withLock, writeState } from "./state.ts";
import { attachTarget, findReusableAgent, registerAgent, reloadIdentity, restartAgent, sendKeys, setAgentPaused, setAgentRole, spawnAgent, stopAgent } from "./agents.ts";
import { inferRoleKind, now, safeId } from "./utils.ts";
import { loopStatusSnapshot, recordLoopPlan } from "./loop.ts";
import { overridePath } from "./identity.ts";
import { registerCwdTracking, swarmArgumentCompletions } from "./completion.ts";

// Tiny flag parser for /swarm lifecycle subcommands. Recognizes --force --no-kill --literal --enter
// --inject/--no-inject --kind <v> --model <v> --provider <v> --caps <v>; everything else goes to `rest`.
function parseFlags(tokens: string[]): { rest: string[]; force: boolean; kill: boolean; literal: boolean; enter: boolean; inject?: boolean; kind?: string; model?: string; provider?: string; caps?: string } {
	const out: { rest: string[]; force: boolean; kill: boolean; literal: boolean; enter: boolean; inject?: boolean; kind?: string; model?: string; provider?: string; caps?: string } = { rest: [], force: false, kill: true, literal: false, enter: false };
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--force") out.force = true;
		else if (t === "--no-kill") out.kill = false;
		else if (t === "--literal") out.literal = true;
		else if (t === "--enter") out.enter = true;
		else if (t === "--inject") out.inject = true;
		else if (t === "--no-inject") out.inject = false;
		else if (t === "--kind") out.kind = tokens[++i];
		else if (t === "--model") out.model = tokens[++i];
		else if (t === "--provider") out.provider = tokens[++i];
		else if (t === "--caps") out.caps = tokens[++i];
		else out.rest.push(t);
	}
	return out;
}

export function registerSwarmCommand(pi: ExtensionAPI) {
	registerCwdTracking(pi);
	pi.registerCommand("swarm", {
		description: "Manage pi swarm agents: init | list | status (rollup) | tasks (indexed list w/ age) | graph [<#|task-id> [text|mermaid|json]] — no-arg lists tasks | task <#|id> [runtime] | next <#|id> (ready nodes + suggested agent) | validate <#|id> [runtime] | spawn <id> [role] | register <tmux-target> <id> [role...] (adopt a pane) | stop <id> [--force] [--no-kill] | restart <id> | role <id> <role...> [--kind …] [--caps a,b] | pause <id> | resume <id> | sendkey <id> <keys...> [--literal] [--enter] | attach <id> | release <id> [<task-id>] [--force] | send <to> <message> | trace | capture <id> | identity reload <id> [note] | identity show <id> | loop status <task-id> | loop plan <task-id> <summary>",
		getArgumentCompletions: (argumentPrefix) => swarmArgumentCompletions(argumentPrefix),
		handler: async (args, ctx) => {
			const p = paths(ctx.cwd);
			await ensureDirs(p);
			const [cmd, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (!cmd || cmd === "init") {
					const st = await withLock(p, async () => { const s = await readState(p, ctx.cwd); await trace(p, "swarm.init", { by: currentAgentId() }); return s; });
					ctx.ui.notify(`Swarm ${st.swarmId} ready: ${relative(ctx.cwd, p.state)}`, "info");
					return;
				}
				if (cmd === "list") {
					const st = await readState(p, ctx.cwd);
					ctx.ui.notify(`Swarm ${st.swarmId}: ${Object.keys(st.agents).length} agents, tmux ${st.tmuxSession}`, "info");
					return;
				}
				if (cmd === "status") {
					// PM-facing rollup: agent counts, per-task status/current/next/unacked, closure line. Stable
					// prefixed lines so the test lane can grep output instead of capturing panes.
					const st = await readState(p, ctx.cwd);
					const { text, details } = await buildSwarmStatusSummary(p, st);
					await trace(p, "swarm.status", { by: currentAgentId(), details });
					ctx.ui.notify(text, "info");
					return;
				}
				if (cmd === "graph") {
					// No arg -> list tasks (indexed, with age) so the operator can pick by # or task-id.
					// Arg accepts a list index (1,2,3...), a full task-id/uuid, or a unique prefix.
					const arg = rest.shift();
					const format = (rest.shift() || "text").toLowerCase();
					if (!["text", "mermaid", "json"].includes(format)) { ctx.ui.notify("Graph format must be text, mermaid, or json", "warning"); return; }
					if (!arg) {
						const list = await listTasksIndexed(p);
						await trace(p, "swarm.tasks", { by: currentAgentId(), count: list.length, via: "graph-noarg" });
						ctx.ui.notify(`${renderTasksIndexedList(list)}\n\nUsage: /swarm graph <#|task-id> [text|mermaid|json]`, "info");
						return;
					}
					const { hit, list, missReason, ambiguous } = await resolveTaskArg(p, arg);
					if (!hit) {
						const hint = ambiguous ? `Ambiguous "${arg}" matches: ${ambiguous.join(", ")}` : (missReason || "task not found");
						ctx.ui.notify(`${hint}\n\n${renderTasksIndexedList(list)}`, "warning");
						return;
					}
					const task = hit.task;
					const tp = hit.tp;
					const { ready, current } = computeReadyNodes(task);
					const out = format === "mermaid"
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
					// Indexed task list (status, age, node completion, current/next) so the operator can pick by
					// # or task-id for graph|task|next|validate.
					const list = await listTasksIndexed(p);
					await trace(p, "swarm.tasks", { by: currentAgentId(), count: list.length });
					ctx.ui.notify(renderTasksIndexedList(list), "info");
					return;
				}
				if (cmd === "task") {
					// Detailed per-task status: node/gate table + artifacts + optional runtime liveness & closure.
					// Mirrors the swarm_task_status agent tool. Arg = list index | task-id | unique prefix.
					const arg = rest.shift();
					if (!arg) {
						const list = await listTasksIndexed(p);
						ctx.ui.notify(`${renderTasksIndexedList(list)}\n\nUsage: /swarm task <#|task-id> [runtime]`, "info");
						return;
					}
					const withRuntime = rest.some((t) => t === "runtime" || t === "--runtime" || t === "-r");
					const { hit, list, missReason, ambiguous } = await resolveTaskArg(p, arg);
					if (!hit) {
						const hint = ambiguous ? `Ambiguous "${arg}" matches: ${ambiguous.join(", ")}` : (missReason || "task not found");
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
						blocks.push(`Closure: stored=${closure.storedStatus} derived=${closure.derivedStatus} closed=${closure.closedNodes}/${closure.nodeClosure.length} open=${closure.openNodes} stale=${closure.staleNodes}`);
						if (closure.openAssignments.length) blocks.push(`  Open: ${closure.openAssignments.map((a) => `${a.nodeId}->${a.assignee}(${a.status})`).join(", ")}`);
						if (closure.staleAssignments.length) blocks.push(`  Stale: ${closure.staleAssignments.map((a) => `${a.nodeId}->${a.assignee} (${a.reason})`).join(", ")}`);
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
					// Ready/next nodes + a suggested reusable agent per ready node. Mirrors swarm_next_nodes.
					// Arg = list index | task-id | unique prefix.
					const arg = rest.shift();
					if (!arg) {
						const list = await listTasksIndexed(p);
						ctx.ui.notify(`${renderTasksIndexedList(list)}\n\nUsage: /swarm next <#|task-id>`, "info");
						return;
					}
					const { hit, list, missReason, ambiguous } = await resolveTaskArg(p, arg);
					if (!hit) {
						const hint = ambiguous ? `Ambiguous "${arg}" matches: ${ambiguous.join(", ")}` : (missReason || "task not found");
						ctx.ui.notify(`${hint}\n\n${renderTasksIndexedList(list)}`, "warning");
						return;
					}
					const task = hit.task;
					const tp = hit.tp;
					const { ready, current } = computeReadyNodes(task);
					const actionable = Array.from(new Set([
						...ready,
						...current.filter((id) => task.nodes[id] && task.nodes[id].status === "ready" && !task.nodes[id].assignee),
					]));
					const st = await readState(p, ctx.cwd);
					const lines: string[] = [`Task #${hit.index} ${task.taskId} (${task.status})`, `Ready: ${actionable.length ? actionable.join(", ") : "(none)"}`, `Current: ${current.length ? current.join(", ") : "(none)"}`];
					for (const nodeId of actionable) {
						const node = task.nodes[nodeId];
						const kind = inferRoleKind(nodeId, node.role);
						const found = await findReusableAgent(pi, st, { roleKind: kind, requireIdle: false, includeBusy: false });
						await trace(p, "agent.find", { taskId: task.taskId, nodeId, roleKind: kind, recommended: found.recommended });
						lines.push(`  ${nodeId} (${node.role}) -> ${found.recommended || "(no reusable agent; spawn needed)"}`);
					}
					await traceTask(tp, "task.next_nodes", { taskId: task.taskId, ready: actionable, current, via: "command" });
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				if (cmd === "validate") {
					// Structural + optional runtime validation. Mirrors swarm_validate_graph.
					// Arg = list index | task-id | unique prefix.
					const arg = rest.shift();
					if (!arg) {
						const list = await listTasksIndexed(p);
						ctx.ui.notify(`${renderTasksIndexedList(list)}\n\nUsage: /swarm validate <#|task-id> [runtime]`, "info");
						return;
					}
					const withRuntime = rest.some((t) => t === "runtime" || t === "--runtime" || t === "-r");
					const { hit, list, missReason, ambiguous } = await resolveTaskArg(p, arg);
					if (!hit) {
						const hint = ambiguous ? `Ambiguous "${arg}" matches: ${ambiguous.join(", ")}` : (missReason || "task not found");
						ctx.ui.notify(`${hint}\n\n${renderTasksIndexedList(list)}`, "warning");
						return;
					}
					const task = hit.task;
					const tp = hit.tp;
					const { errors, warnings } = validateTaskGraph(task);
					let runtimeWarnings: string[] = [];
					if (withRuntime) { const st = await readState(p, ctx.cwd); runtimeWarnings = await runtimeTaskWarnings(pi, st, task); }
					const ok = errors.length === 0;
					const lines: string[] = [`Validation #${hit.index} ${task.taskId}: ${ok ? "PASS" : "FAIL"} (${errors.length} errors, ${warnings.length + runtimeWarnings.length} warnings)`];
					for (const e of errors) lines.push(`  \u2717 ${e}`);
					for (const w of [...warnings, ...runtimeWarnings]) lines.push(`  \u26a0 ${w}`);
					await traceTask(tp, "task.validate", { taskId: task.taskId, ok, via: "command", runtime: withRuntime });
					ctx.ui.notify(lines.join("\n"), ok ? "info" : "warning");
					return;
				}
				if (cmd === "spawn") {
					const id = rest.shift();
					if (!id) { ctx.ui.notify("Usage: /swarm spawn <id> [role]", "warning"); return; }
					const role = rest.join(" ") || id;
					const result = await withLock(p, async () => { const st = await readState(p, ctx.cwd); const model = currentModel(); const r = await spawnAgent(pi, ctx.cwd, p, st, { id, role, model, provider: currentProvider(model) }); await writeState(p, st); return r; });
					ctx.ui.notify(`Spawned ${result.agent.id} at ${result.agent.tmuxTarget}`, "info");
					return;
				}
				if (cmd === "register") {
					// Adopt an EXISTING tmux pane into the swarm under a role without spawning. Upsert by id.
					// Usage: /swarm register <tmux-target> <id> [role...] [--kind K] [--model M] [--provider P] [--no-inject]
					const tmuxTarget = rest.shift();
					const id = rest.shift();
					if (!tmuxTarget || !id) { ctx.ui.notify("Usage: /swarm register <tmux-target> <id> [role...] [--kind K] [--model M] [--provider P] [--no-inject]", "warning"); return; }
					const flags = parseFlags(rest);
					const roleText = flags.rest.join(" ");
					const result = await withLock(p, async () => {
						const st = await readState(p, ctx.cwd);
						const r = await registerAgent(pi, ctx.cwd, p, st, { tmuxTarget, id, role: roleText || id, roleKind: flags.kind, model: flags.model, provider: flags.provider, inject: flags.inject });
						await writeState(p, st);
						return r;
					});
					ctx.ui.notify(`Registered ${result.agent.id} at ${result.agent.tmuxTarget} (alive=${result.tmuxAlive} piRunning=${result.piRunning} injected=${result.injected})`, "info");
					return;
				}
				if (cmd === "stop") {
					const id = rest.shift();
					if (!id) { ctx.ui.notify("Usage: /swarm stop <id> [--force] [--no-kill]", "warning"); return; }
					const flags = parseFlags(rest);
					try {
						const result = await withLock(p, async () => { const st = await readState(p, ctx.cwd); const r = await stopAgent(pi, p, st, safeId(id), { force: flags.force, killPane: flags.kill }); await writeState(p, st); return r; });
						ctx.ui.notify(`Stopped ${result.agent.id}: killed=${result.killed} method=${result.method}`, "info");
					} catch (err: any) { ctx.ui.notify(`Stop failed: ${err?.message || err}`, "warning"); }
					return;
				}
				if (cmd === "restart") {
					const id = rest.shift();
					if (!id) { ctx.ui.notify("Usage: /swarm restart <id>", "warning"); return; }
					try {
						const result = await withLock(p, async () => { const st = await readState(p, ctx.cwd); const r = await restartAgent(pi, ctx.cwd, p, st, safeId(id)); await writeState(p, st); return r; });
						ctx.ui.notify(`Restarted ${result.agent.id} at ${result.agent.tmuxTarget} (kill=${result.kill.method})`, "info");
					} catch (err: any) { ctx.ui.notify(`Restart failed: ${err?.message || err}`, "warning"); }
					return;
				}
				if (cmd === "role") {
					const id = rest.shift();
					if (!id) { ctx.ui.notify("Usage: /swarm role <id> <role...> [--kind K] [--caps a,b]", "warning"); return; }
					const flags = parseFlags(rest);
					const caps = flags.caps ? String(flags.caps).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
					try {
						const result = await withLock(p, async () => { const st = await readState(p, ctx.cwd); const r = await setAgentRole(pi, ctx.cwd, p, st, safeId(id), { role: flags.rest.join(" ") || undefined, roleKind: flags.kind, capabilities: caps }); await writeState(p, st); return r; });
						ctx.ui.notify(`Set role for ${result.agent.id}: roleKind=${result.agent.roleKind} v${result.provenance.version} injected=${result.injected}`, "info");
					} catch (err: any) { ctx.ui.notify(`Role change failed: ${err?.message || err}`, "warning"); }
					return;
				}
				if (cmd === "pause" || cmd === "resume") {
					const id = rest.shift();
					if (!id) { ctx.ui.notify(`Usage: /swarm ${cmd} <id>`, "warning"); return; }
					const paused = cmd === "pause";
					const agent = await withLock(p, async () => { const st = await readState(p, ctx.cwd); const a = setAgentPaused(st, safeId(id), paused); await writeState(p, st); return a; });
					ctx.ui.notify(`${agent.id} ${paused ? "paused" : "resumed"}`, "info");
					return;
				}
				if (cmd === "sendkey") {
					const id = rest.shift();
					if (!id) { ctx.ui.notify("Usage: /swarm sendkey <id> <keys...> [--literal] [--enter]", "warning"); return; }
					const flags = parseFlags(rest);
					const keys = flags.rest.join(" ");
					if (!keys) { ctx.ui.notify("No keys given", "warning"); return; }
					const st = await readState(p, ctx.cwd);
					const agent = st.agents[safeId(id)];
					if (!agent) { ctx.ui.notify(`Unknown agent ${id}`, "warning"); return; }
					try { await sendKeys(pi, p, agent.tmuxTarget, keys, { literal: flags.literal, enter: flags.enter }); ctx.ui.notify(`Sent keys to ${agent.id}`, "info"); }
					catch (err: any) { ctx.ui.notify(`sendkey failed: ${err?.message || err}`, "warning"); }
					return;
				}
				if (cmd === "attach") {
					const id = rest.shift();
					if (!id) { ctx.ui.notify("Usage: /swarm attach <id>", "warning"); return; }
					const st = await readState(p, ctx.cwd);
					const agent = st.agents[safeId(id)];
					if (!agent) { ctx.ui.notify(`Unknown agent ${id}`, "warning"); return; }
					const cmds = attachTarget(agent);
					ctx.ui.notify(`${cmds.attach}\n${cmds.selectWindow}\n${cmds.selectPane}`, "info");
					return;
				}
				if (cmd === "release") {
					const id = rest.shift();
					if (!id) { ctx.ui.notify("Usage: /swarm release <id> [<task-id>] [--force]", "warning"); return; }
					const flags = parseFlags(rest);
					const taskId = flags.rest[0];
					let failed: string | null = null;
					const result = await withLock(p, async () => {
						const st = await readState(p, ctx.cwd);
						const agent = st.agents[safeId(id)];
						if (!agent) throw new Error(`Unknown agent ${id}`);
						const candidate = (agent.activeTaskIds || []).slice().filter((tid) => !taskId || tid === safeId(taskId));
						const removed: string[] = []; const refused: { taskId: string; status: string }[] = [];
						for (const tid of candidate) {
							let status = "unknown"; const tp = taskPaths(p, tid);
							if (existsSync(tp.taskJson)) { try { status = (await readTaskState(tp.taskJson)).status; } catch {} }
							const terminal = status === "done" || status === "failed" || status === "cancelled" || status === "unknown";
							if (terminal || flags.force) { agent.activeTaskIds = agent.activeTaskIds.filter((t) => t !== tid); removed.push(tid); } else refused.push({ taskId: tid, status });
						}
						agent.updatedAt = now();
						await trace(p, "agent.release_task", { agentId: agent.id, via: "command", removed, refused, force: flags.force });
						await writeState(p, st);
						return { removed, refused };
					}).catch((err: any) => { failed = err?.message || String(err); return null; });
					if (failed) ctx.ui.notify(`Release failed: ${failed}`, "warning");
					else if (result) ctx.ui.notify(`Released [${result.removed.join(",")}] from ${safeId(id)}; refused [${result.refused.map((r) => `${r.taskId}:${r.status}`).join(",")}]`, "info");
					return;
				}
				if (cmd === "send") {
					const to = rest.shift();
					const body = rest.join(" ");
					if (!to || !body) { ctx.ui.notify("Usage: /swarm send <to> <message>", "warning"); return; }
					const { msg, delivery } = await enqueueAndDeliver(pi, ctx.cwd, p, { to, body });
					ctx.ui.notify(`Sent ${msg.id} to ${msg.to}. Injected: ${Boolean(delivery?.delivered)}`, "info");
					return;
				}
				if (cmd === "trace") {
					ctx.ui.notify(`Trace: ${relative(ctx.cwd, p.events)}`, "info");
					return;
				}
				if (cmd === "capture") {
					const agentId = rest[0];
					if (!agentId) { ctx.ui.notify("Usage: /swarm capture <agent-id>", "warning"); return; }
					const st = await readState(p, ctx.cwd);
					const agent = st.agents[safeId(agentId)];
					if (!agent) { ctx.ui.notify(`Unknown agent ${agentId}`, "warning"); return; }
					const file = await capturePane(pi, p, agent.id, agent.tmuxTarget, `command-${Date.now()}`);
					ctx.ui.notify(`Captured to ${relative(ctx.cwd, file)}`, "info");
					return;
				}
				if (cmd === "identity") {
					const sub = rest.shift();
					const agentId = rest.shift();
					if (sub === "show") {
						if (!agentId) { ctx.ui.notify("Usage: /swarm identity show <agent-id>", "warning"); return; }
						const st = await readState(p, ctx.cwd);
						const agent = st.agents[safeId(agentId)];
						if (!agent) { ctx.ui.notify(`Unknown agent ${agentId}`, "warning"); return; }
						const file = identityPath(p, agent.id);
						const ov = overridePath(p, agent.id);
						const markdown = existsSync(file) ? await readFile(file, "utf8") : "(no identity file yet; run /swarm identity reload <id> to generate it)";
						const head = `Identity ${agent.id} v${agent.identityVersion ?? "?"} hash=${(agent.identityHash || "").slice(0, 12) || "?"} loadedAt=${agent.identityLoadedAt || "?"} override=${existsSync(ov)}`;
						ctx.ui.notify(`${head}\n\n${markdown}`.slice(0, 4000), "info");
						return;
					}
					if (sub === "reload") {
						if (!agentId) { ctx.ui.notify("Usage: /swarm identity reload <agent-id> [note]", "warning"); return; }
						const note = rest.join(" ") || undefined;
						const r = await reloadIdentity(pi, ctx.cwd, p, safeId(agentId), { note, source: "command" });
						ctx.ui.notify(`Reloaded ${r.agent.id}: v${r.provenance.version} hash=${r.provenance.shortHash} override=${r.provenance.overridePresent} tmuxAlive=${r.tmuxAlive} injected=${r.injected}`, "info");
						return;
					}
					ctx.ui.notify("Usage: /swarm identity reload <agent-id> [note] | identity show <agent-id>", "warning");
					return;
				}
				if (cmd === "loop") {
					// V1.5 iteration proposal loop: read-only status and orchestrator plan synthesis.
					const sub = rest.shift();
					const taskId = rest.shift();
					if (sub === "status") {
						if (!taskId) { ctx.ui.notify("Usage: /swarm loop status <task-id>", "warning"); return; }
						const snap = await loopStatusSnapshot(p, ctx.cwd, taskId);
						if (!snap.enabled || !snap.loop) {
							if (snap.enabled && !snap.started) ctx.ui.notify(`Task ${taskId} has an enabled loop but it has not started (close terminal-done to begin).`, "info");
							else ctx.ui.notify(`Task ${taskId} has no enabled iteration loop.`, "info");
							return;
						}
						const props = snap.proposals || [];
						ctx.ui.notify(`Loop ${taskId}: round ${snap.loop.currentRound} phase=${snap.loop.phase}. Proposals: ${props.map((x) => `${x.agentId}=${x.status}`).join(", ") || "(none)"}. State: ${snap.paths.loopStateFile}`, "info");
						return;
					}
					if (sub === "plan") {
						if (!taskId) { ctx.ui.notify("Usage: /swarm loop plan <task-id> <summary...>", "warning"); return; }
						const summaryText = rest.join(" ");
						if (!summaryText) { ctx.ui.notify("Usage: /swarm loop plan <task-id> <summary...>", "warning"); return; }
						const r = await recordLoopPlan(pi, ctx.cwd, p, taskId, { summary: summaryText });
						ctx.ui.notify(`Recorded next-iteration plan for ${taskId} (round ${r.round}) at ${r.artifact}; phase=${r.phase}.`, "info");
						return;
					}
					ctx.ui.notify("Usage: /swarm loop status <task-id> | loop plan <task-id> <summary...>", "warning");
					return;
				}
				ctx.ui.notify(`Unknown /swarm command: ${cmd}`, "warning");
			} catch (err: any) {
				await trace(p, "error", { where: "command", command: cmd, message: err?.message || String(err), stack: err?.stack });
				ctx.ui.notify(`Swarm error: ${err?.message || err}`, "error");
			}
		},
	});
}
