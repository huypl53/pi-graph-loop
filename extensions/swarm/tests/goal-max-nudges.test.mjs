#!/usr/bin/env node
import { rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `goal-max-nudges-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi", "swarm"), { recursive: true });

process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
process.env.PI_SWARM_GOAL_IDLE_CHECK_INTERVAL_MS = "10";
process.env.PI_SWARM_GOAL_IDLE_CHECKS_REQUIRED = "1";

const tools = {};
const commands = {};
const notifications = [];
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: (name, def) => {
		commands[name] = def;
	},
	on: () => {},
	sendMessage: () => {},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};

const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;
factory(pi);

const { paths, readState, writeState, ensureDirs } = await import(join(here, "..", "src", "state.ts"));
const { ensureRoot } = await import(join(here, "..", "src", "identity.ts"));
const { resolveGoalMaxNudges, evaluateIdleGoalNudgeLocked } = await import(join(here, "..", "src", "reconcile.ts"));

const p = paths(scratch);
await ensureDirs(p);
{
	const st0 = await readState(p, scratch);
	ensureRoot(st0, scratch, p);
	await writeState(p, st0);
}

let pass = 0,
	fail = 0;
const ok = (n, c, info) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n, info ?? "");
	}
};

const fakeCtx = {
	cwd: scratch,
	ui: {
		notify: (msg, type) => {
			notifications.push({ msg, type });
		},
	},
};

console.log("\n[1] resolveGoalMaxNudges pure helper");
ok("resolveGoalMaxNudges(undefined) === 3", resolveGoalMaxNudges(undefined) === 3);
ok("resolveGoalMaxNudges(5) === 5", resolveGoalMaxNudges(5) === 5);
ok("resolveGoalMaxNudges(-1) === -1", resolveGoalMaxNudges(-1) === -1);
ok("resolveGoalMaxNudges(0) === 3", resolveGoalMaxNudges(0) === 3);
ok("resolveGoalMaxNudges(-2) === 3", resolveGoalMaxNudges(-2) === 3);

console.log("\n[2] swarm_set_goal tool supports maxNudges");
await tools.swarm_set_goal.execute("call1", { text: "Goal 5 nudges", maxNudges: 5 }, undefined, undefined, { cwd: scratch });
{
	const st = await readState(p, scratch);
	ok("st.goal.maxNudges === 5", st.goal?.maxNudges === 5);
}

await tools.swarm_set_goal.execute("call2", { text: "Infinite goal", maxNudges: -1 }, undefined, undefined, { cwd: scratch });
{
	const st = await readState(p, scratch);
	ok("st.goal.maxNudges === -1 (infinite)", st.goal?.maxNudges === -1);
}

let threwInvalid = false;
try {
	await tools.swarm_set_goal.execute("call3", { text: "Invalid goal", maxNudges: -2 }, undefined, undefined, { cwd: scratch });
} catch (err) {
	threwInvalid = true;
}
ok("swarm_set_goal with maxNudges: -2 throws", threwInvalid);

console.log("\n[3] /swarm goal nudges subcommand");
notifications.length = 0;
await commands.swarm.handler("goal nudges", fakeCtx);
const showNotif = notifications[notifications.length - 1]?.msg || "";
ok("/swarm goal nudges displays current max nudges", showNotif.includes("infinite (-1)") || showNotif.includes("-1"));

notifications.length = 0;
await commands.swarm.handler("goal nudges 10", fakeCtx);
const setNotif = notifications[notifications.length - 1]?.msg || "";
ok("/swarm goal nudges 10 notifies success", setNotif.includes("updated to 10"));
{
	const st = await readState(p, scratch);
	ok("st.goal.maxNudges === 10 after /swarm goal nudges 10", st.goal?.maxNudges === 10);
}

notifications.length = 0;
await commands.swarm.handler("goal nudges -1", fakeCtx);
const setInfNotif = notifications[notifications.length - 1]?.msg || "";
ok("/swarm goal nudges -1 notifies infinite", setInfNotif.includes("infinite (-1)"));
{
	const st = await readState(p, scratch);
	ok("st.goal.maxNudges === -1 after /swarm goal nudges -1", st.goal?.maxNudges === -1);
}

notifications.length = 0;
await commands.swarm.handler("goal nudges invalid", fakeCtx);
const warnNotif = notifications[notifications.length - 1]?.msg || "";
ok("/swarm goal nudges invalid warns usage", warnNotif.includes("Usage:"));

console.log("\n[4] /swarm goal set and update with -n flag");
notifications.length = 0;
await commands.swarm.handler("goal set -n 7 Fresh goal with 7 nudges", fakeCtx);
{
	const st = await readState(p, scratch);
	ok("goal set with -n 7 sets maxNudges = 7", st.goal?.maxNudges === 7);
}

notifications.length = 0;
await commands.swarm.handler("goal update -n -1", fakeCtx);
{
	const st = await readState(p, scratch);
	ok("goal update with -n -1 sets maxNudges = -1", st.goal?.maxNudges === -1);
}

console.log("\n[5] evaluateIdleGoalNudgeLocked with maxNudges = -1 (infinite)");
{
	const st = await readState(p, scratch);
	const ts = new Date().toISOString();
	st.agents["worker-1"] = {
		id: "worker-1",
		role: "worker role",
		roleKind: "worker",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxSession: st.tmuxSession,
		tmuxWindow: "worker-1",
		tmuxTarget: "sess:worker-1.0",
		model: "glm-5.1",
		provider: "zai-coding-cn",
		cwd: scratch,
		mailbox: ".pi/swarm/mailboxes/worker-1.jsonl",
		createdAt: ts,
		updatedAt: ts,
		lastHeartbeatAt: ts,
	};
	st.goal = {
		id: "goal-inf-test",
		text: "Infinite nudges test goal",
		setAt: new Date(Date.now() - 60000).toISOString(),
		setBy: "root",
		consecutiveNoResolveNudges: 0,
		maxNudges: -1,
	};
	st.idleNudgeState = {
		allIdleSinceAt: new Date(Date.now() - 60000).toISOString(),
	};
	await writeState(p, st);

	// Run 5 consecutive nudges - all 5 MUST emit without hitting max_nudges or backoff!
	let allEmitted = true;
	for (let i = 0; i < 5; i++) {
		const nowMs = Date.now() + i * 1000;
		// Advance lastCheck to satisfy debounce
		st.idleNudgeState.goalIdleLastCheckAt = new Date(nowMs - 50).toISOString();
		const res = await evaluateIdleGoalNudgeLocked(pi, scratch, p, st, nowMs);
		if (!res.emitted) {
			console.error(`Tick ${i + 1} failed to emit:`, res.reason);
			allEmitted = false;
			break;
		}
	}
	ok("maxNudges: -1 allows 5+ consecutive emissions past default 3 cap", allEmitted);
	ok("consecutiveNoResolveNudges climbed to 5", st.goal.consecutiveNoResolveNudges === 5);
}

console.log("\n[6] evaluateIdleGoalNudgeLocked with custom maxNudges = 2");
{
	const st = await readState(p, scratch);
	st.goal = {
		id: "goal-custom-2",
		text: "Cap at 2 goal",
		setAt: new Date(Date.now() - 60000).toISOString(),
		setBy: "root",
		consecutiveNoResolveNudges: 0,
		maxNudges: 2,
	};
	st.idleNudgeState = {
		allIdleSinceAt: new Date(Date.now() - 60000).toISOString(),
	};
	await writeState(p, st);

	// Nudge 1
	st.idleNudgeState.goalIdleLastCheckAt = new Date(Date.now() - 50).toISOString();
	const res1 = await evaluateIdleGoalNudgeLocked(pi, scratch, p, st, Date.now());
	ok("nudge 1 emitted", res1.emitted === true);

	// Nudge 2
	st.idleNudgeState.goalIdleLastCheckAt = new Date(Date.now() + 950).toISOString();
	const res2 = await evaluateIdleGoalNudgeLocked(pi, scratch, p, st, Date.now() + 1000);
	ok("nudge 2 emitted", res2.emitted === true);

	// Nudge 3 should be capped at 2!
	st.idleNudgeState.goalIdleLastCheckAt = new Date(Date.now() + 1950).toISOString();
	const res3 = await evaluateIdleGoalNudgeLocked(pi, scratch, p, st, Date.now() + 2000);
	ok("nudge 3 is capped (emitted: false, reason: max_nudges)", res3.emitted === false && res3.reason === "max_nudges");
}

console.log(`\nRESULTS: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
