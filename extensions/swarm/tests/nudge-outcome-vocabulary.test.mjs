#!/usr/bin/env node
/**
 * nudge-outcome-vocabulary.test.mjs — Fix A red→green (task-202610031339-artifact-progress-nudge)
 *
 * RED: artifact-progress nudge body for a node whose outgoing edges are
 * (when=passed, when=failed) must advertise exactly those `when` values as the
 * `outcome=` vocabulary — never the generic list
 * planned|implemented|tested|reviewed|approved|rejected|failed.
 * Terminal / no-outgoing-edge nodes must fall back to a "see task.md edges" hint,
 * also never the generic list.
 */

import { mkdtemp, mkdir, writeFile, rm, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PI_SWARM_ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS ||= "200";
process.env.PI_SWARM_ARTIFACT_PROGRESS_NUDGE_CAP ||= "3";
process.env.PI_SWARM_ARTIFACT_PROGRESS_GRACE_MS ||= "60";
process.env.PI_SWARM_ARTIFACT_PROGRESS_MAX_FILES ||= "50";

const here = dirname(fileURLToPath(import.meta.url));
const { paths, readState, withLock, writeState, taskPaths, ensureDirs } = await import(join(here, "..", "src", "state.ts"));
const { evaluateArtifactProgressNudgeLocked } = await import(join(here, "..", "src", "nudges", "artifact-progress.ts"));
const { outgoingOutcomes } = await import(join(here, "..", "src", "taskgraph", "graph.ts"));
const { ensureRoot } = await import(join(here, "..", "src", "identity.ts"));
const { deliverMessageLocked } = await import(join(here, "..", "src", "mailbox.ts"));

// The stale generic vocabulary (must NEVER appear as the update-line outcome list)
const GENERIC = "planned|implemented|tested|reviewed|approved|rejected|failed";

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

const SAVED_AGENT_ID = process.env.PI_SWARM_AGENT_ID;
const SAVED_ORCH = process.env.PI_SWARM_IS_ROOT;
delete process.env.PI_SWARM_AGENT_ID;
process.env.PI_SWARM_IS_ROOT = "1";
process.on("exit", () => {
	if (SAVED_AGENT_ID === undefined) delete process.env.PI_SWARM_AGENT_ID;
	else process.env.PI_SWARM_AGENT_ID = SAVED_AGENT_ID;
	if (SAVED_ORCH === undefined) delete process.env.PI_SWARM_IS_ROOT;
	else process.env.PI_SWARM_IS_ROOT = SAVED_ORCH;
});

const pi = {
	sendMessage: async () => {},
	sendUserMessage: async () => {},
	registerTool: () => {},
	registerCommand: () => {},
	on: () => {},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};

async function readMailboxMessages(p, agentId) {
	try {
		const path = join(p.mailboxes, `${agentId}.jsonl`);
		const raw = await readFile(path, "utf8");
		return raw
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}

async function buildScratchDir(prefix) {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	await mkdir(join(dir, ".pi"), { recursive: true });
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({}));
	process.chdir(dir);
	const p = paths(dir);
	await ensureDirs(p);
	return { dir, p };
}

function makeAgentRecord(st, dir, id, overrides = {}) {
	const nowIso = new Date().toISOString();
	return {
		id,
		role: "implementer",
		roleKind: "worker",
		capabilities: [],
		activeTaskIds: overrides.activeTaskIds || [],
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxSession: st.tmuxSession,
		tmuxWindow: id,
		tmuxTarget: `sess:${id}.0`,
		model: "glm-5.1",
		provider: "zai-coding-cn",
		cwd: dir,
		mailbox: `.pi/swarm/mailboxes/${id}.jsonl`,
		lastHeartbeatAt: nowIso,
		lastToolAt: overrides.lastToolAt ?? nowIso,
		lastAgentSettledAt: nowIso,
		createdAt: nowIso,
		updatedAt: nowIso,
		...overrides,
	};
}

async function seedAgent(p, dir, id, activeTaskId, lastToolMsOffset) {
	const st = await readState(p, dir);
	ensureRoot(st, dir, p);
	st.agents[id] = makeAgentRecord(st, dir, id, {
		activeTaskIds: [activeTaskId],
		lastToolAt: new Date(Date.now() + (lastToolMsOffset ?? -120_000)).toISOString(),
	});
	await writeState(p, st);
	return st;
}

async function seedTask(p, dir, { taskId, edges, nodes, lastProgressAt }) {
	const tp = taskPaths(p, taskId);
	await mkdir(tp.root, { recursive: true });
	const nowMs = Date.now();
	const nowIso = new Date(nowMs).toISOString();
	const taskNodes = {};
	for (const [name, o] of Object.entries(nodes)) {
		taskNodes[name] = {
			status: o.status || "assigned",
			role: "implementer",
			assignee: o.assignee,
			dependsOn: o.dependsOn || [],
			allowedFiles: o.allowedFiles || ["src/widget.ts"],
			messageIds: ["msg-assign-1"],
			attempts: 1,
			assignmentMessageId: "msg-assign-1",
			lastActivityAt: nowIso,
			lastProgressAt: o.lastProgressAt ?? lastProgressAt,
		};
	}
	const task = {
		version: 1,
		taskId,
		title: "outcome-vocab test task",
		goal: "red test",
		status: "in_progress",
		priority: "normal",
		createdAt: new Date(nowMs - 3600_000).toISOString(),
		updatedAt: nowIso,
		owner: "root",
		workflow: "feature-dev",
		allowedFiles: ["src/widget.ts"],
		nodes: taskNodes,
		edges: edges || [],
		currentNodes: Object.keys(taskNodes),
		sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
		gates: {},
		editLocks: {},
	};
	await writeFile(tp.taskJson, JSON.stringify(task, null, 2));
	const filePath = join(dir, "src/widget.ts");
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, "// touched\n");
	await utimes(filePath, new Date(nowMs - 30_000), new Date(nowMs - 30_000));
	return task;
}

async function runEvaluator(p, dir, nowMs) {
	return withLock(p, async () => {
		const s = await readState(p, dir);
		const r = await evaluateArtifactProgressNudgeLocked(pi, dir, p, s, nowMs);
		await writeState(p, s);
		return r;
	});
}

async function lastNudgeBody(p, agentId) {
	const msgs = await readMailboxMessages(p, agentId);
	return msgs[msgs.length - 1]?.body ?? "";
}

// ===== S1: edges (when=passed, when=failed) → body advertises exactly those =====
console.log("\n=== FIX-A S1: edge when values become the outcome vocabulary ===");
{
	const { dir, p } = await buildScratchDir("fixa-s1-");
	const nowMs = Date.now();
	const fiveMinAgo = new Date(nowMs - 5 * 60_000).toISOString();
	await seedAgent(p, dir, "worker-a", "task-a1", -120_000);
	await seedTask(p, dir, {
		taskId: "task-a1",
		edges: [
			{ from: "implement", to: "review", when: "passed" },
			{ from: "implement", to: "fix", when: "failed", rework: true },
		],
		nodes: { implement: { assignee: "worker-a", lastProgressAt: fiveMinAgo } },
		lastProgressAt: fiveMinAgo,
	});

	const r = await runEvaluator(p, dir, nowMs);
	const body = await lastNudgeBody(p, "worker-a");
	console.log("  evaluator:", JSON.stringify(r));
	ok("S1: nudge delivered", body.includes("ARTIFACT-PROGRESS NUDGE"), "no nudge body found");
	ok("S1: body advertises outcome=passed", body.includes("outcome=<one of: passed|failed>"), body.slice(0, 300));
	ok("S1: body does NOT advertise any wrong-edge single value list", !body.includes("one of: passed|failed|implemented") && !body.includes(GENERIC), "wrong vocab");
	ok("S1: body does NOT contain the stale generic list", !body.includes(GENERIC), "generic list present");
	await rm(dir, { recursive: true, force: true });
}

// ===== S2: terminal / no-outgoing-edge node → hint fallback, never generic list =====
console.log("\n=== FIX-A S2: no outgoing edges → task.md hint fallback ===");
{
	const { dir, p } = await buildScratchDir("fixa-s2-");
	const nowMs = Date.now();
	const fiveMinAgo = new Date(nowMs - 5 * 60_000).toISOString();
	await seedAgent(p, dir, "worker-a", "task-a2", -120_000);
	await seedTask(p, dir, {
		taskId: "task-a2",
		edges: [],
		nodes: { implement: { assignee: "worker-a", lastProgressAt: fiveMinAgo } },
		lastProgressAt: fiveMinAgo,
	});

	const r = await runEvaluator(p, dir, nowMs);
	const body = await lastNudgeBody(p, "worker-a");
	ok("S2: nudge delivered", body.includes("ARTIFACT-PROGRESS NUDGE"), "no nudge body found");
	ok("S2: body carries the task.md edges hint", body.includes("see task.md edges"), body.slice(0, 200));
	ok("S2: body does NOT contain the stale generic list", !body.includes(GENERIC), "generic list present");
	await rm(dir, { recursive: true, force: true });
}

// ===== S3: outgoingOutcomes helper direct unit check =====
console.log("\n=== FIX-A S3: outgoingOutcomes() helper contract ===");
{
	const task = {
		nodes: { a: { status: "in_progress" }, b: { status: "done" } },
		edges: [
			{ from: "a", to: "b", when: "passed" },
			{ from: "a", to: "c", when: "failed", rework: true },
			{ from: "b", to: "d", when: "approved" },
		],
	};
	const outs = outgoingOutcomes(task, "a");
	ok("S3: returns unique when values in edge order", JSON.stringify(outs) === JSON.stringify(["passed", "failed"]), JSON.stringify(outs));
	ok("S3: empty for terminal node", outgoingOutcomes(task, "d").length === 0, JSON.stringify(outgoingOutcomes(task, "d")));
	ok("S3: empty for unknown node", outgoingOutcomes(task, "zzz").length === 0);
}

console.log(`\n---`);
console.log(`nudge-outcome-vocabulary results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
