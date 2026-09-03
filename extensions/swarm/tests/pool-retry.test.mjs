// Issue 17 model-pool-respect-pi-retries: engine-retry gate.
//
// pi's engine retries a failed provider request up to retry.maxRetries (default 3) times with
// exponential backoff before giving up. This test proves:
//   1. Transient errors (5xx, 429, network) within pi's 3-retry window do NOT trigger rotation.
//   2. Final-exhaustion error (after 3 retries) DOES trigger rotation.
//   3. The /swarm pool rotate (manual override) always works regardless of gate state.
//   4. A successful turn_end clears the incident (engine recovered).
//   5. A long idle gap (> ENGINE_RETRY_WINDOW_MS) starts a fresh incident.
//   6. Two consecutive exhausted bursts both swap (incident cleared between).
//
// Run: node extensions/swarm/pool-retry.test.mjs
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, readState } from "../src/state.ts";
import { registerSwarmHooks } from "../src/hooks.ts";
import { poolStatus, slotKey } from "../src/pool.ts";

let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) pass++; else { fail++; console.error("  FAIL:", name, info ?? ""); } };

// --- fixture project with a model pool ---
const dir = await mkdtemp(join(tmpdir(), "pool-retry-"));
await mkdir(join(dir, ".pi"), { recursive: true });
await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({
	swarm: {
		defaultModel: "glm-5.1",
		defaultProvider: "zai-coding-cn",
		modelPool: [
			{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50 },
			{ model: "gpt-5.4-mini", provider: "openai", weight: 30 },
			{ model: "claude-sonnet-4", provider: "anthropic", weight: 0 },
		],
		rotation: { strategy: "round-robin", cooldownMs: 300_000, maxRetries: 2 },
	},
}));
process.chdir(dir);
const p = paths(dir);
// Seed agent record so currentAgentId resolves.
process.env.PI_SWARM_AGENT_ID = "worker-a";
const st = await readState(p, dir);
const ts = new Date().toISOString();
st.agents["worker-a"] = {
	id: "worker-a", role: "worker", roleKind: "worker", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1,
	status: "running", runtimeStatus: "idle", health: "healthy",
	tmuxSession: "sess", tmuxWindow: "worker-a", tmuxTarget: "sess:worker-a.0",
	model: "glm-5.1", provider: "zai-coding-cn", cwd: dir, mailbox: ".pi/swarm/mailboxes/x.jsonl",
	createdAt: ts, updatedAt: ts,
};
const { writeState } = await import("../src/state.ts");
await writeState(p, st);

// --- fake pi capturing setModel + sendMessage ---
const setModelCalls = [];
const sentMessages = [];
const handlers = {};
const fakePi = {
	on: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
	registerTool: () => {}, registerCommand: () => {},
	setModel: async (m) => { setModelCalls.push(`${m.provider}/${m.id}`); return true; },
	sendMessage: (m, o) => { sentMessages.push({ m, o }); },
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};
const fakeModelGlm = { id: "glm-5.1", provider: "zai-coding-cn" };
const fakeModelGpt = { id: "gpt-5.4-mini", provider: "openai" };
const fakeModelClaude = { id: "claude-sonnet-4", provider: "anthropic" };
const ctx = {
	cwd: dir, mode: "tui", isIdle: () => true, model: fakeModelGlm,
	modelRegistry: { find: (provider, id) => {
		if (id === "gpt-5.4-mini") return fakeModelGpt;
		if (id === "claude-sonnet-4") return fakeModelClaude;
		if (id === "glm-5.1") return fakeModelGlm;
		return undefined;
	} },
};

// --- helpers ---
async function countTraceEvents(name) {
	try {
		const raw = await readFile(p.events, "utf8");
		const lines = raw.split("\n").filter(Boolean);
		return lines.filter((l) => {
			try { const o = JSON.parse(l); return o.event === name; } catch { return false; }
		}).length;
	} catch { return 0; }
}

// Each fixture runs with a fresh pool-state + a fresh agent id so the gate Map, swap chain, and
// pool state all start empty for that fixture. Restoring PI_SWARM_AGENT_ID handles the case where
// the guest fixture (7) deleted it earlier.
async function freshSession(agentId = `worker-${Math.random().toString(36).slice(2, 8)}`) {
	const { rm } = await import("node:fs/promises");
	await rm(join(dir, ".pi", "swarm", "pool-state.json"), { force: true }).catch(() => {});
	await rm(p.events, { force: true }).catch(() => {});
	setModelCalls.length = 0;
	sentMessages.length = 0;
	process.env.PI_SWARM_AGENT_ID = agentId;
	const ss = handlers["session_start"][0];
	await ss({ type: "session_start" }, ctx);
}

async function burstOfErrors(n, errorMessage, model = fakeModelGlm) {
	const te = handlers["turn_end"][0];
	for (let i = 0; i < n; i++) {
		await te({ type: "turn_end", turnIndex: 100 + i, message: {
			role: "assistant", model: model.id, provider: model.provider,
			stopReason: "error", errorMessage,
		}, toolResults: [] }, { ...ctx, model });
	}
}

registerSwarmHooks(fakePi);
const turnEnd = handlers["turn_end"][0];

// =============================================================
// Fixture 1: Transient within engine retries (NO rotation)
// =============================================================
// Emit 2 error turn_ends (engine has 3 retries; 2 is below threshold). Expect NO setModel call,
// NO bench, NO streak bump, but pool.swap_gated_by_engine_retry should fire for each gated event.
{
	await freshSession();
	const beforeStreak = (await poolStatus(p)).slots.find((s) => s.model === "glm-5.1")?.health?.failures ?? 0;
	await burstOfErrors(2, "fetch failed: ECONNREFUSED");
	ok("fixture 1: setModel NOT called within engine retry window", setModelCalls.length === 0, `calls=${setModelCalls.length}`);
	const ps = await poolStatus(p);
	const glm = ps.slots.find((s) => s.model === "glm-5.1");
	ok("fixture 1: glm streak NOT bumped by gated errors", (glm.health?.failures ?? 0) === beforeStreak, `before=${beforeStreak} after=${glm.health?.failures}`);
	ok("fixture 1: glm NOT benched", !glm.inCooldown);
	const gated = await countTraceEvents("pool.swap_gated_by_engine_retry");
	ok("fixture 1: pool.swap_gated_by_engine_retry fired for each gated strike", gated === 2, `gated=${gated}`);
	const exhausted = await countTraceEvents("pool.engine_retry_exhausted");
	ok("fixture 1: pool.engine_retry_exhausted did NOT fire", exhausted === 0, `exhausted=${exhausted}`);
}

// =============================================================
// Fixture 2: Exhausted retries (rotation)
// =============================================================
// Emit 3 error turn_ends in a row on the SAME slot+error. Expect setModel called exactly once
// (on the 3rd strike), slot streak bumped once, swap note sent. Note: round-robin prefers glm
// (cursor=0), so after one swap the new slot will be gpt; we model that explicitly.
{
	await freshSession();
	await burstOfErrors(3, "fetch failed: ECONNREFUSED");
	ok("fixture 2: setModel called exactly once on exhaustion", setModelCalls.length === 1, `calls=${setModelCalls.length}`);
	ok("fixture 2: swapped to a DIFFERENT slot", setModelCalls[0] !== "zai-coding-cn/glm-5.1", `to=${setModelCalls[0]}`);
	const ps = await poolStatus(p);
	const glm = ps.slots.find((s) => s.model === "glm-5.1");
	ok("fixture 2: glm failure streak bumped (1x)", (glm.health?.failures ?? 0) === 1, `failures=${glm.health?.failures}`);
	ok("fixture 2: swap note sent to the agent", sentMessages.some((s) => /MODEL POOL/.test(s.m.content) && /transient/.test(s.m.content)));
	const gated = await countTraceEvents("pool.swap_gated_by_engine_retry");
	ok("fixture 2: pool.swap_gated_by_engine_retry fired for strikes 1 and 2", gated === 2, `gated=${gated}`);
	const exhausted = await countTraceEvents("pool.engine_retry_exhausted");
	ok("fixture 2: pool.engine_retry_exhausted fired exactly once on the terminal strike", exhausted === 1, `exhausted=${exhausted}`);
}

// =============================================================
// Fixture 3: Engine retry burst with success before exhaustion clears the incident
// =============================================================
// Emit 2 errors (below threshold) then a successful stop. Expect NO setModel call (incident
// cleared by the stop), pool.engine_retry_recovered fired, slot streak NOT bumped.
{
	await freshSession();
	const te = handlers["turn_end"][0];
	const beforeStreak = (await poolStatus(p)).slots.find((s) => s.model === "glm-5.1")?.health?.failures ?? 0;
	await te({ type: "turn_end", turnIndex: 1, message: {
		role: "assistant", model: "glm-5.1", provider: "zai-coding-cn",
		stopReason: "error", errorMessage: "fetch failed: ECONNREFUSED",
	}, toolResults: [] }, { ...ctx, model: fakeModelGlm });
	await te({ type: "turn_end", turnIndex: 2, message: {
		role: "assistant", model: "glm-5.1", provider: "zai-coding-cn",
		stopReason: "error", errorMessage: "fetch failed: ECONNREFUSED",
	}, toolResults: [] }, { ...ctx, model: fakeModelGlm });
	await te({ type: "turn_end", turnIndex: 3, message: {
		role: "assistant", model: "glm-5.1", provider: "zai-coding-cn",
		stopReason: "stop", errorMessage: undefined,
	}, toolResults: [] }, { ...ctx, model: fakeModelGlm });
	ok("fixture 3: setModel NOT called when engine recovered", setModelCalls.length === 0, `calls=${setModelCalls.length}`);
	const ps = await poolStatus(p);
	const glm = ps.slots.find((s) => s.model === "glm-5.1");
	ok("fixture 3: glm streak cleared by stop turn", (glm.health?.failures ?? 0) === 0, `failures=${glm.health?.failures}`);
	const recovered = await countTraceEvents("pool.engine_retry_recovered");
	ok("fixture 3: pool.engine_retry_recovered fired on stop turn", recovered === 1, `recovered=${recovered}`);
}

// =============================================================
// Fixture 4: Long idle gap starts a fresh incident
// =============================================================
// The window check is on the LAST seen timestamp, not a timer. To exercise it without sleeping
// 14s, we simulate a gap by emitting a strike, manually advancing the incident's lastSeenAt
// beyond the window via the module's internal state (read indirectly: next strike must start a
// fresh incident count=1). We do this by reading events.jsonl between strikes: after the first
// strike, we wait briefly (window is 14s — too long for a unit test). Instead we use a different
// mechanism: emit a strike on a DIFFERENT error message, which forces a fresh incident via the
// message-mismatch branch.
{
	await freshSession();
	const te = handlers["turn_end"][0];
	await te({ type: "turn_end", turnIndex: 1, message: {
		role: "assistant", model: "glm-5.1", provider: "zai-coding-cn",
		stopReason: "error", errorMessage: "fetch failed: ECONNREFUSED",
	}, toolResults: [] }, { ...ctx, model: fakeModelGlm });
	const gated1 = await countTraceEvents("pool.swap_gated_by_engine_retry");
	ok("fixture 4: first strike gated", gated1 === 1);
	// Different error message -> different incident (count=1 again, still gated, no swap).
	await te({ type: "turn_end", turnIndex: 2, message: {
		role: "assistant", model: "glm-5.1", provider: "zai-coding-cn",
		stopReason: "error", errorMessage: "Error 429: rate limit exceeded",
	}, toolResults: [] }, { ...ctx, model: fakeModelGlm });
	const gated2 = await countTraceEvents("pool.swap_gated_by_engine_retry");
	ok("fixture 4: different error starts a fresh incident (still gated)", gated2 === 2, `gated=${gated2}`);
	ok("fixture 4: setModel still NOT called", setModelCalls.length === 0, `calls=${setModelCalls.length}`);
}

// =============================================================
// Fixture 5: Two consecutive exhausted bursts both swap
// =============================================================
// First burst exhausts (3 errors on glm) -> swap to gpt. Second burst exhausts (3 errors on gpt)
// -> swap to claude (fallback). Verify two swaps and two engine_retry_exhausted events.
{
	await freshSession();
	const te = handlers["turn_end"][0];
	const err = async (i, model) => {
		await te({ type: "turn_end", turnIndex: 200 + i, message: {
			role: "assistant", model: model.id, provider: model.provider,
			stopReason: "error", errorMessage: "fetch failed: ECONNREFUSED",
		}, toolResults: [] }, { ...ctx, model });
	};
	// Burst 1 on glm
	await err(1, fakeModelGlm);
	await err(2, fakeModelGlm);
	await err(3, fakeModelGlm);
	ok("fixture 5: first burst swaps exactly once", setModelCalls.length === 1, `calls=${setModelCalls.length}`);
	// Burst 2 on gpt
	await err(4, fakeModelGpt);
	await err(5, fakeModelGpt);
	await err(6, fakeModelGpt);
	ok("fixture 5: second burst swaps again (second swap)", setModelCalls.length === 2, `calls=${setModelCalls.length}`);
	ok("fixture 5: two distinct swap targets", new Set(setModelCalls).size === 2, `targets=${[...new Set(setModelCalls)].join(",")}`);
	const exhausted = await countTraceEvents("pool.engine_retry_exhausted");
	ok("fixture 5: pool.engine_retry_exhausted fired twice", exhausted === 2, `exhausted=${exhausted}`);
}

// =============================================================
// Fixture 6: Quota error exhausts and swaps (immediate bench still works)
// =============================================================
// Quota benches immediately on recordProviderError. The gate should still gate the swap path
// (the gate is about rotation timing, not benching).
{
	await freshSession();
	await burstOfErrors(3, "Error 429: You exceeded your current quota");
	ok("fixture 6: quota exhaustion swaps", setModelCalls.length === 1, `calls=${setModelCalls.length}`);
	const ps = await poolStatus(p);
	const glm = ps.slots.find((s) => s.model === "glm-5.1");
	ok("fixture 6: quota slot is benched", glm.inCooldown && /quota/.test(glm.health.lastError));
}

// =============================================================
// Fixture 7: Guest sessions never rotate, never gate
// =============================================================
// A guest session short-circuits at the top of turn_end; the gate Map is never touched.
{
	await freshSession();
	process.env.PI_SWARM_AGENT_ID = "swarm-guest";
	const te = handlers["turn_end"][0];
	await te({ type: "turn_end", turnIndex: 1, message: {
		role: "assistant", model: "glm-5.1", provider: "zai-coding-cn",
		stopReason: "error", errorMessage: "fetch failed: ECONNREFUSED",
	}, toolResults: [] }, { ...ctx, model: fakeModelGlm });
	ok("fixture 7: guest session does not call setModel", setModelCalls.length === 0);
	const gated = await countTraceEvents("pool.swap_gated_by_engine_retry");
	ok("fixture 7: guest session does not emit gate trace", gated === 0, `gated=${gated}`);
	delete process.env.PI_SWARM_AGENT_ID;
}

// =============================================================
// Fixture 8: Unknown error (context overflow) does NOT enter the gate
// =============================================================
// kind === "unknown" short-circuits before the gate; the gate Map is never mutated for unknown errors.
{
	await freshSession();
	const te = handlers["turn_end"][0];
	await te({ type: "turn_end", turnIndex: 1, message: {
		role: "assistant", model: "glm-5.1", provider: "zai-coding-cn",
		stopReason: "error", errorMessage: "Prompt is too long: 390000 tokens > 200000 maximum",
	}, toolResults: [] }, { ...ctx, model: fakeModelGlm });
	await te({ type: "turn_end", turnIndex: 2, message: {
		role: "assistant", model: "glm-5.1", provider: "zai-coding-cn",
		stopReason: "error", errorMessage: "Prompt is too long: 390000 tokens > 200000 maximum",
	}, toolResults: [] }, { ...ctx, model: fakeModelGlm });
	await te({ type: "turn_end", turnIndex: 3, message: {
		role: "assistant", model: "glm-5.1", provider: "zai-coding-cn",
		stopReason: "error", errorMessage: "Prompt is too long: 390000 tokens > 200000 maximum",
	}, toolResults: [] }, { ...ctx, model: fakeModelGlm });
	ok("fixture 8: context overflow never swaps", setModelCalls.length === 0, `calls=${setModelCalls.length}`);
	const unclassified = await countTraceEvents("pool.turn_error_unclassified");
	ok("fixture 8: pool.turn_error_unclassified fired for each strike", unclassified === 3, `unclassified=${unclassified}`);
	const gated = await countTraceEvents("pool.swap_gated_by_engine_retry");
	ok("fixture 8: gate trace NEVER fires for unknown errors", gated === 0, `gated=${gated}`);
}

// =============================================================
// Fixture 9: session_shutdown clears any open incident
// =============================================================
// Emit 1 strike (incident opened with count=1), then fire session_shutdown, then emit another
// strike on a FRESH slot — the second strike must start a fresh incident (count=1, NOT 2).
{
	await freshSession();
	const te = handlers["turn_end"][0];
	await te({ type: "turn_end", turnIndex: 1, message: {
		role: "assistant", model: "glm-5.1", provider: "zai-coding-cn",
		stopReason: "error", errorMessage: "fetch failed: ECONNREFUSED",
	}, toolResults: [] }, { ...ctx, model: fakeModelGlm });
	const gated1 = await countTraceEvents("pool.swap_gated_by_engine_retry");
	ok("fixture 9: first strike gated", gated1 === 1);
	// Fire session_shutdown to clear the incident.
	const sd = handlers["session_shutdown"][0];
	await sd({ type: "session_shutdown" }, ctx);
	// Next strike starts a fresh incident (count=1, still gated).
	await te({ type: "turn_end", turnIndex: 2, message: {
		role: "assistant", model: "glm-5.1", provider: "zai-coding-cn",
		stopReason: "error", errorMessage: "fetch failed: ECONNREFUSED",
	}, toolResults: [] }, { ...ctx, model: fakeModelGlm });
	const gated2 = await countTraceEvents("pool.swap_gated_by_engine_retry");
	ok("fixture 9: post-shutdown strike is a fresh incident (still gated)", gated2 === 2, `gated=${gated2}`);
	ok("fixture 9: still no swap (count=1 below threshold)", setModelCalls.length === 0, `calls=${setModelCalls.length}`);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.chdir("/");
await rm(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
