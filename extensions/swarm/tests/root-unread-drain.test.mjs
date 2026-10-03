#!/usr/bin/env node
/**
 * root-unread-drain.test.mjs — bug fix 2026-10-02 RED-GREEN reproduction.
 *
 * Symptom (live session evidence, worktree feat-milestones 2026-09-30, root transcript):
 *   swarm_check_mailbox(agentId:"root", fullBody:true, markDelivered:true) returned the SAME
 *   6 messages (5,841B of full bodies) at least 5 times, with unread=1 never draining, because:
 *
 *     - computeUnreadForTool (root) counts unread as `!rec.surfacedAt`;
 *     - surfacedAt is ONLY stamped for informational messages (requiresAck === false) — both in
 *       the markDelivered branch of swarm_check_mailbox (guard `rec.requiresAck !== false` → skip)
 *       and in the root pump (same guard, pump.ts:252);
 *     - actionable messages (requiresAck:true — task-stall, graph-advance nudges, goal
 *       escalations under legacy flag) get a consumerReceipts entry instead, which the unread
 *       computation never consults;
 *     - swarm_ack_message is commented out of the registration set, so no ack path exists.
 *
 *   Net effect: unread for root is permanently stuck on actionable messages and the model
 *   re-reads the full bodies forever (~29KB of duplicate context in one session).
 *
 * Invariants under test (fake-pi harness, same shape as tool-output-budget.test.mjs):
 *   1.  RED (bug): actionable root message (requiresAck:true) with a pump consumer receipt
 *       still counts as unread after check_mailbox(markDelivered:true).
 *       GREEN: it drains — unread reflects surfacedAt OR consumerReceipts OR ackedAt.
 *   2.  informational messages (requiresAck:false) keep draining via surfacedAt (no regression).
 *   3.  unread flag on individual rows agrees with the count (row-level same predicate).
 *   4.  markDelivered:true stamps a durable read marker for actionable messages too (seenAt via
 *       lifecycle derivation or surfacedAt) so a LATER root session does not re-count them.
 *   5.  A legacy actionable message with ackedAt set (pre-minimal-protocol era) counts as read.
 *   6.  Worker ledger semantics unchanged: delivered-set keyed unread (no surfacedAt involved).
 *
 * Run: PI_SWARM_AGENT_ID=root PI_SWARM_IS_ROOT=1 node extensions/swarm/tests/root-unread-drain.test.mjs
 */
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), `swarm-unread-drain-${process.pid}-${Date.now()}`));
await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });

let pass = 0,
	fail = 0;
const ok = (name, cond, extra = "") => {
	if (cond) {
		pass++;
		console.log("  ok  ", name, extra);
	} else {
		fail++;
		console.error("  FAIL", name, extra);
	}
};
const B = (s) => Buffer.byteLength(s, "utf8");

const T0 = Date.now();
const iso = (ms) => new Date(T0 - ms).toISOString();

// ---- seed: root mailbox mirroring the live incident ----
// msg-action: actionable nudge (requiresAck:true) ALREADY surfaced by the pump
//             (consumerReceipts entry written at pump surface time). This is the stuck one.
// msg-info:  informational message already surfaced via the legacy surfacedAt stamp.
// msg-new:   fresh informational message, never surfaced.
// msg-acked: legacy actionable message that WAS acked (ackedAt set) pre-minimal-protocol.
const leaf = (id, subject, o = {}) =>
	JSON.stringify({
		id,
		swarmId: "t",
		from: "worker-1",
		to: "root",
		subject,
		priority: "high",
		type: "swarm.message",
		schemaVersion: 1,
		createdAt: o.createdAt,
		body: o.body ?? "Body. " + "x".repeat(400),
		requiresAck: o.requiresAck ?? false,
		requiresResponse: o.requiresResponse ?? false,
		headers: {},
		idempotencyKey: `k-${id}`,
	});

const ACTION_ID = "msg-action-01";
const INFO_ID = "msg-info-01";
const NEW_ID = "msg-new-01";
const ACKED_ID = "msg-acked-01";

const messages = {
	[ACTION_ID]: {
		id: ACTION_ID,
		from: "worker-1",
		to: "root",
		status: "injected",
		createdAt: iso(600_000),
		updatedAt: iso(600_000),
		injectedAt: iso(590_000),
		attempts: 1,
		requiresAck: true,
		requiresResponse: false,
		subject: "Task stall: node implement in_progress too long",
	},
	[INFO_ID]: {
		id: INFO_ID,
		from: "worker-1",
		to: "root",
		status: "injected",
		createdAt: iso(500_000),
		updatedAt: iso(500_000),
		injectedAt: iso(490_000),
		attempts: 1,
		requiresAck: false,
		requiresResponse: false,
		subject: "Status update",
		surfacedAt: iso(480_000), // already surfaced (informational path)
	},
	[NEW_ID]: {
		id: NEW_ID,
		from: "worker-1",
		to: "root",
		status: "queued",
		createdAt: iso(60_000),
		updatedAt: iso(60_000),
		attempts: 0,
		requiresAck: false,
		requiresResponse: false,
		subject: "Fresh notification",
	},
	[ACKED_ID]: {
		id: ACKED_ID,
		from: "worker-1",
		to: "root",
		status: "acked",
		createdAt: iso(700_000),
		updatedAt: iso(400_000),
		injectedAt: iso(690_000),
		ackedAt: iso(400_000),
		attempts: 1,
		requiresAck: true,
		requiresResponse: false,
		subject: "Legacy acknowledged assignment",
	},
};

// The pump wrote a durable consumer receipt for the actionable message when it surfaced it.
const consumerReceipts = {
	root: {
		revision: 1,
		entries: {
			[ACTION_ID]: {
				surfacedAt: iso(580_000),
				requiresAck: true,
				conversationId: undefined,
				fingerprint: "seed",
			},
		},
	},
};

const state = {
	version: 1,
	swarmId: "unread-drain-test",
	cwd: scratch,
	tmuxSession: "swarm",
	agents: {},
	delivered: {},
	messages,
	consumerReceipts,
};
await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(state, null, 2), "utf8");
await writeFile(
	join(scratch, ".pi/swarm/mailboxes/root.jsonl"),
	[ACTION_ID, INFO_ID, NEW_ID, ACKED_ID].map((id) =>
		leaf(id, messages[id].subject, {
			createdAt: messages[id].createdAt,
			requiresAck: messages[id].requiresAck,
			requiresResponse: messages[id].requiresResponse,
		}),
	).join("\n") + "\n",
	"utf8",
);

// ---- load the real extension ----
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
process.env.PI_SWARM_TERMINAL_MANAGER = "tmux";

const tools = {};
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	exec: async () => ({ code: 1, stdout: "", stderr: "" }),
	sendMessage: () => {},
};
const mod = await import(join(here, "..", "index.ts"));
mod.default(pi);
const call = (n, p) => tools[n].execute("t", p, undefined, undefined, { cwd: scratch });
const textOf = (r) => r?.content?.[0]?.text ?? "";
const parseOf = (r) => JSON.parse(textOf(r));

// ============================================================================
// Case 1 — RED (the bug): actionable + pump-receipt message must drain on markDelivered
// ============================================================================
console.log("\n[C1] actionable root message drains after markDelivered:true");
{
	const r1 = await call("swarm_check_mailbox", { agentId: "root", limit: 20 });
	const p1 = parseOf(r1);
	// Pre-read state: only msg-new is genuinely unseen (info already surfaced; action has a
	// consumer receipt; acked has ackedAt). The bug reports unread=2 (action + new).
	ok("C1 initial read-only scan: unread counts only the fresh message", p1.unread === 1, `got ${p1.unread}`);
	const actionRow = p1.messages.find((m) => m.id === ACTION_ID);
	ok("C1 actionable row not flagged unread (consumer receipt exists)", actionRow?.unread === false, JSON.stringify(actionRow));

	// Second poll after markDelivered: the fresh message must drain too.
	const r2 = await call("swarm_check_mailbox", { agentId: "root", markDelivered: true, limit: 20 });
	const p2 = parseOf(r2);
	ok("C1 second poll: unread fully drained to 0", p2.unread === 0, `got ${p2.unread}`);
	const newRow = p2.messages.find((m) => m.id === NEW_ID);
	ok("C1 fresh row no longer unread after markDelivered", newRow?.unread === false, JSON.stringify(newRow));
}

// ============================================================================
// Case 2 — informational surfacedAt path unchanged
// ============================================================================
console.log("\n[C2] informational surfacedAt semantics (no regression)");
{
	const r = await call("swarm_check_mailbox", { agentId: "root", limit: 20 });
	const p = parseOf(r);
	const infoRow = p.messages.find((m) => m.id === INFO_ID);
	ok("C2 informational already-surfaced row is read", infoRow?.unread === false, JSON.stringify(infoRow));
}

// ============================================================================
// Case 3 — row flags agree with the count
// ============================================================================
console.log("\n[C3] unread flag vs count consistency");
{
	const r = await call("swarm_check_mailbox", { agentId: "root", limit: 20 });
	const p = parseOf(r);
	const flagged = p.messages.filter((m) => m.unread === true).length;
	ok("C3 count equals number of flagged rows", p.unread === flagged, `count=${p.unread} flagged=${flagged}`);
}

// ============================================================================
// Case 4 — markDelivered leaves a durable marker for actionable messages
// ============================================================================
console.log("\n[C4] durable read marker after markDelivered (later session)");
{
	// Simulate a later root session: wipe the volatile in-process markers the tool itself owns
	// (none exist — the tool is stateless across sessions) and drop the delivered ledger entry
	// for the fresh message, because root unread keys on durable markers (surfacedAt /
	// consumer receipts / ackedAt), NOT on st.delivered.root. After C1's markDelivered:true the
	// fresh message must carry a durable marker; otherwise a later session re-counts it.
	const stPath = join(scratch, ".pi/swarm/swarm-state.json");
	const st = JSON.parse(await readFile(stPath, "utf8"));
	ok(
		"C4 fresh message got a durable surfacedAt marker from markDelivered",
		typeof st.messages[NEW_ID]?.surfacedAt === "string",
		JSON.stringify(st.messages[NEW_ID] || null),
	);
	// A later-session read-only scan (delivered ledger is irrelevant for root unread) must stay drained.
	const r = await call("swarm_check_mailbox", { agentId: "root", limit: 20 });
	const p = parseOf(r);
	ok("C4 later session scan still drained", p.unread === 0, `got ${p.unread}`);
}

// ============================================================================
// Case 5 — legacy acked actionable message counts as read
// ============================================================================
console.log("\n[C5] ackedAt actionable message is read");
{
	const r = await call("swarm_check_mailbox", { agentId: "root", limit: 20 });
	const p = parseOf(r);
	const ackedRow = p.messages.find((m) => m.id === ACKED_ID);
	ok("C5 acked actionable row is present", !!ackedRow, `messages=${p.messages.map((m) => m.id).join(",")}`);
	ok("C5 acked actionable row is read", ackedRow?.unread === false, JSON.stringify(ackedRow));
}

// ============================================================================
// Case 6 — worker ledger semantics unchanged
// ============================================================================
console.log("\n[C6] worker delivered-ledger semantics unchanged");
{
	// seed a worker mailbox + ledger
	const st = JSON.parse(await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
	st.delivered["worker-9"] = [ACTION_ID];
	st.messages[NEW_ID + "-w"] = {
		id: NEW_ID + "-w",
		from: "root",
		to: "worker-9",
		status: "queued",
		createdAt: iso(30_000),
		updatedAt: iso(30_000),
		attempts: 0,
		requiresAck: false,
		requiresResponse: false,
		subject: "Worker assignment",
	};
	await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(st, null, 2), "utf8");
	await writeFile(
		join(scratch, ".pi/swarm/mailboxes/worker-9.jsonl"),
		leaf(NEW_ID + "-w", "Worker assignment", { createdAt: iso(30_000) }) + "\n",
		"utf8",
	);
	const r = await call("swarm_check_mailbox", { agentId: "worker-9", limit: 20 });
	const p = parseOf(r);
	ok("C6 worker unread keys on delivered ledger", p.unread === 1, `got ${p.unread}`);
}

// ============================================================================
// Case 7 — full-body re-dump cost: after drain, a follow-up fullBody poll reports unread=0
// (the model's signal to NOT re-read; the bytes are only re-injected when it chooses to)
// ============================================================================
console.log("\n[C7] fullBody follow-up reports drained unread");
{
	const r = await call("swarm_check_mailbox", { agentId: "root", fullBody: true, limit: 20 });
	const p = parseOf(r);
	ok("C7 fullBody poll: unread stays 0 after drain", p.unread === 0, `got ${p.unread}`);
	ok("C7 fullBody bodies present when explicitly requested", typeof p.messages?.[0]?.body === "string" || p.messages?.length === 0);
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) {
	console.error("\nRED confirmed: root unread does not drain on actionable/consumer-receipt messages.");
	process.exit(1);
}
console.error("\nGREEN: all invariants hold.");
