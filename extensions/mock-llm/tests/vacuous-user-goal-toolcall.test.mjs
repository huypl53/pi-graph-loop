#!/usr/bin/env node
/**
 * vacuous-user-goal-toolcall — tmux-lane companion: proves the REAL tool path.
 *
 * Companion to vacuous-user-goal-nudge.test.mjs. That lane proves the seeded-world
 * emission wiring; THIS lane proves the production path a live user-goal actually
 * takes: the root LLM calls swarm_set_goal({origin: "user", setByScope:
 * "user-request"}) via a real tool_use turn (mock-llm fixture vacuous-user-goal-toolcall),
 * then the pump's solo route nudges. Seed: root + long-stopped worker (vacuous), NO goal.
 *
 * SKIP-by-default live lane (RUN_SOLO_GOAL_LANE=1); fixture-shape assertions always run.
 */

import { rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "vacuous-user-goal-toolcall.jsonl");
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

console.log("== vacuous-user-goal-toolcall fixture file shape ==");
ok("fixture file exists", existsSync(fixturePath));
const lines = existsSync(fixturePath)
	? readFileSync(fixturePath, "utf8")
			.split("\n")
			.filter((l) => l.trim() && !l.startsWith("#"))
	: [];
ok("fixture has 3 scripted turns", lines.length === 3, { lines: lines.length });
const turns = lines.map((l) => JSON.parse(l));
const tc = turns[0]?.events?.find((e) => e.type === "toolcall");
ok(
	"turn 0 carries a toolcall event (the -p lane's user-prompt turn)",
	Boolean(tc),
	turns[0]?.events?.map((e) => e.type),
);
ok("toolcall name === swarm_set_goal", tc?.name === "swarm_set_goal", tc?.name);
ok("toolcall origin === user", tc?.arguments?.origin === "user", tc?.arguments?.origin);

if (process.env.RUN_SOLO_GOAL_LANE !== "1") {
	console.log(`\n(skipping live lane — set RUN_SOLO_GOAL_LANE=1 to execute the full E2E scenario)`);
	console.log(`VACUOUS-USER-GOAL-TOOLCALL FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
	process.exit(fail === 0 ? 0 : 1);
}

// === Live E2E lane (real swarm_set_goal tool call via mock-llm toolcall turn) ===
console.log("\n== Live E2E lane ==");
const scratch = join(tmpdir(), `swarm-solo-toolcall-lane-${process.pid}-${Date.now()}`);

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
	tmuxSession: "solo-toolcall-lane",
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

st.agents["worker-stopped"] = {
	id: "worker-stopped",
	role: "implementer",
	roleKind: "implementer",
	roleKindExplicit: true,
	tmuxTarget: "sv:worker.0",
	tmuxSession: "sv",
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

// NO seeded goal — the tool turn creates it (the production path under test).
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
		"vacuous-user-goal-toolcall",
		"-p",
		"set the goal via the tool",
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

const events = readJsonl(eventsFile);
const goalSet = events.find((e) => e.event === "goal.set");
ok("[live lane] goal.set fired via the real tool", Boolean(goalSet), events.map((e) => e.event).slice(-10));
ok("[live lane] goal.set origin === user", goalSet?.origin === "user", goalSet?.origin);
ok("[live lane] goal.set via === tool", goalSet?.via === "tool", goalSet?.via);

const nudge = events.find((e) => e.event === "goal.idle_nudge");
ok("[live lane] goal.idle_nudge fired after the tool-set goal", Boolean(nudge), events.map((e) => e.event).slice(-10));
ok("[live lane] nudge route === solo_vacuous", nudge?.route === "solo_vacuous", nudge?.route);

const mb = readJsonl(mailboxFile);
const nudgeMsg = mb.find((m) => /Idle streak: goal/.test(String(m.subject)));
ok(
	"[live lane] idle-streak nudge in root mailbox",
	Boolean(nudgeMsg),
	mb.map((m) => m.subject),
);
ok(
	"[live lane] nudge key family === NOTIFY_KEY_GOAL_IDLE_NUDGE",
	/^goal:[^:]+:nudge:idle-streak:1$/.test(String(nudgeMsg?.idempotencyKey || "")),
	nudgeMsg?.idempotencyKey,
);

console.log(`\nVACUOUS-USER-GOAL-TOOLCALL FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
