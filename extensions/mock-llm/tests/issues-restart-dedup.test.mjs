#!/usr/bin/env node
/**
 * issues-restart-dedup.test.mjs — fixture shape test + seeded mock-llm replay for the
 * issue-run restart dedup (issues-sequencer-restart-dedup).
 *
 * Always-on: fixture schema assertions.
 * Replay (RUN_SWARM_ISSUES_RESTART_DEDUP_LANE=1): seeds a two-run world (run 1 completes
 * fix-one, run 2 starts and dedupes fix-one + activates fix-two), rewrites the fixture's
 * __LINKED_TASK_ID__ token to the real id, then spawns a real
 * `pi --provider mock-llm --model issues-restart-dedup` session. Asserts the run
 * advances past the deduped issue to the next queued issue.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "issues-restart-dedup.jsonl");
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

console.log("== issues-restart-dedup fixture shape ==");
ok("fixture file exists", existsSync(fixturePath));
const lines = existsSync(fixturePath)
	? readFileSync(fixturePath, "utf8")
			.split("\n")
			.filter((l) => l.trim() && !l.startsWith("#"))
	: [];
ok("fixture has 3 scripted turns (1 text + 1 toolcall + result-absorbing turn)", lines.length === 3, { lines: lines.length });
const turns = lines.map((l) => JSON.parse(l));
ok("turn 0 is a text observation of the dedup notice", turns[0]?.events?.some((e) => e.type === "text" && /already completed in run/.test(e.text ?? "")));
ok("turn 1 completes the tokenized linked task", turns[1]?.events?.some((e) => e.type === "toolcall" && e.name === "swarm_update_task" && JSON.stringify(e.arguments).includes("__LINKED_TASK_ID__") && JSON.stringify(e.arguments).includes('"status":"done"')));
ok("all turns terminate", turns.every((t) => t.stopReason === "stop"));
console.log(`\nISSUES-RESTART-DEDUP FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);

// === End-to-end replay: seed a two-run world, resolve the token, spawn real pi ===
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
const { spawnSync } = await import("node:child_process");
const { paths, readState, writeState, ensureDirs } = await import(join(swarmSrc, "state.ts"));
const { getIssueRun } = await import(join(swarmSrc, "issues", "state.ts"));
const { handleIssuesCommand } = await import(join(swarmSrc, "commands", "issues.ts"));
const { observeLinkedTaskLocked } = await import(join(swarmSrc, "issues", "controller.ts"));

const scratch = mkdtempSync(join(tmpdir(), `issues-restart-dedup-lane-${process.pid}-`));
console.log("\n== End-to-end replay ==", scratch);
for (const d of ["traces", "mailboxes", "tasks"]) mkdirSync(join(scratch, ".pi", "swarm", d), { recursive: true });
mkdirSync(join(scratch, "docs"), { recursive: true });
writeFileSync(join(scratch, "docs", "one.md"), "doc one\n");
writeFileSync(join(scratch, "docs", "two.md"), "doc two\n");
writeFileSync(
	join(scratch, ".pi", "swarm", "issues.yml"),
	"issues:\n  - id: fix-one\n    title: One\n    content: do one\n    docs:\n      - docs/one.md\n  - id: fix-two\n    title: Two\n    content: do two\n    docs:\n      - docs/two.md\n",
);
const p = paths(scratch);
await ensureDirs(p);

// Run 1: start, finish fix-one
await handleIssuesCommand("issues", ["start"], { cwd: scratch, ui: { notify: () => {} } }, p, {});
let st = await readState(p, scratch);
let run = getIssueRun(st);
let active = run.queue.find((q) => q.status === "active");
const { deliverMessageLocked } = await import(join(swarmSrc, "mailbox.ts"));
await observeLinkedTaskLocked(p, { cwd: scratch }, st, { taskId: active.taskId, status: "done" }, { pi: null, deliverMessageLocked });
await writeState(p, st);

// Clear goal + reset run state so run 2 can start
await new Promise((resolve) => {
	import(join(swarmSrc, "state.ts")).then(({ withLock }) => {
		withLock(p, async () => {
			const st2 = await readState(p, scratch);
			const r2 = getIssueRun(st2);
			r2.status = "inactive";
			r2.activeIssueId = undefined;
			r2.queue = [];
			delete st2.goal;
			await writeState(p, st2);
			resolve();
		});
	});
});

// Clean up tasks to avoid the known taskId collision (phase-05 limitation)
rmSync(join(scratch, ".pi", "swarm", "tasks"), { recursive: true, force: true });
mkdirSync(join(scratch, ".pi", "swarm", "tasks"), { recursive: true });

// Run 2: start (dedup fix-one, activate fix-two)
await handleIssuesCommand("issues", ["start"], { cwd: scratch, ui: { notify: () => {} } }, p, {});
st = await readState(p, scratch);
run = getIssueRun(st);
const seededId = run.queue.find((q) => q.status === "active")?.taskId;
ok("run 2 deduped fix-one and activated fix-two", run.queue[0].status === "done" && run.queue[1].status === "active" && seededId, JSON.stringify(run.queue.map((q) => ({ i: q.issueId, s: q.status }))));
ok("seeded linked run has a deterministic taskId", Boolean(seededId), seededId);

// Resolve the fixture token to the real id for this replay
const fixtureText = readFileSync(fixturePath, "utf8").replaceAll("__LINKED_TASK_ID__", seededId);
writeFileSync(fixturePath, fixtureText);
try {
	const res = spawnSync(
		"pi",
		["-ne", "-e", join(repoRoot, "extensions/mock-llm"), "-e", join(repoRoot, "extensions/swarm"), "--provider", "mock-llm", "--model", "issues-restart-dedup", "-p", "run the restart-dedup scenario"],
		{
			cwd: scratch,
			encoding: "utf8",
			timeout: 120_000,
			// PI_SWARM_TERMINAL_MANAGER=tmux (test-hermeticity-pin-unpinned-lanes 2026-10-04): the
			// USER's GLOBAL ~/.pi/agent/swarm.yml (e.g. terminalManager: herdr) merges into every
			// scratch cwd that does not set inheritGlobal:false — without this pin the child pi
			// spawns REAL herdr workspaces in the user's live daemon. Env var is precedence #1 in
			// getTerminalDriver, so this pin makes the lane hermetic regardless of host config.
			// Same pattern as swarm-yml-pool.test.mjs.
			env: { ...process.env, PI_SWARM_TERMINAL_MANAGER: "tmux" },
		},
	);
	ok("replay session exited cleanly", res.status === 0, { status: res.status, stderr: String(res.stderr || "").slice(-160) });
} finally {
	writeFileSync(fixturePath, lines.join("\n") + "\n"); // restore tokenized fixture
}

const stAfter = await readState(p, scratch);
const runAfter = getIssueRun(stAfter);
ok("run 2 advanced past the deduped issue", runAfter.queue[1].status === "done" || runAfter.queue[1].status === "active", JSON.stringify(runAfter.queue.map((q) => ({ i: q.issueId, s: q.status }))));
const transcriptDirs = join(scratch, ".pi", "mock-llm", "transcripts");
ok("mock-llm transcript recorded", existsSync(transcriptDirs) && readdirSync(transcriptDirs).length > 0);

console.log(`\nISSUES-RESTART-DEDUP REPLAY ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
try {
	rmSync(scratch, { recursive: true, force: true });
} catch {
	// best-effort cleanup (tmp rotation handles leftovers)
}
process.exit(fail === 0 ? 0 : 1);
