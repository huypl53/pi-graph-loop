#!/usr/bin/env node
/**
 * H1 D3 — gate=0 (PI_SWARM_MINIMAL_PROTOCOL=0) reply settle rule.
 *
 * Contract (Fix 4): under gate=0, a reply that passes validateResultMessage settles the
 * response debt of the target record AND all context-parallel records (Fix 2 sweep), but
 * does NOT run the v2 lifecycle derivation — no respondedAt/lifecycleStage/lifecycleSource
 * stamped (Phase-1 shadow-only regression contract preserved).
 *
 * Separate process: PI_SWARM_MINIMAL_PROTOCOL is read at module load and cached by ESM,
 * so gate=0 must be the env at THIS process's startup. Mirrors the gate split used by
 * minimal-protocol-authoritative/shadow.
 *
 * Run: PI_SWARM_MINIMAL_PROTOCOL=0 PI_SWARM_AGENT_ID=root PI_SWARM_IS_ROOT=1 node \
 *        extensions/swarm/tests/response-debt-gate0-settle.test.mjs
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.PI_SWARM_MINIMAL_PROTOCOL !== "0") {
	console.error("Run with PI_SWARM_MINIMAL_PROTOCOL=0 (see header).");
	process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), `swarm-h1-gate0-${process.pid}-${Date.now()}`));
await mkdir(join(scratch, ".pi/swarm"), { recursive: true });
process.chdir(scratch);

const ORIG_AGENT_ID = process.env.PI_SWARM_AGENT_ID;
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
process.on("exit", () => {
	if (ORIG_AGENT_ID === undefined) delete process.env.PI_SWARM_AGENT_ID;
	else process.env.PI_SWARM_AGENT_ID = ORIG_AGENT_ID;
});

const { paths, readState, writeState, withLock, ensureDirs } = await import(join(here, "..", "src", "state.ts"));
const { deliverMessageLocked } = await import(join(here, "..", "src", "mailbox.ts"));
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
		model: "glm-4.7",
		provider: "ccs",
		cwd: scratch,
		mailbox: `.pi/swarm/mailboxes/${id}.jsonl`,
		createdAt: ts,
		updatedAt: ts,
	};
}

await withLock(p, async () => {
	const s = await readState(p, scratch);
	ensureRoot(s, scratch, p);
	s.agents["worker-g0"] = baseAgent("worker-g0");
	await writeState(p, s);
});

console.log("\n--- gate=0: valid reply settles target + parallel debt, no lifecycle v2 ---");
const assignId = "msg-assign-g0";
const nudgeId = "msg-nudge-g0";
const convo = "task:h1-g0:implement";
const ts = now();

await withLock(p, async () => {
	const s = await readState(p, scratch);
	s.messages[assignId] = {
		id: assignId,
		from: "root",
		to: "worker-g0",
		status: "injected",
		createdAt: ts,
		updatedAt: ts,
		injectedAt: ts,
		attempts: 1,
		requiresAck: true,
		requiresResponse: true,
		conversationId: convo,
		response: { status: "missing", missingAt: ts },
	};
	// Parallel legacy nudge record (pre-fix minted debt) sharing the assignment context.
	s.messages[nudgeId] = {
		id: nudgeId,
		from: "root",
		to: "worker-g0",
		status: "injected",
		createdAt: ts,
		updatedAt: ts,
		injectedAt: ts,
		attempts: 1,
		requiresAck: true,
		requiresResponse: true,
		conversationId: convo,
		replyTo: assignId,
		response: { status: "missing", missingAt: ts },
	};
	s.delivered["worker-g0"] = [assignId, nudgeId];
	s.agents["worker-g0"].runtimeStatus = "response_missing";
	await writeState(p, s);
});

// Worker replies correctly.
const replyEnv = process.env.PI_SWARM_AGENT_ID;
process.env.PI_SWARM_AGENT_ID = "worker-g0";
try {
	await withLock(p, async () => {
		const s = await readState(p, scratch);
		await deliverMessageLocked(pi, scratch, p, s, {
			to: "root",
			body: "Result.",
			replyTo: assignId,
			conversationId: convo,
			requiresAck: false,
		});
		await writeState(p, s);
	});
} finally {
	process.env.PI_SWARM_AGENT_ID = replyEnv;
}

const after = await readState(p, scratch);
ok(
	"gate=0: assignment record settles to verified",
	after.messages[assignId]?.response?.status === "verified",
	after.messages[assignId]?.response?.status,
);
ok(
	"gate=0: parallel nudge record also settles (Fix 2 sweep runs under gate=0)",
	after.messages[nudgeId]?.response?.status === "verified",
	after.messages[nudgeId]?.response?.status,
);
ok(
	"gate=0: worker runtimeStatus unstuck to idle",
	after.agents["worker-g0"]?.runtimeStatus === "idle",
	after.agents["worker-g0"]?.runtimeStatus,
);

// v2 lifecycle stays gate=1-only (Phase-1 shadow contract).
ok("gate=0: NO respondedAt stamped (shadow-only lifecycle preserved)", !after.messages[assignId]?.respondedAt);
ok("gate=0: NO lifecycleStage stamped", !after.messages[assignId]?.lifecycleStage);
ok("gate=0: NO lifecycleSource stamped", !after.messages[assignId]?.lifecycleSource);

// Fix 2 fence: a record in a DIFFERENT assignment context (no conversationId match, no
// replyTo chain to the original) must NOT be swept by the parallel settlement.
const otherId = "msg-other-g0";
await withLock(p, async () => {
	const s = await readState(p, scratch);
	s.messages[otherId] = {
		id: otherId,
		from: "root",
		to: "worker-g0",
		status: "injected",
		createdAt: ts,
		updatedAt: ts,
		injectedAt: ts,
		attempts: 1,
		requiresAck: true,
		requiresResponse: true,
		conversationId: "task:other:node",
		response: { status: "missing", missingAt: ts },
	};
	await writeState(p, s);
});
process.env.PI_SWARM_AGENT_ID = "worker-g0";
try {
	await withLock(p, async () => {
		const s = await readState(p, scratch);
		await deliverMessageLocked(pi, scratch, p, s, {
			to: "root",
			body: "Result again.",
			replyTo: assignId,
			conversationId: convo,
			requiresAck: false,
		});
		await writeState(p, s);
	});
} finally {
	process.env.PI_SWARM_AGENT_ID = replyEnv;
}
const after2 = await readState(p, scratch);
ok(
	"gate=0: unrelated-context record is NOT swept by the parallel settlement",
	after2.messages[otherId]?.response?.status === "missing",
	after2.messages[otherId]?.response?.status,
);
ok(
	"gate=0: re-reply remains idempotent on already-verified records",
	after2.messages[assignId]?.response?.status === "verified" && after2.messages[nudgeId]?.response?.status === "verified",
);

console.log(`\n${pass} passed, ${fail} failed`);
await rm(scratch, { recursive: true, force: true }).catch(() => {});
process.exit(fail > 0 ? 1 : 0);
