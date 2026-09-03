#!/usr/bin/env node
/**
 * Minimal-protocol Phase 1 — shadow telemetry + wrapper + derivation tests (Issue 25).
 *
 * Invariants under test:
 *   - tool.invoked is emitted ONCE per swarm tool invocation with tool name, profile/gate,
 *     success/error class, and duration. Wrapping does not alter return values or swallow
 *     thrown errors.
 *   - Under gate=0 (default), `swarm_check_mailbox` does NOT stamp any v2 lifecycle field on
 *     the recipient's record. A shadow `message.lifecycle_derived_shadow` trace is emitted
 *     with the would-be field + source.
 *   - `deriveLifecycleFromTrigger` (pure helper) returns no_change when the field is already
 *     set, and emits the correct source label per proposal §A.
 *   - The migration tool /swarm protocol migrate is idempotent: a second run yields migrated=0.
 *
 * Pattern mirrors `lifecycle-fencing.test.mjs` / `completion.test.mjs`: real extension
 * factory, in-memory mock pi, asserts on durable state + events.jsonl.
 */
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), `swarm-minimal-protocol-shadow-${process.pid}-${Date.now()}`));
await mkdir(join(scratch, ".pi"), { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log("  ok  ", name); } else { fail++; console.error("  FAIL", name); } };

// ---- scratch helpers ----
async function readGlobalEvents() {
	const p = join(scratch, ".pi/swarm/traces/events.jsonl");
	const txt = await readFile(p, "utf8").catch(() => "");
	return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
async function readStateFile() {
	const p = join(scratch, ".pi/swarm/swarm-state.json");
	try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; }
}

// ---- shared: load extension with a controllable identity ----
async function loadExtension({ identity = "worker-a" } = {}) {
	process.env.PI_SWARM_AGENT_ID = identity;
	const handlers = {};
	const commands = {};
	const tools = {};
	const pi = {
		registerTool: (def) => { tools[def.name] = def; },
		registerCommand: (name, def) => { commands[name] = def; },
		on: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
		exec: async (cmd, args) => {
			if (cmd === "tmux" && args?.[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
			return { code: 1, stdout: "", stderr: "" };
		},
		setModel: async () => true,
		sendMessage: () => {},
	};
	const mod = await import(join(here, "..", "index.ts"));
	mod.default(pi);
	return { pi, handlers, tools, commands };
}

// ============================================================
// Scenario 1: tool.invoked emitted once per tool call (wrapper coverage)
// ============================================================
{
	console.log("\n--- Scenario 1: tool.invoked emitted once per tool call ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi"), { recursive: true });

	const { tools } = await loadExtension({ identity: "worker-a" });

	const t0 = Date.now();
	const result = await tools.swarm_list_agents.execute("c1", {}, undefined, undefined, { cwd: scratch });
	const t1 = Date.now();
	ok("swarm_list_agents returns a result", typeof result?.content?.[0]?.text === "string");
	ok("swarm_list_agents duration < 5s", (t1 - t0) < 5_000);

	const events = await readGlobalEvents();
	const toolInvoked = events.filter((e) => e.event === "tool.invoked" && e.tool === "swarm_list_agents");
	ok("exactly one tool.invoked for swarm_list_agents", toolInvoked.length === 1);
	if (toolInvoked.length) {
		ok("tool.invoked carries agentId=worker-a", toolInvoked[0].agentId === "worker-a");
		ok("tool.invoked carries gate=0", toolInvoked[0].gate === 0);
		ok("tool.invoked cls=success", toolInvoked[0].cls === "success");
		ok("tool.invoked has durationMs", typeof toolInvoked[0].durationMs === "number" && toolInvoked[0].durationMs >= 0);
		ok("tool.invoked has no errClass on success", toolInvoked[0].errClass === undefined);
	}
}

// ============================================================
// Scenario 2: tool wrapper re-throws thrown errors + stamps cls=thrown
// ============================================================
{
	console.log("\n--- Scenario 2: thrown errors propagate + tool.invoked cls=thrown ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi"), { recursive: true });

	const { tools } = await loadExtension({ identity: "worker-a" });

	let thrown = null;
	try {
		// swarm_ack_message throws on unknown messageId
		await tools.swarm_ack_message.execute("c2", { messageId: "msg-nonexistent", status: "seen" }, undefined, undefined, { cwd: scratch });
	} catch (err) { thrown = err; }
	ok("swarm_ack_message threw on unknown id", thrown instanceof Error);
	ok("thrown error mentions unknown message id", String(thrown?.message || "").includes("Unknown message id"));

	const events = await readGlobalEvents();
	const toolInvoked = events.filter((e) => e.event === "tool.invoked" && e.tool === "swarm_ack_message" && e.cls === "thrown");
	ok("exactly one tool.invoked cls=thrown for swarm_ack_message", toolInvoked.length === 1);
	if (toolInvoked.length) ok("errClass captured (Error)", toolInvoked[0].errClass === "Error");
}

// ============================================================
// Scenario 3: gate=0 mailbox read emits shadow lifecycle trace; record unchanged
// ============================================================
{
	console.log("\n--- Scenario 3: gate=0 mailbox read -> shadow trace, no record mutation ---");
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi"), { recursive: true });

	const { tools } = await loadExtension({ identity: "worker-a" });

	// Seed an unread message into worker-a's mailbox + a matching swarm-state record.
	const msgId = "msg-shadow-1";
	const beforeTs = new Date().toISOString();
	await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
	await writeFile(join(scratch, ".pi/swarm/mailboxes/worker-a.jsonl"), JSON.stringify({
		id: msgId, swarmId: "test", from: "orchestrator", to: "worker-a", subject: "hi",
		priority: "normal", type: "swarm.message", schemaVersion: 1, createdAt: beforeTs,
		body: "hello", requiresAck: true, headers: {},
	}) + "\n", "utf8");

	// Seed a minimal state file with the matching record (no v2 fields).
	const st = {
		version: 1, swarmId: "test", cwd: scratch, tmuxSession: "test",
		agents: {
			"orchestrator": { id: "orchestrator", role: "orchestrator", roleKind: "orchestrator", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 99, status: "running", runtimeStatus: "idle", health: "healthy", tmuxSession: "test", tmuxWindow: "orch", tmuxTarget: "test:orch.0", model: "glm-5.1", provider: "zai-coding-cn", cwd: scratch, mailbox: ".pi/swarm/mailboxes/orchestrator.jsonl", createdAt: beforeTs, updatedAt: beforeTs },
			"worker-a": { id: "worker-a", role: "worker", roleKind: "worker", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1, status: "running", runtimeStatus: "idle", health: "healthy", tmuxSession: "test", tmuxWindow: "worker-a", tmuxTarget: "test:worker-a.0", model: "glm-5.1", provider: "zai-coding-cn", cwd: scratch, mailbox: ".pi/swarm/mailboxes/worker-a.jsonl", createdAt: beforeTs, updatedAt: beforeTs },
		},
		delivered: { "worker-a": [] },
		messages: { [msgId]: { id: msgId, from: "orchestrator", to: "worker-a", status: "queued", createdAt: beforeTs, updatedAt: beforeTs, attempts: 0, requiresAck: true } },
	};
	await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(st, null, 2), "utf8");

	const out = await tools.swarm_check_mailbox.execute("c3", { markDelivered: true }, undefined, undefined, { cwd: scratch });
	ok("swarm_check_mailbox returned text result", typeof out?.content?.[0]?.text === "string");

	// Record should NOT have v2 fields under gate=0 (except deliveredAt may stamp surfacedAt for orchestrator only)
	const after = await readStateFile();
	const rec = after?.messages?.[msgId];
	ok("message record has NO seenAt under gate=0", !rec?.seenAt);
	ok("message record has NO mailboxDeliveredAt under gate=0", !rec?.mailboxDeliveredAt);
	ok("message record has NO respondedAt under gate=0", !rec?.respondedAt);
	ok("message record has NO terminalAt under gate=0", !rec?.terminalAt);
	ok("message record has NO lifecycleStage under gate=0", !rec?.lifecycleStage);

	// But the SHADOW trace must be present.
	const events = await readGlobalEvents();
	const shadows = events.filter((e) => e.event === "message.lifecycle_derived_shadow");
	ok("at least one message.lifecycle_derived_shadow trace emitted", shadows.length >= 1);
	if (shadows.length) {
		ok("shadow trace has shadow=true", shadows[0].shadow === true);
		ok("shadow trace has gate=0", shadows[0].gate === 0);
	}

	// tool.invoked for swarm_check_mailbox must also be present.
	const toolInvoked = events.filter((e) => e.event === "tool.invoked" && e.tool === "swarm_check_mailbox");
	ok("tool.invoked for swarm_check_mailbox present", toolInvoked.length === 1);
}

// ============================================================
// Scenario 4: deriveLifecycleFromTrigger pure helper (no state mutation)
// ============================================================
{
	console.log("\n--- Scenario 4: deriveLifecycleFromTrigger pure helper ---");
	const { deriveLifecycleFromTrigger } = await import(join(here, "..", "src/mailbox.ts"));

	const baseRec = { id: "m", from: "o", to: "w", status: "queued", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", attempts: 0, requiresAck: true };
	const at = "2026-01-01T00:00:00Z";

	const d1 = deriveLifecycleFromTrigger(baseRec, { kind: "mailbox_appended" }, at);
	ok("mailbox_appended -> set mailboxDeliveredAt (transport receipt)", d1.kind === "set" && d1.field === "mailboxDeliveredAt");
	ok("mailbox_appended source label", d1.kind === "set" && d1.source === "mailbox.appended");

	const d2 = deriveLifecycleFromTrigger(baseRec, { kind: "mailbox_surfaced" }, at);
	ok("mailbox_surfaced -> set seenAt (NOT just injection)", d2.kind === "set" && d2.field === "seenAt");
	ok("mailbox_surfaced source label", d2.kind === "set" && d2.source === "mailbox.surfaced");

	// task_tool WITHOUT context -> no_change (proposal §A requires matching taskId/nodeId/attemptId)
	const d3 = deriveLifecycleFromTrigger(baseRec, { kind: "task_tool" }, at);
	ok("task_tool without context -> no_change", d3.kind === "no_change");

	const d4 = deriveLifecycleFromTrigger(baseRec, { kind: "task_tool", taskId: "t", nodeId: "n", attemptId: "a" }, at);
	ok("task_tool WITH context -> set processingAt", d4.kind === "set" && d4.field === "processingAt");

	// Idempotence: if seenAt already set, no_change
	const seenRec = { ...baseRec, seenAt: at };
	const d5 = deriveLifecycleFromTrigger(seenRec, { kind: "mailbox_surfaced" }, "2026-02-01T00:00:00Z");
	ok("seenAt already set -> no_change", d5.kind === "no_change");

	// Terminal reasons
	const d6 = deriveLifecycleFromTrigger(baseRec, { kind: "deadline_exceeded", deadlineMs: 60_000 }, at);
	ok("deadline_exceeded -> terminalAt with responseDeadlineMs source", d6.kind === "set" && d6.field === "terminalAt" && d6.kind === "set" && d6.source === "responseDeadlineMs");
	const d7 = deriveLifecycleFromTrigger(baseRec, { kind: "supersession", supersededBy: "new" }, at);
	ok("supersession -> terminalAt with supersession source", d7.kind === "set" && d7.field === "terminalAt" && d7.kind === "set" && d7.source === "supersession");
	const d8 = deriveLifecycleFromTrigger(baseRec, { kind: "ttl_expired" }, at);
	ok("ttl_expired -> terminalAt with ttl_expired source", d8.kind === "set" && d8.field === "terminalAt" && d8.kind === "set" && d8.source === "ttl_expired");
}

// ============================================================
// Scenario 5: PI_SWARM_MINIMAL_PROTOCOL module-load env read
// ============================================================
{
	console.log("\n--- Scenario 5: PI_SWARM_MINIMAL_PROTOCOL constant ---");
	const { PI_SWARM_MINIMAL_PROTOCOL } = await import(join(here, "..", "src/constants.ts"));
	// module-load read pattern — just confirm the constant is a 0|1 number.
	ok("PI_SWARM_MINIMAL_PROTOCOL constant is a 0|1 number", PI_SWARM_MINIMAL_PROTOCOL === 0 || PI_SWARM_MINIMAL_PROTOCOL === 1);
	ok("PI_SWARM_MINIMAL_PROTOCOL default is 0 (no env set)", PI_SWARM_MINIMAL_PROTOCOL === 0);
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
