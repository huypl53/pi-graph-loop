import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mockLLM from "./index.ts";
import { clearFixtureCache, discoverModelConfigs, fixtureDir, fixtureFilePath, listFixtureDiscovery, loadFixtureFile } from "./src/fixtures.ts";
import { resetMockLLMCursor, streamMockLLM } from "./src/stream.ts";

const tmp = join(tmpdir(), `mock-llm-selftest-${Date.now()}`);
await mkdir(tmp, { recursive: true });
const transcriptRoot = join(tmp, "transcripts");
await mkdir(transcriptRoot, { recursive: true });
process.env.PI_MOCK_LLM_TRANSCRIPTS_DIR = transcriptRoot;
clearFixtureCache();
resetMockLLMCursor();

const registered = {};
await mockLLM({
	registerProvider(name, config) {
		registered.name = name;
		registered.config = config;
	},
});

assert.equal(registered.name, "mock-llm", "provider should register as mock-llm");
assert.equal(registered.config.api, "mock-llm-stream");
assert.equal(registered.config.models.length, 42, "expected forty-two scenario models");
assert.deepEqual((await discoverModelConfigs()).map((model) => model.id).sort(), ["429-mid-edit", "ack-lifecycle-booking", "assignment-fence-stale-attempt", "auto-close-evidence-closure", "cancel-supersession", "commit-no-evidence", "dead-letter-final", "delivery-repair-retry", "drift-then-wake", "edit-not-persisted", "gc-retention-dryrun", "goal-busy-epoch-reset", "goal-interval-reanchor", "graph-advance-nudge-rearm", "handoff-chain", "idle-nudge-recovery", "initial-ready-nudge", "inprogress-death", "mailbox-delivery-read", "midturn-assign", "parallel-fail-a", "parallel-fail-b", "pool-engine-retry-gated-swap-exhausted", "pool-quota-bench-cooldown-recovery", "pool-spawn-fallback-all-tagged-benched", "pool-strict-roles-tagged-only", "prune-retention-apply", "quota-429-then-recovery", "quota-exhausted-all-turns", "reconcile-repair-retry", "response-credit-verified-result", "response-missing-settle", "response-required-death", "settled-with-open-assignment", "shared-context-a", "shared-context-b", "stale-all-agents", "supersession-race-new", "supersession-race-old", "task-graph-semantics", "torn-json-then-recovery", "wake-up-escalation-reminder"].sort());
assert.equal((await listFixtureDiscovery()).length, 42);

function makeContext() {
	return {
		systemPrompt: "mock-llm selftest",
		messages: [{ role: "user", content: "run the fixture" }],
		tools: [{ name: "Edit", description: "edit files", parameters: { type: "object", properties: {}, required: [] } }],
	};
}

async function collect(stream) {
	const events = [];
	for await (const event of stream) events.push(event);
	const result = await stream.result();
	return { events, result };
}

function fixturePath(modelId) {
	return join(fixtureDir(), `${modelId}.jsonl`);
}

async function withFixture(modelId, content, fn) {
	const path = fixturePath(modelId);
	await writeFile(path, content, "utf8");
	clearFixtureCache();
	try {
		return await fn(path);
	} finally {
		await rm(path, { force: true });
		clearFixtureCache();
	}
}

async function latestTranscript(modelId) {
	async function walk(dir) {
		const entries = await readdir(dir, { withFileTypes: true });
		const out = [];
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) out.push(...await walk(full));
			else out.push(full);
		}
		return out;
	}
	for (let attempt = 0; attempt < 5; attempt++) {
		const files = (await walk(transcriptRoot)).filter((file) => file.includes(`/${modelId}/`)).sort();
		const latest = files.at(-1);
		if (latest) return JSON.parse(await readFile(latest, "utf8"));
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.ok(false, `expected transcript file for ${modelId}`);
}

// Path traversal must be rejected for both direct lookup and path helper.
await assert.rejects(() => loadFixtureFile("../escape"), /invalid model id/i);
assert.throws(() => fixtureFilePath("..\\escape"), /invalid model id/i);
assert.throws(() => fixtureFilePath("../../escape"), /invalid model id/i);

// Malformed JSON line should report model + line context.
await withFixture("zz-selftest-malformed", "{not json}\n", async () => {
	await assert.rejects(() => loadFixtureFile("zz-selftest-malformed"), /zz-selftest-malformed\.jsonl line 1/i);
});

// Stream path regression: malformed fixtures must surface a stream error event instead of
// triggering an unhandled rejection from the fire-and-forget async IIFE.
await withFixture("zz-selftest-stream-error", "{not json}\n", async () => {
	resetMockLLMCursor("zz-selftest-stream-error");
	const model = { id: "zz-selftest-stream-error", provider: "mock-llm", api: "mock-llm-stream" };
	let unhandled = null;
	const onUnhandled = (reason) => { unhandled = reason; };
	process.once("unhandledRejection", onUnhandled);
	const { events, result } = await collect(streamMockLLM(model, makeContext()));
	await new Promise((resolve) => setTimeout(resolve, 0));
	process.removeListener("unhandledRejection", onUnhandled);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage, /json|line 1|malformed/i);
	assert.equal(events.filter((event) => event.type === "error").length, 1);
	assert.equal(unhandled, null);
});

// Terminal emission regression: if the stream end path throws while replayTurn is already
// handling an error, the helper must keep the terminal signal single-shot.
await withFixture("zz-selftest-double-terminal", JSON.stringify({ stopReason: "stop", events: [{ type: "error", kind: "429", status: 429 }] }) + "\n", async () => {
	resetMockLLMCursor("zz-selftest-double-terminal");
	const model = { id: "zz-selftest-double-terminal", provider: "mock-llm", api: "mock-llm-stream" };
	const stream = streamMockLLM(model, makeContext());
	stream.end = () => { throw new Error("end boom"); };
	let unhandled = null;
	const onUnhandled = (reason) => { unhandled = reason; };
	process.once("unhandledRejection", onUnhandled);
	const { events, result } = await collect(stream);
	await new Promise((resolve) => setTimeout(resolve, 0));
	process.removeListener("unhandledRejection", onUnhandled);
	assert.equal(result.stopReason, "error");
	assert.equal(events.filter((event) => event.type === "error").length, 1);
	assert.equal(unhandled, null);
});

// Missing required field should surface a clear error.
await withFixture("zz-selftest-missing-field", JSON.stringify({ events: [{ type: "text", delayMs: 0 }] }) + "\n", async () => {
	await assert.rejects(() => loadFixtureFile("zz-selftest-missing-field"), /missing text/i);
});

// Invalid delay values should be rejected.
await withFixture("zz-selftest-negative-delay", JSON.stringify({ events: [{ type: "text", text: "hi", delayMs: -1 }] }) + "\n", async () => {
	await assert.rejects(() => loadFixtureFile("zz-selftest-negative-delay"), /delayMs/i);
});

// Script exhaustion should become a terminal error on the second request.
await withFixture("zz-selftest-script-exhausted", JSON.stringify({ stopReason: "stop", events: [{ type: "text", text: "one turn" }] }) + "\n", async () => {
	resetMockLLMCursor("zz-selftest-script-exhausted");
	const model = { id: "zz-selftest-script-exhausted", provider: "mock-llm", api: "mock-llm-stream" };
	const first = await collect(streamMockLLM(model, makeContext()));
	assert.equal(first.result.stopReason, "stop");
	const second = await collect(streamMockLLM(model, makeContext()));
	assert.equal(second.result.stopReason, "error");
	assert.match(second.result.errorMessage, /script_exhausted/i);
});

// Transcript ordering must include start -> text_start -> ... -> done for a successful request.
await withFixture("zz-selftest-transcript-order", JSON.stringify({ stopReason: "stop", events: [{ type: "text", text: "hello", chunks: ["he", "llo"] }, { type: "stop", reason: "stop" }] }) + "\n", async () => {
	resetMockLLMCursor("zz-selftest-transcript-order");
	const model = { id: "zz-selftest-transcript-order", provider: "mock-llm", api: "mock-llm-stream" };
	const { events, result } = await collect(streamMockLLM(model, makeContext()));
	assert.equal(result.stopReason, "stop");
	assert.ok(events.some((event) => event.type === "text_start"));
	const transcript = await latestTranscript("zz-selftest-transcript-order");
	const types = transcript.events.map((event) => event.type);
	assert.equal(types[0], "start");
	assert.ok(types.includes("text_start"));
	assert.ok(types.includes("text_delta"));
	assert.ok(types.includes("text_end"));
	assert.equal(types.at(-1), "done");
	assert.ok(types.indexOf("start") < types.indexOf("text_start"));
	assert.ok(types.indexOf("text_start") < types.indexOf("done"));
});

// Existing scenario coverage stays intact.
{
	resetMockLLMCursor("429-mid-edit");
	const model = registered.config.models.find((m) => m.id === "429-mid-edit");
	const { events, result } = await collect(streamMockLLM(model, makeContext()));
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage, /429/i);
	assert.ok(events.some((event) => event.type === "text_start"));
	assert.ok(events.some((event) => event.type === "toolcall_start"));
	assert.ok(events.some((event) => event.type === "error"));
	const transcript = await latestTranscript("429-mid-edit");
	assert.equal(transcript.final.status, "error");
	assert.ok(transcript.events.some((event) => event.type === "toolcall_start"));
	assert.ok(transcript.events.some((event) => event.type === "error"));
}

{
	resetMockLLMCursor("response-missing-settle");
	const model = registered.config.models.find((m) => m.id === "response-missing-settle");
	const ac = new AbortController();
	const stream = streamMockLLM(model, makeContext(), { signal: ac.signal });
	const finisher = collect(stream);
	setTimeout(() => ac.abort(), 50);
	const { result } = await finisher;
	assert.equal(result.stopReason, "aborted");
	assert.match(result.errorMessage, /aborted/i);
	const transcript = await latestTranscript("response-missing-settle");
	assert.equal(transcript.final.status, "error");
}

{
	resetMockLLMCursor("drift-then-wake");
	const model = registered.config.models.find((m) => m.id === "drift-then-wake");
	const ac1 = new AbortController();
	const turn1 = streamMockLLM(model, makeContext(), { signal: ac1.signal });
	const turn1Done = collect(turn1);
	setTimeout(() => ac1.abort(), 50);
	const { result: result1 } = await turn1Done;
	assert.equal(result1.stopReason, "aborted");

	const { result: result2, events } = await collect(streamMockLLM(model, makeContext()));
	assert.equal(result2.stopReason, "stop");
	assert.ok(events.some((event) => event.type === "text_delta"));
	const transcript = await latestTranscript("drift-then-wake");
	assert.ok(transcript.events.some((event) => event.type === "done" || event.type === "error"));
}

{
	resetMockLLMCursor("edit-not-persisted");
	const model = registered.config.models.find((m) => m.id === "edit-not-persisted");
	const { result } = await collect(streamMockLLM(model, makeContext()));
	assert.equal(result.stopReason, "stop");
	assert.ok(result.content.some((block) => block.type === "toolCall"));
}

{
	resetMockLLMCursor("settled-with-open-assignment");
	const model = registered.config.models.find((m) => m.id === "settled-with-open-assignment");
	const { result } = await collect(streamMockLLM(model, makeContext()));
	assert.equal(result.stopReason, "stop");
}

console.log("mock-llm selftest passed");
await rm(tmp, { recursive: true, force: true });
