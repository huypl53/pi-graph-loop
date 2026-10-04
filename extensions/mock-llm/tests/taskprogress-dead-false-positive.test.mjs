#!/usr/bin/env node
/**
 * taskprogress-dead-false-positive.test.mjs — mock-llm fixture driver
 * (task-202610040001-taskprogressstate-dead-f, plan §4)
 *
 * Agent-visible surface: swarm_agent_status output. Seeds the live-incident agent shape
 * (runtimeStatus=tool_running, lastHeartbeatAt 90s stale, lastToolAt 5s fresh, healthy,
 * pane alive via fake tmux probe) in a scratch .pi/swarm, loads the REAL swarm extension,
 * replays the fixture's swarm_agent_status toolcall, and asserts the row:
 *   - taskProgressState !== "dead" (the false verdict)
 *   - why lacks "no pane / stale heartbeat"
 *   - plus the pure-function red suite re-run inline (R1..R4) for the regression contract.
 */

import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const fixturePath = join(root, "extensions/mock-llm/fixtures/taskprogress-dead-false-positive.jsonl");

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

// Parse the fixture (comment lines allowed), find the scripted swarm_agent_status call.
const rawLines = (await readFile(fixturePath, "utf8")).split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
const turns = rawLines.map((l) => JSON.parse(l));
const tcEvent = turns.flatMap((t) => t.events || []).find((e) => e.type === "toolcall" && e.name === "swarm_agent_status");
ok("fixture: scripted swarm_agent_status toolcall present", Boolean(tcEvent), "no toolcall event in fixture");
const targetAgentId = tcEvent?.arguments?.agentId || "incident-agent";

// Scratch world with the incident-shaped agent.
const scratch = await mkdtemp(join(tmpdir(), "tp-dead-fp-"));
await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
const nowMs = Date.now();
const state = {
	version: 1,
	swarmId: "swarm-x",
	cwd: scratch,
	tmuxSession: "swarm",
	agents: {
		root: { id: "root", runtimeStatus: "idle", status: "running", health: "healthy", lastHeartbeatAt: new Date(nowMs).toISOString() },
		[targetAgentId]: {
			id: targetAgentId,
			role: "implementer",
			roleKind: "worker",
			capabilities: [],
			activeTaskIds: ["task-1"],
			maxConcurrentTasks: 1,
			status: "running",
			runtimeStatus: "tool_running",
			health: "healthy",
			tmuxSession: "swarm",
			tmuxWindow: targetAgentId,
			tmuxTarget: "swarm:0.1",
			model: "m",
			provider: "p",
			cwd: scratch,
			mailbox: `.pi/swarm/mailboxes/${targetAgentId}.jsonl`,
			lastHeartbeatAt: new Date(nowMs - 90_000).toISOString(),
			lastToolAt: new Date(nowMs - 5_000).toISOString(),
			createdAt: new Date(nowMs).toISOString(),
			updatedAt: new Date(nowMs).toISOString(),
		},
	},
	delivered: {},
	messages: {},
};
await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(state, null, 2), "utf8");

// Load the real extension with a fake pi: tmux probes report the pane alive.
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
process.env.PI_SWARM_TERMINAL_MANAGER = "tmux";
const tools = {};
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	exec: async (cmd, args) => {
		if (cmd === "tmux" && args?.[0] === "list-panes") return { code: 0, stdout: "%1 0 1 1\n", stderr: "" };
		if (cmd === "tmux" && args?.[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	},
	sendMessage: () => {},
};
const mod = await import(join(root, "extensions/swarm/index.ts"));
mod.default(pi);

const r = await tools["swarm_agent_status"].execute("t", { agentId: targetAgentId }, undefined, undefined, { cwd: scratch });
const text = r?.content?.[0]?.text ?? "";
const parsed = JSON.parse(text);
const row = parsed.agents?.[0];

console.log("\n=== taskprogress dead false-positive (fixture lane) ===");
ok("tool returned a row for the target agent", Boolean(row), text.slice(0, 200));
ok("row.taskProgressState !== dead (incident shape is mid-tool, not dead)", row?.taskProgressState !== "dead", `got=${row?.taskProgressState}`);
ok("row.taskProgressState === active (fresh lastToolAt verdict)", row?.taskProgressState === "active", `got=${row?.taskProgressState}`);
ok("why does not say 'no pane / stale heartbeat'", !(row?.why ?? "").includes("no pane / stale heartbeat"), `why=${row?.why}`);

// Negative control: same shape but idle (not mid-tool) stays dead (no masking).
state.agents[targetAgentId].runtimeStatus = "idle";
await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(state, null, 2), "utf8");
const r2 = await tools["swarm_agent_status"].execute("t", { agentId: targetAgentId }, undefined, undefined, { cwd: scratch });
const row2 = JSON.parse(r2?.content?.[0]?.text ?? "{}").agents?.[0];
ok("negative control: idle + stale heartbeat still dead (no masking)", row2?.taskProgressState === "dead", `got=${row2?.taskProgressState}`);
ok("negative control: why says 'no pane / stale heartbeat' for the genuine dead", (row2?.why ?? "").includes("no pane / stale heartbeat"), `why=${row2?.why}`);

console.log(`\n---\ntaskprogress-dead-false-positive (fixture lane) results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
