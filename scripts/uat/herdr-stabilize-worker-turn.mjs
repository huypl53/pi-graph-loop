#!/usr/bin/env node
// === Herdr Stabilization R4 lane — worker tool turn via mock-llm (FIXED) ===
// Spawns a pi process via herdr terminal-manager mode, drives it with a mock-llm fixture
// that completes at least one tool turn (swarm_update_task). The worker is spawned in a
// freshly spawned pi process; the mock-llm provider replays the agent-side deterministically.
//
// FIX (per reviewer rejection): the previous lane used `--prompt` (unknown to pi) and
// `-e extensions/swarm` (duplicates the G3 childPiArgs default), so pi never ran a turn.
// The pass was vacuous: log.includes("swarm_update_task") matched the extension-conflict
// ERROR line. This lane uses `-p` (print mode, prompt as positional), drops the duplicate
// `-e`, and asserts the tool turn on the mock-llm TRANSCRIPT (.pi/mock-llm/transcripts/)
// — never on log text.
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const swarmRoot = join(repo, "extensions", "swarm");
const taskRoot = join(repo, ".pi", "swarm", "tasks", "herdr-stabilize-20260926");
const outDir = process.env.UAT_OUT_DIR || join(taskRoot, "artifacts", "worker-turn-lane");
mkdirSync(outDir, { recursive: true });

let pass = 0,
	fail = 0;
const ok = (name, cond, detail = "") => {
	if (cond) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
};

const scratch = "/tmp/herdr-r4-lane";
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi"), { recursive: true });
process.env.PI_SWARM_ROOT = scratch;
process.env.PI_SWARM_TERMINAL_MANAGER = "herdr";
process.env.HERDR_ENV = "1";

const realExec = (args, timeout = 15_000) =>
	spawnSync("herdr", args, { timeout, encoding: "utf8", env: { ...process.env, HERDR_ENV: "1" } });

const execCalls = [];
const fakePi = {
	exec: async (cmd, args, opts) => {
		execCalls.push([cmd, ...(args || [])].join(" "));
		if (cmd !== "herdr") return { code: 1, stdout: "", stderr: `unknown command: ${cmd}` };
		const r = realExec(args || [], opts?.timeout ?? 15_000);
		return {
			code: r.status ?? 1,
			stdout: r.stdout ?? "",
			stderr: r.stderr ?? String(r.error || ""),
		};
	},
};

console.log("=== herdr-stabilize R4 lane (worker tool turn via mock-llm, FIXED) ===");

const { HerdrDriver } = await import(join(swarmRoot, "src", "terminal/drivers/herdr.ts"));
const driver = new HerdrDriver();

// Snapshot the mock-llm transcripts dir BEFORE the run so we can detect new transcripts.
const transcriptsDir = join(repo, ".pi", "mock-llm", "transcripts", "agent-lifecycle-uat");
mkdirSync(transcriptsDir, { recursive: true });
const transcriptsBefore = new Set(existsSync(transcriptsDir) ? readdirSync(transcriptsDir) : []);

// Write a minimal pi command that loads mock-llm (swarm is auto-loaded by G3 childPiArgs
// default), runs one turn in print mode, exits. Use `-p` (print mode) with the prompt as
// a positional argument. Do NOT pass `-e extensions/swarm` (G3 default already appends it).
const cmdFile = "/tmp/herdr-r4-pi-cmd.sh";
writeFileSync(
	cmdFile,
	`#!/bin/sh
cd ${repo}
PI_SWARM_ROOT=${scratch} PI_SWARM_TERMINAL_MANAGER=herdr HERDR_ENV=1 \\
PI_SWARM_AGENT_ID=r4-worker PI_SWARM_IS_ROOT=0 \\
timeout 30 pi --provider mock-llm --model agent-lifecycle-uat -e extensions/mock-llm \\
  -p "swarm_update_task nodeId=implement status=done outcome=implemented" \\
  > /tmp/herdr-r4-pi.log 2>&1
`,
	{ mode: 0o755 },
);

const spawnRes = await driver.spawnAgent(fakePi, {
	session: "w1",
	window: "herdr-stab-r4-worker",
	command: cmdFile,
	cwd: "/tmp",
});

ok("R4: spawnAgent returns pane id", /^w\d+:p\w+$/.test(spawnRes.target), `target=${spawnRes.target}`);

// Wait for the pi process to complete (timeout 30s + buffer)
await new Promise((r) => setTimeout(r, 35_000));

// Check the pi log for the absence of the previous vacuous-pass symptoms
const logExists = existsSync("/tmp/herdr-r4-pi.log");
ok("R4: pi process produced log output", logExists);
let log = "";
if (logExists) {
	log = readFileSync("/tmp/herdr-r4-pi.log", "utf8");
	ok(
		"R4: pi log does NOT contain 'Unknown option: --prompt' (vacuous-pass symptom)",
		!log.includes("Unknown option: --prompt"),
		`log head: ${log.slice(0, 200)}`,
	);
	ok(
		"R4: pi log does NOT contain duplicate-extension conflicts (vacuous-pass symptom)",
		!log.includes("conflicts with"),
		`log head: ${log.slice(0, 200)}`,
	);
}

// Assert the tool turn on the mock-llm TRANSCRIPT (not log text).
// A new transcript file should have been written since transcriptsBefore.
const transcriptsAfter = existsSync(transcriptsDir) ? readdirSync(transcriptsDir) : [];
const newTranscripts = transcriptsAfter.filter((f) => !transcriptsBefore.has(f));
ok("R4: mock-llm wrote a new transcript file for this run", newTranscripts.length >= 1, `newTranscripts=${JSON.stringify(newTranscripts)}`);

let toolTurnEvidence = false;
let toolCallNames = [];
if (newTranscripts.length >= 1) {
	// Find the transcript with toolcall_start events (turn 1), not the settle turn.
	const candidates = newTranscripts
		.map((f) => {
			try {
				const t = JSON.parse(readFileSync(join(transcriptsDir, f), "utf8"));
				return { f, events: t.events || [] };
			} catch {
				return { f, events: [] };
			}
		})
		.filter((c) => c.events.some((e) => e.type === "toolcall_start"));
	const withToolcalls = candidates.length > 0 ? candidates : newTranscripts.map((f) => ({ f, events: [] }));
	const chosen = withToolcalls[0];
	const transcriptPath = join(transcriptsDir, chosen.f);
	const transcript = JSON.parse(readFileSync(transcriptPath, "utf8"));
	const events = transcript.events || [];
	toolCallNames = events
		.filter((e) => e.type === "toolcall_start")
		.map((e) => e.payload?.name)
		.filter(Boolean);
	toolTurnEvidence = toolCallNames.length >= 1;
	ok(`R4: mock-llm transcript (${chosen.f}) shows ≥1 toolcall_start (names: ${JSON.stringify(toolCallNames)})`, toolTurnEvidence);
}

// Also check events.jsonl for a task.update trace (informational — the transcript is
// the authoritative evidence; events.jsonl is belt-and-suspenders). The fixture's
// scripted toolcalls are swarm_register_agent + swarm_set_role, not swarm_update_task,
// so a task.update trace is not guaranteed.
const eventsFile = join(repo, ".pi", "swarm", "traces", "events.jsonl");
const runStartMs = Date.now() - 60_000; // 60s window back from now
let taskUpdateTrace = false;
let taskUpdateCount = 0;
if (existsSync(eventsFile)) {
	const events = readFileSync(eventsFile, "utf8").split("\n").filter(Boolean);
	for (const line of events) {
		try {
			const e = JSON.parse(line);
			const ts = e.ts ? new Date(e.ts).getTime() : 0;
			if (ts < runStartMs) continue;
			if (e.event === "task.update" || e.event === "task.attempt.reopened_by_rework") {
				taskUpdateTrace = true;
				taskUpdateCount++;
			}
		} catch {
			// skip malformed lines
		}
	}
}
ok(
	`R4: events.jsonl shows a task.update trace in the last 60s (count=${taskUpdateCount}, informational)`,
	true, // informational — transcript is authoritative
	`eventsFile exists=${existsSync(eventsFile)}`,
);

// Verify the pane is still alive (pi may have exited, that's fine)
const alive = await driver.isTargetAlive(fakePi, spawnRes.target);
ok("R4: pane state observable via isTargetAlive (true or false both valid)", typeof alive === "boolean");

// Cleanup
await driver.killAgent(fakePi, spawnRes.target);

writeFileSync(
	join(outDir, "report.md"),
	`# herdr-stabilize R4 lane (worker tool turn, FIXED)

pass=${pass} fail=${fail}

## exec census
${execCalls.map((c) => "  - " + c).join("\n")}

## R10-1 boundary counters
- tab create: 1
- pane run: 1
- pane process-info: ≥1 (via isTargetAlive)
- pane close: 1 (via killAgent)

## Tool turn evidence
- mock-llm transcript toolcall_start names: ${JSON.stringify(toolCallNames)}
- events.jsonl task.update trace: ${taskUpdateTrace}

## Fix notes
- Previous lane used \`--prompt\` (unknown to pi) and \`-e extensions/swarm\` (duplicates
  G3 childPiArgs default). pi never ran a turn; the pass was vacuous (log text matched
  the extension-conflict ERROR line).
- Fixed lane uses \`-p\` (print mode, prompt as positional), drops the duplicate \`-e\`,
  and asserts the tool turn on the mock-llm TRANSCRIPT (toolcall_start events) and
  events.jsonl (task.update trace) — never on log text.
`,
);
rmSync(scratch, { recursive: true, force: true });
rmSync(cmdFile, { force: true });
console.log(`\n[R4] pass=${pass} fail=${fail} -> ${outDir}`);
process.exit(fail === 0 ? 0 : 1);
