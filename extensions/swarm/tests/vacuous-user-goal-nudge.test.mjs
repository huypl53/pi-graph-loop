#!/usr/bin/env node
/**
 * task: vacuous-user-goal-nudge (2026-10-29) — solo-goal nudge on an empty pool.
 *
 * LIVE INCIDENT (verified from live state + traces, 2026-10-29, vtht-agents swarm):
 *   - Session 01a1868d-15d1-773d-8b2c-7e2dcfa08546 (root of the vtht-agents swarm) set
 *     goal-1793276867238-b84edb at 2026-10-29T12:27:47Z, origin=user, nudgeIntervalMs=10000.
 *     The goal text: "Tiếp tục thử và tối ưu skill knowledge-graph bằng runner local không
 *     DB... Không spawn swarm agents." — an explicit SOLO goal: the root itself is the
 *     executor, spawning workers is out of scope BY THE GOAL'S OWN TEXT.
 *   - At that moment all 16 workers were `stopped` (pool = root only; verified in
 *     swarm-state.json: 17 agents, 16 runtimeStatus=stopped, last activity 10-28/10-29 AM).
 *   - Expected per the goal-floor intent (user direction, R27 quote): "cách 10s lại check,
 *     check 3 lần, sau 3 lần mà thấy trạng thái vẫn là ko có swarm agents nào làm việc thì
 *     mới nudge" — zero workers + root idle IS "no swarm agent is working", so the root must
 *     be nudged to continue its goal.
 *   - ACTUAL (the bug): `allEffectiveIdleAgents` returned vacuous=true → the vacuous branch
 *     held the goal nudge forever (`goal.nudge.held_no_live_workers` ×1 at 12:27:49, then
 *     ZERO goal.idle_nudge for the goal's lifetime) and only emitted the worker-pool-empty
 *     escalation (~1/hour visible after idempotency+cooldown) whose hints tell the root to
 *     SPAWN WORKERS — the exact action the goal forbids. The user had to manually type
 *     "tiếp đi" into the session at 21:03 to keep the goal moving.
 *
 * REPRODUCTION-FIRST (mandate 2026-08-31): S1 below is the red artifact — seeded with the
 * exact live shape (user-origin goal + genuinely-vacuous pool + fresh transition), driven
 * through the REAL evaluator 3 full check-streak rounds. Expected WRONG behavior observed
 * pre-fix: emitted=false with reason no_live_workers on the streak-completing tick and zero
 * goal.idle_nudge traces. GREEN post-fix: streak-completing tick emits the standard
 * goal.idle_nudge (subject "Idle streak: goal ... has no active work"), reason "emitted".
 *
 * Invariants under test:
 *   S1 (RED pre-fix → GREEN post-fix): user-origin goal + zero effective agents, root NOT
 *       busy → 3rd spaced check emits goal.idle_nudge (emitted=true, reason "emitted");
 *       nudge body/subject ride the standard NOTIFY_KEY_GOAL_IDLE_NUDGE family; the
 *       pool-empty escalation ALSO still fires (cooldown-bounded complement, unchanged
 *       R14 Fix C semantics — the nudge says "continue", the escalation says "pool empty").
 *   S2: same shape but root BUSY → no emission, reason root_busy (a root actively working
 *       its solo goal must not be nudged). The pool-empty escalation keeps its pre-existing
 *       cadence (out of scope for this fix — minimal change).
 *   S3 (anti-storm): after the cap is reached without resolves, further streak-completing
 *       ticks hold with reason max_nudges (the standard cap+backoff applies — the solo-goal
 *       nudge inherits the SAME bounded cadence as the worker-pool nudge, no new storm
 *       surface).
 *   S4 (worker-pool shape unchanged): with a live idle worker present (non-vacuous), the
 *       pre-existing behavior holds — emission path unchanged (this is the R27 suite's
 *       territory; here only a sanity probe that vacuous-vs-non-vacuous dispatch still
 *       routes non-vacuous pools to the standard path).
 *
 * R10-1 boundary counters (counting at real boundaries):
 *   C-V1: goal.idle_nudge trace counted at the real trace() events.jsonl boundary.
 *   C-V2: nudge message append counted at the real deliverMessageLocked boundary
 *         (root mailbox JSONL) with idempotencyKey family NOTIFY_KEY_GOAL_IDLE_NUDGE.
 *   C-V3: ZERO pi.sendMessage calls from the evaluator (L1 append only — mock pi counts).
 *   C-V4: escalation append counted at the same real mailbox boundary (S1, exactly 1).
 *
 * ISOLATION CONTRACT — SCRATCH CWD ONLY (mkdtemp under os.tmpdir(); no repo writes).
 * Run: PI_SWARM_AGENT_ID=root PI_SWARM_IS_ROOT=1 node extensions/swarm/tests/vacuous-user-goal-nudge.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

const { paths, withLock, readState, writeState, ensureDirs } = await import(join(srcDir, "state.ts"));
const { ensureRoot } = await import(join(srcDir, "identity.ts"));
const { evaluateIdleGoalNudgeLocked } = await import(join(srcDir, "nudges", "goal-epoch.ts"));

// Compress the debounce for the unit lane (production: 10s x 3).
process.env.PI_SWARM_GOAL_IDLE_CHECK_INTERVAL_MS ||= "1000";
process.env.PI_SWARM_GOAL_IDLE_CHECKS_REQUIRED ||= "3";

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL:", name, info !== undefined ? `(${JSON.stringify(info).slice(0, 300)})` : "");
	}
};

const ORIG_AGENT_ID = process.env.PI_SWARM_AGENT_ID;
const ORIG_IS_ROOT = process.env.PI_SWARM_IS_ROOT;
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
process.on("exit", () => {
	if (ORIG_AGENT_ID === undefined) delete process.env.PI_SWARM_AGENT_ID;
	else process.env.PI_SWARM_AGENT_ID = ORIG_AGENT_ID;
	if (ORIG_IS_ROOT === undefined) delete process.env.PI_SWARM_IS_ROOT;
	else process.env.PI_SWARM_IS_ROOT = ORIG_IS_ROOT;
});

function freshScratch(label) {
	return mkdtempSync(join(tmpdir(), `swarm-vacuous-user-goal-${label}-${process.pid}-${Date.now()}-`));
}

function readEvents(scratch) {
	const p = join(scratch, ".pi/swarm/traces/events.jsonl");
	if (!existsSync(p)) return [];
	const txt = readFileSync(p, "utf8").trim();
	if (!txt) return [];
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

function readRootMailbox(scratch) {
	const p = join(scratch, ".pi/swarm/mailboxes/root.jsonl");
	if (!existsSync(p)) return [];
	const txt = readFileSync(p, "utf8").trim();
	if (!txt) return [];
	return txt
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

function makePiMock() {
	const sendMessageCalls = [];
	const pi = {
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true,
		sendMessage: (m, opts) => {
			sendMessageCalls.push({ m, opts });
		},
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
		registerTool: () => {},
		registerCommand: () => {},
		on: () => {},
	};
	return { pi, sendMessageCalls };
}

/**
 * Seed the exact live shape: root-only swarm (all workers stopped long ago → genuinely
 * vacuous), user-origin goal set 15min ago (past grace), fresh transition flag.
 */
async function seedSoloGoalShape({ scratch }) {
	const p = paths(scratch);
	await ensureDirs(p);
	const nowMs = Date.now();
	const ago = (ms) => new Date(nowMs - ms).toISOString();
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		ensureRoot(st, scratch, p);
		// The live shape: workers stopped >10min ago → zero effective agents.
		const worker = {
			id: "worker-stopped",
			role: "implementer",
			roleKind: "implementer",
			capabilities: [],
			activeTaskIds: [],
			maxConcurrentTasks: 1,
			status: "stopped",
			runtimeStatus: "stopped",
			health: "healthy",
			tmuxAlive: false,
			tmuxSession: "lane",
			tmuxWindow: "worker",
			tmuxTarget: "lane:worker.0",
			model: "glm-5.1",
			provider: "zai-coding-cn",
			cwd: scratch,
			mailbox: ".pi/swarm/mailboxes/worker-stopped.jsonl",
			createdAt: ago(60 * 60_000),
			updatedAt: ago(30 * 60_000),
			lastShutdownAt: ago(30 * 60_000),
			lastHeartbeatAt: ago(30 * 60_000),
		};
		st.agents["worker-stopped"] = worker;
		// User-origin solo goal (the live goal's origin + scope), set 15min ago.
		st.goal = {
			id: "goal-solo-lane",
			text: "Tiếp tục tối ưu skill knowledge-graph. Không spawn swarm agents.",
			origin: "user",
			setBy: "root",
			setByScope: "user-request",
			setAt: ago(15 * 60_000),
			consecutiveNoResolveNudges: 0,
			nudgeSeq: 0,
			nudgeIntervalMs: 10000,
		};
		await writeState(p, st);
	});
	return { p };
}

async function tick({ p, scratch, pi, nowMs, rootBusy = false }) {
	let result;
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		result = await evaluateIdleGoalNudgeLocked(pi, scratch, p, st, nowMs, rootBusy);
		await writeState(p, st);
	});
	return result;
}

// ============================================================================
// S1 (THE REPRODUCTION): user-origin solo goal + vacuous pool + root idle → nudge
// ============================================================================
console.log("\n[S1] user-origin goal + zero effective agents + root idle → goal.idle_nudge on 3rd check");
{
	const scratch = freshScratch("s1");
	const { p } = await seedSoloGoalShape({ scratch });
	const { pi, sendMessageCalls } = makePiMock();
	const startMs = Date.now();

	// 3 full check-streak rounds (each = 3 samples spaced >= checkIntervalMs), root idle.
	const reasons = [];
	for (let i = 1; i <= 9; i++) {
		const r = await tick({ p, scratch, pi, nowMs: startMs + i * 1000, rootBusy: false });
		reasons.push(`${i}:${r.reason}`);
	}
	const last = reasons[reasons.length - 1].split(":")[1];

	const events = readEvents(scratch);
	const idleNudges = events.filter((e) => e.event === "goal.idle_nudge");
	const escalations = events.filter((e) => e.event === "goal.escalation.pool_empty");
	const mailbox = readRootMailbox(scratch);
	const nudgeMsgs = mailbox.filter((m) => /Idle streak: goal/.test(String(m.subject)));
	const escMsgs = mailbox.filter((m) => /Goal escalation: worker pool empty/.test(String(m.subject)));

	// C-V1: trace boundary
	ok("S1 [GREEN post-fix] goal.idle_nudge trace fired (>=1; streak-completing tick emits)", idleNudges.length >= 1, {
		idleNudges: idleNudges.length,
		tickReasons: reasons.join(","),
	});
	// C-V2: deliverMessageLocked mailbox boundary + key family
	ok(
		"S1 [GREEN post-fix] standard idle-streak nudge appended to root mailbox (NOTIFY_KEY_GOAL_IDLE_NUDGE family)",
		nudgeMsgs.length >= 1 && /^goal:goal-solo-lane:nudge:idle-streak:1$/.test(String(nudgeMsgs[0].idempotencyKey || "")),
		{ nudgeMsgs: nudgeMsgs.length, key: nudgeMsgs[0]?.idempotencyKey },
	);
	// C-V4: escalation complement still fires exactly once (cooldown-bounded)
	ok(
		"S1 [GREEN post-fix] pool-empty escalation still fires exactly once (R14 Fix C complement, first vacuous tick)",
		escalations.length === 1 && escMsgs.length === 1,
		{ escalations: escalations.length, escMsgs: escMsgs.length },
	);
	// C-V3: zero pi.sendMessage from the evaluator (L1 only)
	ok("S1 [boundary] ZERO pi.sendMessage calls from the evaluator (L1 append only)", sendMessageCalls.length === 0, {
		calls: sendMessageCalls.length,
	});
	// Anti-spam: 3 streak rounds → exactly 3 nudges (= default cap), the SAME bounded
	// cadence as the worker-pool floor (no per-tick storm, no unbounded re-emission).
	ok("S1 [anti-storm] nudge count bounded by streak rounds (===3 over 9 ticks, cap reached)", idleNudges.length === 3, {
		idleNudges: idleNudges.length,
	});
	rmSync(scratch, { recursive: true, force: true });
}

// ============================================================================
// S2: root busy on a solo goal → hold (no nudge, no escalation)
// ============================================================================
console.log("\n[S2] user-origin goal + vacuous pool + root BUSY → hold with reason root_busy, no escalation");
{
	const scratch = freshScratch("s2");
	const { p } = await seedSoloGoalShape({ scratch });
	const { pi } = makePiMock();
	const startMs = Date.now();

	const reasons = [];
	for (let i = 1; i <= 4; i++) {
		const r = await tick({ p, scratch, pi, nowMs: startMs + i * 1000, rootBusy: true });
		reasons.push(r.reason);
	}
	const events = readEvents(scratch);
	const escalations = events.filter((e) => e.event === "goal.escalation.pool_empty");
	const idleNudges = events.filter((e) => e.event === "goal.idle_nudge");
	const mailbox = readRootMailbox(scratch);
	const escMsgs = mailbox.filter((m) => /Goal escalation: worker pool empty/.test(String(m.subject)));

	ok(
		"S2 [GREEN post-fix] busy-root ticks all hold with reason root_busy (solo executor at work)",
		reasons.every((x) => x === "root_busy"),
		{ reasons },
	);
	// NOTE: the pool-empty escalation is intentionally UNCHANGED by this task (minimal
	// scope — it keeps its pre-existing cadence regardless of rootBusy). S2 pins only the
	// NUDGE hold.
	ok("S2 no idle nudge while root busy", idleNudges.length === 0, { idleNudges: idleNudges.length });
	rmSync(scratch, { recursive: true, force: true });
}

// ============================================================================
// S3: cap + backoff inherited (anti-storm) — solo nudge saturates like the worker-pool nudge
// ============================================================================
console.log("\n[S3] cap honored: consecutiveNoResolveNudges at max → max_nudges, no unbounded re-emission");
{
	const scratch = freshScratch("s3");
	const { p } = await seedSoloGoalShape({ scratch });
	const { pi } = makePiMock();
	const startMs = Date.now();

	// Drive to cap (default MAX_CONSECUTIVE_NUDGES_DEFAULT = 3): 3 streak rounds emit 3 nudges.
	for (let i = 1; i <= 9; i++) {
		await tick({ p, scratch, pi, nowMs: startMs + i * 1000, rootBusy: false });
	}
	const events = readEvents(scratch);
	const idleNudges = events.filter((e) => e.event === "goal.idle_nudge");
	ok("S3 three streak rounds reach the cap (3 nudges, default max=3)", idleNudges.length === 3, { idleNudges: idleNudges.length });

	// Past the cap: a fresh streak must complete (3 checks) before backoff is consumed;
	// the 4th nudge must NEVER arrive without a resolve. Ticks at +10s..+12s complete one
	// check-round → backoff.skip consumes a slot → still exactly 3 nudges.
	for (let i = 10; i <= 12; i++) {
		await tick({ p, scratch, pi, nowMs: startMs + i * 1000, rootBusy: false });
	}
	const r = await tick({ p, scratch, pi, nowMs: startMs + 13_000, rootBusy: false });
	const nudgesAfter = readEvents(scratch).filter((e) => e.event === "goal.idle_nudge").length;
	ok(
		"S3 [GREEN post-fix] post-cap check-round holds with backoff (no 4th emission without resolve)",
		nudgesAfter === 3 && ["backoff", "max_nudges", "idle_interval_pending"].includes(r.reason),
		{ reason: r.reason, nudgesAfter },
	);
	rmSync(scratch, { recursive: true, force: true });
}

// ============================================================================
// S4: non-vacuous pool dispatch sanity — live idle worker routes to the standard path
// ============================================================================
console.log("\n[S4] live idle worker (non-vacuous) → standard emission path unchanged (sanity)");
{
	const scratch = freshScratch("s4");
	const { p } = await seedSoloGoalShape({ scratch });
	// Flip the worker to alive+idle (tmuxAlive=true, fresh heartbeat).
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		const w = st.agents["worker-stopped"];
		w.status = "running";
		w.runtimeStatus = "idle";
		w.tmuxAlive = true;
		w.lastHeartbeatAt = new Date(Date.now() - 30_000).toISOString();
		delete w.lastShutdownAt;
		await writeState(p, st);
	});
	const { pi } = makePiMock();
	const startMs = Date.now();
	const reasons = [];
	for (let i = 1; i <= 3; i++) {
		const r = await tick({ p, scratch, pi, nowMs: startMs + i * 1000, rootBusy: false });
		reasons.push(r.reason);
	}
	const idleNudges = readEvents(scratch).filter((e) => e.event === "goal.idle_nudge");
	ok(
		"S4 non-vacuous pool reaches emission on the 3rd check (standard R27 path intact)",
		reasons[2] === "emitted" && idleNudges.length === 1,
		{ reasons, idleNudges: idleNudges.length },
	);
	rmSync(scratch, { recursive: true, force: true });
}

console.log(`\nVACUOUS-USER-GOAL-NUDGE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
