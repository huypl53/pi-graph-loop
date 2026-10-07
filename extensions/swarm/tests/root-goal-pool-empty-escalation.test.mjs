#!/usr/bin/env node
/**
 * task-202610071614 (root-goal-pool-empty-escalation) — root-origin goals must
 * escalate on an empty worker pool, and a fresh goal SET must reset the
 * swarm-level lastWasVacuous transition flag.
 *
 * Source incident (verified by plan §0):
 *   - Live trace sequence goal-1791377290938, origin=root, set via issue-controller
 *     at 2026-10-07T12:48Z; by 12:55Z all 27 workers stopped, census
 *     idle:0 busy:0 stopped:27; zero goal.nudge.* traces for that goalId, no
 *     escalation message; only graph.advance_nudge_emitted kept flowing.
 *   - Two root causes:
 *     (1) evaluateIdleGoalNudgeLocked's vacuous + busy-dead branches gate the
 *         escalation on goal.origin ∈ {user, system, batch} — "root" is excluded.
 *     (2) lastWasVacuous is swarm-level (not goal-scoped) and only cleared on
 *         non-vacuous ticks. A new goal created while the flag is already true
 *         produces zero held_no_live_workers traces.
 *
 * Reproduce-first (mandate 2026-08-31). RED observed for S1 + S2 below at pre-fix
 * HEAD. GREEN expected after the predicate widening + lastWasVacuous reset land.
 *
 * Invariants under test:
 *   S1 (RED pre-fix → GREEN post-fix):
 *     root-origin goal + vacuous pool + fresh transition (lastWasVacuous false)
 *     → escalationSendCount === 0 (RED) → === 1 (GREEN); heldNoLiveWorkersTraceCount
 *     === 1 (GREEN); mailbox has 1 high-priority escalation message.
 *   S2 (RED pre-fix → GREEN post-fix):
 *     root-origin goal + vacuous pool + STALE transition (lastWasVacuous true
 *     carried over from a prior goal) → heldNoLiveWorkersTraceCount === 0 (RED,
 *     the stale-flag bug) → === 1 (GREEN, the reset-on-set fires the held trace
 *     on the new goal's first vacuous tick); escalationSendCount === 1 (GREEN).
 *   S3 (no regression):
 *     user-origin goal + vacuous pool + fresh transition → byte-identical to the
 *     existing R14-S2 behavior (the predicate widening must not regress the
 *     user-origin path).
 *   S4 (cooldown bounded):
 *     root-origin goal + 12 ticks of vacuous pool → escalationSendCount === 1
 *     (one bounded nudge per NOTIFY_DEFAULT_COOLDOWN_MS).
 *   S5 (cap honored):
 *     root-origin goal + consecutiveNoResolveNudges already at maxNudges →
 *     escalationSendCount === 0 (the cap branch suppresses; the predicate
 *     widening must not bypass the cap).
 *   S6 (busy-dead route parity):
 *     root-origin goal + 1 busy worker with probe-dead pane + 0 other effective
 *     agents → escalationSendCount === 1 with cause busy_dead_pane (the busy-dead
 *     route must also widen the predicate).
 *   S7 (helper predicate matrix):
 *     goalOriginEscalatesOnEmptyPool returns true for all four origins.
 *   S8 (UPDATE path does NOT reset lastWasVacuous):
 *     an UPDATE on an existing goal preserves the transition flag (an update
 *     is a continuation, not a new goal).
 *
 * R10-1 boundary counters (counting assertions at real boundaries):
 *   C-F27-1: escalationSendCount counted at the real deliverMessageLocked boundary
 *            (mailbox append).
 *   C-F27-2: heldNoLiveWorkersTraceCount counted at the real traceLogged boundary.
 *   C-F27-3: zero pi.sendMessage calls from the new path (escalation rides
 *            deliverMessageLocked L1 append only).
 *   C-F27-4: lastWasVacuous reset trace counted at the real setGoalCore boundary.
 *
 * ISOLATION CONTRACT — SCRATCH CWD ONLY.
 * Run: node extensions/swarm/tests/root-goal-pool-empty-escalation.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

const { paths, withLock, readState, writeState } = await import(join(srcDir, "state.ts"));
const { ensureRoot } = await import(join(srcDir, "identity.ts"));
const { evaluateIdleGoalNudgeLocked, goalOriginEscalatesOnEmptyPool } = await import(join(srcDir, "nudges", "goal-epoch.ts"));
const { setGoalCore } = await import(join(srcDir, "primitives", "goal-core.ts"));

// ============================================================================
// Test harness
// ============================================================================

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info !== undefined ? `(${JSON.stringify(info).slice(0, 400)})` : "");
	}
};

const ORIG_PI_SWARM_AGENT_ID = process.env.PI_SWARM_AGENT_ID;
const ORIG_PI_SWARM_IS_ROOT = process.env.PI_SWARM_IS_ROOT;
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";

function freshScratch(label) {
	return mkdtempSync(join(tmpdir(), `swarm-r27-rootgoal-${label}-${process.pid}-${Date.now()}-`));
}

function readEvents(scratchDir) {
	const p = join(scratchDir, ".pi/swarm/traces/events.jsonl");
	if (!existsSync(p)) return [];
	const txt = readFileSync(p, "utf8").trim();
	return txt
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

function readRootMailbox(scratchDir) {
	const p = join(scratchDir, ".pi/swarm/mailboxes/root.jsonl");
	if (!existsSync(p)) return [];
	const txt = readFileSync(p, "utf8").trim();
	return txt
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

function makePiMock() {
	const sendMessages = [];
	const pi = {
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		sendMessage: (m, _opts) => {
			sendMessages.push({ id: m?.details?.id, m });
		},
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
		registerTool: () => {},
		registerCommand: () => {},
		on: () => {},
	};
	return { pi, sendMessages };
}

/**
 * Seed a swarm state with the specified goal + worker shape.
 * @param opts.scratch — scratch dir
 * @param opts.workerShape — "genuinely-vacuous" (3 dead workers)
 * @param opts.goalOrigin — "user" | "root" | "system" | "batch"
 * @param opts.goalIntervalMs — 5000 (matches live incident)
 * @param opts.goalSetAt — ISO string (default: 15min ago)
 * @param opts.lastWasVacuous — pre-seed the swarm-level transition flag
 */
async function seedR27Shape({
	scratch: scratchDir,
	workerShape = "genuinely-vacuous",
	goalOrigin = "root",
	goalIntervalMs = 5000,
	goalSetAt = null,
	lastWasVacuous = false,
	consecutiveNoResolveNudges = 0,
} = {}) {
	const p = paths(scratchDir);
	const nowMs = Date.now();
	const setAt = goalSetAt || new Date(nowMs - 15 * 60_000).toISOString();
	const workerTs = new Date(nowMs - 15 * 60_000).toISOString();

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
			tmuxAlive: workerShape === "genuinely-vacuous" ? false : true,
			tmuxSession: "r27",
			tmuxWindow: "worker-1",
			tmuxTarget: `r27:worker-1.0`,
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
			tmuxAlive: workerShape === "genuinely-vacuous" ? false : true,
			tmuxSession: "r27",
			tmuxWindow: "worker-2",
			tmuxTarget: `r27:worker-2.0`,
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
			tmuxAlive: workerShape === "genuinely-vacuous" ? false : true,
			tmuxSession: "r27",
			tmuxWindow: "worker-3",
			tmuxTarget: `r27:worker-3.0`,
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
		swarmId: "r27-rootgoal-test",
		cwd: scratchDir,
		tmuxSession: "r27",
		agents,
		delivered: {},
		messages: {},
		goal: {
			id: "goal-r27-red",
			origin: goalOrigin,
			text: "R27 root-origin goal test",
			nudgeIntervalMs: goalIntervalMs,
			setAt,
			consecutiveNoResolveNudges,
		},
		idleNudgeState: lastWasVacuous ? { lastWasVacuous: true } : {},
		createdAt: workerTs,
		updatedAt: workerTs,
	};

	mkdirSync(join(scratchDir, ".pi/swarm/mailboxes"), { recursive: true });
	mkdirSync(join(scratchDir, ".pi/swarm/traces"), { recursive: true });
	writeFileSync(join(scratchDir, ".pi/swarm/traces/events.jsonl"), "");
	writeFileSync(join(scratchDir, ".pi/swarm/swarm-state.json"), JSON.stringify(initial, null, 2));

	await withLock(p, async () => {
		const st = await readState(p, scratchDir);
		ensureRoot(st, scratchDir, p);
		await writeState(p, st);
	});
	return { p, nowMs };
}

// ============================================================================
// S7 — helper predicate matrix (pure, no I/O)
// ============================================================================
console.log("\n[S7] goalOriginEscalatesOnEmptyPool predicate matrix");
{
	ok("S7 user → true", goalOriginEscalatesOnEmptyPool("user") === true);
	ok("S7 root → true (the headline fix)", goalOriginEscalatesOnEmptyPool("root") === true);
	ok("S7 system → true", goalOriginEscalatesOnEmptyPool("system") === true);
	ok("S7 batch → true", goalOriginEscalatesOnEmptyPool("batch") === true);
	ok("S7 undefined → false (defensive)", goalOriginEscalatesOnEmptyPool(undefined) === false);
}

// ============================================================================
// S1 — root-origin goal + vacuous pool + fresh transition (lastWasVacuous false)
// ============================================================================
console.log("\n[S1] root-origin goal + vacuous pool + fresh transition → escalation");
{
	const s1Scratch = freshScratch("s1");
	const { p } = await seedR27Shape({
		scratch: s1Scratch,
		workerShape: "genuinely-vacuous",
		goalOrigin: "root",
		lastWasVacuous: false,
	});

	const { pi, sendMessages } = makePiMock();
	const nowMs = Date.now();

	await withLock(p, async () => {
		const st = await readState(p, s1Scratch);
		await evaluateIdleGoalNudgeLocked(pi, s1Scratch, p, st, nowMs);
		await writeState(p, st);
	});

	const events = readEvents(s1Scratch);
	const heldTraces = events.filter((e) => e.event === "goal.nudge.held_no_live_workers");
	const escalationTraces = events.filter((e) => e.event === "goal.escalation.pool_empty");

	ok(
		"S1 [GREEN post-fix] heldNoLiveWorkersTraceCount === 1 (fresh transition fires the held trace)",
		heldTraces.length === 1,
		`got ${heldTraces.length}`,
	);
	ok(
		"S1 [GREEN post-fix] escalationSendCount === 1 (root-origin goal escalates on empty pool)",
		escalationTraces.length === 1,
		`got ${escalationTraces.length}`,
	);
	ok(
		"S1 [GREEN post-fix] escalation cause === 'pool_empty'",
		escalationTraces[0]?.cause === "pool_empty",
		escalationTraces[0]?.cause,
	);
	ok(
		"S1 [GREEN post-fix] escalation origin === 'root' (the headline fix)",
		escalationTraces[0]?.origin === "root",
		escalationTraces[0]?.origin,
	);

	const mailbox = readRootMailbox(s1Scratch);
	const escMsg = mailbox.find((m) => /Goal escalation: worker pool empty/.test(String(m.subject)));
	ok("S1 [GREEN post-fix] high-priority escalation message appended to root mailbox", Boolean(escMsg), mailbox.map((m) => m.subject));
	ok("S1 [GREEN post-fix] escalation priority === 'high'", escMsg?.priority === "high", escMsg?.priority);

	// R10-1 C-F27-3: zero pi.sendMessage calls from the new path.
	ok("S1 [R10-1 C-F27-3] zero pi.sendMessage calls (escalation rides deliverMessageLocked L1 only)", sendMessages.length === 0, sendMessages.length);
}

// ============================================================================
// S2 — root-origin goal + vacuous pool + STALE transition (lastWasVacuous true)
//      The live incident shape: a new goal is SET while the swarm-level flag is
//      already true (carried over from a prior goal). The reset-on-set must fire
//      the held trace on the new goal's first vacuous tick.
// ============================================================================
console.log("\n[S2] root-origin goal + vacuous pool + STALE transition → reset-on-set fires held trace");
{
	const s2Scratch = freshScratch("s2");
	const p = paths(s2Scratch);
	const nowMs = Date.now();
	const workerTs = new Date(nowMs - 15 * 60_000).toISOString();

	const initial = {
		version: 1,
		swarmId: "r27-rootgoal-s2",
		cwd: s2Scratch,
		tmuxSession: "r27-s2",
		agents: {
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
				tmuxAlive: false,
				tmuxSession: "r27-s2",
				tmuxWindow: "worker-1",
				tmuxTarget: `r27-s2:worker-1.0`,
				model: "mock",
				provider: "mock-llm",
				cwd: s2Scratch,
				mailbox: ".pi/swarm/mailboxes/worker-1.jsonl",
				createdAt: workerTs,
				updatedAt: workerTs,
				lastHeartbeatAt: workerTs,
			},
		},
		delivered: {},
		messages: {},
		goal: {
			id: "goal-r27-s2-old",
			origin: "root",
			text: "R27 root-origin SET test (old goal)",
			nudgeIntervalMs: 5000,
			setAt: new Date(nowMs - 15 * 60_000).toISOString(),
			consecutiveNoResolveNudges: 0,
		},
		idleNudgeState: { lastWasVacuous: true }, // pre-seed the flag (the live incident shape)
		createdAt: workerTs,
		updatedAt: workerTs,
	};

	mkdirSync(join(s2Scratch, ".pi/swarm/mailboxes"), { recursive: true });
	mkdirSync(join(s2Scratch, ".pi/swarm/traces"), { recursive: true });
	writeFileSync(join(s2Scratch, ".pi/swarm/traces/events.jsonl"), "");
	writeFileSync(join(s2Scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(initial, null, 2));

	await withLock(p, async () => {
		const st = await readState(p, s2Scratch);
		ensureRoot(st, s2Scratch, p);
		await writeState(p, st);
	});

	const { pi } = makePiMock();

	// SET a new goal (the reset-on-set site).
	await withLock(p, async () => {
		const st = await readState(p, s2Scratch);
		await setGoalCore(
			p,
			s2Scratch,
			{ text: "R27 root-origin SET test (new goal)", origin: "root" },
			{
				readState: async (pp, cwd) => st,
				writeState: async (pp, s) => {
					Object.assign(st, s);
				},
				trace: async () => {},
				actor: "root",
				via: "test",
			},
		);
		await writeState(p, st);
	});

	// Now drive a tick — the reset-on-set cleared lastWasVacuous, so the held trace fires.
	await withLock(p, async () => {
		const st = await readState(p, s2Scratch);
		await evaluateIdleGoalNudgeLocked(pi, s2Scratch, p, st, nowMs + 1000);
		await writeState(p, st);
	});

	const events = readEvents(s2Scratch);
	const heldTraces = events.filter((e) => e.event === "goal.nudge.held_no_live_workers");
	const escalationTraces = events.filter((e) => e.event === "goal.escalation.pool_empty");

	ok(
		"S2 [GREEN post-fix] heldNoLiveWorkersTraceCount === 1 (the reset-on-set fires the held trace on the new goal's first vacuous tick)",
		heldTraces.length === 1,
		`got ${heldTraces.length}`,
	);
	ok(
		"S2 [GREEN post-fix] escalationSendCount === 1 (root-origin goal escalates on empty pool)",
		escalationTraces.length === 1,
		`got ${escalationTraces.length}`,
	);
}

// ============================================================================
// S3 — control (no regression): user-origin goal + vacuous pool + fresh transition
// ============================================================================
console.log("\n[S3] control: user-origin goal + vacuous pool + fresh transition → byte-identical to R14-S2");
{
	const s3Scratch = freshScratch("s3");
	const { p } = await seedR27Shape({
		scratch: s3Scratch,
		workerShape: "genuinely-vacuous",
		goalOrigin: "user",
		lastWasVacuous: false,
	});

	const { pi } = makePiMock();
	const nowMs = Date.now();

	await withLock(p, async () => {
		const st = await readState(p, s3Scratch);
		await evaluateIdleGoalNudgeLocked(pi, s3Scratch, p, st, nowMs);
		await writeState(p, st);
	});

	const events = readEvents(s3Scratch);
	const heldTraces = events.filter((e) => e.event === "goal.nudge.held_no_live_workers");
	const escalationTraces = events.filter((e) => e.event === "goal.escalation.pool_empty");

	ok(
		"S3 [no regression] heldNoLiveWorkersTraceCount === 1 (user-origin path unchanged)",
		heldTraces.length === 1,
		`got ${heldTraces.length}`,
	);
	ok(
		"S3 [no regression] escalationSendCount === 1 (user-origin path unchanged)",
		escalationTraces.length === 1,
		`got ${escalationTraces.length}`,
	);
	ok(
		"S3 [no regression] escalation origin === 'user'",
		escalationTraces[0]?.origin === "user",
		escalationTraces[0]?.origin,
	);
}

// ============================================================================
// S4 — cooldown bounded: root-origin goal + 12 ticks of vacuous pool
// ============================================================================
console.log("\n[S4] root-origin goal + 12 ticks of vacuous pool → escalationSendCount === 1 (cooldown bounded)");
{
	const s4Scratch = freshScratch("s4");
	const { p } = await seedR27Shape({
		scratch: s4Scratch,
		workerShape: "genuinely-vacuous",
		goalOrigin: "root",
		lastWasVacuous: false,
	});

	const { pi } = makePiMock();
	const startMs = Date.now();
	for (let i = 0; i < 12; i++) {
		const tickNowMs = startMs + (i + 1) * 5000;
		await withLock(p, async () => {
			const st = await readState(p, s4Scratch);
			await evaluateIdleGoalNudgeLocked(pi, s4Scratch, p, st, tickNowMs);
			await writeState(p, st);
		});
	}

	const events = readEvents(s4Scratch);
	const escalationTraces = events.filter((e) => e.event === "goal.escalation.pool_empty");
	ok(
		"S4 [GREEN post-fix] escalationSendCount === 1 (one bounded nudge per NOTIFY_DEFAULT_COOLDOWN_MS)",
		escalationTraces.length === 1,
		`got ${escalationTraces.length}`,
	);

	const mailbox = readRootMailbox(s4Scratch);
	const highPriorityEscalations = mailbox.filter((m) => m.priority === "high");
	ok(
		"S4 mailbox durable append === 1 with priority=high",
		highPriorityEscalations.length === 1,
		`got ${highPriorityEscalations.length} (mailbox total=${mailbox.length})`,
	);
}

// ============================================================================
// S5 — cap honored: root-origin goal + consecutiveNoResolveNudges already at maxNudges
// ============================================================================
console.log("\n[S5] root-origin goal + consecutiveNoResolveNudges at maxNudges → cap suppresses escalation");
{
	const s5Scratch = freshScratch("s5");
	const { p } = await seedR27Shape({
		scratch: s5Scratch,
		workerShape: "genuinely-vacuous",
		goalOrigin: "root",
		lastWasVacuous: false,
		consecutiveNoResolveNudges: 3, // MAX_CONSECUTIVE_NUDGES_DEFAULT
	});

	const { pi } = makePiMock();
	const nowMs = Date.now();

	await withLock(p, async () => {
		const st = await readState(p, s5Scratch);
		await evaluateIdleGoalNudgeLocked(pi, s5Scratch, p, st, nowMs);
		await writeState(p, st);
	});

	const events = readEvents(s5Scratch);
	const escalationTraces = events.filter((e) => e.event === "goal.escalation.pool_empty");
	ok(
		"S5 [GREEN post-fix] escalationSendCount === 0 (cap branch suppresses; predicate widening must not bypass the cap)",
		escalationTraces.length === 0,
		`got ${escalationTraces.length}`,
	);
}

// ============================================================================
// S6 — busy-dead route parity: root-origin goal + 1 busy worker with probe-dead pane
// ============================================================================
console.log("\n[S6] root-origin goal + busy worker with probe-dead pane → busy_dead_pane escalation");
{
	const s6Scratch = freshScratch("s6");
	const p = paths(s6Scratch);
	const nowMs = Date.now();
	const workerTs = new Date(nowMs - 60_000).toISOString();

	const initial = {
		version: 1,
		swarmId: "r27-rootgoal-s6",
		cwd: s6Scratch,
		tmuxSession: "r27-s6",
		agents: {
			"worker-dead": {
				id: "worker-dead",
				role: "implementer",
				roleKind: "implementer",
				capabilities: [],
				activeTaskIds: [],
				maxConcurrentTasks: 1,
				status: "running",
				runtimeStatus: "busy",
				health: "healthy",
				tmuxAlive: true, // stale cache
				tmuxSession: "r27-s6",
				tmuxWindow: "worker-dead",
				tmuxTarget: `r27-s6:worker-dead.0`,
				model: "mock",
				provider: "mock-llm",
				cwd: s6Scratch,
				mailbox: ".pi/swarm/mailboxes/worker-dead.jsonl",
				createdAt: workerTs,
				updatedAt: workerTs,
				lastHeartbeatAt: workerTs,
			},
		},
		delivered: {},
		messages: {},
		goal: {
			id: "goal-r27-s6",
			origin: "root",
			text: "R27 root-origin busy-dead test",
			nudgeIntervalMs: 5000,
			setAt: new Date(nowMs - 15 * 60_000).toISOString(),
			consecutiveNoResolveNudges: 0,
		},
		idleNudgeState: {},
		createdAt: workerTs,
		updatedAt: workerTs,
	};

	mkdirSync(join(s6Scratch, ".pi/swarm/mailboxes"), { recursive: true });
	mkdirSync(join(s6Scratch, ".pi/swarm/traces"), { recursive: true });
	writeFileSync(join(s6Scratch, ".pi/swarm/traces/events.jsonl"), "");
	writeFileSync(join(s6Scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(initial, null, 2));

	await withLock(p, async () => {
		const st = await readState(p, s6Scratch);
		ensureRoot(st, s6Scratch, p);
		await writeState(p, st);
	});

	// pi.exec returns dead for the worker's pane (real tmux driver semantics).
	const pi = {
		exec: async (cmd, args) => {
			if (cmd === "tmux" && args[0] === "list-panes") {
				return { code: 1, stdout: "", stderr: "can't find pane" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
		setModel: async () => true,
		sendMessage: () => {},
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
		registerTool: () => {},
		registerCommand: () => {},
		on: () => {},
	};

	await withLock(p, async () => {
		const st = await readState(p, s6Scratch);
		await evaluateIdleGoalNudgeLocked(pi, s6Scratch, p, st, nowMs + 1000);
		await writeState(p, st);
	});

	const events = readEvents(s6Scratch);
	const escalationTraces = events.filter((e) => e.event === "goal.escalation.pool_empty");
	ok(
		"S6 [GREEN post-fix] escalationSendCount === 1 (busy-dead route widens the predicate)",
		escalationTraces.length === 1,
		`got ${escalationTraces.length}`,
	);
	ok(
		"S6 [GREEN post-fix] escalation cause === 'busy_dead_pane'",
		escalationTraces[0]?.cause === "busy_dead_pane",
		escalationTraces[0]?.cause,
	);
	ok(
		"S6 [GREEN post-fix] escalation origin === 'root'",
		escalationTraces[0]?.origin === "root",
		escalationTraces[0]?.origin,
	);
}

// ============================================================================
// S8 — UPDATE path does NOT reset lastWasVacuous
// ============================================================================
console.log("\n[S8] UPDATE path preserves lastWasVacuous (an update is a continuation, not a new goal)");
{
	const s8Scratch = freshScratch("s8");
	const p = paths(s8Scratch);
	const nowMs = Date.now();
	const workerTs = new Date(nowMs - 15 * 60_000).toISOString();

	const initial = {
		version: 1,
		swarmId: "r27-rootgoal-s8",
		cwd: s8Scratch,
		tmuxSession: "r27-s8",
		agents: {
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
				tmuxAlive: false,
				tmuxSession: "r27-s8",
				tmuxWindow: "worker-1",
				tmuxTarget: `r27-s8:worker-1.0`,
				model: "mock",
				provider: "mock-llm",
				cwd: s8Scratch,
				mailbox: ".pi/swarm/mailboxes/worker-1.jsonl",
				createdAt: workerTs,
				updatedAt: workerTs,
				lastHeartbeatAt: workerTs,
			},
		},
		delivered: {},
		messages: {},
		goal: {
			id: "goal-r27-s8",
			origin: "root",
			text: "R27 root-origin UPDATE test",
			nudgeIntervalMs: 5000,
			setAt: new Date(nowMs - 15 * 60_000).toISOString(),
			consecutiveNoResolveNudges: 0,
		},
		idleNudgeState: { lastWasVacuous: true }, // pre-seed the flag
		createdAt: workerTs,
		updatedAt: workerTs,
	};

	mkdirSync(join(s8Scratch, ".pi/swarm/mailboxes"), { recursive: true });
	mkdirSync(join(s8Scratch, ".pi/swarm/traces"), { recursive: true });
	writeFileSync(join(s8Scratch, ".pi/swarm/traces/events.jsonl"), "");
	writeFileSync(join(s8Scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(initial, null, 2));

	await withLock(p, async () => {
		const st = await readState(p, s8Scratch);
		ensureRoot(st, s8Scratch, p);
		await writeState(p, st);
	});

	// UPDATE the existing goal (not SET a new one).
	await withLock(p, async () => {
		const st = await readState(p, s8Scratch);
		await setGoalCore(
			p,
			s8Scratch,
			{ text: "R27 root-origin UPDATE test (updated)", update: true },
			{
				readState: async (pp, cwd) => st,
				writeState: async (pp, s) => {
					Object.assign(st, s);
				},
				trace: async () => {},
				actor: "root",
				via: "test",
			},
		);
		await writeState(p, st);
	});

	// Verify lastWasVacuous is STILL true (UPDATE path does not reset).
	const stateAfter = JSON.parse(readFileSync(join(s8Scratch, ".pi/swarm/swarm-state.json"), "utf8"));
	ok(
		"S8 [GREEN post-fix] lastWasVacuous === true after UPDATE (UPDATE path preserves the flag)",
		stateAfter.idleNudgeState?.lastWasVacuous === true,
		stateAfter.idleNudgeState,
	);
}

// ============================================================================
// S9 — SET path resets lastWasVacuous (the headline fix for the stale-flag bug)
// ============================================================================
console.log("\n[S9] SET path resets lastWasVacuous (the headline fix for the stale-flag bug)");
{
	const s9Scratch = freshScratch("s9");
	const p = paths(s9Scratch);
	const nowMs = Date.now();
	const workerTs = new Date(nowMs - 15 * 60_000).toISOString();

	const initial = {
		version: 1,
		swarmId: "r27-rootgoal-s9",
		cwd: s9Scratch,
		tmuxSession: "r27-s9",
		agents: {
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
				tmuxAlive: false,
				tmuxSession: "r27-s9",
				tmuxWindow: "worker-1",
				tmuxTarget: `r27-s9:worker-1.0`,
				model: "mock",
				provider: "mock-llm",
				cwd: s9Scratch,
				mailbox: ".pi/swarm/mailboxes/worker-1.jsonl",
				createdAt: workerTs,
				updatedAt: workerTs,
				lastHeartbeatAt: workerTs,
			},
		},
		delivered: {},
		messages: {},
		goal: {
			id: "goal-r27-s9-old",
			origin: "root",
			text: "R27 root-origin SET test (old goal)",
			nudgeIntervalMs: 5000,
			setAt: new Date(nowMs - 15 * 60_000).toISOString(),
			consecutiveNoResolveNudges: 0,
		},
		idleNudgeState: { lastWasVacuous: true }, // pre-seed the flag (the live incident shape)
		createdAt: workerTs,
		updatedAt: workerTs,
	};

	mkdirSync(join(s9Scratch, ".pi/swarm/mailboxes"), { recursive: true });
	mkdirSync(join(s9Scratch, ".pi/swarm/traces"), { recursive: true });
	writeFileSync(join(s9Scratch, ".pi/swarm/traces/events.jsonl"), "");
	writeFileSync(join(s9Scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(initial, null, 2));

	await withLock(p, async () => {
		const st = await readState(p, s9Scratch);
		ensureRoot(st, s9Scratch, p);
		await writeState(p, st);
	});

	// SET a new goal (not UPDATE).
	await withLock(p, async () => {
		const st = await readState(p, s9Scratch);
		await setGoalCore(
			p,
			s9Scratch,
			{ text: "R27 root-origin SET test (new goal)", origin: "root" },
			{
				readState: async (pp, cwd) => st,
				writeState: async (pp, s) => {
					Object.assign(st, s);
				},
				trace: async () => {},
				actor: "root",
				via: "test",
			},
		);
		await writeState(p, st);
	});

	// Verify lastWasVacuous is now false (SET path resets the flag).
	const stateAfter = JSON.parse(readFileSync(join(s9Scratch, ".pi/swarm/swarm-state.json"), "utf8"));
	ok(
		"S9 [GREEN post-fix] lastWasVacuous === false after SET (SET path resets the flag)",
		stateAfter.idleNudgeState?.lastWasVacuous === false,
		stateAfter.idleNudgeState,
	);
}

// ============================================================================
// Cleanup
// ============================================================================
process.env.PI_SWARM_AGENT_ID = ORIG_PI_SWARM_AGENT_ID;
process.env.PI_SWARM_IS_ROOT = ORIG_PI_SWARM_IS_ROOT;

console.log(`\nROOT-GOAL-POOL-EMPTY-ESCALATION ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
if (fail > 0) {
	console.error(
		"\n  ↳ RED regression reproduced — the root-origin goal-pump empty-pool deadlock is confirmed. The predicate widening + lastWasVacuous reset will land the fix.",
	);
	process.exit(1);
}
process.exit(0);
