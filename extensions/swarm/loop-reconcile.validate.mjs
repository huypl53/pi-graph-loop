// Logic-mirror validation for the loop-watcher (reconcileLoopNudgesLocked + sendLoop*Locked + ackLoopNudgeLocked).
// Mirrors the EXACT decision conditions in index.ts. The harness is a state-checker + nudger: it never
// changes task/loop state except advancing the loop's OWN phase to "executing" when the graph reopens
// (Design B: the graph owns the iteration; reopen = round executing). Cells:
//   (1) phase=planned & task done -> REOPEN nudge.
//   (2) not yet planned & no pending proposals (empty pool OR all replied) -> PLAN-NOW nudge.
//   (3) task left `done` -> auto-ack reopen + plan-now + KICKOFF nudges; advance phase -> executing.
//   (4) task done & phase=executing -> nothing (round just closed; kickoff will start the next).
// Run: node extensions/swarm/loop-reconcile.validate.mjs

let failures = 0;
function assert(c, m) { if (!c) { failures++; console.error("  FAIL:", m); } else console.log("  ok  ", m); }

// tasks: taskId -> { status, phase, round, pending }. env tracks resulting phases + nudges + acks.
function mkEnv() {
	const e = { messages: {}, seq: 0, phases: {} };
	const send = (e, key) => { if (Object.values(e.messages).some((r) => r.to === "orchestrator" && r.idempotencyKey === key)) return; e.messages[`m${++e.seq}`] = { to: "orchestrator", idempotencyKey: key, requiresAck: true, status: "delivered", ackedAt: null }; };
	const ack = (e, key) => { const rec = Object.values(e.messages).find((r) => r.to === "orchestrator" && r.idempotencyKey === key); if (rec && rec.requiresAck && !rec.ackedAt) { rec.status = "acked"; rec.ackedAt = Date.now(); } };
	e.reopenKey = (t, r) => `loop:${t}:round:${r}:nudge:reopen`;
	e.planNowKey = (t, r) => `loop:${t}:round:${r}:nudge:plan-now`;
	e.kickoffKey = (t, r) => `loop:${t}:round:${r}:nudge:orchestrator`;
	e.send = send; e.ack = ack;
	e.reconcile = (tasks) => {
		for (const t of tasks) {
			const { taskId, status, phase, round, pending } = t;
			const rk = e.reopenKey(taskId, round), pk = e.planNowKey(taskId, round), kk = e.kickoffKey(taskId, round);
			if (status !== "done") {
				ack(e, rk); ack(e, pk); ack(e, kk);
				e.phases[taskId] = (phase === "awaiting_plan" || phase === "collecting_proposals") ? "executing" : phase;
				continue;
			}
			e.phases[taskId] = phase;
			if (phase === "planned") { ack(e, pk); send(e, rk); }
			else if (phase === "executing") { /* nothing: round just closed; kickoff starts next */ }
			else { if (pending === 0) send(e, pk); }
		}
	};
	return e;
}
const count = (e, key) => Object.values(e.messages).filter((r) => r.to === "orchestrator" && r.idempotencyKey === key).length;
const isAcked = (e, key) => { const r = Object.values(e.messages).find((x) => x.idempotencyKey === key); return !!(r && r.ackedAt); };

// === Cell 1: REOPEN nudge ===
{ const e = mkEnv(); e.reconcile([{ taskId: "t1", status: "done", phase: "planned", round: 1, pending: 0 }]);
  assert(count(e, e.reopenKey("t1", 1)) === 1, "A: done+planned sends one reopen nudge"); }
{ const e = mkEnv(); for (let i = 0; i < 3; i++) e.reconcile([{ taskId: "t1", status: "done", phase: "planned", round: 1, pending: 0 }]);
  assert(count(e, e.reopenKey("t1", 1)) === 1, "B: repeated reconcile idempotent"); }

// === Cell 2: PLAN-NOW nudge (empty-pool dead-end fix) ===
{ const e = mkEnv(); e.reconcile([{ taskId: "t1", status: "done", phase: "awaiting_plan", round: 1, pending: 0 }]);
  assert(count(e, e.planNowKey("t1", 1)) === 1, "D: done+awaiting_plan+empty pool -> plan-now"); }
{ const e = mkEnv(); e.reconcile([{ taskId: "t1", status: "done", phase: "collecting_proposals", round: 1, pending: 2 }]);
  assert(count(e, e.planNowKey("t1", 1)) === 0, "E: collecting w/ pending -> no plan-now"); }
{ const e = mkEnv(); e.reconcile([{ taskId: "t1", status: "done", phase: "awaiting_plan", round: 1, pending: 0 }]);
  e.reconcile([{ taskId: "t1", status: "done", phase: "planned", round: 1, pending: 0 }]);
  assert(isAcked(e, e.planNowKey("t1", 1)), "G: phase->planned auto-acks plan-now");
  assert(count(e, e.reopenKey("t1", 1)) === 1, "G: phase->planned sends reopen"); }

// === Cell 3: task left done -> ack ALL nudges (incl kickoff) + advance phase to executing ===
{ const e = mkEnv();
  // simulate all three round-1 nudges already sent
  e.send(e, e.kickoffKey("t1", 1)); e.send(e, e.reopenKey("t1", 1)); e.send(e, e.planNowKey("t1", 1));
  e.reconcile([{ taskId: "t1", status: "in_progress", phase: "awaiting_plan", round: 1, pending: 0 }]);
  assert(isAcked(e, e.kickoffKey("t1", 1)), "J: kickoff nudge auto-acked when graph reopens");
  assert(isAcked(e, e.reopenKey("t1", 1)) && isAcked(e, e.planNowKey("t1", 1)), "J: reopen+plan-now also acked on reopen");
  assert(e.phases["t1"] === "executing", "J: phase advanced awaiting_plan -> executing on reopen");
}
{ const e = mkEnv();
  e.reconcile([{ taskId: "t1", status: "in_progress", phase: "planned", round: 1, pending: 0 }]);
  assert(e.phases["t1"] === "planned", "K: phase stays planned on reopen (already past mid-setup; not downgraded)");
}

// === Cell 4: task done + phase executing -> nothing (no spurious plan-now during kickoff race) ===
{ const e = mkEnv(); e.reconcile([{ taskId: "t1", status: "done", phase: "executing", round: 1, pending: 0 }]);
  assert(count(e, e.planNowKey("t1", 1)) === 0 && count(e, e.reopenKey("t1", 1)) === 0, "L: done+executing -> no nudges (kickoff will start next round)");
}

console.log(failures === 0 ? "\nALL PASS (loop-reconcile watcher: reopen + plan-now + executing cells)" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
