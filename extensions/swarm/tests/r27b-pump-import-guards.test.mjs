#!/usr/bin/env node
/**
 * R27-B — pump-surface import integrity regression guards.
 *
 * Two PRE-EXISTING production bugs found during the R27 tmux validation lane
 * (2026-09-07, /tmp/r27-validation): `src/surface.ts` referenced
 * `checkStallNotificationStale` (line ~399, graph-advance nudge keys) and
 * `evaluateIdleGoalNudgeLocked` (line ~573, the pump's goal tick) WITHOUT
 * importing either. TypeScript transpile-only never flagged it and the unit
 * suite never caught it because tests call the evaluators directly, not
 * through the pump. In a REAL pi lane the pump tick crashed with
 * ReferenceError on every tick:
 *
 *   trace: goal.nudge.error {"error":"evaluateIdleGoalNudgeLocked is not defined"}
 *   Extension error: checkStallNotificationStale is not defined
 *     at staleSurfaceReason (surface.ts:399) via pumpRootMailbox
 *
 * i.e. at HEAD the goal nudge NEVER fired from a real root pump and
 * graph-advance-key surface revalidation crashed. These guards pin the fix.
 *
 * Reproduce-first: the RED artifacts are the tmux lane traces preserved at
 * tmux-snapshots/r27-validation/events.jsonl (pre-fix run) and the baseline
 * probes below (each crashed with ReferenceError on HEAD — verified by
 * copying HEAD surface.ts into the baseline worktree and running the same
 * probe code).
 *
 * Run: node tests/r27b-pump-import-guards.test.mjs
 */
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = await import(join(here, "../src/reconcile.ts"));
const { paths, ensureDirs, readState, writeState } = await import(join(here, "../src/state.ts"));
const { ensureRoot, claimRootLeader } = await import(join(here, "../src/identity.ts"));

let pass = 0, fail = 0;
const ok = (name, condition, info = "") => { if (condition) { pass++; console.log("  ok  ", name); } else { fail++; console.error("  FAIL", name, info); } };

process.env.PI_SWARM_AGENT_ID = "root";

// --- Guard 1: a real pump tick with a goal set reaches evaluateIdleGoalNudgeLocked
// without ReferenceError, and the first streak sample lands (goal.idle_check). ---
{
	const dir = mkdtempSync(join(tmpdir(), "r27b-pump-"));
	const p = paths(dir);
	await ensureDirs(p);
	const st = await readState(p, dir);
	ensureRoot(st, dir, p);
	st.agents["w"] = { id: "w", role: "r", roleKind: "worker", status: "running", runtimeStatus: "idle", lastHeartbeatAt: new Date().toISOString() };
	st.goal = { id: "g1", text: "probe", setAt: new Date().toISOString(), setBy: "root", origin: "root", consecutiveNoResolveNudges: 0 };
	await writeState(p, st);
	await claimRootLeader(st, Date.now(), process.pid);
	await writeState(p, st);
	const pi = { sendMessage: async () => true, registerTool: () => {}, on: () => {} };
	const ctx = { cwd: dir, mode: "tui", isIdle: () => true };
	await src.pumpRootMailbox(pi, ctx, p, "watchdog");
	await new Promise(r => setTimeout(r, 200));
	const traceLines = existsSync(p.events) ? readFileSync(p.events, "utf8") : "";
	ok("pump tick with goal: no goal.nudge.error ReferenceError", !traceLines.includes("goal.nudge.error"), traceLines.split("\n").filter(l => l.includes("goal.nudge.error")).join("; "));
	ok("pump tick with goal: streak sample traced (goal.idle_check)", traceLines.includes("goal.idle_check"), traceLines.split("\n").filter(Boolean).slice(0, 6).join("; "));
	ok("pump tick with goal: no idle.epoch.error", !traceLines.includes("idle.epoch.error"));
}

// --- Guard 2: staleSurfaceReason on a graph-advance key (task:t:node:n:nudge:assign:seq:s)
// reaches checkStallNotificationStale without ReferenceError. ---
{
	const dir = mkdtempSync(join(tmpdir(), "r27b-surface-"));
	const p = paths(dir);
	await ensureDirs(p);
	const st = await readState(p, dir);
	ensureRoot(st, dir, p);
	st.agents["w"] = { id: "w", role: "r", roleKind: "worker", status: "running", runtimeStatus: "idle", lastHeartbeatAt: new Date().toISOString() };
	await writeState(p, st);
	const msg = { id: "m1", idempotencyKey: "task:t1:node:a:nudge:assign:seq:1", createdAt: new Date().toISOString() };
	const taskIndex = { t1: { taskId: "t1", status: "in_progress", start: "a", edges: [], handoffs: [], nodes: { a: { status: "assigned", assignee: "w", dependsOn: [] } } } };
	let result = null;
	let threw = null;
	try { result = await src.staleSurfaceReason(p, st, msg, taskIndex, Date.now()); } catch (err) { threw = String(err); }
	ok("graph-advance key surface check: no ReferenceError (checkStallNotificationStale imported)", threw === null, threw);
	ok("graph-advance key surface check returns a verdict", threw === null && result !== null && typeof result.stale === "boolean", JSON.stringify(result));
}

// --- Guard 3: static source check — every identifier referenced as a call in surface.ts
// must be imported (cheap regex guard against the same class of bug recurring). ---
{
	const surfaceSrc = readFileSync(join(here, "../src/surface.ts"), "utf8");
	for (const ident of ["checkStallNotificationStale", "evaluateIdleGoalNudgeLocked", "updateIdleEpochLocked", "allEffectiveIdleAgents"]) {
		const imported = new RegExp(`import\\s*\\{[^}]*\\b${ident}\\b[^}]*\\}\\s*from`).test(surfaceSrc);
		ok(`surface.ts imports ${ident}`, imported);
	}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
if (fail) console.error("R27-B FAIL");
else console.log("R27-B PASS");
