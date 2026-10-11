// Incident 2026-10-11 (session 01a12883): slow-timeout errors spaced beyond the engine-retry
// window never accumulate into one incident, so the gate never opens.
//
// Root cause: ENGINE_RETRY_WINDOW_MS (14s) was calibrated for pi's exponential backoff budget
// (2s+4s+8s) but NOT for the request duration itself. A "Codex SSE response headers timed out
// after 300000ms" attempt takes 5 minutes; two consecutive strikes on the same slot are
// ~302s apart, so each strike ages out the previous incident (window check on lastSeenAt) and
// starts a FRESH incident at count:1. The gate threshold is never reached — live trace shows
// three identical timeout strikes at 01:36 / 01:41 / 01:46, all gated count:1, zero
// engine_retry_exhausted, and the session had to be rescued by a MANUAL model change.
//
// Key pi runtime fact this fix relies on (verified in pi-agent-core agent-loop.js): every
// engine retry re-enters through agent.continue() → runAgentLoopContinue, which emits a fresh
// agent_start + turn_start BEFORE the next attempt. So "a turn_start observed after the last
// error strike" means the engine started a NEW ATTEMPT on the same incident — the incident is
// live regardless of how long the attempt took.
//
// This suite pins the corrected contract with a fake clock (no real sleeping):
//   S1: two identical timeout strikes spaced 302s apart WITH a turn_start in between (engine
//       re-entry) accumulate into ONE incident; the second strike exhausts the gate and swaps.
//   S2: two identical timeout strikes spaced 302s apart WITHOUT any turn_start in between
//       (agent idle, no new attempt) still age out — fresh incident, still gated, no swap.
//   S3: a successful turn between strikes clears the incident (recovered) even when a
//       turn_start follows — recovery wins over liveness.
//   S4: fast bursts (within the wall-clock window) behave exactly as before (regression guard
//       for the existing gate semantics).
//
// Run: node extensions/swarm/tests/pool-slow-attempt-window.test.mjs
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { stringify } from "yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, readState, writeState } from "../src/state.ts";
import { registerSwarmHooks } from "../src/hooks.ts";
import { poolStatus } from "../src/pool.ts";

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) pass++;
	else {
		fail++;
		console.error("  FAIL:", name, info ?? "");
	}
};

// --- fake clock: deterministic inter-strike spacing without real sleeps ---
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const advance = (ms) => {
	clockOffset += ms;
};

// --- fixture project with a model pool ---
const dir = await mkdtemp(join(tmpdir(), "pool-slow-attempt-"));
await mkdir(join(dir, ".pi"), { recursive: true });
await writeFile(
	join(dir, ".pi", "swarm.yml"),
	stringify({
		defaultModel: "glm-5.1",
		defaultProvider: "zai-coding-cn",
		modelPool: [
			{ model: "glm-5.1", provider: "zai-coding-cn", weight: 50 },
			{ model: "gpt-5.4-mini", provider: "openai", weight: 30 },
		],
		rotation: { strategy: "round-robin", cooldownMs: 300_000, maxRetries: 2 },
	}),
);
process.chdir(dir);
const p = paths(dir);

const setModelCalls = [];
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
	sendMessage: () => {},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};
const fakeModelGlm = { id: "glm-5.1", provider: "zai-coding-cn" };
const fakeModelGpt = { id: "gpt-5.4-mini", provider: "openai" };
const ctx = {
	cwd: dir,
	mode: "tui",
	isIdle: () => true,
	model: fakeModelGlm,
	modelRegistry: {
		find: (provider, id) => (id === "gpt-5.4-mini" ? fakeModelGpt : id === "glm-5.1" ? fakeModelGlm : undefined),
	},
};

registerSwarmHooks(fakePi);
const turnEnd = handlers["turn_end"][0];
const turnStart = handlers["turn_start"][0]; // turns.ts root-epoch handler (harmless for workers)
const turnStartLiveness = handlers["turn_start"][1]; // pool liveness stamp (pool-swap.ts, Incident B)

const TIMEOUT_ERR = "Codex SSE response headers timed out after 300000ms";

let turnIdx = 0;
async function strike(model = fakeModelGlm, errorMessage = TIMEOUT_ERR) {
	await turnEnd(
		{
			type: "turn_end",
			turnIndex: turnIdx++,
			message: { role: "assistant", model: model.id, provider: model.provider, stopReason: "error", errorMessage },
			toolResults: [],
		},
		{ ...ctx, model },
	);
}
async function attemptStart() {
	// Mimic pi's engine retry re-entry: runAgentLoopContinue emits agent_start + turn_start.
	// Drive the LIVESS handler (index 1) — that is the one the gate's hasAttemptSinceIncident
	// reads. (Index 0 is the root-epoch handler; it no-ops for non-root agents.)
	await turnStartLiveness({ type: "turn_start", turnIndex: turnIdx, timestamp: Date.now() }, { ...ctx, model: fakeModelGlm });
}
async function healthyStop(model = fakeModelGpt) {
	await turnEnd(
		{
			type: "turn_end",
			turnIndex: turnIdx++,
			message: { role: "assistant", model: model.id, provider: model.provider, stopReason: "stop", errorMessage: undefined },
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
	_resetTurnStartForTests(); // in-process liveness stamps must not leak across scenarios
	process.env.PI_SWARM_AGENT_ID = agentId;
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

// =============================================================
// S1: slow strikes + turn_start re-entry accumulate (the live incident)
// =============================================================
{
	await freshSession("worker-slow");
	await strike(); // t0: first timeout, gated count:1
	advance(302_000); // the retry attempt itself took ~302s (300s timeout + backoff)
	await attemptStart(); // pi re-enters via agent.continue() -> turn_start
	await strike(); // t0+302s: second timeout on the SAME incident
	ok(
		"S1: second slow strike (turn_start re-entry) exhausts and swaps",
		setModelCalls.length === 1,
		`calls=${setModelCalls.length} (live session needed a MANUAL model change here)`,
	);
	if (setModelCalls.length > 0)
		ok("S1: swapped to a DIFFERENT slot", setModelCalls[0] !== "zai-coding-cn/glm-5.1", `to=${setModelCalls[0]}`);
	const exhausted = await countTraceEvents("pool.engine_retry_exhausted");
	ok("S1: engine_retry_exhausted fired once", exhausted === 1, `exhausted=${exhausted}`);
	const gated = await countTraceEvents("pool.swap_gated_by_engine_retry");
	ok("S1: first strike was gated exactly once", gated === 1, `gated=${gated}`);
	// Transient kind: no immediate bench, but streak recorded once.
	const ps = await poolStatus(p);
	const glm = ps.slots.find((s) => s.model === "glm-5.1");
	ok("S1: transient slot NOT benched (streak 1 < maxRetries 2)", !glm?.inCooldown, JSON.stringify(glm?.health ?? null));
}

// =============================================================
// S2: slow strikes WITHOUT re-entry still age out (idle gap)
// =============================================================
{
	await freshSession("worker-idle");
	await strike();
	advance(302_000);
	// NO turn_start: the agent sat idle (settled) between the errors — nothing is in flight.
	await strike();
	ok("S2: idle-gap strike starts a fresh incident (no swap)", setModelCalls.length === 0, `calls=${setModelCalls.length}`);
	const gated = await countTraceEvents("pool.swap_gated_by_engine_retry");
	ok("S2: both strikes gated", gated === 2, `gated=${gated}`);
}

// =============================================================
// S3: a successful turn clears the incident even if turn_start follows
// =============================================================
{
	await freshSession("worker-recover");
	await strike(); // gated count:1
	await attemptStart();
	await healthyStop(fakeModelGlm); // engine recovered on the retry — incident cleared
	advance(302_000);
	await attemptStart();
	await strike(); // fresh incident, gated
	ok("S3: recovery clears the incident (no swap on the next single strike)", setModelCalls.length === 0, `calls=${setModelCalls.length}`);
	const recovered = await countTraceEvents("pool.engine_retry_recovered");
	ok("S3: engine_retry_recovered fired", recovered === 1, `recovered=${recovered}`);
}

// =============================================================
// S4: fast bursts (within the wall-clock window) unchanged
// =============================================================
{
	await freshSession("worker-fast");
	await strike();
	await attemptStart();
	await strike(); // ~0s apart: window path, same accumulation
	ok("S4: fast second strike still exhausts and swaps", setModelCalls.length === 1, `calls=${setModelCalls.length}`);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
Date.now = realNow;
process.chdir("/");
await rm(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
