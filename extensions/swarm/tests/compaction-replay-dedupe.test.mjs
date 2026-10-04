#!/usr/bin/env node
/**
 * Compaction-replay dedupe (task-202610040300-replay-after-compaction) — RED-first regression test.
 *
 * Live incident (2026-10-04 01:52–02:07Z): msg-1791078745920-a1685ac9 was delivered to
 * herdr-ws-fixer-2 via tmux inject + input_intercept (seenAt/processingAt/respondedAt stamped),
 * then after the worker session's auto-compaction, `agent_settled` → surfaceAgentPending
 * re-surfaced the SAME message id (trace `mailbox.agent_surface` 02:07:30, ids include a1685ac9)
 * because the pending filter only excluded acked/dead_letter/superseded/already-surfaced records —
 * not records whose swarm-visible lifecycle had already progressed.
 *
 * R10-1 boundary counting: assertions count calls at the REAL `pi.sendMessage` argument boundary
 * (spy on the ExtensionAPI stub passed to surfaceAgentPending), not an internal helper.
 *
 * RED expectation (pre-fix): surfaceAgentPending re-surfaces the lifecycle-progressed message
 * (≥1 pi.sendMessage) — the observed duplicate. GREEN expectation (post-fix): 0 calls.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, readState, writeState } from "../src/state.ts";
import { surfaceAgentPending } from "../src/hooks/pump-manager.ts";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-compaction-replay-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const p = paths(scratch);

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

process.env.PI_SWARM_AGENT_ID = "w1";

const now = new Date().toISOString();
// Seed: message delivered + seen + processed + responded (a1685ac9 shape), never acked,
// not superseded, not in agentSurfaced ledger (inject/intercept path never writes it).
{
	const st = await readState(p, scratch);
	st.messages["m-replayed"] = {
		id: "m-replayed",
		from: "root",
		to: "w1",
		status: "intercepted",
		createdAt: now,
		updatedAt: now,
		queuedAt: now,
		injectedAt: now,
		interceptedAt: now,
		seenAt: now,
		processingAt: now,
		respondedAt: now,
		attempts: 1,
		requiresAck: false,
		requiresResponse: true,
		response: { status: "verified", sentAt: now, verifiedAt: now },
		subject: "Task t / node test assigned",
		conversationId: "task:t:test",
	};
	// Control: a genuinely pending injected-but-unseen message must STILL surface.
	st.messages["m-pending"] = {
		id: "m-pending",
		from: "root",
		to: "w1",
		status: "injected",
		createdAt: now,
		updatedAt: now,
		queuedAt: now,
		injectedAt: now,
		attempts: 1,
		requiresAck: true,
		subject: "fresh assignment",
	};
	await writeState(p, st);
}

// Mailbox bodies (surfaceAgentPending reads bodies from the mailbox file). BOTH messages
// have bodies in the real incident — the replayed one is fully deliverable, which is exactly
// why the duplicate surfaced in the worker pane.
const mbLine = (id, subject, body) =>
	JSON.stringify({
		id,
		swarmId: "s",
		from: "root",
		to: "w1",
		subject,
		priority: "normal",
		type: "swarm.message",
		schemaVersion: 1,
		createdAt: now,
		body,
		requiresAck: id === "m-pending",
		headers: {},
	}) + "\n";
writeFileSync(join(p.mailboxes, "w1.jsonl"), mbLine("m-pending", "fresh assignment", "fresh work") + mbLine("m-replayed", "stale replay assignment", "stale work"));

const calls = [];
const pi = {
	sendMessage: (msg, opts) => {
		calls.push({ id: msg?.details?.id, opts });
	},
};
const ctx = { cwd: scratch, mode: "tui", isIdle: () => true };

const res = await surfaceAgentPending(pi, ctx, p, "w1", "compaction-replay-test");

// R10-1 boundary: count real pi.sendMessage calls.
const replayedCalls = calls.filter((c) => c.id === "m-replayed");
const pendingCalls = calls.filter((c) => c.id === "m-pending");

ok("RED: replayed id excluded from pending set", !res.ids.includes("m-replayed"), `ids=${JSON.stringify(res.ids)}`);
ok("RED: lifecycle-progressed message NOT re-sent after compaction", replayedCalls.length === 0, `got ${replayedCalls.length} pi.sendMessage calls for m-replayed`);
ok("control: fresh unseen pending message still surfaces", pendingCalls.length === 1, `got ${pendingCalls.length}`);
ok("boundary total: exactly 1 pi.sendMessage (only the control)", calls.length === 1, `got ${calls.length}`);
ok("surfaced count reflects only the control", res.surfaced === 1, `got ${res.surfaced}`);

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
