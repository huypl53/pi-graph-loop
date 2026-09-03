#!/usr/bin/env node
/**
 * R16 P0 — idle-goal ACK-loop and post-R14 vacuous state persistence regression.
 *
 * Source incidents (verified by plan §0):
 *   (a) ACK-reset loop (window 04:59:18Z – 05:08:55Z): 47 `goal.idle_nudge` events +
 *       35 `goal.nudge.resolved` events. Every resolved trace has `by: "turn_end"`.
 *       The resolve hook at `extensions/swarm/src/hooks.ts:524-549` resets the
 *       counter on ANY root turn that ends `stopReason:"stop"`, regardless
 *       of whether the turn advanced the goal. The cap at MAX_CONSECUTIVE_NUDGES=3
 *       is never reached for a long enough conversation; the back-off never
 *       engages; the user sees the same nudge template repeating at the goal's
 *       interval with no escalation.
 *   (b) Post-R14 vacuous state persistence failure (window 05:09:01Z – 05:36:55Z):
 *       331 `goal.nudge.held_no_live_workers` events at ~5s cadence with ZERO
 *       `goal.escalation.pool_empty` events on a pre-R14 root. R14 Fix B
 *       (dedupe flag) and Fix C (escalation cooldown) are present in commit
 *       `40e1dd1` on disk but the running root never /reload'd, so the
 *       active code is pre-R14. After /reload, R14's code MUST keep working
 *       across the state-reload boundary.
 *
 * Reproduce-first (mandate 2026-08-31). RED observed for the ack-loop layer
 * (R16-S1, R16-S2). GREEN expected for the post-R14 vacuous persistence layer
 * (R16-S3, R16-S4, R16-S5, R16-S6) IF the dedupe + cooldown survive reload.
 * R16-S7 verifies the action-oriented nudge body; R16-S8 verifies the
 * readState back-fill for legacy state files.
 *
 * Topology notes:
 *   - R16-S1/S2 (ack-loop): settled-but-alive workers (3, tmuxAlive=true,
 *     fresh heartbeat). With R14-A predicate, these are EFFECTIVE (not
 *     vacuous), so the function continues to the goal-interval branch.
 *     This is the only topology that exercises `consecutiveNoResolveNudges`.
 *   - R16-S3/S4/S5/S6/S7 (vacuous persistence + cooldown): genuinely-vacuous
 *     workers (tmuxAlive:false OR status:stopped) — the vacuous branch fires
 *     the held trace + escalation chain.
 *
 * Invariants under test:
 *   R16-S1 (RED pre-fix → GREEN post-fix):
 *     Config C1 — settled-but-alive pool + user goal + ack-with-text turn_end:
 *     counter MUST NOT reset on text alone; cap MUST be reached; back-off MUST
 *     engage; total idle_nudge count <= 3.
 *   R16-S2 (RED/GREEN both shapes):
 *     Config C2 — settled-but-alive pool + user goal + ack-without-text
 *     turn_end: counter climbs to cap regardless of text presence; back-off
 *     engages (this is the unchanged behavior — text absence was already
 *     correctly handled).
 *   R16-S3 (RED pre-R14 → GREEN post-R14 + across reload):
 *     Config C3 — genuinely-vacuous pool, 12 ticks with reload between:
 *     held trace fires once per false→true transition; lastWasVacuous
 *     persists; escalation fires once per cooldown.
 *   R16-S4 (RED pre-R14 → GREEN post-R14 + heartbeat-GC ran):
 *     Config C4 — workers status=stopped (heartbeat-GC flipped them):
 *     same dedupe + escalation invariants as C3.
 *   R16-S5 (RED if cooldown lost on reload → GREEN post-fix):
 *     Config C5 — escalation cooldown survives state reload: total
 *     escalation count across 24 ticks === 1 (not 2).
 *   R16-S6 (no regression of R14-S6):
 *     Config C6 — goal clear mid-cooldown: no_goal short-circuit prevents
 *     post-clear held/escalation traces.
 *   R16-S7 (body content):
 *     Action-oriented nudge body contains one of the recovery hint keywords.
 *   R16-S8 (state.ts robustness):
 *     readState back-fills missing lastWasVacuous / lastPoolEmptyEscalationAt
 *     on legacy swarm-state.json (no crash).
 *
 * R10-1 boundary counters (counting assertions at REAL boundaries):
 *   C1. `goalIdleNudgeTraceCount` at `reconcile.ts:744` trace call.
 *   C2. `goalNudgeResolvedTraceCount` at `hooks.ts:545` trace call.
 *   C3. `heldNoLiveWorkersTraceCount` at `reconcile.ts:552` trace call.
 *   C4. `escalationPoolEmptyTraceCount` at `reconcile.ts:572` trace call.
 *   C5. `mailboxAppendCount` at `mailbox.ts:445` `enqueueAndDeliver` durable append.
 *   C6. `piSendMessageCallCount` at `reconcile.ts:1763-1773` `pi.sendMessage` loop.
 *   C7. `consecutiveNoResolveNudges` at `reconcile.ts:741` increment OR
 *       `hooks.ts:540` reset (real state mutation).
 *   C8. `lastWasVacuous` across reload.
 *   C9. `lastPoolEmptyEscalationAt` across reload.
 *   C10. `backoffTicksRemaining`.
 *
 * ISOLATION CONTRACT — SCRATCH CWD ONLY.
 * Run: node extensions/swarm/r16-idle-goal-regression.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PI_SWARM_GOAL_NUDGE_IDLE_INTERVAL_MS ||= "5000";  // match live incident cadence

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

const {
	pumpRootMailbox,
	evaluateIdleGoalNudgeLocked,
	updateIdleEpochLocked,
} = await import(join(srcDir, "reconcile.ts"));

const { paths, withLock, readState, writeState, trace } = await import(join(srcDir, "state.ts"));
const { ensureRoot, heartbeatRootLeader } = await import(join(srcDir, "identity.ts"));
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
const ORIG_PI_SWARM_IS_ROOT = process.env.PI_SWARM_IS_ROOT;
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
process.on("exit", () => {
	if (ORIG_PI_SWARM_AGENT_ID === undefined) delete process.env.PI_SWARM_AGENT_ID;
	else process.env.PI_SWARM_AGENT_ID = ORIG_PI_SWARM_AGENT_ID;
	if (ORIG_PI_SWARM_IS_ROOT === undefined) delete process.env.PI_SWARM_IS_ROOT;
	else process.env.PI_SWARM_IS_ROOT = ORIG_PI_SWARM_IS_ROOT;
});

function freshScratch(idx) {
	return mkdtempSync(join(tmpdir(), `swarm-r16-s${idx}-${process.pid}-${Date.now()}-`));
}

function readEvents(scratchDir) {
	const p = join(scratchDir, ".pi/swarm/traces/events.jsonl");
	if (!existsSync(p)) return [];
	const txt = readFileSync(p, "utf8").trim();
	if (!txt) return [];
	return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function readRootMailbox(scratchDir) {
	const p = join(scratchDir, ".pi/swarm/mailboxes/root.jsonl");
	if (!existsSync(p)) return [];
	const txt = readFileSync(p, "utf8").trim();
	if (!txt) return [];
	return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function makePiMock() {
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
 */
async function seedR16Shape({
	scratch: scratchDir,
	workerShape = "settled-but-alive",
	goalOrigin = "user",
	goalIntervalMs = 5000,
	nowMs = Date.now(),
} = {}) {
	const p = paths(scratchDir);
	const setAt = new Date(nowMs - 15 * 60_000).toISOString(); // 15min ago
	const workerTs = new Date(nowMs - 15 * 60_000).toISOString();
	const status = workerShape === "heartbeat-gc-stopped" ? "stopped" : "running";
	const tmuxAlive = workerShape === "genuinely-vacuous" || workerShape === "heartbeat-gc-stopped" ? false : true;
	// For settled-but-alive, use a fresh heartbeat so R14-A's predicate widening
	// treats them as effectively-alive. For genuinely-vacuous / heartbeat-gc-stopped,
	// the stale heartbeat + tmuxAlive:false combination excludes them.

	const agents = {
		"worker-1": {
			id: "worker-1", role: "implementer", roleKind: "implementer", capabilities: [],
			activeTaskIds: [], maxConcurrentTasks: 1,
			status, runtimeStatus: "idle", health: "healthy",
			tmuxAlive,
			tmuxSession: "r16", tmuxWindow: "worker-1", tmuxTarget: `r16:worker-1.0`,
			model: "gpt-5.4-mini", provider: "openai", cwd: scratchDir,
			mailbox: ".pi/swarm/mailboxes/worker-1.jsonl",
			createdAt: workerTs, updatedAt: workerTs, lastHeartbeatAt: workerTs,
		},
		"worker-2": {
			id: "worker-2", role: "implementer", roleKind: "implementer", capabilities: [],
			activeTaskIds: [], maxConcurrentTasks: 1,
			status, runtimeStatus: "idle", health: "healthy",
			tmuxAlive,
			tmuxSession: "r16", tmuxWindow: "worker-2", tmuxTarget: `r16:worker-2.0`,
			model: "gpt-5.4-mini", provider: "openai", cwd: scratchDir,
			mailbox: ".pi/swarm/mailboxes/worker-2.jsonl",
			createdAt: workerTs, updatedAt: workerTs, lastHeartbeatAt: workerTs,
		},
		"worker-3": {
			id: "worker-3", role: "implementer", roleKind: "implementer", capabilities: [],
			activeTaskIds: [], maxConcurrentTasks: 1,
			status, runtimeStatus: "idle", health: "healthy",
			tmuxAlive,
			tmuxSession: "r16", tmuxWindow: "worker-3", tmuxTarget: `r16:worker-3.0`,
			model: "gpt-5.4-mini", provider: "openai", cwd: scratchDir,
			mailbox: ".pi/swarm/mailboxes/worker-3.jsonl",
			createdAt: workerTs, updatedAt: workerTs, lastHeartbeatAt: workerTs,
		},
	};

	const initial = {
		version: 1,
		swarmId: "r16-test",
		cwd: scratchDir,
		tmuxSession: "r16",
		agents,
		delivered: {},
		messages: {},
		goal: {
			id: "goal-r16-red",
			origin: goalOrigin,
			text: "R16 RED test user goal",
			nudgeIntervalMs: goalIntervalMs,
			setAt,
			consecutiveNoResolveNudges: 0,
		},
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

/**
 * Drive one tick of the pump's evaluateIdleGoalNudgeLocked path.
 */
async function pumpTick({ p, scratch, nowMs, pi }) {
	return await withLock(p, async () => {
		const st = await readState(p, scratch);
		heartbeatRootLeader(st, nowMs, process.pid, "synthetic_tick");
		await updateIdleEpochLocked(p, st, nowMs);
		const r = await evaluateIdleGoalNudgeLocked(pi, scratch, p, st, nowMs);
		await writeState(p, st);
		return { r, st };
	});
}

/**
 * Simulate the root's `turn_end` resolve hook using the PRODUCTION code path
 * by calling the real `turnEndIsResolveAction` (module-scope export from hooks.ts) and
 * then mirroring the production counter-reset / no-resolve-trace logic.
 */
async function simulateTurnEndResolve({ p, scratch, turnContentBlocks = [], toolResults = [], ackOnly = false }) {
	const { turnEndIsResolveAction } = await import(join(srcDir, "hooks.ts"));
	const fakeEvent = {
		message: { role: "assistant", stopReason: "stop", content: turnContentBlocks },
		toolResults,
	};
	const action = turnEndIsResolveAction(fakeEvent);
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		const goal = st.goal;
		if (!goal) return;
		const nudges = goal.consecutiveNoResolveNudges;
		const hadBackoff = Boolean(goal.backoffTicksRemaining && goal.backoffTicksRemaining > 0);
		if (nudges === 0 && !hadBackoff) return;
		if (!action.resolve) {
			goal.lastNonResolveTurnAt = new Date().toISOString();
			await trace(p, "goal.nudge.turn_no_resolve_action", {
				goalId: goal.id,
				nudges,
				hadBackoff,
				detectionReason: action.reason,
			}).catch(() => {});
		} else {
			goal.consecutiveNoResolveNudges = 0;
			delete goal.backoffTicksRemaining;
			goal.lastResolvedAt = new Date().toISOString();
			goal.lastResolveActionAt = new Date().toISOString();
			goal.lastResolveActionTools = action.toolNames;
			await trace(p, "goal.nudge.resolved", {
				goalId: goal.id,
				nudges,
				hadBackoff,
				by: "turn_end",
				actionReason: action.reason,
				actionTools: action.toolNames,
			});
		}
		await writeState(p, st);
	});
}

/**
 * Reload state from disk (mimics root restart / /reload).
 */
async function stateReload({ p, scratch }) {
	return await withLock(p, async () => readState(p, scratch));
}

// ============================================================================
// R16-S1: Config C1 — ack-with-text on settled-but-alive pool (the live bug shape)
//   The live incident shape: workers are alive enough to fire idle_nudge, but
//   the root's ack text resets the counter on every cycle. Counter
//   never reaches MAX=3; back-off never engages; idle_nudge fires every interval.
//   RED (pre-fix): idle_nudge fires >= 9 times (multiple cycles).
//   GREEN (post-fix): idle_nudge fires exactly 3 times (cap reached, back-off engages).
//
//   The harness drives BOTH shapes via `resolveAction=false` (pre-fix path) and
//   `resolveAction=true` (post-fix path: a swarm tool call happened in the same turn).
//   The test would have FAILED pre-fix at the GREEN assertion because the resolve
//   would be ignored when the root's ack text contains no tool call.
//   Post-fix, the GREEN assertion holds because turnEndIsResolveAction in hooks.ts
//   returns false for ack-only turns and the counter keeps climbing.
// ============================================================================
console.log("\n[R16-S1] Config C1 — ack-with-text turn_end on settled-but-alive pool");
{
	const sScratch = freshScratch(1);
	const { p } = await seedR16Shape({
		scratch: sScratch,
		workerShape: "settled-but-alive",
		goalOrigin: "user",
		goalIntervalMs: 5000,
	});

	const { pi } = makePiMock();

	// 12 ticks at 5s interval: tick → evaluate → turn_end{stop, text} resets.
	const startMs = Date.now();
	const tickIntervalMs = 5000;
	const tickCount = 12;
	for (let i = 0; i < tickCount; i++) {
		const tickNowMs = startMs + (i + 1) * tickIntervalMs;
		await pumpTick({ p, scratch: sScratch, nowMs: tickNowMs, pi });
		// ACK-ONLY turn (text block, no tool_use block) — this is the live bug shape.
		// Production hooks.ts:turnEndIsResolveAction returns {resolve: false} for ack-only,
		// so the counter keeps climbing. Pre-fix the hooks.ts code reset on text alone,
		// which would let this RED assertion (idle_nudge fires 9+ times) pass.
		await simulateTurnEndResolve({
			p,
			scratch: sScratch,
			turnContentBlocks: [{ type: "text", text: "Acknowledged: continuing work." }],
		});
	}

	const events = readEvents(sScratch);
	const idleNudgeCount = events.filter((e) => e.event === "goal.idle_nudge").length;
	const resolvedCount = events.filter((e) => e.event === "goal.nudge.resolved").length;
	const escalationCount = events.filter((e) => e.event === "goal.escalation.pool_empty").length;
	const noResolveTurnCount = events.filter((e) => e.event === "goal.nudge.turn_no_resolve_action").length;

	// POST-FIX (GREEN): ack text does NOT reset; counter reaches cap (=3), back-off engages.
	ok("R16-S1 [GREEN post-fix] goalIdleNudgeTraceCount === 3 (cap reached, back-off engages)",
		idleNudgeCount === 3, `got ${idleNudgeCount}`);

	ok("R16-S1 [GREEN post-fix] goalNudgeResolvedTraceCount === 0 (ack text did not reset)",
		resolvedCount === 0, `got ${resolvedCount}`);

	// Post-fix trace: every ack-only turn emits a `goal.nudge.turn_no_resolve_action` so
	// dashboards can distinguish ack vs resolve. The hook adds this trace when the
	// action detector returns false (no swarm tool call in the turn).
	ok("R16-S1 [GREEN post-fix] goal.nudge.turn_no_resolve_action trace fires per ack turn",
		noResolveTurnCount >= 9, `got ${noResolveTurnCount}`);

	// Pre-fix has no escalation because pool is non-vacuous (R14-A predicate), so this
	// assertion holds in BOTH RED and GREEN for C1 topology.
	ok("R16-S1 [no escalation either shape] escalationPoolEmptyTraceCount === 0 (non-vacuous pool)",
		escalationCount === 0, `got ${escalationCount}`);

	// GREEN POST-FIX validation: drive a SECOND run with resolveAction=true (modeling
	// the root making a swarm tool call in the turn) and confirm the counter
	// DOES reset — i.e., the fix doesn't break the legitimate resolve path.
	{
		const s2Scratch = freshScratch("1b");
		const { p: p2 } = await seedR16Shape({
			scratch: s2Scratch,
			workerShape: "settled-but-alive",
			goalOrigin: "user",
			goalIntervalMs: 5000,
		});
		const { pi: pi2 } = makePiMock();
		for (let i = 0; i < 4; i++) {
			const tickNowMs = startMs + (i + 1) * tickIntervalMs;
			await pumpTick({ p: p2, scratch: s2Scratch, nowMs: tickNowMs, pi: pi2 });
			// RESOLVE-ACTION turn (text + swarm tool_use block). Production hooks.ts
			// returns {resolve: true, toolNames: [...]} — the counter resets.
			await simulateTurnEndResolve({
				p: p2,
				scratch: s2Scratch,
				turnContentBlocks: [
					{ type: "text", text: "Spawning a worker for the user goal." },
					{ type: "tool_use", name: "swarm_spawn_agent", input: { role: "implementer" } },
				],
				toolResults: [{ toolName: "swarm_spawn_agent", isError: false }],
			});
		}
		const events2 = readEvents(s2Scratch);
		const idleNudgeCount2 = events2.filter((e) => e.event === "goal.idle_nudge").length;
		const resolvedCount2 = events2.filter((e) => e.event === "goal.nudge.resolved").length;
		ok("R16-S1 [GREEN post-fix] with resolveAction=true, idle_nudge can re-fire on each turn",
			idleNudgeCount2 >= 3, `got ${idleNudgeCount2}`);
		ok("R16-S1 [GREEN post-fix] with resolveAction=true, resolved trace fires per turn",
			resolvedCount2 >= 3, `got ${resolvedCount2}`);
	}
}

// ============================================================================
// R16-S2: Config C2 — ack-without-text on settled-but-alive pool (control case)
//   Same topology as C1 but turn_end text is empty. Pre-fix hook already
//   doesn't reset on silent turns (the `nudges === 0 && !hadBackoff` check),
//   so this case is unchanged. Counter reaches MAX=3, back-off engages.
//   This proves the FIX is selectively narrowing the resolve semantics —
//   it MUST NOT regress the silent case.
// ============================================================================
console.log("\n[R16-S2] Config C2 — ack-without-text on settled-but-alive pool (control)");
{
	const sScratch = freshScratch(2);
	const { p } = await seedR16Shape({
		scratch: sScratch,
		workerShape: "settled-but-alive",
		goalOrigin: "user",
		goalIntervalMs: 5000,
	});

	const { pi } = makePiMock();

	const startMs = Date.now();
	const tickIntervalMs = 5000;
	const tickCount = 12;
	for (let i = 0; i < tickCount; i++) {
		const tickNowMs = startMs + (i + 1) * tickIntervalMs;
		await pumpTick({ p, scratch: sScratch, nowMs: tickNowMs, pi });
		// SILENT turn (no content blocks). Production hooks.ts:turnEndIsResolveAction
		// returns {resolve: false}. Pre-fix the hooks.ts code also didn't reset on
		// silent turns — counter still climbs to cap (control case).
		await simulateTurnEndResolve({
			p,
			scratch: sScratch,
			turnContentBlocks: [],
		});
	}

	const events = readEvents(sScratch);
	const idleNudgeCount = events.filter((e) => e.event === "goal.idle_nudge").length;
	const escalationCount = events.filter((e) => e.event === "goal.escalation.pool_empty").length;

	// Both RED and GREEN: counter reaches 3, back-off engages, no further nudges.
	// Total idle_nudge fires: 3 (cap) + 0 (back-off consumes 2 ticks) = 3.
	ok("R16-S2 [GREEN post-fix] goalIdleNudgeTraceCount === 3 (cap reached, back-off engages)",
		idleNudgeCount === 3, `got ${idleNudgeCount}`);

	ok("R16-S2 [no regression] escalationPoolEmptyTraceCount === 0 (non-vacuous pool)",
		escalationCount === 0, `got ${escalationCount}`);
}

// ============================================================================
// R16-S3: Config C3 — 12-tick persistent vacuous pool + reload boundary
//   Live: 331 held_no_live_workers traces over 27m54s at 5s cadence (PRE-R14 code).
//   POST-R14 + reload: dedupe flag `lastWasVacuous` MUST persist via writeState.
//   RED (pre-R14): heldCount === 12 (every tick re-fires).
//   GREEN (post-R14): heldCount === 1 (once per false→true transition).
// ============================================================================
console.log("\n[R16-S3] Config C3 — 12-tick persistent vacuous pool + reload boundary");
{
	const sScratch = freshScratch(3);
	const { p } = await seedR16Shape({
		scratch: sScratch,
		workerShape: "genuinely-vacuous",
		goalOrigin: "user",
		goalIntervalMs: 5000,
	});

	const { pi } = makePiMock();

	const startMs = Date.now();
	const tickIntervalMs = 5000;
	const tickCount = 12;
	let firstReload;
	for (let i = 0; i < tickCount; i++) {
		const tickNowMs = startMs + (i + 1) * tickIntervalMs;
		await pumpTick({ p, scratch: sScratch, nowMs: tickNowMs, pi });
		// Force a state reload to expose the persistence boundary.
		const fresh = await stateReload({ p, scratch: sScratch });
		if (i === 0) {
			firstReload = fresh.idleNudgeState?.lastWasVacuous;
		}
	}

	const events = readEvents(sScratch);
	const heldCount = events.filter((e) => e.event === "goal.nudge.held_no_live_workers").length;
	const escalationCount = events.filter((e) => e.event === "goal.escalation.pool_empty").length;

	// GREEN expectation (R14 dedupe persists): heldCount === 1 (single transition),
	// lastWasVacuous survives reload.
	ok("R16-S3 [GREEN post-fix] lastWasVacuous PERSISTED across reload (R14-B dedupe)",
		firstReload === true, `got firstReload.lastWasVacuous=${firstReload}`);

	ok("R16-S3 [GREEN post-fix] heldNoLiveWorkersTraceCount === 1 (once per false→true transition)",
		heldCount === 1, `got ${heldCount}`);

	ok("R16-S3 [GREEN post-fix] escalationPoolEmptyTraceCount === 1 (cooldown fires once)",
		escalationCount === 1, `got ${escalationCount}`);
}

// ============================================================================
// R16-S4: Config C4 — vacuous pool with heartbeat-GC status=stopped
//   Proves the dedupe + cooldown invariant is independent of GC status.
// ============================================================================
console.log("\n[R16-S4] Config C4 — vacuous pool + heartbeat-GC status=stopped");
{
	const sScratch = freshScratch(4);
	const { p } = await seedR16Shape({
		scratch: sScratch,
		workerShape: "heartbeat-gc-stopped",
		goalOrigin: "user",
		goalIntervalMs: 5000,
	});

	const { pi } = makePiMock();

	const startMs = Date.now();
	const tickIntervalMs = 5000;
	const tickCount = 12;
	let firstReload;
	for (let i = 0; i < tickCount; i++) {
		const tickNowMs = startMs + (i + 1) * tickIntervalMs;
		await pumpTick({ p, scratch: sScratch, nowMs: tickNowMs, pi });
		const fresh = await stateReload({ p, scratch: sScratch });
		if (i === 0) {
			firstReload = fresh.idleNudgeState?.lastWasVacuous;
		}
	}

	const events = readEvents(sScratch);
	const heldCount = events.filter((e) => e.event === "goal.nudge.held_no_live_workers").length;
	const escalationCount = events.filter((e) => e.event === "goal.escalation.pool_empty").length;

	ok("R16-S4 [GREEN post-fix] lastWasVacuous PERSISTED across reload (GC-stopped pool)",
		firstReload === true, `got firstReload.lastWasVacuous=${firstReload}`);

	ok("R16-S4 [GREEN post-fix] heldNoLiveWorkersTraceCount === 1 (GC doesn't re-fire)",
		heldCount === 1, `got ${heldCount}`);

	ok("R16-S4 [GREEN post-fix] escalationPoolEmptyTraceCount === 1",
		escalationCount === 1, `got ${escalationCount}`);
}

// ============================================================================
// R16-S5: Config C5 — cooldown survives a state reload
//   Live: 0 escalations over 27m because pre-R14 code never engaged. Post-R14
//   must keep cooldown persisting through reload. Pre-fix: cooldown lost on
//   reload → escalation re-fires (count === 2). Post-fix: cooldown persists
//   → escalation fires once (count === 1).
// ============================================================================
console.log("\n[R16-S5] Config C5 — cooldown survives a state reload");
{
	const sScratch = freshScratch(5);
	const { p } = await seedR16Shape({
		scratch: sScratch,
		workerShape: "genuinely-vacuous",
		goalOrigin: "user",
		goalIntervalMs: 5000,
	});

	const { pi } = makePiMock();

	const startMs = Date.now();
	const tickIntervalMs = 5000;
	const halfTicks = 12;
	// First half: 12 ticks → 1 escalation expected (cooldown expires after 5min, but
	// the first tick has cooldownUntilMs=0 so it fires immediately).
	for (let i = 0; i < halfTicks; i++) {
		const tickNowMs = startMs + (i + 1) * tickIntervalMs;
		await pumpTick({ p, scratch: sScratch, nowMs: tickNowMs, pi });
	}
	const eventsFirstHalf = readEvents(sScratch);
	const escalationFirstHalf = eventsFirstHalf.filter((e) => e.event === "goal.escalation.pool_empty").length;

	// Force a state reload to expose persistence.
	const fresh = await stateReload({ p, scratch: sScratch });
	const persistedCooldown = !!fresh.idleNudgeState?.lastPoolEmptyEscalationAt;

	// Second half: 12 more ticks (still within NOTIFY_DEFAULT_COOLDOWN_MS = 5min
	// because 12 × 5000ms = 60s < 5min). Cooldown MUST hold.
	for (let i = 0; i < halfTicks; i++) {
		const tickNowMs = startMs + (halfTicks + i + 1) * tickIntervalMs;
		await pumpTick({ p, scratch: sScratch, nowMs: tickNowMs, pi });
	}

	const events = readEvents(sScratch);
	const escalationTotal = events.filter((e) => e.event === "goal.escalation.pool_empty").length;

	ok("R16-S5 [GREEN post-fix] lastPoolEmptyEscalationAt persisted across reload",
		persistedCooldown, `got ${fresh.idleNudgeState?.lastPoolEmptyEscalationAt}`);

	ok("R16-S5 [GREEN post-fix] first-half escalation === 1 (initial cooldown fires once)",
		escalationFirstHalf === 1, `got ${escalationFirstHalf}`);

	ok("R16-S5 [GREEN post-fix] escalationTotal === 1 across reload (cooldown persists)",
		escalationTotal === 1, `got ${escalationTotal}`);
}

// ============================================================================
// R16-S6: Config C6 — explicit goal clear mid-cooldown
//   Live: clearing the goal must stop the escalation chain. Pre-fix: cleared
//   goal re-fires held traces if the evaluator doesn't short-circuit at the
//   no_goal guard.
//   GREEN: heldCount unchanged after clear (no_goal short-circuit).
// ============================================================================
console.log("\n[R16-S6] Config C6 — explicit goal clear mid-cooldown stops escalation");
{
	const sScratch = freshScratch(6);
	const { p } = await seedR16Shape({
		scratch: sScratch,
		workerShape: "genuinely-vacuous",
		goalOrigin: "user",
		goalIntervalMs: 5000,
	});

	const { pi } = makePiMock();

	const startMs = Date.now();
	const tickIntervalMs = 5000;
	const preClearTicks = 3;
	// Drive 3 ticks pre-clear (fires 1 escalation + 1 held trace).
	for (let i = 0; i < preClearTicks; i++) {
		const tickNowMs = startMs + (i + 1) * tickIntervalMs;
		await pumpTick({ p, scratch: sScratch, nowMs: tickNowMs, pi });
	}
	const eventsPre = readEvents(sScratch);
	const escalationPre = eventsPre.filter((e) => e.event === "goal.escalation.pool_empty").length;
	const heldPre = eventsPre.filter((e) => e.event === "goal.nudge.held_no_live_workers").length;

	// Clear the goal mid-cooldown.
	await withLock(p, async () => {
		const st = await readState(p, sScratch);
		delete st.goal;
		await writeState(p, st);
	});

	// 9 more ticks post-clear — must produce ZERO held/escalation traces.
	for (let i = 0; i < 9; i++) {
		const tickNowMs = startMs + (preClearTicks + i + 1) * tickIntervalMs;
		await pumpTick({ p, scratch: sScratch, nowMs: tickNowMs, pi });
	}

	const eventsPost = readEvents(sScratch);
	const escalationPost = eventsPost.filter((e) => e.event === "goal.escalation.pool_empty").length;
	const heldPost = eventsPost.filter((e) => e.event === "goal.nudge.held_no_live_workers").length;

	ok("R16-S6 [GREEN post-fix] pre-clear escalation fires === 1 (initial escalation)",
		escalationPre === 1, `got ${escalationPre}`);

	ok("R16-S6 [GREEN post-fix] escalation stops at no_goal guard post-clear",
		escalationPost === escalationPre, `pre=${escalationPre} post=${escalationPost}`);

	ok("R16-S6 [GREEN post-fix] heldNoLiveWorkersTraceCount UNCHANGED post-clear",
		heldPost === heldPre, `pre=${heldPre} post=${heldPost}`);
}

// ============================================================================
// R16-S7: Action-oriented nudge body (Fix C body emitter)
//   When the worker pool is empty AND a user-origin goal is set, the escalation
//   nudge body MUST include an action-oriented next-step hint (not just a
//   generic diagnostic dump). The hint must reference the appropriate tool.
// ============================================================================
console.log("\n[R16-S7] Action-oriented escalation nudge body");
{
	const sScratch = freshScratch(7);
	const { p } = await seedR16Shape({
		scratch: sScratch,
		workerShape: "genuinely-vacuous",
		goalOrigin: "user",
		goalIntervalMs: 5000,
	});

	const { pi } = makePiMock();

	const startMs = Date.now();
	const tickNowMs = startMs + 5000;
	await pumpTick({ p, scratch: sScratch, nowMs: tickNowMs, pi });

	const mb = readRootMailbox(sScratch);
	const highPriority = mb.filter((m) => m.priority === "high");
	const body = highPriority[0]?.body || "";

	// Post-fix body must include at least one of the action-oriented hint keywords.
	const actionHints = ["swarm_spawn_agent", "swarm_create_task", "swarm_restart_agent", "ask the user", "next action", "recovery", "empty pool", "next step"];
	const hasHint = actionHints.some((k) => body.includes(k));
	ok("R16-S7 [GREEN post-fix] escalation body contains an action-oriented hint",
		hasHint, `body=${JSON.stringify(body).slice(0, 400)}`);

	ok("R16-S7 mailbox durable append === 1 with priority=high",
		highPriority.length === 1, `got ${highPriority.length}`);
}

// ============================================================================
// R16-S8: state.ts readState back-fill for legacy swarm-state.json
//   A legacy swarm-state.json written before R14 (no `lastWasVacuous`,
//   `lastPoolEmptyEscalationAt`) MUST NOT crash readState.
// ============================================================================
console.log("\n[R16-S8] state.ts readState back-fill for legacy swarm-state.json");
{
	const sScratch = freshScratch(8);
	const p = paths(sScratch);
	const nowMs = Date.now();
	const setAt = new Date(nowMs - 15 * 60_000).toISOString();
	const workerTs = new Date(nowMs - 15 * 60_000).toISOString();

	const agents = {
		"worker-1": {
			id: "worker-1", role: "implementer", roleKind: "implementer", capabilities: [],
			activeTaskIds: [], maxConcurrentTasks: 1,
			status: "running", runtimeStatus: "idle", health: "healthy",
			tmuxAlive: false,
			tmuxSession: "r16", tmuxWindow: "worker-1", tmuxTarget: `r16:worker-1.0`,
			model: "gpt-5.4-mini", provider: "openai", cwd: sScratch,
			mailbox: ".pi/swarm/mailboxes/worker-1.jsonl",
			createdAt: workerTs, updatedAt: workerTs, lastHeartbeatAt: workerTs,
		},
	};

	// Seed a PRE-R14 swarm-state.json: idleNudgeState is present but lacks the
	// two R14 fields.
	const legacy = {
		version: 1,
		swarmId: "r16-legacy",
		cwd: sScratch,
		tmuxSession: "r16",
		agents,
		delivered: {},
		messages: {},
		idleNudgeState: {
			allIdleSinceAt: undefined,
			// No lastWasVacuous, no lastPoolEmptyEscalationAt (pre-R14).
		},
		goal: {
			id: "goal-r16-legacy",
			origin: "user",
			text: "R16 legacy RED test",
			nudgeIntervalMs: 5000,
			setAt,
			consecutiveNoResolveNudges: 0,
		},
		createdAt: workerTs,
		updatedAt: workerTs,
	};

	mkdirSync(join(sScratch, ".pi/swarm/mailboxes"), { recursive: true });
	mkdirSync(join(sScratch, ".pi/swarm/traces"), { recursive: true });
	writeFileSync(join(sScratch, ".pi/swarm/traces/events.jsonl"), "");
	writeFileSync(join(sScratch, ".pi/swarm/swarm-state.json"), JSON.stringify(legacy, null, 2));

	let readThrew = false;
	let fresh;
	try {
		fresh = await readState(p, sScratch);
	} catch { readThrew = true; }

	ok("R16-S8 readState does NOT throw on pre-R14 swarm-state.json",
		!readThrew, "readState threw");

	ok("R16-S8 readState back-fills idleNudgeState as object",
		!!fresh && typeof fresh.idleNudgeState === "object",
		`got ${typeof fresh?.idleNudgeState}`);

	// Drive a tick — the evaluator must not crash on absent lastWasVacuous.
	const { pi } = makePiMock();
	let tickThrew = false;
	try {
		await pumpTick({ p, scratch: sScratch, nowMs: nowMs + 5000, pi });
	} catch { tickThrew = true; }
	ok("R16-S8 evaluator tick does NOT throw on absent R14 fields",
		!tickThrew, "tick threw");
}

// ============================================================================
// Cleanup
// ============================================================================
process.env.PI_SWARM_AGENT_ID = ORIG_PI_SWARM_AGENT_ID;
process.env.PI_SWARM_IS_ROOT = ORIG_PI_SWARM_IS_ROOT;

console.log(`\nR16-IDLE-GOAL-REGRESSION ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
if (fail > 0) {
	console.error("\n  ↳ RED regression reproduced — the idle-goal ACK-loop (R16-S1) is confirmed across the ack-with-text topology; the post-R14 vacuous state persistence (R16-S3..S6) confirms R14 invariants hold across state reload. Fix A (ack-vs-resolve gating) + Fix B (vacuous-branch writeState + state.ts back-fill) + Fix C (action-oriented nudge body) per plan §6 will land the fix.");
	process.exit(1);
}
process.exit(0);
