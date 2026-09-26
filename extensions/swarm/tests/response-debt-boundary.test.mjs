#!/usr/bin/env node
/**
 * H1 — R10-1 boundary counter (followup-h1-response-debt-lifecycle-20260926).
 *
 * Counts mutations at the REAL message-record state boundary — `upsertMessageRecord(...)`
 * calls plus direct `st.messages[id]` / `st.messages[id].response` assignments inside
 * `deliverMessageLocked` — via a state-stub harness. No helper-level stubs: the boundary
 * is the actual record-write surface the engine uses (per docs/swarm/pi-runtime-contract.md §10).
 *
 * Asserts:
 *   - one verified reply settles exactly N context-parallel records with exactly N
 *     record-response writes (no more) — the sweep is precise, not a shotgun;
 *   - post-fix nudges mint ZERO new response debt (requiresResponse:false => no debt record
 *     writes attributable to response tracking on the nudge path).
 *
 * Run: PI_SWARM_AGENT_ID=root PI_SWARM_IS_ROOT=1 node extensions/swarm/tests/response-debt-boundary.test.mjs
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), `swarm-h1-boundary-${process.pid}-${Date.now()}`));
await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
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

const { paths, readState, writeState, withLock, ensureDirs } = await import(join(here, "..", "src", "state.ts"));
const { deliverMessageLocked } = await import(join(here, "..", "src", "mailbox.ts"));
const { evaluateArtifactProgressNudgeLocked } = await import(join(here, "..", "src", "nudges", "artifact-progress.ts"));
const { ensureRoot } = await import(join(here, "..", "src", "identity.ts"));

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
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
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
		model: "m",
		provider: "p",
		cwd: scratch,
		mailbox: `.pi/swarm/mailboxes/${id}.jsonl`,
		createdAt: ts,
		updatedAt: ts,
	};
}

// Wrap the REAL boundary: count st.messages record mutations (property writes on records +
// new record inserts) inside deliverMessageLocked by instrumenting a Proxy around st.messages.
// This stubs STATE, not helpers — deliverMessageLocked and its helpers run unmodified.
async function instrumentedDelivery(params, countRef) {
	return withLock(p, async () => {
		const s = await readState(p, scratch);
		const inner = s.messages;
		s.messages = new Proxy(inner, {
			set(target, prop, value) {
				if (typeof prop === "string" && value && typeof value === "object" && "id" in value) countRef.inserts++;
				target[prop] = value;
				return true;
			},
			get(target, prop) {
				const v = target[prop];
				if (typeof prop === "string" && v && typeof v === "object") {
					return new Proxy(v, {
						set(t2, prop2, val2) {
							if (prop2 === "response" || prop2 === "updatedAt" || prop2 === "status") countRef.mutations++;
							t2[prop2] = val2;
							return true;
						},
					});
				}
				return v;
			},
		});
		const r = await deliverMessageLocked(pi, scratch, p, s, params);
		s.messages = inner;
		await writeState(p, s);
		return r;
	});
}

await withLock(p, async () => {
	const s = await readState(p, scratch);
	ensureRoot(s, scratch, p);
	s.agents["worker-b"] = baseAgent("worker-b");
	await writeState(p, s);
});

// ===== Boundary 1: one reply, N parallel records => exactly N record mutations (+ reply-record insert) =====
console.log("\n--- R10-1: reply settles exactly N parallel records with N record writes ---");
{
	const convo = "task:h1-b:implement";
	const ts = now();
	await withLock(p, async () => {
		const s = await readState(p, scratch);
		for (const [id, extra] of [
			["msg-assign-b", {}],
			["msg-nudge-b1", { replyTo: "msg-assign-b" }],
			["msg-nudge-b2", { replyTo: "msg-assign-b" }],
			["msg-nudge-b3", { replyTo: "msg-assign-b" }],
		]) {
			s.messages[id] = {
				id,
				from: "root",
				to: "worker-b",
				status: "injected",
				createdAt: ts,
				updatedAt: ts,
				injectedAt: ts,
				attempts: 1,
				requiresAck: true,
				requiresResponse: true,
				conversationId: convo,
				response: { status: "missing", missingAt: ts },
				...extra,
			};
		}
		s.delivered["worker-b"] = ["msg-assign-b", "msg-nudge-b1", "msg-nudge-b2", "msg-nudge-b3"];
		await writeState(p, s);
	});

	const countRef = { inserts: 0, mutations: 0 };
	const replyEnv = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = "worker-b";
	try {
		await instrumentedDelivery(
			{ to: "root", body: "Result.", replyTo: "msg-assign-b", conversationId: convo, requiresAck: false },
			countRef,
		);
	} finally {
		process.env.PI_SWARM_AGENT_ID = replyEnv;
	}

	const s = await readState(p, scratch);
	const settled = ["msg-assign-b", "msg-nudge-b1", "msg-nudge-b2", "msg-nudge-b3"].filter(
		(id) => s.messages[id]?.response?.status === "verified",
	);
	ok("all 4 context-parallel records settled by the single reply", settled.length === 4, JSON.stringify(settled));
	// Boundary exactness: deliverMessageLocked legitimately touches the reply record itself
	// (upsertMessageRecord at the queued/injected transition, 2 records counted by the proxy
	// via insert + delivery-status patch) + settles 4 records (each settle writes response +
	// updatedAt = 2 proxy-visible writes per record). Precise expectation at this boundary:
	// 8 settle-shaped writes = 4 records x (response, updatedAt); nothing more.
	ok(
		"R10-1: exactly 8 record-state writes = 4 settled records x (response, updatedAt) — no shotgun",
		countRef.mutations === 8,
		`mutations=${countRef.mutations}`,
	);
	ok(
		"R10-1: exactly 2 new record inserts (reply enqueue + its injected-state upsert — the only new records)",
		countRef.inserts === 2,
		`inserts=${countRef.inserts}`,
	);
}

// ===== Boundary 2: post-fix nudge mints ZERO response-debt records =====
console.log("\n--- R10-1: artifact-progress nudge mints zero debt records ---");
{
	process.env.PI_SWARM_ARTIFACT_PROGRESS_GRACE_MS ||= "1000";
	process.env.PI_SWARM_ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS ||= "1000";
	const taskId = "h1-b-nudge";
	const tp = join(p.tasksDir, taskId);
	await mkdir(tp, { recursive: true });
	const artifact = join(scratch, "src-b.txt");
	await writeFile(artifact, "fresh work\n");
	const assignedAt = new Date(Date.now() - 60_000).toISOString();
	await utimesFix(artifact);
	async function utimesFix(f) {
		const { utimes } = await import("node:fs/promises");
		await utimes(f, new Date(), new Date());
	}
	await writeFile(
		join(tp, "task.json"),
		JSON.stringify({
			version: 1,
			taskId,
			title: "boundary nudge probe",
			status: "in_progress",
			owner: "root",
			allowedFiles: ["src-b.txt"],
			nodes: {
				implement: {
					status: "in_progress",
					role: "implementer",
					assignee: "worker-b",
					dependsOn: [],
					messageIds: [],
					assignmentMessageId: "msg-assign-b",
					attempts: 1,
					activeAttemptId: "attempt-b",
					attemptHistory: [
						{
							attemptId: "attempt-b",
							attemptNumber: 1,
							assignmentMessageId: "msg-assign-b",
							assignee: "worker-b",
							assignedAt,
							status: "active",
						},
					],
					lastProgressAt: new Date(Date.now() - 5 * 60_000).toISOString(),
				},
			},
			edges: [],
			handoffs: [],
			gates: {},
			editLocks: {},
		}),
	);

	const before = await readState(p, scratch);
	const debtBefore = Object.values(before.messages).filter((m) => m.requiresResponse).length;

	await withLock(p, async () => {
		const s = await readState(p, scratch);
		await evaluateArtifactProgressNudgeLocked(pi, scratch, p, s, Date.now());
		await writeState(p, s);
	});

	const after = await readState(p, scratch);
	const debtRecords = Object.values(after.messages).filter((m) => m.requiresResponse);
	const newDebt = debtRecords.filter((m) => !before.messages[m.id]);
	const nudgeRecords = Object.values(after.messages).filter((m) => m.idempotencyKey?.startsWith("r20:nudge:"));
	ok("nudge message was minted", nudgeRecords.length >= 1, `count=${nudgeRecords.length}`);
	ok(
		"R10-1: nudge minted ZERO new response-debt records (requiresResponse:false at the boundary)",
		newDebt.length === 0,
		`newDebt=${JSON.stringify(newDebt.map((m) => m.id))}`,
	);
	ok(
		"no change in total requiresResponse record count after the nudge",
		debtRecords.length === debtBefore,
		`${debtBefore} -> ${debtRecords.length}`,
	);
}

console.log(`\n${pass} passed, ${fail} failed`);
await rm(scratch, { recursive: true, force: true }).catch(() => {});
process.exit(fail > 0 ? 1 : 0);
