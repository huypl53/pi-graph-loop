#!/usr/bin/env node
/**
 * goal-max-nudges.test.mjs — fixture shape test + opt-in/live lane for the
 * goal maxNudges / infinite nudges (-1) scenario.
 *
 * Runs pi with --provider mock-llm --model goal-max-nudges:
 *   - Turn 1: swarm_set_goal with maxNudges: -1
 *   - Turn 2: swarm_set_goal with update: true, maxNudges: 5
 *   - Turn 3: swarm_set_goal with update: true, maxNudges: -1
 *   - Turn 4: swarm_mark_goal_done
 *
 * Verifies the fixture shape and execution against swarm tools.
 */

import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "goal-max-nudges.jsonl");
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

console.log("== goal-max-nudges fixture shape ==");
ok("fixture file exists", existsSync(fixturePath));
const lines = existsSync(fixturePath)
	? readFileSync(fixturePath, "utf8")
			.split("\n")
			.filter((l) => l.trim() && !l.startsWith("#"))
	: [];
ok("fixture has 5 scripted turns", lines.length === 5, { lines: lines.length });
const turns = lines.map((l) => JSON.parse(l));
ok(
	"turn 0 sets goal with maxNudges: -1",
	turns[0]?.events?.some((e) => e.type === "toolcall" && e.arguments?.maxNudges === -1),
);
ok(
	"turn 1 updates maxNudges: 5",
	turns[1]?.events?.some((e) => e.type === "toolcall" && e.arguments?.maxNudges === 5),
);
ok(
	"turn 2 updates maxNudges: -1",
	turns[2]?.events?.some((e) => e.type === "toolcall" && e.arguments?.maxNudges === -1),
);
ok(
	"turn 3 marks goal done",
	turns[3]?.events?.some((e) => e.name === "swarm_mark_goal_done"),
);
ok("turn 4 final stop", turns[4]?.stopReason === "stop" && turns[4]?.events?.some((e) => e.type === "stop"));

const scratch = mkdtempSync(join(tmpdir(), `swarm-goal-max-nudges-lane-${process.pid}-`));
mkdirSync(join(scratch, ".pi"), { recursive: true });
writeFileSync(join(scratch, ".pi", "settings.json"), JSON.stringify({ swarm: {} }));

const res = spawnSync(
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
		"goal-max-nudges",
		"-p",
		"run goal-max-nudges sequence",
	],
	{
		cwd: scratch,
		encoding: "utf8",
		timeout: 120_000,
		env: { ...process.env, PI_SWARM_AGENT_ID: "root", PI_SWARM_IS_ROOT: "1" },
	},
);

ok("pi lane exited with code 0", res.status === 0, { status: res.status, stderr: String(res.stderr || "").slice(0, 300) });

const eventsFile = join(scratch, ".pi", "swarm", "traces", "events.jsonl");
if (existsSync(eventsFile)) {
	const records = readFileSync(eventsFile, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));

	const goalSet = records.filter((r) => r.event === "goal.set");
	ok("recorded goal.set events", goalSet.length >= 1, { count: goalSet.length });
	ok(
		"recorded initial maxNudges=-1",
		goalSet.some((r) => r.maxNudges === -1),
	);

	const goalUpdated = records.filter((r) => r.event === "goal.updated");
	ok("recorded goal.updated events", goalUpdated.length >= 2, { count: goalUpdated.length });
	ok(
		"recorded updated maxNudges=5",
		goalUpdated.some((r) => r.maxNudges === 5),
	);
	ok(
		"recorded updated maxNudges back to -1",
		goalUpdated.some((r) => r.maxNudges === -1),
	);

	const goalCleared = records.filter((r) => r.event === "goal.cleared");
	ok("recorded goal.cleared event", goalCleared.length >= 1, { count: goalCleared.length });
} else {
	ok("events.jsonl was created", false);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\nGOAL-MAX-NUDGES FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
