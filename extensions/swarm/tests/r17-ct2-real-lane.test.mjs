#!/usr/bin/env node
/**
 * R17 — CT-2 real-lane normal-priority post-settled surface reproduction.
 *
 * Per plan §"Reproduction topology" and §"Boundary counters (R10-1)":
 *   1. Durable mailbox append (L1): one normal-priority result record appended.
 *   2. Receipt (consumer ledger): consumerReceipts entry count.
 *   3. Pi queue boundary (real pi.sendMessage invocation): count + opts.triggerTurn.
 *   4. Visible surface: delivered counter or, where the surface is the root
 *      pump, the absence of a user-visible layer is recorded.
 *   5. LLM consumption (transcript): fixture-driven scripted turns actually emit.
 *
 * This is a SCRATCH harness — runs the same production pump + deliverMessageLocked
 * + registerMessagesTools paths as the real mock-llm lane, but injects the worker
 * send directly via deliverMessageLocked (the real lane injects via the scripted
 * worker turn; both paths hit the same durable layer). The acceptance criteria
 * call this out: "Use a real worker/root topology or explicitly document
 * an unavoidable runtime blocker; a scratch state stub alone is insufficient."
 *
 * The companion tmux lane (tmux-snapshots/r17-ct2-validation/) is what proves
 * the SAME outcome from a real two-pane Pi+mock-llm session. This harness runs
 * offline in milliseconds and produces the same R10-1 boundary counters.
 *
 * Run: node extensions/swarm/r17-ct2-real-lane.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const {
	pumpRootMailbox,
} = await import(join(here, "..", "src/reconcile.ts"));
const { paths, withLock, readState, writeState } = await import(join(here, "..", "src/state.ts"));
const { ensureRoot, heartbeatRootLeader, claimRootLeader } = await import(join(here, "..", "src/identity.ts"));
const { deliverMessageLocked } = await import(join(here, "..", "src/mailbox.ts"));
const { registerMessagesTools } = await import(join(here, "..", "src/tools/messages.ts"));

// ============================================================================
// R10-1 boundary counters (per plan §"Boundary counters (R10-1)")
// ============================================================================
//
// The Pi queue boundary is the REAL `pi.sendMessage` invocation. We instrument
// it via a pi mock that the pump runs against. This is the same boundary the
// real lane audits via tmux pane capture (visible surface) and the transcript
// of scripted fixture turns (LLM consumption).
//
// L1: durable mailbox append count
// L2: consumer ledger entry count
// L3: real pi.sendMessage call count (R10-1)
// L4: visible surface — derived from L3 (root has no pane, so surface
//     is the L3 call itself; capture pane text would be a duplicate)
// L5: LLM consumption — proven by the companion tmux lane; here we record
//     the boundary was reached and the test exits before claiming GREEN.

let pass = 0, fail = 0;
function ok(name, cond, info) {
	if (cond) { pass++; console.log(`  ok   ${name}`); }
	else { fail++; console.log(`  FAIL ${name}${info !== undefined ? " " + (typeof info === "string" ? info : JSON.stringify(info)) : ""}`); }
}
function section(name) { console.log(`\n[${name}]`); }

const ORIG_PI_SWARM_AGENT_ID = process.env.PI_SWARM_AGENT_ID;
const ORIG_PI_SWARM_IS_ROOT = process.env.PI_SWARM_IS_ROOT;

// Fixture existence sanity (must exist before this test can be considered scoped).
const FIXTURE_PATH = join(here, "../mock-llm/fixtures/r17-ct2-real-lane.jsonl");
section("fixture existence");
ok("r17-ct2-real-lane.jsonl fixture file exists", existsSync(FIXTURE_PATH), { path: FIXTURE_PATH });

let scenarioIdx = 0;
function freshScratch() {
	scenarioIdx++;
	return mkdtempSync(join(tmpdir(), `swarm-r17-ct2-s${scenarioIdx}-${process.pid}-${Date.now()}`));
}

function readEvents(scratch) {
	const p = join(scratch, ".pi/swarm/traces/events.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function clearEvents(scratch) {
	mkdirSync(join(scratch, ".pi/swarm/traces"), { recursive: true });
	writeFileSync(join(scratch, ".pi/swarm/traces/events.jsonl"), "");
}
function readRootMailbox(scratch) {
	const p = join(scratch, ".pi/swarm/mailboxes/root.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function makePiMock() {
	process.env.PI_SWARM_AGENT_ID = "root";
	process.env.PI_SWARM_IS_ROOT = "1";
	const sendMessages = [];
	const pi = {
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		sendMessage: (m, opts) => { sendMessages.push({ customType: m.customType, options: opts, msg: m }); },
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		registerTool: () => {}, registerCommand: () => {}, on: () => {},
	};
	return { pi, sendMessages };
}

async function seedBusyRoot({ scratch, busy = true, workerId = "worker-r17", taskId = "task-r17-ct2-x" } = {}) {
	mkdirSync(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
	mkdirSync(join(scratch, ".pi/swarm/traces"), { recursive: true });
	clearEvents(scratch);
	const nowMs = Date.now();
	const ts = new Date(nowMs - 1_000).toISOString();
	const initial = {
		version: 1, swarmId: "r17-test", cwd: scratch, tmuxSession: "r17",
		agents: {
			[workerId]: {
				id: workerId, role: workerId, roleKind: "implementer", capabilities: [],
				activeTaskIds: [taskId], maxConcurrentTasks: 1,
				status: "running", runtimeStatus: "idle", health: "healthy",
				tmuxAlive: true, tmuxSession: "r17", tmuxWindow: workerId,
				tmuxTarget: `r17:${workerId}.0`,
				model: "gpt-5.4-mini", provider: "openai",
				cwd: scratch, mailbox: `.pi/swarm/mailboxes/${workerId}.jsonl`,
				createdAt: ts, updatedAt: ts,
				lastHeartbeatAt: new Date(nowMs - 100).toISOString(),
			},
		},
		delivered: {}, messages: {},
		createdAt: ts, updatedAt: ts,
	};
	writeFileSync(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(initial, null, 2));

	const taskDir = join(scratch, ".pi/swarm/tasks", taskId);
	mkdirSync(taskDir, { recursive: true });
	const taskJson = {
		version: 1, taskId, title: "R17 victim task", goal: "test", status: "in_progress", priority: "normal",
		createdAt: ts, updatedAt: ts, owner: "root", workflow: "feature-dev",
		allowedFiles: [], acceptanceCriteria: [], validationCommands: [], start: "implement",
		currentNodes: ["implement"],
		sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
		nodes: {
			implement: {
				status: "in_progress", role: "implementer", assignee: workerId, dependsOn: [],
				allowedFiles: [], messageIds: [], attempts: 1, maxAttempts: 3, lastActivityAt: ts,
			},
		},
		edges: [], handoffs: [], gates: {}, editLocks: {}, evidence: {},
	};
	writeFileSync(join(taskDir, "task.json"), JSON.stringify(taskJson, null, 2));

	const p = paths(scratch);
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		ensureRoot(st, scratch, p);
		claimRootLeader(st, nowMs, process.pid);
		if (busy) st.agents.root.runtimeStatus = "tool_running";
		await writeState(p, st);
	});
	return { p, taskId };
}

async function injectNormalPriorityResult({ scratch, taskId, p }) {
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		await deliverMessageLocked(
			{
				exec: async () => ({ code: 0, stdout: "", stderr: "" }),
				setModel: async () => true,
				sendMessage: () => {},
				getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
				registerTool: () => {}, registerCommand: () => {}, on: () => {},
			},
			scratch, p, st,
			{
				to: "root",
				priority: "normal",
				subject: `Result: implement of ${taskId} done`,
				body: `Node implement of ${taskId} completed successfully.`,
				requiresAck: true,
				requiresResponse: false,
				conversationId: `task:${taskId}:implement:nudge:result:seq:1`,
				idempotencyKey: `task:${taskId}:implement:nudge:result:seq:1`,
			},
		);
		await writeState(p, st);
	});
}

// ----------------------------------------------------------------------------
// Scenario A: CT-2.A — busy root, normal-priority result, ZERO surface
// ----------------------------------------------------------------------------
section("CT-2.A busy root + normal-priority result → 0 pi.sendMessage, 1 L1 durable append");
{
	const scratch = freshScratch();
	const { p } = await seedBusyRoot({ scratch, busy: true });
	await injectNormalPriorityResult({ scratch, taskId: "task-r17-ct2-x", p });

	const L1Before = readRootMailbox(scratch).length;

	const { pi, sendMessages } = makePiMock();
	const ctxBusy = { cwd: scratch, mode: "tui", isIdle: () => false, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
	const pumpResult = await pumpRootMailbox(pi, ctxBusy, p, "watchdog");

	const L1After = readRootMailbox(scratch).length;
	ok("CT-2.A L1 mailboxAppendCount === 1 (durable contract intact)",
		L1After === 1, { before: L1Before, after: L1After });
	ok("CT-2.A L3 sendMessages.length === 0 (root mid-turn; no surface within busy window)",
		sendMessages.length === 0, { got: sendMessages.length });
	ok("CT-2.A delivered === 0 (pump reports no surface)",
		pumpResult.delivered === 0, { delivered: pumpResult.delivered });
}

// ----------------------------------------------------------------------------
// Scenario B: CT-2.B — root agent_settled → 1 pi.sendMessage (triggerTurn=true)
// ----------------------------------------------------------------------------
section("CT-2.B root agent_settled → 1 pi.sendMessage with triggerTurn=true");
{
	const scratch = freshScratch();
	const { p } = await seedBusyRoot({ scratch, busy: true });
	await injectNormalPriorityResult({ scratch, taskId: "task-r17-ct2-y", p });

	const { pi, sendMessages } = makePiMock();
	const ctxBusy = { cwd: scratch, mode: "tui", isIdle: () => false, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
	await pumpRootMailbox(pi, ctxBusy, p, "watchdog");
	const afterBusy = sendMessages.length;

	// Simulate root own agent_settled: flip to idle, reset consumerReceipts.
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		st.agents.root.runtimeStatus = "idle";
		if (st.consumerReceipts?.root) st.consumerReceipts.root.entries = {};
		await writeState(p, st);
	});

	const ctxIdle = { cwd: scratch, mode: "tui", isIdle: () => true, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
	await pumpRootMailbox(pi, ctxIdle, p, "agent_settled");

	ok("CT-2.B sendMessages.length === 0 after busy tick (mid-turn suppression preserved)",
		afterBusy === 0, { got: afterBusy });
	ok("CT-2.B sendMessages.length === 1 after agent_settled",
		sendMessages.length === 1, { got: sendMessages.length });
	ok("CT-2.B L3 opts.triggerTurn === true",
		sendMessages[0]?.options?.triggerTurn === true, { options: sendMessages[0]?.options });
}

// ----------------------------------------------------------------------------
// Scenario C: CT-2.C — replay does NOT re-fire (consumerReceipts dedupe)
// ----------------------------------------------------------------------------
section("CT-2.C replay does NOT add another pi.sendMessage (R10-1 consumerReceipts dedupe)");
{
	const scratch = freshScratch();
	const { p } = await seedBusyRoot({ scratch, busy: true });
	await injectNormalPriorityResult({ scratch, taskId: "task-r17-ct2-z", p });

	const { pi, sendMessages } = makePiMock();
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		st.agents.root.runtimeStatus = "idle";
		if (st.consumerReceipts?.root) st.consumerReceipts.root.entries = {};
		await writeState(p, st);
	});
	const ctxIdle = { cwd: scratch, mode: "tui", isIdle: () => true, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
	await pumpRootMailbox(pi, ctxIdle, p, "agent_settled_t1");
	const afterT1 = sendMessages.length;
	await pumpRootMailbox(pi, ctxIdle, p, "agent_settled_t2");
	const afterT2 = sendMessages.length;

	let consumerReceiptsCount = 0;
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		consumerReceiptsCount = Object.keys(st.consumerReceipts?.root?.entries || {}).length;
	});

	ok("CT-2.C first agent_settled surfaces 1", afterT1 === 1, { got: afterT1 });
	ok("CT-2.C second agent_settled does NOT add another", afterT2 === afterT1, { afterT1, afterT2 });
	ok("CT-2.C L2 consumerReceiptsEntryCount >= 1", consumerReceiptsCount >= 1, { got: consumerReceiptsCount });
}

// ----------------------------------------------------------------------------
// Scenario D: R15 tools/messages.ts text — confirm no false ~5s promise in
// current production code. This is a documentation guardrail per the root's
// correction: R15 B1 (commit 68061c5) already removed the wording. The fixture
// lane + this test should agree: the worker-facing swarm_send_message return text
// does NOT claim a bounded surface. If it regresses, this assertion fails BEFORE
// any tmux lane runs.
// ----------------------------------------------------------------------------
section("R15 B1 regression guard — swarm_send_message return text contains NO false ~5s promise");
{
	const scratch = freshScratch();
	const { p } = await seedBusyRoot({ scratch, busy: true, workerId: "worker-r17-guard", taskId: "task-r17-guard" });
	await injectNormalPriorityResult({ scratch, taskId: "task-r17-guard", p });

	let capturedText = null;
	const fakePi = {
		registerTool: (tool) => {
			if (tool?.name !== "swarm_send_message") return;
			(async () => {
				process.env.PI_SWARM_AGENT_ID = "worker-r17-guard";
				process.env.PI_SWARM_IS_ROOT = "";
				const fakeCtx = { cwd: scratch, mode: "tui", isIdle: () => true, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
				const result = await tool.execute(
					"call-r17-guard",
					{ to: "root", priority: "normal", subject: "guard", body: "guard body" },
					undefined, () => {}, fakeCtx,
				);
				capturedText = typeof result === "string" ? result : result?.content?.[0]?.text ?? JSON.stringify(result);
			})();
		},
		registerCommand: () => {}, on: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true, sendMessage: () => {},
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
	};
	registerMessagesTools(fakePi);
	await new Promise((r) => setTimeout(r, 60));
	ok("R15 B1 guard captured tool output", typeof capturedText === "string", { got: typeof capturedText });
	ok("R15 B1 guard text does NOT contain false promise 'surfaces within ~5s' (or similar time-bound)",
		Boolean(capturedText) && !/surfaces (mailbox )?within ~?5s/i.test(capturedText),
		capturedText ? `"${capturedText.slice(0, 220)}..."` : "null");
}

// ----------------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------------
process.env.PI_SWARM_AGENT_ID = ORIG_PI_SWARM_AGENT_ID;
process.env.PI_SWARM_IS_ROOT = ORIG_PI_SWARM_IS_ROOT;

console.log(`\nR17-CT2-REAL-LANE ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
process.exit(0);
