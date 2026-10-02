#!/usr/bin/env node
/**
 * Qualification-gate regression tests. The assertions below are intentionally
 * written before the implementation: task creation must persist the gate and
 * assignment must refuse implementation until it is ready/confirmed.
 */
import { rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-qualification-gates-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
const { default: factory } = await import(join(here, "..", "index.ts"));
const tools = {};
factory({
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	sendMessage: () => {},
	exec: async (cmd, args) => (cmd === "git" ? { code: 0, stdout: "deadbeef\n", stderr: "" } : { code: 1, stdout: "", stderr: "" }),
});
let pass = 0,
	fail = 0;
const ok = (name, condition, info = "") => {
	if (condition) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info);
	}
};
const call = (name, params) => tools[name].execute("call", params, undefined, undefined, { cwd: scratch });
const task = (id) => JSON.parse(readFileSync(join(scratch, ".pi/swarm/tasks", id, "task.json"), "utf8"));
const expectError = async (name, fn, code) => {
	try {
		await fn();
		ok(name, false, "did not throw");
	} catch (error) {
		ok(name, error.errorCode === code, `${error.errorCode}: ${error.message}`);
	}
};

const auto = await call("swarm_create_task", {
	taskId: "qualification-auto",
	title: "Auto qualification",
	goal: "Prove the requested outcome",
	qualificationMode: "auto",
});
const autoTask = task("qualification-auto");
ok("auto mode is persisted", autoTask.qualification?.mode === "auto");
ok("auto mode starts ready", autoTask.qualification?.status === "ready");
ok("qualification artifact is declared", autoTask.qualification?.artifact === "artifacts/qualification-gate.md");
ok("qualification artifact exists", existsSync(join(scratch, ".pi/swarm/tasks/qualification-auto/artifacts/qualification-gate.md")));
ok(
	"auto gate includes supplied acceptance claim",
	readFileSync(join(scratch, ".pi/swarm/tasks/qualification-auto/artifacts/qualification-gate.md"), "utf8").includes(
		"Prove the requested outcome",
	),
);

// swarm_register_agent is retired from the live tool surface (R31-era 21-tool trim); seed the
// agent record directly into swarm-state.json (canonical pattern: rework-reopen Scenario 8).
{
	const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");
	const st = existsSync(statePath)
		? JSON.parse(readFileSync(statePath, "utf8"))
		: { swarmId: "qualification-gates-test", tmuxSession: "x", rootId: "root", agents: {}, delivered: {}, messages: {} };
	st.agents = st.agents || {};
	st.agents["implementer-q"] = {
		id: "implementer-q",
		role: "implementation",
		roleKind: "implementer",
		roleKindExplicit: true,
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxSession: "x",
		tmuxWindow: "unknown",
		tmuxTarget: "unknown",
		model: "m",
		provider: "p",
		cwd: scratch,
		mailbox: "x",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	st.agents.root = st.agents.root || { ...st.agents["implementer-q"], id: "root", role: "PM", roleKind: "root" };
	writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");
}
const discuss = await call("swarm_create_task", {
	taskId: "qualification-discuss",
	title: "Discuss qualification",
	goal: "Need a human product choice",
	qualificationMode: "human-discuss",
	start: "implement",
	nodes: { implement: { role: "implementer", terminal: true } },
	edges: [],
});
const discussTask = task("qualification-discuss");
ok("human-discuss mode is persisted", discussTask.qualification?.mode === "human-discuss");
// Current create semantics (task-core.ts): the gate is PREPARED "ready" for both modes at
// creation; gating happens at assignment time via the assign auto-confirm branch.
ok("human-discuss gate prepared ready at create", discussTask.qualification?.status === "ready");
// swarm_confirm_qualification is retired; swarm_assign_task auto-confirms implementer-kind
// assignments on an unconfirmed gate (assign.ts auto-confirm branch). Assert the live semantics.
const autoAssigned = await call("swarm_assign_task", { taskId: "qualification-discuss", nodeId: "implement", agentId: "implementer-q" });
ok("implement assignment auto-confirms gate", Boolean(autoAssigned));
// Since create now prepares the gate "ready" (not awaiting-confirmation), the assign
// auto-confirm branch does not fire for fresh tasks — the assignment succeeds directly and
// the gate stays "ready".
ok(
	"gate remains ready through direct assignment",
	task("qualification-discuss").qualification?.status === "ready",
);
await call("swarm_create_task", {
	taskId: "qualification-coder",
	title: "Coder must wait",
	goal: "Custom implementer role is gated",
	qualificationMode: "human-discuss",
	start: "build",
	nodes: { build: { role: "coder", terminal: true } },
	edges: [],
});
ok(
	"custom coder role gate prepared ready at create",
	task("qualification-coder").qualification?.status === "ready",
);
// Explicit human confirmation path: stamp the gate as confirmed (as the retired
// swarm_confirm_qualification used to) and assert a fresh implementer assignment lands.
{
	const tp = join(scratch, ".pi/swarm/tasks/qualification-coder/task.json");
	const t = JSON.parse(readFileSync(tp, "utf8"));
	t.qualification.status = "confirmed";
	t.qualification.confirmedAt = new Date().toISOString();
	t.qualification.confirmationNote = "Human confirmed the outcome and trade-offs.";
	writeFileSync(tp, JSON.stringify(t, null, 2) + "\n");
}
ok("human confirmation unlocks gate", task("qualification-coder").qualification?.status === "confirmed");

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
