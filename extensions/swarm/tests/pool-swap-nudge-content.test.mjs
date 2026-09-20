#!/usr/bin/env node
/**
 * Reproducing test: pool swap nudge content after 429 should NOT include error body text.
 *
 * Bug: After a successful model pool swap (quota 429 → switch provider), the nudge message
 * sent to the agent embeds the raw errorText (up to 160 chars of the 429 body). This causes
 * the agent to read the lengthy error reasoning instead of simply continuing its current task.
 *
 * Expected (CORRECT): nudge says "switched to <new-slot>, continue your task" — NO error text.
 * Actual (BUGGY):     nudge says "...failed with a quota error from X (You exceeded your current
 *                     quota, please check your plan and billing details). That slot was benched..."
 *
 * Red criterion: sentMessages[0].m.content CONTAINS errorText substring → BUG.
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

const dir = await mkdtemp(join(tmpdir(), "pool-swap-nudge-content-"));
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
	isIdle: () => true,
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

console.log("\n[Reproducing bug] 429 quota swap nudge should NOT contain raw error text");
{
	process.env.PI_SWARM_AGENT_ID = "worker-b";
	delete process.env.PI_SWARM_IS_ROOT;

	const t0 = Date.now();
	await withLock(p, async () => {
		const st = await readState(p, dir);
		ensureRoot(st, dir, p);
		st.agents["worker-b"] = {
			id: "worker-b",
			role: "implementer",
			roleKind: "implementer",
			status: "running",
			runtimeStatus: "busy",
			health: "healthy",
			tmuxAlive: true,
			lastHeartbeatAt: new Date(t0).toISOString(),
			activeTaskIds: ["task-test-2"],
			model: "glm-5.1",
			provider: "zai-coding-cn",
		};
		await writeState(p, st);
	});

	// The raw 429 error text that currently gets embedded in the nudge
	const RAW_ERROR_TEXT =
		'You exceeded your current quota, please check your plan and billing details. resets_in_seconds=12345';
	const errText = `429: {"error":{"message":"${RAW_ERROR_TEXT}","type":"insufficient_quota","code":"insufficient_quota"}}`;

	// Trigger ENGINE_MAX_RETRIES error turns to exhaust the engine gate and trigger a swap
	for (let i = 0; i < ENGINE_MAX_RETRIES; i++) {
		await handlers["turn_end"][0](
			{
				type: "turn_end",
				turnIndex: i + 1,
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
	}

	// After ENGINE_MAX_RETRIES strikes, a swap should have fired
	ok("setModel was called (swap happened)", setModelCalls.length >= 1, `setModel calls: ${JSON.stringify(setModelCalls)}`);
	ok("a nudge message was sent to the agent", sentMessages.length >= 1, `sentMessages.length=${sentMessages.length}`);

	// === New behavior: two separate messages ===
	// 1. user-facing pool event warning (display: true, no triggerTurn)
	// 2. minimal agent nudge ("Continue your current task.", triggerTurn: true)
	const triggerMsg = sentMessages.find((s) => s.o?.triggerTurn === true);
	const displayMsg = sentMessages.find((s) => s.m?.display === true && !s.o?.triggerTurn);

	console.log("\n  [all sent messages]:");
	sentMessages.forEach((s, i) => console.log(`  [${i}] opts=${JSON.stringify(s.o)} content=${String(s.m.content).slice(0, 150)}`));

	// The trigger message (what the LLM reads) must be just "continue"
	ok("a triggerTurn message was sent", !!triggerMsg, `sentMessages opts: ${JSON.stringify(sentMessages.map((s) => s.o))}`);
	if (triggerMsg) {
		const content = String(triggerMsg.m.content);
		const isMinimal = content.toLowerCase().includes("continue") &&
			!content.includes("gpt-5.4-mini") &&
			!content.includes("openai") &&
			!content.includes("glm") &&
			!content.includes("quota") &&
			!content.includes("error") &&
			!content.includes("exceeded");
		ok(
			"agent trigger message is minimal continue-only (no model/error info in LLM context)",
			isMinimal,
			`trigger content: ${content.slice(0, 300)}`,
		);
	}

	// The display-only message (what the user sees) should carry pool event info
	ok("a user-facing display-only warning was sent (no triggerTurn)", !!displayMsg, `sentMessages: ${JSON.stringify(sentMessages.map((s) => s.o))}`);
	if (displayMsg) {
		const warnContent = String(displayMsg.m.content);
		const hasPoolInfo = warnContent.includes("gpt-5.4-mini") || warnContent.includes("openai") || warnContent.includes("quota");
		ok("user warning contains pool event info (new slot or error kind)", hasPoolInfo, `warn content: ${warnContent.slice(0, 200)}`);
	}
}

console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
// Exit non-zero when tests PASS (pre-fix = bug is reproduced = test should be RED)
// This test is written to be RED before fix and GREEN after fix.
if (fail > 0) process.exit(1);
