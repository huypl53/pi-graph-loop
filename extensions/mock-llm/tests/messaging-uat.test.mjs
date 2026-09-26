#!/usr/bin/env node
/**
 * Per-fixture scenario driver — extensions/mock-llm/fixtures/messaging-uat.jsonl
 *
 * Domain 3 (messaging) UAT lane. Streams the fixture end-to-end via streamMockLLM, executes
 * the captured toolcalls against the REAL swarm tool handlers in a fresh scratch `.pi/swarm`
 * tree (with a seeded task for the stale-attempt close), and asserts:
 *
 *   M1  fixture registers + all scripted toolcalls captured (send/ack-required, stale close,
 *       3-message R30 burst).
 *   M2  requiresAck message enqueued durably (root mailbox JSONL record + message record).
 *   M3  stale-attempt close REFUSED (supersession/late-result fence) — the stale attemptId is
 *       not the node's activeAttemptId; node NOT closed; message.late_result_rejected traced
 *       (the fence the fixture's stale turn was authored to violate pre-fix).
 *   M4  R30 coalescing: the 3 burst messages surface via the REAL pumpRootMailbox as exactly
 *       ONE pi.sendMessage batch call (swarm-batch-message) at the real boundary — not 3.
 *   M5  ack ledger: message record carries requiresAck:true and no ackedAt (awaiting root).
 *   M6  (R10-1 boundary) pump delivery counted at the REAL pi.sendMessage boundary:
 *       batch call count == 1, batch ids length == 3.
 *   M7  deterministic replay — second stream yields identical captured sequence.
 *
 * RED mode (UAT_RED=1): seeds the node WITHOUT a newer active attempt (the pre-fence shape:
 * stale attemptId IS the active one) so the "stale" close lands — asserting the fence's absence
 * is observable (node closed by the stale attempt = the red artifact).
 *
 * Run: node extensions/mock-llm/tests/messaging-uat.test.mjs
 */

import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const swarmRoot = join(here, "..", "..", "swarm");
const RED = process.env.UAT_RED === "1";
const STAMP =
	process.env.UAT_STAMP ||
	`uat-${new Date()
		.toISOString()
		.replace(/[-:.TZ]/g, "")
		.slice(0, 15)}`;
const RUN_DIR = process.env.UAT_RUN_DIR || join(process.cwd(), ".pi", "swarm-uat", "runs", STAMP, "messaging");
mkdirSync(RUN_DIR, { recursive: true });

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

// --- scratch + real extension wiring ---
const scratch = mkdtempSync(join(tmpdir(), `swarm-uat-msg-${process.pid}-${Date.now()}`));
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";

const sentAtBoundary = []; // R10-1: real pi.sendMessage calls (pump boundary)
const pi = {
	registerTool: () => {},
	registerCommand: () => {},
	on: () => {},
	sendMessage: (msg, opts) => {
		sentAtBoundary.push({ msg, opts });
	},
	exec: async (cmd, args) => {
		if (cmd === "tmux") {
			if (args[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
			if (args[0] === "capture-pane") return { code: 0, stdout: "pi swarm session\n", stderr: "" };
			if (
				[
					"send-keys",
					"kill-window",
					"kill-pane",
					"has-session",
					"list-panes",
					"list-windows",
					"new-window",
					"new-session",
				].includes(args[0])
			)
				return { code: 0, stdout: "", stderr: "" };
		}
		if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	},
};

const { paths, ensureDirs, defaultState, writeState, readState } = await import(join(swarmRoot, "src", "state.ts"));
const { ensureRoot, heartbeatRootLeader } = await import(join(swarmRoot, "src", "identity.ts"));
const p = paths(scratch);
await ensureDirs(p);
{
	const st = defaultState(scratch);
	ensureRoot(st, scratch, p);
	heartbeatRootLeader(st, Date.now(), process.pid, "uat_msg");
	const nowIso = new Date().toISOString();
	st.agents["worker-msg"] = {
		id: "worker-msg",
		role: "worker",
		roleKind: "implementer",
		capabilities: [],
		activeTaskIds: ["task-uatmessaging"],
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		lastHeartbeatAt: nowIso,
		lastSessionStartAt: nowIso,
		tmuxTarget: "uatsess:msg.0",
		mailbox: ".pi/swarm/mailboxes/worker-msg.jsonl",
		createdAt: nowIso,
		updatedAt: nowIso,
		cwd: scratch,
	};
	await writeState(p, st);
}

// seed the task the fixture's stale close targets
const TASK_ID = "task-uatmessaging";
const taskDir = join(p.tasksDir, TASK_ID);
mkdirSync(taskDir, { recursive: true });
const nowIso = new Date().toISOString();
const task = {
	version: 1,
	taskId: TASK_ID,
	title: "UAT messaging",
	goal: "fixture target task",
	status: "in_progress",
	priority: "normal",
	createdAt: nowIso,
	updatedAt: nowIso,
	owner: "root",
	workflow: "feature-dev",
	start: "n1",
	currentNodes: ["n1"],
	nodes: {
		n1: {
			status: "in_progress",
			role: "implementer",
			dependsOn: [],
			assignee: "worker-msg",
			attempts: 2,
			attemptHistory: [
				{
					attemptId: "attempt-stale-uat",
					attemptNumber: 1,
					assignee: "worker-msg",
					assignedAt: nowIso,
					status: "superseded",
					supersededAt: nowIso,
					releasedAt: nowIso,
					releaseReason: "reassign",
				},
				{
					attemptId: "attempt-active-uat",
					attemptNumber: 2,
					assignee: "worker-msg",
					assignedAt: nowIso,
					status: "active",
					lastActivityAt: nowIso,
				},
			],
			activeAttemptId: RED ? "attempt-stale-uat" : "attempt-active-uat", // RED: stale IS active (pre-fence shape)
			evidence: {},
			createdAt: nowIso,
			updatedAt: nowIso,
			outcome: null,
			lastActivityAt: nowIso,
		},
	},
	edges: [],
	handoffs: [],
	gates: {},
	sharedContext: { summary: "", decisions: [], risks: [], openQuestions: [] },
	evidence: {},
	qualification: { mode: "auto", status: "ready", artifact: null, preparedAt: nowIso },
	reworkConsumption: [],
};
if (RED) {
	// pre-fence shape: the stale attempt is ALSO marked active (the supersession fence's absence)
	task.nodes.n1.attemptHistory[0].status = "active";
	task.nodes.n1.attemptHistory.pop(); // no newer attempt
}
writeFileSync(join(taskDir, "task.json"), JSON.stringify(task, null, 2) + "\n");

const readTask = () => JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
const rootMailboxPath = join(scratch, ".pi", "swarm", "mailboxes", "root.jsonl");
const readRootMailbox = () => {
	try {
		return readFileSync(rootMailboxPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
};

// --- stream the fixture ---
const { streamMockLLM, resetMockLLMCursor } = await import(join(here, "..", "src", "stream.ts"));
const FIXTURE_MODEL = "messaging-uat";
const MODEL = { id: FIXTURE_MODEL, provider: "mock-llm", api: "mock-llm-stream" };
const makeContext = () => ({
	systemPrompt: "messaging-uat driver",
	messages: [{ role: "user", content: "run messaging UAT" }],
	tools: ["swarm_send_message", "swarm_update_task"].map((name) => ({
		name,
		description: name,
		parameters: { type: "object", properties: {} },
	})),
});
const streamOnce = async () => {
	resetMockLLMCursor(FIXTURE_MODEL);
	const evs = [];
	const s = streamMockLLM(MODEL, makeContext());
	for await (const ev of s) evs.push(ev);
	const result = await s.result();
	return {
		evs,
		result,
		calls: evs
			.filter((e) => e.type === "toolcall_end" && e.toolCall)
			.map((e) => ({ name: e.toolCall.name, arguments: e.toolCall.arguments })),
	};
};
const { evs, result, calls: captured } = await streamOnce();
ok("M1a: fixture streamed to stop", result.stopReason === "stop", `stop=${result.stopReason}`);
ok("M1b: all scripted toolcalls captured (5)", captured.length === 5, `count=${captured.length}`);
writeFileSync(join(RUN_DIR, "fixture-captured.json"), JSON.stringify(captured, null, 2) + "\n");

// --- M2: execute the requiresAck send against the REAL tool ---
const mod = await import(`${join(swarmRoot, "index.ts")}?cb=${Date.now()}-${Math.random()}`);
const factory = mod.default;
const tools = {};
const pi2 = {
	...pi,
	registerTool: (def) => {
		tools[def.name] = def;
	},
};
factory(pi2);
const call = async (name, params, agentId = "root") => {
	const prev = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = agentId;
	try {
		const t = tools[name];
		if (!t) throw new Error("no tool " + name);
		return await t.execute("call", params, undefined, undefined, { cwd: scratch });
	} finally {
		process.env.PI_SWARM_AGENT_ID = prev;
	}
};
const text = (r) => (r && r.content && r.content[0] && r.content[0].text) || "";

const ackSend = captured[0];
ok("M2a: first toolcall is the requiresAck send", ackSend?.name === "swarm_send_message" && ackSend.arguments.requiresAck === true);
const ackRes = await call("swarm_send_message", ackSend.arguments, "worker-msg");
const ackMsgId = text(ackRes).match(/msg-[A-Za-z0-9-]+/)?.[0];
ok("M2b: requiresAck message durably enqueued", !!ackMsgId && readRootMailbox().some((m) => m.id === ackMsgId), ackMsgId);
{
	const st = await readState(p, scratch);
	const rec = st.messages[ackMsgId];
	ok(
		"M5: message record requiresAck:true, unacked",
		rec?.requiresAck === true && !rec.ackedAt,
		JSON.stringify({ requiresAck: rec?.requiresAck, ackedAt: rec?.ackedAt ?? null }),
	);
}

// --- M3: stale-attempt close through the REAL tool ---
const staleClose = captured[1];
ok(
	"M3a: second toolcall is the stale close",
	staleClose?.name === "swarm_update_task" && staleClose.arguments.attemptId === "attempt-stale-uat",
);
const staleRes = await call("swarm_update_task", staleClose.arguments, "worker-msg").catch((e) => e);
const nodeAfter = readTask().nodes.n1;
if (RED) {
	ok(
		"RED: pre-fence shape — the stale close LANDS (no fence present)",
		nodeAfter.status === "done",
		`status=${nodeAfter.status} (this is the violation the fence prevents)`,
	);
} else {
	const refused =
		staleRes instanceof Error ? /SUPERSESSION|superseded|refus/i.test(String(staleRes.message)) : /refus/i.test(text(staleRes));
	ok("M3b: stale-attempt close refused", refused, (staleRes instanceof Error ? String(staleRes.message) : text(staleRes)).slice(0, 140));
	ok("M3c: node NOT closed by the stale attempt", nodeAfter.status !== "done", `status=${nodeAfter.status}`);
	// durable trace: check both the global events.jsonl AND the per-task events (fence traces
	// may land in either depending on the code path)
	const findLateTrace = async () => {
		const pathsToCheck = [join(scratch, ".pi", "swarm", "traces", "events.jsonl"), join(taskDir, "events.jsonl")];
		for (const fp of pathsToCheck) {
			try {
				const t = await (await import("node:fs/promises")).readFile(fp, "utf8");
				if (/message\.late_result_rejected/.test(t)) return true;
			} catch {}
		}
		return false;
	};
	ok("M3d: message.late_result_rejected traced", await findLateTrace(), "no trace found");
}

// --- M4/M6: R30 coalescing at the REAL pump boundary ---
{
	const burst = captured.filter((c) => c.name === "swarm_send_message" && c.arguments.subject?.startsWith("uat burst"));
	ok("M4a: 3 burst messages captured", burst.length === 3, `count=${burst.length}`);
	for (const b of burst) await call("swarm_send_message", b.arguments, "worker-msg");
	const { pumpRootMailbox } = await import(join(swarmRoot, "src", "reconcile.ts"));
	const before = sentAtBoundary.length;
	const ctx = { mode: "tui", cwd: scratch, isIdle: () => true };
	await pumpRootMailbox(pi, ctx, p, "uat_messaging");
	const pumpCalls = sentAtBoundary.slice(before);
	const batchCalls = pumpCalls.filter((c) => c.msg?.customType === "swarm-batch-message");
	ok(
		"M4b: R30 coalescing — burst surfaced as ONE batch pi.sendMessage",
		batchCalls.length === 1,
		`batch=${batchCalls.length} total=${pumpCalls.length}`,
	);
	ok(
		"M6 (R10-1): batch carries the burst ids at the real boundary",
		batchCalls[0]?.msg?.details?.ids?.length >= 3,
		JSON.stringify(batchCalls[0]?.msg?.details?.ids || null),
	);
	ok(
		"M6b: no unbatched per-message sends for the burst",
		pumpCalls.filter((c) => c.msg?.customType === "swarm-message").length === 0,
		`singles=${pumpCalls.filter((c) => c.msg?.customType === "swarm-message").length}`,
	);
}

// --- M7: deterministic replay ---
const second = await streamOnce();
const sig = (cs) => cs.map((c) => `${c.name}:${JSON.stringify(c.arguments)}`).join("|");
ok("M7: deterministic replay", sig(captured) === sig(second.calls));

// ============ report ============
const report = [
	`# messaging UAT lane (${RED ? "RED" : "GREEN"})`,
	``,
	`- stamp: ${STAMP}`,
	`- scratch: ${scratch}`,
	`- fixture: extensions/mock-llm/fixtures/messaging-uat.jsonl`,
	`- results: ${pass} pass, ${fail} fail`,
	`- R10-1 boundary counters: pump pi.sendMessage calls = ${sentAtBoundary.length} (batch=1, ids=3 asserted at the real boundary); late-result fence exercised at the real swarm_update_task boundary`,
].join("\n");
writeFileSync(join(RUN_DIR, `report${RED ? ".red" : ""}.md`), report + "\n");

console.log(`\n[${RED ? "RED" : "GREEN"}] pass=${pass} fail=${fail} -> ${RUN_DIR}`);
if (!process.env.UAT_KEEP_SCRATCH) rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
