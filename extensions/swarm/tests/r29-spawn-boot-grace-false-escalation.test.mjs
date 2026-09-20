#!/usr/bin/env node
/**
 * R29 REPRODUCE-FIRST — false "worker pool empty" escalation during agent boot window.
 *
 * Source incident (observed 2026-09-20 11:03:40):
 *   Live trace pane %141, swarm goal goal-1789834877637-e13fd0.
 *   Two workers (plan-hub-redteam, plan-core-redteam) were spawned ~11:00–11:01.
 *   At 11:03:40 the pump fired an "Goal escalation: worker pool empty" nudge to root.
 *   When root checked (11:05:45) both workers were running/busy/healthy with 2-3s heartbeat.
 *   Root diagnosed: "escalation was a false alarm from the pump — pool diag was stale listing,
 *   workers hadn't registered their first heartbeat yet when pump snapshot was taken."
 *
 * Root cause:
 *   `agentIsEffectivelyAlive` (goal-epoch.ts:100) passes three liveness gates:
 *     (a) status === "running"
 *     (b) tmuxAlive !== false
 *     (c) runtimeStatus !== "stopped"
 *     (d) lastHeartbeatAt is fresh (within AGENT_HEARTBEAT_STALE_MS = 10m)
 *         OR tmuxAlive === true AND runtimeStatus ∈ {idle, tool_running}
 *   A freshly spawned agent that has NEVER sent a heartbeat yet has:
 *     status="running", tmuxAlive=null (unknown — pane hasn't been probed), runtimeStatus="idle",
 *     lastHeartbeatAt=undefined.
 *   ⇒ gate (d): hb = NaN → hbFresh = false.
 *   ⇒ gate (d) fallback: tmuxAlive === null (NOT === true) → false.
 *   ⇒ agentIsEffectivelyAlive returns FALSE.
 *   ⇒ newly-spawned agent is invisible to the pool diag → vacuous branch → escalation fires.
 *
 * The fix: `agentIsEffectivelyAlive` must grant a spawn-boot grace window based on
 * `createdAt`. An agent that was created within AGENT_SPAWN_BOOT_GRACE_MS (default: 2×
 * AGENT_HEARTBEAT_STALE_MS = 20 min, tunable via PI_SWARM_AGENT_SPAWN_BOOT_GRACE_MS) and
 * has never sent a heartbeat (lastHeartbeatAt undefined/null) is treated as ALIVE — it is
 * booting. After the grace window expires with still no heartbeat, it is treated as dead
 * (stale-on-arrival).
 *
 * Invariants under test (reproduce-first — all RED before fix, GREEN after):
 *
 *   R29-S1 [RED pre-fix]: a freshly-spawned worker (createdAt=now, no heartbeat, tmuxAlive=null,
 *     status=running, runtimeStatus=idle) is NOT counted by agentIsEffectivelyAlive.
 *     idleAgentsCount === 0 (vacuous=true → escalation fires) — WRONG.
 *     Expected GREEN: idleAgentsCount === 1 (worker in boot grace → vacuous=false → no escalation).
 *
 *   R29-S2 [RED pre-fix]: evaluateIdleGoalNudgeLocked with a just-spawned worker
 *     (no heartbeat, tmuxAlive=null) + active user-origin goal fires escalation.
 *     escalationCount === 1 (WRONG — worker IS running, just booting).
 *     Expected GREEN: escalationCount === 0 (boot-grace suppresses escalation).
 *
 *   R29-S3 [GREEN both pre and post]: a worker that has been "running" for > BOOT_GRACE_MS
 *     with no heartbeat and tmuxAlive=null IS correctly counted as dead by agentIsEffectivelyAlive
 *     (boot grace expired → stale-on-arrival → vacuous → escalation correct).
 *     escalationCount === 1 — should stay GREEN to confirm no regression.
 *
 *   R29-S4 [GREEN post-fix]: once a booting worker sends its first heartbeat,
 *     agentIsEffectivelyAlive returns true (normal heartbeat-fresh path, not boot grace).
 *     idleAgentsCount === 1 after heartbeat stamp.
 *
 *   R29-S5 [GREEN post-fix]: boot-grace does not silence a genuinely dead worker
 *     (status="running" but runtimeStatus="stopped") — stopped gate still rejects first.
 *
 * R10-1 boundary counters at real boundaries (not internal helpers):
 *   - escalationCount: counts deliverMessageLocked calls with subject matching "pool empty"
 *   - idleAgentsCount: counts entries returned by allEffectiveIdleAgents (via direct import)
 *
 * Isolation: scratch tmpdir, no network, no real tmux.
 * Run: node extensions/swarm/tests/r29-spawn-boot-grace-false-escalation.test.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

// === Compress all timing knobs for the test ===
// Boot grace: set to 120_000ms (2min) so we can test expired vs. within grace
// by manipulating nowMs relative to createdAt.
process.env.PI_SWARM_AGENT_SPAWN_BOOT_GRACE_MS ||= "120000"; // 2 min for test
process.env.PI_SWARM_GOAL_IDLE_CHECK_INTERVAL_MS = "500";
process.env.PI_SWARM_GOAL_IDLE_CHECKS_REQUIRED = "3";
process.env.PI_SWARM_AGENT_HEARTBEAT_STALE_MS = "600000"; // 10min

const { agentIsEffectivelyAlive, allEffectiveIdleAgents, evaluateIdleGoalNudgeLocked } = await import(
	join(srcDir, "nudges", "goal-epoch.ts")
);
const { paths, withLock, readState, writeState, ensureDirs } = await import(join(srcDir, "state.ts"));
const { ensureRoot, heartbeatRootLeader } = await import(join(srcDir, "identity.ts"));
const { deliverMessageLocked } = await import(join(srcDir, "mailbox.ts"));

// ============================================================================
// Harness
// ============================================================================

let pass = 0, fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info ?? "");
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
	const d = mkdtempSync(join(tmpdir(), `swarm-r29-${label}-`));
	mkdirSync(join(d, ".pi"), { recursive: true });
	writeFileSync(
		join(d, ".pi", "settings.json"),
		JSON.stringify({ swarm: { defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" } }),
	);
	return d;
}

function readEvents(scratchDir) {
	const ep = join(scratchDir, ".pi/swarm/traces/events.jsonl");
	if (!existsSync(ep)) return [];
	return readFileSync(ep, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => { try { return JSON.parse(l); } catch { return null; } })
		.filter(Boolean);
}

// Mock pi (no real LLM / tmux)
const deliverCalls = [];
const mockPi = {
	registerTool: () => {},
	registerCommand: () => {},
	on: () => {},
	setModel: async () => true,
	sendMessage: () => {},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};

// Intercept deliverMessageLocked to count escalations
// We do this by checking the events file for goal.escalation.pool_empty traces.

// ============================================================================
// Agent fixture builder
// ============================================================================

/**
 * Build a SwarmAgent-shaped object for the given scenario.
 *  shape:
 *    "booting"        — just spawned, no heartbeat, tmuxAlive=null (PRE-FIX: dead; POST-FIX: alive)
 *    "booting-alive"  — just spawned, no heartbeat, tmuxAlive=true  (already alive pre-fix)
 *    "healthy"        — running with fresh heartbeat
 *    "stopped"        — runtimeStatus=stopped (always dead)
 *    "stale-arrived"  — created > BOOT_GRACE ago, still no heartbeat (always dead after fix)
 */
function makeAgent(id, shape, nowMs) {
	const BOOT_GRACE_MS = Number(process.env.PI_SWARM_AGENT_SPAWN_BOOT_GRACE_MS || 120000);
	const base = {
		id,
		role: "worker",
		roleKind: "worker",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		health: "healthy",
		tmuxSession: `sess-${id}`,
		tmuxWindow: "0",
		tmuxTarget: `sess-${id}:0`,
		model: "glm-5.1",
		provider: "zai-coding-cn",
		cwd: "/tmp",
		mailbox: `.pi/swarm/mailboxes/${id}.jsonl`,
		updatedAt: new Date(nowMs).toISOString(),
	};

	switch (shape) {
		case "booting":
			return {
				...base,
				status: "running",
				runtimeStatus: "idle",
				tmuxAlive: null, // unknown — pane not yet probed
				lastHeartbeatAt: undefined, // NO heartbeat yet
				createdAt: new Date(nowMs - 60_000).toISOString(), // spawned 1 minute ago (within grace)
			};
		case "booting-alive":
			return {
				...base,
				status: "running",
				runtimeStatus: "idle",
				tmuxAlive: true, // pane confirmed alive
				lastHeartbeatAt: undefined, // still no heartbeat (just booted)
				createdAt: new Date(nowMs - 60_000).toISOString(),
			};
		case "healthy":
			return {
				...base,
				status: "running",
				runtimeStatus: "idle",
				tmuxAlive: true,
				lastHeartbeatAt: new Date(nowMs - 5_000).toISOString(), // 5s ago
				createdAt: new Date(nowMs - 300_000).toISOString(),
			};
		case "stopped":
			return {
				...base,
				status: "running",
				runtimeStatus: "stopped",
				tmuxAlive: null,
				lastHeartbeatAt: undefined,
				createdAt: new Date(nowMs - 60_000).toISOString(), // within grace but stopped
			};
		case "stale-arrived":
			return {
				...base,
				status: "running",
				runtimeStatus: "idle",
				tmuxAlive: null,
				lastHeartbeatAt: undefined, // STILL no heartbeat
				createdAt: new Date(nowMs - BOOT_GRACE_MS - 60_000).toISOString(), // grace expired
			};
		default:
			throw new Error(`Unknown shape: ${shape}`);
	}
}

// ============================================================================
// S1: agentIsEffectivelyAlive — booting worker (no heartbeat, tmuxAlive=null)
// PRE-FIX: returns false  ← RED (wrong — worker IS running, just booting)
// POST-FIX: returns true  ← GREEN (boot-grace window applies)
// ============================================================================
console.log("\n--- S1: agentIsEffectivelyAlive with booting worker (no heartbeat, tmuxAlive=null) ---");
{
	const nowMs = Date.now();
	const agent = makeAgent("plan-hub-redteam", "booting", nowMs);
	const alive = agentIsEffectivelyAlive(agent, nowMs);

	ok(
		"R29-S1 booting worker (tmuxAlive=null, no hb, within boot grace) → agentIsEffectivelyAlive returns TRUE",
		alive === true,
		`alive=${alive} (expected true; returned false because boot grace is missing)`,
	);
}

// ============================================================================
// S2: evaluateIdleGoalNudgeLocked fires false escalation when 2 booting workers
// are present but invisible to the pool liveness filter.
// PRE-FIX: escalationCount === 1  ← RED (escalation should NOT fire — workers ARE running)
// POST-FIX: escalationCount === 0  ← GREEN
// ============================================================================
console.log("\n--- S2: evaluateIdleGoalNudgeLocked fires escalation with 2 booting workers ---");
{
	const scratch = freshScratch("s2");
	process.chdir(scratch);
	const p = paths(scratch);
	await ensureDirs(p);

	await withLock(p, async () => {
		let st = await readState(p, scratch);
		ensureRoot(st, scratch, p);

		const nowMs = Date.now();
		// Goal set 5 minutes ago (well past GOAL_INITIAL_SET_GRACE_MS=0)
		const goalSetAt = new Date(nowMs - 5 * 60_000).toISOString();
		st.goal = {
			id: "goal-r29-repro",
			text: "Red-team corrective architecture plan v1.1",
			setAt: goalSetAt,
			origin: "user",
			consecutiveNoResolveNudges: 0,
			nudgeSeq: 0,
		};

		// Two booting workers — freshly spawned, no heartbeat yet, tmuxAlive=null
		st.agents["plan-hub-redteam"] = makeAgent("plan-hub-redteam", "booting", nowMs);
		st.agents["plan-core-redteam"] = makeAgent("plan-core-redteam", "booting", nowMs);

		// Advance idle epoch to "all idle" so debounce passes:
		// Set allIdleSinceAt to far in the past and build up the check streak
		st.idleNudgeState = {
			allIdleSinceAt: new Date(nowMs - 60_000).toISOString(),
			goalIdleCheckCount: 3, // already satisfied check streak
			goalIdleLastCheckAt: new Date(nowMs - 600).toISOString(),
		};

		await writeState(p, st);

		// Run evaluator
		await evaluateIdleGoalNudgeLocked(mockPi, scratch, p, st, nowMs, false);
		await writeState(p, st);
	});

	const events = readEvents(scratch);
	const escalationEvents = events.filter((e) => e.event === "goal.escalation.pool_empty");
	const escalationCount = escalationEvents.length;

	ok(
		"R29-S2 evaluateIdleGoalNudgeLocked does NOT fire escalation when booting workers are present",
		escalationCount === 0,
		`escalationCount=${escalationCount} (expected 0; got 1 because booting workers were treated as dead)`,
	);

	// Also check vacuous branch was taken (direct symptom)
	const heldEvents = events.filter((e) => e.event === "goal.nudge.held_no_live_workers");
	ok(
		"R29-S2b goal.nudge.held_no_live_workers is NOT traced when booting workers are present",
		heldEvents.length === 0,
		`heldEvents=${heldEvents.length} (expected 0; got ${heldEvents.length} because pool was treated as vacuous)`,
	);
}

// ============================================================================
// S3: boot grace expired — worker SHOULD be treated as dead (no regression)
// PRE and POST-FIX: escalation fires (grace window expired, legitimately dead)
// This must remain GREEN after fix to prove grace doesn't overstay.
// ============================================================================
console.log("\n--- S3: grace-expired worker (no hb, createdAt > BOOT_GRACE ago) → escalation correct ---");
{
	const nowMs = Date.now();
	const agent = makeAgent("stale-worker", "stale-arrived", nowMs);
	const alive = agentIsEffectivelyAlive(agent, nowMs);

	ok(
		"R29-S3 [GREEN both] grace-expired worker with no heartbeat → agentIsEffectivelyAlive returns FALSE (correct)",
		alive === false,
		`alive=${alive}`,
	);
}

// ============================================================================
// S4: after first heartbeat, worker transitions from boot-grace to normal path
// POST-FIX: agentIsEffectivelyAlive returns true via heartbeat-fresh path
// ============================================================================
console.log("\n--- S4: after first heartbeat, booting worker becomes normally alive ---");
{
	const nowMs = Date.now();
	const agent = makeAgent("plan-hub-redteam", "booting", nowMs);
	// Simulate first heartbeat arriving
	agent.lastHeartbeatAt = new Date(nowMs - 3_000).toISOString(); // 3s ago

	const alive = agentIsEffectivelyAlive(agent, nowMs);
	// Should be true via the normal hbFresh path (heartbeat 3s ago < 10min stale threshold)
	ok(
		"R29-S4 [GREEN post-fix] booting worker after first heartbeat → agentIsEffectivelyAlive returns TRUE",
		alive === true,
		`alive=${alive}`,
	);
}

// ============================================================================
// S5: stopped worker in boot-grace window is still correctly rejected
// The stopped gate (runtimeStatus==="stopped") runs BEFORE boot-grace check.
// POST-FIX: remains false (stopped is always dead regardless of grace)
// ============================================================================
console.log("\n--- S5: stopped worker in boot grace → still dead (stopped gate runs first) ---");
{
	const nowMs = Date.now();
	const agent = makeAgent("stopped-worker", "stopped", nowMs);
	const alive = agentIsEffectivelyAlive(agent, nowMs);

	ok(
		"R29-S5 [GREEN both] stopped worker in boot-grace window → agentIsEffectivelyAlive returns FALSE",
		alive === false,
		`alive=${alive}`,
	);
}

// ============================================================================
// S6: allEffectiveIdleAgents with mixed (booting + healthy) pool
// PRE-FIX: idleAgents=[healthy] (booting invisible) → len=1, not vacuous... wait
//          Actually: 1 healthy agent → NOT vacuous → idleAgents.length=1 → allIdle=true
//          vs. scenario where ONLY booting workers exist → vacuous
// This sub-scenario: only booting workers → vacuous (S2 already covers); let's test:
//   one booting + one healthy → pre-fix: idleAgents=[healthy], len=1, not vacuous
//   This case doesn't trigger the bug, but let's confirm the fix doesn't break it.
// ============================================================================
console.log("\n--- S6: mixed pool (1 booting + 1 healthy) → healthy still visible both pre/post ---");
{
	const nowMs = Date.now();
	const fakeState = {
		agents: {
			root: { id: "root", status: "running", runtimeStatus: "idle", health: "healthy" },
			"booting-worker": makeAgent("booting-worker", "booting", nowMs),
			"healthy-worker": makeAgent("healthy-worker", "healthy", nowMs),
		},
		idleNudgeState: {},
	};

	const result = allEffectiveIdleAgents(fakeState, nowMs);
	// Pre-fix: idleAgents might be [healthy-worker] only (len=1, vacuous=false)
	// Post-fix: idleAgents=[booting-worker, healthy-worker] (len=2, vacuous=false)
	// Either way NOT vacuous — mixed pool should never trigger the false escalation
	ok(
		"R29-S6 [GREEN both] mixed pool is not vacuous (healthy worker always visible)",
		result.vacuous === false,
		`vacuous=${result.vacuous}, idleAgents=${result.idleAgents.map((a) => a.id)}`,
	);
	// Pre-fix: len=1 (booting invisible). Post-fix: len=2.
	// Both are acceptable (not vacuous). Log for informational diff.
	console.log(
		`     idleAgents count: ${result.idleAgents.length} (pre-fix=1, post-fix=2)`,
		result.idleAgents.map((a) => a.id),
	);
}

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${"=".repeat(60)}`);
console.log(`R29 REPRODUCE: ${pass} passed, ${fail} failed`);
console.log("=".repeat(60));
console.log();
if (fail === 0) {
	console.log("✓ All assertions passed — fix verified.");
} else {
	const redCount = fail;
	console.log(
		`✓  ${redCount} RED assertion(s) observed — reproduce confirmed.\n` +
		"   S1 and S2 should be RED (wrong behavior proven).\n" +
		"   S3, S5 should be GREEN (no regression in dead-worker detection).\n" +
		"   S4, S6 may be GREEN or need post-fix re-run.",
	);
}
process.exit(fail === 0 ? 0 : 1);
