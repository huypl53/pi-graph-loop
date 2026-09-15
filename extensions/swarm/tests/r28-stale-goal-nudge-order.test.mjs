#!/usr/bin/env node
/**
 * R28 regression test — Stale Goal Nudge Ordering & Stuck-Busy Escalation Hygiene.
 *
 * Reproduces the two symptoms reported from incident multiple-20260915-105755:
 *   1. Out-of-order resurrection: Nudge 49 resurrected and surfaced AFTER Nudge 50-52
 *      because allIdleSinceAt was cleared by root_busy (or worker busy), causing staleSurfaceReason
 *      to return stale: false.
 *   2. Unconsumed stale messages lingering in mailbox and inflating oldestWaitMs >= 120s,
 *      which triggers false stuck-busy escalation and interrupts an actively working Root.
 *
 * Red-Green discipline:
 *   - MUST run RED against pre-fix surface.ts.
 *   - Minimal fix in surface.ts makes it GREEN.
 *
 * Run: node extensions/swarm/tests/r28-stale-goal-nudge-order.test.mjs
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { pumpRootMailbox, staleSurfaceReason } = await import(join(here, "../src/surface.ts"));
const { paths, ensureDirs, readState, writeState } = await import(join(here, "../src/state.ts"));
const { ensureRoot, claimRootLeader } = await import(join(here, "../src/identity.ts"));

process.env.PI_SWARM_AGENT_ID = "root";

let pass = 0,
	fail = 0;
const ok = (name, condition, info = "") => {
	if (condition) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info);
	}
};

const dir = mkdtempSync(join(tmpdir(), "r28-lane-"));
const p = paths(dir);
await ensureDirs(p);

try {
	const nowMs = Date.now();
	const tNow = new Date(nowMs).toISOString();
	const tOlder = new Date(nowMs - 150_000).toISOString(); // 150s ago (> 120s threshold)

	const st = await readState(p, dir);
	ensureRoot(st, dir, p);
	await claimRootLeader(st, nowMs, process.pid);

	// Setup active goal at nudgeSeq 52
	st.goal = {
		id: "goal-r28",
		text: "R28 repro goal",
		setAt: tOlder,
		setBy: "root",
		origin: "user",
		consecutiveNoResolveNudges: 52,
		nudgeSeq: 52,
	};

	// Worker is busy (running a tool, like s0-doc-planner was in production)
	st.agents["worker-a"] = {
		id: "worker-a",
		role: "worker",
		roleKind: "worker",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus: "busy",
		health: "healthy",
		tmuxAlive: true,
		lastHeartbeatAt: tNow,
		createdAt: tOlder,
		updatedAt: tNow,
	};

	// Root pseudo-agent with recent tool activity (active, not stuck!)
	st.agents.root.lastToolAt = tNow;
	st.agents.root.lastHeartbeatAt = tNow;

	// Mailbox has older nudge 49 (created 150s ago, while active goal is at seq 52)
	const msg49 = {
		id: "msg-49",
		swarmId: "swarm-r28",
		from: "root",
		to: "root",
		subject: "Idle streak: goal 49",
		body: "Nudge 49",
		type: "swarm.message",
		schemaVersion: 1,
		createdAt: tOlder,
		requiresAck: true,
		idempotencyKey: "goal:goal-r28:nudge:idle-streak:49",
	};

	st.messages["msg-49"] = msg49;

	// Write mailbox JSONL
	writeFileSync(
		join(p.mailboxes, "root.jsonl"),
		JSON.stringify(msg49) + "\n",
		"utf8",
	);

	// Simulate allIdleSinceAt is missing/undefined (due to root_busy or worker busy)
	st.idleNudgeState = {
		goalConsecutiveNoResolveNudges: 52,
	};

	await writeState(p, st);

	// --- Test 1: Monotonic Goal Nudge Sequence Guard ---
	// In staleSurfaceReason, Nudge 49 (seq: 49) MUST be recognized as stale/superseded
	// when active goal is already at nudgeSeq: 52, EVEN IF allIdleSinceAt is undefined!
	const staleCheck = await staleSurfaceReason(p, st, msg49, {}, nowMs);
	ok(
		"Test 1: Nudge 49 is classified as stale/superseded when active goal nudgeSeq is 52",
		staleCheck.stale === true && staleCheck.reason === "goal_nudge_superseded",
		`staleCheck=${JSON.stringify(staleCheck)}`,
	);

	// --- Test 2: Stuck-Busy Escalation Hygiene ---
	// When Root is BUSY (isIdle: false) but actively executing tools (lastToolAt is fresh),
	// pumpRootMailbox MUST NOT trigger stuck-busy escalation and MUST NOT force delivery.
	const sentMessagesBusy = [];
	const piBusy = {
		sendMessage: async (content, opts) => {
			sentMessagesBusy.push({ content, opts });
			return true;
		},
		registerTool: () => {},
		on: () => {},
	};

	const ctxBusy = { cwd: dir, mode: "tui", isIdle: () => false };
	await pumpRootMailbox(piBusy, ctxBusy, p, "watchdog");

	ok(
		"Test 2: No forced delivery when Root is actively executing tools (no false stuck-busy escalation)",
		sentMessagesBusy.length === 0,
		`sent=${sentMessagesBusy.length} messages: ${JSON.stringify(sentMessagesBusy)}`,
	);

	// --- Test 3: Permanent Stale Retirement into consumerReceipts ---
	// When Root is IDLE and pump runs, stale Nudge 49 MUST be retired into consumerReceipts
	// so it never surfaces and never inflates oldestWaitMs on subsequent ticks.
	const sentMessagesIdle = [];
	const piIdle = {
		sendMessage: async (content, opts) => {
			sentMessagesIdle.push({ content, opts });
			return true;
		},
		registerTool: () => {},
		on: () => {},
	};

	const ctxIdle = { cwd: dir, mode: "tui", isIdle: () => true };
	await pumpRootMailbox(piIdle, ctxIdle, p, "watchdog");

	const surfaced49 = sentMessagesIdle.some((m) => JSON.stringify(m).includes("Idle streak: goal 49"));
	ok(
		"Test 3a: Nudge 49 is NOT surfaced to Root",
		!surfaced49,
		`surfaced49=${surfaced49}`,
	);

	const stAfter = await readState(p, dir);
	const receipt49 = stAfter.consumerReceipts?.root?.entries?.["msg-49"];
	ok(
		"Test 3b: Stale Nudge 49 is recorded in consumerReceipts as consumed",
		Boolean(receipt49),
		`receipt49=${JSON.stringify(receipt49)}`,
	);
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log(`\nSummary: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
