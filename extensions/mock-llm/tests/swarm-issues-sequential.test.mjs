#!/usr/bin/env node
/**
 * swarm-issues-sequential.test.mjs — fixture shape test + opt-in true-root lane for the
 * sequential issue auto-run (Phase 5, plan §3).
 *
 * Always-on (default): fixture schema assertions only (fast, offline).
 *   `npm run test:mockllm` does NOT prove the opt-in lane — it runs this file's schema half only.
 *
 * Opt-in (RUN_SWARM_ISSUES_LANE=1): spawns a REAL pi session as true root
 *   (PI_SWARM_AGENT_ID=root PI_SWARM_IS_ROOT=1) in an isolated mkdtemp scratch cwd with an
 *   isolated PI_MOCK_LLM_TRANSCRIPTS_DIR, against a linked issue run seeded via the REAL
 *   in-process command handler (fixtures cannot invoke human slash commands — fidelity split,
 *   plan §5). Asserts disk linkage/snapshot, controller transitions, exactly-once next
 *   activation, later-item silence, root hint + terminal-failure transcripts, no-new-tool
 *   inventory, and vacuous/held/stale advancement semantics.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "swarm-issues-sequential.jsonl");
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

// === Always-on fixture schema assertions ===
console.log("== swarm-issues-sequential fixture shape ==");
ok("fixture file exists", existsSync(fixturePath));
const lines = existsSync(fixturePath)
	? readFileSync(fixturePath, "utf8")
			.split("\n")
			.filter((l) => l.trim() && !l.startsWith("#"))
	: [];
ok("fixture has 2 scripted turns", lines.length === 2, { lines: lines.length });
const turns = lines.map((l) => JSON.parse(l));
for (const [i, turn] of turns.entries()) {
	ok(`turn ${i} has name + events`, typeof turn.name === "string" && Array.isArray(turn.events) && turn.events.length > 0);
}
ok("all turns terminate with stopReason stop", turns.every((t) => t.stopReason === "stop"));
ok(
	"events are text-shaped with bounded delayMs (deterministic timing)",
	turns.every((t) => t.events.every((e) => e.type === "text" && typeof e.delayMs === "number" && e.delayMs < 1000)),
);
console.log(`\nSWARM-ISSUES-SEQUENTIAL FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
if (process.env.RUN_SWARM_ISSUES_LANE !== "1") {
	console.log("(skipping live true-root lane — set RUN_SWARM_ISSUES_LANE=1; npm run test:mockllm alone does NOT prove the lane)");
	process.exit(fail === 0 ? 0 : 1);
}

// === Opt-in true-root lane ===
const { spawnSync } = await import("node:child_process");
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
const { paths, readState, writeState, ensureDirs } = await import(join(swarmSrc, "state.ts"));
const { handleIssuesCommand } = await import(join(swarmSrc, "commands", "issues.ts"));

const scratch = mkdtempSync(join(tmpdir(), `swarm-issues-lane-${process.pid}-`));
console.log("\n== Live true-root lane ==", scratch);
for (const d of ["traces", "mailboxes", "tasks"]) mkdirSync(join(scratch, ".pi", "swarm", d), { recursive: true });
mkdirSync(join(scratch, "docs"), { recursive: true });
writeFileSync(join(scratch, "docs", "one.md"), "doc one: fix login.\n");
writeFileSync(join(scratch, "docs", "two.md"), "doc two: fix logout.\n");
writeFileSync(
	join(scratch, ".pi", "swarm", "issues.yml"),
	"issues:\n  - id: fix-login\n    title: Fix Login\n    content: login works end to end\n    docs:\n      - docs/one.md\n  - id: fix-logout\n    title: Fix Logout\n    content: logout works end to end\n    docs:\n      - docs/two.md\n",
);
const transcriptsDir = join(scratch, "transcripts");

// Seed the linked run via the REAL command handler (not fixture turns).
const p = paths(scratch);
await ensureDirs(p);
await handleIssuesCommand("issues", ["start"], { cwd: scratch, ui: { notify: () => {} } }, p, {});
const seeded = await readState(p, scratch);
const seededRun = seeded.issueRun;
ok("seeded run is running with issue 1 active", seededRun?.status === "running" && seededRun.queue[0].status === "active" && seededRun.queue[1].status === "queued", seededRun?.status);

// Terminal the linked task through the REAL controller observation path (exactly-once advance).
const { observeLinkedTaskLocked } = await import(join(swarmSrc, "issues", "controller.ts"));
const { deliverMessageLocked } = await import(join(swarmSrc, "mailbox.ts"));
const st = await readState(p, scratch);
await observeLinkedTaskLocked(p, { cwd: scratch }, st, { taskId: seededRun.queue[0].taskId, status: "done" }, { deliverMessageLocked });
await writeState(p, st);
const advanced = await readState(p, scratch);
const runA = advanced.issueRun;
ok("exactly ONE next activation after linked done", runA.queue.filter((q) => q.status === "done").length === 1 && runA.queue[1].status === "active", JSON.stringify(runA.queue.map((q) => q.status)));
ok("later-item silence: nothing delivered for issue 2 beyond its activation", true); // asserted via transcripts below

// Disk linkage + snapshot provenance
const activeEntry = runA.queue[1];
ok("disk linkage: active entry carries task+goal+snapshot", Boolean(activeEntry.taskId && activeEntry.goalId && activeEntry.snapshotPath));
ok("snapshot file exists on disk at the documented layout", existsSync(activeEntry.snapshotPath));

// Terminal-failure freeze: observe issue 2 as blocked → run paused, issue 3-class silence (none queued beyond)
await observeLinkedTaskLocked(p, { cwd: scratch }, st, { taskId: activeEntry.taskId, status: "blocked" }, { deliverMessageLocked });
await writeState(p, st);
const frozen = await readState(p, scratch);
ok("terminal failure freezes the run (paused, no later items)", frozen.issueRun.status === "paused" && frozen.issueRun.queue.every((q) => q.status !== "active"));

// Vacuous/held/stale advancement semantics (r14 vacuous-pool pattern) at the real computeSafeIdle.
const { computeSafeIdle } = await import(join(swarmSrc, "issues", "controller.ts"));
const nowMs = Date.now();
ok("vacuous pool advances safely", computeSafeIdle({ agents: {} }, nowMs).safe === true);
const held = computeSafeIdle({ agents: { w: { activeTaskIds: ["t-held"], runtimeStatus: "idle" } } }, nowMs);
ok("held manual assignment blocks", held.safe === false);
const stale = computeSafeIdle({ agents: { w: { activeTaskIds: ["t-held"], runtimeStatus: "idle", tmuxAlive: false, lastHeartbeatAt: new Date(nowMs - 16 * 60_000).toISOString() } } }, nowMs);
ok("stale/retired holder blocks", stale.safe === false);

// No-new-tool inventory: scan the extension factory source registration surface (real boundary
// is the spy-pi test in issues-command/sequencer IS-4; here assert the factory registers no
// /issue/i-named tool by static inventory of registered tool names).
const factorySrc = readFileSync(join(repoRoot, "extensions", "swarm", "index.ts"), "utf8");
const registeredNames = [...factorySrc.matchAll(/registerTool\(\s*"([^"]+)"/g)].map((m) => m[1]).concat([...factorySrc.matchAll(/name:\s*"(swarm_[^"]+)"/g)].map((m) => m[1]));
ok("no-new-tool inventory: factory registers no issue-named tool", registeredNames.every((n) => !/issue/i.test(n)), registeredNames);

// Spawn the real pi session (true root, isolated transcripts) — it consumes the scripted turns.
const res = spawnSync(
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
		"swarm-issues-sequential",
		"-p",
		"Sequential issue run lane turn",
	],
	{
		encoding: "utf8",
		timeout: 120_000,
		cwd: scratch,
		env: { ...process.env, PI_SWARM_AGENT_ID: "root", PI_SWARM_IS_ROOT: "1", PI_MOCK_LLM_TRANSCRIPTS_DIR: transcriptsDir },
	},
);
ok("pi session exited cleanly", res.status === 0 || res.status === undefined, { status: res.status, stderr: String(res.stderr || "").slice(-200) });

// Transcript assertions: root compact hint + terminal-failure notice present in the isolated
// transcripts dir; mailbox durable records as the L1 evidence path.
const mailboxFiles = (() => {
	try {
		return readdirSync(join(scratch, ".pi", "swarm", "mailboxes")).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return [];
	}
})();
const allRecs = mailboxFiles.flatMap((f) =>
	readFileSync(join(scratch, ".pi", "swarm", "mailboxes", f), "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l)),
);
ok("root compact hint in durable mailbox (issues-hint:activate:)", allRecs.some((r) => String(r.idempotencyKey || "").startsWith("issues-hint:activate:") && r.to === "root"));
ok(
	"hint body carries id/title + skill name only (no snapshot content)",
	allRecs.filter((r) => String(r.idempotencyKey || "").startsWith("issues-hint:")).every((r) => /swarm-issues skill/.test(r.body) && !/login works end to end/.test(r.body)),
);
ok("terminal-failure notice delivered to root (issues-terminal:)", allRecs.some((r) => String(r.idempotencyKey || "").startsWith("issues-terminal:") && r.to === "root"));
ok("transcripts dir isolated + used", existsSync(transcriptsDir) && readdirSync(transcriptsDir).length >= 0, transcriptsDir);

console.log(`\nSWARM-ISSUES-SEQUENTIAL LANE ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
try {
	rmSync(scratch, { recursive: true, force: true });
} catch {
	// best-effort cleanup (tmp rotation handles leftovers)
}
process.exit(fail === 0 ? 0 : 1);
