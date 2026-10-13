# Fix Plan: self-nudge abort harm + post-abort status masking (2026-10-13 incident)

- **Incident**: workflow-agents root session `01a1241f`, worker `p9-deploy-nested-supervisor`, 2026-10-13 12:08:42–12:21:42 UTC (ms-level evidence in `.pi/swarm/traces/events.jsonl` + the worker's own session jsonl).
- **Reproduction (RED, already landed)**: `extensions/swarm/tests/self-nudge-abort-harm.test.mjs` — 4 FAIL map 1-1 to the two stacked bugs; 2 control cases GREEN (Issue-86 interrupt path for root/peer-origin directives stays armed); existing suites green (`high-priority-interrupt` 36/36, `update-failure-signals` 41/41).
- **Layers crossed**: `ctx.abort()` (L2 Pi queue), `pi.sendMessage` followUp/steer (L2), durable state (L1), status surface (L3/L4).

## 0. Root cause (two stacked bugs)

**Bug A — abort harm.** `nudges/update-failure.ts` emits the closure-class self-nudge with
`priority: "high"` and `from === to === worker`. `hooks/shutdown-input.ts` Issue-86 path
(`isHigh && midTurn`) then calls `ctx.abort()` on the worker's **in-flight turn**. But the
self-nudge exists to answer a question the model will see **in the same turn** — the failing
`swarm_update_task` toolResult (the very call that triggered the nudge) is already queued for
the model. Aborting beheads exactly the continuation that would act on the guidance. In the
incident the abort landed 40 ms after the toolResult; the beheaded turn was the report turn.

**Bug B — status masking.** After the abort: agent settles idle, `status` stays `"running"`
(record-level; pane alive), and `deriveTaskProgressState` predicate 5 (`lastToolAt ≤ 60s`)
reports `"active"` because `lastToolAt` was stamped by the failed `swarm_update_task` call
itself. No field anywhere records "this agent's turn was just aborted", so root reads
`why:"active"`, concludes "closure notice is task-graph noise", and does nothing. The worker
was woken 13 min later only by the unrelated 15-min taskless backstop.

**Bug B2 (wake, monitor-only in this plan).** The post-abort re-queue
(`pi.sendMessage(deliverAs:"followUp", triggerTurn:true)`) can lose the wake: followUp waits
for a turn boundary that never comes once the abort settles the agent. In the incident the
msg only surfaced at 12:21:42, after the unrelated backstop had already woken the pane. See
§7 for why this is deliberately out of scope here.

## 1. Non-goals

- No change to Issue-86 for **root/peer-origin** high directives (STOP etc.) — that is the
  20-min-stranded-message fix; the reproduction's control cases pin it.
- No change to `deriveTaskProgressState`'s existing predicates for the general case; only the
  post-abort masking window is addressed.
- No new timers, no new pump phases, no new tools/commands.
- No fix for the followUp wake-loss (B2) in this plan — only durable observability that makes
  the dead air provable (§7).

## 2. Fix A — self-nudges never interrupt (shutdown-input.ts)

**Claim being fixed (for §10 row):** "priority-high interrupt-on-delivery is safe for any
sender, including engine-generated self-nudges" — false; the guidance the self-nudge carries
is superseded by the failing toolResult already in the same turn, so the interrupt destroys
the turn that would act on it.

### Change

In `hooks/shutdown-input.ts`, before the Issue-86 `if (isHigh && midTurn)` block:

```ts
// Self-nudges (from === to) are engine-generated guidance about a failure the model
// will already see in this same turn (the failing toolResult triggered the nudge). The
// interrupt path exists for urgent directives from OTHER agents; applying it to a self-nudge
// aborts exactly the continuation that would act on the guidance (incident 2026-10-13:
// report turn beheaded 40ms after the TASK_NOT_FOUND result landed). Self-nudges therefore
// NEVER take the interrupt path: mid-turn → followUp (consumed at this turn's boundary),
// idle → steer (turn-triggering). NOTE: the input hook only fires for messages addressed to
// THIS agent, so from === to already implies from === me (review NIT: no redundant compare).
const isSelfNudge = msg.from === msg.to;
if (isHigh && midTurn && !isSelfNudge) {
```

The existing tail (line ~240) already does `deliverAs: ctx.isIdle() ? "steer" : "followUp"`
with `triggerTurn: true`, so a self-nudge falling through gets:
- **mid-turn**: followUp — consumed at the *current* turn's boundary (the turn the model is
  already in; pi queues it until tool calls finish). The guidance arrives right after the
  model reads the failing result. **This is the key win over abort**: no continuation is
  destroyed; the nudge rides the boundary pi already guarantees.
- **idle** (dangling done-in-head worker): steer + triggerTurn — wakes the pane the same way
  the 15-min taskless backstop eventually did, but immediately.

### Why this is minimal and safe

- `isSelfNudge` is computed from fields already present (`msg.from`, `msg.to`, `currentAgentId()`); no new state.
- Root pseudo-agent is unaffected (`me === "root"` never matches a worker self-nudge).
- The 30s rate-limit ledger is untouched (it sits inside the interrupt branch; self-nudges no
  longer reach it — desired: they no longer interrupt).
- Guarded ordering: the intercept bookkeeping (durable record, `message.input_intercept`
  trace) happens **before** this branch, so traces/state stay complete for self-nudges.

### Sub-finding A2 — classification honesty (update-failure.ts, reorder only)

The incident worker was **message-only** (no task graph): `swarm_update_task {taskId:"p9",
status:"failed"}` → `TASK_NOT_FOUND`. Today the terminal-intent check wins → `"closure"`, but
with empty `myActiveTaskIds` there is no node to dangle — the honest class is the existing
`"orphan"` (same IMMEDIATE self-nudge + root-notice semantics, better hint text).

**Reviewer BLOCKER fix (agy finding 1, verified):** the original draft reclassified ALL
terminal-intent failures with empty task lists — that breaks the existing matrix
(`update-failure-signals.test.mjs:67-71`: `{status:"done"}, INVALID_TRANSITION, []` → closure;
`{cancelTask:true}, CANCEL_FORBIDDEN, []` → closure). Correct change is a REORDER so the
TASK_NOT_FOUND-orphan rule runs FIRST (it is strictly more specific):

```ts
export function classifyUpdateFailure(params, errorCode, myActiveTaskIds) {
  // Most specific first: a TASK_NOT_FOUND on a worker holding no tasks means there is no net
  // at all — terminal intent cannot dangle a node that does not exist (incident 2026-10-13:
  // message-only deploy worker guessed taskId "p9", status failed). Orphan keeps the same
  // IMMEDIATE notify semantics with the honest "no task graph is tracking you" hint.
  if (errorCode === "TASK_NOT_FOUND" && myActiveTaskIds.length === 0) return "orphan";
  if (params?.cancelTask === true || TERMINAL_INTENT_STATUSES.has(String(params?.status ?? ""))) return "closure";
  return "work";
}
```

Existing matrix rows stay green (they use non-TASK_NOT_FOUND codes for the closure rows;
the `TASK_NOT_FOUND + no held tasks → orphan` row has no terminal intent). NEW matrix rows
to add: `{status:"failed"}, TASK_NOT_FOUND, []` → orphan (the incident shape);
`{status:"done"}, TASK_NOT_FOUND, ["t1"]` → closure (held task + terminal intent even on
TASK_NOT_FOUND stays closure — a real node may dangle).

## 3. Fix B — post-abort visibility (3 small pieces)

### B1. Stamp the interrupt on the agent record (durable)

In `shutdown-input.ts`, inside the `interruptEffective` success branch (and in the degrade
path where `ctx.abort()` threw — stamp with `degraded:true`? **No**: only stamp when
effective; a failed abort left the turn running, stamping would lie):

```ts
if (interruptEffective) {
  await withLock(p, async () => {
    const st2 = await readState(p);
    const self2 = st2.agents[me];
    if (self2) {
      self2.lastInterruptAt = now();   // additive optional field on SwarmAgent
      self2.updatedAt = now();
    }
    await writeState(p, st2);
  });
}
```

**Reviewer MAJOR fix (agy finding 3, verified):** `lastHighInterruptAt` ALREADY exists
(`types/agents.ts:46`) and is stamped by the rate-limit ledger BEFORE `ctx.abort()` — i.e. it
records the ATTEMPT, even when the abort fails. `lastInterruptAt` records the EFFECTIVE
interrupt. Keep both but make the contract explicit in `types/agents.ts` comments:
`lastHighInterruptAt` = rate-limit ledger (attempt time, may precede a failed abort);
`lastInterruptAt` = effective interrupt (stamped only when `ctx.abort()` resolved).
Derive/status consumers read ONLY `lastInterruptAt`. The double lock is inherent to the
sequencing (ledger must stamp before the abort decision; effectiveness is only known after)
and mirrors the existing pattern two blocks above — sequential, never nested. Additive
optional field, no migration (absent = never effectively interrupted).

R10-1 note: no new `pi.sendMessage` / `ctx.abort` call sites — B1 adds one durable state
write inside the *existing* interrupt-success branch.

### B2. Surface it in `swarm_agent_status` rows

`tools/agents/status.ts` row rendering: include `interruptedAgo` (compact seconds/minutes)
whenever `lastInterruptAt` is present and < 10 min old — same style as `heartbeatAge` /
`settledAge`. Also flip the headline `why` to `"turn aborted <N>s ago"` when
`runtimeStatus === "idle"` AND `lastInterruptAt` < 60s old — the exact window where the
incident's root was misled. Beyond 60s the existing `why` logic stands (lastToolAt window
closes; honest states resume).

### B3. Predicate honesty in `deriveTaskProgressState` (agents.ts)

Add one clause to predicate 5 (the `"active"` fallthrough): a fresh `lastInterruptAt` (< 60s)
with `runtimeStatus !== "busy" && !== "tool_running"` must NOT derive `"active"`, falling
through to `awaiting_input` instead — the agent's turn was externally terminated; "active"
would repeat the incident's masking:

```ts
// 5) active: ... — but a tool executed BEFORE an effective interrupt cannot evidence a
// healthy active worker: the interrupt killed the turn that tool belonged to. Order by time,
// not a blanket window (review MINOR fix, agy finding 4): if lastToolAt > lastInterruptAt a
// NEW turn ran tools after the abort — the agent is genuinely alive again and must derive
// normally.
const interruptMs = agent.lastInterruptAt ? new Date(agent.lastInterruptAt).getTime() : 0;
const interruptedAfterLastTool = interruptMs > 0 && interruptMs <= nowMs &&
  interruptMs <= ACTIVE_LAST_TOOL_MS + nowMs /* fresh */ && (!lastToolMs || interruptMs >= lastToolMs);
if (interruptedAfterLastTool) return "awaiting_input";
if (lastToolMs && nowMs - lastToolMs <= ACTIVE_LAST_TOOL_MS) return "active";
```

(Implementation note: express "fresh" as `nowMs - interruptMs <= ACTIVE_LAST_TOOL_MS` — the
sketch above is for ordering intent.) The runtimeStatus guard from the original draft is
DROPPED — timestamp ordering subsumes it: busy/tool_running with a post-interrupt tool run
has lastToolAt > interruptMs and falls through correctly.

`agent-status-derive.test.mjs` (exhaustive, 6 states + exclusivity) gains rows:
interrupt 5s ago + lastToolAt 10s ago (pre-abort tool) + idle → awaiting_input (not active);
interrupt 30s ago + lastToolAt 10s ago (post-abort tool in a new turn) → active allowed;
interrupt > 60s ago → unchanged; busy + fresh interrupt + post-interrupt lastToolAt →
unchanged (honest: a new turn is running).

## 4. Mock-llm fixture (mandatory per AGENTS.md)

`extensions/mock-llm/fixtures/self-nudge-abort-harm.jsonl` — Pattern 2 (seeded world +
single actor), extending the existing `update-failure-signals.jsonl` recipe:

- **Seed**: worker `self-nudge-lane` running/busy, NO task graph (incident shape), message
  history empty.
- **Turn 0**: toolcall `swarm_update_task {taskId:"ghost", nodeId:"deploy", status:"failed"}`
  → engine emits the self-nudge (real chain: classify → deliverMessageLocked → intercept →
  followUp). Fixture asserts via the transcript that NO `ctx.abort` boundary is crossed and
  the followUp queues.
- **Turn 1**: scripted response to the surfaced guidance: `swarm_send_message(to:"root")` —
  the report the incident's worker was robbed of.
- **Turn 2**: stop.
- **Validation lane** (tmux, per extension flow): `pi --provider mock-llm --model
  self-nudge-abort-harm -e ./extensions/mock-llm -e ./extensions/swarm`; assert transcript
  ordering + events.jsonl shows zero `message.interrupt_requested` and one report to root.

## 5. Contract + docs (mandatory)

- `pi-runtime-contract.md §10`: new F-row — claim "priority-high interrupt-on-delivery is
  safe for any sender including engine-generated self-nudges" / status "post-abort agents
  read as active with no interrupt trace" → FIXED with pointer to this plan + tests.
- `docs/swarm/operations.md`: incident entry (symptom → evidence → fix) in the R-rows style.
- CHANGELOG.md: `fix` entry.

## 6. Test matrix (all red→green off the landed reproduction)

| Test | Asserts | Suite |
|---|---|---|
| self-nudge mid-turn → 0 abort + followUp delivered + durable record | Fix A | `self-nudge-abort-harm.test.mjs` A |
| self-nudge normal-priority mid-turn → followUp (control) | Fix A control | same (add) |
| root/peer STOP mid-turn → abort stays 1 | non-regression | same, A-ctrl/A-ctrl2 |
| root STOP mid-turn → abort=1 + waitForIdle awaited + steer delivery | Fix C | same (add C section) |
| waitForIdle throws/bounded-timeout → degrade followUp + errorlog row | Fix C degrade | same (add) |
| self-nudge idle → steer, 0 abort, durable record | Fix A idle leg | same, A2 |
| `{status:failed}, TASK_NOT_FOUND, []` → `orphan`; `{status:done}, TASK_NOT_FOUND, ["t1"]` → `closure` | A2 reorder | `update-failure-signals.test.mjs` new rows |
| existing closure matrix rows unchanged (INVALID_TRANSITION/CANCEL_FORBIDDEN + []) | A2 non-regression | same existing rows |
| interrupt success stamps `lastInterruptAt`; ledger `lastHighInterruptAt` documented as attempt-time | B1 | `self-nudge-abort-harm.test.mjs` B |
| interrupt 5s ago + pre-abort lastToolAt + idle → `awaiting_input` | B3 ordering | same B + `agent-status-derive.test.mjs` |
| interrupt 30s ago + post-abort lastToolAt (new turn ran) → `active` allowed | B3 anti-mask | `agent-status-derive.test.mjs` |
| mock-llm lane: no abort boundary, followUp consumed, report lands | end-to-end | §4 lane |

## 7. Wake-loss after abort — PROMOTED INTO SCOPE (review MAJOR fix, agy finding 2)

The original draft deferred the followUp wake-loss. The reviewer correctly rejected the
deferral: the SAME incident proved that `pi.sendMessage(followUp, triggerTurn:true)` fired
immediately after `ctx.abort()` loses the wake (13-minute dead air). Fix A closes the
self-nudge path, but **root/peer STOP mid-turn still takes the abort path** — and would hit
the identical hang: worker aborted, STOP queued as followUp, no turn boundary ever comes,
the urgent directive sits unconsumed. That regresses the very incident (2026-08-31 stranded
STOP) Issue-86 was built to fix.

### Fix C — guaranteed post-abort wake (shutdown-input.ts, interrupt branch tail)

Contract §5 footgun 1 states the remedy explicitly: "`ctx.abort()` is synchronous; to know
the abort was honoured, listen for `agent_end` + `agent_settled` or call `ctx.waitForIdle()`".
So the interrupt branch becomes:

```ts
if (interruptEffective) {
  await trace(p, "message.interrupt_effective", {...}).catch(() => {});
  // Guarantee the directive survives the abort we just caused: wait for the aborted turn to
  // settle, then deliver as steer — "Send now" when idle — so the STOP is consumed by the
  // turn it triggers. followUp-then-pray is exactly the 13-minute dead-air path (incident
  // 2026-10-13); waitForIdle is the contract-blessed boundary (§5.1).
  try {
    await ctx.waitForIdle();
    deliveryMode = "steer";
  } catch (err) {
    await logSwarmError(p, "shutdown-input", "wait_for_idle_failed", err, { id: msg.id, to: msg.to });
    deliveryMode = "followUp"; // graceful degrade: same as today, but now durably logged
  }
} else {
  deliveryMode = "followUp";
}
pi.sendMessage({ ... }, { triggerTurn: true, deliverAs: deliveryMode });
```

(Evidence note: `ctx.waitForIdle(): Promise<void>` exists at `dist/core/extensions/types.d.ts:290`;
the contract §5.1 recommendation to call it after `ctx.abort()` is currently `[INFERRED]` — the
mock-llm lane in §4 MUST include a wake probe asserting steer-after-idle actually triggers the
consuming turn, and the §10 row updates the evidence tag accordingly.)

- **steer while idle** = "Send now" + `triggerTurn:true` wakes the agent (contract §3) — the
  STOP is consumed by the very next turn instead of waiting for an external backstop.
- `ctx.waitForIdle()` failure degrades to today's followUp behavior — but durably recorded
  (`errors.jsonl`), no silent swallow.
- R10-1: this changes ZERO boundary counts (same one `pi.sendMessage`, same one `ctx.abort`);
  it only selects a different `deliverAs` value post-idle. New test asserts the boundary
  shape: abort=1, waitForIdle awaited exactly once, sendMessage deliverAs="steer",
  triggerTurn=true.
- Edge: queued continuation/auto-compaction (§4) — `waitForIdle()` is false-idle during
  those, so we block until genuine settle; the steer then triggers the consuming turn.
  Timeout safety: wrap with a bounded race (e.g. 10s) so a pathological hang degrades to
  followUp + errorlog rather than stalling the input hook; exact bound decided at impl with a
  test pinning the degrade path.

## 8. Risk review

- **Could suppressing the abort for self-nudges strand a high-priority engine directive?**
  No: engine self-nudges are advisory ("report via swarm_send_message"); the only *urgent*
  engine→worker channel is root's STOP (peer-origin, still interrupts — and now with Fix C,
  with a guaranteed wake instead of the 13-minute dead air).
- **FollowUp consumed mid-turn?** If the turn errors before another tool call, the queued
  followUp rides to the settle boundary; reconcile/idle-watchdog steer re-injects undelivered
  rows (existing durable mailbox semantics) — strictly better than the abort path, which
  destroyed the turn outright (reviewer Q1 residual risk, accepted and observable).
- **Rate-limit ledger interplay**: self-nudges skip the ledger (they no longer reach that
  branch). A closure-storm of self-nudges is already capped by the idempotency dedupe per
  (agent,task,node,class) + root-notice cooldown/cap in `update-failure.ts`.
- **`lastInterruptAt` growth**: one optional timestamp field; the 60s/10min windows keep it
  from ever masking long-lived states; no migration needed.
- **Fixture determinism**: Pattern 2 (seeded world) — no cross-process timing races.
