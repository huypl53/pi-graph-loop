#!/usr/bin/env node
/**
 * goal-escalation-deadpane — scratch-cell lane for the mock-LLM fixture scenario.
 *
 * Plan §3.7 acceptance: end-to-end scenario via the mock-LLM fixture. Strategy:
 *   - Use real `pi --provider mock-llm --model goal-escalation-deadpane` against a scratch
 *     cwd, with PI_SWARM_AGENT_ID=root.
 *   - Seed the swarm state with: root pseudo-agent + a user-origin goal + a busy-but-dead-pane
 *     worker (runtimeStatus=busy, fresh heartbeat, tmuxTarget=goal-deadpane-probe:9999.0 —
 *     does not exist in this lane, so the real tmux probe returns dead deterministically).
 *   - Let the lane run to terminal (3 turns). After the pump tick fires, the
 *     goal.escalation.pool_empty trace should fire with cause=busy_dead_pane and the
 *     high-priority escalation message should be appended to the root mailbox.
 *
 * Pattern 2 (seeded world + single-actor script) per the mock-llm-scenarios skill: the
 * engine does the real work, the scripted turns just give the lane a clean terminal.
 *
 * This is a SKIP-by-default companion test. Set RUN_DEADPANE_LANE=1 to actually exec
 * pi and validate; otherwise the file just verifies the fixture exists and is
 * well-formed.
 */

import { rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "goal-escalation-deadpane.jsonl");
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

console.log("== goal-escalation-deadpane fixture file shape ==");
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

if (process.env.RUN_DEADPANE_LANE !== "1") {
	console.log(`\n(skipping live lane — set RUN_DEADPANE_LANE=1 to execute the full E2E scenario)`);
	console.log(`GOAL-ESCALATION-DEADPANE FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
	process.exit(fail === 0 ? 0 : 1);
}

// === Live E2E lane (opt-in via RUN_DEADPANE_LANE=1) ===
console.log("\n== Live E2E lane ==");
const scratch = join(tmpdir(), `swarm-deadpane-lane-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi", "swarm", "mailboxes"), { recursive: true });
mkdirSync(join(scratch, ".pi", "swarm", "traces"), { recursive: true });

// Seed state with: root pseudo-agent + a user-origin goal + a busy-but-dead-pane worker
const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");

const { ensureDirs, paths, defaultState } = await import(join(repoRoot, "extensions/swarm/src/state.ts"));
await ensureDirs(paths(scratch));

const st = defaultState(scratch);
const now = new Date().toISOString();
const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();
const sixtySecAgo = new Date(Date.now() - 60_000).toISOString();

st.agents["root"] = {
	id: "root",
	role: "root",
	roleKind: "root",
	roleKindExplicit: true,
	tmuxTarget: "unknown",
	tmuxSession: "deadpane-lane",
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

// Seed the busy-but-dead-pane worker: runtimeStatus=busy, fresh heartbeat (60s ago),
// tmuxTarget=goal-deadpane-probe:9999.0 — does not exist in this lane, so the real
// tmux probe returns dead deterministically.
st.agents["worker-dead"] = {
	id: "worker-dead",
	role: "implementer",
	roleKind: "implementer",
	roleKindExplicit: true,
	tmuxTarget: "goal-deadpane-probe:9999.0",
	tmuxSession: "goal-deadpane-probe",
	tmuxWindow: "worker-dead",
	mailbox: ".pi/swarm/mailboxes/worker-dead.jsonl",
	capabilities: [],
	status: "running",
	runtimeStatus: "busy",
	health: "healthy",
	tmuxAlive: true,
	createdAt: thirtyMinAgo,
	updatedAt: sixtySecAgo,
	lastHeartbeatAt: sixtySecAgo,
	activeTaskIds: [],
};

// Seed the user-origin goal (set 30min ago, past any grace)
st.goal = {
	id: "goal-deadpane-lane",
	text: "Ship the dead-pane classifier fix",
	origin: "user",
	setAt: thirtyMinAgo,
	consecutiveNoResolveNudges: 0,
};

writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");

// Run the lane — mirror reviewer-lane-probe.mjs recipe: scratch cwd, -ne, absolute -e paths,
// env hygiene (set PI_SWARM_AGENT_ID=root, PI_SWARM_IS_ROOT=1).
const env = { ...process.env };
env.PI_SWARM_AGENT_ID = "root";
env.PI_SWARM_IS_ROOT = "1";
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
		"goal-escalation-deadpane",
		"-p",
		"idle",
	],
	{ cwd: scratch, env, timeout: 30_000, encoding: "utf8" },
);

// After the lane, the goal.escalation.pool_empty trace should have fired with cause=busy_dead_pane
// and the high-priority escalation message should be appended to the root mailbox.
const eventsFile = join(scratch, ".pi/swarm/traces/events.jsonl");
const mailboxFile = join(scratch, ".pi/swarm/mailboxes/root.jsonl");

if (existsSync(eventsFile)) {
	const events = readFileSync(eventsFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	const esc = events.find((e) => e.event === "goal.escalation.pool_empty");
	ok("[live lane] goal.escalation.pool_empty trace fired", Boolean(esc), events.map((e) => e.event));
	ok("[live lane] escalation cause === 'busy_dead_pane'", esc?.cause === "busy_dead_pane", esc?.cause);
	const diagRow = esc?.poolDiag?.find((d) => d.id === "worker-dead");
	ok("[live lane] poolDiag row classifies worker-dead as 'busy_dead_pane'", diagRow?.classification === "busy_dead_pane", diagRow);
	ok("[live lane] poolDiag row carries fresh paneAlive === false (probe beat the cache)", diagRow?.paneAlive === false, diagRow);
} else {
	ok("[live lane] events.jsonl was created", false);
}

if (existsSync(mailboxFile)) {
	const mb = readFileSync(mailboxFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	const escMsg = mb.find((m) => /Goal escalation: worker pool empty/.test(String(m.subject)));
	ok("[live lane] high-priority escalation message appended to root mailbox", Boolean(escMsg), mb.map((m) => m.subject));
	ok("[live lane] escalation priority === 'high'", escMsg?.priority === "high", escMsg?.priority);
	ok(
		"[live lane] escalation body names the dead worker + restart hint",
		Boolean(escMsg) && String(escMsg.body).includes("worker-dead") && /swarm_spawn_agent|swarm_restart_agent/.test(String(escMsg.body)),
		escMsg?.body?.slice(0, 300),
	);
} else {
	ok("[live lane] root mailbox was created", false);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\nGOAL-ESCALATION-DEADPANE FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
