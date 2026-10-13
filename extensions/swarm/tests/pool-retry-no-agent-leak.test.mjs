#!/usr/bin/env node
/**
 * Reproducing test: transient provider error retry must NOT send internal plumbing
 * (swarm-pool-retry) into LLM context via pi.sendMessage.
 *
 * Expected (CORRECT):
 *   1. Zero messages with customType "swarm-pool-retry".
 *   2. No message sent via pi.sendMessage contains internal plumbing like "Pool:" or error status.
 *   3. ctx.ui.notify was called with the retry notice for user/operator UI display.
 *   4. Exactly one trigger message is sent to the agent to continue task.
 *
 * Actual (BUGGY pre-fix):
 *   1. sentMessages includes a message with customType "swarm-pool-retry" containing
 *      "⚠ Pool: rate_limit error on ... — retrying attempt 1/2...".
 *   2. That message leaks into LLM context via convertToLlm(role: custom).
 *   3. ctx.ui.notify is not called.
 */

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { stringify } from "yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../src/state.ts";
import { registerSwarmHooks } from "../src/hooks.ts";

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL:", name, info ?? "");
	}
};

const dir = await mkdtemp(join(tmpdir(), "pool-retry-no-leak-"));
await mkdir(join(dir, ".pi"), { recursive: true });
await writeFile(
	join(dir, ".pi", "swarm.yml"),
	stringify({
		defaultModel: "glm-5.1",
		defaultProvider: "zai-coding-cn",
		modelPool: [
			{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50 },
			{ model: "gpt-5.4-mini", provider: "openai", weight: 50 },
		],
		rotation: { strategy: "round-robin", cooldownMs: 300_000, maxRetries: 2 },
	}),
);
process.chdir(dir);
const p = paths(dir);

const sentMessages = [];
const uiNotifies = [];
const handlers = {};
const fakeModelGlm = { id: "glm-5.1", provider: "zai-coding-cn" };

const fakePi = {
	on: (ev, fn) => {
		(handlers[ev] ||= []).push(fn);
	},
	registerTool: () => {},
	registerCommand: () => {},
	setModel: async () => true,
	sendMessage: (m, o) => {
		sentMessages.push({ m, o });
	},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};

const ctx = {
	cwd: dir,
	mode: "tui",
	hasUI: true,
	ui: {
		notify: (msg, type) => {
			uiNotifies.push({ msg, type });
		},
		setStatus: () => {},
	},
	isIdle: () => true,
	model: fakeModelGlm,
	modelRegistry: {
		find: () => fakeModelGlm,
	},
};

registerSwarmHooks(fakePi);
process.env.PI_SWARM_AGENT_ID = "worker-test";

console.log("\n[Reproducing bug] Pool retry on transient error must not leak plumbing into pi.sendMessage\n");

// Strike 1: transient 429 rate limit
const err429 = "429: Too Many Requests / Rate limit reached";
await handlers["turn_end"][0](
	{
		type: "turn_end",
		turnIndex: 1,
		message: {
			role: "assistant",
			model: fakeModelGlm.id,
			provider: fakeModelGlm.provider,
			stopReason: "error",
			errorMessage: err429,
		},
		toolResults: [],
	},
	ctx,
);

const poolRetryMsg = sentMessages.find((s) => s.m?.customType === "swarm-pool-retry");
ok("No swarm-pool-retry message in sentMessages (not leaked to LLM context)", !poolRetryMsg, `found: ${JSON.stringify(poolRetryMsg)}`);

const plumbingInSent = sentMessages.filter((s) => /pool:/i.test(String(s.m?.content)));
ok("No plumbing or 'Pool:' text in sentMessages", plumbingInSent.length === 0, `found: ${JSON.stringify(plumbingInSent)}`);

const notifyFired = uiNotifies.find((n) => /pool:/i.test(n.msg) && /retrying/i.test(n.msg));
ok("User notification was displayed via ctx.ui.notify", Boolean(notifyFired), `actual uiNotifies: ${JSON.stringify(uiNotifies)}`);

const triggerMsg = sentMessages.find((s) => s.o?.triggerTurn === true);
ok("Agent trigger message was sent to continue", Boolean(triggerMsg), `sentMessages=${JSON.stringify(sentMessages)}`);

console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
process.chdir("/");
await rm(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
