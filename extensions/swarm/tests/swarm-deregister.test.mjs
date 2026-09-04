// /swarm deregister — self-service de-registration of a pi session from its swarm role.
// Inverse of `/swarm register here <id> [role]`: detaches THIS pane's session (or, for the
// PM, any pane's session) from its swarm role without killing the pane, marks the agent
// record stopped, un-adopts the in-process identity (PI_SWARM_AGENT_ID -> guest), and
// re-applies guest tool gating so the swarm tool surface disappears on the next prompt.
//
// Cases (red before implementation):
//   1. 'here' resolves to the current agent id; guest 'here' is refused with guidance.
//   1c. The root (PM) role cannot be de-registered from inside a session.
//   2. Self-service: a worker may deregister ITSELF (here or explicit own id); another
//      agent id requires root.
//   3. Active tasks refuse without --force (delegate: stopAgent guard).
//   4. Default keeps the pane alive (killPane=false), marks stopped, keeps record + mailbox.
//   5. --purge removes the agent record + delivered ledger (mailbox/identity files stay).
//   6. In-process un-adopt: PI_SWARM_AGENT_ID cleared, gating re-applied, status line reset.
//   7. Trace artifact agent.deregister is written; unknown id errors cleanly.
//   8. Usage help on missing/wrong args.
//
// Run: node extensions/swarm/tests/swarm-deregister.test.mjs
import { rmSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

const cmds = {};
const tools = {};
const activeToolSet = { active: ["read", "swarm_send_message", "swarm_task_status", "bash"] };
const pi = {
	registerTool: (def) => { tools[def.name] = def; },
	registerCommand: (name, opts) => { cmds[name] = opts; },
	on: () => {},
	exec: async () => ({ code: 0, stdout: "%1\n", stderr: "" }), // tmux stub: panes resolve, nothing fails
	getActiveTools: () => [...activeToolSet.active],
	setActiveTools: (next) => { activeToolSet.active = [...next]; },
	getAllTools: () => Object.values(tools), // gating enumerates registered tools via getAllTools
};
factory(pi);
if (typeof cmds.swarm?.handler !== "function") { console.error("FAIL: /swarm command not registered"); process.exit(1); }

const scratch = join(tmpdir(), `swarm-deregister-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

// Import state helpers via the same module graph the factory uses.
const { paths, readState, writeState } = await import(join(here, "..", "src", "state.ts"));

const notes = [];
const statusSet = [];
const ctx = {
	cwd: scratch,
	hasUI: true,
	ui: {
		notify: (msg, level) => notes.push({ msg, level }),
		setStatus: (_key, value) => statusSet.push(value),
	},
};

let fail = 0;
const ok = (name, cond) => { if (cond) console.log("  ok  ", name); else { fail++; console.error("  FAIL", name); } };
const lastNote = () => notes.at(-1)?.msg || "";
const lastLevel = () => notes.at(-1)?.level || "";
const traceEvents = (p) => readdirSync(p.traces).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(p.traces, f), "utf8").split(/\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
const { SWARM_GUEST_ID } = await import(join(here, "..", "src", "constants.ts"));

// Seed swarm state with one idle worker and one busy worker.
const p = paths(scratch);
await cmds.swarm.handler("init", ctx);
{
	const st = await readState(p, scratch);
	st.agents["worker-01"] = { id: "worker-01", role: "Implement things", status: "running", roleKind: "implementer", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1, tmuxTarget: "sess:0.1", createdAt: new Date().toISOString() };
	st.agents["worker-02"] = { id: "worker-02", role: "Review things", status: "running", roleKind: "reviewer", capabilities: [], activeTaskIds: ["task-x"], maxConcurrentTasks: 1, tmuxTarget: "sess:0.2", createdAt: new Date().toISOString() };
	st.delivered["worker-01"] = [{ id: "msg-1" }]; // seed a delivered ledger entry so the keep-vs-purge assertion is non-vacuous
	await writeState(p, st);
}
const mailboxFile = join(p.mailboxes, "worker-01.jsonl");
mkdirSync(p.mailboxes, { recursive: true });

// --- Case 8 first: usage help on bad invocations (no implementation dependency) ---
await cmds.swarm.handler("deregister", ctx);
ok("no arg -> usage warning", /\/swarm deregister here/.test(lastNote()) && /--force/.test(lastNote()) && /--purge/.test(lastNote()) && lastLevel() === "warning");
await cmds.swarm.handler("deregister --purge", ctx);
ok("flags without id -> usage warning", /\/swarm deregister here/.test(lastNote()) && /--force/.test(lastNote()) && /--purge/.test(lastNote()));

// --- Case 1b: guest 'here' is refused with guidance ---
const prevAgent = process.env.PI_SWARM_AGENT_ID;
const prevRoot = process.env.PI_SWARM_IS_ROOT;
process.env.PI_SWARM_AGENT_ID = "";
process.env.PI_SWARM_IS_ROOT = "";
await cmds.swarm.handler("deregister here", ctx);
ok("guest 'here' refused with register hint", /register this pane first/i.test(lastNote()) && lastLevel() === "warning");

// --- Case 1c: the root (PM) role cannot be de-registered from inside a session ---
process.env.PI_SWARM_AGENT_ID = "";
process.env.PI_SWARM_IS_ROOT = "1";
await cmds.swarm.handler("deregister here", ctx);
ok("root 'here' refused with guidance", /root \(PM\) role cannot be de-registered/i.test(lastNote()) && lastLevel() === "warning");
await cmds.swarm.handler("deregister root", ctx);
ok("explicit 'root' id refused too", /root \(PM\) role cannot be de-registered/i.test(lastNote()));

// --- Case 2b: non-root session cannot deregister ANOTHER agent ---
process.env.PI_SWARM_AGENT_ID = "worker-01";
process.env.PI_SWARM_IS_ROOT = "";
await cmds.swarm.handler("deregister worker-02", ctx);
ok("worker deregistering another agent -> root-only refusal", /root-only/.test(lastNote()) && lastLevel() === "warning");
{
	const st = await readState(p, scratch);
	ok("refused deregister leaves state untouched", st.agents["worker-02"]?.status === "running");
}

// --- Case 3: active tasks refuse without --force ---
await cmds.swarm.handler("deregister worker-02", ctx); // still self? no: worker-01 != worker-02 -> already refused above. Switch to root for the task-guard case.
process.env.PI_SWARM_AGENT_ID = "";
process.env.PI_SWARM_IS_ROOT = "1";
await cmds.swarm.handler("deregister worker-02", ctx);
ok("active task refuses without --force", /active tasks/i.test(lastNote()) && lastLevel() === "error");
{
	const st = await readState(p, scratch);
	ok("refused stop leaves agent running", st.agents["worker-02"]?.status === "running");
}

// --- Case 7b: unknown id errors cleanly ---
await cmds.swarm.handler("deregister nobody", ctx);
ok("unknown id -> clean error", /Unknown swarm agent: nobody/.test(lastNote()) && lastLevel() === "error");

// --- Case 4+6: self-service 'here' happy path (worker-01, no active tasks) ---
process.env.PI_SWARM_AGENT_ID = "worker-01";
process.env.PI_SWARM_IS_ROOT = "";
activeToolSet.active = ["read", "swarm_send_message", "swarm_task_status", "bash"];
await cmds.swarm.handler("deregister here", ctx);
ok("self 'here' succeeds with info notice", /Deregistered worker-01/.test(lastNote()) && lastLevel() === "info", lastNote());
ok("notice mentions pane kept alive", /pane kept alive/i.test(lastNote()));
ok("status line reset to guest", statusSet.at(-1) === `swarm:${SWARM_GUEST_ID}`);
ok("in-process identity un-adopted (env cleared)", !process.env.PI_SWARM_AGENT_ID);
ok("guest gating removed swarm tools", !activeToolSet.active.some((n) => n.startsWith("swarm_")));
ok("non-swarm tools untouched by gating", activeToolSet.active.includes("read") && activeToolSet.active.includes("bash"));
{
	const st = await readState(p, scratch);
	const a = st.agents["worker-01"];
	ok("agent record kept and marked stopped", a && a.status === "stopped");
	ok("mailbox file untouched (non-destructive)", !existsSync(mailboxFile) || readFileSync(mailboxFile, "utf8") === "");
	ok("delivered ledger still present", Array.isArray(st.delivered["worker-01"]) && st.delivered["worker-01"].length === 1);
}
ok("trace agent.deregister written", traceEvents(p).some((e) => e.event === "agent.deregister" && e.agentId === "worker-01"));

// --- Case 2a/5: root may deregister another agent by id; --purge removes the record ---
process.env.PI_SWARM_AGENT_ID = "";
process.env.PI_SWARM_IS_ROOT = "1";
await cmds.swarm.handler("deregister worker-02 --force --purge", ctx);
ok("root deregisters other agent with --force --purge", /Deregistered worker-02/.test(lastNote()) && /purged/i.test(lastNote()));
{
	const st = await readState(p, scratch);
	ok("purge removed agent record", !st.agents["worker-02"]);
	ok("purge removed delivered ledger", !st.delivered["worker-02"]);
}

// --- Self deregister with explicit own id (equivalent to 'here') ---
{
	const st = await readState(p, scratch);
	st.agents["worker-03"] = { id: "worker-03", role: "Probe role", status: "running", roleKind: "worker", capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1, tmuxTarget: "sess:0.3", createdAt: new Date().toISOString() };
	await writeState(p, st);
}
process.env.PI_SWARM_AGENT_ID = "worker-03";
process.env.PI_SWARM_IS_ROOT = "";
await cmds.swarm.handler("deregister worker-03", ctx);
ok("explicit own id treated as self-service", /Deregistered worker-03/.test(lastNote()) && lastLevel() === "info");
{
	const st = await readState(p, scratch);
	ok("explicit own id marks stopped", st.agents["worker-03"]?.status === "stopped");
}

// restore env
process.env.PI_SWARM_AGENT_ID = prevAgent;
process.env.PI_SWARM_IS_ROOT = prevRoot;

rmSync(scratch, { recursive: true, force: true });
if (fail) { console.error(`\nDEREGISTER FAIL (${fail})`); process.exit(1); }
console.log("\nDEREGISTER PASS");
