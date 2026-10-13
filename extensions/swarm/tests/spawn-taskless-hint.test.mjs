#!/usr/bin/env node
/**
 * spawn-taskless-hint.test.mjs — RED-first for plan
 * docs/swarm/plans/2026-10-13-worker-task-closure-gaps.md §1.3 (Stage C).
 *
 * Reproduces gap G4a:
 * swarm_spawn_agent has no taskId/nodeId params (by design) and its success response
 * never tells root that the new worker is tracked by NO task graph until a separate
 * swarm_assign_task call.
 *
 * Contract under test (pre-fix: RED; post-fix: GREEN):
 *   (1) calling the real swarm_spawn_agent tool returns a result whose content[0].text
 *       contains the NOTE paragraph with the actual spawned agent id substituted:
 *         "NOTE: this agent is NOT tracked by any task graph yet. To attach its work to the task graph (and get progress/closure nudges), assign a node:\n  swarm_assign_task(taskId=\"<taskId>\", nodeId=\"<nodeId>\", agentId=\"<spawnedId>\")\nIf this is a message-only helper (no task graph), it will report back via swarm messages."
 *   (2) the text contains 'swarm_assign_task(taskId=' and 'agentId="<spawnedId>"'
 *   (3) the existing warning header + status line are unchanged when hasUserConfig is false vs true
 *       (the .pi/swarm.yaml warning behavior is preserved)
 *   (4) text contains no raw filesystem path (no scratch cwd string, no ".pi/" except the existing
 *       warning header which mentions .pi/swarm.yaml — that one is allowed, assert no OTHER .pi/
 *       occurrences beyond it).
 */
import { rmSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-spawn-taskless-hint-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi", "swarm"), { recursive: true });

// Hermetic HOME pin so local ~/.pi/agent/swarm.yml doesn't make hasUserConfig true in unconfigured leg
const hermeticHome = mkdtempSync(join(tmpdir(), "swarm-taskless-home-"));
const origHome = process.env.HOME;
process.env.HOME = hermeticHome;

// Fast spawn settle
process.env.PI_SWARM_SPAWN_SETTLE_MS = "10";
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
process.env.PI_SWARM_TERMINAL_MANAGER = "tmux";
if (!process.env.TMUX) process.env.PI_SWARM_TMUX_OK = "1";

// Ensure preflight credential check passes for mock/fallback provider
process.env.MOCK_LLM_API_KEY = "test-key";
process.env.OPENAI_API_KEY = "test-key";
process.env.CLIPROXYAPI_API_KEY = "test-key";

const { _clearGlobalYmlMemoForTests } = await import(join(here, "..", "src", "config.ts"));
_clearGlobalYmlMemoForTests();

const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

const tools = {};
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	exec: async (cmd, args) => {
		if (cmd === "tmux") {
			if (args[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
			if (args[0] === "capture-pane") return { code: 0, stdout: "pi swarm session\n", stderr: "" };
			if (
				[
					"send-keys",
					"kill-window",
					"kill-pane",
					"has-session",
					"list-panes",
					"list-windows",
					"new-window",
					"new-session",
				].includes(args[0])
			) {
				return { code: 0, stdout: "", stderr: "" };
			}
		}
		if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	},
	sendMessage: () => {},
};
factory(pi);

let pass = 0,
	fail = 0;
const ok = (n, c, info) => {
	if (c) {
		pass++;
		console.log("  ok  ", n);
	} else {
		fail++;
		console.error("  FAIL", n, info ?? "");
	}
};

const call = async (name, params) => {
	const t = tools[name];
	if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: scratch });
};

console.log("\n[1] swarm_spawn_agent without user config (.pi/swarm.yaml absent)");
{
	const res = await call("swarm_spawn_agent", { role: "worker", id: "worker-c1" });
	const text = res?.content?.[0]?.text || "";

	ok("result has content text", Boolean(text), text);

	// Warning header present when unconfigured
	ok("preserves unconfigured warning header", text.includes("[WARNING: .pi/swarm.yaml is not configured."));

	// Preserves original status line
	ok(
		"preserves spawned status line",
		text.includes("Spawned worker-c1 at ") &&
			text.includes('\nIdentity + snapshot persisted (use swarm_agent_status agentId:"worker-c1" to inspect).'),
		text,
	);

	// Expected second paragraph
	const expectedHint =
		'NOTE: this agent is NOT tracked by any task graph yet. To attach its work to the task graph (and get progress/closure nudges), assign a node:\n  swarm_assign_task(taskId="<taskId>", nodeId="<nodeId>", agentId="worker-c1")\nIf this is a message-only helper (no task graph), it will report back via swarm messages.';
	ok("contains taskless assign hint with spawned agent id", text.includes(expectedHint), text);

	ok("text contains swarm_assign_task(taskId=", text.includes("swarm_assign_task(taskId="), text);
	ok('text contains agentId="worker-c1"', text.includes('agentId="worker-c1"'), text);

	// De-path rule checks
	ok("no scratch cwd leak", !text.includes(scratch), text);
	const piOccurrences = text.match(/\.pi\//g) || [];
	ok(
		"only the allowed warning header contains .pi/ (at most 2 occurrences)",
		piOccurrences.length <= 2,
		`piOccurrences=${piOccurrences.length}`,
	);
}

console.log("\n[2] swarm_spawn_agent with user config (.pi/swarm.yaml present)");
{
	// Create user config
	writeFileSync(join(scratch, ".pi", "swarm.yaml"), "defaultModel: test-model\ndefaultProvider: mock-llm\n", "utf8");

	const res = await call("swarm_spawn_agent", { role: "worker", id: "worker-c2" });
	const text = res?.content?.[0]?.text || "";

	ok("no warning header when configured", !text.includes("[WARNING: .pi/swarm.yaml is not configured."));

	ok(
		"preserves spawned status line without warnHeader",
		text.startsWith("Spawned worker-c2 at ") &&
			text.includes('\nIdentity + snapshot persisted (use swarm_agent_status agentId:"worker-c2" to inspect).'),
		text,
	);

	const expectedHint =
		'NOTE: this agent is NOT tracked by any task graph yet. To attach its work to the task graph (and get progress/closure nudges), assign a node:\n  swarm_assign_task(taskId="<taskId>", nodeId="<nodeId>", agentId="worker-c2")\nIf this is a message-only helper (no task graph), it will report back via swarm messages.';
	ok("contains taskless assign hint with spawned agent id worker-c2", text.includes(expectedHint), text);

	ok("no scratch cwd leak", !text.includes(scratch), text);
	const piOccurrences = text.match(/\.pi\//g) || [];
	ok("zero .pi/ occurrences when configured", piOccurrences.length === 0, `piOccurrences=${piOccurrences.length}`);
}

console.log(`\n${fail === 0 ? "SPAWN-TASKLESS-HINT PASS" : "SPAWN-TASKLESS-HINT FAIL"} (${pass} passed, ${fail} failed)`);
rmSync(scratch, { recursive: true, force: true });
rmSync(hermeticHome, { recursive: true, force: true });
process.env.HOME = origHome;
delete process.env.MOCK_LLM_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.CLIPROXYAPI_API_KEY;
process.exit(fail === 0 ? 0 : 1);
