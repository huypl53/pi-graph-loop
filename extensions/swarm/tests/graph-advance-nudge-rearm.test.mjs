#!/usr/bin/env node
/**
 * Issue F2 (task-202608310422): graph-advance nudge re-arm — seq-suffixed idempotency key.
 *
 * The pre-fix `sendGraphAdvanceNudgeLocked` used a static per-(taskId, nodeId) notify key, so after
 * a deferral ack the next reconcile tick passed the cap + cooldown + in-flight gates but the
 * eventual `deliverMessageLocked` dedupe on `from + to + idempotencyKey` returned the original
 * acked message (`message.idempotent_reuse`). The orchestrator mailbox received exactly one nudge
 * per node for the node's lifetime.
 *
 * The fix: NOTIFY_KEY_GRAPH_ADVANCE carries a `{seq}` slot; the seq advances per successful emit
 * only; each emit gets a fresh dedupe slot. Cap + cooldown semantics are unchanged
 * (`NOTIFY_DEFAULT_MAX_NUDGES=3`, `NOTIFY_DEFAULT_COOLDOWN_MS=5min`).
 *
 * Invariants under test (each case is a real `withLock`-held invocation against
 * `reconcileGraphAdvanceLocked` over a scratch state, mirroring the pattern in
 * lifecycle-fencing.test.mjs):
 *   1. First send emits seq:1; the seq is stamped in `st.graphAdvanceNudgeState[taskId][nodeId]`;
 *      the `graph.advance_nudge_emitted` trace is recorded with `seq:1`.
 *   2. Deferral ack + cooldown elapsed -> next reconcile emits a NEW record under key :seq:2;
 *      distinct id from the seq:1 record; `message.idempotent_reuse` is NOT traced for the seq:2
 *      emit (the bug under test).
 *   3. Cooldown skip -> no seq:2 record; cap math unchanged.
 *   4. Monotonic seq: seeded seq:1 + seq:2 records (both acked, both > cooldown ago) -> next
 *      reconcile emits seq:3; durable seq store at 3.
 *   5. Cap 3 holds: three acked prior records > cooldown ago -> no new record; seq stays at 3.
 *   6. Same-tick dedupe: two reconcile calls in the same `withLock` block produce exactly 1 record.
 *   7. Node leaves ready -> perNode.lastResolvedAt stamped, nudgeSeq preserved.
 */
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), `swarm-graph-advance-rearm-${process.pid}-${Date.now()}`));
await mkdir(join(scratch, ".pi"), { recursive: true });
await mkdir(join(scratch, ".pi/swarm/tasks"), { recursive: true });
await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
await mkdir(join(scratch, ".pi/swarm/traces"), { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) { pass++; } else { fail++; console.error("  FAIL:", name, info ?? ""); } };

// ---- scratch fixtures ----
const TASK_ID = "task-graph-advance-rearm";
const NODE_ID = "plan";

async function writeStateFile(state) {
	const p = join(scratch, ".pi/swarm/swarm-state.json");
	await writeFile(p, JSON.stringify(state, null, 2));
}
async function readStateFile() {
	const p = join(scratch, ".pi/swarm/swarm-state.json");
	try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; }
}
async function readTaskFile(taskId = TASK_ID) {
	const p = join(scratch, `.pi/swarm/tasks/${taskId}/task.json`);
	try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; }
}
async function writeTask(task) {
	const tp = join(scratch, `.pi/swarm/tasks/${task.taskId}`);
	await mkdir(tp, { recursive: true });
	await mkdir(join(tp, "artifacts"), { recursive: true });
	await writeFile(join(tp, "task.json"), JSON.stringify(task, null, 2));
	await writeFile(join(tp, "task.md"), `# ${task.taskId}`);
	await writeFile(join(tp, "events.jsonl"), "");
}
async function readEvents(taskId = TASK_ID) {
	const p = join(scratch, `.pi/swarm/tasks/${taskId}/events.jsonl`);
	const txt = await readFile(p, "utf8").catch(() => "");
	return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
async function readGlobalEvents() {
	const p = join(scratch, ".pi/swarm/traces/events.jsonl");
	const txt = await readFile(p, "utf8").catch(() => "");
	return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
async function readOrchestratorMailbox() {
	const p = join(scratch, ".pi/swarm/mailboxes/orchestrator.jsonl");
	const txt = await readFile(p, "utf8").catch(() => "");
	return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function freshState(overrides = {}) {
	const base = {
		version: 1, swarmId: "test-f2", cwd: scratch,
		tmuxSession: "test-f2",
		agents: {
			"orchestrator": {
				id: "orchestrator", role: "orchestrator", roleKind: "orchestrator", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 99,
				status: "running", runtimeStatus: "idle", health: "healthy",
				tmuxSession: "test-f2", tmuxWindow: "orch", tmuxTarget: "test-f2:orch.0",
				model: "glm-5.1", provider: "zai-coding-cn", cwd: scratch,
				mailbox: ".pi/swarm/mailboxes/orchestrator.jsonl",
				createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
			},
		},
		delivered: {},
		messages: {},
		...overrides,
	};
	return base;
}

function freshTask(taskId = TASK_ID, nodeId = NODE_ID, nodeOverrides = {}) {
	return {
		version: 1, taskId, title: "test-f2", goal: "test-f2",
		status: "in_progress", priority: "normal",
		createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		owner: "orchestrator", workflow: "feature-dev",
		allowedFiles: [], acceptanceCriteria: [], validationCommands: [],
		start: nodeId, currentNodes: [nodeId],
		sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
		nodes: {
			[nodeId]: {
				status: "ready", role: "planner", dependsOn: [], readArtifacts: [], writeArtifacts: [],
				messageIds: [], attempts: 0, maxAttempts: 1,
				...nodeOverrides,
			},
		},
		edges: [], handoffs: [], gates: {}, editLocks: {}, evidence: {},
	};
}

// ---- load extension + capture handles ----
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

async function loadExtension({ identity = "orchestrator" } = {}) {
	process.env.PI_SWARM_AGENT_ID = identity;
	const handlers = {};
	const commands = {};
	const tools = {};
	const pi = {
		registerTool: (def) => { tools[def.name] = def; },
		registerCommand: (name, def) => { commands[name] = def; },
		on: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
		setModel: async () => true,
		sendMessage: () => {},
		exec: async (cmd, args) => {
			if (cmd === "tmux" && args[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
			return { code: 1, stdout: "", stderr: "" };
		},
	};
	factory(pi);
	return { pi, handlers, tools, commands };
}

async function runReconcile({ identity = "orchestrator" } = {}) {
	const { handlers } = await loadExtension({ identity });
	process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
	const sessionStart = handlers["session_start"][0];
	const ctx = {
		cwd: scratch, mode: "tui", isIdle: () => true, hasUI: false,
		ui: { setStatus: () => {} },
		model: { id: "glm-5.1", provider: "zai-coding-cn" },
	};
	// session_start runs reconcileGraphAdvanceLocked via the pump path. Calling it twice
	// covers both the immediate reconcile and the re-arm across cooldown.
	await sessionStart({}, ctx);
}

async function setupClean({ nodeOverrides = {}, ageMs = 120_000 } = {}) {
	await rm(join(scratch, ".pi"), { recursive: true, force: true });
	await mkdir(join(scratch, ".pi"), { recursive: true });
	await mkdir(join(scratch, ".pi/swarm/tasks"), { recursive: true });
	await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
	await mkdir(join(scratch, ".pi/swarm/traces"), { recursive: true });

	const task = freshTask();
	const created = new Date(Date.now() - ageMs).toISOString();
	task.createdAt = created;
	if (nodeOverrides.status) task.nodes[NODE_ID].status = nodeOverrides.status;
	if (nodeOverrides.assignee !== undefined) task.nodes[NODE_ID].assignee = nodeOverrides.assignee;
	await writeTask(task);

	const st = freshState();
	st.orchestratorLeader = {
		pid: process.pid, sessionStartedAt: new Date().toISOString(),
		claimedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString(),
		agentRecordId: "orchestrator",
	};
	await writeStateFile(st);
}

// Seed a seq-suffixed graph-advance message record under the static-key shape of the fixture/legacy
// state. Returns the seeded messageId. `ackedAt` is optional; `createdAt` defaults to `ageMs` ago.
async function seedGraphAdvanceMessage(st, opts = {}) {
	const { acked = true, ageMs = 600_000, seq = 1, overrideCreatedAt } = opts;
	const id = `msg-f2-seq${seq}-${Math.random().toString(36).slice(2, 8)}`;
	const createdAt = overrideCreatedAt || new Date(Date.now() - ageMs).toISOString();
	st.messages[id] = {
		id, from: "orchestrator", to: "orchestrator", status: acked ? "acked" : "injected",
		createdAt, updatedAt: createdAt,
		injectedAt: acked ? undefined : createdAt,
		ackedAt: acked ? createdAt : undefined,
		attempts: 1, requiresAck: true, requiresResponse: false,
		subject: `Node ${NODE_ID} (planner) is READY but unassigned — advance task ${TASK_ID} now`,
		idempotencyKey: `task:${TASK_ID}:node:${NODE_ID}:nudge:assign:seq:${seq}`,
	};
	return id;
}

// ============================================================================
// Case 1: first send emits seq:1 + stamps graphAdvanceNudgeState + emits trace
// ============================================================================
console.log("\n[C1] first send emits seq:1");
await setupClean();
await runReconcile();
{
	const st = await readStateFile();
	const mailbox = await readOrchestratorMailbox();
	const events = await readGlobalEvents();
	const seqRecs = mailbox.filter((m) => m.idempotencyKey === `task:${TASK_ID}:node:${NODE_ID}:nudge:assign:seq:1`);
	ok("exactly one mailbox record with seq:1 idempotency key", seqRecs.length === 1, `mailbox=${JSON.stringify(mailbox.map(m => m.idempotencyKey))}`);
	ok("durable per-(task,node) seq store stamped to 1", st.graphAdvanceNudgeState?.[TASK_ID]?.[NODE_ID]?.nudgeSeq === 1, `seq=${st.graphAdvanceNudgeState?.[TASK_ID]?.[NODE_ID]?.nudgeSeq}`);
	ok("per-(task,node) lastNudgeAt stamped", typeof st.graphAdvanceNudgeState?.[TASK_ID]?.[NODE_ID]?.lastNudgeAt === "string");
	ok("graph.advance_nudge_emitted trace recorded with seq:1", events.some((e) => e.event === "graph.advance_nudge_emitted" && e.seq === 1 && e.taskId === TASK_ID && e.nodeId === NODE_ID));
}

// ============================================================================
// Case 2: deferral ack + cooldown elapsed -> second emit under seq:2 (new id)
// ============================================================================
console.log("\n[C2] deferral ack + cooldown elapsed -> seq:2 record (distinct id)");
{
	const st = await readStateFile();
	// Mark the seq:1 record as acked (the deferral scenario) + push its createdAt > cooldown ago.
	const seq1Id = Object.keys(st.messages).find((id) => st.messages[id].idempotencyKey === `task:${TASK_ID}:node:${NODE_ID}:nudge:assign:seq:1`);
	ok("seeded seq:1 record exists", !!seq1Id);
	if (seq1Id) {
		st.messages[seq1Id] = {
			...st.messages[seq1Id],
			status: "acked",
			ackedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			createdAt: new Date(Date.now() - 10 * 60_000).toISOString(), // 10 min ago > cooldown (5 min)
		};
	}
	await writeStateFile(st);
}
await runReconcile();
{
	const mailbox = await readOrchestratorMailbox();
	const events = await readGlobalEvents();
	const st = await readStateFile();
	const seq1Recs = mailbox.filter((m) => m.idempotencyKey === `task:${TASK_ID}:node:${NODE_ID}:nudge:assign:seq:1`);
	const seq2Recs = mailbox.filter((m) => m.idempotencyKey === `task:${TASK_ID}:node:${NODE_ID}:nudge:assign:seq:2`);
	ok("seq:1 record still present (1)", seq1Recs.length === 1);
	ok("seq:2 record emitted (1)", seq2Recs.length === 1, `mailbox=${JSON.stringify(mailbox.map(m => m.idempotencyKey))}`);
	ok("seq:2 has a distinct id from seq:1", seq1Recs[0]?.id !== seq2Recs[0]?.id);
	ok("seq:2 record requiresAck=true (orchestrator must ack the re-arm)", seq2Recs[0]?.requiresAck === true);
	ok("durable seq store advanced to 2", st.graphAdvanceNudgeState?.[TASK_ID]?.[NODE_ID]?.nudgeSeq === 2);
	ok("graph.advance_nudge_emitted trace recorded with seq:2", events.some((e) => e.event === "graph.advance_nudge_emitted" && e.seq === 2 && e.taskId === TASK_ID && e.nodeId === NODE_ID));
	// Critical: the bug under test was that the second emit was short-circuited by
	// findIdempotentMessage and traced as `message.idempotent_reuse`. After the fix, no such trace
	// fires for the seq:2 emit.
	const seq2MsgId = seq2Recs[0]?.id;
	const seq2Reuse = events.filter((e) => e.event === "message.idempotent_reuse" && e.id === seq2MsgId && e.idempotencyKey?.endsWith(":seq:2"));
	ok("no `message.idempotent_reuse` trace for the seq:2 emit (the bug)", seq2Reuse.length === 0, `reuse events=${JSON.stringify(seq2Reuse)}`);
}

// ============================================================================
// Case 3: cooldown skip — createdAt within cooldown -> no seq:3 record
// ============================================================================
console.log("\n[C3] cooldown skip — seq:2 within cooldown -> no seq:3");
{
	const st = await readStateFile();
	// Push seq:2's createdAt within the cooldown window.
	const seq2Id = Object.keys(st.messages).find((id) => st.messages[id].idempotencyKey === `task:${TASK_ID}:node:${NODE_ID}:nudge:assign:seq:2`);
	if (seq2Id) {
		st.messages[seq2Id] = {
			...st.messages[seq2Id],
			status: "acked",
			ackedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			createdAt: new Date(Date.now() - 30_000).toISOString(), // 30s ago < 5min cooldown
		};
	}
	await writeStateFile(st);
}
await runReconcile();
{
	const mailbox = await readOrchestratorMailbox();
	const seq3Recs = mailbox.filter((m) => m.idempotencyKey === `task:${TASK_ID}:node:${NODE_ID}:nudge:assign:seq:3`);
	ok("no seq:3 record while seq:2 is within cooldown", seq3Recs.length === 0, `mailbox=${JSON.stringify(mailbox.map(m => m.idempotencyKey))}`);
	const st = await readStateFile();
	ok("durable seq store stays at 2", st.graphAdvanceNudgeState?.[TASK_ID]?.[NODE_ID]?.nudgeSeq === 2);
}

// ============================================================================
// Case 4: monotonic seq — both seq:1 + seq:2 acked and > cooldown ago -> seq:3
// ============================================================================
console.log("\n[C4] monotonic seq: prior seq:1 + seq:2 acked + > cooldown -> seq:3");
{
	const st = await readStateFile();
	for (const seq of [1, 2]) {
		const id = Object.keys(st.messages).find((k) => st.messages[k].idempotencyKey === `task:${TASK_ID}:node:${NODE_ID}:nudge:assign:seq:${seq}`);
		if (id) {
			st.messages[id] = {
				...st.messages[id],
				status: "acked",
				ackedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
			};
		}
	}
	await writeStateFile(st);
}
await runReconcile();
{
	const mailbox = await readOrchestratorMailbox();
	const seq3Recs = mailbox.filter((m) => m.idempotencyKey === `task:${TASK_ID}:node:${NODE_ID}:nudge:assign:seq:3`);
	ok("seq:3 record emitted (1)", seq3Recs.length === 1);
	const st = await readStateFile();
	ok("durable seq store advanced to 3", st.graphAdvanceNudgeState?.[TASK_ID]?.[NODE_ID]?.nudgeSeq === 3);
}

// ============================================================================
// Case 5: cap 3 holds — 3 prior acked records > cooldown -> no new record
// ============================================================================
console.log("\n[C5] cap 3 holds — three prior acked records > cooldown -> no new record");
{
	const st = await readStateFile();
	for (const seq of [1, 2, 3]) {
		const id = Object.keys(st.messages).find((k) => st.messages[k].idempotencyKey === `task:${TASK_ID}:node:${NODE_ID}:nudge:assign:seq:${seq}`);
		if (id) {
			st.messages[id] = {
				...st.messages[id],
				status: "acked",
				ackedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
			};
		}
	}
	await writeStateFile(st);
}
await runReconcile();
{
	const mailbox = await readOrchestratorMailbox();
	const seq4Recs = mailbox.filter((m) => m.idempotencyKey === `task:${TASK_ID}:node:${NODE_ID}:nudge:assign:seq:4`);
	ok("no seq:4 record when cap reached (3 prior)", seq4Recs.length === 0);
	const st = await readStateFile();
	ok("durable seq store stays at 3 (cap reached)", st.graphAdvanceNudgeState?.[TASK_ID]?.[NODE_ID]?.nudgeSeq === 3);
}

// ============================================================================
// Case 6: same-tick dedupe — two reconciles in the same withLock block produce 1 record
// ============================================================================
console.log("\n[C6] same-tick dedupe — two reconcile calls in same session_start produce exactly 1 record");
await setupClean();
{
	const st = await readStateFile();
	// Two reconcile invocations back-to-back in the same tick must not double-emit.
	// session_start is the single entry point; calling it twice simulates two pump ticks
	// in the same async microtask burst (which is the worst-case for the seq guard).
	await loadExtension({ identity: "orchestrator" });
	process.env.PI_SWARM_IS_ORCHESTRATOR = "1";
	const { handlers } = await loadExtension({ identity: "orchestrator" });
	const sessionStart = handlers["session_start"][0];
	const ctx = {
		cwd: scratch, mode: "tui", isIdle: () => true, hasUI: false,
		ui: { setStatus: () => {} },
		model: { id: "glm-5.1", provider: "zai-coding-cn" },
	};
	await sessionStart({}, ctx);
	await sessionStart({}, ctx);
}
{
	const mailbox = await readOrchestratorMailbox();
	const seq1Recs = mailbox.filter((m) => m.idempotencyKey === `task:${TASK_ID}:node:${NODE_ID}:nudge:assign:seq:1`);
	const st = await readStateFile();
	ok("exactly one seq:1 record across two reconcile calls in same tick", seq1Recs.length === 1, `count=${seq1Recs.length}`);
	ok("durable seq store stayed at 1 (no double-advance)", st.graphAdvanceNudgeState?.[TASK_ID]?.[NODE_ID]?.nudgeSeq === 1);
}

// ============================================================================
// Case 7: node leaves ready -> perNode.lastResolvedAt stamped, nudgeSeq preserved
// ============================================================================
console.log("\n[C7] node leaves ready -> lastResolvedAt stamped, nudgeSeq preserved");
{
	const st = await readStateFile();
	// First emit (already happened in case 6) — confirm pre-state.
	ok("pre-state: seq=1", st.graphAdvanceNudgeState?.[TASK_ID]?.[NODE_ID]?.nudgeSeq === 1);

	// Mark the node as assigned so the actionable predicate no longer matches it.
	const task = await readTaskFile();
	task.nodes[NODE_ID].status = "assigned";
	task.nodes[NODE_ID].assignee = "worker-x";
	await writeTask(task);
}
await runReconcile();
{
	const st = await readStateFile();
	ok("durable seq store preserved at 1 (NOT reset)", st.graphAdvanceNudgeState?.[TASK_ID]?.[NODE_ID]?.nudgeSeq === 1);
	ok("per-(task,node) lastResolvedAt stamped", typeof st.graphAdvanceNudgeState?.[TASK_ID]?.[NODE_ID]?.lastResolvedAt === "string");

	// Confirm any outstanding seq:1 nudge was auto-acked (the else-branch path).
	const seq1Recs = Object.values(st.messages || {}).filter((m) => m.idempotencyKey === `task:${TASK_ID}:node:${NODE_ID}:nudge:assign:seq:1`);
	ok("seq:1 record auto-acked after node left ready", seq1Recs.length >= 1 && seq1Recs.every((r) => !!r.ackedAt), `seq1=${JSON.stringify(seq1Recs.map((r) => ({ id: r.id, ackedAt: r.ackedAt })))}`);
}

// Restore env
delete process.env.PI_SWARM_AGENT_ID;
delete process.env.PI_SWARM_IS_ORCHESTRATOR;

console.log(`\nGRAPH-ADVANCE-NUDGE-REARM ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
