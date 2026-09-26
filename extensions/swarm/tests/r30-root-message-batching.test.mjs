/**
 * extensions/swarm/tests/r30-root-message-batching.test.mjs
 *
 * R30: Root Inbound Message Coalescing & Batch Surfacing (R10-1 boundary assertion)
 *
 * Problem: When multiple messages accumulate in the root mailbox (e.g. workers reporting
 * progress/status/acks), `pumpRootMailbox` currently calls `pi.sendMessage` N times:
 * 1 with triggerTurn: true, and N-1 with deliverAs: "followUp".
 * Pi runtime converts each followUp into a sequential, separate LLM turn, burning
 * context window (e.g. 467k tokens in pane %141) and forcing root into sequential 1-by-1
 * acknowledgements ("Đã nhận...").
 *
 * Fix requirement:
 * - When N pending messages exist (N > 1), `pumpRootMailbox` MUST coalesce them into
 *   a SINGLE composite message and call `pi.sendMessage` EXACTLY ONCE at the L2 boundary.
 * - All N message IDs must be marked as surfaced in `consumerReceipts` / `delivered`.
 * - The composite content must format all N messages with clear sender demarcations.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { pumpRootMailbox } = await import(join(here, "..", "src/reconcile.ts"));
const { paths, withLock, readState, writeState } = await import(join(here, "..", "src/state.ts"));
const { ensureRoot, heartbeatRootLeader } = await import(join(here, "..", "src/identity.ts"));
const { deliverMessageLocked } = await import(join(here, "..", "src/mailbox.ts"));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
	if (cond) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.log(`  FAIL ${name}${detail ? " " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`);
	}
}

let scenarioIdx = 0;
function freshScratch() {
	scenarioIdx++;
	return mkdtempSync(join(tmpdir(), `swarm-r30-batch-s${scenarioIdx}-${process.pid}-${Date.now()}`));
}

function makePiMockWithCounters() {
	const sendMessages = [];
	const pi = {
		sendMessage: (msg, opts) => {
			sendMessages.push({ msg, opts, atMs: Date.now() });
			return undefined;
		},
		registerTool: () => {},
		registerCommand: () => {},
		on: () => {},
	};
	return { pi, sendMessages };
}

async function seedMultiWorkerMessages({ scratch, workerCount = 3 }) {
	const p = paths(scratch);
	mkdirSync(p.root, { recursive: true });
	mkdirSync(p.traces, { recursive: true });
	mkdirSync(p.mailboxes, { recursive: true });
	mkdirSync(p.tasksDir, { recursive: true });

	const { pi } = makePiMockWithCounters();

	await withLock(p, async () => {
		const st = await readState(p, scratch);
		ensureRoot(st, scratch, p);
		heartbeatRootLeader(st, Date.now(), process.pid, "test_r30_seed");

		for (let i = 1; i <= workerCount; i++) {
			const workerId = `worker-${i}`;
			st.agents[workerId] = {
				id: workerId,
				name: workerId,
				cwd: scratch,
				role: "worker",
				status: "running",
				tmuxTarget: `session:${i}.0`,
				heartbeatAt: new Date().toISOString(),
				createdAt: new Date().toISOString(),
			};

			process.env.PI_SWARM_AGENT_ID = workerId;
			process.env.PI_SWARM_IS_ROOT = "";
			await deliverMessageLocked(pi, scratch, p, st, {
				to: "root",
				body: `Status update from worker ${i}: completed step ${i}. No further action.`,
				subject: `Update from ${workerId}`,
				requiresAck: true,
			});
		}
		await writeState(p, st);
	});
	process.env.PI_SWARM_AGENT_ID = "root";
	process.env.PI_SWARM_IS_ROOT = "1";
}

console.log("=== R30: Root Inbound Message Coalescing & Batch Surfacing ===");

// --- Scenario 1: Multiple pending messages delivered in ONE pi.sendMessage call ---
console.log("\n[R30-S1] 3 pending worker messages -> exactly 1 pi.sendMessage call (L2 boundary assertion)");
{
	const scratch = freshScratch();
	const p = paths(scratch);
	await seedMultiWorkerMessages({ scratch, workerCount: 3 });

	const { pi, sendMessages } = makePiMockWithCounters();
	const ctx = {
		cwd: scratch,
		mode: "tui",
		isIdle: () => true,
		hasUI: false,
		ui: { setStatus: () => {} },
		model: { id: "gpt-6-luna", provider: "openai" },
	};

	const result = await pumpRootMailbox(pi, ctx, p, "agent_settled");

	// Boundary check: In current codebase without batching, sendMessages.length === 3.
	// With batching, sendMessages.length MUST be 1.
	ok("R30-S1 sendMessages.length === 1 (batched into single turn trigger)", sendMessages.length === 1, `got ${sendMessages.length}`);
	ok("R30-S1 result.delivered === 3 (all 3 messages delivered)", result.delivered === 3, `got ${result.delivered}`);

	if (sendMessages.length > 0) {
		const deliveredMsg = sendMessages[0].msg;
		ok("R30-S1 customType is swarm-batch-message", deliveredMsg.customType === "swarm-batch-message", deliveredMsg.customType);
		ok("R30-S1 contains content from worker-1", deliveredMsg.content.includes("worker-1"));
		ok("R30-S1 contains content from worker-2", deliveredMsg.content.includes("worker-2"));
		ok("R30-S1 contains content from worker-3", deliveredMsg.content.includes("worker-3"));
		ok("R30-S1 options triggerTurn is true", sendMessages[0].opts?.triggerTurn === true);
	}

	// Verify durable consumerReceipts for ALL 3 messages
	const stAfter = await readState(p, scratch);
	const receipts = stAfter.consumerReceipts?.root?.entries || {};
	const receiptIds = Object.keys(receipts);
	ok("R30-S1 consumerReceipts contains all 3 messages", receiptIds.length === 3, `got ${receiptIds.length}`);
}

// --- Scenario 2: Single pending message -> uses standard format (non-regression) ---
console.log("\n[R30-S2] 1 pending message -> uses standard format and exactly 1 pi.sendMessage");
{
	const scratch = freshScratch();
	const p = paths(scratch);
	await seedMultiWorkerMessages({ scratch, workerCount: 1 });

	const { pi, sendMessages } = makePiMockWithCounters();
	const ctx = {
		cwd: scratch,
		mode: "tui",
		isIdle: () => true,
		hasUI: false,
		ui: { setStatus: () => {} },
		model: { id: "gpt-6-luna", provider: "openai" },
	};

	const result = await pumpRootMailbox(pi, ctx, p, "agent_settled");
	ok("R30-S2 sendMessages.length === 1", sendMessages.length === 1, `got ${sendMessages.length}`);
	ok("R30-S2 result.delivered === 1", result.delivered === 1, `got ${result.delivered}`);
	if (sendMessages.length > 0) {
		const deliveredMsg = sendMessages[0].msg;
		ok("R30-S2 customType is swarm-message for single message", deliveredMsg.customType === "swarm-message", deliveredMsg.customType);
	}
}

// --- Scenario 3: Replay guard on batched messages (no duplicate sendMessage on next tick) ---
console.log("\n[R30-S3] Replay guard: next pump tick does not re-send batched messages");
{
	const scratch = freshScratch();
	const p = paths(scratch);
	await seedMultiWorkerMessages({ scratch, workerCount: 3 });

	const { pi, sendMessages } = makePiMockWithCounters();
	const ctx = {
		cwd: scratch,
		mode: "tui",
		isIdle: () => true,
		hasUI: false,
		ui: { setStatus: () => {} },
		model: { id: "gpt-6-luna", provider: "openai" },
	};

	// First tick
	await pumpRootMailbox(pi, ctx, p, "agent_settled");
	const countAfterTick1 = sendMessages.length;

	// Second tick
	const result2 = await pumpRootMailbox(pi, ctx, p, "agent_settled");
	const countAfterTick2 = sendMessages.length;

	ok(
		"R30-S3 tick 2 does not add new sendMessages",
		countAfterTick2 === countAfterTick1,
		`tick1: ${countAfterTick1}, tick2: ${countAfterTick2}`,
	);
	ok("R30-S3 tick 2 delivered === 0", result2.delivered === 0, `got ${result2.delivered}`);
}

console.log(`\nResults: ${pass} passed, ${fail} failed.`);
if (fail > 0) {
	process.exit(1);
}
