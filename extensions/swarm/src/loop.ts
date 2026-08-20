// === swarm/loop.ts — auto-extracted from index.ts (verbatim bodies) ===
import { defineTool, CONFIG_DIR_NAME, truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, appendFile, rm, stat, rename, readdir, realpath } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import type { LoopConfig, LoopPhase, LoopPlan, LoopProposal, LoopProposalStatus, LoopRefreshResult, LoopRound, LoopState, MessageRecord, Paths, SwarmState, TaskPaths, TaskState } from "./types.ts";
import { SPAWN_SETTLE_MS } from "./constants.ts";
import { appendLoopHistory, loopDir, loopHistoryFile, loopRoundFile, loopStateFile, paths, readLoopState, readState, readTaskState, taskPaths, trace, traceTask, withLock, writeLoopState, writeState } from "./state.ts";
import { collectDeclaredArtifacts } from "./taskgraph.ts";
import { currentAgentId } from "./session.ts";
import { deliverMessageLocked, findIdempotentMessage, readMailbox } from "./mailbox.ts";
import { isSafeRelativePath, now, safeId, sleep } from "./utils.ts";
import { isTmuxRunning, tmux } from "./tmux.ts";
import { reconcile } from "./reconcile.ts";
import { reloadIdentity } from "./agents.ts";

// Normalize the raw task.loop block. Returns undefined when absent/disabled so callers can treat the
// loop as a no-op with a single falsy check. proposalAgents default to [] (a no-op fanout is valid
// and lets an orchestrator record a plan without any proposal agents configured).
export function getLoopConfig(loop: Partial<LoopConfig> | undefined): LoopConfig | undefined {
	const raw = loop;
	if (!raw || typeof raw !== "object" || raw.enabled !== true) return undefined;
	return {
		enabled: true,
		proposalAgents: Array.from(new Set((Array.isArray(raw.proposalAgents) ? raw.proposalAgents : []).map((a) => safeId(String(a))))),
		refreshAgents: Array.isArray(raw.refreshAgents) ? Array.from(new Set(raw.refreshAgents.map((a) => safeId(String(a))))) : undefined,
		maxRounds: typeof raw.maxRounds === "number" && raw.maxRounds > 0 ? Math.floor(raw.maxRounds) : undefined,
	};
}

export function buildProposalRequest(task: TaskState, round: number, artifacts: string[]): string {
	const arts = artifacts.length ? artifacts.map((a) => `- ${a}`).join("\n") : "- (no declared artifacts)";
	return [
		`[PI-SWARM ITERATION PROPOSAL REQUEST]`,
		``,
		`Task ${task.taskId} ("${task.title}") just completed iteration ${round}. The swarm is collecting proposals for the best NEXT-iteration change before the orchestrator synthesizes a plan.`,
		``,
		`Goal of this task: ${task.goal}`,
		``,
		`Key artifacts:`,
		arts,
		``,
		`Propose ONE concrete, high-leverage improvement for the next iteration. Keep it short: a summary line, the rationale, and the specific change you would make. Reply to this message with your proposal (your reply is recorded as your proposal). Do NOT start implementing.`,
	].join("\n");
}

// Enrich the requested-proposal records with live ack/response state and detected reply messages so
// the read-only status surface reflects reality without mutating loop state. Reply bodies live in
// mailboxes (MessageRecord carries no body): replies to proposal requests land in the orchestrator
// mailbox (the proposal sender), so we scan it (and the proposer mailboxes as a fallback) by id.
export async function collectLoopProposalStatus(p: Paths, st: SwarmState, round: LoopRound): Promise<LoopProposal[]> {
	const replyByReplyTo = new Map<string, MessageRecord>();
	for (const rec of Object.values(st.messages)) {
		if (rec.replyTo) {
			const prev = replyByReplyTo.get(rec.replyTo);
			// keep the latest reply by updatedAt
			if (!prev || (rec.updatedAt || "") > (prev.updatedAt || "")) replyByReplyTo.set(rec.replyTo, rec);
		}
	}
	const replyIds = new Set<string>();
	for (const prop of round.proposals) if (prop.messageId && replyByReplyTo.has(prop.messageId)) replyIds.add(replyByReplyTo.get(prop.messageId)!.id);
	const bodyById = new Map<string, string>();
	if (replyIds.size) {
		const boxes = ["orchestrator", ...Array.from(new Set(round.proposals.map((x) => x.agentId)))];
		for (const mbox of boxes) {
			try { for (const m of await readMailbox(p, mbox)) { if (replyIds.has(m.id) && !bodyById.has(m.id)) bodyById.set(m.id, m.body || ""); } } catch {}
			if (bodyById.size >= replyIds.size) break;
		}
	}
	return round.proposals.map((prop) => {
		if (prop.status === "skipped" || prop.status === "failed") return prop;
		const reply = prop.messageId ? replyByReplyTo.get(prop.messageId) : undefined;
		if (reply) {
			const body = bodyById.get(reply.id) || "";
			return {
				...prop,
				status: "received" as LoopProposalStatus,
				receivedAt: reply.createdAt,
				summary: body.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 1).join(" ").slice(0, 200) || "(empty reply)",
				body: prop.body,
			};
		}
		return prop;
	});
}

export async function writeProposalsArtifact(tp: TaskPaths, round: LoopRound, proposals: LoopProposal[]) {
	const lines: string[] = [
		`# Iteration ${round.round} proposals`,
		"",
		`Phase:  ${round.phase}`,
		`Started: ${round.startedAt}`,
		"",
		"| Agent | Status | Message | Summary / error |",
		"| --- | --- | --- | --- |",
	];
	for (const p of proposals) {
		const summary = p.status === "received" ? (p.summary || "") : (p.error || "");
		lines.push(`| ${p.agentId} | ${p.status} | ${p.messageId || "-"} | ${(summary || "").replace(/\|/g, "\\|")} |`);
	}
	await mkdir(tp.artifacts, { recursive: true });
	await writeFile(join(tp.artifacts, `proposals-round-${round.round}.md`), `${lines.join("\n")}\n`, "utf8");
}

export async function writeNextPlanArtifact(tp: TaskPaths, round: number, plan: LoopPlan, proposals: LoopProposal[]) {
	const lines: string[] = [
		`# Next-iteration plan (round ${round})`,
		"",
		`- Created at: ${plan.createdAt}`,
		`- Created by: ${plan.createdBy}`,
		`- Artifact: ${plan.artifact}`,
		"",
		`## Summary`,
		"",
		plan.summary,
		"",
	];
	if (plan.nextSteps && plan.nextSteps.trim()) {
		lines.push(`## Next steps`, "", plan.nextSteps.trim(), "");
	}
	lines.push(`## Proposals considered`, "", ` ${proposals.length} proposal(s) this round:`, "");
	for (const p of proposals) lines.push(`- **${p.agentId}** (${p.status}): ${p.status === "received" ? (p.summary || "(no summary)") : (p.error || p.status)}`);
	await mkdir(tp.artifacts, { recursive: true });
	await writeFile(join(tp.artifacts, "next-plan.md"), `${lines.join("\n")}\n`, "utf8");
}

// Kick off the post-iteration proposal round for a loop-enabled task. Runs INSIDE the caller's swarm
// lock (used by swarm_update_task on terminal DONE close) so proposal fanout is atomic with the close.
// Best-effort: never throws (failures are traced). Guards: no-op when loop disabled, task not done,
// an active round already exists, or maxRounds reached. Persists proposal message records via writeState.
export async function kickoffLoopIfEnabled(pi: ExtensionAPI, cwd: string, p: Paths, st: SwarmState, task: TaskState, tp: TaskPaths): Promise<void> {
	const cfg = getLoopConfig(task.loop);
	if (!cfg) return;
	if (task.status !== "done") return;
	// readLoopState throws (after backing up the file) on a corrupt loop-state.json. Self-heal: treat
	// that as "no existing loop" so the round restarts from 1, preserving the pre-resilience behavior
	// and ensuring a corrupt file can't permanently block loop kickoff for a just-closed task.
	let existing: LoopState | undefined;
	try {
		existing = await readLoopState(p, task.taskId);
	} catch (err: any) {
		await traceTask(tp, "task.loop.kickoff_corrupt_recovered", { taskId: task.taskId, error: String((err as Error)?.message || err) });
		existing = undefined;
	}
	if (existing && ["collecting_proposals", "awaiting_plan", "refreshing"].includes(existing.phase)) {
		await traceTask(tp, "task.loop.kickoff_skipped", { taskId: task.taskId, phase: existing.phase, reason: "active round exists" });
		return;
	}
	const round = (existing?.currentRound || 0) + 1;
	if (cfg.maxRounds && round > cfg.maxRounds) {
		await traceTask(tp, "task.loop.kickoff_skipped", { taskId: task.taskId, round, maxRounds: cfg.maxRounds, reason: "maxRounds reached" });
		return;
	}
	const ts = now();
	const pool = cfg.proposalAgents;
	const conversationId = `task:${task.taskId}:loop:${round}`;
	const artifactsList = collectDeclaredArtifacts(task);
	const proposals: LoopProposal[] = [];
	const proposalMessageIds: string[] = [];
	for (const agentId of pool) {
		if (!st.agents[agentId]) {
			proposals.push({ agentId, status: "skipped", error: "agent not registered" });
			continue;
		}
		const body = buildProposalRequest(task, round, artifactsList);
		try {
			const { msg } = await deliverMessageLocked(pi, cwd, p, st, {
				to: agentId,
				subject: `Task ${task.taskId} iteration ${round}: propose next change`,
				body,
				conversationId,
				requiresAck: true,
				requiresResponse: true,
				idempotencyKey: `loop:${task.taskId}:round:${round}:propose:${agentId}`,
			});
			proposals.push({ agentId, messageId: msg.id, status: "requested" });
			proposalMessageIds.push(msg.id);
		} catch (err: any) {
			proposals.push({ agentId, status: "failed", error: String((err as Error)?.message || err) });
		}
	}
	// Orchestrator nudge: there is no event hook for "all proposal replies received", so explicitly tell the
	// orchestrator a round started and how to advance it. This is ACTION-EXPECTED (requiresAck:true): the
	// orchestrator must advance the round. The auto-pump defers delivery to idle and re-triggers it (bounded)
	// until acked; recordLoopPlan auto-acks it (by idempotencyKey) once a plan is recorded, so reminders
	// stop then. Sent for loop-enabled tasks only; never sent when task.loop is absent/disabled.
	try {
		const statusLines = proposals.map((x) => `- ${x.agentId}: ${x.status}${x.messageId ? ` (messageId=${x.messageId})` : ""}${x.error ? ` [${x.error}]` : ""}`).join("\n");
		const workers = availableProposers(st); // Flow A: tell the orchestrator who it CAN ask, even with an empty pool
		await deliverMessageLocked(pi, cwd, p, st, {
			to: "orchestrator",
			subject: `Task ${task.taskId} iteration loop: round ${round} started`,
			body: `The V1.5 iteration proposal loop started for task ${task.taskId} after it reached terminal-done.\n\nRound ${round}. ${pool.length ? `Proposal requests sent to ${pool.length} agent(s):\n${statusLines}\nCheck \`swarm_loop_status\` (or \`/swarm loop status ${task.taskId}\`) — it shows "collecting proposals" until replies arrive, then "ready to plan".` : `No proposal agents are configured (task.loop.proposalAgents is empty).${workers.length ? ` Two options: (1) synthesize the plan directly from carry-forward context, OR (2) if you want diverse ideas first, send proposal requests yourself to the worker agents [${workers.join(", ")}] via \`swarm_send_message\` (requiresResponse:true) or \`swarm_task_message\`, read their replies, then plan. (Loop status does NOT auto-track ad-hoc proposals — you collect them yourself.)` : ` No other worker agents are registered either, so synthesize the plan directly from carry-forward context.`}`}\n\nCarry-forward context to plan from: call \`swarm_iteration_context\` / \`swarm_iteration_status\` for the best run, metrics vs baseline, and active memories for this task; also read the latest distill_memory artifact for what the previous iteration learned.\n\nTo advance the round:\n1. Record the next-iteration plan: \`swarm_loop_plan(taskId="${task.taskId}", summary=..., nextSteps=...)\` -> writes artifacts/next-plan.md${cfg.refreshAgents && cfg.refreshAgents.length ? " and best-effort refreshes refreshAgents" : ""}.\n2. REOPEN the graph so round ${round} executes: reset each iteration node to pending with \`swarm_update_task(taskId="${task.taskId}", nodeId=..., status="pending", force=true)\` (e.g. plan_iteration, implement_change, run_uat, distill_memory, finalize_iteration). The task derives back to in_progress and agents run the iteration; when it closes terminal-done again the loop auto-kicks off round ${round + 1}.\n\n(Action required. This nudge is auto-acknowledged once a plan is recorded; if the graph is still \`done\` after the plan, a separate bounded reminder asks you to reopen it.)`,
			conversationId,
			requiresAck: true,
			idempotencyKey: `loop:${task.taskId}:round:${round}:nudge:orchestrator`,
		});
	} catch (err: any) {
		await traceTask(tp, "task.loop.nudge_failed", { taskId: task.taskId, round, error: String((err as Error)?.message || err) });
	}
	const phase: LoopPhase = proposalMessageIds.length ? "collecting_proposals" : "awaiting_plan";
	const roundRec: LoopRound = { round, phase, startedAt: ts, proposalMessageIds, proposals, refreshResults: [] };
	const loopState: LoopState = {
		taskId: task.taskId,
		enabled: true,
		config: { ...cfg },
		currentRound: round,
		phase,
		rounds: [...(existing?.rounds || []), roundRec],
		createdAt: existing?.createdAt || ts,
		updatedAt: ts,
	};
	try {
		await mkdir(loopDir(p, task.taskId), { recursive: true });
		await writeFile(loopRoundFile(p, task.taskId, round), `${JSON.stringify(roundRec, null, 2)}\n`, "utf8");
		await writeLoopState(p, loopState);
		await writeProposalsArtifact(tp, roundRec, proposals);
		await appendLoopHistory(p, task.taskId, { type: "round_start", round, phase, proposalMessageIds, pool });
		// Persist the proposal message records added by deliverMessageLocked (mailbox jsonl is already
		// written; this persists the swarm-state.json message ledger so status/acks survive a restart).
		await writeState(p, st);
		await traceTask(tp, "task.loop.kickoff", { taskId: task.taskId, round, phase, proposalMessageIds, pool, skipped: proposals.filter((x) => x.status === "skipped").map((x) => x.agentId), failed: proposals.filter((x) => x.status === "failed").map((x) => x.agentId) });
	} catch (err: any) {
		await traceTask(tp, "task.loop.kickoff_partial", { taskId: task.taskId, round, error: String((err as Error)?.message || err), proposalMessageIds });
	}
}

// Best-effort agent refresh used after a plan is recorded. Prefers a tmux `/new` context reset for a
// live pane, then reloads+injects the durable identity. Runs OUTSIDE the swarm lock (reloadIdentity
// acquires the lock itself), so callers must not already hold it. Never throws; failures are captured
// per-agent into a LoopRefreshResult so a refresh outage cannot corrupt loop state.
export async function refreshLoopAgent(pi: ExtensionAPI, cwd: string, p: Paths, agentId: string): Promise<LoopRefreshResult> {
	const result: LoopRefreshResult = { agentId, mode: "skipped", tmuxAlive: false, injected: false };
	let st: SwarmState;
	try {
		st = await readState(p, cwd);
	} catch (err: any) {
		result.error = `readState failed: ${String((err as Error)?.message || err)}`;
		return result;
	}
	const agent = st.agents[agentId];
	if (!agent) {
		result.error = "agent not registered";
		return result;
	}
	result.mode = "identity_reload";
	if (agent.tmuxTarget && agent.tmuxTarget !== "unknown") {
		try {
			const alive = await isTmuxRunning(pi, agent.tmuxTarget);
			result.tmuxAlive = alive;
			if (alive) {
				// tmux /new-style refresh: reset the running agent's conversation context so the next
				// iteration starts clean. Best-effort; if it cannot be sent we still identity-reload below.
				try {
					await tmux(pi, ["send-keys", "-t", agent.tmuxTarget, "/new", "Enter"], 10_000);
					result.mode = "tmux_new";
					await sleep(SPAWN_SETTLE_MS);
				} catch (err: any) {
					await trace(p, "loop.refresh.tmux_new_failed", { agentId, error: String((err as Error)?.message || err) });
				}
			}
		} catch (err: any) {
			result.error = `tmux probe failed: ${String((err as Error)?.message || err)}`;
		}
	}
	try {
		const r = await reloadIdentity(pi, cwd, p, agentId, { note: "loop refresh after plan recorded", source: "loop" });
		result.injected = r.injected;
		result.tmuxAlive = result.tmuxAlive || r.tmuxAlive;
		if (result.mode === "identity_reload" && r.injected) result.mode = "identity_reload";
	} catch (err: any) {
		result.error = (result.error ? result.error + "; " : "") + `identity reload failed: ${String((err as Error)?.message || err)}`;
	}
	return result;
}

// Read-only snapshot of loop state for a task (used by the swarm_loop_status tool and the
// `/swarm loop status` command). Enriches the current round's proposals with live ack/response/reply
// state. Returns enabled:false when no loop is configured so callers can report a clean no-op.
export async function loopStatusSnapshot(p: Paths, cwd: string, taskId: string): Promise<{ enabled: boolean; started: boolean; taskId: string; proposalState?: string; config?: LoopConfig; loop?: LoopState; round?: LoopRound; proposals?: LoopProposal[]; paths: { loopStateFile: string; historyFile?: string; proposalsArtifact?: string; planArtifact?: string } }> {
	const tp = taskPaths(p, taskId);
	if (!existsSync(tp.taskJson)) throw new Error(`TASK_NOT_FOUND: ${taskId}`);
	const task = await readTaskState(tp.taskJson);
	const cfg = getLoopConfig(task.loop);
	const loop = await readLoopState(p, taskId);
	const basePaths = { loopStateFile: relative(cwd, loopStateFile(p, taskId)) };
	if (!cfg || !loop) return { enabled: Boolean(cfg), started: false, taskId, proposalState: "not_started", config: cfg, paths: basePaths };
	const st = await readState(p, cwd);
	const round = loop.rounds[loop.rounds.length - 1];
	const proposals = round ? await collectLoopProposalStatus(p, st, round) : [];
	const pending = proposals.filter((x) => x.status === "requested").length;
	const proposalState: string = loop.phase === "planned" ? "planned" : loop.phase === "executing" ? "executing" : (pending > 0 ? "collecting_proposals" : "ready_to_plan");
	return {
		enabled: true, started: true, taskId, proposalState, config: loop.config, loop, round, proposals,
		paths: {
			loopStateFile: relative(cwd, loopStateFile(p, taskId)),
			historyFile: relative(cwd, loopHistoryFile(p, taskId)),
			proposalsArtifact: round ? relative(cwd, join(tp.artifacts, `proposals-round-${round.round}.md`)) : undefined,
			planArtifact: round?.plan ? relative(cwd, join(tp.artifacts, "next-plan.md")) : undefined,
		},
	};
}

// Orchestrator write path (used by the swarm_loop_plan tool and the `/swarm loop plan` command):
// record/synthesize the next-iteration plan, write artifacts/next-plan.md, advance loop state to
// 'planned', append a durable round record to loop history, and optionally best-effort refresh
// configured refreshAgents. Refresh runs OUTSIDE the swarm lock (reloadIdentity takes the lock), so
// this function must NOT be called while holding the lock. Refresh failures are captured per-agent
// and never corrupt loop state.
export async function recordLoopPlan(pi: ExtensionAPI, cwd: string, p: Paths, taskId: string, opts: { summary: string; nextSteps?: string; artifact?: string; refresh?: boolean }): Promise<{ artifact: string; phase: LoopPhase; round: number; refreshResults: LoopRefreshResult[]; loopStateFile: string; historyFile: string }> {
	const me = currentAgentId();
	const tp = taskPaths(p, taskId);
	if (!existsSync(tp.taskJson)) throw new Error(`TASK_NOT_FOUND: ${taskId}`);
	const task = await readTaskState(tp.taskJson);
	const cfg = getLoopConfig(task.loop);
	if (!cfg) throw new Error(`LOOP_NOT_ENABLED: task ${taskId} has no enabled loop (task.loop.enabled !== true)`);;
	const artifactRel = opts.artifact || "artifacts/next-plan.md";
	if (!isSafeRelativePath(artifactRel)) throw new Error(`PATH_OUTSIDE_TASK: artifact must be relative, no ..: ${artifactRel}`);
	const loop = await readLoopState(p, taskId);
	if (!loop) throw new Error(`LOOP_NOT_STARTED: no loop state for ${taskId}; the task must close terminal-done first to start the proposal round`);
	const round = loop.rounds[loop.rounds.length - 1];
	if (!round) throw new Error(`LOOP_NO_ROUND: loop state for ${taskId} has no round to plan`);
	const st = await readState(p, cwd);
	const proposals = await collectLoopProposalStatus(p, st, round);
	const plan: LoopPlan = { artifact: artifactRel, summary: opts.summary, nextSteps: opts.nextSteps, createdAt: now(), createdBy: me };
	round.plan = plan;
	round.phase = "planned";
	round.endedAt = now();
	loop.phase = "planned";
	await writeLoopState(p, loop);
	await writeNextPlanArtifact(tp, round.round, plan, proposals);
	await writeProposalsArtifact(tp, round, proposals);
	await appendLoopHistory(p, taskId, { type: "plan_recorded", round: round.round, summary: opts.summary, artifact: artifactRel, createdBy: me });
	await trace(p, "loop.plan", { taskId, round: round.round, artifact: artifactRel, proposals: proposals.length, by: me });
	// Auto-ack the round's orchestrator nudge (requiresAck:true): recording a plan IS the response, so stop
	// the bounded re-trigger reminders. Best-effort and lock-safe: no-op if the nudge was never sent / already
	// acked. Looked up by idempotencyKey (from+to+key) to avoid any message-id coupling.
	await withLock(p, async () => {
		const s = await readState(p, cwd);
		const nudgeKey = `loop:${taskId}:round:${round.round}:nudge:orchestrator`;
		const rec = findIdempotentMessage(s, "orchestrator", "orchestrator", nudgeKey) || Object.values(s.messages || {}).find((r) => r.idempotencyKey === nudgeKey && r.to === "orchestrator");
		if (rec && rec.requiresAck && !rec.ackedAt) {
			const at = now();
			s.messages[rec.id] = { ...rec, status: "acked", ackedAt: at, updatedAt: at, lastAck: { by: me, status: "done", note: "auto-acked: loop plan recorded", at } };
			s.delivered["orchestrator"] = Array.from(new Set([...(s.delivered["orchestrator"] || []), rec.id]));
			await writeState(p, s);
			await trace(p, "message.ack", { id: rec.id, agentId: "orchestrator", status: "done", note: "auto-acked: loop plan recorded" });
		}
	});
	const wantRefresh = opts.refresh !== undefined ? opts.refresh : Boolean(cfg.refreshAgents && cfg.refreshAgents.length);
	const refreshResults: LoopRefreshResult[] = [];
	if (wantRefresh && cfg.refreshAgents && cfg.refreshAgents.length) {
		loop.phase = "refreshing";
		await writeLoopState(p, loop);
		for (const agentId of cfg.refreshAgents) {
			try {
				const r = await refreshLoopAgent(pi, cwd, p, agentId);
				refreshResults.push(r);
				await trace(p, "loop.refresh", { taskId, round: round.round, agentId, mode: r.mode, tmuxAlive: r.tmuxAlive, injected: r.injected, error: r.error });
			} catch (err: any) {
				refreshResults.push({ agentId, mode: "skipped", error: String((err as Error)?.message || err) });
			}
		}
		round.refreshResults = [...(round.refreshResults || []), ...refreshResults];
		loop.phase = "planned";
		await writeLoopState(p, loop);
		await appendLoopHistory(p, taskId, { type: "refresh_done", round: round.round, refreshResults });
	}
	// Harness-as-watcher: the plan is now recorded but the task graph is still `done` (recordLoopPlan never
	// reopens nodes). Nudge the orchestrator to reopen immediately, instead of waiting up to the throttled
	// pump reconcile. Idempotent per round (the pump reconcile will re-send/ack as needed).
	await withLock(p, async () => {
		const s = await readState(p, cwd);
		await sendLoopReopenNudgeLocked(pi, cwd, p, s, taskId, round.round, artifactRel);
		await writeState(p, s);
	});
	return { artifact: artifactRel, phase: loop.phase, round: round.round, refreshResults, loopStateFile: relative(cwd, loopStateFile(p, taskId)), historyFile: relative(cwd, loopHistoryFile(p, taskId)) };
}

// === Loop watcher: detect states that need an orchestrator ACTION and nudge it. ===
// Per the loop's design the harness is a state-checker + nudger; the orchestrator (an agent) performs every
// state change (plan, reopen graph, execute). The key gap this closes: after swarm_loop_plan, loop.phase
// becomes "planned" but recordLoopPlan does NOT reopen the task graph — so iteration N+1 never executes
// until the orchestrator resets the nodes. We detect "plan recorded but task still done" and nudge the
// orchestrator to reopen (idempotent per round; auto-acked once the task leaves `done`). Both helpers
// assume the caller holds the state lock (they mutate st in place and append to the mailbox file).

export async function sendLoopReopenNudgeLocked(pi: ExtensionAPI, cwd: string, p: Paths, st: SwarmState, taskId: string, round: number, planArtifact: string): Promise<void> {
	const key = `loop:${taskId}:round:${round}:nudge:reopen`;
	if (findIdempotentMessage(st, "orchestrator", "orchestrator", key)) return; // idempotent: one reopen nudge per round
	let iterNodes = "the iteration nodes";
	try { iterNodes = Object.keys((await readTaskState(taskPaths(p, taskId).taskJson)).nodes || {}).join(", ") || iterNodes; } catch {}
	try {
		await deliverMessageLocked(pi, cwd, p, st, {
			to: "orchestrator",
			subject: `Task ${taskId} iteration loop: plan recorded but graph still closed — reopen to run round ${round}`,
			body: `A next-iteration plan for ${taskId} (round ${round}) was recorded at \`${planArtifact}\`, but the task is still \`done\` — round ${round} will not execute until you REOPEN the graph.\n\nReopen by resetting each iteration node to pending:\n  swarm_update_task(taskId="${taskId}", nodeId=<node>, status="pending", force=true)\nfor: ${iterNodes}.\nThe task derives back to in_progress and agents run round ${round}; when it closes terminal-done again the loop auto-kicks off round ${round + 1}.\n\n(Action required. Auto-acknowledged once the task leaves \`done\`.)`,
			requiresAck: true,
			idempotencyKey: key,
		});
	} catch (err: any) {
		await trace(p, "loop.reopen_nudge_failed", { taskId, round, error: String((err as Error)?.message || err) }).catch(() => {});
	}
}

// Ack a loop nudge (by idempotencyKey) if it exists, requires ack, and hasn't been acked yet. Helper for
// reconcileLoopNudgesLocked so auto-ack logic (on plan-recorded / task-left-done) stays in one place.
export function ackLoopNudgeLocked(st: SwarmState, key: string, nowMs: number, note: string): void {
	const rec = findIdempotentMessage(st, "orchestrator", "orchestrator", key) || Object.values(st.messages || {}).find((r) => r.to === "orchestrator" && r.idempotencyKey === key);
	if (rec && rec.requiresAck && !rec.ackedAt) {
		const at = new Date(nowMs).toISOString();
		st.messages[rec.id] = { ...rec, status: "acked", ackedAt: at, updatedAt: at, lastAck: { by: "orchestrator", status: "done", note, at } };
		st.delivered["orchestrator"] = Array.from(new Set([...(st.delivered["orchestrator"] || []), rec.id]));
	}
}

// Registered swarm agents that could propose a next-iteration change (every agent except the
// orchestrator). Used by Flow-A nudges so an EMPTY proposalAgents pool still tells the orchestrator WHO
// it can ask for ideas, instead of silently skipping the proposal stage. The harness never auto-fans-out:
// it only surfaces the option; the orchestrator (an agent) decides whether to solicit proposals.
export function availableProposers(st: SwarmState): string[] {
	return Object.values(st.agents || {}).filter((a) => a.id !== "orchestrator").map((a) => a.id).sort();
}

// Watcher cell #2: "ready to plan" — the round is awaiting a plan AND there is nothing left to wait for
// (empty proposalAgents pool, or all requested proposals replied). This is the exact dead-end an empty
// proposalAgents pool hits: kickoff sets phase=awaiting_plan, and without this nudge the orchestrator may
// sit on a stale kickoff nudge forever. Idempotent per round; auto-acked once a plan is recorded.
export async function sendLoopPlanNowNudgeLocked(pi: ExtensionAPI, cwd: string, p: Paths, st: SwarmState, taskId: string, round: number, emptyPool: boolean, workers: string[]): Promise<void> {
	const key = `loop:${taskId}:round:${round}:nudge:plan-now`;
	if (findIdempotentMessage(st, "orchestrator", "orchestrator", key)) return; // idempotent: one plan-now nudge per round
	try {
		await deliverMessageLocked(pi, cwd, p, st, {
			to: "orchestrator",
			subject: `Task ${taskId} iteration loop: round ${round} ready to plan — synthesize the next plan`,
			body: `Task ${taskId} iteration loop round ${round} is READY TO PLAN — ${emptyPool ? "no proposal agents are configured (task.loop.proposalAgents is empty)" : "all requested proposal agents have replied"}.${emptyPool && workers.length ? ` Two options: (1) synthesize the plan directly, OR (2) if you want diverse ideas first, send proposal requests yourself to [${workers.join(", ")}] (\`swarm_send_message\` requiresResponse:true / \`swarm_task_message\`), read their replies, then plan. Loop status does NOT auto-track ad-hoc proposals.` : ""} Synthesize the next-iteration plan now.\n\n1. Get carry-forward context: \`swarm_iteration_context\` / \`swarm_iteration_status\` (best run, metrics vs baseline, active memories) + the latest distill_memory artifact.\n2. Record the plan: \`swarm_loop_plan(taskId="${taskId}", summary=..., nextSteps=...)\` -> writes artifacts/next-plan.md. (A separate reminder then asks you to reopen the graph so the round executes.)\n\n(Action required. Auto-acknowledged once a plan is recorded.)`,
			requiresAck: true,
			idempotencyKey: key,
		});
	} catch (err: any) {
		await trace(p, "loop.plan_now_nudge_failed", { taskId, round, error: String((err as Error)?.message || err) }).catch(() => {});
	}
}

// Watcher entry point: called from the orchestrator pump (throttled) and from recordLoopPlan (immediate).
// Never mutates task/loop state — only sends/acks orchestrator nudges. Three cells:
//   (1) phase=planned & task done -> nudge to REOPEN the graph (the plan exists but the graph is closed).
//   (2) not yet planned & no pending proposals (empty pool OR all replied) -> nudge to PLAN NOW.
//   (3) task left `done` (iteration executing) -> auto-ack that round's reopen + plan-now nudges.
export async function reconcileLoopNudgesLocked(pi: ExtensionAPI, cwd: string, p: Paths, st: SwarmState, nowMs: number): Promise<void> {
	if (!existsSync(p.tasksDir)) return;
	let entries: string[] = [];
	try { entries = await readdir(p.tasksDir); } catch { return; }
	for (const taskId of entries) {
		const tp = taskPaths(p, taskId);
		if (!existsSync(tp.taskJson)) continue;
		let task: TaskState;
		try { task = await readTaskState(tp.taskJson); } catch { continue; }
		if (!getLoopConfig(task.loop)) continue;
		const loop = await readLoopState(p, taskId);
		if (!loop) continue;
		const round = loop.currentRound;
		const reopenKey = `loop:${taskId}:round:${round}:nudge:reopen`;
		const planNowKey = `loop:${taskId}:round:${round}:nudge:plan-now`;
		// Task moved off `done` (reopened / in_progress): the iteration is executing. Auto-ack this round's
		// reopen + plan-now nudges AND the kickoff nudge so reminders stop while the work runs. The kickoff
		// nudge used to be acked ONLY by recordLoopPlan; if the orchestrator reopened WITHOUT recording a plan
		// it stayed unacked and the pump re-triggered it (capped 3x), wasting turns on "duplicate" responses.
		if (task.status !== "done") {
			ackLoopNudgeLocked(st, reopenKey, nowMs, "auto-acked: task left done (graph reopened)");
			ackLoopNudgeLocked(st, planNowKey, nowMs, "auto-acked: task left done (graph reopened)");
			ackLoopNudgeLocked(st, `loop:${taskId}:round:${round}:nudge:orchestrator`, nowMs, "auto-acked: task left done (orchestrator reopened)");
			// Design B: the graph IS the iteration driver (this task has its own plan_iteration node). When the
			// orchestrator reopens the graph the round has entered execution — advance loop phase out of the
			// mid-setup set (awaiting_plan / collecting_proposals) to "executing" so the next close-done kicks
			// off a fresh round. kickoff's guard skips only mid-setup phases, not executing/planned, so rounds
			// advance WITHOUT a separate swarm_loop_plan when the graph owns the planning.
			if (loop.phase === "awaiting_plan" || loop.phase === "collecting_proposals") {
				const rr = loop.rounds[loop.rounds.length - 1];
				if (rr) rr.phase = "executing";
				loop.phase = "executing";
				loop.updatedAt = new Date(nowMs).toISOString();
				try { await writeLoopState(p, loop); } catch {}
				await trace(p, "loop.round_executing", { taskId, round, phase: "executing" }).catch(() => {});
			}
			continue;
		}
		// task.status === "done" (graph closed)
		if (loop.phase === "planned") {
			// Plan recorded but graph still closed -> nudge to reopen. The plan-now ask is satisfied -> ack it.
			ackLoopNudgeLocked(st, planNowKey, nowMs, "auto-acked: loop plan recorded");
			const planArtifact = loop.rounds[loop.rounds.length - 1]?.plan?.artifact || "artifacts/next-plan.md";
			await sendLoopReopenNudgeLocked(pi, cwd, p, st, taskId, round, planArtifact);
		} else if (loop.phase !== "executing") {
			// Not yet planned (awaiting_plan / collecting_proposals). If all proposals are in (or the pool is
			// empty) -> ready_to_plan -> nudge synthesize now. (Skip the executing phase: that round already ran;
			// kickoff will create the next round on this close-done, briefly racing before it resets the phase.)
			const roundRec = loop.rounds[loop.rounds.length - 1];
			const proposals = roundRec ? await collectLoopProposalStatus(p, st, roundRec) : [];
			const pending = proposals.filter((x) => x.status === "requested").length;
			if (pending === 0) { const workers = availableProposers(st); await sendLoopPlanNowNudgeLocked(pi, cwd, p, st, taskId, round, proposals.length === 0, workers); }
		}
	}
}
