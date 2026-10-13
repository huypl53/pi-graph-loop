#!/usr/bin/env node
/**
 * update-failure-signals.test.mjs (mock-llm lane) — fixture driver for Stage B
 * (plan: docs/swarm/plans/2026-10-13-worker-task-closure-gaps.md §1.2; pattern: mock-llm idle-agent-gc.test.mjs)
 *
 * Seeds the incident shape (worker-stuck: running/idle, NO task graph), replays the fixture
 * turns through the REAL registered handlers:
 *   turn 0: closure-intent swarm_update_task on a guessed taskId → throws TASK_NOT_FOUND;
 *           the REAL recorder (src/nudges/update-failure.ts via tools/tasks/update.ts) emits
 *           the IMMEDIATE self-nudge + root notice (streak 1 — the motivating scenario).
 *   turn 1: swarm_send_message to root succeeds.
 * Asserts: both mailbox rows exist with the right idempotency keys, bodies name the errorCode
 * + message-root guidance, no raw paths, R10-1 pane-less world → zero inject sends, and the
 * agent record carries the stamped streak/class.
 */

import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const fixturePath = join(root, "extensions/mock-llm/fixtures/update-failure-signals.jsonl");

let passed = 0,
	failed = 0;
const ok = (n, c, info) => {
	if (c) {
		passed++;
		console.log("  ok  ", n);
	} else {
		failed++;
		console.error("  FAIL:", n, info ?? "");
	}
};

const rawLines = (await readFile(fixturePath, "utf8")).split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
const turns = rawLines.map((l) => JSON.parse(l));
const scripted = turns.flatMap((t) => t.events || []).filter((e) => e.type === "toolcall");
ok(
	"fixture: turn 0 is the failing swarm_update_task",
	scripted[0]?.name === "swarm_update_task" &&
		scripted[0].arguments.taskId === "ghost-closure-task" &&
		scripted[0].arguments.status === "done",
);
ok("fixture: turn 1 reports to root", scripted[1]?.name === "swarm_send_message" && scripted[1].arguments.to === "root");

// Scratch world — incident shape
const scratch = await mkdtemp(join(tmpdir(), "update-failure-lane-"));
await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
const NOW = new Date().toISOString();
const agent = (id, overrides = {}) => ({
	id,
	role: `${id} role`,
	roleKind: "worker",
	capabilities: [],
	activeTaskIds: [],
	maxConcurrentTasks: 1,
	status: "running",
	runtimeStatus: "idle",
	health: "healthy",
	tmuxTarget: `sess:${id}`,
	lastHeartbeatAt: NOW,
	createdAt: NOW,
	updatedAt: NOW,
	...overrides,
});
const state = {
	version: 1,
	swarmId: "swarm-lane",
	cwd: scratch,
	tmuxSession: "sess",
	agents: { root: agent("root", { roleKind: "root" }), "worker-stuck": agent("worker-stuck") },
	delivered: {},
	messages: {},
};
await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(state, null, 2), "utf8");

process.env.PI_SWARM_AGENT_ID = "worker-stuck";
const sends = [];
const tools = {};
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	sendMessage: (m, o) => sends.push({ m, o }),
	exec: async (cmd, args) => {
		if (cmd === "tmux" && args?.[0] === "display-message") return { code: 0, stdout: "pi\t1234\n", stderr: "" };
		if (cmd === "tmux" && args?.[0] === "list-panes") return { code: 0, stdout: "%1 0 1 1\n", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	},
};
const mod = await import(join(root, "extensions/swarm/index.ts"));
mod.default(pi);

const ctx = { cwd: scratch, hasUI: false };

// Turn 0: the closure-intent failure through the REAL handler (recorder fires inside)
let err = null;
try {
	await tools["swarm_update_task"].execute("t", scripted[0].arguments, undefined, undefined, ctx);
} catch (e) {
	err = e;
}
ok("lane: real update_task throws TASK_NOT_FOUND", err?.errorCode === "TASK_NOT_FOUND", String(err?.errorCode || err?.message));

const st1 = JSON.parse(await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
ok("lane: streak stamped =1 (immediate, no streak gate)", st1.agents["worker-stuck"].updateFailureStreak === 1);
ok(
	"lane: class stamped closure (terminal intent wins per classify order)",
	st1.agents["worker-stuck"].lastUpdateFailureClass === "closure",
	st1.agents["worker-stuck"].lastUpdateFailureClass,
);
ok("lane: errorCode stamped", st1.agents["worker-stuck"].lastUpdateFailureCode === "TASK_NOT_FOUND");

// Mailbox ledger rows (subject/body live in the JSONL ledger)
const ledgerRows = async (who, pattern) => {
	const p = join(scratch, ".pi/swarm/mailboxes", `${who}.jsonl`);
	try {
		return (await readFile(p, "utf8"))
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l))
			.filter((m) => (m.idempotencyKey || "").includes(pattern));
	} catch {
		return [];
	}
};
const selfRows = await ledgerRows("worker-stuck", "update-failure:self");
const rootRows = await ledgerRows("root", "worker-stuck:update-failure:root");
ok(
	"lane: self-nudge in worker mailbox immediately (streak 1)",
	selfRows.length === 1,
	JSON.stringify(selfRows.map((m) => m.idempotencyKey)),
);
ok(
	"lane: root notice in root mailbox immediately (streak 1)",
	rootRows.length === 1,
	JSON.stringify(rootRows.map((m) => m.idempotencyKey)),
);
ok(
	"lane: self-nudge names TASK_NOT_FOUND",
	selfRows.length === 1 && selfRows[0].body.includes("TASK_NOT_FOUND"),
	selfRows[0]?.body?.slice(0, 200),
);
ok("lane: self-nudge instructs swarm_send_message fallback", selfRows.length === 1 && selfRows[0].body.includes("swarm_send_message"));
ok("lane: self-nudge has no raw .pi/ path", selfRows.length === 1 && !selfRows[0].body.includes(".pi/"));
ok(
	"lane: root notice names agent + error + class",
	rootRows.length === 1 &&
		rootRows[0].body.includes("worker-stuck") &&
		rootRows[0].body.includes("TASK_NOT_FOUND") &&
		rootRows[0].body.includes("closure"),
);
ok("lane: R10-1 zero pi.sendMessage (pane-less world, mailbox-only delivery)", sends.length === 0, String(sends.length));

// Turn 1: the guidance path succeeds
const r = await tools["swarm_send_message"].execute("t", scripted[1].arguments, undefined, undefined, ctx);
ok("lane: real send_message succeeded", /Sent msg-/.test(r?.content?.[0]?.text ?? ""), (r?.content?.[0]?.text ?? "").slice(0, 120));

console.log(`\n---\nupdate-failure-signals (mock-llm lane) results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
