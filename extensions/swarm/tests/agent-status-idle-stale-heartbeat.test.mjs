#!/usr/bin/env node
/**
 * agent-status-idle-stale-heartbeat.test.mjs — dead false-positive for IDLE agents with
 * pane-alive evidence (task-202610040400-idle-dead-pane-alive, red-first; plan §4)
 *
 * RED: deriveTaskProgressState step (1) returns dead on heartbeat >60s stale for every
 * non-busy|tool_running runtimeStatus. Live incident 2026-10-04 02:45 UTC (idle-death-probe):
 * an idle agent whose ONLY anomaly is a heartbeat older than DEAD_HEARTBEAT_MS (60s) showed
 * taskProgressState="dead" with paneAlive=true, runtimeStatus="idle", health="healthy" in the
 * same row. Heartbeats stamp at tool-call boundaries and settle (hooks/tools.ts, hooks/
 * settled.ts) — an idle agent waiting between assignments (the normal posture, including
 * root) fires none, so it reads stale-hb while the live tmux probe proves the pane lives.
 *
 * Contract (plan §3, approved by root): POSITIVE pane-alive evidence (probed true, not
 * default-true-when-unknown) on a status:"running" record outranks heartbeat staleness in
 * the dead gate. Deferred agents flow through the existing pipeline (awaiting_input /
 * stalled / idle_blocked) — NO new state (plan §2, Option A). Pane-dead stays dead
 * unconditionally; absence of pane evidence is NOT life; stopped records stay dead.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let deriveTaskProgressState = null;
try {
	const mod = await import(join(here, "..", "src", "agents.ts"));
	deriveTaskProgressState = mod.deriveTaskProgressState;
} catch (e) {
	deriveTaskProgressState = null;
}

let passed = 0,
	failed = 0;
const ok = (n, c, info) => {
	if (c) {
		passed++;
		console.log("  ok  ", n);
	} else {
		failed++;
		console.error("  FAIL:", n, info ?? "");
	}
};

function makeAgent(overrides = {}) {
	const nowIso = new Date().toISOString();
	return {
		id: "agent-x",
		role: "implementer",
		roleKind: "worker",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxSession: "sess",
		tmuxWindow: "agent-x",
		tmuxTarget: "sess:agent-x.0",
		model: "m",
		provider: "p",
		cwd: "/tmp",
		mailbox: ".pi/swarm/mailboxes/agent-x.jsonl",
		lastHeartbeatAt: nowIso,
		lastToolAt: nowIso,
		createdAt: nowIso,
		updatedAt: nowIso,
		...overrides,
	};
}

function makeState(agent, extras = {}) {
	return {
		version: 1,
		swarmId: "swarm-x",
		cwd: "/tmp",
		tmuxSession: "sess",
		agents: {
			"agent-x": agent,
			root: { id: "root", runtimeStatus: "idle", status: "running", health: "healthy", lastHeartbeatAt: new Date().toISOString() },
		},
		delivered: {},
		messages: {},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...extras,
	};
}

const run = (agent, ctx = {}) =>
	typeof deriveTaskProgressState === "function"
		? deriveTaskProgressState(agent, makeState(agent), { nowMs: Date.now(), ...ctx })
		: "MISSING_HELPER";

console.log("=== idle stale-heartbeat dead false-positive (I) ===");

// ----- I1: the live incident shape (idle-death-probe 2026-10-04 02:45 UTC) -----
{
	const agent = makeAgent({
		runtimeStatus: "idle",
		lastHeartbeatAt: new Date(Date.now() - 90_000).toISOString(), // 90s stale
		lastToolAt: new Date(Date.now() - 90_000).toISOString(), // settled 90s ago
	});
	ok(
		"I1 incident: idle + pane alive (probe) + hb 90s stale → awaiting_input (not dead)",
		run(agent, { tmuxAlive: true }) === "awaiting_input",
		`got=${run(agent, { tmuxAlive: true })}`,
	);
}
// ----- I2: root-shaped (root idles >60s between turns constantly) -----
{
	const agent = makeAgent({
		id: "root",
		lastHeartbeatAt: new Date(Date.now() - 5 * 60_000).toISOString(), // 5min stale
		lastToolAt: new Date(Date.now() - 5 * 60_000).toISOString(),
	});
	ok(
		"I2: idle + pane alive + hb 5min stale → awaiting_input (not dead)",
		run(agent, { tmuxAlive: true }) === "awaiting_input",
		`got=${run(agent, { tmuxAlive: true })}`,
	);
}
// ----- I3: the defer falls through to the honest existing pipeline -----
{
	const agent = makeAgent({
		activeTaskIds: ["task-1"],
		lastHeartbeatAt: new Date(Date.now() - 90_000).toISOString(),
		lastToolAt: new Date(Date.now() - 11 * 60_000).toISOString(), // 11min since last tool
	});
	ok(
		"I3a: idle + pane alive + stale hb + activeTask + lastToolAt 11min → stalled",
		run(agent, { tmuxAlive: true }) === "stalled",
		`got=${run(agent, { tmuxAlive: true })}`,
	);
}
{
	const agent = makeAgent({
		lastHeartbeatAt: new Date(Date.now() - 90_000).toISOString(),
		lastToolAt: new Date(Date.now() - 90_000).toISOString(),
	});
	const st = makeState(agent);
	st.messages = {
		m1: { id: "m1", to: "agent-x", from: "root", requiresResponse: true, status: "delivered", response: { status: "pending" } },
	};
	const out = deriveTaskProgressState(agent, st, { nowMs: Date.now(), tmuxAlive: true });
	ok("I3b: idle + pane alive + stale hb + responseMissing → idle_blocked (debt precedence)", out === "idle_blocked", `got=${out}`);
}
// ----- I4: starting runtime with pane alive is not dead either -----
{
	const agent = makeAgent({
		runtimeStatus: "starting",
		lastHeartbeatAt: new Date(Date.now() - 90_000).toISOString(),
	});
	ok(
		"I4: starting + pane alive + stale hb → NOT dead",
		run(agent, { tmuxAlive: true }) !== "dead",
		`got=${run(agent, { tmuxAlive: true })}`,
	);
}
// ----- I5: no-masking guards — genuinely dead shapes stay dead -----
{
	const agent = makeAgent({
		lastHeartbeatAt: new Date(Date.now() - 90_000).toISOString(),
	});
	ok(
		"I5a: pane DEAD (probe false) + idle + stale hb → dead unchanged",
		run(agent, { tmuxAlive: false }) === "dead",
		`got=${run(agent, { tmuxAlive: false })}`,
	);
}
{
	const agent = makeAgent({
		lastHeartbeatAt: new Date(Date.now() - 90_000).toISOString(),
		tmuxAlive: undefined,
	});
	// Absence of pane evidence is NOT life: no ctx probe, no positive record evidence.
	ok("I5b: NO pane evidence + idle + stale hb → dead (absence-of-evidence-is-not-life)", run(agent) === "dead", `got=${run(agent)}`);
}
{
	const agent = makeAgent({
		status: "stopped",
		lastHeartbeatAt: new Date(Date.now() - 90_000).toISOString(),
	});
	ok(
		"I5c: stopped record + pane alive + stale hb → dead (stopped contract)",
		run(agent, { tmuxAlive: true }) === "dead",
		`got=${run(agent, { tmuxAlive: true })}`,
	);
}
{
	const agent = makeAgent({
		lastHeartbeatAt: new Date(Date.now() - 90_000).toISOString(),
	});
	const st = makeState(agent);
	st.messages = {
		mdl: { id: "mdl", to: "agent-x", from: "root", status: "dead_letter", createdAt: new Date().toISOString() },
	};
	const out = deriveTaskProgressState(agent, st, { nowMs: Date.now(), tmuxAlive: true });
	ok("I5d: pane alive + stale hb + deadLetters → idle_blocked (debt not masked by liveness)", out === "idle_blocked", `got=${out}`);
}
// ----- I6: exclusivity — no new state (Option A documented in test) -----
{
	const now = Date.now();
	const ALL_STATES = ["active", "stalled", "completed_unverified", "awaiting_input", "idle_blocked", "dead"];
	const configs = [
		{ label: "incident", o: { lastHeartbeatAt: new Date(now - 90_000).toISOString() } },
		{
			label: "root-shaped",
			o: { lastHeartbeatAt: new Date(now - 5 * 60_000).toISOString(), lastToolAt: new Date(now - 5 * 60_000).toISOString() },
		},
		{
			label: "stalled-defer",
			o: {
				activeTaskIds: ["t"],
				lastHeartbeatAt: new Date(now - 90_000).toISOString(),
				lastToolAt: new Date(now - 11 * 60_000).toISOString(),
			},
		},
	];
	let allIn = true;
	const got = [];
	for (const c of configs) {
		const a = makeAgent(c.o);
		const st = makeState(a);
		const out = deriveTaskProgressState(a, st, { nowMs: now, tmuxAlive: true });
		got.push(out);
		if (!ALL_STATES.includes(out)) allIn = false;
	}
	ok("I6: every pane-alive deferred shape stays in the existing 6-state vocabulary (no new state)", allIn, `got=${got.join(",")}`);
}

console.log(`\n---\nagent-status-idle-stale-heartbeat results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
