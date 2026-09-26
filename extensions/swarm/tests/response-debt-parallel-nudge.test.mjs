#!/usr/bin/env node
/**
 * H1 — response-debt lifecycle (followup-h1-response-debt-lifecycle-20260926).
 *
 * RED reproducer for three defects observed live (planner-uat 4x, implementer-uat 3x):
 *   D1: a nudge minted with requiresResponse:true creates a PARALLEL response-debt record;
 *       a correct reply to the ORIGINAL assignment verifies only the assignment record, so
 *       the nudge record stays open -> reconcile re-flags response_missing -> duplicate
 *       reminder loop until TTL.
 *   D2: artifact-progress nudge fires on raw file mtime with no attempt-window causality —
 *       a stale pre-assignment mtime re-arms a nudge for already-closed work.
 *   D3: under gate=0 (PI_SWARM_MINIMAL_PROTOCOL=0) the reply auto-verify path never runs,
 *       so debt lingers even after a correct reply.
 *
 * Engine-harness lane per plan §1 (streaming mock-llm fixture
 * response-debt-parallel-nudge.jsonl ships for the interactive UAT lane; this harness
 * drives the real deliverMessageLocked / evaluateArtifactProgressNudgeLocked /
 * reconcile path deterministically, which is where the debt records live).
 *
 * Run (RED, pre-fix):
 *   PI_SWARM_AGENT_ID=root PI_SWARM_IS_ROOT=1 node extensions/swarm/tests/response-debt-parallel-nudge.test.mjs
 * UAT_OUT_DIR separation: all state goes under a mkdtemp scratch dir, never the repo.
 */
import { mkdtemp, mkdir, writeFile, utimes, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), `swarm-h1-response-debt-${process.pid}-${Date.now()}`));
await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
await writeFile(join(scratch, ".pi/settings.json"), JSON.stringify({ swarm: { defaultModel: "glm-4.7", defaultProvider: "ccs" } }));
process.chdir(scratch);

const ORIG_AGENT_ID = process.env.PI_SWARM_AGENT_ID;
const ORIG_IS_ROOT = process.env.PI_SWARM_IS_ROOT;
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
process.on("exit", () => {
	if (ORIG_AGENT_ID === undefined) delete process.env.PI_SWARM_AGENT_ID;
	else process.env.PI_SWARM_AGENT_ID = ORIG_AGENT_ID;
	if (ORIG_IS_ROOT === undefined) delete process.env.PI_SWARM_IS_ROOT;
	else process.env.PI_SWARM_IS_ROOT = ORIG_IS_ROOT;
});

process.env.PI_SWARM_ARTIFACT_PROGRESS_GRACE_MS ||= "1000";
process.env.PI_SWARM_ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS ||= "1000";
process.env.PI_SWARM_TASK_STALL_NUDGE_IDLE_INTERVAL_MS ||= "1000";
const { paths, readState, writeState, withLock, ensureDirs } = await import(join(here, "..", "src", "state.ts"));
const { deliverMessageLocked, responseMissingRecords } = await import(join(here, "..", "src", "mailbox.ts"));
const { evaluateArtifactProgressNudgeLocked } = await import(join(here, "..", "src", "nudges", "artifact-progress.ts"));
const { reconcile } = await import(join(here, "..", "src", "reconcile-core.ts"));
const { ensureRoot } = await import(join(here, "..", "src", "identity.ts"));
const { streamMockLLM, resetMockLLMCursor } = await import(join(here, "..", "..", "mock-llm", "src", "stream.ts"));

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL:", name, info ?? "");
	}
};

const pi = {
	registerTool: () => {},
	registerCommand: () => {},
	on: () => {},
	setModel: async () => true,
	sendMessage: () => {},
	exec: async (cmd, args) => {
		if (cmd === "tmux" && args?.[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	},
};

const p = paths(scratch);
await ensureDirs(p);
const now = () => new Date().toISOString();

function baseAgent(id) {
	const ts = now();
	return {
		id,
		role: id === "root" ? "root" : "worker",
		roleKind: id === "root" ? "root" : "worker",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 9,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxSession: "test",
		tmuxWindow: id,
		tmuxTarget: `test:${id}.0`,
		model: "glm-4.7",
		provider: "ccs",
		cwd: scratch,
		mailbox: `.pi/swarm/mailboxes/${id}.jsonl`,
		createdAt: ts,
		updatedAt: ts,
	};
}

const st = await withLock(p, async () => {
	const s = await readState(p, scratch);
	ensureRoot(s, scratch, p);
	s.agents["worker-x"] = baseAgent("worker-x");
	await writeState(p, s);
	return s;
});

// =====================================================================
// Scenario D1: nudge mints parallel debt; correct reply to the assignment
// leaves the nudge record open -> duplicate reminder loop.
// =====================================================================
console.log("\n--- D1: nudge parallel debt survives a correct reply to the assignment ---");
{
	const assignId = "msg-assign-d1";
	const nudgeId = "msg-nudge-d1";
	const convo = "task:h1-task:implement";
	const ts = now();

	// Seed: assignment record (open debt) + a nudge record minted by the engine with
	// requiresResponse:true (exactly what artifact-progress.ts:191 produces today).
	await withLock(p, async () => {
		const s = await readState(p, scratch);
		s.messages[assignId] = {
			id: assignId,
			from: "root",
			to: "worker-x",
			status: "injected",
			createdAt: ts,
			updatedAt: ts,
			injectedAt: ts,
			attempts: 1,
			requiresAck: true,
			requiresResponse: true,
			conversationId: convo,
			subject: "Task h1-task / node implement assigned",
			response: { status: "missing", missingAt: ts },
		};
		s.messages[nudgeId] = {
			id: nudgeId,
			from: "root",
			to: "worker-x",
			status: "injected",
			createdAt: ts,
			updatedAt: ts,
			injectedAt: ts,
			attempts: 1,
			requiresAck: true,
			requiresResponse: true, // <- the defect: nudge mints parallel debt
			conversationId: convo,
			replyTo: assignId,
			subject: "ARTIFACT-PROGRESS: close h1-task:implement now",
			response: { status: "missing", missingAt: ts },
		};
		s.delivered["worker-x"] = [assignId, nudgeId];
		await writeState(p, s);
	});

	// Reconcile flags BOTH records as response_missing (the loop fuel).
	await reconcile(pi, scratch, p, {});
	let afterReconcile = await readState(p, scratch);
	const missingAfterReconcile = responseMissingRecords(afterReconcile, "worker-x").map((m) => m.id);
	ok(
		"pre-fix: reconcile flags the nudge record response_missing (parallel debt minted)",
		missingAfterReconcile.includes(nudgeId),
		JSON.stringify(missingAfterReconcile),
	);

	// Replay the worker's real mock-LLM turn, then deliver its scripted toolcall through the
	// production message engine. The fixture supplies replyTo/conversationId; this is the
	// end-to-end agent-side interaction whose accepted reply must clear parallel debt.
	const fixtureModelId = "response-debt-parallel-nudge";
	resetMockLLMCursor(fixtureModelId);
	const fixtureStream = streamMockLLM(
		{ id: fixtureModelId, provider: "mock-llm", api: "mock-llm-stream" },
		{
			systemPrompt: "H1 response-debt UAT worker",
			messages: [{ role: "user", content: "Reply to the original assignment." }],
			tools: [{ name: "swarm_send_message", description: "send a response", parameters: { type: "object", properties: {} } }],
		},
	);
	const fixtureEvents = [];
	for await (const event of fixtureStream) fixtureEvents.push(event);
	const fixtureResult = await fixtureStream.result();
	const replyCalls = fixtureEvents.filter((event) => event.type === "toolcall_end" && event.toolCall);
	ok("mock-LLM fixture emits one original-assignment reply", fixtureResult.stopReason === "toolUse" && replyCalls.length === 1);
	const replyParams = replyCalls[0]?.toolCall?.arguments;
	ok(
		"fixture reply targets the assignment and matching task context",
		replyParams?.replyTo === assignId && replyParams?.conversationId === convo,
		JSON.stringify(replyParams),
	);

	// Identity switch: deliverMessageLocked stamps `from` via currentAgentId() at call time.
	const replyEnv = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = "worker-x";
	try {
		await withLock(p, async () => {
			const s = await readState(p, scratch);
			await deliverMessageLocked(pi, scratch, p, s, replyParams);
			await writeState(p, s);
		});
	} finally {
		process.env.PI_SWARM_AGENT_ID = replyEnv;
	}

	afterReconcile = await readState(p, scratch);
	ok(
		"assignment record verified after correct reply",
		afterReconcile.messages[assignId]?.response?.status === "verified",
		afterReconcile.messages[assignId]?.response?.status,
	);

	// RED assertion: the nudge's PARALLEL record should have settled too. Pre-fix it stays open.
	const nudgeStillOpen =
		afterReconcile.messages[nudgeId]?.requiresResponse === true &&
		afterReconcile.messages[nudgeId]?.response?.status !== "verified" &&
		afterReconcile.messages[nudgeId]?.response?.status !== "waived";
	console.log(`  (red probe) nudge record open after correct reply: ${nudgeStillOpen}`);
	ok("POST-FIX: nudge parallel debt settled by the assignment reply (single debt per assignment)", !nudgeStillOpen);

	// The loop itself: reconcile must NOT re-flag response_missing on the nudge after the reply.
	await reconcile(pi, scratch, p, {});
	const s2 = await readState(p, scratch);
	const reFlagged = responseMissingRecords(s2, "worker-x").map((m) => m.id);
	ok(
		"POST-FIX: no duplicate reminder loop — no response_missing records remain for the worker",
		reFlagged.length === 0,
		JSON.stringify(reFlagged),
	);
}

// =====================================================================
// Scenario D2: stale pre-assignment mtime must not (re)arm a nudge.
// =====================================================================
console.log("\n--- D2: artifact-progress ignores stale pre-assignment mtimes ---");
{
	const taskId = "h1-stale";
	const tp = join(p.tasksDir, taskId);
	await mkdir(join(tp, "artifacts"), { recursive: true });
	// Time relationships that expose D2: baseline (lastProgressAt) is OLDER than the artifact
	// mtime, but the mtime PREdates the current attempt's assignedAt (rework re-assigned the
	// node 30 min ago; the file was last touched 1 h ago by the superseded attempt).
	// Pre-fix: baseline-only comparison sees "new progress" and re-arms the nudge (RED).
	const nowMs = Date.now();
	const twoHoursAgo = new Date(nowMs - 2 * 60 * 60 * 1000);
	const oneHourAgo = new Date(nowMs - 1 * 60 * 60 * 1000);
	const thirtyMinAgo = new Date(nowMs - 30 * 60 * 1000);
	const artifact = join(scratch, "src-d2.txt");
	await writeFile(artifact, "stale work product\n");
	await utimes(artifact, oneHourAgo, oneHourAgo);

	const assignedAt = thirtyMinAgo.toISOString();
	await writeFile(
		join(tp, "task.json"),
		JSON.stringify({
			version: 1,
			taskId,
			title: "stale-mtime probe",
			status: "in_progress",
			owner: "root",
			allowedFiles: ["src-d2.txt"],
			nodes: {
				implement: {
					status: "in_progress",
					role: "implementer",
					assignee: "worker-x",
					dependsOn: [],
					messageIds: [],
					assignmentMessageId: "msg-assign-d2",
					attempts: 2,
					activeAttemptId: "attempt-d2",
					attemptHistory: [
						{
							attemptId: "attempt-d1",
							attemptNumber: 1,
							assignmentMessageId: "msg-assign-d2-old",
							assignee: "worker-x",
							assignedAt: twoHoursAgo.toISOString(),
							status: "superseded",
						},
						{
							attemptId: "attempt-d2",
							attemptNumber: 2,
							assignmentMessageId: "msg-assign-d2",
							assignee: "worker-x",
							assignedAt,
							status: "active",
						},
					],
					lastProgressAt: twoHoursAgo.toISOString(), // progress predates the rework attempt
				},
			},
			edges: [],
			handoffs: [],
			gates: {},
			editLocks: {},
		}),
	);

	await withLock(p, async () => {
		const s = await readState(p, scratch);
		await evaluateArtifactProgressNudgeLocked(pi, scratch, p, s, Date.now());
		await writeState(p, s);
	});

	const task = JSON.parse(await readFile(join(tp, "task.json"), "utf8"));
	const nudged = task.nodes.implement.artifactProgressNudgeCount ?? 0;
	console.log(`  (red probe) nudged on stale mtime: ${nudged}`);
	ok("POST-FIX: stale pre-assignment mtime does NOT fire an artifact-progress nudge", nudged === 0, `count=${nudged}`);

	// Control: a FRESH mtime (inside the attempt window) must still fire.
	await utimes(artifact, new Date(), new Date());
	await withLock(p, async () => {
		const s = await readState(p, scratch);
		await evaluateArtifactProgressNudgeLocked(pi, scratch, p, s, Date.now());
		await writeState(p, s);
	});
	const task2 = JSON.parse(await readFile(join(tp, "task.json"), "utf8"));
	const nudged2 = task2.nodes.implement.artifactProgressNudgeCount ?? 0;
	ok("control: fresh in-window mtime still fires the nudge", nudged2 >= 1, `count=${nudged2}`);
}

// =====================================================================
// Scenario D3: gate=0 — note only. PI_SWARM_MINIMAL_PROTOCOL is read at module load
// and this process is gate=1; the gate=0 settle rule is asserted in
// tests/response-debt-gate0-settle.test.mjs (subprocess, PI_SWARM_MINIMAL_PROTOCOL=0),
// mirroring the split used by minimal-protocol-authoritative/shadow.
// =====================================================================
console.log("\n--- D3: covered by tests/response-debt-gate0-settle.test.mjs (gate split) ---");
ok("gate=0 settle lane lives in response-debt-gate0-settle.test.mjs", true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log("RED confirmed — the defect reproduces deterministically.");
} else {
	console.log("GREEN.");
}
await rm(scratch, { recursive: true, force: true }).catch(() => {});
process.exit(fail > 0 ? 1 : 0);
