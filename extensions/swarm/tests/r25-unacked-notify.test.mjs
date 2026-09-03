#!/usr/bin/env node
/**
 * R25 — notify PM when a worker settles/stops owing unacked requiresAck messages.
 *
 * Plan §0 root cause:
 *   - agent_settled worker branch (hooks.ts:821) covers requiresResponse-missing + open-assignment
 *     cases but NOT plain requiresAck-only debt.
 *   - stopAgent (agents.ts:438) refuses only on activeTaskIds; ack debt proceeds silently.
 *
 * Plan §1 RED asserts (deterministic, state-seeded, NO LLM):
 *   1. Settled path: a running worker with seeded unacked requiresAck records → orchestrator
 *      receives an ack-debt notify (mailbox record to:"orchestrator" + subject matches).
 *   2. Stop path: stop_agent on the same shape → orchestrator receives the same notify.
 *   3. Re-settle with UNCHANGED debt set → notify count stays 1 (idempotency storm guard).
 *   4. Sensitivity (false-RED guard): requiresResponse-missing still triggers the existing
 *      L868 notify (proves the harness observes the real path).
 *   5. Invariant: requiresAck=false messages never produce a notify (post-fix invariant).
 */

import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-r25-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

// Initialize .pi/swarm dir + state file before any tool call
const { ensureDirs, paths, defaultState } = await import(join(here, "..", "src", "state.ts"));
await ensureDirs(paths(scratch));

let pass = 0, fail = 0;
const ok = (n, c, info) => {
	if (c) { pass++; console.log("  ok  ", n); }
	else { fail++; console.error("  FAIL", n, info !== undefined ? `(${JSON.stringify(info).slice(0, 200)})` : ""); }
};

const tools = {};
const sentMessages = []; // R10-1 boundary counter for real pi.sendMessage
const pi = {
	registerTool: (def) => { tools[def.name] = def; },
	registerCommand: () => {},
	on: () => {},
	sendMessage: (msg) => { sentMessages.push(msg); }, // captured for boundary assertions
	exec: async (cmd, args) => {
		if (cmd === "tmux") {
			if (args[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
			if (args[0] === "kill-window" || args[0] === "kill-pane") return { code: 0, stdout: "", stderr: "" };
			if (args[0] === "has-session") return { code: 0, stdout: "", stderr: "" };
		}
		if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	},
};
factory(pi);

const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");
const call = async (name, params) => {
	const t = tools[name]; if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: scratch });
};
const readSwarmState = () => JSON.parse(readFileSync(statePath, "utf8"));
const writeSwarmState = (st) => writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");
const orchMailboxPath = join(scratch, ".pi", "swarm", "mailboxes", "orchestrator.jsonl");
const readOrchMailbox = () => {
	try { return readFileSync(orchMailboxPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
	catch { return []; }
};

// Bootstrap state file
writeFileSync(statePath, JSON.stringify(defaultState("swarm-r25", scratch), null, 2) + "\n");

const seedAgentWithUnackedDebt = (agentId, opts = {}) => {
	const st = readSwarmState();
	const aid = String(Object.keys(st.agents).length + 1).padStart(2, "0");
	st.agents[agentId] = {
		id: agentId,
		role: opts.role || "test-worker",
		roleKind: opts.roleKind || "implementer",
		roleKindExplicit: false,
		tmuxTarget: "r25sess:r25." + aid,
		tmuxSession: "r25sess",
		tmuxWindow: "r25",
		mailbox: `.pi/swarm/mailboxes/${agentId}.jsonl`,
		capabilities: ["implement"],
		status: opts.status || "running",
		runtimeStatus: opts.status === "stopped" ? "stopped" : "idle",
		health: "healthy",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		lastHeartbeatAt: new Date().toISOString(),
		activeTaskIds: [],
		lastSessionStartAt: new Date().toISOString(),
	};
	st.swarmId = st.swarmId || "swarm-r25";
	st.messages = st.messages || {};
	const now = new Date().toISOString();
	const seed = (id, subject, requiresAck, requiresResponse) => {
		st.messages[id] = {
			id,
			swarmId: st.swarmId,
			from: "orchestrator",
			to: agentId,
			subject,
			priority: "normal",
			type: "swarm.message",
			schemaVersion: 1,
			createdAt: now,
			body: `seeded ${subject} for ${agentId}`,
			requiresAck,
			requiresResponse,
			status: "intercepted",
			attempts: 1,
			queuedAt: now,
			updatedAt: now,
			headers: { cwd: scratch, senderModel: "test", senderProvider: "test" },
		};
	};
	seed(`msg-r25-${agentId}-1`, "Task A requiresAck", true, false);
	seed(`msg-r25-${agentId}-2`, "Task B requiresAck", true, false);
	if (opts.includeRequiresResponse) {
		seed(`msg-r25-${agentId}-3`, "Task C requiresResponse", false, true);
	}
	if (opts.includeRequiresAckFalse) {
		seed(`msg-r25-${agentId}-4`, "Task D informational", false, false);
	}
	writeSwarmState(st);
	return st;
};

// Register orchestrator pseudo-agent so deliverMessageLocked has an "orchestrator" agent to deliver to.
{
	const st = readSwarmState();
	st.agents.orchestrator = st.agents.orchestrator || {
		id: "orchestrator", role: "orchestrator", roleKind: "orchestrator", roleKindExplicit: true,
		tmuxTarget: "r25sess:orch.1", tmuxSession: "r25sess", tmuxWindow: "orch",
		mailbox: ".pi/swarm/mailboxes/orchestrator.jsonl", capabilities: ["orchestrate"],
		status: "running", runtimeStatus: "idle", health: "healthy",
		createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		lastHeartbeatAt: new Date().toISOString(), activeTaskIds: [],
	};
	st.swarmId = st.swarmId || "swarm-r25";
	st.messages = st.messages || {};
	writeSwarmState(st);
}

// === Worker seeded with running status + 2 unacked requiresAck messages ===
seedAgentWithUnackedDebt("r25-worker", { status: "running" });

// === 1. Settle path: drive agent_settled handler directly ===
const { registerSwarmHooks } = await import(join(here, "..", "src", "hooks.ts"));
const handlers = [];
const stub = {
	sendMessage: (m) => sentMessages.push(m),
	exec: async (cmd, args) => {
		if (cmd === "tmux") return { code: 0, stdout: "%1\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	},
	registerTool: () => {},
	registerCommand: () => {},
	on: (ev, fn) => handlers.push({ ev, fn }),
};
registerSwarmHooks(stub);
const agentSettledHandler = handlers.find((h) => h.ev === "agent_settled")?.fn;
ok("agent_settled handler registered", typeof agentSettledHandler === "function");

// Flip identity to the worker
const prevAgent = process.env.PI_SWARM_AGENT_ID;
process.env.PI_SWARM_AGENT_ID = "r25-worker";
try {
	await agentSettledHandler({}, { cwd: scratch, mode: "tui" });
} finally {
	process.env.PI_SWARM_AGENT_ID = prevAgent;
}

const orchMail1 = readOrchMailbox();
const ackDebtNotify1 = orchMail1.find((m) =>
	m.to === "orchestrator" && /unacked ack|ack debt|R25/i.test(m.subject || "")
);
ok("[Settle path] orchestrator received ack-debt notify (RED today: none)", !!ackDebtNotify1, {
	totalOrchMessages: orchMail1.length,
	subjects: orchMail1.map((m) => m.subject),
});

// === 3. Re-settle storm guard: cooldown suppresses repeated settles within window ===
// [Settle path] already settled r25-worker once (lastAckDebtNotifyAt stamped). Run 2 more settles
// back-to-back; cumulative orchestrator mailbox count for ack-debt subjects must stay at 1
// (the original), not 3 — that's the storm-guard proof.
const orchBeforeResettle = readOrchMailbox().filter((m) => m.to === "orchestrator" && /unacked ack|ack debt|R25/i.test(m.subject || "")).length;
process.env.PI_SWARM_AGENT_ID = "r25-worker";
try { await agentSettledHandler({}, { cwd: scratch, mode: "tui" }); } finally { process.env.PI_SWARM_AGENT_ID = prevAgent; }
process.env.PI_SWARM_AGENT_ID = "r25-worker";
try { await agentSettledHandler({}, { cwd: scratch, mode: "tui" }); } finally { process.env.PI_SWARM_AGENT_ID = prevAgent; }
const orchAfterResettle = readOrchMailbox().filter((m) => m.to === "orchestrator" && /unacked ack|ack debt|R25/i.test(m.subject || "")).length;
ok("[Re-settle] cumulative notify count stays 1 across 2 more settles (cooldown storm guard)", orchAfterResettle === orchBeforeResettle, { before: orchBeforeResettle, after: orchAfterResettle });

// === 4. Sensitivity: requiresResponse-missing still triggers L868 notify (false-RED guard) ===
seedAgentWithUnackedDebt("r25-worker-rr", { status: "running", includeRequiresResponse: true });
rmSync(orchMailboxPath, { force: true });
process.env.PI_SWARM_AGENT_ID = "r25-worker-rr";
try {
	await agentSettledHandler({}, { cwd: scratch, mode: "tui" });
} finally {
	process.env.PI_SWARM_AGENT_ID = prevAgent;
}
const orchMail3 = readOrchMailbox();
const rrNotify = orchMail3.find((m) =>
	m.to === "orchestrator" && /missing response/i.test(m.subject || "")
);
ok("[Sensitivity] requiresResponse-missing still produces the existing L868 notify", !!rrNotify, {
	totalOrchMessages: orchMail3.length,
	subjects: orchMail3.map((m) => m.subject),
});

// === 5. Invariant: requiresAck=false messages never produce a notify ===
// Seed a worker holding ONLY informational messages — predicate requires m.requiresAck === true,
// so unackedRequiresAckRecords returns empty → no notify.
seedAgentWithUnackedDebt("r25-worker-info", { status: "running", includeRequiresAckFalse: true });
// Drop the seeded requiresAck=true records so ONLY informational remain
{
	const st = readSwarmState();
	for (const id of Object.keys(st.messages || {})) {
		if (st.messages[id].to === "r25-worker-info" && st.messages[id].requiresAck === true) {
			delete st.messages[id];
		}
	}
	writeSwarmState(st);
}
rmSync(orchMailboxPath, { force: true });
process.env.PI_SWARM_AGENT_ID = "r25-worker-info";
try {
	await agentSettledHandler({}, { cwd: scratch, mode: "tui" });
} finally {
	process.env.PI_SWARM_AGENT_ID = prevAgent;
}
const orchMail4 = readOrchMailbox();
const infoNotify = orchMail4.filter((m) =>
	m.to === "orchestrator" && /unacked ack|ack debt|R25/i.test(m.subject || "")
);
ok("[Invariant] requiresAck=false informational messages NEVER produce a notify", infoNotify.length === 0, {
	count: infoNotify.length,
});

// === 2. Stop path: factory swarm_stop_agent tool call ===
seedAgentWithUnackedDebt("r25-stopped", { status: "running" });
rmSync(orchMailboxPath, { force: true });
const stopRes = await call("swarm_stop_agent", { agentId: "r25-stopped", cwd: scratch });
ok("[Stop path] swarm_stop_agent succeeds (no activeTaskIds)", !!stopRes?.content?.[0]?.text);
const orchMail5 = readOrchMailbox();
const stopNotify = orchMail5.find((m) =>
	m.to === "orchestrator" && /unacked ack|ack debt|R25|stop/i.test(m.subject || "")
);
ok("[Stop path] orchestrator received ack-debt notify (RED today: none)", !!stopNotify, {
	totalOrchMessages: orchMail5.length,
	subjects: orchMail5.map((m) => m.subject),
});

// === R10-1 boundary counting assertion ===
// Plan §5 + AGENTS.md rule 4 require a REAL R10-1 boundary counter at the `pi.sendMessage`
// surface, not a constant-true line. The settle-path notify lands in the orchestrator mailbox
// synchronously; the actual sendMessage call happens when pumpOrchestratorMailbox surfaces it
// on the next pump tick (real production boundary). We drive the pump twice and assert:
//   - After 1st settle: at least 1 sendMessage carrying subject matching /owing/ (the ack-debt
//     notify surfaces exactly once).
//   - After the re-settle round (2 more settles within cooldown): ZERO new sends — the surface
//     ledger (consumerReceipts.orchestrator.entries) dedupes the same idempotencyKey, and the
//     cooldown never reached the deliver path.
//   - After the stop path: at least 1 sendMessage carrying subject matching /owing/.
const { pumpOrchestratorMailbox } = await import(join(here, "..", "src", "reconcile.ts"));
const { withLock } = await import(join(here, "..", "src", "state.ts"));
const pumpStub = {
	sendMessage: (m, o) => sentMessages.push({ customType: m?.customType, content: m?.content, details: m?.details, options: o }),
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};
const pumpCtx = { cwd: scratch, mode: "tui", isIdle: () => true, hasUI: false, ui: { setStatus: () => {} }, model: { id: "glm-5.1", provider: "zai-coding-cn" } };
const pPaths = paths(scratch);
// Helper: ack-debt sendMatcher — pump wraps the swarm message as {customType:"swarm-message",
// details:<SwarmMessage>}; the subject lives at details.subject (NOT m.subject at the top level).
const ackDebtSubject = (s) => /owing.*unacked ack/.test(String(s?.details?.subject || "") || "");
// Seed the orchestrator leader so pump's second-line defense does not deny.
const seedOrchestratorLeader = async () => {
	await withLock(pPaths, async () => {
		const st = readSwarmState();
		const { ensureOrchestrator, heartbeatOrchestratorLeader } = await import(join(here, "..", "src", "identity.ts"));
		ensureOrchestrator(st, scratch, pPaths);
		heartbeatOrchestratorLeader(st, Date.now(), process.pid, "r25_test_seed");
		writeSwarmState(st);
	});
};
// Helper: set orchestrator identity for the duration of a pump call.
const pumpAsOrchestrator = async () => {
	const prev = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = "orchestrator";
	try { return await pumpOrchestratorMailbox(pumpStub, pumpCtx, pPaths, "r25"); }
	finally { process.env.PI_SWARM_AGENT_ID = prev; }
};

await seedOrchestratorLeader();

// [R10-1a] Fresh worker settle; pump once; assert >=1 ack-debt sendMessage at the boundary.
seedAgentWithUnackedDebt("r25-worker-b1", { status: "running" });
rmSync(orchMailboxPath, { force: true });
process.env.PI_SWARM_AGENT_ID = "r25-worker-b1";
try { await agentSettledHandler({}, { cwd: scratch, mode: "tui" }); } finally { process.env.PI_SWARM_AGENT_ID = prevAgent; }
sentMessages.length = 0;
await pumpAsOrchestrator();
const pumpSends1 = sentMessages.filter(ackDebtSubject);
ok("[R10-1 boundary] first settle surfaces >=1 ack-debt sendMessage at the pump boundary", pumpSends1.length >= 1, { count: pumpSends1.length, detailsSubjects: sentMessages.map((s) => s?.details?.subject) });

// [R10-1b] Re-settle the same worker 2x more within cooldown; pump again; surface-ledger dedupes.
process.env.PI_SWARM_AGENT_ID = "r25-worker-b1";
try { await agentSettledHandler({}, { cwd: scratch, mode: "tui" }); } finally { process.env.PI_SWARM_AGENT_ID = prevAgent; }
process.env.PI_SWARM_AGENT_ID = "r25-worker-b1";
try { await agentSettledHandler({}, { cwd: scratch, mode: "tui" }); } finally { process.env.PI_SWARM_AGENT_ID = prevAgent; }
sentMessages.length = 0;
await pumpAsOrchestrator();
const pumpSends2 = sentMessages.filter(ackDebtSubject);
ok("[R10-1 boundary] re-settle within cooldown surfaces 0 NEW ack-debt sendMessage (surface-ledger dedupe)", pumpSends2.length === 0, { count: pumpSends2.length, detailsSubjects: sentMessages.map((s) => s?.details?.subject) });

// [R10-1c] Stop path surfaces >=1 ack-debt sendMessage at the pump boundary (separate debt set).
seedAgentWithUnackedDebt("r25-worker-b1-stop", { status: "running" });
rmSync(orchMailboxPath, { force: true });
await call("swarm_stop_agent", { agentId: "r25-worker-b1-stop", cwd: scratch });
sentMessages.length = 0;
await pumpAsOrchestrator();
const pumpSends3 = sentMessages.filter(ackDebtSubject);
ok("[R10-1 boundary] stop path surfaces >=1 ack-debt sendMessage at the pump boundary", pumpSends3.length >= 1, { count: pumpSends3.length, detailsSubjects: sentMessages.map((s) => s?.details?.subject) });

// Cleanup
rmSync(scratch, { recursive: true, force: true });

console.log(`\nR25 NOTIFY ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
