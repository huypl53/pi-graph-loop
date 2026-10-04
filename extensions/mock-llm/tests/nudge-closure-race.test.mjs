#!/usr/bin/env node
/**
 * Mock-LLM driver — extensions/mock-llm/fixtures/nudge-closure-race.jsonl
 *
 * Proves Fix C of task-202610031339-artifact-progress-nudge end-to-end:
 *
 *   C1: a REAL task with an artifact-progress-triggering mtime is seeded; the fixture worker
 *       closes the node (outcome=passed, the edge-required value per Fix A) while the sweep
 *       window is open (closure written via an fs.stat interposition BEFORE delivery).
 *   C2: the REAL evaluateArtifactProgressNudgeLocked re-reads task.json before delivery,
 *       observes the terminal status, and delivers NO nudge (race lost, closure wins).
 *   C3: the worker mailbox transcript has no [PI-SWARM ARTIFACT-PROGRESS NUDGE] line, and a
 *       worker.artifact_progress_race_lost trace lands as census evidence.
 *   C4: transcript evidence exists under .pi/mock-llm/transcripts/nudge-closure-race/.
 *
 * Run: node extensions/mock-llm/tests/nudge-closure-race.test.mjs
 */
// No PI_SWARM_TERMINAL_MANAGER pin needed: this lane is in-process only
// (imports swarm/index.ts directly, never spawns a pi subprocess), so the
// terminal driver is irrelevant. See swarm-yml-pool.test.mjs for the
// spawn-based pin pattern.

// Interpose fs.promises.stat FIRST — before ANY module that imports node:fs/promises
// (including ../src/stream.ts transitively via transcripts.ts/fixtures.ts).
import fs from "node:fs";
const origPromisesStat = fs.promises.stat.bind(fs.promises);
let raceClosureTaskPath = null;
let raceClosureWritten = false;
Object.defineProperty(fs.promises, "stat", {
	value: async (path, opts) => {
		const s = await origPromisesStat(path, opts);
		if (!raceClosureWritten && raceClosureTaskPath && String(path).includes("src/feature.ts")) {
			raceClosureWritten = true;
			// The worker closes the node mid-sweep, between the snapshot stat and nudge delivery.
			const task = JSON.parse(await fs.promises.readFile(raceClosureTaskPath, "utf8"));
			task.nodes.implement.status = "done";
			task.nodes.implement.outcome = "passed";
			await fs.promises.writeFile(raceClosureTaskPath, JSON.stringify(task, null, 2));
		}
		return s;
	},
	configurable: true,
});
const { streamMockLLM, resetMockLLMCursor } = await import("../src/stream.ts");
const fsp = await import("node:fs/promises");
const { mkdtemp, mkdir, writeFile, rm, readFile, readdir, utimes } = fsp;
const { tmpdir } = await import("node:os");
const { join, dirname } = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { readFileSync, rmSync } = await import("node:fs");

const here = dirname(fileURLToPath(import.meta.url));
const swarmRoot = join(here, "..", "..", "swarm");

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info ?? "");
	}
};

const FIXTURE_MODEL = "nudge-closure-race";
const TRANSCRIPT_ROOT = join(process.cwd(), ".pi", "mock-llm", "transcripts");
await mkdir(TRANSCRIPT_ROOT, { recursive: true });
process.env.PI_MOCK_LLM_TRANSCRIPTS_DIR = TRANSCRIPT_ROOT;

console.log("C1: seeded artifact-progress trigger + mid-sweep closure (fixture worker)");
const scratch = join(tmpdir(), `swarm-nudge-closure-race-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_ARTIFACT_PROGRESS_NUDGE_BACKOFF_MS ||= "200";
process.env.PI_SWARM_ARTIFACT_PROGRESS_NUDGE_CAP ||= "3";
process.env.PI_SWARM_ARTIFACT_PROGRESS_GRACE_MS ||= "60";

const stateMod = await import(join(swarmRoot, "src", "state.ts"));
const { evaluateArtifactProgressNudgeLocked } = await import(join(swarmRoot, "src", "nudges", "artifact-progress.ts"));
const { ensureRoot } = await import(join(swarmRoot, "src", "identity.ts"));

const p = stateMod.paths(scratch);
await mkdir(join(scratch, ".pi"), { recursive: true });
await stateMod.ensureDirs(p);
const st = await stateMod.readState(p, scratch);
ensureRoot(st, scratch, p);
const nowMs = Date.now();
const nowIso = new Date(nowMs).toISOString();
st.agents["race-worker"] = {
	id: "race-worker", role: "implementer", roleKind: "worker", capabilities: [], activeTaskIds: ["task-nudge-closure-race"],
	maxConcurrentTasks: 1, status: "running", runtimeStatus: "idle", health: "healthy",
	tmuxSession: st.tmuxSession, tmuxWindow: "race-worker", tmuxTarget: "s:0", model: "mock-llm", provider: "mock-llm",
	cwd: scratch, mailbox: ".pi/swarm/mailboxes/race-worker.jsonl", lastHeartbeatAt: nowIso,
	lastToolAt: new Date(nowMs - 120_000).toISOString(), lastAgentSettledAt: nowIso, createdAt: nowIso, updatedAt: nowIso,
};
await stateMod.writeState(p, st);

const tp = stateMod.taskPaths(p, "task-nudge-closure-race");
await mkdir(tp.root, { recursive: true });
const task = {
	version: 1, taskId: "task-nudge-closure-race", title: "closure race lane", goal: "prove race-losing sweep stays silent",
	status: "in_progress", priority: "normal", createdAt: nowIso, updatedAt: nowIso, owner: "root", workflow: "feature-dev",
	allowedFiles: ["src/feature.ts"],
	nodes: {
		implement: {
			status: "assigned", role: "implementer", assignee: "race-worker", dependsOn: [], allowedFiles: ["src/feature.ts"],
			messageIds: ["msg-race-assign-1"], attempts: 1, assignmentMessageId: "msg-race-assign-1",
			lastActivityAt: nowIso, lastProgressAt: new Date(nowMs - 300_000).toISOString(),
		},
	},
	edges: [{ from: "implement", to: "review", when: "passed" }],
	currentNodes: ["implement"], sharedContext: { summary: "", decisions: [], openQuestions: [], risks: [] }, gates: {}, editLocks: {},
};
await writeFile(tp.taskJson, JSON.stringify(task, null, 2));
const artifactPath = join(scratch, "src/feature.ts");
await mkdir(dirname(artifactPath), { recursive: true });
await writeFile(artifactPath, "// seeded artifact\n");
await utimes(artifactPath, new Date(nowMs - 30_000), new Date(nowMs - 30_000));

// Arm the race: the first stat over the artifact closes the node on disk (mid-sweep, before delivery).
raceClosureTaskPath = tp.taskJson;
raceClosureWritten = false;

const pi = {
	sendMessage: () => {}, sendUserMessage: () => {}, registerTool: () => {}, registerCommand: () => {}, on: () => {},
	exec: async (cmd) => (cmd === "git" ? { code: 0, stdout: "deadbeef\n", stderr: "" } : { code: 1, stdout: "", stderr: "" }),
};

const result = await stateMod.withLock(p, async () => {
	const s = await stateMod.readState(p, scratch);
	const r = await evaluateArtifactProgressNudgeLocked(pi, scratch, p, s, nowMs);
	await stateMod.writeState(p, s);
	return r;
});
await new Promise((r) => setTimeout(r, 20));

console.log("C2: sweep loses the race — no nudge delivered");
ok("C2.a: race closure actually landed mid-sweep", raceClosureWritten, "interposition never fired");
const taskAfter = JSON.parse(await readFile(tp.taskJson, "utf8"));
ok("C2.b: node is done on disk", taskAfter.nodes.implement.status === "done", taskAfter.nodes.implement.status);
ok("C2.c: sweep nudged nobody", (result?.nudged ?? 1) === 0, JSON.stringify(result));

let mailboxLines = [];
try {
	mailboxLines = readFileSync(join(scratch, ".pi/swarm/mailboxes/race-worker.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
} catch {}
const nudgeMail = mailboxLines.filter((m) => m.subject?.includes("ARTIFACT-PROGRESS"));
ok("C2.d: worker mailbox has NO artifact-progress nudge", nudgeMail.length === 0, `got=${nudgeMail.length}`);

console.log("C3: census trace evidence");
let events = [];
try {
	events = readFileSync(p.events, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
} catch {}
ok("C3.a: worker.artifact_progress_race_lost trace recorded", events.some((e) => e.event === "worker.artifact_progress_race_lost"), events.map((e) => e.event).filter((n) => n.includes("artifact")).join(","));

await rm(scratch, { recursive: true, force: true });

console.log("C4: fixture worker transcript (worker-side protocol replay)");
resetMockLLMCursor(FIXTURE_MODEL);
const makeContext = () => ({
	systemPrompt: "mock-llm nudge-closure-race driver",
	messages: [{ role: "user", content: "run the fixture" }],
	tools: [
		{ name: "swarm_update_task", description: "update task", parameters: { type: "object", properties: {} } },
	],
});
const model = { id: FIXTURE_MODEL, provider: "mock-llm", api: "mock-llm-stream" };
const fixtureEvents = [];
for (let turn = 0; turn < 2; turn++) {
	const s = streamMockLLM(model, makeContext());
	for await (const event of s) fixtureEvents.push(event);
	await s.result();
}
const toolcallEnds = fixtureEvents.filter((e) => e.type === "toolcall_end").map((e) => e.toolCall);
const updCall = toolcallEnds.find((t) => t?.name === "swarm_update_task");
ok("C4.a: fixture emitted the closure toolcall", !!updCall, `tools: ${toolcallEnds.map((t) => t?.name).join(",")}`);
ok("C4.b: closure uses the edge-required outcome (Fix A vocabulary)", updCall?.arguments?.outcome === "passed", `outcome=${updCall?.arguments?.outcome}`);

async function walk(dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full)));
		else out.push(full);
	}
	return out;
}
const files = (await walk(TRANSCRIPT_ROOT)).filter((f) => f.includes(`/${FIXTURE_MODEL}/`)).sort();
ok("C4.c: transcript written to .pi/mock-llm/transcripts/nudge-closure-race/", files.length > 0, "");
if (files.length) {
	const raw = await readFile(files[files.length - 1], "utf8");
	ok("C4.d: transcript shows no nudge consumed by the worker", !raw.includes("ARTIFACT-PROGRESS NUDGE"), "");
}

console.log(`\n---\nnudge-closure-race (mock-llm driver) results: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
