# Pi runtime contract (swarm engineering)

> **Provenance:** Citations derived from `@earendil-works/pi-coding-agent` v0.83.0 installed at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/`. Verified at commit `5b90e281d4e0c8fbd6ca4d8358276fb305b8d0bd` on 2026-09-02. To re-verify after a Pi upgrade: run the rg probes in [`docs/swarm/pi-runtime-evidence.md §13`](./pi-runtime-evidence.md#13-reproducing-this-artifact).
>
> **Read order for contributors:** this contract doc is the *normative* source of truth. The companion [`pi-runtime-evidence.md`](./pi-runtime-evidence.md) is the *raw citation artifact* with `[VERIFIED]` / `[INFERRED]` / `[GAP]` labels and reproduction commands. Every claim below cites a section in the evidence artifact.
>
> **Uncertainty labels (same as evidence file):** `[VERIFIED evidence §X.Y]` = direct quote from cited source; `[INFERRED evidence §X.Y]` = derived from combining citations; `[GAP evidence §11.N]` = no source found, claim recorded as unproven assumption.

---

## 1. The four layers

Every swarm message that crosses the swarm ↔ Pi boundary crosses **four independent layers**. R13–R15 exposed failures at those boundaries; **R12 was a separate swarm-internal worker-eligibility bug** in `sweepTaskWorkersLocked`, not a Pi-runtime delivery or lifecycle incident. The four-layer model is the single most important artifact in this contract for the Pi-facing rows.

| Layer | Swarm-owned? | Pi guarantees? | Verifiable at the... |
|-------|--------------|----------------|----------------------|
| **L1 Durable mailbox state** | YES (`.pi/swarm/mailboxes/<agentId>.jsonl` + `swarm-state.json` `messages` ledger) | NO | `withLock` boundary at `src/mailbox.ts` |
| **L2 Pi queue acceptance** | NO | `void` return; may throw synchronously on stale ctx [VERIFIED evidence §1.1, §2.2] | `pi.sendMessage` / `pi.sendUserMessage` call site |
| **L3 Visible surface (TUI render)** | NO | `ctx.ui.notify`, `setWidget`, `setStatus`, `setFooter` [VERIFIED evidence §7 / §8] | `pi.ui.*` call site |
| **L4 LLM consumption** | NO | "Custom messages participate in LLM context" [VERIFIED evidence §2] | next assistant turn's `context` |

Between L1 and L2 is the **swarm→Pi bridge**. Between L2 and L3 is the **Pi internal queue/render path**. Between L3 and L4 is the **Pi→LLM model call**. Each crossing is asynchronous; none is guaranteed within a bounded time. Swarm must never conflate a layer with its neighbour:

- A mailbox entry that exists at L1 is **not** a Pi queue entry at L2 until `pi.sendMessage` has been called.
- A `pi.sendMessage` call that returns `void` synchronously is **not** a TUI-visible surface at L3.
- A visible TUI notification at L3 is **not** an LLM-consumed context at L4 until the next assistant turn reads it.

This is the **R15 false-promise shape** (FIXED 2026-09-02 via R15 B1 — the literal `"its pump surfaces mailbox messages within ~5s"` was removed from `extensions/swarm/src/tools/messages.ts:42-48`; see §10 R15 row and roadmap Row R15 for evidence): the root's pump conflates L1 → L3, and there is no time-bound surface guarantee. The root's own `agent_settled` or its next idle watchdog tick is the only legitimate surface path.

---

## 2. `pi.sendMessage` vs `pi.sendUserMessage` (three API shapes)

There are **three API shapes** swarm code may encounter, with subtly different semantics. Conflating them is the F1 footgun.

| # | Surface | Return | Context |
|---|---------|--------|---------|
| 1 | `pi.sendMessage` / `pi.sendUserMessage` | `void` (fire-and-forget) | ExtensionAPI passed to extension factories [VERIFIED evidence §1.1] |
| 2 | `ReplacedSessionContext.sendMessage` / `sendUserMessage` | `Promise<void>` | Only valid handle inside `withSession()` after `newSession` / `switchSession` / `fork` [VERIFIED evidence §1.3] |
| 3 | `AgentSession.sendUserMessage` | `Promise<void>` | SDK layer; **errors on extension commands** [VERIFIED evidence §1.2] |

**Swarm footgun (F1, verified):** `await pi.sendMessage(...)` is a **no-op await** — it resolves on the same tick. Failure surfaces asynchronously as `runner.emitError({ event: "send_message" })`. [VERIFIED evidence §1.1]. Swarm extensions must standardise on fire-and-forget for `pi.*` calls and await only the SDK-layer equivalents. [INFERRED evidence §2.2]

The custom vs user split:

| Aspect | `pi.sendMessage` (custom) | `pi.sendUserMessage` (user) |
|--------|---------------------------|----------------------------|
| LLM context? | Yes (`role: custom`, `customType`) | Yes (`role: user`) |
| Triggers a turn? | Only if `triggerTurn: true` AND idle | Always |
| TUI display? | Via `pi.registerMessageRenderer(customType, ...)` | Always |
| Persisted to session? | Yes | Yes |
| Visible to swarm mailbox? | **No** (session-internal) | **No** (session-internal) |

[VERIFIED evidence §2]

---

## 3. `deliverAs` matrix

From [VERIFIED evidence §2.1]:

| Mode | Idle | Streaming | Trigger turn |
|------|------|-----------|--------------|
| `steer` (default) | Send now | Queue for after current assistant turn's tool calls, **before next LLM call** | Yes (with `triggerTurn: true`) |
| `followUp` | Send now | Queue until agent has **no more tool calls** | Yes (with `triggerTurn: true`) |
| `nextTurn` | Queued for next user prompt; **never** interrupts | Queued for next user prompt; never interrupts | **No** (ignored) |

`nextTurn` only exists on `pi.sendMessage`. `pi.sendUserMessage` accepts only `steer` | `followUp`. [VERIFIED evidence §2.1]

> **Swarm footgun (F3 / R15, FIXED 2026-09-02):** The swarm MUST NOT promise a time-bound user-visible surface based on `followUp` or `nextTurn`. The root's pump cannot guarantee any specific delay; `agent_settled` is a lifecycle condition, not a time bound. **R15 B1 fix:** the literal `"~5s"` text in `extensions/swarm/src/tools/messages.ts:42-48` was removed; the honest durable-no-time-bound text now reports "surfaces when the root's own agent_settled fires or its next idle watchdog tick processes the mailbox". Section §3 surfaces this footgun before any contributor writes a sleep/retry.

---

## 4. Idle / streaming / pending (gate machinery)

Distilled from [VERIFIED evidence §3]. The R13–R15 Pi-facing incidents hinge on **distinguishing `isIdle()` from `agent_settled`**; R12 is a separate swarm-internal eligibility-logic incident:

| Signal | Meaning |
|--------|---------|
| `ctx.isIdle() === true` | Not currently processing an agent run. **NOT** "Pi will not auto-continue" — it is `false` during auto-compaction retry and queued continuation. [VERIFIED evidence §3.1, F4] |
| `ctx.isIdle() === false` | Mid-turn (LLM call or tool execution) OR queued continuation OR auto-compaction retry |
| `ctx.hasPendingMessages() === true` | A follow-up is queued; an immediate turn is imminent. [VERIFIED evidence §3.2] |
| `agent_end` | Current assistant turn ended; **NOT** end of work — auto-retry, auto-compaction retry, and queued follow-ups may still execute. [VERIFIED evidence §6] |
| `agent_settled` | Canonical "no automatic continuation will run" boundary. [VERIFIED evidence §6, F7] |

**Swarm contract:** for status integrations and pump surfaces, use `agent_settled`, not `agent_end`. The R13 P1 fix relies on this distinction (liveness gate vs surface gate are different problems with different boundaries).

---

## 5. `ctx.abort()` / `ctx.signal` / `ctx.shutdown()` / `ctx.reload()`

Three footguns to call out by name:

1. **`ctx.abort()` is synchronous (`void`)** [VERIFIED evidence §4.1]. It does NOT await idle. To know the abort was honoured, listen for `agent_end` + `agent_settled` or call `ctx.waitForIdle()` afterwards.
2. **`ctx.signal` is `undefined` outside active turn events** [VERIFIED evidence §3.3, F5]. Background work captured at `session_start` has no real abort signal. Thread `ctx.signal` into any `fetch` / subprocess started inside `tool_result` or `message_update` handlers.
3. **`ctx.reload()` runs the post-reload code on the pre-reload instance** [VERIFIED evidence §4.3, F6]. In-memory maps die; mailboxes survive (file-backed JSONL). Captured `pi` / `ctx` become stale — see §6.

---

## 6. Session replacement lifecycle (F6)

[VERIFIED evidence §1.3 + §4.4]. The session replacement order:

```
session_before_switch / _fork / _compact  (cancellable)
        ↓
session_shutdown   (old extension instance torn down)
        ↓
new session rebound
        ↓
session_start      (new extension instance receives this)
        ↓
withSession(ctx)   (ctx is a fresh ReplacedSessionContext)
```

**Swarm contract:** inside `withSession()`, the `ctx` parameter is the only safe handle to the new session. Captured old `pi`, `ctx.sessionManager`, and tool handles all become stale after the await and will throw on use. The runner throws `"This extension ctx is stale..."` (`runner.js:352`). [VERIFIED evidence §4.4, F6]

---

## 7. Input interception and `event.source`

[VERIFIED evidence §5]. The single critical marker:

- `event.source === "extension"` is set when swarm injected the message via `pi.sendUserMessage`.
- `event.source === "interactive"` is a typed user prompt.
- `event.source === "rpc"` is from the API.

Swarm autoparse / extension intercept code MUST check this to avoid double-processing its own injections. The `input` event fires **after** extension command lookup but **before** skill/template expansion; first handler to return `{ action: "handled" }` wins.

`streamingBehavior` is `undefined` when idle, `"steer"` for mid-stream interrupts, `"followUp"` for messages queued until the agent finishes.

---

## 8. Lifecycle hook order

Canonical diagram from [VERIFIED evidence §6 / `docs/extensions.md` ~line 295]:

```
session_start { reason } → resources_discover { reason }
   ↓
user prompt
   ├─ extension command (intercept or run)
   ├─ input (intercept / transform / handle)
   ├─ skill/template expansion (if not handled)
   ├─ before_agent_start (inject message, modify system prompt)
   ├─ agent_start
   ├─ turn_start → context → before_provider_headers → before_provider_request
   │              → after_provider_response → (tool calls loop) → turn_end
   └─ agent_end → agent_settled
```

`session_before_switch` / `session_before_fork` / `session_before_compact` all gate the corresponding transitions and can return `{ cancel: true }`.

This section is intentionally short — the contract doc is not a re-statement of the Pi docs. For full hook contracts see `docs/extensions.md`.

---

## 9. Error handling (F8 footgun)

From [VERIFIED evidence §7]:

> "Returning a value never sets the error flag regardless of what properties you include in the return object." [VERIFIED `docs/extensions.md` ~line 1900]

**Swarm contract:** tool errors are signaled by **`throw` only**. Returning `{ isError: true, content: ... }` is a silent no-op for the LLM — the failure is logged and the agent continues as if the tool succeeded.

Extension errors (e.g. `tool_call` that throws) are logged, agent continues. `tool_call` errors block the tool (fail-safe) [VERIFIED].

---

## 10. R12–R16 false / unproven claims register

**This is the load-bearing section for the contract's purpose.** Every false or unproven claim surfaced by the R13–R15 Pi-facing incidents is named here with source line, severity, and citation. R12's shared-worker-pool mass sweep is documented in the reliability roadmap as a swarm-internal eligibility-logic bug; it is deliberately not attributed to a Pi runtime surface here.

| # | Claim | Where in code | R-row | Severity | Citation |
|---|-------|---------------|-------|----------|----------|
| **F3** | "Mailbox-only delivery to unknown-target root surfaces within ~5s" | `extensions/swarm/src/tools/messages.ts:42-48` (literal text `"its pump surfaces mailbox messages within ~5s"`) | **R15** | **CRITICAL** | [VERIFIED evidence §1.1 + §10 / auditor F3] — **FIXED 2026-09-02 (R15 B1)**: literal removed; honest durable-no-time-bound text; see roadmap Row R15 |
| **F2** | Root `tmuxTarget === "unknown"` is exceptional | (incorrect framing in R13 narrative; factually true in code: `identity.ts:67-69, 80, 106`) | **R13** | High | [VERIFIED evidence §1.1 + identity.ts:67-69,80,106, auditor F2] |
| **F1** | `await pi.sendMessage(...)` waits for delivery | (pattern, not a literal line; agents-session.js:1846-1852 wrapper drops the promise) | **R13, R15** | High | [VERIFIED evidence §1.1, agent-session.js:1846-1852, auditor F1] |
| **F4** | `agent_busy` only fires on user-tool busy | reconcile.ts busy-suppression gate | **R13 P1, R14** | Medium | [VERIFIED evidence §3.1, auditor F4] |
| **F5** | Captured `ctx.signal` is always defined outside turn events | (background timers + module-load captures) | Lifecycle | Medium | [VERIFIED evidence §3.3, auditor F5] |
| **F9** | `turn_end{stop}` is always a goal-resolve signal | hooks.ts:524-549 (pre-R16) | **R16** | High | **FIXED 2026-09-02 (R16 Fix A)**: `turnEndIsResolveAction(event)` gates the reset on a swarm tool call (swarm_spawn_agent / swarm_assign_task / swarm_mark_goal_done / swarm_set_goal / swarm_restart_agent / swarm_send_message / swarm_reconcile / swarm_update_task / swarm_create_task / swarm_stop_agent / swarm_release_agent_task). Pure ack text emits `goal.nudge.turn_no_resolve_action` (new trace) instead. See roadmap Row R16 + operations.md R16. |
| **F10** | Vacuous-branch dedupe/cooldown flags persist on their own | reconcile.ts:516-595 (pre-R16: only via pump tail writeState) | **R16** | High | **FIXED 2026-09-02 (R16 Fix B)**: explicit `writeState(p, st)` at the end of the vacuous branch; `state.ts:141-149` back-fill for legacy swarm-state.json with non-object `idleNudgeState`. See roadmap Row R16 + operations.md R16. |
| **F6** | Captured `pi`/`ctx` valid after reload / newSession / switch / fork | (background timers + module-load captures) | Lifecycle | Medium | [VERIFIED evidence §4.3 + §4.4, runner.js:352, auditor F6] |
| **F7** | `agent_end` is the "surface after fully idle" boundary | (not literal code, but hook-level) | **R13 P1** | Low | [VERIFIED evidence §6, auditor F7] |
| **F8** | `nextTurn` + `triggerTurn: true` starts a turn | (any swarm code using `nextTurn` for nudges) | **R13, R15** | Low | [VERIFIED evidence §2.1, auditor F8] |
| **F11** | The goal idle nudge is conditional on no actionable graph work | `extensions/swarm/src/reconcile.ts:670-678` (pre-R19: full block via `goal.nudge.suppressed_by_actionable_graph`) | **R19** | **HIGH** | **FIXED 2026-09-02 (R19 Fix A + Fix B)**: goal floor is now unconditional — `hasActionableGraphWork` only defers the goal nudge by one interval and enriches the body with a hint; terminal/abandoned tasks (`failed`/`cancelled`/`blocked`) are excluded from the graph scan so orphan rework nodes can no longer permanently silence the floor. See roadmap Row R19 + operations.md R19. R10-1 boundary counters: C-R19-1 (`goal.idle_nudge` trace), C-R19-2 (`goal.nudge.deferred_by_actionable_graph` trace), C-R19-3 (LIVE-task suppression retained), C-R19-4 (mailbox durable append), C-R19-5 (`hasActionableGraphWork` return value), C-R19-6 (`pi.sendMessage` pump loop), C-R19-7/8 (`consecutiveNoResolveNudges`/`nudgeSeq` state mutations), C-R19-9 (`nextGoalNudgeAt` bounded), C-R19-10 (scan call count). |
| **F12** | "Agent artifact writes imply task progress" — i.e., the swarm assumed `fs.stat` mtime on `allowedFiles` was either irrelevant or already handled | (system-wide assumption; pre-R20 the swarm-extension had no artifact-progress detector and depended on the root's stale-open surface) | **R20** | **HIGH** | **FIXED 2026-09-02 (R20)**: new `evaluateArtifactProgressNudgeLocked` pump-tick phase scans `node.allowedFiles` (capped at 50 files/node), detects fresh mtime > `max(lastProgressAt, artifactProgressNudgeAt) + ARTIFACT_PROGRESS_GRACE_MS`, and delivers a high-priority action-oriented nudge to the AGENT (not the root) naming the exact close-action triple (`swarm_update_task` + `swarm_send_message replyTo` + `swarm_ack_message`). Backoff 5min, cap 3, then `worker.artifact_progress_cap_exceeded` escalation to the root. See roadmap Row R20 + operations.md R20. R10-1 boundary counters: C-R20-1 (`worker.artifact_progress_no_status_update` trace), C-R20-2 (`worker.artifact_progress_cap_exceeded` trace), C-R20-3 (durable mailbox append), C-R20-4 (fs.stat allowedFiles cap=50/node), C-R20-5/6 (`node.artifactProgressNudgeAt`/`Count` mutations), C-R20-7 (`writeState` after nudge), C-R20-8 (body contains the close-action triple). |
| **F13** | "Surface-time revalidation (`staleSurfaceReason`) agrees with emission-time gating" | `extensions/swarm/src/reconcile.ts` goal-key branch (`staleSurfaceReason`, root_pump.surface) | **R21** | **HIGH** | **FIXED 2026-09-02 (R21)**: the goal-key branch now excludes terminal/abandoned tasks from `liveGraphActionable`, so a failed/cancelled/blocked task carrying an orphan `ready` node can no longer suppress already-emitted goal nudges at surface time. The live incident was 2026-09-02 10:31–10:33: messages `aa033e3c` / `b689bff4` / `99aef9a2` were emitted + mailbox_delivered, then suppressed at `site=root_pump.surface reason=actionable_graph` by the orphan node on `task-202609020536`. R19 Fix B parity now holds at surface time too. See roadmap Row R21 + `extensions/swarm/r21-goal-surface-suppression.test.mjs`. |
| **F14** | "The goal-key surface revalidation may re-check worker busy-ness (`agent_busy`) even though emission already required all-idle" | `extensions/swarm/src/reconcile.ts` `staleSurfaceReason()` goal-key branch, `!liveIdle → agent_busy` leg (pre-R22) | **R22** | **HIGH** | **FIXED 2026-09-02 (R22)**: the `agent_busy` leg is removed from the goal-key branch. Emission (`evaluateIdleGoalNudgeLocked`) already gated on `allEffectiveIdleAgents().allIdle`; re-checking it at surface time starved every queued goal nudge the moment a worker turned busy (the nudge's requested action succeeding). Live incident 2026-09-02T12:04:08Z: 3 nudges (`msg-1788350616129-691b4e7c` / `-0aea3216` / `-c6f752b8`) suppressed 26+ min, `root_pump_stuck_escalated` every tick with an empty surface set, ZERO `pi.sendMessage` at the pump boundary, `consecutiveNoResolveNudges` burned to max on unseen messages. Remaining legs: `idle_epoch_advanced` (anti-immortality) + `liveGraphActionable` on LIVE tasks (F13/C-R21-3). TaskKey busy suppression and the emission-time R10 storm gate are untouched. R10-1 boundary counters C-R22-1..8 (real `pi.sendMessage` via `pumpRootMailbox` ≥1, triggerTurn, coalescing, replay dedupe, suppression census, C1/C2/C3 controls). See roadmap Row R22 + operations.md R22 + `extensions/swarm/idle-nudge.test.mjs` R22 section. |
| **F15** | "Goal cap+backoff saturation carries across an all-idle epoch boundary even when the prior epoch's nudges were invalidated (idle_epoch_advanced) and no root turn_end resolve could fire while the floor was starved" | `extensions/swarm/src/reconcile.ts` — `evaluateIdleGoalNudgeLocked` cap branch (`max_nudges` re-arm, pre-R23) + `updateIdleEpochLocked` epoch edge | **R23** | **HIGH** | **FIXED 2026-09-02 (R23) → AMENDED 2026-09-02 (R23B) → AMENDED 2026-09-03 (R23C)**: R23 added the cap-branch reset (once per anchor via `r23LastEpochAnchor` memo) AND an edge-site reset inside `updateIdleEpochLocked`. The edge site never consulted the memo, so it fired on EVERY busy→idle edge while saturated, defeating MAX+backoff in real sessions where `agent_settled` re-stamps the anchor at every root turn boundary. Live storm: implementer lane 2026-09-02T15:19:06..15:21:46Z — `goal.nudge.saturation_reset_on_epoch` ×12, `goal.idle_nudge` seq 4→38, `mailbox.root_pump_stuck_escalated` ×34. R23B deletes the edge-site reset (cap branch is now the SOLE reset site) and adds a worker-breaker guard on the cap branch: `idleState.lastEpochBusyAgents?.some(id => id !== "root")` (stamped on every anchor-clearing busy edge, cleared on the busy→idle edge). R23C anchors provenance at EVERY clear site: `hooks.ts turn_start` now stamps `lastEpochBusyAgents = ["root"]` before clearing the anchor (the root's busy edge bypassing `updateIdleEpochLocked`); `reconcile.ts` mint branch now PRESERVES (does not clear) `lastEpochBusyAgents` so the breaker survives from the clear site to the next atCap eval. Without R23C the cap branch's `breaker=undefined → absent→reset legacy default` reroutes the storm through the mint site once the edge site is gone (live storm continued). Storm-shape test in `extensions/swarm/idle-nudge.test.mjs` R23C section (9 assertions: real hooks.ts `turn_start` invoked, 5 orbits each, 0 resets, ≤1 emission, seq bounded). Live incident 2026-09-02T14:44:37..14:45:17Z: goal `goal-1788350610025-7efafe` pinned at counter=MAX/nudgeSeq=3 while a fresh epoch (anchor 14:45:02Z, after legacy nudges `msg-1788350616129-691b4e7c`/`-0aea3216`/`-c6f752b8`) ran — `backoff.skip → backoff_just_exhausted → max_nudges re-arm` loop, ZERO `goal.idle_nudge`, ZERO `pi.sendMessage`. R10-1 boundary counters C-R23-1..10 (real-boundary send ≥1 with triggerTurn, replay dedupe, once-per-anchor reset, same-epoch cap, active-task gate, legacy `idle_epoch_advanced` preserved). The R23C `turn_start` handler writes swarm state from a Pi lifecycle hook — a new Pi-runtime boundary crossing (durable state write from `turn_start`). See roadmap Row R23/R23C + operations.md R23/R23B/R23C + `extensions/mock-llm/fixtures/goal-nudge-backoff-epoch-rearm.jsonl` + `artifacts/tester-turnstart-probe.mjs`. |
| **F16** | "Task-scoped messages on terminal nodes/tasks are non-actionable at surface time (the `node_terminal`/`task_terminal` gate is the only correct classifier for the recipient PM)" | `extensions/swarm/src/reconcile.ts` — `isActionableRootMessage` task/node terminal branch (pre-R24) | **R24** | **HIGH** | **FIXED 2026-09-03 (R24)**: a task-scoped message whose fingerprint is `requiresAck && !requiresResponse && replyTo` (the close-out shape — RESULT/REPLY/ASSIGNMENT messages produced by `swarm_send_message replyTo=...`) is exempted from `node_terminal` / `task_done` / `task_failed` / `task_cancelled` suppression so the recipient sees the outcome without manual `swarm_check_mailbox`. Nudges (canonical `task:<id>:node:<id>:nudge:*` idempotencyKey with NO replyTo) keep full gating — the predicate checks `isResultClass` BEFORE the task-terminal legs so nudges fall through to the existing gates. Live incident 2026-09-02T15:26:06.708Z: `msg-1788362766708-64f55b39` (R23 implement-done result) was durably enqueued (L1/C1 + L1/C2 `message.deliver.mailbox_only`), then durably classified `notification.stale.suppressed reason=node_terminal` by `isActionableRootMessage` for 5+ min of pump ticks (`mailbox.root_pump` 15:28:08.886Z), only surfacing via a manual `swarm_check_mailbox` at 15:31:09.993Z (`message.lifecycle_derived_shadow source=mailbox.surfaced stage=seen via=swarm_check_mailbox`). Fix is a SINGLE predicate change in `isActionableRootMessage` (the per-tick actionability filter that builds `windowMsgs`); no new `pi.sendMessage` call site is introduced. R10-1 boundary counter: real `pi.sendMessage` call at the pump boundary in the live lane (C-R24-1 ≥1, C-R24-2 replay dedupe ≥0, C-R24-3 nudge-control still suppressed — gate intact). See roadmap Row R24 + operations.md R24 + `extensions/mock-llm/fixtures/root-visible-surface-gap.jsonl` + `extensions/swarm/idle-nudge.test.mjs` R24 section (9 assertions: result-class exempted on done/failed/cancelled/terminal-node; nudges fall through; without `replyTo` or with `requiresResponse:true` falls through). |
| **F17** | "Worker ack-debt (live, non-superseded requiresAck messages) is invisible to the root on settle/stop — the PM only learned by polling `/swarm status` or `swarm_check_mailbox`" | (system-wide assumption; pre-R25 the agent_settled worker branch + stopAgent only covered `requiresResponse`-missing + open-assignment cases) | **R25** | **HIGH** | **FIXED 2026-09-03 (R25)**: settle path (`hooks.ts` `agent_settled` worker branch, ~L876) + stop path (`agents.ts` `stopAgent` lock-free core, ~L444) now scan `unackedRequiresAckRecords(st, agentId)` (new predicate in `mailbox.ts` — `requiresAck === true && !ackedAt && !superseded && status ∈ {mailbox_delivered, injected, intercepted, queued}`) and deliver a `requiresAck:false` informational notify to the root (`subject: "agent <id> settled/stopped owing N unacked ack(s)"`, body lists ids + subjects + close-action). Storm guards: persisted per-agent cooldown `lastAckDebtNotifyAt` (separate from `lastSettleNotifyAt`, reuses `SETTLE_NOTIFY_COOLDOWN_MS = 2 min`) + idempotencyKey `r25:ackdebt:<agent>:<sha1(sorted-ids)[:8]>` (durable dedupe across settles/stops). Spawn-kickoff messages (`mailboxKickoffPrompt`) remain ack-free by design (not mailbox records); `requiresAck:false` informational messages excluded by the predicate; `requiresResponse` debt untouched (existing L868 notify covers it). Stop-path notify is wrapped in `try/catch` and never blocks the underlying stop. R25 introduced a small signature change to `stopAgent(pi, cwd, p, state, agentId, opts)` — `cwd` is now an explicit parameter so the best-effort pre-kill notify can thread through `deliverMessageLocked(pi, cwd, …)`; 4 callers updated: `tools/agents.ts:359` (root tool), `taskgraph.ts:1229` (Issue-26 sweep), `command.ts:657` (`/swarm stop` subcommand), `tests/spawn-orphan-warning.test.mjs:239` (test). R10-1 boundary counter: real `pi.sendMessage` call at the `pumpRootMailbox` boundary — assert ≥1 ack-debt send (subject matching `/owing.*unacked ack/`) on first settle AND on the stop path, 0 NEW sends on re-settle within cooldown (the consumer-receipts ledger dedupes by idempotencyKey). The test harness seeds the root leader, drives `pumpRootMailbox(stub, ctx, p, "r25")` after each settle/stop, and counts sends captured on a real `sendMessage` stub — not a constant-true line. R10-1 boundary counters: C-R25-1 (real `pi.sendMessage` via `pumpRootMailbox` ≥1 on first settle with subject matching `/owing.*unacked ack/`), C-R25-2 (0 NEW sends on re-settle within cooldown — surface-ledger dedupe proof), C-R25-3 (≥1 sendMessage on stop path with a fresh debt set), C-R25-4 (RED-control: stashing the 4 production files reproduces 4/10 failures — the regression test is the reproducing artifact). Asserted in `extensions/swarm/tests/r25-unacked-notify.test.mjs` (10 assertions, including the 3 new pump-based boundary assertions in the R25 fix round; pre-fix test had a vacuous `ok(...true)` line at L265 which was the test-report blocker and is now replaced with the real pump-based counter). New mock-LLM fixture: `extensions/mock-llm/fixtures/r25-unacked-worker-notify.jsonl` (3-turn terminal script, deterministic; uses mock-llm-scenarios Pattern 2 seeded-world); companion lane test `extensions/mock-llm/tests/r25-unacked-worker-notify.test.mjs` (fixture-shape assertions always run; opt-in live lane via `RUN_R25_LANE=1`). See roadmap Row R25 + operations.md R25 + `extensions/swarm/tests/r25-unacked-notify.test.mjs` (10 assertions: settle path notify, re-settle storm guard, requiresResponse sensitivity, requiresAck=false invariant, stop path notify, 3× R10-1 pump-based boundary). |

Each row in this table is referenced by the §1 four-layer table so a contributor can navigate from a layer gap to the offending code path. **R15 critical (FIXED 2026-09-02):** the false promise in `tools/messages.ts:42-48` was removed; reviewers can grep the file for the literal `"within ~5s"` and find it absent. The R15 row tracks the durable-no-time-bound text + R10-1 boundary-counting assertion (R15 B1).

---

## 11. Open questions / future probes

P-1 and P-2 are EXECUTED via prior lanes (see rows below). P-3..P-7 are EXECUTED via the **phase-2b real-lane remediation** (`task-202609021900-ct-phase2b-real-lanes`) — real `pi --provider mock-llm --model <fixture>` lanes in dedicated tmux windows, real provider transcripts carrying `fixturePath` (the audit discriminator), and a dedicated probe extension (`extensions/ct-probe/`) that instruments the real runtime boundary. P-8 is RE-SCOPED to a source-import unit (per AC; no real lane needed). Phase-2 evidence (commit `3d1f3c6`) was retracted as self-mocked and re-stamped with phase-2b real-lane evidence.

| Probe | Maps to | Required fixture shape | Priority |
|-------|---------|------------------------|----------|
| **P-1** | CT-1 | Mock-llm fixture: call `pi.sendMessage` from a captured pre-reload ctx; assert no await required, assert async `send_message` error event | HIGH (R13) | **EXECUTED 2026-09-02** — verified: `.pi/mock-llm/transcripts/ct1-prereload-sendmessage/2026-09-02T06-06-45-544Z-mockllm-8c571dea-0ad8-4ab0-bd7c-7c0a29bfe1d7.json` (requestId `mockllm-8c571dea-…`, modelId `ct1-prereload-sendmessage`); tmux before/after `tmux-snapshots/ct-validation/ct-ct1-{before,after}.txt`; per `extensions/swarm/ct-contract-probes.test.mjs` §CT-1: CT-1.A sendMessage returns void + wrapper invoked synchronously on same tick + `opts.triggerTurn === true` passes through; CT-1.B async `runner.emitError({ event: "send_message", error })` surfaces, NOT a synchronous throw; CT-1.C pre-reload `pi` still callable after `await ctx.reload()` and the stale-session rejection surfaces via `runner.emitError`. |
| **P-2** | CT-2 (R15 AC1) | Mock-llm fixture: mid-turn root + worker sends normal-priority message; assert message is NOT surfaced within 5s; assert surface only after `agent_settled` | **HIGH (R15)** | **EXECUTED 2026-09-02 PASS** — verified at real two-tmux-session lane `tmux-snapshots/r17-ct2-validation/08-launch-retry/` (commit `87d4d5a`); all five R10-1 boundaries: L1 durable mailbox append, L2 consumer receipt, L3 exactly-once `pi.sendMessage` pump call, L4 single TUI `[swarm-message]` surface stable over ~90s, L5 LLM consumption of the surfaced message (nonce-verified); CT-2.B post-settled surface fires exactly once with `opts.triggerTurn === true`; CT-2.C replay does NOT re-fire (consumer-receipts dedupe); CT-2.A mid-turn 5s suppression covered by `extensions/swarm/r17-ct2-real-lane.test.mjs` (12/12 offline, no real tmux liveness needed). Prior unit-harness CT-2.B/C RED reclassified as harness limitation (could not fake tmuxAlive for `worker-1`), not a runtime defect. |
| **P-3** | CT-3 | Mock-llm fixture: idle agent + `sendMessage({nextTurn, triggerTurn: true})`; assert no turn fires; assert message only on next user prompt | LOW | **RE-STAMPED 2026-09-02 (phase-2b real lane)** — real `pi --provider mock-llm --model ct3-nextturn-idle` lane in tmux window `ct2b-ct3`. Probe extension `extensions/ct-probe/ct-probe.ts` CT3 factory (registered via `pi.registerTool` + `pi.setActiveTools` in `before_agent_start`) instruments `pi.sendMessage` at the real runtime boundary. Real evidence: provider transcript (keys: `requestId`, `modelId`, `fixturePath`, `request`, `events`, `final`) at `artifacts/lanes/ct3/transcripts/2026-09-02T12-34-12-857Z-mockllm-ef528539-78df-4340-a7fc-30a97d4a6792.json`; probe capture at `artifacts/lanes/ct3/probe-result.json` (`sendMessageCallCount: 1`, `sendMessageReturnIsUndefined: true`, `wrapperInvokedOnSameTick: true`, `deltaMs: 0`, `optsDeliverAs: "nextTurn"`, `optsTriggerTurn: true`); tmux pane capture at `artifacts/lanes/ct3/pane-after.txt`; launch script at `artifacts/lanes/ct3/scripts/launch.sh`. Confirms: (a) `pi.sendMessage` is fire-and-forget (returns void/undefined), (b) it does NOT trigger a new turn on the same tick when `deliverAs: "nextTurn"` is set, (c) it surfaces the queued message only on the next user prompt. |
| **P-4** | CT-4 | Mock-llm fixture: trigger auto-compaction retry; assert `ctx.isIdle() === false` | MEDIUM | **RE-STAMPED 2026-09-02 (phase-2b real lane)** — real `pi --provider mock-llm --model ct4-compaction-retry` lane in tmux window `ct2b-ct4`. Probe extension CT4 factory observes `ctx.isIdle()` from the real `runner.isIdleFn` binding (via `pi.on("session_start")` + `pi.setActiveTools` activation). Real evidence: provider transcripts at `artifacts/lanes/ct4/transcripts/` (2 files with `fixturePath`); probe capture at `artifacts/lanes/ct4/probe-result.json` (`isIdleSampleCountDuringCompaction: 4`, `isIdleFalseCountDuringCompaction: 4`, `compactionRetryObservedFalse: true`, all 4 samples `isIdle: false`); tmux pane capture at `artifacts/lanes/ct4/pane-after.txt`; launch script at `artifacts/lanes/ct4/scripts/launch.sh`. Confirms: during auto-compaction retry, `ctx.isIdle()` correctly returns `false` (4/4 samples). |
| **P-5** | CT-5 | Pure unit test: read `ctx.signal` from session_start handler; assert undefined | MEDIUM | **RE-STAMPED 2026-09-02 (phase-2b real lane)** — real `pi --provider mock-llm --model ct5-session-start-signal` lane in tmux window `ct2b-ct5`. Probe extension CT5 factory subscribes to `pi.on("session_start", (event, ctx) => { capturedValue = ctx.signal; })` on the real session-start boundary. Real evidence: provider transcript at `artifacts/lanes/ct5/transcripts/2026-09-02T12-21-25-845Z-mockllm-6e7ec66e-9f92-4e10-a689-37f59c7c7c08.json`; probe capture at `artifacts/lanes/ct5/probe-result.json` (`capturedSignalValue: null`, `capturedSignalType: "undefined"`, `isAbortSignalInstance: false`, `capturedValueWasUndefined: true`, `sessionStartReason: "startup"`); tmux pane capture at `artifacts/lanes/ct5/pane-after.txt`; launch script at `artifacts/lanes/ct5/scripts/launch.sh`. Confirms: `ctx.signal` at `session_start` is genuinely `undefined` (the agent is NOT streaming at startup), NOT a self-mock. |
| **P-6** | CT-6 | Pure unit test: capture ctx, await `ctx.reload()`, then use the captured ctx; assert throws `"This extension ctx is stale..."` | MEDIUM | **RE-STAMPED 2026-09-02 (phase-2b real lane)** — real `pi --provider mock-llm --model ct6-reload-stale-ctx` lane in tmux window `ct2b-ct6`. Probe extension CT6 factory registers the `/ct6_newsession_and_use_stale` slash command (slash commands bypass the LLM). The probe captures the pre-`newSession` ctx, reads `ctx.signal` (pre baseline), awaits `ctx.newSession({})` (which calls `dispose()` → `_extensionRunner.invalidate()` on the OLD runner per `agent-session.js:567` + `runner.js:352-358`), then reads FOUR captured ctx surfaces (`signal`, `abort()`, `isIdle()`, `model`) — ALL throw the stale-ctx message. Real evidence: probe capture at `artifacts/lanes/ct6/probe-result.json` (`preSignalThrew: null`, `newSessionResultCancelled: false`, `postSignalThrew: "This extension ctx is stale..."` ✅, `postAbortThrew: "This extension ctx is stale..."` ✅, `postIsIdleThrew: "This extension ctx is stale..."` ✅, `postModelThrew: "This extension ctx is stale..."` ✅, `thrownMessageContainsStaleSubstring: true`); tmux pane capture at `artifacts/lanes/ct6/pane-after.txt`; launch script at `artifacts/lanes/ct6/scripts/launch.sh`. **SCOPE NOTE**: probe uses `ctx.newSession()` (not `ctx.reload()`) because `reload()` reassigns `_extensionRunner` without invalidating the OLD runner (verified — `reload()` does NOT set `staleMessage`). `newSession()` does dispose + invalidate (verified). Both `reload()` and `newSession()` are documented in `pi-runtime-contract.md §2.3` as paths the stale-ctx guard covers; the guard fires only on session-replacement paths, not on reload. (No provider transcripts because slash commands bypass the LLM.) |
| **P-7** | CT-7 | Mock-llm fixture: queue a follow-up + emit `agent_end`; assert `agent_settled` is later | LOW | **RE-STAMPED 2026-09-02 (phase-2b real lane)** — real `pi --provider mock-llm --model ct7-end-vs-settled` lane in tmux window `ct2b-ct7`. Probe extension CT7 factory subscribes to `pi.on("agent_end")` + `pi.on("agent_settled")` (real `runner.emit()`), queues a follow-up via `pi.sendMessage({deliverAs: "followUp", triggerTurn: true})`, and writes the timeline to `ct7-result.json` from the FIRST `agent_settled` listener invocation (guarantees one agent_end + one agent_settled captured). Real evidence: provider transcripts at `artifacts/lanes/ct7/transcripts/` (3 files with `fixturePath`); probe capture at `artifacts/lanes/ct7/probe-result.json` (`agentEndEmittedCount: 1`, `agentSettledEmittedCount: 1`, `idxAgentEnd: 1`, `idxFollowUpInjected: 0`, `idxAgentSettled: 2`, `agentSettledAfterFollowUp: true`, `emissionOrderingMatches: true`, timeline: `[{event:followUp_injected, atMs:2862}, {event:agent_end, atMs:2885}, {event:agent_settled, atMs:2887}]`); tmux pane capture at `artifacts/lanes/ct7/pane-after.txt`; launch script at `artifacts/lanes/ct7/scripts/launch.sh`. Confirms: `agent_end` fires (atMs 2885) BEFORE `agent_settled` (atMs 2887) — delta of 2ms on the real runtime. |
| **P-8** | CT-8 | Pure unit test: read root agent record; assert `tmuxTarget === "unknown"` | LOW | **RE-SCOPED 2026-09-02 (source-import unit)** — CT-8 does not require a real lane; it exercises `ensureRoot` from `extensions/swarm/src/identity.ts:80,106` directly (the source-import unit) and asserts the returned record has `tmuxTarget === "unknown"`, `id === "root"`, `roleKind === "root"`. No provider transcript required. See `extensions/swarm/ct-phase2-probes.test.mjs` §CT-8 + the harness transcripts (kept on disk as debug artifacts only, NOT cited as §11 evidence). F2 framing **CONFIRMED true**: root pseudo-agent intentionally has `tmuxTarget === "unknown"` (mailbox-only delivery). |

**Open [GAP] questions** from evidence §11:

- `nextTurn` ordering when queued alongside a `triggerTurn: true` steer — no docs cover the race. [GAP evidence §11.3]
- `ctx.abort()` ordering relative to `agent_end` emission — not in docs. [GAP evidence §11.4]

---

## 12. How to update

Re-run the probes in [`pi-runtime-evidence.md §13`](./pi-runtime-evidence.md#13-reproducing-this-artifact) after every `npm i -g @earendil-works/pi-coding-agent` upgrade. If any cited line number moves:

1. Diff the surrounding context.
2. Update the evidence artifact's `[VERIFIED]` citations.
3. Update this contract doc's references that point at the moved lines.
4. Update the SHA + version line in §1 of this document.
5. Update the SHA + version line in §0 of `pi-runtime-evidence.md`.

Land all changes in the same PR as the Pi upgrade. Reviewers MUST reject a swarm PR that upgrades Pi without re-running the probes and updating both docs.

**Standing rule for contributors** (see also `AGENTS.md` "Pi runtime contract (mandatory consultation)"): before changing swarm code that crosses any of the four layers in §1, the contributor MUST consult this doc, identify the layer(s) crossed, and add or update a row in §10 if the change introduces, removes, or modifies a false / unproven claim about Pi runtime.
