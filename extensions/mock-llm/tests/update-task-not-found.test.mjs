#!/usr/bin/env node
/**
 * update-task-not-found.test.mjs (mock-llm lane) — fixture driver for Stage A
 * (plan: docs/swarm/plans/2026-10-13-worker-task-closure-gaps.md §1.1; pattern: mock-llm idle-agent-gc.test.mjs)
 *
 * Seeds the incident shape: worker-lost (running, activeTaskIds EMPTY) + one real seeded task
 * dir. Replays the fixture's scripted turns through the REAL registered handlers:
 *   1. swarm_update_task with a guessed taskId → REAL handler must throw STRUCTURED
 *      TASK_NOT_FOUND (errorCode, validTaskIds listing the seeded task, myActiveTaskIds [],
 *      message-only actionableHint naming swarm_send_message, no suggestedNextCall).
 *   2. swarm_send_message to root (the guidance path) → REAL handler must succeed.
 * Asserts no state mutation from the failed call (no task dir, no mailbox rows for the
 * worker, activeTaskIds untouched) and that the report lands in root's mailbox.
 */

import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const fixturePath = join(root, "extensions/mock-llm/fixtures/update-task-not-found.jsonl");

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

// Fixture sanity
const rawLines = (await readFile(fixturePath, "utf8")).split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
const turns = rawLines.map((l) => JSON.parse(l));
const scripted = turns.flatMap((t) => t.events || []).filter((e) => e.type === "toolcall");
const upd = scripted.find((e) => e.name === "swarm_update_task");
const rep = scripted.find((e) => e.name === "swarm_send_message");
ok(
	"fixture: scripted swarm_update_task with guessed taskId",
	Boolean(upd) && upd.arguments.taskId === "p9-prompt-assembly-fix",
	JSON.stringify(scripted.map((e) => e.name)),
);
ok("fixture: scripted swarm_send_message to root follows", Boolean(rep) && rep.arguments.to === "root");

// Scratch world — the incident shape
const scratch = await mkdtemp(join(tmpdir(), "task-not-found-lane-"));
await mkdir(join(scratch, ".pi/swarm/tasks/task-alpha-fixture"), { recursive: true });
await writeFile(
	join(scratch, ".pi/swarm/tasks/task-alpha-fixture/task.json"),
	JSON.stringify({
		taskId: "task-alpha-fixture",
		title: "seeded",
		status: "in_progress",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		nodes: { plan: { role: "planner", status: "ready" } },
		edges: [],
	}),
	"utf8",
);
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
	agents: {
		root: agent("root", { roleKind: "root" }),
		"worker-lost": agent("worker-lost"),
	},
	delivered: {},
	messages: {},
};
await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(state, null, 2), "utf8");

// Real extension, fake pi
process.env.PI_SWARM_AGENT_ID = "worker-lost";
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

// Act 1: the failing update through the REAL handler
let err = null;
try {
	await tools["swarm_update_task"].execute("t", upd.arguments, undefined, undefined, ctx);
} catch (e) {
	err = e;
}
ok(
	"lane: real update_task throws TASK_NOT_FOUND",
	err?.errorCode === "TASK_NOT_FOUND",
	String(err?.errorCode || err?.message?.split("\n")[0]),
);
ok(
	"lane: validTaskIds lists the seeded task",
	JSON.stringify(err?.expected?.validTaskIds) === JSON.stringify(["task-alpha-fixture"]),
	JSON.stringify(err?.expected?.validTaskIds),
);
ok("lane: myActiveTaskIds is empty (incident shape)", JSON.stringify(err?.expected?.myActiveTaskIds) === JSON.stringify([]));
ok("lane: hint names the message-only path", /swarm_send_message/.test(err?.actionableHint || ""), err?.actionableHint);
// valid tasks exist in the dir (seeded) even though THIS worker holds none → status pointer present,
// but the hint still carries the message-only guidance (the contract's "you may not need this tool").
ok("lane: suggestedNextCall is swarm_task_status (valid ids exist)", err?.suggestedNextCall?.tool === "swarm_task_status");
ok("lane: de-path — no .pi/ in error text", !`${err?.message}${err?.actionableHint}`.includes(".pi/"));

// No state mutation from the failed call. NOTE (Stage B): since update-failure signals
// shipped, a failed update DOES emit class-based nudges — the worker gets exactly one
// update-failure self-nudge (TASK_NOT_FOUND + empty activeTaskIds → immediate) and root gets
// exactly one notice. The no-mutation contract is: no task dir, activeTaskIds untouched, and
// no mailbox rows OTHER than the Stage B update-failure pair.
const stAfter = JSON.parse(await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
ok("lane: no task dir created for the guessed id", !existsSync(join(scratch, ".pi/swarm/tasks/p9-prompt-assembly-fix")));
ok("lane: worker activeTaskIds still empty", JSON.stringify(stAfter.agents["worker-lost"].activeTaskIds) === "[]");
const ufRows = Object.values(stAfter.messages || {}).filter((m) => (m.idempotencyKey || "").includes("update-failure"));
ok("lane: exactly the Stage B self-nudge + root notice exist", ufRows.length === 2 && ufRows.some((m) => m.to === "worker-lost") && ufRows.some((m) => m.to === "root"), JSON.stringify(ufRows.map((m) => m.to)));
ok(
	"lane: no OTHER mailbox rows for the worker",
	Object.values(stAfter.messages || {}).filter((m) => m.to === "worker-lost" && !(m.idempotencyKey || "").includes("update-failure")).length === 0,
);

// Act 2: the guidance path — report via swarm_send_message through the REAL handler
const r = await tools["swarm_send_message"].execute("t", rep.arguments, undefined, undefined, ctx);
const repText = r?.content?.[0]?.text ?? "";
ok("lane: real send_message succeeded", /Sent msg-/.test(repText), repText.slice(0, 150));
const stFinal = JSON.parse(await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
const rootRows = Object.values(stFinal.messages || {}).filter((m) => m.to === "root");
ok("lane: report + Stage B root notice in root mailbox records", rootRows.length === 2, String(rootRows.length));

console.log(`\n---\nupdate-task-not-found (mock-llm lane) results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
