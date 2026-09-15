#!/usr/bin/env node
/**
 * Test: Reset idle epoch and goalIdleCheckCount whenever any agent leaves settled / becomes busy.
 *
 * Covers:
 * 1. Root turn_start (Root busy edge) resets goalIdleCheckCount and idle epoch so old streaks do not leak.
 * 2. Worker agent_start / tool_call resets goalIdleCheckCount and idle epoch immediately.
 * 3. Subsequent idle checks measure from zero, preventing premature goal nudges.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PI_SWARM_GOAL_IDLE_CHECK_INTERVAL_MS = "1000";
process.env.PI_SWARM_GOAL_IDLE_CHECKS_REQUIRED = "3";

const here = dirname(fileURLToPath(import.meta.url));
const { paths, readState, withLock, writeState, ensureDirs } = await import(join(here, "..", "src", "state.ts"));
const { evaluateIdleGoalNudgeLocked } = await import(join(here, "..", "src", "reconcile.ts"));
const { ensureRoot } = await import(join(here, "..", "src", "identity.ts"));
const { registerSwarmHooks } = await import(join(here, "..", "src", "hooks.ts"));

const dir = await mkdtemp(join(tmpdir(), "idle-streak-reset-"));
await mkdir(join(dir, ".pi"), { recursive: true });
await writeFile(
	join(dir, ".pi", "settings.json"),
	JSON.stringify({ swarm: { defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" } }),
);
process.chdir(dir);
const p = paths(dir);
await ensureDirs(p);

const sentMessages = [];
const pi = {
	registerTool: () => {},
	registerCommand: () => {},
	on: () => {},
	setModel: async () => true,
	sendMessage: (m, o) => {
		sentMessages.push({ m, o });
	},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};

let pass = 0;
let fail = 0;
const ok = (n, c, info) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL:", n, info ?? "");
	}
};

const handlers = {};
const hpi = {
	on: (ev, fn) => {
		(handlers[ev] ||= []).push(fn);
	},
	registerTool() {},
	registerCommand() {},
	exec: pi.exec,
	setModel: pi.setModel,
	sendMessage: pi.sendMessage,
};
registerSwarmHooks(hpi);

console.log("\n[Test 1] Root turn_start resets goalIdleCheckCount to prevent streak leakage");
{
	const t0 = Date.now();
	process.env.PI_SWARM_IS_ROOT = "1";
	delete process.env.PI_SWARM_AGENT_ID;

	await withLock(p, async () => {
		const st = await readState(p, dir);
		ensureRoot(st, dir, p);
		st.goal = {
			id: "g-streak-1",
			text: "Goal 1",
			setAt: new Date(t0 - 3_600_000).toISOString(),
			setBy: "root",
			consecutiveNoResolveNudges: 0,
			nudgeSeq: 0,
			nudgeIntervalMs: 30_000,
		};
		st.agents["worker-1"] = {
			id: "worker-1",
			role: "worker",
			status: "running",
			runtimeStatus: "idle",
			tmuxAlive: true,
			lastHeartbeatAt: new Date(t0).toISOString(),
			activeTaskIds: [],
		};
		// Seed 2 accumulated idle checks from the prior epoch
		st.idleNudgeState = {
			allIdleSinceAt: new Date(t0 - 20_000).toISOString(),
			goalIdleCheckCount: 2,
		};
		await writeState(p, st);
	});

	// Trigger turn_start for Root
	await handlers["turn_start"][0]({ turnIndex: 0 }, { cwd: dir });

	const st = await readState(p, dir);
	ok(
		"turn_start (root) clears goalIdleCheckCount",
		st.idleNudgeState?.goalIdleCheckCount === undefined,
		`actual goalIdleCheckCount: ${st.idleNudgeState?.goalIdleCheckCount}`,
	);
	ok(
		"turn_start (root) clears allIdleSinceAt",
		st.idleNudgeState?.allIdleSinceAt === undefined,
		`actual allIdleSinceAt: ${st.idleNudgeState?.allIdleSinceAt}`,
	);

	// Root finishes turn and agents settle
	await withLock(p, async () => {
		const s = await readState(p, dir);
		s.idleNudgeState = { allIdleSinceAt: new Date(t0).toISOString() };
		await writeState(p, s);
	});

	// 1 sample after root turn finishes: must be count=1, NOT count=3 (which would prematurely emit)
	const s0 = await readState(p, dir);
	const r1 = await evaluateIdleGoalNudgeLocked(pi, dir, p, s0, t0 + 1000);
	ok(
		"first check after root busy is pending (count=1), not premature emission",
		r1.emitted === false && r1.reason === "idle_interval_pending",
		`r1 result: ${JSON.stringify(r1)}`,
	);
	ok(
		"goalIdleCheckCount is 1 (restarted from 0)",
		s0.idleNudgeState?.goalIdleCheckCount === 1,
		`actual count: ${s0.idleNudgeState?.goalIdleCheckCount}`,
	);
}

console.log("\n[Test 2] Worker agent_start resets goalIdleCheckCount immediately");
{
	const t0 = Date.now();
	process.env.PI_SWARM_AGENT_ID = "worker-1";
	delete process.env.PI_SWARM_IS_ROOT;

	await withLock(p, async () => {
		const st = await readState(p, dir);
		st.idleNudgeState = {
			allIdleSinceAt: new Date(t0 - 20_000).toISOString(),
			goalIdleCheckCount: 2,
		};
		await writeState(p, st);
	});

	// Trigger agent_start for Worker
	await handlers["agent_start"][0]({}, { cwd: dir });

	const st = await readState(p, dir);
	ok(
		"agent_start (worker) clears goalIdleCheckCount immediately",
		st.idleNudgeState?.goalIdleCheckCount === undefined,
		`actual goalIdleCheckCount: ${st.idleNudgeState?.goalIdleCheckCount}`,
	);
	ok(
		"agent_start (worker) clears allIdleSinceAt immediately",
		st.idleNudgeState?.allIdleSinceAt === undefined,
		`actual allIdleSinceAt: ${st.idleNudgeState?.allIdleSinceAt}`,
	);
}

console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
