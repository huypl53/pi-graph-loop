// Flow dialog V3: interactive graph tree + master-detail coverage.
// Run: node extensions/swarm/flow-dialog.test.mjs
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Key, visibleWidth } from "@earendil-works/pi-tui";
import { paths, readState, writeState, taskPaths, readTaskState, writeTaskState } from "../src/state.ts";
import { collectFlowData, FlowDialog, pickFlowTask, deriveCurrentNodeIds, buildStoryLine, buildGraphTree, buildHandoffLines, messageLifecyclePhrase } from "../src/flow-dialog.ts";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

const tools = {};
const cmds = {};
const handlers = {};
const pi = {
	registerTool: (def) => { tools[def.name] = def; },
	registerCommand: (name, opts) => { cmds[name] = opts; },
	on: (ev, h) => { (handlers[ev] ??= []).push(h); },
	exec: async (cmd, args) => {
		if (cmd === "tmux" && args?.[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
		if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	},
};
factory(pi);

const scratch = join(tmpdir(), `swarm-flow-dialog-v3-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
for (const h of handlers.session_start ?? []) await h({}, { cwd: scratch, mode: "tui", hasUI: false });

const p = paths(scratch);
const now = Date.now();
const iso = (delta = 0) => new Date(now + delta).toISOString();

function baseTask(taskId, title, overrides = {}) {
	return {
		version: 1,
		taskId,
		title,
		goal: title,
		status: overrides.status || "in_progress",
		priority: "high",
		createdAt: iso(-10_000),
		updatedAt: iso(overrides.updatedDelta ?? 0),
		owner: "root",
		workflow: "feature-dev",
		allowedFiles: overrides.allowedFiles || [],
		acceptanceCriteria: overrides.acceptanceCriteria || [],
		validationCommands: overrides.validationCommands || [],
		start: overrides.start || "plan",
		currentNodes: overrides.currentNodes || ["implement"],
		sharedContext: { summary: "", decisions: [], risks: [], openQuestions: [] },
		nodes: overrides.nodes,
		edges: overrides.edges,
		handoffs: overrides.handoffs || [],
		gates: overrides.gates || {},
		editLocks: {},
		evidence: {},
	};
}

function mkAgent(id, roleKind, status = "running", runtimeStatus = "idle", health = "healthy") {
	return {
		id,
		role: id,
		roleKind,
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status,
		runtimeStatus,
		health,
		tmuxSession: "swarm-flow-dialog-v3",
		tmuxWindow: id,
		tmuxTarget: `swarm-flow-dialog-v3:${id}.0`,
		model: "gpt-5.4-mini",
		provider: "openai",
		cwd: scratch,
		mailbox: `.pi/swarm/mailboxes/${id}.jsonl`,
		createdAt: iso(-10_000),
		updatedAt: iso(),
	};
}

const branchTaskId = "task-branch";
const linearTaskId = "task-linear-12";
const blockedTaskId = "task-blocked";
const readyTaskId = "task-ready";

const branchTask = baseTask(branchTaskId, "Branch + rework flow", {
	currentNodes: ["review"],
	nodes: {
		plan: { status: "done", role: "planner", dependsOn: [], messageIds: [], attempts: 1, outcome: "planned", lastActivityAt: iso(-8_000) },
		implement: { status: "done", role: "implementer", assignee: "obs-implementer", dependsOn: ["plan"], messageIds: ["msg-impl"], assignmentMessageId: "msg-impl", attempts: 1, outcome: "implemented", lastActivityAt: iso(-7_000) },
		review: { status: "assigned", role: "reviewer", assignee: "obs-reviewer", dependsOn: ["implement"], messageIds: ["msg-review"], assignmentMessageId: "msg-review", attempts: 1, lastActivityAt: iso(-6_000) },
		fix: { status: "blocked", role: "implementer", assignee: "obs-implementer", dependsOn: ["review"], messageIds: ["msg-fix"], assignmentMessageId: "msg-fix", attempts: 2, staleAt: iso(-50_000), lastActivityAt: iso(-5_500) },
		validate: { status: "ready", role: "tester", dependsOn: ["review"], messageIds: [], attempts: 0, lastActivityAt: iso(-4_000) },
		close: { status: "pending", role: "root", dependsOn: ["validate"], messageIds: [], attempts: 0, lastActivityAt: iso(-3_000), terminal: true },
	},
	edges: [
		{ from: "plan", to: "implement", when: "planned" },
		{ from: "implement", to: "review", when: "implemented" },
		{ from: "review", to: "fix", when: "rejected", rework: true },
		{ from: "fix", to: "review", when: "implemented", rework: true },
		{ from: "review", to: "validate", when: "approved" },
		{ from: "validate", to: "close", when: "passed" },
	],
	handoffs: [
		{ fromNode: "implement", toNode: "review", messageId: "msg-review" },
		{ fromNode: "review", toNode: "fix", messageId: "msg-fix" },
	],
	updatedDelta: -2_000,
});

const linearNodes = {};
const linearEdges = [];
for (let i = 1; i <= 12; i++) {
	const id = `node${i}`;
	linearNodes[id] = {
		status: i === 1 ? "done" : i === 2 ? "assigned" : i === 12 ? "ready" : "pending",
		role: i % 3 === 0 ? "reviewer" : i % 3 === 1 ? "planner" : "implementer",
		assignee: i === 2 ? "obs-implementer" : undefined,
		dependsOn: i === 1 ? [] : [`node${i - 1}`],
		messageIds: [],
		attempts: 0,
		outcome: i === 1 ? "planned" : null,
		lastActivityAt: iso(-i * 1_000),
	};
	if (i > 1) linearEdges.push({ from: `node${i - 1}`, to: id, when: i === 2 ? "planned" : `step${i}` });
}
const linearTask = baseTask(linearTaskId, "Twelve node chain", {
	start: "node1",
	currentNodes: ["node2"],
	nodes: linearNodes,
	edges: linearEdges,
	updatedDelta: -1_000,
});

const blockedTask = baseTask(blockedTaskId, "Blocked task", {
	nodes: {
		plan: { status: "done", role: "planner", dependsOn: [], messageIds: [], attempts: 1, outcome: "planned", lastActivityAt: iso(-10_000) },
		implement: { status: "blocked", role: "implementer", assignee: "blocked-agent", dependsOn: ["plan"], messageIds: ["msg-block"], assignmentMessageId: "msg-block", attempts: 1, staleAt: iso(-70_000), lastActivityAt: iso(-9_000) },
	},
	edges: [{ from: "plan", to: "implement", when: "planned" }],
	currentNodes: ["implement"],
});
const readyTask = baseTask(readyTaskId, "Ready task", {
	nodes: {
		plan: { status: "done", role: "planner", dependsOn: [], messageIds: [], attempts: 1, outcome: "planned" },
		implement: { status: "ready", role: "implementer", dependsOn: ["plan"], messageIds: [], attempts: 0 },
	},
	edges: [{ from: "plan", to: "implement", when: "planned" }],
	currentNodes: [],
	status: "ready",
});

await writeTaskState(taskPaths(p, branchTaskId), branchTask);
await writeTaskState(taskPaths(p, linearTaskId), linearTask);
await writeTaskState(taskPaths(p, blockedTaskId), blockedTask);
await writeTaskState(taskPaths(p, readyTaskId), readyTask);

const st = await readState(p, scratch);
st.agents = {
	"obs-implementer": mkAgent("obs-implementer", "implementer", "running", "tool_running", "healthy"),
	"obs-reviewer": mkAgent("obs-reviewer", "reviewer", "running", "busy", "healthy"),
	"blocked-agent": mkAgent("blocked-agent", "implementer", "running", "busy", "healthy"),
};
st.agents["obs-implementer"].activeTaskIds = [branchTaskId];
st.agents["obs-reviewer"].activeTaskIds = [branchTaskId];
st.agents["blocked-agent"].activeTaskIds = [blockedTaskId];
st.messages = {
	"msg-impl": {
		id: "msg-impl",
		from: "root",
		to: "obs-implementer",
		status: "acked",
		createdAt: iso(-9_000),
		updatedAt: iso(-8_500),
		ackedAt: iso(-8_500),
		attempts: 1,
		requiresAck: true,
		requiresResponse: true,
		response: { status: "verified", resultMessageId: "result-impl", verifiedAt: iso(-8_000) },
		conversationId: `task:${branchTaskId}:implement`,
	},
	"msg-review": {
		id: "msg-review",
		from: "root",
		to: "obs-reviewer",
		status: "acked",
		createdAt: iso(-7_000),
		updatedAt: iso(-6_500),
		ackedAt: iso(-6_500),
		attempts: 1,
		requiresAck: true,
		requiresResponse: true,
		response: { status: "verified", resultMessageId: "result-review", verifiedAt: iso(-6_000) },
		conversationId: `task:${branchTaskId}:review`,
	},
	"msg-fix": {
		id: "msg-fix",
		from: "root",
		to: "obs-implementer",
		status: "dead_letter",
		createdAt: iso(-6_000),
		updatedAt: iso(-5_000),
		attempts: 2,
		requiresAck: true,
		requiresResponse: true,
		response: { status: "missing", missingAt: iso(-5_000) },
		conversationId: `task:${branchTaskId}:fix`,
	},
	"msg-block": {
		id: "msg-block",
		from: "root",
		to: "blocked-agent",
		status: "intercepted",
		createdAt: iso(-4_000),
		updatedAt: iso(-3_000),
		queuedAt: iso(-4_000),
		injectedAt: iso(-3_500),
		interceptedAt: iso(-3_400),
		attempts: 1,
		requiresAck: true,
		requiresResponse: true,
		response: { status: "missing", missingAt: iso(-3_000) },
		conversationId: `task:${blockedTaskId}:implement`,
	},
};
await writeState(p, st);

const theme = { fg: (_c, s) => s, bg: (_c, s) => s };
const tui = { requestRender: () => {} };
const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

let fail = 0;
const ok = (name, cond) => { if (cond) console.log("  ok  ", name); else { fail++; console.error("  FAIL", name); } };

const beforeTask = createHash("sha256").update(readFileSync(taskPaths(p, branchTaskId).taskJson)).digest("hex");
const beforeState = createHash("sha256").update(readFileSync(p.state)).digest("hex");

const branchTaskFile = taskPaths(p, branchTaskId);
const branchTaskState = await readTaskState(branchTaskFile.taskJson);
const branchSt = await readState(p, scratch);
const data = await collectFlowData(p, scratch, branchTaskState, branchTaskFile, branchSt, 4);
ok("collectFlowData returns snapshot", Boolean(data));
ok("attention taxonomy is prioritized", data.attention.length > 0 && data.attention[0].severity === "act");
ok("snapshot includes lanes/events", data.lanes.length >= 1 && data.events.length >= 0);
ok("snapshot includes attention hints", data.attention.some((item) => item.hint.includes("/swarm")));

const tree = buildGraphTree(branchTaskState);
ok("tree includes all branch task nodes", ["plan", "implement", "review", "fix", "validate", "close"].every((id) => tree.entries.some((e) => e.nodeId === id)));

const story = buildStoryLine(branchTaskState, data.closure, ["validate"], ["review"], 2);
ok("D1 story line includes percent and next", /%/.test(story) && /next: validate/.test(story) && /needs attention/.test(story));
ok("D5 latest non-superseded message is inline", buildHandoffLines(branchTaskState, branchSt).some((line) => line.edge === "review→fix" && /stuck|waiting/.test(line.text)));
ok("D5 no-record states are explicit", buildHandoffLines(linearTask, branchSt).some((line) => /no handoff record/.test(line.text)));
ok("D2 tree covers all linear nodes without truncation", (() => { const model = buildGraphTree(linearTask); const text = model.entries.map((entry) => entry.nodeId).join(" "); return Array.from({ length: 12 }, (_, i) => `node${i + 1}`).every((id) => text.includes(id)); })());

// Picker regression.
const pickerCustomCalls = [];
const pickerCtx = {
	cwd: scratch,
	mode: "tui",
	hasUI: true,
	ui: {
		notify: () => {},
		custom: async (factory, opts) => {
			pickerCustomCalls.push({ factory, opts });
			const doneValues = [];
			const comp = factory(tui, theme, undefined, (v) => doneValues.push(v));
			const text = comp.render(120).join("\n");
			ok("picker lists tasks in severity order", text.indexOf(blockedTaskId) < text.indexOf(readyTaskId));
			ok("picker shows attention badge for blocked task", /![1-9]/.test(text));
			comp.handleInput("\r");
			return doneValues[0];
		},
	},
};
const pickedTask = await pickFlowTask(pickerCtx, scratch, p);
ok("picker opens overlay with static options", pickerCustomCalls.length === 1 && pickerCustomCalls[0].opts?.overlay === true);
ok("picker returns a resolved task without opening the dialog", Boolean(pickedTask) && pickedTask.task.taskId === blockedTaskId);
ok("non-TUI picker falls back without custom", await pickFlowTask({ cwd: scratch, mode: "print", hasUI: false, ui: { notify: () => {} } }, scratch, p) === undefined);

const dialog = new FlowDialog(tui, theme, { p, cwd: scratch, task: branchTaskState, tp: branchTaskFile, st: branchSt, eventLimit: 4 }, () => {});
await wait();
let dialogText = dialog.render(140).join("\n");
ok("default render shows graph tree and detail", dialogText.includes("GRAPH") && dialogText.includes("detail") && dialogText.includes("review"));
ok("attention badge appears on blocked node", dialogText.includes("fix !") || dialogText.includes("! fix"));
ok("focus line is visible", dialogText.includes("◀"));
ok("debug raw toggle not shown by default", !dialogText.includes("FLOW"));

const beforeFocus = dialogText;
dialog.handleInput("j");
await wait();
const afterFocus = dialog.render(140).join("\n");
ok("j moves graph selection", beforeFocus !== afterFocus);

// Enter opens message view
dialog.handleInput("\r");
await wait();
const msgView = dialog.render(140).join("\n");
ok("Enter on node opens message view", msgView.includes("Messages ·"));

// Esc from message view returns to graph
dialog.handleInput("\x1b");
await wait();
const afterEsc = dialog.render(140).join("\n");
ok("Esc from message view returns to graph", afterEsc.includes("GRAPH") && !afterEsc.includes("Messages ·"));

dialog.handleInput("\t");
await wait();
const afterTab = dialog.render(140).join("\n");
ok("Tab changes branch in branch/rework fixture", afterTab !== afterFocus);

// Attention badge only (no subtree filter).
const attentionBadge = dialog.render(140).join("\n");
ok("attention badge appears on blocked/failed nodes", attentionBadge.includes("fix !") || attentionBadge.includes("! fix"));

// Border alignment: every line of the V3 render must be exactly W wide at W=80 and W=120.
for (const W of [80, 120]) {
	const lines = dialog.render(W);
	ok(`V3 render pads every line to W=${W} (straight right border)`, lines.every((ln) => visibleWidth(ln) <= W) && lines.every((ln, i) => i === 0 ? visibleWidth(ln) >= W - 1 : visibleWidth(ln) === W));
	const treeLines = lines.filter((ln) => /◀/.test(ln));
	ok(`selected tree line spans full inner width at W=${W}`, treeLines.length === 1 && visibleWidth(treeLines[0]) === W);
}
ok("tree labels clean: no [planned]/[implemented]/(seen) jargon", !["[planned]", "[implemented]", "(seen)"].some((j) => dialog.render(140).join("\n").includes(j)));
ok("no a-filter handler in V3 footer", !/a attn|a attention/.test(dialog.render(140).join("\n")));

// Debug raw regression.
dialog.handleInput("d");
await wait();
const debugRaw = dialog.render(140).join("\n");
ok("d shows V2 debug raw legacy sections", debugRaw.includes("FLOW") && debugRaw.includes("LANES") && debugRaw.includes("EVENTS"));
dialog.handleInput("d");
await wait();

// read-only refresh hash.
dialog.handleInput("r");
await wait(50);
const afterTask = createHash("sha256").update(readFileSync(taskPaths(p, branchTaskId).taskJson)).digest("hex");
const afterState = createHash("sha256").update(readFileSync(p.state)).digest("hex");
ok("refresh is read-only over task.json", beforeTask === afterTask);
ok("refresh is read-only over swarm-state.json", beforeState === afterState);

// A second render after navigation should reflect live focus change.
dialog.handleInput("j");
await wait();
const detailUpdate = dialog.render(140).join("\n");
ok("detail panel updates live on focus changes", /fix|validate|review/.test(detailUpdate));

rmSync(scratch, { recursive: true, force: true });
if (fail) { console.error(`\nFLOW DIALOG V3 FAIL (${fail})`); process.exit(1); }
console.log("\nFLOW DIALOG V3 PASS");
