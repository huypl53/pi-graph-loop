#!/usr/bin/env node
/**
 * Mock-LLM driver — extensions/mock-llm/fixtures/assignment-stale-replyto-redirect.jsonl
 *
 * Proves the Fix 1 ergonomics contract end-to-end on the worker side of the interaction:
 *
 *   F1: fixture streams (deterministic replay) and captures a swarm_send_message completion
 *       reply whose replyTo names the STALE assignment id (assignment-msg-stale-a1).
 *   F2: driven against REAL seeded supersession state through the REAL deliverMessageLocked,
 *       the reply is redirected: message.response.redirected trace (stale → current) and the
 *       CURRENT assignment record verifies with the reply as its result message.
 *   F3: supersession evidence on the stale record is preserved (waived, not re-verified).
 *   F4: deterministic replay — second stream yields the identical event/toolcall fingerprint.
 *
 * Run: node extensions/mock-llm/tests/assignment-stale-replyto-redirect.test.mjs
 */
// No PI_SWARM_TERMINAL_MANAGER pin needed: this lane is in-process only
// (imports swarm/index.ts directly, never spawns a pi subprocess), so the
// terminal driver is irrelevant. See swarm-yml-pool.test.mjs for the
// spawn-based pin pattern.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { streamMockLLM, resetMockLLMCursor } from "../src/stream.ts";

const here = dirname(fileURLToPath(import.meta.url));
const swarmRoot = join(here, "..", "..", "swarm", "src");

let pass = 0,
	fail = 0;
// task-202610031339 Fix D: by-design gate=1-only assertions (minimal-protocol redirect/verify
// semantics retired at PI_SWARM_MINIMAL_PROTOCOL=0). Skip with a visible marker at gate=0.
const GATE0 = process.env.PI_SWARM_MINIMAL_PROTOCOL === "0";
let skippedGate0 = 0;
const okGate0 = (name, cond, info) => {
	if (GATE0) {
		skippedGate0++;
		console.log("  SKIP (gate=0 by-design):", name);
		return;
	}
	ok(name, cond, info);
};
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info ?? "");
	}
};

const FIXTURE_MODEL = "assignment-stale-replyto-redirect";
const TRANSCRIPT_ROOT = join(process.cwd(), ".pi", "mock-llm", "transcripts");
await mkdir(TRANSCRIPT_ROOT, { recursive: true });
process.env.PI_MOCK_LLM_TRANSCRIPTS_DIR = TRANSCRIPT_ROOT;

const makeContext = () => ({
	systemPrompt: "mock-llm assignment-stale-replyto-redirect driver",
	messages: [{ role: "user", content: "run the fixture" }],
	tools: [
		{ name: "swarm_check_mailbox", description: "check mailbox", parameters: { type: "object", properties: {} } },
		{ name: "swarm_send_message", description: "send message", parameters: { type: "object", properties: {} } },
	],
});

// F1: stream the fixture turn-by-turn (one streamMockLLM call = one scripted turn) and capture
// the completion toolcall.
console.log("F1: stream fixture + capture stale-replyTo completion toolcall");
resetMockLLMCursor(FIXTURE_MODEL);
const model = { id: FIXTURE_MODEL, provider: "mock-llm", api: "mock-llm-stream" };
const events = [];
for (let turn = 0; turn < 3; turn++) {
	const s = streamMockLLM(model, makeContext());
	for await (const event of s) events.push(event);
	await s.result();
}

const toolcallEnds = events.filter((e) => e.type === "toolcall_end").map((e) => e.toolCall);
const sendCall = toolcallEnds.find((t) => t?.name === "swarm_send_message");
ok("F1.b: fixture emitted a swarm_send_message completion reply", !!sendCall, `tools: ${toolcallEnds.map((t) => t?.name).join(",")}`);
const staleReplyTo = sendCall?.arguments?.replyTo;
ok("F1.c: reply targets the STALE assignment id", staleReplyTo === "assignment-msg-stale-a1", `replyTo: ${staleReplyTo}`);
ok(
	"F1.d: reply carries the assignment conversationId",
	sendCall?.arguments?.conversationId === "task:task-ergo-stale-redirect:implement",
	`conversationId: ${sendCall?.arguments?.conversationId}`,
);

// F2: drive the REAL deliverMessageLocked against seeded supersession state.
console.log("\nF2: real deliverMessageLocked redirect on seeded supersession state");
{
	const swarmMod = await import(join(swarmRoot, "mailbox.ts"));
	const stateMod = await import(join(swarmRoot, "state.ts"));
	const sessionMod = await import(join(swarmRoot, "session.ts"));

	const scratch = await mkdtemp(join(tmpdir(), `ergo-f1-lane-${process.pid}-${Date.now()}-`));
	await mkdir(join(scratch, ".pi/swarm", "traces"), { recursive: true });
	await mkdir(join(scratch, ".pi/swarm/tasks", "task-ergo-stale-redirect"), { recursive: true });

	const ts = new Date().toISOString();
	const staleId = "assignment-msg-stale-a1";
	const currentId = "assignment-msg-current-a2";
	const taskId = "task-ergo-stale-redirect";
	const nodeId = "implement";

	const node = {
		status: "assigned",
		role: "implementer",
		assignee: "impl-1",
		dependsOn: [],
		messageIds: [staleId, currentId],
		attempts: 2,
		activeAttemptId: "attempt-a2",
		assignmentMessageId: currentId,
		attemptHistory: [
			{
				attemptId: "attempt-a1",
				attemptNumber: 1,
				assignmentMessageId: staleId,
				assignee: "impl-1",
				assignedAt: ts,
				status: "superseded",
				supersededAt: ts,
				supersededBy: "attempt-a2",
				lastActivityAt: ts,
			},
			{ attemptId: "attempt-a2", attemptNumber: 2, assignmentMessageId: currentId, assignee: "impl-1", assignedAt: ts, status: "active", lastActivityAt: ts },
		],
	};

	await writeFile(
		join(scratch, ".pi/swarm/tasks", taskId, "task.json"),
		JSON.stringify(
			{
				version: 1,
				taskId,
				title: "ergo stale redirect lane",
				goal: "lane",
				workflow: "feature-dev",
				allowedFiles: [],
				acceptanceCriteria: [],
				validationCommands: [],
				start: nodeId,
				nodes: { [nodeId]: node },
				edges: [],
				gates: {},
				currentNodes: [nodeId],
				sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
				createdAt: ts,
				updatedAt: ts,
				status: "in_progress",
			},
			null,
			2,
		),
	);

	await writeFile(
		join(scratch, ".pi/swarm/swarm-state.json"),
		JSON.stringify(
			{
				version: 1,
				swarmId: "ergo-f1-lane",
				cwd: scratch,
				tmuxSession: "lane",
				agents: {
					root: { id: "root", role: "root", roleKind: "root", status: "idle", runtimeStatus: "idle", activeTaskIds: [], updatedAt: ts },
					"impl-1": { id: "impl-1", role: "implementer", roleKind: "worker", status: "busy", runtimeStatus: "busy", activeTaskIds: [taskId], updatedAt: ts },
				},
				tasks: {},
				messages: {
					[staleId]: {
						id: staleId,
						from: "root",
						to: "impl-1",
						subject: `Task ${taskId} / node ${nodeId} assigned`,
						body: "stale assignment",
						conversationId: `task:${taskId}:${nodeId}`,
						requiresResponse: true,
						requiresAck: false,
						status: "superseded",
						superseded: { at: ts, by: currentId, supersededBy: "reassign" },
						response: { status: "waived", waivedAt: ts, waivedBy: "root" },
						createdAt: ts,
						updatedAt: ts,
					},
					[currentId]: {
						id: currentId,
						from: "root",
						to: "impl-1",
						subject: `Task ${taskId} / node ${nodeId} assigned`,
						body: "current assignment",
						conversationId: `task:${taskId}:${nodeId}`,
						requiresResponse: true,
						requiresAck: false,
						status: "injected",
						response: { status: "missing", missingAt: ts },
						createdAt: ts,
						updatedAt: ts,
					},
				},
				updatedAt: ts,
			},
			null,
			2,
		),
	);

	// Drive the worker-side reply through the REAL engine: switch identity to impl-1 and call
	// deliverMessageLocked exactly as swarm_send_message does.
	const prevId = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = "impl-1";
	try {
		const p = stateMod.paths(scratch);
		await stateMod.ensureDirs(p);
		await stateMod.withLock(p, async () => {
			const st = await stateMod.readState(p, scratch);
			await swarmMod.deliverMessageLocked({ exec: async () => ({ code: 1, stdout: "", stderr: "" }), sendMessage: () => {} }, scratch, p, st, {
				to: "root",
				body: "Implement done",
				subject: "Implement done",
				conversationId: `task:${taskId}:${nodeId}`,
				replyTo: staleId,
				requiresAck: false,
				requiresResponse: false,
			});
			await stateMod.writeState(p, st);
		});
	} finally {
		process.env.PI_SWARM_AGENT_ID = prevId;
	}

	const stAfter = JSON.parse(await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
	okGate0("F2.a: CURRENT assignment record verified by the redirected reply", stAfter.messages[currentId]?.response?.status === "verified", JSON.stringify(stAfter.messages[currentId]?.response || {}));
	okGate0(
		"F2.b: verified resultMessageId is the worker's completion reply",
		typeof stAfter.messages[currentId]?.response?.resultMessageId === "string" &&
			stAfter.messages[currentId].response.resultMessageId.startsWith("msg-"),
		JSON.stringify(stAfter.messages[currentId]?.response || {}),
	);
	ok(
		"F2.c: stale record keeps waived/supersession evidence (not re-verified)",
		stAfter.messages[staleId]?.superseded && stAfter.messages[staleId]?.response?.status === "waived",
		JSON.stringify({ s: !!stAfter.messages[staleId]?.superseded, r: stAfter.messages[staleId]?.response?.status }),
	);

	// Trace evidence: redirected + verified traces in the task trace events.jsonl.
	const traceText = await readFile(join(scratch, ".pi/swarm/traces/events.jsonl"), "utf8").catch(() => "");
	const redirectedLine = traceText.split("\n").find((l) => l.includes("message.response.redirected"));
	const verifiedLine = traceText.split("\n").find((l) => l.includes("message.response.verified") && l.includes("stale_replyto_redirect"));
	okGate0("F2.d: message.response.redirected trace recorded", !!redirectedLine, traceText.slice(0, 400));
	okGate0("F2.e: verified trace carries via=stale_replyto_redirect", !!verifiedLine, "");

	await rm(scratch, { recursive: true, force: true });
}

// F3: transcript evidence exists under .pi/mock-llm/transcripts/<model>/.
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
	ok("F3.a: transcript written to .pi/mock-llm/transcripts/assignment-stale-replyto-redirect/", files.length > 0, "");
	if (files.length) {
		const transcript = JSON.parse(await readFile(files[0], "utf8"));
		ok("F3.b: transcript modelId matches fixture", transcript.modelId === FIXTURE_MODEL, transcript.modelId);
		ok("F3.c: transcript captured the send toolcall", transcript.events.some((e) => e.type === "toolcall_start"), "");
	}
}

// F4: deterministic replay — identical event fingerprint on a second full stream.
console.log("\nF4: deterministic replay fingerprint");
resetMockLLMCursor(FIXTURE_MODEL);
const events2 = [];
for (let turn = 0; turn < 3; turn++) {
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
ok("F4.a: event sequence identical across replays", eventFingerprint(events) === eventFingerprint(events2), `len1=${eventFingerprint(events).length} len2=${eventFingerprint(events2).length}`);

console.log(`\n${pass} pass / ${fail} fail${skippedGate0 ? ` / ${skippedGate0} SKIPPED (gate=0 by-design)` : ""}`);
process.exit(fail === 0 ? 0 : 1);
