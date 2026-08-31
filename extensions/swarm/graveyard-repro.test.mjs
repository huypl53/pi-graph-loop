// Issue 82 — graveyard-repro test (R9 a3 shape): seeds 177 stopped agents with old lastShutdownAt
// + a small set of still-running workers + a fresh task that closes, then asserts that after one
// `agentHeartbeatGCLocked` tick + sweep pass, the graveyard agents are flagged stopped and the
// running workers (with leases) survive. Validates the headline AC: "R9 a3 graveyard shape
// (177 stopped agents) becomes reproducible + fixed in a lane".
//
// Pattern: real factory + real swarm-state mutations. Direct invocation of agentHeartbeatGCLocked
// (no live pump tick needed for determinism). Asserts on durable state + traces.

import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const factory = (await import(join(here, "index.ts"))).default;
const { agentHeartbeatGCLocked } = await import(join(here, "src/reconcile.ts"));
const { sweepTaskWorkersLocked } = await import(join(here, "src/taskgraph.ts"));
const { paths, withLock, readState, writeState } = await import(join(here, "src/state.ts"));

let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) { pass++; console.log("  ok  ", name); } else { fail++; console.error("  FAIL", name, info ?? ""); } };

const scratch = await mkdtemp(join(tmpdir(), `swarm-graveyard-${process.pid}-${Date.now()}`));
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

function makePiMock() {
	const pi = {
		registerTool: (def) => {},
		registerCommand: (name, def) => {},
		on: (ev, fn) => {},
		setModel: async () => true,
		sendMessage: (m, o) => {},
		exec: async (cmd, args) => {
			if (cmd === "tmux" && args[0] === "kill-window") return { code: 0, stdout: "", stderr: "" };
			if (cmd === "tmux" && args[0] === "list-panes") return { code: 0, stdout: "1\n", stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		},
	};
	return { pi };
}

// =============================================================================
// CASE G1: 177 stopped agents + 1 orchestrator + 3 running with leases →
//          heartbeat GC + sweep keeps the lease-honored running set; stopped set is unchanged.
// =============================================================================
console.log("\n[G1] 177-stopped-agents graveyard: heartbeat GC + sweep preserves leases, doesn't disturb stopped records");
{
	await clearEvents();
	const now = Date.now();
	const oldShutdown = new Date(now - 7_200_000).toISOString(); // 2 hours ago

	const agents = { orchestrator: makeAgent("orchestrator", { tmuxTarget: "s:orchestrator.0" }) };
	// Seed 177 stopped agents with old lastShutdownAt — the R9 a3 graveyard shape.
	for (let i = 0; i < 177; i++) {
		agents[`graveyard-${i}`] = makeAgent(`graveyard-${i}`, {
			status: "stopped", runtimeStatus: "stopped", health: "unhealthy",
			lastShutdownAt: oldShutdown,
			tmuxAlive: false,
		});
	}
	// 3 running workers with valid reuse leases — should survive the GC.
	for (let i = 0; i < 3; i++) {
		agents[`leased-${i}`] = makeAgent(`leased-${i}`, {
			status: "running", runtimeStatus: "idle", tmuxAlive: true,
			leaseKind: "reuse", leaseUntil: new Date(now + 3_600_000).toISOString(),
			leaseReason: "reuse across tasks",
			tmuxTarget: `s:leased-${i}.0`,
		});
	}
	const state = {
		version: 1, swarmId: "test", cwd: scratch, tmuxSession: "s",
		agents, delivered: {}, messages: {},
		createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
	};
	await writeStateFile(state);

	const { pi } = makePiMock();
	const path = paths(scratch);
	// Run GC: it should NOT flip the 177 stopped records (they're already stopped).
	// It should NOT touch the 3 leased agents (leaseValid=true).
	const gcResult = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await agentHeartbeatGCLocked(pi, scratch, path, st, now);
		await writeState(path, st);
		return out;
	});

	ok("G1 GC.stopped === 0 (graveyard records already stopped)", gcResult.stopped === 0, JSON.stringify(gcResult));
	ok("G1 GC.stale === 0 (all leased records are fresh-lease, not stale)", gcResult.stale === 0);

	const finalState = await readStateFile();
	// 177 stopped records preserved with their lastShutdownAt stamp (the GC does not delete them
	// from state.agents; that is swarm_prune's job).
	const stoppedCount = Object.values(finalState.agents).filter((a) => a.status === "stopped").length;
	ok("G1 graveyard stopped count preserved (177)", stoppedCount === 177, `got ${stoppedCount}`);
	// 3 leased agents still running
	const leasedAlive = Object.values(finalState.agents).filter((a) => a.id?.startsWith("leased-") && a.status === "running").length;
	ok("G1 leased running count preserved (3)", leasedAlive === 3, `got ${leasedAlive}`);
	const leaseKindAlive = Object.values(finalState.agents).filter((a) => a.leaseKind === "reuse" && a.status === "running").length;
	ok("G1 leaseKind=reuse running count (3)", leaseKindAlive === 3, `got ${leaseKindAlive}`);

	const events = await readEvents();
	ok("G1 no heartbeat_gc traces (no dead-pane running records)", !events.some((e) => e.event?.startsWith?.("agent.heartbeat_gc")));
}

// =============================================================================
// CASE G2: the bounded-set property — after GC + sweep, the on-disk shape is bounded
//          (orchestrator + lease-honored running workers only).
// =============================================================================
console.log("\n[G2] bounded-set property: GC + sweep keeps state.agents small (orchestrator + lease-valid only)");
{
	await clearEvents();
	const now = Date.now();
	const agents = { orchestrator: makeAgent("orchestrator", { tmuxTarget: "s:orchestrator.0" }) };
	// Seed some freshly-stopped agents that the GC would otherwise not flip (already stopped).
	// Plus some dead-pane agents the GC WILL flip.
	for (let i = 0; i < 50; i++) {
		agents[`stopped-${i}`] = makeAgent(`stopped-${i}`, {
			status: "stopped", runtimeStatus: "stopped", health: "unhealthy",
			lastShutdownAt: new Date(now - 3_600_000).toISOString(),
		});
	}
	for (let i = 0; i < 10; i++) {
		agents[`deadpane-${i}`] = makeAgent(`deadpane-${i}`, {
			status: "running", runtimeStatus: "idle", tmuxAlive: false,
			lastHeartbeatAt: new Date(now - 3_600_000).toISOString(), // stale enough for the cheap gate
			tmuxTarget: `s:deadpane-${i}.0`,
		});
	}
	for (let i = 0; i < 2; i++) {
		agents[`leased-${i}`] = makeAgent(`leased-${i}`, {
			status: "running", runtimeStatus: "idle", tmuxAlive: true,
			leaseKind: "reuse", leaseUntil: new Date(now + 3_600_000).toISOString(),
			leaseReason: "reuse",
			tmuxTarget: `s:leased-${i}.0`,
		});
	}
	const state = {
		version: 1, swarmId: "test", cwd: scratch, tmuxSession: "s",
		agents, delivered: {}, messages: {},
		createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
	};
	await writeStateFile(state);

	const { pi } = makePiMock();
	const path = paths(scratch);
	const gcResult = await withLock(path, async () => {
		const st = await readState(path, scratch);
		const out = await agentHeartbeatGCLocked(pi, scratch, path, st, now);
		await writeState(path, st);
		return out;
	});

	ok("G2 GC flipped all 10 dead-pane running records to stopped", gcResult.stopped === 10, JSON.stringify(gcResult));
	const finalState = await readStateFile();
	const stoppedCount = Object.values(finalState.agents).filter((a) => a.status === "stopped").length;
	ok("G2 stopped count === 60 (50 pre-existing + 10 newly-flipped)", stoppedCount === 60, `got ${stoppedCount}`);
	const leasedAlive = Object.values(finalState.agents).filter((a) => a.id?.startsWith("leased-") && a.status === "running").length;
	ok("G2 leased running count preserved (2)", leasedAlive === 2);
	const events = await readEvents();
	const flippedTraces = events.filter((e) => e.event === "agent.heartbeat_gc.stopped" && e.reason === "tmux_dead");
	ok("G2 10 heartbeat_gc.stopped traces emitted", flippedTraces.length === 10, `got ${flippedTraces.length}`);
}

console.log(`\nGRAVEYARD-REPRO ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
