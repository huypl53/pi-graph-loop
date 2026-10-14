// D2 (plan 2026-10-14-pool-dead-slot-stuck-and-streak-runaway):
//   roles-bypass swap fallback — when the role-filtered pickSlot returns undefined (all tagged
//   slots benched) but healthy untagged slots exist, the turn_end swap hook retries with
//   bypassRolesFilter and lands on a healthy slot instead of giving up (live incident: root stuck
//   on dead terra, 225x pool.swap_no_candidate, while glm-4.7/gpt-6-luna/claude-fable-5 sat idle).
//
//   Also covers: throttled no-candidate notify (ctx.hasUI-guarded, 1 per 5min), swap-chain cap
//   on bypass swaps, config/env off-switch, R8 rolesFilterMatched correction, and R10-1 boundary
//   counting (setModel === 1, sendMessage === 2 on bypass; both 0 on true no-candidate).
//
// RED-first: S1 fails against current source. Run: node extensions/swarm/tests/pool-roles-swap-fallback.test.mjs
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, readState, writeState } from "../src/state.ts";
import { registerSwarmHooks, _resetSwapChainForTests } from "../src/hooks.ts";
import { readPoolHealth, writePoolHealth, withPoolLock, validateSwarmSettings, _clearQuotaResetCacheForTests } from "../src/pool.ts";

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

delete process.env.PI_SWARM_ROLE_FALLBACK_OFF;
delete process.env.PI_SWARM_BENCH_MAX_MS;

const dir = await mkdtemp(join(tmpdir(), "pool-roles-swap-fb-"));
await mkdir(join(dir, ".pi"), { recursive: true });
// Pool shaped like the live incident: A=root-tagged (will error), B=root-tagged (pre-benched),
// C=untagged healthy worker slot (the bypass must land here).
await writeFile(
	join(dir, ".pi", "swarm.yml"),
	`modelPool:
  - model: terra
    provider: cp
    roles: [root]
  - model: glm53
    provider: cp
    roles: [root]
  - model: glm47
    provider: cp
rotation:
  strategy: weighted
  cooldownMs: 900000
  maxRetries: 2
`,
);
process.chdir(dir);
const p = paths(dir);

const setModelCalls = [];
const sentMessages = [];
const notifications = [];
const hookHandlers = {};
const fakePi = {
	on: (ev, fn) => {
		(hookHandlers[ev] ||= []).push(fn);
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
const fakeModelTerra = { id: "terra", provider: "cp" };
const fakeModelGlm47 = { id: "glm47", provider: "cp" };
const fakeModelGlm53 = { id: "glm53", provider: "cp" };
const mkCtx = (over = {}) => ({
	cwd: dir,
	mode: "tui",
	hasUI: true,
	isIdle: () => true,
	model: fakeModelTerra,
	modelRegistry: { find: (provider, id) => (id === "terra" ? fakeModelTerra : id === "glm47" ? fakeModelGlm47 : id === "glm53" ? fakeModelGlm53 : id === "fable" ? { id: "fable", provider: "cp" } : undefined) },
	ui: { notify: (text, level) => notifications.push({ level, text }), setStatus: () => {} },
	...over,
});

async function seedRootAgent(roleKind = "root") {
	const st = await readState(p, dir);
	st.agents["root"] = {
		id: "root",
		agentId: "root",
		roleKind,
		status: "running",
		createdAt: new Date().toISOString(),
	};
	await writeState(p, st);
}

async function fresh(agentId = "root") {
	await rm(join(dir, ".pi/swarm/pool-state.json"), { force: true }).catch(() => {});
	await rm(p.events, { force: true }).catch(() => {});
	setModelCalls.length = 0;
	sentMessages.length = 0;
	notifications.length = 0;
	for (const k of Object.keys(hookHandlers)) delete hookHandlers[k];
	process.env.PI_SWARM_AGENT_ID = agentId;
	process.env.PI_SWARM_IS_ROOT = "1";
	registerSwarmHooks(fakePi);
	const ss = hookHandlers["session_start"][0];
	await ss({ type: "session_start" }, mkCtx());
	_resetSwapChainForTests(agentId);
	await seedRootAgent();
}

async function traceEvents() {
	const raw = await readFile(p.events, "utf8").catch(() => "");
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
		.filter(Boolean);
}

// Fire an engine-exhausted quota error turn_end on the given model (default terra, the CURRENT slot).
// Two strikes (ENGINE_MAX_RETRIES=2) within the window exhaust the gate -> swap path fires.
async function fireQuotaErrorTurn(ctx, strikes = 2, model = "terra") {
	for (let i = 0; i < strikes; i++) {
		for (const fn of hookHandlers["turn_end"] || []) {
			await fn(
				{ type: "turn_end", message: { role: "assistant", model, provider: "cp", stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit." } },
				ctx,
			);
		}
	}
}

async function benchSlot(key, untilMs) {
	await withPoolLock(p, async () => {
		const h = await readPoolHealth(p);
		h.slots[key] = { failures: 0, cooldownUntil: new Date(Date.now() + untilMs).toISOString(), benchStreak: 1, lastBenchReason: "quota" };
		await writePoolHealth(p, h);
	});
}

// --- S1 THE REPRODUCTION (D2): all root-tagged slots dead -> bypass lands on untagged healthy ---
{
	await fresh();
	await benchSlot("cp/glm53", 2 * 3600_000); // the other root slot already benched
	await fireQuotaErrorTurn(mkCtx()); // terra quota error -> engine gate exhausts -> swap path
	const evs = await traceEvents();
	const swap = evs.filter((e) => e.event === "pool.swap").at(-1);
	ok("S1 bypass swap fired (pool.swap traced)", !!swap, JSON.stringify(evs.filter((e) => e.event?.startsWith("pool."))));
	ok("S1 swapped to the untagged healthy slot", setModelCalls.at(-1) === "cp/glm47", JSON.stringify(setModelCalls));
	ok("S1 trace carries rolesIgnored:true", swap?.rolesIgnored === true, JSON.stringify(swap));
	ok("S1 rolesFilterMatched false on bypass (R8)", swap?.rolesFilterMatched === false, JSON.stringify(swap));
	// R10-1: bypass uses the SAME setModel call site + the same two follow-up sendMessages.
	// (A first-strike gated retry-note may precede exhaustion — Issue 17 behavior — so count the
	// swap-path slice: exactly one swarm-pool-event + one trailing continue-note.)
	const poolEvents = sentMessages.filter((s) => s.m?.customType === "swarm-pool-event");
	ok("S1 R10-1 setModel === 1", setModelCalls.length === 1, JSON.stringify(setModelCalls));
	ok("S1 R10-1 exactly 1 swarm-pool-event + trailing continue note", poolEvents.length === 1 && sentMessages.at(-1)?.m?.customType === "swarm-message", JSON.stringify(sentMessages.map((s) => s.m?.customType)));
	const noCand = evs.filter((e) => e.event === "pool.swap_no_candidate");
	ok("S1 no swap_no_candidate (bypass succeeded)", noCand.length === 0);
}

// --- S2: TRUE no-candidate (all slots benched) -> throttled notify, zero NEW boundary crossings ---
{
	await fresh();
	await benchSlot("cp/glm53", 2 * 3600_000);
	await benchSlot("cp/glm47", 2 * 3600_000); // even the untagged slot is benched
	const ctx = mkCtx();
	await fireQuotaErrorTurn(ctx); // strike 1+2 -> exhausted -> no healthy candidate -> D5 probe ring opens
	// Burn the ring: each probed slot fails its own 2-strike burst, advancing the ring, until
	// every slot is tried and the round records durable exhaustion (swap_no_candidate + notify).
	for (let i = 0; i < 4; i++) {
		const serving = setModelCalls.at(-1)?.split("/")[1];
		if (!serving) break; // ring never opened a probe (unexpected) — bail to fail loudly below
		const before = setModelCalls.length;
		await fireQuotaErrorTurn(ctx, 2, serving);
		if (setModelCalls.length === before) break; // no further probe -> round exhausted
	}
	const evs = await traceEvents();
	// D5 (2026-10-14 §1.4) semantics: an all-benched pool OPENS a probe round — terra probes the
	// benched glm53 (cooldown bypass), then glm47. The OLD "stand still + no setModel" behavior
	// is gone by design; the ring IS the no-candidate answer, bounded to one probe per slot.
	ok("S2 probe ring opened on all-benched pool", setModelCalls.length >= 1, JSON.stringify(setModelCalls));
	const probeSwaps = evs.filter((e) => e.event === "pool.probe_round_swap");
	ok("S2 probe_round_swap traced with ignoredCooldown", probeSwaps.length >= 1 && probeSwaps[0].ignoredCooldown === true, JSON.stringify(probeSwaps));
	// After the whole ring burns (2-slot pool: glm53 + glm47 + terra tried), the round exhausts:
	// swap_no_candidate traced with the durable fence, notify says when the next round opens.
	const noCand = evs.filter((e) => e.event === "pool.swap_no_candidate");
	ok("S2 swap_no_candidate traced once the ring exhausts", noCand.length >= 1, JSON.stringify(evs.filter((e) => e.event?.startsWith("pool.")).map((e) => e.event)));
	const errNotifies = notifications.filter((n) => n.level === "error" && /(no healthy slot|probe round exhausted)/i.test(n.text));
	ok("S2 operator notify fired exactly once (5min throttle)", errNotifies.length === 1, JSON.stringify(notifications));

	// headless shape: ctx.hasUI false must not throw (R4)
	await fresh();
	await benchSlot("cp/glm53", 2 * 3600_000);
	await benchSlot("cp/glm47", 2 * 3600_000);
	const headless = mkCtx({ hasUI: false });
	headless.ui = undefined;
	let threw = false;
	try {
		await fireQuotaErrorTurn(headless);
	} catch (e) {
		threw = true;
		console.error("   headless threw:", e?.message);
	}
	ok("S2 headless (no ctx.ui) does not throw (R4)", !threw);
}

// --- S3: config off-switch restores old behavior ---
{
	await fresh();
	await benchSlot("cp/glm53", 2 * 3600_000);
	await writeFile(
		join(dir, ".pi", "swarm.yml"),
		`modelPool:
  - model: terra
    provider: cp
    roles: [root]
  - model: glm53
    provider: cp
    roles: [root]
  - model: glm47
    provider: cp
rotation:
  strategy: weighted
  roleFallbackOnSwap: false
`,
	);
	_clearQuotaResetCacheForTests();
	await fireQuotaErrorTurn(mkCtx());
	const evs = await traceEvents();
	ok("S3 roleFallbackOnSwap:false → old behavior (no candidate, no swap)", setModelCalls.length === 0 && evs.some((e) => e.event === "pool.swap_no_candidate"));
	// env off-switch
	await writeFile(
		join(dir, ".pi", "swarm.yml"),
		`modelPool:
  - model: terra
    provider: cp
    roles: [root]
  - model: glm53
    provider: cp
    roles: [root]
  - model: glm47
    provider: cp
rotation:
  strategy: weighted
`,
	);
	_clearQuotaResetCacheForTests();
	await rm(join(dir, ".pi/swarm/pool-state.json"), { force: true });
	await fresh();
	await benchSlot("cp/glm53", 2 * 3600_000);
	process.env.PI_SWARM_ROLE_FALLBACK_OFF = "1";
	await fireQuotaErrorTurn(mkCtx());
	const evs2 = await traceEvents();
	ok("S3 env PI_SWARM_ROLE_FALLBACK_OFF=1 → old behavior", setModelCalls.length === 0 && evs2.some((e) => e.event === "pool.swap_no_candidate"));
	delete process.env.PI_SWARM_ROLE_FALLBACK_OFF;
}

// --- S4: bypass swaps are bounded by the swap-chain cap ---
{
	await fresh();
	await benchSlot("cp/glm53", 2 * 3600_000);
	// Each round: the SERVING model dies (2 strikes) -> swap; serving model tracks setModelCalls.
	// Round 1: terra dies -> swap to glm47 (bypass). Round 2: glm47 dies -> swap to terra
	// (un-benched again post-D4? terra was benched 1h in round 1 — still benched, so round 2's
	// filtered+bypass picks find nothing -> no-candidate). Either way the chain must NOT exceed
	// MAX_SWAP_CHAIN: at most 2 swaps, then capped/no-candidate.
	for (let round = 0; round < 3; round++) {
		const serving = setModelCalls.at(-1)?.split("/")[1] || "terra";
		await fireQuotaErrorTurn(mkCtx({ model: { id: serving, provider: "cp" } }), 2, serving);
	}
	const evs = await traceEvents();
	const swaps = evs.filter((e) => e.event === "pool.swap");
	const capped = evs.some((e) => e.event === "pool.swap_chain_capped");
	const noCand = evs.some((e) => e.event === "pool.swap_no_candidate");
	ok("S4 bypass swaps bounded (≤ MAX_SWAP_CHAIN=2)", swaps.length <= 2, JSON.stringify(swaps.map((s) => s.to)));
	ok("S4 chain capped OR exhausted into no-candidate (never unbounded)", capped || noCand, JSON.stringify(evs.filter((e) => e.event?.startsWith("pool.")).slice(-3)));
}

// --- S5: bypass may land on a differently-tagged slot (any healthy slot) ---
{
	await writeFile(
		join(dir, ".pi", "swarm.yml"),
		`modelPool:
  - model: terra
    provider: cp
    roles: [root]
  - model: glm53
    provider: cp
    roles: [root]
  - model: fable
    provider: cp
    roles: [reviewer]
`,
	);
	_clearQuotaResetCacheForTests();
	// fresh() re-reads the yml at session_start — write yml FIRST, then fresh, then bench.
	await fresh();
	await benchSlot("cp/glm53", 2 * 3600_000);
	await fireQuotaErrorTurn(mkCtx());
	const evs = await traceEvents();
	const swap = evs.filter((e) => e.event === "pool.swap").at(-1);
	ok("S5 bypass landed on the differently-tagged healthy slot", setModelCalls.at(-1) === "cp/fable", JSON.stringify(setModelCalls));
	ok("S5 traced rolesIgnored:true", swap?.rolesIgnored === true, JSON.stringify(swap));
}

await rm(dir, { recursive: true, force: true });
process.chdir("/");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
