// Regression: spawn/restart kickoff must surface pending (unacked, non-dead-letter) mailbox
// messages to the agent — closes the "restart-mailbox gap" seen in the wild (approval injected
// while pane was down; respawned agent idled waiting for a verdict it already had).
// Run: node extensions/swarm/mailbox-kickoff.test.mjs
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Direct-load the source module (mirrors other tests' import strategy via index exports if present).
const src = readFileSync(new URL("./src/agents.ts", import.meta.url), "utf8");
if (!src.includes("mailboxKickoffPrompt")) {
	console.error("FAIL: mailboxKickoffPrompt not found in src/agents.ts");
	process.exit(1);
}

// Minimal stand-in: extract the exported function body semantics by importing the real module.
// index.ts re-exports only some symbols; import the module directly with its own dependency graph.
const mod = await import("./src/agents.ts");
const mailboxKickoffPrompt = mod.mailboxKickoffPrompt;
if (typeof mailboxKickoffPrompt !== "function") {
	console.error("FAIL: mailboxKickoffPrompt is not exported");
	process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "swarm-kickoff-"));
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error("  FAIL:", name); } };
try {
	const p = { root: tmp, mailboxes: join(tmp, "mailboxes") };
	const st = (msgs) => ({ messages: msgs });

	// 1. Pending unacked message -> prompt mentions it + the tool to call.
	const withPending = st({ "m1": { id: "m1", to: "w", from: "reviewer", status: "failed", requiresAck: true } });
	let out = await mailboxKickoffPrompt(p, withPending, "w");
	ok("pending message produces prompt", out.includes("PI-SWARM MAILBOX PENDING"));
	ok("prompt tells agent to check mailbox", out.includes("swarm_check_mailbox"));
	ok("prompt lists the message id", out.includes("m1"));

	// 2. All acked -> no prompt.
	const acked = st({ "m1": { id: "m1", to: "w", from: "reviewer", status: "acked", requiresAck: true, ackedAt: "x" } });
	out = await mailboxKickoffPrompt(p, acked, "w");
	ok("acked messages produce no prompt", out === "");

	// 3. Dead-lettered / superseded ignored.
	const dead = st({ "m1": { id: "m1", to: "w", from: "r", status: "dead_letter", requiresAck: true } });
	out = await mailboxKickoffPrompt(p, dead, "w");
	ok("dead-letter ignored", out === "");
	const sup = st({ "m1": { id: "m1", to: "w", from: "r", status: "injected", requiresAck: true, superseded: { at: "x" } } });
	out = await mailboxKickoffPrompt(p, sup, "w");
	ok("superseded ignored", out === "");

	// 4. Messages for other agents ignored.
	const other = st({ "m1": { id: "m1", to: "someone-else", from: "r", status: "failed", requiresAck: true } });
	out = await mailboxKickoffPrompt(p, other, "w");
	ok("other-recipient messages ignored", out === "");

	// 5. Null-safety: empty state.
	out = await mailboxKickoffPrompt(p, {} , "w");
	ok("empty state safe", out === "");
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
