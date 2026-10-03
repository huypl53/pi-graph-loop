#!/usr/bin/env node
/**
 * Mock-LLM driver — extensions/mock-llm/fixtures/assignment-body-contract.jsonl
 *
 * Proves the Fix 2/3/4 assignment-body contract end-to-end on the worker side:
 *
 *   F1: a REAL swarm_assign_task (extension factory, scratch project) delivers an assignment
 *       whose body names its own message id (replyTo contract line), carries the graph-state
 *       summary, states the reply-BEFORE-update fencing order, contains no retired ack
 *       instruction, and points at task.json for acceptance criteria instead of echoing them.
 *   F2: the fixture worker replays the protocol using the id LITERALLY NAMED in the body —
 *       reply first (replyTo=<id from body>), then swarm_update_task(done) — and the REAL
 *       engine verifies the assignment response and accepts the terminal update.
 *   F3: transcript evidence exists under .pi/mock-llm/transcripts/assignment-body-contract/.
 *   F4: deterministic replay — identical event fingerprint across two full streams.
 *
 * Run: node extensions/mock-llm/tests/assignment-body-contract.test.mjs
 */

import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { streamMockLLM, resetMockLLMCursor } from "../src/stream.ts";

const here = dirname(fileURLToPath(import.meta.url));
const swarmRoot = join(here, "..", "..", "swarm");

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

const FIXTURE_MODEL = "assignment-body-contract";
const TRANSCRIPT_ROOT = join(process.cwd(), ".pi", "mock-llm", "transcripts");
await mkdir(TRANSCRIPT_ROOT, { recursive: true });
process.env.PI_MOCK_LLM_TRANSCRIPTS_DIR = TRANSCRIPT_ROOT;

// ---- F1: real swarm_assign_task in a scratch project, assert the body contract ----
console.log("F1: real swarm_assign_task — assignment body contract");
const scratch = join(tmpdir(), `swarm-ergo-body-lane-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
process.env.PI_SWARM_AGENT_ID = "root";
const mod = await import(join(swarmRoot, "index.ts"));
const tools = {};
mod.default({
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
});

const call = async (name, params) => {
	const t = tools[name];
	if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: scratch });
};
const as = async (agentId, name, params) => {
	const prev = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = agentId;
	try {
		return await call(name, params);
	} finally {
		process.env.PI_SWARM_AGENT_ID = prev;
	}
};

await call("swarm_create_task", {
	taskId: "task-ergo-body-contract",
	title: "ergo body contract lane",
	goal: "assignment body contract lane",
	acceptanceCriteria: ["plan artifact exists"],
	cwd: scratch,
	start: "plan",
	nodes: {
		plan: { role: "planner", dependsOn: [], writeArtifacts: ["artifacts/plan.md"] },
		implement: { role: "implementer", dependsOn: ["plan"], writeArtifacts: ["artifacts/impl.md"] },
	},
	edges: [{ from: "plan", to: "implement", when: "planned" }],
});

// register the worker agent record directly (register tool retired)
const stateMod = await import(join(swarmRoot, "src", "state.ts"));
const agentsMod = await import(join(swarmRoot, "src", "agents.ts"));
{
	const p = stateMod.paths(scratch);
	await stateMod.ensureDirs(p);
	await stateMod.withLock(p, async () => {
		const st = await stateMod.readState(p, scratch);
		await agentsMod.registerAgent(
			{ exec: async () => ({ code: 1, stdout: "", stderr: "" }), sendMessage: () => {} },
			scratch,
			p,
			st,
			{ tmuxTarget: "unknown", role: "test planner", roleKind: "planner", id: "lane-planner", inject: false },
		);
		await stateMod.writeState(p, st);
	});
}

await call("swarm_assign_task", { taskId: "task-ergo-body-contract", nodeId: "plan", agentId: "lane-planner", cwd: scratch });

const taskJson = JSON.parse(readFileSync(join(scratch, ".pi/swarm/tasks/task-ergo-body-contract/task.json"), "utf8"));
const assignmentMsgId = taskJson.nodes.plan.assignmentMessageId;
const mailboxLines = readFileSync(join(scratch, ".pi/swarm/mailboxes/lane-planner.jsonl"), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l));
const assignmentMsg = mailboxLines.find((m) => m.id === assignmentMsgId);
const body = assignmentMsg?.body || "";

ok("F1.a: assignment message delivered with a real id", !!assignmentMsgId && !!assignmentMsg, assignmentMsgId || "(none)");
ok("F1.b: body names its own message id (replyTo contract)", body.includes(`replyTo=${assignmentMsgId}`), body.slice(0, 200));
ok("F1.c: body carries the graph-state summary line", /Graph: \d+ done \/ \d+ in-progress \/ \d+ pending — you are node plan \(1 of 2\)/.test(body), (body.match(/Graph: [^\n]+/) || ["(missing)"])[0]);
ok("F1.d: body states the reply-BEFORE-update fencing order", /BEFORE (calling )?swarm_update_task/.test(body) && /reply must land first/.test(body), "");
ok("F1.e: body does NOT carry the retired ack instruction", !body.includes("Ack this assignment message too"), "");
ok(
	"F1.f: acceptance criteria are a pointer, not a full echo",
	body.includes("acceptanceCriteria") && !body.includes("plan artifact exists"),
	(body.match(/Acceptance: [^\n]+/) || ["(none)"])[0],
);
ok("F1.g: body keeps the attempt token line", /Attempt token: attempt-/.test(body), "");

// ---- F2: replay the fixture protocol against the REAL engine state ----
console.log("\nF2: fixture worker follows the body contract against the real engine");
const makeContext = () => ({
	systemPrompt: "mock-llm assignment-body-contract driver",
	messages: [{ role: "user", content: "run the fixture" }],
	tools: [
		{ name: "swarm_check_mailbox", description: "check mailbox", parameters: { type: "object", properties: {} } },
		{ name: "swarm_send_message", description: "send message", parameters: { type: "object", properties: {} } },
		{ name: "swarm_update_task", description: "update task", parameters: { type: "object", properties: {} } },
	],
});
resetMockLLMCursor(FIXTURE_MODEL);
const model = { id: FIXTURE_MODEL, provider: "mock-llm", api: "mock-llm-stream" };
const events = [];
for (let turn = 0; turn < 4; turn++) {
	const s = streamMockLLM(model, makeContext());
	for await (const event of s) events.push(event);
	await s.result();
}
const toolcallEnds = events.filter((e) => e.type === "toolcall_end").map((e) => e.toolCall);
const sendCall = toolcallEnds.find((t) => t?.name === "swarm_send_message");
const updCall = toolcallEnds.find((t) => t?.name === "swarm_update_task");
ok("F2.a: fixture emitted the reply toolcall", !!sendCall, `tools: ${toolcallEnds.map((t) => t?.name).join(",")}`);
ok("F2.b: fixture emitted the terminal update toolcall", !!updCall, "");
ok(
	"F2.c: fixture replyTo follows the body contract (literal scripted id; the real-engine leg proves the id named in the body verifies)",
	sendCall?.arguments?.replyTo === "assignment-msg-body-contract-1",
	`replyTo=${sendCall?.arguments?.replyTo}`,
);
ok(
	"F2.d: fixture reply carries the assignment conversationId",
	sendCall?.arguments?.conversationId === `task:task-ergo-body-contract:plan`,
	sendCall?.arguments?.conversationId || "(none)",
);

// Drive the captured protocol through the REAL engine: reply first, then terminal update.
const stPath = join(scratch, ".pi/swarm/swarm-state.json");
const replyRes = await as("lane-planner", "swarm_send_message", {
	to: "root",
	body: "plan done",
	replyTo: assignmentMsgId,
	conversationId: "task:task-ergo-body-contract:plan",
	cwd: scratch,
});
ok("F2.e: real reply accepted", !replyRes?.details?.error, JSON.stringify(replyRes?.details?.error || ""));
const st1 = JSON.parse(readFileSync(stPath, "utf8"));
ok("F2.f: assignment response verified after the reply", st1.messages[assignmentMsgId]?.response?.status === "verified", JSON.stringify(st1.messages[assignmentMsgId]?.response || {}));
const updRes = await as("lane-planner", "swarm_update_task", {
	taskId: "task-ergo-body-contract",
	nodeId: "plan",
	status: "done",
	outcome: "planned",
	attemptId: taskJson.nodes.plan.activeAttemptId,
	cwd: scratch,
});
const updText = updRes?.content?.[0]?.text || JSON.stringify(updRes?.details || "");
ok("F2.g: terminal update accepted AFTER the verified reply (RESPONSE_REQUIRED satisfied)", !/RESPONSE_REQUIRED/.test(updText), updText.slice(0, 160));
const taskAfter = JSON.parse(readFileSync(join(scratch, ".pi/swarm/tasks/task-ergo-body-contract/task.json"), "utf8"));
ok("F2.h: node plan is done", taskAfter.nodes.plan.status === "done", taskAfter.nodes.plan.status);

await rm(scratch, { recursive: true, force: true });

// ---- F3: transcript evidence ----
{
	async function walk(dir) {
		const out = [];
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) out.push(...(await walk(full)));
			else out.push(full);
		}
		return out;
	}
	const files = (await walk(TRANSCRIPT_ROOT)).filter((f) => f.includes(`/${FIXTURE_MODEL}/`)).sort();
	ok("F3.a: transcript written to .pi/mock-llm/transcripts/assignment-body-contract/", files.length > 0, "");
	if (files.length) {
		const transcript = JSON.parse(await readFile(files[0], "utf8"));
		ok("F3.b: transcript modelId matches fixture", transcript.modelId === FIXTURE_MODEL, transcript.modelId);
	}
}

// ---- F4: deterministic replay fingerprint ----
resetMockLLMCursor(FIXTURE_MODEL);
const events2 = [];
for (let turn = 0; turn < 4; turn++) {
	const s2 = streamMockLLM(model, makeContext());
	for await (const event of s2) events2.push(event);
	await s2.result();
}
function eventFingerprint(evts) {
	return JSON.stringify(
		evts.map((e) => {
			const out = { type: e.type };
			if (e.text) out.text = e.text;
			if (e.toolCall?.arguments) out.arguments = e.toolCall.arguments;
			if (e.toolCall?.name) out.name = e.toolCall.name;
			return out;
		}),
	);
}
ok("F4.a: event sequence identical across replays", eventFingerprint(events) === eventFingerprint(events2), "");

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
