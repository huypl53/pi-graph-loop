// Issue 81 goal-clear-auth: guard predicate + tool/command integration. R9 a2 incident
// (`"chỉ dùng khi user yêu cầu"` standing goal cleared twice by batch workflow without
// user intent). Goal origin metadata now fences swarm_mark_goal_done / goal replacement.
// Pre-policy default is lenient (origin defaults to "root" when absent); new
// user-origin goals going forward refuse without explicit `approvedByUser: true`.
//
// Strategy: import the real predicate (no I/O), then build the tool set from the real factory
// with a mock `pi` whose tmux exec returns success. State lives under a unique temp scratch dir.
// Tests cover:
//   - classifyGoalClearAuthority pure predicate (7 cases)
//   - tool integration: refuses on user-origin (cases 8/9/10/11)
//   - command integration: /swarm goal done refusal + --force-user-clear bypass (cases 12/13)
//
// Run: node extensions/swarm/goal-clear-auth.test.mjs
import { rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { classifyGoalClearAuthority, GOAL_ORIGIN_USER, GOAL_ORIGIN_ROOT, GOAL_ORIGIN_SYSTEM, GOAL_ORIGIN_BATCH } = await import(join(here, "..", "src", "goals.ts"));
const { registerAgentsTools } = await import(join(here, "..", "src", "tools", "agents.ts"));

const scratch = join(tmpdir(), `swarm-goal-clear-auth-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

const tools = {};
const commands = {};
const pi = {
	registerTool: (def) => { tools[def.name] = def; },
	registerCommand: (name, def) => { commands[name] = def.handler; },
	on: () => {},
	sendMessage: () => {},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};
registerAgentsTools(pi);
const { registerSwarmCommand } = await import(join(here, "..", "src", "command.ts"));
registerSwarmCommand(pi);

const call = async (name, params, cwd = scratch) => {
	const t = tools[name]; if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd });
};
const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");
const readSwarmState = () => JSON.parse(readFileSync(statePath, "utf8"));
const writeSwarmState = (st) => writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");

let pass = 0, fail = 0;
const ok = (n, c, info) => { if (c) { pass++; console.log("  ok  ", n); } else { fail++; console.error("  FAIL", n, info ?? ""); } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);

const AGENT_ID = process.env.PI_SWARM_AGENT_ID;
const setAgentId = (id) => { if (id === undefined) delete process.env.PI_SWARM_AGENT_ID; else process.env.PI_SWARM_AGENT_ID = id; };

// Seed an empty state so subsequent reads have a file to work with.
{
	const seedDir = join(scratch, ".pi", "swarm");
	mkdirSync(seedDir, { recursive: true });
	const { ensureRoot } = await import(join(here, "..", "src", "identity.ts"));
	const { ensureDirs, readState, writeState, paths } = await import(join(here, "..", "src", "state.ts"));
	const p0 = paths(scratch);
	await ensureDirs(p0);
	const st0 = await readState(p0, scratch);
	ensureRoot(st0, scratch, p0);
	await writeState(p0, st0);
}

// =============================================================================
// PREDICATE-ONLY CASES (no I/O — fastest signal)
// =============================================================================

console.log("\n[P1] non-user-origin clear: allowed, no reason");
{
	const r = classifyGoalClearAuthority({
		currentGoal: { id: "g1", origin: GOAL_ORIGIN_ROOT },
		action: "clear",
		actor: "root",
		params: {},
	});
	eq("allowed: true", r.allowed, true);
	eq("no reason", r.reason, undefined);
}

console.log("\n[P2] user-origin clear without approvedByUser: refused");
{
	const r = classifyGoalClearAuthority({
		currentGoal: { id: "g2", origin: GOAL_ORIGIN_USER },
		action: "clear",
		actor: "root",
		params: {},
	});
	eq("allowed: false", r.allowed, false);
	eq("reason: user_origin_active", r.reason, "user_origin_active");
}

console.log("\n[P3] user-origin clear WITH approvedByUser: allowed");
{
	const r = classifyGoalClearAuthority({
		currentGoal: { id: "g3", origin: GOAL_ORIGIN_USER },
		action: "clear",
		actor: "root",
		params: { approvedByUser: true },
	});
	eq("allowed: true", r.allowed, true);
	eq("no reason", r.reason, undefined);
}

console.log("\n[P4] user-origin replace without approval: refused (user_origin_replace_blocked)");
{
	const r = classifyGoalClearAuthority({
		currentGoal: { id: "g4", origin: GOAL_ORIGIN_USER },
		action: "replace",
		actor: "root",
		params: { origin: GOAL_ORIGIN_BATCH },
	});
	eq("allowed: false", r.allowed, false);
	eq("reason: user_origin_replace_blocked", r.reason, "user_origin_replace_blocked");
}

console.log("\n[P5] user-origin replace with new origin (root): still refused (replace is what fires the guard)");
{
	const r = classifyGoalClearAuthority({
		currentGoal: { id: "g5", origin: GOAL_ORIGIN_USER },
		action: "replace",
		actor: "root",
		params: { origin: GOAL_ORIGIN_ROOT },
	});
	eq("allowed: false (replace triggers guard, not the new origin value)", r.allowed, false);
	eq("reason: user_origin_replace_blocked", r.reason, "user_origin_replace_blocked");
}

console.log("\n[P6] pre-policy goal (no origin field): allowed (lenient default)");
{
	const r = classifyGoalClearAuthority({
		currentGoal: { id: "g6" }, // no origin
		action: "clear",
		actor: "root",
		params: {},
	});
	eq("allowed: true (legacy default = root)", r.allowed, true);
	eq("origin resolved to root", r.origin, GOAL_ORIGIN_ROOT);
}

console.log("\n[P7] origin:batch clear: allowed");
{
	const r = classifyGoalClearAuthority({
		currentGoal: { id: "g7", origin: GOAL_ORIGIN_BATCH },
		action: "clear",
		actor: "root",
		params: {},
	});
	eq("allowed: true", r.allowed, true);
}

// =============================================================================
// TOOL INTEGRATION CASES (real tool surface, real withLock)
// =============================================================================

const seedUserGoal = (text = "chỉ dùng khi user yêu cầu") => {
	const st = readSwarmState();
	st.goal = {
		id: `goal-userorigin-${Date.now()}`,
		text,
		setAt: new Date().toISOString(),
		setBy: "root",
		origin: GOAL_ORIGIN_USER,
		consecutiveNoResolveNudges: 0,
	};
	writeSwarmState(st);
};

const seedRootGoal = (text = "batch-scoped") => {
	const st = readSwarmState();
	st.goal = {
		id: `goal-orchorigin-${Date.now()}`,
		text,
		setAt: new Date().toISOString(),
		setBy: "root",
		origin: GOAL_ORIGIN_ROOT,
		consecutiveNoResolveNudges: 0,
	};
	writeSwarmState(st);
};

console.log("\n[T8] swarm_mark_goal_done REFUSES on user-origin active goal without approval");
{
	setAgentId("root");
	seedUserGoal();
	const r = await call("swarm_mark_goal_done", {}, scratch);
	const d = r.details || {};
	eq("tool returned refusal shape (refused: true)", d.refused, true);
	eq("reason: user_origin_active", d.reason, "user_origin_active");
	eq("origin: user", d.origin, GOAL_ORIGIN_USER);
	eq("goalId echoed", typeof d.goalId, "string");
	const st = readSwarmState();
	eq("durable goal unchanged (still present)", !!st.goal, true);
	eq("durable goal id preserved", st.goal?.origin, GOAL_ORIGIN_USER);
}

console.log("\n[T9] swarm_mark_goal_done SUCCEEDS on user-origin with approvedByUser: true");
{
	setAgentId("root");
	seedUserGoal();
	const r = await call("swarm_mark_goal_done", { approvedByUser: true }, scratch);
	const d = r.details || {};
	eq("tool returned cleared: true", d.cleared, true);
	eq("clearedId present", typeof d.clearedId, "string");
	const st = readSwarmState();
	eq("durable goal cleared (absent)", !!st.goal, false);
}

console.log("\n[T10] swarm_mark_goal_done succeeds on non-user-origin (existing behavior)");
{
	setAgentId("root");
	seedRootGoal();
	const r = await call("swarm_mark_goal_done", {}, scratch);
	const d = r.details || {};
	eq("tool returned cleared: true", d.cleared, true);
	const st = readSwarmState();
	eq("durable goal cleared (absent)", !!st.goal, false);
}

console.log("\n[T11] swarm_set_goal (replace) REFUSES on user-origin active goal");
{
	setAgentId("root");
	seedUserGoal();
	const before = readSwarmState();
	const beforeId = before.goal?.id;
	const r = await call("swarm_set_goal", { text: "Replace attempt" }, scratch);
	const d = r.details || {};
	eq("tool returned refusal shape (refused: true)", d.refused, true);
	eq("reason: user_origin_replace_blocked", d.reason, "user_origin_replace_blocked");
	eq("origin: user", d.origin, GOAL_ORIGIN_USER);
	const st = readSwarmState();
	eq("durable goal unchanged (still user-origin)", st.goal?.origin, GOAL_ORIGIN_USER);
	eq("durable goal id preserved", st.goal?.id, beforeId);
}

console.log("\n[T12] /swarm goal done refuses on user-origin active goal");
{
	setAgentId("root");
	seedUserGoal();
	const notifs = [];
	const fakeUi = { notify: (msg, level) => { notifs.push({ msg, level }); } };
	const fakeCtx = { ui: fakeUi, cwd: scratch };
	const handler = commands["swarm"];
	if (!handler) throw new Error("no swarm command registered");
	await handler("goal done", fakeCtx);
	const refusal = notifs.find((n) => /user_origin_active|refus|use --force-user-clear/i.test(n.msg));
	ok("refusal notification surfaced", !!refusal, JSON.stringify(notifs));
	const st = readSwarmState();
	eq("durable goal unchanged", !!st.goal, true);
	eq("durable goal origin preserved", st.goal?.origin, GOAL_ORIGIN_USER);
}

console.log("\n[T13] /swarm goal done --force-user-clear succeeds on user-origin active goal");
{
	setAgentId("root");
	seedUserGoal();
	const notifs = [];
	const fakeUi = { notify: (msg, level) => { notifs.push({ msg, level }); } };
	const fakeCtx = { ui: fakeUi, cwd: scratch };
	const handler = commands["swarm"];
	await handler("goal done --force-user-clear", fakeCtx);
	const cleared = notifs.find((n) => /cleared/i.test(n.msg));
	ok("cleared notification surfaced", !!cleared, JSON.stringify(notifs));
	const st = readSwarmState();
	eq("durable goal cleared", !!st.goal, false);
}

console.log(`\nGOAL-CLEAR-AUTH ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
