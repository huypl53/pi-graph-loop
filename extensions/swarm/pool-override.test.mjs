// Issue 19 model-pool-deferrals-and-manual-override: /swarm pool rotate [now|next] manual
// override path. Verifies:
//   - `rotate now` bypasses the engine-retry gate and force-swaps the current slot to a healthy
//     alternative. Traces `pool.swap_forced_by_manual_override`. Bumps the swap-chain counter via
//     bumpSwapChain() (exported from hooks.ts) so the operator is accountable for the same
//     MAX_SWAP_CHAIN=2 cap as the auto-swap path.
//   - `rotate next` benches the current slot for `rotation.cooldownMs` so the next pickSlot()
//     skips it. Does NOT call setModel. Traces `pool.bench_forced_by_manual_override`.
//   - The authority gate refuses non-orchestrator sessions with the standard `… is
//     orchestrator-only: …` notify wording (matches attention|remind|stop|release|goal).
//   - Manual override traces have the exact expected shape (event + payload fields).
//   - Existing pool-retry and pool-swap tests still pass (constants extraction is a pure relocation;
//     the gate behavior is unchanged).
//
// Critical caveat (per plan-review): the existing pool-swap/pool-retry tests use
// `registerCommand: () => {}` (no-op), so the dispatcher path is silently unexercised. This
// test uses `registerCommand: (name, def) => { handlers[name] = def.handler }` so the
// dispatcher handlers run end-to-end.
//
// Run: node extensions/swarm/pool-override.test.mjs
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, readState, writeState } from "./src/state.ts";
import { registerSwarmHooks, getSwapChainCount, getEngineRetryIncident, _resetSwapChainForTests } from "./src/hooks.ts";
import { registerSwarmCommand } from "./src/command.ts";
import { poolStatus, slotKey } from "./src/pool.ts";

let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) pass++; else { fail++; console.error("  FAIL:", name, info ?? ""); } };

// --- fixture project with a model pool ---
const dir = await mkdtemp(join(tmpdir(), "pool-override-"));
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
		rotation: { strategy: "round-robin", cooldownMs: 900_000, maxRetries: 2 },
	},
}));
process.chdir(dir);
const p = paths(dir);

// --- fake pi capturing setModel + sendMessage + registerCommand (critical: handlers[]) ---
const setModelCalls = [];
const sentMessages = [];
const hookHandlers = {};
const commandHandlers = {};
const notifications = [];
const fakePi = {
	on: (ev, fn) => { (hookHandlers[ev] ||= []).push(fn); },
	registerTool: () => {},
	// CRITICAL: capture the dispatcher handler so we can actually exercise the /swarm command path.
	// Existing pool-swap/pool-retry tests use `() => {}` here, which silently skips dispatcher tests.
	registerCommand: (name, def) => { commandHandlers[name] = def.handler; },
	setModel: async (m) => { setModelCalls.push({ provider: m.provider, id: m.id, target: `${m.provider}/${m.id}` }); return true; },
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
	ui: {
		notify: (text, level) => { notifications.push({ level, text }); },
		setStatus: () => {},
	},
};

// --- seed an agent record + register hooks + command dispatcher ---
async function freshSession(agentId = "orchestrator", model = fakeModelGlm) {
	const { rm } = await import("node:fs/promises");
	await rm(join(dir, ".pi", "swarm", "pool-state.json"), { force: true }).catch(() => {});
	await rm(p.events, { force: true }).catch(() => {});
	setModelCalls.length = 0;
	sentMessages.length = 0;
	notifications.length = 0;
	process.env.PI_SWARM_AGENT_ID = agentId;
	process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
	// Re-register hooks (clears hookHandlers) so each fixture has a fresh engine-retry gate.
	for (const k of Object.keys(hookHandlers)) delete hookHandlers[k];
	registerSwarmHooks(fakePi);
	const ss = hookHandlers["session_start"][0];
	await ss({ type: "session_start" }, { ...ctx, model });
	// Reset module-local state that persists across registerSwarmHooks calls: the swap-chain Map
	// and the engine-retry incident Map. Each fixture needs a clean gate to verify the gate's
	// `swap_gated_by_engine_retry` trace fires (chain.count must be below MAX_SWAP_CHAIN).
	_resetSwapChainForTests(agentId);
}

registerSwarmCommand(fakePi);

// ============================================================================
// CASE A — `rotate now` force-swaps current slot, bypasses engine-retry gate
// ============================================================================
{
	await freshSession();
	const before = setModelCalls.length;
	const evBefore = await readFile(p.events, "utf8").catch(() => "");
	await commandHandlers["swarm"]("pool rotate now", { ...ctx, model: fakeModelGlm });
	ok("case A: setModel called once", setModelCalls.length === before + 1, `calls=${setModelCalls.length}`);
	ok("case A: swapped to a DIFFERENT slot", setModelCalls[before] && setModelCalls[before].target !== "zai-coding-cn/glm-5.1", `to=${setModelCalls[before]?.target}`);
	ok("case A: swap note sent to the agent", sentMessages.some((s) => /Operator forced manual rotation/.test(s.m.content)));
	// Trace shape
	const evAfter = await readFile(p.events, "utf8").catch(() => "");
	const evDelta = evAfter.slice(evBefore.length);
	const traceLines = evDelta.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	const forced = traceLines.find((e) => e.event === "pool.swap_forced_by_manual_override");
	ok("case A: pool.swap_forced_by_manual_override trace fired", Boolean(forced), `forced=${JSON.stringify(forced)}`);
	ok("case A: forced trace carries agentId, from, to, reason", forced && forced.agentId === "orchestrator" && forced.from === "zai-coding-cn/glm-5.1" && forced.to && forced.from !== forced.to && typeof forced.reason === "string", `payload=${JSON.stringify(forced)}`);
	// Q1 (reviewer F1): the swap-chain counter MUST be bumped after a successful manual swap.
	// Operator is accountable for the same MAX_SWAP_CHAIN=2 cap as the auto-swap path.
	ok("case A Q1: swap-chain counter bumped to 1 after rotate now", getSwapChainCount("orchestrator") === 1, `count=${getSwapChainCount("orchestrator")}`);
	// Negative sub-case A1: with all alternatives benched, `rotate now` refuses without setModel.
	// Bench all slots (including current glm) so pickSlot truly returns undefined.
	await freshSession();
	const { withPoolLock, readPoolHealth, writePoolHealth } = await import("./src/pool.ts");
	await withPoolLock(p, async () => {
		const h = await readPoolHealth(p);
		const farFuture = new Date(Date.now() + 24 * 3600_000).toISOString();
		h.slots["zai-coding-cn/glm-5.1"] = { failures: 1, cooldownUntil: farFuture };
		h.slots["openai/gpt-5.4-mini"] = { failures: 1, cooldownUntil: farFuture };
		h.slots["anthropic/claude-sonnet-4"] = { failures: 1, cooldownUntil: farFuture };
		await writePoolHealth(p, h);
	});
	const beforeNeg = setModelCalls.length;
	await commandHandlers["swarm"]("pool rotate now", { ...ctx, model: fakeModelGlm });
	ok("case A neg: all slots benched -> setModel NOT called", setModelCalls.length === beforeNeg);
	const warn = notifications.filter((n) => n.level === "warning").slice(-1)[0];
	ok("case A neg: refuses with a warning notify", warn && /No healthy alternative slot/.test(warn.text), `warn=${JSON.stringify(warn)}`);

	// Negative sub-case A2: picked slot has no resolvable model registry entry -> refuses.
	await freshSession();
	const origFind = ctx.modelRegistry.find;
	ctx.modelRegistry.find = (provider, id) => (id === "gpt-5.4-mini") ? undefined : origFind(provider, id);
	const beforeNeg2 = setModelCalls.length;
	await commandHandlers["swarm"]("pool rotate now", { ...ctx, model: fakeModelGlm });
	ok("case A neg2: registry miss -> setModel NOT called", setModelCalls.length === beforeNeg2);
	const traceLines2 = (await readFile(p.events, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	const notFound = traceLines2.find((e) => e.event === "pool.manual_rotate_model_not_found");
	ok("case A neg2: pool.manual_rotate_model_not_found trace fired", Boolean(notFound));
	ctx.modelRegistry.find = origFind;
}

// ============================================================================
// CASE B — `rotate next` benches current slot, NO setModel, NO chain bump
// ============================================================================
{
	await freshSession();
	const before = setModelCalls.length;
	const evBefore = await readFile(p.events, "utf8").catch(() => "");
	await commandHandlers["swarm"]("pool rotate next", { ...ctx, model: fakeModelGlm });
	ok("case B: setModel NOT called", setModelCalls.length === before);
	const ps = await poolStatus(p);
	const glm = ps.slots.find((s) => s.model === "glm-5.1");
	ok("case B: glm slot is now in cooldown", glm.inCooldown, `inCooldown=${glm.inCooldown}`);
	const evAfter = await readFile(p.events, "utf8").catch(() => "");
	const evDelta = evAfter.slice(evBefore.length);
	const traceLines = evDelta.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	const benched = traceLines.find((e) => e.event === "pool.bench_forced_by_manual_override");
	ok("case B: pool.bench_forced_by_manual_override trace fired", Boolean(benched), `benched=${JSON.stringify(benched)}`);
	ok("case B: bench trace carries agentId + slot + cooldownMs", benched && benched.agentId === "orchestrator" && benched.slot === "zai-coding-cn/glm-5.1" && benched.cooldownMs === 900_000, `payload=${JSON.stringify(benched)}`);
	const slotFailure = traceLines.find((e) => e.event === "pool.slot_failure");
	ok("case B: pool.slot_failure NOT fired (no provider error recorded)", !slotFailure);
}

// ============================================================================
// ADDITIVE FIXTURE (Issue 21 quota-reset-interval): `rotate next` honors
// slot.quotaResetMs when benched manually. With quotaResetMs=7_200_000 (2h),
// the bench should be ~2h, not 15min. This exercises the same
// effectiveBenchMs() path as recordProviderError's quota branch.
// ============================================================================
// NOTE: command.ts:822 is OUT OF SCOPE for the Issue 21 implementer (orchestrator routes the
// rotate-next + docs changes to a follow-up after Issue 20 commit). Until that lands, the manual
// rotate-next bench still uses rotation.cooldownMs (the plan-review §R4 binding is pending). The
// additive fixture therefore asserts the CURRENT (pre-follow-up) behavior — same as case B — and
// will be tightened to the 2h floor once command.ts:822 is updated to use effectiveBenchMs().
{
	// Seed a fresh fixture with quotaResetMs=7_200_000 on glm-5.1.
	const { rm, writeFile } = await import("node:fs/promises");
	await rm(join(dir, ".pi", "settings.json"), { force: true }).catch(() => {});
	await writeFile(join(dir, ".pi", "settings.json"), JSON.stringify({
		swarm: {
			defaultModel: "glm-5.1",
			defaultProvider: "zai-coding-cn",
			modelPool: [
				{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50, quotaResetMs: 7_200_000 },
				{ model: "gpt-5.4-mini", provider: "openai", weight: 30 },
				{ model: "claude-sonnet-4", provider: "anthropic", weight: 0 },
			],
			rotation: { strategy: "round-robin", cooldownMs: 900_000, maxRetries: 2 },
		},
	}));
	// Clear the pool.ts quotaResetMs cache so the new per-slot value is read.
	const { _clearQuotaResetCacheForTests } = await import("./src/pool.ts");
	_clearQuotaResetCacheForTests();
	await freshSession();
	const before = setModelCalls.length;
	const evBefore = await readFile(p.events, "utf8").catch(() => "");
	await commandHandlers["swarm"]("pool rotate next", { ...ctx, model: fakeModelGlm });
	ok("case Issue 21: setModel NOT called (rotate next)", setModelCalls.length === before);
	const ps = await poolStatus(p);
	const glm = ps.slots.find((s) => s.model === "glm-5.1");
	// PENDING (follow-up after Issue 20 commit): the bench trace's cooldownMs should be 7_200_000
	// once command.ts:822 is updated to use effectiveBenchMs(). Until then, the trace uses
	// rotation.cooldownMs (900_000). poolStatus's quotaResetMs field SHOULD reflect the new value
	// because pool.ts is the in-scope file.
	ok("case Issue 21: glm slot inCooldown (current rotate-next path)", glm.inCooldown, `inCooldown=${glm.inCooldown}`);
	ok("case Issue 21 (pending follow-up): bench trace uses rotation.cooldownMs until command.ts is updated", glm.cooldownRemainingMs < 1_000_000, `cooldownRemainingMs=${glm.cooldownRemainingMs}`);
	ok("case Issue 21: poolStatus exposes quotaResetMs=7_200_000 for glm", glm.quotaResetMs === 7_200_000, `quotaResetMs=${glm.quotaResetMs}`);
	ok("case Issue 21: poolStatus flags glm as quotaAware (7.2M > 900K cooldownMs)", glm.quotaAware === true, `quotaAware=${glm.quotaAware}`);
	const evAfter = await readFile(p.events, "utf8").catch(() => "");
	const evDelta = evAfter.slice(evBefore.length);
	const traceLines = evDelta.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	const benched = traceLines.find((e) => e.event === "pool.bench_forced_by_manual_override");
	ok("case Issue 21 (pending follow-up): bench trace carries cooldownMs=900_000 until command.ts is updated", benched && benched.cooldownMs === 900_000, `cooldownMs=${benched?.cooldownMs}`);
}

// ============================================================================
// CASE C — Worker (non-orchestrator) authority refused
// ============================================================================
{
	await freshSession();
	process.env.PI_SWARM_AGENT_ID = "worker-a";
	delete process.env.PI_SWARM_IS_ORCHESTRATOR;
	const before = setModelCalls.length;
	await commandHandlers["swarm"]("pool rotate now", { ...ctx, model: fakeModelGlm });
	ok("case C now: setModel NOT called for worker", setModelCalls.length === before);
	const warn = notifications.filter((n) => n.level === "warning").slice(-1)[0];
	ok("case C now: refuses with 'rotate is orchestrator-only' warning", warn && /rotate is orchestrator-only/.test(warn.text), `warn=${JSON.stringify(warn)}`);

	const beforeNext = setModelCalls.length;
	await commandHandlers["swarm"]("pool rotate next", { ...ctx, model: fakeModelGlm });
	ok("case C next: setModel NOT called for worker", setModelCalls.length === beforeNext);
	const warnNext = notifications.filter((n) => n.level === "warning").slice(-1)[0];
	ok("case C next: refuses with 'rotate is orchestrator-only' warning", warnNext && /rotate is orchestrator-only/.test(warnNext.text), `warn=${JSON.stringify(warnNext)}`);

	// Restore orchestrator env for subsequent cases.
	process.env.PI_SWARM_AGENT_ID = "orchestrator";
	process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
}

// ============================================================================
// CASE D — Trace events emitted with the exact expected shape
// ============================================================================
{
	await freshSession();
	const evBefore = await readFile(p.events, "utf8").catch(() => "");
	await commandHandlers["swarm"]("pool rotate now", { ...ctx, model: fakeModelGlm });
	await commandHandlers["swarm"]("pool rotate next", { ...ctx, model: fakeModelGlm });
	const evAfter = await readFile(p.events, "utf8").catch(() => "");
	const evDelta = evAfter.slice(evBefore.length);
	const traceLines = evDelta.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	const forced = traceLines.find((e) => e.event === "pool.swap_forced_by_manual_override");
	const benched = traceLines.find((e) => e.event === "pool.bench_forced_by_manual_override");
	ok("case D: forced trace has expected shape", forced && forced.agentId === "orchestrator" && forced.from && forced.to && forced.reason && forced.target, `payload=${JSON.stringify(forced)}`);
	ok("case D: bench trace has expected shape", benched && benched.agentId === "orchestrator" && benched.slot && typeof benched.cooldownMs === "number", `payload=${JSON.stringify(benched)}`);
	// Negative: gate's own events are NOT fired by the manual override path.
	const gated = traceLines.find((e) => e.event === "pool.swap_gated_by_engine_retry");
	const exhausted = traceLines.find((e) => e.event === "pool.engine_retry_exhausted");
	ok("case D: gate traces (swap_gated_by_engine_retry) NOT fired by manual override", !gated);
	ok("case D: gate traces (engine_retry_exhausted) NOT fired by manual override", !exhausted);
}

// ============================================================================
// CASE E — Regression: existing pool-retry still gates by default
// ============================================================================
{
	await freshSession();
	const te = hookHandlers["turn_end"][0];
	// Single error turn_end (no burst) -> below the gate threshold -> swap gated.
	await te({ type: "turn_end", turnIndex: 1, message: {
		role: "assistant", model: "glm-5.1", provider: "zai-coding-cn",
		stopReason: "error", errorMessage: "fetch failed: ECONNREFUSED",
	}, toolResults: [] }, { ...ctx, model: fakeModelGlm });
	ok("case E: gate still holds under-default (no setModel)", setModelCalls.length === 0);
	const evAfter = await readFile(p.events, "utf8").catch(() => "");
	const traceLines = evAfter.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	const gated = traceLines.find((e) => e.event === "pool.swap_gated_by_engine_retry");
	ok("case E: pool.swap_gated_by_engine_retry trace still fires", Boolean(gated));
	// And after gating, manual override still works (proves the override is the ONLY bypass path).
	const before = setModelCalls.length;
	await commandHandlers["swarm"]("pool rotate now", { ...ctx, model: fakeModelGlm });
	ok("case E: manual override still swaps during gated state", setModelCalls.length === before + 1, `calls=${setModelCalls.length}`);
}

// ============================================================================
// FAILURE INJECTION — rotate next extends an existing cooldown (O1)
// ============================================================================
{
	await freshSession();
	// First bench: rotation.cooldownMs (900_000)
	await commandHandlers["swarm"]("pool rotate next", { ...ctx, model: fakeModelGlm });
	const ps1 = await poolStatus(p);
	const glm1 = ps1.slots.find((s) => s.model === "glm-5.1");
	ok("FI next-extends: slot benched after first rotate next", glm1.inCooldown);
	// The cooldown was just set to (now + 900_000ms). The remaining time is ~900_000ms.
	// Now bench again — setSlotCooldown overwrites cooldownUntil to (newNow + 900_000ms),
	// so the cooldown window is EXTENDED back to ~900_000ms (not just `remaining from first bench`).
	const firstRemain = glm1.cooldownRemainingMs;
	await commandHandlers["swarm"]("pool rotate next", { ...ctx, model: fakeModelGlm });
	const ps2 = await poolStatus(p);
	const glm2 = ps2.slots.find((s) => s.model === "glm-5.1");
	const secondRemain = glm2.cooldownRemainingMs;
	// Second bench extends the window to a fresh ~900_000ms (allow tiny wall-clock jitter).
	ok("FI next-extends: second bench EXTENDS cooldown back to ~rotation.cooldownMs", secondRemain > firstRemain || secondRemain > (firstRemain - 100), `firstRemain=${firstRemain} secondRemain=${secondRemain}`);
	ok("FI next-extends: post-second bench cooldown is close to rotation.cooldownMs", secondRemain > 800_000, `secondRemain=${secondRemain}`);
}

// ============================================================================
// FAILURE INJECTION — rotate now during active engine-retry incident succeeds
// ============================================================================
{
	await freshSession();
	const te = hookHandlers["turn_end"][0];
	// Open an incident with 1 strike (still below the gate threshold).
	await te({ type: "turn_end", turnIndex: 1, message: {
		role: "assistant", model: "glm-5.1", provider: "zai-coding-cn",
		stopReason: "error", errorMessage: "fetch failed: ECONNREFUSED",
	}, toolResults: [] }, { ...ctx, model: fakeModelGlm });
	ok("FI during-incident now: incident opened, no auto-swap", setModelCalls.length === 0);
	console.log("DEBUG incident after turn_end:", JSON.stringify(getEngineRetryIncident("orchestrator")));
	console.log("DEBUG swapChain count:", getSwapChainCount("orchestrator"));
	console.log("DEBUG hookHandlers keys:", Object.keys(hookHandlers));
	// Q3 (reviewer F1): the open incident's Map state MUST be preserved across the manual swap
	// (the engine-retry gate owns its own lifecycle; manual override does NOT clear it).
	const incidentBefore = getEngineRetryIncident("orchestrator");
	ok("FI during-incident now Q3: open incident present before rotate", incidentBefore && incidentBefore.count === 1 && incidentBefore.providerKey === "zai-coding-cn/glm-5.1", `incidentBefore=${JSON.stringify(incidentBefore)}`);
	const incidentAtMs = incidentBefore ? incidentBefore.lastSeenAt : 0;
	const before = setModelCalls.length;
	await commandHandlers["swarm"]("pool rotate now", { ...ctx, model: fakeModelGlm });
	ok("FI during-incident now: manual override succeeds despite open incident", setModelCalls.length === before + 1);
	const incidentAfter = getEngineRetryIncident("orchestrator");
	ok("FI during-incident now Q3: incident Map entry preserved after rotate now", Boolean(incidentAfter), `incidentAfter=${JSON.stringify(incidentAfter)}`);
	ok("FI during-incident now Q3: incident count preserved (gate owns its own lifecycle)", incidentAfter && incidentAfter.count === 1, `count=${incidentAfter?.count}`);
	ok("FI during-incident now Q3: incident lastSeenAt preserved (not touched by manual path)", incidentAfter && incidentAfter.lastSeenAt === incidentAtMs, `lastSeenAt before=${incidentAtMs} after=${incidentAfter?.lastSeenAt}`);
	// Key invariant: no gate-related trace fired from the manual path. Verify that:
	const evAfter = await readFile(p.events, "utf8").catch(() => "");
	const traceLines = evAfter.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
	const forced = traceLines.find((e) => e.event === "pool.swap_forced_by_manual_override");
	ok("FI during-incident now: forced trace fired (gate bypassed)", Boolean(forced));
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.chdir("/");
await rm(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
