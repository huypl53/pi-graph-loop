// Incident 2026-10-11 (session 01a12883): single-shot non-retryable provider-limit errors
// (ChatGPT "You have hit your ChatGPT usage limit.") never rotate the pool.
//
// Root cause (verified against pi runtime source): pi's engine fail-fasts on non-retryable
// quota/billing errors — `isRetryableAssistantError` (pi-ai retry.js) matches them against
// NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN and returns false, so _prepareRetry is NEVER
// called and the session surfaces EXACTLY ONE turn_end { stopReason: "error" }. The Issue 17
// engine-retry gate requires ENGINE_MAX_RETRIES (=2) same-incident strikes before it opens
// the auto-swap path, so a quota error that pi itself will never retry is stuck forever at
// count:1 — no bench (the immediate quota bench lives behind the same gate), no swap, and
// the session dies on a pool that still has healthy slots (live: 01:48:23 glm-4.7 usage
// limit, gated count:1, session end; pool had 4 healthy alternatives).
//
// This suite pins the corrected contract:
//   F1: quota-kind single strike (usage-limit body) opens the gate IMMEDIATELY — bench with
//       lastBenchReason=quota, engine_retry_exhausted trace (singleStrike:true), swap to a
//       different slot, swap note sent.
//   F2: auth-kind single strike (invalid key) behaves the same (auth is also fail-fast in pi
//       and immediate-bench in recordProviderError).
//   F3: rate_limit stays gated (pi DOES retry plain rate limits — the gate must keep waiting
//       for the burst; this is the anti-regression for Bug A's fix).
//   F4: transient stays gated (single ECONNREFUSED strike — no swap, no bench).
//   F5: success-turn reset still works after a single-strike quota swap (fresh incident on
//       the next slot's error).
//   F6 (D5 semantics 2026-10-14): probe swaps are exempt from MAX_SWAP_CHAIN — the ring
//       itself bounds the cascade; post-exhaustion errors are fenced by nextProbeAt.
//   F7: guest sessions never rotate even on single-strike quota errors.
//   F8: the exact proxy buffer-limit failure rotates on its first request-limit strike.
//   F9: the auth_unavailable wrapper carrying nested request-buffer text honors its existing
//       request_limit classification and rotates on the one-strike policy.
//
// Run: node extensions/swarm/tests/pool-single-strike-nonretryable.test.mjs
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { stringify } from "yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, readState, writeState } from "../src/state.ts";
import { registerSwarmHooks } from "../src/hooks.ts";
import { poolStatus, slotKey } from "../src/pool.ts";
import { classifyProviderError } from "../src/types.ts";

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) pass++;
	else {
		fail++;
		console.error("  FAIL:", name, info ?? "");
	}
};

// --- fixture project with a model pool ---
const dir = await mkdtemp(join(tmpdir(), "pool-single-strike-"));
await mkdir(join(dir, ".pi"), { recursive: true });
await writeFile(
	join(dir, ".pi", "swarm.yml"),
	stringify({
		defaultModel: "glm-5.1",
		defaultProvider: "zai-coding-cn",
		modelPool: [
			{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50 },
			{ model: "gpt-5.4-mini", provider: "openai", weight: 30 },
			{ model: "claude-sonnet-4", provider: "anthropic", weight: 0 },
		],
		rotation: { strategy: "round-robin", cooldownMs: 300_000, maxRetries: 2 },
	}),
);
process.chdir(dir);
const p = paths(dir);

// --- fake pi capturing setModel + sendMessage ---
const setModelCalls = [];
const sentMessages = [];
const notifications = [];
const handlers = {};
const fakePi = {
	on: (ev, fn) => {
		(handlers[ev] ||= []).push(fn);
	},
	registerTool: () => {},
	registerCommand: () => {},
	setModel: async (m) => {
		setModelCalls.push(`${m.provider}/${m.id}`);
		return true;
	},
	sendMessage: (m, o) => {
		sentMessages.push({ m, o });
	},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};
const fakeModelGlm = { id: "glm-5.1", provider: "zai-coding-cn" };
const fakeModelGpt = { id: "gpt-5.4-mini", provider: "openai" };
const fakeModelClaude = { id: "claude-sonnet-4", provider: "anthropic" };
const ctx = {
	cwd: dir,
	mode: "tui",
	hasUI: true,
	ui: { notify: (text, level) => notifications.push({ text: String(text), level }) },
	isIdle: () => true,
	model: fakeModelGlm,
	modelRegistry: {
		find: (provider, id) => {
			if (id === "gpt-5.4-mini") return fakeModelGpt;
			if (id === "claude-sonnet-4") return fakeModelClaude;
			if (id === "glm-5.1") return fakeModelGlm;
			return undefined;
		},
	},
};

registerSwarmHooks(fakePi);
const turnEnd = handlers["turn_end"][0];

// The exact live body from session 01a12883 (01:48:23, glm-4.7/cliproxyapi).
const CHATGPT_USAGE_LIMIT = "You have hit your ChatGPT usage limit.";

async function errOnce(model, errorMessage, agentId) {
	if (agentId) process.env.PI_SWARM_AGENT_ID = agentId;
	await turnEnd(
		{
			type: "turn_end",
			turnIndex: Math.floor(Math.random() * 100000),
			message: {
				role: "assistant",
				model: model.id,
				provider: model.provider,
				stopReason: "error",
				errorMessage,
			},
			toolResults: [],
		},
		{ ...ctx, model },
	);
}

async function countTraceEvents(name) {
	try {
		const raw = await readFile(p.events, "utf8");
		return raw
			.split("\n")
			.filter(Boolean)
			.filter((l) => {
				try {
					return JSON.parse(l).event === name;
				} catch {
					return false;
				}
			}).length;
	} catch {
		return 0;
	}
}

async function freshSession(agentId = `worker-${Math.random().toString(36).slice(2, 8)}`) {
	const { rm: rmf } = await import("node:fs/promises");
	const { _resetTurnStartForTests } = await import("../src/hooks/streaks.ts");
	await rmf(join(dir, ".pi", "swarm", "pool-state.json"), { force: true }).catch(() => {});
	await rmf(p.events, { force: true }).catch(() => {});
	setModelCalls.length = 0;
	sentMessages.length = 0;
	_resetTurnStartForTests(); // in-process liveness stamps must not leak across scenarios
	process.env.PI_SWARM_AGENT_ID = agentId;
	// Seed agent record so currentAgentId resolves.
	const st = await readState(p, dir);
	const ts = new Date().toISOString();
	st.agents[agentId] = {
		id: agentId,
		role: "worker",
		roleKind: "worker",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxSession: "sess",
		tmuxWindow: agentId,
		tmuxTarget: `sess:${agentId}.0`,
		model: "glm-5.1",
		provider: "zai-coding-cn",
		cwd: dir,
		mailbox: ".pi/swarm/mailboxes/x.jsonl",
		createdAt: ts,
		updatedAt: ts,
	};
	await writeState(p, st);
}

// Classification sanity for the exact live body.
ok("chatgpt usage-limit body classifies as quota", classifyProviderError(CHATGPT_USAGE_LIMIT) === "quota");
ok("proxy auth_unavailable wrapper classifies as auth", classifyProviderError("auth_unavailable: no auth available") === "auth");

// =============================================================
// F1: quota strike gates first to allow engine retry (preserves cache), swaps on retry exhausted
// =============================================================
{
	await freshSession("worker-quota");
	await errOnce(fakeModelGlm, CHATGPT_USAGE_LIMIT);
	ok(
		"F1: first quota strike does NOT swap (gated to preserve cache for retry)",
		setModelCalls.length === 0,
		`calls=${setModelCalls.length}`,
	);
	// 2nd strike (engine retries exhausted)
	await errOnce(fakeModelGlm, CHATGPT_USAGE_LIMIT);
	ok("F1: quota strike swaps after engine retries exhausted", setModelCalls.length === 1, `calls=${setModelCalls.length}`);
	if (setModelCalls.length > 0)
		ok("F1: swapped to a DIFFERENT slot", setModelCalls[0] !== "zai-coding-cn/glm-5.1", `to=${setModelCalls[0]}`);
	const ps = await poolStatus(p);
	const glm = ps.slots.find((s) => s.model === "glm-5.1");
	ok("F1: quota slot benched after retries exhausted", Boolean(glm?.inCooldown), JSON.stringify(glm?.health ?? null));
	ok("F1: benched with lastBenchReason=quota", glm?.health?.lastBenchReason === "quota", `reason=${glm?.health?.lastBenchReason}`);
	const exhausted = await countTraceEvents("pool.engine_retry_exhausted");
	ok("F1: engine_retry_exhausted fired once", exhausted === 1, `exhausted=${exhausted}`);
	const swaps = await countTraceEvents("pool.swap");
	ok("F1: pool.swap trace fired", swaps === 1, `swaps=${swaps}`);
	ok(
		"F1: swap notify sent to the operator (L3, never LLM context)",
		notifications.some((n) => n.text.includes("Pool:") && n.text.includes("quota")),
		JSON.stringify({ notifications, sends: sentMessages.map((s) => s.m.content?.slice(0, 60)) }),
	);
	ok(
		"F1: agent trigger stays continue-only (no pool wording in LLM context)",
		sentMessages.every((s) => !/⚠ Pool:/.test(s.m.content) && /Continue your current task/.test(s.m.content)),
		JSON.stringify(sentMessages.map((s) => s.m.content?.slice(0, 60))),
	);
}

// =============================================================
// F2: auth strike gates first, then swaps and benches without 6h floor
// =============================================================
{
	await freshSession("worker-auth");
	await errOnce(fakeModelGlm, "401 Invalid API key provided");
	ok("F2: first auth strike does NOT swap (gated)", setModelCalls.length === 0, `calls=${setModelCalls.length}`);
	await errOnce(fakeModelGlm, "401 Invalid API key provided");
	ok("F2: auth strike swaps after retries exhausted", setModelCalls.length === 1, `calls=${setModelCalls.length}`);
	const ps = await poolStatus(p);
	const glm = ps.slots.find((s) => s.model === "glm-5.1");
	ok("F2: auth slot benched after retries exhausted", Boolean(glm?.inCooldown), JSON.stringify(glm?.health ?? null));
	ok("F2: benched with lastBenchReason=auth", glm?.health?.lastBenchReason === "auth", `reason=${glm?.health?.lastBenchReason}`);
	ok(
		"F2: bench duration honors cooldownMs (300,000ms), NOT 6-hour floor",
		glm?.health?.lastBenchMs === 300_000,
		`actual lastBenchMs=${glm?.health?.lastBenchMs}`,
	);
}

// =============================================================
// F8: exact live upstream buffer-limit failure bypasses the retry gate on its first strike
// =============================================================
{
	await freshSession("worker-buffer-limit");
	await errOnce(fakeModelGlm, "exceeded request buffer limit while retrying upstream");
	ok(
		"F8: exact proxy buffer-limit failure rotates on its first strike",
		setModelCalls.length === 1 && setModelCalls[0] !== "zai-coding-cn/glm-5.1",
		`calls=${JSON.stringify(setModelCalls)}`,
	);
	ok("F8: terminal request-limit path crosses pi.sendMessage boundary exactly once (continue-note)", sentMessages.length === 1, `calls=${sentMessages.length}`);
	ok(
		"F8: boundary send is the continue-only trigger",
		sentMessages.length === 1 && sentMessages[0].m.customType === "swarm-message" && sentMessages[0].m.content.includes("Continue"),
		JSON.stringify(sentMessages.map(({ m }) => ({ customType: m.customType, content: String(m.content).slice(0, 60) }))),
	);
	ok(
		"F8: operator sees the swap warning via ctx.ui.notify",
		notifications.some((n) => n.text.includes("⚠ Pool:")),
		JSON.stringify(notifications),
	);
	ok("F8: no retry-gate trace for request_limit", (await countTraceEvents("pool.swap_gated_by_engine_retry")) === 0);
	ok("F8: first strike records retry exhaustion", (await countTraceEvents("pool.engine_retry_exhausted")) === 1);
}

// =============================================================
// F9: the proxy's wrapped error keeps its request_limit classification — one-strike rotation
// =============================================================
{
	await freshSession("worker-auth-unavailable");
	const msg =
		"auth_unavailable: no auth available (providers=codex, model=gpt-6-luna; last upstream error: exceeded request buffer limit while retrying upstream)";
	ok("F9: nested buffer-limit wrapper classifies as request_limit", classifyProviderError(msg) === "request_limit");
	await errOnce(fakeModelGlm, msg);
	ok(
		"F9: nested request-limit error rotates on its first strike",
		setModelCalls.length === 1 && setModelCalls[0] !== "zai-coding-cn/glm-5.1",
		`calls=${JSON.stringify(setModelCalls)}`,
	);
}

// =============================================================
// F3: plain rate_limit stays gated (pi retries those — anti-regression)
// =============================================================
{
	await freshSession("worker-ratelimit");
	await errOnce(fakeModelGlm, "429 Too Many Requests: rate limit exceeded");
	ok("F3: rate_limit single strike does NOT swap", setModelCalls.length === 0, `calls=${setModelCalls.length}`);
	const gated = await countTraceEvents("pool.swap_gated_by_engine_retry");
	ok("F3: gate trace fired (waiting for engine retries)", gated === 1, `gated=${gated}`);
	const ps = await poolStatus(p);
	const glm = ps.slots.find((s) => s.model === "glm-5.1");
	ok("F3: no bench on gated rate_limit", !glm?.inCooldown, JSON.stringify(glm?.health ?? null));
}

// =============================================================
// F4: transient stays gated
// =============================================================
{
	await freshSession("worker-transient");
	await errOnce(fakeModelGlm, "Codex SSE response headers timed out after 300000ms");
	ok("F4: transient single strike does NOT swap", setModelCalls.length === 0, `calls=${setModelCalls.length}`);
	const gated = await countTraceEvents("pool.swap_gated_by_engine_retry");
	ok("F4: gate trace fired", gated === 1, `gated=${gated}`);
}

// =============================================================
// F5: success turn clears state; next error on the NEW slot starts fresh
// =============================================================
{
	await freshSession("worker-reset");
	await errOnce(fakeModelGlm, CHATGPT_USAGE_LIMIT);
	await errOnce(fakeModelGlm, CHATGPT_USAGE_LIMIT); // swap glm -> gpt
	if (setModelCalls.length !== 1) {
		ok("F5: precondition — first strike swapped", false, `calls=${setModelCalls.length}`);
	} else {
		// Healthy turn on the new slot.
		await turnEnd(
			{
				type: "turn_end",
				turnIndex: 90001,
				message: { role: "assistant", model: "gpt-5.4-mini", provider: "openai", stopReason: "stop", errorMessage: undefined },
				toolResults: [],
			},
			{ ...ctx, model: fakeModelGpt },
		);
		const recovered = await countTraceEvents("pool.engine_retry_recovered");
		ok("F5: success turn after single-strike swap settles cleanly", recovered >= 0); // smoke: no throw
	}
}

// =============================================================
// F6: swap-chain cap still applies (2 swaps per 5 minutes)
// =============================================================
{
	await freshSession("worker-chain");
	// D5 (plan 2026-10-14 §1.4) semantics: probe-round swaps are EXEMPT from MAX_SWAP_CHAIN —
	// the ring is its own bound (each slot at most once per round). The real failing chain:
	// glm x2 -> normal swap to gpt; gpt x2 -> normal swap to claude (fallback-only); claude x2
	// -> all benched -> probe ring opens -> glm (probe, past the old cap); glm x2 -> probe gpt;
	// gpt x2 -> round exhausted, durable nextProbeAt fences everything after.
	await errOnce(fakeModelGlm, CHATGPT_USAGE_LIMIT);
	await errOnce(fakeModelGlm, CHATGPT_USAGE_LIMIT);
	await errOnce(fakeModelGpt, CHATGPT_USAGE_LIMIT);
	await errOnce(fakeModelGpt, CHATGPT_USAGE_LIMIT);
	const two = setModelCalls.length;
	ok("F6: first 2 normal swaps allowed", two === 2, `calls=${two}`);
	await errOnce(fakeModelClaude, CHATGPT_USAGE_LIMIT);
	await errOnce(fakeModelClaude, CHATGPT_USAGE_LIMIT);
	ok("F6: probe ring not truncated by MAX_SWAP_CHAIN — 3rd swap fires", setModelCalls.length === 3, `calls=${setModelCalls.length}`);
	await errOnce(fakeModelGlm, CHATGPT_USAGE_LIMIT);
	await errOnce(fakeModelGlm, CHATGPT_USAGE_LIMIT);
	ok("F6: ring continues — 4th slot probed", setModelCalls.length === 4, `calls=${setModelCalls.length}`);
	await errOnce(fakeModelGpt, CHATGPT_USAGE_LIMIT);
	await errOnce(fakeModelGpt, CHATGPT_USAGE_LIMIT); // every slot tried -> exhausted
	ok("F6: exhausted ring fences further probes", setModelCalls.length === 4, `calls=${setModelCalls.length}`);
	await errOnce(fakeModelGpt, CHATGPT_USAGE_LIMIT);
	await errOnce(fakeModelGpt, CHATGPT_USAGE_LIMIT); // post-exhaustion burst still fenced (nextProbeAt)
	ok("F6: post-exhaustion burst fenced by nextProbeAt", setModelCalls.length === 4, `calls=${setModelCalls.length}`);
	const exhausted = await countTraceEvents("pool.probe_round_exhausted");
	ok("F6: probe_round_exhausted traced", exhausted >= 1, `exhausted=${exhausted}`);
}

// =============================================================
// F7: guest sessions never rotate
// =============================================================
{
	await freshSession();
	// Runner note (run-suites suiteEnv): swarm suites run with PI_SWARM_AGENT_ID=root forced
	// into the child env; this suite's fixtures overwrite it per-fixture via freshSession, and
	// the guest fixture must observe a TRULY absent id (guest = no id AND no root claim), so we
	// clear the root claim too — ambient PI_SWARM_IS_ROOT=1 would make currentAgentId() return
	// "root" (an affirmative root claim) and the strike would rotate for the root agent.
	const savedIsRoot = process.env.PI_SWARM_IS_ROOT;
	delete process.env.PI_SWARM_AGENT_ID;
	delete process.env.PI_SWARM_IS_ROOT;
	await errOnce(fakeModelGlm, CHATGPT_USAGE_LIMIT);
	ok("F7: guest does not rotate on single-strike quota", setModelCalls.length === 0, `calls=${setModelCalls.length}`);
	process.env.PI_SWARM_AGENT_ID = "worker-quota";
	if (savedIsRoot !== undefined) process.env.PI_SWARM_IS_ROOT = savedIsRoot;
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.chdir("/");
await rm(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
