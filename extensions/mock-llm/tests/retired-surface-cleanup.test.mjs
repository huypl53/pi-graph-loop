#!/usr/bin/env node
/**
 * retired-surface-cleanup.test.mjs — mock-llm lane driver (task-retired-swarm-surface-cleanup-20261004)
 * (pattern: agent-stopped-gc.test.mjs — replay the fixture's toolcalls through the REAL registered
 * handlers, then assert the retired-surface contract at the real boundaries + transcript evidence)
 *
 * Proves end-to-end:
 *   L1  fixture shape: census toolcall + send + finish scripted in retired-surface-cleanup.jsonl
 *   L2  replay: the scripted toolcalls execute against the REAL registered swarm tools (no
 *       retired tool is invoked; the census executes, the send lands in the root mailbox)
 *   L3  registry: the live surface is exactly the 14 approved tools — ack/message-status/gc and
 *       every retired agent/task name ABSENT (counted at pi.registerTool boundary)
 *   L4  identity: buildIdentityMarkdown carries workflow guidance with NO tool catalog and NO
 *       ACK/metadata/retired content; identityPrompt names no tools
 *   Evidence: fixture-shape assertions always run; transcript path reported for the live lane.
 *
 * Run: node extensions/mock-llm/tests/retired-surface-cleanup.test.mjs
 */
import { readFile, mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const fixturePath = join(root, "extensions/mock-llm/fixtures/retired-surface-cleanup.jsonl");

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

// --- L1: fixture shape ---
const turns = (await readFile(fixturePath, "utf8"))
	.split("\n")
	.filter((l) => l.trim() && !l.trim().startsWith("#"))
	.map((l) => JSON.parse(l));
const calls = turns.flatMap((t) => t.events || []).filter((e) => e.type === "toolcall");
const finishTurn = turns.find((t) => t.name === "finish");
const finishText = (finishTurn?.events || []).filter((e) => e.type === "text").map((e) => e.text || "").join("\n");
const identityContract = "Identity guidance stays outcome-oriented: no tool names, parameter names, or ordered action/call sequences.";
ok("fixture finish explicitly states the high-level identity contract", finishText.includes(identityContract), finishText);
ok("fixture identity-contract text exposes no concrete tool/parameter/call details",
	!(/\bswarm_[a-z0-9_]+\b|\b(?:replyTo|taskId|nodeId|resultMessageId|assignmentMessageId|status)\b|\bfirst\b[^\n]{0,80}\bthen\b/i.test(finishText.split(/identity guidance/i)[1] || "")),
	finishText);
ok("fixture: at least 2 scripted toolcalls", calls.length >= 2, calls.map((c) => c.name));
ok("fixture: census toolcall present", calls.some((c) => c.name === "swarm_agent_status"));
ok("fixture: send toolcall present", calls.some((c) => c.name === "swarm_send_message"));
ok("fixture: no retired tool scripted", calls.every((c) => !["swarm_ack_message", "swarm_message_status", "swarm_gc", "swarm_prune", "swarm_next_nodes", "swarm_validate_graph", "swarm_restart_agent"].includes(c.name)), calls.map((c) => c.name));

// --- scratch world + REAL extension ---
const scratch = await mkdtemp(join(tmpdir(), "retired-surface-lane-"));
await mkdir(join(scratch, ".pi/swarm/mailboxes"), { recursive: true });
const tools = {};
const sentMessages = [];
const factory = (await import(join(root, "extensions/swarm/index.ts"))).default;
factory({
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	sendMessage: async (...args) => {
		sentMessages.push(args);
		return { ok: true };
	},
	sendUserMessage: async () => {},
	setModel: () => {},
});

// Set root authority for the test (swarm_create_task / swarm_assign_task require root)
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";

// --- L3: registry contract (real pi.registerTool boundary) ---
const LIVE = new Set([
	"swarm_agent_status", "swarm_list_agents", "swarm_spawn_agent", "swarm_stop_agent",
	"swarm_set_goal", "swarm_mark_goal_done", "swarm_send_message", "swarm_check_mailbox",
	"swarm_reconcile", "swarm_create_task", "swarm_task_status", "swarm_assign_task",
	"swarm_update_task", "swarm_audit",
]);
const registered = new Set(Object.keys(tools).filter((n) => n.startsWith("swarm_")));
ok("L3: live surface is exactly the 14 approved tools", registered.size === LIVE.size && [...LIVE].every((n) => registered.has(n)), [...registered].sort());
ok("L3: ack/message-status absent", !tools.swarm_ack_message && !tools.swarm_message_status);
ok("L3: swarm_gc absent", !tools.swarm_gc);
ok("L3: retired agent/task names absent", ["swarm_prune", "swarm_next_nodes", "swarm_validate_graph", "swarm_restart_agent", "swarm_register_agent", "swarm_task_message"].every((n) => !tools[n]));

// seed root so the scripted calls execute against REAL handlers
const { paths, ensureDirs, readState, writeState, withLock } = await import(join(root, "extensions/swarm/src/state.ts"));
const { ensureRoot } = await import(join(root, "extensions/swarm/src/identity.ts"));
const p = paths(scratch);
await ensureDirs(p);
await withLock(p, async () => {
	const st = await readState(p, scratch);
	ensureRoot(st, scratch, p);
	await writeState(p, st);
});
const ctx = { cwd: scratch, mode: "tui", hasUI: false, ui: { notify: () => {}, setStatus: () => {} } };

// --- L2: replay the scripted toolcalls through the REAL handlers ---
// Require the fixture to script the census call — fail visibly if missing (no silent skip).
const census = calls.find((c) => c.name === "swarm_agent_status");
if (!census) throw new Error("fixture missing required swarm_agent_status toolcall");
const send = calls.find((c) => c.name === "swarm_send_message");
if (!send) throw new Error("fixture missing required swarm_send_message toolcall");
// Require the fixture to script the create/assign calls — fail visibly if missing (no silent skip).
const createTask = calls.find((c) => c.name === "swarm_create_task");
if (!createTask) throw new Error("fixture missing required swarm_create_task toolcall");
const assignTask = calls.find((c) => c.name === "swarm_assign_task");
if (!assignTask) throw new Error("fixture missing required swarm_assign_task toolcall");
const r1 = await tools[census.name].execute("t", census.arguments || {}, undefined, undefined, ctx);
ok("L2: census executes on the REAL handler", !!r1?.content?.[0]?.text, String(r1?.content?.[0]?.text || "").slice(0, 120));

// --- L2b: exercise assignment-body path through REAL handlers ---
// task-202610110329-remediate-retired-surfac: extend the lane to exercise the changed
// assignment/user-facing behavior end-to-end through real registered handlers.
const rCreate = await tools[createTask.name].execute("t", createTask.arguments || {}, undefined, undefined, ctx);
ok("L2b: create_task executes on the REAL handler", !!rCreate?.content?.[0]?.text, String(rCreate?.content?.[0]?.text || "").slice(0, 120));

// Register a worker agent so the assign can find a target
const { registerAgent } = await import(join(root, "extensions/swarm/src/agents.ts"));
await withLock(p, async () => {
	const st = await readState(p, scratch);
	await registerAgent({
		registerTool: () => {},
		registerCommand: () => {},
		on: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		sendMessage: () => {},
	}, scratch, p, st, {
		tmuxTarget: "unknown",
		role: "test implementer",
		roleKind: "implementer",
		id: assignTask.arguments?.agentId || "worker-rsc",
		inject: false,
	});
	await writeState(p, st);
});
const rAssign = await tools[assignTask.name].execute("t", assignTask.arguments || {}, undefined, undefined, ctx);
ok("L2b: assign_task executes on the REAL handler", !!rAssign?.content?.[0]?.text, String(rAssign?.content?.[0]?.text || "").slice(0, 120));

// Verify the assignment body delivered to the worker has NO ACK instruction.
// Strict parse: malformed mailbox lines must fail visibly (no silent catch swallowing).
const workerMailbox = join(scratch, ".pi/swarm/mailboxes", `${assignTask.arguments?.agentId || "worker-rsc"}.jsonl`);
const workerRaw = existsSync(workerMailbox) ? await readFile(workerMailbox, "utf8") : "";
const workerLines = workerRaw.split("\n").filter((l) => l.trim().length > 0);
const workerBodies = [];
let parseFailures = 0;
for (const line of workerLines) {
	try {
		const parsed = JSON.parse(line);
		workerBodies.push(parsed.body || "");
	} catch (err) {
		parseFailures++;
		console.error(`  FAIL: malformed mailbox line: ${line.slice(0, 80)}... error: ${err.message}`);
	}
}
ok("L2b: no malformed mailbox lines (strict parse)", parseFailures === 0, `${parseFailures} parse failures`);
const allWorkerBodies = workerBodies.join("\n");
ok("L2b: assignment body delivered to worker mailbox", workerBodies.length >= 1, `lines=${workerBodies.length}`);
ok("L2b: assignment body has NO 'Ack this assignment message too.'", !allWorkerBodies.includes("Ack this assignment message too."), "stale gate=0 ack instruction");
ok("L2b: assignment body has NO swarm_ack_message reference", !allWorkerBodies.includes("swarm_ack_message"), "stale ack tool reference");

const r2 = await tools[send.name].execute("t", { ...(send.arguments || {}), body: send.arguments?.body || "lane" }, undefined, undefined, ctx);
ok("L2: send executes on the REAL handler", !!r2?.content?.[0]?.text);
const mailboxFile = join(scratch, ".pi/swarm/mailboxes/root.jsonl");
const mbLines = existsSync(mailboxFile) ? (await readFile(mailboxFile, "utf8")).split("\n").filter(Boolean) : [];
ok("L2: message durably landed in the root mailbox", mbLines.length >= 1, `lines=${mbLines.length}`);
ok("L2: NO ack suffix injected into the delivered body", !mbLines.join("\n").includes("[PI-SWARM ACK REQUIRED]"), "delivery-text contract");

// --- L4: identity contract (real builder) ---
const { buildIdentityMarkdown, identityPrompt } = await import(join(root, "extensions/swarm/src/identity.ts"));
const st = await readState(p, scratch);
const agent = {
	id: "lane-worker", role: "Worker role", roleKind: "worker", capabilities: [], activeTaskIds: [],
	maxConcurrentTasks: 1, status: "running", cwd: scratch, tmuxSession: "s", tmuxWindow: "w",
	tmuxTarget: "s:w.0", mailbox: "m", model: "m", provider: "p",
	createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};
const md = buildIdentityMarkdown(st, agent);
const forbidden = ["swarm_send_message", "swarm_check_mailbox", "swarm_list_agents", "swarm_update_task", "replyTo", "taskId", "nodeId", "resultMessageId", "assignmentMessageId", "status=done", "ACK Protocol", "swarm-memory.md", "Swarm ID:", "Model: ", "CWD:", "Tmux target:", "Mailbox:"];
const found = forbidden.filter((x) => md.includes(x));
ok("L4: identity carries workflow guidance, NOT a tool/parameter catalog", found.length === 0, `found=${JSON.stringify(found)}`);
const workflow = md.split("## Reply & Completion Workflow")[1]?.split("\n## ")[0] || "";
const orderedActionChain = /\b(?:read|follow|check|keep|reply|send|report|update|close)\b[^.\n]*(?:;\s*(?:read|follow|check|keep|reply|send|report|update|close)\b|,\s*(?:and\s+)?(?:read|follow|check|keep|reply|send|report|update|close)\b)/i;
ok("L4: identity has high-level workflow without ordered action chains", /reply|completion/i.test(workflow) && /assignment|outcome|scope/i.test(workflow) && !orderedActionChain.test(workflow), workflow);
const mailboxRetrySequence = /\bre-?read\b[^.\n]{0,100}\bbefore\s+retrying\b/i;
ok("L4: identity omits mailbox reread-before-retry sequence", !mailboxRetrySequence.test(workflow), workflow.match(mailboxRetrySequence)?.[0] || "");
const coordinatesWhenUnclear = /(?:\bif\s+(?:the\s+)?(?:scope|ownership)(?:\s+or\s+(?:the\s+)?(?:scope|ownership))?\s+(?:is\s+)?(?:unclear|ambiguous)[^.]*\b(?:coordinate|coordinator|clarify|ask)\b|\b(?:coordinate|coordinator|clarify|ask)\b[^.]*\bif\s+(?:the\s+)?(?:scope|ownership)\b[^.]*\b(?:unclear|ambiguous)\b)/i;
ok("L4: identity retains high-level fencing and coordination guidance", /superseded\/cancelled assignment.{0,60}\bfenced\b/i.test(workflow) && coordinatesWhenUnclear.test(workflow), workflow);
const prompt = identityPrompt(scratch, ".pi/swarm/agents/lane-worker.md");
const forbiddenPrompt = /\bswarm_[a-z0-9_]+\b|\b(?:replyTo|taskId|nodeId|resultMessageId|assignmentMessageId|status)\b|\bfirst\b[^\n]{0,80}\bthen\b|\b(?:then|and)\s+(?:close|update|send|reply)\b/i;
ok("L4: spawn prompt names no tools, parameters, or action sequence", !forbiddenPrompt.test(prompt), prompt);
ok("L4: spawn prompt keeps high-level reply/update guidance", /reply/i.test(prompt) && /task update/i.test(prompt));

// transcript evidence pointer: the interactive tmux lane for this fixture wrote transcripts here.
// This is a soft pointer — the test must not fail on a clean machine where the manual lane
// hasn't been run yet. Manual transcript evidence belongs in the validation artifact, not as a
// CI prerequisite.
const transcriptDir = "/tmp/retired-surface-validate/.pi/mock-llm/transcripts/retired-surface-cleanup";
const transcripts = existsSync(transcriptDir) ? await readdir(transcriptDir) : [];
if (transcripts.length >= 3) {
	ok("evidence: live-lane transcripts present (manual lane run)", transcripts.length >= 3, `${transcripts.length} transcripts at ${transcriptDir}`);
} else {
	console.log("  skip evidence: live-lane transcripts present (manual lane not yet run; transcripts belong in validation artifact)");
}

await rm(scratch, { recursive: true, force: true });
console.log(`\nretired-surface-cleanup (mock-llm lane) results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
