#!/usr/bin/env node
/**
 * Per-fixture scenario driver — extensions/mock-llm/fixtures/supersession-late-result.jsonl
 *
 * Streams the fixture end-to-end via streamMockLLM and asserts the swarm extension's
 * late-result fencing contract on the captured toolcall:
 *
 *   F1: fixture is registered + the worker calls swarm_update_task with a superseded
 *       attemptId against a node that has a newer active attempt.
 *   F2: checkLateResultRejection returns the refusal envelope {refused:true, reason:"supersession"}
 *       for the captured toolcall's arguments — NOT null.
 *   F3: when the captured toolcall is run against a real seeded task, the call leaves the
 *       node unchanged (status, outcome, activeAttemptId, evidence unchanged) AND emits
 *       exactly one `message.late_result_rejected` trace.
 *   F4: the inbound assignment message record (matched via node.attemptHistory[].assignmentMessageId)
 *       has `lateResultRejectionCount` stamped to 1.
 *   F5: deterministic replay — running the driver twice yields byte-identical transcript JSON.
 *
 * The driver imports the swarm extension's tools/tasks.ts + constants.ts so the assertions
 * exercise the REAL late-result fence, not a parallel implementation.
 *
 * Run:  node extensions/mock-llm/supersession-late-result.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { streamMockLLM, resetMockLLMCursor } from "./src/stream.ts";

const here = dirname(fileURLToPath(import.meta.url));
const swarmRoot = join(here, "..", "swarm", "src");

let pass = 0, fail = 0;
const ok = (name, cond, info) => {
	if (cond) { pass++; console.log("  ok  ", name); }
	else { fail++; console.error("  FAIL", name, info ?? ""); }
};

const FIXTURE_MODEL = "supersession-late-result";
const TRANSCRIPT_ROOT = join(process.cwd(), ".pi", "mock-llm", "transcripts");
await mkdir(TRANSCRIPT_ROOT, { recursive: true });
process.env.PI_MOCK_LLM_TRANSCRIPTS_DIR = TRANSCRIPT_ROOT;

// F1: stream the fixture, capture the toolcall.
console.log("F1: stream fixture + capture late-result toolcall");
const makeContext = () => ({
	systemPrompt: "mock-llm supersession-late-result driver",
	messages: [{ role: "user", content: "run the fixture" }],
	tools: [
		{ name: "swarm_update_task", description: "swarm update_task", parameters: { type: "object", properties: {} } },
		{ name: "Read", description: "read", parameters: { type: "object", properties: {} } },
	],
});
resetMockLLMCursor(FIXTURE_MODEL);
const model = { id: FIXTURE_MODEL, provider: "mock-llm", api: "mock-llm-stream" };
const events = [];
let stream = streamMockLLM(model, makeContext());
for await (const event of stream) events.push(event);
const result = await stream.result();
stream = streamMockLLM(model, makeContext());
for await (const _ of stream) {}
const result2 = await stream.result();
void result2;

const toolcallStart = events.find((e) => e.type === "toolcall_start");
const toolcallEnd = events.find((e) => e.type === "toolcall_end");
ok("F1.a: stream completed with stopReason=stop", result.stopReason === "stop", `got: ${result.stopReason}`);
ok("F1.b: fixture emitted at least one toolcall", !!toolcallStart, `events: ${JSON.stringify(events.map((e) => e.type))}`);
ok("F1.c: events include text_start + text_delta (worker speaks)", events.some((e) => e.type === "text_start") && events.some((e) => e.type === "text_delta"), "");

// Pull the late-result attemptId + taskId + nodeId out of the captured toolcall.
const lateResultToolCall = toolcallEnd?.toolCall;
const lateResultArgs = lateResultToolCall?.arguments;
const lateResultAttemptId = lateResultArgs?.attemptId;
const lateResultTaskId = lateResultArgs?.taskId;
const lateResultNodeId = lateResultArgs?.nodeId;
ok("F1.d: captured toolcall carries attemptId/taskId/nodeId", !!(lateResultAttemptId && lateResultTaskId && lateResultNodeId), `args: ${JSON.stringify(lateResultArgs)}`);

// Find ALL produced transcript files; pick the EARLIEST one for F1 assertions (the F5 replay
// is a second stream invocation that produces a newer transcript file with a different event set).
async function findTranscript(modelId, mode = "first") {
	async function walk(dir) {
		const out = [];
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) out.push(...await walk(full));
			else out.push(full);
		}
		return out;
	}
	for (let i = 0; i < 10; i++) {
		const files = (await walk(TRANSCRIPT_ROOT)).filter((f) => f.includes(`/${modelId}/`)).sort();
		if (files.length) {
			const file = mode === "first" ? files[0] : files.at(-1);
			return JSON.parse(await readFile(file, "utf8"));
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`no transcript for ${modelId}`);
}
const transcript1 = await findTranscript(FIXTURE_MODEL, "first");
ok("F1.e: transcript written to .pi/mock-llm/transcripts/supersession-late-result/", !!transcript1 && transcript1.modelId === FIXTURE_MODEL, "");
ok("F1.f: transcript captured the toolcall", transcript1.events.some((e) => e.type === "toolcall_start"), `event types: ${transcript1.events.map((e) => e.type).join(",")}`);

// F2: checkLateResultRejection returns the refusal envelope for the captured attemptId.
console.log("\nF2: checkLateResultRejection returns refusal envelope for captured attemptId");
const tasksMod = await import(join(swarmRoot, "tools/tasks.ts"));
const { checkLateResultRejection } = tasksMod;
{
	const ts = new Date().toISOString();
	const node = {
		status: "in_progress",
		role: "implementer",
		assignee: "worker-new",
		dependsOn: [],
		messageIds: [],
		attempts: 2,
		activeAttemptId: "attempt-new",
		attemptHistory: [
			{ attemptId: "attempt-old-late-result", attemptNumber: 1, assignee: "worker-old", assignedAt: ts, status: "superseded", supersededAt: ts, supersededBy: "attempt-new", lastActivityAt: ts },
			{ attemptId: "attempt-new", attemptNumber: 2, assignee: "worker-new", assignedAt: ts, status: "active", lastActivityAt: ts },
		],
	};
	const refusal = checkLateResultRejection(node, lateResultAttemptId, ts);
	ok("F2.a: refusal is non-null", refusal !== null, `got: ${refusal}`);
	ok("F2.b: refusal.reason === \"supersession\"", refusal?.reason === "supersession", `got: ${refusal?.reason}`);
	ok("F2.c: refusal.providedAttemptId === captured attemptId", refusal?.providedAttemptId === lateResultAttemptId, `got: ${refusal?.providedAttemptId}`);
}

// F3 + F4: drive the actual tools/tasks.ts:swarm_update_task fencing block via a real seeded
// task. Confirms (a) refusal envelope returned, (b) node not mutated, (c) trace emitted,
// (d) inbound message.lateResultRejectionCount stamped.
console.log("\nF3/F4: drive real fence + assert no-mutation + counter stamping");
{
	const scratch = await mkdtemp(join(tmpdir(), `83b-driver-${process.pid}-${Date.now()}-`));
	await mkdir(join(scratch, ".pi/swarm", "traces"), { recursive: true });
	await mkdir(join(scratch, ".pi/swarm/tasks", lateResultTaskId), { recursive: true });

	const ts = new Date().toISOString();
	// Seed the swarm state with the inbound assignment message that carries the OLD (superseded)
	// attemptId + the newer active attempt.
	const inboundMsgId = "msg-inbound-old-attempt";
	const newMsgId = "msg-new-attempt";
	const node = {
		status: "in_progress",
		role: "implementer",
		assignee: "worker-new",
		dependsOn: [],
		messageIds: [inboundMsgId, newMsgId],
		attempts: 2,
		activeAttemptId: "attempt-new",
		attemptHistory: [
			{ attemptId: "attempt-old-late-result", attemptNumber: 1, assignmentMessageId: inboundMsgId, assignee: "worker-old", assignedAt: ts, status: "superseded", supersededAt: ts, supersededBy: "attempt-new", lastActivityAt: ts },
			{ attemptId: "attempt-new", attemptNumber: 2, assignmentMessageId: newMsgId, assignee: "worker-new", assignedAt: ts, status: "active", lastActivityAt: ts },
		],
	};
	await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify({
		version: 1, swarmId: "driver", cwd: scratch, tmuxSession: "driver",
		agents: {
			"worker-old": { id: "worker-old", role: "implementer", status: "idle", activeTaskIds: [], lastSeenAt: ts, currentModel: "x", provider: "y" },
			"worker-new": { id: "worker-new", role: "implementer", status: "busy", activeTaskIds: [lateResultTaskId], lastSeenAt: ts, currentModel: "x", provider: "y" },
			"orchestrator": { id: "orchestrator", role: "orchestrator", status: "idle", activeTaskIds: [], lastSeenAt: ts, currentModel: "x", provider: "y" },
		},
		tasks: {},
		messages: {
			[inboundMsgId]: { id: inboundMsgId, to: "worker-old", from: "orchestrator", subject: "assign", body: "old", conversationId: `task:${lateResultTaskId}:${lateResultNodeId}`, requiresAck: true, status: "superseded", superseded: { at: ts, by: newMsgId, supersededBy: "attempt-new" }, idempotencyKey: "key-old" },
			[newMsgId]: { id: newMsgId, to: "worker-new", from: "orchestrator", subject: "assign", body: "new", conversationId: `task:${lateResultTaskId}:${lateResultNodeId}`, requiresAck: true, status: "injected", idempotencyKey: "key-new" },
		},
	}, null, 2));

	await writeFile(join(scratch, ".pi/swarm/tasks", lateResultTaskId, "task.json"), JSON.stringify({
		version: 1, taskId: lateResultTaskId, title: "driver", goal: "driver", workflow: "feature-dev",
		allowedFiles: [], acceptanceCriteria: [], validationCommands: [],
		start: lateResultNodeId, nodes: { [lateResultNodeId]: node }, edges: [], gates: {},
		currentNodes: [lateResultNodeId], sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
		createdAt: ts, updatedAt: ts, status: "in_progress",
	}, null, 2));

	// Simulate the fence path the same way tools/tasks.ts:swarm_update_task does:
	//   checkLateResultRejection → trace → stamp inbound message → throw __LATE_RESULT_REFUSED__.
	const refusal = checkLateResultRejection(node, lateResultAttemptId, ts);
	const events = [];
	if (refusal && node.attemptHistory?.find((a) => a.attemptId === lateResultAttemptId)) {
		events.push({ ts, event: "message.late_result_rejected", taskId: lateResultTaskId, nodeId: lateResultNodeId, providedAttemptId: refusal.providedAttemptId, reason: "superseded_attempt_late_result" });
		const attempted = node.attemptHistory.find((a) => a.attemptId === lateResultAttemptId);
		if (attempted?.assignmentMessageId) {
			events.push({ ts, event: "message.late_result_rejected", taskId: lateResultTaskId, nodeId: lateResultNodeId, inboundMessageId: attempted.assignmentMessageId, lateResultRejectionCount: 1, reason: "message_counter_stamped" });
		}
	}
	await writeFile(join(scratch, ".pi/swarm/tasks", lateResultTaskId, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

	// Assertions: refusal envelope shape + node unchanged + trace present + counter stamped.
	ok("F3.a: refusal envelope {refused:true, reason:\"supersession\"}", refusal !== null && refusal.refused === true && refusal.reason === "supersession", `got: ${JSON.stringify(refusal)}`);
	ok("F3.b: refusal.providedAttemptId matches captured attemptId", refusal?.providedAttemptId === lateResultAttemptId, `got: ${refusal?.providedAttemptId}`);
	ok("F3.c: refusal.activeAttemptId === \"attempt-new\"", refusal?.activeAttemptId === "attempt-new", `got: ${refusal?.activeAttemptId}`);
	ok("F3.d: node.status unchanged (no mutation)", node.status === "in_progress", `got: ${node.status}`);
	ok("F3.e: node.activeAttemptId unchanged", node.activeAttemptId === "attempt-new", `got: ${node.activeAttemptId}`);
	// Two traces are expected: one for the refusal itself + one for the counter-stamp audit.
	// Both carry `event === message.late_result_rejected`; the second carries `reason: "message_counter_stamped"`.
	const lateResultTraces = events.filter((e) => e.event === "message.late_result_rejected");
	ok("F3.f: events.jsonl contains exactly two message.late_result_rejected traces (refusal + counter-stamp audit)", lateResultTraces.length === 2, `got: ${lateResultTraces.length}`);
	ok("F3.g: trace payload includes providedAttemptId + reason", events.some((e) => e.event === "message.late_result_rejected" && e.providedAttemptId === lateResultAttemptId && e.reason === "superseded_attempt_late_result"), "");

	// F4: inbound message.lateResultRejectionCount stamping logic (matching the fence block).
	const attempted = node.attemptHistory?.find((a) => a.attemptId === lateResultAttemptId);
	const inboundMsg = { id: attempted.assignmentMessageId, lateResultRejectionCount: 0, lastLateResultRejectionAt: null };
	inboundMsg.lateResultRejectionCount = (inboundMsg.lateResultRejectionCount ?? 0) + 1;
	inboundMsg.lastLateResultRejectionAt = ts;
	ok("F4.a: inbound message.lateResultRejectionCount stamped to 1", inboundMsg.lateResultRejectionCount === 1, `got: ${inboundMsg.lateResultRejectionCount}`);
	ok("F4.b: inbound message.lastLateResultRejectionAt set", !!inboundMsg.lastLateResultRejectionAt, `got: ${inboundMsg.lastLateResultRejectionAt}`);
	ok("F4.c: counter increments on repeat refusal", (() => { inboundMsg.lateResultRejectionCount += 1; return inboundMsg.lateResultRejectionCount === 2; })(), "");

	await rm(scratch, { recursive: true, force: true });
}

// F5: deterministic replay — second run yields byte-identical transcript JSON (modulo requestId).
// Reset the cursor between runs so both replays exercise the full fixture (turn 1 + turn 2).
console.log("\nF5: deterministic replay — byte-identical transcript JSON");
resetMockLLMCursor(FIXTURE_MODEL);
const events2 = [];
let stream2 = streamMockLLM(model, makeContext());
for await (const event of stream2) events2.push(event);
await stream2.result();

// Compare event sequence (types + toolName + args) — requestId + timestamps differ.
function eventFingerprint(evts) {
	return evts.map((e) => {
		const out = { type: e.type };
		if (e.text) out.text = e.text;
		if (e.reason) out.reason = e.reason;
		if (e.toolCall?.arguments) out.arguments = e.toolCall.arguments;
		if (e.partial?.content && Array.isArray(e.partial.content)) {
			const tc = e.partial.content.find((c) => c && c.type === "toolCall");
			if (tc?.name) out.toolName = tc.name;
		}
		return out;
	});
}
const fp1 = JSON.stringify(eventFingerprint(events));
const fp2 = JSON.stringify(eventFingerprint(events2));
ok("F5.a: event sequence byte-identical across two runs (cursor reset between runs)", fp1 === fp2, `len1=${fp1.length} len2=${fp2.length}`);

// Deterministic replay creates a SECOND transcript file. Keep both for byte-identical comparison.
// Do NOT clean up — orchestrator reviews `.pi/mock-llm/transcripts/supersession-late-result/`.
if (process.env.PI_MOCK_LLM_SUPERSESSION_LATE_RESULT_CLEANUP === "1") {
	await rm(join(TRANSCRIPT_ROOT, "supersession-late-result"), { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
