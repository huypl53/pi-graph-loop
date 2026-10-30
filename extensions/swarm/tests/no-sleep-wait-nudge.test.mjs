#!/usr/bin/env node
/**
 * Test: Goal nudges and health check nudges MUST NOT suggest running sleep/synchronous wait
 * to Root (which causes hallucinated sleep polling loops).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = await import(join(here, "../src/reconcile.ts"));
const { paths, ensureDirs, readState, writeState } = await import(join(here, "../src/state.ts"));
const { ensureRoot, claimRootLeader } = await import(join(here, "../src/identity.ts"));

process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_GOAL_IDLE_CHECK_INTERVAL_MS = "100";
process.env.PI_SWARM_GOAL_IDLE_CHECKS_REQUIRED = "1";

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

const dir = mkdtempSync(join(tmpdir(), "nudge-body-"));
const p = paths(dir);
await ensureDirs(p);

try {
	const nowMs = Date.now();
	const t0 = new Date(nowMs).toISOString();
	const staleHb = new Date(nowMs - 15 * 60 * 1000).toISOString(); // 15 mins ago
	const freshHb = new Date(nowMs - 10 * 1000).toISOString();

	const st = await readState(p, dir);
	ensureRoot(st, dir, p);

	// 1. Long running worker to trigger health check nudge
	st.agents["worker-long"] = {
		id: "worker-long",
		role: "tester",
		roleKind: "worker",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus: "tool_running",
		health: "healthy",
		tmuxAlive: true,
		tmuxTarget: "pi-swarm:worker-long.0",
		model: "mock",
		provider: "mock-llm",
		lastHeartbeatAt: staleHb,
		createdAt: staleHb,
		updatedAt: staleHb,
	};

	st.agents["worker-idle"] = {
		id: "worker-idle",
		role: "implementer",
		roleKind: "worker",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxAlive: true,
		tmuxTarget: "pi-swarm:worker-idle.0",
		model: "mock",
		provider: "mock-llm",
		lastHeartbeatAt: freshHb,
		createdAt: freshHb,
		updatedAt: freshHb,
	};

	st.goal = {
		id: "goal-test",
		text: "Advance project features",
		setAt: t0,
		setBy: "root",
		origin: "user",
		consecutiveNoResolveNudges: 0,
	};

	await writeState(p, st);
	await claimRootLeader(st, Date.now(), process.pid);
	await writeState(p, st);

	const sentMessages = [];
	const pi = {
		sendMessage: async (content, opts) => {
			sentMessages.push({ content, opts });
			return true;
		},
		registerTool: () => {},
		on: () => {},
	};
	const ctx = { cwd: dir, mode: "tui", isIdle: () => true };

	// Pump ticks (simulating checks spaced 1s apart)
	await src.pumpRootMailbox(pi, ctx, p, "watchdog");
	await new Promise((r) => setTimeout(r, 1050));
	await src.pumpRootMailbox(pi, ctx, p, "watchdog");
	await new Promise((r) => setTimeout(r, 1050));
	await src.pumpRootMailbox(pi, ctx, p, "watchdog");

	const healthCheckMsg = sentMessages.find((m) => JSON.stringify(m).includes("[Health Check]"));
	ok("emitted health check nudge", Boolean(healthCheckMsg));
	const healthCheckBody = healthCheckMsg?.content?.details?.body ?? "";
	ok("health check nudge does NOT mention sleep", !/\bsleep\b/i.test(healthCheckBody), `found sleep in health check: ${healthCheckBody}`);
	ok(
		"health check nudge does NOT mention synchronous wait",
		!healthCheckBody.includes("synchronous wait"),
		`found synchronous wait in health check: ${healthCheckBody}`,
	);

	// 2. Clear agents to trigger idle goal nudge
	delete st.agents["worker-long"];
	st.idleNudgeState = {};
	await writeState(p, st);

	sentMessages.length = 0;
	// Pump to fire idle goal nudge
	await src.pumpRootMailbox(pi, ctx, p, "watchdog");
	await new Promise((r) => setTimeout(r, 150));
	await src.pumpRootMailbox(pi, ctx, p, "watchdog");

	const idleGoalMsg = sentMessages.find((m) => JSON.stringify(m).includes("Idle streak: goal"));
	ok("emitted idle goal nudge", Boolean(idleGoalMsg));
	const idleGoalBody = idleGoalMsg?.content?.details?.body ?? "";
	ok("idle goal nudge does NOT mention sleep", !/\bsleep\b/i.test(idleGoalBody), `found sleep in idle goal: ${idleGoalBody}`);
	ok(
		"idle goal nudge does NOT mention synchronous wait",
		!idleGoalBody.includes("synchronous wait"),
		`found synchronous wait in idle goal: ${idleGoalBody}`,
	);
} finally {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
