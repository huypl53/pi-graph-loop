#!/usr/bin/env node
/**
 * Test: Long-running tool execution (>10m without heartbeat) must emit an actionable
 * health-check nudge for the busy worker, and must NOT trigger a false alarm claiming
 * "all non-root agents have been idle / goal has no active work".
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = await import(join(here, "../src/reconcile.ts"));
const { paths, ensureDirs, readState, writeState } = await import(join(here, "../src/state.ts"));
const { ensureRoot, claimRootLeader } = await import(join(here, "../src/identity.ts"));

process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_GOAL_IDLE_CHECK_INTERVAL_MS = "1000";
process.env.PI_SWARM_GOAL_IDLE_CHECKS_REQUIRED = "3";

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

const dir = mkdtempSync(join(tmpdir(), "long-running-worker-"));
const p = paths(dir);
await ensureDirs(p);

try {
	const nowMs = Date.now();
	const t0 = new Date(nowMs).toISOString();
	const staleHb = new Date(nowMs - 15 * 60 * 1000).toISOString(); // 15 mins ago
	const freshHb = new Date(nowMs - 10 * 1000).toISOString(); // 10s ago

	const st = await readState(p, dir);
	ensureRoot(st, dir, p);

	// worker-long is running a 90m/120m sync command in tmux
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

	// worker-idle finished prior task and is idle waiting for review/next assignment
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
		id: "goal-long-running",
		text: "Track long-running worker without false idle alarm",
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

	// Pump ticks (simulating 3 checks spaced 1s apart)
	await src.pumpRootMailbox(pi, ctx, p, "watchdog");
	await new Promise((r) => setTimeout(r, 1050));
	await src.pumpRootMailbox(pi, ctx, p, "watchdog");
	await new Promise((r) => setTimeout(r, 1050));
	await src.pumpRootMailbox(pi, ctx, p, "watchdog");

	const sentBodies = sentMessages.map((m) => JSON.stringify(m));

	// 1. Must NOT emit false alarm saying all agents are idle
	ok(
		"no false alarm claiming all non-root agents have been idle",
		!sentBodies.some((b) => b.includes("All 1 non-root agent(s) have been idle") || (b.includes("Idle streak") && b.includes("has no active work"))),
		sentBodies.join("\n"),
	);

	// 2. Must emit an actionable health-check nudge for worker-long
	ok(
		"emitted health check for long-running worker-long",
		sentBodies.some((b) => b.includes("[Health Check]") && b.includes("worker-long")),
		sentBodies.join("\n"),
	);

	// 3. Health check body must guide Root to capture pane output
	ok(
		"health check suggests checking tmux capture-pane",
		sentBodies.some((b) => b.includes("tmux capture-pane -t pi-swarm:worker-long.0")),
		sentBodies.join("\n"),
	);
} finally {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
