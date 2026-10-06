#!/usr/bin/env node
/**
 * agent-status-toolrunning-dead.test.mjs — dead false-positive for tool-running agents
 * (task-202610040001-taskprogressstate-dead-f, red-first)
 *
 * RED: deriveTaskProgressState step (1) returns dead on heartbeat >60s stale regardless of
 * runtimeStatus. Live incident 2026-10-03: agent running one long tool (gates/test suites)
 * showed taskProgressState=dead + why="no pane / stale heartbeat" while paneAlive=true,
 * health=healthy, lastToolAt fresh. Heartbeats only stamp at tool_execution_start/end —
 * ONE tool call >60s trips the false verdict.
 *
 * Contract: busy|tool_running defers the heartbeat-dead verdict (falls through to the
 * active/stalled/awaiting_input pipeline). tmuxAlive=false stays dead unconditionally.
 * idle/starting/settled + stale heartbeat stay dead (no masking).
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
	typeof deriveTaskProgressState === "function" ? deriveTaskProgressState(agent, makeState(agent), { nowMs: Date.now(), ...ctx }) : "MISSING_HELPER";

console.log("=== tool-running dead false-positive (R) ===");

// ----- R1: the live incident shape -----
{
	const agent = makeAgent({
		runtimeStatus: "tool_running",
		lastHeartbeatAt: new Date(Date.now() - 90_000).toISOString(), // 90s stale
		lastToolAt: new Date(Date.now() - 5_000).toISOString(), // 5s fresh (mid-tool stamp)
	});
	ok("R1 incident: tool_running + hb 90s stale + lastToolAt fresh → active (not dead)", run(agent) === "active", `got=${run(agent)}`);
}
{
	const agent = makeAgent({
		runtimeStatus: "busy",
		lastHeartbeatAt: new Date(Date.now() - 90_000).toISOString(),
		lastToolAt: new Date(Date.now() - 5_000).toISOString(),
	});
	ok("R1b: busy + hb stale + lastToolAt fresh → active (not dead)", run(agent) === "active", `got=${run(agent)}`);
}
{
	const agent = makeAgent({
		runtimeStatus: "busy",
		activeTaskIds: ["task-1"],
		lastHeartbeatAt: new Date(Date.now() - 90_000).toISOString(),
		lastToolAt: new Date(Date.now() - 180_000).toISOString(), // 3min — no active verdict possible
	});
	const out = run(agent);
	ok("R1c: busy + hb stale + lastToolAt 3min → NOT dead", out !== "dead", `got=${out}`);
}
{
	const agent = makeAgent({
		runtimeStatus: "tool_running",
		activeTaskIds: ["task-1"],
		lastHeartbeatAt: new Date(Date.now() - 90_000).toISOString(),
		lastToolAt: new Date(Date.now() - 11 * 60_000).toISOString(), // 11min stale
	});
	const out = run(agent);
	ok("R1d: tool_running + lastToolAt 11min + activeTask → stalled (defer converges honestly)", out === "stalled", `got=${out}`);
}

// ----- R2: still-dead contract preserved -----
{
	const agent = makeAgent({
		runtimeStatus: "tool_running",
		lastHeartbeatAt: new Date(Date.now() - 90_000).toISOString(),
	});
	const out = run(agent, { tmuxAlive: false });
	ok("R2: pane dead (tmuxAlive=false) + tool_running → STILL dead", out === "dead", `got=${out}`);
}
{
	const agent = makeAgent({
		status: "stopped",
		runtimeStatus: "stopped",
		lastHeartbeatAt: new Date(Date.now() - 90_000).toISOString(),
	});
	ok("R2b: stopped agent → dead unchanged", run(agent) === "dead", `got=${run(agent)}`);
}

// ----- R3: no masking of genuinely dead agents -----
{
	const agent = makeAgent({
		runtimeStatus: "idle",
		lastHeartbeatAt: new Date(Date.now() - 90_000).toISOString(),
	});
	ok("R3a: idle + hb 90s stale → dead unchanged (no masking)", run(agent) === "dead", `got=${run(agent)}`);
}
{
	const agent = makeAgent({
		runtimeStatus: "starting",
		lastHeartbeatAt: new Date(Date.now() - 90_000).toISOString(),
	});
	ok("R3b: starting + hb stale → dead unchanged", run(agent) === "dead", `got=${run(agent)}`);
}

// ----- R4: precedence — actionable debt beats deferred-dead -----
{
	const agent = makeAgent({
		id: "agent-r4",
		runtimeStatus: "tool_running",
		lastHeartbeatAt: new Date(Date.now() - 90_000).toISOString(),
		lastToolAt: new Date(Date.now() - 5_000).toISOString(),
	});
	const st = makeState(agent);
	st.messages = {
		m1: { id: "m1", to: "agent-r4", from: "root", requiresResponse: true, status: "delivered", response: { status: "pending" } },
	};
	const out = deriveTaskProgressState(agent, st, { nowMs: Date.now() });
	ok("R4: tool_running + stale hb + responseMissing → idle_blocked (actionable, not dead)", out === "idle_blocked", `got=${out}`);
}

console.log(`\n---\nagent-status-toolrunning-dead results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
