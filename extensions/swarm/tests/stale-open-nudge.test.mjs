#!/usr/bin/env node
// R11-1 completion repro: stale-open scan surfaces an assigned node with NO progress past the
// threshold, but the surfacing is TRACE-ONLY — nothing nudges the root. The operator
// (and the root LLM) must poll proxyMetrics by hand; the swarm idles for hours
// (live evidence: 2026-09-01 — 5 idle-locks, each discovered by the human, staleOpen=1 in
// metrics with ZERO nudges delivered).
//
// Expected CORRECT behavior (assertions): when staleOpenAssignmentScanLocked surfaces a stale
// node, the root receives ONE high-priority mailbox nudge (idempotent within the
// surfacing window, capped, cooled-down). RED today: zero nudges.
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-stale-open-nudge-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });

process.env.PI_SWARM_AGENT_ID = "root";
// Shrink the threshold so the fixture doesn't wait 5 minutes.
process.env.PI_SWARM_STALE_OPEN_THRESHOLD_MS = "1000";
const mod = await import(join(here, "..", "index.ts"));
const factory = mod.default;

const tools = {};
const pi = {
	registerTool: (def) => { tools[def.name] = def; },
	registerCommand: () => {},
	on: () => {},
	exec: async (cmd, args) => {
		if (cmd === "tmux" && args[0] === "display-message") return { code: 0, stdout: "%1\n", stderr: "" };
		if (cmd === "git") return { code: 0, stdout: "deadbeef\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	},
	sendMessage: () => {},
};
factory(pi);

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log("  ok  ", n); } else { fail++; console.error("  FAIL", n, extra ?? ""); } };

const call = async (name, params) => {
	const t = tools[name]; if (!t) throw new Error("no tool " + name);
	return t.execute("call", params, undefined, undefined, { cwd: scratch });
};

// --- fixture: one task, implement assigned to a worker 10 minutes ago, no progress ---
mkdirSync(join(scratch, ".pi/swarm"), { recursive: true });
const statePath = join(scratch, ".pi/swarm/swarm-state.json");
const nowIso = new Date().toISOString();
const oldIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
writeFileSync(statePath, JSON.stringify({
	version: 1, swarmId: "repro",
	agents: {
		root: { id: "root", status: "running", runtimeStatus: "idle", activeTaskIds: [], updatedAt: nowIso },
		"worker-x": { id: "worker-x", status: "running", runtimeStatus: "idle", activeTaskIds: [], updatedAt: nowIso },
	},
	messages: {}, updatedAt: nowIso,
}, null, 2));

await call("swarm_create_task", {
	taskId: "task-repro-r111",
	title: "R11-1 nudge repro",
	goal: "stale-open nudge repro",
	nodes: {
		plan: { role: "planner", dependsOn: [], writeArtifacts: ["artifacts/plan.md"] },
		implement: { role: "implementer", dependsOn: ["plan"], writeArtifacts: ["artifacts/impl.md"] },
		review: { role: "reviewer", dependsOn: ["implement"], terminal: true, writeArtifacts: ["artifacts/review.md"] },
	},
	edges: [
		{ from: "plan", to: "implement", when: "planned" },
		{ from: "implement", to: "review", when: "implemented" },
	],
	cwd: scratch,
});
await call("swarm_update_task", { taskId: "task-repro-r111", nodeId: "plan", status: "done", outcome: "planned", force: true, cwd: scratch });
await call("swarm_assign_task", { taskId: "task-repro-r111", nodeId: "implement", agentId: "worker-x", cwd: scratch });

// Age the node: lastActivityAt 10min ago (simulate worker settled silently after pickup).
const taskPath = join(scratch, ".pi/swarm/tasks/task-repro-r111/task.json");
const t0 = JSON.parse(readFileSync(taskPath, "utf8"));
t0.nodes.implement.lastActivityAt = oldIso;
writeFileSync(taskPath, JSON.stringify(t0, null, 2));

// --- run the pump phase directly (the scan is a locked helper; drive via reconcile tool) ---
await call("swarm_reconcile", { scope: "all", dryRun: false, cwd: scratch });
// The scan is pump-invoked; for the repro, invoke the helper the same way the pump does:
const { staleOpenAssignmentScanLocked, staleOpenNudgeLocked } = await import(join(here, "..", "src", "taskgraph.ts"));
const { paths: pathsOf, readState } = await import(join(here, "..", "src", "state.ts"));
const p = pathsOf(scratch);
let scan;
{
	const { withLock } = await import(join(here, "..", "src", "state.ts"));
	scan = await withLock(p, async () => {
		const st = await readState(p, scratch);
		const r = await staleOpenAssignmentScanLocked(p, st, Date.now());
		if (staleOpenNudgeLocked) { try { await staleOpenNudgeLocked(pi, scratch, p, st, "task-repro-r111", "implement"); } catch {} }
		const { writeState } = await import(join(here, "..", "src", "state.ts"));
		await writeState(p, st);
		return r;
	});
}
ok("scan surfaced the stale node", scan.surfaced === 1, JSON.stringify(scan));
const tS = JSON.parse(readFileSync(join(scratch, ".pi/swarm/tasks/task-repro-r111/task.json"), "utf8"));
console.log("   [dbg] staleOpenSurfacedAt after scan:", tS.nodes.implement.staleOpenSurfacedAt);

// --- THE ASSERTIONS: root must have been nudged ---
const st1 = JSON.parse(readFileSync(statePath, "utf8"));
const nudges = Object.values(st1.messages || {}).filter((m) => m.to === "root" && (m.idempotencyKey || "").includes(":nudge:stale-open:seq:"));
ok("root received a stale-open nudge", nudges.length >= 1, `nudges=${nudges.length}`);
if (nudges.length >= 1) ok("nudge key names the node", (nudges[0].idempotencyKey || "").includes("implement"), nudges[0].idempotencyKey);

// Idempotency within window: second scan must NOT double-nudge.
{
	const { withLock } = await import(join(here, "..", "src", "state.ts"));
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		const r = await staleOpenAssignmentScanLocked(p, st, Date.now());
		if (staleOpenNudgeLocked) { try { await staleOpenNudgeLocked(pi, scratch, p, st, "task-repro-r111", "implement"); } catch {} }
		const { writeState } = await import(join(here, "..", "src", "state.ts"));
		await writeState(p, st);
		return r;
	});
}
const st2 = JSON.parse(readFileSync(statePath, "utf8"));
const nudges2 = Object.values(st2.messages || {}).filter((m) => m.to === "root" && (m.idempotencyKey || "").includes(":nudge:stale-open:seq:"));
ok("no duplicate nudge within window", nudges2.length === nudges.length, `before=${nudges.length} after=${nudges2.length}`);


// --- KR6 boundary: node WITH fresh progress (below threshold) must NOT nudge ---
{
	rmSync(scratch, { recursive: true, force: true });
	mkdirSync(join(scratch, ".pi/swarm"), { recursive: true });
	const freshIso = new Date(Date.now() - 200).toISOString(); // well below the 1000ms threshold
	writeFileSync(statePath, JSON.stringify({
		version: 1, swarmId: "repro",
		agents: {
			root: { id: "root", status: "running", runtimeStatus: "idle", activeTaskIds: [], updatedAt: nowIso },
			"worker-x": { id: "worker-x", status: "running", runtimeStatus: "tool_running", activeTaskIds: [], updatedAt: nowIso },
		},
		messages: {}, updatedAt: nowIso,
	}, null, 2));
	await call("swarm_create_task", {
		taskId: "task-repro-fresh", title: "fresh", goal: "fresh",
		nodes: { plan: { role: "planner", dependsOn: [], writeArtifacts: ["artifacts/plan.md"] }, implement: { role: "implementer", dependsOn: ["plan"], writeArtifacts: ["artifacts/impl.md"] }, review: { role: "reviewer", dependsOn: ["implement"], terminal: true, writeArtifacts: ["artifacts/review.md"] } },
		edges: [ { from: "plan", to: "implement", when: "planned" }, { from: "implement", to: "review", when: "implemented" } ],
		cwd: scratch,
	});
	await call("swarm_update_task", { taskId: "task-repro-fresh", nodeId: "plan", status: "done", outcome: "planned", force: true, cwd: scratch });
	await call("swarm_assign_task", { taskId: "task-repro-fresh", nodeId: "implement", agentId: "worker-x", cwd: scratch });
	const tp2 = join(scratch, ".pi/swarm/tasks/task-repro-fresh/task.json");
	const tf = JSON.parse(readFileSync(tp2, "utf8"));
	tf.nodes.implement.lastActivityAt = freshIso;
	tf.nodes.implement.lastProgressAt = freshIso; // fresh progress on BOTH anchors
	writeFileSync(tp2, JSON.stringify(tf, null, 2));
	const { withLock, writeState } = await import(join(here, "..", "src", "state.ts"));
	await withLock(p, async () => {
		const st = await readState(p, scratch);
		const r = await staleOpenAssignmentScanLocked(p, st, Date.now());
		ok("KR6: fresh-progress node NOT surfaced", r.surfaced === 0 && (r.surfacedNodes?.length ?? 0) === 0, JSON.stringify(r));
		if (staleOpenNudgeLocked) { await staleOpenNudgeLocked(pi, scratch, p, st, "task-repro-fresh", "implement"); }
		await writeState(p, st);
	});
	const stf = JSON.parse(readFileSync(statePath, "utf8"));
	const nf = Object.values(stf.messages || {}).filter((m) => m.to === "root" && (m.idempotencyKey || "").includes(":nudge:stale-open:seq:"));
	ok("KR6: fresh-progress node NOT nudged", nf.length === 0, `nudges=${nf.length}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
