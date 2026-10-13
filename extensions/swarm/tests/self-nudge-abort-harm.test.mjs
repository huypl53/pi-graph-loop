// self-nudge abort harm — RED reproduction of the 2026-10-13 live incident
// (workflow-agents root session 01a1241f, worker p9-deploy-nested-supervisor).
//
// Incident chain (ms-level evidence from .pi/swarm/traces/events.jsonl + the worker's own
// session jsonl):
//   12:08:42.92  worker's swarm_update_task throws TASK_NOT_FOUND (closure intent)
//   12:08:42.95  nudges/update-failure.ts classifies "closure" → enqueues a priority:high
//                SELF-nudge (from == to == worker)
//   12:08:44.18  tmux inject lands in the worker pane mid-turn
//   12:08:44.22  toolResult (TASK_NOT_FOUND) reaches the model — abort is NOT killing a tool
//   12:08:44.25  input_intercept → Issue-86 path (isHigh && midTurn) → ctx.abort()
//   12:08:44.29  agent settles idle; the beheaded turn WAS the report turn (the worker had
//                already announced "Per rule 6, I stop here and capture")
//   ...13 minutes of dead air — the re-queued followUp never wakes the agent...
//   12:21:10     an UNRELATED 15-min taskless backstop wakes the pane
//
// TWO stacked bugs under test:
//   BUG A (abort harm): a priority-high SELF-nudge (from === to === me) takes the Issue-86
//        interrupt path and ctx.abort()s the recipient's in-flight turn. A self-nudge is
//        engine-generated guidance about a failure the model is about to see anyway (the
//        failing tool result is already in the same turn); interrupting the turn destroys
//        exactly the continuation that would act on it. Expected post-fix behavior:
//        NO ctx.abort() for from===me; deliver as followUp (mid-turn) or steer (idle).
//
//   BUG B (status masking): after the abort the agent settles, lastToolAt was stamped by the
//        very swarm_update_task call that failed, so deriveTaskProgressState reports "active"
//        for up to 60s while the agent is idle — root reads "active" and ignores the closure
//        notice. Expected post-fix surface: the aborted-turn fact is visible (lastAbortAt /
//        interrupt marker on the agent record) so status can surface it.
//
// Pattern: real registerSwarmHooks factory + captured pi.on handlers (same harness as
// high-priority-interrupt.test.mjs). NO fixture echoes. Real durable state assertions.
//
// Run: node extensions/swarm/tests/self-nudge-abort-harm.test.mjs

import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info ?? "");
	}
};

// === scratch world (same shape as high-priority-interrupt.test.mjs) ===
async function setupScratch(identity) {
	const scratch = await mkdtemp(join(tmpdir(), `swarm-snah-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`));
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
				runtimeStatus: "busy", // mid-turn when the self-nudge lands
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
	return txt
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

function buildSwarmMsg({ id, from, to, priority = "normal", subject = "test", body = "test body" }) {
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
		requiresAck: false,
		headers: {},
	};
}

function buildSystemDelivery(msg) {
	const payload = Buffer.from(JSON.stringify(msg), "utf8").toString("base64");
	return `[PI-SWARM SYSTEM MESSAGE] b64:${payload} [/PI-SWARM SYSTEM MESSAGE]`;
}

async function loadExtension(identity) {
	process.env.PI_SWARM_AGENT_ID = identity;
	process.env.PI_SWARM_TERMINAL_MANAGER = "tmux";
	const handlers = {};
	const tools = {};
	const commands = {};
	const sentMessages = [];
	const pi = {
		registerTool: (def) => {
			tools[def.name] = def;
		},
		registerCommand: (name, def) => {
			commands[name] = def;
		},
		on: (ev, fn) => {
			(handlers[ev] ||= []).push(fn);
		},
		setModel: async () => true,
		sendMessage: (m, o) => {
			sentMessages.push({ m, o });
		},
		exec: async (cmd, args) => {
			if (cmd === "tmux" && (args[0] === "display-message" || args[0] === "list-panes")) return { code: 0, stdout: "%1\n", stderr: "" };
			if (cmd === "herdr") return { code: 0, stdout: "test:0\n", stderr: "" };
			return { code: 1, stdout: "", stderr: "" };
		},
	};
	factory(pi);
	return { pi, handlers, tools, commands, sentMessages };
}

async function driveInput(handlers, msg, { isIdle = false, ctxOverrides = {} } = {}) {
	const inputHandlers = handlers["input"] || [];
	if (inputHandlers.length === 0) throw new Error("no input handler registered");
	const event = { source: "user", text: buildSystemDelivery(msg) };
	let abortCallCount = 0;
	const ctx = {
		cwd: msg.testScratch,
		isIdle: () => isIdle,
		abort: async () => {
			abortCallCount++;
		},
		...ctxOverrides,
	};
	const result = await inputHandlers[inputHandlers.length - 1](event, ctx);
	return { result, abortCallCount, ctx };
}

const WORKER = "p9-deploy-nested-supervisor";

// =============================================================================
// BUG A — priority-high SELF-nudge (from === to === me) mid-turn must NOT ctx.abort()
// =============================================================================
console.log("\n[A] self-nudge (from==to==me) mid-turn: must not ctx.abort(); followUp instead");
{
	const scratch = await setupScratch(WORKER);
	const { handlers, sentMessages } = await loadExtension(WORKER);
	const msg = buildSwarmMsg({
		id: "msg-1791893322939-3b295c9a",
		from: WORKER, // SELF-nudge — engine-generated via nudges/update-failure.ts
		to: WORKER,
		priority: "high",
		subject: "[Swarm] swarm_update_task failed (closure, TASK_NOT_FOUND)",
		body: "Your swarm_update_task call failed (closure-intent class, streak 1, errorCode TASK_NOT_FOUND).",
	});
	msg.testScratch = scratch;
	const { abortCallCount } = await driveInput(handlers, msg, { isIdle: false });

	// RED assertion: today this is 1 (the incident). Post-fix it must be 0.
	ok("self-nudge mid-turn does NOT ctx.abort() the recipient turn", abortCallCount === 0, `abortCallCount=${abortCallCount}`);

	const events = await readEvents(scratch);
	const requested = events.filter((e) => e.event === "message.interrupt_requested");
	ok("no message.interrupt_requested trace for a self-nudge", requested.length === 0, `got ${requested.length}`);

	// The guidance must still reach the model: followUp (mid-turn) or steer (idle).
	const followUp = sentMessages.find((s) => s.o?.deliverAs === "followUp");
	ok(
		"self-nudge still delivered as followUp so the next-turn boundary consumes it",
		Boolean(followUp),
		`sentMessages=${JSON.stringify(sentMessages.map((s) => ({ ct: s.m?.customType, d: s.o?.deliverAs })))}`,
	);
	const state = await readState(scratch);
	const rec = state.messages?.[msg.id];
	ok("durable record: message intercepted and recorded", Boolean(rec), "no message record in state");
}

// Control: the interruption path must stay intact for a directive from ANOTHER agent
// (root STOP). This proves the fix did not lobotomize Issue 86.
console.log("\n[A-ctrl] root-origin high directive mid-turn: interrupt path stays armed");
{
	const scratch = await setupScratch(WORKER);
	const { handlers } = await loadExtension(WORKER);
	const msg = buildSwarmMsg({ id: "msg-ctrl-root-stop", from: "root", to: WORKER, priority: "high", subject: "STOP", body: "Stop now" });
	msg.testScratch = scratch;
	const { abortCallCount } = await driveInput(handlers, msg, { isIdle: false });
	ok("root STOP mid-turn still ctx.abort()s (Issue 86 intact)", abortCallCount === 1, `abortCallCount=${abortCallCount}`);
}

// Control: peer-origin (different worker) high directive mid-turn also keeps the path.
console.log("\n[A-ctrl2] peer-origin high directive mid-turn: interrupt path stays armed");
{
	const scratch = await setupScratch(WORKER);
	const { handlers } = await loadExtension(WORKER);
	const msg = buildSwarmMsg({
		id: "msg-ctrl-peer",
		from: "p9-final-nested-review",
		to: WORKER,
		priority: "high",
		subject: "STOP",
		body: "Reviewer verdict changed; stop deploying.",
	});
	msg.testScratch = scratch;
	const { abortCallCount } = await driveInput(handlers, msg, { isIdle: false });
	ok("peer STOP mid-turn still ctx.abort()s", abortCallCount === 1, `abortCallCount=${abortCallCount}`);
}

// Control: self-nudge with priority normal mid-turn -> followUp, abort 0
console.log("\n[A-ctrl3] self-nudge normal priority mid-turn: followUp and no abort");
{
	const scratch = await setupScratch(WORKER);
	const { handlers, sentMessages } = await loadExtension(WORKER);
	const msg = buildSwarmMsg({
		id: "msg-self-normal",
		from: WORKER,
		to: WORKER,
		priority: "normal",
		subject: "[Swarm] info",
		body: "normal priority note",
	});
	msg.testScratch = scratch;
	const { abortCallCount } = await driveInput(handlers, msg, { isIdle: false });
	ok("self-nudge normal priority mid-turn does not abort", abortCallCount === 0, `abortCallCount=${abortCallCount}`);
	const followUp = sentMessages.find((s) => s.o?.deliverAs === "followUp");
	ok("self-nudge normal priority delivered as followUp", Boolean(followUp));
}

// =============================================================================
// BUG A2 — idle recipient: a self-nudge must STEER (turn-triggering delivery), never abort
// =============================================================================
console.log("\n[A2] self-nudge while idle: steer only (no abort)");
{
	const scratch = await setupScratch(WORKER);
	const { handlers } = await loadExtension(WORKER);
	const msg = buildSwarmMsg({
		id: "msg-self-idle",
		from: WORKER,
		to: WORKER,
		priority: "high",
		subject: "[Swarm] swarm_update_task failed (closure, TASK_NOT_FOUND)",
		body: "dangling done-in-head worker — report via swarm_send_message",
	});
	msg.testScratch = scratch;
	const { abortCallCount } = await driveInput(handlers, msg, { isIdle: true });
	ok("self-nudge while idle does NOT abort", abortCallCount === 0, `abortCallCount=${abortCallCount}`);
	const state = await readState(scratch);
	ok("idle self-nudge still recorded durably", Boolean(state.messages?.[msg.id]), "no message record");
}

// =============================================================================
// BUG B — post-abort visibility: the agent record must carry the interrupt fact
// =============================================================================
console.log("\n[B] post-abort visibility: aborted-turn fact must be durable + derivable");
{
	const scratch = await setupScratch(WORKER);
	const { handlers, tools } = await loadExtension(WORKER);
	// A root-origin high STOP mid-turn (the legitimate interrupt) → then the record must show it.
	const msg = buildSwarmMsg({ id: "msg-b-root-stop", from: "root", to: WORKER, priority: "high", subject: "STOP", body: "Stop" });
	msg.testScratch = scratch;
	await driveInput(handlers, msg, { isIdle: false });

	const state = await readState(scratch);
	const agent = state.agents[WORKER];
	ok(
		"agent record stamps lastAbortAt/lastInterruptAt after an effective interrupt (RED: missing today)",
		Boolean(agent?.lastInterruptAt || agent?.lastAbortAt),
		"no interrupt timestamp on the agent record — status output cannot surface the aborted turn",
	);

	// And the derive function must not call an idle-just-aborted agent "active" purely off
	// lastToolAt stamped by the tool that triggered the whole cascade.
	const { deriveTaskProgressState } = await import(join(here, "..", "src", "agents.ts"));
	const agentRow = JSON.parse(JSON.stringify(agent));
	agentRow.runtimeStatus = "idle"; // settled after the abort
	agentRow.lastToolAt = new Date(Date.now() - 5_000).toISOString(); // the failed update_task call
	agentRow.lastHeartbeatAt = new Date(Date.now() - 5_000).toISOString();
	const derived = deriveTaskProgressState(agentRow, state, {
		nowMs: Date.now(),
		artifactMtimeMs: null,
		tmuxAlive: true,
	});
	ok(
		'idle agent with fresh lastToolAt but a JUST-ABORTED turn derives NOT "active" (RED: derives active today)',
		derived !== "active",
		`derived=${derived} — root saw exactly this masking in the incident`,
	);

	// Verify swarm_agent_status output surfaces why and interruptedAgo
	const statusTool = tools["swarm_agent_status"];
	ok("swarm_agent_status tool registered", Boolean(statusTool));
	if (statusTool) {
		// Simulate agent settlement post-abort: runtimeStatus becomes idle with fresh heartbeat
		const liveState = await readState(scratch);
		liveState.agents[WORKER].runtimeStatus = "idle";
		liveState.agents[WORKER].lastHeartbeatAt = new Date().toISOString();
		await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(liveState, null, 2));

		const res = await statusTool.execute("test-call", { agentId: WORKER }, undefined, undefined, { cwd: scratch });
		const parsed = JSON.parse(res.content?.[0]?.text || "{}");
		const workerRow = parsed.agents?.[0];
		ok("status row contains interruptedAgo", Boolean(workerRow?.interruptedAgo), `interruptedAgo=${workerRow?.interruptedAgo}`);
		ok("status row why reflects turn aborted", String(workerRow?.why).includes("turn aborted"), `why=${workerRow?.why}`);
	}
}

// =============================================================================
// FIX C — wake-loss protection with ctx.waitForIdle
// =============================================================================
console.log("\n[C] root STOP mid-turn with ctx.waitForIdle: delivers as steer");
{
	const scratch = await setupScratch(WORKER);
	const { handlers, sentMessages } = await loadExtension(WORKER);
	const msg = buildSwarmMsg({ id: "msg-c-root-stop", from: "root", to: WORKER, priority: "high", subject: "STOP", body: "Stop now" });
	msg.testScratch = scratch;
	let waitForIdleCalled = false;
	const { abortCallCount } = await driveInput(handlers, msg, {
		isIdle: false,
		ctxOverrides: {
			waitForIdle: async () => {
				waitForIdleCalled = true;
			},
		},
	});
	ok("root STOP abortCallCount is 1", abortCallCount === 1, `abortCallCount=${abortCallCount}`);
	ok("waitForIdle was called", waitForIdleCalled);
	ok("exactly one message sent", sentMessages.length === 1);
	ok("message deliverAs is steer", sentMessages[0]?.o?.deliverAs === "steer");
	ok("message triggerTurn is true", sentMessages[0]?.o?.triggerTurn === true);
}

console.log("\n[C-degrade] root STOP mid-turn when waitForIdle throws: degrades to followUp and logs error");
{
	const scratch = await setupScratch(WORKER);
	const { handlers, sentMessages } = await loadExtension(WORKER);
	const msg = buildSwarmMsg({ id: "msg-c-degrade", from: "root", to: WORKER, priority: "high", subject: "STOP", body: "Stop now" });
	msg.testScratch = scratch;
	const { abortCallCount } = await driveInput(handlers, msg, {
		isIdle: false,
		ctxOverrides: {
			waitForIdle: async () => {
				throw new Error("simulated waitForIdle failure");
			},
		},
	});
	ok("root STOP abortCallCount is 1 on degrade", abortCallCount === 1, `abortCallCount=${abortCallCount}`);
	ok("exactly one message sent on degrade", sentMessages.length === 1);
	ok("message deliverAs degrades to followUp", sentMessages[0]?.o?.deliverAs === "followUp");
	ok("message triggerTurn is true on degrade", sentMessages[0]?.o?.triggerTurn === true);

	// Verify error log in .pi/swarm/traces/errors.jsonl
	const errLogPath = join(scratch, ".pi", "swarm", "traces", "errors.jsonl");
	const errContent = await readFile(errLogPath, "utf8").catch(() => "");
	ok("errors.jsonl contains wait_for_idle_failed", errContent.includes("wait_for_idle_failed"), `errContent=${errContent}`);
}

console.log(`\n${pass} passed, ${fail} failed${fail > 0 ? " (RED — bug reproduced)" : " (GREEN)"}`);
process.exit(fail > 0 ? 1 : 0);
