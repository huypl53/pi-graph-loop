#!/usr/bin/env node
/** Real pi + mock-LLM replay: guest-tool-denial exercises an anonymous guest session
 * where a model attempts to call swarm_list_agents and is rejected at execution time
 * with SWARM_GUEST_DENIED, and tool gating is enforced. */
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "guest-tool-denial-lane-"));
const transcriptRoot = join(scratch, ".pi/mock-llm/transcripts");

const env = { ...process.env, PI_MOCK_LLM_TRANSCRIPTS_DIR: transcriptRoot };
delete env.PI_SWARM_AGENT_ID;
delete env.PI_SWARM_IS_ROOT;
delete env.PI_SWARM_ADMIN_MODE;

const run = spawnSync(
	"pi",
	[
		"-ne",
		"-e",
		resolve(repo, "extensions/mock-llm"),
		"-e",
		resolve(repo, "extensions/swarm"),
		"--provider",
		"mock-llm",
		"--model",
		"guest-tool-denial",
		"-p",
		"List all active swarm agents.",
	],
	{ cwd: scratch, env, timeout: 30_000, encoding: "utf8" },
);

let pass = 0,
	fail = 0;
const ok = (name, condition, info = "") => {
	if (condition) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info);
	}
};

ok("real pi lane exits cleanly", run.status === 0, run.stderr || run.stdout);
const transcriptDir = join(transcriptRoot, "guest-tool-denial");
ok("mock transcript was emitted", existsSync(transcriptDir));

if (existsSync(transcriptDir)) {
	const files = readdirSync(transcriptDir);
	const jsonFiles = files.filter((f) => f.endsWith(".json"));
	ok("transcript json files exist", jsonFiles.length > 0, `files=[${files.join(",")}]`);
	for (const f of jsonFiles) {
		const parsed = JSON.parse(readFileSync(join(transcriptDir, f), "utf8"));
		const toolNames = parsed.request?.toolNames || [];
		const swarmToolsInRequest = toolNames.filter((t) => t.startsWith("swarm_"));
		ok(`transcript ${f} has zero swarm tools in request`, swarmToolsInRequest.length === 0, `found=[${swarmToolsInRequest.join(",")}]`);
	}
}

const traceFile = join(scratch, ".pi/swarm/traces/events.jsonl");
ok("swarm trace file exists", existsSync(traceFile));
if (existsSync(traceFile)) {
	const traceContent = readFileSync(traceFile, "utf8");
	const lines = traceContent
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	const toolExec = lines.find((l) => l.event === "tool.executed" && l.tool === "swarm_list_agents");
	ok("tool.executed trace recorded", Boolean(toolExec));
	ok("guest invocation was flagged as isError: true", toolExec?.isError === true);
}

const output = (run.stdout || "") + (run.stderr || "");
ok("final output acknowledges guest tool denial", /Swarm tools are disabled for guest sessions/i.test(output), output.slice(0, 300));

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
