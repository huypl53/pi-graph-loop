#!/usr/bin/env node
/**
 * Qualification-gate regression tests. The assertions below are intentionally
 * written before the implementation: task creation must persist the gate and
 * assignment must refuse implementation until it is ready/confirmed.
 */
import { rmSync, readFileSync, existsSync } from "node:fs";
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
  registerTool: (def) => { tools[def.name] = def; }, registerCommand: () => {}, on: () => {}, sendMessage: () => {},
  exec: async (cmd, args) => cmd === "git" ? { code: 0, stdout: "deadbeef\n", stderr: "" } : { code: 1, stdout: "", stderr: "" },
});
let pass = 0, fail = 0;
const ok = (name, condition, info = "") => { if (condition) { pass++; console.log("  ok  ", name); } else { fail++; console.error("  FAIL", name, info); } };
const call = (name, params) => tools[name].execute("call", params, undefined, undefined, { cwd: scratch });
const task = (id) => JSON.parse(readFileSync(join(scratch, ".pi/swarm/tasks", id, "task.json"), "utf8"));
const expectError = async (name, fn, code) => { try { await fn(); ok(name, false, "did not throw"); } catch (error) { ok(name, error.errorCode === code, `${error.errorCode}: ${error.message}`); } };

const auto = await call("swarm_create_task", { taskId: "qualification-auto", title: "Auto qualification", goal: "Prove the requested outcome", qualificationMode: "auto" });
const autoTask = task("qualification-auto");
ok("auto mode is persisted", autoTask.qualification?.mode === "auto");
ok("auto mode starts ready", autoTask.qualification?.status === "ready");
ok("qualification artifact is declared", autoTask.qualification?.artifact === "artifacts/qualification-gate.md");
ok("qualification artifact exists", existsSync(join(scratch, ".pi/swarm/tasks/qualification-auto/artifacts/qualification-gate.md")));
ok("auto gate includes supplied acceptance claim", readFileSync(join(scratch, ".pi/swarm/tasks/qualification-auto/artifacts/qualification-gate.md"), "utf8").includes("Prove the requested outcome"));

await call("swarm_register_agent", { tmuxTarget: "unknown", role: "implementation", roleKind: "implementer", id: "implementer-q", inject: false });
const discuss = await call("swarm_create_task", { taskId: "qualification-discuss", title: "Discuss qualification", goal: "Need a human product choice", qualificationMode: "human-discuss", start: "implement", nodes: { implement: { role: "implementer", terminal: true } }, edges: [] });
const discussTask = task("qualification-discuss");
ok("human-discuss mode is persisted", discussTask.qualification?.mode === "human-discuss");
ok("human-discuss waits for confirmation", discussTask.qualification?.status === "awaiting-confirmation");
await expectError("implement assignment is blocked before confirmation", () => call("swarm_assign_task", { taskId: "qualification-discuss", nodeId: "implement", agentId: "implementer-q" }), "QUALIFICATION_NOT_READY");
await call("swarm_confirm_qualification", { taskId: "qualification-discuss", note: "Human confirmed the outcome and trade-offs." });
ok("confirmation unlocks gate", task("qualification-discuss").qualification?.status === "confirmed");
const assigned = await call("swarm_assign_task", { taskId: "qualification-discuss", nodeId: "implement", agentId: "implementer-q" });
ok("implementation assignment works after confirmation", Boolean(assigned));

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
