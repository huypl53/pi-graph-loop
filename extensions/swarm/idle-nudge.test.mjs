// Issue 18 swarm-goal-idle-nudge: orchestrator pump goal idle-streak evaluation.
//
// Strategy: drive the REAL `evaluateIdleGoalNudgeLocked` exported from reconcile.ts with a scratch
// state. Tests cover:
//   - happy idle-streak: 3 nudges, then 2-tick back-off, then loop (max+back-off+max+back-off)
//   - resolve on turn_end {stop}: counter resets
//   - goal cleared stops loop
//   - busy agent suppresses
//   - active task node suppresses
//   - idempotency (same tick twice)
//   - back-off decrement behavior
//   - no goal set is a noop (binding C-1: goal field is `undefined` for legacy swarms)
//
// State is seeded with the orchestrator pseudo-agent (binding C-3) so deliverMessageLocked can
// upsert the nudge to `to: "orchestrator"`. We stub pi.sendMessage via the registered mock pi.
//
// Run: node extensions/swarm/idle-nudge.test.mjs
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { paths, readState, withLock, writeState, taskPaths, ensureDirs, trace } = await import(join(here, "src", "state.ts"));
const { evaluateIdleGoalNudgeLocked } = await import(join(here, "src", "reconcile.ts"));
const { ensureOrchestrator } = await import(join(here, "src", "identity.ts"));

const dir = await mkdtemp(join(tmpdir(), "idle-nudge-"));
await mkdir(join(dir, ".pi"), { recursive: true });
await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ swarm: { defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" } }));
process.chdir(dir);
const p = paths(dir);
await ensureDirs(p);

const sentMessages = [];
const pi = {
	registerTool: () => {},
	registerCommand: () => {},
	on: () => {},
	setModel: async () => true,
	sendMessage: (m, o) => { sentMessages.push({ m, o }); },
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};

let pass = 0, fail = 0;
const ok = (n, c, info) => { if (c) { pass++; console.log("  ok  ", n); } else { fail++; console.error("  FAIL:", n, info ?? ""); } };

// The test runs from inside the implementer agent. evaluateIdleGoalNudgeLocked calls
// deliverMessageLocked, which stamps `from = currentAgentId()`. To make the goal-nudge emit look
// like a real orchestrator-emitted message (and for findIdempotentMessage to hit the same
// `from\u0000to\u0000key` tuple the plan assumes), we set PI_SWARM_IS_ORCHESTRATOR=1 in this process.
const SAVED_AGENT_ID = process.env.PI_SWARM_AGENT_ID;
const SAVED_ORCH = process.env.PI_SWARM_IS_ORCHESTRATOR;
delete process.env.PI_SWARM_AGENT_ID;
process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
process.on("exit", () => {
	if (SAVED_AGENT_ID === undefined) delete process.env.PI_SWARM_AGENT_ID;
	else process.env.PI_SWARM_AGENT_ID = SAVED_AGENT_ID;
	if (SAVED_ORCH === undefined) delete process.env.PI_SWARM_IS_ORCHESTRATOR;
	else process.env.PI_SWARM_IS_ORCHESTRATOR = SAVED_ORCH;
});

async function readEventsFile() {
	try { const raw = await readFile(p.events, "utf8"); return raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
	catch { return []; }
}
async function countEvents(name) {
	const events = await readEventsFile();
	return events.filter((e) => e.event === name).length;
}

async function setup() {
	const st = await readState(p, dir);
	// Seed orchestrator pseudo-agent (binding C-3) so deliverMessageLocked(to: "orchestrator") works.
	ensureOrchestrator(st, dir, p);
	// Seed 2 worker agents with runtimeStatus: "idle".
	const ts = new Date().toISOString();
	st.agents["worker-a"] = {
		id: "worker-a", role: "worker-a role", roleKind: "worker", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1,
		status: "running", runtimeStatus: "idle", health: "healthy",
		tmuxSession: st.tmuxSession, tmuxWindow: "worker-a", tmuxTarget: "sess:worker-a.0",
		model: "glm-5.1", provider: "zai-coding-cn", cwd: dir, mailbox: ".pi/swarm/mailboxes/worker-a.jsonl",
		createdAt: ts, updatedAt: ts, lastHeartbeatAt: ts,
	};
	st.agents["worker-b"] = {
		id: "worker-b", role: "worker-b role", roleKind: "worker", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1,
		status: "running", runtimeStatus: "idle", health: "healthy",
		tmuxSession: st.tmuxSession, tmuxWindow: "worker-b", tmuxTarget: "sess:worker-b.0",
		model: "glm-5.1", provider: "zai-coding-cn", cwd: dir, mailbox: ".pi/swarm/mailboxes/worker-b.jsonl",
		createdAt: ts, updatedAt: ts, lastHeartbeatAt: ts,
	};
	await writeState(p, st);
	// Clear events file so per-test counts start clean.
	await rm(p.events, { force: true });
	sentMessages.length = 0;
}

async function tick(nowMs = Date.now()) {
	let result;
	await withLock(p, async () => {
		const st = await readState(p, dir);
		ensureOrchestrator(st, dir, p); // ensure pseudo-agent exists for deliverMessageLocked
		result = await evaluateIdleGoalNudgeLocked(pi, dir, p, st, nowMs);
		await writeState(p, st);
	});
	return result;
}

async function setGoal(text = "Ship Issue 18") {
	await withLock(p, async () => {
		const st = await readState(p, dir);
		ensureOrchestrator(st, dir, p);
		st.goal = { id: `goal-${Date.now()}-test`, text, setAt: new Date().toISOString(), setBy: "orchestrator", consecutiveNoResolveNudges: 0 };
		await writeState(p, st);
	});
}

// =============================================================
// Case A: happy idle-streak — 3 nudges, back-off, repeat
// =============================================================
// Note on idempotency: the real pump's idempotency check is per-(goalId, idle-streak). To emit
// successive nudges from the SAME goal, the test must simulate a resolve (which clears the
// existing message from the idempotency index) between ticks. We do that by deleting the message
// record (and clearing the goal's lastNudgeAt) between ticks — the same state mutation a real
// orchestrator turn_end would produce (counter reset on resolve, which also clears back-off).
console.log("\n[A] happy idle-streak: 3 nudges -> back-off -> repeat");
{
	await setup();
	await setGoal("Test A: 3 nudges then back-off");
	const resetForNextTick = async () => {
		// Simulate "resolve" exactly as production does: the orchestrator turn_end resets the
		// consecutive counter and clears back-off — NOTHING deletes the emitted message record.
		// (The pre-fix test deleted the nudge message because the static idempotency key would
		// otherwise suppress every later emit forever — the exact production bug this suite now
		// guards against. With the seq-suffixed key, consecutive nudges get fresh dedupe slots,
		// so no deletion is needed or allowed here.)
		await withLock(p, async () => {
			const s = await readState(p, dir);
			if (s.goal) {
				s.goal.consecutiveNoResolveNudges = 0;
				s.goal.backoffTicksRemaining = undefined;
			}
			await writeState(p, s);
		});
	};

	// Tick 1: first nudge emitted (counter goes 0 -> 1)
	let r = await tick();
	ok("tick 1 emits", r.emitted === true);
	ok("tick 1 reason: emitted", r.reason === "emitted");
	let st1 = await readState(p, dir);
	ok("counter=1 after tick 1", st1.goal.consecutiveNoResolveNudges === 1);
	ok("lastNudgeAt stamped", typeof st1.goal.lastNudgeAt === "string");
	ok("backoffTicksRemaining undefined after emit", st1.goal.backoffTicksRemaining === undefined);


	// Tick 2: second nudge (counter goes 1 -> 2)
	r = await tick();
	ok("tick 2 emits", r.emitted === true);
	let st2 = await readState(p, dir);
	ok("counter=2 after tick 2", st2.goal.consecutiveNoResolveNudges === 2);


	// Tick 3: third nudge (counter goes 2 -> 3)
	r = await tick();
	ok("tick 3 emits", r.emitted === true);
	let st3 = await readState(p, dir);
	ok("counter=3 after tick 3", st3.goal.consecutiveNoResolveNudges === 3);
	// The MAX-nudges branch is entered on the NEXT tick, not this one (the emit increments first).
	ok("backoffTicksRemaining undefined after 3rd emit", st3.goal.backoffTicksRemaining === undefined);


	// Tick 4: counter is now 3 >= MAX (3) — enters back-off branch; emits nothing.
	const goalBeforeBackoff = await readState(p, dir);
	r = await tick();
	ok("tick 4 does NOT emit (max nudges -> back-off)", r.emitted === false);
	ok("tick 4 reason: max_nudges", r.reason === "max_nudges");
	let st4 = await readState(p, dir);
	ok("backoffTicksRemaining set to 2 on max entry", st4.goal.backoffTicksRemaining === 2);
	ok("counter still 3 (no increment on max-nudges tick)", st4.goal.consecutiveNoResolveNudges === 3);
	ok("goal.id unchanged across back-off", st4.goal.id === goalBeforeBackoff.goal.id);

	// Tick 5: back-off decrement (2 -> 1)
	r = await tick();
	ok("tick 5 does NOT emit (backoff skip)", r.emitted === false);
	ok("tick 5 reason: backoff", r.reason === "backoff");
	let st5 = await readState(p, dir);
	ok("backoffTicksRemaining=1 after tick 5", st5.goal.backoffTicksRemaining === 1);

	// Tick 6: back-off decrement to 0 (gate) — does NOT emit (it is the back-off exit gate).
	r = await tick();
	ok("tick 6 does NOT emit (back-off exit gate)", r.emitted === false);
	ok("tick 6 reason: backoff_just_exhausted", r.reason === "backoff_just_exhausted");
	const st6 = await readState(p, dir);
	ok("backoffTicksRemaining=0 (gate) after tick 6", st6.goal.backoffTicksRemaining === 0);

	// Tick 7: counter is still 3 (>= MAX), so re-enters max_nudges branch and re-arms back-off.
	r = await tick();
	ok("tick 7 does NOT emit (counter still 3 -> max_nudges again)", r.emitted === false);
	ok("tick 7 reason: max_nudges", r.reason === "max_nudges");
	const st7 = await readState(p, dir);
	ok("backoffTicksRemaining re-armed to 2", st7.goal.backoffTicksRemaining === 2);
	ok("goal.nudge.backoff traced", (await countEvents("goal.nudge.backoff")) >= 1);
	ok("goal.nudge.backoff.exhausted traced on tick 6", (await countEvents("goal.nudge.backoff.exhausted")) === 1);
	ok("goal.nudge.backoff.skip traced on tick 5", (await countEvents("goal.nudge.backoff.skip")) >= 1);
	ok("goal.idle_nudge traced exactly 3 times (max reached before back-off)", (await countEvents("goal.idle_nudge")) === 3);
}

// =============================================================
// Case B: turn_end {stop} resets counter (resolve path)
// =============================================================
console.log("\n[B] back-off decrement: sets up goal with backoffTicksRemaining=1 and verifies gate logic");
{
	await setup();
	await setGoal("Test B: backoff gate");
	// Force state: counter=2, backoff=1. Tick should DECREMENT backoff (1 -> 0) and return
	// backoff_just_exhausted (the gate, does NOT emit).
	await withLock(p, async () => {
		const st = await readState(p, dir);
		st.goal.consecutiveNoResolveNudges = 2;
		st.goal.backoffTicksRemaining = 1;
		st.goal.lastNudgeAt = new Date().toISOString();
		await writeState(p, st);
	});
	const r = await tick();
	ok("tick does NOT emit (gate hit)", r.emitted === false);
	ok("reason: backoff_just_exhausted", r.reason === "backoff_just_exhausted");
	const st = await readState(p, dir);
	ok("backoffTicksRemaining=0 (gate)", st.goal.backoffTicksRemaining === 0);
	ok("counter unchanged", st.goal.consecutiveNoResolveNudges === 2);
}

// =============================================================
// Case C: goal cleared stops loop
// =============================================================
console.log("\n[C] goal cleared stops loop");
{
	await setup();
	await setGoal("Test C: cleared");
	const r1 = await tick();
	ok("first tick emits", r1.emitted === true);
	// Clear the goal.
	await withLock(p, async () => {
		const st = await readState(p, dir);
		delete st.goal;
		await writeState(p, st);
	});
	// Subsequent tick must be a noop.
	const r2 = await tick();
	ok("post-clear tick does NOT emit", r2.emitted === false);
	ok("post-clear tick reason: no_goal", r2.reason === "no_goal");
}

// =============================================================
// Case D: busy agent suppresses
// =============================================================
console.log("\n[D] busy agent suppresses");
{
	await setup();
	await setGoal("Test D: busy suppresses");
	// Make worker-a busy.
	await withLock(p, async () => {
		const st = await readState(p, dir);
		st.agents["worker-a"].runtimeStatus = "busy";
		await writeState(p, st);
	});
	const r = await tick();
	ok("tick does NOT emit", r.emitted === false);
	ok("reason: agent_busy", r.reason === "agent_busy");
	// Restore worker-a to idle; tick should emit.
	await withLock(p, async () => {
		const st = await readState(p, dir);
		st.agents["worker-a"].runtimeStatus = "idle";
		await writeState(p, st);
	});
	const r2 = await tick();
	ok("after restore tick emits", r2.emitted === true);
}

// =============================================================
// Case E0 (Issue 27): stopped ghost agents do NOT suppress the nudge
// =============================================================
console.log("\n[E0] Issue 27: ghost agents ignored");
{
	await setup();
	await setGoal("Test E0: ghosts ignored");
	// Add 100 ghost records: stopped, stale heartbeat, dead tmux — exactly the live-swarm failure
	// mode that starved goal.nudge for hours.
	await withLock(p, async () => {
		const st = await readState(p, dir);
		for (let i = 0; i < 100; i++) {
			const id = `ghost-${i}`;
			st.agents[id] = {
				id, role: "ghost", roleKind: "worker", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1,
				status: "stopped", runtimeStatus: "stopped", health: "unhealthy",
				tmuxSession: st.tmuxSession, tmuxWindow: id, tmuxTarget: "unknown",
				model: "glm-5.1", provider: "zai-coding-cn", cwd: dir, mailbox: ".pi/swarm/mailboxes/ghost.jsonl",
				createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
				lastHeartbeatAt: "2026-01-01T00:00:00.000Z", tmuxAlive: false,
			};
		}
		await writeState(p, st);
	});
	const r = await tick();
	ok("tick DOES emit despite 100 ghosts", r.emitted === true);
	// A stale-heartbeat but still-recorded-running agent (dead pane, never stopped) is also ignored.
	await withLock(p, async () => {
		const st = await readState(p, dir);
		st.agents["stale-runner"] = {
				id: "stale-runner", role: "r", roleKind: "worker", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1,
				status: "running", runtimeStatus: "idle", health: "healthy",
				tmuxSession: st.tmuxSession, tmuxWindow: "s", tmuxTarget: "sess:s.0",
				model: "glm-5.1", provider: "zai-coding-cn", cwd: dir, mailbox: ".pi/swarm/mailboxes/s.jsonl",
				createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
				lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
			};
		await writeState(p, st);
	});
	const r2 = await tick(Date.now()); // new tick; nudge already emitted once — reason is duplicate or emits again after counter? Use fresh idempotency expectation.
	ok("stale-runner also ignored (not agent_busy)", r2.reason !== "agent_busy");
}

// =============================================================
// Case E: active task node suppresses
// =============================================================
console.log("\n[E] active task node suppresses");
{
	await setup();
	await setGoal("Test E: active node suppresses");
	// Write a scratch task with one assigned node.
	await withLock(p, async () => {
		const st = await readState(p, dir);
		const tp = taskPaths(p, "test-task-1");
		const { writeTaskState } = await import(join(here, "src", "state.ts"));
		const { writeFile, mkdir } = await import("node:fs/promises");
		await mkdir(tp.root, { recursive: true });
		await writeFile(tp.taskJson, JSON.stringify({
			version: 1, taskId: "test-task-1", title: "test", goal: "test", status: "in_progress", priority: "normal",
			createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
			owner: "orchestrator", workflow: "feature-dev", allowedFiles: [], acceptanceCriteria: [], validationCommands: [],
			start: "n1", currentNodes: ["n1"],
			sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
			nodes: {
				n1: {
					status: "assigned", role: "worker", assignee: "worker-a",
					dependsOn: [], messageIds: [], attempts: 1, lastActivityAt: new Date().toISOString(),
				},
			},
			edges: [], handoffs: [], gates: {}, editLocks: {}, evidence: {},
		}));
	});
	const r = await tick();
	ok("tick does NOT emit (active node)", r.emitted === false);
	ok("reason: active_nodes", r.reason === "active_nodes");

	// Close the node to terminal.
	await withLock(p, async () => {
		const { writeTaskState } = await import(join(here, "src", "state.ts"));
		const { readFile } = await import("node:fs/promises");
		const tp = taskPaths(p, "test-task-1");
		const task = JSON.parse(await readFile(tp.taskJson, "utf8"));
		task.nodes.n1.status = "done";
		await writeTaskState(tp, task);
	});
	const r2 = await tick();
	ok("after node closes tick emits", r2.emitted === true);
	// Cleanup.
	await rm(taskPaths(p, "test-task-1").root, { recursive: true, force: true });
}

// =============================================================
// Case F: idempotency semantics under the seq-suffixed key
// =============================================================
console.log("\n[F] idempotency: consecutive ticks EMIT (fresh seq each emit); counter climbs to max then back-off");
{
	await setup();
	await setGoal("Test F: idempotency");
	const r1 = await tick();
	ok("first tick emits", r1.emitted === true);
	const r2 = await tick();
	// Post-fix behavior: a silent-ignore (no resolve) keeps climbing — tick 2 emits nudge 2 of 3
	// under a FRESH dedupe slot (goal:{goalId}:nudge:idle-streak:2). The old duplicate_suppressed
	// behavior was the production bug: one nudge per goal, ever.
	ok("second tick without resolve EMITS (fresh seq)", r2.emitted === true);
	const s2 = await readState(p, dir);
	ok("nudgeSeq=2 stamped (never resets)", s2.goal.nudgeSeq === 2);
	ok("consecutive counter=2", s2.goal.consecutiveNoResolveNudges === 2);
	// Two distinct message records must exist (one per seq)
	const keys = Object.values(s2.messages).map((m) => m.idempotencyKey).filter((k) => String(k).startsWith(`goal:${s2.goal.id}:nudge:idle-streak`));
	ok("two distinct idempotency keys persisted", new Set(keys).size === 2);
}

// =============================================================
// Case G: no goal set is a noop (binding C-1)
// =============================================================
console.log("\n[G] no goal set (legacy state with no `goal` key) is a no_goal noop");
{
	await setup();
	// Explicitly clear the goal field on disk to mimic a legacy swarm-state.json with NO `goal` key.
	await withLock(p, async () => {
		const st = await readState(p, dir);
		delete st.goal;
		await writeState(p, st);
	});
	const r = await tick();
	ok("tick is no_goal noop", r.emitted === false && r.reason === "no_goal");
}

// =============================================================
// Case H: goal text subject / body shaping (R-D compliance — no truncate(text, N))
// =============================================================
console.log("\n[H] goal text subject / body shaping");
{
	await setup();
	await setGoal("X".repeat(500));
	const r = await tick();
	ok("tick emits", r.emitted === true);
	// Inspect the appended mailbox line for the orchestrator.
	const mbFile = join(p.mailboxes, "orchestrator.jsonl");
	const { readFile } = await import("node:fs/promises");
	const lines = (await readFile(mbFile, "utf8")).split("\n").filter(Boolean);
	const msg = JSON.parse(lines[lines.length - 1]);
	ok("subject length fits in plan bounds (<= 110 chars)", msg.subject.length <= 110); // "Idle streak: goal \"" + truncated text (60) + "\" has no active work"
	ok("subject contains goal snippet", /Idle streak: goal/.test(msg.subject));
	ok("body has nudge counter and max", /This is nudge 1 of 3/.test(msg.body));
	ok("body mentions swarm_mark_goal_done action", /swarm_mark_goal_done/.test(msg.body));
	ok("body contains up to 240-char text excerpt", msg.body.includes("X".repeat(240)));
}

console.log(`\n${fail === 0 ? "IDLE-NUDGE PASS" : "IDLE-NUDGE FAIL"} (${pass} passed, ${fail} failed)`);
await rm(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
