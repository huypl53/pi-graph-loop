#!/usr/bin/env node
/**
 * Issue 29 — force reopen clears stale activeAttemptId.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), `swarm-force-reopen-${process.pid}-${Date.now()}`));
await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
await writeFile(join(scratch, ".pi/settings.json"), JSON.stringify({ swarm: { defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" } }));
const originalCwd = process.cwd();
process.chdir(scratch);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  ok  ", name); } else { fail++; console.error("  FAIL", name, detail ? `(${detail})` : ""); } };
const expectReject = async (fn, predicate, name) => {
	try { await fn(); ok(name, false, "expected rejection"); return null; }
	catch (err) { ok(name, predicate(err), err?.errorCode || err?.message || String(err)); return err; }
};
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const readTask = async (taskId) => readJson(join(scratch, `.pi/swarm/tasks/${taskId}/task.json`));
const readTaskEvents = async (taskId) => {
	const raw = await readFile(join(scratch, `.pi/swarm/tasks/${taskId}/events.jsonl`), "utf8").catch(() => "");
	return raw.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
};
const readGlobalEvents = async () => {
	const raw = await readFile(join(scratch, ".pi/swarm/traces/events.jsonl"), "utf8").catch(() => "");
	return raw.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
};

async function loadExtension({ agentId, isOrchestrator = false } = {}) {
	if (agentId) process.env.PI_SWARM_AGENT_ID = agentId; else delete process.env.PI_SWARM_AGENT_ID;
	if (isOrchestrator) process.env.PI_SWARM_IS_ORCHESTRATOR = "1"; else delete process.env.PI_SWARM_IS_ORCHESTRATOR;
	const tools = {};
	const handlers = {};
	const activeTools = new Set();
	const pi = {
		registerTool: (def) => { tools[def.name] = def; activeTools.add(def.name); },
		registerCommand: () => {},
		on: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
		exec: async (cmd, args) => {
			if (cmd === "tmux" && args?.[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
			return { code: 1, stdout: "", stderr: "" };
		},
		setModel: async () => true,
		sendMessage: () => {},
		getAllTools: () => Object.values(tools).map((t) => ({ name: t.name })),
		getActiveTools: () => Array.from(activeTools),
		setActiveTools: (names) => { activeTools.clear(); for (const n of names) activeTools.add(n); },
	};
	const mod = await import(join(here, "index.ts"));
	mod.default(pi);
	for (const fn of handlers.session_start || []) {
		await fn({}, { cwd: scratch, mode: "tui", hasUI: false, ui: { setStatus: () => {}, notify: () => {} } });
	}
	return { tools };
}
const call = (tools, name, params) => tools[name].execute("call", params, undefined, undefined, { cwd: scratch });
const updateAs = async (tools, agentId, isOrchestrator, params) => {
	const prevId = process.env.PI_SWARM_AGENT_ID;
	const prevOrch = process.env.PI_SWARM_IS_ORCHESTRATOR;
	process.env.PI_SWARM_AGENT_ID = agentId;
	if (isOrchestrator) process.env.PI_SWARM_IS_ORCHESTRATOR = "1"; else delete process.env.PI_SWARM_IS_ORCHESTRATOR;
	try { return await call(tools, "swarm_update_task", { ...params, cwd: scratch }); }
	finally {
		if (prevId === undefined) delete process.env.PI_SWARM_AGENT_ID; else process.env.PI_SWARM_AGENT_ID = prevId;
		if (prevOrch === undefined) delete process.env.PI_SWARM_IS_ORCHESTRATOR; else process.env.PI_SWARM_IS_ORCHESTRATOR = prevOrch;
	}
};
const assign = async (tools, taskId, nodeId, agentId) => call(tools, "swarm_assign_task", { taskId, nodeId, agentId, cwd: scratch });
const registerAgent = async (tools, id, roleKind) => call(tools, "swarm_register_agent", { id, role: `${roleKind} test agent`, roleKind, tmuxTarget: "unknown", inject: false });

// Scenario 1: force reopen clears stale attempt and fences prior assignment
{
	console.log("\n--- Scenario 1: force reopen clears stale attempt ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension({ agentId: "orchestrator", isOrchestrator: true });
	await registerAgent(tools, "worker-a", "implementer");
	const taskId = "task-force-reopen-s1";
	await call(tools, "swarm_create_task", { taskId, title: "force reopen", goal: "force reopen stale attempt", priority: "normal", cwd: scratch, nodes: { plan: { role: "planner" }, "done-node": { role: "implementer", dependsOn: ["plan"] } }, edges: [{ from: "plan", to: "done-node", when: "planned" }] });
	await assign(tools, taskId, "plan", "worker-a");
	let task = await readTask(taskId);
	await updateAs(tools, "worker-a", false, { taskId, nodeId: "plan", status: "done", outcome: "planned", attemptId: task.nodes.plan.activeAttemptId });
	await assign(tools, taskId, "done-node", "worker-a");
	task = await readTask(taskId);
	const priorAttemptId = task.nodes["done-node"].activeAttemptId;
	await updateAs(tools, "worker-a", false, { taskId, nodeId: "done-node", status: "done", outcome: "implemented", attemptId: priorAttemptId });
	task = await readTask(taskId);
	ok("node completed before force reopen", task.nodes["done-node"].status === "done");
	ok("active attempt exists before force reopen", Boolean(task.nodes["done-node"].activeAttemptId));
	await updateAs(tools, "orchestrator", true, { taskId, nodeId: "done-node", status: "ready", force: true });
	task = await readTask(taskId);
	ok("force reopen clears activeAttemptId", task.nodes["done-node"].activeAttemptId === undefined);
	ok("force reopen clears assignee", task.nodes["done-node"].assignee === undefined);
	ok("force reopen clears assignmentMessageId", task.nodes["done-node"].assignmentMessageId === undefined);
	ok("force reopen sets ready", task.nodes["done-node"].status === "ready");
	const priorAttempt = task.nodes["done-node"].attemptHistory.find((a) => a.attemptId === priorAttemptId);
	ok("prior attempt superseded", priorAttempt?.status === "superseded");
	ok("prior attempt supersededBy force reopen", priorAttempt?.supersededBy === "<force-reopen>");
	ok("prior attempt releaseReason force-reopen", priorAttempt?.releaseReason === "force-reopen");
	const forceEvents = await readTaskEvents(taskId);
	const forceTrace = forceEvents.find((e) => e.event === "task.attempt.force_reopen" && e.nodeId === "done-node");
	ok("force reopen trace emitted", Boolean(forceTrace));
	ok("force reopen trace includes prior attempt id", forceTrace?.priorAttemptId === priorAttemptId);
	await expectReject(() => updateAs(tools, "worker-a", false, { taskId, nodeId: "done-node", status: "in_progress", attemptId: priorAttemptId }), (e) => ["ATTEMPT_TOKEN_REQUIRED", "ATTEMPT_TOKEN_MISMATCH", "ATTEMPT_NOT_ACTIVE"].includes(e.errorCode), "stale prior attempt rejected after force reopen");
	await expectReject(() => updateAs(tools, "worker-a", false, { taskId, nodeId: "done-node", status: "in_progress" }), (e) => e?.errorCode === "ATTEMPT_TOKEN_REQUIRED", "missing attempt token rejected after force reopen");
	await assign(tools, taskId, "done-node", "worker-a");
	task = await readTask(taskId);
	const freshAttemptId = task.nodes["done-node"].activeAttemptId;
	ok("fresh assign mints new attempt", Boolean(freshAttemptId) && freshAttemptId !== priorAttemptId);
	const freshAttempt = task.nodes["done-node"].attemptHistory.find((a) => a.attemptId === freshAttemptId);
	ok("fresh attempt is active", freshAttempt?.status === "active");
	await updateAs(tools, "worker-a", false, { taskId, nodeId: "done-node", status: "in_progress", attemptId: freshAttemptId });
	task = await readTask(taskId);
	ok("same assignee can continue with fresh attempt", task.nodes["done-node"].status === "in_progress");
}

// Scenario 2: non-orchestrator force=false still rejected on terminal->non-terminal
{
	console.log("\n--- Scenario 2: non-orchestrator force=false rejected ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension({ agentId: "orchestrator", isOrchestrator: true });
	await registerAgent(tools, "worker-b", "implementer");
	const taskId = "task-force-reopen-s2";
	await call(tools, "swarm_create_task", { taskId, title: "force reopen 2", goal: "guard check", priority: "normal", cwd: scratch, nodes: { only: { role: "implementer", terminal: true } }, edges: [] });
	await assign(tools, taskId, "only", "worker-b");
	let task = await readTask(taskId);
	const attemptId = task.nodes.only.activeAttemptId;
	await updateAs(tools, "worker-b", false, { taskId, nodeId: "only", status: "done", outcome: "ok", attemptId });
	await expectReject(() => updateAs(tools, "worker-b", false, { taskId, nodeId: "only", status: "ready", force: false, attemptId }), (e) => ["INVALID_TRANSITION", "ATTEMPT_NOT_ACTIVE", "ATTEMPT_TOKEN_MISMATCH"].includes(e.errorCode), "worker force=false still rejected on done->ready");
}

// Scenario 3: terminal->terminal regression check
{
	console.log("\n--- Scenario 3: terminal->terminal regression check ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension({ agentId: "orchestrator", isOrchestrator: true });
	await registerAgent(tools, "worker-c", "implementer");
	const taskId = "task-force-reopen-s3";
	await call(tools, "swarm_create_task", { taskId, title: "force reopen 3", goal: "terminal regression", priority: "normal", cwd: scratch, nodes: { only: { role: "implementer", terminal: true } }, edges: [] });
	await assign(tools, taskId, "only", "worker-c");
	let task = await readTask(taskId);
	const attemptId = task.nodes.only.activeAttemptId;
	await updateAs(tools, "worker-c", false, { taskId, nodeId: "only", status: "failed", outcome: "failed", attemptId });
	task = await readTask(taskId);
	ok("terminal failure succeeds", task.nodes.only.status === "failed");
}

// Scenario 4: Issue 28 path remains distinct (rework reopen trace only)
{
	console.log("\n--- Scenario 4: Issue 28 rework path remains distinct ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension({ agentId: "orchestrator", isOrchestrator: true });
	await registerAgent(tools, "planner-a", "planner");
	await registerAgent(tools, "implementer-a", "implementer");
	await registerAgent(tools, "tester-a", "tester");
	const taskId = "task-force-reopen-s4";
	await call(tools, "swarm_create_task", { taskId, title: "issue 28 path", goal: "rework reopen", priority: "normal", cwd: scratch });
	await assign(tools, taskId, "plan", "planner-a");
	let task = await readTask(taskId);
	await updateAs(tools, "planner-a", false, { taskId, nodeId: "plan", status: "done", outcome: "planned", attemptId: task.nodes.plan.activeAttemptId });
	await assign(tools, taskId, "implement", "implementer-a");
	task = await readTask(taskId);
	await updateAs(tools, "implementer-a", false, { taskId, nodeId: "implement", status: "done", outcome: "implemented", attemptId: task.nodes.implement.activeAttemptId });
	await assign(tools, taskId, "test", "tester-a");
	task = await readTask(taskId);
	await updateAs(tools, "tester-a", false, { taskId, nodeId: "test", status: "done", outcome: "passed", attemptId: task.nodes.test.activeAttemptId });
	await updateAs(tools, "orchestrator", true, { taskId, nodeId: "fix", status: "done", outcome: "implemented", force: true });
	const events = await readGlobalEvents();
	ok("rework path emits rework reopen trace", events.some((e) => e.event === "task.attempt.reopened_by_rework" && e.taskId === taskId));
	ok("rework path does not emit force reopen trace", !events.some((e) => e.event === "task.attempt.force_reopen" && e.taskId === taskId));
}

process.chdir(originalCwd);
console.log(`\nSummary: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
