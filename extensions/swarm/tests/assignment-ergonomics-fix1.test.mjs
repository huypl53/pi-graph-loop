#!/usr/bin/env node
/**
 * Assignment ergonomics Fix 1 — stale-replyTo completion redirect (task-202610031216).
 *
 * RED-FIRST (repo mandate): this suite must FAIL on the pre-fix engine, then PASS post-fix.
 *
 * Live-probe forensics (task-202610031143 + root's context-analysis.md): a worker's first turn
 * after a NEW assignment replies to the PREVIOUS assignment message id still visible in its
 * context. Today that reply (a) leaves the reply as unanchored noise in root's mailbox and
 * (b) never credits the ACTIVE assignment record (replyContextCurrent=false fence, mailbox.ts).
 * Root then sees duplicate-looking "Implement done"/"Test done" pairs.
 *
 * Contract under test (post-fix):
 *   F1  A completion reply whose replyTo points at a SUPERSEDED assignment of the SAME
 *       task+node is redirected at the engine boundary: verification credit lands on the
 *       CURRENT assignment record (node.assignmentMessageId), a message.response.redirected
 *       trace is emitted, and the superseded record's waived/supersession evidence is NOT
 *       erased.
 *   F2  A direct reply to the CURRENT assignment still verifies with NO redirect trace
 *       (happy path byte-unchanged).
 *   F3  A reply to a superseded assignment of a DIFFERENT node (or non-assignment message) is
 *       NOT redirected (fence preserved).
 *   F4  Exactly ONE verified completion per node attempt: after redirect, no dangling
 *       response_missing / unanchored verified record remains on the dead assignment.
 *
 * Run: node extensions/swarm/tests/assignment-ergonomics-fix1.test.mjs
 */

import { rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-ergo-fix1-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

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

let pass = 0,
	fail = 0;
const ok = (n, c, extra) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n, extra ?? "");
	}
};

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
const readStateJson = () => JSON.parse(readFileSync(statePath, "utf8"));
const tracesDir = join(scratch, ".pi/swarm/traces");
const eventsFiles = () => {
	if (!existsSync(tracesDir)) return [];
	return [join(tracesDir, "events.jsonl")];
};
const readTraces = () => {
	const lines = [];
	for (const f of eventsFiles()) {
		if (!existsSync(f)) continue;
		for (const line of readFileSync(f, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				lines.push(JSON.parse(line));
			} catch {
				/* torn tail line during concurrent write — ignore in test reader */
			}
		}
	}
	return lines;
};

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

// ---- setup: task ergo-f1 with plan -> implement; implement is the node under test ----
const ct = await call("swarm_create_task", {
	taskId: "task-ergo-f1",
	title: "ergonomics fix1",
	goal: "stale-replyTo redirect repro",
	cwd: scratch,
	start: "plan",
	nodes: {
		plan: { role: "planner", dependsOn: [], writeArtifacts: ["artifacts/plan.md"] },
		implement: { role: "implementer", dependsOn: ["plan"], writeArtifacts: ["artifacts/implementation-report.md"] },
		review: { role: "reviewer", dependsOn: ["implement"], writeArtifacts: ["artifacts/review.md"] },
	},
	edges: [
		{ from: "plan", to: "implement", when: "planned" },
		{ from: "implement", to: "review", when: "implemented" },
	],
});
ok("setup: task created", !ct?.details?.error, JSON.stringify(ct?.details?.error || ""));

await ensureWorker("planner-1", "planner");
await ensureWorker("impl-1", "implementer");

// plan -> done so implement becomes ready
await as("planner-1", "swarm_send_message", {
	to: "root",
	replyTo: readTaskMsgId("plan"),
	body: "plan result",
	cwd: scratch,
});
await as("planner-1", "swarm_update_task", { taskId: "task-ergo-f1", nodeId: "plan", status: "done", outcome: "planned", cwd: scratch });

function readTaskMsgId(nodeId) {
	const task = JSON.parse(readFileSync(join(scratch, ".pi/swarm/tasks/task-ergo-f1/task.json"), "utf8"));
	return task.nodes[nodeId]?.assignmentMessageId;
}

// Assign implement (attempt A1). Then reassign (cross-agent not needed; genuine reassign after
// a state move is the deterministic supersede path — simplest: root reassigns to the same agent
// from "assigned" state is a duplicate retry which does NOT supersede, so force a genuine
// supersede by moving the node to blocked first, like attempt-fencing.test.mjs does).
await call("swarm_assign_task", { taskId: "task-ergo-f1", nodeId: "implement", agentId: "impl-1", cwd: scratch });
const msgA1 = readTaskMsgId("implement");
ok("setup: A1 assignment message exists", !!msgA1, msgA1 || "(none)");

// Genuine supersede: root forces node to blocked, then reassigns (mints A2).
await call("swarm_update_task", { taskId: "task-ergo-f1", nodeId: "implement", status: "blocked", force: true, cwd: scratch });
await call("swarm_assign_task", { taskId: "task-ergo-f1", nodeId: "implement", agentId: "impl-1", cwd: scratch });
const msgA2 = readTaskMsgId("implement");
ok("setup: A2 assignment message exists and differs from A1", !!msgA2 && msgA2 !== msgA1, `${msgA2} vs ${msgA1}`);

const st1 = readStateJson();
ok(
	"setup: A1 record is superseded + waived by the reassign",
	st1.messages[msgA1]?.superseded && st1.messages[msgA1]?.response?.status === "waived",
	JSON.stringify({ superseded: !!st1.messages[msgA1]?.superseded, response: st1.messages[msgA1]?.response?.status }),
);
ok(
	"setup: A2 record is live requiresResponse",
	!st1.messages[msgA2]?.superseded && st1.messages[msgA2]?.requiresResponse === true,
	JSON.stringify({ superseded: !!st1.messages[msgA2]?.superseded, rr: st1.messages[msgA2]?.requiresResponse }),
);

// ============ F1 RED: completion reply aimed at the STALE A1 id ============
const reply1 = await as("impl-1", "swarm_send_message", {
	to: "root",
	replyTo: msgA1,
	conversationId: "task:task-ergo-f1:implement",
	body: "Implement done",
	cwd: scratch,
});
ok("F1: reply sent", !reply1?.details?.error, JSON.stringify(reply1?.details?.error || ""));

const st2 = readStateJson();
const traces2 = readTraces();

// RED expectations (pre-fix these fail):
const redirectedTrace = traces2.find(
	(t) => t.event === "message.response.redirected" && t.redirectedFrom === msgA1 && t.redirectedTo === msgA2,
);
ok("F1: message.response.redirected trace emitted (from A1 to A2)", !!redirectedTrace, `traces: ${traces2.map((t) => t.event).slice(-8).join(",")}`);
ok(
	"F1: credit lands on the CURRENT assignment record (A2 verified)",
	st2.messages[msgA2]?.response?.status === "verified" && st2.messages[msgA2]?.response?.resultMessageId === reply1?.details?.message?.id,
	JSON.stringify(st2.messages[msgA2]?.response || {}),
);
ok(
	"F1: supersession evidence on A1 NOT erased (still waived/superseded)",
	st2.messages[msgA1]?.superseded && st2.messages[msgA1]?.response?.status === "waived",
	JSON.stringify({ superseded: !!st2.messages[msgA1]?.superseded, response: st2.messages[msgA1]?.response?.status }),
);
ok(
	"F1: no dangling open response debt on A1 (responseMissing excludes it)",
	(st2.messages[msgA1]?.response?.status === "waived" || st2.messages[msgA1]?.response?.status === "verified") === true,
	st2.messages[msgA1]?.response?.status || "(none)",
);

// ============ F2: direct reply to CURRENT A2 (post-fix happy path, no redirect) ============
// A2 already verified by the redirect leg; verify a SECOND direct reply does not emit another
// redirect and does not flip A1 evidence. Send a second completion aimed at A2.
const reply2 = await as("impl-1", "swarm_send_message", {
	to: "root",
	replyTo: msgA2,
	conversationId: "task:task-ergo-f1:implement",
	body: "Implement done (direct)",
	cwd: scratch,
});
ok("F2: direct reply sent", !reply2?.details?.error, JSON.stringify(reply2?.details?.error || ""));
const st3 = readStateJson();
const traces3 = readTraces();
const redirectCount = traces3.filter((t) => t.event === "message.response.redirected").length;
ok("F2: still exactly ONE redirect trace total (direct reply did not redirect)", redirectCount === 1, `redirects: ${redirectCount}`);
ok(
	"F2: A2 response remains verified",
	st3.messages[msgA2]?.response?.status === "verified",
	st3.messages[msgA2]?.response?.status || "(none)",
);

// ============ F3: superseded assignment of a DIFFERENT node must NOT be redirected ============
// plan's assignment (already done + superseded by task lifecycle) — reply aimed at it stays fenced.
const msgPlan = readTaskMsgId("plan");
const reply3 = await as("planner-1", "swarm_send_message", {
	to: "root",
	replyTo: msgPlan,
	conversationId: "task:task-ergo-f1:plan",
	body: "plan done (late reply to plan assignment)",
	cwd: scratch,
});
ok("F3: late cross-node reply sent (accepted as traffic)", !reply3?.details?.error, JSON.stringify(reply3?.details?.error || ""));
const traces4 = readTraces();
const planRedirect = traces4.find(
	(t) => t.event === "message.response.redirected" && t.redirectedFrom === msgPlan,
);
ok("F3: NO redirect emitted for cross-node stale reply", !planRedirect, JSON.stringify(planRedirect || {}));
const st4 = readStateJson();
ok(
	"F3: plan assignment record not re-credited as verified by the redirect path",
	st4.messages[msgPlan]?.response?.status !== "verified" || st4.messages[msgPlan]?.response?.resultMessageId === undefined,
	JSON.stringify(st4.messages[msgPlan]?.response || {}),
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
