#!/usr/bin/env node
/**
 * loop-repeat-lane.test.mjs — live mock-llm lanes for the loop-repeat guard v1.2
 * (task loop-repeat-guard, plan §3 + §5).
 *
 * Two REAL pi + mock-llm lanes in isolated scratch cwds, each asserting transcript
 * evidence at `.pi/mock-llm/transcripts/`:
 *
 *   1. positive (loop-bash-repeat-poll): 24 turns / 23 identical bash polls, lane env
 *      PI_SWARM_LOOP_REPEAT_WINDOW_MS=0 → nudges 1..3 fire mid-run (one turn_end continuation
 *      each, marker in the NEXT model request with role=user), exactly 3 continuations,
 *      milestone-4 boundary → exactly ONE root escalation (mailbox append), terminal stop.
 *   2. negative (loop-repeat-tdd-neg): 6 turns / 4 identical bash calls (count < 5) → ZERO
 *      nudge markers, zero continuations. R10-1 C-R10-1-2 zero-send control.
 *
 * The guard extension is the PRODUCTION swarm extension loaded via -e; a tiny lane ext
 * asserts the R10-1 boundary counter (loop_repeat.nudge / loop_repeat.escalated audit
 * records) at settle.
 *
 * ISOLATION: scratch cwd per lane (mkdtemp), seeded worker record so the guard observes the
 * scripted bash calls; PI_SWARM_AGENT_ID=worker-lane. PI_LOOP_REPEAT_LANES=0 skips the live
 * lanes (fixture-shape assertions only, deterministic offline gate).
 *
 * Run: node extensions/swarm/tests/loop-repeat-lane.test.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

let pass = 0;
let fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info !== undefined ? JSON.stringify(info).slice(0, 500) : "");
	}
};

const FIXTURES = {
	positive: "loop-bash-repeat-poll",
	negative: "loop-repeat-tdd-neg",
};
const NUDGE_FAMILY = "LOOP-REPEAT nudge";
const ESCALATION_FAMILY = "LOOP-REPEAT escalation";

// ============================================================================
// Fixture shape assertions (always run — cheap, deterministic)
// ============================================================================
function fixtureTurns(model) {
	const path = join(repoRoot, "extensions", "mock-llm", "fixtures", `${model}.jsonl`);
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.trim() && !l.startsWith("#"))
		.map((l) => JSON.parse(l));
}
function fixtureStats(model) {
	const turns = fixtureTurns(model);
	let bash = 0;
	let others = 0;
	let stops = 0;
	for (const t of turns) {
		if (t.stopReason === "stop") stops++;
		for (const e of t.events ?? []) {
			if (e.type === "toolcall") {
				if (e.name === "bash") bash++;
				else others++;
			}
		}
	}
	return { turns: turns.length, bash, others, stops };
}

console.log("== fixture shape ==");
const pStats = fixtureStats(FIXTURES.positive);
ok("positive fixture: 24 turns, 23 bash polls, terminal stop", pStats.turns === 24 && pStats.bash === 23 && pStats.stops === 1, pStats);
const nStats = fixtureStats(FIXTURES.negative);
ok("negative fixture: 6 turns, 4 bash calls + 1 edit, terminal stop", nStats.turns === 6 && nStats.bash === 4 && nStats.others === 1 && nStats.stops === 1, nStats);
ok("fixtures contain no nudge/escalation text (injected by the guard, not scripted)", ["positive", "negative"].every((k) => {
	const raw = readFileSync(join(repoRoot, "extensions", "mock-llm", "fixtures", `${FIXTURES[k]}.jsonl`), "utf8");
	return !raw.includes(NUDGE_FAMILY) && !raw.includes(ESCALATION_FAMILY);
}));

// ============================================================================
// Lane harness
// ============================================================================
const LANE_EXT = join(repoRoot, "extensions", "swarm", "tests", "fixtures", "loop-repeat-lane-ext.ts");

function seedWorker(scratch, agentId, taskId) {
	const stateDir = join(scratch, ".pi", "swarm");
	mkdirSync(stateDir, { recursive: true });
	const now = new Date().toISOString();
	writeFileSync(
		join(stateDir, "swarm-state.json"),
		JSON.stringify({
			version: 1,
			swarmId: "loop-repeat-lane",
			cwd: scratch,
			agents: {
				[agentId]: {
					id: agentId,
					role: "implementer",
					roleKind: "worker",
					capabilities: [],
					activeTaskIds: [taskId],
					maxConcurrentTasks: 1,
					status: "running",
					runtimeStatus: "busy",
					health: "healthy",
					pid: process.pid,
					createdAt: now,
					updatedAt: now,
				},
			},
			delivered: {},
			messages: {},
			createdAt: now,
			updatedAt: now,
		}),
	);
}

function runLane(model, { windowOverride = "0", keep = false } = {}) {
	const scratch = mkdtempSync(join(tmpdir(), `loop-repeat-lane-${model}-`));
	mkdirSync(join(scratch, ".pi", "mock-llm", "transcripts"), { recursive: true });
	mkdirSync(join(scratch, ".pi"), { recursive: true });
	writeFileSync(join(scratch, ".pi", "swarm.yml"), "terminalManager: tmux\n");
	seedWorker(scratch, "worker-lane", "task-lane-1");
	// Create a root.jsonl so the bash command has something to read
	writeFileSync(join(scratch, "root.jsonl"), "ready\n");

	const env = { ...process.env };
	env.PI_SWARM_AGENT_ID = "worker-lane";
	delete env.PI_SWARM_IS_ROOT;
	env.PI_SWARM_LOOP_REPEAT_WINDOW_MS = windowOverride; // lane command override only — never in fixtures
	env.PI_MOCK_LLM_TRANSCRIPTS_DIR = join(scratch, ".pi", "mock-llm", "transcripts");
	env.PI_LOOP_REPEAT_LANE_SCRATCH = scratch;

	const r = spawnSync(
		"pi",
		[
			"-ne",
			"-e",
			join(repoRoot, "extensions/mock-llm"),
			"-e",
			join(repoRoot, "extensions/swarm"),
			"-e",
			LANE_EXT,
			"--provider",
			"mock-llm",
			"--model",
			model,
			"-p",
			"run the loop-repeat lane",
		],
		{ cwd: scratch, env, timeout: 180_000, encoding: "utf8" },
	);
	return { r, scratch };
}

function readTranscripts(scratch, model) {
	const dir = join(scratch, ".pi", "mock-llm", "transcripts", model);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.sort()
		.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

function requestMarkerHits(transcripts, family) {
	return transcripts.filter((t) => (t?.request?.messages ?? []).some((m) => m.role === "user" && typeof m.preview === "string" && m.preview.includes(family)));
}

function nudgeKsInLastUserMessage(transcripts) {
	const ks = [];
	for (const t of transcripts) {
		const users = (t?.request?.messages ?? []).filter((m) => m.role === "user" && typeof m.preview === "string");
		const last = users.at(-1);
		if (!last) continue;
		const match = last.preview.match(/\[LOOP-REPEAT nudge (\d)\/3 — milestone (\d)\]/);
		if (match) ks.push(Number(match[2]));
	}
	return ks;
}

if (process.env.PI_LOOP_REPEAT_LANES === "0") {
	console.log("\n(skipping live lanes — PI_LOOP_REPEAT_LANES=0; fixture-shape assertions only)");
	console.log(`LOOP-REPEAT LANES ${fail === 0 ? "PASS (shape-only)" : "FAIL"} (${fail} failed, ${pass} passed)`);
	process.exit(fail === 0 ? 0 : 1);
}

// ============================================================================
// Lane 1: positive — nudges 1..3 mid-run + exactly ONE root escalation
// ============================================================================
console.log("\n== lane: positive (nudges 1..3 mid-run + root escalation) ==");
const positive = runLane(FIXTURES.positive);
const pt = readTranscripts(positive.scratch, FIXTURES.positive);
ok("positive lane produced transcripts", pt.length > 0, { stderr: positive.r.stderr?.slice(0, 300), status: positive.r.status });
const ptHits = requestMarkerHits(pt, NUDGE_FAMILY);
ok("nudge marker reached model requests (mid-run custom_message)", ptHits.length > 0, { hits: ptHits.length, total: pt.length });
const pCounts = existsSync(join(positive.scratch, "lane-counts.json")) ? JSON.parse(readFileSync(join(positive.scratch, "lane-counts.json"), "utf8")) : {};
ok("R10-1 durable nudge audit == 3 at the injection path (loop_repeat.nudge)", pCounts.nudges === 3, pCounts);
const ks = nudgeKsInLastUserMessage(pt);
ok("nudge delivery observed in model requests (k order 1,2,3 first-seen)", (() => {
	const seen = [];
	for (const k of ks) if (seen.at(-1) !== k) seen.push(k);
	return seen.length >= 3 && seen[0] === 1 && seen[1] === 2 && seen[2] === 3;
})(), { ks: nudgeKsInLastUserMessage(pt) });
ok("scripted terminal stop still consumed (fixture exhausted normally)", pt.length >= 24, { requests: pt.length });
// Exactly-one escalation: durable root mailbox append (deliverMessageLocked), latched.
const rootMailbox = join(positive.scratch, ".pi", "swarm", "mailboxes", "root.jsonl");
const rootLines = existsSync(rootMailbox) ? readFileSync(rootMailbox, "utf8").split("\n").filter((l) => l.trim()) : [];
const escalations = rootLines.map((l) => JSON.parse(l)).filter((m) => typeof m.body === "string" && m.body.includes(ESCALATION_FAMILY));
ok("exactly ONE root escalation in the durable mailbox", escalations.length === 1, { root: rootLines.length, escalations: escalations.length });
ok("escalation body carries streak evidence (agent/task/count)", escalations[0] ? /agent worker-lane/.test(escalations[0].body ?? "") && /task task-lane-1/.test(escalations[0].body ?? "") : false, escalations[0]?.body?.slice(0, 120));

// ============================================================================
// Lane 2: negative — R10-1 C-R10-1-2 zero-send control
// ============================================================================
console.log("\n== lane: negative (zero-send control) ==");
const negative = runLane(FIXTURES.negative);
const nt = readTranscripts(negative.scratch, FIXTURES.negative);
ok("negative lane produced transcripts", nt.length > 0, { stderr: negative.r.stderr?.slice(0, 300) });
const ntHits = requestMarkerHits(nt, NUDGE_FAMILY);
ok("ZERO nudge markers in requests (count below threshold)", ntHits.length === 0, { hits: ntHits.length });
const nCounts = existsSync(join(negative.scratch, "lane-counts.json")) ? JSON.parse(readFileSync(join(negative.scratch, "lane-counts.json"), "utf8")) : {};
ok("R10-1 durable nudge audit == 0 (zero-send control)", nCounts.nudges === 0, nCounts);

// ============================================================================
console.log(`\nLOOP-REPEAT LANES ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
for (const s of [positive.scratch, negative.scratch]) {
	console.log(`evidence: ${join(s, ".pi", "mock-llm", "transcripts")}`);
}
if (process.env.PI_LOOP_REPEAT_LANES_KEEP !== "1") {
	for (const s of [positive.scratch, negative.scratch]) rmSync(s, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
