#!/usr/bin/env node
/**
 * Issue 28 — rework reopen of done nodes.
 *
 * Covers:
 *  - default feature-dev rework loop: test done(passed) -> fix done(implemented) reopens test
 *  - reopened done node is cleared and gets a fresh attempt on next assign
 *  - linear non-rework flow does NOT emit reopen traces
 *  - worker update without force still cannot reopen a done node
 *  - orchestrator force reopen from done -> ready succeeds
 *  - failed->ready path remains functional
 *  - transiently non-reopenable rework targets do not consume the edge until reopen succeeds
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), `swarm-rework-reopen-${process.pid}-${Date.now()}`));
const originalCwd = process.cwd();
process.chdir(scratch);
await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
await writeFile(join(scratch, ".pi/settings.json"), JSON.stringify({ swarm: { defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" } }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
	if (cond) { pass++; console.log("  ok  ", name); }
	else { fail++; console.error("  FAIL", name, detail ? `(${detail})` : ""); }
};
const expectReject = async (fn, predicate, name) => {
	try {
		await fn();
		ok(name, false, "expected rejection");
		return null;
	} catch (err) {
		ok(name, predicate(err), err?.errorCode || err?.message || String(err));
		return err;
	}
};
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const readTask = async (taskId) => readJson(join(scratch, `.pi/swarm/tasks/${taskId}/task.json`));
const readTaskEvents = async (taskId) => {
	const p = join(scratch, `.pi/swarm/tasks/${taskId}/events.jsonl`);
	const raw = await readFile(p, "utf8").catch(() => "");
	return raw.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
};
const readGlobalEvents = async () => {
	const p = join(scratch, ".pi/swarm/traces/events.jsonl");
	const raw = await readFile(p, "utf8").catch(() => "");
	return raw.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
};

const ORIG_AGENT_ID = process.env.PI_SWARM_AGENT_ID;
const ORIG_IS_ORCH = process.env.PI_SWARM_IS_ORCHESTRATOR;

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
	const mod = await import(join(here, "..", "index.ts"));
	mod.default(pi);
	for (const fn of handlers.session_start || []) {
		await fn({}, { cwd: scratch, mode: "tui", hasUI: false, ui: { setStatus: () => {}, notify: () => {} } });
	}
	return { tools };
}

const call = async (tools, name, params) => tools[name].execute("call", params, undefined, undefined, { cwd: scratch });
const as = (agentId, isOrchestrator, fn) => async () => {
	const tools = (await loadExtension({ agentId, isOrchestrator })).tools;
	return fn(tools);
};

async function registerAgent(tools, id, roleKind) {
	await call(tools, "swarm_register_agent", {
		id,
		role: `${roleKind} test agent`,
		roleKind,
		tmuxTarget: "unknown",
		inject: false,
	});
}

async function createDefaultTask(tools, taskId) {
	await call(tools, "swarm_create_task", {
		taskId,
		title: `rework reopen ${taskId}`,
		goal: "validate done->ready rework reopen",
		priority: "normal",
		cwd: scratch,
	});
}

async function assign(tools, taskId, nodeId, agentId) {
	await call(tools, "swarm_assign_task", { taskId, nodeId, agentId, cwd: scratch });
}

async function updateAs(tools, agentId, isOrchestrator, params) {
	const prevId = process.env.PI_SWARM_AGENT_ID;
	const prevOrch = process.env.PI_SWARM_IS_ORCHESTRATOR;
	process.env.PI_SWARM_AGENT_ID = agentId;
	if (isOrchestrator) process.env.PI_SWARM_IS_ORCHESTRATOR = "1"; else delete process.env.PI_SWARM_IS_ORCHESTRATOR;
	try {
		return await call(tools, "swarm_update_task", { ...params, cwd: scratch });
	} finally {
		if (prevId === undefined) delete process.env.PI_SWARM_AGENT_ID; else process.env.PI_SWARM_AGENT_ID = prevId;
		if (prevOrch === undefined) delete process.env.PI_SWARM_IS_ORCHESTRATOR; else process.env.PI_SWARM_IS_ORCHESTRATOR = prevOrch;
	}
}

// ============================================================
// Scenario 1: default feature-dev rework reopen from done -> ready
// ============================================================
{
	console.log("\n--- Scenario 1: default graph rework reopen ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension({ agentId: "orchestrator", isOrchestrator: true });
	await registerAgent(tools, "planner-a", "planner");
	await registerAgent(tools, "implementer-a", "implementer");
	await registerAgent(tools, "tester-a", "tester");
	await registerAgent(tools, "reviewer-a", "reviewer");

	const taskId = "task-rework-reopen-s1";
	await createDefaultTask(tools, taskId);

	await assign(tools, taskId, "plan", "planner-a");
	const planAttempt = (await readTask(taskId)).nodes.plan.activeAttemptId;
	await updateAs(tools, "planner-a", false, { taskId, nodeId: "plan", status: "done", outcome: "planned", attemptId: planAttempt });

	await assign(tools, taskId, "implement", "implementer-a");
	const implAttempt = (await readTask(taskId)).nodes.implement.activeAttemptId;
	await updateAs(tools, "implementer-a", false, { taskId, nodeId: "implement", status: "done", outcome: "implemented", attemptId: implAttempt });

	await assign(tools, taskId, "test", "tester-a");
	const testAttempt1 = (await readTask(taskId)).nodes.test.activeAttemptId;
	await updateAs(tools, "tester-a", false, { taskId, nodeId: "test", status: "done", outcome: "passed", attemptId: testAttempt1 });
	let task = await readTask(taskId);
	ok("review becomes current from linear test->review", task.currentNodes.includes("review"));
	ok("test stays done after first pass", task.nodes.test.status === "done");

	await updateAs(tools, "orchestrator", true, { taskId, nodeId: "fix", status: "ready", force: true });
	await assign(tools, taskId, "fix", "implementer-a");
	const fixAttempt = (await readTask(taskId)).nodes.fix.activeAttemptId;
	await updateAs(tools, "implementer-a", false, { taskId, nodeId: "fix", status: "done", outcome: "implemented", attemptId: fixAttempt });

	await sleep(25);
	task = await readTask(taskId);
	ok("fix->test rework reopens test to ready", task.nodes.test.status === "ready");
	ok("reopen clears assignee", task.nodes.test.assignee === undefined);
	ok("reopen clears activeAttemptId", task.nodes.test.activeAttemptId === undefined);
	ok("reopen clears assignmentMessageId", task.nodes.test.assignmentMessageId === undefined);
	ok("reopen clears staleAt", task.nodes.test.staleAt === undefined);
	ok("reopen nulls outcome", task.nodes.test.outcome === null);
	const priorTestAttempt = task.nodes.test.attemptHistory?.find((a) => a.attemptId === testAttempt1);
	ok("prior attempt remains in history", Boolean(priorTestAttempt));
	ok("prior attempt remains completed", priorTestAttempt?.status === "completed");
	ok("prior attempt releaseReason=terminal", priorTestAttempt?.releaseReason === "terminal");
	ok("prior attempt releasedAt stamped", Boolean(priorTestAttempt?.releasedAt));
	let taskEvents = await readTaskEvents(taskId);
	let globalEvents = await readGlobalEvents();
	const reopenEvents = globalEvents.filter((e) => e.event === "task.attempt.reopened_by_rework" && e.nodeId === "test");
	ok("task.attempt.reopened_by_rework trace emitted", reopenEvents.length >= 1);
	ok("reopen trace carries priorAttemptId", reopenEvents.some((e) => e.priorAttemptId === testAttempt1));
	ok("rework ledger records first consumption", Array.isArray(task.reworkConsumption) && task.reworkConsumption.length === 1);
	const firstConsumption = task.reworkConsumption?.[0];
	ok("rework ledger captures source attempt", firstConsumption?.sourceAttemptId === fixAttempt && firstConsumption?.reopenedNodeId === "test");

	await assign(tools, taskId, "test", "tester-a");
	task = await readTask(taskId);
	const testAttempt2 = task.nodes.test.activeAttemptId;
	ok("fresh active attempt minted after reopen", Boolean(testAttempt2) && testAttempt2 !== testAttempt1);
	ok("fresh attempt history appended", task.nodes.test.attemptHistory.length >= 2);
	taskEvents = await readTaskEvents(taskId);
	globalEvents = await readGlobalEvents();
	const mintedTrace = taskEvents.filter((e) => e.event === "task.attempt.minted" && e.nodeId === "test");
	ok("mint trace exists for re-assignment", mintedTrace.length >= 1);
	ok("global events still readable after re-assignment", globalEvents.length >= reopenEvents.length);
	await updateAs(tools, "tester-a", false, { taskId, nodeId: "test", status: "done", outcome: "passed", attemptId: testAttempt2 });
	task = await readTask(taskId);
	ok("retest completes again", task.nodes.test.status === "done" && task.nodes.test.outcome === "passed");
	ok("rework ledger remains one-shot for same source attempt", task.reworkConsumption.length === 1);

	// Later downstream review/commit updates must not hot-reopen the completed retest.
	await assign(tools, taskId, "review", "reviewer-a");
	task = await readTask(taskId);
	const reviewAttempt = task.nodes.review.activeAttemptId;
	await updateAs(tools, "reviewer-a", false, { taskId, nodeId: "review", status: "done", outcome: "approved", attemptId: reviewAttempt });
	task = await readTask(taskId);
	ok("downstream review keeps test done", task.nodes.test.status === "done");
	ok("downstream review keeps test passed", task.nodes.test.outcome === "passed");
	ok("downstream review leaves commit pending until real git evidence", task.nodes.commit.status === "pending");
	ok("commit evidence flagged unverified", task.evidence?.commit?.status === "unverified");
	ok("downstream review does not add consumption", task.reworkConsumption.length === 1);

	// Fresh qualifying source attempt should be able to trigger a new cycle with a distinct identity.
	await updateAs(tools, "orchestrator", true, { taskId, nodeId: "fix", status: "ready", force: true });
	await assign(tools, taskId, "fix", "implementer-a");
	task = await readTask(taskId);
	const fixAttempt2 = task.nodes.fix.activeAttemptId;
	ok("fresh fix attempt minted", !!fixAttempt2 && fixAttempt2 !== fixAttempt);
	await updateAs(tools, "implementer-a", false, { taskId, nodeId: "fix", status: "done", outcome: "implemented", attemptId: fixAttempt2 });
	task = await readTask(taskId);
	ok("fresh qualifying source attempt reopens test again", task.nodes.test.status === "ready");
	ok("fresh cycle clears current attempt", !task.nodes.test.activeAttemptId);
	ok("fresh cycle appends a second consumption record", task.reworkConsumption.length === 2);
	ok("fresh cycle uses distinct source attempt identity", task.reworkConsumption[1].sourceAttemptId === fixAttempt2 && task.reworkConsumption[1].sourceAttemptId !== firstConsumption?.sourceAttemptId);
	await assign(tools, taskId, "test", "tester-a");
	task = await readTask(taskId);
	const testAttempt3 = task.nodes.test.activeAttemptId;
	ok("fresh reopened test mints third attempt", !!testAttempt3 && testAttempt3 !== testAttempt2);
	await updateAs(tools, "tester-a", false, { taskId, nodeId: "test", status: "done", outcome: "passed", attemptId: testAttempt3 });
	task = await readTask(taskId);
	ok("fresh cycle retest completes passed", task.nodes.test.status === "done" && task.nodes.test.outcome === "passed");
	ok("fresh cycle retains rework ledger length 2", task.reworkConsumption.length === 2);
	ok("fresh cycle consumption id differs", task.reworkConsumption[1].sourceAttemptId === fixAttempt2 && task.reworkConsumption[1].sourceAttemptId !== firstConsumption?.sourceAttemptId);

	// ============ 4. Audit immutability + persistence ============
	const hist = task.nodes.test.attemptHistory;
	ok("audit history append-only (3 attempts)", hist.length === 3);
	ok("attempt 1 completed with outcome", hist[0].status === "completed" && hist[0].outcome === "passed" && hist[0].attemptNumber === 1 && hist[0].supersededBy === "<rework>");
	ok("attempt 2 present as second attempt", hist[1].attemptNumber === 2 && hist[1].assignee === "tester-a" && !!hist[1].assignmentMessageId);
	ok("attempt 3 completed with outcome", hist[2].status === "completed" && hist[2].outcome === "passed" && hist[2].attemptNumber === 3 && hist[2].supersededBy === undefined);
	ok("attempt records carry assignee + message id", hist.every((a) => a.assignee === "tester-a" && a.assignmentMessageId));
}

// ============================================================
// Scenario 2: worker update without force still blocked on done -> ready
// ============================================================
{
	console.log("\n--- Scenario 2: worker cannot reopen done node without force ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension({ agentId: "orchestrator", isOrchestrator: true });
	await registerAgent(tools, "worker-b", "tester");
	const taskId = "task-rework-reopen-s2";
	await createDefaultTask(tools, taskId);
	await assign(tools, taskId, "plan", "worker-b");
	const planAttempt = (await readTask(taskId)).nodes.plan.activeAttemptId;
	await updateAs(tools, "worker-b", false, { taskId, nodeId: "plan", status: "done", outcome: "planned", attemptId: planAttempt });
	const err = await expectReject(
		() => updateAs(tools, "worker-b", false, { taskId, nodeId: "plan", status: "ready" }),
		((e) => Boolean(e?.errorCode) && ["ATTEMPT_TOKEN_REQUIRED", "ATTEMPT_NOT_ACTIVE", "INVALID_TRANSITION"].includes(e.errorCode)),
		"worker rejected on done -> ready without force",
	);
	ok("worker reopen attempt rejected", Boolean(err));
}

// ============================================================
// Scenario 3: orchestrator force reopen succeeds on done -> ready
// ============================================================
{
	console.log("\n--- Scenario 3: orchestrator force reopen succeeds ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension({ agentId: "orchestrator", isOrchestrator: true });
	await registerAgent(tools, "worker-c", "tester");
	const taskId = "task-rework-reopen-s3";
	await createDefaultTask(tools, taskId);
	await assign(tools, taskId, "plan", "worker-c");
	const planAttempt = (await readTask(taskId)).nodes.plan.activeAttemptId;
	await updateAs(tools, "worker-c", false, { taskId, nodeId: "plan", status: "done", outcome: "planned", attemptId: planAttempt });
	await updateAs(tools, "orchestrator", true, { taskId, nodeId: "plan", status: "ready", force: true });
	const task = await readTask(taskId);
	ok("orchestrator force reopens done node to ready", task.nodes.plan.status === "ready");
}

// ============================================================
// Scenario 4: non-rework linear path does not emit reopen trace
// ============================================================
{
	console.log("\n--- Scenario 4: linear non-rework path does not emit reopen trace ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension({ agentId: "orchestrator", isOrchestrator: true });
	await registerAgent(tools, "worker-d", "implementer");
	await registerAgent(tools, "worker-e", "reviewer");
	const taskId = "task-rework-reopen-s4";
	await call(tools, "swarm_create_task", {
		taskId,
		title: "linear path",
		goal: "no rework edges here",
		priority: "normal",
		cwd: scratch,
		nodes: {
			start: { role: "implementer", writeArtifacts: ["artifacts/start.md"] },
			end: { role: "reviewer", dependsOn: ["start"], writeArtifacts: ["artifacts/end.md"] },
		},
		edges: [{ from: "start", to: "end", when: "done" }],
	});
	await assign(tools, taskId, "start", "worker-d");
	const startAttempt = (await readTask(taskId)).nodes.start.activeAttemptId;
	await updateAs(tools, "worker-d", false, { taskId, nodeId: "start", status: "done", outcome: "done", attemptId: startAttempt });
	await sleep(25);
	const task = await readTask(taskId);
	ok("linear successor becomes current", task.currentNodes.includes("end"));
	ok("linear path leaves no reopen trace", (await readTaskEvents(taskId)).filter((e) => e.event === "task.attempt.reopened_by_rework").length === 0);
	ok("completed linear node stays done", task.nodes.start.status === "done");
}

// ============================================================
// Scenario 5: failed -> ready rework still works
// ============================================================
{
	console.log("\n--- Scenario 5: failed -> ready rework still works ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension({ agentId: "orchestrator", isOrchestrator: true });
	await registerAgent(tools, "worker-f", "tester");
	await registerAgent(tools, "worker-g", "implementer");
	const taskId = "task-rework-reopen-s5";
	await createDefaultTask(tools, taskId);
	await assign(tools, taskId, "plan", "worker-f");
	const planAttempt = (await readTask(taskId)).nodes.plan.activeAttemptId;
	await updateAs(tools, "worker-f", false, { taskId, nodeId: "plan", status: "done", outcome: "planned", attemptId: planAttempt });
	await assign(tools, taskId, "implement", "worker-g");
	const implAttempt = (await readTask(taskId)).nodes.implement.activeAttemptId;
	await updateAs(tools, "worker-g", false, { taskId, nodeId: "implement", status: "done", outcome: "implemented", attemptId: implAttempt });
	await assign(tools, taskId, "test", "worker-f");
	const testAttempt = (await readTask(taskId)).nodes.test.activeAttemptId;
	await updateAs(tools, "worker-f", false, { taskId, nodeId: "test", status: "failed", outcome: "failed", attemptId: testAttempt });
	await sleep(25);
	const task = await readTask(taskId);
	ok("failed test makes fix current", task.currentNodes.includes("fix"));
	ok("failed test reopens fix to ready", task.nodes.fix.status === "ready");
	const events = await readGlobalEvents();
	ok("failed path emits one reopen trace", events.some((e) => e.event === "task.attempt.reopened_by_rework" && e.nodeId === "fix"));
}

// ============================================================
// Scenario 6: review rejection does not hot-reopen fix after fix completion
// ============================================================
{
	console.log("\n--- Scenario 6: review rejection stays one-shot after fix completion ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension({ agentId: "orchestrator", isOrchestrator: true });
	await registerAgent(tools, "planner-b", "planner");
	await registerAgent(tools, "implementer-b", "implementer");
	await registerAgent(tools, "tester-b", "tester");
	await registerAgent(tools, "reviewer-b", "reviewer");
	const taskId = "task-rework-reopen-s6";
	await createDefaultTask(tools, taskId);
	await assign(tools, taskId, "plan", "planner-b");
	let task = await readTask(taskId);
	const planAttempt = task.nodes.plan.activeAttemptId;
	await updateAs(tools, "planner-b", false, { taskId, nodeId: "plan", status: "done", outcome: "planned", attemptId: planAttempt });
	await assign(tools, taskId, "implement", "implementer-b");
	task = await readTask(taskId);
	const implAttempt = task.nodes.implement.activeAttemptId;
	await updateAs(tools, "implementer-b", false, { taskId, nodeId: "implement", status: "done", outcome: "implemented", attemptId: implAttempt });
	await assign(tools, taskId, "test", "tester-b");
	task = await readTask(taskId);
	const testAttempt = task.nodes.test.activeAttemptId;
	await updateAs(tools, "tester-b", false, { taskId, nodeId: "test", status: "done", outcome: "passed", attemptId: testAttempt });
	await assign(tools, taskId, "review", "reviewer-b");
	task = await readTask(taskId);
	const reviewAttempt = task.nodes.review.activeAttemptId;
	await updateAs(tools, "reviewer-b", false, { taskId, nodeId: "review", status: "done", outcome: "rejected", attemptId: reviewAttempt });
	task = await readTask(taskId);
	ok("review rejection reopens fix", task.nodes.fix.status === "ready");
	const reopenBefore = (await readTaskEvents(taskId)).filter((e) => e.event === "task.attempt.reopened_by_rework" && e.nodeId === "fix").length;
	await assign(tools, taskId, "fix", "implementer-b");
	task = await readTask(taskId);
	const fixAttempt = task.nodes.fix.activeAttemptId;
	await updateAs(tools, "implementer-b", false, { taskId, nodeId: "fix", status: "done", outcome: "implemented", attemptId: fixAttempt });
	task = await readTask(taskId);
	ok("fix completion stays done", task.nodes.fix.status === "done");
	ok("fix completion reopens test", task.nodes.test.status === "ready");
	ok("fix completion does not re-open fix", task.nodes.fix.status === "done");
	const reopenAfter = (await readTaskEvents(taskId)).filter((e) => e.event === "task.attempt.reopened_by_rework" && e.nodeId === "fix").length;
	ok("fix reopen trace remains one-shot across fix completion", reopenAfter === reopenBefore);
}

// ============================================================
// Scenario 7: transiently non-reopenable target does not consume rework edge
// ============================================================
{
	console.log("\n--- Scenario 7: transient non-reopenable target keeps rework edge unconsumed ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const { tools } = await loadExtension({ agentId: "orchestrator", isOrchestrator: true });
	await registerAgent(tools, "planner-c", "planner");
	await registerAgent(tools, "implementer-c", "implementer");
	await registerAgent(tools, "tester-c", "tester");
	await registerAgent(tools, "reviewer-c", "reviewer");
	const taskId = "task-rework-reopen-s7";
	await createDefaultTask(tools, taskId);

	await assign(tools, taskId, "plan", "planner-c");
	let task = await readTask(taskId);
	let attempt = task.nodes.plan.activeAttemptId;
	await updateAs(tools, "planner-c", false, { taskId, nodeId: "plan", status: "done", outcome: "planned", attemptId: attempt });
	await assign(tools, taskId, "implement", "implementer-c");
	task = await readTask(taskId);
	attempt = task.nodes.implement.activeAttemptId;
	await updateAs(tools, "implementer-c", false, { taskId, nodeId: "implement", status: "done", outcome: "implemented", attemptId: attempt });
	await assign(tools, taskId, "test", "tester-c");
	task = await readTask(taskId);
	const testAttempt = task.nodes.test.activeAttemptId;
	await updateAs(tools, "tester-c", false, { taskId, nodeId: "test", status: "done", outcome: "passed", attemptId: testAttempt });
	await assign(tools, taskId, "review", "reviewer-c");
	await updateAs(tools, "orchestrator", true, { taskId, nodeId: "fix", status: "assigned", force: true });
	task = await readTask(taskId);
	ok("fix is assigned before review rejection", task.nodes.fix.status === "assigned");
	const consumptionBefore = task.reworkConsumption?.length || 0;
	const reviewAttempt = task.nodes.review.activeAttemptId;
	await updateAs(tools, "reviewer-c", false, { taskId, nodeId: "review", status: "done", outcome: "rejected", attemptId: reviewAttempt });
	task = await readTask(taskId);
	ok("review rejection leaves assigned fix in place", task.nodes.fix.status === "assigned");
	ok("review rejection does not consume rework yet", (task.reworkConsumption?.length || 0) === consumptionBefore);

	await updateAs(tools, "orchestrator", true, { taskId, nodeId: "fix", status: "ready", force: true });
	await assign(tools, taskId, "fix", "implementer-c");
	task = await readTask(taskId);
	const fixAttempt2 = task.nodes.fix.activeAttemptId;
	await updateAs(tools, "implementer-c", false, { taskId, nodeId: "fix", status: "done", outcome: "implemented", attemptId: fixAttempt2 });
	task = await readTask(taskId);
	ok("later reopenable pass reopens test", task.nodes.test.status === "ready");
	ok("later reopenable pass stamps matching consumption", task.reworkConsumption.some((r) => r.sourceAttemptId === fixAttempt2 && r.reopenedNodeId === "test"));
	const reopenTrace = (await readGlobalEvents()).filter((e) => e.event === "task.attempt.reopened_by_rework" && e.nodeId === "test");
	ok("reopen trace emitted for the successful pass", reopenTrace.length >= 1);
}

const globalEvents = await readGlobalEvents();
ok("global trace file readable", Array.isArray(globalEvents));

process.chdir(originalCwd);
console.log(`\nSummary: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
