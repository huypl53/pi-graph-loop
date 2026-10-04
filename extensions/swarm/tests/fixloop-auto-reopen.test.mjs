#!/usr/bin/env node
/**
 * fixloop-auto-reopen — task-fu-fixloop-auto (incident task-redteam-fixnow 2026-10-04)
 *
 * Reproduces the fix-loop stall: when the test node closes done/failed (test→fix rework edge
 * fires, fix becomes ready) and the fix node later closes done/outcome="fixed", the back-edge
 * { from: "fix", to: "test", when: "implemented", rework: true } never fires because
 * edgeMatchesActivation compares outcome literally ("fixed" !== "implemented"). The test node
 * stays done, review stays blocked on when:"passed", and the graph stalls with zero actionable
 * nodes (root had to hand-edit task.json).
 *
 * Fix under test: outcome equivalence set {implemented, fixed} in edgeMatchesActivation
 * (extensions/swarm/src/taskgraph/graph.ts). Default graph edges stay byte-unchanged.
 *
 * Scenarios:
 *   S1  THE REPRODUCTION (RED pre-change): fix done/fixed → test reopens to ready
 *   S1b control (GREEN pre+post): fix done/implemented → test reopens (existing machinery)
 *   S2  control (GREEN pre+post): root hand-reset test to ready first → no double transition,
 *       rework ledger not burned (target_not_reopenable suppression)
 *   S3  control (GREEN pre+post): fix done/unknown-outcome → no reopen
 *   S4  second cycle (RED pre, GREEN post): reopen fires again per cycle, ledger grows with
 *       distinct sourceAttemptIds (no one-shot starvation)
 *   S5  trace + boundary (RED pre, GREEN post): exactly one task.attempt.reopened_by_rework
 *       trace per cycle with sourceNodeId="fix", read from global events.jsonl (R10-1: observed
 *       at the real swarm_update_task tool boundary, not an internal helper)
 *   S6  maxAttempts bound (GREEN pre+post): reopen still flips test ready at the attempt cap,
 *       but reassign is refused with INVALID_TRANSITION/maxAttempts — visible dead-end, not a
 *       silent stall
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), `swarm-fixloop-auto-${process.pid}-${Date.now()}`));
const originalCwd = process.cwd();
process.chdir(scratch);
process.env.PI_SWARM_MINIMAL_PROTOCOL = "0";
await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
await writeFile(
	join(scratch, ".pi/settings.json"),
	JSON.stringify({ swarm: { defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" } }),
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0,
	fail = 0;
const ok = (name, cond, detail) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, detail ? `(${detail})` : "");
	}
};
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const readTask = async (taskId) => readJson(join(scratch, `.pi/swarm/tasks/${taskId}/task.json`));
const readGlobalEvents = async () => {
	const p = join(scratch, ".pi/swarm/traces/events.jsonl");
	const raw = await readFile(p, "utf8").catch(() => "");
	return raw
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
};

async function loadExtension({ agentId, isRoot = false } = {}) {
	if (agentId) process.env.PI_SWARM_AGENT_ID = agentId;
	else delete process.env.PI_SWARM_AGENT_ID;
	if (isRoot) process.env.PI_SWARM_IS_ROOT = "1";
	else delete process.env.PI_SWARM_IS_ROOT;
	const tools = {};
	const handlers = {};
	const activeTools = new Set();
	const pi = {
		registerTool: (def) => {
			tools[def.name] = def;
			activeTools.add(def.name);
		},
		registerCommand: () => {},
		on: (ev, fn) => {
			(handlers[ev] ||= []).push(fn);
		},
		exec: async (cmd, args) => {
			if (cmd === "tmux" && args?.[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
			return { code: 1, stdout: "", stderr: "" };
		},
		setModel: async () => true,
		sendMessage: () => {},
		getAllTools: () => Object.values(tools).map((t) => ({ name: t.name })),
		getActiveTools: () => Array.from(activeTools),
		setActiveTools: (names) => {
			activeTools.clear();
			for (const n of names) activeTools.add(n);
		},
	};
	const mod = await import(join(here, "..", "index.ts"));
	mod.default(pi);
	for (const fn of handlers.session_start || []) {
		await fn({}, { cwd: scratch, mode: "tui", hasUI: false, ui: { setStatus: () => {}, notify: () => {} } });
	}
	return { tools };
}

const call = async (tools, name, params) => {
	if (!tools[name]) throw new Error("no tool " + name);
	return tools[name].execute("call", params, undefined, undefined, { cwd: scratch });
};

async function updateAs(tools, agentId, isRoot, params) {
	const prevId = process.env.PI_SWARM_AGENT_ID;
	const prevOrch = process.env.PI_SWARM_IS_ROOT;
	process.env.PI_SWARM_AGENT_ID = agentId;
	if (isRoot) process.env.PI_SWARM_IS_ROOT = "1";
	else delete process.env.PI_SWARM_IS_ROOT;
	try {
		return await call(tools, "swarm_update_task", { ...params, cwd: scratch });
	} finally {
		if (prevId === undefined) delete process.env.PI_SWARM_AGENT_ID;
		else process.env.PI_SWARM_AGENT_ID = prevId;
		if (prevOrch === undefined) delete process.env.PI_SWARM_IS_ROOT;
		else process.env.PI_SWARM_IS_ROOT = prevOrch;
	}
}

const seedAgent = (id, role, roleKind) => ({
	id,
	role,
	roleKind,
	roleKindExplicit: true,
	capabilities: [],
	activeTaskIds: [],
	maxConcurrentTasks: roleKind === "root" ? 99 : 1,
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
});

async function freshSetup({ taskId }) {
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
	const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");
	const seedState = {
		version: 1,
		swarmId: "fixloop-swarm",
		tmuxSession: "fixloop-swarm",
		rootId: "root",
		agents: {
			root: seedAgent("root", "PM", "root"),
			"planner-f": seedAgent("planner-f", "planner", "planner"),
			"implementer-f": seedAgent("implementer-f", "implementer", "implementer"),
			"tester-f": seedAgent("tester-f", "tester", "tester"),
			"reviewer-f": seedAgent("reviewer-f", "reviewer", "reviewer"),
		},
		delivered: {},
		messages: {},
	};
	await writeFile(statePath, JSON.stringify(seedState, null, 2) + "\n");
	const { tools } = await loadExtension({ agentId: "root", isRoot: true });
	await call(tools, "swarm_create_task", {
		taskId,
		title: `fixloop auto-reopen ${taskId}`,
		goal: "auto-reopen test node after fix closes",
		priority: "normal",
		cwd: scratch,
	});
	return tools;
}

// Drive the shared prefix: plan → implement → test done/failed (fix auto-readies).
async function driveToTestFailed(tools, taskId) {
	const assign = async (nodeId, agentId) => {
		await call(tools, "swarm_assign_task", { taskId, nodeId, agentId, cwd: scratch });
		return (await readTask(taskId)).nodes[nodeId].activeAttemptId;
	};
	let attempt = await assign("plan", "planner-f");
	await updateAs(tools, "planner-f", false, { taskId, nodeId: "plan", status: "done", outcome: "planned", attemptId: attempt });
	attempt = await assign("implement", "implementer-f");
	await updateAs(tools, "implementer-f", false, { taskId, nodeId: "implement", status: "done", outcome: "implemented", attemptId: attempt });
	attempt = await assign("test", "tester-f");
	await updateAs(tools, "tester-f", false, { taskId, nodeId: "test", status: "done", outcome: "failed", attemptId: attempt });
	const task = await readTask(taskId);
	ok(`${taskId}: test done/failed auto-readies fix (pre-existing rework edge)`, task.nodes.fix.status === "ready", `fix=${task.nodes.fix.status}`);
	return task;
}

async function closeFix(tools, taskId, outcome) {
	await call(tools, "swarm_assign_task", { taskId, nodeId: "fix", agentId: "implementer-f", cwd: scratch });
	const attempt = (await readTask(taskId)).nodes.fix.activeAttemptId;
	await updateAs(tools, "implementer-f", false, { taskId, nodeId: "fix", status: "done", outcome, attemptId: attempt });
	await sleep(25);
}

// ============================================================
// S1 — THE REPRODUCTION: fix done/"fixed" must reopen test to ready
// ============================================================
{
	console.log("\n--- S1: fix done/fixed reopens test (RED pre-change) ---");
	const taskId = "task-fixloop-s1";
	const tools = await freshSetup({ taskId });
	await driveToTestFailed(tools, taskId);
	await closeFix(tools, taskId, "fixed");
	const task = await readTask(taskId);
	ok("S1: test reopens to ready after fix done/fixed", task.nodes.test.status === "ready", `test=${task.nodes.test.status}`);
	ok("S1: reopened test outcome nulled", task.nodes.test.outcome === null, `outcome=${task.nodes.test.outcome}`);
	ok("S1: reopened test assignee cleared", task.nodes.test.assignee === undefined);
	ok("S1: reopened test activeAttemptId cleared", task.nodes.test.activeAttemptId === undefined);
	ok("S1: task.currentNodes includes test", (task.currentNodes || []).includes("test"), `current=${JSON.stringify(task.currentNodes)}`);
	ok("S1: review still pending (blocked on when=passed)", task.nodes.review.status === "pending", `review=${task.nodes.review.status}`);
}

// ============================================================
// S1b — control: fix done/"implemented" reopens test (existing machinery)
// ============================================================
{
	console.log("\n--- S1b control: fix done/implemented reopens test ---");
	const taskId = "task-fixloop-s1b";
	const tools = await freshSetup({ taskId });
	await driveToTestFailed(tools, taskId);
	await closeFix(tools, taskId, "implemented");
	const task = await readTask(taskId);
	ok("S1b: test reopens to ready after fix done/implemented", task.nodes.test.status === "ready", `test=${task.nodes.test.status}`);
}

// ============================================================
// S2 — control: root hand-reset test to ready BEFORE fix closes → no double transition
// ============================================================
{
	console.log("\n--- S2 control: manual root reset suppresses reopen, ledger intact ---");
	const taskId = "task-fixloop-s2";
	const tools = await freshSetup({ taskId });
	await driveToTestFailed(tools, taskId);
	await updateAs(tools, "root", true, { taskId, nodeId: "test", status: "ready", force: true });
	const before = await readTask(taskId);
	const ledgerBefore = (before.reworkConsumption || []).length;
	await closeFix(tools, taskId, "fixed");
	const task = await readTask(taskId);
	ok("S2: hand-reset test stays ready (no double transition)", task.nodes.test.status === "ready", `test=${task.nodes.test.status}`);
	ok("S2: rework ledger not burned", (task.reworkConsumption || []).length === ledgerBefore, `ledger ${ledgerBefore}→${(task.reworkConsumption || []).length}`);
	const reopenTraces = (await readGlobalEvents()).filter(
		(e) => e.event === "task.attempt.reopened_by_rework" && e.nodeId === "test",
	);
	ok("S2: no reopen trace emitted", reopenTraces.length === 0, `traces=${reopenTraces.length}`);
}

// ============================================================
// S3 — control: fix done with unknown outcome does not reopen test
// ============================================================
{
	console.log("\n--- S3 control: unknown outcome → no reopen ---");
	const taskId = "task-fixloop-s3";
	const tools = await freshSetup({ taskId });
	await driveToTestFailed(tools, taskId);
	await closeFix(tools, taskId, "shipped");
	const task = await readTask(taskId);
	ok("S3: test stays done after fix done/unknown-outcome", task.nodes.test.status === "done", `test=${task.nodes.test.status}`);
	ok("S3: no reopen trace", (await readGlobalEvents()).filter((e) => e.event === "task.attempt.reopened_by_rework" && e.nodeId === "test").length === 0);
}

// ============================================================
// S4 — second cycle: reopen fires again, ledger +1 per cycle with distinct sourceAttemptIds
// ============================================================
{
	console.log("\n--- S4: second cycle reopens again (RED pre-change) ---");
	const taskId = "task-fixloop-s4";
	const tools = await freshSetup({ taskId });
	await driveToTestFailed(tools, taskId);
	await closeFix(tools, taskId, "fixed");
	let task = await readTask(taskId);
	ok("S4 cycle1: test reopened", task.nodes.test.status === "ready", `test=${task.nodes.test.status}`);
	const ledgerAfterCycle1 = (task.reworkConsumption || []).length;
	ok("S4 cycle1: ledger consumed one fix→test entry", ledgerAfterCycle1 >= 1, `ledger=${ledgerAfterCycle1}`);
	if (task.nodes.test.status !== "ready") {
		ok("S4 cycle2: fresh test attempt minted", false, "pre-change stall: test stuck done, cycle 2 unreachable");
		ok("S4 cycle2: fix re-readies after second failed test", false, "unreachable pre-change");
		ok("S4 cycle2: test reopens again (no one-shot starvation)", false, "unreachable pre-change");
		ok("S4 cycle2: ledger +1 per cycle for fix→test", false, "unreachable pre-change");
		ok("S4 cycle2: distinct sourceAttemptIds per cycle", false, "unreachable pre-change");
	} else {
	// Cycle 2: test fails again on a fresh attempt → fix re-readies → fix closes fixed again.
	await call(tools, "swarm_assign_task", { taskId, nodeId: "test", agentId: "tester-f", cwd: scratch });
	const testAttempt2 = (await readTask(taskId)).nodes.test.activeAttemptId;
	ok("S4 cycle2: fresh test attempt minted", Boolean(testAttempt2));
	await updateAs(tools, "tester-f", false, { taskId, nodeId: "test", status: "done", outcome: "failed", attemptId: testAttempt2 });
	task = await readTask(taskId);
	ok("S4 cycle2: fix re-readies after second failed test", task.nodes.fix.status === "ready", `fix=${task.nodes.fix.status}`);
	await closeFix(tools, taskId, "fixed");
	task = await readTask(taskId);
	ok("S4 cycle2: test reopens again (no one-shot starvation)", task.nodes.test.status === "ready", `test=${task.nodes.test.status}`);
	const fixTestEntries = (task.reworkConsumption || []).filter((r) => r.reopenedNodeId === "test");
	ok("S4 cycle2: ledger +1 per cycle for fix→test", fixTestEntries.length === 2, `entries=${fixTestEntries.length}`);
	ok(
		"S4 cycle2: distinct sourceAttemptIds per cycle",
		fixTestEntries.length === 2 && fixTestEntries[0].sourceAttemptId !== fixTestEntries[1].sourceAttemptId,
	);
	}
}

// ============================================================
// S5 — trace + boundary: exactly one reopened_by_rework trace per cycle, sourceNodeId=fix
// ============================================================
{
	console.log("\n--- S5: reopen trace at the real tool boundary (RED pre-change) ---");
	const taskId = "task-fixloop-s5";
	const tools = await freshSetup({ taskId });
	await driveToTestFailed(tools, taskId);
	await closeFix(tools, taskId, "fixed");
	let traces = (await readGlobalEvents()).filter(
		(e) => e.event === "task.attempt.reopened_by_rework" && e.nodeId === "test" && e.sourceNodeId === "fix",
	);
	ok("S5: exactly one reopen trace after cycle 1", traces.length === 1, `traces=${traces.length}`);
	if ((await readTask(taskId)).nodes.test.status === "ready") {
		await call(tools, "swarm_assign_task", { taskId, nodeId: "test", agentId: "tester-f", cwd: scratch });
		const testAttempt2 = (await readTask(taskId)).nodes.test.activeAttemptId;
		await updateAs(tools, "tester-f", false, { taskId, nodeId: "test", status: "done", outcome: "failed", attemptId: testAttempt2 });
		await closeFix(tools, taskId, "fixed");
	} else {
		ok("S5: exactly two reopen traces after cycle 2", false, "pre-change stall: test stuck done, cycle 2 unreachable");
		traces = [];
	}
	traces = (await readGlobalEvents()).filter(
		(e) => e.event === "task.attempt.reopened_by_rework" && e.nodeId === "test" && e.sourceNodeId === "fix",
	);
	if ((await readTask(taskId)).nodes.test.status === "ready") {
		ok("S5: exactly two reopen traces after cycle 2", traces.length === 2, `traces=${traces.length}`);
	}
}

// ============================================================
// S6 — maxAttempts bound: reopen still flips test ready at the cap, but reassign is refused
// ============================================================
{
	console.log("\n--- S6: maxAttempts bounded stop ---");
	const taskId = "task-fixloop-s6";
	const tools = await freshSetup({ taskId });
	await driveToTestFailed(tools, taskId);
	// Drive test attempts to the cap (test maxAttempts = 3 in the default graph).
	let task = await readTask(taskId);
	// test maxAttempts = 3 in the default graph; attempts increment on assign. Drive
	// reopen→assign→failed cycles until the cap refuses reassign (or the loop stalls).
	for (let i = 0; i < 6; i++) {
		if (task.nodes.fix.status === "ready") {
			await closeFix(tools, taskId, "fixed");
			task = await readTask(taskId);
		}
		if (task.nodes.test.status !== "ready") break;
		let refused = null;
		try {
			await call(tools, "swarm_assign_task", { taskId, nodeId: "test", agentId: "tester-f", cwd: scratch });
		} catch (err) {
			refused = err;
		}
		if (refused) break;
		const attempt = (await readTask(taskId)).nodes.test.activeAttemptId;
		await updateAs(tools, "tester-f", false, { taskId, nodeId: "test", status: "done", outcome: "failed", attemptId: attempt });
		task = await readTask(taskId);
	}
	ok("S6: test at maxAttempts", task.nodes.test.attempts >= 3, `attempts=${task.nodes.test.attempts}`);
	// Reopen (if the fix close fired) still flips test ready…
	if (task.nodes.test.status === "done") {
		// fix may not be ready (edge consumed) — force the cycle one more time via a fix close.
		await closeFix(tools, taskId, "fixed");
		task = await readTask(taskId);
	}
	ok("S6: reopen still flips test to ready at the cap", task.nodes.test.status === "ready", `test=${task.nodes.test.status}`);
	// …but reassign is refused with INVALID_TRANSITION / maxAttempts.
	let refused = null;
	try {
		await call(tools, "swarm_assign_task", { taskId, nodeId: "test", agentId: "tester-f", cwd: scratch });
	} catch (err) {
		refused = err;
	}
	ok("S6: reassign refused at cap", Boolean(refused) && refused.errorCode === "INVALID_TRANSITION", `err=${refused?.errorCode || refused?.message || "none"}`);
	ok("S6: refusal mentions maxAttempts", Boolean(refused && /maxAttempts/i.test(refused.message || "")), refused?.message);
}

const globalEvents = await readGlobalEvents();
ok("global trace file readable", Array.isArray(globalEvents));

process.chdir(originalCwd);
console.log(`\nfixloop-auto-reopen: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
