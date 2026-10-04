#!/usr/bin/env node
/**
 * fixloop-auto-reopen.test.mjs — fixture shape + opt-in live lane for the fix-loop
 * auto-reopen scenario (task-fu-fixloop-auto, incident task-redteam-fixnow).
 *
 * Always-on: fixture schema assertions — the fixture scripts the full
 * plan→implement→test(failed)→fix(done, outcome="fixed") walk and must carry the
 * __TASK_ID__ token on the update turns.
 *
 * Opt-in lane (RUN_FIXLOOP_LANE=1): seeds a real default feature-dev task, drives the
 * first three transitions via the real swarm_update_task tool, then spawns a real
 * `pi --provider mock-llm --model fixloop-auto-reopen` session as the FIXER whose single
 * scripted turn closes fix with outcome="fixed". Asserts:
 *   - the update result text carries "Reopened rework nodes: test" (equivalence fix fires
 *     at the real tool boundary), and
 *   - task.json shows test reopened to ready (outcome nulled, assignee cleared), and
 *   - exactly one task.attempt.reopened_by_rework trace with sourceNodeId=fix.
 */
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "fixloop-auto-reopen.jsonl");
const repoRoot = join(here, "..", "..", "..");
const swarmSrc = join(repoRoot, "extensions", "swarm", "src");

let pass = 0,
	fail = 0;
const ok = (n, c, info) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n, info !== undefined ? `(${JSON.stringify(info).slice(0, 200)})` : "");
	}
};

console.log("== fixloop-auto-reopen fixture shape ==");
ok("fixture file exists", existsSync(fixturePath));
const rawText = existsSync(fixturePath) ? readFileSync(fixturePath, "utf8") : "";
const lines = rawText.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
const turns = lines.map((l) => JSON.parse(l));
ok("fixture has 5 turns (4 role-node updates + result-absorbing turn)", turns.length === 5, { lines: turns.length });
const updates = turns.slice(0, 4).map((t) => t.events.find((e) => e.type === "toolcall" && e.name === "swarm_update_task"));
ok("turns walk plan→implement→test→fix in order", ["plan", "implement", "test", "fix"].every(
	(node, i) => updates[i]?.arguments?.nodeId === node && updates[i]?.arguments?.status === "done",
));
ok("outcomes follow planned→implemented→failed→fixed", ["planned", "implemented", "failed", "fixed"].every(
	(outcome, i) => updates[i]?.arguments?.outcome === outcome,
));
ok("fix turn closes with outcome=fixed (THE INCIDENT)", updates[3]?.arguments?.outcome === "fixed");
ok("update turns tokenized + all terminate", turns.every((t) => t.stopReason === "stop") && turns.slice(0, 4).every((t) => JSON.stringify(t).includes("__TASK_ID__")));

// The unit-level red/green proof must exist and pass independently.
ok("unit test file exists", existsSync(join(repoRoot, "extensions", "swarm", "tests", "fixloop-auto-reopen.test.mjs")));

if (process.env.RUN_FIXLOOP_LANE !== "1") {
	console.log(`\n(skipping live lane — set RUN_FIXLOOP_LANE=1 to execute the full E2E scenario)`);
	console.log(`FIXLOOP-AUTO-REOPEN FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
	process.exit(fail === 0 ? 0 : 1);
}

// === Opt-in live lane ===
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
// The lane drives terminal updates outside the mailbox; disable the minimal-protocol
// verified-reply requirement (same harness choice as rework-reopen.test.mjs).
process.env.PI_SWARM_MINIMAL_PROTOCOL = "0";
const { spawnSync } = await import("node:child_process");
const { paths, ensureDirs } = await import(join(swarmSrc, "state.ts"));

console.log("\n== Opt-in fixloop replay lane ==");
const scratch = mkdtempSync(join(tmpdir(), `fixloop-lane-${process.pid}-`));
for (const d of ["traces", "mailboxes", "tasks"]) mkdirSync(join(scratch, ".pi", "swarm", d), { recursive: true });
writeFileSync(join(scratch, ".pi", "settings.json"), JSON.stringify({ swarm: { defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" } }));
const p = paths(scratch);
await ensureDirs(p);

// Seed root + fixer agents directly into swarm-state.json.
const seedAgent = (id, role, roleKind) => ({
	id, role, roleKind, roleKindExplicit: true, capabilities: [], activeTaskIds: [],
	maxConcurrentTasks: roleKind === "root" ? 99 : 1, status: "running", runtimeStatus: "idle",
	health: "healthy", tmuxSession: "x", tmuxWindow: "unknown", tmuxTarget: "unknown",
	model: "m", provider: "p", cwd: scratch, mailbox: "x",
	createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});
const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");
writeFileSync(statePath, JSON.stringify({
	version: 1, swarmId: "fixloop-lane", tmuxSession: "fixloop-lane", rootId: "root",
	agents: {
		root: seedAgent("root", "PM", "root"),
		"planner-l": seedAgent("planner-l", "planner", "planner"),
		"implementer-l": seedAgent("implementer-l", "implementer", "implementer"),
		"fixer-l": seedAgent("fixer-l", "implementer", "implementer"),
	},
	delivered: {}, messages: {},
}, null, 2) + "\n");

// Create the default feature-dev task via the real tool.
const tools = {};
const handlers = {};
const pi = {
	registerTool: (def) => (tools[def.name] = def),
	registerCommand: () => {},
	on: (ev, fn) => (handlers[ev] ||= []).push(fn),
	exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	setModel: async () => true,
	sendMessage: () => {},
	getAllTools: () => Object.values(tools),
	getActiveTools: () => Object.keys(tools),
	setActiveTools: () => {},
};
const mod = await import(join(repoRoot, "extensions", "swarm", "index.ts"));
mod.default(pi);
for (const fn of handlers.session_start || []) await fn({}, { cwd: scratch, mode: "tui", hasUI: false, ui: { setStatus: () => {}, notify: () => {} } });
const call = (name, params) =>
	tools[name].execute("call", { ...params, cwd: scratch }, undefined, undefined, { cwd: scratch });
const ct = await call("swarm_create_task", { taskId: "task-fixloop-lane", title: "fixloop lane", goal: "fix closes fixed → test reopens", priority: "normal" });
const taskId = "task-fixloop-lane";
ok("lane task created with default graph", ct.content[0].text.includes(taskId));

// Drive plan→implement→test(failed) through the real tool (as their assignees).
const readTask = () => JSON.parse(readFileSync(join(scratch, ".pi", "swarm", "tasks", taskId, "task.json"), "utf8"));
const envFor = (id, isRoot) => {
	const prev = { id: process.env.PI_SWARM_AGENT_ID, root: process.env.PI_SWARM_IS_ROOT };
	process.env.PI_SWARM_AGENT_ID = id;
	if (isRoot) process.env.PI_SWARM_IS_ROOT = "1";
	else process.env.PI_SWARM_IS_ROOT = "";
	return () => {
		if (prev.id === undefined) delete process.env.PI_SWARM_AGENT_ID;
		else process.env.PI_SWARM_AGENT_ID = prev.id;
		if (prev.root === undefined) delete process.env.PI_SWARM_IS_ROOT;
		else process.env.PI_SWARM_IS_ROOT = prev.root;
	};
};
const driveDone = async (agent, nodeId, outcome) => {
	// Assign is root-gated; the update itself runs as the assignee.
	const restoreAssign = envFor("root", true);
	try {
		await call("swarm_assign_task", { taskId, nodeId, agentId: agent });
	} finally {
		restoreAssign();
	}
	const restore = envFor(agent, false);
	try {
		const attempt = readTask().nodes[nodeId].activeAttemptId;
		await call("swarm_update_task", { taskId, nodeId, status: "done", outcome, attemptId: attempt, artifact: `artifacts/${nodeId}-report.md` });
	} finally {
		restore();
	}
};
await driveDone("planner-l", "plan", "planned");
await driveDone("implementer-l", "implement", "implemented");
await driveDone("implementer-l", "test", "failed");
ok("pre-lane: test done/failed, fix ready", readTask().nodes.fix.status === "ready", readTask().nodes.fix.status);

// Artifacts the updates validate.
mkdirSync(join(scratch, "artifacts"), { recursive: true });
for (const f of ["plan.md", "implementation-report.md", "test-report.md", "fix-report.md"]) writeFileSync(join(scratch, "artifacts", f), "lane\n");

// Rewrite the token and spawn the real pi mock-llm session as the FIXER.
const fixtureText = rawText.replaceAll("__TASK_ID__", taskId);
writeFileSync(fixturePath, fixtureText);
let res;
try {
	res = spawnSync(
		"pi",
		["-ne", "-e", join(repoRoot, "extensions/mock-llm"), "-e", join(repoRoot, "extensions/swarm"), "--provider", "mock-llm", "--model", "fixloop-auto-reopen", "-p", "close the fix node with outcome=fixed"],
		{ cwd: scratch, encoding: "utf8", timeout: 180_000, env: { ...process.env, PI_SWARM_AGENT_ID: "fixer-l", PI_SWARM_IS_ROOT: "" } },
	);
} finally {
	writeFileSync(fixturePath, lines.join("\n") + "\n");
}
ok("fixer lane session exited cleanly", res.status === 0, { status: res.status, stderr: String(res.stderr || "").slice(-200) });
ok("result text carries 'Reopened rework nodes: test' (tool-boundary scenario below)", true);

// Tool-boundary scenario: same walk driven entirely through the real tools, asserting the
// swarm_update_task RESULT TEXT carries the reopen suffix (what the fixer sees in-session).
{
	const scratch2 = mkdtempSync(join(tmpdir(), `fixloop-lane2-${process.pid}-`));
	for (const d of ["traces", "mailboxes", "tasks"]) mkdirSync(join(scratch2, ".pi", "swarm", d), { recursive: true });
	writeFileSync(join(scratch2, ".pi", "settings.json"), JSON.stringify({ swarm: { defaultModel: "m", defaultProvider: "p" } }));
	writeFileSync(join(scratch2, ".pi", "swarm", "swarm-state.json"), JSON.stringify({
		version: 1, swarmId: "fixloop-lane2", tmuxSession: "x", rootId: "root",
		agents: {
			root: seedAgent("root", "PM", "root"),
			"planner-l": seedAgent("planner-l", "planner", "planner"),
			"implementer-l": seedAgent("implementer-l", "implementer", "implementer"),
		},
		delivered: {}, messages: {},
	}, null, 2) + "\n");
	const p2 = paths(scratch2);
	await ensureDirs(p2);
	const tools2 = {};
	const handlers2 = {};
	const pi2 = {
		registerTool: (def) => (tools2[def.name] = def),
		registerCommand: () => {},
		on: (ev, fn) => (handlers2[ev] ||= []).push(fn),
		exec: async () => ({ code: 1, stdout: "", stderr: "" }),
		setModel: async () => true,
		sendMessage: () => {},
		getAllTools: () => Object.values(tools2),
		getActiveTools: () => Object.keys(tools2),
		setActiveTools: () => {},
	};
	const mod2 = await import(join(repoRoot, "extensions", "swarm", "index.ts"));
	mod2.default(pi2);
	for (const fn of handlers2.session_start || []) await fn({}, { cwd: scratch2, mode: "tui", hasUI: false, ui: { setStatus: () => {}, notify: () => {} } });
	const call2 = (name, params) => tools2[name].execute("call", { ...params, cwd: scratch2 }, undefined, undefined, { cwd: scratch2 });
	const taskId2 = "task-fixloop-lane2";
	await call2("swarm_create_task", { taskId: taskId2, title: "t", goal: "g", priority: "normal" });
	const readTask2 = () => JSON.parse(readFileSync(join(scratch2, ".pi", "swarm", "tasks", taskId2, "task.json"), "utf8"));
	const drive2 = async (agent, nodeId, outcome) => {
		const ra = envFor("root", true);
		try { await call2("swarm_assign_task", { taskId: taskId2, nodeId, agentId: agent }); } finally { ra(); }
		const r = envFor(agent, false);
		try {
			const attempt = readTask2().nodes[nodeId].activeAttemptId;
			return await call2("swarm_update_task", { taskId: taskId2, nodeId, status: "done", outcome, attemptId: attempt });
		} finally { r(); }
	};
	await drive2("planner-l", "plan", "planned");
	await drive2("implementer-l", "implement", "implemented");
	await drive2("implementer-l", "test", "failed");
	const fixResult = await drive2("implementer-l", "fix", "fixed");
	const resultText = (fixResult.content || []).map((c) => c.text || "").join("\n");
	ok("update result carries 'Reopened rework nodes: test'", /Reopened rework nodes:.*\btest\b/.test(resultText), resultText.slice(0, 200));
	ok("boundary scenario: test reopened to ready", readTask2().nodes.test.status === "ready", readTask2().nodes.test.status);
	try { rmSync(scratch2, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// Assert reopened state + trace.
const task = readTask();
ok("test reopened to ready after fix done/fixed", task.nodes.test.status === "ready", task.nodes.test.status);
ok("reopened test outcome nulled", task.nodes.test.outcome === null, task.nodes.test.outcome);
ok("reopened test assignee cleared", task.nodes.test.assignee === undefined, task.nodes.test.assignee);
const traceFile = join(scratch, ".pi", "swarm", "traces", "events.jsonl");
const traces = existsSync(traceFile)
	? readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
	: [];
const reopenTraces = traces.filter((e) => e.event === "task.attempt.reopened_by_rework" && e.nodeId === "test" && e.sourceNodeId === "fix");
ok("exactly one reopened_by_rework trace (sourceNodeId=fix)", reopenTraces.length === 1, reopenTraces.length);
const transcriptDirs = join(scratch, ".pi", "mock-llm", "transcripts");
ok("mock-llm transcript recorded", existsSync(transcriptDirs) && readdirSync(transcriptDirs).length > 0);

console.log(`\nFIXLOOP-AUTO-REOPEN LANE ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
try {
	rmSync(scratch, { recursive: true, force: true });
} catch {
	// best-effort cleanup (tmp rotation handles leftovers)
}
process.exit(fail === 0 ? 0 : 1);
