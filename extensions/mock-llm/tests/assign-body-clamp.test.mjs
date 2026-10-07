#!/usr/bin/env node
/**
 * assign-body-clamp — mock-LLM lane companion test (F4 follow-up, task-fu-assign-clamp).
 *
 * Shape assertions ALWAYS run (fixture exists, is well-formed, carries the oversized→control
 * swarm_assign_task script). The LIVE lane (real `pi --provider mock-llm --model
 * assign-body-clamp` against a seeded scratch cwd with PI_SWARM_MESSAGE_BODY_MAX_BYTES=1024)
 * is opt-in via RUN_ASSIGN_CLAMP_LANE=1 — mirrors the RUN_BODY_CLAMP_LANE pattern. The tester
 * node runs the live lane in a dedicated tmux session per plan §6.
 *
 * Live-lane assertions:
 *   - assign-worker mailbox contains exactly ONE message (the control assignment; the oversized
 *     one is REJECTED before any append);
 *   - lane output contains MESSAGE_BODY_TOO_LARGE (isError tool result surfaced to the agent);
 *   - task.json shows plan assigned to assign-worker with an assignmentMessageId (control assign
 *     persisted); attempt history has no extra superseded junk;
 *   - transcript emitted for the scenario (PI_MOCK_LLM_TRANSCRIPTS_DIR).
 *
 * Root-actor requirement: swarm_assign_task is a root-level tool, so the lane env pins
 * PI_SWARM_AGENT_ID=root + PI_SWARM_IS_ROOT=1 (the qualification-gate-create lane shape).
 */
import { rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "assign-body-clamp.jsonl");
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

console.log("== assign-body-clamp fixture file shape ==");
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
ok(
	"turn 0 = oversized swarm_assign_task toolcall (2KB note)",
	t0calls.length === 1 && t0calls[0].name === "swarm_assign_task" && (t0calls[0].arguments?.note || "").length === 2048,
	{ noteLen: t0calls[0]?.arguments?.note?.length, name: t0calls[0]?.name },
);
ok("turn 0 targets taskId assign-clamp-lane-task / node plan / agent assign-worker", t0calls[0]?.arguments?.taskId === "assign-clamp-lane-task" && t0calls[0]?.arguments?.nodeId === "plan" && t0calls[0]?.arguments?.agentId === "assign-worker");
ok("turn 0 stops with toolUse (agent continues after the isError result)", (turns[0]?.events || []).some((e) => e.type === "stop" && e.reason === "toolUse"));
ok(
	"turn 1 = control swarm_assign_task toolcall (small note)",
	t1calls.length === 1 && t1calls[0].name === "swarm_assign_task" && t1calls[0].arguments?.note === "small control note",
);
ok("turn 2 = closing text + terminal stop", (turns[2]?.events || []).some((e) => e.type === "text") && (turns[2]?.events || []).some((e) => e.type === "stop" && e.reason === "stop"));

if (process.env.RUN_ASSIGN_CLAMP_LANE !== "1") {
	console.log(`\n(skipping live lane — set RUN_ASSIGN_CLAMP_LANE=1 to execute the full E2E scenario)`);
	console.log(`ASSIGN-CLAMP FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
	process.exit(fail === 0 ? 0 : 1);
}

// === Live E2E lane (opt-in via RUN_ASSIGN_CLAMP_LANE=1) ===
console.log("\n== Live E2E lane ==");
const scratch = join(tmpdir(), `swarm-assignclamp-lane-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi", "swarm"), { recursive: true });

// Seed: root pseudo-agent + assign-worker (message-body-clamp lane seeding recipe).
const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");
const now = new Date().toISOString();
const agent = (id, kind) => ({
	id,
	role: kind === "root" ? "root" : "test planner",
	roleKind: kind,
	roleKindExplicit: true,
	tmuxTarget: `assignclamplane:${id}.1`,
	tmuxSession: "assignclamplane",
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
			swarmId: "swarm-assignclamp-lane",
			cwd: scratch,
			tmuxSession: "assignclamplane",
			rootId: "root",
			agents: { root: agent("root", "root"), "assign-worker": agent("assign-worker", "planner") },
			delivered: {},
			messages: {},
			rootPumpSessions: {},
		},
		null,
		2,
	) + "\n",
);

// Seed: minimal hand-written task.json (ready planner node, auto qualification) — the lane
// fixture assigns nodeId=plan by explicit agentId; the oversized-note turn must be rejected
// before ANY write, the control turn must persist the assignment.
const taskDir = join(scratch, ".pi", "swarm", "tasks", "assign-clamp-lane-task");
mkdirSync(taskDir, { recursive: true });
const task = {
	version: 1,
	taskId: "assign-clamp-lane-task",
	title: "Assign clamp lane",
	goal: "Prove the swarm_assign_task body clamp end-to-end.",
	status: "in_progress",
	priority: "normal",
	cwd: scratch,
	createdAt: now,
	updatedAt: now,
	owner: "root",
	workflow: "feature-dev",
	acceptanceCriteria: ["Oversized assignment note is rejected; control assignment persists."],
	nodes: {
		plan: { status: "ready", role: "planner", dependsOn: [], writeArtifacts: ["artifacts/plan.md"] },
	},
	edges: [],
	start: "plan",
	currentNodes: ["plan"],
	qualification: { mode: "auto", status: "ready" },
	handoffs: [],
};
writeFileSync(join(taskDir, "task.json"), JSON.stringify(task, null, 2) + "\n");

const env = { ...process.env };
env.PI_SWARM_AGENT_ID = "root";
env.PI_SWARM_IS_ROOT = "1";
env.PI_SWARM_MESSAGE_BODY_MAX_BYTES = "1024"; // lane cap: the scripted 2KB note must be rejected
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
		"assign-body-clamp",
		"-p",
		"idle",
	],
	{ cwd: scratch, env, timeout: 60_000, encoding: "utf8" },
);

const workerMailPath = join(scratch, ".pi", "swarm", "mailboxes", "assign-worker.jsonl");
const workerMail = existsSync(workerMailPath)
	? readFileSync(workerMailPath, "utf8")
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
const subjects = workerMail.map((m) => m.subject);
ok("[live lane] pi exits cleanly", r.status === 0, (r.stderr || r.stdout || "").slice(0, 300));
ok("[live lane] assign-worker mailbox contains exactly ONE message (control assignment only)", workerMail.length === 1, { subjects });
ok(
	"[live lane] the persisted message is the control assignment",
	typeof workerMail[0]?.body === "string" && workerMail[0].body.includes("small control note") && workerMail[0].body.includes("You are assigned task assign-clamp-lane-task, node plan"),
	{ body: String(workerMail[0]?.body || "").slice(0, 120) },
);
ok(
	"[live lane] no oversized note persisted anywhere in the mailbox",
	!workerMail.some((m) => typeof m.body === "string" && m.body.includes("N".repeat(256))),
);
ok("[live lane] no oversized note persisted in swarm-state messages ledger", !readFileSync(statePath, "utf8").includes("N".repeat(256)));

let taskAfter = null;
try {
	taskAfter = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
} catch {
	taskAfter = null;
}
ok("[live lane] task.json readable after the lane", Boolean(taskAfter));
ok(
	"[live lane] control assignment persisted (plan assigned to assign-worker)",
	taskAfter?.nodes?.plan?.assignee === "assign-worker" && taskAfter?.nodes?.plan?.status === "assigned",
	{ status: taskAfter?.nodes?.plan?.status, assignee: taskAfter?.nodes?.plan?.assignee },
);
ok("[live lane] assignmentMessageId set on the node", Boolean(taskAfter?.nodes?.plan?.assignmentMessageId));
ok("[live lane] no giant acceptance/task mutation leaked into task.json", !readFileSync(join(taskDir, "task.json"), "utf8").includes("N".repeat(256)));

const output = (r.stdout || "") + (r.stderr || "");
// The rejection surfaces to the agent as an isError tool result; the fixture's post-rejection
// text ("...rejected with MESSAGE_BODY_TOO_LARGE...") carries the marker into stdout. Assert on
// EITHER the stdout text or a transcript containing the marker.
let marker = output.includes("MESSAGE_BODY_TOO_LARGE");
if (!marker && existsSync(join(scratch, ".pi/mock-llm/transcripts/assign-body-clamp"))) {
	for (const f of readdirSync(join(scratch, ".pi/mock-llm/transcripts/assign-body-clamp"))) {
		if (f.endsWith(".json") && readFileSync(join(scratch, ".pi/mock-llm/transcripts/assign-body-clamp", f), "utf8").includes("MESSAGE_BODY_TOO_LARGE")) marker = true;
	}
}
ok("[live lane] MESSAGE_BODY_TOO_LARGE surfaced (lane output or transcript)", marker);

const transcriptDir = join(scratch, ".pi/mock-llm/transcripts", "assign-body-clamp");
ok("[live lane] transcript emitted for the scenario", existsSync(transcriptDir) && readdirSync(transcriptDir).some((f) => f.endsWith(".json")));

rmSync(scratch, { recursive: true, force: true });
console.log(`\nASSIGN-CLAMP FIXTURE ${fail === 0 ? "PASS" : "FAIL"} (${fail} failed, ${pass} passed)`);
process.exit(fail ? 1 : 0);
