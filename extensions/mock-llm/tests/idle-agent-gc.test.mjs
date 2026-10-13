#!/usr/bin/env node
/**
 * idle-agent-gc.test.mjs (mock-llm lane) — fixture driver for the idle-agent GC nudge
 * (plan: docs/swarm/plans/2026-10-13-idle-agent-gc-nudge.md; pattern: mock-llm agent-stopped-gc.test.mjs)
 *
 * Seeds the Pattern-2 world (worker-idle / worker-busy / worker-leased), runs the REAL
 * evaluator from src/nudges/idle-agent-gc.ts under the real lock, then replays the fixture's
 * scripted toolcalls (swarm_check_mailbox + swarm_stop_agent) through the REAL registered
 * handlers. Asserts:
 *   - nudge lands in root mailbox exactly once, names only worker-idle
 *   - nudge body names swarm_stop_agent, never a /swarm slash command, no raw .pi/ path
 *   - R10-1: pi.sendMessage called exactly once for the nudge (durable-mailbox → L2 crossing)
 *   - the scripted stop goes through the real stopAgent core: worker-idle stopped,
 *     busy/leased untouched
 */

import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const fixturePath = join(root, "extensions/mock-llm/fixtures/idle-agent-gc-nudge.jsonl");

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
ok(
	"fixture: scripted swarm_check_mailbox present",
	scripted.some((e) => e.name === "swarm_check_mailbox"),
	JSON.stringify(scripted.map((e) => e.name)),
);
ok(
	"fixture: scripted swarm_stop_agent targets worker-idle only",
	scripted.some((e) => e.name === "swarm_stop_agent" && e.arguments?.agentId === "worker-idle"),
	JSON.stringify(scripted.map((e) => e.name)),
);

// Scratch world
const scratch = await mkdtemp(join(tmpdir(), "idle-gc-lane-"));
await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
await writeFile(
	join(scratch, ".pi", "settings.json"),
	JSON.stringify({ swarm: { defaultModel: "glm-5.1", defaultProvider: "zai-coding-cn" } }),
);
const NOW = Date.now();
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
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
	lastHeartbeatAt: iso(NOW - 30 * MIN),
	createdAt: iso(NOW - 90 * MIN),
	updatedAt: iso(NOW),
	...overrides,
});
const state = {
	version: 1,
	swarmId: "swarm-lane",
	cwd: scratch,
	tmuxSession: "sess",
	agents: {
		root: agent("root", { roleKind: "root", lastHeartbeatAt: iso(NOW) }),
		"worker-idle": agent("worker-idle"),
		"worker-busy": agent("worker-busy", { runtimeStatus: "busy", activeTaskIds: ["task-1"], lastHeartbeatAt: iso(NOW - MIN) }),
		"worker-leased": agent("worker-leased", { leaseKind: "reuse", leaseUntil: iso(NOW + 60 * MIN) }),
	},
	delivered: {},
	messages: {},
};
await writeFile(join(scratch, ".pi/swarm/swarm-state.json"), JSON.stringify(state, null, 2), "utf8");

// Real extension, fake pi
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
let evaluateIdleAgentGcNudgeLocked = null;
try {
	({ evaluateIdleAgentGcNudgeLocked } = await import(join(root, "extensions/swarm/src/nudges/idle-agent-gc.ts")));
} catch {
	evaluateIdleAgentGcNudgeLocked = null;
}
if (!evaluateIdleAgentGcNudgeLocked) {
	ok("lane: idle-agent-gc module exists (RED: missing pre-fix)", false, "src/nudges/idle-agent-gc.ts not implemented yet");
	console.log(`\n---\nidle-agent-gc (mock-llm lane) results: ${passed} passed, ${failed} failed`);
	process.exit(1);
}
const sends = [];
const tools = {};
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	sendMessage: (m, o) => sends.push({ m, o }),
	// Reference lane pattern: emulate a live pi tmux pane for the delivery path (inspectProcess
	// display-message → pi command; capturePane list-panes → one pane; send-keys succeeds).
	exec: async (cmd, args) => {
		if (cmd === "tmux" && args?.[0] === "display-message") return { code: 0, stdout: "pi\t1234\n", stderr: "" };
		if (cmd === "tmux" && args?.[0] === "list-panes") return { code: 0, stdout: "%1 0 1 1\n", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	},
};
const mod = await import(join(root, "extensions/swarm/index.ts"));
mod.default(pi);

// Run the REAL evaluator (what the pump phase will call)
const { paths, withLock, readState } = await import(join(root, "extensions/swarm/src/state.ts"));
const p = paths(scratch);
await withLock(p, async () => {
	const st = await readState(p, scratch);
	await evaluateIdleAgentGcNudgeLocked(pi, scratch, p, st, NOW);
});

const stAfterNudge = JSON.parse(await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
// Subject/body live in the durable mailbox JSONL (the ledger carries lifecycle fields only).
let mailboxLines = [];
try {
	mailboxLines = (await readFile(join(scratch, ".pi/swarm/mailboxes/root.jsonl"), "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
} catch {}
const nudges = mailboxLines.filter((m) => m.to === "root" && /idle-gc/.test(m.idempotencyKey || ""));
ok("lane: exactly one idle-gc nudge in root mailbox", nudges.length === 1, JSON.stringify(nudges.map((m) => m.idempotencyKey)));
ok(
	"lane: nudge names only worker-idle",
	nudges.length === 1 &&
		nudges[0].body.includes("worker-idle") &&
		!nudges[0].body.includes("worker-busy") &&
		!nudges[0].body.includes("worker-leased"),
	nudges[0]?.body?.slice(0, 300),
);
ok(
	"lane: nudge body names swarm_stop_agent tool",
	nudges.length === 1 && nudges[0].body.includes("swarm_stop_agent"),
	nudges[0]?.body?.slice(0, 200),
);
ok(
	"lane: nudge body never names a /swarm slash command",
	nudges.length === 1 && !/\/swarm\s+\w/.test(nudges[0].body),
	nudges[0]?.body?.slice(0, 300),
);
ok("lane: nudge body contains no raw .pi/ path", nudges.length === 1 && !nudges[0].body.includes(".pi/"), nudges[0]?.body?.slice(0, 300));
ok(
	"lane: R10-1 zero pi.sendMessage crossings (root delivery is pane-injection/mailbox-append at L1; L2 surfacing stays the pump's job)",
	sends.length === 0,
	String(sends.length),
);

// Replay the fixture's scripted toolcalls through the REAL registered handlers
const ctx = { cwd: scratch, hasUI: false };
const rMail = await tools["swarm_check_mailbox"].execute(
	"t",
	scripted.find((e) => e.name === "swarm_check_mailbox").arguments,
	undefined,
	undefined,
	ctx,
);
const mailText = rMail?.content?.[0]?.text ?? "";
ok("lane: root mailbox surface shows the idle-gc nudge", /idle-gc|worker-idle|Idle agent GC/i.test(mailText), mailText.slice(0, 200));

const stopCall = scripted.find((e) => e.name === "swarm_stop_agent");
const rStop = await tools["swarm_stop_agent"].execute("t", stopCall.arguments, undefined, undefined, ctx);
const stopText = rStop?.content?.[0]?.text ?? "";
ok("lane: real swarm_stop_agent stopped worker-idle", /Stopped worker-idle/.test(stopText), stopText.slice(0, 200));

const stFinal = JSON.parse(await readFile(join(scratch, ".pi/swarm/swarm-state.json"), "utf8"));
ok(
	"lane: worker-idle record is stopped",
	stFinal.agents["worker-idle"]?.status === "stopped",
	JSON.stringify(stFinal.agents["worker-idle"]?.status),
);
ok(
	"lane: worker-busy untouched",
	stFinal.agents["worker-busy"]?.status === "running",
	JSON.stringify(stFinal.agents["worker-busy"]?.status),
);
ok(
	"lane: worker-leased untouched",
	stFinal.agents["worker-leased"]?.status === "running",
	JSON.stringify(stFinal.agents["worker-leased"]?.status),
);

console.log(`\n---\nidle-agent-gc (mock-llm lane) results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
