#!/usr/bin/env node
/**
 * R20 — agent-status-derive.test.mjs
 *
 * Pure-function unit tests for the new `deriveTaskProgressState(agent, swarmState)`
 * helper that collapses the 12-field swarm_agent_status into a single mutually-exclusive
 * taskProgressState. Six RED-state tests, one per derived state.
 *
 * States (mutually exclusive, evaluated in order):
 *   - dead:               tmuxAlive === false OR lastHeartbeatAt > 60s ago
 *   - idle_blocked:       responseMissing > 0 OR ackMissing > 0 OR deadLetters > 0
 *   - completed_unverified: artifact mtime in last 5 min AND activeTaskIds.length > 0 AND verifiedResultMsgId === null
 *   - stalled:            activeTaskIds.length > 0 AND lastToolAt > 10 min ago AND verifiedResultMsgId === null
 *   - active:             lastToolAt < 60s ago OR (artifact mtime < 5 min AND activeTaskIds.length > 0 AND not yet settled)
 *   - awaiting_input:     (otherwise)
 *
 * RED-first discipline: pre-fix the helper does NOT exist (import returns undefined or
 * throws). The tests assert behavior unconditionally — RED proves the helper is missing,
 * GREEN proves the helper returns the right state for each configuration.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// RED: import the helper. Pre-fix it does not exist -> tests fail.
// GREEN: helper returns one of the six states.
let deriveTaskProgressState = null;
try {
	const mod = await import(join(here, "src", "agents.ts"));
	deriveTaskProgressState = mod.deriveTaskProgressState;
} catch (e) {
	deriveTaskProgressState = null;
}

let passed = 0, failed = 0;
const ok = (n, c, info) => {
	if (c) { passed++; console.log("  ok  ", n); }
	else { failed++; console.error("  FAIL:", n, info ?? ""); }
};

const ALL_STATES = ["active", "stalled", "completed_unverified", "awaiting_input", "idle_blocked", "dead"];

function makeAgent(overrides = {}) {
	const nowIso = new Date().toISOString();
	return {
		id: "agent-x", role: "implementer", roleKind: "worker", capabilities: [],
		activeTaskIds: [], maxConcurrentTasks: 1,
		status: "running", runtimeStatus: "idle", health: "healthy",
		tmuxSession: "sess", tmuxWindow: "agent-x", tmuxTarget: "sess:agent-x.0",
		model: "glm-5.1", provider: "zai-coding-cn", cwd: "/tmp",
		mailbox: ".pi/swarm/mailboxes/agent-x.jsonl",
		lastHeartbeatAt: nowIso,
		lastToolAt: nowIso,
		createdAt: nowIso, updatedAt: nowIso,
		...overrides,
	};
}

function makeState(agent, extras = {}) {
	return {
		version: 1, swarmId: "swarm-x", cwd: "/tmp", tmuxSession: "sess",
		agents: { "agent-x": agent, "orchestrator": { id: "orchestrator", runtimeStatus: "idle", status: "running", health: "healthy", lastHeartbeatAt: new Date().toISOString() } },
		delivered: {},
		messages: {},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...extras,
	};
}

console.log("=== R20 agent-status-derive ===");

// ----- CASE 1: dead -----
console.log("\n--- Case 1: dead (tmux pane died OR heartbeat stale) ---");
{
	const agent = makeAgent({ tmuxAlive: false });
	const st = makeState(agent);
	const ctx = { nowMs: Date.now() };
	const out = typeof deriveTaskProgressState === "function" ? deriveTaskProgressState(agent, st, ctx) : "MISSING_HELPER";
	ok("Case 1: dead when tmuxAlive === false", out === "dead", `got=${out}`);
}
{
	const staleHb = new Date(Date.now() - 90_000).toISOString();
	const agent = makeAgent({ lastHeartbeatAt: staleHb });
	const st = makeState(agent);
	const ctx = { nowMs: Date.now() };
	const out = typeof deriveTaskProgressState === "function" ? deriveTaskProgressState(agent, st, ctx) : "MISSING_HELPER";
	ok("Case 1b: dead when lastHeartbeatAt > 60s ago", out === "dead", `got=${out}`);
}

// ----- CASE 2: idle_blocked -----
console.log("\n--- Case 2: idle_blocked (responseMissing / ackMissing / deadLetters) ---");
{
	const agent = makeAgent({});
	const st = makeState(agent, {
		messages: { "msg-1": { id: "msg-1", to: "agent-x", from: "orchestrator", status: "injected", requiresAck: true, requiresResponse: true, response: { status: "missing" }, createdAt: new Date().toISOString() } },
	});
	const ctx = { nowMs: Date.now() };
	const out = typeof deriveTaskProgressState === "function" ? deriveTaskProgressState(agent, st, ctx) : "MISSING_HELPER";
	ok("Case 2: idle_blocked when responseMissing > 0", out === "idle_blocked", `got=${out}`);
}
{
	const agent = makeAgent({});
	const st = makeState(agent, {
		messages: { "msg-2": { id: "msg-2", to: "agent-x", from: "orchestrator", status: "injected", requiresAck: true, ackMissingAt: new Date().toISOString(), createdAt: new Date().toISOString() } },
	});
	const ctx = { nowMs: Date.now() };
	const out = typeof deriveTaskProgressState === "function" ? deriveTaskProgressState(agent, st, ctx) : "MISSING_HELPER";
	ok("Case 2b: idle_blocked when ackMissing > 0", out === "idle_blocked", `got=${out}`);
}
{
	const agent = makeAgent({});
	const st = makeState(agent, {
		messages: { "msg-3": { id: "msg-3", to: "agent-x", from: "orchestrator", status: "dead_letter", requiresAck: false, createdAt: new Date().toISOString() } },
	});
	const ctx = { nowMs: Date.now() };
	const out = typeof deriveTaskProgressState === "function" ? deriveTaskProgressState(agent, st, ctx) : "MISSING_HELPER";
	ok("Case 2c: idle_blocked when deadLetters > 0", out === "idle_blocked", `got=${out}`);
}

// ----- CASE 3: completed_unverified -----
console.log("\n--- Case 3: completed_unverified (artifact wrote, node still open) ---");
{
	const now = Date.now();
	const agent = makeAgent({
		activeTaskIds: ["task-r20-1"],
		lastToolAt: new Date(now - 5 * 60_000).toISOString(),
	});
	const st = makeState(agent);
	const ctx = { nowMs: now, artifactMtimeMs: now - 30_000 };
	const out = typeof deriveTaskProgressState === "function" ? deriveTaskProgressState(agent, st, ctx) : "MISSING_HELPER";
	ok("Case 3: completed_unverified when artifact fresh + activeTask + no verified result", out === "completed_unverified", `got=${out}`);
}

// ----- CASE 4: stalled -----
console.log("\n--- Case 4: stalled (long since last tool call, no progress) ---");
{
	const now = Date.now();
	const agent = makeAgent({
		activeTaskIds: ["task-r20-2"],
		lastToolAt: new Date(now - 11 * 60_000).toISOString(),
	});
	const st = makeState(agent);
	const ctx = { nowMs: now, artifactMtimeMs: now - 60 * 60_000 };
	const out = typeof deriveTaskProgressState === "function" ? deriveTaskProgressState(agent, st, ctx) : "MISSING_HELPER";
	ok("Case 4: stalled when activeTask + lastToolAt > 10 min ago + no fresh artifact", out === "stalled", `got=${out}`);
}

// ----- CASE 5: active -----
console.log("\n--- Case 5: active (recent tool activity) ---");
{
	const now = Date.now();
	const agent = makeAgent({
		activeTaskIds: ["task-r20-3"],
		lastToolAt: new Date(now - 5_000).toISOString(),
	});
	const st = makeState(agent);
	const ctx = { nowMs: now };
	const out = typeof deriveTaskProgressState === "function" ? deriveTaskProgressState(agent, st, ctx) : "MISSING_HELPER";
	ok("Case 5: active when lastToolAt < 60s ago", out === "active", `got=${out}`);
}
{
	const now = Date.now();
	const agent = makeAgent({
		activeTaskIds: ["task-r20-4"],
		lastToolAt: new Date(now - 5 * 60_000).toISOString(),
	});
	// A verified result message flips completed_unverified -> active (worker is genuinely working).
	const st = makeState(agent, {
		messages: {
			"msg-verified": {
				id: "msg-verified", to: "agent-x", from: "orchestrator", status: "acked",
				requiresAck: true, requiresResponse: true,
				response: { status: "verified" },
				createdAt: new Date(now - 5 * 60_000).toISOString(),
			},
		},
	});
	const ctx = { nowMs: now, artifactMtimeMs: now - 30_000 };
	const out = typeof deriveTaskProgressState === "function" ? deriveTaskProgressState(agent, st, ctx) : "MISSING_HELPER";
	ok("Case 5b: active when fresh artifact + activeTask + verified result (between 60s and 10min)", out === "active", `got=${out}`);
}

// ----- CASE 6: awaiting_input -----
console.log("\n--- Case 6: awaiting_input (default idle state) ---");
{
	const now = Date.now();
	const agent = makeAgent({
		activeTaskIds: [],
		lastToolAt: new Date(now - 5 * 60_000).toISOString(),
	});
	const st = makeState(agent);
	const ctx = { nowMs: now };
	const out = typeof deriveTaskProgressState === "function" ? deriveTaskProgressState(agent, st, ctx) : "MISSING_HELPER";
	ok("Case 6: awaiting_input as default fallback", out === "awaiting_input", `got=${out}`);
}

// ----- EXCLUSIVITY -----
console.log("\n--- Exclusivity: every returned value is one of the 6 named states ---");
{
	const now = Date.now();
	const configs = [
		{ tmuxAlive: false },
		{ lastHeartbeatAt: new Date(now - 90_000).toISOString() },
		{ activeTaskIds: ["task-z"], lastToolAt: new Date(now - 5 * 60_000).toISOString() },
		{ activeTaskIds: ["task-z"], lastToolAt: new Date(now - 11 * 60_000).toISOString() },
		{ activeTaskIds: ["task-z"], lastToolAt: new Date(now - 5_000).toISOString() },
		{ activeTaskIds: [], lastToolAt: new Date(now - 5 * 60_000).toISOString() },
	];
	const states = makeState(makeAgent());
	for (const o of configs) {
		const a = makeAgent(o);
		const out = typeof deriveTaskProgressState === "function" ? deriveTaskProgressState(a, states, { nowMs: now }) : "MISSING_HELPER";
		ok(`exclusivity: ${JSON.stringify(o)} -> ${out}`, typeof out === "string" && (ALL_STATES.includes(out) || out === "MISSING_HELPER"), `got=${out}`);
	}
}

console.log(`\n---`);
console.log(`R20 agent-status-derive results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
