// audit.test.mjs — issue 84 coverage for trace audit, timelines, probes, rotation, invariants.
// Run: node extensions/swarm/audit.test.mjs
import { mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, readState, writeState, taskPaths, readTaskState, writeTaskState } from "../src/state.ts";
import { readAuditEvents, auditTimeline, checkInvariants, maybeRotateTraces, __test } from "../src/tools/audit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(tmpdir(), `swarm-audit-${process.pid}-${Date.now()}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const p = paths(scratch);
mkdirSync(p.traces, { recursive: true });
mkdirSync(p.tmuxTraces, { recursive: true });

let fail = 0;
const ok = (name, cond) => { if (cond) console.log(`  ok  ${name}`); else { fail++; console.error(`  FAIL ${name}`); } };

const ts = (offsetMs) => new Date(Date.UTC(2026, 8, 1, 0, 0, 0) + offsetMs).toISOString();

const st = await readState(p, scratch);
st.messages = {
  m1: { id: "m1", from: "orchestrator", to: "worker", status: "queued", createdAt: ts(0), updatedAt: ts(0), attempts: 0, requiresAck: true, queuedAt: ts(0), idempotencyKey: "k1" },
  m2: { id: "m2", from: "orchestrator", to: "worker", status: "dead_letter", createdAt: ts(-1000), updatedAt: ts(-1000), attempts: 2, requiresAck: true, failedAt: ts(-1000) },
  m3: { id: "m3", from: "orchestrator", to: "worker", status: "acked", createdAt: ts(-2000), updatedAt: ts(-2000), attempts: 1, requiresAck: true, ackedAt: ts(-2000), lastAck: { by: "worker", status: "done", at: ts(-2000) } },
  m4: { id: "m4", from: "orchestrator", to: "worker", status: "injected", createdAt: ts(-60 * 60 * 1000), updatedAt: ts(-60 * 60 * 1000), attempts: 1, requiresAck: true },
};
await writeState(p, st);

const taskId = "task-audit-1";
const tp = taskPaths(p, taskId);
mkdirSync(tp.root, { recursive: true });
const task = {
  version: 1,
  taskId,
  title: "Audit task",
  goal: "Exercise audit invariants",
  workflow: "feature-dev",
  allowedFiles: [],
  acceptanceCriteria: [],
  validationCommands: [],
  start: "commit",
  nodes: { commit: { status: "done", role: "orchestrator", dependsOn: [], messageIds: [] } },
  evidence: { commit: { status: "unverified", baseline: "b", head: "h" } },
  edges: [],
  gates: { gate1: { status: "waived" } },
  currentNodes: [],
  sharedContext: { summary: "", decisions: [], risks: [], openQuestions: [] },
  createdAt: ts(0),
  updatedAt: ts(0),
  status: "done",
};
await writeTaskState(tp, task);

appendFileSync(p.events, `${JSON.stringify({ ts: ts(10), event: "message.enqueue", messageId: "m1", id: "m1", taskId })}\n`);
appendFileSync(p.events, `${JSON.stringify({ ts: ts(20), event: "message.mailbox_only", id: "m1", to: "worker" })}\n`);
appendFileSync(p.events, `${JSON.stringify({ ts: ts(30), event: "message.deliver.ok", id: "m1", to: "worker" })}\n`);
appendFileSync(p.events, `${JSON.stringify({ ts: ts(40), event: "message.inject.probe", id: "m1", to: "worker", outcome: "success" })}\n`);
appendFileSync(p.events, `${JSON.stringify({ ts: ts(50), event: "message.ack", id: "m1", status: "done" })}\n`);
appendFileSync(p.events, `${JSON.stringify({ ts: ts(60), event: "message.response.verified", id: "m1" })}\n`);
appendFileSync(p.events, `${JSON.stringify({ ts: ts(70), event: "goal.nudge.emitted", goalId: "goal-1" })}\n`);
appendFileSync(p.events, `${JSON.stringify({ ts: ts(80), event: "goal.nudge.emitted", goalId: "goal-1" })}\n`);
appendFileSync(p.events, `${JSON.stringify({ ts: ts(90), event: "goal.nudge.emitted", goalId: "goal-1" })}\n`);
appendFileSync(p.events, `${JSON.stringify({ ts: ts(100), event: "goal.nudge.emitted", goalId: "goal-1" })}\n`);
appendFileSync(p.events, `${JSON.stringify({ ts: ts(110), event: "mailbox.orchestrator_pump_stuck_escalated", oldestWaitMs: 1234 })}\n`);
appendFileSync(p.events, `${JSON.stringify({ ts: ts(120), event: "mailbox.orchestrator_pump_stuck_escalated", oldestWaitMs: 2345 })}\n`);

ok("event filter matches prefix", (await readAuditEvents(p, { event: "message.", limit: 2 })).events.length === 2);
ok("event filter returns all matches under limit", (await readAuditEvents(p, { event: "goal.nudge.", limit: 10 })).events.length === 4);
ok("audit duration is measured", (await readAuditEvents(p, { event: "message.", limit: 1 })).durationMs >= 0);
ok("event filter matches agent/task", (await readAuditEvents(p, { task: taskId, limit: 5 })).events.some((e) => e.detail.taskId === taskId));

const timeline = await auditTimeline(p, "m1", {});
ok("timeline contains ordered stages", timeline.timeline.stages.map((s) => s.stage).join(",").includes("enqueue") && timeline.timeline.stages.map((s) => s.stage).includes("response_verified"));
ok("timeline duration is measured", timeline.durationMs >= 0);

const probes = __test;
ok("probe P1 flags old actionable", probes.probeP1(st, 1).some((r) => r.messageId === "m4"));
ok("probe P2 lists dead_letter", probes.probeP2(st).some((r) => r.messageId === "m2"));
ok("probe P3 coalesces epochs", probes.probeP3([{ event: "mailbox.orchestrator_pump_stuck_escalated", ts: ts(1), oldestWaitMs: 1 }, { event: "mailbox.orchestrator_pump_stuck_escalated", ts: ts(2), oldestWaitMs: 3 }]).length === 1);
ok("probe P4 flags burst", probes.probeP4([{ event: "goal.nudge.emitted", ts: ts(1), detail: { goalId: "goal-1" } }, { event: "goal.nudge.emitted", ts: ts(2), detail: { goalId: "goal-1" } }, { event: "goal.nudge.emitted", ts: ts(3), detail: { goalId: "goal-1" } }, { event: "goal.nudge.emitted", ts: ts(4), detail: { goalId: "goal-1" } }]).length === 1);
ok("probe P4 negative 2 in window stays quiet", probes.probeP4([{ event: "goal.nudge.emitted", ts: ts(1), detail: { goalId: "goal-2" } }, { event: "goal.nudge.emitted", ts: ts(2), detail: { goalId: "goal-2" } }]).length === 0);
ok("probe P4 negative 3 spread beyond window stays quiet", probes.probeP4([{ event: "goal.nudge.emitted", ts: ts(1), detail: { goalId: "goal-3" } }, { event: "goal.nudge.emitted", ts: ts(61_001), detail: { goalId: "goal-3" } }, { event: "goal.nudge.emitted", ts: ts(122_002), detail: { goalId: "goal-3" } }]).length === 0);

const inv = await checkInvariants(p, st);
ok("invariants flag seeded violations", inv.invariants.some((i) => i.violated && i.invariant === "INV1") && inv.invariants.some((i) => i.violated && i.invariant === "INV2") && inv.invariants.some((i) => i.violated && i.invariant === "INV3"));
ok("invariants duration is measured", inv.durationMs >= 0);
rmSync(tp.root, { recursive: true, force: true });
const clean = await readState(p, scratch);
clean.messages = { m1: { id: "m1", from: "orchestrator", to: "worker", status: "dead_letter", createdAt: ts(0), updatedAt: ts(0), attempts: 1, requiresAck: true, failedAt: ts(0) } };
await writeState(p, clean);
const invClean = await checkInvariants(p, clean);
ok("invariants clean state has zero violations", invClean.counts.violations === 0);

writeFileSync(join(p.traces, "tmux", "old.txt"), "old", "utf8");
writeFileSync(join(p.traces, "tmux", "new.txt"), "new", "utf8");
const old = join(p.traces, "tmux", "old.txt");
const newf = join(p.traces, "tmux", "new.txt");
const fs = await import("node:fs");
fs.utimesSync(old, new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), new Date(Date.now() - 5 * 24 * 60 * 60 * 1000));
const rot = await maybeRotateTraces(p, { rotateBytes: 1, retentionMs: 24 * 60 * 60 * 1000, keepGenerations: 2 });
ok("rotation ran", rot.rotated === true);
ok("rotation dropped old tmux capture", !fs.existsSync(old) && fs.existsSync(newf));
const rollup1 = JSON.parse(readFileSync(join(p.traces, "events.rollup.json"), "utf8"));
ok("rollup captures first generation", Array.isArray(rollup1.generations) && rollup1.generations.length === 1);
appendFileSync(p.events, `${JSON.stringify({ ts: ts(130), event: "message.enqueue", messageId: "m5", id: "m5", taskId })}\n`);
const rot2 = await maybeRotateTraces(p, { rotateBytes: 1, retentionMs: 24 * 60 * 60 * 1000, keepGenerations: 2 });
ok("second rotation ran", rot2.rotated === true);
const rollup2 = JSON.parse(readFileSync(join(p.traces, "events.rollup.json"), "utf8"));
ok("rollup is cumulative", Array.isArray(rollup2.generations) && rollup2.generations.length === 2);

rmSync(scratch, { recursive: true, force: true });
if (fail) { console.error(`\nAUDIT FAIL (${fail})`); process.exit(1); }
console.log("\nAUDIT PASS");
