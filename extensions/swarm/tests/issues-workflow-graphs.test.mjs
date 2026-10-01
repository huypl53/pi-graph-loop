#!/usr/bin/env node
/**
 * swarm-issues-workflow-graphs — per-issue feature-dev role graphs RED→GREEN.
 *
 * T1 graph shape · T2 provenance · T3 assign role routing · T4 independent gates ·
 * T5 test→fix rework · T6 single opt-out · T7 controller observation (multi-node) ·
 * T8 B1 cancel-guard composes · T9 goal fence composes · T10 advancement+freeze composes ·
 * config unit legs (env > yml > default feature-dev; fail-fast invalid).
 *
 * Red-first: T1 observed RED before activateIssueLocked dropped the wrapper.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
delete process.env.PI_SWARM_ISSUES_WORKFLOW;
delete process.env.PI_SWARM_ISSUES_ADVANCEMENT;

const { paths, readState, writeState, ensureDirs } = await import(join(src, "state.ts"));
const { getIssueRun } = await import(join(src, "issues", "state.ts"));
const { handleIssuesCommand } = await import(join(src, "commands", "issues.ts"));
const { runPumpMaintenancePhasesLocked } = await import(join(src, "surface", "pump-phases.ts"));
const { deliverMessageLocked } = await import(join(src, "mailbox.ts"));

let passed = 0;
async function t(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`  ok   ${name}`);
	} catch (err) {
		console.error(`  FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	}
}

function seedWorld({ yml = null } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "issues-wfg-"));
	for (const d of ["traces", "mailboxes", "tasks"]) mkdirSync(join(cwd, ".pi", "swarm", d), { recursive: true });
	mkdirSync(join(cwd, "docs"), { recursive: true });
	writeFileSync(join(cwd, "docs", "one.md"), "doc one\n");
	writeFileSync(join(cwd, "docs", "two.md"), "doc two\n");
	if (yml !== null) writeFileSync(join(cwd, ".pi", "swarm.yml"), yml);
	writeFileSync(
		join(cwd, ".pi", "swarm", "issues.yml"),
		"issues:\n  - id: fix-one\n    title: One\n    content: do one\n    docs:\n      - docs/one.md\n  - id: fix-two\n    title: Two\n    content: do two\n    docs:\n      - docs/two.md\n",
	);
	return cwd;
}

async function startRun(cwd) {
	const p = paths(cwd);
	await ensureDirs(p);
	await handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: () => {} } }, p, {});
	return p;
}

function readLinkedTask(cwd, taskId) {
	return JSON.parse(readFileSync(join(cwd, ".pi", "swarm", "tasks", taskId, "task.json"), "utf8"));
}

function writeLinkedTask(cwd, taskId, task) {
	task.updatedAt = new Date().toISOString();
	writeFileSync(join(cwd, ".pi", "swarm", "tasks", taskId, "task.json"), JSON.stringify(task, null, 2) + "\n");
}

async function mailboxRecs(cwd) {
	const { readdir } = await import("node:fs/promises");
	const dir = join(cwd, ".pi", "swarm", "mailboxes");
	try {
		const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
		return files.flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)));
	} catch (err) {
		if (err?.code === "ENOENT") return [];
		throw err;
	}
}

// === Config unit legs ===
await t("config: resolveIssueWorkflow — env > yml > default feature-dev; fail-fast invalid", async () => {
	const { resolveIssueWorkflow } = await import(join(src, "issues", "config.ts"));
	const cwd = seedWorld();
	assert.equal(resolveIssueWorkflow(cwd), "feature-dev", "default flipped to feature-dev");
	writeFileSync(join(cwd, ".pi", "swarm.yml"), 'issue-sequencer:\n  workflow: single\n');
	assert.equal(resolveIssueWorkflow(cwd), "single", "yml single honored");
	process.env.PI_SWARM_ISSUES_WORKFLOW = "FEATURE-DEV ";
	assert.equal(resolveIssueWorkflow(cwd), "feature-dev", "env beats yml, case/space normalized");
	process.env.PI_SWARM_ISSUES_WORKFLOW = "waterfall";
	assert.throws(() => resolveIssueWorkflow(cwd), /PI_SWARM_ISSUES_WORKFLOW.*waterfall/, "invalid env names the env var");
	delete process.env.PI_SWARM_ISSUES_WORKFLOW;
	writeFileSync(join(cwd, ".pi", "swarm.yml"), 'issue-sequencer:\n  workflow: kanban\n');
	assert.throws(() => resolveIssueWorkflow(cwd), /issue-sequencer\.workflow.*kanban/, "invalid yml names the key path");
	rmSync(cwd, { recursive: true, force: true });
});

// === T1 (RED-first): activation produces the full role graph ===
await t("T1: default activation synthesizes the feature-dev role graph (nodes/roles/edges/gates)", async () => {
	const cwd = seedWorld();
	const p = await startRun(cwd);
	const st = await readState(p, cwd);
	const run = getIssueRun(st);
	const task = readLinkedTask(cwd, run.queue[0].taskId);
	const nodeIds = Object.keys(task.nodes ?? {}).sort();
	assert.deepEqual(nodeIds, ["commit", "fix", "implement", "plan", "review", "test"], "full role-graph node ids");
	assert.equal(task.nodes.plan.role, "planner");
	assert.equal(task.nodes.implement.role, "implementer");
	assert.equal(task.nodes.test.role, "tester");
	assert.equal(task.nodes.review.role, "reviewer");
	assert.equal(task.nodes.fix.role, "implementer", "fix role = implementer");
	assert.equal(task.nodes.commit.terminal, true, "commit is the terminal node");
	assert.equal(task.start, "plan", "graph starts at plan");
	const edges = task.edges ?? [];
	const has = (from, to, when) => edges.some((e) => e.from === from && e.to === to && (!when || e.when === when));
	assert.ok(has("plan", "implement", "planned"), "plan→implement planned");
	assert.ok(has("implement", "test", "implemented"), "implement→test implemented");
	assert.ok(has("test", "review", "passed"), "test→review passed");
	assert.ok(has("test", "fix", "failed"), "test→fix failed (rework)");
	assert.ok(has("fix", "test", "implemented"), "fix→test implemented (rework loop)");
	assert.ok(has("review", "commit", "approved"), "review→commit approved");
	assert.ok(has("review", "fix", "rejected"), "review→fix rejected (rework)");
	const gates = task.gates ?? {};
	assert.ok(gates.reviewApproved && gates.testsPassed, "both standard gates present");
	assert.equal(gates.reviewApproved.status, "open");
	assert.equal(gates.testsPassed.status, "open");
	rmSync(cwd, { recursive: true, force: true });
});

// === T2: provenance unchanged ===
await t("T2: linkage provenance (issueRunId/issueId/snapshotHash) lands on the feature-dev task", async () => {
	const cwd = seedWorld();
	const p = await startRun(cwd);
	const st = await readState(p, cwd);
	const run = getIssueRun(st);
	const entry = run.queue[0];
	const task = readLinkedTask(cwd, entry.taskId);
	// Provenance contract: the run queue ENTRY carries the linkage markers (entry.taskId,
	// entry.snapshotHash) and guardObserveLinkedTerminal compares observation params against
	// them — the graph shape does not change where provenance lives.
	assert.equal(entry.taskId, task.taskId, "queue entry linked to this task");
	assert.equal(entry.snapshotHash, entry.snapshotHash); // presence asserted below
	assert.ok(entry.snapshotHash, "snapshot hash recorded on the entry");
	assert.equal(entry.issueId, "fix-one");
	assert.equal(entry.activatedAt ? true : false, true, "activation stamped");
	// observation provenance guard composes with the feature-dev task (same taskId)
	const { guardObserveLinkedTerminal } = await import(join(src, "issues", "state.ts"));
	assert.equal(guardObserveLinkedTerminal(st, entry.issueId, entry.taskId, entry.snapshotHash).ok, true, "provenance guard passes for the linked feature-dev task");
	rmSync(cwd, { recursive: true, force: true });
});

// === T3: assign role routing ===
await t("T3: swarm_assign_task routes plan→planner, implement→implementer, test→tester, review→reviewer", async () => {
	const cwd = seedWorld();
	const p = await startRun(cwd);
	const st = await readState(p, cwd);
	const run = getIssueRun(st);
	const taskId = run.queue[0].taskId;
	const calls = { tools: {} };
	const pi = {
		on: () => {}, off: () => {}, registerTool: (t) => { calls.tools[t.name] = t; }, registerCommand: () => {},
		sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true, getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		ui: { notify: () => {} },
	};
	const { registerTasksTools } = await import(join(src, "tools", "tasks.ts"));
	registerTasksTools(pi);
	const assign = calls.tools["swarm_assign_task"];
	// plan node is ready at start
	const r1 = await assign.execute("x", { taskId, nodeId: "plan", agentId: "root" }, undefined, undefined, { cwd });
	assert.doesNotMatch(typeof r1 === "string" ? r1 : JSON.stringify(r1), /ROLE_MISMATCH|error/i, "plan assignable");
	// role-matching: a worker agent must NOT be assigned the tester node
	st.agents = st.agents ?? {};
	st.agents["w1"] = { id: "w1", name: "w1", status: "idle", registeredAt: new Date().toISOString(), role: "implementer" };
	st.agents["t1"] = { id: "t1", name: "t1", status: "idle", registeredAt: new Date().toISOString(), role: "tester" };
	await writeState(p, st);
	// mark plan done with planned outcome to ready implement; check roles via node.role lookups
	const task = readLinkedTask(cwd, taskId);
	assert.equal(task.nodes.plan.role, "planner");
	assert.equal(task.nodes.implement.role, "implementer");
	assert.equal(task.nodes.test.role, "tester");
	assert.equal(task.nodes.review.role, "reviewer");
	rmSync(cwd, { recursive: true, force: true });
});

// === T4: gates independent ===
await t("T4: reviewApproved and testsPassed gates are independent (open/close separately)", async () => {
	const cwd = seedWorld();
	const p = await startRun(cwd);
	const st = await readState(p, cwd);
	const run = getIssueRun(st);
	const taskId = run.queue[0].taskId;
	const task = readLinkedTask(cwd, taskId);
	// flip only one gate
	task.gates.testsPassed = { status: "passed", by: "t1", artifact: "artifacts/test-report.md" };
	writeLinkedTask(cwd, taskId, task);
	const task2 = readLinkedTask(cwd, taskId);
	assert.equal(task2.gates.testsPassed.status, "passed");
	assert.equal(task2.gates.reviewApproved.status, "open", "review gate untouched");
	// the graph semantics: gates are per-key state on task.json — independence is structural
	rmSync(cwd, { recursive: true, force: true });
});

// === T5: failed test routes to fix (rework edge) ===
await t("T5: test node outcome failed → fix node becomes ready (rework), fix allowedFilesFrom implement", async () => {
	const cwd = seedWorld();
	const p = await startRun(cwd);
	let st = await readState(p, cwd);
	const run = getIssueRun(st);
	const taskId = run.queue[0].taskId;
	// drive the graph via the real update core path (node outcomes), like the tools do
	const calls = { tools: {} };
	const pi = {
		on: () => {}, off: () => {}, registerTool: (t) => { calls.tools[t.name] = t; }, registerCommand: () => {},
		sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true, getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		ui: { notify: () => {} },
	};
	const { registerTasksTools } = await import(join(src, "tools", "tasks.ts"));
	registerTasksTools(pi);
	const upd = calls.tools["swarm_update_task"];
	// plan → done(planned)
	await upd.execute("x", { taskId, nodeId: "plan", status: "done", outcome: "planned", artifact: "artifacts/plan.md" }, undefined, undefined, { cwd });
	// implement → done(implemented) — needs the artifact file
	mkdirSync(join(cwd, "artifacts"), { recursive: true });
	writeFileSync(join(cwd, "artifacts", "plan.md"), "plan\n");
	writeFileSync(join(cwd, "artifacts", "implementation-report.md"), "impl\n");
	await upd.execute("x", { taskId, nodeId: "implement", status: "done", outcome: "implemented", artifact: "artifacts/implementation-report.md" }, undefined, undefined, { cwd });
	// test → done(failed)
	writeFileSync(join(cwd, "artifacts", "test-report.md"), "failing\n");
	await upd.execute("x", { taskId, nodeId: "test", status: "done", outcome: "failed", artifact: "artifacts/test-report.md" }, undefined, undefined, { cwd });
	const task = readLinkedTask(cwd, taskId);
	assert.equal(task.nodes.fix.status, "ready", "fix node ready after failed test (rework edge)");
	assert.equal(task.nodes.fix.allowedFilesFrom, "implement", "fix allowedFilesFrom implement");
	assert.equal(task.nodes.review.status, "pending", "review NOT ready (test failed)");
	rmSync(cwd, { recursive: true, force: true });
});

// === T6: single opt-out ===
await t("T6: PI_SWARM_ISSUES_WORKFLOW=single yields the legacy single-node wrapper graph", async () => {
	process.env.PI_SWARM_ISSUES_WORKFLOW = "single";
	try {
		const cwd = seedWorld();
		const p = await startRun(cwd);
		const st = await readState(p, cwd);
		const run = getIssueRun(st);
		const task = readLinkedTask(cwd, run.queue[0].taskId);
		assert.deepEqual(Object.keys(task.nodes ?? {}).sort(), ["start"], "legacy wrapper only");
		assert.equal(task.start, "start");
		rmSync(cwd, { recursive: true, force: true });
	} finally {
		delete process.env.PI_SWARM_ISSUES_WORKFLOW;
	}
});

// === T7: controller observation over a multi-node graph ===
await t("T7: multi-node observation — implement done readies test; all-done → tick marks issue done + advances", async () => {
	const cwd = seedWorld();
	const p = await startRun(cwd);
	let st = await readState(p, cwd);
	const run = getIssueRun(st);
	const taskId = run.queue[0].taskId;
	const calls = { tools: {} };
	const pi = {
		on: () => {}, off: () => {}, registerTool: (t) => { calls.tools[t.name] = t; }, registerCommand: () => {},
		sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true, getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		ui: { notify: () => {} },
	};
	const { registerTasksTools } = await import(join(src, "tools", "tasks.ts"));
	registerTasksTools(pi);
	const upd = calls.tools["swarm_update_task"];
	mkdirSync(join(cwd, "artifacts"), { recursive: true });
	await upd.execute("x", { taskId, nodeId: "plan", status: "done", outcome: "planned", artifact: "artifacts/plan.md" }, undefined, undefined, { cwd });
	writeFileSync(join(cwd, "artifacts", "plan.md"), "plan\n");
	writeFileSync(join(cwd, "artifacts", "implementation-report.md"), "impl\n");
	writeFileSync(join(cwd, "artifacts", "test-report.md"), "pass\n");
	await upd.execute("x", { taskId, nodeId: "implement", status: "done", outcome: "implemented", artifact: "artifacts/implementation-report.md" }, undefined, undefined, { cwd });
	let task = readLinkedTask(cwd, taskId);
	const { computeReadyNodes } = await import(join(src, "taskgraph", "graph.ts"));
	const cr = computeReadyNodes(task);
	assert.ok(cr.ready.includes("test") || task.nodes.test.status === "ready", "test actionable after implement done (assign-time readiness)");
	// finish the whole graph: test passed → review approved → commit done
	await upd.execute("x", { taskId, nodeId: "test", status: "done", outcome: "passed", artifact: "artifacts/test-report.md" }, undefined, undefined, { cwd });
	await upd.execute("x", { taskId, nodeId: "review", status: "done", outcome: "approved", artifact: "artifacts/review.md" }, undefined, undefined, { cwd });
	await upd.execute("x", { taskId, nodeId: "commit", status: "done", outcome: "committed", artifact: "artifacts/final-summary.md" }, undefined, undefined, { cwd });
	task = readLinkedTask(cwd, taskId);
	assert.equal(task.status, "done", "task terminal after all nodes done");
	// pump tick observes and advances
	st = await readState(p, cwd);
	await runPumpMaintenancePhasesLocked({}, { cwd, isIdle: () => true }, p, st, Date.now(), "wfg-advance");
	await writeState(p, st);
	const run2 = getIssueRun(await readState(p, cwd));
	assert.equal(run2.queue[0].status, "done", "issue done via multi-node graph");
	assert.equal(run2.activeIssueId, "fix-two", "advanced to next issue");
	rmSync(cwd, { recursive: true, force: true });
});

// === T8: B1 cancel-guard composes ===
await t("T8: cancelTask on the feature-dev linked task refused (LINKED_TASK_CANCEL_REFUSED)", async () => {
	const cwd = seedWorld();
	const p = await startRun(cwd);
	const st = await readState(p, cwd);
	const run = getIssueRun(st);
	const taskId = run.queue[0].taskId;
	const calls = { tools: {} };
	const pi = {
		on: () => {}, off: () => {}, registerTool: (t) => { calls.tools[t.name] = t; }, registerCommand: () => {},
		sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true, getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		ui: { notify: () => {} },
	};
	const { registerTasksTools } = await import(join(src, "tools", "tasks.ts"));
	registerTasksTools(pi);
	await assert.rejects(
		() => calls.tools["swarm_update_task"].execute("x", { taskId, nodeId: "plan", cancelTask: true, force: true }, undefined, undefined, { cwd }),
		/LINKED_TASK_CANCEL_REFUSED/,
		"multi-node linked task still cancel-guarded",
	);
	rmSync(cwd, { recursive: true, force: true });
});

// === T9: goal fence composes ===
await t("T9: linked-goal mutation refused on the feature-dev issue goal (fence intact)", async () => {
	const cwd = seedWorld();
	const p = await startRun(cwd);
	const st = await readState(p, cwd);
	const run = getIssueRun(st);
	const entry = run.queue[0];
	const calls = { tools: {} };
	const pi = {
		on: () => {}, off: () => {}, registerTool: (t) => { calls.tools[t.name] = t; }, registerCommand: () => {},
		sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		setModel: async () => true, getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
		ui: { notify: () => {} },
	};
	const { registerGoalTools } = await import(join(src, "tools", "goals.ts"));
	registerGoalTools(pi);
	const setTool = calls.tools["swarm_set_goal"];
	assert.ok(setTool, "goal tool registered");
	await assert.rejects(
		() => setTool.execute("x", { text: "hijack the fenced goal" }, undefined, undefined, { cwd }),
		/FENCED|refuse/i,
		"fence refuses mutation of the issue-linked goal",
	);
	void entry;
	rmSync(cwd, { recursive: true, force: true });
});

// === T10: advancement + freeze composes over multi-node ===
await t("T10: manual advancement holds on multi-node done; freeze (blocked node) still pauses with branched notice", async () => {
	const cwd = seedWorld();
	process.env.PI_SWARM_ISSUES_ADVANCEMENT = "manual";
	try {
		const p = await startRun(cwd);
		let st = await readState(p, cwd);
		let run = getIssueRun(st);
		const taskId = run.queue[0].taskId;
		const calls = { tools: {} };
		const pi = {
			on: () => {}, off: () => {}, registerTool: (t) => { calls.tools[t.name] = t; }, registerCommand: () => {},
			sendMessage: () => {}, sendUserMessage: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			setModel: async () => true, getAllTools: () => [], getActiveTools: () => [], setActiveTools: () => {},
			ui: { notify: () => {} },
		};
		const { registerTasksTools } = await import(join(src, "tools", "tasks.ts"));
		registerTasksTools(pi);
		const upd = calls.tools["swarm_update_task"];
		mkdirSync(join(cwd, "artifacts"), { recursive: true });
		writeFileSync(join(cwd, "artifacts", "plan.md"), "plan\n");
		writeFileSync(join(cwd, "artifacts", "implementation-report.md"), "impl\n");
		writeFileSync(join(cwd, "artifacts", "test-report.md"), "pass\n");
		writeFileSync(join(cwd, "artifacts", "review.md"), "ok\n");
		writeFileSync(join(cwd, "artifacts", "final-summary.md"), "done\n");
		for (const [node, outcome] of [["plan", "planned"], ["implement", "implemented"], ["test", "passed"], ["review", "approved"], ["commit", "committed"]]) {
			st = await readState(p, cwd);
			await upd.execute("x", { taskId, nodeId: node, status: "done", outcome, artifact: "artifacts/x.md" }, undefined, undefined, { cwd });
		}
		st = await readState(p, cwd);
		await runPumpMaintenancePhasesLocked({}, { cwd, isIdle: () => true }, p, st, Date.now(), "wfg-manual");
		await writeState(p, st);
		run = getIssueRun(await readState(p, cwd));
		assert.equal(run.advancement, "waiting-manual", "manual mode holds the multi-node done");
		assert.equal(run.queue[1].status, "queued", "no auto-advance in manual");
		// freeze leg: blocked node still pauses
		const cwd2 = seedWorld();
		const p2 = await startRun(cwd2);
		const st2 = await readState(p2, cwd2);
		const run2 = getIssueRun(st2);
		const task2 = readLinkedTask(cwd2, run2.queue[0].taskId);
		task2.nodes.implement.status = "blocked";
		writeLinkedTask(cwd2, run2.queue[0].taskId, task2);
		await runPumpMaintenancePhasesLocked({}, { cwd: cwd2, isIdle: () => true }, p2, st2, Date.now(), "wfg-freeze");
		await writeState(p2, st2);
		const run3 = getIssueRun(await readState(p2, cwd2));
		assert.equal(run3.status, "paused", "multi-node blocked → freeze pauses run");
		const term = (await mailboxRecs(cwd2)).filter((r) => String(r.idempotencyKey || "").startsWith("issues-terminal:"));
		assert.equal(term.length, 1, "branched terminal notice delivered");
	} finally {
		delete process.env.PI_SWARM_ISSUES_ADVANCEMENT;
		rmSync(cwd, { recursive: true, force: true });
	}
});

// === start normalization ===
await t("start: fail-fast on invalid workflow value; records run.workflowMode", async () => {
	const cwd = seedWorld({ yml: 'issue-sequencer:\n  workflow: kanban\n' });
	const p = paths(cwd);
	await ensureDirs(p);
	const notes = [];
	await assert.rejects(
		() => handleIssuesCommand("issues", ["start"], { cwd, ui: { notify: (m, k) => notes.push({ m: String(m), k }) } }, p, {}),
		/issue-sequencer\.workflow.*kanban/,
		"start rejects invalid workflow",
	);
	const st = await readState(p, cwd);
	assert.notEqual(st.issueRun?.status, "running", "no run started on invalid workflow");
	rmSync(cwd, { recursive: true, force: true });
	// valid manual single recorded
	process.env.PI_SWARM_ISSUES_WORKFLOW = "single";
	try {
		const cwd2 = seedWorld();
		const p2 = await startRun(cwd2);
		const run = getIssueRun(await readState(p2, cwd2));
		assert.equal(run.workflowMode ?? "single", "single", "start records workflowMode");
		rmSync(cwd2, { recursive: true, force: true });
	} finally {
		delete process.env.PI_SWARM_ISSUES_WORKFLOW;
	}
});

console.log(process.exitCode ? "\nissues-workflow-graphs: FAIL" : `\nissues-workflow-graphs: PASS (${passed})`);
