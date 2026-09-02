#!/usr/bin/env node
/**
 * R20 — artifact-progress self-nudge (r20-artifact-progress-nudge.test.mjs)
 *
 * RED → GREEN reproduce-first test for the new evaluateArtifactProgressNudgeLocked
 * pump-tick phase in extensions/swarm/src/reconcile.ts.
 *
 * Scenarios:
 *   R20-S1 (RED): artifact mtime > lastProgressAt + grace AND node.status in (assigned|in_progress)
 *                  AND agent.lastToolAt > 60s ago → expect ≥1 worker.artifact_progress_no_status_update trace
 *   R20-S2:       node.lastProgressAt >= file mtime → no nudge
 *   R20-S3:       3 fires in 5 min → only 1 (backoff dedupe)
 *   R20-S4 (RED): 5 fires across 3 cap windows → 3 nudges + 1 worker.artifact_progress_cap_exceeded
 *   R20-S5:       agent.lastToolAt < 60s ago → NO nudge (active agent, no noise)
 *   R20-S6:       multi-agent, only completed_unverified agent is the nudge target
 *
 * Boundary counters C-R20-1..10 (at REAL boundaries, not helpers):
 *   C-R20-1:  worker.artifact_progress_no_status_update trace count
 *   C-R20-2:  worker.artifact_progress_cap_exceeded trace count
 *   C-R20-3:  deliverMessageLocked for agent:<id> keyed nudge (durable mailbox append)
 *   C-R20-4:  fs.stat allowedFiles calls (capped at 50/node)
 *   C-R20-5:  node.artifactProgressNudgeAt mutation
 *   C-R20-6:  node.artifactProgressNudgeCount mutation (incl. reset-to-0 on forward transition)
 *   C-R20-7:  writeState after each nudge
 *   C-R20-8:  Body contains exact close-action triple (swarm_update_task + swarm_send_message replyTo + swarm_ack_message)
 *   C-R20-9:  deriveTaskProgressState returns completed_unverified for the trigger config
 *   C-R20-10: deriveTaskProgressState returns correct state for all 6 RED configs (covered in agent-status-derive.test.mjs)
 */

import { mkdtemp, mkdir, writeFile, rm, readFile, utimes, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// RED: tunable thresholds (avoid depending on env-driven defaults inside the test for determinism)
process.env.PI_SWARM_ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS ||= "200";
process.env.PI_SWARM_ARTIFACT_PROGRESS_NUDGE_CAP ||= "3";
process.env.PI_SWARM_ARTIFACT_PROGRESS_GRACE_MS ||= "60";
process.env.PI_SWARM_ARTIFACT_PROGRESS_MAX_FILES ||= "50";
// NOTE: do NOT override ARTIFACT_PROGRESS_ACTIVE_AGENT_SKIP_MS — the production default (60s)
// must remain in effect so the active-agent skip branch is exercised correctly in S5/S6.
// (Overriding to a tiny value would make the predicate trivially false.)


const here = dirname(fileURLToPath(import.meta.url));
const { paths, readState, withLock, writeState, taskPaths, ensureDirs, trace } = await import(join(here, "src", "state.ts"));
// RED: this function does not exist pre-fix. Import will be undefined.
let evaluateArtifactProgressNudgeLocked = null;
try {
	const mod = await import(join(here, "src", "reconcile.ts"));
	evaluateArtifactProgressNudgeLocked = mod.evaluateArtifactProgressNudgeLocked ?? null;
} catch (e) {
	evaluateArtifactProgressNudgeLocked = null;
}
const { ensureOrchestrator } = await import(join(here, "src", "identity.ts"));
const { deliverMessageLocked } = await import(join(here, "src", "mailbox.ts"));

let passed = 0, failed = 0;
const ok = (n, c, info) => {
	if (c) { passed++; console.log("  ok  ", n); }
	else { failed++; console.error("  FAIL:", n, info ?? ""); }
};

const SAVED_AGENT_ID = process.env.PI_SWARM_AGENT_ID;
const SAVED_ORCH = process.env.PI_SWARM_IS_ORCHESTRATOR;
delete process.env.PI_SWARM_AGENT_ID;
process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
process.on("exit", () => {
	if (SAVED_AGENT_ID === undefined) delete process.env.PI_SWARM_AGENT_ID;
	else process.env.PI_SWARM_AGENT_ID = SAVED_AGENT_ID;
	if (SAVED_ORCH === undefined) delete process.env.PI_SWARM_IS_ORCHESTRATOR;
	else process.env.PI_SWARM_IS_ORCHESTRATOR = SAVED_ORCH;
});

const sentMessages = [];
const pi = {
	registerTool: () => {},
	registerCommand: () => {},
	on: () => {},
	setModel: async () => true,
	sendMessage: (m, o) => { sentMessages.push({ m, o }); },
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};

async function readEventsFile(p) {
	try {
		const raw = await readFile(p.events, "utf8");
		return raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	} catch { return []; }
}
async function countEvents(p, name) {
	const events = await readEventsFile(p);
	return events.filter((e) => e.event === name).length;
}
async function readMailboxMessages(p, agentId) {
	try {
		const path = join(p.mailboxes, `${agentId}.jsonl`);
		const raw = await readFile(path, "utf8");
		return raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	} catch { return []; }
}
async function mailboxMessageCount(p, agentId) {
	return (await readMailboxMessages(p, agentId)).length;
}

async function buildScratchDir() {
	const dir = await mkdtemp(join(tmpdir(), "r20-artifact-progress-nudge-"));
	await mkdir(join(dir, ".pi"), { recursive: true });
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ swarm: { defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" } }));
	process.chdir(dir);
	const p = paths(dir);
	await ensureDirs(p);
	return { dir, p };
}

function makeAgentRecord(st, dir, id, overrides = {}) {
	const nowIso = new Date().toISOString();
	return {
		id, role: overrides.role || "implementer", roleKind: overrides.roleKind || "worker", capabilities: [],
		activeTaskIds: overrides.activeTaskIds || [], maxConcurrentTasks: 1,
		status: "running", runtimeStatus: overrides.runtimeStatus || "idle", health: "healthy",
		tmuxSession: st.tmuxSession, tmuxWindow: id, tmuxTarget: `sess:${id}.0`,
		model: "glm-5.1", provider: "zai-coding-cn", cwd: dir,
		mailbox: `.pi/swarm/mailboxes/${id}.jsonl`,
		lastHeartbeatAt: nowIso,
		lastToolAt: overrides.lastToolAt ?? nowIso,
		lastAgentSettledAt: overrides.lastAgentSettledAt ?? nowIso,
		createdAt: nowIso, updatedAt: nowIso,
		...overrides,
	};
}

async function seedState(p, dir, overrides = {}) {
	const st = await readState(p, dir);
	ensureOrchestrator(st, dir, p);
	const now = Date.now();
	const ts = new Date(now).toISOString();
	for (const id of Object.keys(overrides.agents || {})) {
		st.agents[id] = makeAgentRecord(st, dir, id, overrides.agents[id] || {});
	}
	await writeState(p, st);
	return st;
}

async function writeTaskWithAllowedFile(p, dir, { taskId = "task-r20-1", allowedFiles, status = "in_progress", nodes, assignmentMessageId = "msg-assign-1", lastProgressAt, writeArtifactNow = false } = {}) {
	const tp = taskPaths(p, taskId);
	await mkdir(tp.root, { recursive: true });
	const nowMs = Date.now();
	const nowIso = new Date(nowMs).toISOString();
	const nodeNames = Object.keys(nodes || { implement: { assignee: "worker-a" } });
	const taskNodes = {};
	for (const n of nodeNames) {
		const o = (nodes || {})[n] || {};
		taskNodes[n] = {
			status: o.status || "assigned",
			role: o.role || "implementer",
			assignee: o.assignee || "worker-a",
			dependsOn: o.dependsOn || [],
			allowedFiles: o.allowedFiles ?? allowedFiles ?? ["extensions/swarm/src/reconcile.ts"],
			messageIds: o.messageIds ?? [assignmentMessageId],
			attempts: 1,
			assignmentMessageId,
			lastActivityAt: o.lastActivityAt ?? nowIso,
			lastProgressAt: o.lastProgressAt ?? lastProgressAt ?? new Date(nowMs - 5 * 60_000).toISOString(),
		};
	}
	const task = {
		version: 1,
		taskId,
		title: "R20 test task",
		goal: "Demonstrate artifact-progress nudge",
		status,
		priority: "normal",
		createdAt: new Date(nowMs - 3600_000).toISOString(),
		updatedAt: nowIso,
		owner: "orchestrator",
		workflow: "feature-dev",
		allowedFiles: allowedFiles ?? ["extensions/swarm/src/reconcile.ts"],
		nodes: taskNodes,
		edges: [],
		currentNodes: ["implement"],
		sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
		gates: {},
		editLocks: {},
	};
	await writeFile(tp.taskJson, JSON.stringify(task, null, 2));
	if (writeArtifactNow) {
		// Ensure the allowed file exists on disk so fs.stat has a real mtime
		const filePath = join(dir, allowedFiles[0] || "extensions/swarm/src/reconcile.ts");
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, "// touched by r20 test\n");
		// Touch mtime to 30s in the past: well after lastProgressAt (5min ago in S1) AND within
		// ARTIFACT_PROGRESS_GRACE_MS (default 60s). This is the "worker just wrote this" signal.
		await utimes(filePath, new Date(nowMs - 30_000), new Date(nowMs - 30_000));
	}
	return task;
}

async function runEvaluator(p, dir, nowMs, st) {
	if (typeof evaluateArtifactProgressNudgeLocked !== "function") {
		return { emitted: 0, reason: "MISSING_HELPER", events: [] };
	}
	const result = await withLock(p, async () => {
		const s = await readState(p, dir);
		const r = await evaluateArtifactProgressNudgeLocked(pi, dir, p, s, nowMs);
		await writeState(p, s);
		return { r, s };
	});
	return result;
}

// ===== SCENARIO R20-S1: RED trigger =====
console.log("\n=== R20-S1: artifact detected + node open + agent settled idle (RED) ===");
{
	const { dir, p } = await buildScratchDir();
	const nowMs = Date.now();
	const fiveMinAgo = new Date(nowMs - 5 * 60_000).toISOString();
	const twoMinAgo = new Date(nowMs - 2 * 60_000).toISOString();
	const thirtySecAgo = new Date(nowMs - 30_000).toISOString();
	await seedState(p, dir, {
		agents: {
			"worker-a": {
				activeTaskIds: ["task-r20-1"],
				lastToolAt: twoMinAgo,        // 2 min ago (real work happened)
				lastAgentSettledAt: thirtySecAgo, // settled without closing node
			},
		},
	});
	await writeTaskWithAllowedFile(p, dir, {
		taskId: "task-r20-1",
		allowedFiles: ["extensions/swarm/src/reconcile.ts"],
		status: "in_progress",
		nodes: { implement: { assignee: "worker-a", status: "assigned", lastProgressAt: fiveMinAgo } },
		writeArtifactNow: true,
	});
	await writeFile(p.events, "");

	const out = await runEvaluator(p, dir, nowMs, null);
	const traceCount = await countEvents(p, "worker.artifact_progress_no_status_update");
	const capTraceCount = await countEvents(p, "worker.artifact_progress_cap_exceeded");
	const mailboxCount = await mailboxMessageCount(p, "worker-a");
	const st = await readState(p, dir);
	const task = JSON.parse(await readFile(taskPaths(p, "task-r20-1").taskJson, "utf8"));
	const node = task.nodes.implement;

	console.log("  R20-S1 results:");
	console.log("    evaluator outcome:", out.r ?? "MISSING_HELPER");
	console.log("    worker.artifact_progress_no_status_update (C-R20-1):", traceCount);
	console.log("    worker.artifact_progress_cap_exceeded (C-R20-2):", capTraceCount);
	console.log("    worker-a mailbox count (C-R20-3):", mailboxCount);
	console.log("    node.artifactProgressNudgeAt (C-R20-5):", node.artifactProgressNudgeAt);
	console.log("    node.artifactProgressNudgeCount (C-R20-6):", node.artifactProgressNudgeCount);
	console.log("    writeState called (C-R20-7):", Boolean(out.s));

	// C-R20-1: trace must fire
	ok("C-R20-1: worker.artifact_progress_no_status_update trace >= 1", traceCount >= 1, `got=${traceCount}`);
	// C-R20-3: deliverMessageLocked landed in mailbox
	ok("C-R20-3: mailbox message for worker-a >= 1", mailboxCount >= 1, `got=${mailboxCount}`);
	// C-R20-5: node.artifactProgressNudgeAt stamped
	ok("C-R20-5: node.artifactProgressNudgeAt stamped", Boolean(node.artifactProgressNudgeAt), `got=${node.artifactProgressNudgeAt}`);
	// C-R20-6: node.artifactProgressNudgeCount incremented to 1
	ok("C-R20-6: node.artifactProgressNudgeCount === 1", node.artifactProgressNudgeCount === 1, `got=${node.artifactProgressNudgeCount}`);
	// C-R20-7: writeState fired
	ok("C-R20-7: writeState called (state persisted)", Boolean(out.s));
	// C-R20-8: body contains the close-action triple
	const mailboxMessages = await readMailboxMessages(p, "worker-a");
	const body = mailboxMessages[mailboxMessages.length - 1]?.body ?? "";
	ok("C-R20-8: body contains swarm_update_task", body.includes("swarm_update_task"), "no update_task in body");
	ok("C-R20-8: body contains swarm_send_message", body.includes("swarm_send_message"), "no send_message in body");
	ok("C-R20-8: body contains swarm_ack_message", body.includes("swarm_ack_message"), "no ack_message in body");
	ok("C-R20-8: body contains replyTo placeholder", body.includes("replyTo="), "no replyTo placeholder in body");
	await rm(dir, { recursive: true, force: true });
}

// ===== SCENARIO R20-S2: no nudge when up-to-date =====
console.log("\n=== R20-S2: node.lastProgressAt >= file mtime → no nudge ===");
{
	const { dir, p } = await buildScratchDir();
	const nowMs = Date.now();
	const oneMinAgo = new Date(nowMs - 60_000).toISOString();
	await seedState(p, dir, {
		agents: { "worker-a": { activeTaskIds: ["task-r20-2"], lastToolAt: oneMinAgo } },
	});
	await writeTaskWithAllowedFile(p, dir, {
		taskId: "task-r20-2",
		allowedFiles: ["extensions/swarm/src/reconcile.ts"],
		status: "in_progress",
		nodes: { implement: { assignee: "worker-a", status: "assigned", lastProgressAt: oneMinAgo } },
		writeArtifactNow: true,
	});
	// Set the file's mtime equal to lastProgressAt so the predicate is FALSE
	const filePath = join(dir, "extensions/swarm/src/reconcile.ts");
	await utimes(filePath, new Date(nowMs - 60_000), new Date(nowMs - 60_000));
	await writeFile(p.events, "");

	const out = await runEvaluator(p, dir, nowMs, null);
	const traceCount = await countEvents(p, "worker.artifact_progress_no_status_update");
	const mailboxCount = await mailboxMessageCount(p, "worker-a");
	console.log("  R20-S2 results: trace=", traceCount, "mailbox=", mailboxCount);
	ok("R20-S2: no nudge when up-to-date", traceCount === 0, `got=${traceCount}`);
	ok("R20-S2: no mailbox delivery when up-to-date", mailboxCount === 0, `got=${mailboxCount}`);
	await rm(dir, { recursive: true, force: true });
}

// ===== SCENARIO R20-S3: backoff dedupe =====
console.log("\n=== R20-S3: 3 ticks within backoff window → only 1 nudge ===");
{
	const { dir, p } = await buildScratchDir();
	const baseMs = Date.now();
	const fiveMinAgo = new Date(baseMs - 5 * 60_000).toISOString();
	const twoMinAgo = new Date(baseMs - 2 * 60_000).toISOString();
	await seedState(p, dir, {
		agents: { "worker-a": { activeTaskIds: ["task-r20-3"], lastToolAt: twoMinAgo } },
	});
	await writeTaskWithAllowedFile(p, dir, {
		taskId: "task-r20-3",
		allowedFiles: ["extensions/swarm/src/reconcile.ts"],
		status: "in_progress",
		nodes: { implement: { assignee: "worker-a", status: "assigned", lastProgressAt: fiveMinAgo } },
		writeArtifactNow: true,
	});
	await writeFile(p.events, "");

	// Run 3 ticks within the backoff window (200ms each)
	const results = [];
	for (let i = 0; i < 3; i++) {
		const nowMs = baseMs + (i + 1) * 100;
		const out = await runEvaluator(p, dir, nowMs, null);
		results.push({ tick: i, nowMs, out: out.r });
	}
	const traceCount = await countEvents(p, "worker.artifact_progress_no_status_update");
	const mailboxCount = await mailboxMessageCount(p, "worker-a");
	console.log("  R20-S3 results: trace=", traceCount, "mailbox=", mailboxCount, "ticks=", results.map(r => r.tick).join(","));
	ok("R20-S3: only 1 nudge across 3 backoff ticks (C-R20-1)", traceCount === 1, `got=${traceCount}`);
	ok("R20-S3: only 1 mailbox delivery (C-R20-3)", mailboxCount === 1, `got=${mailboxCount}`);
	await rm(dir, { recursive: true, force: true });
}

// ===== SCENARIO R20-S4: cap exceeded (RED) =====
console.log("\n=== R20-S4: 5 fires across 3 cap windows → 3 nudges + 1 cap-exceeded escalation ===");
{
	const { dir, p } = await buildScratchDir();
	const baseMs = Date.now();
	const fiveMinAgo = new Date(baseMs - 5 * 60_000).toISOString();
	const twoMinAgo = new Date(baseMs - 2 * 60_000).toISOString();
	await seedState(p, dir, {
		agents: { "worker-a": { activeTaskIds: ["task-r20-4"], lastToolAt: twoMinAgo } },
	});
	await writeTaskWithAllowedFile(p, dir, {
		taskId: "task-r20-4",
		allowedFiles: ["extensions/swarm/src/reconcile.ts"],
		status: "in_progress",
		nodes: { implement: { assignee: "worker-a", status: "assigned", lastProgressAt: fiveMinAgo } },
		writeArtifactNow: true,
	});
	const filePath = join(dir, "extensions/swarm/src/reconcile.ts");
	await writeFile(p.events, "");

	// Fire 5 times, refreshing file mtime before each fire so the artifact-progress predicate
	// remains true (a worker would keep writing new artifacts). Backoff=200ms (env) ensures
	// each subsequent fire lands past the previous nudge's timestamp + grace.
	const fireTimes = [baseMs + 100, baseMs + 400, baseMs + 700, baseMs + 1000, baseMs + 1300];
	for (let i = 0; i < fireTimes.length; i++) {
		// Re-touch the file to a fresh mtime just before fireTime: simulates a worker writing
		// a fresh artifact between nudges. The mtime lands just before the prior nudge's
		// artifactProgressNudgeAt so the artifact-progress predicate (maxMtimeMs > baselineMs +
		// graceMs) flips TRUE again.
		await utimes(filePath, new Date(fireTimes[i] - 50), new Date(fireTimes[i] - 50));
		const out = await runEvaluator(p, dir, fireTimes[i], null);
	}
	const nudgeTrace = await countEvents(p, "worker.artifact_progress_no_status_update");
	const capTrace = await countEvents(p, "worker.artifact_progress_cap_exceeded");
	console.log("  R20-S4 results: nudges=", nudgeTrace, "cap_escalations=", capTrace);
	ok("R20-S4: exactly 3 nudges fired before cap (C-R20-1)", nudgeTrace === 3, `got=${nudgeTrace}`);
	ok("R20-S4: 1 worker.artifact_progress_cap_exceeded escalation (C-R20-2)", capTrace === 1, `got=${capTrace}`);
	await rm(dir, { recursive: true, force: true });
}

// ===== SCENARIO R20-S5: active agent no-noise =====
console.log("\n=== R20-S5: agent.lastToolAt < 60s ago → no nudge ===");
{
	const { dir, p } = await buildScratchDir();
	const nowMs = Date.now();
	const fiveMinAgo = new Date(nowMs - 5 * 60_000).toISOString();
	const fiveSecAgo = new Date(nowMs - 5_000).toISOString();
	await seedState(p, dir, {
		agents: { "worker-a": { activeTaskIds: ["task-r20-5"], lastToolAt: fiveSecAgo } },
	});
	await writeTaskWithAllowedFile(p, dir, {
		taskId: "task-r20-5",
		allowedFiles: ["extensions/swarm/src/reconcile.ts"],
		status: "in_progress",
		nodes: { implement: { assignee: "worker-a", status: "assigned", lastProgressAt: fiveMinAgo } },
		writeArtifactNow: true,
	});
	await writeFile(p.events, "");

	const out = await runEvaluator(p, dir, nowMs, null);
	const traceCount = await countEvents(p, "worker.artifact_progress_no_status_update");
	const mailboxCount = await mailboxMessageCount(p, "worker-a");
	console.log("  R20-S5 results: trace=", traceCount, "mailbox=", mailboxCount);
	ok("R20-S5: no nudge when agent.lastToolAt < 60s", traceCount === 0, `got=${traceCount}`);
	ok("R20-S5: no mailbox delivery when active", mailboxCount === 0, `got=${mailboxCount}`);
	await rm(dir, { recursive: true, force: true });
}

// ===== SCENARIO R20-S6: multi-agent — only completed_unverified agent is the nudge target =====
console.log("\n=== R20-S6: multi-agent — only completed_unverified agent gets the nudge ===");
{
	const { dir, p } = await buildScratchDir();
	const nowMs = Date.now();
	const fiveMinAgo = new Date(nowMs - 5 * 60_000).toISOString();
	const twoMinAgo = new Date(nowMs - 2 * 60_000).toISOString();
	const tenSecAgo = new Date(nowMs - 10_000).toISOString(); // active worker (lastToolAt < 60s)
	await seedState(p, dir, {
		agents: {
			"worker-a": { activeTaskIds: ["task-r20-6"], lastToolAt: twoMinAgo }, // completed_unverified candidate
			"worker-b": { activeTaskIds: ["task-r20-6"], lastToolAt: tenSecAgo, runtimeStatus: "busy" }, // ACTIVE worker (lastToolAt < 60s ago)
		},
	});
	await writeTaskWithAllowedFile(p, dir, {
		taskId: "task-r20-6",
		allowedFiles: ["extensions/swarm/src/reconcile.ts"],
		status: "in_progress",
		nodes: {
			implement: { assignee: "worker-a", status: "assigned", lastProgressAt: fiveMinAgo },
			review: { assignee: "worker-b", status: "in_progress", lastProgressAt: fiveMinAgo, dependsOn: ["implement"] },
		},
		writeArtifactNow: true,
	});
	await writeFile(p.events, "");

	const out = await runEvaluator(p, dir, nowMs, null);
	const traceCount = await countEvents(p, "worker.artifact_progress_no_status_update");
	const aMailbox = await mailboxMessageCount(p, "worker-a");
	const bMailbox = await mailboxMessageCount(p, "worker-b");
	console.log("  R20-S6 results: trace=", traceCount, "worker-a mailbox=", aMailbox, "worker-b mailbox=", bMailbox);
	ok("R20-S6: at least 1 nudge fired (worker-a is completed_unverified)", traceCount >= 1, `got=${traceCount}`);
	ok("R20-S6: worker-a gets the nudge", aMailbox >= 1, `got=${aMailbox}`);
	ok("R20-S6: worker-b (active: lastToolAt < 60s) does not get a duplicate nudge", bMailbox === 0, `got=${bMailbox}`);
	await rm(dir, { recursive: true, force: true });
}

// ===== SUMMARY =====
console.log(`\n---`);
console.log(`R20 artifact-progress-nudge results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
