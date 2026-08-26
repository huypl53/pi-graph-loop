// === swarm/command.ts — /swarm slash command (verbatim from index.ts) ===
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, appendFile, rm, stat, rename, readdir, realpath } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { buildSwarmStatusSummary, listTasksIndexed, renderTasksIndexedList, resolveTaskArg, runtimeTaskWarnings } from "./reconcile.ts";
import { capturePane, currentPaneTarget, isHereToken, listAllPanes, tmux } from "./tmux.ts";
import { collectDeclaredArtifacts, computeReadyNodes, computeTaskClosure, deriveNodeAttention, graphJsonSummary, printGraphMermaid, printGraphText, validateTaskGraph } from "./taskgraph.ts";
import { buildFlowSnapshot } from "./observability.ts";
import { openFlowDialog, pickFlowTask } from "./flow-dialog.ts";
import { currentAgentId, currentModel, currentProvider } from "./session.ts";
import { enqueueAndDeliver, deliverMessageLocked, findIdempotentMessage } from "./mailbox.ts";
import { ensureDirs, identityPath, mailboxPath, paths, readState, readTaskState, taskPaths, trace, traceTask, withLock, writeState, writeTaskState } from "./state.ts";
import { attachTarget, findReusableAgent, registerAgent, reloadIdentity, restartAgent, sendKeys, setAgentPaused, setAgentRole, spawnAgent, stopAgent } from "./agents.ts";
import { inferRoleKind, now, safeId } from "./utils.ts";
import { claimOrchestratorLeader, ensureOrchestrator, overridePath } from "./identity.ts";
import { startOrchestratorPump } from "./hooks.ts";
import { applySwarmToolGating } from "./tools/gating.ts";
import { poolStatus, setSlotCooldown, validateSwarmSettings, classifySwarmSettings, implicitSingletonPool, formatPreflightError } from "./pool.ts";
import { registerCwdTracking, swarmArgumentCompletions, swarmScopedArgumentCompletions } from "./completion.ts";

// Tiny flag parser for /swarm lifecycle subcommands. Recognizes --force --no-kill --literal --enter
// --inject/--no-inject --kind <v> --model <v> --provider <v> --caps <v> --yes; everything else goes to `rest`.
function parseFlags(tokens: string[]): { rest: string[]; force: boolean; kill: boolean; literal: boolean; enter: boolean; yes: boolean; inject?: boolean; kind?: string; model?: string; provider?: string; caps?: string } {
	const out: { rest: string[]; force: boolean; kill: boolean; literal: boolean; enter: boolean; yes: boolean; inject?: boolean; kind?: string; model?: string; provider?: string; caps?: string } = { rest: [], force: false, kill: true, literal: false, enter: false, yes: false };
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--force") out.force = true;
		else if (t === "--no-kill") out.kill = false;
		else if (t === "--literal") out.literal = true;
		else if (t === "--enter") out.enter = true;
		else if (t === "--inject") out.inject = true;
		else if (t === "--yes") out.yes = true;
		else if (t === "--no-inject") out.inject = false;
		else if (t === "--kind") out.kind = tokens[++i];
		else if (t === "--model") out.model = tokens[++i];
		else if (t === "--provider") out.provider = tokens[++i];
		else if (t === "--caps") out.caps = tokens[++i];
		else out.rest.push(t);
	}
	return out;
}

const SWARM_COMMAND_DESCRIPTION = "Manage pi swarm agents: init | list | status (rollup) | tasks (indexed list w/ age) | graph [<#|task-id> [text|mermaid|json]] — no-arg lists tasks | task <#|task-id> [runtime] | next <#|task-id> (ready nodes + suggested agent) | attention [<#|task-id>] (orchestrator-only: durable recovery attention report) | remind <task-id> <node-id> (orchestrator-only: send the one bounded worker reminder) | flow <#|task-id> [--events N] (read-only observatory snapshot) | validate <#|task-id> [runtime] | spawn <id> [role] | register <here|tmux-target> <id> [role...] (adopt a pane; 'here' = current pane) | panes (list tmux targets) | stop <id> [--force] [--no-kill] | restart <id> | role <id> <role...> [--kind …] [--caps a,b] | pause <id> | resume <id> | sendkey <id> <keys...> [--literal] [--enter] | attach <id> | release <id> [<task-id>] [--force] | mailbox reset <id> --yes | send <to> <message> | trace | capture <id> | identity reload <id> [note] | identity show <id> | pool [list|show|validate|help|preview-preflight] | pool cooldown <slot> <ms> | pool clear <slot>";

// Pure helpers for /swarm pool show|help|validate rendering. `classificationShape` reconciles the
// on-disk shape with the validation result so the show line never reports a stale `source`.
type RawShape = ReturnType<typeof classifySwarmSettings>;
function classificationShape(validation: { ok: boolean; shape: RawShape }, classified: RawShape): RawShape {
	return validation.shape || classified;
}

// Canonical pool-help text — kept as a single constant so /swarm pool help, docs/swarm/operations.md,
// and tests all reference the same source. Pure documentation, no mutation.
const POOL_HELP_TEXT = `Model pool configuration (canonical format)

{
  "swarm": {
    "modelPool": [
      { "model": "gpt-5.4-mini", "provider": "openai", "weight": 50 },
      { "model": "claude-sonnet-4", "provider": "anthropic", "weight": 30 },
      { "model": "glm-5.1", "provider": "zai-coding-cn", "weight": 0 }
    ],
    "rotation": { "strategy": "weighted", "cooldownMs": 900000, "maxRetries": 2 }
  }
}

Slot fields
  model     required, non-empty string
  provider  optional; defaults to provider registry
  weight    non-negative number; default 1; 0 = fallback-only (used when all weighted slots are benched)

Rotation fields
  strategy     weighted | round-robin | sticky (default: weighted)
  cooldownMs   bench duration after maxRetries failures (default: 900000 = 15min)
  maxRetries   consecutive failures before bench (default: 2)

Legacy singleton (still supported, observable as an implicit singleton pool):

{
  "swarm": {
    "defaultModel": "glm-5.1",
    "defaultProvider": "zai-coding-cn"
  }
}

Top-level \`swarm\` is preferred; \`extensions.swarm\` is accepted for backward compatibility.

Discover: /swarm pool show    Validate: /swarm pool validate    Preflight probe: /swarm pool preview-preflight
See: docs/swarm/operations.md (Model pool configuration)`;

type ScopedSwarmCommandName = "swarm" | "swarm-agents" | "swarm-tasks" | "swarm-msg";

function scopedSwarmUsage(commandName: ScopedSwarmCommandName): string {
	switch (commandName) {
		case "swarm-agents":
			return "Usage: /swarm-agents <list|status|spawn|register|panes|stop|restart|role|pause|resume|sendkey|attach|release|mailbox|identity> ...";
		case "swarm-tasks":
			return "Usage: /swarm-tasks <list|graph|status|next|validate> ...";
		case "swarm-msg":
			return "Usage: /swarm-msg send <to> <message>";
		default:
			return "Usage: /swarm ...";
	}
}

function normalizeScopedSwarmArgs(commandName: ScopedSwarmCommandName, args: string): string | null {
	if (commandName === "swarm") return args;
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (!tokens.length) return null;
	const [cmd, ...rest] = tokens;
	if (commandName === "swarm-agents") {
		if (!["list", "status", "spawn", "register", "panes", "stop", "restart", "role", "pause", "resume", "sendkey", "attach", "release", "mailbox", "identity"].includes(cmd)) return null;
		return [cmd, ...rest].join(" ");
	}
	if (commandName === "swarm-tasks") {
		if (cmd === "list") return ["tasks", ...rest].join(" ");
		if (cmd === "status") return ["task", ...rest].join(" ");
		if (["graph", "next", "validate"].includes(cmd)) return [cmd, ...rest].join(" ");
		return null;
	}
	if (commandName === "swarm-msg") return cmd === "send" ? [cmd, ...rest].join(" ") : null;
	return null;
}

export function registerSwarmCommand(pi: ExtensionAPI) {
	registerCwdTracking(pi);
	const runCommand = async (args: string, ctx: any, commandName: ScopedSwarmCommandName = "swarm") => {
		const scopedArgs = normalizeScopedSwarmArgs(commandName, args);
		if (scopedArgs == null) {
			ctx.ui.notify(scopedSwarmUsage(commandName), "warning");
			return;
		}
		const p = paths(ctx.cwd);
		await ensureDirs(p);
		const [cmd, ...rest] = scopedArgs.trim().split(/\s+/).filter(Boolean);
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
				if (cmd === "flow") {
					// Read-only observatory snapshot: task graph, agent lanes, and recent events.
					// In TUI mode, /swarm flow opens the picker or dialog overlay. Non-TUI remains the
					// existing text snapshot path for compatibility and tests.
					const arg = rest.shift();
					let events = 20;
					let badFlag: string | null = null;
					for (let i = 0; i < rest.length; i++) {
						const t = rest[i];
						if (t === "--events") {
							const raw = rest[++i];
							const n = Number(raw);
							if (!raw || !Number.isInteger(n) || n <= 0) { badFlag = `Invalid --events value: ${raw ?? "(missing)"}`; break; }
							events = Math.min(100, n);
							continue;
						}
						badFlag = `Unknown flow flag: ${t}`;
						break;
					}
					if (badFlag) { ctx.ui.notify(`${badFlag}\n\nUsage: /swarm flow <#|task-id> [--events N]`, "warning"); return; }
					if (ctx.mode === "tui" && ctx.hasUI) {
						if (!arg) {
							// Picker: resolved + dialog opened inside openFlowPicker; returns selected task-id (best-effort).
							const picked = await pickFlowTask(ctx, ctx.cwd, p);
							if (!picked) return;
							await openFlowDialog(ctx, ctx.cwd, p, picked.task, picked.tp, { eventLimit: events });
							return;
						}
						const { hit, list, missReason, ambiguous } = await resolveTaskArg(p, arg);
						if (!hit) {
							const hint = ambiguous ? `Ambiguous "${arg}" matches: ${ambiguous.join(", ")}` : (missReason || "task not found");
							ctx.ui.notify(`${hint}\n\n${renderTasksIndexedList(list)}`, "warning");
							return;
						}
						await openFlowDialog(ctx, ctx.cwd, p, hit.task, hit.tp, { eventLimit: events });
						return;
					}
					if (!arg) {
						const list = await listTasksIndexed(p);
						ctx.ui.notify(`${renderTasksIndexedList(list)}\n\nUsage: /swarm flow <#|task-id> [--events N]`, "info");
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
					const st = await readState(p, ctx.cwd);
					const out = await buildFlowSnapshot(p, ctx.cwd, task, tp, st, events, hit.index);
					const graphsDir = join(p.traces, "graphs");
					await mkdir(graphsDir, { recursive: true });
					const outFile = join(graphsDir, `${safeId(task.taskId)}.flow.txt`);
					await writeFile(outFile, `${out}\n`, "utf8");
					await traceTask(tp, "task.flow.read", { taskId: task.taskId, via: "command", events, index: hit.index });
					ctx.ui.notify(`${out}\n\n#${hit.index} ${task.taskId} (written to ${relative(ctx.cwd, outFile)})`.slice(0, 4000), "info");
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
				if (cmd === "attention") {
				// Orchestrator-gated, READ-ONLY recovery attention report (roadmap issue 5). Pure durable
				// derivation from task graph + assignment attempts + mailbox state; never sends, never mutates.
				if (currentAgentId() !== "orchestrator") {
					ctx.ui.notify("attention is orchestrator-only: run it in the PM session (PI_SWARM_IS_ORCHESTRATOR=1 or /swarm register here orchestrator)", "warning");
					return;
				}
				const arg = rest.shift();
				const list = await listTasksIndexed(p);
				const targets = arg ? (await resolveTaskArg(p, arg)) : { list };
				if (arg && !targets.hit) {
					const hint = targets.ambiguous ? `Ambiguous "${arg}" matches: ${targets.ambiguous.join(", ")}` : (targets.missReason || "task not found");
					ctx.ui.notify(`${hint}\n\n${renderTasksIndexedList(list)}`, "warning");
					return;
				}
				const scope = targets.hit ? [{ task: targets.hit.task, tp: targets.hit.tp }] : list.map((t) => ({ task: t.task, tp: t.tp }));
				const st = await readState(p, ctx.cwd);
				const nowMs = Date.now();
				const lines: string[] = [arg ? `Attention report — task ${targets.hit!.task.taskId}` : `Attention report — ${scope.length} task(s)`];
				let actionable = 0, reminders = 0, escalations = 0;
				for (const { task, tp } of scope) {
					const nodeLines: string[] = [];
					for (const [nodeId, node] of Object.entries(task.nodes)) {
						const att = deriveNodeAttention(st, task, nodeId, nowMs);
						if (att.category === "none" || att.category === "terminal") continue;
						if (att.workerReminderEligible) reminders++;
						if (att.orchestratorDecision) escalations++;
						actionable++;
						nodeLines.push(`  ${nodeId} (${node.status}, assignee ${node.assignee || "-"}) → ${att.category}${att.workerReminderEligible ? ` — /swarm remind ${task.taskId} ${nodeId}` : ""}`);
						for (const e of att.evidence) nodeLines.push(`      • ${e}`);
					}
					if (nodeLines.length) lines.push(``, `${task.taskId} (${task.status}):`, ...nodeLines);
				}
				lines.push("", `Summary: ${actionable} node signal(s); reminder-eligible: ${reminders}; orchestrator decisions: ${escalations}. Advisory only — nothing is auto-reassigned, cancelled, or completed.`);
				await trace(p, "swarm.attention", { by: currentAgentId(), tasks: scope.length, actionable, reminders, escalations });
				ctx.ui.notify(lines.join("\n"), "info");
				return;
				}
				if (cmd === "remind") {
				// Orchestrator-gated, the ONLY sending surface for bounded worker reminders (issue 5).
				// Idempotent + attempt-fenced: at most one reminder per attempt, permanently; requires
				// confirmed receipt (durable ack seen/processing) + no-progress interval; never mutates node
				// status/outcome/readiness and creates no ack/response debt.
				if (currentAgentId() !== "orchestrator") {
					ctx.ui.notify("remind is orchestrator-only: run it in the PM session (PI_SWARM_IS_ORCHESTRATOR=1 or /swarm register here orchestrator)", "warning");
					return;
				}
				const taskIdRaw = rest.shift();
				const nodeId = rest.shift();
				if (!taskIdRaw || !nodeId) { ctx.ui.notify("Usage: /swarm remind <task-id> <node-id> (orchestrator-only; see /swarm attention for eligibility)", "warning"); return; }
				const taskId = safeId(taskIdRaw);
				const tp = taskPaths(p, taskId);
				if (!existsSync(tp.taskJson)) { ctx.ui.notify(`No task ${taskId}`, "warning"); return; }
				const outcome = await withLock(p, async () => {
					const st = await readState(p, ctx.cwd);
					const nowMs = Date.now();
					// Re-read under lock: the attempt may have been superseded while the operator typed.
					const task = await readTaskState(tp.taskJson);
					const node = task.nodes[nodeId];
					if (!node) return { sent: false, reason: `node ${nodeId} does not exist in ${taskId}` };
					const att = deriveNodeAttention(st, task, nodeId, nowMs);
					if (att.category !== "reminder_eligible" || !att.workerReminderEligible) {
						return { sent: false, reason: `not eligible: ${att.category} — ${att.evidence.join("; ")}` };
					}
					// Attempt-locality guard: receipt must be a durable processing/seen ack on the CURRENT
					// assignment message. A prior (superseded) attempt's acked message is not receipt of the
					// current assignment, and handoff traffic is not assignment traffic.
					const currentMsg = st.messages[node.assignmentMessageId!];
					if (!currentMsg || !(currentMsg.lastAck?.status === "seen" || currentMsg.lastAck?.status === "processing")) {
						return { sent: false, reason: `not eligible: receipt not confirmed on current assignment ${node.assignmentMessageId} (lastAck ${currentMsg?.lastAck?.status || "none"})` };
					}
					const attemptId = node.activeAttemptId as string;
					const attempt = (node.attemptHistory || []).find((a: any) => a.attemptId === attemptId);
					if (!attempt || attempt.status !== "active") return { sent: false, reason: `not eligible: attempt ${attemptId} is ${attempt?.status || "missing"}` };
					const assignee = node.assignee || attempt.assignee;
					if (!assignee) return { sent: false, reason: `not eligible: node ${nodeId} has no assignee` };
					const msg = st.messages[node.assignmentMessageId!];
					const anchorMs = Math.max(
						msg?.lastAck?.at ? new Date(msg.lastAck.at).getTime() : 0,
						node.lastActivityAt ? new Date(node.lastActivityAt).getTime() : 0,
						attempt.lastActivityAt ? new Date(attempt.lastActivityAt).getTime() : 0,
						new Date(attempt.assignedAt).getTime(),
					);
					// Idempotency fence: one reminder message per attempt, ever. Crash between the mailbox append
					// and the task.json write is repaired here on the next invocation.
					const key = `task:${taskId}:node:${nodeId}:attempt:${attemptId}:reminder`;
					const existing = findIdempotentMessage(st, "orchestrator", assignee, key);
					if (existing || attempt.reminder) {
						const reminderId = attempt.reminder?.reminderId || existing?.id || "unknown";
						let repaired = false;
						if (!attempt.reminder && existing) {
							// Crash repair: message exists durably but the attempt record was never written.
							attempt.reminder = { reminderId, sentAt: existing.createdAt, messageId: existing.id, attemptId, noProgressSince: new Date(anchorMs).toISOString() };
							repaired = true;
							await writeTaskState(tp, task);
						}
						return { sent: false, reason: `already sent for attempt ${attemptId} (reminder message ${attempt.reminder?.messageId || existing?.id})`, repaired };
					}
					// Send the reminder: informational only, no ack/response debt by construction.
					const { msg: rmsg, delivery } = await deliverMessageLocked(pi, ctx.cwd, p, st, {
						to: assignee,
						subject: `Reminder: node ${nodeId} of ${taskId} awaiting progress`,
						body: `You acknowledged the assignment for task ${taskId}, node ${nodeId} (${node.role}), but there has been no durable progress since ${new Date(anchorMs).toISOString()} (${Math.round((nowMs - anchorMs) / 60000)} minutes).\n\nRequired actions (choose one):\n1. If complete: swarm_update_task(taskId="${taskId}", nodeId="${nodeId}", status="done", outcome="<result>")\n2. If blocked: swarm_update_task(taskId="${taskId}", nodeId="${nodeId}", status="blocked", note="<reason>")\n3. If still working: continue, and update the node when finished.\n\nThis reminder is informational; it does not change your task status, assignment, or create any reply obligation. At most one reminder is sent per attempt.`,
						requiresAck: false,
						requiresResponse: false,
						priority: "normal",
						idempotencyKey: key,
					});
					// Persist the reminder record (message-first crash ordering: the idempotency key is the
					// durable fence; a crash before this write is repaired above on the next invocation).
					const taskNow = await readTaskState(tp.taskJson);
					const attemptNow = (taskNow.nodes[nodeId].attemptHistory || []).find((a: any) => a.attemptId === attemptId);
					if (attemptNow && !attemptNow.reminder) {
						attemptNow.reminder = {
							reminderId: rmsg.id,
							sentAt: rmsg.createdAt,
							messageId: rmsg.id,
							attemptId,
							noProgressSince: new Date(anchorMs).toISOString(),
						};
						await writeTaskState(tp, taskNow);
					}
					// Persist the message record/delivery mutation (deliverMessageLocked mutates st in memory only).
					await writeState(p, st);
					await traceTask(tp, "reminder.sent", { taskId, nodeId, attemptId, messageId: rmsg.id, assignee, anchor: new Date(anchorMs).toISOString(), injected: Boolean(delivery?.delivered) });
					return { sent: true, messageId: rmsg.id, attemptId, assignee, injected: Boolean(delivery?.delivered) || delivery?.reused === true, reason: delivery?.reason };
				});
				if (outcome.sent) ctx.ui.notify(`Reminder sent: message ${outcome.messageId} → ${outcome.assignee} (attempt ${outcome.attemptId}; injected=${outcome.injected}). Informational only; one per attempt, ever.`, "info");
				else ctx.ui.notify(`Reminder NOT sent: ${outcome.reason}${outcome.repaired ? " (crash-repaired the attempt reminder record)" : ""}`, "warning");
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
					// No explicit model here: spawnAgent consults the model pool (if configured) before the default.
					const result = await withLock(p, async () => { const st = await readState(p, ctx.cwd); const r = await spawnAgent(pi, ctx.cwd, p, st, { id, role }); await writeState(p, st); return r; });
					ctx.ui.notify(`Spawned ${result.agent.id} at ${result.agent.tmuxTarget}`, "info");
					return;
				}
				if (cmd === "panes") {
					// List every tmux pane with a copy-pasteable target so the operator can discover what to pass
					// to '/swarm register <target> ...'. The current pane is flagged so 'here' is obvious.
					const panes = await listAllPanes(pi);
					await trace(p, "swarm.panes", { by: currentAgentId(), count: panes.length });
					if (!panes.length) { ctx.ui.notify("No tmux sessions/panes found (is pi running inside tmux?). Use '/swarm spawn <id> [role]' to create one.", "info"); return; }
					const cur = panes.find((x) => x.current);
					const rows = panes.map((x) => {
						const tag = x.current ? " <- current (use 'here')" : (x.active ? " (active)" : "");
						return `  ${x.target.padEnd(16)} ${x.paneId.padEnd(6)} ${(x.command || "").slice(0, 10).padEnd(10)} ${(x.title || "").slice(0, 18)}${tag}`;
					});
					const header = `tmux panes — adopt one with:  /swarm register <target> <id> [role]   |   /swarm register here <id> [role]${cur ? `   (you are in ${cur.target})` : ""}`;
					ctx.ui.notify(`${header}\n${rows.join("\n")}`, "info");
					return;
				}
				if (cmd === "register") {
					// Adopt an EXISTING tmux pane into the swarm under a role without spawning. Upsert by id.
					// 'here' (also self/current/.) adopts the CURRENT pane. Usage: /swarm register <here|target> <id> [role...] [--kind K] [--model M] [--provider P] [--no-inject]
					const tmuxTarget = rest.shift();
					const id = rest.shift();
					if (!tmuxTarget || !id) {
						ctx.ui.notify("Adopt a tmux pane into the swarm:\n  /swarm register here <id> [role]            (this pane — no target needed)\n  /swarm register <target> <id> [role]         (another pane)\n  /swarm panes                                  (list targets)\ntarget = session:window.pane | session:window | %paneid | =session\nflags: --kind K --model M --provider P --no-inject", "warning");
						return;
					}
					const flags = parseFlags(rest);
					const roleText = flags.rest.join(" ");
					const agentId = safeId(id);
					// The orchestrator is a human-driven coordinating role, not a generic pane agent. Registering THIS
					// pane as "orchestrator" is an explicit PM opt-in (env + mailbox-only record + PM pump). Registering
					// a DIFFERENT pane as orchestrator is refused (the orchestrator has no dedicated pane).
					if (agentId === "orchestrator") {
						const isHere = isHereToken(tmuxTarget);
						let isCurrent = isHere;
						if (!isHere) {
							const cur = await currentPaneTarget(pi);
							if (cur) {
								let tpid = "";
								try { tpid = (await tmux(pi, ["display-message", "-p", "-t", tmuxTarget, "#{pane_id}"], 3_000)).trim(); } catch { /* not alive / unresolvable */ }
								isCurrent = Boolean(tpid) && tpid === cur.paneId;
							}
						}
						if (isCurrent) {
							// Explicit PM opt-in: gate BEFORE setting env vars so a second live orchestrator cannot
							// steal the role. The leader claim is state-backed; on denial we keep the pane inert.
							const claim = await withLock(p, async () => {
								const st = await readState(p, ctx.cwd);
								return claimOrchestratorLeader(st, Date.now(), process.pid);
							});
							if (claim.kind === "denied") {
								ctx.ui.notify(`Orchestrator already active on pid ${claim.currentLeader.pid} (heartbeat ${Math.round(claim.ageMs / 1000)}s ago); this pane cannot become the PM.`, "warning");
								await trace(p, "agent.orchestrator_optin.denied", { currentLeaderPid: claim.currentLeader.pid, ageMs: claim.ageMs });
								return;
							}
							process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
							process.env.PI_SWARM_AGENT_ID = "orchestrator";
							applySwarmToolGating(pi); // re-enable the swarm tool surface now that this pane is the PM
							await withLock(p, async () => {
								const st = await readState(p, ctx.cwd);
								ensureOrchestrator(st, ctx.cwd, p);
								await trace(p, "agent.orchestrator_optin", { via: "register-command", role: roleText || null });
								await writeState(p, st);
							});
							if (ctx.hasUI) ctx.ui.setStatus("swarm", "swarm:orchestrator");
							try { await startOrchestratorPump(ctx, "register-orchestrator"); }
							catch (err: any) { await trace(p, "agent.orchestrator_optin.pump_failed", { error: String((err as Error)?.message || err) }); }
							ctx.ui.notify("This pane is now the swarm orchestrator (PM): orchestrator-scoped tools now act here, pending orchestrator mail has been surfaced, and the PM mailbox pump is active for this session.", "info");
							return;
						}
						ctx.ui.notify("The orchestrator is a human-driven coordinating role with no dedicated swarm pane — it cannot be attached to another pane. To make THIS pane the orchestrator (PM), run:\n  /swarm register here orchestrator [role]\nor relaunch pi with PI_SWARM_IS_ORCHESTRATOR=1.", "warning");
						return;
					}
					const result = await withLock(p, async () => {
						const st = await readState(p, ctx.cwd);
						const r = await registerAgent(pi, ctx.cwd, p, st, { tmuxTarget, id, role: roleText || id, roleKind: flags.kind, model: flags.model, provider: flags.provider, inject: flags.inject });
						await writeState(p, st);
						return r;
					});
					// If we registered THIS pane (via 'here' or by naming the current pane), adopt the agent
					// identity in-process so the footer/title reflects the new id and subsequent hooks heartbeat
					// the right record. Setting PI_SWARM_AGENT_ID makes currentAgentId() resolve to it; we re-emit
					// the status line immediately. The reserved "orchestrator" id is skipped (that identity must
					// come from explicit opt-in, not registration).
					let adopted = false;
					if (result.agent.id !== "orchestrator") {
						let isCurrent = isHereToken(tmuxTarget);
						if (!isCurrent) {
							const cur = await currentPaneTarget(pi);
							if (cur) {
								let tpid = "";
								try { tpid = (await tmux(pi, ["display-message", "-p", "-t", result.agent.tmuxTarget, "#{pane_id}"], 3_000)).trim(); } catch { /* not alive / unresolvable */ }
								isCurrent = Boolean(tpid) && tpid === cur.paneId;
							}
						}
						if (isCurrent) {
							process.env.PI_SWARM_AGENT_ID = result.agent.id;
							applySwarmToolGating(pi); // re-enable the swarm tool surface for the newly adopted identity
							if (ctx.hasUI) ctx.ui.setStatus("swarm", `swarm:${result.agent.id}`);
							adopted = true;
							await trace(p, "agent.adopt_identity", { agentId: result.agent.id, via: isHereToken(tmuxTarget) ? "here" : "explicit", source: "command" });
						}
					}
					ctx.ui.notify(`Registered ${result.agent.id} at ${result.agent.tmuxTarget} (alive=${result.tmuxAlive} piRunning=${result.piRunning} injected=${result.injected})${adopted ? `; this pane is now '${result.agent.id}'` : ""}`, "info");
					return;
				}
				if (cmd === "stop") {
					const id = rest.shift();
					if (!id) { ctx.ui.notify("Usage: /swarm stop <id> [--force] [--no-kill]", "warning"); return; }
					if (currentAgentId() !== "orchestrator") { ctx.ui.notify("stop is orchestrator-only: run it in the PM session (PI_SWARM_IS_ORCHESTRATOR=1 or /swarm register here orchestrator)", "warning"); return; }
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
				if (cmd === "pool") {
					const sub = rest.shift();
					if (!sub || sub === "list") {
						const status = await poolStatus(p);
						if (!status.slots.length) { ctx.ui.notify("No model pool configured. Add `modelPool` under `swarm` (or extensions.swarm) in .pi/settings.json.", "warning"); return; }
						const lines = [`Model pool (${status.rotation.strategy}, cooldown ${Math.round(status.rotation.cooldownMs / 60000)}min, maxRetries ${status.rotation.maxRetries}):`];
						for (const s of status.slots) {
							const state = s.inCooldown ? `BENCHED ${Math.ceil(s.cooldownRemainingMs / 60000)}m` : "ok";
							const err = s.health?.lastError ? ` lastError=${s.health.lastError.slice(0, 60)}` : "";
							lines.push(`  ${s.key.padEnd(34)} w=${String(s.weight ?? 1).padEnd(3)} ${state} failures=${s.health?.failures ?? 0}${err}`);
						}
						ctx.ui.notify(lines.join("\n"), "info");
						return;
					}
					if (sub === "cooldown" || sub === "clear") {
						const key = rest.shift();
						if (!key) { ctx.ui.notify("Usage: /swarm pool cooldown <provider/model> <ms> | /swarm pool clear <provider/model>", "warning"); return; }
						if (sub === "cooldown") {
							const msRaw = rest.shift();
							if (!msRaw || !/^\d+$/.test(msRaw)) { ctx.ui.notify("Cooldown requires a duration in ms", "warning"); return; }
							const ok = await setSlotCooldown(p, key, parseInt(msRaw, 10));
							ctx.ui.notify(ok ? `Slot ${key} cooldown set to ${msRaw}ms` : `Unknown slot key: ${key} (see /swarm pool list)`, ok ? "info" : "warning");
						} else {
							const ok = await setSlotCooldown(p, key, null);
							ctx.ui.notify(ok ? `Slot ${key} cooldown cleared` : `Unknown slot key: ${key} (see /swarm pool list)`, ok ? "info" : "warning");
						}
						return;
					}
					if (sub === "show") {
						// Read-only model-pool (or implicit singleton) view — never touches .pi/settings.json.
						// Output describes BOTH the explicit pool shape (when configured) AND the singleton
						// fallback the user would get if the pool were empty/all-benched, so the operator
						// can verify their config matches the canonical format before any spawn.
						const validation = validateSwarmSettings();
						const shape = classificationShape(validation, classifySwarmSettings());
						const shapeSource = shape.kind === "empty" ? "defaults" : (shape as any).source || "defaults";
						const lines: string[] = [];
						const singleton = implicitSingletonPool();
						const status = await poolStatus(p);
						if (status.slots.length) {
							lines.push(`Model pool: configured (${status.slots.length} slot${status.slots.length === 1 ? "" : "s"}, source=${shapeSource})`);
							for (const s of status.slots) {
								const state = s.inCooldown ? `BENCHED ${Math.ceil(s.cooldownRemainingMs / 60000)}m` : (s.weight === 0 ? "ok (fallback-only)" : "ok");
								const err = s.health?.lastError ? ` lastError=${s.health.lastError.slice(0, 60)}` : "";
								lines.push(`  ${s.key.padEnd(34)} w=${String(s.weight ?? 1).padEnd(3)} ${state} failures=${s.health?.failures ?? 0}${err}`);
							}
							lines.push(`Rotation: strategy=${status.rotation.strategy}, cooldown=${Math.round(status.rotation.cooldownMs / 60000)}min, maxRetries=${status.rotation.maxRetries}`);
						} else {
							lines.push(`Model pool: not configured — using implicit singleton (source=${singleton.source})`);
							lines.push(`  ${(singleton.slots[0].provider || "(default)")}/${singleton.slots[0].model}  weight=1  (fallback-only when pool is empty)`);
							lines.push(`Rotation: not configured (strategy defaults to weighted)`);
						}
						lines.push("");
						lines.push("Discover config: /swarm pool help  |  Validate: /swarm pool validate");
						await trace(p, "pool.show", { by: currentAgentId(), shape: shape.kind, slots: status.slots.length, ok: validation.ok });
						ctx.ui.notify(lines.join("\n"), validation.ok ? "info" : "warning");
						return;
					}
					if (sub === "validate") {
						// Read-only structural check; never edits .pi/settings.json.
						const v = validateSwarmSettings();
						const lines: string[] = [];
						if (v.ok) {
							lines.push("Config validation: PASSED");
							if (v.shape.kind === "empty") lines.push("  - No swarm config (using defaults).");
							else if (v.shape.kind === "singleton") lines.push(`  - Singleton config: model=${(v.shape as any).defaultModel || "(unset)"}, provider=${(v.shape as any).defaultProvider || "(unset)"}`);
							else if (v.shape.kind === "explicit-pool") lines.push(`  - Explicit pool with ${(v.shape as any).slots} slot(s).`);
							else if (v.shape.kind === "both") lines.push(`  - Both: ${(v.shape as any).slots} pool slot(s) + singleton fallback.`);
							lines.push("  - No duplicates, all weights/cooldownMs/maxRetries are well-formed.");
							await trace(p, "pool.validate", { by: currentAgentId(), ok: true, shape: v.shape.kind });
							ctx.ui.notify(lines.join("\n"), "info");
						} else {
							lines.push(`Config validation: FAILED (${v.errors.length} issue${v.errors.length === 1 ? "" : "s"})`);
							for (const e of v.errors) lines.push(`  \u2717 ${e.field || "config"}: ${e.message}`);
							lines.push("");
							lines.push("Fix in .pi/settings.json (under `swarm` or `extensions.swarm`), then run /swarm pool validate again.");
							await trace(p, "pool.validate", { by: currentAgentId(), ok: false, shape: v.shape.kind, errors: v.errors.length });
							ctx.ui.notify(lines.join("\n"), "warning");
						}
						return;
					}
					if (sub === "help") {
						// Canonical format reference — pure documentation in a notify. Never edits settings.
						ctx.ui.notify(POOL_HELP_TEXT, "info");
						return;
					}
					if (sub === "preview-preflight" || sub === "preflight") {
						// Manual preflight probe — read-only. Reports what the next spawnAgent/restartAgent
						// WOULD do, including classified errors if any. Lets the operator dry-run the gate
						// without actually committing an agent record.
						const { preflightSpawn } = await import("./pool.ts");
						const preflight = await preflightSpawn(p, { model: rest[0], provider: rest[1], tmuxSession: (await readState(p, ctx.cwd)).tmuxSession });
						const lines: string[] = [];
						if (preflight.ok === true) {
							lines.push(`Preflight: PASSED`);
							lines.push(`  model=${preflight.resolved.model}`);
							lines.push(`  provider=${preflight.resolved.provider}`);
							lines.push(`  fromPool=${preflight.resolved.fromPool}`);
							ctx.ui.notify(lines.join("\n"), "info");
						} else {
							// Discriminated union: preflight is narrowed to { ok: false; error: PreflightError } here.
							lines.push(`Preflight: FAILED`);
							lines.push(formatPreflightError((preflight as { ok: false; error: import("./types.ts").PreflightError }).error));
							ctx.ui.notify(lines.join("\n"), "warning");
						}
						return;
					}
					ctx.ui.notify("Usage: /swarm pool [list|show|validate|help|preview-preflight] | /swarm pool cooldown <provider/model> <ms> | /swarm pool clear <provider/model>", "warning");
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
					if (currentAgentId() !== "orchestrator") { ctx.ui.notify("release is orchestrator-only: run it in the PM session (PI_SWARM_IS_ORCHESTRATOR=1 or /swarm register here orchestrator)", "warning"); return; }
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
				if (cmd === "mailbox") {
					const sub = rest.shift();
					if (sub !== "reset") { ctx.ui.notify("Usage: /swarm mailbox reset <agent-id> --yes", "warning"); return; }
					const flags = parseFlags(rest);
					const id = flags.rest[0];
					if (!id) { ctx.ui.notify("Usage: /swarm mailbox reset <agent-id|here> --yes", "warning"); return; }
					const requestedId = id;
					const resolvedHere = isHereToken(requestedId) ? currentAgentId() : undefined;
					if (isHereToken(requestedId) && (!resolvedHere || resolvedHere === "swarm-guest")) {
						ctx.ui.notify("Cannot resolve 'here' to a swarm agent mailbox in this pane. Register this pane first (for an agent: /swarm register here <id> [role]; for PM: /swarm register here orchestrator), or pass an explicit agent id.", "warning");
						return;
					}
					const targetId = resolvedHere || requestedId;
					if (!flags.yes) {
						ctx.ui.notify(`Refusing mailbox reset for ${safeId(targetId)} without --yes. This command is intentionally human-initiated because it archives + clears the live mailbox and delivered ledger.`, "warning");
						return;
					}
					const result = await withLock(p, async () => {
						const st = await readState(p, ctx.cwd);
						const agentId = safeId(targetId);
						const file = mailboxPath(p, agentId);
						if (!st.agents[agentId] && !existsSync(file)) throw new Error(`Unknown agent/mailbox ${agentId}`);
						const archiveDir = join(p.traces, "mailbox-resets");
						await mkdir(archiveDir, { recursive: true });
						const ts = Date.now();
						const archive = join(archiveDir, `${agentId}-${ts}.jsonl.bak`);
						let existed = false;
						let bytes = 0;
						let lines = 0;
						if (existsSync(file)) {
							existed = true;
							const raw = await readFile(file, "utf8");
							bytes = Buffer.byteLength(raw, "utf8");
							lines = raw ? raw.split(/\n/).filter((l) => l.length > 0).length : 0;
							await writeFile(archive, raw, "utf8");
						} else {
							await writeFile(archive, "", "utf8");
						}
						await writeFile(file, "", "utf8");
						const deliveredCleared = (st.delivered[agentId] || []).length;
						st.delivered[agentId] = [];
						await trace(p, "mailbox.reset", { agentId, via: "command", existed, bytes, lines, archive, deliveredCleared, by: currentAgentId() });
						await writeState(p, st);
						return { agentId, file, archive, existed, bytes, lines, deliveredCleared };
					});
					ctx.ui.notify(`Mailbox reset for ${result.agentId}${isHereToken(requestedId) ? " (resolved from 'here')" : ""}. Archived ${result.lines} line(s) to ${relative(ctx.cwd, result.archive)}; cleared live mailbox ${relative(ctx.cwd, result.file)} and delivered ledger entries=${result.deliveredCleared}. If a session was stuck on parse errors, /reload or restart that pi session next.`, "warning");
					return;
				}
				ctx.ui.notify(`Unknown /${commandName} command: ${cmd}`, "warning");
			} catch (err: any) {
				await trace(p, "error", { where: "command", command: cmd, commandName, message: err?.message || String(err), stack: err?.stack });
				ctx.ui.notify(`Swarm error: ${err?.message || err}`, "error");
			}
		};

	pi.registerCommand("swarm", {
		description: SWARM_COMMAND_DESCRIPTION,
		getArgumentCompletions: (argumentPrefix) => swarmArgumentCompletions(argumentPrefix),
		handler: async (args, ctx) => runCommand(args, ctx, "swarm"),
	});
	pi.registerCommand("swarm-agents", {
		description: "Agent lifecycle shortcuts for swarm: list | status | spawn | register | panes | stop | restart | role | pause | resume | sendkey | attach | release | mailbox | identity",
		getArgumentCompletions: (argumentPrefix) => swarmScopedArgumentCompletions("swarm-agents", argumentPrefix),
		handler: async (args, ctx) => runCommand(args, ctx, "swarm-agents"),
	});
	pi.registerCommand("swarm-tasks", {
		description: "Task graph shortcuts for swarm: list | graph | status | next | validate",
		getArgumentCompletions: (argumentPrefix) => swarmScopedArgumentCompletions("swarm-tasks", argumentPrefix),
		handler: async (args, ctx) => runCommand(args, ctx, "swarm-tasks"),
	});
	pi.registerCommand("swarm-msg", {
		description: "Messaging shortcut for swarm: send <to> <message>",
		getArgumentCompletions: (argumentPrefix) => swarmScopedArgumentCompletions("swarm-msg", argumentPrefix),
		handler: async (args, ctx) => runCommand(args, ctx, "swarm-msg"),
	});
}
