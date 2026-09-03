#!/usr/bin/env node
/**
 * R15 P0 — normal-priority worker result to unknown-target orchestrator must not
 * promise a bounded (~5s) user-visible surface.
 *
 * Source incident: 2026-09-01 normal-priority worker results that landed in the
 * orchestrator's mailbox via durable append (mailbox.ts:200-203 mailbox-only
 * short-circuit) were reported back to the worker with the literal text
 * `"its pump surfaces mailbox messages within ~5s"` (tools/messages.ts:42-48)
 * even though the pump defers while the orchestrator is busy
 * (reconcile.ts:1617-1626) and the busy-suppression at reconcile.ts:1665
 * drops the message from the surface plan entirely. Workers interpret the
 * 5s promise as a contract; the orchestrator's pi.sendMessage boundary count
 * is zero until the orchestrator's own agent_settled fires.
 *
 * Invariants under test (RED→GREEN per plan §5):
 *   R15-S1: normal-priority worker result to unknown-target orchestrator + busy
 *           orchestrator → zero pi.sendMessage calls (L2 boundary count = 0).
 *           The durable mailbox append (L1) is intact and == 1.
 *           RED: pre-fix swarm_send_message tool output contains literal
 *           `"within ~5s"` (the false promise); GREEN: the literal is absent
 *           and the text honestly reports durable-no-time-bound semantics.
 *   R15-S2: idle-orchestrator with explicit agent_settled hook → exactly one
 *           pi.sendMessage call (non-regression: legitimate idle path still works).
 *   R15-S3: replay guard — second tick on the same mailbox state does NOT add
 *           another pi.sendMessage (R10-1 no-duplicate via consumerReceipts).
 *   R15-S4: R13 high-priority unknown-target bypass still works (priority-high
 *           still surfaces via the R13 bypass; R15 fix MUST NOT regress it).
 *   R15-S5: durable mailbox semantics preserved — mailboxAppendCount === 1
 *           (durable contract intact).
 *   R15-S6: normal suppression/noise guardrails preserved — notification.stale.suppressed
 *           with reason=agent_busy still fires for normal priority on a busy
 *           orchestrator (we do NOT loosen the busy gate for normal priority;
 *           we only remove the false text).
 *
 * ISOLATION CONTRACT — SCRATCH CWD ONLY.
 * Run: node extensions/swarm/r15-normal-orchestrator-result.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { pumpOrchestratorMailbox } = await import(join(here, "..", "src/reconcile.ts"));
const { paths, withLock, readState, writeState } = await import(join(here, "..", "src/state.ts"));
const { ensureOrchestrator, heartbeatOrchestratorLeader } = await import(join(here, "..", "src/identity.ts"));
const { deliverMessageLocked } = await import(join(here, "..", "src/mailbox.ts"));
// Bring in the production `swarm_send_message` tool registration so we exercise
// the REAL text-generation path that the worker reads (R10-1 real surface boundary).
const { registerMessagesTools } = await import(join(here, "..", "src/tools/messages.ts"));

const ORIG_PI_SWARM_AGENT_ID = process.env.PI_SWARM_AGENT_ID;
const ORIG_PI_SWARM_IS_ORCHESTRATOR = process.env.PI_SWARM_IS_ORCHESTRATOR;

// Each scenario gets a FRESH scratch to avoid cross-scenario contamination of
// consumerReceipts / mailbox files / orchestratorPumpSessions state.
let scenarioIdx = 0;
function freshScratch() {
	scenarioIdx++;
	return mkdtempSync(join(tmpdir(), `swarm-r15-normal-s${scenarioIdx}-${process.pid}-${Date.now()}`));
}

// --- helpers --------------------------------------------------------------

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
	if (cond) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${detail ? " " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`); }
}

function readEvents(scratch) {
	const p = join(scratch, ".pi/swarm/traces/events.jsonl");
	if (!existsSync(p)) return [];
	const txt = readFileSync(p, "utf8").trim();
	return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function clearEvents(scratch) {
	mkdirSync(join(scratch, ".pi/swarm/traces"), { recursive: true });
	writeFileSync(join(scratch, ".pi/swarm/traces/events.jsonl"), "");
}
function readOrchestratorMailbox(scratch) {
	const p = join(scratch, ".pi/swarm/mailboxes/orchestrator.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function makePiMockWithCounters({ busy = true } = {}) {
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

/**
 * Seed the incident shape:
 *   - orchestrator pseudo-agent with tmuxTarget="unknown", runtimeStatus: idle by default
 *     (caller flips to "tool_running" for the busy shape by setting runtimeStatus below)
 *   - one worker fs-planner with tmuxTarget=fs-planner.0 (live)
 *   - a normal-priority result message durably enqueued via deliverMessageLocked
 *     (the production path used by swarm_send_message)
 */
async function seedNormalResultShape({ busy = true, workerId = "fs-planner", taskId = "task-r15-x", scratch: s } = {}) {
	const scratch = s;
	mkdirSync(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
	const p = paths(scratch);
	const nowMs = Date.now();
	// Set lastActivityAt to NOW so the task node is NOT considered stale-open
	// (which would cause the pump to auto-emit a stale-open nudge). The R15
	// test isolates the "normal result" path; stale-open machinery is a separate
	// concern tested by the R13 row.
	const workerTs = new Date(nowMs - 1_000).toISOString();
	// orchestrator is BUSY (mid-turn on its own work) — that's the incident shape.
	// A worker settle is irrelevant to the orchestrator pump; we set the orchestrator's
	// runtimeStatus to tool_running so the pump's effective-agent-set-not-idle condition fires.
	const initial = {
		version: 1, swarmId: "r15-test", cwd: scratch, tmuxSession: "r15",
		agents: {
			[workerId]: {
				id: workerId, role: workerId, roleKind: "implementer", capabilities: [],
				activeTaskIds: [taskId], maxConcurrentTasks: 1,
				status: "running", runtimeStatus: "idle", health: "healthy",
				tmuxAlive: true, tmuxSession: "r15", tmuxWindow: workerId, tmuxTarget: `r15:${workerId}.0`,
				model: "gpt-5.4-mini", provider: "openai",
				cwd: scratch, mailbox: `.pi/swarm/mailboxes/${workerId}.jsonl`,
				createdAt: workerTs, updatedAt: workerTs, lastHeartbeatAt: new Date(nowMs - 100).toISOString(),
			},
		},
		delivered: {}, messages: {},
		createdAt: workerTs, updatedAt: workerTs,
	};
	writeFileSync(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(initial, null, 2));

	// Task graph: required so isActionableOrchestratorMessage doesn't bail with task_missing.
	const taskDir = join(scratch, ".pi/swarm/tasks", taskId);
	mkdirSync(taskDir, { recursive: true });
	const task = {
		version: 1, taskId, title: "R15 victim task", goal: "test", status: "in_progress",
		priority: "normal", createdAt: workerTs, updatedAt: workerTs, owner: "orchestrator",
		workflow: "feature-dev", allowedFiles: [], acceptanceCriteria: [], validationCommands: [],
		start: "implement", currentNodes: ["implement"],
		sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
		nodes: { implement: { status: "in_progress", role: "implementer", assignee: workerId, dependsOn: [], allowedFiles: [], messageIds: [], attempts: 1, maxAttempts: 3, lastActivityAt: workerTs } },
		edges: [], handoffs: [], gates: {}, editLocks: {}, evidence: {},
	};
	writeFileSync(join(taskDir, "task.json"), JSON.stringify(task, null, 2));

	await withLock(p, async () => {
		const st = await readState(p, scratch);
		ensureOrchestrator(st, scratch, p);
		// Flip the orchestrator pseudo-agent to busy so the pump's effective-agent-set-not-idle gate fires.
		if (busy && st.agents.orchestrator) {
			st.agents.orchestrator.runtimeStatus = "tool_running";
			st.agents.orchestrator.tmuxTarget = "unknown"; // explicit — orchestrator never has a real pane
			st.agents.orchestrator.updatedAt = new Date(nowMs).toISOString();
		}
		heartbeatOrchestratorLeader(st, nowMs, process.pid, "r15_test_seed");
		// Reset migration revision + entries so each scenario starts with a clean dedupe ledger.
		if (st.consumerReceipts?.orchestrator) {
			st.consumerReceipts.orchestrator.entries = {};
			st.consumerReceipts.orchestrator.revision = 0;
		}
		const pidKey = String(process.pid);
		if (st.orchestratorPumpSessions?.[pidKey]) {
			st.orchestratorPumpSessions[pidKey].ids = [];
			st.orchestratorPumpSessions[pidKey].triggeredAt = {};
			st.orchestratorPumpSessions[pidKey].retriggerCount = {};
		}
		await writeState(p, st);
	});
	clearEvents(scratch);

	// Enqueue the normal-priority result via the production path.
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		await deliverMessageLocked(
			{ exec: async () => ({ code: 0, stdout: "", stderr: "" }), setModel: async () => true, sendMessage: () => {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {}, registerTool: () => {}, registerCommand: () => {}, on: () => {} },
			scratch, p, st,
			{
				to: "orchestrator",
				priority: "normal",
				subject: `Result: implement of ${taskId} done`,
				body: `Node \`implement\` of task ${taskId} completed successfully. No further action required.`,
				requiresAck: true,
				requiresResponse: false,
				conversationId: `task:${taskId}:implement:nudge:result:seq:1`,
				idempotencyKey: `task:${taskId}:implement:nudge:result:seq:1`,
			},
		);
		await writeState(p, st);
	});
}

/**
 * Invoke the REAL swarm_send_message tool production path and return the
 * text the worker sees. This is the L2 boundary under audit — the literal
 * `"~5s"` text in this return is the false promise.
 */
async function captureSwarmSendMessageToolOutput(scratch, workerId = "fs-planner", taskId = "task-r15-x") {
	let capturedText = null;
	const capturedRegister = {
		registerTool: (tool) => {
			if (tool?.name === "swarm_send_message") {
				// execute the tool synchronously to capture the return text
				(async () => {
					process.env.PI_SWARM_AGENT_ID = workerId;
					process.env.PI_SWARM_IS_ORCHESTRATOR = "";
					const fakeCtx = { cwd: scratch, mode: "tui", isIdle: () => true, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
					const result = await tool.execute(
						"call-r15-red",
						{
							to: "orchestrator",
							priority: "normal",
							subject: `Result: implement of ${taskId} done`,
							body: `Node \`implement\` of task ${taskId} completed successfully.`,
							requiresAck: true,
						},
						undefined,
						() => {},
						fakeCtx,
					);
					capturedText = typeof result === "string" ? result : result?.content?.[0]?.text ?? JSON.stringify(result);
				})();
			}
		},
		registerCommand: () => {}, on: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		sendMessage: () => {},
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
	};
	const fakePi = capturedRegister;
	// Force the registration through the production module so the production
	// tool definition (with the false-promise text) is exercised.
	registerMessagesTools(fakePi);
	// Wait briefly for the async tool execute to complete (Promise.resolve tick).
	await new Promise((r) => setTimeout(r, 50));
	return capturedText;
}

// --- R15-S1: busy-orchestrator normal-priority result (the incident shape) ---
console.log("\n[R15-S1] normal-priority worker result to unknown-target orchestrator + busy orchestrator → 0 pi.sendMessage + literal '~5s' is the false-promise shape");
{
	const scratch = freshScratch();
	const workerId = "fs-planner";
	const taskId = "task-r15-x-s1";
	await seedNormalResultShape({ busy: true, workerId, taskId, scratch });

	// L1 boundary counter captured BEFORE the tool-capture step (which itself enqueues a second message).
	const mailboxBeforeToolCapture = readOrchestratorMailbox(scratch);
	ok("R15-S1 mailboxAppendCount === 1 (L1 durable contract intact, pre-tool-capture)", mailboxBeforeToolCapture.length === 1, `got ${mailboxBeforeToolCapture.length}`);

	// L2 boundary counter — pump the orchestrator mailbox under busy.
	const { pi, sendMessages } = makePiMockWithCounters({ busy: true });
	const p = paths(scratch);
	const ctx = { cwd: scratch, mode: "tui", isIdle: () => false, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
	const result = await pumpOrchestratorMailbox(pi, ctx, p, "watchdog");
	ok("R15-S1 sendMessages.length === 0 (L2 boundary: no surface for busy orchestrator)", sendMessages.length === 0, `got ${sendMessages.length}`);
	ok("R15-S1 result.delivered === 0 (no surface on busy)", result.delivered === 0, { delivered: result.delivered });

	// Capture the REAL swarm_send_message tool output to assert the literal text.
	const toolOutput = await captureSwarmSendMessageToolOutput(scratch, workerId, taskId);
	ok("R15-S1 captured tool output (swarm_send_message return text)", typeof toolOutput === "string", `got ${typeof toolOutput}`);
	ok("R15-S1 false-promise literal text ABSENT from tool output (post-fix)", toolOutput && !toolOutput.includes("within ~5s"), toolOutput ? `"${toolOutput.slice(0, 200)}..."` : "null");
	if (toolOutput) {
		console.log(`    tool output: ${toolOutput.slice(0, 240)}${toolOutput.length > 240 ? "..." : ""}`);
	}
}

// --- R15-S2: idle-orchestrator with explicit agent_settled → surface (non-regression) ---
console.log("\n[R15-S2] idle-orchestrator with explicit agent_settled trigger → 1 pi.sendMessage (non-regression of legitimate idle path)");
{
	const scratch = freshScratch();
	const workerId = "fs-planner";
	const taskId = "task-r15-x-s2";
	const p = paths(scratch);
	await seedNormalResultShape({ busy: false, workerId, taskId, scratch });

	const { pi, sendMessages } = makePiMockWithCounters({ busy: false });
	const ctx = { cwd: scratch, mode: "tui", isIdle: () => true, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
	const result = await pumpOrchestratorMailbox(pi, ctx, p, "agent_settled");
	ok("R15-S2 sendMessages.length === 1 (L2 boundary: legitimate idle path)", sendMessages.length === 1, `got ${sendMessages.length}`);
	ok("R15-S2 sendMessage triggerTurn === true", sendMessages[0]?.options?.triggerTurn === true);
	ok("R15-S2 result.delivered === 1 (idle-path surface delivered)", result.delivered === 1, { delivered: result.delivered });
}

// --- R15-S3: replay guard (R10-1 no-duplicate via consumerReceipts) ---
console.log("\n[R15-S3] replay guard — second tick on same mailbox state does NOT add another pi.sendMessage");
{
	const scratch = freshScratch();
	const workerId = "fs-planner";
	const taskId = "task-r15-x-s3";
	const p = paths(scratch);
	await seedNormalResultShape({ busy: false, workerId, taskId, scratch });

	const { pi, sendMessages } = makePiMockWithCounters({ busy: false });
	const ctx = { cwd: scratch, mode: "tui", isIdle: () => true, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
	await pumpOrchestratorMailbox(pi, ctx, p, "agent_settled_t1");
	const sendAfterFirst = sendMessages.length;
	await pumpOrchestratorMailbox(pi, ctx, p, "agent_settled_t2");
	ok("R15-S3 first tick sendMessages.length === 1", sendAfterFirst === 1, `got ${sendAfterFirst}`);
	ok("R15-S3 second tick did NOT add another sendMessage", sendMessages.length === sendAfterFirst, `got ${sendMessages.length}`);
}

// --- R15-S4: R13 high-priority bypass still works (R15 fix MUST NOT regress) ---
console.log("\n[R15-S4] R13 high-priority unknown-target bypass still works (priority-high surfaces via R13)");
{
	const scratch = freshScratch();
	const workerId = "fs-planner";
	const taskId = "task-r15-x-s4";
	// Seed with HIGH priority nudge via the R13 path.
	await seedNormalResultShape({ busy: true, workerId, taskId, scratch });
	// Replace the message priority to high via a separate enqueue.
	const p = paths(scratch);
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		// Clear low-priority result and add a high-priority nudge.
		const ids = Object.keys(st.messages).filter((id) => st.messages[id].to === "orchestrator");
		for (const id of ids) delete st.messages[id];
		await deliverMessageLocked(
			{ exec: async () => ({ code: 0, stdout: "", stderr: "" }), setModel: async () => true, sendMessage: () => {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {}, registerTool: () => {}, registerCommand: () => {}, on: () => {} },
			scratch, p, st,
			{
				to: "orchestrator",
				priority: "high",
				subject: `STALE OPEN: node implement of ${taskId} assigned but no progress`,
				body: `Node implement of ${taskId} assigned but no progress.`,
				requiresAck: true,
				requiresResponse: false,
				conversationId: `task:${taskId}:node:implement:nudge:stale-open`,
				idempotencyKey: `task:${taskId}:node:implement:nudge:stale-open:seq:99`,
			},
		);
		await writeState(p, st);
	});

	const { pi, sendMessages } = makePiMockWithCounters({ busy: true });
	// R13 bypass only fires inside the surface loop, which only runs when the
	// orchestrator's own `ctx.isIdle() === true` (the pump's busy-defer branch
	// returns early before the surface loop). We model the R13 incident shape
	// — a worker is mid-turn (staleSurfaceReason returns agent_busy because the
	// worker has an activeTaskIds pointer while runtimeStatus=idle), but the
	// orchestrator's own idle/agent_settled is true so the surface loop runs
	// and the bypass fires for priority-high.
	const ctx = { cwd: scratch, mode: "tui", isIdle: () => true, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
	await pumpOrchestratorMailbox(pi, ctx, p, "watchdog");
	ok("R15-S4 priority-high still surfaces via R13 bypass (1 pi.sendMessage)", sendMessages.length === 1, `got ${sendMessages.length}`);
}

// --- R15-S5: durable mailbox semantics preserved ---
console.log("\n[R15-S5] durable mailbox semantics preserved (L1 boundary: append=1 even when L2 surface=0)");
const s5Scratch = freshScratch();
{
	const workerId = "fs-planner";
	const taskId = "task-r15-x-s5";
	await seedNormalResultShape({ busy: true, workerId, taskId, scratch: s5Scratch });
	const events = readEvents(s5Scratch);
	const mailboxOnlyTrace = events.filter((e) => e.event === "message.deliver.mailbox_only");
	ok("R15-S5 message.deliver.mailbox_only trace present (durable semantics intact)", mailboxOnlyTrace.length >= 1, { count: mailboxOnlyTrace.length });
	const mailbox = readOrchestratorMailbox(s5Scratch);
	ok("R15-S5 mailboxAppendCount === 1", mailbox.length === 1, `got ${mailbox.length}`);
}

// --- R15-S6: R13 bypass MUST NOT fire for normal-priority (the B1 boundary) ---
// The R13 P0 bypass is priority=high AND unknown-target orchestrator AND reason=agent_busy.
// For normal priority, the bypass MUST NOT fire — that's the guardrail preventing the
// R10 nudge-storm regression (roadmap.md:937). We force a normal-priority message
// to enter the surface plan with the agent_busy reason and assert that the bypass
// does NOT route it through the L2 pi.sendMessage boundary.
console.log("\n[R15-S6] R13 bypass MUST NOT fire for normal-priority (the B1 boundary)");
{
	const s6Scratch = freshScratch();
	const workerId = "fs-planner";
	const taskId = "task-r15-x-s6";
	await seedNormalResultShape({ busy: true, workerId, taskId, scratch: s6Scratch });
	const p = paths(s6Scratch);
	// Make the worker busy so the surface gate's effective-agent-set-not-idle
	// fires agent_busy for the normal-priority nudge.
	await withLock(p, async () => {
		const st = await readState(p, s6Scratch);
		if (st.agents[workerId]) st.agents[workerId].runtimeStatus = "tool_running";
		await writeState(p, st);
	});
	// Replace the seeded result with a NORMAL-PRIORITY nudge that uses a `:nudge:` style
	// idempotencyKey so the staleSurfaceReason gate applies (`:result:` keys do not match).
	await withLock(p, async () => {
		const st = await readState(p, s6Scratch);
		const ids = Object.keys(st.messages).filter((id) => st.messages[id].to === "orchestrator");
		for (const id of ids) delete st.messages[id];
		await deliverMessageLocked(
			{ exec: async () => ({ code: 0, stdout: "", stderr: "" }), setModel: async () => true, sendMessage: () => {}, getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {}, registerTool: () => {}, registerCommand: () => {}, on: () => {} },
			s6Scratch, p, st,
			{
				to: "orchestrator",
				priority: "normal",
				subject: `normal nudge for ${taskId}`,
				body: `Normal-priority nudge for ${taskId} (bypass guard test).`,
				requiresAck: true,
				requiresResponse: false,
				conversationId: `task:${taskId}:node:implement:nudge:result:seq:1`,
				idempotencyKey: `task:${taskId}:node:implement:nudge:result:seq:1`,
			},
		);
		await writeState(p, st);
	});
	const { pi, sendMessages } = makePiMockWithCounters({ busy: true });
	const ctx = { cwd: s6Scratch, mode: "tui", isIdle: () => true, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
	await pumpOrchestratorMailbox(pi, ctx, p, "watchdog");
	ok("R15-S6 sendMessages.length === 0 (normal priority does NOT trigger R13 bypass)", sendMessages.length === 0, `got ${sendMessages.length}`);
	const events = readEvents(s6Scratch);
	const bypassTrace = events.filter((e) => e.event === "notification.surface.bypass_high_unknown_target");
	ok("R15-S6 NO notification.surface.bypass_high_unknown_target trace for normal priority", bypassTrace.length === 0, `got ${bypassTrace.length}`);
}

// --- Cleanup ---
process.env.PI_SWARM_AGENT_ID = ORIG_PI_SWARM_AGENT_ID;
process.env.PI_SWARM_IS_ORCHESTRATOR = ORIG_PI_SWARM_IS_ORCHESTRATOR;

console.log(`\nR15-NORMAL-ORCHESTRATOR-RESULT ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
if (fail > 0) {
	console.error("\n  ↳ RED regression reproduced — the false ~5s promise in tools/messages.ts:42-48 must be removed (B1 honest removal) without altering mailbox/normal busy suppression/reconcile behavior.");
	process.exit(1);
}
process.exit(0);
