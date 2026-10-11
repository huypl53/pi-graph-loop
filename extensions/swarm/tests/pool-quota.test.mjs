// Issue 70 model-pool engine-retry gate vs mutating 429 bodies.
//
// The Issue 17 engine-retry gate (src/hooks.ts turn_end error branch) keys the per-agent
// incident on exact raw errorMessage equality. Provider 429 usage_limit_reached bodies embed
// a per-second-mutating resets_in_seconds, so every error turn started a FRESH incident at
// count:1, ENGINE_MAX_RETRIES=3 was never reached, and quota-exhausted slots were never
// benched/rotated (live outage 2026-08-30: 39x pool.swap_gated_by_engine_retry count:1, 0x
// pool.engine_retry_exhausted). These fixtures pin the normalized identity:
//   - classifyProviderError recognizes usage_limit_reached as quota (immediate-bench policy).
//   - mutating resets_in_seconds on one slot collapses into ONE incident; the third strike
//     exhausts the gate -> bench + swap + [PI-SWARM MODEL POOL] notify.
//   - a different error KIND or a different providerKey still starts a fresh incident.
//   - a successful turn clears the incident (engine recovered).
//
// Run: node extensions/swarm/pool-quota.test.mjs
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { stringify } from "yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, readState } from "../src/state.ts";
import { registerSwarmHooks } from "../src/hooks.ts";
import { poolStatus } from "../src/pool.ts";
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

// --- live trace-shaped 429 bodies (resets_in_seconds mutates every turn) ---
const quotaBody = (resets) =>
	`429: {"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":178806230,"eligible_promo":null,"resets_in_seconds":${resets}}`;
const quotaBodyOpenAI = (resets) =>
	`OpenAI API error (429): {"type":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"plus","resets_at":178806230,"eligible_promo":null,"resets_in_seconds":${resets}}`;

// --- fixture project with a model pool ---
const dir = await mkdtemp(join(tmpdir(), "pool-quota-"));
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
process.env.PI_SWARM_AGENT_ID = "worker-a";
const st = await readState(p, dir);
const ts = new Date().toISOString();
st.agents["worker-a"] = {
	id: "worker-a",
	role: "worker",
	roleKind: "worker",
	capabilities: [],
	activeTaskIds: [],
	maxConcurrentTasks: 1,
	status: "running",
	runtimeStatus: "idle",
	health: "healthy",
	tmuxSession: "sess",
	tmuxWindow: "worker-a",
	tmuxTarget: "sess:worker-a.0",
	model: "glm-5.1",
	provider: "zai-coding-cn",
	cwd: dir,
	mailbox: ".pi/swarm/mailboxes/x.jsonl",
	createdAt: ts,
	updatedAt: ts,
};
const { writeState } = await import("../src/state.ts");
await writeState(p, st);

// --- fake pi capturing setModel + sendMessage ---
const setModelCalls = [];
const sentMessages = [];
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

// --- helpers ---
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
async function gatedCounts() {
	const raw = await readFile(p.events, "utf8");
	return raw
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter((o) => o?.event === "pool.swap_gated_by_engine_retry")
		.map((o) => o.count);
}

async function freshSession(agentId = `worker-${Math.random().toString(36).slice(2, 8)}`) {
	await rm(join(dir, ".pi", "swarm", "pool-state.json"), { force: true }).catch(() => {});
	await rm(p.events, { force: true }).catch(() => {});
	setModelCalls.length = 0;
	sentMessages.length = 0;
	process.env.PI_SWARM_AGENT_ID = agentId;
	const ss = handlers["session_start"][0];
	await ss({ type: "session_start" }, ctx);
}

const turnEnd = () => handlers["turn_end"][0];
async function errTurn(i, errorMessage, model = fakeModelGlm) {
	await turnEnd()(
		{
			type: "turn_end",
			turnIndex: 300 + i,
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

registerSwarmHooks(fakePi);

// =============================================================
// F0: unit — live 429 usage_limit_reached bodies classify as quota
// =============================================================
// Immediate-bench policy (quota/auth) and lastBenchReason="quota" depend on this.
{
	ok("F0: ccs-style live body -> quota", classifyProviderError(quotaBody(9136)) === "quota", classifyProviderError(quotaBody(9136)));
	ok(
		"F0: openai-style live body -> quota",
		classifyProviderError(quotaBodyOpenAI(9136)) === "quota",
		classifyProviderError(quotaBodyOpenAI(9136)),
	);
	ok("F0: plain 429 rate limit stays rate_limit", classifyProviderError("429 Too Many Requests: rate limit exceeded") === "rate_limit");
	ok(
		"F0: exceeded-quota prose stays quota",
		classifyProviderError("Error 429: You exceeded your current quota, please check your plan and billing details") === "quota",
	);
}

// =============================================================
// F1: mutating resets_in_seconds must NOT reset the incident
// =============================================================
// Two strikes on the same slot whose bodies differ only in resets_in_seconds. Incident
// 2026-10-11 A: quota is now SINGLE-STRIKE (pi fail-fasts quota errors — isRetryableAssistantError
// matches NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN and returns false, so no second turn_end
// ever arrives from the engine). Each strike independently opens the gate; the Issue 70
// normalization contract this suite pins is that the mutating bodies collapse to ONE incident
// identity (no gated events) and both strikes bench/swap instead of oscillating at count:1.
{
	await freshSession();
	await errTurn(1, quotaBody(11508));
	ok(
		"F1: single-strike quota is never pinned at gated count:1",
		JSON.stringify(await gatedCounts()) === "[]",
		JSON.stringify(await gatedCounts()),
	);
	await errTurn(2, quotaBody(11504));
	ok("F1: both mutating-body strikes swapped (identity collapsed)", setModelCalls.length === 2, `calls=${setModelCalls.length}`);
	ok(
		"F1: swaps left the dead slot",
		setModelCalls.every((t) => t !== "zai-coding-cn/glm-5.1"),
		setModelCalls.join(","),
	);
	const exhausted = await countTraceEvents("pool.engine_retry_exhausted");
	ok("F1: pool.engine_retry_exhausted fired per strike", exhausted === 2, `exhausted=${exhausted}`);
	const swaps = await countTraceEvents("pool.swap");
	ok("F1: pool.swap trace fired", swaps === 2, `swaps=${swaps}`);
	const ps = await poolStatus(p);
	const glm = ps.slots.find((s) => s.model === "glm-5.1");
	ok("F1: quota slot benched (in cooldown)", Boolean(glm.inCooldown), JSON.stringify(glm.health));
	ok("F1: benched with lastBenchReason=quota", glm.health?.lastBenchReason === "quota", `reason=${glm.health?.lastBenchReason}`);
	ok(
		"F1: pool quota swap notify sent",
		sentMessages.some((s) => /Pool:.*quota/.test(s.m.content) && /switched/.test(s.m.content)),
		JSON.stringify(sentMessages.map((s) => s.m.content?.slice(0, 60))),
	);
}

// =============================================================
// F2: a different error KIND starts a fresh incident
// =============================================================
// Transient strike then quota strike on the SAME slot: the incident must reset (two gated
// events, no swap). (Passes today via raw-text mismatch; must KEEP passing after identity
// normalization gains the kind component.)
{
	await freshSession();
	await errTurn(1, "fetch failed: ECONNREFUSED");
	await errTurn(2, quotaBody(9136));
	// Incident 2026-10-11 A: the quota strike is single-strike — it swaps immediately. The
	// identity contract remains: the transient strike is gated (different kind → fresh
	// incident), never merged with the quota one.
	ok(
		"F2: transient strike gated; quota strike single-strike swaps",
		setModelCalls.length === 1 && (await gatedCounts()).length === 1,
		`gated=${JSON.stringify(await gatedCounts())} calls=${setModelCalls.length}`,
	);
	ok(
		"F2: no exhausted trace for the gated transient",
		(await countTraceEvents("pool.engine_retry_exhausted")) === 1,
		`exhausted=${await countTraceEvents("pool.engine_retry_exhausted")}`,
	);
}

// =============================================================
// F3: a different providerKey starts a fresh incident
// =============================================================
// Same scrubbed message shape on glm then gpt: fresh incident per slot. Incident 2026-10-11 A:
// quota strikes are single-strike, so BOTH swap (one per slot) — the providerKey separation is
// still observable: two separate exhaustion traces, neither gated.
{
	await freshSession();
	await errTurn(1, quotaBody(9136), fakeModelGlm);
	await errTurn(2, quotaBodyOpenAI(9136), fakeModelGpt);
	ok(
		"F3: per-slot single-strike quota swaps, no gated strikes",
		setModelCalls.length === 2 && (await gatedCounts()).length === 0,
		`gated=${JSON.stringify(await gatedCounts())} calls=${setModelCalls.length}`,
	);
	ok(
		"F3: one exhaustion trace per slot",
		(await countTraceEvents("pool.engine_retry_exhausted")) === 2,
		`exhausted=${await countTraceEvents("pool.engine_retry_exhausted")}`,
	);
}

// =============================================================
// F4: successful turn clears the incident
// =============================================================
// 1 quota strike (single-strike swap), a stop turn, then 1 more strike: the stop turn clears
// the (already-exhausted-and-cleared) incident state and traces recovery; the second strike
// is a FRESH single-strike incident that swaps again. Pin: recovered fires exactly once, and
// the post-recovery strike is never gated.
{
	await freshSession();
	await errTurn(1, quotaBody(9136));
	await turnEnd()(
		{
			type: "turn_end",
			turnIndex: 400,
			message: {
				role: "assistant",
				model: "glm-5.1",
				provider: "zai-coding-cn",
				stopReason: "stop",
				errorMessage: undefined,
			},
			toolResults: [],
		},
		{ ...ctx, model: fakeModelGlm },
	);
	// The quota strike was single-strike: the incident was consumed (deleted) at exhaustion,
	// so the stop turn finds NO open incident and emits no recovery trace — recovery only
	// traces for burst-gated kinds whose incident was still open when the engine recovered.
	ok(
		"F4: no recovered trace (single-strike incident already consumed)",
		(await countTraceEvents("pool.engine_retry_recovered")) === 0,
		`recovered=${await countTraceEvents("pool.engine_retry_recovered")}`,
	);
	await errTurn(2, quotaBody(9128));
	ok("F4: post-recovery strike swaps (fresh single-strike incident)", setModelCalls.length === 2, `calls=${setModelCalls.length}`);
	ok("F4: still no recovered trace", (await countTraceEvents("pool.engine_retry_recovered")) === 0);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.chdir("/");
await rm(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
