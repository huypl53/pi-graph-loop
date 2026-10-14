#!/usr/bin/env node
// D5 (plan 2026-10-14-pool-dead-slot-stuck-and-streak-runaway §1.4): forced model probe round.
//   When a pool error path is EXHAUSTED (engine gate done, slot benched), the swap hook
//   round-robins through every distinct configured provider/model slot ONCE — bypassing BOTH
//   cooldown AND roles — because a proxy provider (cliproxyapi) is transport only: each model
//   under it has an independent quota window. Only after the full round fails does swarm record
//   a durable nextProbeAt (≤ benchMaxMs, D4) and stop probing until due.
//
//   Covers plan §4.3 S1-S7: repro (A→benched-B), full round A→B→C + success clears, all-fail
//   exhaustion + no re-probe before due, durable round survives reload (no re-probe of B),
//   config/env off-switch, unresolvable-registry skip, gated-transient/stop no-round.
//
// RED-first: S1-S4,S6 fail against current source. Run: node extensions/swarm/tests/pool-probe-round.test.mjs
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, readState, writeState } from "../src/state.ts";
import { registerSwarmHooks, _resetSwapChainForTests } from "../src/hooks.ts";
import { readPoolHealth, writePoolHealth, withPoolLock, _clearQuotaResetCacheForTests } from "../src/pool.ts";

delete process.env.PI_SWARM_ROLE_FALLBACK_OFF;
delete process.env.PI_SWARM_BENCH_MAX_MS;
delete process.env.PI_SWARM_FORCE_PROBE_ROUND_OFF;

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

const dir = await mkdtemp(join(tmpdir(), "pool-probe-round-"));
await mkdir(join(dir, ".pi"), { recursive: true });
process.chdir(dir);

const setModelCalls = [];
const sentMessages = [];
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

const registry = { find: (provider, id) => ({ id, provider: provider === "(default)" ? "mock-llm" : provider }) };

const mkCtx = (over = {}) => ({
	cwd: dir,
	mode: "tui",
	hasUI: false,
	isIdle: () => true,
	model: { id: "probe-a", provider: "mock-llm" },
	modelRegistry: registry,
	...over,
});

const p = paths(dir);

async function writeYml(poolYml, rotationExtra = "") {
	await writeFile(
		join(dir, ".pi", "swarm.yml"),
		`modelPool:
${poolYml}
rotation:
  strategy: round-robin
${rotationExtra}`,
	);
	_clearQuotaResetCacheForTests();
}

const POOL_ABC = `  - model: probe-a
    provider: mock-llm
    roles: [root]
  - model: probe-b
    provider: mock-llm
    roles: [root]
  - model: probe-c
    provider: mock-llm`;

async function seedRootAgent() {
	const st = await readState(p, dir);
	st.agents["root"] = {
		id: "root",
		agentId: "root",
		roleKind: "root",
		status: "running",
		createdAt: new Date().toISOString(),
	};
	await writeState(p, st);
}

async function fresh() {
	await rm(join(dir, ".pi/swarm/pool-state.json"), { force: true }).catch(() => {});
	await rm(p.events, { force: true }).catch(() => {});
	await rm(join(dir, ".pi/swarm/swarm-state.json"), { force: true }).catch(() => {});
	setModelCalls.length = 0;
	sentMessages.length = 0;
	for (const k of Object.keys(hookHandlers)) delete hookHandlers[k];
	process.env.PI_SWARM_AGENT_ID = "root";
	process.env.PI_SWARM_IS_ROOT = "1";
	registerSwarmHooks(fakePi);
	const ss = hookHandlers["session_start"][0];
	await ss({ type: "session_start" }, mkCtx());
	_resetSwapChainForTests("root");
	await seedRootAgent();
}

async function fireQuotaErrorTurn(model, strikes = 2) {
	for (let i = 0; i < strikes; i++) {
		for (const fn of hookHandlers["turn_end"] || []) {
			await fn(
				{
					type: "turn_end",
					message: { role: "assistant", model, provider: "mock-llm", stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit." },
				},
				mkCtx({ model: { id: model, provider: "mock-llm" } }),
			);
		}
	}
}

async function fireStopTurn(model) {
	for (const fn of hookHandlers["turn_end"] || []) {
		await fn({ type: "turn_end", message: { role: "assistant", model, provider: "mock-llm", stopReason: "stop" } }, mkCtx({ model: { id: model, provider: "mock-llm" } }));
	}
}

async function benchSlot(key, untilMs, streak = 2) {
	await withPoolLock(p, async () => {
		const h = await readPoolHealth(p);
		h.slots[key] = { failures: 0, cooldownUntil: new Date(Date.now() + untilMs).toISOString(), benchStreak: streak, lastBenchReason: "quota" };
		await writePoolHealth(p, h);
	});
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
				return {};
			}
		});
}

async function swarmState() {
	return JSON.parse(await readFile(join(dir, ".pi/swarm/swarm-state.json"), "utf8"));
}

// --- S1 THE REPRODUCTION (D5): exhausted quota on A probes cooldown-benched B ---
// ALL slots must be cooled/benched — D2 (serve healthy first) outranks probing, so with a
// healthy slot present the normal bypass would fire and the round would (correctly) not open.
{
	await writeYml(POOL_ABC);
	await fresh();
	await benchSlot("mock-llm/probe-b", 3600_000); // benched 1h — old code: invisible to pickSlot
	await benchSlot("mock-llm/probe-c", 1800_000); // benched too — no healthy slot anywhere
	await fireQuotaErrorTurn("probe-a");
	const evs = await traceEvents();
	const noCand = evs.some((e) => e.event === "pool.swap_no_candidate");
	const probeSwap = setModelCalls.includes("mock-llm/probe-b");
	ok("S1 probe swap lands on cooldown-benched probe-b", probeSwap, JSON.stringify(setModelCalls));
	ok("S1 not a terminal swap_no_candidate", !noCand || probeSwap, "swap_no_candidate emitted although probe round should apply");
	const st = await swarmState();
	const round = st.poolProbeRounds?.root;
	ok("S1 durable poolProbeRounds.root exists", !!round, JSON.stringify(st.poolProbeRounds));
	ok("S1 triedSlots includes A and B", round?.triedSlots?.includes("mock-llm/probe-a") && round?.triedSlots?.includes("mock-llm/probe-b"), JSON.stringify(round));
}

// --- S2: full round A→B→C in canonical order, each slot once, success clears ---
{
	await writeYml(POOL_ABC);
	await fresh();
	await benchSlot("mock-llm/probe-b", 3600_000);
	await benchSlot("mock-llm/probe-c", 1800_000, 1);
	await fireQuotaErrorTurn("probe-a"); // A exhausted → probe B
	await fireQuotaErrorTurn("probe-b"); // B exhausted → probe C
	ok("S2 canonical-order round A→B→C", JSON.stringify(setModelCalls) === JSON.stringify(["mock-llm/probe-b", "mock-llm/probe-c"]), JSON.stringify(setModelCalls));
	ok("S2 no slot probed twice", new Set(setModelCalls).size === setModelCalls.length);
	await fireStopTurn("probe-c"); // C healthy → round cleared
	const st = await swarmState();
	ok("S2 success clears poolProbeRounds.root", st.poolProbeRounds?.root === undefined, JSON.stringify(st.poolProbeRounds));
}

// --- S3: all fail — N-1 probe swaps, durable nextProbeAt ≤ now+1h, no re-probe before due ---
// B and C pre-benched: the ring opens from the FIRST failure (nothing healthy to serve).
{
	await writeYml(POOL_ABC);
	await fresh();
	await benchSlot("mock-llm/probe-b", 3600_000);
	await benchSlot("mock-llm/probe-c", 1800_000, 1);
	await fireQuotaErrorTurn("probe-a");
	await fireQuotaErrorTurn("probe-b");
	await fireQuotaErrorTurn("probe-c");
	ok("S3 exactly 2 probe swaps in a 3-slot pool", setModelCalls.length === 2, JSON.stringify(setModelCalls));
	const st = await swarmState();
	const round = st.poolProbeRounds?.root;
	ok("S3 durable nextProbeAt recorded", !!round?.nextProbeAt, JSON.stringify(round));
	if (round?.nextProbeAt) {
		const due = new Date(round.nextProbeAt).getTime();
		ok("S3 nextProbeAt ≤ now+1h (D4 ceiling)", due <= Date.now() + 3600_000 + 60_000, round.nextProbeAt);
	}
	// post-exhaustion errors on C (the last current slot) must not probe again before due
	await fireQuotaErrorTurn("probe-c");
	ok("S3 no probe after round exhausted (before due)", setModelCalls.length === 2, JSON.stringify(setModelCalls));
}

// --- S4: durable round survives reload — B is not re-probed after rehydration ---
{
	await writeYml(POOL_ABC);
	await fresh();
	// Simulate reload aftermath: round already advanced past A and B (B probed and failed),
	// and every slot still benched (cooldowns persist across restarts in pool-state.json).
	await benchSlot("mock-llm/probe-a", 3600_000);
	await benchSlot("mock-llm/probe-b", 3600_000);
	await benchSlot("mock-llm/probe-c", 3600_000);
	const st = await readState(p, dir);
	st.poolProbeRounds = {
		root: { roundId: "r1", startedAt: new Date().toISOString(), triedSlots: ["mock-llm/probe-a", "mock-llm/probe-b"], cursor: 2 },
	};
	await writeState(p, st);
	await fireQuotaErrorTurn("probe-c"); // C now current and failing
	ok("S4 rehydrated round does not re-probe A/B", setModelCalls.length === 0, JSON.stringify(setModelCalls));
	const st2 = await swarmState();
	ok("S4 exhausted rehydrated round records nextProbeAt", !!st2.poolProbeRounds?.root?.nextProbeAt, JSON.stringify(st2.poolProbeRounds?.root));
}

// --- S5: forceProbeRound:false + env off retain old behavior ---
{
	await writeYml(POOL_ABC, "  forceProbeRound: false");
	await fresh();
	await benchSlot("mock-llm/probe-b", 3600_000);
	await fireQuotaErrorTurn("probe-a");
	ok("S5 config off: benched probe-b never probed (D2 untagged fallback may still fire)", !setModelCalls.includes("mock-llm/probe-b") && !setModelCalls.includes("mock-llm/probe-a"), JSON.stringify(setModelCalls));
	// env off-switch (config on, env wins)
	await writeYml(POOL_ABC, "  forceProbeRound: true");
	process.env.PI_SWARM_FORCE_PROBE_ROUND_OFF = "1";
	try {
		await fresh();
		await benchSlot("mock-llm/probe-b", 3600_000);
		await fireQuotaErrorTurn("probe-a");
		ok("S5 env PI_SWARM_FORCE_PROBE_ROUND_OFF=1: benched slot never probed", !setModelCalls.includes("mock-llm/probe-b") && !setModelCalls.includes("mock-llm/probe-a"), JSON.stringify(setModelCalls));
	} finally {
		delete process.env.PI_SWARM_FORCE_PROBE_ROUND_OFF;
	}
}

// --- S6: unresolvable registry slot skipped, round continues to next slot ---
{
	const pool = `  - model: probe-a
    provider: mock-llm
    roles: [root]
  - model: probe-broken
    provider: mock-llm
    roles: [root]
  - model: probe-c
    provider: mock-llm
    roles: [root]`;
	await writeYml(pool);
	await fresh();
	// All slots benched except the current A — the probe ring must open on A's failure, and the
	// unresolvable probe-broken must be skipped WITHOUT a setModel (resolver predicate).
	await benchSlot("mock-llm/probe-broken", 3600_000);
	await benchSlot("mock-llm/probe-c", 3600_000);
	const partialRegistry = { find: (provider, id) => (id === "probe-broken" ? undefined : { id, provider }) };
	const ctxPartial = mkCtx({ modelRegistry: partialRegistry });
	for (let i = 0; i < 2; i++) {
		for (const fn of hookHandlers["turn_end"] || []) {
			await fn({ type: "turn_end", message: { role: "assistant", model: "probe-a", provider: "mock-llm", stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit." } }, ctxPartial);
		}
	}
	ok("S6 unresolvable slot never receives setModel", !setModelCalls.includes("mock-llm/probe-broken"), JSON.stringify(setModelCalls));
	ok("S6 round continues past it to probe-c", setModelCalls.includes("mock-llm/probe-c"), JSON.stringify(setModelCalls));
}

// --- S7: gated transient does not create a round; healthy stop leaves no round ---
{
	await writeYml(POOL_ABC);
	await fresh();
	// single error turn = below ENGINE_MAX_RETRIES → gated, no round
	for (const fn of hookHandlers["turn_end"] || []) {
		await fn({ type: "turn_end", message: { role: "assistant", model: "probe-a", provider: "mock-llm", stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit." } }, mkCtx());
	}
	let st = await swarmState();
	ok("S7 no round before engine exhaustion", st.poolProbeRounds?.root === undefined, JSON.stringify(st.poolProbeRounds?.root));
	await fireStopTurn("probe-a");
	st = await swarmState();
	ok("S7 stop turn leaves no round", st.poolProbeRounds?.root === undefined, JSON.stringify(st.poolProbeRounds?.root));
}

// --- S8: due-wake — exactly one continuation per exhausted round, durable wakeSentAt fence ---
{
	await writeYml(POOL_ABC);
	await fresh();
	// Seed an EXHAUSTED round whose nextProbeAt is in the past.
	const st = await readState(p, dir);
	st.poolProbeRounds = {
		root: {
			roundId: "r-wake",
			startedAt: new Date(Date.now() - 7200_000).toISOString(),
			triedSlots: ["mock-llm/probe-a", "mock-llm/probe-b", "mock-llm/probe-c"],
			cursor: 0,
			exhaustedAt: new Date(Date.now() - 3600_000).toISOString(),
			nextProbeAt: new Date(Date.now() - 60_000).toISOString(),
		},
	};
	await writeState(p, st);
	sentMessages.length = 0;
	const { evaluateProbeRoundWakeLocked } = await import("../src/surface/pump-phases.ts");
	// fake pi capturing sendMessage (the L2 boundary)
	const wakePi = { sendMessage: (m, o) => sentMessages.push({ m, o }) };
	const wakeCtx = { cwd: dir, isIdle: () => true };
	await evaluateProbeRoundWakeLocked(wakePi, wakeCtx, p, st, Date.now());
	const wakes = sentMessages.filter((s) => s.m?.customType === "swarm-message" && s.m?.content?.includes("Continue"));
	ok("S8 due wake sent exactly one continuation", wakes.length === 1, JSON.stringify(sentMessages));
	ok("S8 wake triggerTurn set", wakes[0]?.o?.triggerTurn === true, JSON.stringify(wakes[0]?.o));
	// wakeSentAt stamped durably → second tick must NOT re-send
	const st2 = JSON.parse(await readFile(join(dir, ".pi/swarm/swarm-state.json"), "utf8"));
	ok("S8 wakeSentAt stamped", !!st2.poolProbeRounds?.root?.wakeSentAt, JSON.stringify(st2.poolProbeRounds?.root?.wakeSentAt));
	sentMessages.length = 0;
	await evaluateProbeRoundWakeLocked(wakePi, wakeCtx, p, st2, Date.now());
	const wakes2 = sentMessages.filter((s) => s.m?.customType === "swarm-message");
	ok("S8 no duplicate wake on next tick (durable fence)", wakes2.length === 0, JSON.stringify(sentMessages));
}

// --- S9: not-yet-due round sends nothing; non-exhausted round sends nothing ---
{
	await writeYml(POOL_ABC);
	await fresh();
	const st = await readState(p, dir);
	st.poolProbeRounds = {
		root: {
			roundId: "r-future",
			startedAt: new Date().toISOString(),
			triedSlots: ["mock-llm/probe-a", "mock-llm/probe-b", "mock-llm/probe-c"],
			cursor: 0,
			exhaustedAt: new Date().toISOString(),
			nextProbeAt: new Date(Date.now() + 1800_000).toISOString(),
		},
	};
	await writeState(p, st);
	sentMessages.length = 0;
	const { evaluateProbeRoundWakeLocked } = await import("../src/surface/pump-phases.ts");
	await evaluateProbeRoundWakeLocked({ sendMessage: (m, o) => sentMessages.push({ m, o }) }, { cwd: dir, isIdle: () => true }, p, st, Date.now());
	ok("S9 future-due round sends no wake", sentMessages.length === 0, JSON.stringify(sentMessages));
	// open (non-exhausted) round: also no wake
	st.poolProbeRounds.root = { roundId: "r-open", startedAt: new Date().toISOString(), triedSlots: ["mock-llm/probe-a"], cursor: 1 };
	await writeState(p, st);
	sentMessages.length = 0;
	await evaluateProbeRoundWakeLocked({ sendMessage: (m, o) => sentMessages.push({ m, o }) }, { cwd: dir, isIdle: () => true }, p, st, Date.now());
	ok("S9 open (non-exhausted) round sends no wake", sentMessages.length === 0, JSON.stringify(sentMessages));
}

await rm(dir, { recursive: true, force: true });
process.chdir("/");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
