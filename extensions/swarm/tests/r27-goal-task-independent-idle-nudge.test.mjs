#!/usr/bin/env node
/**
 * R27 mock-LLM lane (offline, deterministic) — task-independent goal nudge.
 *
 * Exercises the changed behavior END-TO-END against the REAL production pump
 * (pumpRootMailbox → updateIdleEpochLocked → evaluateIdleGoalNudgeLocked →
 * deliverMessageLocked → surface re-check), with PI_SWARM_GOAL_IDLE_CHECK_INTERVAL_MS=1000
 * and PI_SWARM_GOAL_IDLE_CHECKS_REQUIRED=3 so a full streak needs exactly 3
 * wall-clock seconds — deterministic, no live model, no tmux.
 *
 * Seeded world = the pre-R27 incident shape: live in_progress task, node
 * assigned to an IDLE worker, activeTaskIds already released, user goal set.
 * Pre-R27 this world silenced the goal floor forever (reason "active_task").
 * Post-R27 the pump must emit exactly one nudge at the 3rd eligible tick.
 *
 * The tmux companion lane (real pi TUI + mock-llm scripted root turns) is
 * captured at tmux-snapshots/r27-validation/ — this file is the offline
 * regression harness with the same acceptance criteria.
 *
 * Run: node tests/r27-goal-task-independent-idle-nudge.test.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = await import(join(here, "../src/reconcile.ts"));
const { paths, ensureDirs, readState, writeState } = await import(join(here, "../src/state.ts"));
const { ensureRoot, claimRootLeader } = await import(join(here, "../src/identity.ts"));

process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_GOAL_IDLE_CHECK_INTERVAL_MS = "1000";
process.env.PI_SWARM_GOAL_IDLE_CHECKS_REQUIRED = "3";

let pass = 0, fail = 0;
const ok = (name, condition, info = "") => { if (condition) { pass++; console.log("  ok  ", name); } else { fail++; console.error("  FAIL", name, info); } };

const dir = mkdtempSync(join(tmpdir(), "r27-lane-"));
const p = paths(dir);
await ensureDirs(p);

// --- Seed the pre-R27 incident world ---
const t0 = new Date().toISOString();
const st = await readState(p, dir);
ensureRoot(st, dir, p);
st.agents["worker-a"] = {
	id: "worker-a", role: "implementer", roleKind: "worker", capabilities: [],
	activeTaskIds: [], maxConcurrentTasks: 1,
	status: "running", runtimeStatus: "idle", health: "healthy",
	tmuxAlive: true, model: "mock", provider: "mock-llm",
	lastHeartbeatAt: t0, createdAt: t0, updatedAt: t0,
};
st.goal = { id: "goal-r27", text: "R27 lane: task-independent floor", setAt: t0, setBy: "root", origin: "user", consecutiveNoResolveNudges: 0 };
await writeState(p, st);
await claimRootLeader(st, Date.now(), process.pid);
await writeState(p, st);
const taskDir = join(p.tasksDir, "task-r27-open");
mkdirSync(taskDir, { recursive: true });
writeFileSync(join(taskDir, "task.json"), JSON.stringify({
	version: 1, taskId: "task-r27-open", title: "R27 open assigned task", goal: "repro",
	status: "in_progress", priority: "normal", createdAt: t0, updatedAt: t0, owner: "root",
	workflow: "feature-dev", allowedFiles: [], acceptanceCriteria: [], validationCommands: [],
	start: "implement", currentNodes: ["implement"],
	sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
	nodes: {
		implement: { status: "in_progress", role: "worker", assignee: "worker-a", dependsOn: [], messageIds: [], attempts: 1, lastActivityAt: t0 },
		review: { status: "pending", role: "reviewer", dependsOn: ["implement"] },
	},
	edges: [{ from: "implement", to: "review", when: "implemented" }],
	handoffs: [], gates: {}, editLocks: {}, evidence: {},
}, null, 2));

// --- Drive the REAL pump across the streak (3 ticks × ~1.05s apart) ---
const sentMessages = [];
const pi = { sendMessage: async (content, opts) => { sentMessages.push({ content, opts }); return true; }, registerTool: () => {}, on: () => {} };
const ctx = { cwd: dir, mode: "tui", isIdle: () => true };
await src.pumpRootMailbox(pi, ctx, p, "watchdog");           // sample 1
await new Promise(r => setTimeout(r, 1050));
await src.pumpRootMailbox(pi, ctx, p, "watchdog");           // sample 2
ok("no nudge before the streak completes (2/3 samples)", sentMessages.length === 0, JSON.stringify(sentMessages.map(m => m.content.slice(0, 60))));
await new Promise(r => setTimeout(r, 1050));
await src.pumpRootMailbox(pi, ctx, p, "watchdog");           // sample 3 → EMIT + surface

// --- Verdicts ---
ok("goal nudge emitted at the 3rd sample despite the open assigned task node", sentMessages.length >= 1, `sent=${sentMessages.length}`);
const sentBodies = sentMessages.map((m) => JSON.stringify(m));
ok("surfaced content is the idle-streak goal nudge", sentBodies.some(b => b.includes("Idle streak") || b.includes("goal-r27")), JSON.stringify(sentBodies.map(b => b.slice(0, 80))));
const traceLines = existsSync(p.events) ? readFileSync(p.events, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const checks = traceLines.filter(e => e.event === "goal.idle_check");
ok("goal.idle_check traced for each eligible sample", checks.length >= 3, `checks=${checks.length}`);
ok("streak counter climbed 1→2→3", checks.slice(0, 3).map(c => c.count).join(",") === "1,2,3", JSON.stringify(checks.map(c => c.count)));
ok("no goal.nudge.error across the whole lane", !traceLines.some(e => e.event === "goal.nudge.error"), traceLines.filter(e => e.event === "goal.nudge.error").map(e => e.error).join(";"));
ok("no pre-R27 task-state suppression traces", !traceLines.some(e => e.event === "goal.nudge.suppressed_by_active_task" || e.event === "goal.nudge.deferred_actionable_graph"), traceLines.filter(e => String(e.event).startsWith("goal.nudge.")).map(e => e.event).join(";"));
const stAfter = await readState(p, dir);
ok("streak reset after emission", (stAfter.idleNudgeState?.goalIdleCheckCount ?? 0) <= 1, `count=${stAfter.idleNudgeState?.goalIdleCheckCount}`);
ok("consecutiveNoResolveNudges climbed to 1", stAfter.goal?.consecutiveNoResolveNudges === 1, `nudges=${stAfter.goal?.consecutiveNoResolveNudges}`);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
if (fail) console.error("R27 LANE FAIL");
else console.log("R27 LANE PASS");
