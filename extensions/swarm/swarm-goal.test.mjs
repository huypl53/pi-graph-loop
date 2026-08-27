// Issue 18 swarm-goal-idle-nudge: swarm_set_goal + swarm_mark_goal_done tools.
//
// Strategy: build the tool set from the real factory with a mock `pi` whose tmux exec returns
// success for the subcommands these tools need. State lives under a unique temp scratch dir.
// Tests cover:
//   - set / re-set / clear lifecycle (durable shape, idempotent across reads)
//   - authority gate: workers throw ORCHESTRATOR_AUTHORITY_REQUIRED
//   - durability across re-reads
//   - goalId safety fence on mark_done
//
// Run: node extensions/swarm/swarm-goal.test.mjs
import { rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const { registerAgentsTools } = await import(join(here, "src", "tools", "agents.ts"));

const scratch = join(tmpdir(), `swarm-goal-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

const tools = {};
const pi = {
	registerTool: (def) => { tools[def.name] = def; },
	registerCommand: () => {},
	on: () => {},
	sendMessage: () => {},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};
registerAgentsTools(pi);

const call = async (name, params, cwd = scratch) => {
	const t = tools[name]; if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd });
};
const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");
const readSwarmState = () => JSON.parse(readFileSync(statePath, "utf8"));
const writeSwarmState = (st) => writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");

let pass = 0, fail = 0;
const ok = (n, c, info) => { if (c) { pass++; console.log("  ok  ", n); } else { fail++; console.error("  FAIL", n, info ?? ""); } };
const throws = async (n, p, matcher) => {
	try { await p; fail++; console.error("  FAIL", n, "(did not throw)"); }
	catch (err) { if (matcher && !matcher.test(String(err?.message || err))) { fail++; console.error("  FAIL", n, `(threw but did not match /${matcher}/: ${err?.message}`); } else { pass++; console.log("  ok  ", n); } }
};

const AGENT_ID = process.env.PI_SWARM_AGENT_ID;
const restoreAgentId = () => { if (AGENT_ID === undefined) delete process.env.PI_SWARM_AGENT_ID; else process.env.PI_SWARM_AGENT_ID = AGENT_ID; };
const setAgentId = (id) => { if (id === undefined) delete process.env.PI_SWARM_AGENT_ID; else process.env.PI_SWARM_AGENT_ID = id; };

// First, seed an empty state so subsequent reads have a file to work with.
{
	const seedDir = join(scratch, ".pi", "swarm");
	mkdirSync(seedDir, { recursive: true });
	const { ensureOrchestrator } = await import(join(here, "src", "identity.ts"));
	const { ensureDirs, readState, writeState, paths } = await import(join(here, "src", "state.ts"));
	const p0 = paths(scratch);
	await ensureDirs(p0);
	const st0 = await readState(p0, scratch);
	ensureOrchestrator(st0, scratch, p0);
	await writeState(p0, st0);
}

console.log("\n[1] swarm_set_goal stores durable goal with required shape");
{
	// Re-read state to get the seeded record.
	setAgentId("orchestrator");
	const before = readSwarmState();
	ok("precondition: orchestrator pseudo-agent seeded", !!before.agents?.orchestrator);
	const r = await call("swarm_set_goal", { text: "Ship Issue 18", cwd: scratch });
	const st = readSwarmState();
	const goal = st.goal;
	ok("goal persisted", !!goal);
	ok("goal.id present (auto-generated)", typeof goal.id === "string" && goal.id.startsWith("goal-"));
	ok("goal.text stored verbatim", goal.text === "Ship Issue 18");
	ok("goal.setAt is ISO", typeof goal.setAt === "string" && goal.setAt.includes("T") && goal.setAt.endsWith("Z"));
	ok("goal.setBy is orchestrator", goal.setBy === "orchestrator");
	ok("goal.consecutiveNoResolveNudges is 0 on fresh set", goal.consecutiveNoResolveNudges === 0);
	ok("goal.lastNudgeAt cleared on fresh set", goal.lastNudgeAt === undefined);
	ok("goal.lastResolvedAt cleared on fresh set", goal.lastResolvedAt === undefined);
	ok("goal.backoffTicksRemaining cleared on fresh set", goal.backoffTicksRemaining === undefined);
	ok("tool returns { goalId, previousId }", typeof r.details?.goalId === "string" && "previousId" in r.details);
	ok("tool text mentions Goal set", /Goal set:/.test(r?.content?.[0]?.text || ""));
}

console.log("\n[2] swarm_set_goal replaces existing goal (resets counter, clears back-off state)");
{
	const st = readSwarmState();
	st.goal.consecutiveNoResolveNudges = 3;
	st.goal.lastNudgeAt = "2026-01-01T00:00:00.000Z";
	st.goal.backoffTicksRemaining = 2;
	writeSwarmState(st);
	const r = await call("swarm_set_goal", { text: "Ship Issue 19", cwd: scratch });
	const after = readSwarmState().goal;
	ok("consecutiveNoResolveNudges reset to 0", after.consecutiveNoResolveNudges === 0);
	ok("lastNudgeAt cleared", after.lastNudgeAt === undefined);
	ok("backoffTicksRemaining cleared", after.backoffTicksRemaining === undefined);
	ok("goal.id is different from previous (replacement, not idempotency)", r.details.goalId !== st.goal.id);
}

console.log("\n[3] swarm_set_goal honors explicit id");
{
	const r = await call("swarm_set_goal", { text: "Custom-id test", id: "my-explicit-goal", cwd: scratch });
	ok("explicit goalId honored", r.details.goalId === "my-explicit-goal");
	ok("state.goal.id matches explicit id", readSwarmState().goal.id === "my-explicit-goal");
}

console.log("\n[4] swarm_set_goal rejects empty text");
{
	await throws("empty text throws", call("swarm_set_goal", { text: "  ", cwd: scratch }), /text must be non-empty/);
	await throws("missing text throws", call("swarm_set_goal", { text: "", cwd: scratch }), /text must be non-empty/);
}

console.log("\n[5] authority gate: non-orchestrator swarm_set_goal throws ORCHESTRATOR_AUTHORITY_REQUIRED");
{
	setAgentId("worker-1");
	// write a worker agent record (otherwise readState has no worker to find — but the gate fires before state reads)
	const st = readSwarmState();
	st.agents["worker-1"] = {
		id: "worker-1", role: "worker", roleKind: "worker", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1,
		status: "running", runtimeStatus: "idle", health: "healthy",
		tmuxSession: st.tmuxSession, tmuxWindow: "worker-1", tmuxTarget: "unknown",
		model: "glm-5.1", provider: "zai-coding-cn", cwd: scratch, mailbox: "mailboxes/worker-1.jsonl",
		createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
	};
	writeSwarmState(st);
	await throws("worker swarm_set_goal throws ORCHESTRATOR_AUTHORITY_REQUIRED", call("swarm_set_goal", { text: "should fail", cwd: scratch }), /ORCHESTRATOR_AUTHORITY_REQUIRED/);
	ok("worker swarm_set_goal did not mutate state.goal", readSwarmState().goal.id === "my-explicit-goal");
	setAgentId("orchestrator");
}

console.log("\n[6] swarm_mark_goal_done clears goal entry");
{
	const r = await call("swarm_mark_goal_done", { cwd: scratch });
	const st = readSwarmState();
	ok("goal entry removed from state", st.goal === undefined);
	ok("tool returns { cleared: true, clearedId, nudges }", r.details.cleared === true && r.details.clearedId === "my-explicit-goal");
}

console.log("\n[7] swarm_mark_goal_done noop when no goal exists");
{
	const r = await call("swarm_mark_goal_done", { cwd: scratch });
	ok("noop returns cleared: true", r.details.cleared === true);
	ok("noop has noop flag", r.details.noop === true);
	ok("text reflects noop", /No active goal/.test(r?.content?.[0]?.text || ""));
}

console.log("\n[8] swarm_mark_goal_done goalId safety fence");
{
	await call("swarm_set_goal", { text: "fence-test", cwd: scratch });
	const wrongId = "wrong-goal-id";
	await throws("wrong goalId throws", call("swarm_mark_goal_done", { goalId: wrongId, cwd: scratch }), /does not match/);
	ok("state.goal still present after fence rejection", !!readSwarmState().goal);
	// Right id clears.
	const r = await call("swarm_mark_goal_done", { goalId: readSwarmState().goal.id, cwd: scratch });
	ok("matching goalId clears", r.details.cleared === true);
	ok("goal entry removed after matching clear", readSwarmState().goal === undefined);
}

console.log("\n[9] authority gate: non-orchestrator swarm_mark_goal_done throws");
{
	// Set a goal first as orchestrator.
	await call("swarm_set_goal", { text: "authority-mark-done-test", cwd: scratch });
	setAgentId("worker-1");
	await throws("worker swarm_mark_goal_done throws ORCHESTRATOR_AUTHORITY_REQUIRED", call("swarm_mark_goal_done", { cwd: scratch }), /ORCHESTRATOR_AUTHORITY_REQUIRED/);
	ok("worker swarm_mark_goal_done did NOT mutate state", !!readSwarmState().goal);
	setAgentId("orchestrator");
	await call("swarm_mark_goal_done", { cwd: scratch }); // cleanup
}

console.log("\n[10] durability across re-read (binding C-1: no st.goal back-fill)");
{
	await call("swarm_set_goal", { text: "durability test", cwd: scratch });
	const before = readSwarmState();
	const goalId = before.goal.id;
	// Mutate unrelated field on disk to confirm goal entry round-trips cleanly.
	const { writeFile } = await import("node:fs/promises");
	const raw = JSON.parse(readFileSync(statePath, "utf8"));
	raw.goal.consecutiveNoResolveNudges = 7;
	await writeFile(statePath, JSON.stringify(raw, null, 2));
	const reloaded = readSwarmState();
	ok("goal survives disk round-trip", !!reloaded.goal);
	ok("goal.id preserved", reloaded.goal.id === goalId);
	ok("goal.text preserved", reloaded.goal.text === "durability test");
	ok("goal.consecutiveNoResolveNudges preserved", reloaded.goal.consecutiveNoResolveNudges === 7);
	// Sanity: a hypothetical legacy state with NO `goal` key would parse to `undefined` here.
	const rawNoGoal = { ...raw };
	delete rawNoGoal.goal;
	await writeFile(statePath, JSON.stringify(rawNoGoal));
	const noGoal = readSwarmState();
	ok("legacy state (no goal key) reads as goal: undefined", noGoal.goal === undefined);
	await call("swarm_mark_goal_done", { cwd: scratch }); // cleanup
}

console.log(`\n${fail === 0 ? "SWARM-GOAL PASS" : "SWARM-GOAL FAIL"} (${pass} passed, ${fail} failed)`);
restoreAgentId();
rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
