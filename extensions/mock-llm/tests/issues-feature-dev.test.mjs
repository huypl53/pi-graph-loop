#!/usr/bin/env node
/**
 * issues-feature-dev.test.mjs — fixture schema + opt-in replay lane for feature-dev issue runs.
 *
 * Always-on: fixture schema assertions (role-node progression plan→implement→test→review→commit).
 * Replay (RUN_SWARM_ISSUES_FEATURE_DEV_LANE=1): seeds a real feature-dev issue run (resolved
 * linked-task id), rewrites the fixture token, spawns a real pi mock-llm session driving ONE
 * issue through the full role graph to done, then asserts the pump tick advanced the run.
 */
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "issues-feature-dev.jsonl");
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
		console.error("  FAIL", n, info !== undefined ? `(${JSON.stringify(info).slice(0, 160)})` : "");
	}
};

console.log("== issues-feature-dev fixture shape ==");
ok("fixture file exists", existsSync(fixturePath));
const lines = existsSync(fixturePath)
	? readFileSync(fixturePath, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"))
	: [];
const turns = lines.map((l) => JSON.parse(l));
ok("fixture has 6 turns (5 role-node updates + result-absorbing turn)", turns.length === 6, { lines: turns.length });
const rolePath = ["plan", "implement", "test", "review", "commit"];
ok("turns walk plan→implement→test→review→commit in order", rolePath.every(
	(node, i) => turns[i]?.events?.some((e) => e.type === "toolcall" && e.name === "swarm_update_task" && e.arguments?.nodeId === node && e.arguments?.status === "done"),
));
ok("outcomes follow the graph edges", ["planned", "implemented", "passed", "approved", "committed"].every(
	(outcome, i) => turns[i]?.events?.some((e) => e.type === "toolcall" && e.arguments?.outcome === outcome),
));
ok("toolcall turns tokenized + all terminate", turns.every((t) => t.stopReason === "stop") && turns.slice(0, 5).every((t) => JSON.stringify(t).includes("__LINKED_TASK_ID__")));
console.log(`\nISSUES-FEATURE-DEV FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
if (fail > 0 || process.env.RUN_SWARM_ISSUES_FEATURE_DEV_LANE !== "1") process.exit(fail === 0 ? 0 : 1);

// === Opt-in replay lane ===
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
delete process.env.PI_SWARM_ISSUES_ADVANCEMENT;
const { spawnSync } = await import("node:child_process");
const { paths, readState, writeState, ensureDirs } = await import(join(swarmSrc, "state.ts"));
const { getIssueRun } = await import(join(swarmSrc, "issues", "state.ts"));
const { handleIssuesCommand } = await import(join(swarmSrc, "commands", "issues.ts"));
const { runPumpMaintenancePhasesLocked } = await import(join(swarmSrc, "surface", "pump-phases.ts"));

console.log("\n== Opt-in feature-dev replay lane ==");
const scratch = mkdtempSync(join(tmpdir(), `issues-fd-lane-${process.pid}-`));
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
await handleIssuesCommand("issues", ["start"], { cwd: scratch, ui: { notify: () => {} } }, p, {});
let st = await readState(p, scratch);
let run = getIssueRun(st);
ok("lane seeded with feature-dev workflow", (run.workflowMode ?? "feature-dev") === "feature-dev", run.workflowMode);
const seededId = run.queue[0].taskId;
ok("linked task carries the full role graph", (() => {
	const t = JSON.parse(readFileSync(join(scratch, ".pi", "swarm", "tasks", seededId, "task.json"), "utf8"));
	return ["plan", "implement", "test", "fix", "review", "commit"].every((n) => t.nodes?.[n]);
})());

// resolve token + spawn real pi session
const fixtureText = readFileSync(fixturePath, "utf8").replaceAll("__LINKED_TASK_ID__", seededId);
// artifacts the updates validate
mkdirSync(join(scratch, "artifacts"), { recursive: true });
for (const f of ["plan.md", "implementation-report.md", "test-report.md", "review.md", "final-summary.md"]) writeFileSync(join(scratch, "artifacts", f), "lane\n");
writeFileSync(fixturePath, fixtureText);
try {
	const res = spawnSync(
		"pi",
		["-ne", "-e", join(repoRoot, "extensions/mock-llm"), "-e", join(repoRoot, "extensions/swarm"), "--provider", "mock-llm", "--model", "issues-feature-dev", "-p", "run the feature-dev scenario"],
		{ cwd: scratch, encoding: "utf8", timeout: 180_000, env: { ...process.env } },
	);
	ok("replay session exited cleanly", res.status === 0, { status: res.status, stderr: String(res.stderr || "").slice(-160) });
} finally {
	writeFileSync(fixturePath, lines.join("\n") + "\n");
}

// pump tick observes the multi-node done and advances
st = await readState(p, scratch);
await runPumpMaintenancePhasesLocked({}, { cwd: scratch, isIdle: () => true }, p, st, Date.now(), "fd-lane");
await writeState(p, st);
run = getIssueRun(await readState(p, scratch));
ok("issue advanced through the full role graph", run.queue[0].status === "done", JSON.stringify(run.queue.map((q) => ({ i: q.issueId, s: q.status }))));
ok("next issue activated", run.activeIssueId === "fix-two" && run.queue[1].status === "active", run.activeIssueId);
const transcriptDirs = join(scratch, ".pi", "mock-llm", "transcripts");
ok("mock-llm transcript recorded", existsSync(transcriptDirs) && readdirSync(transcriptDirs).length > 0);

console.log(`\nISSUES-FEATURE-DEV LANE ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
try {
	rmSync(scratch, { recursive: true, force: true });
} catch {
	// best-effort cleanup (tmp rotation handles leftovers)
}
process.exit(fail === 0 ? 0 : 1);
