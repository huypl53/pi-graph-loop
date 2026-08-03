// End-to-end validation that the swarm fix stops the "ack then re-deliver" loop, while preserving
// retry for genuine (never-acknowledged) delivery failures.
//
// It loads the REAL extension (extensions/swarm/index.ts, with the fix) through a minimal mock pi,
// seeds an isolated scratch swarm-state with two messages addressed to a "running" agent whose tmux
// pane reports alive, then invokes the REAL swarm_reconcile tool and asserts:
//   - the acked-failed message produces NO re-injection (no would_retry/pending/retried) and is left
//     untouched (status "failed", attempts unchanged)  -> loop fixed
//   - the queued (never-delivered) message IS still retried by reconcile            -> retry preserved
//
// Run: node extensions/swarm/reconcile-loop.validate.mjs
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import("./index.ts");
const factory = mod.default;

// --- minimal mock pi: capture registered tools, answer tmux probes as alive ---
const tools = {};
const pi = {
	registerTool: (def) => { tools[def.name] = def; },
	registerCommand: () => {},
	on: () => {},
	exec: async (cmd, args) => {
		// isTmuxRunning -> tmux display-message -p -t <target> "#{pane_id}"
		if (cmd === "tmux" && args[0] === "display-message") return { code: 0, stdout: "%99999\n", stderr: "" };
		// capture-pane / send-keys / has-session -> succeed quietly so deliver() returns delivered
		return { code: 0, stdout: "", stderr: "" };
	},
};
factory(pi);
const reconcileTool = tools["swarm_reconcile"];
if (!reconcileTool) { console.error("swarm_reconcile tool not registered"); process.exit(2); }

// --- scratch project + seeded state (under OS tmp so the repo is never polluted) ---
const scratch = join(tmpdir(), `swarm-ackfix-validate-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi", "swarm", "traces", "tmux"), { recursive: true });
mkdirSync(join(scratch, ".pi", "swarm", "mailboxes"), { recursive: true });

const now = new Date().toISOString();
const baseAgent = {
	id: "worker-a", role: "scratch worker", roleKind: "worker", status: "running",
	capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1,
	runtimeStatus: "idle", health: "healthy",
	tmuxSession: "scratch", tmuxWindow: "worker-a", tmuxTarget: "scratch:0.1",
	model: "glm-5.1", provider: "zai-coding-cn", cwd: scratch,
	createdAt: now, updatedAt: now,
};
const state = {
	version: 1, swarmId: "swarm-scratch", cwd: scratch, tmuxSession: "scratch",
	agents: { "worker-a": baseAgent },
	delivered: {},
	messages: {
		"msg-acked-failed": {
			id: "msg-acked-failed", swarmId: "swarm-scratch", from: "orchestrator", to: "worker-a",
			createdAt: now, status: "failed", attempts: 1, requiresAck: true, requiresResponse: false,
			response: { status: "not_required" },
			lastAck: { by: "worker-a", status: "failed", note: "could not complete", at: now },
			lastError: "worker reported failure", updatedAt: now,
		},
		"msg-queued": {
			id: "msg-queued", swarmId: "swarm-scratch", from: "orchestrator", to: "worker-a",
			createdAt: now, status: "queued", queuedAt: now, attempts: 0, requiresAck: true, requiresResponse: false,
			response: { status: "not_required" }, updatedAt: now,
		},
	},
	createdAt: now, updatedAt: now,
};
writeFileSync(join(scratch, ".pi", "swarm", "swarm-state.json"), JSON.stringify(state, null, 2) + "\n");

// seed the recipient mailbox JSONL (reconcile re-injection reads the mailbox to find the message)
const mailMsg = (over) => JSON.stringify(Object.assign({
	id: "", swarmId: "swarm-scratch", from: "orchestrator", to: "worker-a",
	type: "swarm.message", schemaVersion: 1, createdAt: now, priority: "normal",
	requiresAck: true, requiresResponse: false, headers: {}, body: "scratch body",
}, over));
writeFileSync(
	join(scratch, ".pi", "swarm", "mailboxes", "worker-a.jsonl"),
	mailMsg({ id: "msg-acked-failed" }) + "\n" + mailMsg({ id: "msg-queued" }) + "\n",
);

const ctx = { cwd: scratch };
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.error("  FAIL:", name); } };

// --- 1) DRY RUN: preview actions ---
const dry = await reconcileTool.execute("c1", { dryRun: true }, undefined, () => {}, ctx);
const dryText = dry.content[0].text;
const dryActions = (dry.details && dry.details.actions) || [];
const dryIds = dryActions.map((a) => a.messageId);
const dryHasAckedFailed = dryIds.includes("msg-acked-failed");
const dryQueuedAction = dryActions.find((a) => a.messageId === "msg-queued");
ok("DRY: acked-failed message produces NO reconcile action (no loop)", dryHasAckedFailed === false);
ok("DRY: queued (never-delivered) message is still surfaced for retry",
	Boolean(dryQueuedAction) && /would_retry|retried|pending/.test(dryQueuedAction.action));

// --- 2) APPLIED (non-dry-run): state must reflect fix ---
const applied = await reconcileTool.execute("c2", { dryRun: false }, undefined, () => {}, ctx);
const appliedText = applied.content[0].text;
const after = JSON.parse(readFileSync(join(scratch, ".pi", "swarm", "swarm-state.json"), "utf8"));
const af = after.messages["msg-acked-failed"];
const q = after.messages["msg-queued"];
ok("APPLIED: acked-failed untouched (still status 'failed', attempts unchanged, NOT re-injected)",
	af.status === "failed" && af.attempts === 1 && af.injectedAt === undefined);
ok("APPLIED: queued message was re-injected (status -> injected, attempts bumped)",
	q.status === "injected" && q.attempts === 1);

const appliedHasAckedFailed = /msg-acked-failed/.test(appliedText);
ok("APPLIED: no action emitted for acked-failed message", appliedHasAckedFailed === false);

console.log("\n--- dryRun reconcile actions ---");
console.log(JSON.stringify(dryActions, null, 2));
console.log("\n--- dryRun reconcile output ---");
console.log(dryText);
console.log("\n--- applied reconcile output ---");
console.log(appliedText);
console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);

// keep scratch dir for inspection; do not auto-clean so the user can review
console.log(`\nscratch state: ${join(scratch, ".pi", "swarm", "swarm-state.json")}`);
process.exit(fail === 0 ? 0 : 1);
