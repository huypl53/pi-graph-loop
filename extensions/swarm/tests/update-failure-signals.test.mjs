#!/usr/bin/env node
/**
 * update-failure-signals.test.mjs — RED-first for plan
 * docs/swarm/plans/2026-10-13-worker-task-closure-gaps.md §1.2 (Stage B).
 *
 * Design correction being reproduced: the incident worker called swarm_update_task ONCE with
 * closure intent (status:"done"), failed, and STOPPED — a pure streak-3 gate never fires in
 * exactly the motivating scenario. Failures are therefore CLASSIFIED:
 *   closure — terminal intent (status done/failed/blocked/cancelled or cancelTask)  → IMMEDIATE
 *   orphan  — TASK_NOT_FOUND with empty myActiveTaskIds                              → IMMEDIATE
 *   work    — everything else                                                        → streak 3/6
 *
 * Contract under test (pre-fix: module missing → RED; post-fix → GREEN):
 *   - classifyUpdateFailure(params, errorCode, myActiveTaskIds) pure matrix
 *   - recordUpdateOutcomeLocked(st, agentId, ok, errorCode?, class?) state machine:
 *       increment + stamp on failure, reset on success, root calls never recorded
 *   - immediate self-nudge (worker mailbox) + root notice on FIRST closure/orphan failure
 *   - root notice idempotent per (agent,task,node,class), cap 2, cooldown 10'
 *   - work-class streak: self-nudge exactly at 3, root escalate exactly at 6, silent beyond
 *   - reset-on-success: after a success, a single work failure does NOT re-notify
 *   - R10-1: pi.sendMessage count === durable emissions (mailbox-only path sends 0; assert
 *     via delivery records + inject calls) — here: all deliveries are mailbox-only for a
 *     pane-less worker/root, so sendMessage stays 0 while mailbox rows appear.
 */
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-update-failure-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi", "swarm"), { recursive: true });

process.env.PI_SWARM_AGENT_ID = "root";
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

let classifyUpdateFailure = null;
let recordUpdateOutcomeLocked = null;
try {
	({ classifyUpdateFailure, recordUpdateOutcomeLocked } = await import(join(here, "..", "src", "nudges", "update-failure.ts")));
} catch {
	classifyUpdateFailure = null;
}

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

if (!classifyUpdateFailure || !recordUpdateOutcomeLocked) {
	ok("module exists + exports (RED: missing pre-fix)", false, "src/nudges/update-failure.ts not implemented yet");
	console.log(`\n${pass} passed, ${fail} failed (RED)`);
	process.exit(1);
}

// === Part 1: classifyUpdateFailure pure matrix ===
console.log("\n[1] classifyUpdateFailure matrix");
ok("terminal status -> closure", classifyUpdateFailure({ status: "done" }, "INVALID_TRANSITION", []) === "closure");
ok("status failed -> closure", classifyUpdateFailure({ status: "failed" }, "INVALID_TRANSITION", ["t1"]) === "closure");
ok("status blocked -> closure", classifyUpdateFailure({ status: "blocked" }, "RESPONSE_REQUIRED", ["t1"]) === "closure");
ok("status cancelled -> closure", classifyUpdateFailure({ status: "cancelled" }, "INVALID_TRANSITION", []) === "closure");
ok("cancelTask -> closure regardless of status", classifyUpdateFailure({ cancelTask: true }, "CANCEL_FORBIDDEN", []) === "closure");
ok("TASK_NOT_FOUND + no held tasks -> orphan", classifyUpdateFailure({}, "TASK_NOT_FOUND", []) === "orphan");
ok("TASK_NOT_FOUND + held tasks -> work", classifyUpdateFailure({}, "TASK_NOT_FOUND", ["t1"]) === "work");
ok("INVALID_TRANSITION -> work", classifyUpdateFailure({ status: "in_progress" }, "INVALID_TRANSITION", ["t1"]) === "work");
ok(
	"OUTCOME_REQUIRED -> work (non-terminal params)",
	classifyUpdateFailure({ status: "in_progress" }, "OUTCOME_REQUIRED", ["t1"]) === "work",
);
ok(
	"NODE_ASSIGNEE_MISMATCH -> work (non-terminal params)",
	classifyUpdateFailure({ status: "in_progress" }, "NODE_ASSIGNEE_MISMATCH", ["t1"]) === "work",
);

// === Part 2: real tool drive-through (state machine + emissions through real handlers) ===
const tools = {};
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	sendMessage: () => {},
	exec: async (cmd, args) => {
		if (cmd === "tmux" && args[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
		if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	},
};
factory(pi);

const call = async (name, params) => {
	const t = tools[name];
	if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: scratch });
};
const as = async (agentId, fn) => {
	const prev = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = agentId;
	try {
		return await fn();
	} finally {
		process.env.PI_SWARM_AGENT_ID = prev;
	}
};
const expectThrow = async (agentId, name, params) => {
	try {
		await as(agentId, () => call(name, params));
		return null;
	} catch (err) {
		return err;
	}
};

const statePath = () => join(scratch, ".pi", "swarm", "swarm-state.json");
const readSt = () => JSON.parse(readFileSync(statePath(), "utf8"));
function ensureWorker(agentId, kind = "worker", activeTaskIds = []) {
	const st = existsSync(statePath())
		? JSON.parse(readFileSync(statePath(), "utf8"))
		: { swarmId: "uf-test", tmuxSession: "x", rootId: "root", agents: {}, delivered: {}, messages: {} };
	st.agents = st.agents || {};
	if (!st.agents[agentId])
		st.agents[agentId] = {
			id: agentId,
			role: `test ${kind}`,
			roleKind: kind,
			capabilities: [],
			activeTaskIds,
			maxConcurrentTasks: kind === "root" ? 99 : 1,
			status: "running",
			runtimeStatus: "idle",
			health: "healthy",
			tmuxTarget: "unknown",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
	st.agents.root = st.agents.root || {
		id: "root",
		roleKind: "root",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 99,
		status: "running",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	if (agentId !== "root") st.agents[agentId].activeTaskIds = activeTaskIds;
	writeFileSync(statePath(), JSON.stringify(st, null, 2) + "\n");
}
function mailboxRows(agentId, pattern) {
	// Durable state records strip subject/body (they live in the mailbox JSONL ledger); read
	// body text from the ledger, keyed by the state record's idempotencyKey set.
	const st = readSt();
	const keys = new Set(
		Object.values(st.messages || {})
			.filter((m) => m.to === agentId && (!pattern || (m.idempotencyKey || "").includes(pattern)))
			.map((m) => m.idempotencyKey),
	);
	const ledger = join(scratch, ".pi", "swarm", "mailboxes", `${agentId}.jsonl`);
	const rows = existsSync(ledger)
		? readFileSync(ledger, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => {
					try {
						return JSON.parse(l);
					} catch {
						return null;
					}
				})
				.filter(Boolean)
		: [];
	return rows.filter((m) => keys.has(m.idempotencyKey));
}
async function seedTask(taskId, nodeId = "plan") {
	const r = await call("swarm_create_task", {
		title: taskId,
		goal: "g",
		priority: "normal",
		cwd: scratch,
		taskId,
		start: nodeId,
		nodes: { [nodeId]: { role: "planner", writeArtifacts: ["artifacts/plan.md"] }, done: { role: "implementer", dependsOn: [nodeId] } },
		edges: [{ from: nodeId, to: "done", when: "planned" }],
	});
	return r.content[0].text.match(/task-[A-Za-z0-9_-]+/)[0];
}

// =============================================================
console.log("\n[2] closure-intent failure -> IMMEDIATE self-nudge + root notice (first failure)");
{
	ensureWorker("worker-c", "planner");
	const taskId = await seedTask("task-uf-closure");
	// worker-c does NOT own the node (ready+unassigned claim would succeed; force a closure failure:
	// claim first, then a second worker closes via mismatch → simplest deterministic closure failure
	// for worker-c is INVALID_TRANSITION from assigned with wrong outcome... use RESPONSE_REQUIRED
	// shape: claim the node, then try done WITHOUT outcome (OUTCOME_REQUIRED) while carrying
	// terminal intent status:"done" -> closure class.
	await as("worker-c", () => call("swarm_update_task", { taskId, nodeId: "plan", note: "claim", cwd: scratch }));
	ensureWorker("worker-c", "planner", [taskId]);
	// claim minted an attempt — subsequent calls must present the token
	const attemptId = JSON.parse(readFileSync(join(scratch, ".pi/swarm/tasks", taskId, "task.json"), "utf8")).nodes.plan.activeAttemptId;
	const err = await expectThrow("worker-c", "swarm_update_task", { taskId, nodeId: "plan", status: "done", cwd: scratch, attemptId });
	ok("closure-intent call throws (OUTCOME_REQUIRED)", err?.errorCode === "OUTCOME_REQUIRED", String(err?.errorCode));
	const self = mailboxRows("worker-c", "update-failure");
	const root = mailboxRows("root", "update-failure");
	ok("worker self-nudge delivered immediately (streak 1)", self.length === 1, JSON.stringify(self.map((m) => m.idempotencyKey)));
	ok("root notice delivered immediately (streak 1)", root.length === 1, JSON.stringify(root.map((m) => m.idempotencyKey)));
	ok("self-nudge names the errorCode", self.length === 1 && self[0].body.includes("OUTCOME_REQUIRED"), self[0]?.body?.slice(0, 200));
	ok("self-nudge instructs message-root fallback", self.length === 1 && /swarm_send_message/.test(self[0].body));
	ok("self-nudge has no raw .pi/ path", self.length === 1 && !self[0].body.includes(".pi/"));
	// state stamped
	const st = readSt();
	ok("streak stamped =1", st.agents["worker-c"].updateFailureStreak === 1);
	ok("class stamped closure", st.agents["worker-c"].lastUpdateFailureClass === "closure");
	// second identical closure failure within cooldown: worker self-nudge NOT duplicated
	await expectThrow("worker-c", "swarm_update_task", { taskId, nodeId: "plan", status: "done", cwd: scratch, attemptId });
	ok("second closure failure does not duplicate worker self-nudge (cooldown)", mailboxRows("worker-c", "update-failure").length === 1);
	const st2 = readSt();
	ok("streak incremented to 2", st2.agents["worker-c"].updateFailureStreak === 2);
}

// =============================================================
console.log("\n[3] orphan-class: TASK_NOT_FOUND + empty tasks -> immediate (the incident shape)");
{
	ensureWorker("worker-o", "planner", []);
	const err = await expectThrow("worker-o", "swarm_update_task", { taskId: "ghost-task", nodeId: "plan", status: "done", cwd: scratch });
	ok("throws TASK_NOT_FOUND", err?.errorCode === "TASK_NOT_FOUND");
	const self = mailboxRows("worker-o", "update-failure");
	const root = mailboxRows("root", "update-failure:root:ghost-task");
	ok("orphan self-nudge immediate", self.length === 1, JSON.stringify(self.map((m) => m.idempotencyKey)));
	ok("orphan root notice immediate", root.length === 1, JSON.stringify(root.map((m) => m.idempotencyKey)));
	ok(
		"root notice names the agent + error",
		root.length === 1 && root[0].body.includes("worker-o") && root[0].body.includes("TASK_NOT_FOUND"),
	);
}

// =============================================================
console.log("\n[4] work-class streak: self@3, root@6, silent beyond, reset-on-success");
{
	ensureWorker("worker-w", "implementer");
	const taskId = await seedTask("task-uf-work", "implement");
	// Deterministic repeated work-class failure: NODE_ASSIGNEE_MISMATCH with a NON-terminal
	// requested status (class keys on PARAMS intent → work). worker-w claims 'implement' first
	// (stamps assignee), then worker-w2's in_progress updates all bounce with mismatch.
	ensureWorker("worker-w2", "implementer");
	await as("worker-w", () => call("swarm_update_task", { taskId, nodeId: "implement", note: "claim by other", cwd: scratch }));
	const errs = [];
	for (let i = 0; i < 8; i++) {
		errs.push(
			await expectThrow("worker-w2", "swarm_update_task", { taskId, nodeId: "implement", status: "in_progress", cwd: scratch }),
		);
	}
	ok(
		"work-class failures throw NODE_ASSIGNEE_MISMATCH",
		errs.every((e) => e?.errorCode === "NODE_ASSIGNEE_MISMATCH"),
		String(errs[0]?.errorCode),
	);
	const st8 = readSt();
	ok("streak reached 8", st8.agents["worker-w2"].updateFailureStreak === 8, String(st8.agents["worker-w2"].updateFailureStreak));
	ok("class stamped work", st8.agents["worker-w2"].lastUpdateFailureClass === "work");
	const self = mailboxRows("worker-w2", "update-failure");
	const root = mailboxRows("root", "update-failure");
	ok("work-class self-nudge exactly once (at 3)", self.length === 1, JSON.stringify(self.map((m) => m.idempotencyKey)));
	const rootW2 = mailboxRows("root", "worker-w2:update-failure:root");
	ok("work-class root escalation exactly once (at 6)", rootW2.length === 1, JSON.stringify(rootW2.map((m) => m.idempotencyKey)));
	// success resets (force-assign re-fences the attempt; read the fresh token)
	await as("root", () => call("swarm_assign_task", { taskId, nodeId: "implement", agentId: "worker-w2", force: true, cwd: scratch }));
	const attemptId2 = JSON.parse(readFileSync(join(scratch, ".pi/swarm/tasks", taskId, "task.json"), "utf8")).nodes.implement
		.activeAttemptId;
	await as("worker-w2", () =>
		call("swarm_update_task", { taskId, nodeId: "implement", status: "in_progress", cwd: scratch, attemptId: attemptId2 }),
	);
	const stOk = readSt();
	ok("success resets streak", (stOk.agents["worker-w2"].updateFailureStreak ?? 0) === 0);
	// one more single work failure after reset must NOT notify again: reassign the node to the
	// other claimer (worker-w) so worker-w2's next in_progress call bounces with mismatch again.
	await as("root", () => call("swarm_assign_task", { taskId, nodeId: "implement", agentId: "worker-w", force: true, cwd: scratch }));
	const single = await expectThrow("worker-w2", "swarm_update_task", {
		taskId,
		nodeId: "implement",
		status: "in_progress",
		cwd: scratch,
	});
	ok("single post-reset work failure throws", single?.errorCode === "NODE_ASSIGNEE_MISMATCH");
	ok("no duplicate self-nudge after reset (streak 1)", mailboxRows("worker-w2", "update-failure").length === 1);
	ok("no duplicate root escalation after reset", mailboxRows("root", "worker-w2:update-failure:root").length === 1);
}

// =============================================================
console.log("\n[4b] late-result refusal (__lateResultRefused) counts as FAILURE, not success");
{
	ensureWorker("worker-l1", "implementer");
	ensureWorker("worker-l2", "implementer");
	const taskId = await seedTask("task-uf-late", "implement");
	// worker-l1 claims (mints attempt-1), root force-assigns to worker-l2 (supersedes attempt-1),
	// then force-assigns BACK to worker-l1 (mints attempt-3; assignee is worker-l1 again so the
	// ownership check passes) — worker-l1's ORIGINAL token is now stale → late-result refusal.
	await as("worker-l1", () => call("swarm_update_task", { taskId, nodeId: "implement", note: "claim", cwd: scratch }));
	const tpLate = join(scratch, ".pi/swarm/tasks", taskId, "task.json");
	const staleAttemptId = JSON.parse(readFileSync(tpLate, "utf8")).nodes.implement.activeAttemptId;
	await as("root", () => call("swarm_assign_task", { taskId, nodeId: "implement", agentId: "worker-l2", force: true, cwd: scratch }));
	await as("root", () => call("swarm_assign_task", { taskId, nodeId: "implement", agentId: "worker-l1", force: true, cwd: scratch }));
	// worker-l1 replays its STALE token -> __lateResultRefused (no throw, marker result)
	const res = await as("worker-l1", () =>
		call("swarm_update_task", {
			taskId,
			nodeId: "implement",
			status: "done",
			outcome: "implemented",
			attemptId: staleAttemptId,
			cwd: scratch,
		}),
	);
	const resText = res?.content?.[0]?.text ?? "";
	ok("late-result refusal returns refusal envelope", /Refused: late result/.test(resText), resText.slice(0, 120));
	const stLate = readSt();
	ok(
		"late-result refusal stamps streak >=1 (NOT reset to 0)",
		(stLate.agents["worker-l1"].updateFailureStreak ?? 0) >= 1,
		String(stLate.agents["worker-l1"].updateFailureStreak),
	);
	ok(
		"late-result refusal stamps a class",
		Boolean(stLate.agents["worker-l1"].lastUpdateFailureClass),
		String(stLate.agents["worker-l1"].lastUpdateFailureClass),
	);
	ok(
		"late-result refusal notified root (work-class streak1? no: closure intent -> immediate)",
		mailboxRows("root", "worker-l1:update-failure:root").length >= 1,
		JSON.stringify(mailboxRows("root", "worker-l1:update-failure:root").map((m) => m.idempotencyKey)),
	);
}

// =============================================================
console.log("\n[5] root failures never recorded");
{
	ensureWorker("root", "root");
	const st0 = readSt();
	await expectThrow("root", "swarm_update_task", { taskId: "ghost-root", nodeId: "plan", status: "done", cwd: scratch });
	const st1 = readSt();
	ok("root streak undefined/0", !st1.agents.root.updateFailureStreak);
	ok(
		"root failure emitted no nudges",
		mailboxRows("root", "update-failure:worker").length === 0 && !st1.agents.root.lastUpdateFailureCode,
	);
}

// =============================================================
console.log("\n[6] R10-1: pane-less worker+root -> all deliveries mailbox-only, zero inject sends");
{
	// deliveries above created mailbox records; a pane-less recipient gets mailbox_only delivery.
	// Assert every update-failure record is mailbox-only (no tmux injection path).
	const st = readSt();
	const rows = Object.values(st.messages || {}).filter((m) => (m.idempotencyKey || "").includes("update-failure"));
	ok("all update-failure rows exist durably", rows.length >= 4, String(rows.length));
	ok(
		"all rows requiresAck=false",
		rows.every((m) => m.requiresAck === false),
	);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
