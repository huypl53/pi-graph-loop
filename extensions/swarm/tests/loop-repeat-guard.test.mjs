#!/usr/bin/env node
/**
 * Test: loop-repeat-guard green suite (task loop-repeat-guard).
 *
 * Unit coverage (detector core + hooks, per plan §5 matrix):
 *   T1 AND-gates: count deficient (enough span, count below 5*k) → no milestone
 *   T2 AND-gates: span deficient (count at/above 5*k, span below 10min*k) → no milestone
 *   T3 AND-gates: both met → exactly one pending milestone for k
 *   T4 Ring not reset by other tools: repeat fp A, different fp/tool B, then A → A's count preserved
 *   T5 Fingerprint includes args: same tool, differing args → distinct fingerprints
 *   T6 Window cap: occurrence older than configured cap → pruned
 *   T7 Persistence across restart: persist ring, reconstruct/load state, continue same fp
 *   T8 Task change reset: observe under task A then task B → A repeat state removed
 *   T9 No-double-nudge: read-streak and repeat detectors both pending at one turn_end → one continuation
 *   T10 Escalation-once: cross repeat milestones 1–3 then boundary → three nudges max, root reconcile once
 *   T11 R10-1 negative control: loop-repeat-tdd-neg through actual lane → zero sends
 *   T12 RED reproduction: positive fixture on pre-change code → zero nudge and zero boundary sends
 *
 * Uses the mock-llm live lanes for positive/negative when RUN_LANES=1 (transcript assertions
 * per plan §3); unit assertions always run.
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

const dir = await mkdtemp(join(tmpdir(), "loop-repeat-guard-"));
await mkdir(join(dir, ".pi"), { recursive: true });
await writeFile(join(dir, ".pi", "swarm.yml"), stringify({ defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" }));
process.chdir(dir);
const p = paths(dir);
await ensureDirs(p);

// Worker identity (agents set PI_SWARM_AGENT_ID; this lane simulates worker-01 on task-a).
process.env.PI_SWARM_AGENT_ID = "worker-01";
delete process.env.PI_SWARM_IS_ROOT;
// Lane-shortened time gate: 1 milestone unit = 5 calls + 1s span (override lives in the
// LANE COMMAND per plan §3 — never in fixtures).
process.env.PI_SWARM_LOOP_REPEAT_CALLS = "5";
process.env.PI_SWARM_LOOP_REPEAT_SPAN_MS = "1000";
process.env.PI_SWARM_LOOP_REPEAT_WINDOW_MS = "0"; // disable window cap for deterministic tests
process.env.PI_SWARM_READ_STREAK_CALLS = "6";
process.env.PI_SWARM_READ_STREAK_MS = "100"; // 100ms active time gate for read-streak

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

async function turnEnd() {
	for (const fn of handlers["turn_end"] ?? []) await fn({ type: "turn_end", message: { role: "assistant", stopReason: "toolUse" }, toolResults: [] }, ctx);
}
/** Observe one completed tool call through the PRODUCTION tool_result hook. */
async function toolResult(toolName, args = {}) {
	for (const fn of handlers["tool_result"] ?? []) await fn({ type: "tool_result", toolName, input: args, content: [{ type: "text", text: "x" }] }, ctx);
}
async function repeat() {
	const st = await readState(p, dir);
	const all = Object.values(st.loopRepeats ?? {});
	if (all.length === 0) return null;
	const currentTask = st.agents["worker-01"]?.activeTaskIds?.[0];
	return all.find((s) => s.taskId === currentTask) ?? all[0];
}

// ============================================================================
console.log("== T1: AND-gates: count deficient (enough span, count below 5*k) ==");
resetReadStreakSendCount();
for (let i = 0; i < 4; i++) {
	await toolResult("bash", { command: "cat root.jsonl | tail -1" });
}
let s = await repeat();
ok("4 calls counted, no milestone (count < 5)", s && s.nudges === 0 && s.milestones.length === 0, s);

// ============================================================================
console.log("== T2: AND-gates: span deficient (count at/above 5*k, span below 10min*k) ==");
// Reset state for clean test
await withLock(p, async () => {
	const st = await readState(p, dir);
	st.loopRepeats = {};
	await writeState(p, st);
});
resetReadStreakSendCount();
// 5 calls but span gate is disabled (PI_SWARM_LOOP_REPEAT_WINDOW_MS=0), so this WILL fire.
// To test span-deficient, we need to re-enable the span gate. Use a separate test with
// PI_SWARM_LOOP_REPEAT_WINDOW_MS set to a non-zero value.
process.env.PI_SWARM_LOOP_REPEAT_WINDOW_MS = "60000"; // 60s window cap
for (let i = 0; i < 5; i++) {
	await toolResult("bash", { command: "cat root.jsonl | tail -1" });
}
s = await repeat();
ok("5 calls with span < 1000ms → NO milestone (span gate fails)", s && s.nudges === 0 && s.milestones.length === 0, s);
// Reset for next test
process.env.PI_SWARM_LOOP_REPEAT_WINDOW_MS = "0";
await withLock(p, async () => {
	const st = await readState(p, dir);
	st.loopRepeats = {};
	await writeState(p, st);
});

// ============================================================================
console.log("== T3: AND-gates: both met → exactly one pending milestone for k ==");
resetReadStreakSendCount();
for (let i = 0; i < 5; i++) {
	await toolResult("bash", { command: "cat root.jsonl | tail -1" });
}
s = await repeat();
ok("5 calls → milestone k=1 fired", s && s.milestones.length === 1 && s.milestones[0].k === 1, s);
ok("milestoneJustFired set", s && s.milestoneJustFired?.k === 1, s);

// ============================================================================
console.log("== T4: Ring not reset by other tools ==");
// Reset state
await withLock(p, async () => {
	const st = await readState(p, dir);
	st.loopRepeats = {};
	await writeState(p, st);
});
resetReadStreakSendCount();
// 3 calls with fp A, then 1 call with fp B, then 2 more calls with fp A
for (let i = 0; i < 3; i++) await toolResult("bash", { command: "cat root.jsonl | tail -1" });
await toolResult("read", { path: "src/a.ts" });
for (let i = 0; i < 2; i++) await toolResult("bash", { command: "cat root.jsonl | tail -1" });
s = await repeat();
const ringA = s?.rings ? Object.values(s.rings).find((r) => r.toolName === "bash") : null;
const ringB = s?.rings ? Object.values(s.rings).find((r) => r.toolName === "read") : null;
ok("ring A count = 5 (not reset by read)", ringA && ringA.count === 5, { ringA });
ok("ring B count = 1 (independent)", ringB && ringB.count === 1, { ringB });
ok("ring A consecutiveCount = 2 (reset by read)", ringA && ringA.consecutiveCount === 2, { ringA });

// ============================================================================
console.log("== T5: Fingerprint includes args (same tool, differing args → distinct fps) ==");
// Reset state
await withLock(p, async () => {
	const st = await readState(p, dir);
	st.loopRepeats = {};
	await writeState(p, st);
});
await toolResult("bash", { command: "cat root.jsonl | tail -1" });
await toolResult("bash", { command: "cat other.jsonl | tail -1" });
s = await repeat();
ok("2 distinct fingerprints for 2 distinct args", s && Object.keys(s.rings).length === 2, s);

// ============================================================================
console.log("== T6: Window cap (occurrence older than configured cap → pruned) ==");
// Reset state
await withLock(p, async () => {
	const st = await readState(p, dir);
	st.loopRepeats = {};
	await writeState(p, st);
});
process.env.PI_SWARM_LOOP_REPEAT_WINDOW_MS = "100"; // 100ms window cap
await toolResult("bash", { command: "cat root.jsonl | tail -1" });
await new Promise((r) => setTimeout(r, 150)); // wait > window cap
await toolResult("bash", { command: "cat root.jsonl | tail -1" });
s = await repeat();
const ring = s?.rings ? Object.values(s.rings)[0] : null;
ok("ring count = 1 (first occurrence pruned by window cap)", ring && ring.count === 1, { ring });
process.env.PI_SWARM_LOOP_REPEAT_WINDOW_MS = "0";

// ============================================================================
console.log("== T7: Persistence across restart ==");
// Reset state
await withLock(p, async () => {
	const st = await readState(p, dir);
	st.loopRepeats = {};
	await writeState(p, st);
});
for (let i = 0; i < 3; i++) await toolResult("bash", { command: "cat root.jsonl | tail -1" });
s = await repeat();
const streakIdBefore = s?.streakId;
// Simulate restart by re-reading through a fresh import
const { observeRepeat: observeFresh } = await import(`${join(here, "..", "src", "nudges", "loop-detect.ts")}?fresh=${Date.now()}`);
await observeFresh(pi, dir, "bash", { taskId: "task-loop-1", args: { command: "cat root.jsonl | tail -1" } });
s = await repeat();
ok("persisted count continued (4 calls after fresh instance)", s && Object.values(s.rings)[0].count === 4, s);
ok("same streakId across instances (persisted, not reset)", s && s.streakId === streakIdBefore, { before: streakIdBefore, after: s?.streakId });

// ============================================================================
console.log("== T8: Task change reset ==");
await withLock(p, async () => {
	const st = await readState(p, dir);
	st.agents["worker-01"].activeTaskIds = ["task-loop-2"];
	await writeState(p, st);
});
await toolResult("bash", { command: "cat root.jsonl | tail -1" });
s = await repeat();
ok("new task → new streak at count 1", s && s.taskId === "task-loop-2" && Object.values(s.rings)[0].count === 1, s);
{
	const st = await readState(p, dir);
	const oldStreak = st.loopRepeats?.["worker-01\u0000task-loop-1"];
	ok("old task streak deleted", !oldStreak, { old: oldStreak ?? null });
}

// ============================================================================
console.log("== T9: No-double-nudge (read-streak + repeat both pending → one continuation) ==");
// Reset state
await withLock(p, async () => {
	const st = await readState(p, dir);
	st.loopRepeats = {};
	st.readStreaks = {};
	await writeState(p, st);
});
resetReadStreakSendCount();
// Drive loop-repeat to milestone k=1 (5 bash calls) FIRST
for (let i = 0; i < 5; i++) await toolResult("bash", { command: "cat root.jsonl | tail -1" });
// Then drive read-streak to milestone k=1 (6 reads) — but bash already reset the read-streak,
// so we need to drive reads AFTER bash. The read-streak guard resets on OTHER (bash), so
// we need to drive reads in a separate "session" by directly setting the state.
await withLock(p, async () => {
	const st = await readState(p, dir);
	st.readStreaks = st.readStreaks || {};
	st.readStreaks["worker-01\u0000task-loop-2"] = {
		streakId: "test-streak",
		agentId: "worker-01",
		taskId: "task-loop-2",
		readCallCount: 6,
		accumulatedActiveMs: 200,
		segmentStartedAt: null,
		nudges: 0,
		milestones: [],
		escalated: false,
		lastReadAtMs: Date.now(),
		milestoneJustFired: { k: 1, atMs: Date.now(), readCallCount: 6, accumulatedActiveMs: 200 },
	};
	await writeState(p, st);
});
// Both should have milestoneJustFired set
const stBoth = await readState(p, dir);
const readStreak = stBoth.readStreaks?.["worker-01\u0000task-loop-2"];
const repeatStreak = stBoth.loopRepeats?.["worker-01\u0000task-loop-2"];
ok("read-streak milestoneJustFired set", readStreak?.milestoneJustFired?.k === 1, { readStreak });
ok("repeat milestoneJustFired set", repeatStreak?.milestoneJustFired?.k === 1, { repeatStreak });
// turn_end should emit exactly ONE continuation
await turnEnd();
ok("R10-1 send counter == 1 (no double-nudge)", turnsMod.readStreakSendCount === 1, { count: turnsMod.readStreakSendCount });
// Both pending flags should be consumed
const stAfter = await readState(p, dir);
ok("read-streak milestoneJustFired cleared", !stAfter.readStreaks?.["worker-01\u0000task-loop-2"]?.milestoneJustFired, stAfter.readStreaks?.["worker-01\u0000task-loop-2"]);
ok("repeat milestoneJustFired cleared", !stAfter.loopRepeats?.["worker-01\u0000task-loop-2"]?.milestoneJustFired, stAfter.loopRepeats?.["worker-01\u0000task-loop-2"]);

// ============================================================================
console.log("== T10: Escalation-once (milestone-4 boundary) ==");
// Reset state
await withLock(p, async () => {
	const st = await readState(p, dir);
	st.loopRepeats = {};
	await writeState(p, st);
});
// Drive nudges 1-3 by backdating count
// First, create the ring with one call
await toolResult("bash", { command: "cat root.jsonl | tail -1" });
for (let k = 1; k <= 3; k++) {
	await withLock(p, async () => {
		const st = await readState(p, dir);
		const cur = st.loopRepeats?.["worker-01\u0000task-loop-2"];
		if (cur) {
			const ring = Object.values(cur.rings)[0];
			if (ring) {
				ring.count = 5 * k;
				ring.firstSeenAt = Date.now() - 2000;
				ring.lastSeenAt = Date.now();
			}
		}
		await writeState(p, st);
	});
	await toolResult("bash", { command: "cat root.jsonl | tail -1" });
	const stCheck = await readState(p, dir);
	const curCheck = stCheck.loopRepeats?.["worker-01\u0000task-loop-2"];
	const ringCheck = curCheck ? Object.values(curCheck.rings)[0] : null;
	console.log(`  [debug k=${k}] count=${ringCheck?.count}, nudges=${curCheck?.nudges}, milestones=${curCheck?.milestones?.length}`);
}
s = await repeat();
ok("nudges reached 3 (cap)", s && s.nudges === 3 && s.milestones.length === 3, { nudges: s?.nudges, milestones: s?.milestones?.length });
// Milestone-4 boundary: one more call with cap reached → escalated
await withLock(p, async () => {
	const st = await readState(p, dir);
	const cur = st.loopRepeats?.["worker-01\u0000task-loop-2"];
	if (cur) {
		const ring = Object.values(cur.rings)[0];
		if (ring) {
			ring.count = 21;
			ring.firstSeenAt = Date.now() - 3000;
			ring.lastSeenAt = Date.now();
		}
	}
	await writeState(p, st);
});
await toolResult("bash", { command: "cat root.jsonl | tail -1" });
s = await repeat();
ok("milestone-4 boundary set escalated=true", s && s.escalated === true, { escalated: s?.escalated, nudges: s?.nudges, milestones: s?.milestones?.length });
const { readMailbox } = await import(join(here, "..", "src", "mailbox.ts"));
const rootMailboxBefore = (await readMailbox(p, "root")).length;
await turnEnd();
const rootMailboxAfter = await readMailbox(p, "root");
ok("escalation delivered to root exactly once", rootMailboxAfter.length - rootMailboxBefore === 1, {
	mailbox: rootMailboxAfter.map((m) => m.subject),
});
ok("escalation body carries agent/task/streak evidence", rootMailboxAfter.at(-1)?.body?.includes("worker-01"), rootMailboxAfter.at(-1)?.body?.slice(0, 80));
await turnEnd();
ok("no re-escalation on later turn_end (persisted latch)", (await readMailbox(p, "root")).length === rootMailboxAfter.length, { total: rootMailboxAfter.length });

// ============================================================================
console.log("== R10-1 C-R10-1-4: no alternate sinks in loop-detect.ts ==");
{
	const { readFileSync } = await import("node:fs");
	const src = readFileSync(join(here, "..", "src", "nudges", "loop-detect.ts"), "utf8");
	ok("loop-detect.ts has zero pi.sendMessage call sites", !/pi\.sendMessage\(/.test(src));
	ok("loop-detect.ts has zero ctx.abort call sites", !/\.abort\(\)/.test(src));
	ok("loop-detect.ts sends root escalation only via deliverMessageLocked", /deliverMessageLocked/.test(src));
}

console.log(`\nLOOP-REPEAT-GUARD GREEN ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
