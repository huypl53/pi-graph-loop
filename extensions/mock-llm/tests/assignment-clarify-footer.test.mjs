#!/usr/bin/env node
/**
 * assignment-clarify-footer — mock-LLM driver for the task intent coaching fixtures
 * (task task-202610131005-task-intent-coach, plan §5).
 *
 * Covers BOTH fixtures in one suite:
 *   - assignment-clarify-footer.jsonl (clarify leg): the assignment body carries the 2-line
 *     self-review/clarification footer composed by buildAssignmentBody; the fixture emits a
 *     SPECIFIC clarification toolcall replying to the REAL assignment record, reads the seeded
 *     root answer, then result-reply FIRST and closes done.
 *   - assignment-clear-footer.jsonl (clear leg): same footer, nothing materially unclear,
 *     NO clarification message — restates intent in the result text and closes.
 *
 * Pattern 2 (seeded world + single-actor script) per the mock-llm-scenarios skill: the root's
 * clarification ANSWER is seeded between turns through the REAL engine (`swarm_send_message`
 * as root), not scripted cross-process. The seeded world is a real swarm_create_task +
 * swarm_assign_task in a scratch cwd (template: assignment-body-contract.test.mjs F1) so the
 * fixture's `replyTo` targets a REAL requiresResponse record — otherwise the reply takes the
 * advisory sent-path and verifies nothing.
 *
 * Contract assertions (plan §5 C-1..C-8):
 *   C-1  the REAL assignment body carries both footer lines, before the When finished close;
 *   C-2  clarify toolcall with replyTo === the real assignment id; the clarification reply
 *        itself VERIFIES the assignment record — documented pre-existing verify-on-reply
 *        semantics (validateResultMessage at the delivery boundary), NOT a waiting-enforcement
 *        claim (contract §1/§2.2 honesty);
 *   C-3  root's seeded answer arrives: the worker's next REAL swarm_check_mailbox returns it;
 *   C-4  terminal update accepted post-reply (no RESPONSE_REQUIRED), node done in task.json;
 *   C-5  no response-missing nudge traces fired for the assignment context in this lane (the
 *        clarify reply settled the debt) — documents the settle interplay, no enforcement claim;
 *   C-6  deterministic replay fingerprint for both fixtures;
 *   C-7  transcripts exist under the repo evidence path .pi/mock-llm/transcripts/<fixture>/;
 *   C-8  both fixture files are well-formed 4-turn scripts with lowercase pi-builtin/swarm
 *        tool names and TOKENIZED ids (__ASSIGNMENT_MSG_ID__/__ATTEMPT_ID__) matching the
 *        seeded world (fixture-shape legs always run); the spawn leg materializes a UNIQUELY
 *        NAMED transient fixture (assignment-clarify-footer-live-<pid>.jsonl, tokens → real
 *        seeded ids) and removes it in finally even on spawn failure — the checked-in shared
 *        fixture is NEVER mutated (parallel test:mockllm safety). Token-bridge precedent:
 *        fixloop-auto-reopen __TASK_ID__ / issues-*-guard __LINKED_TASK_ID__.
 *
 * In-process only (imports swarm/index.ts directly, never spawns a pi subprocess) — the
 * terminal driver is irrelevant here; see swarm-yml-pool.test.mjs for the spawn-based pin.
 *
 * Run: node extensions/mock-llm/tests/assignment-clarify-footer.test.mjs
 */
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, rmSync, existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { rm, readFile, readdir, mkdir } from "node:fs/promises";
import { streamMockLLM, resetMockLLMCursor } from "../src/stream.ts";

const here = dirname(fileURLToPath(import.meta.url));
const swarmRoot = join(here, "..", "..", "swarm");

let pass = 0,
	fail = 0;
const ok = (name, cond, info = "") => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info ?? "");
	}
};

const TRANSCRIPT_ROOT = join(process.cwd(), ".pi", "mock-llm", "transcripts");
await mkdir(TRANSCRIPT_ROOT, { recursive: true });
process.env.PI_MOCK_LLM_TRANSCRIPTS_DIR = TRANSCRIPT_ROOT;

// ---- seed: real swarm_create_task + swarm_assign_task in a scratch project ----
console.log("Seed: real task + assignment in a scratch cwd");
const scratch = mkdtempSync(join(tmpdir(), `swarm-clarify-footer-lane-${process.pid}-`));
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi", "swarm"), { recursive: true });
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
const asLane = async (agentId, name, params) => {
	const prev = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = agentId;
	try {
		return await call(name, params);
	} finally {
		process.env.PI_SWARM_AGENT_ID = prev;
	}
};

await call("swarm_create_task", {
	taskId: "task-clarify-footer",
	title: "assignment clarify footer lane",
	goal: "assignment clarify footer lane",
	acceptanceCriteria: ["clarification reply verifies the assignment record"],
	cwd: scratch,
	start: "plan",
	nodes: {
		plan: { role: "planner", dependsOn: [], writeArtifacts: ["artifacts/plan.md"] },
		implement: { role: "implementer", dependsOn: ["plan"], writeArtifacts: ["artifacts/impl.md"] },
	},
	edges: [{ from: "plan", to: "implement", when: "planned" }],
});

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

await call("swarm_assign_task", { taskId: "task-clarify-footer", nodeId: "plan", agentId: "lane-planner", cwd: scratch });
const taskJson = JSON.parse(readFileSync(join(scratch, ".pi/swarm/tasks/task-clarify-footer/task.json"), "utf8"));
const assignmentMsgId = taskJson.nodes.plan.assignmentMessageId;
ok("seed: assignment message id minted", Boolean(assignmentMsgId), assignmentMsgId || "(none)");

// C-1: the REAL assignment body carries both footer lines (mailbox JSONL is the durable copy).
const mailboxLines = readFileSync(join(scratch, ".pi/swarm/mailboxes/lane-planner.jsonl"), "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l));
const assignmentMsg = mailboxLines.find((m) => m.id === assignmentMsgId);
const realBody = assignmentMsg?.body || "";
ok(
	"C-1: real assignment body carries footer line 1 (restate)",
	realBody.includes("Before you start: in one line, restate the intended outcome, the deliverable, and the validation you will run."),
	realBody.slice(-500),
);
ok(
	"C-1: real assignment body carries footer line 2 (clarify-or-proceed, no engine pause)",
	realBody.includes("The engine does not pause for answers — root responds on its own cadence."),
	"",
);
ok(
	"C-1: footer precedes the When finished fencing close in the real body",
	realBody.indexOf("Before you start:") >= 0 && realBody.indexOf("Before you start:") < realBody.indexOf("When finished:"),
	`footer=${realBody.indexOf("Before you start:")} finished=${realBody.indexOf("When finished:")}`,
);

// ---- drive the clarify fixture against the REAL engine state ----
console.log("\nC-2/C-3: clarify fixture replay against the real engine");
const CLARIFY_MODEL = "assignment-clarify-footer";
const makeContext = () => ({
	systemPrompt: "mock-llm assignment-clarify-footer driver",
	messages: [{ role: "user", content: "run the fixture" }],
	tools: [
		{ name: "swarm_check_mailbox", description: "check mailbox", parameters: { type: "object", properties: {} } },
		{ name: "swarm_send_message", description: "send message", parameters: { type: "object", properties: {} } },
		{ name: "swarm_update_task", description: "update task", parameters: { type: "object", properties: {} } },
	],
});
resetMockLLMCursor(CLARIFY_MODEL);
const clarifyModel = { id: CLARIFY_MODEL, provider: "mock-llm", api: "mock-llm-stream" };
const events = [];
for (let turn = 0; turn < 4; turn++) {
	const s = streamMockLLM(clarifyModel, makeContext());
	for await (const event of s) events.push(event);
	await s.result();
}
const toolcallEnds = events.filter((e) => e.type === "toolcall_end").map((e) => e.toolCall);
const sendCalls = toolcallEnds.filter((t) => t?.name === "swarm_send_message");
const clarifyCall = sendCalls.find((t) => String(t?.arguments?.body || "").startsWith("Clarify:"));
const updCall = toolcallEnds.find((t) => t?.name === "swarm_update_task");

ok("C-8.a: clarify fixture emitted a SPECIFIC clarification toolcall", Boolean(clarifyCall), `tools: ${toolcallEnds.map((t) => t?.name).join(",")}`);
ok(
	"C-8.e: clarify fixture replyTo carries the __ASSIGNMENT_MSG_ID__ token (bridged to the real minted id by C-2.a2 in-process and by the spawned C-2.g lane)",
	clarifyCall?.arguments?.replyTo === "__ASSIGNMENT_MSG_ID__",
	clarifyCall?.arguments?.replyTo,
);
ok(
	"C-2.a2: BRIDGE — fixture replyTo token resolvable to the REAL minted assignment id, clarify toolcall replay-equivalent under the bridge",
	(() => {
		const bridged = JSON.parse(JSON.stringify(clarifyCall).replaceAll("__ASSIGNMENT_MSG_ID__", assignmentMsgId));
		return (
			bridged.arguments.replyTo === assignmentMsgId &&
			bridged.arguments.conversationId === "task:task-clarify-footer:plan" &&
			/^Clarify: .+\?$/.test(String(bridged.arguments.body || ""))
			);
	})(),
	`realId=${assignmentMsgId}`,
);
ok(
	"C-2.b: clarification carries the assignment conversationId",
	clarifyCall?.arguments?.conversationId === "task:task-clarify-footer:plan",
	clarifyCall?.arguments?.conversationId || "(none)",
);
ok("C-2.c: clarification body names a specific question", /^Clarify: .+\?$/.test(String(clarifyCall?.arguments?.body || "")), clarifyCall?.arguments?.body);

// Drive the captured clarify protocol through the REAL engine (mirrors the fixture order:
// clarify reply -> answer seeded -> result reply -> terminal close).
const clarifyReplyRes = await asLane("lane-planner", "swarm_send_message", {
	to: "root",
	body: String(clarifyCall?.arguments?.body || "Clarify: ?"),
	replyTo: assignmentMsgId,
	conversationId: "task:task-clarify-footer:plan",
	cwd: scratch,
});
ok("C-2.d: real engine accepted the clarification reply", !clarifyReplyRes?.details?.error, JSON.stringify(clarifyReplyRes?.details?.error || ""));
const stPath = join(scratch, ".pi/swarm/swarm-state.json");
const st1 = JSON.parse(readFileSync(stPath, "utf8"));
ok(
	"C-2.e: clarification reply VERIFIED the assignment record (documented verify-on-clarification semantics — the reply pre-satisfies RESPONSE_REQUIRED; NOT a waiting-enforcement claim)",
	st1.messages[assignmentMsgId]?.response?.status === "verified",
	JSON.stringify(st1.messages[assignmentMsgId]?.response || {}),
);

// Seed the root ANSWER between turns through the real send path (Pattern 2).
const answerRes = await asLane("root", "swarm_send_message", {
	to: "lane-planner",
	body: "Answer: touch both docs — focused, one sentence each.",
	conversationId: "task:task-clarify-footer:plan",
	replyTo: clarifyReplyRes?.details?.message?.id || clarifyReplyRes?.details?.messageId,
	cwd: scratch,
});
ok("C-3.a: root's seeded answer accepted into the worker mailbox", !answerRes?.details?.error, JSON.stringify(answerRes?.details?.error || ""));
// C-3.b on the REAL surface: the WORKER's next swarm_check_mailbox returns the answer.
const answerSurfaced = await asLane("lane-planner", "swarm_check_mailbox", { pendingOnly: true, markDelivered: true, cwd: scratch });
const surfacedRows = answerSurfaced?.details?.messages || [];
ok(
	"C-3.b: worker's real swarm_check_mailbox returns root's answer",
	surfacedRows.some((m) => String(m?.body || "").includes("Answer: touch both")),
	`rows=${surfacedRows.length}`,
);

// C-4: terminal update accepted post-reply (no RESPONSE_REQUIRED), node done.
const updRes = await asLane("lane-planner", "swarm_update_task", {
	taskId: "task-clarify-footer",
	nodeId: "plan",
	status: "done",
	outcome: "planned",
	attemptId: taskJson.nodes.plan.activeAttemptId,
	cwd: scratch,
});
const updText = updRes?.content?.[0]?.text || JSON.stringify(updRes?.details || "");
ok("C-4.a: terminal update accepted after the verified clarify reply (RESPONSE_REQUIRED satisfied)", !/RESPONSE_REQUIRED/.test(updText), updText.slice(0, 160));
const taskAfter = JSON.parse(readFileSync(join(scratch, ".pi/swarm/tasks/task-clarify-footer/task.json"), "utf8"));
ok("C-4.b: node plan is done", taskAfter.nodes.plan.status === "done", taskAfter.nodes.plan.status);
ok("C-2.f: fixture emitted the terminal update toolcall (reply-before-close order scripted)", Boolean(updCall), "");

// C-5: the clarify reply settled the response debt for the assignment context — no
// response_missing nudge traces fired in this lane (documents the settle interplay; the
// settle machinery remains unchanged and applies to a worker that goes silent).
{
	const eventsFile = join(scratch, ".pi/swarm/traces/events.jsonl");
	const traceEvents = existsSync(eventsFile)
		? readFileSync(eventsFile, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => {
					try {
						return JSON.parse(l);
					} catch {
						return null;
					}
				})
				.filter(Boolean)
		: [];
	const responseMissing = traceEvents.filter((t) => t.event === "message.response.missing" || t.event === "worker_nudged");
	ok("C-5: no response_missing / worker_nudged traces in the clarify lane (debt settled by the reply)", responseMissing.length === 0, `traces=${responseMissing.map((t) => t.event).join(",")}`);
}

// C-6: deterministic replay fingerprint for the clarify fixture.
resetMockLLMCursor(CLARIFY_MODEL);
const events2 = [];
for (let turn = 0; turn < 4; turn++) {
	const s2 = streamMockLLM(clarifyModel, makeContext());
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
ok("C-6.a: clarify fixture event sequence identical across replays", eventFingerprint(events) === eventFingerprint(events2), "");

// ---- clear fixture: shape + replay (the clear path needs no engine seeding) ----
console.log("\nC-6/C-8: clear fixture replay (no clarification)");
const CLEAR_MODEL = "assignment-clear-footer";
resetMockLLMCursor(CLEAR_MODEL);
const clearModel = { id: CLEAR_MODEL, provider: "mock-llm", api: "mock-llm-stream" };
const clearEvents = [];
for (let turn = 0; turn < 4; turn++) {
	const s3 = streamMockLLM(clearModel, makeContext());
	for await (const event of s3) clearEvents.push(event);
	await s3.result();
}
const clearEnds = clearEvents.filter((e) => e.type === "toolcall_end").map((e) => e.toolCall);
const clearSends = clearEnds.filter((t) => t?.name === "swarm_send_message");
ok(
	"C-8.b: clear fixture emits exactly ONE send (the result reply) — NO clarification message",
	clearSends.length === 1 && !String(clearSends[0]?.arguments?.body || "").startsWith("Clarify:"),
	`sends=${clearSends.length}`,
);
const clearUpd = clearEnds.find((t) => t?.name === "swarm_update_task");
ok("C-8.c: clear fixture closes the node via swarm_update_task", Boolean(clearUpd), "");
ok("C-8.d: clear fixture replyTo carries the __ASSIGNMENT_MSG_ID__ token", clearSends[0]?.arguments?.replyTo === "__ASSIGNMENT_MSG_ID__", clearSends[0]?.arguments?.replyTo);

resetMockLLMCursor(CLEAR_MODEL);
const clearEvents2 = [];
for (let turn = 0; turn < 4; turn++) {
	const s4 = streamMockLLM(clearModel, makeContext());
	for await (const event of s4) clearEvents2.push(event);
	await s4.result();
}
ok("C-6.b: clear fixture event sequence identical across replays", eventFingerprint(clearEvents) === eventFingerprint(clearEvents2), "");

// C-7: transcript evidence for both fixtures.
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
	const all = await walk(TRANSCRIPT_ROOT);
	ok("C-7.a: clarify transcript written to .pi/mock-llm/transcripts/assignment-clarify-footer/", all.some((f) => f.includes("/assignment-clarify-footer/")), "");
	ok("C-7.b: clear transcript written to .pi/mock-llm/transcripts/assignment-clear-footer/", all.some((f) => f.includes("/assignment-clear-footer/")), "");
}

// ---- C-2.g: SPAWNED real lane with the token bridge (G-5 shape, in-suite reproducibility) ----
// Like the live validation lane: a SECOND scratch world is seeded for real, a UNIQUELY NAMED
// transient fixture (assignment-clarify-footer-live-<pid>.jsonl) is materialized from the
// tokenized checked-in fixture with the REAL minted ids, and a real `pi` process replays THAT
// model stem against the LIVE engine. The checked-in shared fixture is NEVER mutated (parallel
// npm run test:mockllm safety — selftest/other consumers never observe real-id content).
// The transient fixture is removed in finally even on spawn failure, with a cleanup assertion.
// Hard assertions: node done, assignment record VERIFIED by the clarification reply, and NO
// ATTEMPT_TOKEN_MISMATCH / RESPONSE_REQUIRED / response_missing anywhere in the lane's records.
console.log("\nC-2.g: spawned real lane with token bridge");
{
	const { spawnSync } = await import("node:child_process");
	const { writeFileSync } = await import("node:fs");
	const laneScratch = mkdtempSync(join(tmpdir(), `swarm-clarify-footer-spawn-${process.pid}-`));
	rmSync(laneScratch, { recursive: true, force: true });
	mkdirSync(join(laneScratch, ".pi", "swarm"), { recursive: true });
	const prevEnv = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = "root";
	const toolsSpawn = {};
	mod.default({
		registerTool: (d) => (toolsSpawn[d.name] = d),
		registerCommand: () => {},
		on: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		sendMessage: () => {},
	});
	const callSpawn = async (n, prm) => toolsSpawn[n].execute("c", prm, undefined, undefined, { cwd: laneScratch });
	await callSpawn("swarm_create_task", {
		taskId: "task-clarify-footer",
		title: "assignment clarify footer lane",
		goal: "assignment clarify footer lane (spawned)",
		acceptanceCriteria: ["clarification reply verifies the assignment record"],
		start: "plan",
		nodes: {
			plan: { role: "planner", dependsOn: [], writeArtifacts: ["artifacts/plan.md"] },
			implement: { role: "implementer", dependsOn: ["plan"], writeArtifacts: ["artifacts/impl.md"] },
		},
		edges: [{ from: "plan", to: "implement", when: "planned" }],
	});
	{
		const p = stateMod.paths(laneScratch);
		await stateMod.ensureDirs(p);
		await stateMod.withLock(p, async () => {
			const st = await stateMod.readState(p, laneScratch);
			await agentsMod.registerAgent(
				{ exec: async () => ({ code: 1, stdout: "", stderr: "" }), sendMessage: () => {} },
				laneScratch,
				p,
				st,
				{ tmuxTarget: "unknown", role: "test planner", roleKind: "planner", id: "lane-planner", inject: false },
			);
			await stateMod.writeState(p, st);
		});
	}
	await callSpawn("swarm_assign_task", { taskId: "task-clarify-footer", nodeId: "plan", agentId: "lane-planner" });
	const laneTaskJson = JSON.parse(readFileSync(join(laneScratch, ".pi/swarm/tasks/task-clarify-footer/task.json"), "utf8"));
	const laneMsgId = laneTaskJson.nodes.plan.assignmentMessageId;
	const laneAttemptId = laneTaskJson.nodes.plan.activeAttemptId;
	ok("C-2.g seed: spawned lane assignment message id minted", Boolean(laneMsgId), laneMsgId || "(none)");

	// Uniquely named TRANSIENT fixture (real ids), never mutating the checked-in shared fixture.
	const here = dirname(fileURLToPath(import.meta.url));
	const fixturePath = join(here, "..", "fixtures", "assignment-clarify-footer.jsonl");
	const rawFixture = readFileSync(fixturePath, "utf8");
	const liveFixturePath = join(here, "..", "fixtures", `assignment-clarify-footer-live-${process.pid}.jsonl`);
	const bridged = rawFixture.replaceAll("__ASSIGNMENT_MSG_ID__", laneMsgId).replaceAll("__ATTEMPT_ID__", laneAttemptId);
	ok("C-2.g bridge: resolved fixture contains real ids", bridged.includes(laneMsgId) && bridged.includes(laneAttemptId) && !bridged.includes("__ASSIGNMENT_MSG_ID__"), "");
	let spawnStatus = -1;
	try {
		writeFileSync(liveFixturePath, bridged);
		ok("C-2.g bridge: checked-in fixture untouched (still tokenized)", rawFixture.includes("__ASSIGNMENT_MSG_ID__"), "");
		const res = spawnSync(
			"pi",
			[
				"-ne",
				"-e", join(here, "..", "..", "mock-llm"),
				"-e", join(here, "..", "..", "swarm"),
				"--provider", "mock-llm",
				"--model", `assignment-clarify-footer-live-${process.pid}`,
				"-p", "run the clarify footer lane",
			],
			{
				cwd: laneScratch,
				env: { ...process.env, PI_SWARM_AGENT_ID: "lane-planner", PI_SWARM_TERMINAL_MANAGER: "tmux" },
				timeout: 120_000,
			},
		);
		spawnStatus = res.status;
	} finally {
		rmSync(liveFixturePath, { force: true }); // remove transient fixture even on spawn failure
	}
	ok("C-2.g cleanup: transient live fixture removed", !existsSync(liveFixturePath), liveFixturePath);
	ok("C-2.g: spawned pi replay exited cleanly", spawnStatus === 0, `status=${spawnStatus}`);

	// HARD assertions on the spawned lane's durable state.
	const laneTask = JSON.parse(readFileSync(join(laneScratch, ".pi/swarm/tasks/task-clarify-footer/task.json"), "utf8"));
	ok("C-2.g HARD: node plan is DONE in the live lane", laneTask.nodes.plan.status === "done", laneTask.nodes.plan.status);
	const laneState = JSON.parse(readFileSync(join(laneScratch, ".pi/swarm/swarm-state.json"), "utf8"));
	const laneResp = laneState.messages[laneMsgId]?.response;
	ok("C-2.g HARD: real assignment record response.status === verified (clarification reply targeted the real minted id)", laneResp?.status === "verified", JSON.stringify(laneResp || {}));
	const laneRecords = JSON.stringify({ laneTask, laneState });
	ok(
			"C-2.g HARD: NO ATTEMPT_TOKEN_MISMATCH / RESPONSE_REQUIRED / response_missing in the live lane",
			!/ATTEMPT_TOKEN_MISMATCH/.test(laneRecords) && !/RESPONSE_REQUIRED/.test(laneRecords) && !/response_missing/.test(laneRecords),
			"",
		);
	// Cleanup the second scratch world.
	rmSync(laneScratch, { recursive: true, force: true });
	process.env.PI_SWARM_AGENT_ID = prevEnv;
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
