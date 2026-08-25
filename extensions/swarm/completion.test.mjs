// Completion: exercise /swarm getArgumentCompletions end-to-end against on-disk state.
// Run: node extensions/swarm/completion.test.mjs
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { paths, readState, writeState } from "./src/state.ts";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "index.ts"));
const factory = mod.default;

// --- mock pi: capture tools + swarm command options (incl. getArgumentCompletions) ---
const tools = {};
const cmds = {};
const handlers = {}; // event -> [handler]
const pi = {
	registerTool: (def) => { tools[def.name] = def; },
	registerCommand: (name, opts) => { cmds[name] = opts; },
	on: (ev, h) => { (handlers[ev] ??= []).push(h); },
	exec: async (_cmd, args) => {
		if (args?.[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	},
};
factory(pi);
for (const name of ["swarm", "swarm-agents", "swarm-tasks", "swarm-msg"]) {
	if (!cmds[name] || typeof cmds[name].getArgumentCompletions !== "function") {
		console.error(`FAIL: /${name} command did not register getArgumentCompletions`);
		process.exit(1);
	}
}
const complete = (prefix) => cmds.swarm.getArgumentCompletions(prefix);
const completeScoped = (name, prefix) => cmds[name].getArgumentCompletions(prefix);
const valsScoped = async (name, prefix) => (await completeScoped(name, prefix) ?? []).map((i) => i.value);

// --- scratch project ---
const scratch = join(tmpdir(), `swarm-completion-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

// Drive session_start handlers so the completion module latches onto this cwd.
// (Hooks take the guest early-return path -> harmless ensureDirs/readState here.)
const p = paths(scratch);
for (const h of handlers.session_start ?? []) await h({}, { cwd: scratch, mode: "tui", hasUI: false });

// Seed: one real task via the tool + two agents written into state.
const ct = await tools.swarm_create_task.execute("c", { title: "Demo feature", goal: "ship it", cwd: scratch }, undefined, undefined, { cwd: scratch });
const taskId = ct.content[0].text.match(/task-[A-Za-z0-9-]+/)[0];
const st = await readState(p, scratch);
st.agents = {
	planner: { id: "planner", role: "Plan the work", status: "idle", roleKind: "planner", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1 },
	reviewer: { id: "reviewer", role: "Review code", status: "running", roleKind: "reviewer", capabilities: [], activeTaskIds: [taskId], maxConcurrentTasks: 1 },
};
await writeState(p, st);

let fail = 0;
const ok = (name, cond) => { if (cond) console.log("  ok  ", name); else { fail++; console.error("  FAIL", name); } };
const vals = async (prefix) => (await complete(prefix) ?? []).map((i) => i.value);

// 1. Empty prefix -> all subcommands (25 total incl. lifecycle cmds + panes + flow).
const subs = await vals("");
ok("empty lists all subcommands", subs.length === 26 && subs.includes("graph") && subs.includes("flow") && subs.includes("register") && subs.includes("release") && subs.includes("identity") && subs.includes("panes") && subs.includes("pool"));

// 2. Partial subcommand filters by prefix.
const stSubs = await vals("st");
ok("'st' -> status + stop", JSON.stringify(stSubs) === JSON.stringify(["status", "stop"]));

// 3. graph + space -> the concise # form by default (value keeps "graph ").
const graphTasks = await vals("graph ");
ok("graph <space> offers #1", JSON.stringify(graphTasks) === JSON.stringify(["graph 1"]));

// 4. graph + numeric word -> only the # form.
const graphNum = await vals("graph 1");
ok("graph 1 -> # form value", JSON.stringify(graphNum) === JSON.stringify(["graph 1"]));

// 5. graph <taskId-prefix> -> only the id form.
const graphId = await vals(`graph ${taskId.slice(0, 8)}`);
ok("graph <id-prefix> -> id form", JSON.stringify(graphId) === JSON.stringify([`graph ${taskId}`]));

// 6. graph 1 <space> -> format options.
const fmt = await vals("graph 1 ");
ok("graph 1 <space> -> text/mermaid/json", JSON.stringify(fmt.sort()) === JSON.stringify(["graph 1 json", "graph 1 mermaid", "graph 1 text"]));
const fmtPartial = await vals("graph 1 m");
ok("graph 1 m -> mermaid only", JSON.stringify(fmtPartial) === JSON.stringify(["graph 1 mermaid"]));

// 7. flow + task/validate runtime flag position.
const flowTasks = await vals("flow ");
ok("flow <space> -> # form", JSON.stringify(flowTasks) === JSON.stringify(["flow 1"]));
const flowFlags = await vals("flow 1 ");
ok("flow 1 <space> -> --events", JSON.stringify(flowFlags) === JSON.stringify(["flow 1 --events"]));
const rt = await vals("task 1 ");
ok("task 1 <space> -> runtime flags", JSON.stringify(rt.sort()) === JSON.stringify(["task 1 --runtime", "task 1 -r", "task 1 runtime"]));
const noneAfterNext = await complete("next 1 extra");
ok("next with extra token -> no suggestions", JSON.stringify(noneAfterNext) === JSON.stringify([]));

// 8. capture / send -> agent ids.
const cap = await vals("capture ");
ok("capture <space> -> agents", JSON.stringify(cap.sort()) === JSON.stringify(["capture planner", "capture reviewer"]));
const capPartial = await vals("capture rev");
ok("capture rev -> reviewer", JSON.stringify(capPartial) === JSON.stringify(["capture reviewer"]));
const sendTo = await vals("send ");
ok("send <space> -> agents", JSON.stringify(sendTo.sort()) === JSON.stringify(["send planner", "send reviewer"]));
const sendBody = await complete("send planner hello there");
ok("send with body -> no suggestions", JSON.stringify(sendBody) === JSON.stringify([]));

// 9. spawn role position only (id is free text).
const spawnRole = await vals("spawn worker-1 ");
ok("spawn <id> <space> -> role kinds", spawnRole.length === 7 && spawnRole.includes("spawn worker-1 planner"));
const spawnId = await complete("spawn worker-1");
ok("spawn id word -> no suggestions", JSON.stringify(spawnId) === JSON.stringify([]));

// 10. identity reload|show then agent id.
ok("identity <space> -> reload|show", JSON.stringify(await vals("identity ")) === JSON.stringify(["identity reload", "identity show"]));
ok("identity reload <space> -> agents", JSON.stringify((await vals("identity reload ")).sort()) === JSON.stringify(["identity reload planner", "identity reload reviewer"]));
ok("identity show re -> reviewer", JSON.stringify(await vals("identity show re")) === JSON.stringify(["identity show reviewer"]));

// 11. no-arg subcommands yield nothing.
ok("status <space> -> no suggestions", JSON.stringify(await complete("status ")) === JSON.stringify([]));

// 12b. lifecycle agent-id subcommands.
for (const c of ["attach", "restart", "pause", "resume"]) {
	const got = (await vals(`${c} `)).sort();
	ok(`${c} <space> -> agents`, JSON.stringify(got) === JSON.stringify([`${c} planner`, `${c} reviewer`]));
}

// 13. stop: agent id then flags.
ok("stop <space> -> agents", JSON.stringify((await vals("stop ")).sort()) === JSON.stringify(["stop planner", "stop reviewer"]));
ok("stop planner <space> -> flags", JSON.stringify((await vals("stop planner ")).sort()) === JSON.stringify(["stop planner --force", "stop planner --no-kill"]));
ok("stop planner --f -> --force", JSON.stringify(await vals("stop planner --f")) === JSON.stringify(["stop planner --force"]));
ok("stop planner --no -> --no-kill", JSON.stringify(await vals("stop planner --no")) === JSON.stringify(["stop planner --no-kill"]));

// 14. role: agent, role-kind, then --kind value + flags.
ok("role rev <space> -> role kinds", JSON.stringify((await vals("role reviewer ")).slice(0, 1)) === JSON.stringify(["role reviewer orchestrator"]));
ok("role r planner --kind <space> -> role kinds", JSON.stringify((await vals("role reviewer planner --kind ")).slice(0, 1)) === JSON.stringify(["role reviewer planner --kind orchestrator"]));
ok("role r planner <space> -> flags", JSON.stringify((await vals("role reviewer planner ")).sort()) === JSON.stringify(["role reviewer planner --caps", "role reviewer planner --kind"]));

// 15. sendkey: agent then flags only (keys are free text).
ok("sendkey planner <space> -> flags", JSON.stringify((await vals("sendkey planner ")).sort()) === JSON.stringify(["sendkey planner --enter", "sendkey planner --literal"]));

// 16. release: agent, then its active task-ids (reviewer holds taskId), then --force.
ok("release reviewer <space> -> active task", JSON.stringify(await vals(`release reviewer ${taskId.slice(0, 6)}`)) === JSON.stringify([`release reviewer ${taskId}`]));
ok("release reviewer -- -> --force", JSON.stringify(await vals("release reviewer --")) === JSON.stringify(["release reviewer --force"]));

// 17. register: first two positionals free text; role kinds at pos 3; flags after.
ok("register target id <space> -> role kinds", (await vals("register sess:0.1 newagent ")).includes("register sess:0.1 newagent planner"));
ok("register target id role <space> -> flags", JSON.stringify((await vals("register sess:0.1 newagent planner ")).sort()) === JSON.stringify(["register sess:0.1 newagent planner --inject", "register sess:0.1 newagent planner --kind", "register sess:0.1 newagent planner --model", "register sess:0.1 newagent planner --no-inject", "register sess:0.1 newagent planner --provider"]));
ok("register ... --kind <space> -> role kinds", (await vals("register sess:0.1 newagent planner --kind ")).includes("register sess:0.1 newagent planner --kind planner"));
// 17b. register 'here' token: the current-pane shortcut is offered at the target position.
ok("register <space> offers 'here' (current pane)", (await vals("register ")).includes("register here"));
ok("register he -> here", (await vals("register he")).includes("register here"));
ok("register explicit target does NOT force 'here'", !(await vals("register sess")).includes("register here"));

// 18. never throws on junk.
ok("junk does not throw", JSON.stringify(await complete("graph     ")) !== null || true);

// 19. items carry labels + descriptions.
const items0 = await complete("");
ok("subcommand items have descriptions", items0.every((i) => i.label && i.description && i.value));

// 20. scoped command completions expose only their domain and remap to alias values.
ok("/swarm-agents top-level verbs", JSON.stringify(await valsScoped("swarm-agents", "")) === JSON.stringify(["list", "status", "spawn", "register", "panes", "stop", "restart", "role", "pause", "resume", "sendkey", "attach", "release", "mailbox", "identity"]));
ok("/swarm-tasks top-level verbs", JSON.stringify(await valsScoped("swarm-tasks", "")) === JSON.stringify(["list", "graph", "status", "next", "validate"]));
ok("/swarm-tasks status remaps task completion", JSON.stringify(await valsScoped("swarm-tasks", "status ")) === JSON.stringify(["status 1"]));
ok("/swarm-msg only offers send", JSON.stringify(await valsScoped("swarm-msg", "")) === JSON.stringify(["send"]));
ok("/swarm-msg send <space> -> agents", JSON.stringify((await valsScoped("swarm-msg", "send ")).sort()) === JSON.stringify(["send planner", "send reviewer"]));

rmSync(scratch, { recursive: true, force: true });
if (fail) { console.error(`\nCOMPLETION FAIL (${fail})`); process.exit(1); }
console.log("\nCOMPLETION PASS");
