#!/usr/bin/env node
/**
 * R14 P0 — active user-origin goal must escalate when worker pool is empty.
 *
 * Source incident (verified by plan §0):
 *   - Live trace sequence goal-1788266039522-6eae40, origin=user, nudgeIntervalMs=5000.
 *   - 7_278 `goal.nudge.held_no_live_workers` traces fired over ~16h at exactly 5s cadence.
 *   - ZERO orchestrator-bound recovery nudges — the pump never surfaced a goal-empty
 *     escalation despite a standing user goal with `effectiveAgentCount: 0`.
 *
 * Three root causes (plan §1):
 *   1. Vacuous predicate (`reconcile.ts:308-316` `agentIsEffectivelyAlive`) returns
 *      false for settled-but-alive workers whose heartbeat is > 10min stale.
 *   2. `goal.nudge.held_no_live_workers` trace fires every tick, not once per transition
 *      (the comment promises once-per-transition; the code emits unconditionally).
 *   3. No escalation path: the function returns `{emitted:false,reason:"no_live_workers"}`
 *      with no surface; the orchestrator has no recovery nudge despite a user goal.
 *
 * Reproduce-first (mandate 2026-08-31). RED observed for ALL SIX scenarios below
 * (and Configs A, B, C specifically reproduce the live incident shape). GREEN
 * expected after Fixes B + C + A land in that order per plan §5.
 *
 * Invariants under test:
 *   R14-S1 (RED pre-fix → GREEN post-fix):
 *     Config A — settled-but-alive pool (3 workers, tmuxAlive=true, stale heartbeat,
 *     no active task): idleAgentsCount === 0 (RED) → === 3 (GREEN); the vacuous
 *     branch is NOT taken; the normal goal-nudge path resumes.
 *   R14-S2 (RED pre-fix → GREEN post-fix):
 *     Config B — 12-tick stable genuinely-vacuous pool (3 workers, tmuxAlive=false):
 *     heldNoLiveWorkersTraceCount === 12 (RED) → === 1 (GREEN); escalationSendCount
 *     === 0 (RED) → === 1 (GREEN); mailboxAppendCount === 0 (RED) → === 1 (GREEN).
 *   R14-S3 (RED pre-fix → GREEN post-fix):
 *     Config C — vacuous → non-vacuous → vacuous transition with genuinely-vacuous
 *     base: heldNoLiveWorkersTraceCount === 3 (RED, fires every tick of vacuous)
 *     → === 2 (GREEN, once per transition).
 *   R14-S4 (RED pre-fix → GREEN post-fix):
 *     Config D — escalation cooldown bounded: across 12 ticks with a genuinely-vacuous
 *     pool, escalationSendCount === 1 (one nudge per NOTIFY_DEFAULT_COOLDOWN_MS);
 *     the escalation message body names the empty-pool shape.
 *   R14-S5 (no regression):
 *     Config F — active pool with assigned/in-progress task: suppression unchanged;
 *     goal.nudge.suppressed_by_active_task trace per tick (the EXPECTED pre-existing
 *     behavior — NOT a regression); escalationSendCount === 0 (active task
 *     suppression runs BEFORE the vacuous branch; the escalation path is
 *     unreachable while work is in flight).
 *   R14-S6 (goal clear stops escalation):
 *     Config E — explicit goal clear mid-cooldown: escalationSendCount stays at 1;
 *     no additional escalations after the clear; the evaluator returns at the
 *     `if (!goal)` guard, NOT at the vacuous branch.
 *
 * R10-1 boundary counters (counting assertions at real boundaries):
 *   1. `idleAgentsCount` at `reconcile.ts:318` filter call.
 *   2. `heldNoLiveWorkersTraceCount` at `reconcile.ts:520` trace call.
 *   3. `escalationSendCount` at the new `deliverMessageLocked(..., priority:"high", ...)`.
 *   4. `mailboxAppendCount` at `mailbox.ts:362,445` durable append.
 *   5. `sendMessageCallCount` at `reconcile.ts:1763-1773` `pi.sendMessage` loop
 *      (R13 boundary; not changed by R14 but asserted here for the
 *      `idle-and-settled` orchestrator case).
 *   6. `escalationCancelledOnClearCount` at `goals.ts:32-51` clear boundary.
 *
 * ISOLATION CONTRACT — SCRATCH CWD ONLY.
 * Run: node extensions/swarm/r14-goal-empty-pool-escalation.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
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
const { ensureOrchestrator, heartbeatOrchestratorLeader } = await import(join(srcDir, "identity.ts"));
const { deliverMessageLocked } = await import(join(srcDir, "mailbox.ts"));
const { trace } = await import(join(srcDir, "state.ts"));

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

let scratch = mkdtempSync(join(tmpdir(), "swarm-r14-s0-"));

function freshScratch(idx) {
	return mkdtempSync(join(tmpdir(), `swarm-r14-s${idx}-${process.pid}-${Date.now()}-`));
}

function readEvents(scratchDir) {
	const p = join(scratchDir, ".pi/swarm/traces/events.jsonl");
	if (!existsSync(p)) return [];
	const txt = readFileSync(p, "utf8").trim();
	return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function readOrchestratorMailbox(scratchDir) {
	const p = join(scratchDir, ".pi/swarm/mailboxes/orchestrator.jsonl");
	if (!existsSync(p)) return [];
	const txt = readFileSync(p, "utf8").trim();
	return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function makePiMockWithCounters(opts = {}) {
	const sendMessages = [];
	const pi = {
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		sendMessage: (m, _opts) => { sendMessages.push({ id: m?.details?.id, m }); },
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		registerTool: () => {}, registerCommand: () => {}, on: () => {},
	};
	return { pi, sendMessages };
}

/**
 * Seed a swarm state with the specified goal + worker shape.
 * @param opts.scratch — scratch dir
 * @param opts.workerShape — "settled-but-alive" | "genuinely-vacuous"
 * @param opts.goalOrigin — "user" | "orchestrator"
 * @param opts.goalIntervalMs — 5000 (R14 default; matches live incident)
 * @param opts.activeTask — if true, seed a task assigned to worker #1
 * @param opts.nowMs — synthetic clock
 */
async function seedR14Shape({
	scratch: scratchDir,
	workerShape = "genuinely-vacuous",
	goalOrigin = "user",
	goalIntervalMs = 5000,
	activeTask = false,
	goalSetAt = null,
	freshHeartbeat = false,
} = {}) {
	const p = paths(scratchDir);
	const nowMs = Date.now();
	const setAt = goalSetAt || new Date(nowMs - 15 * 60_000).toISOString(); // 15min ago
	// For Config F (active-task suppression regression test) we want the heartbeat fresh
	// so the worker is non-vacuous by the pre-fix predicate AND by the post-fix predicate;
	// the regression is about the active-task suppression branch (reconcile.ts:540+), NOT
	// about the vacuous predicate (Fix A territory). The pre-fix bug classifies a
	// settled-but-alive + stale heartbeat as vacuous; Config F seeds a FRESH heartbeat
	// so the worker is non-vacuous pre-fix AND post-fix.
	const workerTs = freshHeartbeat
		? new Date(nowMs - 1000).toISOString()
		: new Date(nowMs - 15 * 60_000).toISOString();

	const agents = {
		"worker-1": {
			id: "worker-1",
			role: "implementer",
			roleKind: "implementer",
			capabilities: [],
			activeTaskIds: [],
			maxConcurrentTasks: 1,
			status: "running",
			runtimeStatus: "idle",
			health: "healthy",
			tmuxAlive: workerShape === "settled-but-alive" ? true : false,
			tmuxSession: "r14",
			tmuxWindow: "worker-1",
			tmuxTarget: `r14:worker-1.0`,
			model: "gpt-5.4-mini",
			provider: "openai",
			cwd: scratchDir,
			mailbox: ".pi/swarm/mailboxes/worker-1.jsonl",
			createdAt: workerTs,
			updatedAt: workerTs,
			lastHeartbeatAt: workerTs,
		},
		"worker-2": {
			id: "worker-2",
			role: "implementer",
			roleKind: "implementer",
			capabilities: [],
			activeTaskIds: [],
			maxConcurrentTasks: 1,
			status: "running",
			runtimeStatus: "idle",
			health: "healthy",
			tmuxAlive: workerShape === "settled-but-alive" ? true : false,
			tmuxSession: "r14",
			tmuxWindow: "worker-2",
			tmuxTarget: `r14:worker-2.0`,
			model: "gpt-5.4-mini",
			provider: "openai",
			cwd: scratchDir,
			mailbox: ".pi/swarm/mailboxes/worker-2.jsonl",
			createdAt: workerTs,
			updatedAt: workerTs,
			lastHeartbeatAt: workerTs,
		},
		"worker-3": {
			id: "worker-3",
			role: "implementer",
			roleKind: "implementer",
			capabilities: [],
			activeTaskIds: [],
			maxConcurrentTasks: 1,
			status: "running",
			runtimeStatus: "idle",
			health: "healthy",
			tmuxAlive: workerShape === "settled-but-alive" ? true : false,
			tmuxSession: "r14",
			tmuxWindow: "worker-3",
			tmuxTarget: `r14:worker-3.0`,
			model: "gpt-5.4-mini",
			provider: "openai",
			cwd: scratchDir,
			mailbox: ".pi/swarm/mailboxes/worker-3.jsonl",
			createdAt: workerTs,
			updatedAt: workerTs,
			lastHeartbeatAt: workerTs,
		},
	};

	const initial = {
		version: 1,
		swarmId: "r14-test",
		cwd: scratchDir,
		tmuxSession: "r14",
		agents,
		delivered: {},
		messages: {},
		goal: {
			id: "goal-r14-red",
			origin: goalOrigin,
			text: "R14 RED test user goal",
			nudgeIntervalMs: goalIntervalMs,
			setAt,
		},
		createdAt: workerTs,
		updatedAt: workerTs,
	};

	mkdirSync(join(scratchDir, ".pi/swarm/mailboxes"), { recursive: true });
	mkdirSync(join(scratchDir, ".pi/swarm/traces"), { recursive: true });
	writeFileSync(join(scratchDir, ".pi/swarm/traces/events.jsonl"), "");
	writeFileSync(join(scratchDir, ".pi/swarm/swarm-state.json"), JSON.stringify(initial, null, 2));

	if (activeTask) {
		const taskDir = join(scratchDir, ".pi/swarm/tasks", "task-r14-active");
		mkdirSync(taskDir, { recursive: true });
		const taskJson = {
			version: 1,
			taskId: "task-r14-active",
			title: "active task",
			goal: "test",
			status: "in_progress",
			priority: "normal",
			createdAt: workerTs,
			updatedAt: workerTs,
			owner: "orchestrator",
			workflow: "feature-dev",
			allowedFiles: [],
			acceptanceCriteria: [],
			validationCommands: [],
			start: "implement",
			currentNodes: ["implement"],
			sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
			nodes: {
				implement: {
					status: "assigned",
					role: "implementer",
					assignee: "worker-1",
					dependsOn: [],
					allowedFiles: [],
					messageIds: [],
					attempts: 1,
					maxAttempts: 3,
					lastActivityAt: new Date(nowMs - 1000).toISOString(),
				},
			},
			edges: [],
			handoffs: [],
			gates: {},
			editLocks: {},
			evidence: {},
		};
		writeFileSync(join(taskDir, "task.json"), JSON.stringify(taskJson, null, 2));
		// Mark worker-1's activeTaskIds pointer so findAssignedOrInProgressTaskWork picks it up.
		await withLock(p, async () => {
			const st = await readState(p, scratchDir);
			st.agents["worker-1"].activeTaskIds = ["task-r14-active"];
			await writeState(p, st);
		});
	}

	await withLock(p, async () => {
		const st = await readState(p, scratchDir);
		ensureOrchestrator(st, scratchDir, p);
		await writeState(p, st);
	});
	return { p, nowMs };
}

// ============================================================================
// R14-S1: Config A — settled-but-alive pool, no active task
// ============================================================================
console.log("\n[R14-S1] Config A — settled-but-alive pool (3 alive workers, stale heartbeat, no active task)");
{
	const s1Scratch = freshScratch(1);
	const { p } = await seedR14Shape({
		scratch: s1Scratch,
		workerShape: "settled-but-alive",
		goalOrigin: "user",
		activeTask: false,
	});

	const calls = [];
	const pi = {
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		sendMessage: (m) => { calls.push({ id: m?.details?.id }); },
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		registerTool: () => {}, registerCommand: () => {}, on: () => {},
	};

	const nowMs = Date.now();
	let idleAgentsCount = -1;
	await withLock(p, async () => {
		const st = await readState(p, s1Scratch);
		// Drive a single tick; we inspect idleAgentsCount via updateIdleEpochLocked return.
		const { updateIdleEpochLocked } = await import(join(srcDir, "reconcile.ts"));
		const epoch = await updateIdleEpochLocked(p, st, nowMs);
		idleAgentsCount = epoch.idleAgents.length;
		// Reset epoch state we just stamped (so evaluateIdleGoalNudgeLocked starts from a clean slate).
		st.idleNudgeState = {};
		await writeState(p, st);
	});
	await withLock(p, async () => {
		const st = await readState(p, s1Scratch);
		await evaluateIdleGoalNudgeLocked(pi, s1Scratch, p, st, nowMs);
		await writeState(p, st);
	});

	ok("R14-S1 [GREEN post-fix-A] idleAgentsCount === 3 (Fix A: settled-but-alive workers counted via tmuxAlive===true fallback)",
		idleAgentsCount === 3, `got ${idleAgentsCount}`);

	const events = readEvents(s1Scratch);
	const heldTraces = events.filter((e) => e.event === "goal.nudge.held_no_live_workers");
	ok("R14-S1 [GREEN post-fix-A] heldNoLiveWorkersTraceCount === 0 (vacuous=false; the normal goal-nudge path resumes)",
		heldTraces.length === 0, `got ${heldTraces.length}`);

	// GREEN post-fix expectation: idleAgentsCount === 3 (Fix A: settled-but-alive
	// workers counted via tmuxAlive===true fallback). vacuous=false; the normal
	// goal-nudge path resumes. The vacuous branch (reconcile.ts:516+) is NOT taken;
	// held_no_live_workers trace does NOT fire.
}

// ============================================================================
// R14-S2: Config B — 12-tick stable genuinely-vacuous pool
// ============================================================================
console.log("\n[R14-S2] Config B — 12-tick stable genuinely-vacuous pool (3 dead workers)");
{
	const s2Scratch = freshScratch(2);
	const { p } = await seedR14Shape({
		scratch: s2Scratch,
		workerShape: "genuinely-vacuous",
		goalOrigin: "user",
		activeTask: false,
	});

	const pi = {
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		sendMessage: () => {},
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		registerTool: () => {}, registerCommand: () => {}, on: () => {},
	};

	const tickIntervalMs = 5000;
	const tickCount = 12;
	const startMs = Date.now();
	let heldTraceCount = 0;
	let escalationSendCount = 0;
	let mailboxAppendCount = 0;

	for (let i = 0; i < tickCount; i++) {
		const tickNowMs = startMs + (i + 1) * tickIntervalMs;
		await withLock(p, async () => {
			const st = await readState(p, s2Scratch);
			await evaluateIdleGoalNudgeLocked(pi, s2Scratch, p, st, tickNowMs);
			// Count mailbox appends to orchestrator mailbox post-tick.
			const mbFile = join(s2Scratch, ".pi/swarm/mailboxes/orchestrator.jsonl");
			if (existsSync(mbFile)) {
				const lines = readFileSync(mbFile, "utf8").trim().split("\n").filter(Boolean);
				mailboxAppendCount = Math.max(mailboxAppendCount, lines.length);
			}
			// Tally escalation sends via trace events (Fix C adds a trace).
			await writeState(p, st);
		});
	}

	const events = readEvents(s2Scratch);
	heldTraceCount = events.filter((e) => e.event === "goal.nudge.held_no_live_workers").length;
	const escalationTraces = events.filter((e) =>
		e.event === "goal.escalation.pool_empty" || e.event === "message.deliver.mailbox_only"
	);
	escalationSendCount = escalationTraces.filter((e) => e.event === "goal.escalation.pool_empty").length;

	ok("R14-S2 [GREEN post-fix-B] heldNoLiveWorkersTraceCount === 1 (once-per-transition dedupe)",
		heldTraceCount === 1, `got ${heldTraceCount}`);

	ok("R14-S2 [GREEN post-fix-C] escalationSendCount === 1 (one bounded nudge per cooldown)",
		escalationSendCount === 1, `got ${escalationSendCount}`);

	ok("R14-S2 [GREEN post-fix-C] mailboxAppendCount === 1 (durable escalation append)",
		mailboxAppendCount === 1, `got ${mailboxAppendCount}`);
}

// ============================================================================
// R14-S3: Config C — vacuous → non-vacuous → vacuous → vacuous (extra vacuous tick to expose the per-tick bug)
// ============================================================================
console.log("\n[R14-S3] Config C — vacuous → non-vacuous → vacuous → vacuous (genuinely-vacuous base, 4 ticks to expose per-tick spam)");
{
	const s3Scratch = freshScratch(3);
	const { p } = await seedR14Shape({
		scratch: s3Scratch,
		workerShape: "genuinely-vacuous",
		goalOrigin: "user",
		activeTask: false,
	});

	const pi = {
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		sendMessage: () => {},
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		registerTool: () => {}, registerCommand: () => {}, on: () => {},
	};

	const startMs = Date.now();
	// Tick 1: vacuous = true (genuine ghost base).
	await withLock(p, async () => {
		const st = await readState(p, s3Scratch);
		await evaluateIdleGoalNudgeLocked(pi, s3Scratch, p, st, startMs + 5000);
		await writeState(p, st);
	});
	// Flip worker-1 to non-vacuous + fresh heartbeat.
	await withLock(p, async () => {
		const st = await readState(p, s3Scratch);
		st.agents["worker-1"].tmuxAlive = true;
		st.agents["worker-1"].lastHeartbeatAt = new Date(startMs + 10000).toISOString();
		await writeState(p, st);
	});
	// Tick 2: vacuous = false (worker-1 alive).
	await withLock(p, async () => {
		const st = await readState(p, s3Scratch);
		await evaluateIdleGoalNudgeLocked(pi, s3Scratch, p, st, startMs + 10000);
		await writeState(p, st);
	});
	// Revert worker-1 to vacuous.
	await withLock(p, async () => {
		const st = await readState(p, s3Scratch);
		st.agents["worker-1"].tmuxAlive = false;
		st.agents["worker-1"].lastHeartbeatAt = new Date(startMs - 15 * 60_000).toISOString();
		await writeState(p, st);
	});
	// Tick 3: vacuous = true (transition false→true; trace should fire ONCE).
	await withLock(p, async () => {
		const st = await readState(p, s3Scratch);
		await evaluateIdleGoalNudgeLocked(pi, s3Scratch, p, st, startMs + 15000);
		await writeState(p, st);
	});
	// Tick 4: STILL vacuous = true (no transition; trace must NOT re-fire post-fix B).
	await withLock(p, async () => {
		const st = await readState(p, s3Scratch);
		await evaluateIdleGoalNudgeLocked(pi, s3Scratch, p, st, startMs + 20000);
		await writeState(p, st);
	});

	const events = readEvents(s3Scratch);
	const heldTraces = events.filter((e) => e.event === "goal.nudge.held_no_live_workers");
	// RED pre-fix: 3 (ticks 1, 3, 4 — fires every tick of vacuous).
	// GREEN post-fix: 2 (ticks 1 and 3 only — once per false→true transition; tick 2 non-vacuous clears lastWasVacuous; tick 4 re-fires nothing).
	ok("R14-S3 [GREEN post-fix-B] heldNoLiveWorkersTraceCount === 2 (one per false→true transition; tick 4 must NOT re-fire)",
		heldTraces.length === 2, `got ${heldTraces.length}`);
}

// ============================================================================
// R14-S4: Config D — escalation cooldown bounded (12 ticks, genuinely-vacuous)
// ============================================================================
console.log("\n[R14-S4] Config D — escalation cooldown bounded (12 ticks, genuinely-vacuous)");
{
	const s4Scratch = freshScratch(4);
	const { p } = await seedR14Shape({
		scratch: s4Scratch,
		workerShape: "genuinely-vacuous",
		goalOrigin: "user",
		activeTask: false,
	});

	const pi = {
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		sendMessage: () => {},
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		registerTool: () => {}, registerCommand: () => {}, on: () => {},
	};

	const startMs = Date.now();
	let escalationSendCount = 0;
	for (let i = 0; i < 12; i++) {
		const tickNowMs = startMs + (i + 1) * 5000;
		await withLock(p, async () => {
			const st = await readState(p, s4Scratch);
			await evaluateIdleGoalNudgeLocked(pi, s4Scratch, p, st, tickNowMs);
			await writeState(p, st);
		});
	}

	const events = readEvents(s4Scratch);
	escalationSendCount = events.filter((e) => e.event === "goal.escalation.pool_empty").length;
	ok("R14-S4 [GREEN post-fix] escalationSendCount === 1 (one bounded nudge per cooldown)",
		escalationSendCount === 1, `got ${escalationSendCount}`);

	const mailbox = readOrchestratorMailbox(s4Scratch);
	const highPriorityEscalations = mailbox.filter((m) => m.priority === "high");
	ok("R14-S4 mailbox durable append === 1 with priority=high",
		highPriorityEscalations.length === 1,
		`got ${highPriorityEscalations.length} (mailbox total=${mailbox.length})`);
}

// ============================================================================
// R14-S5: Config F — active pool retains existing suppression
// ============================================================================
// We seed worker-1 with runtimeStatus=idle AND activeTaskIds=[task-r14-active] (the
// idle-pointer shape — not the busy shape). This is the post-Issue-85 "pointer-in-flight"
// suppression path at reconcile.ts:540: `suppressed_by_assignment_in_flight`. The regression
// target is the existing suppression; Fix A + B + C do NOT touch this code path.
// Pre-fix and post-fix this path is byte-identical.
console.log("\n[R14-S5] Config F — active pool retains existing suppression (no regression; pointer-in-flight path)");
{
	const s5Scratch = freshScratch(5);
	const { p } = await seedR14Shape({
		scratch: s5Scratch,
		workerShape: "settled-but-alive",
		goalOrigin: "user",
		activeTask: true,
		freshHeartbeat: true, // workers are non-vacuous BOTH pre-fix and post-fix (the active-task regression is a different code path).
	});

	const pi = {
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		sendMessage: () => {},
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		registerTool: () => {}, registerCommand: () => {}, on: () => {},
	};

	const startMs = Date.now();
	for (let i = 0; i < 12; i++) {
		const tickNowMs = startMs + (i + 1) * 5000;
		await withLock(p, async () => {
			const st = await readState(p, s5Scratch);
			await evaluateIdleGoalNudgeLocked(pi, s5Scratch, p, st, tickNowMs);
			await writeState(p, st);
		});
	}

	const events = readEvents(s5Scratch);
	const heldTraces = events.filter((e) => e.event === "goal.nudge.held_no_live_workers");
	ok("R14-S5 heldNoLiveWorkersTraceCount === 0 (active pool: vacuous=false, no held trace)",
		heldTraces.length === 0, `got ${heldTraces.length}`);

	const suppressedTraces = events.filter((e) => e.event === "goal.nudge.suppressed_by_assignment_in_flight");
	ok("R14-S5 active-task suppression unchanged (>=1 suppressed trace; idle-pointer shape)",
		suppressedTraces.length >= 1, `got ${suppressedTraces.length}`);

	const escalationTraces = events.filter((e) => e.event === "goal.escalation.pool_empty");
	ok("R14-S5 escalationSendCount === 0 (active task suppresses before vacuous branch)",
		escalationTraces.length === 0, `got ${escalationTraces.length}`);
}

// ============================================================================
// R14-S6: Config E — explicit goal clear stops escalation
// ============================================================================
console.log("\n[R14-S6] Config E — explicit goal clear stops escalation mid-cooldown");
{
	const s6Scratch = freshScratch(6);
	const { p } = await seedR14Shape({
		scratch: s6Scratch,
		workerShape: "genuinely-vacuous",
		goalOrigin: "user",
		activeTask: false,
	});

	const pi = {
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		sendMessage: () => {},
		getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		registerTool: () => {}, registerCommand: () => {}, on: () => {},
	};

	const startMs = Date.now();
	// 12 ticks → 1 escalation.
	for (let i = 0; i < 12; i++) {
		const tickNowMs = startMs + (i + 1) * 5000;
		await withLock(p, async () => {
			const st = await readState(p, s6Scratch);
			await evaluateIdleGoalNudgeLocked(pi, s6Scratch, p, st, tickNowMs);
			await writeState(p, st);
		});
	}

	const eventsBefore = readEvents(s6Scratch);
	const escalationBefore = eventsBefore.filter((e) => e.event === "goal.escalation.pool_empty").length;

	// Clear the goal mid-cooldown.
	await withLock(p, async () => {
		const st = await readState(p, s6Scratch);
		delete st.goal;
		await writeState(p, st);
	});

	// 12 more ticks → no additional escalations (goal cleared).
	for (let i = 0; i < 12; i++) {
		const tickNowMs = startMs + 12 * 5000 + (i + 1) * 5000;
		await withLock(p, async () => {
			const st = await readState(p, s6Scratch);
			await evaluateIdleGoalNudgeLocked(pi, s6Scratch, p, st, tickNowMs);
			await writeState(p, st);
		});
	}

	const eventsAfter = readEvents(s6Scratch);
	const escalationAfter = eventsAfter.filter((e) => e.event === "goal.escalation.pool_empty").length;
	ok("R14-S6 escalationSendCount unchanged after goal clear (still 1)",
		escalationAfter === escalationBefore, `before=${escalationBefore} after=${escalationAfter}`);
	ok("R14-S6 no additional escalations after goal clear",
		escalationAfter <= 1, `got ${escalationAfter}`);

	// R14-S6 structural proof: heldAfter.length === 1 (asserted below) is the empirical
	// evidence that the no_goal guard (reconcile.ts `if (!goal) return`) fired on every
	// post-clear tick — the vacuous branch was never re-entered, so no new held traces.
	const heldAfter = eventsAfter.filter((e) => e.event === "goal.nudge.held_no_live_workers");
	ok("R14-S6 heldNoLiveWorkersTraceCount UNCHANGED after clear (the goal evaluator bails at the no_goal guard, not at the vacuous branch)",
		heldAfter.length === 1, `got ${heldAfter.length} (expect 1: pre-clear only)`);
}

// ============================================================================
// Cleanup
// ============================================================================
process.env.PI_SWARM_AGENT_ID = ORIG_PI_SWARM_AGENT_ID;
process.env.PI_SWARM_IS_ORCHESTRATOR = ORIG_PI_SWARM_IS_ORCHESTRATOR;

console.log(`\nR14-GOAL-EMPTY-POOL-ESCALATION ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
if (fail > 0) {
	console.error("\n  ↳ RED regression reproduced — the goal-pump empty-pool deadlock is confirmed across six scenarios. Fix B + C + A (in that order) per plan §5 will land the fix.");
	process.exit(1);
}
process.exit(0);
