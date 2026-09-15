#!/usr/bin/env node
/**
 * Test: Worker during LLM error (retry or pool swap) must NOT emit false settled nudges to root.
 *
 * Covers:
 * 1. Strike 1 error (within engine-retry window): agent_settled must NOT enqueue
 *    "settled with missing response" or "settled with open assignment" to root.
 * 2. Strike 2 error (triggers pool.swap with ENGINE_MAX_RETRIES=2):
 *    agent_settled during swap handoff must NOT notify root and must NOT mark worker as response_missing.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { paths, readState, withLock, writeState, ensureDirs } = await import(join(here, "..", "src", "state.ts"));
const { ensureRoot } = await import(join(here, "..", "src", "identity.ts"));
const { registerSwarmHooks } = await import(join(here, "..", "src", "hooks.ts"));
const { ENGINE_MAX_RETRIES } = await import(join(here, "..", "src", "constants.ts"));

const dir = await mkdtemp(join(tmpdir(), "pool-retry-settle-"));
await mkdir(join(dir, ".pi"), { recursive: true });
await writeFile(
	join(dir, ".pi", "settings.json"),
	JSON.stringify({
		swarm: {
			defaultModel: "glm-5.1",
			defaultProvider: "zai-coding-cn",
			modelPool: [
				{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50 },
				{ model: "gpt-5.4-mini", provider: "openai", weight: 50 },
			],
		},
	}),
);
process.chdir(dir);
const p = paths(dir);
await ensureDirs(p);

const sentMessages = [];
const setModelCalls = [];
const handlers = {};
const fakeModelGlm = { id: "glm-5.1", provider: "zai-coding-cn" };
const fakeModelGpt = { id: "gpt-5.4-mini", provider: "openai" };

const pi = {
	registerTool: () => {},
	registerCommand: () => {},
	on: (ev, fn) => {
		(handlers[ev] ||= []).push(fn);
	},
	setModel: async (m) => {
		setModelCalls.push(`${m.provider}/${m.id}`);
		return true;
	},
	sendMessage: (m, o) => {
		sentMessages.push({ m, o });
	},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};

const ctx = {
	cwd: dir,
	mode: "tui",
	isIdle: () => false,
	model: fakeModelGlm,
	modelRegistry: {
		find: (provider, id) => {
			if (id === "gpt-5.4-mini") return fakeModelGpt;
			if (id === "glm-5.1") return fakeModelGlm;
			return undefined;
		},
	},
};

let pass = 0;
let fail = 0;
const ok = (n, c, info) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL:", n, info ?? "");
	}
};

registerSwarmHooks(pi);

console.log("\n[Test 1] Strike 1 429 quota error: engine retry must suppress agent_settled nudges to root");
{
	const t0 = Date.now();
	process.env.PI_SWARM_AGENT_ID = "worker-a";
	delete process.env.PI_SWARM_IS_ROOT;

	await withLock(p, async () => {
		const st = await readState(p, dir);
		ensureRoot(st, dir, p);
		st.agents["worker-a"] = {
			id: "worker-a",
			role: "implementer",
			roleKind: "implementer",
			status: "running",
			runtimeStatus: "busy",
			health: "healthy",
			tmuxAlive: true,
			lastHeartbeatAt: new Date(t0).toISOString(),
			activeTaskIds: ["task-test-1"],
			model: "glm-5.1",
			provider: "zai-coding-cn",
		};
		// Seed a pending requiresResponse message
		st.messages["msg-work-1"] = {
			id: "msg-work-1",
			from: "root",
			to: "worker-a",
			subject: "implement task-test-1",
			createdAt: new Date(t0 - 1000).toISOString(),
			requiresResponse: true,
		};
		await writeState(p, st);
	});

	// Trigger error turn_end (Strike 1: 429 quota error)
	const errText = '429: {"type":"usage_limit_reached","message":"The usage limit has been reached"}';
	await handlers["turn_end"][0](
		{
			type: "turn_end",
			turnIndex: 1,
			message: {
				role: "assistant",
				model: fakeModelGlm.id,
				provider: fakeModelGlm.provider,
				stopReason: "error",
				errorMessage: errText,
			},
			toolResults: [],
		},
		{ ...ctx, model: fakeModelGlm },
	);

	// Pi fires agent_settled for the failed turn
	await handlers["agent_settled"][0]({}, ctx);

	const stAfterSettle = await readState(p, dir);
	const rootMsgs = Object.values(stAfterSettle.messages).filter((m) => m.to === "root" && m.from === "worker-a");
	ok(
		"Strike 1: zero messages sent to root on agent_settled during engine retry",
		rootMsgs.length === 0,
		`found root messages: ${JSON.stringify(rootMsgs.map((m) => m.subject))}`,
	);
	ok(
		"Strike 1: worker runtimeStatus is NOT changed to response_missing",
		stAfterSettle.agents["worker-a"].runtimeStatus !== "response_missing",
		`runtimeStatus: ${stAfterSettle.agents["worker-a"].runtimeStatus}`,
	);
}

console.log("\n[Test 2] Strike 2 triggers pool swap and suppresses agent_settled nudges to root");
{
	ok("ENGINE_MAX_RETRIES is configured to 2", ENGINE_MAX_RETRIES === 2, `actual: ${ENGINE_MAX_RETRIES}`);

	const errText = '429: {"type":"usage_limit_reached","message":"The usage limit has been reached"}';
	// Trigger Strike 2: should exhaust and trigger pool.swap
	await handlers["turn_end"][0](
		{
			type: "turn_end",
			turnIndex: 2,
			message: {
				role: "assistant",
				model: fakeModelGlm.id,
				provider: fakeModelGlm.provider,
				stopReason: "error",
				errorMessage: errText,
			},
			toolResults: [],
		},
		{ ...ctx, model: fakeModelGlm },
	);

	ok("Strike 2: setModel was called to rotate model", setModelCalls.length >= 1, `calls: ${JSON.stringify(setModelCalls)}`);

	// Pi fires agent_settled during the swap handoff
	await handlers["agent_settled"][0]({}, ctx);

	const stAfterSwapSettle = await readState(p, dir);
	const rootMsgs = Object.values(stAfterSwapSettle.messages).filter((m) => m.to === "root" && m.from === "worker-a");
	ok(
		"Strike 2: zero messages sent to root on agent_settled during pool swap handoff",
		rootMsgs.length === 0,
		`found root messages: ${JSON.stringify(rootMsgs.map((m) => m.subject))}`,
	);
	ok(
		"Strike 2: worker runtimeStatus is NOT response_missing",
		stAfterSwapSettle.agents["worker-a"].runtimeStatus !== "response_missing",
		`runtimeStatus: ${stAfterSwapSettle.agents["worker-a"].runtimeStatus}`,
	);
}

console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
