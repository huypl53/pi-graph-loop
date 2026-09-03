// Logic-mirror validation for the graph-advance watcher (reconcileGraphAdvanceLocked +
// sendGraphAdvanceNudgeLocked). Mid-graph counterpart to the loop watcher: detect a READY-but-unassigned
// node in an in_progress task and nudge the orchestrator to assign it (idempotent per task:node; auto-acked
// once assigned/terminal). The harness never assigns — it only surfaces the stall + the exact fix call.
// Run: node extensions/swarm/graph-advance.validate.mjs

let failures = 0;
function assert(c, m) { if (!c) { failures++; console.error("  FAIL:", m); } else console.log("  ok  ", m); }

// deps: nodeId -> [dep nodeIds]; a node is "ready" when all deps are done AND it has no assignee.
function actionableNodes(task) {
	const out = new Set();
	for (const [id, n] of Object.entries(task.nodes)) {
		if (n.assignee) continue;                       // already assigned
		if (["done", "failed", "skipped", "blocked"].includes(n.status)) continue;
		const deps = n.deps || [];
		const depsMet = deps.every((d) => task.nodes[d] && task.nodes[d].status === "done");
		// newly-ready pending (deps just satisfied) OR already ready-status
		if ((n.status === "pending" && depsMet) || n.status === "ready") out.add(id);
	}
	return out;
}
function mkEnv() {
	const e = { messages: {}, seq: 0 };
	const send = (taskId, nodeId) => {
		const key = `task:${taskId}:node:${nodeId}:nudge:assign`;
		if (Object.values(e.messages).some((r) => r.idempotencyKey === key)) return;
		e.messages[`m${++e.seq}`] = { idempotencyKey: key, requiresAck: true, ackedAt: null };
	};
	const ack = (taskId, nodeId) => {
		const r = Object.values(e.messages).find((x) => x.idempotencyKey === `task:${taskId}:node:${nodeId}:nudge:assign`);
		if (r && !r.ackedAt) r.ackedAt = Date.now();
	};
	e.reconcile = (tasks) => {
		for (const t of tasks) {
			if (t.status !== "in_progress") continue;
			const actionable = actionableNodes(t);
			for (const nodeId of Object.keys(t.nodes)) {
				if (actionable.has(nodeId)) send(t.taskId, nodeId);
				else ack(t.taskId, nodeId);
			}
		}
	};
	return e;
}
const sent = (e, taskId, nodeId) => Object.values(e.messages).filter((r) => r.idempotencyKey === `task:${taskId}:node:${nodeId}:nudge:assign`).length;
const acked = (e, taskId, nodeId) => { const r = Object.values(e.messages).find((x) => x.idempotencyKey === `task:${taskId}:node:${nodeId}:nudge:assign`); return !!(r && r.ackedAt); };

// 1. ready-but-unassigned node in an in_progress task -> send assign nudge
{ const e = mkEnv();
  e.reconcile([{ taskId: "t1", status: "in_progress", nodes: {
    plan: { status: "done", assignee: "p", deps: [] },
    impl: { status: "pending", assignee: null, deps: ["plan"] } } }]);
  assert(sent(e, "t1", "impl") === 1, "A: ready-unassigned node -> assign nudge sent");
  assert(sent(e, "t1", "plan") === 0, "A: done node (has assignee) -> no nudge");
}
// 2. node already assigned -> no nudge; a stale nudge gets acked
{ const e = mkEnv();
  e.reconcile([{ taskId: "t1", status: "in_progress", nodes: {
    plan: { status: "done", assignee: "p", deps: [] },
    impl: { status: "in_progress", assignee: "imp", deps: ["plan"] } } }]);
  assert(sent(e, "t1", "impl") === 0, "B: assigned node -> no nudge");
  // simulate a prior assign nudge for impl that should now be cleared
  e.messages["m99"] = { idempotencyKey: `task:t1:node:impl:nudge:assign`, requiresAck: true, ackedAt: null };
  e.reconcile([{ taskId: "t1", status: "in_progress", nodes: {
    plan: { status: "done", assignee: "p", deps: [] },
    impl: { status: "in_progress", assignee: "imp", deps: ["plan"] } } }]);
  assert(acked(e, "t1", "impl"), "B: stale assign nudge auto-acked once node assigned");
}
// 3. task done -> no nudges at all (nothing to drive)
{ const e = mkEnv();
  e.reconcile([{ taskId: "t1", status: "done", nodes: { a: { status: "pending", assignee: null, deps: [] } } }]);
  assert(sent(e, "t1", "a") === 0, "C: done task -> no nudges");
}
// 4. idempotent: repeated reconcile with same stall -> exactly one nudge
{ const e = mkEnv(); const t = [{ taskId: "t1", status: "in_progress", nodes: {
    p: { status: "done", assignee: "x", deps: [] }, q: { status: "pending", assignee: null, deps: ["p"] } } }];
  for (let i = 0; i < 3; i++) e.reconcile(t);
  assert(sent(e, "t1", "q") === 1, "D: repeated reconcile idempotent");
}
// 5. deps NOT satisfied -> not ready -> no nudge
{ const e = mkEnv();
  e.reconcile([{ taskId: "t1", status: "in_progress", nodes: {
    a: { status: "in_progress", assignee: "x", deps: [] },
    b: { status: "pending", assignee: null, deps: ["a"] } } }]);
  assert(sent(e, "t1", "b") === 0, "E: node w/ unsatisfied deps -> no nudge");
}
// 6. multiple actionable nodes -> one nudge each (parallel-ready graph)
{ const e = mkEnv();
  e.reconcile([{ taskId: "t1", status: "in_progress", nodes: {
    start: { status: "done", assignee: "s", deps: [] },
    x: { status: "pending", assignee: null, deps: ["start"] },
    y: { status: "pending", assignee: null, deps: ["start"] } } }]);
  assert(sent(e, "t1", "x") === 1 && sent(e, "t1", "y") === 1, "F: two ready nodes -> one nudge each");
}

console.log(failures === 0 ? "\nALL PASS (graph-advance watcher: ready-but-unassigned stall detection)" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
