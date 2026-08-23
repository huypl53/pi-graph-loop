// Observability: read-only `/swarm flow` snapshot coverage.
// Run: node extensions/swarm/observability.test.mjs
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { paths, readState, writeState, readTaskState, writeTaskState, taskPaths } from "./src/state.ts";
import { readRecentEvents, renderFlowSnapshot } from "./src/observability.ts";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "index.ts"));
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

const call = async (name, params) => {
	const t = tools[name];
	if (!t) throw new Error(`missing tool ${name}`);
	return t.execute("test", params, undefined, undefined, { cwd: params.cwd });
};

const scratch = join(tmpdir(), `swarm-flow-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

for (const h of handlers.session_start ?? []) await h({}, { cwd: scratch, mode: "tui", hasUI: false });

const created = await call("swarm_create_task", {
	title: "Implement Swarm Observatory flow UI",
	goal: "Render a read-only flow snapshot from task.json, swarm-state.json, and recent traces.",
	allowedFiles: ["extensions/swarm/src/observability.ts", "extensions/swarm/src/command.ts", "extensions/swarm/src/completion.ts", "extensions/swarm/observability.test.mjs", "docs/swarm/tools.md", "extensions/swarm/README.md"],
	loop: { enabled: true, proposalAgents: [] },
	cwd: scratch,
});
const taskId = created.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];
const p = paths(scratch);
const tp = taskPaths(p, taskId);

const task = await readTaskState(tp.taskJson);
const eventBase = Date.now() + 60_000;
const isoAt = (delta) => new Date(eventBase + delta).toISOString();
const taskTs = isoAt(0);
const plan = task.nodes.plan;
plan.status = "done";
plan.assignee = "planner-01";
plan.outcome = "planned";
const implement = task.nodes.implement;
implement.status = "assigned";
implement.assignee = "obs-implementer";
implement.lastActivityAt = taskTs;
implement.messageIds = implement.messageIds || [];
const review = task.nodes.review;
review.status = "pending";
review.dependsOn = review.dependsOn || ["implement"];
task.status = "in_progress";
task.currentNodes = ["implement"];
await writeTaskState(tp, task);

const st = await readState(p, scratch);
st.agents = {
	"planner-01": {
		id: "planner-01",
		role: "Planner lane",
		roleKind: "planner",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status: "idle",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxSession: "swarm-flow",
		tmuxWindow: "0",
		tmuxTarget: "swarm-flow:0.0",
		model: "gpt-5.4-mini",
		provider: "openai",
		cwd: scratch,
		mailbox: ".pi/swarm/mailboxes/planner-01.jsonl",
		createdAt: taskTs,
		updatedAt: taskTs,
	},
	"obs-implementer": {
		id: "obs-implementer",
		role: "Implement observability",
		roleKind: "implementer",
		capabilities: [],
		activeTaskIds: [taskId],
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus: "tool_running",
		health: "healthy",
		tmuxSession: "swarm-flow",
		tmuxWindow: "1",
		tmuxTarget: "swarm-flow:0.1",
		model: "gpt-5.4-mini",
		provider: "openai",
		cwd: scratch,
		mailbox: ".pi/swarm/mailboxes/obs-implementer.jsonl",
		createdAt: taskTs,
		updatedAt: taskTs,
	},
	"reviewer-01": {
		id: "reviewer-01",
		role: "Review output",
		roleKind: "reviewer",
		capabilities: [],
		activeTaskIds: [],
		maxConcurrentTasks: 1,
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		tmuxSession: "swarm-flow",
		tmuxWindow: "2",
		tmuxTarget: "swarm-flow:0.2",
		model: "glm-5.1",
		provider: "zai-coding-cn",
		cwd: scratch,
		mailbox: ".pi/swarm/mailboxes/reviewer-01.jsonl",
		createdAt: taskTs,
		updatedAt: taskTs,
	},
};
await writeState(p, st);

const swarmEvents = [
	{ ts: isoAt(1000), event: "swarm.init", by: "orchestrator" },
	{ ts: isoAt(3000), event: "swarm.status", by: "orchestrator", count: 3 },
];
const taskEvents = [
	{ ts: isoAt(2000), event: "task.create", taskId, by: "engine" },
	{ ts: isoAt(4000), event: "task.assign", taskId, nodeId: "implement", assignee: "obs-implementer" },
];
appendFileSync(p.events, `${swarmEvents.map((rec) => JSON.stringify(rec)).join("\n")}\n`);
appendFileSync(tp.events, `not json\n${taskEvents.map((rec) => JSON.stringify(rec)).join("\n")}\n`);

const beforeState = createHash("sha256").update(readFileSync(tp.taskJson)).digest("hex");
const beforeSwarm = createHash("sha256").update(readFileSync(p.state)).digest("hex");

let fail = 0;
const ok = (name, cond) => { if (cond) console.log("  ok  ", name); else { fail++; console.error("  FAIL", name); } };
const notes = [];
const ctx = { cwd: scratch, hasUI: true, ui: { notify: (msg, level) => notes.push({ msg, level }), setStatus: () => {} } };

const recent = await readRecentEvents(p, tp, 3);
ok("readRecentEvents tails + merges + ignores malformed line", recent.length === 3 && recent[0].text.includes("task.create") && recent[1].text.includes("swarm.status") && recent[2].text.includes("task.assign"));

const snapshot = renderFlowSnapshot(task, ["implement"], ["plan", "implement"], st.agents, recent, { index: 1, open: 2, stale: 1, loopLine: "not_started", eventLimit: 3 });
ok("renderFlowSnapshot header", snapshot.includes(`Flow #1 ${taskId} — Implement Swarm Observatory flow UI [in_progress] open=2 stale=1`));
ok("renderFlowSnapshot nodes", snapshot.includes("Nodes:") && snapshot.includes("plan") && snapshot.includes("implement") && snapshot.includes("review"));
ok("renderFlowSnapshot lanes", snapshot.includes("Agents (lanes):") && snapshot.includes("obs-implementer") && snapshot.includes(`active: ${taskId}#implement`));
ok("renderFlowSnapshot events block", snapshot.includes("Events (last 3):") && snapshot.includes("task.assign") && snapshot.includes("Loop: not_started"));

await cmds.swarm.handler("flow", ctx);
ok("no-arg flow shows usage", /Usage: \/swarm flow <#\|task-id> \[--events N\]/.test(notes.at(-1)?.msg || ""));

await cmds.swarm.handler(`flow 1 --events 1`, ctx);
const flowOut = notes.at(-1)?.msg || "";
ok("flow command renders snapshot", flowOut.includes(`Flow #1 ${taskId}`) && flowOut.includes("Agents (lanes):") && flowOut.includes("Events (last 1):"));
{
	const eventBlock = (flowOut.split("Events (last 1):")[1] || "").split("\n\n#")[0];
	ok("flow command limits events", eventBlock.split(/\n/).filter((l) => /^\s{2}/.test(l)).length === 1);
}
ok("flow command writes trace artifact", readFileSync(join(p.traces, "graphs", `${taskId}.flow.txt`), "utf8").includes(`Flow #1 ${taskId}`));

await cmds.swarm.handler(`flow nope`, ctx);
ok("unknown flow id warns with task list", /no task matches|Ambiguous/.test(notes.at(-1)?.msg || "") && /pick by #|No tasks found/.test(notes.at(-1)?.msg || ""));

const afterState = createHash("sha256").update(readFileSync(tp.taskJson)).digest("hex");
const afterSwarm = createHash("sha256").update(readFileSync(p.state)).digest("hex");
ok("flow command leaves task.json unchanged", beforeState === afterState);
ok("flow command leaves swarm-state.json unchanged", beforeSwarm === afterSwarm);

const completions = cmds.swarm.getArgumentCompletions;
ok("flow appears in top-level completions", (await completions("")).some((item) => item.value === "flow"));
ok("flow <space> offers task indices", (await completions("flow ")).some((item) => item.value === "flow 1"));
ok("flow 1 <space> offers --events", JSON.stringify((await completions("flow 1 ")).map((i) => i.value)) === JSON.stringify(["flow 1 --events"]));

rmSync(scratch, { recursive: true, force: true });
if (fail) { console.error(`\nFLOW OBSERVABILITY FAIL (${fail})`); process.exit(1); }
console.log("\nFLOW OBSERVABILITY PASS");
