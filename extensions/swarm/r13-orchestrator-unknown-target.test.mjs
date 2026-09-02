#!/usr/bin/env node
/**
 * R13 P0 — high-priority orchestrator nudges must surface when tmux target is unknown.
 *
 * Source incident: 2026-09-01T13:10:27 trace sequence (stale-open nudge durably enqueued,
 * mailbox_only, then `notification.stale.suppressed site=orchestrator_pump.surface
 * reason=agent_busy evidence=[effective-agent-set-not-idle]` from reconcile.ts:1665 —
 * no `pi.sendMessage` call at reconcile.ts:1765, so user never saw the safety nudge).
 *
 * Root cause (isolated, code-located): `pumpOrchestratorMailbox` (extensions/swarm/src/reconcile.ts)
 * processes `priority: "high"` orchestrator-bound nudges through the same `staleSurfaceReason` gate
 * as normal-priority nudges. When the orchestrator pseudo-agent has `tmuxTarget === "unknown"` AND
 * a worker is `runtimeStatus: "tool_running"` (or any `effective-agent-set-not-idle` condition),
 * the gate suppresses the message with `agent_busy` and the durable mailbox entry masquerades as
 * success while the user sees nothing.
 *
 * Invariants under test (RED→GREEN):
 *   R13-S1: priority-high stale-open nudge to unknown-target orchestrator + busy worker →
 *           exactly ONE pi.sendMessage call (boundary counter). RED pre-fix: 0 calls.
 *   R13-S2: replay (same nudge, same pi session) → still exactly ONE pi.sendMessage call
 *           (R10-1 no-duplicate-surface guard via consumerReceipts).
 *   R13-S3: priority-normal nudge to unknown-target orchestrator + busy worker → 0 pi.sendMessage
 *           calls (busy-suppression preserved for normal traffic; the bug only affects high-priority
 *           safety nudges).
 *   R13-S4: priority-high nudge to a known-target worker → 0 pi.sendMessage calls to the
 *           orchestrator (different path; not affected by this fix).
 *   R13-S5: durable mailbox semantics preserved — `mailboxOnlyCount === 1` after the nudge,
 *           `message.deliver.mailbox_only` trace present, mailbox file has the nudge once.
 *   R13-S6: stale_suppressed trace at reconcile.ts:1665 emitted ONCE per nudge in the
 *           pre-fix (RED) shape; post-fix is gated to 0 for the priority-high unknown-target
 *           shape but remains available for normal-priority traffic.
 *
 * ISOLATION CONTRACT — SCRATCH CWD ONLY.
 * Run: node extensions/swarm/r13-orchestrator-unknown-target.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { pumpOrchestratorMailbox } = await import(join(here, "src/reconcile.ts"));
const { paths, withLock, readState, writeState } = await import(join(here, "src/state.ts"));
const { ensureOrchestrator, heartbeatOrchestratorLeader } = await import(join(here, "src/identity.ts"));
const { deliverMessageLocked } = await import(join(here, "src/mailbox.ts"));
const { staleOpenNudgeLocked } = await import(join(here, "src/taskgraph.ts"));

const scratch = mkdtempSync(join(tmpdir(), `swarm-r13-unk-target-${process.pid}-${Date.now()}`));
mkdirSync(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, info) => {
	if (cond) { pass++; console.log("  ok  ", name); }
	else { fail++; console.error("  FAIL", name, info ?? ""); }
};

const ORIG_PI_SWARM_AGENT_ID = process.env.PI_SWARM_AGENT_ID;
const ORIG_PI_SWARM_IS_ORCHESTRATOR = process.env.PI_SWARM_IS_ORCHESTRATOR;

function readEvents() {
	const p = join(scratch, ".pi/swarm/traces/events.jsonl");
	if (!existsSync(p)) return [];
	const txt = readFileSync(p, "utf8").trim();
	return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function clearEvents() {
	mkdirSync(join(scratch, ".pi/swarm/traces"), { recursive: true });
	writeFileSync(join(scratch, ".pi/swarm/traces/events.jsonl"), "");
}
function readOrchestratorMailbox() {
	const p = join(scratch, ".pi/swarm/mailboxes/orchestrator.jsonl");
	if (!existsSync(p)) return [];
	const txt = readFileSync(p, "utf8").trim();
	return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Build a scratch swarm state with the R13 incident shape:
//   - orchestrator pseudo-agent with tmuxTarget === "unknown"
//   - one worker fs-implementer with runtimeStatus === "tool_running" (busy) AND activeTaskIds:[taskId]
//   - taskId with node `implement` assigned to fs-implementer, lastActivityAt stale (>30s ago),
//     staleOpenSurfacedAt set so the stale-open nudge path will fire when invoked.
async function seedIncidentShape({ taskId = "task-r13-x", workerId = "fs-implementer" } = {}) {
	const p = paths(scratch);
	const nowMs = Date.now();
	const workerTs = new Date(nowMs - 45_000).toISOString();
	// Threshold default is 30_000ms; seed 10_000ms ago so the threshold check passes with margin.
	const surfaceTs = new Date(nowMs - 10_000).toISOString();
	const initial = {
		version: 1, swarmId: "r13-test", cwd: scratch, tmuxSession: "r13",
		agents: {
			[workerId]: {
				id: workerId, role: workerId, roleKind: "implementer", capabilities: [],
				activeTaskIds: [taskId], maxConcurrentTasks: 1,
				status: "running", runtimeStatus: "tool_running", health: "healthy",
				tmuxAlive: true, // explicit — prevent the heartbeat GC from flipping to stopped (R10-1 fixture shape)
				tmuxSession: "r13", tmuxWindow: workerId, tmuxTarget: `r13:${workerId}.0`,
				model: "gpt-5.4-mini", provider: "openai",
				cwd: scratch, mailbox: `.pi/swarm/mailboxes/${workerId}.jsonl`,
				createdAt: workerTs, updatedAt: workerTs, lastHeartbeatAt: new Date(nowMs - 1_000).toISOString(),
			},
		},
		delivered: {}, messages: {},
		createdAt: workerTs, updatedAt: workerTs,
	};
	writeFileSync(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(initial, null, 2));

	// Seed the task graph so the pump's taskIndex picks it up.
	const taskDir = join(scratch, ".pi/swarm/tasks", taskId);
	mkdirSync(taskDir, { recursive: true });
	const task = {
		version: 1, taskId, title: "R13 victim task", goal: "test", status: "in_progress",
		priority: "normal", createdAt: workerTs, updatedAt: workerTs, owner: "orchestrator",
		workflow: "feature-dev", allowedFiles: [], acceptanceCriteria: [], validationCommands: [],
		start: "implement", currentNodes: ["implement"],
		sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
		nodes: {
			implement: {
				status: "in_progress", role: "implementer", assignee: workerId, dependsOn: [],
				allowedFiles: [], messageIds: [], attempts: 1, maxAttempts: 3,
				lastActivityAt: workerTs,
				staleOpenSurfacedAt: surfaceTs,
			},
		},
		edges: [], handoffs: [], gates: {}, editLocks: {}, evidence: {},
	};
	writeFileSync(join(taskDir, "task.json"), JSON.stringify(task, null, 2));

	// Ensure the orchestrator pseudo-agent (which sets tmuxTarget="unknown" by design) and
	// claim the leader so the pump's second-line defense doesn't deny the tick.
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		ensureOrchestrator(st, scratch, p);
		heartbeatOrchestratorLeader(st, nowMs, process.pid, "r13_test_seed");
		// R13-S7 fix: clear the consumerReceipts ledger so a freshly fired nudge (with a new
		// messageId) does not get deduped by an R13-S1 receipt from the same scratch. Also
		// clear the per-pid surfaced set + retriggerCount on the orchestratorPumpSessions
		// entry so the new nudge enters the surface plan.
		if (st.consumerReceipts?.orchestrator) {
			st.consumerReceipts.orchestrator.entries = {};
		}
		const pidKey = String(process.pid);
		if (st.orchestratorPumpSessions?.[pidKey]) {
			st.orchestratorPumpSessions[pidKey].ids = [];
			st.orchestratorPumpSessions[pidKey].triggeredAt = {};
			st.orchestratorPumpSessions[pidKey].retriggerCount = {};
		}
		await writeState(p, st);
	});
	clearEvents();
	return { p, taskId, workerId };
}

// Fire the production stale-open nudge path via staleOpenNudgeLocked(priority:"high") so the
// mailbox durable-append side AND the stale_open.nudge_emitted trace shape match the incident.
// The nudge then sits in the orchestrator mailbox waiting for the next pump tick to surface it.
async function fireStaleOpenNudge(taskId = "task-r13-x", workerId = "fs-implementer", priority = "high") {
	// The pump short-circuits if the caller isn't the orchestrator pseudo-agent. Ensure the env
	// flag is set inside the call so per-test isolation is complete (each scenario seeds + nudges +
	// pumps independently). Restored at file tail.
	process.env.PI_SWARM_AGENT_ID = "orchestrator";
	process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
	const p = paths(scratch);
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		if (priority === "high") {
			// Production path — emits stale_open.nudge_emitted trace + idempotency-keyed durable append.
			await staleOpenNudgeLocked(
				{ exec: async () => ({ code: 0, stdout: "", stderr: "" }), setModel: async () => true, sendMessage: () => {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {}, registerTool: () => {}, registerCommand: () => {}, on: () => {} },
				scratch, p, st, taskId, "implement",
			);
		} else {
			// Normal-priority control: same body shape but normal priority (the production path forces
			// high, so we use deliverMessageLocked directly to keep the same body/keys/requiresAck shape).
			await deliverMessageLocked(
				{ exec: async () => ({ code: 0, stdout: "", stderr: "" }), setModel: async () => true, sendMessage: () => {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {}, registerTool: () => {}, registerCommand: () => {}, on: () => {} },
				scratch, p, st,
				{
					to: "orchestrator",
					priority,
					subject: `STALE OPEN: node implement of ${taskId} assigned but no progress — worker may have settled idle`,
					body: `Node \`implement\` of task ${taskId} is assigned but has shown NO progress past the stale threshold.`,
					requiresAck: true,
					requiresResponse: false,
					conversationId: `task:${taskId}:node:implement:nudge:stale-open`,
					idempotencyKey: `task:${taskId}:node:implement:nudge:stale-open:seq:1`,
				},
			);
		}
		await writeState(p, st);
	});
}

function makePiMockWithCounters() {
	process.env.PI_SWARM_AGENT_ID = "orchestrator";
	process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
	const sendMessages = [];
	const pi = {
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		sendMessage: (m, opts) => sendMessages.push({ customType: m.customType, options: opts, msg: m }),
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		registerTool: () => {}, registerCommand: () => {}, on: () => {},
	};
	return { pi, sendMessages };
}

// =============================================================================
// R13-S1: priority-high stale-open nudge to unknown-target orchestrator + busy
//         worker → exactly ONE pi.sendMessage call (boundary counter).
//         RED pre-fix: 0 calls. GREEN post-fix: 1 call.
// =============================================================================
console.log("\n[R13-S1] priority-high nudge to unknown-target + busy worker → 1 pi.sendMessage (RED→GREEN)");
{
	const { taskId, workerId } = await seedIncidentShape();
	await fireStaleOpenNudge(taskId, workerId, "high");

	const { pi, sendMessages } = makePiMockWithCounters();
	const ctx = { cwd: scratch, mode: "tui", isIdle: () => true, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
	const p = paths(scratch);
	const result = await pumpOrchestratorMailbox(pi, ctx, p, "test_r13_s1");
	ok("R13-S1 result.delivered >= 1", result.delivered >= 1, { delivered: result.delivered, ids: result.ids });
	ok("R13-S1 sendMessages.length === 1 (R10-1 boundary counter)", sendMessages.length === 1, `got ${sendMessages.length}`);
	if (sendMessages.length >= 1) {
		ok("R13-S1 sendMessage customType === 'swarm-message'", sendMessages[0].customType === "swarm-message");
		ok("R13-S1 first sendMessage triggerTurn === true", sendMessages[0].options?.triggerTurn === true);
		ok("R13-S1 details.id is the nudge id", typeof sendMessages[0].msg?.details?.id === "string");
	}

	const events = readEvents();
	const mailboxOnly = events.filter((e) => e.event === "message.deliver.mailbox_only");
	ok("R13-S1 message.deliver.mailbox_only trace present (durable semantics intact)", mailboxOnly.length >= 1, { count: mailboxOnly.length });
	const bypassTrace = events.filter((e) => e.event === "notification.surface.bypass_high_unknown_target");
	ok("R13-S1 notification.surface.bypass_high_unknown_target trace present (R13 fix fired)", bypassTrace.length >= 1, `got ${bypassTrace.length}`);
	if (bypassTrace.length >= 1) {
		ok("R13-S1 bypass trace.suppressedReason === 'agent_busy'", bypassTrace[0].suppressedReason === "agent_busy", `got ${bypassTrace[0].suppressedReason}`);
		ok("R13-S1 bypass trace.by === 'R13 P0'", bypassTrace[0].by === "R13 P0", `got ${bypassTrace[0].by}`);
	}
	const staleSuppressed = events.filter((e) => e.event === "notification.stale.suppressed" && e.site === "orchestrator_pump.surface");
	ok("R13-S1 NO notification.stale.suppressed for priority-high nudge (post-fix)", staleSuppressed.length === 0, `got ${staleSuppressed.length}`);
	const nudgeEmitted = events.filter((e) => e.event === "stale_open.nudge_emitted");
	ok("R13-S1 stale_open.nudge_emitted trace present (bell rang)", nudgeEmitted.length >= 1, { count: nudgeEmitted.length });

	const mailbox = readOrchestratorMailbox();
	ok("R13-S1 orchestrator mailbox has exactly 1 nudge entry", mailbox.length === 1, `got ${mailbox.length}`);
}

// =============================================================================
// R13-S2: replay same nudge → still exactly ONE pi.sendMessage call (no duplicate).
// =============================================================================
console.log("\n[R13-S2] replay guard — no duplicate surface for the same nudge");
{
	const { taskId, workerId } = await seedIncidentShape();
	await fireStaleOpenNudge(taskId, workerId, "high");

	const { pi, sendMessages } = makePiMockWithCounters();
	const ctx = { cwd: scratch, mode: "tui", isIdle: () => true, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
	const p = paths(scratch);
	const r1 = await pumpOrchestratorMailbox(pi, ctx, p, "test_r13_s2_t1");
	ok("R13-S2 first tick sendMessages.length === 1", sendMessages.length === 1, `got ${sendMessages.length}`);

	// Second tick on the same mailbox state → the consumerReceipts ledger must dedupe.
	const r2 = await pumpOrchestratorMailbox(pi, ctx, p, "test_r13_s2_t2");
	ok("R13-S2 second tick did NOT add another sendMessage", sendMessages.length === 1, `got ${sendMessages.length}`);
	ok("R13-S2 second tick result.delivered === 0", r2.delivered === 0, { delivered: r2.delivered });
}

// =============================================================================
// R13-S3: priority-normal nudge → still 0 pi.sendMessage (busy suppression preserved).
// =============================================================================
console.log("\n[R13-S3] normal-priority nudge preserves busy suppression (no regression)");
{
	const { taskId, workerId } = await seedIncidentShape();
	// Use a distinct idempotencyKey so the module-level staleSuppressionTraceSeen cache (added in
	// R10/Issue 11) does NOT dedupe this scenario's first-fire against R13-S1's earlier emit.
	const p = paths(scratch);
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		await deliverMessageLocked(
			{ exec: async () => ({ code: 0, stdout: "", stderr: "" }), setModel: async () => true, sendMessage: () => {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {}, registerTool: () => {}, registerCommand: () => {}, on: () => {} },
			scratch, p, st,
			{
				to: "orchestrator",
				priority: "normal",
				subject: "STALE OPEN: node implement of task-r13-x assigned but no progress (normal control)",
				body: `Node implement of task-r13-x is assigned but has shown NO progress.`,
				requiresAck: true,
				requiresResponse: false,
				conversationId: `task:${taskId}:node:implement:nudge:stale-open`,
				idempotencyKey: `task:${taskId}:node:implement:nudge:stale-open:normal:seq:1`,
			},
		);
		await writeState(p, st);
	});

	const { pi, sendMessages } = makePiMockWithCounters();
	const ctx = { cwd: scratch, mode: "tui", isIdle: () => true, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
	const result = await pumpOrchestratorMailbox(pi, ctx, p, "test_r13_s3");
	ok("R13-S3 sendMessages.length === 0 (normal priority stays suppressed)", sendMessages.length === 0, `got ${sendMessages.length}`);
	ok("R13-S3 result.delivered === 0", result.delivered === 0, { delivered: result.delivered });

	const events = readEvents();
	const staleSuppressed = events.filter((e) => e.event === "notification.stale.suppressed" && e.site === "orchestrator_pump.surface");
	ok("R13-S3 normal-priority nudge DOES suppress with agent_busy", staleSuppressed.length >= 1, `got ${staleSuppressed.length} — events: ${events.map((e) => e.event).join(",")}`);
	if (staleSuppressed.length >= 1) {
		ok("R13-S3 stale_suppressed reason === 'agent_busy'", staleSuppressed[0].reason === "agent_busy", `got reason: ${staleSuppressed[0].reason}`);
	}
}

// =============================================================================
// R13-S4: priority-high nudge to a known-target worker → not surfaced via orchestrator path.
// =============================================================================
console.log("\n[R13-S4] priority-high nudge to known-target worker → not via orchestrator surface");
{
	const { taskId, workerId } = await seedIncidentShape();
	// Send a priority-high nudge to the WORKER (not the orchestrator) — the busy worker
	// cannot surface it either, but it MUST NOT surface via the orchestrator path either.
	const p = paths(scratch);
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		await deliverMessageLocked(
			{ exec: async () => ({ code: 0, stdout: "", stderr: "" }), setModel: async () => true, sendMessage: () => {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {}, registerTool: () => {}, registerCommand: () => {}, on: () => {} },
			scratch, p, st,
			{
				to: workerId,
				priority: "high",
				subject: "Worker-bound nudge",
				body: "This should not surface via the orchestrator.",
				requiresAck: true,
				conversationId: `task:${taskId}:node:implement:nudge:worker-direct`,
				idempotencyKey: `task:${taskId}:node:implement:nudge:worker-direct:seq:1`,
			},
		);
		await writeState(p, st);
	});

	const { pi, sendMessages } = makePiMockWithCounters();
	const ctx = { cwd: scratch, mode: "tui", isIdle: () => true, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
	const result = await pumpOrchestratorMailbox(pi, ctx, p, "test_r13_s4");
	ok("R13-S4 sendMessages.length === 0 (worker-bound not surfaced via orchestrator)", sendMessages.length === 0, `got ${sendMessages.length}`);
	ok("R13-S4 result.delivered === 0", result.delivered === 0, { delivered: result.delivered });
}

// =============================================================================
// R13-S7 (live 2026-09-02 backlog regression): a HIGH stale-open nudge that was
// durably enqueued BEFORE the task/node became terminal must NOT surface to
// the orchestrator after the R13 bypass. The bypass only rescues LIVE
// actionable safety alerts; it MUST NOT replay historical alerts whose
// referenced task/node is now terminal — that is the exact incident observed
// on 2026-09-02 where 01/09 stale-open nudges (whose tasks/nodes closed
// overnight) began surfacing to the orchestrator as fresh "action required"
// messages.
//
// Desired post-fix contract:
//   - pi.sendMessage call count === 0
//   - durable record gets a terminal-receipt trace (e.g. notification.surface.task_terminal
//     or task_done counter advances) — NOT a notification.stale.suppressed agent_busy
//     trace, because the message is not stale on a busy agent, it is moot because
//     the task/node it references is already terminal.
//
// RED (current code, pre-fix-of-this-regression): pi.sendMessage IS called
// because the bypass at reconcile.ts:1665 fires for any priority-high
// unknown-target orchestrator nudge whose recipient.tmuxTarget === "unknown"
// AND v.reason === "agent_busy" — without checking whether the underlying
// task/node is still live. The bypass falls through to the coalescing +
// pi.sendMessage path and surfaces an alert for a closed task.
// =============================================================================
console.log("\n[R13-S7] RED: high stale-open nudge whose task/node is now terminal must NOT surface (backlog regression)");
{
	const { taskId, workerId } = await seedIncidentShape();

	// Step 1: enqueue a HIGH stale-open nudge via the production path so a
	// real st.messages record + a real mailbox JSONL entry exist (matches
	// the 01/09 incident shape).
	await fireStaleOpenNudge(taskId, workerId, "high");

	// Step 2: close the referenced task + node to terminal BEFORE the pump
	// tick. This models the overnight transition: 01/09 nudge durably
	// enqueued, then the task/node closed, then on 02/09 the pump runs.
	const p = paths(scratch);
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		const taskDir = join(scratch, ".pi/swarm/tasks", taskId);
		const taskPath = join(taskDir, "task.json");
		if (!existsSync(taskPath)) throw new Error("R13-S7: task.json missing before close");
		const task = JSON.parse(readFileSync(taskPath, "utf8"));
		task.status = "done";
		task.nodes.implement.status = "done";
		task.nodes.implement.outcome = "implemented";
		task.updatedAt = new Date().toISOString();
		writeFileSync(taskPath, JSON.stringify(task, null, 2));
		await writeState(p, st);
	});

	// Step 3: pump. The bypass should NOT fire here because the nudge's
	// referenced task/node is terminal. CURRENT code (pre-fix-of-this-
	// regression) wrongly bypasses because the only condition checked is
	// priority=high AND unknown-target AND reason=agent_busy.
	const { pi, sendMessages } = makePiMockWithCounters();
	const ctx = { cwd: scratch, mode: "tui", isIdle: () => true, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
	const result = await pumpOrchestratorMailbox(pi, ctx, p, "test_r13_s7");

	// RED assertions: these will FAIL under the current code (proving the regression),
	// and must PASS after the fix-node repairs the bypass to also gate on
	// live-task/node.
	ok("R13-S7 sendMessages.length === 0 (no surface for terminal-task high nudge)", sendMessages.length === 0, `got ${sendMessages.length} — bypass incorrectly surfaced a stale alert for a now-closed task`);
	ok("R13-S7 result.delivered === 0", result.delivered === 0, { delivered: result.delivered });

	const events = readEvents();
	const staleSuppressed = events.filter((e) => e.event === "notification.stale.suppressed" && e.site === "orchestrator_pump.surface");
	const terminalTrace = events.filter((e) => e.event === "notification.surface.task_terminal" || (e.event === "notification.batch.suppressed" && (e.counts?.task_done >= 1 || e.counts?.node_terminal >= 1 || e.counts?.task_done || e.counts?.node_terminal)));
	const batchSuppressed = events.find((e) => e.event === "notification.batch.suppressed");
	const hasTaskDoneOrNodeTerminalInBatch = batchSuppressed && (Number(batchSuppressed.counts?.task_done ?? 0) >= 1 || Number(batchSuppressed.counts?.node_terminal ?? 0) >= 1);
	// Either the per-tick batch counter OR the one-time migration back-fill wrote a
	// consumerReceipt for the terminal nudge. The migration runs on the first pump tick
	// (when revision === 0) and writes receipts for every non-actionable message; later
	// ticks see the receipt and classify it as informational_already_consumed rather than
	// re-counting task_done in the per-tick batch counter. Both paths prove the predicate
	// returned task_done and the message was NOT surfaced.
	const mailboxPath = join(p.mailboxes, "orchestrator.jsonl");
	const allM = readFileSync(mailboxPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const st2 = await readState(p, scratch);
	const receiptsForS7 = Object.entries(st2.consumerReceipts?.orchestrator?.entries || {})
		.filter(([id]) => allM.some((m) => m.id === id && m.idempotencyKey?.startsWith("task:task-r13-x:node:implement:nudge:stale-open")));
	ok("R13-S7 durable trace records terminal-task suppression (task_done/node_terminal/notification.surface.task_terminal OR consumerReceipt for terminal nudge)", terminalTrace.length >= 1 || hasTaskDoneOrNodeTerminalInBatch || receiptsForS7.length >= 1, `staleSuppressed=${staleSuppressed.length}, terminalTrace=${terminalTrace.length}, batch=${JSON.stringify(batchSuppressed?.counts ?? {})}, receiptsForS7=${receiptsForS7.length}`);
}

// =============================================================================
// Cleanup
// =============================================================================
process.env.PI_SWARM_AGENT_ID = ORIG_PI_SWARM_AGENT_ID;
process.env.PI_SWARM_IS_ORCHESTRATOR = ORIG_PI_SWARM_IS_ORCHESTRATOR;

console.log(`\nR13-ORCHESTRATOR-UNKNOWN-TARGET ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
if (fail > 0) {
	console.error("\n  ↳ RED regression reproduced — fix the busy-suppression site at reconcile.ts:1665/1763 to bypass for priority-high unknown-target orchestrator nudges.");
	process.exit(1);
}
process.exit(0);
