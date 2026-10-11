#!/usr/bin/env node
/**
 * task-r-deadpane-goal-classifier — busy-but-dead-pane agents must classify as dead
 * in the goal-escalation / pool-drain diagnostics.
 *
 * Incident (2026-10-03): implementer-02's pane wV:p4 died (herdr workspace closed
 * externally) but swarm-state kept runtimeStatus=busy on a fresh heartbeat; the
 * goal-escalation classifier reported a live busy worker while the worker was
 * physically dead, delaying recovery ~10 minutes (the heartbeat-stale window).
 *
 * Root cause (plan §1): `evaluateIdleGoalNudgeLocked`'s `!allIdle` branch returns the
 * opaque `{emitted:false, reason:"agent_busy"}` for busy agents without ever consulting
 * the existing pane-liveness probe (`isTmuxRunning` facade → terminal driver). The
 * heartbeat GC only corrects `tmuxAlive` after 2× the stale window (20 min) — too late
 * for the goal floor, and heartbeat age is a weak liveness signal for busy agents.
 *
 * REPRODUCE-FIRST (mandate 2026-08-31). S1/S1b are observed RED pre-fix:
 *   pre-fix  → {emitted:false, reason:"agent_busy"}, no trace, no escalation
 *   post-fix → escalation fires with cause busy_dead_pane; poolDiag row classifies
 *              the worker `busy_dead_pane` with paneAlive:false; reason no_live_workers
 *
 * Scenarios:
 *   S1  THE REPRODUCTION — busy + FRESH heartbeat + cached tmuxAlive:true + probe dead
 *       → escalation (cause busy_dead_pane) + poolDiag classification + restart hint.
 *       Heartbeat freshness is irrelevant: fresh + dead pane still classifies dead.
 *   S1b variant — runtimeStatus=tool_running (mid-tool) + fresh heartbeat + dead pane
 *       → dead-pane escalation instead of the long-running-tool health-check nudge.
 *   S2  control (no false positive) — same seed, pane ALIVE → reason agent_busy,
 *       zero escalations, zero dead_pane traces, exactly 1 probe.
 *   S3  probe ledger + cap — second run inside the probe interval fires 0 probes and
 *       no re-escalation; probe count is capped at PI_SWARM_GOAL_DIAG_PROBE_MAX.
 *   S4  mixed pool — dead busy worker + live idle worker → NO pool-empty escalation;
 *       ONE ledger-gated goal.escalation.dead_pane_detected trace; reason agent_busy.
 *   S5  probe failure routing — pi.exec throws → errors.jsonl gains a
 *       goal_diag.probe_failed entry (no silent swallow); agent treated
 *       liveness-unknown (no escalation); classifier continues.
 *   S6  parity — vacuous-branch behavior byte-identical through the refactor:
 *       historical-stopped filtering, maxNudges cap suppression, cooldown stamp.
 *   R10-1 boundary counters (contract §10 F24):
 *       C-F24-1 zero pi.sendMessage calls from the new path (escalation rides
 *               deliverMessageLocked L1 append only)
 *       C-F24-2 probe exec count per round ≤ GOAL_ESCALATION_DIAG_PROBE_MAX,
 *               counted at the real pi.exec boundary
 *       C-F24-3 escalation append exactly 1 per hour-bucket (deliverMessageLocked
 *               idempotency dedupe proof)
 *   R27-B static import-integrity guard: the pump path still statically imports
 *       evaluateIdleGoalNudgeLocked; goal-epoch.ts has no new pi.sendMessage call
 *       sites and no empty catch blocks.
 *
 * Harness: real paths/withLock/readState/writeState on a mkdtemp scratch + mock
 * `pi.exec` with canned `tmux list-panes` results (heartbeat-gc.test.mjs pattern —
 * the REAL tmux terminal driver runs; no internal mocks; deterministic, offline,
 * ms-scale). PI_SWARM_TERMINAL_MANAGER=tmux pins the tmux driver explicitly (repo
 * .pi/swarm.yml may declare herdr; env wins at the factory fast path).
 *
 * Run: PI_SWARM_AGENT_ID=root PI_SWARM_IS_ROOT=1 node extensions/swarm/tests/goal-escalation-deadpane-classify.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

const { paths, withLock, readState, writeState, ensureDirs } = await import(join(srcDir, "state.ts"));
const { evaluateIdleGoalNudgeLocked } = await import(join(srcDir, "nudges", "goal-epoch.ts"));
const { ensureRoot } = await import(join(srcDir, "identity.ts"));

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info !== undefined ? JSON.stringify(info).slice(0, 400) : "");
	}
};

// --- driver pin: tmux driver so the probe seam is `pi.exec("tmux", ["list-panes", ...])` ---
const PREV_TERMINAL_MANAGER = process.env.PI_SWARM_TERMINAL_MANAGER;
process.env.PI_SWARM_TERMINAL_MANAGER = "tmux";
const PREV_AGENT_ID = process.env.PI_SWARM_AGENT_ID;
const PREV_IS_ROOT = process.env.PI_SWARM_IS_ROOT;
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";

let scratch = null;
function freshScratch(label) {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
	scratch = mkdtempSync(join(tmpdir(), `swarm-deadpane-${label}-`));
	mkdirSync(join(scratch, ".pi", "swarm", "mailboxes"), { recursive: true });
	mkdirSync(join(scratch, ".pi", "swarm", "traces"), { recursive: true });
	return scratch;
}

function readEvents(scratchDir = scratch) {
	const p = join(scratchDir, ".pi/swarm/traces/events.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8")
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

function readRootMailbox(scratchDir = scratch) {
	const p = join(scratchDir, ".pi/swarm/mailboxes/root.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8")
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

function readErrors(scratchDir = scratch) {
	const p = join(scratchDir, ".pi/swarm/traces/errors.jsonl");
	if (!existsSync(p)) return [];
	return readFileSync(p, "utf8")
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

/**
 * pi mock with a canned tmux liveness map + exec/sendMessage counters.
 * `tmux list-panes -t <target>` exits 0 when the pane is alive, 1 when dead —
 * the real TmuxDriver.isTargetAlive treats exit 0 as alive, throw/non-zero as dead.
 */
function makePi({ tmuxAlive = new Map(), failTargets = [] } = {}) {
	const execCalls = [];
	const sendMessages = [];
	const pi = {
		registerTool: () => {},
		registerCommand: () => {},
		on: () => {},
		setModel: async () => true,
		sendMessage: (m, o) => {
			sendMessages.push({ m, o });
		},
		exec: async (cmd, args) => {
			execCalls.push({ cmd, args });
			if (cmd === "tmux" && args[0] === "list-panes") {
				const target = args[args.indexOf("-t") + 1];
				if (failTargets.includes(target)) throw new Error(`tmux list-panes crashed for ${target}`);
				const alive = tmuxAlive.get(target) ?? false;
				return { code: alive ? 0 : 1, stdout: alive ? "1\n" : "", stderr: alive ? "" : "can't find pane" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	return { pi, execCalls, sendMessages, listPaneCalls: () => execCalls.filter((c) => c.cmd === "tmux" && c.args[0] === "list-panes") };
}

const GOAL_SET_AT = () => new Date(Date.now() - 30 * 60_000).toISOString(); // 30min ago, past any grace

function makeWorker(id, { runtimeStatus = "busy", heartbeatAgeMs = 60_000, tmuxAlive = true, createdAtAgeMs = 30 * 60_000 } = {}) {
	const now = Date.now();
	return {
		id,
		role: "implementer",
		roleKind: "implementer",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus,
		health: "healthy",
		tmuxAlive,
		tmuxSession: "goal-deadpane-probe",
		tmuxWindow: id,
		tmuxTarget: `goal-deadpane-probe:${id}.0`,
		model: "mock",
		provider: "mock-llm",
		cwd: scratch,
		mailbox: `.pi/swarm/mailboxes/${id}.jsonl`,
		createdAt: new Date(now - createdAtAgeMs).toISOString(),
		updatedAt: new Date(now - heartbeatAgeMs).toISOString(),
		lastHeartbeatAt: new Date(now - heartbeatAgeMs).toISOString(),
	};
}

/**
 * Seed the incident shape: user-origin goal + worker records; write state to disk.
 * Returns the Paths handle.
 */
async function seed(agents, goalOverrides = {}) {
	const p = paths(scratch);
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		ensureRoot(st, scratch, p);
		for (const a of agents) st.agents[a.id] = a;
		st.goal = {
			id: "goal-deadpane-1",
			text: "Ship the dead-pane classifier fix",
			origin: "user",
			setAt: GOAL_SET_AT(),
			consecutiveNoResolveNudges: 0,
			...goalOverrides,
		};
		st.idleNudgeState = {};
		await writeState(p, st);
	});
	return p;
}

/** One evaluator tick under the real lock. */
async function tick(p, pi, nowMs, rootBusy = false) {
	return withLock(p, async () => {
		const st = await readState(p, scratch);
		const r = await evaluateIdleGoalNudgeLocked(pi, scratch, p, st, nowMs, rootBusy);
		await writeState(p, st);
		return r;
	});
}

// =============================================================================
// S1 — THE REPRODUCTION (red pre-fix): busy + FRESH heartbeat + cached tmuxAlive:true
//      + probe returns dead → must classify dead and escalate, NOT agent_busy.
// =============================================================================
console.log("\n[S1] busy + fresh heartbeat + dead pane → busy_dead_pane escalation");
{
	freshScratch("s1");
	const now = Date.now();
	// G1 incident shape: busy agent, heartbeat 60s old (FRESH — well inside the 10min
	// stale window), cached tmuxAlive:true (stale cache never corrected yet).
	const worker = makeWorker("worker-dead", { runtimeStatus: "busy", heartbeatAgeMs: 60_000, tmuxAlive: true });
	const p = await seed([worker]);
	const { pi, listPaneCalls } = makePi({ tmuxAlive: new Map([["goal-deadpane-probe:worker-dead.0", false]]) });

	const r = await tick(p, pi, now + 1000);

	ok(
		"S1 [GREEN post-fix] result.reason === 'no_live_workers' (pre-fix RED: 'agent_busy')",
		r.reason === "no_live_workers",
		{ reason: r.reason },
	);
	ok("S1 [GREEN post-fix] result.emitted === false", r.emitted === false, r);

	const events = readEvents();
	const esc = events.find((e) => e.event === "goal.escalation.pool_empty");
	ok("S1 [GREEN post-fix] goal.escalation.pool_empty trace fired", Boolean(esc), events.map((e) => e.event));
	ok("S1 [GREEN post-fix] escalation cause === 'busy_dead_pane'", esc?.cause === "busy_dead_pane", esc?.cause);
	const diagRow = esc?.poolDiag?.find((d) => d.id === "worker-dead");
	ok("S1 [GREEN post-fix] poolDiag row classifies worker-dead as 'busy_dead_pane'", diagRow?.classification === "busy_dead_pane", diagRow);
	ok("S1 [GREEN post-fix] poolDiag row carries fresh paneAlive === false (probe beat the cache)", diagRow?.paneAlive === false, diagRow);
	ok(
		"S1 [GREEN post-fix] heartbeat freshness irrelevant: fresh 60s heartbeat still classified dead",
		diagRow?.classification === "busy_dead_pane" && diagRow?.heartbeatAgeSec !== null && diagRow?.heartbeatAgeSec < 120,
		diagRow,
	);

	const mb = readRootMailbox();
	const escMsg = mb.find((m) => /Goal escalation: worker pool empty/.test(String(m.subject)));
	ok("S1 [GREEN post-fix] high-priority escalation message appended to root mailbox", Boolean(escMsg), mb.map((m) => m.subject));
	ok("S1 [GREEN post-fix] escalation priority === 'high'", escMsg?.priority === "high", escMsg?.priority);
	ok(
		"S1 [GREEN post-fix] escalation body names the dead worker + restart hint",
		Boolean(escMsg) && String(escMsg.body).includes("worker-dead") && /swarm_spawn_agent|swarm_restart_agent/.test(String(escMsg.body)),
		escMsg?.body?.slice(0, 300),
	);

	const state = JSON.parse(readFileSync(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
	ok(
		"S1 [GREEN post-fix] probe ledger persisted (goalDiagProbeLedger[worker-dead] stamped)",
		typeof state.idleNudgeState?.goalDiagProbeLedger?.["worker-dead"] === "string",
		state.idleNudgeState?.goalDiagProbeLedger,
	);
	ok(
		"S1 [GREEN post-fix] cooldown stamp persisted (lastPoolEmptyEscalationAt)",
		typeof state.idleNudgeState?.lastPoolEmptyEscalationAt === "string",
		state.idleNudgeState?.lastPoolEmptyEscalationAt,
	);
	ok("S1 [GREEN post-fix] agent record NOT mutated by the probe (read-only classifier)", state.agents["worker-dead"].tmuxAlive === true && state.agents["worker-dead"].status === "running", {
		tmuxAlive: state.agents["worker-dead"].tmuxAlive,
		status: state.agents["worker-dead"].status,
	});
	ok("S1 [probe-cost] exactly 1 probe fired for 1 busy agent", listPaneCalls().length === 1, listPaneCalls().length);
}

// =============================================================================
// S1b — mid-tool variant: runtimeStatus=tool_running + fresh heartbeat + dead pane
//       → dead-pane escalation instead of the long-running-tool health-check nudge.
// =============================================================================
console.log("\n[S1b] tool_running + fresh heartbeat + dead pane → dead-pane escalation (not health-check)");
{
	freshScratch("s1b");
	const now = Date.now();
	const worker = makeWorker("worker-tool", { runtimeStatus: "tool_running", heartbeatAgeMs: 60_000, tmuxAlive: true });
	const p = await seed([worker]);
	const { pi } = makePi({ tmuxAlive: new Map([["goal-deadpane-probe:worker-tool.0", false]]) });

	const r = await tick(p, pi, now + 1000);

	ok("S1b [GREEN post-fix] reason === 'no_live_workers' (dead-pane route wins over health-check)", r.reason === "no_live_workers", { reason: r.reason });
	const events = readEvents();
	ok("S1b [GREEN post-fix] pool_empty escalation fired with cause busy_dead_pane", events.some((e) => e.event === "goal.escalation.pool_empty" && e.cause === "busy_dead_pane"), events.map((e) => e.event));
	ok("S1b [GREEN post-fix] NO long_running_tool health-check nudge fired", !events.some((e) => e.event === "goal.nudge.long_running_tool"), events.map((e) => e.event));
	const mb = readRootMailbox();
	ok("S1b [GREEN post-fix] exactly 1 escalation message (no health-check message)", mb.filter((m) => /Health Check|pool empty/.test(String(m.subject))).length === 1, mb.map((m) => m.subject));
}

// =============================================================================
// S2 — control (no false positive): same seed, pane ALIVE → agent_busy, no escalation.
// =============================================================================
console.log("\n[S2] control: busy + fresh heartbeat + LIVE pane → agent_busy, zero escalations");
{
	freshScratch("s2");
	const now = Date.now();
	const worker = makeWorker("worker-live", { runtimeStatus: "busy", heartbeatAgeMs: 60_000, tmuxAlive: true });
	const p = await seed([worker]);
	const { pi, listPaneCalls } = makePi({ tmuxAlive: new Map([["goal-deadpane-probe:worker-live.0", true]]) });

	const r = await tick(p, pi, now + 1000);

	ok("S2 result.reason === 'agent_busy' (live busy worker unchanged)", r.reason === "agent_busy", { reason: r.reason });
	const events = readEvents();
	ok("S2 no pool_empty escalation", !events.some((e) => e.event === "goal.escalation.pool_empty"), events.map((e) => e.event));
	ok("S2 no dead_pane_detected trace", !events.some((e) => e.event === "goal.escalation.dead_pane_detected"), events.map((e) => e.event));
	ok("S2 zero escalation messages", readRootMailbox().length === 0, readRootMailbox().length);
	ok("S2 exactly 1 probe fired (probing happens, verdict is alive)", listPaneCalls().length === 1, listPaneCalls().length);
}

// =============================================================================
// S3 — probe ledger + cap.
// =============================================================================
console.log("\n[S3] probe ledger cooldown + probe cap");
{
	// --- S3a: second run inside the probe interval fires 0 probes ---
	freshScratch("s3a");
	const now = Date.now();
	const worker = makeWorker("worker-ledger", { runtimeStatus: "busy", heartbeatAgeMs: 60_000, tmuxAlive: true });
	const p = await seed([worker]);
	const { pi, listPaneCalls } = makePi({ tmuxAlive: new Map([["goal-deadpane-probe:worker-ledger.0", false]]) });

	await tick(p, pi, now + 1000);
	const probesAfterRun1 = listPaneCalls().length;
	ok("S3a run 1 fired exactly 1 probe", probesAfterRun1 === 1, probesAfterRun1);
	await tick(p, pi, now + 2000);
	ok(
		"S3a run 2 inside probe interval fired 0 probes (ledger-gated)",
		listPaneCalls().length === probesAfterRun1,
		{ run1: probesAfterRun1, total: listPaneCalls().length },
	);
	ok("S3a no re-escalation within cooldown (mailbox still 1 message)", readRootMailbox().length === 1, readRootMailbox().length);

	// --- S3b: probe count capped at PI_SWARM_GOAL_DIAG_PROBE_MAX ---
	const PREV_MAX = process.env.PI_SWARM_GOAL_DIAG_PROBE_MAX;
	process.env.PI_SWARM_GOAL_DIAG_PROBE_MAX = "2";
	try {
		freshScratch("s3b");
		const now2 = Date.now();
		const workers = ["w1", "w2", "w3", "w4"].map((id) => makeWorker(id, { runtimeStatus: "busy", heartbeatAgeMs: 60_000, tmuxAlive: true }));
		const p2 = await seed(workers);
		const { pi: pi2, listPaneCalls: lpc2 } = makePi({
			tmuxAlive: new Map(workers.map((w) => [w.tmuxTarget, false])),
		});
		await tick(p2, pi2, now2 + 1000);
		ok("S3b probe count capped at PI_SWARM_GOAL_DIAG_PROBE_MAX=2 (4 suspicious agents)", lpc2().length === 2, lpc2().length);
	} finally {
		if (PREV_MAX === undefined) delete process.env.PI_SWARM_GOAL_DIAG_PROBE_MAX;
		else process.env.PI_SWARM_GOAL_DIAG_PROBE_MAX = PREV_MAX;
	}
}

// =============================================================================
// S4 — mixed pool: dead busy worker + live idle worker → trace-only dead_pane_detected.
// =============================================================================
console.log("\n[S4] mixed pool: dead busy worker + live idle worker → no escalation, one dead_pane_detected trace");
{
	freshScratch("s4");
	const now = Date.now();
	const deadWorker = makeWorker("worker-dead-mix", { runtimeStatus: "busy", heartbeatAgeMs: 60_000, tmuxAlive: true });
	const liveWorker = makeWorker("worker-live-mix", { runtimeStatus: "idle", heartbeatAgeMs: 60_000, tmuxAlive: true });
	const p = await seed([deadWorker, liveWorker]);
	const { pi } = makePi({
		tmuxAlive: new Map([
			["goal-deadpane-probe:worker-dead-mix.0", false],
			["goal-deadpane-probe:worker-live-mix.0", true],
		]),
	});

	const r = await tick(p, pi, now + 1000);

	ok("S4 reason === 'agent_busy' (live worker remains; pool NOT empty)", r.reason === "agent_busy", { reason: r.reason });
	const events = readEvents();
	ok("S4 NO pool_empty escalation (live workers remain)", !events.some((e) => e.event === "goal.escalation.pool_empty"), events.map((e) => e.event));
	const deadTrace = events.filter((e) => e.event === "goal.escalation.dead_pane_detected");
	ok("S4 exactly ONE goal.escalation.dead_pane_detected trace", deadTrace.length === 1, deadTrace.length);
	ok("S4 trace names the dead agent id", Boolean(deadTrace[0]) && (deadTrace[0]?.agents?.includes?.("worker-dead-mix") || JSON.stringify(deadTrace[0]).includes("worker-dead-mix")), deadTrace[0]);
	ok("S4 trace carries the busy_dead_pane classification", Boolean(deadTrace[0]) && JSON.stringify(deadTrace[0]).includes("busy_dead_pane"), deadTrace[0]);
	ok("S4 zero mailbox messages (silence stays correct with live workers)", readRootMailbox().length === 0, readRootMailbox().length);
}

// =============================================================================
// S5 — probe failure routing: pi.exec throws → durable errorlog entry, no escalation,
//      classifier continues (liveness unknown ⇒ treated alive-by-convention).
// =============================================================================
console.log("\n[S5] probe failure routes to errors.jsonl (no silent swallow)");
{
	freshScratch("s5");
	const now = Date.now();
	const worker = makeWorker("worker-err", { runtimeStatus: "busy", heartbeatAgeMs: 60_000, tmuxAlive: true });
	const p = await seed([worker]);
	// S5 exercises the REAL per-agent probe-error path: the shared isTmuxRunning facade routes
	// to the tmuxDriver singleton, so patching ITS isTargetAlive to throw gives a genuine
	// exception from inside probeAgentPaneLiveness. (The real tmux driver converts exec failure
	// to false + its own durable errorlog entry — see tmux-alive-fallback-reproduce.test.mjs —
	// so an exec mock cannot produce a probe-throws lane there.)
	let r = null;
	let threw = false;
	const { pi: piS5 } = makePi();
	try {
		const { tmuxDriver } = await import(join(srcDir, "terminal", "index.ts"));
		const origIsTargetAlive = tmuxDriver.isTargetAlive;
		tmuxDriver.isTargetAlive = async () => {
			throw new Error("simulated probe crash (S5)");
		};
		try {
			r = await tick(p, piS5, now + 1000);
		} finally {
			tmuxDriver.isTargetAlive = origIsTargetAlive;
		}
	} catch (err) {
		threw = true;
	}
	ok("S5 evaluator did not throw (per-agent catch)", threw === false, threw);
	ok("S5 reason === 'agent_busy' (liveness unknown ⇒ treated alive-by-convention)", r?.reason === "agent_busy", { reason: r?.reason });
	ok("S5 no escalation fired on unknown liveness", !readEvents().some((e) => e.event === "goal.escalation.pool_empty"));
	const errs = readErrors();
	const probeErr = errs.find((e) => e.event === "internal.error" && e.op === "goal_diag.probe_failed");
	ok("S5 errors.jsonl gained a goal_diag.probe_failed entry (durable, not silent)", Boolean(probeErr), errs.slice(0, 3));
	ok("S5 error entry names the agent", JSON.stringify(probeErr || {}).includes("worker-err"), probeErr);
}

// =============================================================================
// S6 — parity: vacuous-branch behavior byte-identical through the refactor.
// =============================================================================
console.log("\n[S6] parity: vacuous path (pool-diag historical filter, maxNudges cap, cooldown) unchanged");
{
	// --- S6a: historical stopped agent excluded from poolDiag ---
	freshScratch("s6a");
	const now = Date.now();
	const old = makeWorker("old-worker", { runtimeStatus: "stopped", heartbeatAgeMs: 2 * 86400_000, tmuxAlive: false, createdAtAgeMs: 3 * 86400_000 });
	old.status = "stopped";
	old.lastShutdownAt = new Date(now - 2 * 86400_000).toISOString();
	const p = await seed([old]);
	const { pi } = makePi();
	await tick(p, pi, now + 1000);
	const escA = readEvents().find((e) => e.event === "goal.escalation.pool_empty");
	ok("S6a vacuous escalation still fires for genuinely-vacuous pool", Boolean(escA), readEvents().map((e) => e.event));
	ok("S6a escalation cause === 'pool_empty' (vacuous branch keeps its cause)", escA?.cause === "pool_empty", escA?.cause);
	ok("S6a historical stopped agent excluded from poolDiag", Array.isArray(escA?.poolDiag) && escA.poolDiag.length === 0, escA?.poolDiag);
	ok("S6a cooldown stamp set by the vacuous branch", typeof JSON.parse(readFileSync(join(scratch, ".pi/swarm/swarm-state.json"), "utf8")).idleNudgeState?.lastPoolEmptyEscalationAt === "string");

	// --- S6b: capped goal suppresses escalation ---
	freshScratch("s6b");
	const nowB = Date.now();
	const pB = await seed([makeWorker("worker-capped", { runtimeStatus: "stopped", heartbeatAgeMs: 2 * 86400_000, tmuxAlive: false, createdAtAgeMs: 3 * 86400_000 })], {
		maxNudges: 1,
		consecutiveNoResolveNudges: 2,
	});
	const { pi: piB } = makePi();
	await withLock(pB, async () => {
		const st = await readState(pB, scratch);
		st.agents["worker-capped"].status = "stopped";
		st.agents["worker-capped"].lastShutdownAt = new Date(nowB - 2 * 86400_000).toISOString();
		await writeState(pB, st);
	});
	await tick(pB, piB, nowB + 1000);
	ok("S6b escalation suppressed when goal already capped at maxNudges", !readEvents().some((e) => e.event === "goal.escalation.pool_empty"), readEvents().map((e) => e.event));

	// --- S6c: cooldown — second tick within NOTIFY_DEFAULT_COOLDOWN_MS does not re-escalate ---
	freshScratch("s6c");
	const nowC = Date.now();
	const stopped = makeWorker("worker-stopped-c", { runtimeStatus: "stopped", heartbeatAgeMs: 2 * 86400_000, tmuxAlive: false, createdAtAgeMs: 3 * 86400_000 });
	stopped.status = "stopped";
	stopped.lastShutdownAt = new Date(nowC - 2 * 86400_000).toISOString();
	const pC = await seed([stopped]);
	const { pi: piC } = makePi();
	await tick(pC, piC, nowC + 1000);
	await tick(pC, piC, nowC + 60_000);
	const escCount = readEvents().filter((e) => e.event === "goal.escalation.pool_empty").length;
	ok("S6c exactly 1 escalation across 2 ticks within cooldown", escCount === 1, escCount);
}

// =============================================================================
// R10-1 boundary counters (contract §10 F24)
// =============================================================================
console.log("\n[R10-1] F24 boundary counters");
{
	// --- C-F24-1: zero pi.sendMessage calls from the new path ---
	freshScratch("cf241");
	let now = Date.now();
	const worker = makeWorker("worker-send", { runtimeStatus: "busy", heartbeatAgeMs: 60_000, tmuxAlive: true });
	const p = await seed([worker]);
	const { pi, sendMessages } = makePi({ tmuxAlive: new Map([["goal-deadpane-probe:worker-send.0", false]]) });
	await tick(p, pi, now + 1000);
	ok(
		"C-F24-1 ZERO pi.sendMessage calls while the escalation WAS appended (deliverMessageLocked L1 only)",
		sendMessages.length === 0 && readRootMailbox().length === 1,
		{ sends: sendMessages.length, mailbox: readRootMailbox().length },
	);

	// --- C-F24-3: escalation append exactly 1 per hour-bucket (idempotency dedupe proof) ---
	// Cooldown expired (lastPoolEmptyEscalationAt 10min ago) and the re-fire lands in the SAME
	// hour-bucket → the idempotency key `goal:<id>:escalation:pool-empty:<YYYY-MM-DDTHH>` dedupes
	// the append. The re-fire time is DERIVED from `now` (not Date.now()) so the suite is
	// hour-boundary-immune: if `now + 11min` would cross the hour top, both ticks are pulled back
	// into `now`'s hour (the dedupe key family is wall-clock-hour based by design — that product
	// behavior is pinned by root-goal-pool-empty-escalation's cooldown assertions, not here).
	{
		const minuteOf = (t) => new Date(t).getUTCMinutes();
		if (minuteOf(now + 11 * 60_000) < minuteOf(now)) {
			// crossing the hour top: rewind BOTH ticks into the current hour
			now -= 15 * 60_000;
		}
	}
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		st.idleNudgeState.lastPoolEmptyEscalationAt = new Date(now - 10 * 60_000).toISOString();
		await writeState(p, st);
	});
	await tick(p, pi, now + 11 * 60_000);
	ok("C-F24-3 same-hour re-fire past the cooldown appends NOTHING new (hour-bucket dedupe)", readRootMailbox().length === 1, readRootMailbox().length);
}

// =============================================================================
// R27-B static import-integrity guard (pump path + no-silent-swallow scan)
// =============================================================================
console.log("\n[R27-B] static import-integrity + no-silent-swallow guards");
{
	const goalEpochSrc = readFileSync(join(srcDir, "nudges", "goal-epoch.ts"), "utf8");
	ok(
		"R27-B goal-epoch.ts has NO pi.sendMessage call sites",
		!/pi\.sendMessage/.test(goalEpochSrc),
		(goalEpochSrc.match(/pi\.sendMessage/g) || []).length,
	);
	ok("R27-B goal-epoch.ts has no empty catch blocks", !/catch\s*\{\s*\}/.test(goalEpochSrc));
	ok("R27-B classifyPoolAgent is exported from goal-epoch.ts", /export\s+(async\s+)?function\s+classifyPoolAgent/.test(goalEpochSrc));
	ok("R27-B probeAgentPaneLiveness is exported from goal-epoch.ts", /export\s+(async\s+)?function\s+probeAgentPaneLiveness/.test(goalEpochSrc));

	const pumpPhasesSrc = readFileSync(join(srcDir, "surface", "pump-phases.ts"), "utf8");
	ok(
		"R27-B pump-phases.ts still statically imports evaluateIdleGoalNudgeLocked",
		/import\s*\{[^}]*evaluateIdleGoalNudgeLocked[^}]*\}\s*from\s*"\.\.\/nudges\/goal-epoch\.ts"/.test(pumpPhasesSrc),
	);
	const reconcileSrc = readFileSync(join(srcDir, "reconcile.ts"), "utf8");
	ok("R27-B reconcile barrel still re-exports evaluateIdleGoalNudgeLocked", /evaluateIdleGoalNudgeLocked/.test(reconcileSrc));

	// Executable pump probe: the evaluator runs through the real pump path without ReferenceError
	// (r27b pattern — a real pumpRootMailbox tick on a seeded dead-pane world reaches the new code).
	const { pumpRootMailbox } = await import(join(srcDir, "reconcile.ts"));
	const { claimRootLeader } = await import(join(srcDir, "identity.ts"));
	freshScratch("r27b-exec");
	const now = Date.now();
	const worker = makeWorker("worker-pump", { runtimeStatus: "busy", heartbeatAgeMs: 60_000, tmuxAlive: true });
	const p = await seed([worker]);
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		claimRootLeader(st, Date.now(), process.pid);
		await writeState(p, st);
	});
	const { pi: pumpPi } = makePi({ tmuxAlive: new Map([["goal-deadpane-probe:worker-pump.0", false]]) });
	const pumpCtx = { cwd: scratch, mode: "tui", isIdle: () => true, hasUI: false, ui: { setStatus: () => {} }, model: { id: "mock", provider: "mock-llm" } };
	await pumpRootMailbox(pumpPi, pumpCtx, p, "deadpane-guard");
	await new Promise((res) => setTimeout(res, 150));
	const pumpEvents = readEvents();
	ok(
		"R27-B real pump tick: escalation fired through the pump path, no goal.nudge.error",
		pumpEvents.some((e) => e.event === "goal.escalation.pool_empty") && !pumpEvents.some((e) => e.event === "goal.nudge.error"),
		pumpEvents.map((e) => e.event).join(","),
	);
}

// --- restore env ---
if (PREV_TERMINAL_MANAGER === undefined) delete process.env.PI_SWARM_TERMINAL_MANAGER;
else process.env.PI_SWARM_TERMINAL_MANAGER = PREV_TERMINAL_MANAGER;
if (PREV_AGENT_ID === undefined) delete process.env.PI_SWARM_AGENT_ID;
else process.env.PI_SWARM_AGENT_ID = PREV_AGENT_ID;
if (PREV_IS_ROOT === undefined) delete process.env.PI_SWARM_IS_ROOT;
else process.env.PI_SWARM_IS_ROOT = PREV_IS_ROOT;
if (scratch) rmSync(scratch, { recursive: true, force: true });

console.log(`\nGOAL-ESCALATION-DEADPANE-CLASSIFY ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
