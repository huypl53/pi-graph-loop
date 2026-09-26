#!/usr/bin/env node
/**
 * Test: Goal idle-streak nudge must NEVER count or fire while Root is actively working.
 * Swarm is only idle when BOTH workers AND Root are idle.
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

const dir = mkdtempSync(join(tmpdir(), "root-busy-goal-nudge-"));
const p = paths(dir);
await ensureDirs(p);

try {
	const nowMs = Date.now();
	const t0 = new Date(nowMs).toISOString();

	const st = await readState(p, dir);
	ensureRoot(st, dir, p);

	// Both workers are currently idle waiting for assignments
	st.agents["worker-1"] = {
		id: "worker-1",
		role: "worker-1",
		roleKind: "worker",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxAlive: true,
		tmuxTarget: "sess:worker-1.0",
		model: "mock",
		provider: "mock-llm",
		lastHeartbeatAt: t0,
		createdAt: t0,
		updatedAt: t0,
	};
	st.agents["worker-2"] = {
		id: "worker-2",
		role: "worker-2",
		roleKind: "worker",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxAlive: true,
		tmuxTarget: "sess:worker-2.0",
		model: "mock",
		provider: "mock-llm",
		lastHeartbeatAt: t0,
		createdAt: t0,
		updatedAt: t0,
	};

	st.goal = {
		id: "goal-root-busy",
		text: "Goal while root is actively planning",
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

	// Root is actively executing a turn (e.g. drafting tasks, calling tools, running bash)
	const ctx = {
		cwd: dir,
		mode: "tui",
		isIdle: () => false, // Root is BUSY!
	};

	// Pump ticks (simulating 3 watchdog checks 1s apart while Root is working)
	await src.pumpRootMailbox(pi, ctx, p, "watchdog");
	await new Promise((r) => setTimeout(r, 1050));
	await src.pumpRootMailbox(pi, ctx, p, "watchdog");
	await new Promise((r) => setTimeout(r, 1050));
	await src.pumpRootMailbox(pi, ctx, p, "watchdog");

	const finalState = await readState(p, dir);
	const idleMessages = Object.values(finalState.messages || {}).filter((m) => m.idempotencyKey?.includes(":nudge:idle-streak:"));

	// Assertions:
	// 1. Root is busy, so NO goal idle nudge should be enqueued in mailbox
	ok(
		"no goal idle nudge queued in mailbox while root is busy",
		idleMessages.length === 0,
		`found ${idleMessages.length} idle messages: ${JSON.stringify(idleMessages.map((m) => m.subject))}`,
	);

	// 2. No goal nudge should have been surfaced to Root
	ok("no goal nudge surfaced while root is busy", sentMessages.length === 0, `sentMessages=${sentMessages.length}`);

	// 3. The check streak must not accumulate while Root is busy
	ok(
		"goalIdleCheckCount does not climb while root is busy",
		(finalState.idleNudgeState?.goalIdleCheckCount ?? 0) === 0,
		`goalIdleCheckCount=${finalState.idleNudgeState?.goalIdleCheckCount}`,
	);
} finally {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {}
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
