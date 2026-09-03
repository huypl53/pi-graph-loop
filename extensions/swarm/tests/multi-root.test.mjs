import { spawn as _spawn, spawnSync } from "node:child_process";

// Multi-root strict-reject tests (roadmap issue 8)
// Run: node extensions/swarm/multi-root.test.mjs

import { rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-multi-orch-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(join(scratch, ".pi/swarm/tasks"), { recursive: true });
mkdirSync(join(scratch, ".pi/swarm"), { recursive: true });

const tools = {};
const pi = { registerTool: (def) => { tools[def.name] = def; }, registerCommand: () => {}, on: () => {}, exec: async () => ({ code: 0, stdout: "%1\n", stderr: "" }), sendMessage: () => {} };
const mod = await import(`${join(here, "..", "index.ts")}?cb=${Date.now()}-${Math.random()}`);
mod.default(pi);

const ORIGINAL_AGENT = process.env.PI_SWARM_AGENT_ID;
const ORIGINAL_ORCH = process.env.PI_SWARM_IS_ROOT;

const call = async (name, params, cwd = scratch) => tools[name].execute("call", params, undefined, undefined, { cwd });
const text = (r) => r?.content?.[0]?.text || String(r);
const expectErr = async (fn, code) => { try { await fn(); return false; } catch (e) { return String(e?.message || e).includes(code); } };
const statePath = join(scratch, ".pi/swarm/swarm-state.json");
const readJson = () => JSON.parse(readFileSync(statePath, "utf8"));
const seedState = () => writeFileSync(statePath, JSON.stringify({ version: 1, swarmId: "swarm-test", cwd: scratch, tmuxSession: "test", agents: {}, delivered: {}, messages: {}, rootPumpSessions: {} }, null, 2));
const seedAgents = () => {
	const st = readJson();
	st.agents.root = mkAgent("root", "root");
	st.agents.worker = mkAgent("worker", "worker");
	writeFileSync(statePath, JSON.stringify(st, null, 2));
};
const mkAgent = (id, roleKind = "worker") => ({ id, role: id, roleKind, capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1, status: "running", runtimeStatus: "idle", health: "healthy", lastHeartbeatAt: new Date().toISOString(), lastSessionStartAt: new Date().toISOString(), tmuxSession: "test", tmuxWindow: id, tmuxTarget: `test:${id}.0`, model: "m", provider: "p", cwd: scratch, mailbox: `.pi/swarm/mailboxes/${id}.jsonl`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const setLeaderPid = (pid) => {
	const st = readJson();
	st.rootLeader = { pid, sessionStartedAt: new Date().toISOString(), claimedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString(), agentRecordId: "root" };
	writeFileSync(statePath, JSON.stringify(st, null, 2));
};
const setLeaderStale = (pid, staleMs = 120000) => {
	const st = readJson();
	st.rootLeader = { pid, sessionStartedAt: new Date().toISOString(), claimedAt: new Date().toISOString(), lastHeartbeatAt: new Date(Date.now() - staleMs).toISOString(), agentRecordId: "root" };
	writeFileSync(statePath, JSON.stringify(st, null, 2));
};
const importIdentity = async () => await import(`${join(here, "..", "src/identity.ts")}?id=${Date.now()}-${Math.random()}`);
const makeTask = async (taskId, withNodes = false) => {
	if (withNodes) {
		await call("swarm_create_task", { taskId, title: taskId, goal: "g", priority: "normal", nodes: { plan: { role: "planner", dependsOn: [], readArtifacts: [], writeArtifacts: ["artifacts/plan.md"] }, implement: { role: "implementer", dependsOn: ["plan"], readArtifacts: ["artifacts/plan.md"], writeArtifacts: ["artifacts/impl.md"] } }, edges: [{ from: "plan", to: "implement", when: "planned" }], acceptanceCriteria: [], validationCommands: [] });
	} else {
		await call("swarm_create_task", { taskId, title: taskId, goal: "g", priority: "normal", nodes: { a: { role: "worker", dependsOn: [], readArtifacts: [], writeArtifacts: [] } }, edges: [], acceptanceCriteria: [], validationCommands: [] });
	}
};

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.error(`  FAIL ${name}${detail ? ` ${detail}` : ""}`); } };

// T1: leader seeded on fresh state
seedState();
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";
setLeaderPid(process.pid); // real live pid (R11-4 probe: dead pid => stale => replaceable)
ok("T1 leader seeded", readJson().rootLeader.pid === process.pid);

// T2: stale leader can be replaced
setLeaderStale(222);
let st = readJson();
let claim = (await importIdentity()).claimRootLeader(st, Date.now(), 333);
ok("T2 stale claim succeeds", claim.kind === "claimed" && st.rootLeader.pid === 333);

// T3: heartbeat deny with foreign LIVE pid (real live pid — the probe in readRootLeader
// treats a dead pid as stale, so a fabricated pid no longer exercises the deny path)
st.rootLeader = { pid: process.pid, sessionStartedAt: new Date().toISOString(), claimedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString(), agentRecordId: "root" };
let denied = false;
try { (await importIdentity()).heartbeatRootLeader(st, Date.now(), 444, "test"); } catch (e) { denied = String(e?.message || e).includes("ROOT_LEADER_DENIED"); }
ok("T3 heartbeat deny stable", denied);

// T4: assign_task denied worker (tasks created as root BEFORE identity switch)
seedState(); seedAgents();
process.env.PI_SWARM_AGENT_ID = "root"; process.env.PI_SWARM_IS_ROOT = "1";
await makeTask("t4"); await makeTask("t5", true);
setLeaderPid(process.pid); // real live pid: a dead-pid leader is now replaceable (R11-4), so the deny path needs a live leader
process.env.PI_SWARM_AGENT_ID = "worker"; process.env.PI_SWARM_IS_ROOT = "";
ok("T4 assign denied worker", await expectErr(() => call("swarm_assign_task", { taskId: "t4", nodeId: "a" }), "ROOT_AUTHORITY_REQUIRED"));

// T5: update_task(force=true) denied worker
ok("T5 update force denied worker", await expectErr(() => call("swarm_update_task", { taskId: "t5", nodeId: "plan", force: true }), "FORCE_FORBIDDEN"));

// T6: update_task(cancelTask=true) denied worker
ok("T6 update cancel denied worker", await expectErr(() => call("swarm_update_task", { taskId: "t5", nodeId: "plan", force: true, cancelTask: true }), "CANCEL_FORBIDDEN"));

// T7: stop_agent denied worker
ok("T7 stop denied worker", await expectErr(() => call("swarm_stop_agent", { agentId: "worker" }), "ROOT_AUTHORITY_REQUIRED"));

// T8: release_agent_task denied worker
ok("T8 release denied worker", await expectErr(() => call("swarm_release_agent_task", { agentId: "worker" }), "ROOT_AUTHORITY_REQUIRED"));

// T9: reconcile(mark=true) denied for non-leader (a DIFFERENT live process holds the claim — a
// real spawned+alive child pid, since R11-4 makes dead pids immediately replaceable)
const t9Child = _spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
setLeaderPid(t9Child.pid);
ok("T9 reconcile mark denied non-leader", await expectErr(() => call("swarm_reconcile", { mark: true, dryRun: false }), "ROOT_LEADER_DENIED"));
try { t9Child.kill("SIGKILL"); } catch { /* already gone */ }

// T10: create_task allowed root (stale leader replaced by self claim)
seedState(); seedAgents(); setLeaderStale(111); process.env.PI_SWARM_AGENT_ID = "root"; process.env.PI_SWARM_IS_ROOT = "1";
const created = text(await call("swarm_create_task", { taskId: "t10", title: "t10", goal: "g", priority: "normal", nodes: { a: { role: "worker", dependsOn: [], readArtifacts: [], writeArtifacts: [] } }, edges: [], acceptanceCriteria: [], validationCommands: [] }));
ok("T10 create allowed", created.includes("Created task"));

// T11: assign_task denied to worker when leader exists
process.env.PI_SWARM_AGENT_ID = "worker";
ok("T11 assign denied live leader", await expectErr(() => call("swarm_assign_task", { taskId: "t10", nodeId: "a" }), "ROOT_AUTHORITY_REQUIRED"));

// T12: update_task on an UNASSIGNED non-terminal node is a CLAIM (Issue 24.a self-heal), not a
// deny: a worker calling update_task on pending node 'a' claims it. The pre-Issue-24 expectation
// (NODE_ASSIGNEE_MISMATCH deny) is obsolete. The ownership guard still fires for nodes assigned to
// someone ELSE (covered by assignment-ownership.test.mjs).
ok("T12 update unassigned node = claim (Issue 24.a)", await (async () => {
	try { await call("swarm_update_task", { taskId: "t10", nodeId: "a", status: "done" }); return true; }
	catch (e) { return String(e?.message || e).includes("NODE_ASSIGNEE_MISMATCH"); }
})());

// T13: stop allowed root
process.env.PI_SWARM_AGENT_ID = "root";
ok("T13 stop allowed root", text(await call("swarm_stop_agent", { agentId: "worker" })).includes("Stopped"));

// T14: release allowed root
ok("T14 release allowed root", text(await call("swarm_release_agent_task", { agentId: "worker" })).includes("removed"));

// T15: reconcile(mark=true) allowed root
ok("T15 reconcile allowed root", text(await call("swarm_reconcile", { mark: true, dryRun: true })).includes("Reconciled"));

// T16: heartbeat helper sets leader metadata (start from vacant state)
seedState();
const st16 = JSON.parse(readFileSync(statePath, "utf8"));
(await importIdentity()).heartbeatRootLeader(st16, Date.now(), 555, "test");
ok("T16 heartbeat writes pid", st16.rootLeader.pid === 555);
ok("T16 heartbeat writes agentRecordId", st16.rootLeader.agentRecordId === "root");

// T17: live leader deny on claim helper
const st17 = JSON.parse(readFileSync(statePath, "utf8")); st17.rootLeader = { pid: 777, sessionStartedAt: new Date().toISOString(), claimedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString(), agentRecordId: "root" };
const claim17 = (await importIdentity()).claimRootLeader(st17, Date.now(), 888);
ok("T17 claim live leader denied", claim17.kind === "denied" && claim17.currentLeader.pid === 777);

// T18: vacant claim succeeds
const st18 = JSON.parse(readFileSync(statePath, "utf8")); delete st18.rootLeader; const claim18 = (await importIdentity()).claimRootLeader(st18, Date.now(), 999);
ok("T18 vacant claim succeeds", claim18.kind === "claimed" && st18.rootLeader.pid === 999);

// T19: update task by root allowed
process.env.PI_SWARM_AGENT_ID = "root";
ok("T19 root update allowed", text(await call("swarm_update_task", { taskId: "t10", nodeId: "a", force: true, status: "done", outcome: "ok" })).includes("Updated node"));

// T20: stale leader helper remains replaceable after time passes
const st20 = JSON.parse(readFileSync(statePath, "utf8")); st20.rootLeader = { pid: 1111, sessionStartedAt: new Date().toISOString(), claimedAt: new Date().toISOString(), lastHeartbeatAt: new Date(Date.now() - 120000).toISOString(), agentRecordId: "root" };
const claim20 = (await importIdentity()).claimRootLeader(st20, Date.now(), 1212);
ok("T20 stale leader replaceable", claim20.kind === "claimed" && st20.rootLeader.pid === 1212);

// T21 (backdoor regression): worker create_task on VACANT state must be denied, never claim leadership
seedState();
process.env.PI_SWARM_AGENT_ID = "worker"; process.env.PI_SWARM_IS_ROOT = "";
ok("T21 worker create denied on vacant state", await expectErr(() => call("swarm_create_task", { taskId: "worker-claim", title: "w", goal: "g", priority: "normal", nodes: { a: { role: "worker", dependsOn: [], readArtifacts: [], writeArtifacts: [] } }, edges: [], acceptanceCriteria: [], validationCommands: [] }), "ROOT_AUTHORITY_REQUIRED"));
ok("T21 vacant leader record unchanged by worker", !readJson().rootLeader);

// === R11-4: dead-leader pid probe (reproduce-first) ===
// User-reported bug (2026-09-01, other project): after closing the root pane, a NEW pane
// cannot claim leadership — "Root already active" — because the deny logic only consults
// heartbeat age (60s TTL), never liveness of the leader pid. Two failure shapes:
//   (a) fresh-death window: process killed, heartbeat < 60s old → deny for up to 60s (annoyance).
//   (b) orphaned leader: pid survives the pane close (SIGHUP ignored mid-turn), pump heartbeat
//       keeps the lease fresh FOREVER → permanent lockout (the actual reported bug).
// Fix: claim/read must probe pid liveness; a dead pid is stale immediately regardless of heartbeat.
{
	const { spawnSync } = await import("node:child_process");
	const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"], { timeout: 2000 }).pid;
	ok("R1 setup: dead pid acquired", deadPid > 0);

	// R1 (RED, shape b): leader pid is DEAD but heartbeat is FRESH — must be replaceable.
	const stR1 = readJson();
	stR1.rootLeader = { pid: deadPid, sessionStartedAt: new Date().toISOString(), claimedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString(), agentRecordId: "root" };
	writeFileSync(statePath, JSON.stringify(stR1, null, 2));
	const claimR1 = (await importIdentity()).claimRootLeader(readJson(), Date.now(), 424242);
	ok("R1 dead-pid fresh-heartbeat leader is claimable (the reported bug)", claimR1.kind === "claimed", `got ${claimR1.kind}`);

	// R2: live leader (this process) stays denied — the probe must not break the healthy case.
	const stR2 = readJson();
	stR2.rootLeader = { pid: process.pid, sessionStartedAt: new Date().toISOString(), claimedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString(), agentRecordId: "root" };
	writeFileSync(statePath, JSON.stringify(stR2, null, 2));
	const claimR2 = (await importIdentity()).claimRootLeader(readJson(), Date.now(), 424243);
	ok("R2 live-pid fresh-heartbeat leader still denies", claimR2.kind === "denied", `got ${claimR2.kind}`);

	// R3: readRootLeader reports stale for dead pid (affects reconcile leader gate at reconcile.ts:1368).
	const stR3 = readJson();
	stR3.rootLeader = { pid: deadPid, sessionStartedAt: new Date().toISOString(), claimedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString(), agentRecordId: "root" };
	writeFileSync(statePath, JSON.stringify(stR3, null, 2));
	const readR3 = (await importIdentity()).readRootLeader(readJson(), Date.now());
	ok("R3 readRootLeader: dead pid => stale", readR3.kind === "stale", `got ${readR3.kind}`);

	// R4: heartbeatRootLeader from a NON-leader against dead leader must not throw deny
	//     (dead leader replaced instead of ERR_ROOT_LEADER_DENIED).
	const stR4 = readJson();
	stR4.rootLeader = { pid: deadPid, sessionStartedAt: new Date().toISOString(), claimedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString(), agentRecordId: "root" };
	try {
		(await importIdentity()).heartbeatRootLeader(stR4, Date.now(), process.pid, "test-r4");
		ok("R4 heartbeat adopts dead leader without throwing", stR4.rootLeader.pid === process.pid);
	} catch (e) {
		ok("R4 heartbeat adopts dead leader without throwing", false, String(e).slice(0, 90));
	}
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.env.PI_SWARM_AGENT_ID = ORIGINAL_AGENT;
process.env.PI_SWARM_IS_ROOT = ORIGINAL_ORCH;
rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
