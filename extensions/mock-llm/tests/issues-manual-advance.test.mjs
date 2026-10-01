#!/usr/bin/env node
/**
 * issues-manual-advance.test.mjs — fixture schema + opt-in replay lane for manual advancement.
 *
 * Always-on: fixture schema assertions.
 * Replay (RUN_SWARM_ISSUES_ADVANCEMENT_LANE=1): seeds a manual-mode run via the real
 * handleIssuesCommand, drives the REAL pump tick (no auto-advance), asserts exactly one
 * issues-manual-wait notice, then resume-advances through the real command.
 */
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "issues-manual-advance.jsonl");
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

console.log("== issues-manual-advance fixture shape ==");
ok("fixture file exists", existsSync(fixturePath));
const lines = existsSync(fixturePath)
	? readFileSync(fixturePath, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"))
	: [];
const turns = lines.map((l) => JSON.parse(l));
ok("fixture has 2 turns", turns.length === 2, { lines: turns.length });
ok("all turns terminate", turns.every((t) => t.stopReason === "stop"));
ok("turn bodies reference the resume command", turns[0]?.events?.some((e) => e.type === "text" && /resume/.test(e.text ?? "")));
console.log(`\nISSUES-MANUAL-ADVANCE FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
if (fail > 0 || process.env.RUN_SWARM_ISSUES_ADVANCEMENT_LANE !== "1") process.exit(fail === 0 ? 0 : 1);

// === Opt-in replay lane ===
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
process.env.PI_SWARM_ISSUES_ADVANCEMENT = "manual";
const { paths, readState, writeState, ensureDirs } = await import(join(swarmSrc, "state.ts"));
const { getIssueRun } = await import(join(swarmSrc, "issues", "state.ts"));
const { handleIssuesCommand } = await import(join(swarmSrc, "commands", "issues.ts"));
const { runPumpMaintenancePhasesLocked } = await import(join(swarmSrc, "surface", "pump-phases.ts"));

console.log("\n== Opt-in manual-mode replay lane ==");
const scratch = mkdtempSync(join(tmpdir(), `issues-adv-lane-${process.pid}-`));
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
ok("lane seeded in manual mode", run.advancementMode === "manual", run.advancementMode);
// finish the linked task, tick through the REAL pump
const tp = join(scratch, ".pi", "swarm", "tasks", run.queue[0].taskId, "task.json");
const task = JSON.parse(readFileSync(tp, "utf8"));
task.status = "done";
for (const n of Object.values(task.nodes ?? {})) n.status = "done";
writeFileSync(tp, JSON.stringify(task, null, 2) + "\n");
await runPumpMaintenancePhasesLocked({}, { cwd: scratch, isIdle: () => true }, p, st, Date.now(), "adv-lane");
await writeState(p, st);
st = await readState(p, scratch);
run = getIssueRun(st);
ok("manual lane: NO auto-advance on tick", run.queue[1].status === "queued" && !run.activeIssueId, JSON.stringify(run.queue.map((q) => q.status)));
ok("manual lane: waiting-manual set", run.advancement === "waiting-manual", run.advancement);
const mailboxDir = join(scratch, ".pi", "swarm", "mailboxes");
const recs = readdirSync(mailboxDir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(mailboxDir, f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)));
const waits = recs.filter((r) => String(r.idempotencyKey || "").startsWith("issues-manual-wait:"));
ok("manual lane: exactly one wait notice with resume command", waits.length === 1 && /\/swarm issues resume/.test(waits[0].body ?? ""), waits.length);
// resume through the real command
await handleIssuesCommand("issues", ["resume"], { cwd: scratch, ui: { notify: () => {} } }, p, {});
run = getIssueRun(await readState(p, scratch));
ok("manual lane: resume activated fix-two", run.activeIssueId === "fix-two" && run.queue[1].status === "active", run.activeIssueId);
ok("manual lane: waiting marker cleared", !run.advancement, run.advancement);
console.log(`\nISSUES-MANUAL-ADVANCE LANE ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
try {
	rmSync(scratch, { recursive: true, force: true });
} catch {
	// best-effort cleanup (tmp rotation handles leftovers)
}
process.exit(fail === 0 ? 0 : 1);
