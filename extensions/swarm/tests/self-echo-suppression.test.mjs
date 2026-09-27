// self-echo-suppression.test.mjs — task self-echo-pump-suppression-20260927
//
// RED-GREEN spec (plan §2, S2 amended per root 2026-09-27 17:14):
//   S1 (red on main): root-authored result-class + assignment echo messages are
//      classified ACTIONABLE by isActionableRootMessage (no sender check; R24
//      result-class exemption rescues self-echoes). The bug.
//   S2 (red on main): inferRoleKind's role-TEXT fallback misclassifies a node
//      whose role merely MENTIONS "root" ("root-vs-worker", "Root closes task")
//      as kind "root" — so swarm_assign_task takes the DELIBERATE root-branch
//      (assign.ts expectedKind==="root") on a false premise. Live incident:
//      review + implement nodes auto-routed to the root pseudo-agent.
//   S3 (green guard, must pass pre AND post fix): genuine worker→root
//      result-class messages stay actionable (R24 exemption intact).
//   S4 (green guard): root-authored INFORMATIONAL echoes (requiresAck:false)
//      remain in the actionable:false-but-surfaceable class the pump uses for
//      one-time informational surfacing (the fix suppresses the actionable
//      class only; informational visibility is a pump-path property, asserted
//      here at the predicate + census level).
//   S5 (green guard): a node whose role text GENUINELY designates root
//      ownership (role text STARTS with "Root ") keeps routing to root via the
//      deliberate branch after the fix (task-1 done-node behavior preserved).
//
// Run: PI_SWARM_AGENT_ID=root PI_SWARM_IS_ROOT=1 node extensions/swarm/tests/self-echo-suppression.test.mjs
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0,
	fail = 0;
const ok = (name, cond, detail) => {
	if (cond) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.log(`  FAIL ${name} ${detail ?? ""}`);
	}
};

process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
process.env.PI_SWARM_TERMINAL_MANAGER ||= "tmux";

const scratch = await mkdtemp(join(tmpdir(), "self-echo-"));
await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
const st0 = { agents: {}, tasks: {}, messages: {} };
await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(st0, null, 2), "utf8");

const tools = {};
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	sendMessage: () => {},
	setModel: async () => true,
};
const mod = await import(join(here, "..", "index.ts"));
mod.default(pi);
const call = async (name, params) => {
	const t = tools[name];
	if (!t) throw new Error(`no tool ${name}`);
	return t.execute("t", params, undefined, undefined, { cwd: scratch });
};
const textOf = (r) => r?.content?.[0]?.text ?? "";

const { isActionableRootMessage } = await import(join(here, "..", "src", "surface", "actionable.ts"));
const { inferRoleKind } = await import(join(here, "..", "src", "utils.ts"));
const { decideSurfaceLocked } = await import(join(here, "..", "src", "surface", "pump-decision.ts"));
const { paths, withLock, readState, writeState } = await import(join(here, "..", "src", "state.ts"));
const { ensureRoot, heartbeatRootLeader } = await import(join(here, "..", "src", "identity.ts"));

const now = Date.now();
const LIVE = { T1: { taskId: "T1", status: "in_progress", nodes: { n1: { nodeId: "n1", status: "in_progress" } } } };

// ============================================================
// S1 — self-echo actionable on main (RED = the bug)
// ============================================================
console.log("\n--- S1: root-authored echoes NOT actionable post-fix (self_origin) ---");
{
	const selfResult = {
		id: "m-self-result",
		to: "root",
		from: "root",
		requiresAck: true,
		requiresResponse: false,
		replyTo: "msg-x",
		conversationId: "task:T1:n1",
	};
	const v1 = isActionableRootMessage(selfResult, LIVE, now, {}, false);
	ok("S1a root result-class echo suppressed as self_origin", v1.ok === false && v1.reason === "self_origin", JSON.stringify(v1));

	const selfAssignEcho = {
		id: "m-self-echo",
		to: "root",
		from: "root",
		requiresAck: true,
		conversationId: "task:T1:n1",
	};
	const v2 = isActionableRootMessage(selfAssignEcho, LIVE, now, {}, false);
	ok("S1b root assignment echo suppressed as self_origin", v2.ok === false && v2.reason === "self_origin", JSON.stringify(v2));
}

// ============================================================
// S2 — role-text "root" mention misroutes node classification (red on main)
// ============================================================
console.log("\n--- S2: role-text 'root' mention no longer hijacks classification (fixed) ---");
{
	// The live incident shape: a REVIEW node whose descriptive role text mentions root.
	const gotReview = inferRoleKind("review", "reviewer: verify implement result; unread ledger split root-vs-worker semantics.");
	ok("S2a reviewer node mentioning 'root' classifies as reviewer", gotReview === "reviewer", `got ${gotReview}`);
	const gotImpl = inferRoleKind("implement", "implementer step for the root-authored spec.");
	ok("S2b implementer node mentioning 'root' classifies as implementer", gotImpl === "implementer", `got ${gotImpl}`);
	// And a genuine reviewer text (no root mention) classifies correctly:
	ok("S2c clean reviewer text still 'reviewer'", inferRoleKind("review", "Senior reviewer of node results.") === "reviewer");

	// Assign-path shape: with the corrected classification, the deliberate root branch is
	// NOT taken (expectedKind = inferRoleKind(nodeId, role); assign.ts:178 fires only on
	// expectedKind === "root").
	const expectedKind = inferRoleKind("review", "reviewer: verify implement result; unread ledger split root-vs-worker semantics.");
	const deliberateBranchTaken = expectedKind === "root";
	ok("S2d assign deliberate root-branch NOT taken on mention-only text", deliberateBranchTaken === false, `expectedKind=${expectedKind}`);
}

// ============================================================
// S3 — R24 regression guard: worker→root results stay actionable (green pre+post)
// ============================================================
console.log("\n--- S3: worker→root result stays actionable (R24 intact) ---");
{
	const workerResult = {
		id: "m-worker-result",
		to: "root",
		from: "worker-a",
		requiresAck: true,
		requiresResponse: false,
		replyTo: "msg-x",
		conversationId: "task:T1:n1",
	};
	const v = isActionableRootMessage(workerResult, LIVE, now, {}, false);
	ok("S3a worker result-class actionable (live task)", v.ok === true, JSON.stringify(v));
	const doneState = { T1: { taskId: "T1", status: "done", nodes: { n1: { nodeId: "n1", status: "done" } } } };
	const vDone = isActionableRootMessage(workerResult, doneState, now, {}, false);
	ok("S3b worker result actionable (task done — R24 exemption)", vDone.ok === true, JSON.stringify(vDone));
	const plain = { id: "m-w2", to: "root", from: "worker-a", requiresAck: true, requiresResponse: false, replyTo: "msg-x" };
	const vPlain = isActionableRootMessage(plain, {}, now, {}, false);
	ok("S3c worker result actionable (plain PM shape)", vPlain.ok === true, JSON.stringify(vPlain));
}

// ============================================================
// S4 — informational echo one-time surfacing preserved (green target)
// ============================================================
console.log("\n--- S4: root-authored informational echo still surfaceable ---");
{
	const infoEcho = { id: "m-info", to: "root", from: "root", requiresAck: false };
	const v = isActionableRootMessage(infoEcho, {}, now, {}, false);
	// On main it lands in the actionable class; post-fix it must NOT be suppressed-as-junk:
	// the acceptable post-fix verdicts are actionable (main behavior, informational batch
	// path handles one-time surfacing upstream via surfacedAt/consumerReceipts) OR a
	// dedicated non-actionable-but-surfaceable classification. Unacceptable: dead_letter/
	// superseded/acked-style hard suppression.
	ok("S4 informational echo not hard-suppressed", v.ok === true || v.reason === "self_origin", JSON.stringify(v));
}

// ============================================================
// S5 — deliberate root-ownership role text keeps routing to root (green target)
// ============================================================
console.log("\n--- S5: genuine root-ownership role text still 'root' kind ---");
{
	ok("S5a 'Root closes task…' text → root kind", inferRoleKind("done", "Root closes task after review verdict.") === "root");
	ok(
		"S5b root pseudo-agent ownership phrasing → root kind",
		inferRoleKind("commit", "Root pseudo-agent commits the release tag.") === "root",
	);
}

// ============================================================
// S6 — engine nudges authored by root-side machinery stay actionable
// (design correction: self_origin exempts canonical engine-nudge keys)
// ============================================================
console.log("\n--- S6: engine nudges (from:'root' but canonical nudge keys) stay actionable ---");
{
	const cases = [
		[
			"stale-open",
			{
				id: "m-n1",
				to: "root",
				from: "root",
				requiresAck: true,
				conversationId: "task:T1:n1",
				idempotencyKey: "task:T1:node:n1:nudge:stale-open:seq:1",
			},
		],
		["goal idle", { id: "m-n2", to: "root", from: "root", requiresAck: true, idempotencyKey: "goal:g1:nudge:idle-streak:1" }],
		[
			"goal pool-empty escalation",
			{
				id: "m-n3",
				to: "root",
				from: "root",
				requiresAck: true,
				idempotencyKey: "goal:g1:escalation:pool-empty:2026-09-27T10",
				conversationId: "goal:g1:escalation:pool-empty:cooldown:900000",
			},
		],
		[
			"graph-stall",
			{
				id: "m-n4",
				to: "root",
				from: "root",
				requiresAck: true,
				conversationId: "task:T1:n1",
				idempotencyKey: "task:T1:nudge:graph-stall:2",
			},
		],
		[
			"r20 artifact-progress",
			{ id: "m-n5", to: "root", from: "root", requiresAck: true, conversationId: "task:T1:n1", idempotencyKey: "r20:nudge:T1:n1:2" },
		],
		[
			"settle-stale",
			{ id: "m-n6", to: "root", from: "root", requiresAck: true, idempotencyKey: "task:T1:agent:w1:nudge:settle-stale" },
		],
		["initial-ready", { id: "m-n7", to: "root", from: "root", requiresAck: true, idempotencyKey: "task:T1:nudge:initial-ready" }],
	];
	for (const [name, rec] of cases) {
		const v = isActionableRootMessage(rec, LIVE, now, {}, false);
		ok(`S6 ${name} nudge actionable`, v.ok === true, JSON.stringify(v));
	}
}

// ============================================================
// Rework (review blocking finding) — S7: REAL pump decision path with a
// fresh root-authored requiresAck:false informational echo (no surfacedAt,
// no receipt): must surface EXACTLY ONCE via decideSurfaceLocked, then be
// deduped on the second tick (surfacedAt stamp), with no re-trigger counting.
// And S8: a fresh root-authored ACK-EXPECTED echo yields self_origin → 0 surfaces.
// ============================================================
let scenarioCounter = 0;
function freshScratchDir(prefix) {
	scenarioCounter++;
	return join(scratch, `pump-${prefix}-${scenarioCounter}`);
}
async function seedPumpShape({ requiresAck = false, idempotencyKey, conversationId, taskId = "T1", nodeId = "n1" } = {}) {
	const echo = { requiresAck, idempotencyKey, conversationId };
	const dir = freshScratchDir(echo.requiresAck ? "ack" : "info");
	await mkdir(join(dir, ".pi/swarm/tasks", taskId), { recursive: true });
	const ts = new Date(Date.now() - 1_000).toISOString();
	const initial = {
		version: 1,
		swarmId: "selfecho-pump",
		cwd: dir,
		tmuxSession: "se",
		agents: {},
		delivered: {},
		messages: {},
		createdAt: ts,
		updatedAt: ts,
	};
	await writeFile(join(dir, ".pi/swarm/swarm-state.json"), JSON.stringify(initial), "utf8");
	const task = {
		version: 1,
		taskId,
		title: "SE pump",
		goal: "t",
		status: "in_progress",
		priority: "normal",
		createdAt: ts,
		updatedAt: ts,
		owner: "root",
		workflow: "feature-dev",
		allowedFiles: [],
		acceptanceCriteria: [],
		validationCommands: [],
		start: nodeId,
		currentNodes: [nodeId],
		sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] },
		nodes: {
			[nodeId]: {
				status: "in_progress",
				role: "implementer",
				assignee: "worker-a",
				dependsOn: [],
				messageIds: [],
				attempts: 1,
				lastActivityAt: ts,
			},
		},
		edges: [],
		handoffs: [],
		gates: {},
		editLocks: {},
		evidence: {},
	};
	await writeFile(join(dir, ".pi/swarm/tasks", taskId, "task.json"), JSON.stringify(task, null, 2), "utf8");
	const p = paths(dir);
	const msgId = `m-${echo.requiresAck ? "ack" : "info"}-${scenarioCounter}`;
	await withLock(p, async () => {
		const st = await readState(p, dir);
		ensureRoot(st, dir, p);
		heartbeatRootLeader(st, Date.now(), process.pid, "selfecho_seed");
		// reset migration backfill + session so this message is FRESH (no receipt, no surfaced set)
		if (st.consumerReceipts?.root) {
			st.consumerReceipts.root.entries = {};
			st.consumerReceipts.root.revision = 0;
		}
		const pidKey = String(process.pid);
		if (st.rootPumpSessions?.[pidKey]) {
			st.rootPumpSessions[pidKey].ids = [];
			st.rootPumpSessions[pidKey].triggeredAt = {};
			st.rootPumpSessions[pidKey].retriggerCount = {};
		}
		const rec = {
			id: msgId,
			swarmId: st.swarmId,
			from: "root", // root-authored echo — the class under test
			to: "root",
			subject: "Self-echo",
			priority: "normal",
			type: "swarm.message",
			schemaVersion: 1,
			createdAt: ts,
			body: "echo body",
			requiresAck: echo.requiresAck,
			requiresResponse: false,
			idempotencyKey: echo.idempotencyKey ?? undefined,
			conversationId: echo.conversationId ?? (echo.requiresAck ? `task:${taskId}:${nodeId}` : undefined),
		};
		st.messages[msgId] = rec;
		// The pump scans the mailbox JSONL file (readMailboxCached), not st.messages — append
		// there too, mirroring deliverMessageLocked's durable write (upsert + appendJsonl).
		await mkdir(join(dir, ".pi/swarm/mailboxes"), { recursive: true });
		await appendFile(join(dir, ".pi/swarm/mailboxes/root.jsonl"), JSON.stringify(rec) + "\n", "utf8");
		await writeState(p, st);
	});
	return { dir, p, msgId };
}
const pumpCtx = (dir) => ({
	cwd: dir,
	mode: "tui",
	isIdle: () => true,
	hasUI: false,
	ui: { setStatus: () => {} },
	model: { id: "m", provider: "p" },
});

console.log("\n--- S7: fresh root informational echo surfaces ONCE via real pump path (rework) ---");
{
	const { dir, p, msgId } = await seedPumpShape({ requiresAck: false });
	const t1 = await decideSurfaceLocked(pumpCtx(dir), p, await readState(p, dir), Date.now(), "agent_settled", true);
	ok(
		"S7a first tick surfaces the informational echo exactly once",
		t1.toSurface.length === 1 && t1.toSurface[0].id === msgId,
		JSON.stringify(t1.toSurface.map((m) => m.id)),
	);
	const st1 = await readState(p, dir);
	// NOTE: decideSurfaceLocked dedupes tick 2 via the per-pid surfaced session set (sess.ids);
	// the durable surfacedAt stamp is applied by pumpRootMailbox's write-back (pump.ts:250-255)
	// AFTER the decision returns — so at this layer assert the session set, not surfacedAt.
	ok("S7b message marked surfaced in the pump session set", Boolean(st1.rootPumpSessions?.[String(process.pid)]?.ids?.includes(msgId)));
	const t2 = await decideSurfaceLocked(pumpCtx(dir), p, await readState(p, dir), Date.now(), "agent_settled", true);
	ok("S7c second tick yields 0 surfaces (surfacedAt dedupe)", t2.toSurface.length === 0, JSON.stringify(t2.toSurface.map((m) => m.id)));
	const st2 = await readState(p, dir);
	const pidKey = String(process.pid);
	const retrig = st2.rootPumpSessions?.[pidKey]?.retriggerCount?.[msgId] ?? 0;
	ok("S7d no retrigger counting for informational self-echo", retrig === 0, `got ${retrig}`);
}

console.log("\n--- S8: fresh root ACK-EXPECTED echo still suppressed (self_origin, 0 surfaces) ---");
{
	const { dir, p, msgId } = await seedPumpShape({ requiresAck: true });
	const t1 = await decideSurfaceLocked(pumpCtx(dir), p, await readState(p, dir), Date.now(), "agent_settled", true);
	ok("S8a ack-expected self-echo yields 0 surfaces", t1.toSurface.length === 0, JSON.stringify(t1.toSurface.map((m) => m.id)));
	const st1 = await readState(p, dir);
	ok("S8b ack-expected self-echo not surfaced-stamped", !st1.messages[msgId]?.surfacedAt);
}

console.log("\n--- S9: engine-exemption precision — non-canonical goal: reference is NOT exempt ---");
{
	const rec = { id: "m-goalchat", to: "root", from: "root", requiresAck: true, conversationId: "goal:some-id:chat" };
	const v = isActionableRootMessage(rec, {}, now, {}, false);
	ok("S9 non-canonical goal: chat echo suppressed as self_origin", v.ok === false && v.reason === "self_origin", JSON.stringify(v));
	const recEsc = {
		id: "m-goalesc",
		to: "root",
		from: "root",
		requiresAck: true,
		idempotencyKey: "goal:g1:escalation:pool-empty:2026-09-27T10",
	};
	const vEsc = isActionableRootMessage(recEsc, {}, now, {}, false);
	ok("S9b canonical goal escalation still exempt (actionable)", vEsc.ok === true, JSON.stringify(vEsc));
}

// cleanup
await rm(scratch, { recursive: true, force: true }).catch(() => {});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
