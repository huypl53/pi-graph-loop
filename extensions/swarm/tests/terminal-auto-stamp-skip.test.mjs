#!/usr/bin/env node
// terminal-auto-stamp-skip.test.mjs — F7 red tests (task-redteam-fixnow)
//
// deliverMessageLocked's Issue-24.b branch auto-stamps node.assignee from assignment-shaped
// messages WITHOUT checking the node status. When the node is already TERMINAL (done/failed/
// skipped/cancelled) the stamp mutates closed work — an assignment-shaped message delivered to
// a recipient of a DONE node flips node.assignee on terminal state (audit distortion; redteam
// finding F7, PoC /tmp/rt-edgeb/p2-close/poc.mjs verdict MUTATED).
//
// RED symptom (pre-fix, observed against HEAD 6ff8ff8): for each terminal status, sending an
// assignment-shaped message stamps node.assignee on the terminal node.
// GREEN contract (post-fix):
//   - node.assignee stays null and node.status unchanged for all four terminal statuses;
//   - trace message.deliver.assignment_auto_stamp_skipped_terminal emitted with
//     { taskId, nodeId, nodeStatus, messageTo };
//   - no NEW message.deliver.assignment_auto_stamp for terminal nodes;
//   - CONTROL: a non-terminal (ready, unassigned) node still auto-stamps (assignment-ownership
//     case 5 semantics preserved).
//
// Run: node extensions/swarm/tests/terminal-auto-stamp-skip.test.mjs
import { rmSync, readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-termstamp-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

process.env.PI_SWARM_AGENT_ID = "root";
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;
if (typeof factory !== "function") throw new Error("no default export");

const tools = {};
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	exec: async () => ({ code: 1, stdout: "", stderr: "" }),
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

const readTask = (taskId) => JSON.parse(readFileSync(join(scratch, `.pi/swarm/tasks/${taskId}/task.json`), "utf8"));
const readNode = (taskId, nodeId) => readTask(taskId).nodes[nodeId];
const readTaskEvents = (taskId) => {
	// message.deliver.* traces go through trace(p, ...) -> the GLOBAL traces/events.jsonl with
	// FLAT rows ({ts, event, taskId, nodeId, ...} — payload fields are top-level, not under a
	// data key). Rows are filtered to (a) stamp-related events AND (b) this taskId, because the
	// global trace file accumulates across every case in this suite (one process, one scratch).
	const out = [];
	for (const p of [join(scratch, `.pi/swarm/tasks/${taskId}/events.jsonl`), join(scratch, ".pi/swarm/traces/events.jsonl")]) {
		if (!existsSync(p)) continue;
		out.push(
			...readFileSync(p, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => {
					try {
						const j = JSON.parse(l);
						const stampRelated =
							j?.event === "message.deliver.assignment_auto_stamp" || j?.event === "message.deliver.assignment_auto_stamp_skipped_terminal";
						return stampRelated && j.taskId === taskId ? j : null;
					} catch {
						return null;
					}
				})
				.filter(Boolean),
		);
	}
	return out;
};

// Task 4 terminal statuses per plan (constants.ts TERMINAL_NODE_STATUSES).
const TERMINAL = ["done", "failed", "skipped", "cancelled"];

async function seedTaskWithNode(nodeId, status, extraNode = {}) {
	const taskId = `task-termstamp-${status}-${Math.random().toString(36).slice(2, 8)}`;
	const now = new Date().toISOString();
	const task = {
		version: 1,
		taskId,
		title: "terminal auto-stamp skip test",
		goal: "g",
		status: "in_progress",
		priority: "high",
		createdAt: now,
		updatedAt: now,
		owner: "root",
		workflow: "feature-dev",
		start: nodeId,
		currentNodes: [],
		nodes: {
			[nodeId]: {
				status,
				role: "implementer",
				dependsOn: [],
				assignee: null,
				...extraNode,
			},
		},
		edges: [],
		handoffs: [],
		gates: {},
	};
	const dir = join(scratch, ".pi", "swarm", "tasks", taskId);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "task.json"), JSON.stringify(task, null, 2) + "\n");
	return taskId;
}

async function sendAssignmentShape(taskId, nodeId, to) {
	return call("swarm_send_message", {
		to,
		subject: `Task ${taskId} / node ${nodeId} assigned`,
		body: "Assignment body",
		conversationId: `task:${taskId}:${nodeId}`,
	});
}

// A registered recipient is not strictly required (auto-stamp runs before any recipient
// registration check in the 24.b branch), but seed one so delivery mirrors production.
const stateDir = join(scratch, ".pi", "swarm");
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });
writeFileSync(join(stateDir, "swarm-state.json"), JSON.stringify({
	swarmId: "termstamp-test",
	tmuxSession: "x",
	rootId: "root",
	agents: {
		root: { id: "root", roleKind: "root", status: "running", activeTaskIds: [] },
		"worker-a": { id: "worker-a", roleKind: "implementer", status: "running", activeTaskIds: [] },
	},
	delivered: {},
	messages: {},
}, null, 2) + "\n");

// ---------------------------------------------------------------------------
console.log("\n[1] terminal nodes are NOT auto-stamped; skip is traced");
for (const status of TERMINAL) {
	const taskId = await seedTaskWithNode("implement", status);
	const nodeBefore = readNode(taskId, "implement");
	await sendAssignmentShape(taskId, "implement", "worker-a");
	const node = readNode(taskId, "implement");
	ok(`${status}: assignee stays null`, node.assignee === null || node.assignee === undefined, `got=${JSON.stringify(node.assignee)}`);
	ok(`${status}: status unchanged`, node.status === status, `got=${node.status}`);
	const events = readTaskEvents(taskId);
	ok(
		`${status}: assignment_auto_stamp_skipped_terminal trace emitted`,
		events.some((e) => e.event === "message.deliver.assignment_auto_stamp_skipped_terminal" && e.nodeStatus === status),
		`events=${events.map((e) => e.event).join(",")}`,
	);
	ok(
		`${status}: no assignment_auto_stamp trace`,
		!events.some((e) => e.event === "message.deliver.assignment_auto_stamp"),
	);
}

// ---------------------------------------------------------------------------
console.log("\n[2] CONTROL non-terminal (ready, unassigned) node still auto-stamps");
{
	const taskId = await seedTaskWithNode("implement", "ready");
	await sendAssignmentShape(taskId, "implement", "worker-a");
	const node = readNode(taskId, "implement");
	ok("ready: assignee auto-stamped to worker-a", node.assignee === "worker-a", `got=${JSON.stringify(node.assignee)}`);
	const events = readTaskEvents(taskId);
	ok("ready: assignment_auto_stamp trace emitted", events.some((e) => e.event === "message.deliver.assignment_auto_stamp"));
	ok("ready: no skip trace for non-terminal", !events.some((e) => e.event === "message.deliver.assignment_auto_stamp_skipped_terminal"));
}

// ---------------------------------------------------------------------------
console.log("\n[3] skip trace payload shape");
{
	const taskId = await seedTaskWithNode("implement", "done");
	await sendAssignmentShape(taskId, "implement", "worker-a");
	const events = readTaskEvents(taskId).filter((e) => e.event === "message.deliver.assignment_auto_stamp_skipped_terminal");
	ok("skip trace present", events.length === 1, `count=${events.length}`);
	const e = events[0];
	ok(
		"skip trace carries taskId/nodeId/nodeStatus/messageTo (flat trace row)",
		e && e.taskId === taskId && e.nodeId === "implement" && e.nodeStatus === "done" && e.messageTo === "worker-a",
		`row=${JSON.stringify(e).slice(0, 220)}`,
	);
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
