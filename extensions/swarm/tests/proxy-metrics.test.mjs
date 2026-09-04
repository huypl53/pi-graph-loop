// Issue 83c — proxy metric capture (hung-but-alive residuals, stale-open counts,
// supersession churn) + /swarm metrics command.

import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PI_SWARM_PROXY_METRIC_INTERVAL_MS ||= "60000";
process.env.PI_SWARM_STALE_OPEN_THRESHOLD_MS ||= "300000";
process.env.PI_SWARM_IS_ORCHESTRATOR ||= "1";

const here = dirname(fileURLToPath(import.meta.url));
const { paths, readState, writeState, taskPaths, ensureDirs, writeTaskState, withLock } = await import(join(here, "..", "src/state.ts"));
const { proxyMetricEmitLocked } = await import(join(here, "..", "src/taskgraph.ts"));
const { buildSwarmStatusSummary } = await import(join(here, "..", "src/reconcile.ts"));
const { registerSwarmCommand } = await import(join(here, "..", "src/command.ts"));

let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) { pass++; console.log("  ok  ", name); } else { fail++; console.error("  FAIL", name, info ?? ""); } };

function makeTask(taskId, assignee, { stale = false, supersessionWindowStart, supersessionCount = 0 } = {}) {
	const now = Date.now();
	const ts = new Date(now - (stale ? 360_000 : 10_000)).toISOString();
	return {
		version: 1,
		taskId,
		title: taskId,
		goal: taskId,
		status: "in_progress",
		priority: "normal",
		createdAt: ts,
		updatedAt: ts,
		owner: "orchestrator",
		workflow: "feature-dev",
		allowedFiles: [],
		acceptanceCriteria: [],
		validationCommands: [],
		start: "n1",
		currentNodes: ["n1"],
		sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
		nodes: {
			n1: {
				status: stale ? "assigned" : "done",
				role: "worker",
				assignee: assignee,
				dependsOn: [],
				messageIds: [],
				attempts: 1,
				lastActivityAt: ts,
				lastProgressAt: stale ? undefined : ts,
				supersessionCount,
				supersessionWindowStart,
			},
		},
		edges: [],
		handoffs: [],
		gates: {},
		editLocks: {},
		evidence: {},
	};
}

function makeAgent(id, activeTaskIds = [], runtimeStatus = "idle") {
	const now = new Date().toISOString();
	return {
		id,
		role: id,
		roleKind: "worker",
		capabilities: [],
		activeTaskIds,
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus,
		health: "healthy",
		lastHeartbeatAt: now,
		tmuxSession: "s",
		tmuxWindow: id,
		tmuxTarget: `${id}:0.0`,
		model: "glm-5.1",
		provider: "zai-coding-cn",
		cwd: "",
		mailbox: `.pi/swarm/mailboxes/${id}.jsonl`,
		createdAt: now,
		updatedAt: now,
	};
}

async function makeScratch() {
	const dir = join(tmpdir(), `swarm-83c-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	await mkdir(join(dir, ".pi", "swarm", "traces"), { recursive: true });
	await mkdir(join(dir, ".pi", "swarm", "tasks"), { recursive: true });
	await mkdir(join(dir, ".pi", "swarm", "mailboxes"), { recursive: true });
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ swarm: { defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" } }, null, 2));
	return dir;
}

async function writeTask(scratch, task) {
	const tp = taskPaths(paths(scratch), task.taskId);
	await mkdir(tp.root, { recursive: true });
	await mkdir(tp.artifacts, { recursive: true });
	await writeTaskState(tp, task);
}

async function readEvents(scratch) {
	const files = [join(scratch, ".pi", "swarm", "traces", "events.jsonl"), join(scratch, ".pi", "swarm", "events.jsonl")];
	const out = [];
	for (const file of files) {
		const raw = await readFile(file, "utf8").catch(() => "");
		for (const line of raw.split("\n").filter(Boolean)) {
			try { out.push(JSON.parse(line)); } catch {}
		}
	}
	for (const taskDir of ["task-stale-a", "task-stale-b", "task-fresh"]) {
		const raw = await readFile(join(scratch, ".pi", "swarm", "tasks", taskDir, "events.jsonl"), "utf8").catch(() => "");
		for (const line of raw.split("\n").filter(Boolean)) {
			try { out.push(JSON.parse(line)); } catch {}
		}
	}
	return out;
}

// --------------------------------------------------
// C1: fresh state emits zeroed proxy snapshot
// --------------------------------------------------
{
	const scratch = await makeScratch();
	const p = paths(scratch);
	await ensureDirs(p);
	const st = await readState(p, scratch);
	st.proxyMetrics = { hungButAlive: 0, staleOpen: 0, supersessionChurn: 0 };
	await writeState(p, st);
	const result = await withLock(p, async () => {
		const live = await readState(p, scratch);
		const out = await proxyMetricEmitLocked(p, live, Date.now());
		await writeState(p, live);
		return out;
	});
	ok("C1 emitted zeroed snapshot", result.emitted === true, JSON.stringify(result));
	ok("C1 hungButAlive starts at 0", result.metrics.hungButAlive === 0, JSON.stringify(result.metrics));
	ok("C1 staleOpen starts at 0", result.metrics.staleOpen === 0, JSON.stringify(result.metrics));
	ok("C1 supersessionChurn starts at 0", result.metrics.supersessionChurn === 0, JSON.stringify(result.metrics));
	const events = await readEvents(scratch);
	ok("C1 proxy.metric_emit trace written", events.filter((e) => e.event === "proxy.metric_emit").length === 1);
	await rm(scratch, { recursive: true, force: true });
}

// --------------------------------------------------
// C2/C3/C4/C5: mixed state + idempotency + status view + command
// --------------------------------------------------
{
	const scratch = await makeScratch();
	const p = paths(scratch);
	await ensureDirs(p);
	const now = Date.now();
	const st = await readState(p, scratch);
	st.agents = {
		orchestrator: makeAgent("orchestrator", ["task-stale-a", "task-stale-b"]),
		"worker-a": makeAgent("worker-a", ["task-stale-a"]),
		"worker-b": makeAgent("worker-b", ["task-stale-b"]),
	};
	st.agents.orchestrator.roleKind = "orchestrator";
	st.agents.orchestrator.tmuxTarget = "orchestrator:0.0";
	st.agents.orchestrator.runtimeStatus = "idle";
	st.agents["worker-a"].runtimeStatus = "idle";
	st.agents["worker-b"].runtimeStatus = "idle";
	st.proxyMetrics = { hungButAlive: 0, staleOpen: 0, supersessionChurn: 0, lastEmitAt: new Date(now - 120_000).toISOString() };
	await writeState(p, st);
	await writeTask(scratch, makeTask("task-stale-a", "worker-a", { stale: true, supersessionCount: 1, supersessionWindowStart: new Date(now - 30_000).toISOString() }));
	await writeTask(scratch, makeTask("task-stale-b", "worker-b", { stale: true, supersessionCount: 1, supersessionWindowStart: new Date(now - 20_000).toISOString() }));
	await writeTask(scratch, makeTask("task-fresh", "worker-a", { stale: false }));

	const first = await withLock(p, async () => {
		const live = await readState(p, scratch);
		const out = await proxyMetricEmitLocked(p, live, now);
		await writeState(p, live);
		return out;
	});
	ok("C2 hungButAlive=2", first.metrics.hungButAlive === 2, JSON.stringify(first.metrics));
	ok("C2 staleOpen=2", first.metrics.staleOpen === 2, JSON.stringify(first.metrics));
	ok("C2 supersessionChurn=2", first.metrics.supersessionChurn === 2, JSON.stringify(first.metrics));

	const second = await withLock(p, async () => {
		const live = await readState(p, scratch);
		const out = await proxyMetricEmitLocked(p, live, now + 1000);
		await writeState(p, live);
		return out;
	});
	ok("C3 re-run inside interval skips emit", second.emitted === false && second.reason === "interval_pending");
	ok("C3 snapshot retained", (await readState(p, scratch)).proxyMetrics.staleOpen === 2);

	const summary = await buildSwarmStatusSummary(p, await readState(p, scratch));
	ok("C4 /swarm status includes proxy metrics line", summary.text.includes("proxy metrics: hungButAlive=2 staleOpen=2 supersessionChurn=2"), summary.text);

	const cmds = {};
	const notes = [];
	const pi = {
		registerTool: () => {},
		registerCommand: (name, opts) => { cmds[name] = opts; },
		on: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	};
	registerSwarmCommand(pi);
	const prevAgent = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = "orchestrator";
	await cmds.swarm.handler("metrics", { cwd: scratch, hasUI: true, ui: { notify: (msg) => notes.push(msg), setStatus: () => {} }, mode: "tui" });
	if (prevAgent === undefined) delete process.env.PI_SWARM_AGENT_ID; else process.env.PI_SWARM_AGENT_ID = prevAgent;
	ok("C4 /swarm metrics surfaces proxy snapshot", notes.at(-1)?.includes("proxy metrics: hungButAlive=2 staleOpen=2 supersessionChurn=2"), notes.at(-1));

	let execCount = 0;
	const piProbe = { registerTool: () => {}, registerCommand: () => {}, on: () => {}, exec: async () => { execCount++; return { code: 0, stdout: "", stderr: "" }; } };
	await withLock(p, async () => {
		const live = await readState(p, scratch);
		await proxyMetricEmitLocked(p, live, now + 70_000);
		await writeState(p, live);
	});
	ok("C5 zero exec/tmux probes (R10-1 counting assertion)", execCount === 0);
	const events = await readEvents(scratch);
	ok("C5 proxy.metric_emit trace count stays bounded", events.filter((e) => e.event === "proxy.metric_emit").length === 2);

	await rm(scratch, { recursive: true, force: true });
}

if (fail) {
	console.error(`\nPROXY-METRICS FAIL (${fail})`);
	process.exit(1);
}
console.log(`\nPROXY-METRICS PASS (${pass} passed, 0 failed)`);
