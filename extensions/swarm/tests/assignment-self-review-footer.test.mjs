#!/usr/bin/env node
/**
 * assignment-self-review-footer.test.mjs — S2 regression suite
 * (task task-202610131005-task-intent-coach, plan §4).
 *
 * RED-FIRST (AGENTS.md 2026-08-31): written and observed FAILING against HEAD before the
 * formatting.ts source change; the red log is archived under the task artifacts/red/ directory.
 *
 * Contract (plan §2 — prompt-only worker coaching footer, composed by buildAssignmentBody):
 *   The assignment body gains a 2-line self-review footer placed AFTER the note block and
 *   BEFORE the final "When finished:" fencing line, under BOTH PI_SWARM_MINIMAL_PROTOCOL
 *   gates, with byte-identical footer text under both gates:
 *     line 1: restate outcome/deliverable/validation (lightweight intent self-review);
 *     line 2: conditional clarification via a reply to THIS assignment, with waiting framed
 *             as coaching ONLY — no timing units, no engine-pause/enforcement promise
 *             (R15 honesty shape, pi-runtime-contract §3/§10).
 *
 * Templates: mock-llm/tests/assignment-body-contract.test.mjs F1 (real swarm_create_task +
 * swarm_assign_task in a scratch project; body read from the worker mailbox JSONL line for
 * the assignmentMessageId), retired-surface-cleanup.test.mjs §F (per-gate child processes —
 * PI_SWARM_MINIMAL_PROTOCOL is snapshotted at module load, constants.ts), assign-body-clamp
 * (cap interplay), assignment-ergonomics-fix1 (fenced shape via checkStallNotificationStale
 * "superseded_message" staleness — C-3 fenced assignments compose the SAME body).
 *
 * Run: node extensions/swarm/tests/assignment-self-review-footer.test.mjs
 */
import { rmSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const FOOTER_L1 = "Before you start: in one line, restate the intended outcome, the deliverable, and the validation you will run.";
const FOOTER_L2 = "Materially unclear? Reply to this assignment with your specific question before proceeding; otherwise proceed and surface your assumptions in the result message. The engine does not pause for answers — root responds on its own cadence.";

let pass = 0,
	fail = 0;
const ok = (name, cond, info = "") => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info);
	}
};

// Pin the cap at process boot, BEFORE the dynamic import below: constants.ts reads
// PI_SWARM_MESSAGE_BODY_MAX_BYTES at module load (same pattern as assign-body-clamp.test.mjs).
// Safe under run-suites.mjs: each suite runs in its own process with a fresh env copy.
const CAP = 4096;
process.env.PI_SWARM_MESSAGE_BODY_MAX_BYTES = String(CAP);

// ============================== F1: real assignment body ==============================
console.log("F1: real swarm_assign_task body carries the self-review footer");
const scratch = mkdtempSync(join(tmpdir(), `swarm-assign-footer-${process.pid}-`));
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi", "swarm"), { recursive: true });

process.env.PI_SWARM_AGENT_ID = "root";
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

const tools = {};
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	exec: async (cmd, args) => {
		if (cmd === "tmux" && args[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
		if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	},
	sendMessage: () => {},
};
factory(pi);

const call = async (name, params) => {
	const t = tools[name];
	if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: scratch });
};
const as = async (agentId, name, params) => {
	const prev = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = agentId;
	try {
		return await call(name, params);
	} finally {
		process.env.PI_SWARM_AGENT_ID = prev;
	}
};

const statePath = join(scratch, ".pi/swarm/swarm-state.json");
const stateMod = await import(join(here, "..", "src", "state.ts"));
const readStateJson = () => JSON.parse(readFileSync(statePath, "utf8"));

async function ensureWorker(agentId, roleKind) {
	const { registerAgent } = await import(join(here, "..", "src/agents.ts"));
	const { paths, ensureDirs, withLock, readState, writeState } = await import(join(here, "..", "src/state.ts"));
	const p = paths(scratch);
	await ensureDirs(p);
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		await registerAgent(pi, scratch, p, st, {
			tmuxTarget: "unknown",
			role: `test ${roleKind}`,
			roleKind,
			id: agentId,
			inject: false,
		});
		await writeState(p, st);
	});
}

// readBody: mailbox JSONL line is the durable body copy (state records do not carry body).
function readBody(taskId, nodeId, agentId, msgId) {
	const lines = readFileSync(join(scratch, ".pi/swarm/mailboxes", `${agentId}.jsonl`), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter((m) => m && m.id === msgId);
	return (lines.at(-1) || {}).body || "";
}

await call("swarm_create_task", {
	taskId: "task-assign-footer",
	title: "assignment self-review footer",
	goal: "self-review footer repro",
	acceptanceCriteria: ["footer visible in every assignment body"],
	cwd: scratch,
	start: "plan",
	nodes: {
		plan: { role: "planner", dependsOn: [], writeArtifacts: ["artifacts/plan.md"] },
		implement: { role: "implementer", dependsOn: ["plan"], writeArtifacts: ["artifacts/impl.md"] },
	},
	edges: [{ from: "plan", to: "implement", when: "planned" }],
});
await ensureWorker("footer-planner", "planner");
await call("swarm_assign_task", { taskId: "task-assign-footer", nodeId: "plan", agentId: "footer-planner", cwd: scratch });

const taskJson = JSON.parse(readFileSync(join(scratch, ".pi/swarm/tasks/task-assign-footer/task.json"), "utf8"));
const assignMsgId = taskJson.nodes.plan.assignmentMessageId;
const body = readBody("task-assign-footer", "plan", "footer-planner", assignMsgId);

// T-1 — both footer lines present verbatim
ok("T-1.a: footer line 1 (restate outcome/deliverable/validation)", body.includes(FOOTER_L1), body.slice(-600));
ok("T-1.b: footer line 2 (clarify-or-proceed + no-pause honesty)", body.includes(FOOTER_L2), body.slice(-600));

// T-2 — ORDER pin: footer before the fencing close; fencing close stays LAST
{
	const footerIdx = body.indexOf(FOOTER_L1);
	const finishedIdx = body.indexOf("When finished:");
	ok("T-2.a: footer precedes the When finished fencing line", footerIdx >= 0 && finishedIdx >= 0 && footerIdx < finishedIdx, `footer=${footerIdx} finished=${finishedIdx}`);
	const lastNonEmpty = body.split("\n").filter((l) => l.trim().length).at(-1) || "";
	ok("T-2.b: the LAST non-empty body line still starts with 'When finished:'", lastNonEmpty.startsWith("When finished:"), lastNonEmpty.slice(0, 120));
}

// T-3 — existing contract lines intact
ok("T-3.a: replyTo contract line intact", /Reply to THIS assignment message: replyTo=/.test(body), "");
ok("T-3.b: graph summary line intact", /Graph: \d+ done \/ \d+ in-progress \/ \d+ pending/.test(body), "");
ok("T-3.c: scope line intact", /Scope: /.test(body), "");
ok("T-3.d: acceptance pointer line intact", /Acceptance: \d+ criteria/.test(body), "");
ok("T-3.e: attempt token line intact", /Attempt token: attempt-/.test(body), "");
ok("T-3.f: playbook line intact (planner role playbook resolves)", /Role playbook: /.test(body), "");

// T-7 — wording gates on the two new strings (honesty + retired-name hygiene)
{
	const footer = `${FOOTER_L1}\n${FOOTER_L2}`;
	ok("T-7.a: footer carries no timing units", !/\bwithin \d|\b~\d+\s*s\b|\bseconds?\b|\bminutes?\b/i.test(footer), footer);
	ok("T-7.b: footer names no engine enforcement of waiting", !/engine (waits|will wait|pauses until)|waiting is enforced/i.test(footer), footer);
	const swarmTokens = [...footer.matchAll(/\bswarm_[a-z0-9_]+\b/g)].map((m) => m[0]);
	ok("T-7.c: footer is tool-name-free", swarmTokens.length === 0, `tokens=${swarmTokens.join(",")}`);
}

// ==================== T-4: clamp interplay (site 2 still bounds composed bodies) ====================
console.log("\nT-4: composed-body clamp still throws MESSAGE_BODY_TOO_LARGE with the footer in the body");
{
	// Fresh assignable node: implement becomes ready once plan closes (verified reply + done).
	// The terminal close must carry the assignee's real attempt token (ATTEMPT_TOKEN_REQUIRED fence).
	const planAttemptId = JSON.parse(readFileSync(join(scratch, ".pi/swarm/tasks/task-assign-footer/task.json"), "utf8")).nodes.plan.activeAttemptId;
	await as("footer-planner", "swarm_send_message", { to: "root", replyTo: assignMsgId, body: "plan result", cwd: scratch });
	await as("footer-planner", "swarm_update_task", { taskId: "task-assign-footer", nodeId: "plan", status: "done", outcome: "planned", attemptId: planAttemptId, cwd: scratch });
	// Giant task-content channel folded into the composed body by buildAssignmentBody
	// (assign-body-clamp R5 shape: giant writeArtifacts seeded directly into task.json).
	// Sizing: each artifact renders as `.pi/swarm/tasks/<id>/<path>, ` (~390B); 60 items ≈ 23.4KB
	// + ~700B baseline body ≈ 24KB total — far over the 4KiB test cap (PI_SWARM_MESSAGE_BODY_MAX_BYTES),
	// under the 256KiB production default, and |footer delta| ≈ 460B cannot explain it.
	const taskPath = join(scratch, ".pi/swarm/tasks/task-assign-footer/task.json");
	const tf = JSON.parse(readFileSync(taskPath, "utf8"));
	const giant = "Z".repeat(320);
	tf.nodes.implement.writeArtifacts = Array.from({ length: 60 }, (_, i) => `artifacts/giant-${giant}-${i}.md`);
	writeFileSync(taskPath, JSON.stringify(tf, null, 2));
	let threw = null;
	try {
		await call("swarm_assign_task", { taskId: "task-assign-footer", nodeId: "implement", agentId: "footer-planner", note: "tiny" });
	} catch (err) {
		threw = err;
	}
	ok(
		"T-4.a: composed oversized body still throws MESSAGE_BODY_TOO_LARGE",
		threw !== null && String(threw.message).includes("MESSAGE_BODY_TOO_LARGE"),
		threw ? String(threw.message).slice(0, 160) : "no throw",
	);
	// Footer delta is constant: cap-sized body + footer must still fit under the default cap.
	// Measure the constant delta on the in-cap control below.
	const tf2 = JSON.parse(readFileSync(taskPath, "utf8"));
	tf2.nodes.implement.writeArtifacts = ["artifacts/impl.md"];
	writeFileSync(taskPath, JSON.stringify(tf2, null, 2));
	const res = await call("swarm_assign_task", { taskId: "task-assign-footer", nodeId: "implement", agentId: "footer-planner", note: "tiny" });
	const implMsgId = res?.details?.messageId;
	const implBody = readBody("task-assign-footer", "implement", "footer-planner", implMsgId) || "";
	// Pre-footer baseline shape (HEAD): the body would be ~450B shorter without the footer.
	ok("T-4.b: footer delta is constant (<2KiB) — body stays well under the default cap", implBody.length > 0 && implBody.length < 8 * 1024, `len=${implBody.length}`);
}

// ==================== T-5: FENCED assignment carries the footer (C-3) ====================
console.log("\nT-5: fenced assignment body carries the footer");
// Scratch-cwd seeding note (Pattern-2 sanctioned state seeding): without a real tmux pane the
// assignment delivery often persists as status "failed" (injection impossible), and
// supersedeOpenAssignments deliberately skips failed records (mailbox.ts open predicate).
// In a real lane the canonical assignment record is live (mailbox_delivered) at supersede
// time. The seedLeg below restores that engine-shape status on the B1 record so the stale
// branch (3) of checkStallNotificationStale fires deterministically on the B3 assign.
function seedLiveAssignmentStatus(taskId, nodeId, agentId, msgId) {
	const { paths, ensureDirs, withLock, readState, writeState } = stateMod;
	const p = paths(scratch);
	return withLock(p, async () => {
		await ensureDirs(p);
		const st = await readState(p, scratch);
		const rec = st.messages?.[msgId];
		if (rec && !rec.superseded && rec.status === "failed") rec.status = "mailbox_delivered";
		await writeState(p, st);
	});
}
// T-5 world-seed (Pattern-2, deterministic): put the node into the exact post-supersession state
// a real engine produces — node.assignmentMessageId points at a record that a LATER supersede
// (swarm_assign_task's supersedeOpenAssignments or task-cancellation supersedeTaskAssignmentMessages)
// marked superseded+waived. At the NEXT swarm_assign_task, checkStallNotificationStale branch (3)
// ("superseded_message") fires and the fresh mint is FENCED — before the footer lands in that
// fenced body. Ordering note: in a live sequence the B(n+1) assign supersedes B(n) AFTER B(n+1)'s
// own staleness check, so assign-time fencing requires a supersede from OUTSIDE the assign chain
// (e.g. cancellation/reopen) — seeded here by stamping the b2 record directly.
function seedStaleCanonicalAssignment(taskId, nodeId, msgId) {
	const { paths, ensureDirs, withLock, readState, writeState } = stateMod;
	const p = paths(scratch);
	return withLock(p, async () => {
		await ensureDirs(p);
		const st = await readState(p, scratch);
		const rec = st.messages?.[msgId];
		if (rec && !rec.superseded) {
			rec.superseded = { at: new Date().toISOString(), by: "root", supersededBy: "seed-supersede" };
			rec.response = { ...(rec.response || { status: "missing" }), status: "waived" };
		}
		await writeState(p, st);
		const taskPath = join(scratch, ".pi/swarm/tasks", taskId, "task.json");
		const task = JSON.parse(readFileSync(taskPath, "utf8"));
		if (task.nodes?.[nodeId]) task.nodes[nodeId].assignmentMessageId = msgId;
		writeFileSync(taskPath, JSON.stringify(task, null, 2));
	});
}
{
	// Genuine supersede → stale canonical assignment message → assignStaleCheck.stale on the
	// NEXT assign (freshAssignment only skips branch (6); branch (3) superseded_message fires).
	await call("swarm_update_task", { taskId: "task-assign-footer", nodeId: "implement", status: "blocked", force: true, cwd: scratch });
	const b1 = await call("swarm_assign_task", { taskId: "task-assign-footer", nodeId: "implement", agentId: "footer-planner", cwd: scratch });
	await seedLiveAssignmentStatus("task-assign-footer", "implement", "footer-planner", b1?.details?.messageId);
	await call("swarm_update_task", { taskId: "task-assign-footer", nodeId: "implement", status: "blocked", force: true, cwd: scratch });
	const b2 = await call("swarm_assign_task", { taskId: "task-assign-footer", nodeId: "implement", agentId: "footer-planner", cwd: scratch });
	await seedLiveAssignmentStatus("task-assign-footer", "implement", "footer-planner", b2?.details?.messageId);
	// Seed the stale-canonical state (see seedStaleCanonicalAssignment commentary), then assign.
	await seedStaleCanonicalAssignment("task-assign-footer", "implement", b2?.details?.messageId);
	const res3 = await call("swarm_assign_task", { taskId: "task-assign-footer", nodeId: "implement", agentId: "footer-planner", cwd: scratch });
	const fenced = res3?.details?.fenced === true;
	ok("T-5.setup: third assign came out FENCED (stale canonical message)", fenced, `reason=${res3?.details?.reason}`);
	if (fenced) {
		const fBody = readBody("task-assign-footer", "implement", "footer-planner", res3.details.messageId);
		ok("T-5.a: fenced body includes footer line 1", fBody.includes(FOOTER_L1), fBody.slice(-400));
		ok("T-5.b: fenced body includes footer line 2", fBody.includes(FOOTER_L2), "");
		ok("T-5.c: fenced body includes the fence note", /FENCED notice replaces the canonical assignment message/.test(fBody), "");
		// The fence NOTE is appended after the fencing close line by the assign path (body + note);
		// the contract under test: footer BEFORE the When finished line, fence note after it.
		const fFooterIdx = fBody.indexOf(FOOTER_L1);
		const fFinishedIdx = fBody.indexOf("When finished:");
		ok(
			"T-5.d: fenced body has footer BEFORE the When finished line (fence note trails)",
			fFooterIdx >= 0 && fFinishedIdx >= 0 && fFooterIdx < fFinishedIdx,
			`footer=${fFooterIdx} finished=${fFinishedIdx}`,
		);
	}
}

// ==================== T-6: both protocol gates via child processes (C-2) ====================
console.log("\nT-6: footer present + identical under both PI_SWARM_MINIMAL_PROTOCOL gates");
{
	const run = promisify(execFile);
	const formattingPath = join(here, "..", "src", "taskgraph", "formatting.ts");
	const childScript = `
import { buildAssignmentBody } from ${JSON.stringify(formattingPath)};
const fakeTask = {
	taskId: "task-test",
	title: "test",
	goal: "test",
	acceptanceCriteria: [],
	nodes: {
		implement: {
			status: "assigned",
			role: "implementer",
			assignee: "worker-a",
			dependsOn: [],
			allowedFiles: [],
			messageIds: [],
			attempts: 1,
			assignmentMessageId: "msg-1",
			lastActivityAt: new Date().toISOString(),
			lastProgressAt: new Date().toISOString(),
		},
	},
	edges: [],
};
const body = buildAssignmentBody(fakeTask, "implement", "root", undefined, "att-1", "msg-1");
console.log("RESULT:" + JSON.stringify({ body }));
`;
	const child = async (gate) => {
		const env = { ...process.env };
		if (gate === "0") env.PI_SWARM_MINIMAL_PROTOCOL = "0";
		else delete env.PI_SWARM_MINIMAL_PROTOCOL;
		const { stdout } = await run(process.execPath, ["--input-type=module", "-e", childScript], { env });
		const resultLine = stdout.trim().split("\n").filter((l) => l.startsWith("RESULT:")).pop();
		return JSON.parse(resultLine.slice(7));
	};
	const gate1 = await child("1");
	const gate0 = await child("0");
	for (const [label, res] of [["gate=1", gate1], ["gate=0", gate0]]) {
		ok(`T-6.${label}: footer line 1 present`, res.body.includes(FOOTER_L1), res.body.slice(-500));
		ok(`T-6.${label}: footer line 2 present`, res.body.includes(FOOTER_L2), "");
		ok(`T-6.${label}: footer precedes the When finished close`, res.body.indexOf(FOOTER_L1) < res.body.indexOf("When finished:") && res.body.indexOf(FOOTER_L1) >= 0, "");
		ok(`T-6.${label}: When finished close is the last line`, (res.body.split("\n").filter((l) => l.trim()).at(-1) || "").startsWith("When finished:"), "");
	}
	ok("T-6: footer text is byte-identical under both gates", gate1.body === gate0.body, "bodies diverged");
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
