// Issue 86 — priority-high interrupt-on-delivery. The recipient-side `pi.on("input", ...)` hook
// must call `ctx.abort()` when a `priority: "high"` swarm message is intercepted mid-turn, so
// urgent directives are consumed at the next-turn boundary instead of sitting intercepted for
// 20+ minutes (live incident 2026-08-31: STOP sat 23 min before manual tmux Escape).
//
// Guardrails under test:
//   - High + mid-turn + first in window  → ctx.abort() once + interrupt_requested/effective traces
//   - High + mid-turn + second in window → suppressed (no abort) + interrupt_suppressed trace
//   - High + mid-turn + second after window → abort again
//   - High + idle → steer (existing behavior, no abort)
//   - Normal + mid-turn → followUp (existing behavior, no abort)
//   - Normal + idle → steer (existing behavior, no abort)
//   - ctx.abort() throws → graceful degrade (interrupt_failed trace + still queue followUp)
//   - PI_SWARM_HIGH_INTERRUPT_WINDOW_MS env override → honored
//
// Pattern: real `registerSwarmHooks(pi)` factory + captured `pi.on` handlers. NO fixture echoes,
// NO function-only assertions. Real durable state assertions (swarm-state.json + events.jsonl).
//
// Run: node extensions/swarm/high-priority-interrupt.test.mjs

import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) { pass++; console.log("  ok  ", name); } else { fail++; console.error("  FAIL", name, info ?? ""); } };

// Build a scratch dir + minimal swarm state with the recipient agent registered.
async function setupScratch(identity) {
	const scratch = await mkdtemp(join(tmpdir(), `swarm-hpi-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
	await mkdir(join(scratch, ".pi", "swarm"), { recursive: true });
	const now = new Date().toISOString();
	const state = {
		version: 1,
		swarmId: "test",
		cwd: scratch,
		tmuxSession: "test",
		agents: {
			[identity]: {
				id: identity,
				role: "worker",
				roleKind: "worker",
				capabilities: [],
				activeTaskIds: [],
				maxConcurrentTasks: 1,
				status: "running",
				runtimeStatus: "idle",
				health: "healthy",
				tmuxSession: "test",
				tmuxWindow: identity,
				tmuxTarget: `test:${identity}.0`,
				model: "glm-5.1",
				provider: "zai-coding-cn",
				cwd: scratch,
				mailbox: `.pi/swarm/mailboxes/${identity}.jsonl`,
				createdAt: now,
				updatedAt: now,
			},
		},
		delivered: {},
		messages: {},
		createdAt: now,
		updatedAt: now,
	};
	await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(state, null, 2));
	return scratch;
}

async function readState(scratch) {
	return JSON.parse(await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
}
async function readEvents(scratch) {
	const txt = await readFile(join(scratch, ".pi/swarm/traces/events.jsonl"), "utf8").catch(() => "");
	return txt.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
async function writeEvents(scratch, events) {
	await mkdir(join(scratch, ".pi/swarm/traces"), { recursive: true });
	await writeFile(join(scratch, ".pi/swarm/traces/events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function buildSwarmMsg({ id, from = "orchestrator", to, priority = "normal", subject = "test", body = "test body" }) {
	return {
		id,
		swarmId: "test",
		from,
		to,
		subject,
		priority,
		type: "swarm.message",
		schemaVersion: 1,
		createdAt: new Date().toISOString(),
		body,
		requiresAck: true,
		headers: {},
	};
}

function buildSystemDelivery(msg) {
	const payload = Buffer.from(JSON.stringify(msg), "utf8").toString("base64");
	return `[PI-SWARM SYSTEM MESSAGE] b64:${payload} [/PI-SWARM SYSTEM MESSAGE]`;
}

// Load the extension with a captured mock pi.
async function loadExtension(identity) {
	process.env.PI_SWARM_AGENT_ID = identity;
	const handlers = {};
	const tools = {};
	const commands = {};
	const sentMessages = [];
	const pi = {
		registerTool: (def) => { tools[def.name] = def; },
		registerCommand: (name, def) => { commands[name] = def; },
		on: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
		setModel: async () => true,
		sendMessage: (m, o) => { sentMessages.push({ m, o }); },
		exec: async (cmd, args) => {
			if (cmd === "tmux" && args[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
			return { code: 1, stdout: "", stderr: "" };
		},
	};
	factory(pi);
	return { pi, handlers, tools, commands, sentMessages };
}

// Drive the input handler with a synthetic event + ctx.
async function driveInput(handlers, msg, { isIdle = false, abortShouldThrow = false } = {}) {
	const inputHandlers = handlers["input"] || [];
	if (inputHandlers.length === 0) throw new Error("no input handler registered");
	const event = {
		source: "user", // anything other than "extension" passes the gate
		text: buildSystemDelivery(msg),
	};
	let abortCallCount = 0;
	let lastAbortError = null;
	const ctx = {
		cwd: msg.testScratch,
		isIdle: () => isIdle,
		abort: async () => {
			abortCallCount++;
			if (abortShouldThrow) {
				lastAbortError = new Error("simulated abort failure");
				throw lastAbortError;
			}
		},
	};
	const result = await inputHandlers[inputHandlers.length - 1](event, ctx);
	return { result, abortCallCount, lastAbortError, ctx };
}

const RECIPIENT = "worker-a";

// =============================================================================
// CASE 1: High priority + mid-turn + first in window → interrupt path
// =============================================================================
console.log("\n[C1] high priority mid-turn first-in-window: ctx.abort() called once, traces emitted, durable lastHighInterruptAt populated");
{
	const scratch = await setupScratch(RECIPIENT);
	const { handlers } = await loadExtension(RECIPIENT);
	const msg = buildSwarmMsg({ id: "msg-c1", to: RECIPIENT, priority: "high", subject: "STOP", body: "Stop now" });
	msg.testScratch = scratch;
	const { abortCallCount } = await driveInput(handlers, msg, { isIdle: false });
	ok("ctx.abort() called exactly once", abortCallCount === 1, `got ${abortCallCount}`);
	const events = await readEvents(scratch);
	const requested = events.find((e) => e.event === "message.interrupt_requested");
	const effective = events.find((e) => e.event === "message.interrupt_effective");
	ok("message.interrupt_requested trace emitted", !!requested, JSON.stringify(events.map((e) => e.event)));
	ok("message.interrupt_effective trace emitted", !!effective, JSON.stringify(events.map((e) => e.event)));
	ok("requested trace has msg.id", requested?.id === "msg-c1");
	ok("effective trace has msg.id", effective?.id === "msg-c1");
	ok("requested trace has agentId", requested?.agentId === RECIPIENT);
	ok("effective trace has agentId", effective?.agentId === RECIPIENT);
	const st = await readState(scratch);
	const self = st.agents[RECIPIENT];
	ok("agent.lastHighInterruptAt populated", !!self?.lastHighInterruptAt, JSON.stringify(self));
	const recent = Date.now() - new Date(self.lastHighInterruptAt).getTime();
	ok("agent.lastHighInterruptAt is within 5s of now", recent < 5_000, `${recent}ms ago`);
}

// =============================================================================
// CASE 2: High priority + mid-turn + second within window → suppressed
// =============================================================================
console.log("\n[C2] high priority mid-turn second-in-window: NO abort, interrupt_suppressed trace, message still queued");
{
	const scratch = await setupScratch(RECIPIENT);
	const { handlers } = await loadExtension(RECIPIENT);
	// First inject — interrupts
	const msg1 = buildSwarmMsg({ id: "msg-c2-1", to: RECIPIENT, priority: "high" });
	msg1.testScratch = scratch;
	await driveInput(handlers, msg1, { isIdle: false });
	const events1 = await readEvents(scratch);
	ok("first inject: interrupt_effective trace present", events1.some((e) => e.event === "message.interrupt_effective" && e.id === "msg-c2-1"));
	// Second inject within window — must be suppressed
	const msg2 = buildSwarmMsg({ id: "msg-c2-2", to: RECIPIENT, priority: "high" });
	msg2.testScratch = scratch;
	const { abortCallCount } = await driveInput(handlers, msg2, { isIdle: false });
	ok("second inject: ctx.abort() NOT called again", abortCallCount === 0, `got ${abortCallCount}`);
	const events2 = await readEvents(scratch);
	const suppressed = events2.find((e) => e.event === "message.interrupt_suppressed" && e.id === "msg-c2-2");
	ok("second inject: message.interrupt_suppressed trace emitted", !!suppressed, JSON.stringify(events2.map((e) => e.event)));
	ok("suppressed trace has reason=rate_limited", suppressed?.reason === "rate_limited");
	ok("suppressed trace has windowMs=30000 (default)", suppressed?.windowMs === 30_000);
	// Verify only ONE interrupt_effective (from msg-c2-1)
	const effectives = events2.filter((e) => e.event === "message.interrupt_effective");
	ok("exactly ONE interrupt_effective total", effectives.length === 1, `got ${effectives.length}`);
}

// =============================================================================
// CASE 3: High priority + mid-turn + second AFTER window → interrupt again
// =============================================================================
console.log("\n[C3] high priority mid-turn second-after-window: ctx.abort() called again, lastHighInterruptAt updated");
{
	const scratch = await setupScratch(RECIPIENT);
	// Pre-populate lastHighInterruptAt to 31s ago via direct state write (simulating elapsed window).
	const st0 = await readState(scratch);
	st0.agents[RECIPIENT].lastHighInterruptAt = new Date(Date.now() - 31_000).toISOString();
	await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(st0, null, 2));
	const { handlers } = await loadExtension(RECIPIENT);
	const msg = buildSwarmMsg({ id: "msg-c3", to: RECIPIENT, priority: "high" });
	msg.testScratch = scratch;
	const { abortCallCount } = await driveInput(handlers, msg, { isIdle: false });
	ok("after window: ctx.abort() called once", abortCallCount === 1, `got ${abortCallCount}`);
	const events = await readEvents(scratch);
	ok("after window: interrupt_effective trace emitted", events.some((e) => e.event === "message.interrupt_effective" && e.id === "msg-c3"));
	ok("after window: NO interrupt_suppressed trace", !events.some((e) => e.event === "message.interrupt_suppressed"));
	const st = await readState(scratch);
	const recent = Date.now() - new Date(st.agents[RECIPIENT].lastHighInterruptAt).getTime();
	ok("after window: agent.lastHighInterruptAt refreshed", recent < 5_000, `${recent}ms ago`);
}

// =============================================================================
// CASE 4: High priority + idle → steer (existing behavior, no abort)
// =============================================================================
console.log("\n[C4] high priority IDLE: NO abort, steer behavior preserved");
{
	const scratch = await setupScratch(RECIPIENT);
	const { handlers } = await loadExtension(RECIPIENT);
	const msg = buildSwarmMsg({ id: "msg-c4", to: RECIPIENT, priority: "high" });
	msg.testScratch = scratch;
	const { abortCallCount } = await driveInput(handlers, msg, { isIdle: true });
	ok("idle: ctx.abort() NOT called", abortCallCount === 0, `got ${abortCallCount}`);
	const events = await readEvents(scratch);
	ok("idle: NO interrupt_requested trace", !events.some((e) => e.event === "message.interrupt_requested"));
	ok("idle: NO interrupt_effective trace", !events.some((e) => e.event === "message.interrupt_effective"));
}

// =============================================================================
// CASE 5: Normal priority + mid-turn → followUp (existing behavior, no abort)
// =============================================================================
console.log("\n[C5] normal priority mid-turn: NO abort, followUp behavior preserved");
{
	const scratch = await setupScratch(RECIPIENT);
	const { handlers, sentMessages } = await loadExtension(RECIPIENT);
	const msg = buildSwarmMsg({ id: "msg-c5", to: RECIPIENT, priority: "normal" });
	msg.testScratch = scratch;
	const { abortCallCount } = await driveInput(handlers, msg, { isIdle: false });
	ok("normal mid-turn: ctx.abort() NOT called", abortCallCount === 0, `got ${abortCallCount}`);
	ok("normal mid-turn: pi.sendMessage called with deliverAs=followUp", sentMessages.some((s) => s.o?.deliverAs === "followUp"));
	const events = await readEvents(scratch);
	ok("normal mid-turn: NO interrupt_requested trace", !events.some((e) => e.event === "message.interrupt_requested"));
}

// =============================================================================
// CASE 6: Normal priority + idle → steer (existing behavior, no abort)
// =============================================================================
console.log("\n[C6] normal priority IDLE: NO abort, steer behavior preserved");
{
	const scratch = await setupScratch(RECIPIENT);
	const { handlers, sentMessages } = await loadExtension(RECIPIENT);
	const msg = buildSwarmMsg({ id: "msg-c6", to: RECIPIENT, priority: "normal" });
	msg.testScratch = scratch;
	const { abortCallCount } = await driveInput(handlers, msg, { isIdle: true });
	ok("normal idle: ctx.abort() NOT called", abortCallCount === 0);
	ok("normal idle: pi.sendMessage called with deliverAs=steer", sentMessages.some((s) => s.o?.deliverAs === "steer"));
}

// =============================================================================
// CASE 7: ctx.abort() throws → graceful degrade
// =============================================================================
console.log("\n[C7] ctx.abort() throws: interrupt_failed trace, message still queued as followUp");
{
	const scratch = await setupScratch(RECIPIENT);
	const { handlers, sentMessages } = await loadExtension(RECIPIENT);
	const msg = buildSwarmMsg({ id: "msg-c7", to: RECIPIENT, priority: "high" });
	msg.testScratch = scratch;
	const { abortCallCount } = await driveInput(handlers, msg, { isIdle: false, abortShouldThrow: true });
	ok("abort threw but was attempted once", abortCallCount === 1, `got ${abortCallCount}`);
	const events = await readEvents(scratch);
	const failed = events.find((e) => e.event === "message.interrupt_failed" && e.id === "msg-c7");
	ok("interrupt_failed trace emitted", !!failed, JSON.stringify(events.map((e) => e.event)));
	ok("interrupt_failed trace has error string", !!failed?.error && /simulated abort failure/.test(failed.error));
	ok("interrupt_failed: NO interrupt_effective trace", !events.some((e) => e.event === "message.interrupt_effective"));
	// Message still queued — graceful degrade
	ok("graceful degrade: pi.sendMessage called with deliverAs=followUp", sentMessages.some((s) => s.o?.deliverAs === "followUp" && s.m?.details?.id === "msg-c7"));
}

// =============================================================================
// CASE 8: PI_SWARM_HIGH_INTERRUPT_WINDOW_MS env override → honored
// =============================================================================
console.log("\n[C8] PI_SWARM_HIGH_INTERRUPT_WINDOW_MS=2000: second inject within 2s suppressed, after 2.1s not");
{
	const prevEnv = process.env.PI_SWARM_HIGH_INTERRUPT_WINDOW_MS;
	process.env.PI_SWARM_HIGH_INTERRUPT_WINDOW_MS = "2000";
	try {
		const scratch = await setupScratch(RECIPIENT);
		const { handlers } = await loadExtension(RECIPIENT);
		// First inject — interrupts
		const msg1 = buildSwarmMsg({ id: "msg-c8-1", to: RECIPIENT, priority: "high" });
		msg1.testScratch = scratch;
		await driveInput(handlers, msg1, { isIdle: false });
		// Second inject immediately — must be suppressed (window=2s)
		const msg2 = buildSwarmMsg({ id: "msg-c8-2", to: RECIPIENT, priority: "high" });
		msg2.testScratch = scratch;
		const r2 = await driveInput(handlers, msg2, { isIdle: false });
		ok("within 2s window: ctx.abort() NOT called", r2.abortCallCount === 0);
		const events = await readEvents(scratch);
		const suppressed = events.find((e) => e.event === "message.interrupt_suppressed" && e.id === "msg-c8-2");
		ok("within 2s window: interrupt_suppressed trace with windowMs=2000", suppressed?.windowMs === 2_000, `got ${suppressed?.windowMs}`);
		// Advance the ledger by overwriting lastHighInterruptAt to 3s ago (simulating elapsed window)
		const st = await readState(scratch);
		st.agents[RECIPIENT].lastHighInterruptAt = new Date(Date.now() - 3_000).toISOString();
		await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(st, null, 2));
		// Third inject — must interrupt
		const msg3 = buildSwarmMsg({ id: "msg-c8-3", to: RECIPIENT, priority: "high" });
		msg3.testScratch = scratch;
		const r3 = await driveInput(handlers, msg3, { isIdle: false });
		ok("after 2s+ window: ctx.abort() called", r3.abortCallCount === 1);
		const events2 = await readEvents(scratch);
		ok("after 2s+ window: interrupt_effective trace emitted (msg-c8-3)", events2.some((e) => e.event === "message.interrupt_effective" && e.id === "msg-c8-3"));
	} finally {
		if (prevEnv === undefined) delete process.env.PI_SWARM_HIGH_INTERRUPT_WINDOW_MS;
		else process.env.PI_SWARM_HIGH_INTERRUPT_WINDOW_MS = prevEnv;
	}
}

console.log(`\nHIGH-PRIORITY-INTERRUPT ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
