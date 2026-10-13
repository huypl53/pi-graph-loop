#!/usr/bin/env node
/**
 * taskless-worker-detect.test.mjs (mock-llm lane) — fixture driver for Stage D
 * (plan: docs/swarm/plans/2026-10-13-worker-task-closure-gaps.md §1.4 & §3)
 *
 * Pattern: mock-llm/tests/idle-agent-gc.test.mjs
 * Seeds the world, imports the REAL evaluator from src/nudges/taskless-worker.ts,
 * runs it under the real withLock, replays a root turn: swarm_check_mailbox then
 * swarm_assign_task of the seeded task graph to worker-taskless; asserts mailbox rows,
 * idempotency keys, the assign succeeded, and untouched agents remain untouched.
 */

import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const fixturePath = join(root, "extensions/mock-llm/fixtures/taskless-worker-detect.jsonl");

let passed = 0,
	failed = 0;
const ok = (n, c, info) => {
	if (c) {
		passed++;
		console.log("  ok  ", n);
	} else {
		failed++;
		console.error("  FAIL:", n, info ?? "");
	}
};

// Fixture sanity
const rawLines = (await readFile(fixturePath, "utf8")).split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
const turns = rawLines.map((l) => JSON.parse(l));
const scripted = turns.flatMap((t) => t.events || []).filter((e) => e.type === "toolcall");
ok(
	"fixture: scripted swarm_check_mailbox present",
	scripted.some((e) => e.name === "swarm_check_mailbox"),
	JSON.stringify(scripted.map((e) => e.name)),
);
ok(
	"fixture: scripted swarm_assign_task targets worker-taskless",
	scripted.some((e) => e.name === "swarm_assign_task" && e.arguments?.agentId === "worker-taskless"),
	JSON.stringify(scripted.map((e) => e.name)),
);

// Scratch world
const scratch = await mkdtemp(join(tmpdir(), "taskless-detect-lane-"));
const taskId = "task-lane-detect";
await mkdir(join(scratch, ".pi/swarm/tasks", taskId), { recursive: true });
await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });

const NOW = Date.now();
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

// Seed ready task graph
const task = {
	taskId,
	title: "Lane task",
	goal: "assign taskless worker",
	status: "ready",
	owner: "root",
	createdAt: iso(NOW),
	updatedAt: iso(NOW),
	start: "n1",
	nodes: {
		n1: {
			id: "n1",
			role: "implementer",
			status: "ready",
			dependsOn: [],
		},
	},
	edges: [],
};
await writeFile(join(scratch, ".pi/swarm/tasks", taskId, "task.json"), JSON.stringify(task, null, 2), "utf8");

const agent = (id, overrides = {}) => ({
	id,
	role: `${id} role`,
	roleKind: "worker",
	capabilities: [],
	activeTaskIds: [],
	maxConcurrentTasks: 1,
	status: "running",
	runtimeStatus: "idle",
	health: "healthy",
	tmuxTarget: `sess:${id}`,
	lastHeartbeatAt: iso(NOW),
	createdAt: iso(NOW - 20 * MIN),
	updatedAt: iso(NOW),
	...overrides,
});

const state = {
	version: 1,
	swarmId: "swarm-lane",
	cwd: scratch,
	tmuxSession: "sess",
	agents: {
		root: agent("root", { roleKind: "root" }),
		"worker-fresh": agent("worker-fresh", { createdAt: iso(NOW - 5 * MIN) }),
		"worker-taskless": agent("worker-taskless", { createdAt: iso(NOW - 20 * MIN) }),
		"worker-contractual": agent("worker-contractual", { createdAt: iso(NOW - 20 * MIN) }),
		"worker-with-task": agent("worker-with-task", { activeTaskIds: [taskId], createdAt: iso(NOW - 20 * MIN) }),
	},
	delivered: {},
	messages: {
		"msg-contractual": {
			id: "msg-contractual",
			from: "root",
			to: "worker-contractual",
			requiresResponse: true,
			status: "mailbox_delivered",
			createdAt: iso(NOW - 10 * MIN),
		},
	},
};
await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(state, null, 2), "utf8");

process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";

let evaluateTasklessWorkerNudgeLocked = null;
try {
	({ evaluateTasklessWorkerNudgeLocked } = await import(join(root, "extensions/swarm/src/nudges/taskless-worker.ts")));
} catch (err) {
	ok("import evaluateTasklessWorkerNudgeLocked failed", false, String(err));
}

const sentMessages = [];
const tools = {};
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	sendMessage: (m, o) => sentMessages.push({ m, o }),
	exec: async (cmd, args) => {
		if (cmd === "tmux" && args?.[0] === "display-message") return { code: 0, stdout: "pi\t1234\n", stderr: "" };
		if (cmd === "tmux" && args?.[0] === "list-panes") return { code: 0, stdout: "%1 0 1 1\n", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	},
};

const mod = await import(join(root, "extensions/swarm/index.ts"));
mod.default(pi);

const { paths, withLock } = await import(join(root, "extensions/swarm/src/state.ts"));
const p = paths(scratch);
const ctx = { cwd: scratch, hasUI: false };

// 1. Run the REAL evaluator under the real lock
let evalRes = null;
await withLock(p, async () => {
	evalRes = await evaluateTasklessWorkerNudgeLocked(pi, scratch, p, state, NOW, [{ taskId, nodes: task.nodes }]);
});

ok("lane: evaluateTasklessWorkerNudgeLocked ran", evalRes?.scanRan === true);
ok("lane: exactly 1 self-nudge emitted (worker-taskless)", evalRes?.selfNudged === 1);
ok("lane: exactly 1 root notice emitted (for worker-taskless)", evalRes?.rootNotified === 1);

// Mailbox assertions
async function readMailbox(who) {
	try {
		const raw = await readFile(join(scratch, ".pi", "swarm", "mailboxes", `${who}.jsonl`), "utf8");
		return raw
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

const rootMail = await readMailbox("root");
const rootNotices = rootMail.filter((m) => (m.idempotencyKey || "").includes("taskless-root"));
ok("lane: root notice landed in root mailbox", rootNotices.length === 1);
ok("lane: root notice idempotency key matches template", rootNotices[0]?.idempotencyKey === "agent:worker-taskless:nudge:taskless-root:1");
ok("lane: root notice body offers swarm_assign_task", rootNotices[0]?.body?.includes("swarm_assign_task"));
ok("lane: root notice contains no raw .pi/ path", !rootNotices[0]?.body?.includes(".pi/"));

const tasklessMail = await readMailbox("worker-taskless");
ok("lane: worker-taskless received self-nudge", tasklessMail.length === 1);
ok("lane: self-nudge idempotency key matches template", tasklessMail[0]?.idempotencyKey === "agent:worker-taskless:nudge:taskless-self");

for (const id of ["worker-fresh", "worker-contractual", "worker-with-task"]) {
	const mb = await readMailbox(id);
	ok(`lane: ${id} untouched (mailbox empty)`, mb.length === 0);
}

// 2. Replay root turn: swarm_check_mailbox then swarm_assign_task
const checkCall = scripted.find((e) => e.name === "swarm_check_mailbox");
const assignCall = scripted.find((e) => e.name === "swarm_assign_task");

const checkRes = await tools["swarm_check_mailbox"].execute("call-1", checkCall.arguments, undefined, undefined, ctx);
const checkText = checkRes?.content?.[0]?.text || "";
ok("lane: check_mailbox surfaces root notice", checkText.includes("worker-taskless") && checkText.includes("no task-graph assignment"));

const assignRes = await tools["swarm_assign_task"].execute("call-2", assignCall.arguments, undefined, undefined, ctx);
const assignText = assignRes?.content?.[0]?.text || "";
ok("lane: assign task succeeded", !assignRes?.isError && assignText.includes("Assigned"), assignText);

// Verify node assignment on disk
const taskAfter = JSON.parse(await readFile(join(scratch, ".pi/swarm/tasks", taskId, "task.json"), "utf8"));
ok("lane: node n1 assigned to worker-taskless", taskAfter.nodes.n1.assignee === "worker-taskless");
ok("lane: node n1 status is assigned", taskAfter.nodes.n1.status === "assigned");

// Verify agent record
const stFinal = JSON.parse(await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
ok("lane: worker-taskless activeTaskIds updated", stFinal.agents["worker-taskless"]?.activeTaskIds?.includes(taskId));

console.log(`\n---\ntaskless-worker-detect (mock-llm lane) results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
