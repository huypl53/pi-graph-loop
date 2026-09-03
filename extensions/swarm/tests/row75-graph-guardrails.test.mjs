#!/usr/bin/env node
/**
 * Row 75 guardrail regression test.
 * Covers:
 *  1) create-time fan-in dependsOn validation
 *  2) assignment note + artifact paths are task-absolute
 *  3) failed-but-recoverable graphs still emit graph-stall nudges
 *  4) commit node auto-close is blocked without real commit evidence and surfaces unverified evidence
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), `swarm-row75-guardrails-${process.pid}-`));
mkdirSync(join(scratch, ".pi/swarm"), { recursive: true });
writeFileSync(join(scratch, ".pi/settings.json"), JSON.stringify({ swarm: { defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" } }, null, 2));

const origAgent = process.env.PI_SWARM_AGENT_ID;
const origOrch = process.env.PI_SWARM_IS_ORCHESTRATOR;
process.env.PI_SWARM_AGENT_ID = "orchestrator";
process.env.PI_SWARM_IS_ORCHESTRATOR = "1";

const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;
const tools = {};
const pi = {
  registerTool: (def) => { tools[def.name] = def; },
  registerCommand: () => {},
  on: () => {},
  exec: async (cmd, args) => {
    if (cmd === "tmux" && args?.[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
    if (cmd === "git" && args?.[0] === "rev-parse") return { code: 0, stdout: "baseline-commit\n", stderr: "" };
    if (cmd === "git" && args?.[0] === "diff") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  },
  sendMessage: () => {},
  getAllTools: () => Object.values(tools).map((t) => ({ name: t.name })),
  getActiveTools: () => Object.values(tools).map((t) => ({ name: t.name })),
  setActiveTools: () => {},
  setModel: async () => true,
};
factory(pi);

const call = async (name, params) => tools[name].execute("call", params, undefined, undefined, { cwd: scratch });
const ok = (name, cond, detail = "") => {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` (${detail})` : ""}`);
  console.log(`ok  ${name}`);
};
const readTask = (taskId) => JSON.parse(readFileSync(join(scratch, `.pi/swarm/tasks/${taskId}/task.json`), "utf8"));
const readMailbox = (agentId) => readFileSync(join(scratch, `.pi/swarm/mailboxes/${agentId}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

async function ensureWorker(id, roleKind) {
  await call("swarm_register_agent", { id, role: `${roleKind} test agent`, roleKind, tmuxTarget: "unknown", inject: false });
}

try {
  // 1) create-time validation
  let createErr = null;
  try {
    await call("swarm_create_task", {
      taskId: "task-row75-create-reject",
      title: "fan-in guard",
      goal: "reject missing dependsOn on fan-in nodes",
      cwd: scratch,
      start: "plan",
      nodes: {
        plan: { role: "planner", dependsOn: [], writeArtifacts: ["artifacts/plan.md"] },
        fanin: { role: "implementer", writeArtifacts: ["artifacts/implementation-report.md"] },
      },
      edges: [{ from: "plan", to: "fanin", when: "planned" }],
    });
  } catch (err) {
    createErr = err;
  }
  ok("create rejects fan-in node missing dependsOn", createErr && /fanin|dependsOn/.test(String(createErr.message || createErr)));

  // 2) assignment note rewritten to task-absolute artifact paths
  await ensureWorker("writer-1", "implementer");
  const created = await call("swarm_create_task", {
    taskId: "task-row75-artifact-note",
    title: "artifact note rewrite",
    goal: "rewrite relative artifact refs",
    cwd: scratch,
    start: "plan",
    nodes: {
      plan: { role: "planner", dependsOn: [], writeArtifacts: ["artifacts/plan.md"] },
      implement: { role: "implementer", dependsOn: ["plan"], readArtifacts: ["artifacts/plan.md"], writeArtifacts: ["artifacts/implementation-report.md"] },
    },
    edges: [{ from: "plan", to: "implement", when: "planned" }],
  });
  ok("task created", /Created task/.test(created.content?.[0]?.text || ""));
  const taskId = "task-row75-artifact-note";
  process.env.PI_SWARM_AGENT_ID = "orchestrator";
  process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
  await call("swarm_assign_task", {
    taskId,
    nodeId: "plan",
    agentId: "writer-1",
    cwd: scratch,
    note: "Please write artifacts/analysis-a1.md and read artifacts/plan.md before you continue.",
  });
  const t1 = readTask(taskId);
  const msg = readMailbox("writer-1").at(-1);
  ok("assignment body uses task-absolute write artifact path", msg.body.includes(`.pi/swarm/tasks/${taskId}/artifacts/plan.md`));
  ok("assignment note rewrites relative artifact path", msg.body.includes(`.pi/swarm/tasks/${taskId}/artifacts/analysis-a1.md`));

  // 3) terminal-but-recoverable failed graph still nudges
  await ensureWorker("planner-2", "planner");
  await ensureWorker("impl-2", "implementer");
  await ensureWorker("tester-2", "tester");
  const task2 = "task-row75-recoverable";
  await call("swarm_create_task", {
    taskId: task2,
    title: "recoverable failed graph",
    goal: "surface failed-but-fixable graphs",
    cwd: scratch,
    start: "plan",
    nodes: {
      plan: { role: "planner", dependsOn: [], writeArtifacts: ["artifacts/plan.md"] },
      implement: { role: "implementer", dependsOn: ["plan"], readArtifacts: ["artifacts/plan.md"], writeArtifacts: ["artifacts/implementation-report.md"] },
      test: { role: "tester", dependsOn: ["implement"], readArtifacts: ["artifacts/implementation-report.md"], writeArtifacts: ["artifacts/test-report.md"] },
      fix: { role: "implementer", dependsOn: ["test"], readArtifacts: ["artifacts/test-report.md"], writeArtifacts: ["artifacts/fix-report.md"], allowedFilesFrom: "implement" },
      review: { role: "reviewer", dependsOn: ["test"], readArtifacts: ["artifacts/implementation-report.md", "artifacts/test-report.md"], writeArtifacts: ["artifacts/review.md"] },
      commit: { role: "orchestrator", dependsOn: ["review"], writeArtifacts: ["artifacts/final-summary.md"], terminal: true },
    },
    edges: [
      { from: "plan", to: "implement", when: "planned" },
      { from: "implement", to: "test", when: "implemented" },
      { from: "test", to: "review", when: "passed" },
      { from: "test", to: "fix", when: "failed", rework: true },
      { from: "fix", to: "test", when: "implemented", rework: true },
      { from: "review", to: "commit", when: "approved" },
      { from: "review", to: "fix", when: "rejected", rework: true },
    ],
  });
  process.env.PI_SWARM_AGENT_ID = "orchestrator";
  process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
  await call("swarm_assign_task", { taskId: task2, nodeId: "plan", agentId: "planner-2", cwd: scratch });
  const planAttempt = readTask(task2).nodes.plan.activeAttemptId;
  process.env.PI_SWARM_AGENT_ID = "planner-2";
  await call("swarm_update_task", { taskId: task2, nodeId: "plan", status: "done", outcome: "planned", attemptId: planAttempt, cwd: scratch });
  process.env.PI_SWARM_AGENT_ID = "orchestrator";
  process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
  await call("swarm_assign_task", { taskId: task2, nodeId: "implement", agentId: "impl-2", cwd: scratch });
  const implAttempt = readTask(task2).nodes.implement.activeAttemptId;
  process.env.PI_SWARM_AGENT_ID = "impl-2";
  await call("swarm_update_task", { taskId: task2, nodeId: "implement", status: "done", outcome: "implemented", attemptId: implAttempt, cwd: scratch });
  process.env.PI_SWARM_AGENT_ID = "orchestrator";
  process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
  await call("swarm_assign_task", { taskId: task2, nodeId: "test", agentId: "tester-2", cwd: scratch });
  const testAttempt = readTask(task2).nodes.test.activeAttemptId;
  process.env.PI_SWARM_AGENT_ID = "tester-2";
  await call("swarm_update_task", { taskId: task2, nodeId: "test", status: "failed", outcome: "failed", attemptId: testAttempt, cwd: scratch });
  const task2Path = join(scratch, `.pi/swarm/tasks/${task2}/task.json`);
  const task2Json = readTask(task2);
  ok("failed graph keeps fix ready", task2Json.nodes.fix.status === "ready" && task2Json.status === "failed");
  // age the task so the stalled-graph nudge window is eligible
  const task2Raw = JSON.parse(readFileSync(task2Path, "utf8"));
  task2Raw.createdAt = new Date(Date.now() - 120_000).toISOString();
  writeFileSync(task2Path, JSON.stringify(task2Raw, null, 2));
  const statePath = join(scratch, ".pi/swarm/swarm-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const fresh = new Date().toISOString();
  for (const a of Object.values(state.agents)) {
    if (a.id !== "orchestrator") {
      a.runtimeStatus = "idle";
      a.status = "running";
      a.health = "healthy";
      a.lastHeartbeatAt = fresh;
    }
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.env.PI_SWARM_AGENT_ID = "orchestrator";
  process.env.PI_SWARM_AGENT_ID = "orchestrator";
  process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
  // Drive the stall-nudge helper directly (the pump-tick path is leader-gated; tests bypass it)
  const { evaluateTaskGraphStallNudgeLocked, isStallNudgeEligibleTaskStatus } = await import(join(here, "..", "src/reconcile.ts"));
  const { readState, paths, withLock, writeState, taskPaths, readTaskState } = await import(join(here, "..", "src/state.ts"));
  let nudgeResult = null;
  await withLock(paths(scratch), async () => {
    const st = await readState(paths(scratch), scratch);
    nudgeResult = await evaluateTaskGraphStallNudgeLocked(pi, scratch, paths(scratch), st, Date.now() + 120_000);
    await writeState(paths(scratch), st);
  });
  ok("failed recoverable graph emits stall nudge", nudgeResult && nudgeResult.emitted === true);
  const mb = readMailbox("orchestrator");
  ok("orchestrator mailbox has graph-stall message", mb.some((m) => /graph-stall/.test(m.idempotencyKey || "") || /actionable but unassigned/.test(m.subject || "")));
  ok("isStallNudgeEligibleTaskStatus returns true for failed", isStallNudgeEligibleTaskStatus("failed"));

  // 4) commit not auto-closed without real commit evidence
  await ensureWorker("reviewer-1", "reviewer");
  const task3 = "task-row75-commit-guard";
  await call("swarm_create_task", {
    taskId: task3,
    title: "commit guard",
    goal: "commit node should not auto-close without evidence",
    cwd: scratch,
  });
  process.env.PI_SWARM_AGENT_ID = "orchestrator";
  process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
  const task3Path = join(scratch, `.pi/swarm/tasks/${task3}/task.json`);
  const task3Raw = JSON.parse(readFileSync(task3Path, "utf8"));
  task3Raw.createdAt = new Date(Date.now() - 120_000).toISOString();
  writeFileSync(task3Path, JSON.stringify(task3Raw, null, 2));
  await call("swarm_assign_task", { taskId: task3, nodeId: "plan", agentId: "planner-2", cwd: scratch });
  const task3Plan = readTask(task3).nodes.plan.activeAttemptId;
  process.env.PI_SWARM_AGENT_ID = "planner-2";
  await call("swarm_update_task", { taskId: task3, nodeId: "plan", status: "done", outcome: "planned", attemptId: task3Plan, cwd: scratch });
  process.env.PI_SWARM_AGENT_ID = "orchestrator";
  process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
  await call("swarm_assign_task", { taskId: task3, nodeId: "implement", agentId: "impl-2", cwd: scratch });
  const task3Impl = readTask(task3).nodes.implement.activeAttemptId;
  process.env.PI_SWARM_AGENT_ID = "impl-2";
  await call("swarm_update_task", { taskId: task3, nodeId: "implement", status: "done", outcome: "implemented", attemptId: task3Impl, cwd: scratch });
  process.env.PI_SWARM_AGENT_ID = "orchestrator";
  process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
  await call("swarm_assign_task", { taskId: task3, nodeId: "test", agentId: "tester-2", cwd: scratch });
  const task3Test = readTask(task3).nodes.test.activeAttemptId;
  process.env.PI_SWARM_AGENT_ID = "tester-2";
  await call("swarm_update_task", { taskId: task3, nodeId: "test", status: "done", outcome: "passed", attemptId: task3Test, cwd: scratch });
  process.env.PI_SWARM_AGENT_ID = "orchestrator";
  process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
  await call("swarm_assign_task", { taskId: task3, nodeId: "review", agentId: "reviewer-1", cwd: scratch });
  const task3Review = readTask(task3).nodes.review.activeAttemptId;
  process.env.PI_SWARM_AGENT_ID = "reviewer-1";
  await call("swarm_update_task", { taskId: task3, nodeId: "review", status: "done", outcome: "approved", attemptId: task3Review, cwd: scratch });
  const afterCommit = readTask(task3);
  ok("commit remains pending without real git evidence", afterCommit.nodes.commit.status === "pending");
  ok("commit evidence surfaced as unverified", afterCommit.evidence?.commit?.status === "unverified");

  // 4b) When a real commit lands (HEAD != baseline), auto-close the commit node on the next update.
  const headFile = join(scratch, ".pi/swarm/tasks/" + task3 + "/baseline.txt");
  // Simulate a real commit landing by changing the baseline to a different value before a fresh
  // graph trigger. We need to write baseline.txt to a NEW hash AND make the autoClose check resolve
  // HEAD against the new value; since this scratch dir is not a git repo we let the mock exec
  // pretend a commit happened by re-pointing baseline at the latest known head (already baseline).
  // Instead, drive autoClose directly with a fake pi that returns a different HEAD.
  const fakePi = { exec: async (cmd, args) => {
    if (cmd === "git" && args?.[0] === "rev-parse") return { code: 0, stdout: "post-create-head\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  } };
  const task3State = readTask(task3);
  const { autoCloseOrchestratorTerminalNodes } = await import(join(here, "..", "src/taskgraph.ts"));
  task3State.nodes.review = task3State.nodes.review || task3State.nodes.review; // noop
  const closed = await autoCloseOrchestratorTerminalNodes(fakePi, taskPaths({ tasksDir: join(scratch, ".pi/swarm/tasks"), root: scratch }, task3), task3State);
  ok("commit auto-closes once fake git reports new HEAD", closed.closed.includes("commit"));
  ok("commit evidence status verified", task3State.evidence?.commit?.status === "verified");

  // 4c) Mixed terminal graphs must retain commit evidence when a later non-commit terminal closes.
  const task3Mixed = "task-row75-mixed-evidence";
  const mixedTp = taskPaths({ tasksDir: join(scratch, ".pi/swarm/tasks"), root: scratch }, task3Mixed);
  mkdirSync(mixedTp.root, { recursive: true });
  mkdirSync(mixedTp.artifacts, { recursive: true });
  writeFileSync(join(mixedTp.root, "baseline.txt"), "baseline-commit\n", "utf8");
  const mixedTask = {
    version: 1,
    taskId: task3Mixed,
    title: "mixed evidence",
    goal: "commit evidence must survive later terminal closes",
    status: "ready",
    priority: "normal",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    owner: "orchestrator",
    workflow: "feature-dev",
    allowedFiles: [],
    acceptanceCriteria: [],
    validationCommands: [],
    start: "commit",
    currentNodes: ["commit", "finalize"],
    sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
    nodes: {
      commit: { status: "pending", role: "orchestrator", dependsOn: [], readArtifacts: [], writeArtifacts: [], messageIds: [], attempts: 0, maxAttempts: 1, terminal: true },
      finalize: { status: "pending", role: "orchestrator", dependsOn: [], readArtifacts: [], writeArtifacts: [], messageIds: [], attempts: 0, maxAttempts: 1, terminal: true },
    },
    edges: [],
    handoffs: [],
    gates: {},
    editLocks: {},
    evidence: {},
  };
  writeFileSync(mixedTp.taskJson, `${JSON.stringify(mixedTask, null, 2)}\n`, "utf8");
  const mixedPi = { exec: async (cmd, args) => cmd === "git" && args?.[0] === "rev-parse" ? { code: 0, stdout: "post-create-head\n", stderr: "" } : { code: 1, stdout: "", stderr: "" } };
  const mixedState = readTask(task3Mixed);
  const { autoCloseOrchestratorTerminalNodes: autoCloseMixed } = await import(join(here, "..", "src/taskgraph.ts"));
  const mixedClosed = await autoCloseMixed(mixedPi, mixedTp, mixedState);
  ok("mixed graph closes both terminals", mixedClosed.closed.includes("commit") && mixedClosed.closed.includes("finalize"));
  ok("mixed graph retains commit evidence after later terminal close", mixedState.evidence?.commit?.status === "verified");
  ok("mixed graph also stamps finalize evidence", mixedState.evidence?.finalize?.status === "verified");

  // 4d) The commit-guard is keyed off the orchestrator-terminal predicate, not the literal id.
  // A custom graph whose commit-step node is named "finalize" with role "orchestrator" must also
  // require git evidence (this is the Row 75 R5/R6 bypass hole).
  process.env.PI_SWARM_AGENT_ID = "orchestrator";
  process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
  const task4 = "task-row75-finalize-guard";
  await call("swarm_create_task", {
    taskId: task4,
    title: "finalize guard",
    goal: "non-commit orchestrator terminal node still requires git evidence",
    cwd: scratch,
    nodes: { plan: { role: "planner", dependsOn: [] }, implement: { role: "implementer", dependsOn: ["plan"] }, finalize: { role: "orchestrator", dependsOn: ["implement"], terminal: true } },
    edges: [{ from: "plan", to: "implement", when: "planned" }, { from: "implement", to: "finalize", when: "implemented" }],
    start: "plan",
  });
  await ensureWorker("impl-4", "implementer");
  process.env.PI_SWARM_AGENT_ID = "orchestrator";
  process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
  await call("swarm_assign_task", { taskId: task4, nodeId: "plan", agentId: "planner-2", cwd: scratch });
  const t4Plan = readTask(task4).nodes.plan.activeAttemptId;
  process.env.PI_SWARM_AGENT_ID = "planner-2";
  await call("swarm_update_task", { taskId: task4, nodeId: "plan", status: "done", outcome: "planned", attemptId: t4Plan, cwd: scratch });
  process.env.PI_SWARM_AGENT_ID = "orchestrator";
  process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
  await call("swarm_assign_task", { taskId: task4, nodeId: "implement", agentId: "impl-4", cwd: scratch });
  const t4Impl = readTask(task4).nodes.implement.activeAttemptId;
  process.env.PI_SWARM_AGENT_ID = "impl-4";
  await call("swarm_update_task", { taskId: task4, nodeId: "implement", status: "done", outcome: "implemented", attemptId: t4Impl, cwd: scratch });
  process.env.PI_SWARM_AGENT_ID = "orchestrator";
  process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
  const finalizeNode = readTask(task4).nodes.finalize;
  ok("finalize orchestrator terminal stays pending without git evidence", finalizeNode.status === "pending");
  ok("finalize evidence recorded under per-node key", readTask(task4).evidence?.finalize?.status === "unverified");
  ok("finalize legacy .commit alias is not dual-written", readTask(task4).evidence?.commit === undefined);
  // With a real commit landing, the finalize node auto-closes AND the per-node evidence flips.
  const fakePiFinalize = { exec: async (cmd, args) => cmd === "git" && args?.[0] === "rev-parse" ? { code: 0, stdout: "post-create-head\n", stderr: "" } : { code: 1, stdout: "", stderr: "" } };
  const task4State = readTask(task4);
  const { autoCloseOrchestratorTerminalNodes: autoClose4, printGraphText } = await import(join(here, "..", "src/taskgraph.ts"));
  const closed4 = await autoClose4(fakePiFinalize, taskPaths({ tasksDir: join(scratch, ".pi/swarm/tasks"), root: scratch }, task4), task4State);
  ok("finalize auto-closes once git HEAD advances", closed4.closed.includes("finalize"));
  ok("finalize per-node evidence flips to verified", task4State.evidence?.finalize?.status === "verified");
  ok("legacy .commit alias is not dual-written", task4State.evidence?.commit === undefined);
  ok("printGraphText still surfaces finalize evidence via read-compat alias", printGraphText(task4State, [], []).includes("Commit evidence [finalize]"));

  // 4d) Create-path ordering: a terminal one-node graph only auto-closes once baseline exists.
  const { autoCloseOrchestratorTerminalNodes: autoCloseOrder } = await import(join(here, "..", "src/taskgraph.ts"));
  const { writeBaselineCommit } = await import(join(here, "..", "src/trace.ts"));
  const seedOneNodeTask = (taskId) => {
    const tp = taskPaths({ tasksDir: join(scratch, ".pi/swarm/tasks"), root: scratch }, taskId);
    mkdirSync(tp.root, { recursive: true });
    mkdirSync(tp.artifacts, { recursive: true });
    const task = {
      version: 1,
      taskId,
      title: "create ordering",
      goal: "baseline must precede auto-close for a one-node orchestrator graph",
      status: "ready",
      priority: "normal",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      owner: "orchestrator",
      workflow: "feature-dev",
      allowedFiles: [],
      acceptanceCriteria: [],
      validationCommands: [],
      start: "finalize",
      currentNodes: ["finalize"],
      sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
      nodes: {
        finalize: { status: "pending", role: "orchestrator", dependsOn: [], readArtifacts: [], writeArtifacts: [], messageIds: [], attempts: 0, maxAttempts: 1, terminal: true },
      },
      edges: [],
      handoffs: [],
      gates: {},
      editLocks: {},
      evidence: {},
    };
    writeFileSync(tp.taskJson, JSON.stringify(task, null, 2));
    return { tp, task };
  };
  // Old order: auto-close before baseline should not close the node.
  const oldOrderTaskId = "task-row75-create-ordering-old";
  const oldOrder = seedOneNodeTask(oldOrderTaskId);
  const noBaselinePi = { exec: async (cmd, args) => cmd === "git" && args?.[0] === "rev-parse" ? { code: 0, stdout: "post-create-head\n", stderr: "" } : { code: 0, stdout: "", stderr: "" } };
  const noClose = await autoCloseOrder(noBaselinePi, oldOrder.tp, oldOrder.task);
  ok("one-node create does not auto-close before baseline exists", noClose.closed.length === 0);
  ok("node stays pending without baseline", oldOrder.task.nodes.finalize.status === "pending");
  // Fixed order: baseline first, then auto-close, must close and stamp evidence.
  const newOrderTaskId = "task-row75-create-ordering-new";
  const newOrder = seedOneNodeTask(newOrderTaskId);
  const stagedPi = {
    calls: 0,
    exec: async (cmd, args) => {
      if (cmd === "git" && args?.[0] === "rev-parse") {
        stagedPi.calls += 1;
        return stagedPi.calls === 1 ? { code: 0, stdout: "baseline-before-create\n", stderr: "" } : { code: 0, stdout: "post-create-head\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  await writeBaselineCommit(stagedPi, newOrder.tp);
  const closedOrder = await autoCloseOrder(stagedPi, newOrder.tp, newOrder.task);
  ok("one-node create auto-closes after baseline exists", closedOrder.closed.includes("finalize"));
  ok("one-node create stamps per-node evidence", newOrder.task.evidence?.finalize?.status === "verified");

  // 2b) Notes with leading ./artifacts/... references rewrite to task-absolute paths.
  await ensureWorker("writer-2", "implementer");
  const task6 = "task-row75-dot-artifact";
  await call("swarm_create_task", {
    taskId: task6,
    title: "dot artifact rewrite",
    goal: "ensure ./artifacts/x.md references in notes rewrite",
    cwd: scratch,
    nodes: { plan: { role: "planner", writeArtifacts: ["artifacts/plan.md"] } },
    edges: [],
    start: "plan",
  });
  process.env.PI_SWARM_AGENT_ID = "orchestrator";
  process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
  await call("swarm_assign_task", { taskId: task6, nodeId: "plan", agentId: "writer-2", note: "see ./artifacts/plan.md and artifacts/other.md for context", cwd: scratch });
  const t5Mailbox = readMailbox("writer-2");
  const t5Note = t5Mailbox[t5Mailbox.length - 1]?.body || "";
  ok("./artifacts/ note reference rewritten to task-absolute", t5Note.includes(`.pi/swarm/tasks/${task6}/artifacts/plan.md`));
  ok("plain artifacts/ note reference also rewritten", t5Note.includes(`.pi/swarm/tasks/${task6}/artifacts/other.md`));
  ok("rewrite annotation present in assignment body", t5Note.includes("Note (rewritten to task-absolute artifact paths)"));

  console.log("PASS row75 guardrail test");
} finally {
  process.env.PI_SWARM_AGENT_ID = origAgent;
  process.env.PI_SWARM_IS_ORCHESTRATOR = origOrch;
  rmSync(scratch, { recursive: true, force: true });
}
