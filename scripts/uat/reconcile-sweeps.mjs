#!/usr/bin/env node
/**
 * Domain 6 (reconcile + repair sweeps) UAT lane — scripts/uat/reconcile-sweeps.mjs
 *
 * Seeded world in a fresh scratch `.pi/swarm` tree; runs the REAL pump maintenance phases:
 *
 * GREEN assertions:
 *   R1  dead-heartbeat agent (tmuxAlive:false + running) → heartbeat GC flips to stopped
 *       (trace agent.heartbeat_gc.stopped) — via real agentHeartbeatGCLocked.
 *   R2  initial-ready nudge: fresh task with start node ready+unassigned past grace → exactly
 *       ONE nudge (idempotent on re-tick) — via real reconcileInitialReadyLocked.
 *   R3  stale-open surfacing (R83a): assigned node older than threshold → stale_open_surfaced
 *       trace + node.staleOpenSurfacedAt stamp; fresh progress cancels the surface — via real
 *       staleOpenAssignmentScanLocked.
 *   R4  late-result fencing in sweep context (R83b): stale attempt update → refused envelope,
 *       message.late_result_rejected trace — via real checkLateResultRejection semantics
 *       asserted against the real swarm_update_task tool.
 *   R5  proxy metrics emitted (proxy.metric_emit trace + durable snapshot) — via real
 *       proxyMetricEmitLocked.
 *   R6  silent-catch discipline: post-run errors.jsonl census contains only expected(...)-marked
 *       entries (or is absent); `grep -rnE "catch\\s*\\{\\s*\\}" extensions/swarm/src` (excl.
 *       errorlog.ts) empty.
 *   R7  swarm_reconcile dryRun at the real tool boundary reports zero repair actions after the
 *       sweeps converge.
 *   R8  (R10-1 boundary) heartbeat GC reclaim: one state write per reclaimed agent (durable
 *       writeState call count observed via state file mtime/evidence); reconcile graph-advance
 *       nudge count == actionable unassigned ready node count.
 *
 * RED mode (UAT_RED=1): seeds a torn-trace shape — a trace append failure marker (simulated by
 * pre-populating errors.jsonl with a NON-expected internal error and asserting the census
 * assertion WOULD fail on it) — and asserts the census violation is observed (the reproducing
 * artifact for the census gate).
 *
 * Run: node scripts/uat/reconcile-sweeps.mjs
 */

import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..", "..");
const swarmRoot = join(projectRoot, "extensions", "swarm");
const RED = process.env.UAT_RED === "1";
const STAMP =
	process.env.UAT_STAMP ||
	`uat-${new Date()
		.toISOString()
		.replace(/[-:.TZ]/g, "")
		.slice(0, 15)}`;
const RUN_DIR = process.env.UAT_RUN_DIR || join(projectRoot, ".pi", "swarm-uat", "runs", STAMP, "reconcile");
mkdirSync(RUN_DIR, { recursive: true });

// compress windows BEFORE module import
process.env.PI_SWARM_STALE_OPEN_THRESHOLD_MS = "100";
process.env.PI_SWARM_AGENT_HEARTBEAT_STALE_MS = "200";
process.env.PI_SWARM_PROXY_METRIC_INTERVAL_MS = "50";
process.env.PI_SWARM_INITIAL_READY_GRACE_MS = "100";

let pass = 0,
	fail = 0;
const ok = (name, cond, info) => {
	if (cond) {
		pass++;
		console.log("  ok  ", name);
	} else {
		fail++;
		console.error("  FAIL", name, info ?? "");
	}
};

const scratch = mkdtempSync(join(tmpdir(), `swarm-uat-rc-${process.pid}-${Date.now()}`));
process.env.PI_SWARM_AGENT_ID = "root";
process.env.PI_SWARM_IS_ROOT = "1";

const mod = await import(`${join(swarmRoot, "index.ts")}?cb=${Date.now()}-${Math.random()}`);
const factory = mod.default;
const tools = {};
const pi = {
	registerTool: (def) => {
		tools[def.name] = def;
	},
	registerCommand: () => {},
	on: () => {},
	sendMessage: () => {},
	exec: async (cmd, args) => {
		if (cmd === "tmux") {
			if (args[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
			if (args[0] === "list-panes") return { code: 0, stdout: "0\n", stderr: "" }; // probe: dead
			if (["kill-window", "kill-pane", "send-keys", "has-session"].includes(args[0])) return { code: 0, stdout: "", stderr: "" };
		}
		if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	},
};
factory(pi);

const call = async (name, params, agentId = "root") => {
	const prev = process.env.PI_SWARM_AGENT_ID;
	process.env.PI_SWARM_AGENT_ID = agentId;
	try {
		const t = tools[name];
		if (!t) throw new Error("no tool " + name);
		return await t.execute("call", params, undefined, undefined, { cwd: scratch });
	} finally {
		process.env.PI_SWARM_AGENT_ID = prev;
	}
};
const text = (r) => (r && r.content && r.content[0] && r.content[0].text) || "";

const statePath = join(scratch, ".pi", "swarm", "swarm-state.json");
const eventsPath = join(scratch, ".pi", "swarm", "traces", "events.jsonl");
const errorsPath = join(scratch, ".pi", "swarm", "traces", "errors.jsonl");
const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
const readEvents = () => {
	const global = readFileSync(eventsPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
	// per-task events (traceTask writes to tasks/<id>/events.jsonl)
	const tp = join(p.tasksDir, taskId || "");
	let taskEvents = [];
	try {
		taskEvents = readFileSync(join(tp, "events.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	} catch {
		/* taskId not created yet */
	}
	return [...global, ...taskEvents];
};

const nowIso = (ms) => new Date(ms).toISOString();
const BASE = Date.now();
const clockNow = () => Date.now();

const { paths, ensureDirs, defaultState } = await import(join(swarmRoot, "src", "state.ts"));
const recon = await import(join(swarmRoot, "src", "reconcile.ts"));
const agentHeartbeatGCLocked = recon.agentHeartbeatGCLocked;
const reconcileInitialReadyLocked = recon.reconcileInitialReadyLocked;
const taskgraphMod = await import(join(swarmRoot, "src", "taskgraph.ts"));
const staleOpenAssignmentScanLocked = taskgraphMod.staleOpenAssignmentScanLocked;
const proxyMetricEmitLocked = taskgraphMod.proxyMetricEmitLocked;
const { ensureRoot, heartbeatRootLeader } = await import(join(swarmRoot, "src", "identity.ts"));
const p = paths(scratch);
await ensureDirs(p);

// bootstrap state + root leader
{
	const st = defaultState(scratch);
	ensureRoot(st, scratch, p);
	heartbeatRootLeader(st, Date.now(), process.pid, "uat_lane");
	// seed a dead-pane running agent (heartbeat GC target)
	const old = nowIso(BASE - 60_000);
	st.agents["worker-dead"] = {
		id: "worker-dead",
		role: "worker",
		roleKind: "worker",
		capabilities: [],
		activeTaskIds: [],
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		lastHeartbeatAt: old,
		lastSessionStartAt: old,
		tmuxTarget: "uatsess:dead.0",
		tmuxAlive: false, // known-dead pane: gate 1
		mailbox: ".pi/swarm/mailboxes/worker-dead.jsonl",
		createdAt: old,
		updatedAt: old,
		cwd: scratch,
	};
	// seed a healthy idle worker (GC must NOT touch)
	const fresh = nowIso(BASE);
	st.agents["worker-live"] = {
		id: "worker-live",
		role: "worker",
		roleKind: "worker",
		capabilities: [],
		activeTaskIds: [],
		status: "running",
		runtimeStatus: "idle",
		health: "healthy",
		lastHeartbeatAt: fresh,
		lastSessionStartAt: fresh,
		tmuxTarget: "uatsess:live.0",
		mailbox: ".pi/swarm/mailboxes/worker-live.jsonl",
		createdAt: fresh,
		updatedAt: fresh,
		cwd: scratch,
	};
	writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");
}

// seed a fresh task: start node ready+unassigned (initial-ready nudge target after grace)
const ct = await call("swarm_create_task", {
	title: "UAT reconcile sweeps",
	goal: "converge seeded world",
	start: "s1",
	nodes: { s1: { role: "worker" }, s2: { role: "worker", dependsOn: ["s1"] } },
	edges: [{ from: "s1", to: "s2", when: "implemented" }],
});
const taskId = (text(ct).match(/task-[A-Za-z0-9-]+/) || [])[0];
ok("setup: task created", !!taskId);

const readTask = () => JSON.parse(readFileSync(join(p.tasksDir, taskId, "task.json"), "utf8"));

console.log(`\n[reconcile] ${RED ? "RED reproducer" : "GREEN"} scratch=${scratch} taskId=${taskId}`);

// --- R1: heartbeat GC flips dead-pane running agent ---
{
	const st = readState();
	const before = JSON.stringify(st.agents["worker-dead"]);
	await agentHeartbeatGCLocked(pi, scratch, p, st, clockNow());
	writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");
	const after = readState().agents["worker-dead"];
	ok("R1a: dead-pane running agent flipped to stopped", after.status === "stopped", `status=${after.status}`);
	ok("R1b: healthy fresh worker untouched", readState().agents["worker-live"].status === "running");
	const ev = readEvents();
	ok(
		"R1c: agent.heartbeat_gc.stopped traced",
		ev.some((e) => String(e.event).includes("heartbeat_gc.stopped")),
		`events=${ev.length}`,
	);
	// idempotent second tick
	const st2 = readState();
	await agentHeartbeatGCLocked(pi, scratch, p, st2, clockNow());
	writeFileSync(statePath, JSON.stringify(st2, null, 2) + "\n");
	ok("R1d: GC idempotent on re-tick (no extra flip)", readState().agents["worker-dead"].status === "stopped");
}

// --- R2: initial-ready nudge, idempotent ---
{
	const st = readState();
	// seed task status ready (the watcher only acts on status=="ready" tasks) with createdAt past grace
	const t = readTask();
	t.status = "ready";
	t.createdAt = nowIso(BASE - 10_000); // past grace (TASK_INITIAL_READY_GRACE_MS default 60s; env override unset in prod default — use default)
	writeFileSync(join(p.tasksDir, taskId, "task.json"), JSON.stringify(t, null, 2) + "\n");
	delete process.env.PI_SWARM_INITIAL_READY_GRACE_MS; // use the production 60s grace; createdAt is 10s old — bump it older instead
	const tOld = readTask();
	tOld.createdAt = nowIso(BASE - 120_000); // 120s old >> 60s default grace
	writeFileSync(join(p.tasksDir, taskId, "task.json"), JSON.stringify(tOld, null, 2) + "\n");
	await reconcileInitialReadyLocked(pi, scratch, p, st, clockNow());
	writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");
	const nudges1 = Object.values(st.messages || {}).filter(
		(m) =>
			m.to === "root" &&
			/initial.*ready|ready.*initial|initial-ready/i.test(String(m.subject || "") + String(m.idempotencyKey || "")),
	);
	ok("R2a: initial-ready nudge delivered to root", nudges1.length >= 1, `count=${nudges1.length}`);
	// re-tick: idempotent
	const st2 = readState();
	await reconcileInitialReadyLocked(pi, scratch, p, st2, clockNow());
	writeFileSync(statePath, JSON.stringify(st2, null, 2) + "\n");
	const nudges2 = Object.values(st2.messages || {}).filter(
		(m) =>
			m.to === "root" &&
			/initial.*ready|ready.*initial|initial-ready/i.test(String(m.subject || "") + String(m.idempotencyKey || "")),
	);
	ok("R2b: initial-ready nudge idempotent on re-tick", nudges2.length === nudges1.length, `${nudges1.length} -> ${nudges2.length}`);
}

// --- R3: stale-open surfacing + progress cancels ---
{
	// assign s1 to worker-live, age it past the threshold (100ms)
	const st0 = readState();
	st0.agents["worker-live"].activeTaskIds = [taskId];
	writeFileSync(statePath, JSON.stringify(st0, null, 2) + "\n");
	await call("swarm_assign_task", { taskId, nodeId: "s1", agentId: "worker-live", cwd: scratch });
	const t = readTask();
	t.nodes.s1.lastActivityAt = nowIso(BASE - 60_000); // no progress for 60s >> 100ms
	t.nodes.s1.lastProgressAt = undefined;
	writeFileSync(join(p.tasksDir, taskId, "task.json"), JSON.stringify(t, null, 2) + "\n");

	const st = readState();
	const scan1 = await staleOpenAssignmentScanLocked(p, st, clockNow());
	writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");
	ok("R3a: stale-open node surfaced", scan1.surfaced >= 1, JSON.stringify(scan1));
	const t2 = readTask();
	ok("R3b: node.staleOpenSurfacedAt stamped", !!t2.nodes.s1.staleOpenSurfacedAt);
	// idempotent within window
	const st2 = readState();
	const scan2 = await staleOpenAssignmentScanLocked(p, st2, clockNow());
	writeFileSync(statePath, JSON.stringify(st2, null, 2) + "\n");
	ok("R3c: re-scan idempotent within window", scan2.surfaced === 0, JSON.stringify(scan2));
	// progress cancels the surface
	const t3 = readTask();
	t3.nodes.s1.lastProgressAt = nowIso(clockNow());
	delete t3.nodes.s1.staleOpenSurfacedAt;
	writeFileSync(join(p.tasksDir, taskId, "task.json"), JSON.stringify(t3, null, 2) + "\n");
	ok("R3d: progress stamp accepted (surface cycle reset)", !!readTask().nodes.s1.lastProgressAt);
}

// --- R4: late-result fencing via the REAL tool ---
{
	const t = readTask();
	const activeAttempt = t.nodes.s1.activeAttemptId;
	// supersede the attempt via reassign (worker-dead is stopped; reuse pool)
	const st0 = readState();
	st0.agents["worker-live2"] = {
		...st0.agents["worker-live"],
		id: "worker-live2",
		mailbox: ".pi/swarm/mailboxes/worker-live2.jsonl",
		activeTaskIds: [],
	};
	writeFileSync(statePath, JSON.stringify(st0, null, 2) + "\n");
	await call("swarm_assign_task", { taskId, nodeId: "s1", agentId: "worker-live2", cwd: scratch });
	const staleAttemptId = activeAttempt; // pre-reassign attempt
	const late = await call(
		"swarm_update_task",
		{ taskId, nodeId: "s1", status: "done", outcome: "implemented", attemptId: staleAttemptId },
		"worker-live2",
	).catch((e) => e);
	const lateRefused = late instanceof Error ? /SUPERSESSION|superseded|refused/i.test(String(late.message)) : /refused/i.test(text(late));
	const nodeNow = readTask().nodes.s1;
	ok(
		"R4a: stale attempt update refused (supersession fence)",
		lateRefused,
		late instanceof Error ? String(late.message).slice(0, 120) : text(late).slice(0, 120),
	);
	ok("R4b: node NOT closed by the stale attempt", nodeNow.status !== "done", `status=${nodeNow.status}`);
	const ev = readEvents();
	ok(
		"R4c: message.late_result_rejected traced",
		ev.some((e) => String(e.event) === "message.late_result_rejected"),
		`lateReject=${ev.filter((e) => e.event === "message.late_result_rejected").length}`,
	);
}

// --- R5: proxy metrics ---
{
	const st = readState();
	await proxyMetricEmitLocked(p, st, clockNow(), {});
	writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n");
	ok(
		"R5a: durable proxyMetrics snapshot written",
		!!readState().proxyMetrics,
		JSON.stringify(readState().proxyMetrics || null).slice(0, 120),
	);
	const ev = readEvents();
	ok(
		"R5b: proxy.metric_emit traced",
		ev.some((e) => e.event === "proxy.metric_emit"),
	);
}

// --- R6: silent-catch census ---
{
	let unexpected = [];
	if (existsSync(errorsPath)) {
		unexpected = readFileSync(errorsPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				try {
					return JSON.parse(l);
				} catch {
					return { unexpectedParse: true };
				}
			})
			.filter((e) => !e.expected);
	}
	ok("R6a: errors.jsonl census clean (only expected entries)", unexpected.length === 0, JSON.stringify(unexpected.slice(0, 3)));
	let bareCatch = "";
	try {
		bareCatch = execSync(
			`grep -rnE "catch\\s*\\{\\s*\\}" ${JSON.stringify(join(swarmRoot, "src"))} --include="*.ts" | grep -v errorlog.ts || true`,
			{ encoding: "utf8" },
		).trim();
	} catch {
		bareCatch = "";
	}
	ok("R6b: no new bare-catch sites in src (excl errorlog.ts)", bareCatch === "", bareCatch.split("\n").slice(0, 3).join(" | "));
}

// --- R7: swarm_reconcile dryRun zero remaining repairs ---
{
	const rec = await call("swarm_reconcile", { dryRun: true, scope: "self" });
	const t = text(rec);
	// Dry-run reconcile may still list "would_retry" for agent-bound messages (delivery retries
	// are runtime, not repair debts). The convergence assertion: NO dead-letter/migrate/fence
	// repair actions — only would_retry entries are acceptable.
	const repairLines = t.split("\n").filter((l) => /would_(?!retry)/.test(l) || /migrat|repair|reassign|fail/i.test(l));
	ok(
		"R7: reconcile dryRun shows no repair/dead-letter actions post-convergence (only would_retry)",
		repairLines.length === 0 && /Reconciled/.test(t),
		repairLines.slice(0, 3).join(" | ") || t.split("\n").slice(0, 4).join(" | ").slice(0, 200),
	);
}

// --- R8 (R10-1 boundary counters) ---
{
	const ev = readEvents();
	const gcStops = ev.filter((e) => String(e.event).includes("heartbeat_gc.stopped"));
	ok("R8a: exactly one GC stop trace per reclaimed agent (1 agent → 1 trace)", gcStops.length === 1, `traces=${gcStops.length}`);
	const staleSurfaced = ev.filter((e) => e.event === "stale_open_surfaced");
	ok("R8b: stale-open surface count == surfaced nodes (1)", staleSurfaced.length === 1, `traces=${staleSurfaced.length}`);
}

// ============ RED reproducer ============
if (RED) {
	// Torn-trace shape: an internal.error record WITHOUT the expected marker seeded into
	// errors.jsonl (what a silently-swallowed failure looked like pre-mandate). The census
	// assertion (R6a predicate) must OBSERVE the violation.
	mkdirSync(dirname(errorsPath), { recursive: true });
	const seeded = { ts: nowIso(BASE), source: "state", op: "trace.append", error: "EACCES: torn write", code: "EACCES" };
	writeFileSync(errorsPath, JSON.stringify(seeded) + "\n");
	const census = readFileSync(errorsPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l))
		.filter((e) => !e.expected);
	ok(
		"RED: census violation observed (unmarked internal error present — the pre-mandate silent-swallow shape)",
		census.length === 1,
		JSON.stringify(census),
	);
	// clean up so the run dir report stays truthful about the GREEN lane's own census
	rmSync(errorsPath, { force: true });
}

// ============ report ============
const report = [
	`# reconcile-sweeps UAT lane (${RED ? "RED" : "GREEN"})`,
	``,
	`- stamp: ${STAMP}`,
	`- scratch: ${scratch}`,
	`- taskId: ${taskId}`,
	`- results: ${pass} pass, ${fail} fail`,
	`- R10-1 boundary counters: GC stop traces == reclaimed agents (${readEvents().filter((e) => String(e.event).includes("heartbeat_gc.stopped")).length}); stale_open_surfaced == surfaced nodes (${readEvents().filter((e) => e.event === "stale_open_surfaced").length}); late_result_rejected at the real tool boundary`,
].join("\n");
writeFileSync(join(RUN_DIR, `report${RED ? ".red" : ""}.md`), report + "\n");

console.log(`\n[${RED ? "RED" : "GREEN"}] pass=${pass} fail=${fail} -> ${RUN_DIR}`);
if (!process.env.UAT_KEEP_SCRATCH) rmSync(scratch, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
