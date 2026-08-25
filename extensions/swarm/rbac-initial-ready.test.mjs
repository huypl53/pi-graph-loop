// Reliability-roadmap Phase 1 regression: server-side RBAC for forced task mutations + initial-ready
// nudge that fires after a bounded grace period without ever auto-assigning.
//
// Run: node extensions/swarm/rbac-initial-ready.test.mjs
import { rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "index.ts"));
const factory = mod.default;
const { reconcileInitialReadyLocked } = await import(join(here, "src/reconcile.ts"));
const { paths, readState, writeState, mailboxPath } = await import(join(here, "src/state.ts"));
const { TASK_INITIAL_READY_GRACE_MS } = await import(join(here, "src/constants.ts"));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error("  FAIL:", name); } };

const scratch = join(tmpdir(), `swarm-rbac-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi/swarm/tasks"), { recursive: true });
mkdirSync(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });

const tools = {};
const pi = { registerTool: (def) => { tools[def.name] = def; }, registerCommand: () => {}, on: () => {}, exec: async (cmd, args) => { if (cmd === "tmux" && args[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" }; if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" }; return { code: 1, stdout: "", stderr: "" }; }, sendMessage: () => {} };
factory(pi);
const call = async (name, params) => tools[name].execute("call", params, undefined, undefined, { cwd: params.cwd || scratch });

// --- RBAC server-side checks (regular worker identity) ---
{
  const ct = await call("swarm_create_task", { title: "rbac-fixture", goal: "x", priority: "normal", cwd: scratch });
  const taskId = ct.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];
  let threw = null;
  try {
    await call("swarm_update_task", { taskId, nodeId: "plan", status: "done", outcome: "planned", force: true, cwd: scratch });
  } catch (err) { threw = err; }
  ok("worker force=true is rejected (FORCE_FORBIDDEN)", threw && /FORCE_FORBIDDEN/.test(threw.message || String(threw)));

  threw = null;
  try {
    await call("swarm_update_task", { taskId, nodeId: "plan", cancelTask: true, force: true, cwd: scratch });
  } catch (err) { threw = err; }
  ok("worker cancelTask is rejected (CANCEL_FORBIDDEN)", threw && /CANCEL_FORBIDDEN/.test(threw.message || String(threw)));

  threw = null;
  try {
    await call("swarm_update_task", { taskId, nodeId: "plan", cancelTask: true, force: false, cwd: scratch });
  } catch (err) { threw = err; }
  ok("worker cancelTask without force rejected (CANCEL_FORBIDDEN)", threw && /CANCEL_FORBIDDEN/.test(threw.message || String(threw)));
}

// --- Orchestrator can use force=true (simulated by direct env identity switch) ---
{
  const prevAgent = process.env.PI_SWARM_AGENT_ID;
  const prevOrch = process.env.PI_SWARM_IS_ORCHESTRATOR;
  process.env.PI_SWARM_AGENT_ID = "";
  process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
  try {
    const ct = await call("swarm_create_task", { title: "rbac-orch", goal: "x", priority: "normal", cwd: scratch });
    const taskId = ct.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];
    let threw = null;
    try {
      await call("swarm_update_task", { taskId, nodeId: "plan", status: "done", outcome: "planned", force: true, cwd: scratch });
    } catch (err) { threw = err; }
    ok("orchestrator force=true is accepted", !threw);
  } finally {
    process.env.PI_SWARM_AGENT_ID = prevAgent || "implementer-01";
    process.env.PI_SWARM_IS_ORCHESTRATOR = prevOrch || "";
  }
}

// --- Initial-ready nudge fires after grace, never auto-assigns ---
{
  const ct = await call("swarm_create_task", { title: "initial-ready", goal: "x", priority: "normal", cwd: scratch });
  const taskId = ct.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];
  const taskPath = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
  const p = paths(scratch);

  let st = await readState(p, scratch);
  const nudgesBefore = Object.values(st.messages || {}).filter((m) => m.idempotencyKey === `task:${taskId}:nudge:initial-ready`);
  ok("no initial-ready nudge before reconcile runs", nudgesBefore.length === 0);
  let taskJson = JSON.parse(readFileSync(taskPath, "utf8"));
  ok("reconcile does NOT auto-assign the start node", taskJson.nodes[taskJson.start].status !== "assigned" && !taskJson.nodes[taskJson.start].assignee);

  // AFTER grace: invoke the watcher with nowMs past the grace and persist.
  st = await readState(p, scratch);
  await reconcileInitialReadyLocked(pi, scratch, p, st, Date.now() + TASK_INITIAL_READY_GRACE_MS + 10_000);
  await writeState(p, st);
  const stateAfter = await readState(p, scratch);
  const nudgesAfter = Object.values(stateAfter.messages || {}).filter((m) => m.idempotencyKey === `task:${taskId}:nudge:initial-ready`);
  ok("initial-ready nudge fires after grace", nudgesAfter.length === 1);
  ok("nudge addressed to orchestrator", nudgesAfter[0]?.to === "orchestrator");
  // The full body lives in the durable mailbox, not the lifecycle record in state.
  const mailbox = readFileSync(mailboxPath(p, "orchestrator"), "utf8");
  const nudgle = JSON.parse(mailbox.split(/\n+/).filter(Boolean).reverse().find((l) => l.includes(`nudge:initial-ready`)) || "{}");
  ok("nudge contains concrete next-action", /swarm_assign_task/.test(nudgle.body || ""));

  // Idempotent: a second call within the cooldown does NOT emit another.
  st = await readState(p, scratch);
  await reconcileInitialReadyLocked(pi, scratch, p, st, Date.now() + TASK_INITIAL_READY_GRACE_MS + 10_000 + 1000);
  await writeState(p, st);
  const stateAfter2 = await readState(p, scratch);
  const nudgesAfter2 = Object.values(stateAfter2.messages || {}).filter((m) => m.idempotencyKey === `task:${taskId}:nudge:initial-ready`);
  ok("initial-ready nudge is idempotent within cooldown", nudgesAfter2.length === 1);

  // No auto-assign / auto-spawn after nudge.
  const taskAfter = JSON.parse(readFileSync(taskPath, "utf8"));
  ok("nudge did not auto-assign the start node", taskAfter.nodes[taskAfter.start].status !== "assigned" && !taskAfter.nodes[taskAfter.start].assignee);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
