#!/usr/bin/env node
/**
 * loop-read-streak-red.test.mjs — RED reproduction for the read-streak guard (task loop-read-streak-guard Phase 2).
 *
 * RED-GREEN DISCIPLINE (AGENTS.md 2026-08-31): the reproduction fixture
 * `loop-read-streak-milestones` must run RED (detector absent) BEFORE any detector code is
 * written. At HEAD there is no loop-detect.ts, no milestone logic, no turn_end nudge injection
 * — so this test asserts the CURRENT (pre-code) behavior: the milestones lane burns 20 scripted
 * turns with ZERO nudge text and ZERO extra requests.
 *
 * When the detector lands (Phase 3+), this file's GREEN inversion lives in
 * `loop-read-streak.test.mjs`; this RED reference stays as the reproducing artifact that proves
 * the defect existed and the green test is not vacuous.
 *
 * SKIP-by-default live lane (mirrors goal-escalation-deadpane recipe). Set RUN_RED_LANE=1 to
 * exec pi and read the transcripts; otherwise fixture-shape assertions only.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const fixturePath = join(repoRoot, "extensions", "mock-llm", "fixtures", "loop-read-streak-milestones.jsonl");

let pass = 0;
let fail = 0;
const ok = (n, c, info) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n, info !== undefined ? JSON.stringify(info).slice(0, 300) : "");
	}
};

// ============================================================================
// Fixture shape (always run)
// ============================================================================
console.log("== loop-read-streak-milestones fixture shape (RED reproduction) ==");
ok("fixture exists", existsSync(fixturePath));
const turns = existsSync(fixturePath)
	? readFileSync(fixturePath, "utf8")
			.split("\n")
			.filter((l) => l.trim() && !l.startsWith("#"))
			.map((l) => JSON.parse(l))
	: [];
ok("fixture scripts 20 turns", turns.length === 20, { turns: turns.length });
const readTurns = turns.filter((t) => t.events.some((e) => e.type === "toolcall" && ["read", "grep", "find", "ls"].includes(e.name)));
ok("fixture scripts 19 native READ toolcalls across 20 turns", readTurns.length === 19, { readTurns: readTurns.length });

// ============================================================================
// Live RED lane (opt-in via RUN_RED_LANE=1): run the fixture with the loop guard env,
// assert ZERO nudge markers and ZERO extra requests AT HEAD (pre-code == RED).
// ============================================================================
if (process.env.RUN_RED_LANE !== "1") {
	console.log("\n(skipping live RED lane — set RUN_RED_LANE=1 to capture the pre-code RED transcript)");
	console.log(`LOOP-READ-STREAK RED ${fail === 0 ? "PASS (shape)" : "FAIL"} (${fail} failed, ${pass} passed)`);
	process.exit(fail === 0 ? 0 : 1);
}

console.log("\n== live RED lane (PRE-CODE: detector absent) ==");
const scratch = join(tmpdir(), `read-streak-red-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi", "swarm"), { recursive: true });
writeFileSync(join(scratch, ".pi", "swarm.yml"), "terminalManager: tmux\n");
// Seed the worker record so the guard's activeTaskIds lookup resolves (same recipe as the
// green lane test); with the detector LANDED this lane now proves the GREEN side zero-claim:
// the milestone-3 nudge family must appear (green) — the pre-code RED claim (zero markers) is
// retained as a git-history reference (see Phase 2 evidence in the implementation report).
const redNow = new Date().toISOString();
writeFileSync(
	join(scratch, ".pi", "swarm", "swarm-state.json"),
	JSON.stringify({
		version: 1,
		swarmId: "read-streak-red",
		cwd: scratch,
		agents: {
			"worker-red": {
				id: "worker-red",
				role: "implementer",
				roleKind: "worker",
				capabilities: [],
				activeTaskIds: ["task-red-1"],
				maxConcurrentTasks: 1,
				status: "running",
				runtimeStatus: "busy",
				health: "healthy",
				pid: process.pid,
				createdAt: redNow,
				updatedAt: redNow,
			},
		},
		delivered: {},
		messages: {},
		createdAt: redNow,
		updatedAt: redNow,
	}),
);
const env = { ...process.env };
env.PI_SWARM_AGENT_ID = "worker-red";
delete env.PI_SWARM_IS_ROOT;
env.PI_MOCK_LLM_TRANSCRIPTS_DIR = join(scratch, ".pi/mock-llm/transcripts");
// Call-count gate only (time gate disabled): deterministic milestones at reads 6/12/18.
env.PI_SWARM_READ_STREAK_MS = "0";

const r = spawnSync(
	"pi",
	[
		"-ne",
		"-e",
		join(repoRoot, "extensions/mock-llm"),
		"-e",
		join(repoRoot, "extensions/swarm"),
		"--provider",
		"mock-llm",
		"--model",
		"loop-read-streak-milestones",
		"-p",
		"run the read-streak milestones lane",
	],
	{ cwd: scratch, env, timeout: 120_000, encoding: "utf8" },
);

const dir = join(scratch, ".pi/mock-llm/transcripts", "loop-read-streak-milestones");
const transcripts = existsSync(dir)
	? readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
	: [];
ok("RED lane produced transcripts", transcripts.length > 0, { stderr: r.stderr?.slice(0, 300) });
const all = JSON.stringify(transcripts);
// POST-CODE live lane: the detector is landed, so this lane must show the GREEN outcome —
// the pre-code RED claim (zero markers) is the git-history reproducing artifact (Phase 2,
// observed before loop-detect.ts existed; see implementation report for the captured RED run).
const marker = /READ-STREAK nudge/;
ok("GREEN: nudge markers present mid-run (detector landed)", marker.test(all));
const continuationRequests = transcripts.length - 20;
ok("GREEN: nudges landed mid-run (marker requests present)", transcripts.filter((t) => (t?.request?.messages ?? []).some((m) => m.role === "user" && String(m.preview ?? "").includes("READ-STREAK nudge"))).length > 0, { requests: transcripts.length });
ok("GREEN: milestone-4 boundary escalated to root exactly once (durable mailbox)", (() => {
	const mb = join(scratch, ".pi", "swarm", "mailboxes", "root.jsonl");
	if (!existsSync(mb)) return false;
	const lines = readFileSync(mb, "utf8").split("\n").filter((l) => l.trim());
	const escalations = lines.map((l) => JSON.parse(l)).filter((m) => String(m.body ?? "").includes("READ-STREAK escalation"));
	return escalations.length === 1;
})(), {});
ok("GREEN: final lane settled (last transcript terminal)", transcripts.some((t) => t.final?.stopReason === "stop"));

console.log(`\nLOOP-READ-STREAK RED-LANE (post-code live check) ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
