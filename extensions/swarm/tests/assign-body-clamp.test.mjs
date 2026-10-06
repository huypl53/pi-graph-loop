#!/usr/bin/env node
// assign-body-clamp.test.mjs — F4 follow-up red tests (task-fu-assign-clamp, reviewer-05 finding A)
//
// swarm_assign_task embeds an UNCLAMPED message body: params.note (agent-controllable free
// text) is folded into the assignment body by buildAssignmentBody(...) and delivered verbatim
// by deliverMessageLocked — same L1 risk class as the F4 finding (unbounded mailbox line →
// reader RSS amplification). A root agent calling swarm_assign_task with a 2 MB note
// persists a 2 MB mailbox line TODAY.
//
// RED symptoms (pre-fix, observed before any source change):
//   [R1] an oversized note (2x the 4KB test cap) on swarm_assign_task SUCCEEDS instead of
//        throwing MESSAGE_BODY_TOO_LARGE (with formatted size, cap, and env-var name);
//   [R2] the oversized assignment IS persisted (mailbox JSONL line + st.messages record +
//        node mutation) instead of rejected with nothing persisted;
//   [R4] an oversized re-assignment on an active assignment succeeds; prior state not intact;
//   [R5] a composed body whose size comes from TASK content (giant acceptanceCriteria seeded
//        directly into task.json, bypassing create-tool params) persists instead of being
//        clamped by the post-buildAssignmentBody defensive site.
//
// GREEN contract (post-fix), mirroring mailbox-body-clamp.test.mjs for swarm_send_message:
//   - Site 1 (execute boundary, right after requireRootAuthority): params.note rejected with
//     MESSAGE_BODY_TOO_LARGE BEFORE any lock/read/write;
//   - Site 2 (right after buildAssignmentBody, pre-deliver, pre-write): composed assignment
//     body rejected with MESSAGE_BODY_TOO_LARGE; nothing persisted (no task.json write, no
//     mailbox append, fencing/supersession counters untouched in-memory, lock released);
//   - [R3] in-cap control assigns succeed: attempt minted, assignmentMessageId set, 1 mailbox
//     line, receipt/msg.id returned;
//   - [R6] R10-1 zero-crossing: pi.sendMessage call count === 0 across rejected + in-cap
//     assigns (the clamp adds NO new Pi-runtime boundary crossing).
//
// DEVIATION from mailbox-body-clamp.test.mjs (documented in plan §4): this suite pins
// process.env.PI_SWARM_MESSAGE_BODY_MAX_BYTES = "4096" BEFORE the dynamic import instead of
// SKIPping — env-tunability is already proven by mailbox-body-clamp [6]; this suite pins the
// assign boundary. Safe because run-suites.mjs isolates each suite in its own process.
//
// Run: node extensions/swarm/tests/assign-body-clamp.test.mjs
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Pin the cap at process boot, BEFORE the dynamic import below: constants.ts reads
// PI_SWARM_MESSAGE_BODY_MAX_BYTES at module load.
const CAP = 4096;
process.env.PI_SWARM_MESSAGE_BODY_MAX_BYTES = String(CAP);

const scratch = mkdtempSync(join(tmpdir(), `swarm-assgnclamp-${process.pid}-`));
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi", "swarm"), { recursive: true });

process.env.PI_SWARM_AGENT_ID = "root";
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;
if (typeof factory !== "function") throw new Error("no default export");

// R10-1 counting stub: count calls at the REAL mock-pi sendMessage boundary.
let piSendMessageCalls = 0;
const tools = {};
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	sendMessage: () => {
		piSendMessageCalls++;
		return {};
	},
};
factory(pi);

let pass = 0,
	fail = 0;
const ok = (n, c, info) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n, info ?? "");
	}
};

const call = async (name, params) => {
	const t = tools[name];
	if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: scratch });
};

// Seed: root pseudo-agent + one worker, like mailbox-body-clamp.test.mjs.
writeFileSync(
	join(scratch, ".pi", "swarm", "swarm-state.json"),
	JSON.stringify(
		{
			version: 1,
			swarmId: "assignclamp-test",
			cwd: scratch,
			tmuxSession: "x",
			agents: {
				root: { id: "root", role: "root", roleKind: "root", status: "running", runtimeStatus: "idle", tmuxPane: "%0" },
				"clamp-worker": { id: "clamp-worker", role: "worker", roleKind: "worker", status: "running", runtimeStatus: "idle", tmuxPane: "%1" },
			},
			delivered: {},
			messages: {},
			rootPumpSessions: {},
		},
		null,
		2,
	),
);

const mailboxFile = join(scratch, ".pi", "swarm", "mailboxes", "clamp-worker.jsonl");
const mailboxLines = () => (existsSync(mailboxFile) ? readFileSync(mailboxFile, "utf8").split("\n").filter(Boolean).length : 0);
const readStMessages = () => {
	const st = JSON.parse(readFileSync(join(scratch, ".pi", "swarm", "swarm-state.json"), "utf8"));
	return Object.keys(st.messages || {}).length;
};

// ---- task under test: two nodes (plan, implement) like the fixture graphs ----
const ct = await call("swarm_create_task", {
	title: "Assign body clamp",
	goal: "Exercise the swarm_assign_task body clamp (F4 follow-up).",
	cwd: scratch,
	start: "plan",
	nodes: {
		plan: { role: "planner", writeArtifacts: ["artifacts/plan.md"] },
		implement: { role: "implementer", dependsOn: ["plan"] },
	},
	edges: [{ from: "plan", to: "implement", when: "planned" }],
});
const taskId = ct.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];
const taskJsonPath = join(scratch, ".pi", "swarm", "tasks", taskId, "task.json");
const readTask = () => JSON.parse(readFileSync(taskJsonPath, "utf8"));
ok("setup: task created", existsSync(taskJsonPath));

// ===========================================================================
console.log("\n[R1] oversized note rejected with MESSAGE_BODY_TOO_LARGE");
{
	const oversized = "N".repeat(2 * CAP); // 2x-cap note under the test cap
	let threw = null;
	try {
		await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "clamp-worker", note: oversized });
	} catch (err) {
		threw = err;
	}
	ok(
		"assign throws with MESSAGE_BODY_TOO_LARGE",
		threw !== null && String(threw.message).includes("MESSAGE_BODY_TOO_LARGE"),
		threw ? `wrong error: ${String(threw.message).slice(0, 160)}` : "no throw — oversized note accepted",
	);
	ok(
		"error carries formatted actual size, cap, and env var name",
		threw !== null &&
			String(threw.message).includes("8.0KB") &&
			String(threw.message).includes("4.0KB") &&
			String(threw.message).includes("PI_SWARM_MESSAGE_BODY_MAX_BYTES"),
		threw ? `message=${String(threw.message).slice(0, 240)}` : "no throw",
	);
}

// ===========================================================================
console.log("\n[R2] nothing persisted after the rejected assign (oversized note)");
{
	ok("mailbox JSONL has 0 lines (no append)", mailboxLines() === 0, `lines=${mailboxLines()}`);
	ok("st.messages unchanged (0 records)", readStMessages() === 0, `records=${readStMessages()}`);
	const node = readTask().nodes.plan;
	ok("node plan still ready + unassigned", node.status === "ready" && !node.assignee, `status=${node.status}`);
	ok("no attempt minted", !(node.attemptHistory || []).length && !node.activeAttemptId);
	ok("no handoffs recorded", !(readTask().handoffs || []).length);
}

// ===========================================================================
console.log("\n[R3] in-cap control assign succeeds with attempt + mailbox line");
{
	let result = null;
	let threw = null;
	try {
		result = await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "clamp-worker", note: "small note" });
	} catch (err) {
		threw = err;
	}
	ok("in-cap assign does not throw", threw === null, threw ? String(threw.message).slice(0, 160) : "");
	const node = readTask().nodes.plan;
	ok("node assigned to clamp-worker", node.assignee === "clamp-worker", `assignee=${node.assignee}`);
	ok("attempt minted", !!node.activeAttemptId && (node.attemptHistory || []).length === 1);
	ok("assignmentMessageId set", !!node.assignmentMessageId);
	ok("mailbox JSONL has exactly 1 line", mailboxLines() === 1, `lines=${mailboxLines()}`);
	ok("st.messages has exactly 1 record", readStMessages() === 1, `records=${readStMessages()}`);
	ok("result carries message id", Boolean(result?.details?.messageId));
}

// ===========================================================================
console.log("\n[R4] oversized note after an active assignment rejected + prior state intact");
{
	const before = readTask();
	const beforeLines = mailboxLines();
	const oversized = "N".repeat(2 * CAP);
	let threw = null;
	try {
		await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "clamp-worker", note: oversized });
	} catch (err) {
		threw = err;
	}
	ok(
		"re-assign with oversized note throws MESSAGE_BODY_TOO_LARGE",
		threw !== null && String(threw.message).includes("MESSAGE_BODY_TOO_LARGE"),
		threw ? `wrong error: ${String(threw.message).slice(0, 160)}` : "no throw — oversized note accepted",
	);
	const after = readTask();
	ok("mailbox line count unchanged", mailboxLines() === beforeLines, `lines=${mailboxLines()} vs ${beforeLines}`);
	ok("attempt id unchanged", after.nodes.plan.activeAttemptId === before.nodes.plan.activeAttemptId);
	ok("st.messages record count unchanged", readStMessages() === 1, `records=${readStMessages()}`);
}

// ===========================================================================
console.log("\n[R5] composed-body clamp (site 2): giant task content + tiny note");
{
	// Giant acceptanceCriteria is seeded DIRECTLY into task.json, bypassing create-tool params;
	// only the post-buildAssignmentBody defensive site can bound this composed body.
	// R5 needs a FRESH assignable node: implement becomes ready once plan closes with
	// outcome "planned". The reply fence requires the ASSIGNEE (clamp-worker) to reply to
	// the assignment message first (mirror of attempt-fencing.test.mjs awaitAs)...
	const prev = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = "clamp-worker";
	try {
		const assignmentMsgId = readTask().nodes.plan.assignmentMessageId;
		await call("swarm_send_message", { to: "root", replyTo: assignmentMsgId, body: "result for R5" });
	} finally {
		process.env.PI_SWARM_AGENT_ID = prev;
	}
	await call("swarm_update_task", { taskId, nodeId: "plan", status: "done", outcome: "planned", force: true, cwd: scratch });
	const tf = JSON.parse(readFileSync(taskJsonPath, "utf8"));
	// Giant task-content channel folded into the composed body by buildAssignmentBody.
	// (Pre-merge the giant acceptanceCriteria echo carried this; master's Ergonomics Fix 2
	// trimmed that echo to a one-liner, so the site-2 repro now seeds giant artifact lists
	// on the target node — still task.json content, still only boundable post-compose.)
	tf.nodes.implement.writeArtifacts = Array.from({ length: 24 }, (_, i) => `artifacts/r5-giant-report-${"Z".repeat(Math.ceil((2 * CAP) / 24))}-${i}.md`);
	writeFileSync(taskJsonPath, JSON.stringify(tf, null, 2));

	// Byte-identity baselines for the reject-nothing-persisted proof (root review round 1):
	// every durable state surface is snapshotted before the rejected assign and must be
	// byte-identical after it. Trace JSONL (events.jsonl/errors.jsonl) is EXCLUDED by design:
	// plan §10 explicitly classifies pre-site-2 trace calls as trace-only, non-state.
	const beforeRecords = readStMessages();
	const beforeTask = readFileSync(taskJsonPath, "utf8");
	const beforeState = readFileSync(join(scratch, ".pi", "swarm", "swarm-state.json"), "utf8");
	const beforeLines = mailboxLines();
	let threw = null;
	try {
		await call("swarm_assign_task", { taskId, nodeId: "implement", agentId: "clamp-worker", note: "tiny" });
	} catch (err) {
		threw = err;
	}
	ok(
		"composed oversized body throws MESSAGE_BODY_TOO_LARGE",
		threw !== null && String(threw.message).includes("MESSAGE_BODY_TOO_LARGE"),
		threw ? `wrong error: ${String(threw.message).slice(0, 160)}` : "no throw — composed oversized body accepted",
	);
	ok(
		"nothing persisted for the rejected composed body",
		mailboxLines() === beforeLines &&
			readStMessages() === beforeRecords &&
			readFileSync(taskJsonPath, "utf8") === beforeTask &&
			readFileSync(join(scratch, ".pi", "swarm", "swarm-state.json"), "utf8") === beforeState,
		`lines=${mailboxLines()} vs ${beforeLines}; records=${readStMessages()} vs ${beforeRecords}; task/state JSON byte-differs`,
	);
	// Semantic fallbacks (byte identity above covers these, kept as explicit contract rows):
	ok("node implement untouched (pending, unassigned, no attempt history)", readTask().nodes.implement.status === "pending" && !readTask().nodes.implement.assignee && !(readTask().nodes.implement.attemptHistory || []).length);
	// Shrink back so later cases see a sane graph.
	const tf2 = JSON.parse(readFileSync(taskJsonPath, "utf8"));
	tf2.acceptanceCriteria = [];
	writeFileSync(taskJsonPath, JSON.stringify(tf2, null, 2));
}

// ===========================================================================
console.log("\n[R6] R10-1 zero-crossing: no pi.sendMessage calls across rejected + in-cap assigns");
ok(`pi.sendMessage call count === 0 (got ${piSendMessageCalls})`, piSendMessageCalls === 0);

rmSync(scratch, { recursive: true, force: true });
console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
