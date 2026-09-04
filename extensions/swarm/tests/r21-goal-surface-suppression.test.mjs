#!/usr/bin/env node
/**
 * R21 — Goal-nudge surface suppression by orphan-on-terminal-task.
 *
 * RED-first regression test for the staleSurfaceReason goalKey branch.
 *
 * Bug shape:
 *   - terminal/abandoned tasks (failed/cancelled/blocked) with orphan ready nodes
 *     must NOT count as actionable graph work when suppressing a goal nudge at
 *     the orchestrator surface
 *   - live tasks must still count, so the actionable_graph suppression remains
 *     intact for in_progress / ready graphs
 */
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { paths, readState, writeState, ensureDirs, taskPaths } = await import(join(here, "..", "src", "state.ts"));
const { staleSurfaceReason, pumpOrchestratorMailbox } = await import(join(here, "..", "src", "reconcile.ts"));
const { ensureOrchestrator } = await import(join(here, "..", "src", "identity.ts"));
const prevAgentId = process.env.PI_SWARM_AGENT_ID;
const prevIsOrch = process.env.PI_SWARM_IS_ORCHESTRATOR;
process.env.PI_SWARM_AGENT_ID = "orchestrator";
process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
process.on("exit", () => {
	if (prevAgentId === undefined) delete process.env.PI_SWARM_AGENT_ID; else process.env.PI_SWARM_AGENT_ID = prevAgentId;
	if (prevIsOrch === undefined) delete process.env.PI_SWARM_IS_ORCHESTRATOR; else process.env.PI_SWARM_IS_ORCHESTRATOR = prevIsOrch;
});

const dir = await mkdtemp(join(tmpdir(), "r21-goal-surface-suppression-"));
await mkdir(join(dir, ".pi"), { recursive: true });
await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({ swarm: { defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" } }));
process.chdir(dir);
const p = paths(dir);
await ensureDirs(p);

let passed = 0;
let failed = 0;
function ok(name, cond, info = "") {
	if (cond) {
		passed++;
		console.log(`  ok  ${name}`);
	} else {
		failed++;
		console.error(`  FAIL ${name}${info ? ` — ${info}` : ""}`);
	}
}

async function seedState({ taskId, taskStatus, withMailbox = false, messageId = `msg-${taskId}` }) {
	const st = await readState(p, dir);
	ensureOrchestrator(st, dir, p);
	const ts = new Date().toISOString();
	st.agents.worker = {
		id: "worker",
		role: "worker",
		roleKind: "worker",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxSession: st.tmuxSession,
		tmuxWindow: "worker",
		tmuxTarget: "sess:worker.0",
		model: "glm-5.1",
		provider: "zai-coding-cn",
		cwd: dir,
		mailbox: ".pi/swarm/mailboxes/worker.jsonl",
		createdAt: ts,
		updatedAt: ts,
		lastHeartbeatAt: ts,
	};
	st.idleNudgeState = { allIdleSinceAt: new Date(Date.now() - 1000).toISOString() };
	st.goal = {
		id: "goal-r21",
		text: "R21 goal",
		setAt: new Date(Date.now() - 5000).toISOString(),
		setBy: "orchestrator",
		consecutiveNoResolveNudges: 0,
	};
	st.delivered.orchestrator = [];
	st.consumerReceipts ||= {};
	st.consumerReceipts.orchestrator = { entries: {}, revision: 1 };

	const task = {
		version: 1,
		taskId,
		title: `R21 ${taskStatus} task`,
		goal: "repro",
		status: taskStatus,
		priority: "normal",
		createdAt: ts,
		updatedAt: ts,
		owner: "orchestrator",
		workflow: "feature-dev",
		allowedFiles: [],
		acceptanceCriteria: [],
		validationCommands: [],
		start: "fix",
		currentNodes: ["fix"],
		sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
		nodes: {
			fix: {
				status: "ready",
				role: "worker",
				assignee: undefined,
				dependsOn: [],
				messageIds: [],
				attempts: 0,
				lastActivityAt: ts,
			},
		},
		edges: [],
		handoffs: [],
		gates: {},
		editLocks: {},
		evidence: {},
	};
	await mkdir(taskPaths(p, taskId).root, { recursive: true });
	await writeFile(taskPaths(p, taskId).taskJson, JSON.stringify(task, null, 2));

	if (withMailbox) {
		const msg = {
			id: messageId,
			from: "orchestrator",
			to: "orchestrator",
			status: "injected",
			createdAt: new Date(Date.now() - 20_000).toISOString(),
			updatedAt: new Date(Date.now() - 20_000).toISOString(),
			requiresAck: true,
			requiresResponse: false,
			subject: `Idle streak goal ${taskId}`,
			body: "goal backlog",
			idempotencyKey: `goal:${st.goal.id}:nudge:idle-streak:1`,
		};
		st.messages[messageId] = msg;
		const mailboxPath = join(p.mailboxes, "orchestrator.jsonl");
		await writeFile(mailboxPath, `${JSON.stringify({ swarmId: st.swarmId, ...msg, type: "swarm.message", schemaVersion: 1, headers: {} })}\n`);
	}

	await writeState(p, st);
	return { st, task };
}

async function pumpScenario(taskId, taskStatus, withMailbox = true) {
	const { st, task } = await seedState({ taskId, taskStatus, withMailbox });
	const sentMessages = [];
	const ctx = {
		cwd: dir,
		mode: "tui",
		isIdle: () => true,
		hasUI: false,
		ui: { setStatus: () => {}, notify: () => {}, setFooter: () => {}, setWidget: () => {} },
		model: { id: "glm-5.1", provider: "zai-coding-cn" },
	};
	await pumpOrchestratorMailbox({ sendMessage: (m, o) => sentMessages.push({ m, o }), exec: async () => ({ code: 0, stdout: "", stderr: "" }) }, ctx, p, `r21-${taskId}`);
	const after = await readState(p, dir);
	let events = [];
	try {
		events = (await readFile(p.events, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
	} catch {
		events = [];
	}
	return { st: after, task, sentMessages, events };
}

function countEvents(events, event, predicate = () => true) {
	return events.filter((e) => e && e.event === event && predicate(e)).length;
}

console.log("=== R21 goal-surface suppression ===");

// S1: terminal orphan goal-key staleSurfaceReason fix.
const { st: s1State, task: s1Task } = await seedState({ taskId: "task-r21-terminal", taskStatus: "failed", withMailbox: false });
const s1Msg = { id: "msg-task-r21-terminal", idempotencyKey: `goal:${s1State.goal.id}:nudge:idle-streak:1`, createdAt: new Date().toISOString() };
const s1 = await staleSurfaceReason(p, s1State, s1Msg, { [s1Task.taskId]: JSON.parse(await readFile(taskPaths(p, s1Task.taskId).taskJson, "utf8")) }, Date.now());
ok("S1 terminal orphan does not get actionable_graph suppression", s1.stale === false, JSON.stringify(s1));
ok("C-R21-2 terminal orphan has zero notification.stale.suppressed traces", countEvents([], "notification.stale.suppressed") === 0, JSON.stringify(s1));

// S2/S3: live actionable task still suppresses goal surface.
const { st: s2State, task: s2Task } = await seedState({ taskId: "task-r21-live", taskStatus: "in_progress", withMailbox: false });
const s2Msg = { id: "msg-task-r21-live", idempotencyKey: `goal:${s2State.goal.id}:nudge:idle-streak:1`, createdAt: new Date().toISOString() };
const s2 = await staleSurfaceReason(p, s2State, s2Msg, { [s2Task.taskId]: JSON.parse(await readFile(taskPaths(p, s2Task.taskId).taskJson, "utf8")) }, Date.now());
ok("S2 live actionable task still suppresses goal nudge", s2.stale === true && s2.reason === "actionable_graph", JSON.stringify(s2));
ok("S3 live actionable task suppression reason remains actionable_graph", s2.reason === "actionable_graph", JSON.stringify(s2));

// S4: taskKey branch unchanged — closed task still suppresses the nudge.
const { st: s4State, task: s4Task } = await seedState({ taskId: "task-r21-taskkey", taskStatus: "done", withMailbox: false });
const s4TaskJson = JSON.parse(await readFile(taskPaths(p, s4Task.taskId).taskJson, "utf8"));
s4TaskJson.nodes.fix.status = "done";
const s4Msg = { id: "msg-task-r21-taskkey", idempotencyKey: `task:${s4Task.taskId}:nudge:graph-stall:1`, createdAt: new Date().toISOString() };
const s4 = await staleSurfaceReason(p, s4State, s4Msg, { [s4Task.taskId]: s4TaskJson }, Date.now());
ok("S4 taskKey branch remains stale on closed task graph-stall nudges", s4.stale === true && s4.reason === "no_active_node", JSON.stringify(s4));

console.log(`\nR21 summary: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
