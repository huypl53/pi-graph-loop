// Regression test for Issue 14: orphan-spawn engine warning.
//
// The engine emits an `agent.spawn.orphan_warning` trace event when swarm_spawn_agent mints a new
// agent record but no follow-up delivery (swarm_send_message, swarm_assign_task which sends
// internally, or swarm_stop_agent) occurs within ORPHAN_SPAWN_WARNING_TIMEOUT_MS. The warning is
// emitted via the existing trace event system — no new public tool. The test exercises all six
// required cases by driving the real cores (spawnAgent, enqueueAndDeliver, stopAgent, restartAgent)
// against a temp swarm dir; the watchdog timer is configured to ~50ms via PI_SWARM_ORPHAN_TIMEOUT_MS
// (set BEFORE importing constants — env var read happens at module load).
//
// Run: PI_SWARM_ORPHAN_TIMEOUT_MS=50 node extensions/swarm/spawn-orphan-warning.test.mjs
import { rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Force the env var so the constants module picks it up on import. Setting it here (before import)
// is critical — Number(process.env.PI_SWARM_ORPHAN_TIMEOUT_MS) is evaluated at module load time.
process.env.PI_SWARM_ORPHAN_TIMEOUT_MS = "50";

// Direct imports of the cores + types we exercise. Real handlers, real lock, real state.
const { spawnAgent, stopAgent, restartAgent, fireOrphanWarning, armOrphanWatch, clearOrphanWatch, recentSpawnCount, isSameRootLeader } = await import(join(here, "..", "src", "agents.ts"));
const { enqueueAndDeliver } = await import(join(here, "..", "src", "mailbox.ts"));
const { paths, withLock, readState, writeState } = await import(join(here, "..", "src", "state.ts"));

// Mock pi: never makes real tmux calls. Most subcommands no-op success; capture-pane returns
// empty (so the "You are <id>" identity reload message is the only thing sent into the fake pane).
const sentKeys = [];
const pi = {
	exec: async (cmd, args) => {
		if (cmd !== "tmux") {
			if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
			return { code: 1, stdout: "", stderr: "" };
		}
		const sub = args[0];
		// display-message is overloaded: format arg "-p #{pane_id}" => pane id; "#{pane_current_command}" => command.
		if (sub === "display-message") {
			const fmt = args.includes("-p") ? args[args.length - 1] : "";
			if (fmt === "#{pane_current_command}") return { code: 0, stdout: "node\n", stderr: "" };
			return { code: 0, stdout: "%99\n", stderr: "" };
		}
		if (sub === "capture-pane") return { code: 0, stdout: "", stderr: "" };            // empty pane probe
		if (sub === "send-keys") { sentKeys.push(args.slice(1).join(" ")); return { code: 0, stdout: "", stderr: "" }; }
		if (sub === "kill-window" || sub === "kill-pane") return { code: 0, stdout: "", stderr: "" };
		if (sub === "has-session") return { code: 0, stdout: "", stderr: "" };
		if (sub === "new-window" || sub === "new-session") return { code: 0, stdout: "", stderr: "" };
		if (sub === "list-panes") return { code: 0, stdout: "0\n", stderr: "" };           // for pane-current-command probes
		if (sub === "list-windows") return { code: 0, stdout: "", stderr: "" };
		return { code: 1, stdout: "", stderr: "unknown tmux subcommand: " + sub };
	},
	registerTool: () => {}, registerCommand: () => {}, on: () => {}, sendMessage: () => {},
};

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("  ok  ", n); } else { fail++; console.error("  FAIL", n); } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Generous margin over ORPHAN_SPAWN_WARNING_TIMEOUT_MS (50ms) so the test never flakes on slow CI.
const TIMER_MARGIN_MS = 250;

const readEvents = (p) => {
	const file = join(p, ".pi", "swarm", "traces", "events.jsonl");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => {
		try { return JSON.parse(l); } catch { return {}; }
	});
};
const eventNames = (events, name) => events.filter((e) => e?.event === name);

// Set up a fresh scratch dir + swarm state for each test case so they cannot interact.
const freshScratch = (label) => {
	const root = join(tmpdir(), `swarm-orphan-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	return root;
};

// Direct helper: inject a pre-existing message record into state.messages without going through the
// delivery path. Used by the race-backstop case to simulate "a message already exists at fire time".
const seedInboundMessage = async (cwd, p, toAgentId, fromAgentId = "root") => {
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		const id = `msg-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		st.messages[id] = {
			id,
			from: fromAgentId,
			to: toAgentId,
			status: "injected",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			injectedAt: new Date().toISOString(),
			attempts: 1,
			requiresAck: true,
			requiresResponse: false,
			response: { status: "not_required" },
		};
		await writeState(p, st);
	});
};

console.log("\n[1] Happy path: spawn then send within window -> cleared, NO orphan_warning");
{
	const cwd = freshScratch("happy");
	const p = paths(cwd);
	const { msg } = await withLock(p, async () => {
		const st = await readState(p, cwd);
		// Pre-seed the root pseudo-agent (enqueueAndDeliver keys `from = currentAgentId()`).
		st.agents["root"] ||= {
			id: "root", role: "PM", roleKind: "root", roleKindExplicit: true,
			capabilities: [], activeTaskIds: [], maxConcurrentTasks: 99, status: "running", runtimeStatus: "idle",
			health: "healthy", tmuxSession: "x", tmuxWindow: "unknown", tmuxTarget: "unknown", model: "m", provider: "p",
			cwd, mailbox: "x", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		};
		const r = await spawnAgent(pi, cwd, p, st, { id: "happy-1", role: "Worker", initialPrompt: "go" });
		await writeState(p, st);
		return { msg: null };
	});
	// Confirm the watchdog armed (state.recentSpawns has 1 entry).
	const before = await withLock(p, async () => readState(p, cwd));
	ok("happy-1 is in recentSpawns after spawn", recentSpawnCount(before) === 1);
	// Send a message quickly — within the 50ms window.
	await enqueueAndDeliver(pi, cwd, p, { to: "happy-1", body: "do stuff" });
	const after = await withLock(p, async () => readState(p, cwd));
	ok("happy-1 removed from recentSpawns after send", recentSpawnCount(after) === 0);
	await wait(TIMER_MARGIN_MS);
	const events = readEvents(cwd);
	ok("agent.spawn.orphan_watch_start trace present", eventNames(events, "agent.spawn.orphan_watch_start").length === 1);
	ok("agent.spawn.orphan_cleared trace present (by swarm_send_message)", eventNames(events, "agent.spawn.orphan_cleared").length === 1);
	const cleared = eventNames(events, "agent.spawn.orphan_cleared")[0];
	ok("orphan_cleared reports by=swarm_send_message", cleared?.by === "swarm_send_message");
	ok("NO agent.spawn.orphan_warning trace", eventNames(events, "agent.spawn.orphan_warning").length === 0);
	rmSync(cwd, { recursive: true, force: true });
}

console.log("\n[2] Orphan path: spawn, no follow-up -> orphan_warning fires after timeout");
{
	const cwd = freshScratch("orphan");
	const p = paths(cwd);
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		await spawnAgent(pi, cwd, p, st, { id: "orphan-1", role: "Worker", initialPrompt: "go" });
		await writeState(p, st);
	});
	ok("orphan-1 armed in recentSpawns", recentSpawnCount(await withLock(p, async () => readState(p, cwd))) === 1);
	await wait(TIMER_MARGIN_MS);
	const events = readEvents(cwd);
	ok("agent.spawn.orphan_watch_start trace present", eventNames(events, "agent.spawn.orphan_watch_start").length === 1);
	ok("agent.spawn.orphan_warning trace present", eventNames(events, "agent.spawn.orphan_warning").length === 1);
	const warn = eventNames(events, "agent.spawn.orphan_warning")[0];
	ok("orphan_warning reports agentId=orphan-1", warn?.agentId === "orphan-1");
	ok("orphan_warning reports source=swarm_spawn_agent", warn?.source === "swarm_spawn_agent");
	ok("orphan_warning reports ageMs >= 0", typeof warn?.ageMs === "number" && warn.ageMs >= 0);
	ok("NO agent.spawn.orphan_cleared trace", eventNames(events, "agent.spawn.orphan_cleared").length === 0);
	ok("recentSpawns cleared after warning fired", recentSpawnCount(await withLock(p, async () => readState(p, cwd))) === 0);
	rmSync(cwd, { recursive: true, force: true });
}

console.log("\n[3] Cancel via assignment: spawn then deliver_message -> cleared, NO orphan_warning");
{
	// We can't easily drive swarm_assign_task without the full task graph; deliverMessageLocked is
	// its shared delivery core and per plan §R2 (B1 binding) the unified clear site lives there.
	// Driving deliverMessageLocked directly is functionally equivalent: any successful inbound
	// delivery to the agent clears the watch (the entry gate for §2.2 and §2.3 is the same).
	const cwd = freshScratch("assign");
	const p = paths(cwd);
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		st.agents["root"] ||= {
			id: "root", role: "PM", roleKind: "root", roleKindExplicit: true,
			capabilities: [], activeTaskIds: [], maxConcurrentTasks: 99, status: "running", runtimeStatus: "idle",
			health: "healthy", tmuxSession: "x", tmuxWindow: "unknown", tmuxTarget: "unknown", model: "m", provider: "p",
			cwd, mailbox: "x", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		};
		await spawnAgent(pi, cwd, p, st, { id: "assign-1", role: "Worker", initialPrompt: "go" });
		await writeState(p, st);
	});
	// Deliver an "assignment" message — the body is irrelevant for this test.
	await enqueueAndDeliver(pi, cwd, p, { to: "assign-1", body: "TASK ASSIGNMENT: do X", clearReason: "swarm_assign_task" });
	ok("assign-1 removed from recentSpawns after assignment message", recentSpawnCount(await withLock(p, async () => readState(p, cwd))) === 0);
	await wait(TIMER_MARGIN_MS);
	const events = readEvents(cwd);
	ok("agent.spawn.orphan_watch_start trace present", eventNames(events, "agent.spawn.orphan_watch_start").length === 1);
	ok("agent.spawn.orphan_cleared trace present", eventNames(events, "agent.spawn.orphan_cleared").length === 1);
	const clearedAssign = eventNames(events, "agent.spawn.orphan_cleared")[0];
	ok("orphan_cleared reports by=swarm_assign_task", clearedAssign?.by === "swarm_assign_task");
	ok("NO agent.spawn.orphan_warning trace", eventNames(events, "agent.spawn.orphan_warning").length === 0);
	rmSync(cwd, { recursive: true, force: true });
}

console.log("\n[4] Reuse path: pre-existing agent + restart -> NO orphan_watch_start trace");
{
	const cwd = freshScratch("reuse");
	const p = paths(cwd);
	// Plant a pre-existing stopped agent record so restartAgent has something to refresh.
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		st.agents["reuse-1"] = {
			id: "reuse-1", role: "Worker", roleKind: "implementer", roleKindExplicit: true,
			capabilities: [], activeTaskIds: [], maxConcurrentTasks: 1, status: "stopped", runtimeStatus: "stopped",
			health: "unhealthy", tmuxSession: "x", tmuxWindow: "reuse-1", tmuxTarget: "x:reuse-1.0",
			model: "m", provider: "p", cwd, mailbox: "x",
			createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		};
		await writeState(p, st);
	});
	const eventsBeforeRestart = readEvents(cwd);
	const startBefore = eventNames(eventsBeforeRestart, "agent.spawn.orphan_watch_start").length;
	// Now restart: this is the reuse path (isNewRecord=false). restartAgent calls spawnAgent.
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		await restartAgent(pi, cwd, p, st, "reuse-1");
		await writeState(p, st);
	});
	const events = readEvents(cwd);
	ok("reuse-1 NOT armed in recentSpawns", recentSpawnCount(await withLock(p, async () => readState(p, cwd))) === 0);
	ok("NO new agent.spawn.orphan_watch_start trace from restart", eventNames(events, "agent.spawn.orphan_watch_start").length === startBefore);
	await wait(TIMER_MARGIN_MS);
	ok("NO agent.spawn.orphan_warning trace from restart", eventNames(events, "agent.spawn.orphan_warning").length === 0);
	rmSync(cwd, { recursive: true, force: true });
}

console.log("\n[5] Cancel via stop_agent: spawn then stop -> cleared, NO orphan_warning");
{
	const cwd = freshScratch("stop");
	const p = paths(cwd);
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		await spawnAgent(pi, cwd, p, st, { id: "stop-1", role: "Worker", initialPrompt: "go" });
		await writeState(p, st);
	});
	ok("stop-1 armed in recentSpawns", recentSpawnCount(await withLock(p, async () => readState(p, cwd))) === 1);
	// Stop the agent. stopAgent core runs clearOrphanWatch BEFORE killAgentPane (B5 binding).
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		await stopAgent(pi, cwd, p, st, "stop-1");
		await writeState(p, st);
	});
	ok("stop-1 removed from recentSpawns after stop", recentSpawnCount(await withLock(p, async () => readState(p, cwd))) === 0);
	await wait(TIMER_MARGIN_MS);
	const events = readEvents(cwd);
	ok("agent.spawn.orphan_watch_start trace present", eventNames(events, "agent.spawn.orphan_watch_start").length === 1);
	ok("agent.spawn.orphan_cleared trace present (by swarm_stop_agent)", eventNames(events, "agent.spawn.orphan_cleared").length === 1);
	const cleared = eventNames(events, "agent.spawn.orphan_cleared")[0];
	ok("orphan_cleared reports by=swarm_stop_agent", cleared?.by === "swarm_stop_agent");
	ok("NO agent.spawn.orphan_warning trace", eventNames(events, "agent.spawn.orphan_warning").length === 0);
	rmSync(cwd, { recursive: true, force: true });
}

console.log("\n[6] Race backstop: message exists at fire time -> orphan_resolved_late, NO orphan_warning");
{
	const cwd = freshScratch("race");
	const p = paths(cwd);
	let spawnedEntry = null;
	let spawnedId = null;
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		st.agents["root"] ||= {
			id: "root", role: "PM", roleKind: "root", roleKindExplicit: true,
			capabilities: [], activeTaskIds: [], maxConcurrentTasks: 99, status: "running", runtimeStatus: "idle",
			health: "healthy", tmuxSession: "x", tmuxWindow: "unknown", tmuxTarget: "unknown", model: "m", provider: "p",
			cwd, mailbox: "x", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		};
		await spawnAgent(pi, cwd, p, st, { id: "race-1", role: "Worker", initialPrompt: "go" });
		spawnedEntry = st.recentSpawns?.[0];
		spawnedId = "race-1";
		await writeState(p, st);
	});
	ok("race-1 armed in recentSpawns", spawnedEntry !== null);
	// Simulate "a delivery raced ahead but the clear path missed" — seed an inbound message record.
	await seedInboundMessage(cwd, p, "race-1");
	await wait(TIMER_MARGIN_MS);
	const events = readEvents(cwd);
	ok("agent.spawn.orphan_watch_start trace present", eventNames(events, "agent.spawn.orphan_watch_start").length === 1);
	ok("agent.spawn.orphan_resolved_late trace present", eventNames(events, "agent.spawn.orphan_resolved_late").length === 1);
	const resolved = eventNames(events, "agent.spawn.orphan_resolved_late")[0];
	ok("orphan_resolved_late reports resolver=pre-existing-message", resolved?.resolver === "pre-existing-message");
	ok("orphan_resolved_late reports messageIds", Array.isArray(resolved?.messageIds) && resolved.messageIds.length > 0);
	ok("NO agent.spawn.orphan_warning trace (race backstop)", eventNames(events, "agent.spawn.orphan_warning").length === 0);
	ok("recentSpawns cleared after race resolution", recentSpawnCount(await withLock(p, async () => readState(p, cwd))) === 0);
	rmSync(cwd, { recursive: true, force: true });
}

console.log("\n[7] Preflight clear: spawn + same-root assign within grace window");
{
	const cwd = freshScratch("preflight");
	const p = paths(cwd);
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		st.agents["root"] ||= {
			id: "root", role: "PM", roleKind: "root", roleKindExplicit: true,
			capabilities: [], activeTaskIds: [], maxConcurrentTasks: 99, status: "running", runtimeStatus: "idle",
			health: "healthy", tmuxSession: "x", tmuxWindow: "unknown", tmuxTarget: "unknown", model: "m", provider: "p",
			cwd, mailbox: "x", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		};
		await spawnAgent(pi, cwd, p, st, { id: "preflight-1", role: "Worker", initialPrompt: "go" });
		await writeState(p, st);
	});
	// Verify the stamp is on the entry (C1 fix proves this works even without the leader seed).
	const entry = await withLock(p, async () => {
		const st = await readState(p, cwd);
		return st.recentSpawns?.find((s) => s.agentId === "preflight-1");
	});
	ok("entry stamped with spawnedByPid=process.pid", entry?.spawnedByPid === process.pid);
	// B2 fix: loose shape assertion (matches [7a]'s style). The arm-time fallback ISO
	// string and the test setup fallback ISO string are different timestamps; we only
	// assert the field exists and is a non-empty ISO string.
	ok("entry stamped with spawnedBySessionStartedAt (ISO string, non-empty)",
		typeof entry?.spawnedBySessionStartedAt === "string" &&
		entry.spawnedBySessionStartedAt.length > 0 &&
		!Number.isNaN(Date.parse(entry.spawnedBySessionStartedAt)));
	// B3 fix: re-anchor callerLeader from the actual entry stamp so the helper's
	// positive-direction assertion doesn't depend on env-var preset. This matches
	// test [8]'s pattern of deriving the comparison tuple from the real stamped
	// value rather than from the test-setup fallback ISO.
	const callerLeader = { pid: process.pid, sessionStartedAt: entry?.spawnedBySessionStartedAt };
	ok("isSameRootLeader returns true for matching pid+sessionStartedAt",
		isSameRootLeader(entry, callerLeader) === true);
	// Drive the pre-clear site directly.
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		await clearOrphanWatch(p, st, "preflight-1", "swarm_assign_task", "preflight");
		await writeState(p, st);
	});
	ok("preflight-1 removed from recentSpawns after pre-clear",
		recentSpawnCount(await withLock(p, async () => readState(p, cwd))) === 0);
	await wait(TIMER_MARGIN_MS); // 250ms >> 50ms timer
	const events = readEvents(cwd);
	ok("orphan_watch_start trace present", eventNames(events, "agent.spawn.orphan_watch_start").length === 1);
	ok("orphan_cleared trace present (by swarm_assign_task, reason preflight)",
		eventNames(events, "agent.spawn.orphan_cleared").length === 1);
	const cleared = eventNames(events, "agent.spawn.orphan_cleared")[0];
	ok("orphan_cleared.by === swarm_assign_task", cleared?.by === "swarm_assign_task");
	ok("orphan_cleared.reason === preflight", cleared?.reason === "preflight");
	ok("orphan_cleared.spawnedByPid stamped", cleared?.spawnedByPid === process.pid);
	ok("NO orphan_warning trace", eventNames(events, "agent.spawn.orphan_warning").length === 0);
	rmSync(cwd, { recursive: true, force: true });
}

console.log("\n[7a] Preflight clear: spawn as root's first tool call (leader was vacant at arm time)");
{
	const cwd = freshScratch("preflight-vacant");
	const p = paths(cwd);
	// Do NOT seed st.rootLeader — production "first tool call" case.
	// The spawn-time stamp must still match the assign-time caller (same process).
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		st.agents["root"] ||= {
			id: "root", role: "PM", roleKind: "root", roleKindExplicit: true,
			capabilities: [], activeTaskIds: [], maxConcurrentTasks: 99, status: "running", runtimeStatus: "idle",
			health: "healthy", tmuxSession: "x", tmuxWindow: "unknown", tmuxTarget: "unknown", model: "m", provider: "p",
			cwd, mailbox: "x", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		};
		await spawnAgent(pi, cwd, p, st, { id: "preflight-vacant-1", role: "Worker", initialPrompt: "go" });
		await writeState(p, st);
	});
	// Verify the entry IS stamped from process.pid even though the leader was vacant.
	const entry = await withLock(p, async () => {
		const st = await readState(p, cwd);
		return st.recentSpawns?.find((s) => s.agentId === "preflight-vacant-1");
	});
	ok("entry stamped with spawnedByPid=process.pid despite vacant leader (C1 fix)",
		entry?.spawnedByPid === process.pid);
	ok("entry stamped with spawnedBySessionStartedAt despite vacant leader",
		typeof entry?.spawnedBySessionStartedAt === "string" &&
		entry.spawnedBySessionStartedAt.length > 0);
	ok("isSameRootLeader returns true (same process, no leader needed)",
		isSameRootLeader(entry, { pid: process.pid, sessionStartedAt: process.env.PI_SWARM_SESSION_STARTED_AT }) === true);
	// Drive the pre-clear site.
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		await clearOrphanWatch(p, st, "preflight-vacant-1", "swarm_assign_task", "preflight");
		await writeState(p, st);
	});
	ok("entry removed after pre-clear",
		recentSpawnCount(await withLock(p, async () => readState(p, cwd))) === 0);
	await wait(TIMER_MARGIN_MS);
	const events = readEvents(cwd);
	ok("orphan_watch_start trace present", eventNames(events, "agent.spawn.orphan_watch_start").length === 1);
	ok("orphan_cleared trace present (reason preflight)",
		eventNames(events, "agent.spawn.orphan_cleared").length === 1);
	const cleared = eventNames(events, "agent.spawn.orphan_cleared")[0];
	ok("orphan_cleared.reason === preflight", cleared?.reason === "preflight");
	ok("NO orphan_warning trace", eventNames(events, "agent.spawn.orphan_warning").length === 0);
	rmSync(cwd, { recursive: true, force: true });
}

console.log("\n[8] Cross-root assign does NOT pre-clear");
{
	const cwd = freshScratch("cross-orch");
	const p = paths(cwd);
	const foreignLeader = {
		pid: 999_001,                                            // DIFFERENT pid (foreign root)
		sessionStartedAt: new Date().toISOString(),
	};
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		st.agents["root"] ||= {
			id: "root", role: "PM", roleKind: "root", roleKindExplicit: true,
			capabilities: [], activeTaskIds: [], maxConcurrentTasks: 99, status: "running", runtimeStatus: "idle",
			health: "healthy", tmuxSession: "x", tmuxWindow: "unknown", tmuxTarget: "unknown", model: "m", provider: "p",
			cwd, mailbox: "x", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
		};
		await spawnAgent(pi, cwd, p, st, { id: "cross-orch-1", role: "Worker", initialPrompt: "go" });
		await writeState(p, st);
	});
	// Override the entry's stamp to simulate a foreign root's spawn (different pid + session).
	await withLock(p, async () => {
		const st = await readState(p, cwd);
		const e = st.recentSpawns?.find((s) => s.agentId === "cross-orch-1");
		if (e) {
			e.spawnedByPid = foreignLeader.pid;
			e.spawnedBySessionStartedAt = foreignLeader.sessionStartedAt;
		}
		await writeState(p, st);
	});
	ok("cross-orch-1 armed in recentSpawns",
		recentSpawnCount(await withLock(p, async () => readState(p, cwd))) === 1);
	const entry = await withLock(p, async () => {
		const st = await readState(p, cwd);
		return st.recentSpawns.find((s) => s.agentId === "cross-orch-1");
	});
	const callerLeader = { pid: process.pid, sessionStartedAt: process.env.PI_SWARM_SESSION_STARTED_AT || undefined };
	ok("isSameRootLeader returns false for foreign pid",
		isSameRootLeader(entry, callerLeader) === false);
	// N1 strengthening: also verify the helper returns true when caller DOES match.
	ok("isSameRootLeader returns true when caller matches the stamp",
		isSameRootLeader(entry, foreignLeader) === true);
	await wait(TIMER_MARGIN_MS);
	const events = readEvents(cwd);
	ok("orphan_warning fires (foreign root did not pre-clear)",
		eventNames(events, "agent.spawn.orphan_warning").length === 1);
	ok("NO orphan_cleared trace (foreign root cannot clear)",
		eventNames(events, "agent.spawn.orphan_cleared").length === 0);
	ok("recentSpawns cleared after warning fired",
		recentSpawnCount(await withLock(p, async () => readState(p, cwd))) === 0);
	rmSync(cwd, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "ORPHAN-WARNING PASS" : "ORPHAN-WARNING FAIL"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
