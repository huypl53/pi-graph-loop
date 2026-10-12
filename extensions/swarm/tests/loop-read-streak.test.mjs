#!/usr/bin/env node
/**
 * Test: loop-read-streak green suite (task loop-read-streak-guard Phase 3+4).
 *
 * Unit coverage (detector core + hooks, per plan §5 matrix):
 *   T1 active-segment pause (settle freezes accumulator; idle gap excluded)
 *   T2 persistence across detector instances (state file survives)
 *   T3 task change resets
 *   T4 bash = OTHER reset (fail-closed, zero sends)
 *   T5 both-gates AND (calls alone insufficient)
 *   T6 continuation guard (one nudge per milestone, cap 3)
 *   T7 escalate once (milestone-4 boundary, persisted flag, no re-escalation)
 *   T8 toggle off (fresh read each event, zero effect)
 *   T9 root-only command (non-root /swarm loop on rejected)
 *   R10-1 C-R10-1-1 send counting at the real turns.ts boundary
 *   R10-1 C-R10-1-4 no alternate sinks (loop-detect has zero sendMessage/abort references)
 *
 * Uses the mock-llm live lanes for milestones/reset/escalate-once when RUN_LANES=1
 * (transcript assertions per plan §3); unit assertions always run.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { paths, ensureDirs, readState, withLock, writeState } = await import(join(here, "..", "src", "state.ts"));
const { registerSwarmHooks } = await import(join(here, "..", "src", "hooks.ts"));
const { registerSwarmCommand } = await import(join(here, "..", "src", "commands", "index.ts"));
// Namespace import: `readStreakSendCount` is a mutable module-level let in turns.ts — a
// destructured import would snapshot the number at import time and never see increments.
const turnsMod = await import(join(here, "..", "src", "hooks", "turns.ts"));
const { resetReadStreakSendCount } = turnsMod;
const { deliverMessageLocked } = await import(join(here, "..", "src", "mailbox.ts"));

const dir = await mkdtemp(join(tmpdir(), "loop-read-streak-"));
await mkdir(join(dir, ".pi"), { recursive: true });
await writeFile(join(dir, ".pi", "swarm.yml"), stringify({ defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" }));
process.chdir(dir);
const p = paths(dir);
await ensureDirs(p);

// Worker identity (agents set PI_SWARM_AGENT_ID; this lane simulates worker-01 on task-a).
process.env.PI_SWARM_AGENT_ID = "worker-01";
delete process.env.PI_SWARM_IS_ROOT;
// Lane-shortened time gate: 1 milestone unit = 6 calls + 1s active (override lives in the
// LANE COMMAND per plan §3 — never in fixtures).
process.env.PI_SWARM_READ_STREAK_CALLS = "6";
process.env.PI_SWARM_READ_STREAK_MS = "1000";

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

// Seed the agent record so activeTaskIds lookups resolve.
const st0 = await readState(p, dir);
st0.agents["worker-01"] = {
	id: "worker-01",
	role: "implementer",
	roleKind: "worker",
	capabilities: [],
	activeTaskIds: ["task-loop-1"],
	maxConcurrentTasks: 1,
	status: "running",
	runtimeStatus: "busy",
	health: "healthy",
	pid: process.pid,
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
};
await writeState(p, st0);

// Register the PRODUCTION hooks (turns/tools/settled) against a capturing pi facade.
const handlers = {};
const sentMessages = [];
const pi = {
	registerTool: () => {},
	registerCommand: () => {},
	on: (ev, fn) => {
		(handlers[ev] ||= []).push(fn);
	},
	sendMessage: (m, o) => {
		sentMessages.push({ m, o });
	},
	setModel: async () => true,
};
registerSwarmHooks(pi);

const ctx = { cwd: dir, mode: "print" };

async function turnEndOnce() {
	for (const fn of handlers["turn_end"] ?? []) await fn({ type: "turn_end", message: { role: "assistant", stopReason: "toolUse" }, toolResults: [] }, ctx);
}
async function settle() {
	for (const fn of handlers["agent_settled"] ?? []) await fn({ type: "agent_settled" }, ctx);
}
/** Observe one completed tool call through the PRODUCTION tool_result hook. */
async function toolResult(toolName) {
	for (const fn of handlers["tool_result"] ?? []) await fn({ type: "tool_result", toolName, content: [{ type: "text", text: "x" }] }, ctx);
}
/** Fire the production turn_end handlers. */
async function turnEnd() {
	for (const fn of handlers["turn_end"] ?? []) await fn({ type: "turn_end", message: { role: "assistant", stopReason: "toolUse" }, toolResults: [] }, ctx);
}
async function streak() {
	const st = await readState(p, dir);
	const all = Object.values(st.readStreaks ?? {});
	if (all.length === 0) return null;
	// Prefer the streak for the agent's CURRENT active task (insertion order makes values[0]
	// unreliable after a task change).
	const currentTask = st.agents["worker-01"]?.activeTaskIds?.[0];
	return all.find((s) => s.taskId === currentTask) ?? all[0];
}

// ============================================================================
console.log("== T1: active-segment pause (settle freezes accumulator; idle excluded) ==");
resetReadStreakSendCount();
for (let i = 0; i < 3; i++) {
	await toolResult("read");
}
let s = await streak();
ok("3 reads counted, segment open", s && s.readCallCount === 3 && s.segmentStartedAt !== null, s);
const frozenActive = s.accumulatedActiveMs;
await settle();
s = await streak();
ok("settle froze segment (segmentStartedAt null, accumulator >= frozen)", s && s.segmentStartedAt === null && s.accumulatedActiveMs >= frozenActive, s);
// Idle gap: wait 50ms — the gap must NOT accrue (segment is paused).
await new Promise((r) => setTimeout(r, 50));
await toolResult("read");
s = await streak();
ok("idle gap excluded: accumulator == frozen (±25ms), segment reopened", s && Math.abs(s.accumulatedActiveMs - frozenActive) < 25 && s.segmentStartedAt !== null, {
	acc: s.accumulatedActiveMs,
	frozenActive,
});

// ============================================================================
console.log("== T2: persistence across detector instances (state file) ==");
// The streak above is already persisted; simulate a "restart" by re-reading through a fresh
// import of the detector module (new module instance, same state file).
const { observeToolCall: observeFresh } = await import(`${join(here, "..", "src", "nudges", "loop-detect.ts")}?fresh=${Date.now()}`);
const res2 = await observeFresh(pi, dir, "read", { taskId: "task-loop-1" });
s = await streak();
ok("persisted count continued (5 reads after fresh instance)", s && s.readCallCount === 5, s);
ok("same streakId across instances (persisted, not reset)", res2.streak && s && res2.streak.streakId === s.streakId);

// ============================================================================
console.log("== T3: task change resets ==");
await withLock(p, async () => {
	const st = await readState(p, dir);
	st.agents["worker-01"].activeTaskIds = ["task-loop-2"];
	await writeState(p, st);
});
await toolResult("read");
s = await streak();
ok("new task → new streak at count 1", s && s.readCallCount === 1 && s.taskId === "task-loop-2", s);
{
	const st = await readState(p, dir);
	const oldStreak = st.readStreaks?.["worker-01\u0000task-loop-1"];
	ok("old task streak deleted", !oldStreak, { old: oldStreak ?? null });
}

// ============================================================================
console.log("== T4: bash = OTHER reset (fail-closed) ==");
resetReadStreakSendCount();
for (let i = 0; i < 3; i++) await toolResult("read");
await toolResult("bash"); // OTHER
s = await streak();
{
	const stNow = await readState(p, dir);
	ok("bash deleted the whole streak (current task key gone)", !stNow.readStreaks?.["worker-01\u0000task-loop-2"], { cur: stNow.readStreaks?.["worker-01\u0000task-loop-2"] ?? null });
}
for (let i = 0; i < 3; i++) await toolResult("read");
s = await streak();
ok("post-bash reads start a FRESH streak (count 3, not 6)", s && s.readCallCount === 3, s);
ok("zero sends so far", turnsMod.readStreakSendCount === 0, { count: turnsMod.readStreakSendCount });

/** Backdate the CURRENT task's streak (state-file surgery to simulate elapsed active time). */
async function backdateCurrentStreak(patch) {
	await withLock(p, async () => {
		const st = await readState(p, dir);
		const task = st.agents["worker-01"]?.activeTaskIds?.[0];
		const cur = task ? st.readStreaks?.[`worker-01\u0000${task}`] : null;
		if (cur) Object.assign(cur, patch);
		await writeState(p, st);
	});
}

// ============================================================================
console.log("== T5: both-gates AND (calls alone insufficient) ==");
// 6 reads but active < 1000ms (fast loop, no settle pauses) → NO milestone yet.
resetReadStreakSendCount();
for (let i = 0; i < 3; i++) await toolResult("read");
await backdateCurrentStreak({ accumulatedActiveMs: 0 });
for (let i = 0; i < 3; i++) await toolResult("read");
await turnEnd();
s = await streak();
ok("6 reads with 0 active ms → NO milestone (gate AND)", s && s.milestones.length === 0, s);
ok("zero sends when time gate unmet", turnsMod.readStreakSendCount === 0, { count: turnsMod.readStreakSendCount });
// Now satisfy the time gate: settle adds nothing (segment open accrues on next read), so
// backdate the accumulated time directly to simulate elapsed active time.
await backdateCurrentStreak({ accumulatedActiveMs: 1500 });
await toolResult("read"); // 7th read, active >= 1000 → milestone 1 should fire
s = await streak();
ok("7th read with active >= 1000ms → milestone 1 fired", s && s.milestones.length === 1 && s.milestones[0].k === 1, s);
ok("milestoneJustFired set", s && s.milestoneJustFired?.k === 1, s);

// ============================================================================
console.log("== T6: continuation guard (turn_end consumes exactly once, cap 3) ==");
resetReadStreakSendCount();
await turnEnd(); // should consume the milestone → BoundaryResult
s = await streak();
ok("turn_end returned a BoundaryResult when milestone fired (checked via flag cleared)", s && !s.milestoneJustFired, s);
ok("R10-1 send counter == 1 after one milestone turn_end", turnsMod.readStreakSendCount === 1, { count: turnsMod.readStreakSendCount });
await turnEnd(); // no new milestone
ok("second turn_end (no milestone) → still 1 send", turnsMod.readStreakSendCount === 1, { count: turnsMod.readStreakSendCount });

// ============================================================================
console.log("== T7: escalate once (milestone-4 boundary) ==");
// Fast-forward: drive nudges 2 and 3 by backdating time and observing reads.
for (let k = 2; k <= 3; k++) {
	await backdateCurrentStreak({ accumulatedActiveMs: 1000 * k, readCallCount: 6 * k });
	await toolResult("read");
}
s = await streak();
ok("nudges reached 3 (cap)", s && s.nudges === 3 && s.milestones.length === 3, s);
// Milestone-4 boundary: one more READ with the cap reached and streak unbroken → escalated.
await backdateCurrentStreak({ accumulatedActiveMs: 4000 });
await toolResult("read");
s = await streak();
ok("milestone-4 boundary set escalated=true (streak unbroken)", s && s.escalated === true, s);
// R10-1 C-R10-1-3: the escalation's ONE legitimate root send is the durable mailbox append
// through deliverMessageLocked (plan §4 boundary definition) — live pi.sendMessage injection
// only fires when the root pane is running, which a unit lane does not provide.
const { readMailbox } = await import(join(here, "..", "src", "mailbox.ts"));
const rootMailboxBefore = (await readMailbox(p, "root")).length;
await turnEnd();
const rootMailboxAfter = await readMailbox(p, "root");
ok("escalation delivered to root exactly once via deliverMessage path", rootMailboxAfter.length - rootMailboxBefore === 1, {
	mailbox: rootMailboxAfter.map((m) => m.subject),
});
ok("escalation body carries agent/task/streak evidence", rootMailboxAfter.at(-1)?.body?.includes("worker-01"), rootMailboxAfter.at(-1)?.body?.slice(0, 80));
await turnEnd();
ok("no re-escalation on later turn_end (persisted latch)", (await readMailbox(p, "root")).length === rootMailboxAfter.length, { total: rootMailboxAfter.length });

// ============================================================================
console.log("== T8: toggle off (fresh read each event, zero effect) ==");
resetReadStreakSendCount();
await withLock(p, async () => {
	const st = await readState(p, dir);
	st.readStreakGuard = { enabled: false, updatedAt: new Date().toISOString() };
	st.readStreaks = {};
	await writeState(p, st);
});
for (let i = 0; i < 10; i++) await toolResult("read");
s = await streak();
ok("guard OFF → no streak state created", !s, s);
ok("guard OFF → zero sends", turnsMod.readStreakSendCount === 0, { count: turnsMod.readStreakSendCount });
await turnEnd();
ok("guard OFF → turn_end no-ops", turnsMod.readStreakSendCount === 0, { count: turnsMod.readStreakSendCount });
// Toggle back ON — must apply on the NEXT event without restart (M3).
await withLock(p, async () => {
	const st = await readState(p, dir);
	st.readStreakGuard = { enabled: true, updatedAt: new Date().toISOString() };
	await writeState(p, st);
});
await toolResult("read");
s = await streak();
ok("guard re-ON → counting resumes immediately", s && s.readCallCount === 1, s);

// ============================================================================
console.log("== T9: root-only command (non-root /swarm loop on rejected) ==");
{
	const notifies = [];
	const loopPi = { registerTool: () => {}, registerCommand: (_n, _o) => {}, on: () => {}, sendMessage: () => {} };
	// Drive handleLoopCommand directly with a non-root agent identity.
	const { handleLoopCommand } = await import(join(here, "..", "src", "commands", "loop.ts"));
	process.env.PI_SWARM_AGENT_ID = "worker-01"; // non-root
	await handleLoopCommand("loop", ["on"], { ui: { notify: (msg, level) => notifies.push({ msg, level }) } }, p, loopPi);
	ok("non-root loop on → warning, no state change", notifies[0]?.level === "warning", notifies);
	const st = await readState(p, dir);
	ok("state file untouched by non-root attempt", st.readStreakGuard?.enabled !== undefined ? st.readStreakGuard.enabled === true : true, st.readStreakGuard);
}

// ============================================================================
console.log("== R10-1 C-R10-1-4: no alternate sinks in loop-detect.ts ==");
{
	const { readFileSync } = await import("node:fs");
	const src = readFileSync(join(here, "..", "src", "nudges", "loop-detect.ts"), "utf8");
	ok("loop-detect.ts has zero pi.sendMessage call sites", !/pi\.sendMessage\(/.test(src));
	ok("loop-detect.ts has zero ctx.abort call sites", !/\.abort\(\)/.test(src));
	ok("loop-detect.ts sends root escalation only via deliverMessageLocked", /deliverMessageLocked/.test(src));
}

// ============================================================================
console.log("== Reset-for-escalate-once fixture semantics (unit mirror) ==");
// bash reset ALSO clears escalation (fresh streak, escalated=false) — verified via T4's reset
// plus explicit check:
await withLock(p, async () => {
	const st = await readState(p, dir);
	const cur = Object.values(st.readStreaks ?? {})[0];
	if (cur) {
		cur.escalated = true;
		cur.nudges = 3;
		cur.milestones = [1, 2, 3].map((k) => ({ k, atMs: Date.now(), readCallCount: 6 * k, accumulatedActiveMs: 1000 * k }));
	}
	await writeState(p, st);
});
await toolResult("bash");
s = await streak();
ok("OTHER after escalation → streak deleted (escalation does not survive reset)", !s, s);

console.log(`\nLOOP-READ-STREAK GREEN ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
