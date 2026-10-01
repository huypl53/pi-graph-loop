#!/usr/bin/env node
/**
 * issues-cancel-guard.test.mjs — fixture shape test + seeded mock-llm replay for the
 * linked-task cancel guard (b1-b2).
 *
 * Always-on: fixture schema assertions.
 * Replay: the test seeds a real linked run (deterministic taskId computed from the issues.yml
 * titles), rewrites the fixture's __LINKED_TASK_ID__ token to the real id, then spawns a real
 * `pi --provider mock-llm --model issues-cancel-guard` session. Turn 1 attempts cancelTask on
 * the active linked task → LINKED_TASK_CANCEL_REFUSED; turn 2 completes the terminal node done
 * → the run advances to the next queued issue.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "issues-cancel-guard.jsonl");
const repoRoot = join(here, "..", "..", "..");
const swarmSrc = join(repoRoot, "extensions", "swarm", "src");

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

console.log("== issues-cancel-guard fixture shape ==");
ok("fixture file exists", existsSync(fixturePath));
const lines = existsSync(fixturePath)
	? readFileSync(fixturePath, "utf8")
			.split("\n")
			.filter((l) => l.trim() && !l.startsWith("#"))
	: [];
ok("fixture has 3 scripted turns (2 toolcalls + result-absorbing turn)", lines.length === 3, { lines: lines.length });
const turns = lines.map((l) => JSON.parse(l));
ok("turn 0 attempts cancelTask on the tokenized linked task", turns[0]?.events?.some((e) => e.type === "toolcall" && e.name === "swarm_update_task" && JSON.stringify(e.arguments).includes("__LINKED_TASK_ID__") && JSON.stringify(e.arguments).includes("cancelTask")));
ok("turn 1 completes the terminal node done", turns[1]?.events?.some((e) => e.type === "toolcall" && e.name === "swarm_update_task" && JSON.stringify(e.arguments).includes('"status":"done"')));
ok("all turns terminate", turns.every((t) => t.stopReason === "stop"));
console.log(`\nISSUES-CANCEL-GUARD FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);

// === End-to-end replay: seed a real linked run, resolve the token, spawn real pi ===
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
const { spawnSync } = await import("node:child_process");
const { paths, readState } = await import(join(swarmSrc, "state.ts"));
const { getIssueRun } = await import(join(swarmSrc, "issues", "state.ts"));
const { handleIssuesCommand } = await import(join(swarmSrc, "commands", "issues.ts"));

const scratch = mkdtempSync(join(tmpdir(), `issues-cancel-lane-${process.pid}-`));
console.log("\n== End-to-end replay ==", scratch);
for (const d of ["traces", "mailboxes", "tasks"]) mkdirSync(join(scratch, ".pi", "swarm", d), { recursive: true });
mkdirSync(join(scratch, "docs"), { recursive: true });
writeFileSync(join(scratch, "docs", "one.md"), "doc one\n");
writeFileSync(join(scratch, "docs", "two.md"), "doc two\n");
writeFileSync(
	join(scratch, ".pi", "swarm", "issues.yml"),
	"issues:\n  - id: fix-cron\n    title: Fix Cron Store\n    content: cron store works\n    docs:\n      - docs/one.md\n  - id: fix-locator\n    title: Fix Locator\n    content: locator works\n    docs:\n      - docs/two.md\n",
);
const p = paths(scratch);
const { ensureDirs } = await import(join(swarmSrc, "state.ts"));
await ensureDirs(p);
await handleIssuesCommand("issues", ["start"], { cwd: scratch, ui: { notify: () => {} } }, p, {});
const seededId = getIssueRun(await readState(p, scratch)).queue[0].taskId;
ok("seeded linked run has a deterministic taskId", Boolean(seededId), seededId);

// Resolve the fixture token to the real id for this replay (checked-in fixture keeps the token).
const fixtureText = readFileSync(fixturePath, "utf8").replaceAll("__LINKED_TASK_ID__", seededId);
const resolvedFixture = join(scratch, "issues-cancel-guard-resolved.jsonl");
writeFileSync(resolvedFixture, fixtureText);
// The provider resolves fixtures from its own fixtures dir; copy the resolved fixture over the
// original for the spawn, then restore it after (test-scoped mutation, restored in finally).
writeFileSync(fixturePath, fixtureText);
try {
	const res = spawnSync(
		"pi",
		["-ne", "-e", join(repoRoot, "extensions/mock-llm"), "-e", join(repoRoot, "extensions/swarm"), "--provider", "mock-llm", "--model", "issues-cancel-guard", "-p", "run the cancel-guard scenario"],
		{ cwd: scratch, encoding: "utf8", timeout: 120_000, env: { ...process.env } },
	);
	ok("replay session exited cleanly", res.status === 0, { status: res.status, stderr: String(res.stderr || "").slice(-160) });
} finally {
	writeFileSync(fixturePath, lines.join("\n") + "\n"); // restore tokenized fixture
}

const stAfter = await readState(p, scratch);
const runAfter = getIssueRun(stAfter);
// turn 1 refused the cancel (task NOT cancelled), turn 2 completed node done → run advanced
ok("cancel was refused (task survived, issue advanced via proper completion)", runAfter.queue[0].status === "done" && runAfter.queue[1].status === "active", JSON.stringify(runAfter.queue.map((q) => ({ i: q.issueId, s: q.status }))));
ok("run still running (no silent freeze)", runAfter.status === "running", runAfter.status);
// refusal + transcript evidence
const transcriptDirs = join(scratch, ".pi", "mock-llm", "transcripts");
ok("mock-llm transcript recorded", existsSync(transcriptDirs) && readdirSync(transcriptDirs).length > 0);

console.log(`\nISSUES-CANCEL-GUARD REPLAY ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
try {
	rmSync(scratch, { recursive: true, force: true });
} catch {
	// best-effort cleanup (tmp rotation handles leftovers)
}
process.exit(fail === 0 ? 0 : 1);
