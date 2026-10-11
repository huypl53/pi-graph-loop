// retired-surface-cleanup.test.mjs — RED-first reproducing artifact for the approved
// retired-surface cleanup (task-retired-swarm-surface-cleanup-20261004).
//
// All assertions run at the REAL registration/identity boundaries (pi.registerTool capture +
// buildIdentityMarkdown/identityPrompt), not at grep level:
//   A. Registry contract: the extension factory registers EXACTLY the live default surface —
//      ack/message-status (comment-only), swarm_gc (registrar retired from default surface),
//      and every agent/task retired-tool name are ABSENT.
//   B. Generated identity: buildIdentityMarkdown carries minimal role/workflow content —
//      no retired tool names, no ACK Protocol section, no docs/swarm-memory.md active-policy
//      link, and no redundant runtime metadata (model/provider/cwd/tmux/mailbox/swarm id).
//   C. Spawn prompt: identityPrompt never tells an agent to call swarm_ack_message.
//
// Run: node extensions/swarm/tests/retired-surface-cleanup.test.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
	if (cond) { pass++; console.log("  ok  ", name); }
	else { fail++; console.error("  FAIL", name, extra); }
};

// --- A. registry contract at the real factory boundary ---
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;
if (typeof factory !== "function") throw new Error("no default export");

const toolDefs = new Map();
const commands = [];
const handlers = {};
const scratch = mkdtempSync(join(tmpdir(), "swarm-retired-cleanup-"));
factory({
	registerTool: (def) => { toolDefs.set(def.name, def); },
	registerCommand: (name) => { commands.push(name); },
	on: (ev, fn) => { (handlers[ev] ??= []).push(fn); },
	getActiveTools: () => [...toolDefs.keys()],
	getAllTools: () => [...toolDefs.values()].map((d) => ({ name: d.name })),
	setActiveTools: () => {},
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	sendMessage: () => {},
});

const LIVE_SURFACE = new Set([
	// agents/goals
	"swarm_agent_status", "swarm_list_agents", "swarm_spawn_agent", "swarm_stop_agent",
	"swarm_set_goal", "swarm_mark_goal_done",
	// messages
	"swarm_send_message", "swarm_check_mailbox", "swarm_reconcile",
	// tasks
	"swarm_create_task", "swarm_task_status", "swarm_assign_task", "swarm_update_task",
	// audit
	"swarm_audit",
]);

const RETIRED_NAMES = [
	// agent retired block (comment-only)
	"swarm_prune", "swarm_agent_identity", "swarm_reload_identity", "swarm_trace",
	"swarm_capture_agent_pane", "swarm_dead_letters", "swarm_register_agent",
	"swarm_restart_agent", "swarm_set_role", "swarm_set_agent_paused", "swarm_send_keys",
	"swarm_attach_agent", "swarm_release_agent_task",
	// task retired block (comment-only)
	"swarm_confirm_qualification", "swarm_validate_graph", "swarm_print_graph",
	"swarm_next_nodes", "swarm_task_message",
	// messages comment-only handlers
	"swarm_ack_message", "swarm_message_status",
	// gc registrar retired from default surface
	"swarm_gc",
];

console.log("A. live registry contract (factory boundary)");
{
	const registered = new Set(toolDefs.keys());
	const missing = [...LIVE_SURFACE].filter((n) => !registered.has(n));
	ok("every live name is registered", missing.length === 0, `missing=${missing}`);
	const extra = [...registered].filter((n) => !LIVE_SURFACE.has(n) && n.startsWith("swarm_"));
	ok("no extra swarm_ tools outside the live surface", extra.length === 0, `extra=${extra}`);
	const present = RETIRED_NAMES.filter((n) => registered.has(n));
	ok("all retired names are absent from the live registry", present.length === 0, `present=${present}`);
	ok("default surface size is exact", registered.size === LIVE_SURFACE.size, `${registered.size} vs ${LIVE_SURFACE.size}`);
}

// --- B. generated identity contract ---
const { buildIdentityMarkdown } = await import(join(here, "..", "src", "identity.ts"));
import { readFileSync } from "node:fs";
const mkAgent = (id, role, roleKind) => ({
	id, role, roleKind,
	capabilities: [],
	activeTaskIds: [],
	maxConcurrentTasks: 1,
	status: "running",
	cwd: "/tmp/proj",
	tmuxTarget: "s:w.0",
	tmuxSession: "s",
	tmuxWindow: "w",
	mailbox: ".pi/swarm/mailboxes/a.jsonl",
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	model: "some-model",
	provider: "some-provider",
});
const st = { swarmId: "swarm-cleanup-test", agents: {} };
const md = buildIdentityMarkdown(st, mkAgent("worker-a", "Worker role", "worker"));
const mdPlanner = buildIdentityMarkdown(st, mkAgent("planner-01", "Task planner", "planner"));
const mdReviewer = buildIdentityMarkdown(st, mkAgent("reviewer-01", "Review work", "reviewer"));

console.log("B. generated identity is minimal role/workflow content");
{
	const stale = [
		"swarm_ack_message", "ACK Protocol", "swarm-memory.md", "swarm_trace",
		"swarm_capture_agent_pane", "swarm_agent_identity", "swarm_next_nodes",
		"Swarm ID:", "Model: ", "CWD:", "Tmux target:", "Mailbox:",
		// root review 2026-10-11: workflow guidance, NOT a tool catalog — no exact tool names/calls
		"swarm_send_message", "swarm_check_mailbox", "swarm_list_agents", "swarm_update_task",
		"replyTo", "status=done", "exact calls and ids",
	];
	const found = stale.filter((s) => md.includes(s));
	ok("identity carries no stale/retired content", found.length === 0, `found=${JSON.stringify(found)}`);
	ok("identity has no explicit tool-parameter/call-sequence wording",
		!/[\w.]+\([^\n)]*(?:=|replyTo)|\b(?:replyTo|taskId|nodeId|resultMessageId|assignmentMessageId|status)\b|\bexact calls and ids\b|\bthen\s+(?:close|update|send|reply)\b|\bfirst\b[^\n]{0,80}\bthen\b/i.test(md),
		md.match(/.{0,50}(?:replyTo|taskId|nodeId|resultMessageId|assignmentMessageId|status|exact calls and ids|then\s+(?:close|update|send|reply)|\bfirst\b[^\n]{0,80}\bthen\b).{0,50}/i)?.[0] || "");
	ok("identity keeps the role card essentials", md.includes("## Identity") && md.includes("worker-a") && md.includes("Worker role"));
	ok("identity keeps the role playbook section for playbook roles", mdPlanner.includes("## Role Playbook"));
	ok("planner identity embeds the charter", mdPlanner.includes("Charter:"));
	ok("planner identity embeds the playbook path", mdPlanner.includes("role-skills/planner"));
	ok("reviewer identity keeps the qualification responsibility pointer", mdReviewer.includes("qualification-skills"));
	const workflow = md.split("## Reply & Completion Workflow")[1]?.split("\n## ")[0] || "";
	const actionVerb = "(?:read|follow|check|keep|reply|send|report|update|close)";
	const orderedActionChain = new RegExp(`\\b${actionVerb}\\b[^.\\n]*(?:;\\s*${actionVerb}\\b|,\\s*(?:and\\s+)?${actionVerb}\\b)`, "i");
	ok("identity workflow does not enumerate comma/and/semicolon action chains", !orderedActionChain.test(workflow), workflow.match(orderedActionChain)?.[0] || "");
	const mailboxRetrySequence = /\bre-?read\b[^.\n]{0,100}\bbefore\s+retrying\b/i;
	ok("identity omits mailbox reread-before-retry sequence", !mailboxRetrySequence.test(workflow), workflow.match(mailboxRetrySequence)?.[0] || "");
	const coordinatesWhenUnclear = /(?:\bif\s+(?:the\s+)?(?:scope|ownership)(?:\s+or\s+(?:the\s+)?(?:scope|ownership))?\s+(?:is\s+)?(?:unclear|ambiguous)[^.]*\b(?:coordinate|coordinator|clarify|ask)\b|\b(?:coordinate|coordinator|clarify|ask)\b[^.]*\bif\s+(?:the\s+)?(?:scope|ownership)\b[^.]*\b(?:unclear|ambiguous)\b)/i;
	ok("identity retains high-level fencing and coordination guidance", /superseded\/cancelled assignment.{0,60}\bfenced\b/i.test(workflow) && coordinatesWhenUnclear.test(workflow), workflow);
	ok("identity keeps high-level reply/completion guidance", /reply|completion/i.test(workflow) && /assignment|outcome|scope/i.test(workflow));
	ok("identity keeps peer-verification guidance", /peer/i.test(md));
}

// --- C. spawn prompt contract ---
const { identityPrompt } = await import(join(here, "..", "src", "identity.ts"));
console.log("C. spawn identity prompt has no retired ack guidance");
{
	const prompt = identityPrompt("/tmp/proj", ".pi/swarm/agents/worker-a.md");
	ok("prompt never mentions swarm_ack_message", !prompt.includes("swarm_ack_message"), prompt.slice(0, 200));
	ok("prompt omits replyTo parameter", !/\breplyTo\b/i.test(prompt), prompt);
	ok("prompt omits exact tool names and call sequencing",
		!(/\bswarm_[a-z0-9_]+\b/i.test(prompt) || /\b(?:replyTo|taskId|nodeId|resultMessageId|assignmentMessageId|status)\b/i.test(prompt) || /\bthen\s+(?:close|update|send|reply)\b/i.test(prompt) || /\bfirst\b[^\n]{0,80}\bthen\b/i.test(prompt)), prompt);
	ok("prompt keeps the reply workflow guidance", /reply/i.test(prompt) && /close|update/i.test(prompt));
}

// --- D. active prompt/error strings carry no unregistered tool names ---
// task-202610110329-remediate-retired-surfac R3: swarm_graph is unregistered but still
// referenced in actionableHint strings in assign.ts and task-core.ts.
console.log("D. active prompt/error strings carry no unregistered tool names");
{
	const { readFileSync } = await import("node:fs");
	const assignSrc = readFileSync(join(here, "..", "src", "tools", "tasks", "assign.ts"), "utf8");
	const taskCoreSrc = readFileSync(join(here, "..", "src", "primitives", "task-core.ts"), "utf8");
	const settledSrc = readFileSync(join(here, "..", "src", "hooks", "settled.ts"), "utf8");
	const statusSrc = readFileSync(join(here, "..", "src", "tools", "agents", "status.ts"), "utf8");
	const turnsSrc = readFileSync(join(here, "..", "src", "hooks", "turns.ts"), "utf8");
	const formattingSrc = readFileSync(join(here, "..", "src", "taskgraph", "formatting.ts"), "utf8");

	// R3: swarm_graph is unregistered — must not appear in active strings
	ok("assign.ts has no swarm_graph reference", !assignSrc.includes("swarm_graph"), "stale swarm_graph hint");
	ok("task-core.ts has no swarm_graph reference", !taskCoreSrc.includes("swarm_graph"), "stale swarm_graph hint");
	ok("settled.ts has no swarm_next_nodes reference", !settledSrc.includes("swarm_next_nodes"), "stale swarm_next_nodes hint");

	// R4: swarm_gc purgeStopped must be replaced with /swarm deregister --purge-stopped
	ok("status.ts has no swarm_gc purgeStopped reference", !statusSrc.includes("swarm_gc purgeStopped"), "stale swarm_gc hint");

	// R2: SWARM_RESOLVE_TOOLS must not contain retired names
	ok("turns.ts SWARM_RESOLVE_TOOLS excludes swarm_restart_agent", !turnsSrc.includes('"swarm_restart_agent"'), "stale swarm_restart_agent in SWARM_RESOLVE_TOOLS");
	ok("turns.ts SWARM_RESOLVE_TOOLS excludes swarm_release_agent_task", !turnsSrc.includes('"swarm_release_agent_task"'), "stale swarm_release_agent_task in SWARM_RESOLVE_TOOLS");

	// R5: gate=0 assignment body must not contain "Ack this assignment message too."
	ok("formatting.ts has no 'Ack this assignment message too.' line", !formattingSrc.includes("Ack this assignment message too."), "stale gate=0 ack instruction");
}

// --- E. SWARM_RESOLVE_TOOLS set content contract ---
console.log("E. SWARM_RESOLVE_TOOLS set excludes retired names");
{
	const { SWARM_RESOLVE_TOOLS } = await import(join(here, "..", "src", "hooks", "turns.ts"));
	ok("SWARM_RESOLVE_TOOLS excludes swarm_restart_agent", !SWARM_RESOLVE_TOOLS.has("swarm_restart_agent"));
	ok("SWARM_RESOLVE_TOOLS excludes swarm_release_agent_task", !SWARM_RESOLVE_TOOLS.has("swarm_release_agent_task"));
	ok("SWARM_RESOLVE_TOOLS still includes core resolve tools", SWARM_RESOLVE_TOOLS.has("swarm_spawn_agent") && SWARM_RESOLVE_TOOLS.has("swarm_assign_task") && SWARM_RESOLVE_TOOLS.has("swarm_update_task"));
}

// --- F. assignment body contract under both protocol gates ---
// task-202610110329-remediate-retired-surfac R5: gate=0 must not contain "Ack this assignment message too."
// C1/B4 fix: PI_SWARM_MINIMAL_PROTOCOL is snapshotted at module load (constants.ts:402), so
// re-importing formatting.ts in the same process is a no-op. Use child processes to get a
// fresh module snapshot per gate.
console.log("F. assignment body contract under both protocol gates");
{
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const run = promisify(execFile);

	const formattingPath = join(here, "..", "src", "taskgraph", "formatting.ts");
	const childScript = `
import { buildAssignmentBody } from ${JSON.stringify(formattingPath)};
const fakeTask = {
	taskId: "task-test",
	title: "test",
	goal: "test",
	acceptanceCriteria: [],
	nodes: {
		implement: {
			status: "assigned",
			role: "implementer",
			assignee: "worker-a",
			dependsOn: [],
			allowedFiles: [],
			messageIds: [],
			attempts: 1,
			assignmentMessageId: "msg-1",
			lastActivityAt: new Date().toISOString(),
			lastProgressAt: new Date().toISOString(),
		},
	},
	edges: [],
};
const body = buildAssignmentBody(fakeTask, "implement", "root", undefined, "att-1", "msg-1");
console.log("RESULT:" + JSON.stringify({ body }));
`;

	const child = async (gate) => {
		const env = { ...process.env };
		if (gate === "0") env.PI_SWARM_MINIMAL_PROTOCOL = "0";
		else delete env.PI_SWARM_MINIMAL_PROTOCOL;
		const { stdout } = await run(process.execPath, ["--input-type=module", "-e", childScript], { env });
		const resultLine = stdout.trim().split("\n").filter((l) => l.startsWith("RESULT:")).pop();
		return JSON.parse(resultLine.slice(7));
	};

	const gate1 = await child("1");
	const gate0 = await child("0");

	ok("gate=1: body has NO 'Ack this assignment message too.'", !gate1.body.includes("Ack this assignment message too."), gate1.body.slice(-200));
	ok("gate=1: body has NO swarm_ack_message reference", !gate1.body.includes("swarm_ack_message"), gate1.body.slice(-200));
	ok("gate=0: body has NO 'Ack this assignment message too.'", !gate0.body.includes("Ack this assignment message too."), gate0.body.slice(-200));
	ok("gate=0: body has NO swarm_ack_message reference", !gate0.body.includes("swarm_ack_message"), gate0.body.slice(-200));
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\nRETIRED-SURFACE-CLEANUP ${fail === 0 ? "PASS" : "FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
