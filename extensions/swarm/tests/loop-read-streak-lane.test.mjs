#!/usr/bin/env node
/**
 * loop-read-streak-lane.test.mjs — live mock-llm lanes for the read-streak guard
 * (task loop-read-streak-guard Phase 5, plan §3 + §5 T12).
 *
 * Three REAL pi + mock-llm lanes in isolated scratch cwds, each asserting transcript
 * evidence at `.pi/mock-llm/transcripts/` (recipe mirrors r10-1-busy-nudge-probe.test.mjs):
 *
 *   1. milestones   (loop-read-streak-milestones): 20 turns / 19 native READs, lane env
 *      PI_SWARM_READ_STREAK_MS=15000 → nudges 1..3 fire mid-run (one turn_end continuation
 *      each, marker in the NEXT model request with role=user), exactly 3 continuations,
 *      terminal stop consumed normally.
 *   2. reset        (loop-read-streak-reset): R10-1 C-R10-1-2 zero-send control — an `edit`
 *      (OTHER) resets the streak mid-lane → ZERO nudge markers, zero continuations.
 *   3. escalate-once(loop-read-streak-escalate-once): 29 reads cross milestones 1..3 + the
 *      milestone-4 boundary → nudges 1..3 mid-run AND exactly ONE durable root escalation
 *      (mailbox append), none after (persisted latch), no 4th continuation.
 *
 * The guard extension is the PRODUCTION swarm extension loaded via -e; a tiny lane ext
 * asserts the R10-1 boundary counter (readStreakSendCount from hooks/turns.ts) at settle.
 *
 * ISOLATION: scratch cwd per lane (mkdtemp), seeded worker record so the guard observes the
 * scripted READs; PI_SWARM_AGENT_ID=worker-lane. PI_READ_STREAK_LANES=0 skips the live lanes
 * (fixture-shape assertions only, deterministic offline gate).
 *
 * Run: node extensions/swarm/tests/loop-read-streak-lane.test.mjs
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
	milestones: "loop-read-streak-milestones",
	reset: "loop-read-streak-reset",
	escalate: "loop-read-streak-escalate-once",
};
const NUDGE_FAMILY = "READ-STREAK nudge";
const ESCALATION_FAMILY = "READ-STREAK escalation";

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
	let reads = 0;
	let others = 0;
	let stops = 0;
	for (const t of turns) {
		if (t.stopReason === "stop") stops++;
		for (const e of t.events ?? []) {
			if (e.type === "toolcall") {
				if (["read", "grep", "find", "ls"].includes(e.name)) reads++;
				else others++;
			}
		}
	}
	return { turns: turns.length, reads, others, stops };
}

console.log("== fixture shape ==");
const mStats = fixtureStats(FIXTURES.milestones);
ok("milestones fixture: 20 turns, 19 READs, terminal stop", mStats.turns === 20 && mStats.reads === 19 && mStats.stops === 1, mStats);
const rStats = fixtureStats(FIXTURES.reset);
ok("reset fixture: has ≥1 OTHER (edit) toolcall + terminal stop", rStats.others >= 1 && rStats.stops === 1, rStats);
const eStats = fixtureStats(FIXTURES.escalate);
ok("escalate fixture: ≥24 READs (milestone-4 boundary), terminal stop, zero OTHER", eStats.reads >= 24 && eStats.stops === 1 && eStats.others === 0, eStats);
ok("fixtures contain no nudge/escalation text (injected by the guard, not scripted)", ["milestones", "reset", "escalate"].every((k) => {
	const raw = readFileSync(join(repoRoot, "extensions", "mock-llm", "fixtures", `${FIXTURES[k]}.jsonl`), "utf8");
	return !raw.includes(NUDGE_FAMILY) && !raw.includes(ESCALATION_FAMILY);
}));

// ============================================================================
// Lane harness
// ============================================================================
const LANE_EXT = join(repoRoot, "extensions", "swarm", "tests", "fixtures", "loop-lane-ext.ts");

function seedWorker(scratch, agentId, taskId) {
	const stateDir = join(scratch, ".pi", "swarm");
	mkdirSync(stateDir, { recursive: true });
	const now = new Date().toISOString();
	writeFileSync(
		join(stateDir, "swarm-state.json"),
		JSON.stringify({
			version: 1,
			swarmId: "loop-read-streak-lane",
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

function runLane(model, { msOverride = "50", keep = false } = {}) {
	const scratch = mkdtempSync(join(tmpdir(), `loop-read-streak-lane-${model}-`));
	mkdirSync(join(scratch, ".pi", "mock-llm", "transcripts"), { recursive: true });
	mkdirSync(join(scratch, ".pi"), { recursive: true });
	writeFileSync(join(scratch, ".pi", "swarm.yml"), "terminalManager: tmux\n");
	seedWorker(scratch, "worker-lane", "task-lane-1");

	const env = { ...process.env };
	env.PI_SWARM_AGENT_ID = "worker-lane";
	delete env.PI_SWARM_IS_ROOT;
	env.PI_SWARM_READ_STREAK_MS = msOverride; // lane command override only — never in fixtures
	env.PI_MOCK_LLM_TRANSCRIPTS_DIR = join(scratch, ".pi", "mock-llm", "transcripts");
	env.PI_READ_STREAK_LANE_SCRATCH = scratch;

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
			"run the read-streak lane",
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
	// Count only NEW nudges: the continuation injects the nudge as the LAST user message of
	// the request that consumed it — carried-forward copies from earlier turns are historical
	// context, not new injections.
	const ks = [];
	for (const t of transcripts) {
		const users = (t?.request?.messages ?? []).filter((m) => m.role === "user" && typeof m.preview === "string");
		const last = users.at(-1);
		if (!last) continue;
		const match = last.preview.match(/\[READ-STREAK nudge (\d)\/3 — milestone (\d)\]/);
		if (match) ks.push(Number(match[2]));
	}
	return ks;
}

if (process.env.PI_READ_STREAK_LANES === "0") {
	console.log("\n(skipping live lanes — PI_READ_STREAK_LANES=0; fixture-shape assertions only)");
	console.log(`LOOP-READ-STREAK LANES ${fail === 0 ? "PASS (shape-only)" : "FAIL"} (${fail} failed, ${pass} passed)`);
	process.exit(fail === 0 ? 0 : 1);
}

// ============================================================================
// Lane 1: milestones — nudges 1..3 mid-run (GREEN reproduction of the red lane)
// ============================================================================
console.log("\n== lane: milestones (nudges 1..3 mid-run) ==");
const milestones = runLane(FIXTURES.milestones);
const mt = readTranscripts(milestones.scratch, FIXTURES.milestones);
ok("milestones lane produced transcripts", mt.length > 0, { stderr: milestones.r.stderr?.slice(0, 300), status: milestones.r.status });
const mtHits = requestMarkerHits(mt, NUDGE_FAMILY);
ok("nudge marker reached model requests (mid-run custom_message)", mtHits.length > 0, { hits: mtHits.length, total: mt.length });
const mCounts = existsSync(join(milestones.scratch, "lane-counts.json")) ? JSON.parse(readFileSync(join(milestones.scratch, "lane-counts.json"), "utf8")) : {};
ok("R10-1 durable nudge audit == 3 at the injection path (loop_streak.nudge)", mCounts.nudges === 3, mCounts);
// New-injection evidence in transcripts: continuation requests (the requests whose LAST user
// message is a fresh nudge) — historical copies ride along in later requests by design.
const ks = nudgeKsInLastUserMessage(mt);
ok("nudge delivery observed in model requests (k order 1,2,3 first-seen)", (() => {
	const seen = [];
	for (const k of ks) if (seen.at(-1) !== k) seen.push(k);
	return seen.length >= 3 && seen[0] === 1 && seen[1] === 2 && seen[2] === 3;
})(), { ks: nudgeKsInLastUserMessage(mt) });
ok("scripted terminal stop still consumed (fixture exhausted normally, not script_exhausted)", mt.length >= 20, { requests: mt.length });

// ============================================================================
// Lane 2: reset — R10-1 C-R10-1-2 zero-send control
// ============================================================================
console.log("\n== lane: reset (zero-send control) ==");
const reset = runLane(FIXTURES.reset);
const rt = readTranscripts(reset.scratch, FIXTURES.reset);
ok("reset lane produced transcripts", rt.length > 0, { stderr: reset.r.stderr?.slice(0, 300) });
const rtHits = requestMarkerHits(rt, NUDGE_FAMILY);
ok("ZERO nudge markers in requests (edit reset the streak)", rtHits.length === 0, { hits: rtHits.length });
const rCounts = existsSync(join(reset.scratch, "lane-counts.json")) ? JSON.parse(readFileSync(join(reset.scratch, "lane-counts.json"), "utf8")) : {};
ok("R10-1 durable nudge audit == 0 (zero-send control)", rCounts.nudges === 0, rCounts);

// ============================================================================
// Lane 3: escalate-once — nudges 1..3 + exactly ONE root escalation
// ============================================================================
console.log("\n== lane: escalate-once (one root escalation, latched) ==");
const escalate = runLane(FIXTURES.escalate);
const et = readTranscripts(escalate.scratch, FIXTURES.escalate);
ok("escalate lane produced transcripts", et.length > 0, { stderr: escalate.r.stderr?.slice(0, 300) });
const etHits = requestMarkerHits(et, NUDGE_FAMILY);
ok("nudge delivery observed in escalate-lane requests (marker family present)", etHits.length >= 3, { hits: etHits.length });
const eCounts = existsSync(join(escalate.scratch, "lane-counts.json")) ? JSON.parse(readFileSync(join(escalate.scratch, "lane-counts.json"), "utf8")) : {};
ok("R10-1 durable nudge audit == 3 (no 4th continuation past the cap)", eCounts.nudges === 3, eCounts);
// Exactly-one escalation: durable root mailbox append (deliverMessageLocked), latched.
const rootMailbox = join(escalate.scratch, ".pi", "swarm", "mailboxes", "root.jsonl");
const rootLines = existsSync(rootMailbox) ? readFileSync(rootMailbox, "utf8").split("\n").filter((l) => l.trim()) : [];
const escalations = rootLines.map((l) => JSON.parse(l)).filter((m) => typeof m.body === "string" && m.body.includes(ESCALATION_FAMILY));
ok("exactly ONE root escalation in the durable mailbox", escalations.length === 1, { root: rootLines.length, escalations: escalations.length });
ok("escalation body carries streak evidence (agent/task/reads)", escalations[0] ? /agent worker-lane/.test(escalations[0].body ?? "") && /task task-lane-1/.test(escalations[0].body ?? "") : false, escalations[0]?.body?.slice(0, 120));

// ============================================================================
console.log(`\nLOOP-READ-STREAK LANES ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
for (const s of [milestones.scratch, reset.scratch, escalate.scratch]) {
	console.log(`evidence: ${join(s, ".pi", "mock-llm", "transcripts")}`);
}
if (process.env.PI_READ_STREAK_LANES_KEEP !== "1") {
	for (const s of [milestones.scratch, reset.scratch, escalate.scratch]) rmSync(s, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
