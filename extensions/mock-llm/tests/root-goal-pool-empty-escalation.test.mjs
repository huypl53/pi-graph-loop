#!/usr/bin/env node
/**
 * root-goal-pool-empty-escalation — scratch-cell lane for the mock-LLM fixture scenario.
 *
 * Plan §6.3 acceptance: end-to-end scenario via the mock-LLM fixture. Strategy:
 *   - Use real `pi --provider mock-llm --model root-goal-pool-empty-escalation` against a scratch
 *     cwd, with PI_SWARM_AGENT_ID=root.
 *   - Seed the swarm state with: root pseudo-agent + a root-origin goal + 3 dead workers
 *     (genuinely-vacuous base).
 *   - Let the lane run to terminal (3 turns). After the pump tick fires, the
 *     goal.escalation.pool_empty trace should fire with cause=pool_empty and the
 *     high-priority escalation message should be appended to the root mailbox.
 *
 * Pattern 2 (seeded world + single-actor script) per the mock-llm-scenarios skill: the
 * engine does the real work, the scripted turns just give the lane a clean terminal.
 *
 * This is a SKIP-by-default companion test. Set RUN_ROOT_GOAL_POOL_LANE=1 to actually exec
 * pi and validate; otherwise the file just verifies the fixture exists and is
 * well-formed.
 */

import { rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "root-goal-pool-empty-escalation.jsonl");
const repoRoot = join(here, "..", "..", "..");

let pass = 0,
	fail = 0;
const ok = (n, c, info) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n, info !== undefined ? `(${JSON.stringify(info).slice(0, 200)})` : "");
	}
};

console.log("== root-goal-pool-empty-escalation fixture file shape ==");
ok("fixture file exists", existsSync(fixturePath));
const lines = existsSync(fixturePath)
	? readFileSync(fixturePath, "utf8")
			.split("\n")
			.filter((l) => l.trim() && !l.startsWith("#"))
	: [];
ok("fixture has 3 scripted turns", lines.length === 3, { lines: lines.length });
const turns = lines.map((l) => JSON.parse(l));
ok("turn 0 = text", turns[0]?.events?.[0]?.type === "text");
ok("turn 1 = text", turns[1]?.events?.[0]?.type === "text");
ok("turn 2 = stop (terminal)", turns[2]?.stopReason === "stop" && turns[2]?.events?.some((e) => e.type === "stop"));

if (process.env.RUN_ROOT_GOAL_POOL_LANE !== "1") {
	console.log(`\n(skipping live lane — set RUN_ROOT_GOAL_POOL_LANE=1 to execute the full E2E scenario)`);
	console.log(`ROOT-GOAL-POOL-EMPTY-ESCALATION FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
	process.exit(fail === 0 ? 0 : 1);
}

// === Live E2E lane (opt-in via RUN_ROOT_GOAL_POOL_LANE=1) ===
console.log("\n== Live E2E lane ==");
const scratch = join(tmpdir(), `swarm-root-goal-pool-lane-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi", "swarm", "mailboxes"), { recursive: true });
mkdirSync(join(scratch, ".pi", "swarm", "traces"), { recursive: true });

// Seed state with: root pseudo-agent + a root-origin goal + 3 dead workers
const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");

const { ensureDirs, paths, defaultState } = await import(join(repoRoot, "extensions/swarm/src/state.ts"));
await ensureDirs(paths(scratch));

const st = defaultState(scratch);
const now = new Date().toISOString();
const fifteenMinAgo = new Date(Date.now() - 15 * 60_000).toISOString();

st.goal = {
	id: "goal-r27-lane",
	origin: "root",
	text: "R27 root-origin goal test (lane)",
	nudgeIntervalMs: 5000,
	setAt: fifteenMinAgo,
	consecutiveNoResolveNudges: 0,
};

for (let i = 1; i <= 3; i++) {
	st.agents[`worker-${i}`] = {
		id: `worker-${i}`,
		role: "implementer",
		roleKind: "implementer",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxAlive: false, // dead pane
		tmuxSession: "r27-lane",
		tmuxWindow: `worker-${i}`,
		tmuxTarget: `r27-lane:worker-${i}.0`,
		model: "mock",
		provider: "mock-llm",
		cwd: scratch,
		mailbox: `.pi/swarm/mailboxes/worker-${i}.jsonl`,
		createdAt: fifteenMinAgo,
		updatedAt: fifteenMinAgo,
		lastHeartbeatAt: fifteenMinAgo,
	};
}

writeFileSync(statePath, JSON.stringify(st, null, 2));

// Spawn the lane
const result = spawnSync(
	"pi",
	[
		"-ne",
		"-e",
		"extensions/swarm",
		"-e",
		"extensions/mock-llm",
		"--provider",
		"mock-llm",
		"--model",
		"root-goal-pool-empty-escalation",
		"-p",
		"idle",
	],
	{
		cwd: repoRoot,
		env: {
			...process.env,
			PI_SWARM_AGENT_ID: "root",
			PI_SWARM_IS_ROOT: "1",
			PI_SWARM_CWD: scratch,
		},
		stdio: "inherit",
		timeout: 120_000,
	},
);

ok("lane exit code === 0", result.status === 0, { status: result.status });

// Verify the escalation fired
const eventsPath = join(scratch, ".pi/swarm/traces/events.jsonl");
if (existsSync(eventsPath)) {
	const events = readFileSync(eventsPath, "utf8")
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
	const escalationTraces = events.filter((e) => e.event === "goal.escalation.pool_empty");
	ok("lane fired goal.escalation.pool_empty trace", escalationTraces.length >= 1, escalationTraces.length);
	ok("lane escalation origin === 'root'", escalationTraces[0]?.origin === "root", escalationTraces[0]?.origin);
	ok("lane escalation cause === 'pool_empty'", escalationTraces[0]?.cause === "pool_empty", escalationTraces[0]?.cause);
}

const mailboxPath = join(scratch, ".pi/swarm/mailboxes/root.jsonl");
if (existsSync(mailboxPath)) {
	const mailbox = readFileSync(mailboxPath, "utf8")
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
	const escMsg = mailbox.find((m) => /Goal escalation: worker pool empty/.test(String(m.subject)));
	ok("lane appended high-priority escalation message to root mailbox", Boolean(escMsg), mailbox.map((m) => m.subject));
	ok("lane escalation priority === 'high'", escMsg?.priority === "high", escMsg?.priority);
}

rmSync(scratch, { recursive: true, force: true });

console.log(`\nROOT-GOAL-POOL-EMPTY-ESCALATION FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
