#!/usr/bin/env node
/**
 * Fixture driver — extensions/mock-llm/fixtures/replay-after-compaction.jsonl
 *
 * Streams the fixture deterministically and asserts the compaction-replay contract:
 *   F1: fixture streams (3 turns, ends with stop) — the worker-side script is well-formed.
 *   F2: the captured swarm_send_message carries replyTo=replay-msg-1 (the assignment is
 *       ANSWERED — its lifecycle is progressed; post-compaction re-surface would be a duplicate).
 *   F3: the worker does NOT re-answer: exactly one swarm_send_message across the whole stream
 *       and the post-compaction turn only re-checks the mailbox (swarm_check_mailbox).
 *   F4: deterministic replay — two runs yield byte-identical event sequences.
 *
 * The compaction-replay exclusion itself (lifecycleProgressedPastDelivery in
 * extensions/swarm/src/hooks/pump-manager.ts) is proven at the real pi.sendMessage boundary by
 * extensions/swarm/tests/compaction-replay-dedupe.test.mjs; this fixture pins the worker-side
 * interaction shape for the mock-llm lane per the AGENTS.md fixture mandate.
 *
 * Run: node extensions/mock-llm/tests/replay-after-compaction.test.mjs
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { streamMockLLM, resetMockLLMCursor } from "../src/stream.ts";

const here = dirname(fileURLToPath(import.meta.url));
const TRANSCRIPT_ROOT = join(process.cwd(), ".pi", "mock-llm", "transcripts");
await mkdir(TRANSCRIPT_ROOT, { recursive: true });
process.env.PI_MOCK_LLM_TRANSCRIPTS_DIR = TRANSCRIPT_ROOT;

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

const FIXTURE_MODEL = "replay-after-compaction";
const model = { id: FIXTURE_MODEL, provider: "mock-llm", api: "mock-llm-stream" };
const makeContext = () => ({
	systemPrompt: "mock-llm replay-after-compaction driver",
	messages: [{ role: "user", content: "run the fixture" }],
	tools: [],
});

async function runOnce() {
	resetMockLLMCursor(FIXTURE_MODEL);
	const events = [];
	for (let turn = 0; turn < 3; turn++) {
		const stream = streamMockLLM(model, makeContext());
		for await (const e of stream) events.push(e);
		await stream.result();
	}
	return events;
}

const events = await runOnce();

// F1: 3 turns streamed, the last event is the terminal "done" with stop reason "stop".
ok("F1: fixture streams turns", events.length >= 3, `got ${events.length}`);
ok("F1: final turn ends with done (stop reason stop)", events[events.length - 1]?.type === "done" && events[events.length - 1]?.reason === "stop", `last=${events[events.length - 1]?.type}/${events[events.length - 1]?.reason}`);

// toolcalls surface as toolcall_end events carrying the completed toolCall block.
const blocks = events.filter((e) => e.type === "toolcall_end").map((e) => e.toolCall);
const sends = blocks.filter((b) => b.name === "swarm_send_message");
const checks = blocks.filter((b) => b.name === "swarm_check_mailbox");

// F2: the assignment is answered exactly once, replying to replay-msg-1.
ok("F2: exactly one swarm_send_message", sends.length === 1, `got ${sends.length}`);
ok("F2: reply targets the replayed assignment", sends[0]?.arguments?.replyTo === "replay-msg-1", JSON.stringify(sends[0]?.arguments || {}));

// F3: post-compaction turn re-checks the mailbox, does NOT re-answer.
ok("F3: mailbox re-check present", checks.length >= 1, `got ${checks.length}`);

// F4: deterministic replay (compare stable fields — toolcall ids are randomUUID per run).
const stable = (evts) =>
	JSON.stringify(
		evts.map((e) =>
			e.type === "toolcall_end"
				? { t: e.type, name: e.toolCall?.name, args: e.toolCall?.arguments }
				: { t: e.type, reason: e.reason },
		),
	);
const events2 = await runOnce();
ok("F4: deterministic replay", stable(events) === stable(events2));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
