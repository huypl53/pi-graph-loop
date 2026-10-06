#!/usr/bin/env node
/**
 * taskprogress-idle-stale-hb.test.mjs — mock-llm fixture driver
 * (task-202610040400-idle-dead-pane-alive, plan §5)
 *
 * Agent-visible surface: swarm_agent_status output. Seeds the live-incident agent shape
 * (status=running, runtimeStatus=idle, lastHeartbeatAt 90s stale, lastToolAt 90s stale,
 * healthy, no tasks, pane alive via mocked tmux probe) in a scratch .pi/swarm, loads the
 * REAL swarm extension, executes the fixture's scripted swarm_agent_status toolcall against
 * the REAL registered handler, and asserts the slim row:
 *   - taskProgressState === "awaiting_input" (the false verdict pre-fix: "dead")
 *   - paneAlive === true, heartbeatAge present
 *   - why lacks "no pane / stale heartbeat"
 * Plus: census-view assertion (tool-output-budget §2 consistency: healthy-idle agents stay
 * out of attention) and two negative controls (pane-dead → dead; stopped+pane-alive → dead).
 *
 * Fixture: extensions/mock-llm/fixtures/taskprogress-idle-stale-hb.jsonl (authored in the
 * implement node per plan §0 scope note; this test parses it and asserts its shape).
 */

import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const fixturePath = join(root, "extensions/mock-llm/fixtures/taskprogress-idle-stale-hb.jsonl");

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
let tcEvent = null;
try {
	const rawLines = (await readFile(fixturePath, "utf8")).split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
	const turns = rawLines.map((l) => JSON.parse(l));
	tcEvent = turns.flatMap((t) => t.events || []).find((e) => e.type === "toolcall" && e.name === "swarm_agent_status");
} catch (e) {
	tcEvent = null;
}
ok(
	"fixture: taskprogress-idle-stale-hb.jsonl exists with a scripted swarm_agent_status toolcall",
	Boolean(tcEvent),
	"fixture missing or malformed (authored in implement node)",
);
const targetAgentId = tcEvent?.arguments?.agentId || "idle-stale-agent";

// Scratch world with the incident-shaped agent.
const scratch = await mkdtemp(join(tmpdir(), "tp-idle-stale-hb-"));
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
			activeTaskIds: [],
			maxConcurrentTasks: 1,
			status: "running",
			runtimeStatus: "idle",
			health: "healthy",
			tmuxSession: "swarm",
			tmuxWindow: targetAgentId,
			tmuxTarget: "swarm:0.1",
			model: "m",
			provider: "p",
			cwd: scratch,
			mailbox: `.pi/swarm/mailboxes/${targetAgentId}.jsonl`,
			lastHeartbeatAt: new Date(nowMs - 90_000).toISOString(),
			lastToolAt: new Date(nowMs - 90_000).toISOString(),
			createdAt: new Date(nowMs).toISOString(),
			updatedAt: new Date(nowMs).toISOString(),
		},
	},
	delivered: {},
	messages: {},
};
await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(state, null, 2), "utf8");

// Load the real extension with a fake pi: tmux probes report the pane alive.
// (isTargetAlive throws on a non-zero tmux exit → probe false; return code 1 = dead pane.)
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
process.env.PI_SWARM_TERMINAL_MANAGER = "tmux";
let paneAlive = true;
const tools = {};
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	exec: async (cmd, args) => {
		if (cmd === "tmux" && args?.[0] === "list-panes") {
			return paneAlive ? { code: 0, stdout: "%1 0 1 1\n", stderr: "" } : { code: 1, stdout: "", stderr: "can't find pane" };
		}
		return { code: 0, stdout: "", stderr: "" };
	},
	sendMessage: () => {},
};
const mod = await import(join(root, "extensions/swarm/index.ts"));
mod.default(pi);

const call = (params) => tools["swarm_agent_status"].execute("t", params, undefined, undefined, { cwd: scratch });

console.log("\n=== taskprogress idle stale-heartbeat (fixture lane) ===");

// --- 1. targeted slim row: the incident shape ---
const r = await call({ agentId: targetAgentId });
const text = r?.content?.[0]?.text ?? "";
const parsed = JSON.parse(text);
const row = parsed.agents?.[0];
ok("tool returned a slim row for the target agent", Boolean(row), text.slice(0, 200));
ok(
	"row.taskProgressState === awaiting_input (incident shape is alive-idle, not dead)",
	row?.taskProgressState === "awaiting_input",
	`got=${row?.taskProgressState}`,
);
ok("row.paneAlive === true (probed)", row?.paneAlive === true, `got=${row?.paneAlive}`);
ok(
	"row.heartbeatAge present (stale-hb signal stays visible without a dead verdict)",
	typeof row?.heartbeatAge === "number",
	`got=${JSON.stringify(row?.heartbeatAge)}`,
);
ok("why does not say 'no pane / stale heartbeat'", !(row?.why ?? "").includes("no pane / stale heartbeat"), `why=${row?.why}`);

// --- 2. census view: healthy-idle agents stay out of attention (tool-output-budget §2) ---
const rc = await call({});
const pc = JSON.parse(rc?.content?.[0]?.text ?? "{}");
ok(
	"census view: agent NOT in attention (healthy-idle, no debt)",
	!(pc.attention || []).some((a) => a.agentId === targetAgentId),
	`attention=${JSON.stringify((pc.attention || []).map((a) => a.agentId))}`,
);
ok(
	"census view: census.idle counts the agent (moved out of the stopped bucket)",
	pc.census?.idle === 1,
	`got=${JSON.stringify(pc.census)}`,
);

// --- 3. negative control: pane dies → dead verdict with the honest why ---
paneAlive = false;
const rd = await call({ agentId: targetAgentId });
const rowDead = JSON.parse(rd?.content?.[0]?.text ?? "{}").agents?.[0];
ok("negative control: pane dead → dead", rowDead?.taskProgressState === "dead", `got=${rowDead?.taskProgressState}`);
ok(
	"negative control: pane-dead why says 'no pane / stale heartbeat'",
	(rowDead?.why ?? "").includes("no pane / stale heartbeat"),
	`why=${rowDead?.why}`,
);

// --- 4. negative control: stopped record with pane alive stays dead ---
paneAlive = true;
state.agents[targetAgentId].status = "stopped";
await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(state, null, 2), "utf8");
const rs = await call({ agentId: targetAgentId });
const rowStopped = JSON.parse(rs?.content?.[0]?.text ?? "{}").agents?.[0];
ok(
	"negative control: stopped record + pane alive → dead (stopped contract)",
	rowStopped?.taskProgressState === "dead",
	`got=${rowStopped?.taskProgressState}`,
);

console.log(`\n---\ntaskprogress-idle-stale-hb (fixture lane) results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
