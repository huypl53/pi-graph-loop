#!/usr/bin/env node
/**
 * Regression: verify that reconcile-core.ts, tasks-index.ts, and tools/tasks.ts
 * do not throw ReferenceError due to missing imports:
 * - safeId in reconcile-core.ts (when agentId option is passed)
 * - TRACE_LIFECYCLE_DERIVED & TRACE_MESSAGE_ATTENTION_DERIVED in reconcile-core.ts (when message responseDeadlineMs expires)
 * - logSwarmError in tasks-index.ts (when status scan encounters an error)
 * - TRACE_TASK_LEASE_STAMPED in tools/tasks.ts (when swarm_assign_task stamps a lease)
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-missing-imports-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
mkdirSync(join(scratch, ".pi/swarm/traces"), { recursive: true });
mkdirSync(join(scratch, ".pi/swarm/tasks/task-1"), { recursive: true });

process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
process.env.PI_SWARM_MINIMAL_PROTOCOL = "1";

const { default: factory } = await import(join(here, "..", "index.ts"));
const { buildSwarmStatusSummary } = await import(join(here, "..", "src", "tasks-index.ts"));
const { paths } = await import(join(here, "..", "src", "state.ts"));

const p = paths(scratch);
const nowIso = new Date().toISOString();
const old = new Date(Date.now() - 100_000).toISOString();

// Seed state with a message that has responseDeadlineMs exceeded
const messages = {
	"msg-1": {
		id: "msg-1",
		from: "root",
		to: "worker-1",
		status: "queued",
		createdAt: old,
		updatedAt: old,
		attempts: 0,
		requiresAck: false,
		responseDeadlineMs: 10, // expired!
	},
};

const agents = {
	root: {
		id: "root",
		role: "orchestrator",
		status: "running",
		tmuxTarget: "unknown",
		createdAt: old,
		updatedAt: old,
		lastHeartbeatAt: nowIso,
		leaderPid: process.pid,
	},
	"worker-1": {
		id: "worker-1",
		role: "worker",
		status: "idle",
		tmuxTarget: "unknown",
		createdAt: old,
		updatedAt: old,
	},
};

const swarmState = {
	version: 1,
	swarmId: "swarm-imports-test",
	cwd: scratch,
	tmuxSession: "none",
	agents,
	delivered: { "worker-1": [] },
	messages,
	createdAt: old,
	updatedAt: old,
	rootLeader: {
		agentId: "root",
		claimedAt: nowIso,
		lastHeartbeatAt: nowIso,
		pid: process.pid,
		leaseMs: 60_000,
	},
};

writeFileSync(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(swarmState, null, 2));

// Seed an invalid task.json to trigger logSwarmError in tasks-index.ts
writeFileSync(join(scratch, ".pi/swarm/tasks/task-1/task.json"), "INVALID JSON");

const tools = {};
factory({
	registerTool: (tool) => {
		tools[tool.name] = tool;
	},
	registerCommand: () => {},
	on: () => {},
	exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	sendMessage: () => {},
});

let pass = 0;
let fail = 0;
const ok = (name, condition, detail) => {
	if (condition) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, detail ?? "");
	}
};

// 1. Test reconcile with agentId option -> tests safeId
try {
	await tools.swarm_reconcile.execute("call-1", { dryRun: true, agentId: "worker-1" }, undefined, undefined, { cwd: scratch });
	ok("swarm_reconcile with agentId runs without safeId ReferenceError", true);
} catch (err) {
	ok("swarm_reconcile with agentId runs without safeId ReferenceError", false, err);
}

// 2. Test reconcile with responseDeadlineMs expired under gate=1 -> tests TRACE_LIFECYCLE_DERIVED
try {
	await tools.swarm_reconcile.execute("call-2", { dryRun: false }, undefined, undefined, { cwd: scratch });
	ok("swarm_reconcile deadline sweep runs without TRACE_LIFECYCLE_DERIVED ReferenceError", true);
} catch (err) {
	ok("swarm_reconcile deadline sweep runs without TRACE_LIFECYCLE_DERIVED ReferenceError", false, err);
}

// 3. Test tasks-index.ts error handling -> tests logSwarmError
try {
	await buildSwarmStatusSummary(p, swarmState);
	ok("buildSwarmStatusSummary handles unreadable task without logSwarmError ReferenceError", true);
} catch (err) {
	ok("buildSwarmStatusSummary handles unreadable task without logSwarmError ReferenceError", false, err);
}

// 4. Test swarm_assign_task with lease -> tests TRACE_TASK_LEASE_STAMPED
// Seed valid task for assigning
const validTask = {
	taskId: "task-lease-test",
	title: "Test Task",
	status: "open",
	createdAt: nowIso,
	updatedAt: nowIso,
	nodes: {
		"node-1": {
			id: "node-1",
			title: "Node 1",
			status: "ready",
			assignee: null,
			dependsOn: [],
		},
	},
};
mkdirSync(join(scratch, ".pi/swarm/tasks/task-lease-test"), { recursive: true });
writeFileSync(join(scratch, ".pi/swarm/tasks/task-lease-test/task.json"), JSON.stringify(validTask, null, 2));

try {
	await tools.swarm_assign_task.execute(
		"call-4",
		{
			taskId: "task-lease-test",
			nodeId: "node-1",
			assignee: "worker-1",
			lease: { kind: "exclusive", reason: "test lease" },
		},
		undefined,
		undefined,
		{ cwd: scratch },
	);
	ok("swarm_assign_task with lease runs without TRACE_TASK_LEASE_STAMPED ReferenceError", true);
} catch (err) {
	ok("swarm_assign_task with lease runs without TRACE_TASK_LEASE_STAMPED ReferenceError", false, err);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
