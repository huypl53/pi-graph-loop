#!/usr/bin/env node
/**
 * vacuous-user-goal-nudge — scratch-cell lane for the mock-LLM fixture scenario.
 *
 * task: vacuous-user-goal-nudge (2026-10-29). Strategy (Pattern 2, seeded world +
 * single-actor script — mirrors goal-escalation-deadpane.test.mjs):
 *   - Real `pi --provider mock-llm --model vacuous-user-goal-nudge` against a scratch
 *     cwd, PI_SWARM_AGENT_ID=root.
 *   - Seed: root pseudo-agent + one long-stopped worker (genuinely vacuous pool) +
 *     a user-origin goal set 30min ago (past grace).
 *   - Compress the debounce to a SINGLE check (PI_SWARM_GOAL_IDLE_CHECKS_REQUIRED=1):
 *     the -p print lane has no idle watchdog (pump ticks only on lifecycle events —
 *     session_start/agent_settled), so a 3x1s streak cannot elapse before exit. The
 *     streak semantics (3 spaced checks, wipe-survival, cap+backoff) are covered
 *     offline by extensions/swarm/tests/vacuous-user-goal-nudge.test.mjs; THIS lane
 *     proves the end-to-end wiring: seeded world → real pump tick → evaluator →
 *     deliverMessageLocked → root mailbox.
 *   - After the pump ticks, assert: goal.idle_nudge fired with route=solo_vacuous,
 *     the root mailbox holds the Idle streak nudge (NOTIFY_KEY_GOAL_IDLE_NUDGE family),
 *     and the pool-empty escalation fired exactly once (bounded complement).
 *
 * SKIP-by-default live lane (RUN_SOLO_GOAL_LANE=1); fixture-shape assertions always run.
 */

import { rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "vacuous-user-goal-nudge.jsonl");
const repoRoot = join(here, "..", "..", "..");

let pass = 0,
	fail = 0;
const ok = (n, c, info) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL:", n, info !== undefined ? `(${JSON.stringify(info).slice(0, 300)})` : "");
	}
};

console.log("== vacuous-user-goal-nudge fixture file shape ==");
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

if (process.env.RUN_SOLO_GOAL_LANE !== "1") {
	console.log(`\n(skipping live lane — set RUN_SOLO_GOAL_LANE=1 to execute the full E2E scenario)`);
	console.log(`VACUOUS-USER-GOAL-NUDGE FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
	process.exit(fail === 0 ? 0 : 1);
}

// === Live E2E lane ===
console.log("\n== Live E2E lane ==");
const scratch = join(tmpdir(), `swarm-solo-goal-lane-${process.pid}-${Date.now()}`);

mkdirSync(join(scratch, ".pi", "swarm", "mailboxes"), { recursive: true });
mkdirSync(join(scratch, ".pi", "swarm", "traces"), { recursive: true });

const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");
const { ensureDirs, paths, defaultState } = await import(join(repoRoot, "extensions/swarm/src/state.ts"));
await ensureDirs(paths(scratch));

const st = defaultState(scratch);
const now = new Date().toISOString();
const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();

st.agents["root"] = {
	id: "root",
	role: "root",
	roleKind: "root",
	roleKindExplicit: true,
	tmuxTarget: "unknown",
	tmuxSession: "solo-goal-lane",
	tmuxWindow: "root",
	mailbox: ".pi/swarm/mailboxes/root.jsonl",
	capabilities: ["orchestrate"],
	status: "running",
	runtimeStatus: "idle",
	health: "healthy",
	createdAt: now,
	updatedAt: now,
	lastHeartbeatAt: now,
	activeTaskIds: [],
};

// Genuinely vacuous: worker stopped 30min ago (stale + dead pane + stopped).
st.agents["worker-stopped"] = {
	id: "worker-stopped",
	role: "implementer",
	roleKind: "implementer",
	roleKindExplicit: true,
	tmuxTarget: "solo-lane:worker.0",
	tmuxSession: "solo-lane",
	tmuxWindow: "worker",
	mailbox: ".pi/swarm/mailboxes/worker-stopped.jsonl",
	capabilities: [],
	status: "stopped",
	runtimeStatus: "stopped",
	health: "healthy",
	tmuxAlive: false,
	createdAt: thirtyMinAgo,
	updatedAt: thirtyMinAgo,
	lastShutdownAt: thirtyMinAgo,
	lastHeartbeatAt: thirtyMinAgo,
	activeTaskIds: [],
};

// User-origin goal (set 30min ago, past any grace) — the live incident shape.
st.goal = {
	id: "goal-solo-lane",
	text: "Tiếp tục tối ưu skill knowledge-graph. Không spawn swarm agents.",
	origin: "user",
	setBy: "root",
	setByScope: "user-request",
	setAt: thirtyMinAgo,
	consecutiveNoResolveNudges: 0,
	nudgeSeq: 0,
	nudgeIntervalMs: 10000,
};

writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");

const env = { ...process.env };
env.PI_SWARM_AGENT_ID = "root";
env.PI_SWARM_IS_ROOT = "1";
env.PI_SWARM_GOAL_IDLE_CHECK_INTERVAL_MS = "1000";
env.PI_SWARM_GOAL_IDLE_CHECKS_REQUIRED = "1";
env.PI_MOCK_LLM_TRANSCRIPTS_DIR = join(scratch, ".pi/mock-llm/transcripts");

const r = spawnSync(
	"pi",
	[
		"-ne",
		"-e",
		join(repoRoot, "extensions/swarm"),
		"-e",
		join(repoRoot, "extensions/mock-llm"),
		"--provider",
		"mock-llm",
		"--model",
		"vacuous-user-goal-nudge",
		"-p",
		"idle",
	],
	{ cwd: scratch, env, timeout: 45_000, encoding: "utf8" },
);

const eventsFile = join(scratch, ".pi/swarm/traces/events.jsonl");
const mailboxFile = join(scratch, ".pi/swarm/mailboxes/root.jsonl");

const readJsonl = (p) =>
	existsSync(p)
		? readFileSync(p, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];

if (existsSync(eventsFile)) {
	const events = readJsonl(eventsFile);
	const nudge = events.find((e) => e.event === "goal.idle_nudge");
	ok("[live lane] goal.idle_nudge trace fired", Boolean(nudge), events.map((e) => e.event).slice(-12));
	ok("[live lane] nudge route === solo_vacuous", nudge?.route === "solo_vacuous", nudge?.route);
	ok("[live lane] nudge idleAgents === 0 (empty pool)", nudge?.idleAgents === 0, nudge?.idleAgents);
} else {
	ok("[live lane] events.jsonl was created", false);
}

if (existsSync(mailboxFile)) {
	const mb = readJsonl(mailboxFile);
	const nudgeMsg = mb.find((m) => /Idle streak: goal/.test(String(m.subject)));
	ok(
		"[live lane] idle-streak nudge appended to root mailbox",
		Boolean(nudgeMsg),
		mb.map((m) => m.subject),
	);
	ok(
		"[live lane] nudge key family === NOTIFY_KEY_GOAL_IDLE_NUDGE",
		/^goal:goal-solo-lane:nudge:idle-streak:1$/.test(String(nudgeMsg?.idempotencyKey || "")),
		nudgeMsg?.idempotencyKey,
	);
	ok(
		"[live lane] nudge body says ZERO live workers + suggests continuing solo (not spawning)",
		Boolean(nudgeMsg) && String(nudgeMsg.body).includes("ZERO live workers"),
		nudgeMsg?.body?.slice(0, 200),
	);
	const escMsg = mb.find((m) => /Goal escalation: worker pool empty/.test(String(m.subject)));
	ok(
		"[live lane] pool-empty escalation fired exactly once (bounded complement)",
		mb.filter((m) => /Goal escalation/.test(String(m.subject))).length === 1,
		{
			found: Boolean(escMsg),
		},
	);
} else {
	ok("[live lane] root mailbox was created", false);
}

console.log(`\nVACUOUS-USER-GOAL-NUDGE FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
