#!/usr/bin/env node
/**
 * nudge-minimal-protocol.test.mjs — Fix B red→green (task-202610031339)
 *
 * PI_SWARM_MINIMAL_PROTOCOL is an import-time constant, so this test spawns a CHILD process
 * for each gate lane:
 *   gate=1 (default/minimal): nudge body must NOT instruct swarm_ack_message (retired).
 *   gate=0 (legacy):          nudge body MUST carry the ack triple, byte-preserved.
 *
 * Run this file directly; it re-execs itself as `--child <gate>`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const here = new URL(".", import.meta.url).pathname;
const self = new URL(import.meta.url).pathname;

if (process.argv[2] === "--child") {
	await runChild(process.argv[3]);
} else {
	const run = promisify(execFile);
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

	const child = async (gate) => {
		const env = { ...process.env };
		if (gate === "0") env.PI_SWARM_MINIMAL_PROTOCOL = "0";
		else delete env.PI_SWARM_MINIMAL_PROTOCOL;
		const { stdout } = await run(process.execPath, [self, "--child", gate], { env, cwd: here });
		return JSON.parse(stdout.trim().split("\n").filter((l) => l.startsWith("RESULT:")).pop().slice(7));
	};

	console.log("=== FIX-B: nudge body protocol gating ===");
	const gate1 = await child("1");
	const gate0 = await child("0");

	ok("gate=1: nudge was delivered", gate1.delivered, JSON.stringify(gate1));
	ok("gate=1: body has NO swarm_ack_message instruction", !gate1.bodyIncludesAck, "ack line present at gate=1");
	ok("gate=1: body still carries update+send steps", gate1.bodyIncludesUpdate && gate1.bodyIncludesSend, "close steps missing");

	ok("gate=0: nudge was delivered", gate0.delivered, JSON.stringify(gate0));
	ok("gate=0: body carries the ack triple (legacy byte-preserved)", gate0.bodyIncludesAck, "ack line missing at gate=0");

	console.log(`\n---\nnudge-minimal-protocol results: ${passed} passed, ${failed} failed`);
	process.exit(failed > 0 ? 1 : 0);
}

async function runChild(gate) {
	const { mkdtemp, mkdir, writeFile, readFile, utimes } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join, dirname } = await import("node:path");
	const { paths, readState, withLock, writeState, taskPaths, ensureDirs } = await import(join(here, "..", "src", "state.ts"));
	const { evaluateArtifactProgressNudgeLocked } = await import(join(here, "..", "src", "nudges", "artifact-progress.ts"));
	const { ensureRoot } = await import(join(here, "..", "src", "identity.ts"));
	const pi = { sendMessage: async () => {}, sendUserMessage: async () => {}, registerTool: () => {}, registerCommand: () => {}, on: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }) };

	process.env.PI_SWARM_ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS ||= "200";
	process.env.PI_SWARM_ARTIFACT_PROGRESS_NUDGE_CAP ||= "3";
	process.env.PI_SWARM_ARTIFACT_PROGRESS_GRACE_MS ||= "60";

	const dir = await mkdtemp(join(tmpdir(), `fixb-gate${gate}-`));
	await mkdir(join(dir, ".pi"), { recursive: true });
	process.chdir(dir);
	const p = paths(dir);
	await ensureDirs(p);
	const st = await readState(p, dir);
	ensureRoot(st, dir, p);
	const nowMs = Date.now();
	const nowIso = new Date(nowMs).toISOString();
	st.agents["worker-a"] = {
		id: "worker-a", role: "implementer", roleKind: "worker", capabilities: [], activeTaskIds: ["task-b1"],
		maxConcurrentTasks: 1, status: "running", runtimeStatus: "idle", health: "healthy",
		tmuxSession: st.tmuxSession, tmuxWindow: "worker-a", tmuxTarget: "s:0", model: "m", provider: "p",
		cwd: dir, mailbox: ".pi/swarm/mailboxes/worker-a.jsonl", lastHeartbeatAt: nowIso,
		lastToolAt: new Date(nowMs - 120_000).toISOString(), lastAgentSettledAt: nowIso, createdAt: nowIso, updatedAt: nowIso,
	};
	await writeState(p, st);
	const tp = taskPaths(p, "task-b1");
	await mkdir(tp.root, { recursive: true });
	const task = {
		version: 1, taskId: "task-b1", title: "t", goal: "g", status: "in_progress", priority: "normal",
		createdAt: nowIso, updatedAt: nowIso, owner: "root", workflow: "feature-dev", allowedFiles: ["src/widget.ts"],
		nodes: { implement: { status: "assigned", role: "implementer", assignee: "worker-a", dependsOn: [], allowedFiles: ["src/widget.ts"], messageIds: ["msg-1"], attempts: 1, assignmentMessageId: "msg-1", lastActivityAt: nowIso, lastProgressAt: new Date(nowMs - 300_000).toISOString() } },
		edges: [{ from: "implement", to: "review", when: "passed" }],
		currentNodes: ["implement"], sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] }, gates: {}, editLocks: {},
	};
	await writeFile(tp.taskJson, JSON.stringify(task, null, 2));
	const fp = join(dir, "src/widget.ts");
	await mkdir(dirname(fp), { recursive: true });
	await writeFile(fp, "x");
	await utimes(fp, new Date(nowMs - 30_000), new Date(nowMs - 30_000));

	let delivered = false;
	try {
		const r = await withLock(p, async () => {
			const s = await readState(p, dir);
			const rr = await evaluateArtifactProgressNudgeLocked(pi, dir, p, s, nowMs);
			await writeState(p, s);
			return rr;
		});
		delivered = r.nudged >= 1;
	} catch (e) {
		delivered = false;
		console.error("child error:", e.message);
	}
	const mailboxPath = join(dir, ".pi/swarm/mailboxes/worker-a.jsonl");
	let body = "";
	try {
		const raw = await readFile(mailboxPath, "utf8");
		const lines = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
		body = lines[lines.length - 1]?.body ?? "";
	} catch {}
	console.log(
		"RESULT:" +
			JSON.stringify({
				gate,
				delivered,
				bodyIncludesAck: body.includes("swarm_ack_message("),
				bodyIncludesUpdate: body.includes("swarm_update_task("),
				bodyIncludesSend: body.includes("swarm_send_message("),
			}),
	);
	process.exit(0);
}
