#!/usr/bin/env node
/**
 * nudge-closure-race.test.mjs — Fix C red→green (task-202610031339)
 *
 * RED: when node.status transitions to terminal (done|failed|skipped) between the sweep's
 * snapshot/stat phase and nudge delivery, no nudge may be sent — the delivery path must
 * re-read task.json from disk (under the caller's lock) before sending.
 *
 * Determinism: interpose on fs/promises.stat (module-bound import in artifact-progress.ts is
 * NOT patchable, so we patch the fs/promises module default export? No — the source imports
 * { stat } from "node:fs/promises", which resolves per-module; instead we exploit the source's
 * own await point: seed the file so the first stat triggers the closure write via a patched
 * globalThis-side effect... Simplest reliable lane: monkey-patch fs/promises.stat BEFORE the
 * dynamic import of artifact-progress.ts, so the source module binds our wrapper.
 */

import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// CRITICAL: fs.promises.stat must be patched BEFORE any node:fs/promises import anywhere in this
// process — the first fs/promises import freezes the per-loader binding to the ORIGINAL function,
// and later static imports in stripped-.ts modules bind to that original (Node 26 behavior).
// So we patch here via node:fs only, then re-export fs/promises helpers through the patched
// facade. All fs/promises usage below goes through the `fsp` proxy.
import fs from "node:fs";
const origPromisesStat = fs.promises.stat.bind(fs.promises);
let closureWritten = false;
let closureNodeId = null;
let closureStatus = "done";
let closureTaskPath = null;
Object.defineProperty(fs.promises, "stat", {
	value: async (path, opts) => {
		const s = await origPromisesStat(path, opts);
		if (!closureWritten && closureTaskPath && String(path).includes("widget.ts")) {
			closureWritten = true;
			// Simulate the worker closing the node mid-sweep (between snapshot stat and delivery).
			const task = JSON.parse(await readFile(closureTaskPath, "utf8"));
			task.nodes[closureNodeId].status = closureStatus;
			task.nodes[closureNodeId].outcome = "passed";
			await writeFile(closureTaskPath, JSON.stringify(task, null, 2));
		}
		return s;
	},
	configurable: true,
});
const fsp = await import("node:fs/promises");
const mkdtemp = fsp.mkdtemp, mkdir = fsp.mkdir, writeFile = fsp.writeFile, rm = fsp.rm, readFile = fsp.readFile, utimes = fsp.utimes;

process.env.PI_SWARM_ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS ||= "200";
process.env.PI_SWARM_ARTIFACT_PROGRESS_NUDGE_CAP ||= "3";
process.env.PI_SWARM_ARTIFACT_PROGRESS_GRACE_MS ||= "60";
process.env.PI_SWARM_ARTIFACT_PROGRESS_MAX_FILES ||= "50";

const here = dirname(fileURLToPath(import.meta.url));

const { paths, readState, withLock, writeState, taskPaths, ensureDirs } = await import(join(here, "..", "src", "state.ts"));
const { evaluateArtifactProgressNudgeLocked } = await import(join(here, "..", "src", "nudges", "artifact-progress.ts"));
const { ensureRoot } = await import(join(here, "..", "src", "identity.ts"));

const pi = { sendMessage: async () => {}, sendUserMessage: async () => {}, registerTool: () => {}, registerCommand: () => {}, on: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }) };

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

async function readMailboxMessages(p, agentId) {
	try {
		const raw = await readFile(join(p.mailboxes, `${agentId}.jsonl`), "utf8");
		return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

async function buildScratch() {
	const dir = await mkdtemp(join(tmpdir(), "fixc-"));
	await mkdir(join(dir, ".pi"), { recursive: true });
	process.chdir(dir);
	const p = paths(dir);
	await ensureDirs(p);
	return { dir, p };
}

async function seed(p, dir, taskId) {
	const st = await readState(p, dir);
	ensureRoot(st, dir, p);
	const nowMs = Date.now();
	const nowIso = new Date(nowMs).toISOString();
	st.agents["worker-a"] = {
		id: "worker-a", role: "implementer", roleKind: "worker", capabilities: [], activeTaskIds: [taskId],
		maxConcurrentTasks: 1, status: "running", runtimeStatus: "idle", health: "healthy",
		tmuxSession: st.tmuxSession, tmuxWindow: "worker-a", tmuxTarget: "s:0", model: "m", provider: "p",
		cwd: dir, mailbox: ".pi/swarm/mailboxes/worker-a.jsonl", lastHeartbeatAt: nowIso,
		lastToolAt: new Date(nowMs - 120_000).toISOString(), lastAgentSettledAt: nowIso, createdAt: nowIso, updatedAt: nowIso,
	};
	await writeState(p, st);
	const tp = taskPaths(p, taskId);
	await mkdir(tp.root, { recursive: true });
	const task = {
		version: 1, taskId, title: "t", goal: "g", status: "in_progress", priority: "normal",
		createdAt: nowIso, updatedAt: nowIso, owner: "root", workflow: "feature-dev", allowedFiles: ["src/widget.ts"],
		nodes: { implement: { status: "assigned", role: "implementer", assignee: "worker-a", dependsOn: [], allowedFiles: ["src/widget.ts"], messageIds: ["msg-1"], attempts: 1, assignmentMessageId: "msg-1", lastActivityAt: nowIso, lastProgressAt: new Date(nowMs - 300_000).toISOString() } },
		edges: [{ from: "implement", to: "review", when: "passed" }],
		currentNodes: ["implement"], sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] }, gates: {}, editLocks: {},
	};
	await writeFile(tp.taskJson, JSON.stringify(task, null, 2));
	const fp = join(dir, "src/widget.ts");
	await mkdir(dirname(fp), { recursive: true });
	await writeFile(fp, "x");
	await utimes(fp, new Date(nowMs - 30_000), new Date(nowMs - 30_000));
	return tp.taskJson;
}

async function runEvaluator(p, dir, nowMs) {
	return withLock(p, async () => {
		const s = await readState(p, dir);
		const r = await evaluateArtifactProgressNudgeLocked(pi, dir, p, s, nowMs);
		await writeState(p, s);
		return r;
	});
}

for (const terminalStatus of ["done", "failed", "skipped"]) {
	console.log(`\n=== FIX-C: node closes (${terminalStatus}) mid-sweep → no nudge ===`);
	{
		closureWritten = false;
		const { dir, p } = await buildScratch();
		const taskJsonPath = await seed(p, dir, `task-c-${terminalStatus}`);
		closureTaskPath = taskJsonPath;
		closureNodeId = "implement";
		closureStatus = terminalStatus;
		const r = await runEvaluator(p, dir, Date.now());
		// Allow the deferred closure write to flush before asserting on-disk state.
		await new Promise((res) => setTimeout(res, 20));
		const onDisk = JSON.parse(await readFile(taskJsonPath, "utf8"));
		const mailbox = await readMailboxMessages(p, "worker-a");
		const nudgeMail = mailbox.filter((m) => m.subject?.includes("ARTIFACT-PROGRESS"));
		console.log(`  evaluator:`, JSON.stringify(r), `closureWritten:`, closureWritten, `onDisk:`, onDisk.nodes.implement.status);
		ok(`${terminalStatus}: closure actually landed mid-sweep`, onDisk.nodes.implement.status === terminalStatus, onDisk.nodes.implement.status);
		ok(`${terminalStatus}: no nudge delivered despite closure`, nudgeMail.length === 0, `got=${nudgeMail.length}`);
		await rm(dir, { recursive: true, force: true });
	}
}

console.log(`\n---`);
console.log(`nudge-closure-race results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
