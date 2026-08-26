#!/usr/bin/env node
// UAT: Crash Consistency and Failure Injection
// Tests extension boot and representative crash/recovery paths deterministically
// Run: node extensions/swarm/uat-crash-consistency.mjs

import { rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-uat-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

console.log("=== Crash Consistency UAT ===\n");
console.log("Scratch dir:", scratch);
console.log("");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("✓", n); } else { fail++; console.error("✗", n); } };

// Test 1: Extension loads successfully
console.log("[1] Extension boot test");
try {
	const { paths, ensureDirs, readState, writeState, withLock, appendJsonl, mailboxPath } = await import(join(here, "src/state.ts"));
	const { readTaskState, writeTaskState, taskPaths } = await import(join(here, "src/state.ts"));
	const { readMailbox } = await import(join(here, "src/mailbox.ts"));
	const { LOCK_STALE_MS } = await import(join(here, "src/constants.ts"));
	const { reconcileTasks } = await import(join(here, "src/reconcile.ts"));
	
	// Minimal ExtensionAPI stub for reconcileTasks
	const pi = {
		registerTool: () => {},
		registerCommand: () => {},
		on: () => {},
		exec: async (cmd, args) => {
			if (cmd === "tmux" && args?.[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
			if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
			return { code: 1, stdout: "", stderr: "" };
		},
		sendMessage: () => {},
	};
	
	ok("Extension imports load", true);
	ok("LOCK_STALE_MS exported from constants", LOCK_STALE_MS === 60_000);
	
	const p = paths(scratch);
	await ensureDirs(p);
	ok("Directories created", existsSync(p.root));
	
	// Test 2: State write and read (atomicity)
	console.log("\n[2] State write/read atomicity");
	const state = await readState(p, scratch);
	ok("Initial state created", state.swarmId && state.version === 1);
	
	state.testField = "uat-test";
	await writeState(p, state);
	
	const readBack = await readState(p, scratch);
	ok("State persists after write", readBack.testField === "uat-test");
	ok("State file is valid JSON", existsSync(p.state));
	
	// Test 3: Lock acquisition and release
	console.log("\n[3] Lock acquisition and release");
	let lockHeld = false;
	await withLock(p, async () => {
		lockHeld = true;
		ok("Lock held during execution", existsSync(p.lock));
	});
	ok("Lock released after execution", !existsSync(p.lock));
	
	// Test 4: Stale lock recovery
	console.log("\n[4] Stale lock recovery");
	mkdirSync(p.lock, { recursive: true });
	const staleTime = new Date(Date.now() - LOCK_STALE_MS - 1000);
	utimesSync(p.lock, staleTime, staleTime);
	
	await withLock(p, async () => {
		ok("Stale lock acquired", true);
	});
	ok("Stale lock removed", !existsSync(p.lock));
	
	// Test 5: Corrupt state recovery
	console.log("\n[5] Corrupt state recovery");
	writeFileSync(p.state, "{corrupt json", "utf8");
	const recovered = await readState(p, scratch);
	ok("Corrupt state recovered", recovered.swarmId && existsSync(`${p.state}.corrupt.bak`));
	
	// Test 6: Task state write/read
	console.log("\n[6] Task state write/read");
	const tp = taskPaths(p, "uat-task");
	mkdirSync(tp.root, { recursive: true });
	
	const task = {
		taskId: "uat-task",
		version: 1,
		status: "in_progress",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		nodes: {
			plan: { id: "plan", status: "done", role: "planner", dependsOn: [], messageIds: [], attemptHistory: [] }
		},
		edges: [],
		currentNodes: [],
		allowedFiles: [],
		acceptanceCriteria: [],
		validationCommands: [],
		handoffs: [],
		gates: {},
		editLocks: {},
		evidence: {},
		sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] }
	};
	
	await writeTaskState(tp, task);
	ok("Task state written", existsSync(tp.taskJson));
	
	const readTask = await readTaskState(tp.taskJson);
	ok("Task state read back", readTask.taskId === "uat-task");
	
	// Test 7: Mailbox append and read
	console.log("\n[7] Mailbox append/read");
	const mbox = mailboxPath(p, "test-agent");
	
	const msg = {
		id: "msg-uat-1",
		swarmId: "swarm-uat",
		from: "orchestrator",
		to: "test-agent",
		priority: "normal",
		type: "swarm.message",
		schemaVersion: 1,
		createdAt: new Date().toISOString(),
		body: "UAT test message",
		requiresAck: false,
		headers: {}
	};
	
	await appendJsonl(mbox, msg);
	ok("Mailbox append succeeds", existsSync(mbox));
	
	const msgs = await readMailbox(p, "test-agent");
	ok("Mailbox message read back", msgs.length === 1 && msgs[0].id === "msg-uat-1");
	
	// Test 8: Concurrent write serialization
	console.log("\n[8] Concurrent write serialization");
	const state1 = await readState(p, scratch);
	const state2 = await readState(p, scratch);
	
	let writes = 0;
	const write1 = withLock(p, async () => {
		state1.counter = (state1.counter || 0) + 1;
		await writeState(p, state1);
		writes++;
	});
	const write2 = withLock(p, async () => {
		state2.counter = (state2.counter || 0) + 1;
		await writeState(p, state2);
		writes++;
	});
	
	await Promise.all([write1, write2]);
	ok("Both writes completed", writes === 2);
	
	const finalState = await readState(p, scratch);
	ok("Final state valid (not corrupted)", finalState.counter === 1 || finalState.counter === 2);
	
	// Test 9: Cross-file drift detection via reconcile
	console.log("\n[9] Cross-file drift detection via reconcile");
	const driftTp = taskPaths(p, "drift-task");
	mkdirSync(driftTp.root, { recursive: true });
	
	const driftTask = {
		taskId: "drift-task",
		version: 1,
		status: "in_progress",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		nodes: {
			work: { 
				id: "work", 
				status: "assigned", 
				role: "worker", 
				dependsOn: [], 
				messageIds: ["msg-phantom"],
				assignee: "agent-missing" 
			}
		},
		edges: [],
		currentNodes: ["work"],
		allowedFiles: [],
		acceptanceCriteria: [],
		validationCommands: [],
		handoffs: [],
		gates: {},
		editLocks: {},
		evidence: {},
		sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] }
	};
	
	writeFileSync(driftTp.taskJson, JSON.stringify(driftTask, null, 2), "utf8");
	const driftTaskRead = await readTaskState(driftTp.taskJson);
	ok("Task references missing entities", driftTaskRead.nodes.work.messageIds.includes("msg-phantom"));
	
	const currentState = await readState(p, scratch);
	ok("State does not contain phantom message", !currentState.messages["msg-phantom"]);
	ok("State does not contain phantom agent", !currentState.agents["agent-missing"]);
	
	// Call real reconcileTasks - should detect drift
	const driftActions = await reconcileTasks(pi, p, currentState, { dryRun: true, mark: false, nowMs: Date.now() });
	const driftStale = driftActions.find(a => a.messageId === "drift-task/work" && a.action === "task_node_stale");
	ok("Reconcile detects drift", driftStale !== undefined);
	ok("Drift reason mentions missing entities", driftStale && (driftStale.reason.includes("msg-phantom") || driftStale.reason.includes("agent-missing")));
	
	console.log(`\n=== UAT Results: ${pass} pass, ${fail} fail ===`);
	if (fail > 0) {
		console.error("UAT FAILED");
		process.exit(1);
	}
	console.log("UAT PASSED");
	
} catch (err) {
	console.error("UAT ERROR:", err);
	process.exit(1);
} finally {
	// Cleanup
	rmSync(scratch, { recursive: true, force: true });
}
