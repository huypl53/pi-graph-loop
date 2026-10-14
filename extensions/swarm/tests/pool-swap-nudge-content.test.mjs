#!/usr/bin/env node
/**
 * Reproducing test (2 bugs, one lane):
 *
 * Bug 1 (original): pool swap nudge embeds raw error body text in the agent trigger message.
 *   Expected: nudge says "Continue your current task." — NO error text.
 *
 * Bug 2 (2026-10-14, task pool-event-context-leak): the operator-facing swap notice is sent as a
 *   session custom message (customType "swarm-pool-event", display:true, deliverAs:"followUp").
 *   The in-code comment claims it never reaches the LLM — FALSE per pi-runtime-contract.md §2:
 *   every pi.sendMessage custom message participates in LLM context (display is TUI-render-only,
 *   deliverAs is timing-only). Each swap therefore leaks one "⚠ Pool: …" line into the agent's
 *   context window, permanently (it is persisted to the session).
 *
 * Expected (CORRECT, post-fix):
 *   - LLM sees exactly ONE message per swap: "Continue your current task." (swarm-message, triggerTurn).
 *   - The operator sees the swap warning ONLY via ctx.ui.notify (L3, zero LLM consumption).
 *   - Headless (ctx.hasUI === false): no notify, no throw, still exactly the one trigger message.
 *
 * Red criterion (bug 2): sentMessages contains a customType "swarm-pool-event" → CONTEXT LEAK → BUG.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { paths, readState, withLock, writeState, ensureDirs } = await import(join(here, "..", "src", "state.ts"));
const { ensureRoot } = await import(join(here, "..", "src", "identity.ts"));
const { registerSwarmHooks } = await import(join(here, "..", "src", "hooks.ts"));
const { ENGINE_MAX_RETRIES } = await import(join(here, "..", "src", "constants.ts"));

const uiNotifications = [];
const dir = await mkdtemp(join(tmpdir(), "pool-swap-nudge-content-"));
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
	hasUI: true,
	ui: {
		notify: (text, level) => {
			uiNotifications.push({ text: String(text), level });
		},
	},
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
	const RAW_ERROR_TEXT = "You exceeded your current quota, please check your plan and billing details. resets_in_seconds=12345";
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

	// === Post-fix contract (bug 2 + bug 1) ===
	// Exactly ONE session message crosses the pi.sendMessage boundary per swap — the continue-only
	// trigger. The operator warning moves to ctx.ui.notify (L3-only, never LLM context).
	const poolEventMsgs = sentMessages.filter((s) => s.m?.customType === "swarm-pool-event");
	const triggerMsg = sentMessages.find((s) => s.o?.triggerTurn === true);

	console.log("\n  [all sent messages]:");
	sentMessages.forEach((s, i) => console.log(`  [${i}] opts=${JSON.stringify(s.o)} content=${String(s.m.content).slice(0, 150)}`));
	console.log("  [ui notifications]:", JSON.stringify(uiNotifications));

	// THE REPRODUCTION: no swarm-pool-event custom message may exist — it lands in LLM context.
	ok(
		"no swarm-pool-event custom message sent (context-leak repro)",
		poolEventMsgs.length === 0,
		`leaked: ${JSON.stringify(poolEventMsgs.map((s) => String(s.m.content).slice(0, 120)))}`,
	);
	ok("exactly one session message per swap (continue-note only)", sentMessages.length === 2 && sentMessages[0].m.content.includes("(retrying)"), `sentMessages.length=${sentMessages.length} (strike-1 gated retry note + swap trigger expected)`);

	// The trigger message (what the LLM reads) must be just "continue"
	ok("a triggerTurn message was sent", !!triggerMsg, `sentMessages opts: ${JSON.stringify(sentMessages.map((s) => s.o))}`);
	if (triggerMsg) {
		const content = String(triggerMsg.m.content);
		const isMinimal =
			content.toLowerCase().includes("continue") &&
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

	// The operator warning surfaces via ctx.ui.notify (L3) carrying pool event info
	const notifyMsg = uiNotifications.find((n) => n.text.includes("⚠ Pool:"));
	ok("operator swap warning surfaced via ctx.ui.notify", !!notifyMsg, JSON.stringify(uiNotifications));
	if (notifyMsg) {
		const hasPoolInfo = notifyMsg.text.includes("gpt-5.4-mini") || notifyMsg.text.includes("openai") || notifyMsg.text.includes("quota");
		ok("operator notify contains pool event info (new slot or error kind)", hasPoolInfo, `notify text: ${notifyMsg.text.slice(0, 200)}`);
	}
}

// --- Headless control (R4): ctx.hasUI === false → no notify, no throw, still one trigger send ---
{
	uiNotifications.length = 0;
	sentMessages.length = 0;
	setModelCalls.length = 0;
	process.env.PI_SWARM_AGENT_ID = "worker-headless";
	delete process.env.PI_SWARM_IS_ROOT;

	await withLock(p, async () => {
		const st = await readState(p, dir);
		ensureRoot(st, dir, p);
		st.agents["worker-headless"] = {
			id: "worker-headless",
			role: "implementer",
			roleKind: "implementer",
			status: "running",
			runtimeStatus: "busy",
			health: "healthy",
			tmuxAlive: true,
			lastHeartbeatAt: new Date().toISOString(),
			activeTaskIds: [],
			model: "glm-5.1",
			provider: "zai-coding-cn",
		};
		await writeState(p, st);
	});

	const headlessCtx = { ...ctx, hasUI: false };
	delete headlessCtx.ui;
	const headlessErr = `429: {"error":{"message":"quota again","type":"insufficient_quota","code":"insufficient_quota"}}`;
	for (let i = 0; i < ENGINE_MAX_RETRIES; i++) {
		await handlers["turn_end"][0](
			{
				type: "turn_end",
				turnIndex: i + 1,
				message: { role: "assistant", model: fakeModelGlm.id, provider: fakeModelGlm.provider, stopReason: "error", errorMessage: headlessErr },
				toolResults: [],
			},
			{ ...headlessCtx, model: fakeModelGlm },
		);
	}

	ok("headless: swap still fired (rotation must not depend on UI)", setModelCalls.length >= 1, JSON.stringify(setModelCalls));
	ok("headless: zero ctx.ui.notify calls", uiNotifications.length === 0, JSON.stringify(uiNotifications));
	ok(
		"headless: zero swarm-pool-event customs; every send is a swarm-message continue-note",
		sentMessages.length >= 1 && sentMessages.every((s) => s.m?.customType === "swarm-message"),
		JSON.stringify(sentMessages.map((s) => s.m?.customType)),
	);
}

console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
// RED before fix (context leak present), GREEN after fix.
if (fail > 0) process.exit(1);
