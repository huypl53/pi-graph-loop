#!/usr/bin/env node
/**
 * Per-fixture scenario driver — extensions/mock-llm/fixtures/worker-identity-hints.jsonl
 *
 * Worker identity-hints lane. Asserts the two core-duty hints injected by
 * before_agent_start into the WORKER system prompt are present and actionable:
 *
 *   H1  injection text: the worker systemPrompt carries the identity line PLUS
 *       the swarm_update_task-with-evidence close-out hint and the
 *       swarm_send_message do-not-sit-silent hint (the 2026-10-13 tweak).
 *   H2  fixture replay: scripted turns capture the close-with-evidence
 *       swarm_update_task call and the blocked-follow-up swarm_send_message call.
 *   H3  real execution: the captured close lands against a scratch swarm tree
 *       (node n1 → done, evidence recorded) via the REAL swarm_update_task tool.
 *   H4  real execution: the captured blocked message lands in the root mailbox
 *       via the REAL swarm_send_message tool (do-not-sit-silent is deliverable,
 *       not just prose).
 *   H5  deterministic replay — second stream yields the identical captured sequence.
 *
 * Run: node extensions/mock-llm/tests/worker-identity-hints.test.mjs
 * RED mode (UAT_RED=1): asserts against the PRE-tweak wording ("Use swarm tools
 * for peer coordination." as the final sentence, no close-out/no anti-silence
 * hints) — the red artifact is H1 failing on the old prompt.
 */

import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const swarmRoot = join(here, "..", "..", "swarm");
const RED = process.env.UAT_RED === "1";
const STAMP =
	process.env.UAT_STAMP ||
	`uat-${new Date()
		.toISOString()
		.replace(/[-:.TZ]/g, "")
		.slice(0, 15)}`;
const RUN_DIR = process.env.UAT_RUN_DIR || join(process.cwd(), ".pi", "swarm-uat", "runs", STAMP, "worker-identity-hints");
mkdirSync(RUN_DIR, { recursive: true });

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info ?? "");
	}
};

// --- scratch + real extension wiring ---
const scratch = mkdtempSync(join(tmpdir(), `swarm-uat-hints-${process.pid}-${Date.now()}`));
process.env.PI_SWARM_AGENT_ID = "worker-hints";
delete process.env.PI_SWARM_IS_ROOT;

const pi = {
	registerTool: () => {},
	registerCommand: () => {},
	on: () => {},
	sendMessage: () => {},
	exec: async (cmd, args) => {
		if (cmd === "tmux") return { code: 0, stdout: "", stderr: "" };
		if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	},
};

// --- H1: the real before_agent_start worker injection carries both hints ---
const hookHandlers = {};
const hookPi = {
	...pi,
	on: (ev, handler) => {
		hookHandlers[ev] ||= [];
		hookHandlers[ev].push(handler);
	},
};
{
	const mod = await import(`${join(swarmRoot, "index.ts")}?h1=${Date.now()}-${Math.random()}`);
	mod.default(hookPi);
}
const { paths, ensureDirs, defaultState, writeState, readState } = await import(join(swarmRoot, "src", "state.ts"));
const p = paths(scratch);
await ensureDirs(p);
{
	const st = defaultState(scratch);
	const nowIso = new Date().toISOString();
	st.agents["worker-hints"] = {
		id: "worker-hints",
		role: "implementer",
		roleKind: "implementer",
		capabilities: [],
		activeTaskIds: ["task-uathints"],
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		lastHeartbeatAt: nowIso,
		lastSessionStartAt: nowIso,
		tmuxTarget: "uatsess:hints.0",
		mailbox: ".pi/swarm/mailboxes/worker-hints.jsonl",
		createdAt: nowIso,
		updatedAt: nowIso,
		cwd: scratch,
	};
	await writeState(p, st);
}
let injectedPrompt = "";
{
	const event = { systemPrompt: "You are a coding assistant with tool access." };
	const ctx = { cwd: scratch, mode: "tui", isIdle: () => true, hasUI: false, ui: { notify: () => {}, setStatus: () => {} } };
	for (const h of hookHandlers.before_agent_start || []) {
		const res = await h(event, ctx);
		if (res?.systemPrompt) injectedPrompt = res.systemPrompt;
	}
}
if (RED) {
	ok(
		"RED H1: pre-tweak wording — final sentence is the bare peer-coordination line (no hints)",
		/Use swarm tools for peer coordination\.\s*$/.test(injectedPrompt) && !injectedPrompt.includes("do not sit silent"),
		"the tweak is already present — RED mode expects the OLD prompt",
	);
} else {
	ok("H1a: identity line present", injectedPrompt.includes("Pi Swarm identity: you are agent `worker-hints`"));
	ok(
		"H1b: close-out hint (swarm_update_task + evidence)",
		injectedPrompt.includes("swarm_update_task") && /evidence/i.test(injectedPrompt),
	);
	ok(
		"H1c: anti-silence hint (swarm_send_message + do not sit silent)",
		injectedPrompt.includes("swarm_send_message") && injectedPrompt.includes("do not sit silent"),
	);
}
writeFileSync(join(RUN_DIR, "injected-system-prompt.txt"), injectedPrompt + "\n");

// --- seed the task the fixture's close targets ---
const TASK_ID = "task-uathints";
const taskDir = join(p.tasksDir, TASK_ID);
mkdirSync(taskDir, { recursive: true });
const nowIso = new Date().toISOString();
const task = {
	version: 1,
	taskId: TASK_ID,
	title: "UAT worker identity hints",
	goal: "fixture target task",
	status: "in_progress",
	priority: "normal",
	createdAt: nowIso,
	updatedAt: nowIso,
	owner: "root",
	workflow: "feature-dev",
	start: "n1",
	currentNodes: ["n1"],
	nodes: {
		n1: {
			status: "in_progress",
			role: "implementer",
			dependsOn: [],
			assignee: "worker-hints",
			attempts: 1,
			attemptHistory: [
				{
					attemptId: "attempt-active-uat",
					attemptNumber: 1,
					assignee: "worker-hints",
					assignedAt: nowIso,
					status: "active",
					lastActivityAt: nowIso,
				},
			],
			activeAttemptId: "attempt-active-uat",
			evidence: {},
			createdAt: nowIso,
			updatedAt: nowIso,
			outcome: null,
			lastActivityAt: nowIso,
		},
	},
	edges: [],
	handoffs: [],
	gates: {},
	sharedContext: { summary: "", decisions: [], risks: [], openQuestions: [] },
	evidence: {},
	qualification: { mode: "auto", status: "ready", artifact: null, preparedAt: nowIso },
	reworkConsumption: [],
};
writeFileSync(join(taskDir, "task.json"), JSON.stringify(task, null, 2) + "\n");
const readTask = () => JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
const findTaskUpdateTrace = async () => {
	try {
		const t = readFileSync(join(taskDir, "events.jsonl"), "utf8");
		return /"event":"task\.update"/.test(t) && /"note":true/.test(t);
	} catch {
		return false;
	}
};
const rootMailboxPath = join(scratch, ".pi", "swarm", "mailboxes", "root.jsonl");
const readRootMailbox = () => {
	try {
		return readFileSync(rootMailboxPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
};

// --- H2/H5: stream the fixture (twice for determinism) ---
const { streamMockLLM, resetMockLLMCursor } = await import(join(here, "..", "src", "stream.ts"));
const FIXTURE_MODEL = "worker-identity-hints";
const MODEL = { id: FIXTURE_MODEL, provider: "mock-llm", api: "mock-llm-stream" };
const makeContext = () => ({
	systemPrompt: "worker-identity-hints driver",
	messages: [{ role: "user", content: "run worker identity hints UAT" }],
	tools: ["swarm_update_task", "swarm_send_message"].map((name) => ({
		name,
		description: name,
		parameters: { type: "object", properties: {} },
	})),
});
const streamOnce = async () => {
	resetMockLLMCursor(FIXTURE_MODEL);
	const evs = [];
	const s = streamMockLLM(MODEL, makeContext());
	for await (const ev of s) evs.push(ev);
	const result = await s.result();
	return {
		evs,
		result,
		calls: evs
			.filter((e) => e.type === "toolcall_end" && e.toolCall)
			.map((e) => ({ name: e.toolCall.name, arguments: e.toolCall.arguments })),
	};
};
const first = await streamOnce();
ok("H2a: fixture streamed to stop", first.result.stopReason === "stop", `stop=${first.result.stopReason}`);
const captured = first.calls;
ok(
	"H2b: close call captured (swarm_update_task, evidence note present)",
	captured[0]?.name === "swarm_update_task" && /evidence/i.test(captured[0]?.arguments?.note || ""),
);
ok(
	"H2c: blocked call captured (swarm_send_message to root)",
	captured[1]?.name === "swarm_send_message" && captured[1]?.arguments?.to === "root",
);
writeFileSync(join(RUN_DIR, "fixture-captured.json"), JSON.stringify(captured, null, 2) + "\n");
const second = await streamOnce();
ok(
	"H5: deterministic replay — identical captured sequence",
	JSON.stringify(second.calls) === JSON.stringify(captured),
	"second stream diverged",
);

// --- H3/H4: execute the captured calls against the REAL tools ---
const mod = await import(`${join(swarmRoot, "index.ts")}?cb=${Date.now()}-${Math.random()}`);
const tools = {};
const pi2 = {
	...pi,
	registerTool: (def) => {
		tools[def.name] = def;
	},
};
mod.default(pi2);
const call = async (name, params, agentId = "worker-hints") => {
	const prev = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = agentId;
	try {
		const t = tools[name];
		if (!t) throw new Error("no tool " + name);
		return await t.execute("call", params, undefined, undefined, { cwd: scratch });
	} finally {
		process.env.PI_SWARM_AGENT_ID = prev;
	}
};
const text = (r) => (r && r.content && r.content[0] && r.content[0].text) || "";

// H3: the close lands — node done with evidence via the REAL swarm_update_task
const closeRes = await call("swarm_update_task", captured[0].arguments).catch((e) => e);
const nodeAfter = readTask().nodes.n1;
ok(
	"H3a: real swarm_update_task closes the node",
	nodeAfter.status === "done",
	`status=${nodeAfter.status} err=${closeRes instanceof Error ? String(closeRes.message).slice(0, 120) : ""}`,
);
ok(
	"H3b: evidence note traced with the update",
	await findTaskUpdateTrace(),
	"task.update trace with note:true not found",
);

// H4: the blocked message lands in the root mailbox via the REAL swarm_send_message
const msgRes = await call("swarm_send_message", captured[1].arguments).catch((e) => e);
const mailbox = readRootMailbox();
ok(
	"H4: real swarm_send_message delivers the blocked message to root",
	mailbox.some((m) => (m.body || "").includes("Blocked")),
	`mailbox=${mailbox.length} err=${msgRes instanceof Error ? String(msgRes.message).slice(0, 120) : text(msgRes).slice(0, 120)}`,
);

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILED`} (${pass} passed)`);
if (fail > 0) process.exit(1);
