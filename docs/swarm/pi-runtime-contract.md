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

This is the **R15 false-promise shape** (FIXED 2026-09-02 via R15 B1 — the literal `"its pump surfaces mailbox messages within ~5s"` was removed from `extensions/swarm/src/tools/messages.ts:42-48`; see §10 R15 row and roadmap Row R15 for evidence): the orchestrator's pump conflates L1 → L3, and there is no time-bound surface guarantee. The orchestrator's own `agent_settled` or its next idle watchdog tick is the only legitimate surface path.

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

> **Swarm footgun (F3 / R15, FIXED 2026-09-02):** The swarm MUST NOT promise a time-bound user-visible surface based on `followUp` or `nextTurn`. The orchestrator's pump cannot guarantee any specific delay; `agent_settled` is a lifecycle condition, not a time bound. **R15 B1 fix:** the literal `"~5s"` text in `extensions/swarm/src/tools/messages.ts:42-48` was removed; the honest durable-no-time-bound text now reports "surfaces when the orchestrator's own agent_settled fires or its next idle watchdog tick processes the mailbox". Section §3 surfaces this footgun before any contributor writes a sleep/retry.

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

## 10. R12–R15 false / unproven claims register

**This is the load-bearing section for the contract's purpose.** Every false or unproven claim surfaced by the R13–R15 Pi-facing incidents is named here with source line, severity, and citation. R12's shared-worker-pool mass sweep is documented in the reliability roadmap as a swarm-internal eligibility-logic bug; it is deliberately not attributed to a Pi runtime surface here.

| # | Claim | Where in code | R-row | Severity | Citation |
|---|-------|---------------|-------|----------|----------|
| **F3** | "Mailbox-only delivery to unknown-target orchestrator surfaces within ~5s" | `extensions/swarm/src/tools/messages.ts:42-48` (literal text `"its pump surfaces mailbox messages within ~5s"`) | **R15** | **CRITICAL** | [VERIFIED evidence §1.1 + §10 / auditor F3] — **FIXED 2026-09-02 (R15 B1)**: literal removed; honest durable-no-time-bound text; see roadmap Row R15 |
| **F2** | Orchestrator `tmuxTarget === "unknown"` is exceptional | (incorrect framing in R13 narrative; factually true in code: `identity.ts:67-69, 80, 106`) | **R13** | High | [VERIFIED evidence §1.1 + identity.ts:67-69,80,106, auditor F2] |
| **F1** | `await pi.sendMessage(...)` waits for delivery | (pattern, not a literal line; agents-session.js:1846-1852 wrapper drops the promise) | **R13, R15** | High | [VERIFIED evidence §1.1, agent-session.js:1846-1852, auditor F1] |
| **F4** | `agent_busy` only fires on user-tool busy | reconcile.ts busy-suppression gate | **R13 P1, R14** | Medium | [VERIFIED evidence §3.1, auditor F4] |
| **F5** | Captured `ctx.signal` is always defined outside turn events | (background timers + module-load captures) | Lifecycle | Medium | [VERIFIED evidence §3.3, auditor F5] |
| **F6** | Captured `pi`/`ctx` valid after reload / newSession / switch / fork | (background timers + module-load captures) | Lifecycle | Medium | [VERIFIED evidence §4.3 + §4.4, runner.js:352, auditor F6] |
| **F7** | `agent_end` is the "surface after fully idle" boundary | (not literal code, but hook-level) | **R13 P1** | Low | [VERIFIED evidence §6, auditor F7] |
| **F8** | `nextTurn` + `triggerTurn: true` starts a turn | (any swarm code using `nextTurn` for nudges) | **R13, R15** | Low | [VERIFIED evidence §2.1, auditor F8] |

Each row in this table is referenced by the §1 four-layer table so a contributor can navigate from a layer gap to the offending code path. **R15 critical (FIXED 2026-09-02):** the false promise in `tools/messages.ts:42-48` was removed; reviewers can grep the file for the literal `"within ~5s"` and find it absent. The R15 row tracks the durable-no-time-bound text + R10-1 boundary-counting assertion (R15 B1).

---

## 11. Open questions / future probes

These probes are **NOT** executed by this PR. They are listed as **required future contract tests** (CT-1..CT-8 from the auditor's report). Filing them as separate R-row tasks is the post-KB follow-up (out of scope for this documentation task).

| Probe | Maps to | Required fixture shape | Priority |
|-------|---------|------------------------|----------|
| **P-1** | CT-1 | Mock-llm fixture: call `pi.sendMessage` from a captured pre-reload ctx; assert no await required, assert async `send_message` error event | HIGH (R13) | **EXECUTED 2026-09-02** — verified: `.pi/mock-llm/transcripts/ct1-prereload-sendmessage/2026-09-02T06-06-45-544Z-mockllm-8c571dea-0ad8-4ab0-bd7c-7c0a29bfe1d7.json` (requestId `mockllm-8c571dea-…`, modelId `ct1-prereload-sendmessage`); tmux before/after `tmux-snapshots/ct-validation/ct-ct1-{before,after}.txt`; per `extensions/swarm/ct-contract-probes.test.mjs` §CT-1: CT-1.A sendMessage returns void + wrapper invoked synchronously on same tick + `opts.triggerTurn === true` passes through; CT-1.B async `runner.emitError({ event: "send_message", error })` surfaces, NOT a synchronous throw; CT-1.C pre-reload `pi` still callable after `await ctx.reload()` and the stale-session rejection surfaces via `runner.emitError`. |
| **P-2** | CT-2 (R15 AC1) | Mock-llm fixture: mid-turn orchestrator + worker sends normal-priority message; assert message is NOT surfaced within 5s; assert surface only after `agent_settled` | **HIGH (R15)** | **EXECUTED 2026-09-02 PASS** — verified at real two-tmux-session lane `tmux-snapshots/r17-ct2-validation/08-launch-retry/` (commit `87d4d5a`); all five R10-1 boundaries: L1 durable mailbox append, L2 consumer receipt, L3 exactly-once `pi.sendMessage` pump call, L4 single TUI `[swarm-message]` surface stable over ~90s, L5 LLM consumption of the surfaced message (nonce-verified); CT-2.B post-settled surface fires exactly once with `opts.triggerTurn === true`; CT-2.C replay does NOT re-fire (consumer-receipts dedupe); CT-2.A mid-turn 5s suppression covered by `extensions/swarm/r17-ct2-real-lane.test.mjs` (12/12 offline, no real tmux liveness needed). Prior unit-harness CT-2.B/C RED reclassified as harness limitation (could not fake tmuxAlive for `worker-1`), not a runtime defect. |
| **P-3** | CT-3 | Mock-llm fixture: idle agent + `sendMessage({nextTurn, triggerTurn: true})`; assert no turn fires; assert message only on next user prompt | LOW |
| **P-4** | CT-4 | Mock-llm fixture: trigger auto-compaction retry; assert `ctx.isIdle() === false` | MEDIUM |
| **P-5** | CT-5 | Pure unit test: read `ctx.signal` from session_start handler; assert undefined | MEDIUM |
| **P-6** | CT-6 | Pure unit test: capture ctx, await `ctx.reload()`, then use the captured ctx; assert throws `"This extension ctx is stale..."` | MEDIUM |
| **P-7** | CT-7 | Mock-llm fixture: queue a follow-up + emit `agent_end`; assert `agent_settled` is later | LOW |
| **P-8** | CT-8 | Pure unit test: read orchestrator agent record; assert `tmuxTarget === "unknown"` | LOW |

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
