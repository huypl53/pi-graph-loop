#!/usr/bin/env node
/**
 * spawn-taskless-hint.test.mjs (mock-llm lane) — fixture driver for Stage C
 * (plan: docs/swarm/plans/2026-10-13-worker-task-closure-gaps.md §1.3 & §3)
 *
 * Driver executes the mock-llm fixture turns through the REAL registered tool handlers:
 *   turn 0: root spawns an agent via swarm_spawn_agent.
 *           Asserts:
 *             - spawn result text contains the assign-hint paragraph with the spawned agent id
 *             - contains swarm_assign_task(taskId="<taskId>", nodeId="<nodeId>", agentId="worker-spawn-lane")
 *             - no raw filesystem path leakage
 *   turn 1: root calls swarm_assign_task on a seeded task graph (with a ready node).
 *           Asserts:
 *             - assignment succeeds normally
 *             - node assigned to worker-spawn-lane
 *             - agent record has activeTaskIds updated
 */

import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const fixturePath = join(root, "extensions/mock-llm/fixtures/spawn-taskless-hint.jsonl");

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
const spawnCall = scripted.find((e) => e.name === "swarm_spawn_agent");
const assignCall = scripted.find((e) => e.name === "swarm_assign_task");

ok("fixture: turn 0 is swarm_spawn_agent", Boolean(spawnCall) && spawnCall.arguments.id === "worker-spawn-lane");
ok("fixture: turn 1 is swarm_assign_task", Boolean(assignCall) && assignCall.arguments.taskId === "task-spawn-lane");

// Scratch world
const scratch = await mkdtemp(join(tmpdir(), "spawn-taskless-lane-"));
const taskId = "task-spawn-lane";
await mkdir(join(scratch, ".pi/swarm/tasks", taskId), { recursive: true });
await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });

// Seed a task with a ready node
const NOW = new Date().toISOString();
const task = {
	taskId,
	title: "Spawn lane task",
	goal: "test assignment after spawn hint",
	status: "ready",
	owner: "root",
	createdAt: NOW,
	updatedAt: NOW,
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

// Seed root agent in swarm-state.json
const rootAgent = {
	id: "root",
	role: "root coordinator",
	roleKind: "root",
	capabilities: [],
	activeTaskIds: [],
	maxConcurrentTasks: 99,
	status: "running",
	runtimeStatus: "idle",
	health: "healthy",
	tmuxTarget: "sess:root.0",
	lastHeartbeatAt: NOW,
	createdAt: NOW,
	updatedAt: NOW,
};
const state = {
	version: 1,
	swarmId: "swarm-spawn-lane",
	cwd: scratch,
	tmuxSession: "sess",
	rootId: "root",
	agents: { root: rootAgent },
	delivered: {},
	messages: {},
};
await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(state, null, 2), "utf8");

// Config so hasUserConfig is true
await writeFile(join(scratch, ".pi/swarm.yaml"), "defaultModel: mock-model\ndefaultProvider: mock-llm\n", "utf8");

process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
process.env.PI_SWARM_SPAWN_SETTLE_MS = "10";
process.env.PI_SWARM_TERMINAL_MANAGER = "tmux";
if (!process.env.TMUX) process.env.PI_SWARM_TMUX_OK = "1";
process.env.MOCK_LLM_API_KEY = "test-key";

const tools = {};
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	sendMessage: () => {},
	exec: async (cmd, args) => {
		if (cmd === "tmux") {
			if (args?.[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
			if (args?.[0] === "capture-pane") return { code: 0, stdout: "pi swarm session\n", stderr: "" };
			if (
				[
					"send-keys",
					"kill-window",
					"kill-pane",
					"has-session",
					"list-panes",
					"list-windows",
					"new-window",
					"new-session",
				].includes(args?.[0])
			) {
				return { code: 0, stdout: "", stderr: "" };
			}
		}
		if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	},
};

const mod = await import(join(root, "extensions/swarm/index.ts"));
mod.default(pi);

const ctx = { cwd: scratch, hasUI: false };

// Turn 0: spawn agent
const spawnRes = await tools["swarm_spawn_agent"].execute("call-1", spawnCall.arguments, undefined, undefined, ctx);
const spawnText = spawnRes?.content?.[0]?.text || "";

ok("lane: spawn result returned text", Boolean(spawnText));
ok("lane: spawn text contains status line", spawnText.includes("Spawned worker-spawn-lane at "));

const expectedHint =
	'NOTE: this agent is NOT tracked by any task graph yet. To attach its work to the task graph (and get progress/closure nudges), assign a node:\n  swarm_assign_task(taskId="<taskId>", nodeId="<nodeId>", agentId="worker-spawn-lane")\nIf this is a message-only helper (no task graph), it will report back via swarm messages.';
ok("lane: spawn text contains exact assign-hint paragraph", spawnText.includes(expectedHint), spawnText);
ok("lane: spawn text has no scratch cwd leak", !spawnText.includes(scratch));
ok("lane: spawn text has zero .pi/ occurrences when configured", !spawnText.includes(".pi/"));

// Turn 1: assign task
const assignRes = await tools["swarm_assign_task"].execute("call-2", assignCall.arguments, undefined, undefined, ctx);
const assignText = assignRes?.content?.[0]?.text || "";

ok("lane: assign task succeeded", !assignRes?.isError && assignText.includes("Assigned"), assignText);

// Verify task graph state
const taskAfter = JSON.parse(await readFile(join(scratch, ".pi/swarm/tasks", taskId, "task.json"), "utf8"));
ok("lane: node n1 assigned to worker-spawn-lane", taskAfter.nodes.n1.assignee === "worker-spawn-lane");
ok("lane: node n1 status is assigned", taskAfter.nodes.n1.status === "assigned");

// Verify agent activeTaskIds
const stAfter = JSON.parse(await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
const spawnedRecord = stAfter.agents["worker-spawn-lane"];
ok("lane: spawned agent record exists", Boolean(spawnedRecord));
ok("lane: spawned agent activeTaskIds includes task-spawn-lane", spawnedRecord?.activeTaskIds?.includes(taskId));

console.log(`\n---\nspawn-taskless-hint (mock-llm lane) results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
