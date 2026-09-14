#!/usr/bin/env node
// Test reproduction: active workers (thinking/busy with fresh heartbeat, or running tools)
// MUST NOT be surfaced as stale-open, even if node.lastActivityAt is older than threshold.
// Only workers that have ACTUALLY settled (runtimeStatus === "idle") or whose heartbeat is
// dead (hung > AGENT_HEARTBEAT_STALE_MS) should be eligible for stale-open surfacing.

import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-stale-active-skip-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_STALE_OPEN_THRESHOLD_MS = "1000"; // 1s threshold

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
const ok = (n, c, extra) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n, extra ?? "");
	}
};

const call = async (name, params) => {
	const t = tools[name];
	if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: scratch });
};

mkdirSync(join(scratch, ".pi/swarm"), { recursive: true });
const statePath = join(scratch, ".pi/swarm/swarm-state.json");
const nowIso = new Date().toISOString();
const oldIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();

writeFileSync(
	statePath,
	JSON.stringify(
		{
			version: 1,
			swarmId: "repro-active-skip",
			agents: {
				root: { id: "root", status: "running", runtimeStatus: "idle", activeTaskIds: [], updatedAt: nowIso },
				"worker-tool": {
					id: "worker-tool",
					status: "running",
					runtimeStatus: "tool_running", // Active: tool executing!
					lastHeartbeatAt: nowIso,
					activeTaskIds: [],
					updatedAt: nowIso,
				},
				"worker-thinking": {
					id: "worker-thinking",
					status: "running",
					runtimeStatus: "busy", // Active: thinking / prompt active!
					lastHeartbeatAt: nowIso,
					activeTaskIds: [],
					updatedAt: nowIso,
				},
				"worker-settled": {
					id: "worker-settled",
					status: "running",
					runtimeStatus: "idle", // Actually settled!
					lastAgentSettledAt: oldIso,
					lastHeartbeatAt: nowIso,
					activeTaskIds: [],
					updatedAt: nowIso,
				},
			},
			messages: {},
			updatedAt: nowIso,
		},
		null,
		2,
	),
);

// Create task with 3 nodes assigned to the 3 workers
await call("swarm_create_task", {
	taskId: "task-test-skip",
	title: "Active worker skip test",
	goal: "Test stale open skip for active workers",
	nodes: {
		node_tool: { role: "worker", dependsOn: [] },
		node_thinking: { role: "worker", dependsOn: [] },
		node_settled: { role: "worker", dependsOn: [] },
	},
	edges: [],
	cwd: scratch,
});

await call("swarm_assign_task", { taskId: "task-test-skip", nodeId: "node_tool", agentId: "worker-tool", cwd: scratch });
await call("swarm_assign_task", { taskId: "task-test-skip", nodeId: "node_thinking", agentId: "worker-thinking", cwd: scratch });
await call("swarm_assign_task", { taskId: "task-test-skip", nodeId: "node_settled", agentId: "worker-settled", cwd: scratch });

// Age all 3 nodes past the threshold (lastActivityAt = 10min ago)
const taskPath = join(scratch, ".pi/swarm/tasks/task-test-skip/task.json");
const taskData = JSON.parse(readFileSync(taskPath, "utf8"));
taskData.nodes.node_tool.lastActivityAt = oldIso;
taskData.nodes.node_thinking.lastActivityAt = oldIso;
taskData.nodes.node_settled.lastActivityAt = oldIso;
writeFileSync(taskPath, JSON.stringify(taskData, null, 2));

const { staleOpenAssignmentScanLocked } = await import(join(here, "..", "src", "taskgraph.ts"));
const { paths: pathsOf, readState, withLock } = await import(join(here, "..", "src", "state.ts"));
const p = pathsOf(scratch);

const scan = await withLock(p, async () => {
	const st = await readState(p, scratch);
	return staleOpenAssignmentScanLocked(p, st, Date.now());
});

console.log("Scan result surfaced nodes:", scan.surfacedNodes);

// ASSERTIONS:
// 1. node_tool (assignee runtimeStatus="tool_running") MUST NOT be surfaced
const toolSurfaced = (scan.surfacedNodes || []).some((n) => n.nodeId === "node_tool");
ok("worker running tool is NOT surfaced as stale", !toolSurfaced, "node_tool was surfaced!");

// 2. node_thinking (assignee runtimeStatus="busy", fresh heartbeat) MUST NOT be surfaced
const thinkingSurfaced = (scan.surfacedNodes || []).some((n) => n.nodeId === "node_thinking");
ok("worker thinking (busy + fresh heartbeat) is NOT surfaced as stale", !thinkingSurfaced, "node_thinking was surfaced!");

// 3. node_settled (assignee runtimeStatus="idle") MUST be surfaced
const settledSurfaced = (scan.surfacedNodes || []).some((n) => n.nodeId === "node_settled");
ok("truly settled worker IS surfaced as stale", settledSurfaced, "node_settled was NOT surfaced!");

rmSync(scratch, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
