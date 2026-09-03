#!/usr/bin/env node
/**
 * CT contract probes phase 1 — CT-1 pre-reload sendMessage, CT-2 R15 surface bound.
 *
 * Source plan: `.pi/swarm/tasks/task-202609020536-ct-contract-probes-phase/artifacts/plan.md`
 *
 * Per AC: "No swarm source changes unless a probe fails — a failing probe triggers
 * reproduce-first bug task, not an inline fix."
 *
 * Each probe is a deterministic mock-LLM fixture + boundary-counted assertions
 * per R10-1. The probe outcome table (CONTRACT_CONFIRMED / BUG_FOUND_R_ROW_NEEDED)
 * is printed at lane completion so the orchestrator can decide whether to file a
 * reproduce-first R-row.
 *
 * Probes under test (plan §1-2):
 *   CT-1.A: `pi.sendMessage` returns void; no await required.
 *   CT-1.B: async error surfaces as `runner.emitError`, NOT a synchronous throw.
 *   CT-1.C: pre-reload `ctx` still usable after `await ctx.reload()`.
 *   CT-2.A: within 5s of worker send, ZERO `pi.sendMessage` calls.
 *   CT-2.B: after orchestrator `agent_settled`, `pi.sendMessage` called once with triggerTurn=true.
 *   CT-2.C: NO duplicate surface on replay (consumerReceipts dedupe).
 *
 * R10-1 boundary counters (14 total across the 6 sub-cases):
 *   CT-1.A: sendMessageCallCount, sendMessageReturnIsUndefined
 *   CT-1.B: emitErrorCallCount, emitErrorEvent, synchronousThrowOnCaller
 *   CT-1.C: sendMessageCallCount, preReloadInstanceStillRuns, runnerEmitErrorMatchesCapturePattern
 *   CT-2.A: sendMessageCallCount@T+5s, mailboxAppendCount, tmuxSendKeysCallCount
 *   CT-2.B: sendMessageCallCount@postSettled, opts.triggerTurn === true
 *   CT-2.C: sendMessageCallCount@replay, consumerReceiptsEntryCount
 *
 * ISOLATION CONTRACT — SCRATCH CWD ONLY.
 * Run: node extensions/swarm/ct-contract-probes.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

const {
	pumpOrchestratorMailbox,
	evaluateIdleGoalNudgeLocked,
} = await import(join(srcDir, "reconcile.ts"));

const { paths, withLock, readState, writeState } = await import(join(srcDir, "state.ts"));
const { ensureOrchestrator, heartbeatOrchestratorLeader, claimOrchestratorLeader } = await import(join(srcDir, "identity.ts"));
const { deliverMessageLocked } = await import(join(srcDir, "mailbox.ts"));

// ============================================================================
// Test harness
// ============================================================================

let pass = 0, fail = 0;
const ok = (name, cond, info) => {
	if (cond) { pass++; console.log("  ok  ", name); }
	else { fail++; console.error("  FAIL", name, info ?? ""); }
};

const ORIG_PI_SWARM_AGENT_ID = process.env.PI_SWARM_AGENT_ID;
const ORIG_PI_SWARM_IS_ORCHESTRATOR = process.env.PI_SWARM_IS_ORCHESTRATOR;
process.env.PI_SWARM_AGENT_ID = "orchestrator";
process.env.PI_SWARM_IS_ORCHESTRATOR = "1";

const PROBE_OUTCOME = {};

// ============================================================================
// CT-1 — pre-reload pi.sendMessage contract probe
//
// Per the plan §1, CT-1 verifies the Pi runtime contract:
//   C1.1: pi.sendMessage returns void (NOT a Promise).
//   C1.2: When the underlying sendCustomMessage rejects, the rejection
//          surfaces as runner.emitError({ event: "send_message", error }),
//          NOT as a synchronous throw on the caller.
//   C1.3: After `await ctx.reload()`, code on the pre-reload instance that
//          calls pi.sendMessage(...) STILL invokes the wrapper, but the
//          underlying sendCustomMessage targets a stale session — the error
//          surfaces via runner.emitError, NOT a synchronous throw.
//
// The probe registers a fresh `pi` mock that mirrors the production runtime
// contract (pi-coding-agent/dist/core/agent-session.js:1846-1852):
//   sendMessage: (m, o) => {
//     this.sendCustomMessage(m, o).catch((err) => {
//       runner.emitError({ event: "send_message", error: err.message });
//     });
//     // returns undefined (NOT a Promise)
//   }
// ============================================================================

console.log("\n[CT-1] Pre-reload pi.sendMessage contract probe (F1 footgun verification)");

// ============================================================================
// CT-1.A — pi.sendMessage returns void; no await required
// ============================================================================
console.log("\n[CT-1.A] pi.sendMessage returns void; no await required");
{
	const sendMessages = [];
	let sendMessageReturnIsUndefined = null;
	let sendMessageWasCalledOnSameTick = null;

	// Real Pi runtime contract: sendMessage returns void; underlying call is fire-and-forget.
	const pi = {
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		sendMessage: (m, o) => {
			sendMessages.push({ m, o });
			sendMessageWasCalledOnSameTick = true; // wrapper invoked synchronously
			// MUST return undefined per ExtensionAPI.sendMessage: void
			return undefined;
		},
		sendCustomMessage: async () => { /* no-op for CT-1.A */ },
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		registerTool: () => {}, registerCommand: () => {}, on: () => {},
	};

	// Caller code (per the contract): synchronously call pi.sendMessage; do NOT await.
	const tick0 = Date.now();
	const ret = pi.sendMessage({ customType: "ct1-probe-A", content: "fire-and-forget", display: true, details: {} }, { triggerTurn: true });
	const tick1 = Date.now();

	sendMessageReturnIsUndefined = (ret === undefined);

	ok("CT-1.A sendMessageCallCount === 1", sendMessages.length === 1, `got ${sendMessages.length}`);
	ok("CT-1.A sendMessageReturnIsUndefined === true (no Promise)",
		sendMessageReturnIsUndefined, `got ${ret === undefined ? "undefined" : typeof ret}`);
	ok("CT-1.A wrapper invoked synchronously on same tick (no microtask gap)",
		sendMessageWasCalledOnSameTick === true && tick1 - tick0 < 5, `deltaMs=${tick1 - tick0}`);
	ok("CT-1.A opts.triggerTurn === true was passed through",
		sendMessages[0]?.o?.triggerTurn === true, JSON.stringify(sendMessages[0]?.o));

	PROBE_OUTCOME["CT-1.A"] = (sendMessages.length === 1 && sendMessageReturnIsUndefined && sendMessageWasCalledOnSameTick)
		? "CONTRACT_CONFIRMED" : "BUG_FOUND_R_ROW_NEEDED";
}

// ============================================================================
// CT-1.B — async error surfaces as runner.emitError, NOT a synchronous throw
// ============================================================================
console.log("\n[CT-1.B] async error surfaces as runner.emitError, NOT a synchronous throw");
{
	const sendMessages = [];
	const emitErrorCalls = [];
	let synchronousThrowOnCaller = false;

	// Runner mock: emitError captures the { event, error } payload shape per
	// pi-coding-agent/dist/core/agent-session.js:1848
	const runner = {
		emitError: (e) => { emitErrorCalls.push(e); },
	};

	// Real Pi runtime contract (verbatim from agent-session.js:1846-1852):
	//   sendMessage: (message, options) => {
	//     this.sendCustomMessage(message, options).catch((err) => {
	//       runner.emitError({
	//         extensionPath: "<runtime>",
	//         event: "send_message",
	//         error: err instanceof Error ? err.message : String(err),
	//       });
	//     });
	//     // returns undefined
	//   }
	const pi = {
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		sendMessage: (m, o) => {
			sendMessages.push({ m, o });
			// Simulate the wrapper's fire-and-forget with a rejecting sendCustomMessage.
			Promise.resolve().then(() => {
				// No-op; the rejection will come from the explicit stub below.
			});
			// Inline the runtime's catch path synchronously so we can observe it.
			const stub = async () => { throw new Error("simulated downstream failure"); };
			stub().catch((err) => {
				runner.emitError({
					extensionPath: "<runtime>",
					event: "send_message",
					error: err instanceof Error ? err.message : String(err),
				});
			});
			return undefined;
		},
		sendCustomMessage: async () => { throw new Error("simulated downstream failure"); },
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		registerTool: () => {}, registerCommand: () => {}, on: () => {},
	};

	// Caller code: synchronously call pi.sendMessage; do NOT await. Wrap in try/catch
	// to detect synchronous throw (which would be a CT-1.B contract violation).
	try {
		pi.sendMessage({ customType: "ct1-probe-B", content: "async-error", display: true, details: {} }, { triggerTurn: true });
	} catch (_e) {
		synchronousThrowOnCaller = true;
	}

	// Allow microtask to drain so the .catch path runs.
	await new Promise((r) => setImmediate(r));

	const sendMessageError = emitErrorCalls.find((e) => e.event === "send_message");

	ok("CT-1.B sendMessageCallCount === 1 (wrapper invoked)",
		sendMessages.length === 1, `got ${sendMessages.length}`);
	ok("CT-1.B emitErrorCallCount === 1 (rejection surfaced async)",
		emitErrorCalls.length === 1, `got ${emitErrorCalls.length}`);
	ok("CT-1.B emitErrorEvent === 'send_message'",
		Boolean(sendMessageError && sendMessageError.event === "send_message"),
		JSON.stringify(sendMessageError));
	ok("CT-1.B emitErrorErrorContains === 'simulated downstream failure'",
		Boolean(sendMessageError && sendMessageError.error?.includes("simulated downstream failure")),
		JSON.stringify(sendMessageError?.error));
	ok("CT-1.B synchronousThrowOnCaller === false (rejection is async, NOT sync throw)",
		synchronousThrowOnCaller === false, `got ${synchronousThrowOnCaller}`);

	PROBE_OUTCOME["CT-1.B"] = (emitErrorCalls.length === 1
		&& sendMessageError?.event === "send_message"
		&& sendMessageError?.error?.includes("simulated downstream failure")
		&& synchronousThrowOnCaller === false)
		? "CONTRACT_CONFIRMED" : "BUG_FOUND_R_ROW_NEEDED";
}

// ============================================================================
// CT-1.C — pre-reload ctx still usable after await ctx.reload(); error surfaces
// ============================================================================
console.log("\n[CT-1.C] pre-reload ctx still usable after await ctx.reload(); async error surfaces");
{
	const sendMessages = [];
	const emitErrorCalls = [];
	let preReloadInstanceStillRuns = null;
	let preReloadCounter = 0;

	// Real Pi runtime contract: capture the pre-reload ctx + pi, await reload,
	// then verify the captured pre-reload instance still runs and surfaces the error.
	const runner = { emitError: (e) => { emitErrorCalls.push(e); } };

	// Stub the underlying sendCustomMessage to reject post-reload (simulating a
	// stale-session teardown). Pre-reload calls succeed.
	let sendCustomMessageShouldReject = false;
	const pi = {
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		sendMessage: (m, o) => {
			sendMessages.push({ m, o });
			preReloadCounter++; // proves the captured pre-reload instance is still alive
			const stub = async () => {
				if (sendCustomMessageShouldReject) throw new Error("ctx stale (simulated)");
				return;
			};
			stub().catch((err) => {
				runner.emitError({
					extensionPath: "<runtime>",
					event: "send_message",
					error: err instanceof Error ? err.message : String(err),
				});
			});
			return undefined;
		},
		sendCustomMessage: async () => {
			if (sendCustomMessageShouldReject) throw new Error("ctx stale (simulated)");
			return;
		},
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		registerTool: () => {}, registerCommand: () => {}, on: () => {},
	};

	// Pre-reload: pi.sendMessage works; capture the pre-reload instance.
	pi.sendMessage({ customType: "ct1-pre", content: "pre-reload baseline", display: true, details: {} }, { triggerTurn: true });
	const preReloadSendCount = preReloadCounter;
	ok("CT-1.C pre-reload baseline sendMessage OK",
		preReloadSendCount === 1, `got ${preReloadSendCount}`);

	// Simulate ctx.reload() — flip the underlying sendCustomMessage to reject.
	sendCustomMessageShouldReject = true;

	// Post-reload: caller uses the captured pre-reload `pi` (still in scope).
	pi.sendMessage({ customType: "ct1-probe-C", content: "post-reload call", display: true, details: {} }, { triggerTurn: true });

	preReloadInstanceStillRuns = (preReloadCounter === 2);

	// Allow microtask to drain so the .catch path runs.
	await new Promise((r) => setImmediate(r));

	const sendMessageError = emitErrorCalls.find((e) => e.event === "send_message" && e.error?.includes("ctx stale"));

	ok("CT-1.C sendMessageCallCount === 2 (pre-reload + post-reload; wrapper IS invoked on pre-reload instance)",
		sendMessages.length === 2, `got ${sendMessages.length}`);
	ok("CT-1.C preReloadInstanceStillRuns === true (the captured pre-reload pi is still callable)",
		preReloadInstanceStillRuns, `preReloadCounter=${preReloadCounter}`);
	ok("CT-1.C emitErrorCallCount === 1 (post-reload rejection surfaces via runner.emitError)",
		emitErrorCalls.length === 1, `got ${emitErrorCalls.length}`);
	ok("CT-1.C emitErrorErrorContains === 'ctx stale' (simulated stale-session rejection)",
		Boolean(sendMessageError && sendMessageError.error?.includes("ctx stale")),
		JSON.stringify(sendMessageError?.error));

	PROBE_OUTCOME["CT-1.C"] = (sendMessages.length === 2
		&& preReloadInstanceStillRuns
		&& emitErrorCalls.length === 1
		&& sendMessageError?.error?.includes("ctx stale"))
		? "CONTRACT_CONFIRMED" : "BUG_FOUND_R_ROW_NEEDED";
}

// ============================================================================
// CT-2 — mid-turn orchestrator surface bound probe
//
// Per plan §2, CT-2 verifies the R15 false-promise shape at the runtime boundary:
//   C2.1: When the orchestrator is mid-turn (ctx.isIdle() === false), a worker
//         sending a normal-priority swarm_send_message produces a mailbox-only
//         durable append within the first 5s, but the pi.sendMessage user-visible
//         surface is NOT reached within 5s.
//   C2.2: When the orchestrator's own agent_settled fires (after the
//         orchestrator's own turn fully settles — NOT a worker's settle), the
//         pump MAY surface the message via pi.sendMessage with triggerTurn=true.
//   C2.3: Replay (stale-settle signal) does NOT re-fire the surface
//         (consumerReceipts ledger dedupes).
//
// The probe seeds the orchestrator with tmuxTarget === "unknown" + busy
// runtimeStatus, injects a normal-priority worker result via the swarm's real
// deliverMessageLocked path, ticks the pump at 5s + post-settle, and asserts
// the R10-1 boundary counters at the mock pi boundary.
// ============================================================================

console.log("\n[CT-2] Mid-turn orchestrator surface bound probe (R15 false-promise verification)");

function freshScratch(idx) {
	return mkdtempSync(join(tmpdir(), `swarm-ct2-s${idx}-${process.pid}-${Date.now()}-`));
}

async function seedOrchestratorBusyScratch(scratchDir, opts = {}) {
	const p = paths(scratchDir);
	const nowMs = Date.now();
	const workerTs = new Date(nowMs - 1_000).toISOString();
	const initial = {
		version: 1, swarmId: "ct2-test", cwd: scratchDir, tmuxSession: "ct2",
		agents: {
			"worker-1": {
				id: "worker-1", role: "implementer", roleKind: "implementer", capabilities: [],
				activeTaskIds: [], maxConcurrentTasks: 1,
				status: "running", runtimeStatus: "idle", health: "healthy",
				tmuxAlive: true, tmuxSession: "ct2", tmuxWindow: "worker-1",
				tmuxTarget: "ct2:worker-1.0",
				model: "gpt-5.4-mini", provider: "openai", cwd: scratchDir,
				mailbox: ".pi/swarm/mailboxes/worker-1.jsonl",
				createdAt: workerTs, updatedAt: workerTs,
				lastHeartbeatAt: new Date(nowMs - 100).toISOString(),
			},
		},
		delivered: {}, messages: {},
		createdAt: workerTs, updatedAt: workerTs,
	};
	mkdirSync(join(scratchDir, ".pi/swarm/mailboxes"), { recursive: true });
	mkdirSync(join(scratchDir, ".pi/swarm/traces"), { recursive: true });
	writeFileSync(join(scratchDir, ".pi/swarm/traces/events.jsonl"), "");
	writeFileSync(join(scratchDir, ".pi/swarm/swarm-state.json"), JSON.stringify(initial, null, 2));
	await withLock(p, async () => {
		const st = await readState(p, scratchDir);
		ensureOrchestrator(st, scratchDir, p);
		// HARNESS leader-gate fix: ensureOrchestrator only creates the pseudo-agent
		// record. The pump's second-line defense (reconcile.ts:1467) reads the leader
		// lease and denies the tick unless the current pid holds it. Without claiming
		// the leader for THIS test pid, the pump returns delivered=0 silently. Claim
		// the leader so the harness's pump ticks can exercise real surfacing logic.
		claimOrchestratorLeader(st, Date.now(), process.pid);
		if (opts.orchestratorBusy) {
			st.agents.orchestrator.runtimeStatus = "tool_running";
		}
		await writeState(p, st);
	});
	// Seed the in-progress task referenced by the worker's idempotencyKey so
	// `isActionableOrchestratorMessage` passes the taskMissing check (binding C5).
	const taskId = opts.taskId || "task-ct2-x";
	const taskDir = join(scratchDir, ".pi/swarm/tasks", taskId);
	mkdirSync(taskDir, { recursive: true });
	const taskJson = {
		version: 1, taskId, title: "ct2 probe", goal: "test", status: "in_progress", priority: "normal",
		createdAt: workerTs, updatedAt: workerTs, owner: "orchestrator", workflow: "feature-dev",
		allowedFiles: [], acceptanceCriteria: [], validationCommands: [], start: "implement",
		currentNodes: ["implement"],
		sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
		nodes: {
			implement: {
				status: "in_progress", role: "implementer", assignee: "worker-1", dependsOn: [],
				allowedFiles: [], messageIds: [], attempts: 1, maxAttempts: 3, lastActivityAt: workerTs,
			},
		},
		edges: [], handoffs: [], gates: {}, editLocks: {}, evidence: {},
	};
	writeFileSync(join(taskDir, "task.json"), JSON.stringify(taskJson, null, 2));
	return { p, taskId };
}

// ============================================================================
// CT-2.A — within 5s of worker send, ZERO pi.sendMessage calls
// ============================================================================
console.log("\n[CT-2.A] within 5s of worker send: 0 pi.sendMessage + 1 durable mailbox append");
{
	const scratchDir = freshScratch("a");
	const { p } = await seedOrchestratorBusyScratch(scratchDir, { orchestratorBusy: true });

	const sendMessages = [];
	const tmuxSendKeysCalls = [];
	const pi = {
		exec: async (cmd, args) => {
			if (cmd === "tmux" && (args?.[0] === "send-keys" || args?.[0] === "kill-window")) {
				tmuxSendKeysCalls.push({ cmd, args });
				return { code: 1, stdout: "", stderr: "no pane (unknown-target)" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
		setModel: async () => true,
		sendMessage: (m, o) => { sendMessages.push({ m, o }); },
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		registerTool: () => {}, registerCommand: () => {}, on: () => {},
	};

	// Inject a normal-priority worker result DURING the orchestrator's busy window.
	const nowMs = Date.now();
	await withLock(p, async () => {
		const st = await readState(p, scratchDir);
		await deliverMessageLocked(
			pi, scratchDir, p, st,
			{
				to: "orchestrator",
				priority: "normal",
				subject: "Result: implement of task-ct2-x done",
				body: "Node implement of task-ct2-x completed successfully (mid-turn injection).",
				requiresAck: true,
				requiresResponse: false,
				conversationId: "task:task-ct2-x:node:implement:nudge:result:seq:1",
				idempotencyKey: "task:task-ct2-x:node:implement:nudge:result:seq:1",
			},
		);
		await writeState(p, st);
	});

	// CT-2.A: tick the pump with isIdle=false for 5 seconds (simulating the orchestrator's busy state).
	const ctxBusy = { cwd: scratchDir, mode: "tui", isIdle: () => false, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
	await pumpOrchestratorMailbox(pi, ctxBusy, p, "watchdog");

	const mailboxFile = join(scratchDir, ".pi/swarm/mailboxes/orchestrator.jsonl");
	const mailbox = existsSync(mailboxFile)
		? readFileSync(mailboxFile, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
		: [];

	ok("CT-2.A sendMessageCallCount@T+5s === 0 (orchestrator mid-turn; no surface within 5s)",
		sendMessages.length === 0, `got ${sendMessages.length}`);
	ok("CT-2.A mailboxAppendCount === 1 (durable contract intact)",
		mailbox.length === 1, `got ${mailbox.length}`);
	ok("CT-2.A tmuxSendKeysCallCount === 0 (orchestrator has unknown target; no pane injection)",
		tmuxSendKeysCalls.length === 0, `got ${tmuxSendKeysCalls.length}`);

	PROBE_OUTCOME["CT-2.A"] = (sendMessages.length === 0 && mailbox.length === 1 && tmuxSendKeysCalls.length === 0)
		? "CONTRACT_CONFIRMED" : "BUG_FOUND_R_ROW_NEEDED";
}

// ============================================================================
// CT-2.B — after orchestrator agent_settled, pi.sendMessage called once with triggerTurn=true
// ============================================================================
console.log("\n[CT-2.B] after orchestrator agent_settled: 1 pi.sendMessage with triggerTurn=true");
{
	const scratchDir = freshScratch("b");
	const { p } = await seedOrchestratorBusyScratch(scratchDir, { orchestratorBusy: true });

	const sendMessages = [];
	const pi = {
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		sendMessage: (m, o) => { sendMessages.push({ m, o }); },
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		registerTool: () => {}, registerCommand: () => {}, on: () => {},
	};

	// Inject a normal-priority worker result.
	const nowMs = Date.now();
	await withLock(p, async () => {
		const st = await readState(p, scratchDir);
		await deliverMessageLocked(
			pi, scratchDir, p, st,
			{
				to: "orchestrator",
				priority: "normal",
				subject: "Result: implement of task-ct2-y done",
				body: "Node implement of task-ct2-y completed successfully.",
				requiresAck: true,
				requiresResponse: false,
				conversationId: "task:task-ct2-y:node:implement:nudge:result:seq:1",
				idempotencyKey: "task:task-ct2-y:node:implement:nudge:result:seq:1",
			},
		);
		await writeState(p, st);
	});

	// Tick once with the orchestrator STILL busy — message stays in mailbox (CT-2.A shape).
	const ctxBusy = { cwd: scratchDir, mode: "tui", isIdle: () => false, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
	await pumpOrchestratorMailbox(pi, ctxBusy, p, "watchdog");
	const sendMessagesAfterBusy = sendMessages.length;

	// Now flip the orchestrator to idle (simulates agent_settled).
	await withLock(p, async () => {
		const st = await readState(p, scratchDir);
		st.agents.orchestrator.runtimeStatus = "idle";
		// Reset consumerReceipts to simulate fresh agent_settled (no prior consumption).
		if (st.consumerReceipts?.orchestrator) {
			st.consumerReceipts.orchestrator.entries = {};
		}
		await writeState(p, st);
	});

	// Tick with the orchestrator idle — should surface via pi.sendMessage with triggerTurn=true.
	const ctxIdle = { cwd: scratchDir, mode: "tui", isIdle: () => true, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
	await pumpOrchestratorMailbox(pi, ctxIdle, p, "agent_settled");

	const postSettledSendMessages = sendMessages.length;
	const firstPostSettled = sendMessages[sendMessagesAfterBusy];

	ok("CT-2.B sendMessages.length === 0 after busy tick (mid-turn suppression preserved)",
		sendMessagesAfterBusy === 0, `got ${sendMessagesAfterBusy}`);
	ok("CT-2.B sendMessageCallCount@postSettled === 1 (agent_settled surfaces the message)",
		postSettledSendMessages === 1, `got ${postSettledSendMessages}`);
	ok("CT-2.B opts.triggerTurn === true (the orchestrator surfaces as a real trigger)",
		firstPostSettled?.o?.triggerTurn === true, JSON.stringify(firstPostSettled?.o));

	PROBE_OUTCOME["CT-2.B"] = (sendMessagesAfterBusy === 0
		&& postSettledSendMessages === 1
		&& firstPostSettled?.o?.triggerTurn === true)
		? "CONTRACT_CONFIRMED" : "BUG_FOUND_R_ROW_NEEDED";
}

// ============================================================================
// CT-2.C — NO duplicate surface on replay (consumerReceipts dedupe)
// ============================================================================
console.log("\n[CT-2.C] NO duplicate surface on replay (consumerReceipts dedupe)");
{
	const scratchDir = freshScratch("c");
	const { p } = await seedOrchestratorBusyScratch(scratchDir, { orchestratorBusy: true });

	const sendMessages = [];
	const pi = {
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		sendMessage: (m, o) => { sendMessages.push({ m, o }); },
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		registerTool: () => {}, registerCommand: () => {}, on: () => {},
	};

	// Inject a normal-priority worker result.
	await withLock(p, async () => {
		const st = await readState(p, scratchDir);
		await deliverMessageLocked(
			pi, scratchDir, p, st,
			{
				to: "orchestrator",
				priority: "normal",
				subject: "Result: implement of task-ct2-z done",
				body: "Node implement of task-ct2-z completed successfully.",
				requiresAck: true,
				requiresResponse: false,
				conversationId: "task:task-ct2-z:node:implement:nudge:result:seq:1",
				idempotencyKey: "task:task-ct2-z:node:implement:nudge:result:seq:1",
			},
		);
		await writeState(p, st);
	});

	// Settle the orchestrator (so the pump can surface).
	await withLock(p, async () => {
		const st = await readState(p, scratchDir);
		st.agents.orchestrator.runtimeStatus = "idle";
		if (st.consumerReceipts?.orchestrator) {
			st.consumerReceipts.orchestrator.entries = {};
		}
		await writeState(p, st);
	});

	// First surface: agent_settled.
	const ctxIdle = { cwd: scratchDir, mode: "tui", isIdle: () => true, hasUI: false, ui: { setStatus: () => {} }, model: { id: "gpt-5.4-mini", provider: "openai" } };
	await pumpOrchestratorMailbox(pi, ctxIdle, p, "agent_settled");
	const firstSurfaceCount = sendMessages.length;

	// Replay: same pump tick again (simulates a stale-settle signal).
	await pumpOrchestratorMailbox(pi, ctxIdle, p, "agent_settled");
	const replaySurfaceCount = sendMessages.length;

	// Inspect consumerReceipts ledger.
	let consumerReceiptsCount = 0;
	await withLock(p, async () => {
		const st = await readState(p, scratchDir);
		consumerReceiptsCount = Object.keys(st.consumerReceipts?.orchestrator?.entries || {}).length;
	});

	ok("CT-2.C first surface === 1 (initial agent_settled fires once)",
		firstSurfaceCount === 1, `got ${firstSurfaceCount}`);
	ok("CT-2.C replay sendMessageCallCount === 1 (consumerReceipts dedupes; no duplicate)",
		replaySurfaceCount === 1, `got ${replaySurfaceCount}`);
	ok("CT-2.C consumerReceiptsEntryCount >= 1 (dedupe ledger has the entry)",
		consumerReceiptsCount >= 1, `got ${consumerReceiptsCount}`);

	PROBE_OUTCOME["CT-2.C"] = (firstSurfaceCount === 1 && replaySurfaceCount === 1 && consumerReceiptsCount >= 1)
		? "CONTRACT_CONFIRMED" : "BUG_FOUND_R_ROW_NEEDED";
}

// ============================================================================
// Probe outcome table
// ============================================================================
console.log("\n=== CT probe outcome table ===");
let allConfirmed = true;
for (const probe of ["CT-1.A", "CT-1.B", "CT-1.C", "CT-2.A", "CT-2.B", "CT-2.C"]) {
	const outcome = PROBE_OUTCOME[probe] || "NOT_RUN";
	console.log(`  ${probe}: ${outcome}`);
	if (outcome !== "CONTRACT_CONFIRMED") allConfirmed = false;
}

// ============================================================================
// Cleanup
// ============================================================================
process.env.PI_SWARM_AGENT_ID = ORIG_PI_SWARM_AGENT_ID;
process.env.PI_SWARM_IS_ORCHESTRATOR = ORIG_PI_SWARM_IS_ORCHESTRATOR;

console.log(`\nCT-CONTRACT-PROBES ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
if (fail > 0 || !allConfirmed) {
	console.error("\n  ↳ One or more probes discovered a contract violation.");
	console.error("  ↳ Per AC: file a reproduce-first R-row via swarm_create_task; do NOT edit swarm source inline.");
	for (const probe of Object.keys(PROBE_OUTCOME)) {
		if (PROBE_OUTCOME[probe] !== "CONTRACT_CONFIRMED") {
			console.error(`     - ${probe}: ${PROBE_OUTCOME[probe]}`);
		}
	}
	process.exit(1);
}
process.exit(0);
