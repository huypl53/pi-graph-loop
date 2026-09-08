#!/usr/bin/env node
/**
 * errorlog-evidence-failure.test.mjs — fixture shape test + opt-in live lane for the
 * no-silent-swallow scenario.
 *
 * Pattern 2 (seeded world + single-actor script) per the mock-llm-scenarios skill:
 *   - Seed `.pi/swarm/traces/events.jsonl` as a DIRECTORY so every evidence append fails with
 *     EISDIR (deterministic), while the sibling errors.jsonl stays writable.
 *   - Run a real `pi --provider mock-llm --model errorlog-evidence-failure` session against the
 *     scratch cwd; after it exits, errors.jsonl MUST contain internal.error records with
 *     op=evidence.append_failed — proving the previously-swallowed evidence failures are durable.
 *
 * This file is SKIP-by-default (fast, offline). Set RUN_ERRORLOG_LANE=1 to exec pi.
 * The red/green unit-level assertions for the same bug live in
 * extensions/swarm/tests/errorlog.test.mjs (run always).
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "errorlog-evidence-failure.jsonl");
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

console.log("== errorlog-evidence-failure fixture shape ==");
ok("fixture file exists", existsSync(fixturePath));
const lines = existsSync(fixturePath)
	? readFileSync(fixturePath, "utf8")
			.split("\n")
			.filter((l) => l.trim() && !l.startsWith("#"))
	: [];
ok("fixture has 3 scripted turns", lines.length === 3, { lines: lines.length });
const turns = lines.map((l) => JSON.parse(l));
ok("turn 0 has 2 toolcalls", turns[0]?.events?.filter((e) => e.type === "toolcall").length === 2);
ok(
	"turn 1 has 1 toolcall",
	turns[1]?.events?.some((e) => e.type === "toolcall"),
);
ok("turn 2 = stop (terminal)", turns[2]?.stopReason === "stop" && turns[2]?.events?.some((e) => e.type === "stop"));

// The unit-level red/green proof must exist and pass independently.
ok("unit test file exists", existsSync(join(repoRoot, "extensions", "swarm", "tests", "errorlog.test.mjs")));

if (process.env.RUN_ERRORLOG_LANE !== "1") {
	console.log(`\n(skipping live lane — set RUN_ERRORLOG_LANE=1 to execute the full E2E scenario)`);
	console.log(`ERRORLOG-EVIDENCE-FAILURE FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
	process.exit(fail === 0 ? 0 : 1);
}

// === Live E2E lane (opt-in) ===
const { spawnSync } = await import("node:child_process");
const { mkdtempSync, rmSync } = await import("node:fs");
const scratch = mkdtempSync(join(tmpdir(), `swarm-errorlog-lane-${process.pid}-`));
console.log("\n== Live E2E lane ==", scratch);

// Seed the poisoned traces dir: events.jsonl as a DIRECTORY.
mkdirSync(join(scratch, ".pi", "swarm", "traces", "events.jsonl"), { recursive: true });
writeFileSync(join(scratch, ".pi", "settings.json"), JSON.stringify({ swarm: {} }));

const res = spawnSync(
	"pi",
	[
		"-e",
		join(repoRoot, "extensions/swarm"),
		"-e",
		join(repoRoot, "extensions/mock-llm"),
		"--provider",
		"mock-llm",
		"--model",
		"errorlog-evidence-failure",
		"-p",
		"run three trivial read tool calls",
	],
	{ cwd: scratch, encoding: "utf8", timeout: 120_000, env: { ...process.env, PI_SWARM_AGENT_ID: "root", PI_SWARM_IS_ROOT: "1" } },
);
ok("pi lane exited with code 0", res.status === 0, { status: res.status, stderr: String(res.stderr || "").slice(0, 200) });

const errorsFile = join(scratch, ".pi", "swarm", "traces", "errors.jsonl");
ok("errors.jsonl was created", existsSync(errorsFile));
if (existsSync(errorsFile)) {
	const records = readFileSync(errorsFile, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
	const evidenceFailures = records.filter((r) => r.event === "internal.error" && r.op === "evidence.append_failed");
	ok("errors.jsonl contains evidence.append_failed records", evidenceFailures.length > 0, { total: records.length });
	// 3 scripted toolcalls => tool_execution_end fired 3 times => 3 previously-swallowed evidence failures
	ok("3 evidence failures recorded (one per scripted toolcall)", evidenceFailures.length === 3, { count: evidenceFailures.length });
	ok(
		"record carries code=EISDIR",
		evidenceFailures.some((r) => r.code === "EISDIR"),
		evidenceFailures[0],
	);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\nERRORLOG-EVIDENCE-FAILURE LANE ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
