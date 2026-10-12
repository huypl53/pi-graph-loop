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
// Two strikes on the same slot whose bodies differ only in resets_in_seconds.
// Strike 1 is gated (count 1) allowing engine to retry and preserve cache.
// Mutating bodies collapse to ONE incident identity so strike 2 reaches ENGINE_MAX_RETRIES=2,
// exhausts retries, and performs bench + swap.
{
	await freshSession();
	await errTurn(1, quotaBody(11508));
	ok(
		"F1: first quota strike is gated (allows engine retry to preserve cache)",
		JSON.stringify(await gatedCounts()) === "[1]",
		JSON.stringify(await gatedCounts()),
	);
	await errTurn(2, quotaBody(11504));
	ok(
		"F1: mutating-body strikes collapsed and swapped after retries exhausted",
		setModelCalls.length === 1,
		`calls=${setModelCalls.length}`,
	);
	ok(
		"F1: swaps left the dead slot",
		setModelCalls.every((t) => t !== "zai-coding-cn/glm-5.1"),
		setModelCalls.join(","),
	);
	const exhausted = await countTraceEvents("pool.engine_retry_exhausted");
	ok("F1: pool.engine_retry_exhausted fired once on exhaustion", exhausted === 1, `exhausted=${exhausted}`);
	const swaps = await countTraceEvents("pool.swap");
	ok("F1: pool.swap trace fired once", swaps === 1, `swaps=${swaps}`);
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
// Transient strike then quota strike on the SAME slot: different kind resets the incident
// (both strikes gated at count:1, no swap).
{
	await freshSession();
	await errTurn(1, "fetch failed: ECONNREFUSED");
	await errTurn(2, quotaBody(9136));
	ok(
		"F2: transient strike gated; quota strike starts fresh incident and also gates",
		setModelCalls.length === 0 && (await gatedCounts()).length === 2,
		`gated=${JSON.stringify(await gatedCounts())} calls=${setModelCalls.length}`,
	);
	ok(
		"F2: no exhausted trace for either gated strike",
		(await countTraceEvents("pool.engine_retry_exhausted")) === 0,
		`exhausted=${await countTraceEvents("pool.engine_retry_exhausted")}`,
	);
}

// =============================================================
// F3: a different providerKey starts a fresh incident
// =============================================================
// 2 strikes on glm (exhausts -> swap #1), then 2 strikes on gpt (exhausts -> swap #2).
{
	await freshSession();
	await errTurn(1, quotaBody(9136), fakeModelGlm);
	await errTurn(2, quotaBody(9130), fakeModelGlm);
	await errTurn(3, quotaBodyOpenAI(9136), fakeModelGpt);
	await errTurn(4, quotaBodyOpenAI(9130), fakeModelGpt);
	ok("F3: per-slot retries exhaust and swap", setModelCalls.length === 2, `calls=${setModelCalls.length}`);
	ok(
		"F3: one exhaustion trace per slot",
		(await countTraceEvents("pool.engine_retry_exhausted")) === 2,
		`exhausted=${await countTraceEvents("pool.engine_retry_exhausted")}`,
	);
}

// =============================================================
// F4: successful turn clears the incident (engine recovered)
// =============================================================
// 1 quota strike (gated at count 1), then a stop turn: engine recovered!
// Traces pool.engine_retry_recovered.
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
	ok(
		"F4: recovered trace fires when turn succeeds after gated error",
		(await countTraceEvents("pool.engine_retry_recovered")) === 1,
		`recovered=${await countTraceEvents("pool.engine_retry_recovered")}`,
	);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.chdir("/");
await rm(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
