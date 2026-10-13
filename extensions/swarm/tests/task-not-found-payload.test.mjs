#!/usr/bin/env node
/**
 * task-not-found-payload.test.mjs — RED-first for plan
 * docs/swarm/plans/2026-10-13-worker-task-closure-gaps.md §1.1 (Stage A).
 *
 * Incident (worker p9-prompt-assembly-fix, 2026-10-13): a finishing worker called
 * swarm_update_task with a guessed taskId and got bare `Task not found: <id>` — the only
 * swarm_update_task failure site that bypasses failTaskTool, so no errorCode, no valid task
 * ids, no guidance. The worker improvised (ls .pi/swarm/tasks) and went idle.
 *
 * Contract under test (pre-fix: all RED; post-fix: GREEN):
 *   - swarm_update_task with a nonexistent taskId throws with:
 *       errorCode === "TASK_NOT_FOUND"
 *       expected.validTaskIds  — sorted existing task ids from the real tasks dir (capped 20)
 *       expected.myActiveTaskIds — the caller agent's activeTaskIds (workers: from state)
 *       actionableHint — non-empty, mentions swarm_send_message when caller has no tasks
 *       (message-only guidance) and names swarm_task_status otherwise
 *   - expected.suggestedNextCall = { tool: "swarm_task_status", params:{taskId:"(run swarm_task_status)"} }
 *     when valid tasks exist; absent when none do (hint carries the guidance).
 *   - swarm_assign_task with a nonexistent taskId throws the same structured shape
 *     (agent-facing surface parity).
 *   - root callers get the same structured payload (hint may differ, still structured).
 *   - NO state mutation on failure: no task dir created, no mailbox records, no
 *     activeTaskIds change.
 *   - Static hygiene: the TASK_NOT_FOUND text never contains a raw filesystem path
 *     (de-path rule) and the throw passes through failTaskTool (err.errorCode set, body JSON
 *     carries ok:false).
 */
import { rmSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-task-not-found-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

process.env.PI_SWARM_AGENT_ID = "root";
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

const tools = {};
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	exec: async (cmd, args) => {
		if (cmd === "tmux" && args[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
		if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	},
	sendMessage: () => {},
};
factory(pi);

let pass = 0,
	fail = 0;
const ok = (n, c, info) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n, info ?? "");
	}
};

const call = async (name, params) => {
	const t = tools[name];
	if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: scratch });
};
const as = (agentId, fn) => {
	const prev = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = agentId;
	try {
		return fn();
	} finally {
		process.env.PI_SWARM_AGENT_ID = prev;
	}
};
const awaitAs = async (agentId, name, params) => {
	const prev = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = agentId;
	try {
		return await call(name, params);
	} finally {
		process.env.PI_SWARM_AGENT_ID = prev;
	}
};
const expectErrorCode = async (agentId, name, params, code) => {
	try {
		await awaitAs(agentId, name, params);
		ok(`expect ${code}`, false, "no throw");
		return null;
	} catch (err) {
		ok(`rejects with ${code} (got ${err.errorCode})`, err.errorCode === code);
		return err;
	}
};

async function ensureWorker(agentId, roleKind) {
	mkdirSync(join(scratch, ".pi", "swarm"), { recursive: true });
	const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");
	const seedAgent = (id, kind) => ({
		id,
		role: `test ${kind}`,
		roleKind: kind,
		roleKindExplicit: true,
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: kind === "root" ? 99 : 1,
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
	const st = existsSync(statePath)
		? JSON.parse(readFileSync(statePath, "utf8"))
		: { swarmId: "task-not-found-test", tmuxSession: "x", rootId: "root", agents: {}, delivered: {}, messages: {} };
	st.agents = st.agents || {};
	if (!st.agents[agentId]) st.agents[agentId] = seedAgent(agentId, roleKind);
	st.agents.root = st.agents.root || seedAgent("root", "root");
	writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");
}

function seedTaskDir(taskId) {
	const dir = join(scratch, ".pi", "swarm", "tasks", taskId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "task.json"),
		JSON.stringify({
			taskId,
			title: taskId,
			status: "in_progress",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			nodes: { plan: { role: "planner", status: "in_progress", assignee: "worker-a" } },
			edges: [],
		}),
		"utf8",
	);
}

function statePath() {
	return join(scratch, ".pi", "swarm", "swarm-state.json");
}
function readStateFile() {
	return JSON.parse(readFileSync(statePath(), "utf8"));
}
function tasksDirIds() {
	const dir = join(scratch, ".pi", "swarm", "tasks");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((e) => existsSync(join(dir, e, "task.json")));
}
function mailboxCount(agentId) {
	const st = readStateFile();
	return Object.values(st.messages || {}).filter((m) => m.to === agentId).length;
}

// =============================================================
console.log("\n[1] update: nonexistent taskId -> TASK_NOT_FOUND with structured payload (empty task dir)");
{
	await ensureWorker("root", "root");
	await ensureWorker("worker-a", "planner");
	const err = await expectErrorCode(
		"worker-a",
		"swarm_update_task",
		{ taskId: "does-not-exist", nodeId: "plan", status: "done", cwd: scratch },
		"TASK_NOT_FOUND",
	);
	ok("hint present", Boolean(err?.actionableHint));
	ok("hint names message-only path (no active tasks)", /swarm_send_message/.test(err?.actionableHint || ""));
	ok("no suggestedNextCall when no tasks exist", err?.suggestedNextCall === undefined);
	ok("validTaskIds is empty array", Array.isArray(err?.expected?.validTaskIds) && err.expected.validTaskIds.length === 0);
	ok("myActiveTaskIds present", Array.isArray(err?.expected?.myActiveTaskIds));
	ok("no task dir created by the failed call", !existsSync(join(scratch, ".pi", "swarm", "tasks", "does-not-exist")));
}

// =============================================================
console.log("\n[2] update: existing tasks -> validTaskIds listed + suggestedNextCall names swarm_task_status");
{
	seedTaskDir("task-alpha-test");
	seedTaskDir("task-beta-test");
	const err = await expectErrorCode(
		"worker-a",
		"swarm_update_task",
		{ taskId: "does-not-exist", nodeId: "plan", status: "done", cwd: scratch },
		"TASK_NOT_FOUND",
	);
	ok(
		"validTaskIds lists seeded tasks",
		JSON.stringify(err?.expected?.validTaskIds) === JSON.stringify(["task-alpha-test", "task-beta-test"]),
	);
	ok("suggestedNextCall is swarm_task_status", err?.suggestedNextCall?.tool === "swarm_task_status");
}

// =============================================================
console.log("\n[3] worker WITH an active task -> hint does NOT push message-only path");
{
	const st = readStateFile();
	st.agents["worker-a"].activeTaskIds = ["task-alpha-test"];
	writeFileSync(statePath(), JSON.stringify(st, null, 2) + "\n");
	const err = await expectErrorCode(
		"worker-a",
		"swarm_update_task",
		{ taskId: "wrong-task", nodeId: "plan", status: "done", cwd: scratch },
		"TASK_NOT_FOUND",
	);
	ok("hint still structured", Boolean(err?.actionableHint));
	ok("myActiveTaskIds shows the held task", JSON.stringify(err?.expected?.myActiveTaskIds) === JSON.stringify(["task-alpha-test"]));
	ok("hint mentions validTaskIds source (swarm_task_status)", /swarm_task_status/.test(err?.actionableHint || ""));
	ok("hint does not tell task-holding worker to skip update_task", !/not required/.test(err?.actionableHint || ""));
	st.agents["worker-a"].activeTaskIds = [];
	writeFileSync(statePath(), JSON.stringify(st, null, 2) + "\n");
}

// =============================================================
console.log("\n[4] root caller gets the same structured payload");
{
	const err = await expectErrorCode(
		"root",
		"swarm_update_task",
		{ taskId: "does-not-exist", nodeId: "plan", cwd: scratch },
		"TASK_NOT_FOUND",
	);
	ok("root payload structured too", err?.errorCode === "TASK_NOT_FOUND" && Array.isArray(err?.expected?.validTaskIds));
}

// =============================================================
console.log("\n[5] assign: nonexistent taskId -> same structured shape");
{
	await ensureWorker("root", "root");
	const err = await expectErrorCode(
		"root",
		"swarm_assign_task",
		{ taskId: "does-not-exist", nodeId: "plan", agentId: "worker-a", cwd: scratch },
		"TASK_NOT_FOUND",
	);
	ok("assign payload structured", Boolean(err?.actionableHint));
	ok("assign lists validTaskIds", Array.isArray(err?.expected?.validTaskIds));
}

// =============================================================
console.log("\n[6] no state mutation on failure");
{
	const stBefore = readStateFile();
	const mailsBefore = mailboxCount("worker-a");
	await expectErrorCode(
		"worker-a",
		"swarm_update_task",
		{ taskId: "does-not-exist", nodeId: "plan", status: "done", cwd: scratch },
		"TASK_NOT_FOUND",
	);
	const stAfter = readStateFile();
	ok(
		"worker activeTaskIds unchanged",
		JSON.stringify(stAfter.agents["worker-a"].activeTaskIds) === JSON.stringify(stBefore.agents["worker-a"].activeTaskIds),
	);
	ok("no mailbox rows for caller", mailboxCount("worker-a") === mailsBefore);
	ok("tasks dir unchanged", JSON.stringify(tasksDirIds()) === JSON.stringify(["task-alpha-test", "task-beta-test"]));
}

// =============================================================
console.log("\n[7] de-path hygiene: throw text carries no raw filesystem path");
{
	const err = await expectErrorCode(
		"worker-a",
		"swarm_update_task",
		{ taskId: "does-not-exist", nodeId: "plan", status: "done", cwd: scratch },
		"TASK_NOT_FOUND",
	);
	const full = `${err?.message || ""} ${JSON.stringify({ h: err?.actionableHint, e: err?.expected })}`;
	ok("no scratch path leak", !full.includes(scratch));
	ok("no .pi/ path leak", !full.includes(".pi/"));
}

// =============================================================
console.log("\n[8] errorCode trace recorded (task.tool.invalid with TASK_NOT_FOUND)");
{
	const evPath = join(scratch, ".pi", "swarm", "traces", "events.jsonl");
	const events = existsSync(evPath)
		? readFileSync(evPath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => {
					try {
						return JSON.parse(l);
					} catch {
						return null;
					}
				})
				.filter(Boolean)
		: [];
	ok(
		"trace event present",
		events.some((e) => e.event === "task.tool.invalid" && e.code === "TASK_NOT_FOUND"),
	);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
