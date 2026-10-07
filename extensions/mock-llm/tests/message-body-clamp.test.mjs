#!/usr/bin/env node
/**
 * message-body-clamp — mock-LLM lane companion test (F4, task-redteam-fixnow).
 *
 * Shape assertions ALWAYS run (fixture exists, is well-formed, carries the oversized→control
 * send script). The LIVE lane (real `pi --provider mock-llm --model message-body-clamp`
 * against a seeded scratch cwd with PI_SWARM_MESSAGE_BODY_MAX_BYTES=1024) is opt-in via
 * RUN_BODY_CLAMP_LANE=1 — mirrors the r25 pattern. The tester node runs the live lane in a
 * dedicated tmux session per plan §8.
 *
 * Live-lane assertions:
 *   - root mailbox contains exactly ONE message (the control body; the oversized one is
 *     REJECTED before any append);
 *   - the control message body is "small control body";
 *   - lane output contains MESSAGE_BODY_TOO_LARGE (isError tool result surfaced to the agent);
 *   - transcript emitted for the scenario (PI_MOCK_LLM_TRANSCRIPTS_DIR).
 */
import { rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "message-body-clamp.jsonl");
const repoRoot = join(here, "..", "..", "..");

let pass = 0,
	fail = 0;
const ok = (n, c, info) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n, info !== undefined ? `(${JSON.stringify(info).slice(0, 300)})` : "");
	}
};

console.log("== message-body-clamp fixture file shape ==");
ok("fixture file exists", existsSync(fixturePath));
const lines = existsSync(fixturePath)
	? readFileSync(fixturePath, "utf8")
			.split("\n")
			.filter((l) => l.trim() && !l.startsWith("#"))
	: [];
ok("fixture has 3 scripted turns", lines.length === 3, { lines: lines.length });
const turns = lines.map((l) => JSON.parse(l));
const t0calls = (turns[0]?.events || []).filter((e) => e.type === "toolcall");
const t1calls = (turns[1]?.events || []).filter((e) => e.type === "toolcall");
ok("turn 0 = oversized swarm_send_message toolcall", t0calls.length === 1 && t0calls[0].name === "swarm_send_message" && (t0calls[0].arguments?.body || "").length === 2048, {
	bodyLen: t0calls[0]?.arguments?.body?.length,
});
ok("turn 0 stops with toolUse (agent continues after the isError result)", (turns[0]?.events || []).some((e) => e.type === "stop" && e.reason === "toolUse"));
ok("turn 1 = control swarm_send_message toolcall (small body)", t1calls.length === 1 && t1calls[0].name === "swarm_send_message" && t1calls[0].arguments?.body === "small control body");
ok("turn 2 = closing text + terminal stop", (turns[2]?.events || []).some((e) => e.type === "text") && (turns[2]?.events || []).some((e) => e.type === "stop" && e.reason === "stop"));

if (process.env.RUN_BODY_CLAMP_LANE !== "1") {
	console.log(`\n(skipping live lane — set RUN_BODY_CLAMP_LANE=1 to execute the full E2E scenario)`);
	console.log(`BODY-CLAMP FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
	process.exit(fail === 0 ? 0 : 1);
}

// === Live E2E lane (opt-in via RUN_BODY_CLAMP_LANE=1) ===
console.log("\n== Live E2E lane ==");
const scratch = join(tmpdir(), `swarm-bodyclamp-lane-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi", "swarm"), { recursive: true });

// Seed: root pseudo-agent + clamp-worker (r25 seeding recipe).
const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");
const now = new Date().toISOString();
const agent = (id, kind) => ({
	id,
	role: kind === "root" ? "root" : "test worker",
	roleKind: kind,
	roleKindExplicit: true,
	tmuxTarget: `clamplane:${id}.1`,
	tmuxSession: "clamplane",
	tmuxWindow: id,
	mailbox: `.pi/swarm/mailboxes/${id}.jsonl`,
	capabilities: [],
	status: "running",
	runtimeStatus: "idle",
	health: "healthy",
	createdAt: now,
	updatedAt: now,
	lastHeartbeatAt: now,
	activeTaskIds: [],
});
writeFileSync(
	statePath,
	JSON.stringify(
		{
			version: 1,
			swarmId: "swarm-bodyclamp-lane",
			cwd: scratch,
			tmuxSession: "clamplane",
			rootId: "root",
			agents: { root: agent("root", "root"), "clamp-worker": agent("clamp-worker", "implementer") },
			delivered: {},
			messages: {},
			rootPumpSessions: {},
		},
		null,
		2,
	) + "\n",
);

const env = { ...process.env };
delete env.PI_SWARM_IS_ROOT;
delete env.PI_SWARM_ADMIN_MODE;
env.PI_SWARM_AGENT_ID = "clamp-worker";
env.PI_SWARM_MESSAGE_BODY_MAX_BYTES = "1024"; // lane cap: the scripted 2KB body must be rejected
env.PI_MOCK_LLM_TRANSCRIPTS_DIR = join(scratch, ".pi/mock-llm/transcripts");

const r = spawnSync(
	"pi",
	[
		"-ne",
		"-e",
		resolve(repoRoot, "extensions/swarm"),
		"-e",
		resolve(repoRoot, "extensions/mock-llm"),
		"--provider",
		"mock-llm",
		"--model",
		"message-body-clamp",
		"-p",
		"idle",
	],
	{ cwd: scratch, env, timeout: 60_000, encoding: "utf8" },
);

const rootMailPath = join(scratch, ".pi", "swarm", "mailboxes", "root.jsonl");
const rootMail = existsSync(rootMailPath)
	? readFileSync(rootMailPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(Boolean)
	: [];
const subjects = rootMail.map((m) => m.subject);
ok("[live lane] pi exits cleanly", r.status === 0, (r.stderr || r.stdout || "").slice(0, 300));
ok("[live lane] root mailbox contains exactly ONE message (control only)", rootMail.length === 1, { subjects });
ok("[live lane] the persisted message is the control body", rootMail[0]?.body === "small control body", { body: rootMail[0]?.body?.slice(0, 60) });
ok("[live lane] no oversized body persisted anywhere in the mailbox", !rootMail.some((m) => typeof m.body === "string" && m.body.startsWith("P".repeat(64))));
const output = (r.stdout || "") + (r.stderr || "");
// The rejection surfaces to the agent as an isError tool result; in the -ne lane the worker's
// next assistant text ("...rejected with MESSAGE_BODY_TOO_LARGE...") carries the marker into
// stdout. Assert on EITHER the stdout text or a transcript containing the marker.
let marker = output.includes("MESSAGE_BODY_TOO_LARGE");
if (!marker && existsSync(join(scratch, ".pi/mock-llm/transcripts/message-body-clamp"))) {
	for (const f of readdirSync(join(scratch, ".pi/mock-llm/transcripts/message-body-clamp"))) {
		if (f.endsWith(".json") && readFileSync(join(scratch, ".pi/mock-llm/transcripts/message-body-clamp", f), "utf8").includes("MESSAGE_BODY_TOO_LARGE")) marker = true;
	}
}
ok("[live lane] MESSAGE_BODY_TOO_LARGE surfaced (lane output or transcript)", marker);

const transcriptDir = join(scratch, ".pi/mock-llm/transcripts", "message-body-clamp");
ok("[live lane] transcript emitted for the scenario", existsSync(transcriptDir) && readdirSync(transcriptDir).some((f) => f.endsWith(".json")));

rmSync(scratch, { recursive: true, force: true });
console.log(`\nBODY-CLAMP FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
process.exit(fail ? 1 : 0);
