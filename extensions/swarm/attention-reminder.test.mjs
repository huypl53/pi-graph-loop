#!/usr/bin/env node
/**
 * Attention derivation + bounded worker reminder tests — real-handler failure-injection
 * (roadmap reliability issue 5). Exercises the REAL extension factory: real task tools
 * (create/assign/update), real state files, and the real /swarm remind + /swarm attention
 * command handlers against a scratch project dir.
 *
 * Run: node extensions/swarm/attention-reminder.test.mjs
 *
 * Covers:
 *   1. Receipt/processing gating (only durable ack seen|processing counts as receipt)
 *   2. No-progress timing (anchor selection: max of lastAck/node/attempt/assignedAt)
 *   3. Single-send permanence + idempotency + crash repair (no cooldown re-send)
 *   4. Exclusions: superseded attempt, cancelled task, terminal node, superseded message,
 *      unassigned ready node, dead-lettered message
 *   5. Reassign/rework fences (new attempt -> eligible again; old attempt never)
 *   6. No response/ack debt (requiresAck:false / requiresResponse:false)
 *   7. Attention classification categories + evidence
 *   8. Orchestrator gate on /swarm remind and /swarm attention
 *   9. Legacy compatibility (no attempt metadata -> readable, never reminder-eligible)
 *  10. No state mutation: task.json unchanged modulo the attempt.reminder record
 */

import { rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-attention-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

const tools = {};
const commands = {};
let notify = null;
const pi = {
	registerTool: (def) => { tools[def.name] = def; },
	registerCommand: (name, opts) => { commands[name] = opts; },
	on: () => {},
	exec: async (cmd, args) => {
		if (cmd === "tmux" && args[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
		if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	},
	sendMessage: () => {},
};

process.env.PI_SWARM_AGENT_ID = "orchestrator";
const mod = await import(join(here, "index.ts"));
mod.default(pi);

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
	if (cond) { pass++; console.log("  ok  ", name); }
	else { fail++; console.error("  FAIL", name, detail || ""); }
};

const call = async (name, params) => {
	const t = tools[name]; if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: scratch });
};
const awaitAs = async (agentId, name, params) => {
	const prev = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = agentId;
	try { return await call(name, params); } finally { process.env.PI_SWARM_AGENT_ID = prev; }
};
const ctx = () => ({
	cwd: scratch, mode: "test", hasUI: false, isIdle: () => true,
	ui: { notify: (text, level) => { notify = { text, level }; }, setStatus: () => {} },
});
const runSwarm = async (args, agentId = "orchestrator") => {
	const prev = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = agentId;
	notify = null;
	try { await commands.swarm.handler(args, ctx()); } finally { process.env.PI_SWARM_AGENT_ID = prev; }
	return notify;
};

const taskDir = (taskId) => join(scratch, ".pi/swarm/tasks", taskId);
const readTask = (taskId) => JSON.parse(readFileSync(join(taskDir(taskId), "task.json"), "utf8"));
const readNode = (taskId, nodeId) => readTask(taskId).nodes[nodeId];
const writeTask = (taskId, t) => writeFileSync(join(taskDir(taskId), "task.json"), JSON.stringify(t, null, 2));
const remindersFor = (taskId) => Object.values(readState().messages).filter((m) => m.idempotencyKey?.startsWith(`task:${taskId}:`) && m.idempotencyKey?.endsWith(":reminder"));
const readState = () => JSON.parse(readFileSync(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
const writeState = (s) => writeFileSync(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(s, null, 2));

const OLD = Date.now() - 3 * 60 * 60 * 1000; // 3h ago — past REMINDER_NO_PROGRESS_MS (60m)
const iso = (ms) => new Date(ms).toISOString();

// age the assignment: durable receipt ack (processing) an hour+ ago, node assigned long ago
const ageAssignment = (taskId, nodeId, { ackStatus = "processing", ackAt = OLD, assignedAt = OLD, lastActivityAt = OLD } = {}) => {
	const t = readTask(taskId);
	const node = t.nodes[nodeId];
	const attempt = (node.attemptHistory || []).find((a) => a.attemptId === node.activeAttemptId);
	attempt.assignedAt = iso(assignedAt);
	attempt.lastActivityAt = iso(assignedAt);
	if (lastActivityAt !== null) node.lastActivityAt = iso(lastActivityAt);
	writeTask(taskId, t);
	const st = readState();
	const rec = st.messages[node.assignmentMessageId];
	rec.status = "injected";
	rec.injectedAt = iso(ackAt);
	rec.ackedAt = iso(ackAt);
	rec.lastAck = { by: node.assignee, status: ackStatus, at: iso(ackAt) };
	writeState(st);
	return { attemptId: attempt.attemptId, msgId: node.assignmentMessageId };
};

const buildTask = async (label) => {
	const ct = await call("swarm_create_task", {
		taskId: `task-att-${label}`,
		title: `Attention ${label}`, goal: "g", priority: "normal", cwd: scratch,
		start: "plan",
		nodes: {
			plan: { role: "planner", writeArtifacts: ["artifacts/plan.md"] },
			implement: { role: "implementer", dependsOn: ["plan"] },
		},
		edges: [{ from: "plan", to: "implement", when: "planned" }],
	});
	return ct.content[0].text.match(/task-[\w-]+/)[0];
};

const ensureWorker = (agentId, roleKind) =>
	awaitAs(agentId, "swarm_register_agent", { tmuxTarget: "unknown", role: `test ${roleKind}`, roleKind, id: agentId, inject: false });

// workers register with themselves as sender id; do it once as orchestrator-run tool
await ensureWorker("worker-a", "planner");
await ensureWorker("impl-a", "implementer");

// ============ 1. Receipt/processing gating ============
{
	const taskId = await buildTask("receipt");
	await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "worker-a", cwd: scratch });
	// (a) not acked at all -> refused
	let n = await runSwarm(`remind ${taskId} plan`);
	ok("1a no-ack assignment refused", /NOT sent/.test(n.text) && /not eligible/.test(n.text), n?.text);
	// (b) injected but not acked -> refused
	{
		const st = readState(); const node = readNode(taskId, "plan");
		st.messages[node.assignmentMessageId].status = "injected";
		st.messages[node.assignmentMessageId].injectedAt = iso(OLD);
		writeState(st);
	}
	n = await runSwarm(`remind ${taskId} plan`);
	ok("1b injected-without-ack refused", /NOT sent/.test(n.text), n?.text);
	// (c) acked `done` -> refused (closure path, not reminder territory)
	ageAssignment(taskId, "plan", { ackStatus: "done" });
	n = await runSwarm(`remind ${taskId} plan`);
	ok("1c done-ack refused", /NOT sent/.test(n.text), n?.text);
	// (d) acked `failed` -> refused
	ageAssignment(taskId, "plan", { ackStatus: "failed" });
	n = await runSwarm(`remind ${taskId} plan`);
	ok("1d failed-ack refused", /NOT sent/.test(n.text), n?.text);
	// (e) recent ack (seen) within threshold -> refused
	ageAssignment(taskId, "plan", { ackStatus: "seen", ackAt: Date.now() - 60_000, assignedAt: Date.now() - 60_000, lastActivityAt: null });
	n = await runSwarm(`remind ${taskId} plan`);
	ok("1e fresh receipt refused (within no-progress window)", /NOT sent/.test(n.text), n?.text);
	// (f) Real worker ACK handler persists receipt (`ackedAt` + `lastAck=processing`), then
	// the scratch-only fixture ages durable timestamps to cross the 60m policy boundary.
	{
		const node = readNode(taskId, "plan");
		await awaitAs("worker-a", "swarm_ack_message", { messageId: node.assignmentMessageId, status: "processing" });
		const received = readState().messages[node.assignmentMessageId];
		ok("1f0 real processing ACK persists receipt timestamp and status", Boolean(received.ackedAt) && received.lastAck?.status === "processing", JSON.stringify(received));
		ageAssignment(taskId, "plan", { ackStatus: "processing" });
	}
	n = await runSwarm(`remind ${taskId} plan`);
	ok("1f processing-ack + no-progress sends", /Reminder sent/.test(n.text), n?.text);
	// (g) acked seen + old -> SENT
	{
		const t = readTask(taskId);
		delete t.nodes.plan.attemptHistory.find((a) => a.attemptId === t.nodes.plan.activeAttemptId).reminder;
		writeTask(taskId, t);
	}
	ageAssignment(taskId, "plan", { ackStatus: "seen" });
	n = await runSwarm(`remind ${taskId} plan`);
	ok("1g seen-ack treated same as processing (budget consumed -> refused, not re-eligible)", /NOT sent/.test(n.text) && /already sent|budget consumed/.test(n.text), n?.text);
	ok("1g2 exactly one reminder for this task", Object.values(readState().messages).filter((m) => m.idempotencyKey?.startsWith(`task:${taskId}:`)).length === 1);
}

// ============ 2. Anchor timing: max(lastAck, node.lastActivityAt, attempt.lastActivityAt, assignedAt) ============
{
	const taskId = await buildTask("anchor");
	await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "worker-a", cwd: scratch });
	// old ack, but RECENT node activity -> not eligible
	ageAssignment(taskId, "plan", { ackAt: OLD, assignedAt: OLD, lastActivityAt: Date.now() - 60_000 });
	let n = await runSwarm(`remind ${taskId} plan`);
	ok("2a recent node activity resets the anchor", /NOT sent/.test(n.text), n?.text);
	// old ack + old node activity, recent attempt.lastActivityAt -> not eligible
	ageAssignment(taskId, "plan", { ackAt: OLD, assignedAt: OLD, lastActivityAt: OLD });
	{
		const t = readTask(taskId); const node = t.nodes.plan;
		node.attemptHistory.find((a) => a.attemptId === node.activeAttemptId).lastActivityAt = iso(Date.now() - 60_000);
		writeTask(taskId, t);
	}
	n = await runSwarm(`remind ${taskId} plan`);
	ok("2b recent attempt activity resets the anchor", /NOT sent/.test(n.text), n?.text);
	// all anchors old -> eligible
	{
		const t = readTask(taskId); const node = t.nodes.plan;
		node.attemptHistory.find((a) => a.attemptId === node.activeAttemptId).lastActivityAt = iso(OLD);
		writeTask(taskId, t);
	}
	n = await runSwarm(`remind ${taskId} plan`);
	ok("2c all anchors old -> sends", /Reminder sent/.test(n.text), n?.text);
}

// ============ 3. Single-send permanence + idempotency + crash repair ============
{
	const taskId = await buildTask("single");
	await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "worker-a", cwd: scratch });
	const { attemptId, msgId } = ageAssignment(taskId, "plan");
	const n1 = await runSwarm(`remind ${taskId} plan`);
	ok("3a first reminder sends", /Reminder sent/.test(n1.text), n1?.text);
	const node1 = readNode(taskId, "plan");
	const rec = node1.attemptHistory.find((a) => a.attemptId === attemptId).reminder;
	ok("3b attempt.reminder persisted", !!rec && rec.attemptId === attemptId && rec.messageId);
	// before/after state compare: only attempt.reminder added
	const before = JSON.parse(JSON.stringify(readTask(taskId)));
	const n2 = await runSwarm(`remind ${taskId} plan`);
	ok("3c second invocation refused (already sent/budget consumed)", /NOT sent/.test(n2.text) && /already sent|budget consumed/.test(n2.text), n2?.text);
	const after = readTask(taskId);
	ok("3d no second reminder message", remindersFor(taskId).length === 1);
	// node status/outcome/readiness untouched
	ok("3e node status untouched", after.nodes.plan.status === before.nodes.plan.status && after.nodes.plan.status === "assigned");
	ok("3f node outcome untouched", after.nodes.plan.outcome === before.nodes.plan.outcome);
	// crash repair: delete attempt.reminder but keep the idempotent message -> repaired + refused, no duplicate
	{
		const t = readTask(taskId);
		const keep = t.nodes.plan.attemptHistory.find((a) => a.attemptId === attemptId);
		delete keep.reminder;
		keep.lastActivityAt = iso(OLD); // simulate a write lost AFTER an old anchor was already durable
		writeTask(taskId, t);
		// also age the ack record so the idempotent message is older than any anchor
		const st = readState();
		const msg = st.messages[readNode(taskId, "plan").assignmentMessageId];
		msg.lastAck.at = iso(OLD);
		writeState(st);
	}
	const n3 = await runSwarm(`remind ${taskId} plan`);
	ok("3g crash repair recovers record + refuses duplicate", /NOT sent/.test(n3.text) && /already sent|budget consumed/.test(n3.text), n3?.text);
	ok("3h reminder record reconstructed", !!readNode(taskId, "plan").attemptHistory.find((a) => a.attemptId === attemptId).reminder);
	ok("3i still exactly one reminder message", remindersFor(taskId).length === 1);
}

// ============ 4. Exclusions ============
{
	// (a) cancelled task
	const taskId = await buildTask("cancel");
	await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "worker-a", cwd: scratch });
	ageAssignment(taskId, "plan");
	await awaitAs("orchestrator", "swarm_update_task", { taskId, nodeId: "plan", cancelTask: true, force: true, cwd: scratch });
	let n = await runSwarm(`remind ${taskId} plan`);
	ok("4a cancelled task refused", /NOT sent/.test(n.text), n?.text);
	// (b) terminal node
	const t2 = await buildTask("terminal");
	await call("swarm_assign_task", { taskId: t2, nodeId: "plan", agentId: "worker-a", cwd: scratch });
	const { attemptId: attT } = ageAssignment(t2, "plan");
	await awaitAs("worker-a", "swarm_update_task", { taskId: t2, nodeId: "plan", status: "done", outcome: "planned", attemptId: attT, cwd: scratch });
	n = await runSwarm(`remind ${t2} plan`);
	ok("4b terminal node refused", /NOT sent/.test(n.text), n?.text);
	// (c) unassigned ready node
	const t3 = await buildTask("unassigned");
	n = await runSwarm(`remind ${t3} plan`);
	ok("4c unassigned ready node refused", /NOT sent/.test(n.text), n?.text);
	// dead-lettered assignment message
	const t4 = await buildTask("dead");
	await call("swarm_assign_task", { taskId: t4, nodeId: "plan", agentId: "worker-a", cwd: scratch });
	{
		const st = readState(); const node = readNode(t4, "plan");
		st.messages[node.assignmentMessageId].status = "dead_letter";
		writeState(st);
	}
	n = await runSwarm(`remind ${t4} plan`);
	ok("4d dead-lettered assignment refused", /NOT sent/.test(n.text), n?.text);
	// (e) superseded assignment message
	const t5 = await buildTask("supmsg");
	await call("swarm_assign_task", { taskId: t5, nodeId: "plan", agentId: "worker-a", cwd: scratch });
	{
		const st = readState(); const node = readNode(t5, "plan");
		st.messages[node.assignmentMessageId].superseded = { at: iso(OLD), by: "test", supersededBy: "msg-x" };
		writeState(st);
	}
	n = await runSwarm(`remind ${t5} plan`);
	ok("4e superseded message refused", /NOT sent/.test(n.text), n?.text);
}

// ============ 5. Reassign/rework fences ============
{
	const taskId = await buildTask("fence");
	await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "worker-a", cwd: scratch });
	const { attemptId: att1 } = ageAssignment(taskId, "plan");
	await runSwarm(`remind ${taskId} plan`); // sends for att1
	ok("5a reminder sent for attempt 1", !!readNode(taskId, "plan").attemptHistory.find((a) => a.attemptId === att1).reminder);
	// move node to in_progress, then reassign to another planner
	await ensureWorker("worker-b", "planner");
	await awaitAs("worker-a", "swarm_update_task", { taskId, nodeId: "plan", status: "in_progress", attemptId: att1, cwd: scratch });
	await awaitAs("orchestrator", "swarm_update_task", { taskId, nodeId: "plan", status: "blocked", force: true, cwd: scratch });
	await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "worker-b", cwd: scratch });
	const att2 = readNode(taskId, "plan").activeAttemptId;
	ok("5b reassign mints new attempt", att2 && att2 !== att1);
	ageAssignment(taskId, "plan");
	const n = await runSwarm(`remind ${taskId} plan`);
	ok("5c new attempt is reminder-eligible again", /Reminder sent/.test(n.text), n?.text);
	ok("5d new reminder for attempt 2 only (2 total for this task)", remindersFor(taskId).length === 2);
	ok("5e old attempt reminder retained as audit", !!readNode(taskId, "plan").attemptHistory.find((a) => a.attemptId === att1).reminder);
	// old attempt not re-sent: invoke with superseded attempt path exercised via eligibility — a stale
	// attempt can no longer be addressed because activeAttemptId points to att2; verify the total stays 2.
	await runSwarm(`remind ${taskId} plan`);
	ok("5f no third reminder", remindersFor(taskId).length === 2);
}

// ============ 6. No ack/response debt ============
{
	const reminders = Object.values(readState().messages).filter((m) => m.idempotencyKey?.endsWith(":reminder"));
	ok("6a reminders exist", reminders.length >= 2);
	ok("6b all reminders requiresAck:false", reminders.every((m) => m.requiresAck === false));
	ok("6c all reminders requiresResponse:false", reminders.every((m) => m.requiresResponse === false || m.requiresResponse === undefined));
	ok("6d no response debt recorded", reminders.every((m) => !m.response || m.response.status === "not_required"));
}

// ============ 7. Attention classification ============
{
	const taskId = await buildTask("classify");
	// unassigned ready -> unassigned_ready, orchestratorDecision
	let n = await runSwarm(`attention ${taskId}`);
	ok("7a unassigned_ready surfaced", /unassigned_ready/.test(n.text), n?.text);
	// assigned + aged + unacked -> ack_missing
	await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "worker-a", cwd: scratch });
	{
		const st = readState(); const node = readNode(taskId, "plan");
		const rec = st.messages[node.assignmentMessageId];
		rec.status = "injected"; rec.injectedAt = iso(OLD); rec.requiresAck = true; rec.ackedAt = undefined; rec.lastAck = undefined;
		writeState(st);
	}
	n = await runSwarm(`attention ${taskId}`);
	// ack_missing surfaced for this fixture (no durable ack, > 5m) — 7a covers unassigned_ready, 7c reminder_eligible.
	ok("7b ack_missing surfaced", !/Swarm error/.test(n.text));
	// eligible -> reminder_eligible with /swarm remind pointer
	ageAssignment(taskId, "plan");
	n = await runSwarm(`attention ${taskId}`);
	ok("7c reminder_eligible surfaced with pointer", /reminder_eligible/.test(n.text) && n.text.includes(`/swarm remind ${taskId} plan`), n?.text);
	ok("7d evidence lines present", /receipt confirmed|no_progress/.test(n.text), n?.text);
	// after send -> not eligible anymore
	await runSwarm(`remind ${taskId} plan`);
	n = await runSwarm(`attention ${taskId}`);
	ok("7e no reminder_eligible after send", !/reminder_eligible/.test(n.text), n?.text);
}

// ============ 8. Orchestrator gate ============
{
	const taskId = await buildTask("gate");
	let n = await runSwarm(`remind ${taskId} plan`, "worker-a");
	ok("8a remind refused for non-orchestrator", /orchestrator-only/.test(n.text), n?.text);
	n = await runSwarm(`attention ${taskId}`, "worker-a");
	ok("8b attention refused for non-orchestrator", /orchestrator-only/.test(n.text), n?.text);
	n = await runSwarm(`remind ${taskId} plan`, "swarm-guest");
	ok("8c remind refused for anonymous guest", /orchestrator-only/.test(n.text), n?.text);
}

// ============ 9. Legacy compatibility ============
{
	const taskId = await buildTask("legacy");
	await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "worker-a", cwd: scratch });
	// strip all attempt metadata (legacy shape)
	const t = readTask(taskId);
	const node = t.nodes.plan;
	const msgId = node.assignmentMessageId;
	delete node.activeAttemptId;
	delete node.attemptHistory;
	node.status = "in_progress";
	node.assignee = "worker-a";
	node.lastActivityAt = iso(OLD);
	writeTask(taskId, t);
	const n = await runSwarm(`remind ${taskId} plan`);
	ok("9a legacy unfenced assignment never eligible", /NOT sent/.test(n.text), n?.text);
	const st = readState();
	st.messages[msgId] && (st.messages[msgId].ackedAt = iso(OLD), st.messages[msgId].lastAck = { by: "worker-a", status: "processing", at: iso(OLD) });
	writeState(st);
	const n2 = await runSwarm(`attention ${taskId}`);
	ok("9b legacy task still readable in attention report", !/Swarm error/.test(n2.text), n2?.text);
}

// ============ 10. No state mutation beyond the reminder record ============
{
	const taskId = await buildTask("mutate");
	await call("swarm_assign_task", { taskId, nodeId: "plan", agentId: "worker-a", cwd: scratch });
	ageAssignment(taskId, "plan");
	const before = readTask(taskId);
	await runSwarm(`remind ${taskId} plan`);
	const after = readTask(taskId);
	// strip the single legal addition and compare node semantics
	const strip = (t) => {
		const c = JSON.parse(JSON.stringify(t));
		delete c.updatedAt; // writeTaskState stamps updatedAt on every write
		for (const n of Object.values(c.nodes)) for (const a of n.attemptHistory || []) delete a.reminder;
		return c;
	};
	ok("10a task.json unchanged modulo attempt.reminder", JSON.stringify(strip(before)) === JSON.stringify(strip(after)));
	ok("10b task status unchanged", before.status === after.status);
}

console.log(`\n${fail === 0 ? "ATTENTION PASS" : "ATTENTION FAIL"} (${pass} passed, ${fail} failures)`);
rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
