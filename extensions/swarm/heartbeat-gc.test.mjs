// Issue 82 — heartbeat-driven agent GC (P0, R9 a3 graveyard) unit test.
//
// Invariants under test (all 8 cases from plan §"Unit tests" → "heartbeat-gc.test.mjs"):
//   1. Dead pane + running record → flipped to stopped with reason:"tmux_dead" trace
//   2. Stale heartbeat + idle record → health flipped to "stale" (status unchanged)
//   3. Stale heartbeat + busy record → untouched (no trace, no mutation)
//   4. Lease-valid (reuse) agent → untouched even when stale (no trace)
//   5. Lease-valid (park) agent → untouched in heartbeat GC (park is sweep's job)
//   6. Orchestrator pseudo-agent → skipped
//   7. Paused agent → skipped (paused is dormant by design)
//   8. Probe-after-probe: cached tmuxAlive=true + heartbeat past 2× stale window →
//      GC issues a tmux probe; if probe returns false → flipped to stopped +
//      reason:"tmux_dead_after_probe" + tmux_liveness_correction trace
//   9. Idempotent re-tick: running the GC twice in a row produces no extra mutations
//
// Pattern: real factory + captured `pi.exec("tmux", ...)` mock returning canned liveness.
// Asserts on durable state (state.agents mutations) + events.jsonl traces. No internal-return
// mocks (per Re-C2 caveat).

import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "index.ts"));
const recon = await import(join(here, "src/reconcile.ts"));
const factory = mod.default;
const agentHeartbeatGCLocked = recon.agentHeartbeatGCLocked;

let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) { pass++; console.log("  ok  ", name); } else { fail++; console.error("  FAIL", name, info ?? ""); } };

// --- scratch fixture helpers ---
const scratch = await mkdtemp(join(tmpdir(), `swarm-hbgc-${process.pid}-${Date.now()}`));
await mkdir(join(scratch, ".pi", "swarm"), { recursive: true });

async function writeStateFile(state) {
	await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(state, null, 2));
}
async function readStateFile() {
	return JSON.parse(await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
}
async function readEvents() {
	const txt = await readFile(join(scratch, ".pi/swarm/traces/events.jsonl"), "utf8").catch(() => "");
	return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
async function clearEvents() {
	await mkdir(join(scratch, ".pi/swarm/traces"), { recursive: true });
	await writeFile(join(scratch, ".pi/swarm/traces/events.jsonl"), "");
}

// --- pi mock: tmux probe returns canned liveness per target ---
function makePiMock({ tmuxAlive = new Map() } = {}) {
	const execCalls = [];
	const handlers = {};
	const pi = {
		registerTool: (def) => {},
		registerCommand: (name, def) => {},
		on: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
		setModel: async () => true,
		sendMessage: (m, o) => {},
		exec: async (cmd, args) => {
			execCalls.push({ cmd, args });
			if (cmd === "tmux" && args[0] === "list-panes") {
				const target = args.find((a, i) => a === "-t") ? args[args.indexOf("-t") + 1] : null;
				const alive = tmuxAlive.get(target) ?? false;
				return { code: 0, stdout: alive ? "1\n" : "0\n", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	return { pi, execCalls, tmuxAlive, handlers };
}

// --- agent record factory ---
function makeAgent(id, overrides = {}) {
	const now = new Date().toISOString();
	return {
		id, role: "worker", roleKind: "worker", capabilities: [],
		activeTaskIds: [], maxConcurrentTasks: 1,
		status: "running", runtimeStatus: "idle", health: "healthy",
		lastHeartbeatAt: now, lastSessionStartAt: now, lastAgentStartAt: now,
		pid: 1000,
		tmuxSession: "s", tmuxWindow: id, tmuxTarget: `s:${id}.0`,
		model: "m", provider: "p", cwd: scratch,
		mailbox: `.pi/swarm/mailboxes/${id}.jsonl`,
		createdAt: now, updatedAt: now,
		...overrides,
	};
}

function makeState(agents) {
	const now = new Date().toISOString();
	return {
		version: 1, swarmId: "test", cwd: scratch, tmuxSession: "s",
		agents, delivered: {}, messages: {},
		createdAt: now, updatedAt: now,
	};
}

// --- run GC under test (uses the real factory for `paths`/`writeState`/`trace`) ---
async function runGC(st, nowMs, pi, probeTargets) {
	process.env.PI_SWARM_AGENT_ID = "orchestrator"; // make trace events route correctly
	// Use real `withLock` + `paths` from state.ts; just inject the mock pi via the factory
	factory(pi);
	const pathsMod = await import(join(here, "src/state.ts"));
	const path = pathsMod.paths(scratch);
	const lockPath = path.lock;
	const result = await pathsMod.withLock(path, async () => {
		const stIn = await pathsMod.readState(path, scratch);
		return await agentHeartbeatGCLocked(pi, scratch, path, stIn, nowMs);
	});
	// Read back state after GC mutation
	return { result, finalState: await readStateFile() };
}

// =============================================================================
// CASE 1: dead pane + running record → flipped to stopped
// =============================================================================
console.log("\n[C1] dead pane + running record → status=stopped, reason='tmux_dead'");
{
	await clearEvents();
	const now = Date.now();
	const nowIso = new Date(now).toISOString();
	const state = makeState({
		orchestrator: makeAgent("orchestrator", { status: "running", runtimeStatus: "idle", tmuxTarget: "s:orchestrator.0" }),
		"worker-a": makeAgent("worker-a", { status: "running", runtimeStatus: "idle", tmuxAlive: false, lastHeartbeatAt: nowIso }),
	});
	await writeStateFile(state);
	const { pi } = makePiMock();
	const { result, finalState } = await runGC(state, now, pi);
	ok("C1 result.stopped === 1", result.stopped === 1, JSON.stringify(result));
	ok("C1 worker-a.status === 'stopped'", finalState.agents["worker-a"].status === "stopped", finalState.agents["worker-a"].status);
	ok("C1 worker-a.runtimeStatus === 'stopped'", finalState.agents["worker-a"].runtimeStatus === "stopped");
	ok("C1 worker-a.health === 'unhealthy'", finalState.agents["worker-a"].health === "unhealthy");
	ok("C1 worker-a.lastShutdownAt populated", !!finalState.agents["worker-a"].lastShutdownAt);
	const events = await readEvents();
	const trace = events.find((e) => e.event === "agent.heartbeat_gc.stopped" && e.agentId === "worker-a");
	ok("C1 trace emitted", !!trace, JSON.stringify(events.map((e) => e.event)));
	ok("C1 trace.reason === 'tmux_dead'", trace?.reason === "tmux_dead");
	ok("C1 orchestrator untouched", finalState.agents["orchestrator"].status === "running");
}

// =============================================================================
// CASE 2: stale heartbeat + idle record → health='stale', status unchanged
// =============================================================================
console.log("\n[C2] stale heartbeat + idle → health='stale' (downgrade; status preserved)");
{
	await clearEvents();
	const now = Date.now();
	const staleIso = new Date(now - (700_000)).toISOString(); // 700s ago (> 600s stale window)
	const state = makeState({
		orchestrator: makeAgent("orchestrator", { status: "running", tmuxAlive: true, lastHeartbeatAt: new Date(now).toISOString() }),
		"worker-b": makeAgent("worker-b", { status: "running", runtimeStatus: "idle", health: "healthy", tmuxAlive: true, lastHeartbeatAt: staleIso, tmuxTarget: "s:worker-b.0" }),
	});
	await writeStateFile(state);
	// tmux probe for worker-b returns true (so gate 2 passes without flipping stopped)
	const { pi, tmuxAlive } = makePiMock({ tmuxAlive: new Map([["s:worker-b.0", true]]) });
	const { result, finalState } = await runGC(state, now, pi);
	ok("C2 result.stale === 1", result.stale === 1, JSON.stringify(result));
	ok("C2 result.stopped === 0", result.stopped === 0);
	ok("C2 worker-b.health === 'stale'", finalState.agents["worker-b"].health === "stale");
	ok("C2 worker-b.status === 'running' (unchanged)", finalState.agents["worker-b"].status === "running");
	const events = await readEvents();
	const trace = events.find((e) => e.event === "agent.heartbeat_gc.stale" && e.agentId === "worker-b");
	ok("C2 stale trace emitted", !!trace, JSON.stringify(events.map((e) => e.event)));
	ok("C2 trace.hbAgeMs > 600000", typeof trace?.hbAgeMs === "number" && trace.hbAgeMs > 600_000, `hbAgeMs=${trace?.hbAgeMs}`);
}

// =============================================================================
// CASE 3: stale heartbeat + busy record → untouched (no mutation, no trace)
// =============================================================================
console.log("\n[C3] stale heartbeat + busy record → untouched");
{
	await clearEvents();
	const now = Date.now();
	const staleIso = new Date(now - (700_000)).toISOString();
	const state = makeState({
		orchestrator: makeAgent("orchestrator", { tmuxAlive: true, lastHeartbeatAt: new Date(now).toISOString() }),
		"worker-c": makeAgent("worker-c", { status: "running", runtimeStatus: "busy", tmuxAlive: true, lastHeartbeatAt: staleIso, tmuxTarget: "s:worker-c.0" }),
	});
	await writeStateFile(state);
	const { pi } = makePiMock({ tmuxAlive: new Map([["s:worker-c.0", true]]) });
	const { result, finalState } = await runGC(state, now, pi);
	ok("C3 result.stopped === 0", result.stopped === 0);
	ok("C3 result.stale === 0", result.stale === 0);
	ok("C3 worker-c.health unchanged ('healthy')", finalState.agents["worker-c"].health === "healthy");
	ok("C3 worker-c.runtimeStatus unchanged ('busy')", finalState.agents["worker-c"].runtimeStatus === "busy");
	const events = await readEvents();
	ok("C3 no heartbeat_gc.* traces", !events.some((e) => e.event === "agent.heartbeat_gc.stopped" || e.event === "agent.heartbeat_gc.stale"));
}

// =============================================================================
// CASE 4: lease-valid (reuse) agent → untouched
// =============================================================================
console.log("\n[C4] lease-valid reuse agent → untouched");
{
	await clearEvents();
	const now = Date.now();
	const staleIso = new Date(now - (700_000)).toISOString();
	const state = makeState({
		orchestrator: makeAgent("orchestrator", { tmuxAlive: true, lastHeartbeatAt: new Date(now).toISOString() }),
		"worker-d": makeAgent("worker-d", {
			status: "running", runtimeStatus: "idle", tmuxAlive: false, lastHeartbeatAt: staleIso, // would otherwise be flagged stopped
			leaseKind: "reuse", leaseUntil: new Date(now + 3_600_000).toISOString(), leaseReason: "test",
			tmuxTarget: "s:worker-d.0",
		}),
	});
	await writeStateFile(state);
	const { pi } = makePiMock();
	const { result, finalState } = await runGC(state, now, pi);
	ok("C4 result.stopped === 0", result.stopped === 0);
	ok("C4 result.stale === 0", result.stale === 0);
	ok("C4 worker-d.status unchanged ('running')", finalState.agents["worker-d"].status === "running");
	ok("C4 worker-d.leaseKind preserved", finalState.agents["worker-d"].leaseKind === "reuse");
	const events = await readEvents();
	ok("C4 no heartbeat_gc traces", !events.some((e) => e.event?.startsWith?.("agent.heartbeat_gc")));
}

// =============================================================================
// CASE 5: lease-valid (park) agent → untouched in heartbeat GC
// =============================================================================
console.log("\n[C5] lease-valid park agent → untouched in heartbeat GC (park is sweep's job)");
{
	await clearEvents();
	const now = Date.now();
	const staleIso = new Date(now - (700_000)).toISOString();
	const state = makeState({
		orchestrator: makeAgent("orchestrator", { tmuxAlive: true, lastHeartbeatAt: new Date(now).toISOString() }),
		"worker-e": makeAgent("worker-e", {
			status: "running", runtimeStatus: "idle", tmuxAlive: false, lastHeartbeatAt: staleIso,
			leaseKind: "park", leaseUntil: new Date(now + 3_600_000).toISOString(), leaseReason: "test",
			tmuxTarget: "s:worker-e.0",
		}),
	});
	await writeStateFile(state);
	const { pi } = makePiMock();
	const { result, finalState } = await runGC(state, now, pi);
	ok("C5 result.stopped === 0", result.stopped === 0);
	ok("C5 worker-e.status unchanged", finalState.agents["worker-e"].status === "running");
	ok("C5 worker-e.leaseKind='park'", finalState.agents["worker-e"].leaseKind === "park");
}

// =============================================================================
// CASE 6: orchestrator pseudo-agent → skipped
// =============================================================================
console.log("\n[C6] orchestrator pseudo-agent → skipped");
{
	await clearEvents();
	const now = Date.now();
	const staleIso = new Date(now - (700_000)).toISOString();
	const state = makeState({
		orchestrator: makeAgent("orchestrator", { status: "running", tmuxAlive: false, lastHeartbeatAt: staleIso }),
	});
	await writeStateFile(state);
	const { pi } = makePiMock();
	const { result, finalState } = await runGC(state, now, pi);
	ok("C6 orchestrator.status unchanged ('running')", finalState.agents["orchestrator"].status === "running");
	ok("C6 no traces fired for orchestrator", !(await readEvents()).some((e) => e.agentId === "orchestrator" && e.event?.startsWith?.("agent.heartbeat_gc")));
}

// =============================================================================
// CASE 7: paused agent → skipped
// =============================================================================
console.log("\n[C7] paused agent → skipped");
{
	await clearEvents();
	const now = Date.now();
	const staleIso = new Date(now - (700_000)).toISOString();
	const state = makeState({
		orchestrator: makeAgent("orchestrator", { tmuxAlive: true, lastHeartbeatAt: new Date(now).toISOString() }),
		"worker-g": makeAgent("worker-g", {
			paused: true, status: "running", runtimeStatus: "idle", tmuxAlive: false, lastHeartbeatAt: staleIso,
			tmuxTarget: "s:worker-g.0",
		}),
	});
	await writeStateFile(state);
	const { pi } = makePiMock();
	const { result, finalState } = await runGC(state, now, pi);
	ok("C7 worker-g.status unchanged", finalState.agents["worker-g"].status === "running");
	ok("C7 worker-g.paused preserved", finalState.agents["worker-g"].paused === true);
	ok("C7 no heartbeat_gc traces for paused", !(await readEvents()).some((e) => e.agentId === "worker-g" && e.event?.startsWith?.("agent.heartbeat_gc")));
}

// =============================================================================
// CASE 8: probe-after-probe → flipped stopped on probe disagreement
// =============================================================================
console.log("\n[C8] probe-after-probe: cached tmuxAlive=true + heartbeat past 2× stale window → probe returns false → stopped");
{
	await clearEvents();
	const now = Date.now();
	const veryStaleIso = new Date(now - (1_300_000)).toISOString(); // 1300s ago (> 2× 600s)
	const state = makeState({
		orchestrator: makeAgent("orchestrator", { tmuxAlive: true, lastHeartbeatAt: new Date(now).toISOString() }),
		"worker-h": makeAgent("worker-h", { status: "running", runtimeStatus: "idle", tmuxAlive: true, lastHeartbeatAt: veryStaleIso, tmuxTarget: "s:worker-h.0" }),
	});
	await writeStateFile(state);
	// probe returns FALSE — disagreement with cached true
	const { pi } = makePiMock({ tmuxAlive: new Map([["s:worker-h.0", false]]) });
	const { result, finalState } = await runGC(state, now, pi);
	ok("C8 result.stopped === 1", result.stopped === 1);
	ok("C8 result.corrected === 1 (probe disagreed with cached)", result.corrected === 1);
	ok("C8 worker-h.status === 'stopped'", finalState.agents["worker-h"].status === "stopped");
	ok("C8 worker-h.tmuxAlive === false (field corrected)", finalState.agents["worker-h"].tmuxAlive === false);
	const events = await readEvents();
	const correction = events.find((e) => e.event === "agent.tmux_liveness_correction" && e.agentId === "worker-h");
	ok("C8 tmux_liveness_correction trace emitted", !!correction);
	ok("C8 correction.alive === false", correction?.alive === false);
	ok("C8 correction.previous === true", correction?.previous === true);
	const stopped = events.find((e) => e.event === "agent.heartbeat_gc.stopped" && e.agentId === "worker-h");
	ok("C8 heartbeat_gc.stopped trace emitted with reason='tmux_dead_after_probe'", stopped?.reason === "tmux_dead_after_probe");
}

// =============================================================================
// CASE 9: idempotent re-tick → no extra mutations on second pass
// =============================================================================
console.log("\n[C9] idempotent re-tick: second pass produces no extra mutations");
{
	await clearEvents();
	const now = Date.now();
	const staleIso = new Date(now - (700_000)).toISOString();
	const state = makeState({
		orchestrator: makeAgent("orchestrator", { tmuxAlive: true, lastHeartbeatAt: new Date(now).toISOString() }),
		"worker-i": makeAgent("worker-i", { status: "running", runtimeStatus: "idle", tmuxAlive: false, lastHeartbeatAt: staleIso }),
	});
	await writeStateFile(state);
	const { pi } = makePiMock();
	const r1 = await runGC(state, now, pi);
	ok("C9 first tick stopped=1", r1.result.stopped === 1);
	const eventsAfter1 = await readEvents();
	const r2 = await runGC(state, now, pi);
	const eventsAfter2 = await readEvents();
	ok("C9 second tick stopped=0 (already stopped)", r2.result.stopped === 0);
	ok("C9 second tick stale=0", r2.result.stale === 0);
	const stoppedTraces = eventsAfter2.filter((e) => e.event === "agent.heartbeat_gc.stopped" && e.agentId === "worker-i");
	ok("C9 exactly ONE heartbeat_gc.stopped trace for worker-i (idempotent)", stoppedTraces.length === 1, `got ${stoppedTraces.length}`);
}

// =============================================================================
// CASE 10 (review item 1): probe-guarded — a stopped agent with stale heartbeat + tmuxTarget
// is NOT probed on subsequent ticks (the graveyard-shape livelock fix).
// =============================================================================
console.log("\n[C10] review-item-1: stopped agent with stale heartbeat + tmuxTarget NOT probed on later ticks (graveyard livelock guard)");
{
	await clearEvents();
	const now = Date.now();
	const staleIso = new Date(now - 1_800_000).toISOString(); // 30 min ago, well past 2× 10min window
	let tmuxProbeCount = 0;
	const makePiMockCounted = () => {
		const original = makePiMock();
		const wrapped = { ...original };
		const piMock = { ...wrapped.pi };
		piMock.exec = async (cmd, args) => {
			if (cmd === "tmux" && args[0] === "list-panes") {
				tmuxProbeCount++;
				return { code: 0, stdout: "1\n", stderr: "" };
			}
			return wrapped.pi.exec(cmd, args);
		};
		return { ...wrapped, pi: piMock };
	};
	const state = makeState({
		orchestrator: makeAgent("orchestrator", { tmuxAlive: true, lastHeartbeatAt: new Date(now).toISOString() }),
		"graveyard-z": makeAgent("graveyard-z", {
			status: "stopped", // already stopped — the post-fix code must NOT probe this
			runtimeStatus: "stopped", tmuxAlive: false,
			lastHeartbeatAt: staleIso,
			lastShutdownAt: new Date(now - 7_200_000).toISOString(),
			tmuxTarget: "s:graveyard-z.0",
		}),
	});
	await writeStateFile(state);
	const { pi } = makePiMockCounted();
	// Run 5 ticks; the pre-fix code would probe "graveyard-z" on EVERY tick (5 probes total).
	const { result, finalState } = await runGC(state, now, pi);
	ok("C10 first tick stopped=0 (already stopped)", result.stopped === 0);
	ok("C10 first tick probesFired=0 (status!=='running' guard)", result.probesFired === 0, `probesFired=${result.probesFired}`);
	ok("C10 first tick probesThrottled=0 (gate 2 never entered)", result.probesThrottled === 0);
	ok("C10 ZERO tmux probes fired across the entire test (counted by exec mock)", tmuxProbeCount === 0, `got ${tmuxProbeCount}`);
	const events = await readEvents();
	ok("C10 zero heartbeat_gc.stopped traces", !events.some((e) => e.event === "agent.heartbeat_gc.stopped"));
	ok("C10 zero heartbeat_gc.probe_throttled traces (gate 2 not entered)", !events.some((e) => e.event === "agent.heartbeat_gc.probe_throttled"));
	ok("C10 graveyard-z.status preserved", finalState.agents["graveyard-z"].status === "stopped");
}

// =============================================================================
// CASE 11 (review item 1): probe-ledger — a running agent whose probe ledger is younger than
// probeAfterMs is NOT re-probed (the second-tick throttle).
// =============================================================================
console.log("\n[C11] review-item-1: running agent with fresh lastProbeAt is throttled (second tick skips probe)");
{
	await clearEvents();
	const now = Date.now();
	const staleIso = new Date(now - 1_800_000).toISOString();
	let tmuxProbeCount = 0;
	const makePiMockCounted = () => {
		const original = makePiMock();
		const wrapped = { ...original };
		const piMock = { ...wrapped.pi };
		piMock.exec = async (cmd, args) => {
			if (cmd === "tmux" && args[0] === "list-panes") {
				tmuxProbeCount++;
				return { code: 0, stdout: "1\n", stderr: "" }; // probe says alive — no flip
			}
			return wrapped.pi.exec(cmd, args);
		};
		return { ...wrapped, pi: piMock };
	};
	const state = makeState({
		orchestrator: makeAgent("orchestrator", { tmuxAlive: true, lastHeartbeatAt: new Date(now).toISOString() }),
		"worker-j": makeAgent("worker-j", {
			status: "running", runtimeStatus: "idle", tmuxAlive: true,
			lastHeartbeatAt: staleIso,
			lastProbeAt: new Date(now - 60_000).toISOString(), // probed 60s ago — well within probeAfterMs (20min default)
			tmuxTarget: "s:worker-j.0",
		}),
	});
	await writeStateFile(state);
	const { pi } = makePiMockCounted();
	const r = await runGC(state, now, pi);
	ok("C11 first tick probesFired=0 (ledger blocks probe)", r.result.probesFired === 0, `probesFired=${r.result.probesFired}`);
	ok("C11 first tick probesThrottled=1 (ledger skip trace)", r.result.probesThrottled === 1);
	ok("C11 first tick ZERO tmux probes fired (counted)", tmuxProbeCount === 0, `got ${tmuxProbeCount}`);
	const events = await readEvents();
	const throttleTraces = events.filter((e) => e.event === "agent.heartbeat_gc.probe_throttled");
	ok("C11 exactly ONE probe_throttled trace for worker-j", throttleTraces.length === 1);
	ok("C11 throttle trace payload: lastProbeAtMs populated", typeof throttleTraces[0]?.lastProbeAtMs === "number");
	ok("C11 worker-j.lastProbeAt UNCHANGED (no probe fired)", r.finalState.agents["worker-j"].lastProbeAt === new Date(now - 60_000).toISOString());
}

// =============================================================================
// CASE 12 (review item 3): paused agent with EXPIRED park lease + dead pane → flipped to
// stopped (the zombie-reclamation fix). Without this fix, an expired-park agent whose pane
// died post-expiry would stay status:running forever.
// =============================================================================
console.log("\n[C12] review-item-3: paused agent with expired-park lease + dead pane → flipped to stopped");
{
	await clearEvents();
	const now = Date.now();
	const staleIso = new Date(now - 1_800_000).toISOString();
	const expiredIso = new Date(now - 60_000).toISOString(); // expired 60s ago
	const state = makeState({
		orchestrator: makeAgent("orchestrator", { tmuxAlive: true, lastHeartbeatAt: new Date(now).toISOString() }),
		"zombie-k": makeAgent("zombie-k", {
			status: "running", runtimeStatus: "idle", tmuxAlive: false, lastHeartbeatAt: staleIso,
			paused: true, // paused — would normally be skipped
			leaseKind: "park", leaseUntil: expiredIso, leaseReason: "test expired",
			tmuxTarget: "s:zombie-k.0",
		}),
	});
	await writeStateFile(state);
	const { pi } = makePiMock();
	const r = await runGC(state, now, pi);
	ok("C12 result.stopped === 1 (expired-park zombie flipped)", r.result.stopped === 1);
	ok("C12 result.expiredParkFlipped === 1", r.result.expiredParkFlipped === 1);
	ok("C12 zombie-k.status === 'stopped'", r.finalState.agents["zombie-k"].status === "stopped");
	ok("C12 zombie-k.health === 'unhealthy'", r.finalState.agents["zombie-k"].health === "unhealthy");
	ok("C12 zombie-k.lastShutdownAt populated", !!r.finalState.agents["zombie-k"].lastShutdownAt);
	const events = await readEvents();
	const flippedTraces = events.filter((e) => e.event === "agent.heartbeat_gc.expired_park_flipped" && e.agentId === "zombie-k");
	ok("C12 expired_park_flipped trace emitted", flippedTraces.length === 1);
	ok("C12 flipped trace payload: reason='tmux_dead_after_lease_expiry'", flippedTraces[0]?.reason === "tmux_dead_after_lease_expiry");
}

// =============================================================================
// CASE 13 (review item 3 inverse): paused agent with VALID park lease + dead pane → NOT flipped
// (valid lease still wins; preserves the operator's intentional dormant hold).
// =============================================================================
console.log("\n[C13] review-item-3 inverse: paused agent with VALID park lease + dead pane → still skipped");
{
	await clearEvents();
	const now = Date.now();
	const staleIso = new Date(now - 1_800_000).toISOString();
	const state = makeState({
		orchestrator: makeAgent("orchestrator", { tmuxAlive: true, lastHeartbeatAt: new Date(now).toISOString() }),
		"valid-l": makeAgent("valid-l", {
			status: "running", runtimeStatus: "idle", tmuxAlive: false, lastHeartbeatAt: staleIso,
			paused: true,
			leaseKind: "park", leaseUntil: new Date(now + 3_600_000).toISOString(), leaseReason: "test valid",
			tmuxTarget: "s:valid-l.0",
		}),
	});
	await writeStateFile(state);
	const { pi } = makePiMock();
	const r = await runGC(state, now, pi);
	ok("C13 result.stopped === 0 (valid lease still wins)", r.result.stopped === 0);
	ok("C13 result.expiredParkFlipped === 0", r.result.expiredParkFlipped === 0);
	ok("C13 valid-l.status === 'running' (unchanged)", r.finalState.agents["valid-l"].status === "running");
}

console.log(`\nHEARTBEAT-GC ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
