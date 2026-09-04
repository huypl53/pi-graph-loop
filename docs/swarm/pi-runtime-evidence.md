# Pi coding-agent runtime contract — evidence artifact

> **Status:** Research deliverable. Citations to installed docs and `dist` source.
> **Purpose:** Single source of truth for swarm engineering decisions that touch Pi
> lifecycle, message delivery, interrupt, reload, or session-replacement semantics.
> **Uncertainty labels:** `[VERIFIED]` = direct quote from cited source;
> `[INFERRED]` = derived from combining citations; `[GAP]` = no source found,
> needs an additional probe.
> **Reader:** Pi swarm contributors; reviewable independently from swarm code.
> **Companion doc:** [`docs/swarm/pi-runtime-contract.md`](./pi-runtime-contract.md) is the
> normative single source of truth for swarm contributors. This file is the raw
> citation artifact with `[VERIFIED]`/`[INFERRED]`/`[GAP]` labels and reproduction
> commands; every claim in the contract doc points at a section here.

---

## 0. Provenance and version

| Item | Value |
|------|-------|
| Installed package | `@earendil-works/pi-coding-agent` |
| Install path | `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent` |
| Docs root | `…/pi-coding-agent/docs/` |
| Dist root | `…/pi-coding-agent/dist/core/` |
| Knowledge cutoff | January 2026 (this is the bundled doc state on this host) |

Every claim below links to a relative path inside that install root so the
artifact can be diffed against a future `pi-coding-agent` upgrade by re-running
the same `rg` probes.

---

## 1. Two layers, one runtime

There are **two API surfaces** swarm extensions can call, and they have
different shapes. Conflating them is the most common swarm-side bug.

### 1.1 `ExtensionAPI` (the `pi.*` object passed to extension factories)

Defined in `dist/core/extensions/types.d.ts` and documented in
`docs/extensions.md` ("ExtensionAPI Methods" section).

Key methods with exact signatures (cited from
`dist/core/extensions/types.d.ts:909-921`):

```ts
sendMessage<T = unknown>(
  message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
  options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }
): void;                                                                 // [VERIFIED]

sendUserMessage(
  content: string | (TextContent | ImageContent)[],
  options?: { deliverAs?: "steer" | "followUp" }
): void;                                                                 // [VERIFIED]
```

Note: `pi.sendMessage` returns **`void`**, not `Promise<void>`. The SDK
`AgentSession.sendUserMessage` (1.2 below) returns `Promise<void>`. Swarm must
not `await` `pi.sendMessage` as if it were a promise — it would resolve
immediately on a synchronous call. `[INFERRED]` from comparing the two
signatures in `types.d.ts`.

### 1.2 `AgentSession` / `ReplacedSessionContext` (SDK layer)

`AgentSession` is returned by `createAgentSession()`. Documented in
`docs/sdk.md` lines ~33-100 ("AgentSession" block).

`sendUserMessage` here has the **same** signature shape but
`Promise<void>` return:

```ts
sendUserMessage(
  content: string | (TextContent | ImageContent)[],
  options?: { deliverAs?: "steer" | "followUp" }
): Promise<void>;                                                        // [VERIFIED]
```

`docs/sdk.md` "Prompting and Message Queueing" block: `steer()` and
`followUp()` are also SDK helpers and explicitly error on extension
commands. Swarm extensions should use `pi.sendMessage`/`pi.sendUserMessage`,
not the SDK ones, unless they own the session. `[VERIFIED]`

### 1.3 `ReplacedSessionContext` (post-replacement)

`dist/core/extensions/types.d.ts:297-305` defines a third shape that appears
**only inside `withSession()` callbacks** for `ctx.newSession`,
`ctx.switchSession`, `ctx.fork`. Both methods are async and return
`Promise<void>`. `[VERIFIED]`

> **Swarm footgun (verified):** Per `docs/extensions.md` "Session replacement
> lifecycle and footguns", a captured old `pi` / old command `ctx` becomes
> stale after `await ctx.newSession()` and will throw if used.
> `ReplacedSessionContext.sendMessage` and `sendUserMessage` are the *only*
> safe paths to talk to the new session from inside `withSession()`.

---

## 2. `sendMessage` vs `sendUserMessage` — the integration contract

| Aspect | `pi.sendMessage` (custom) | `pi.sendUserMessage` (user) |
|--------|---------------------------|----------------------------|
| LLM context? | Yes (role `custom`, `customType`) | Yes (role `user`) |
| Triggers a turn? | Only if `triggerTurn: true` AND idle | Always |
| While streaming, default behaviour | Queues per `deliverAs` | Queues per `deliverAs` (or throws if no `deliverAs`) |
| TUI display? | Via `pi.registerMessageRenderer(customType, ...)` | Always |
| Persisted to session? | Yes (custom message entry) | Yes (user message entry) |
| Visible to swarm mailbox? | **No** (session-internal) | **No** (session-internal) |

All rows `[VERIFIED]` from `docs/extensions.md` sections
"### pi.sendMessage" (~line 1395) and "### pi.sendUserMessage" (~line 1411).

### 2.1 `deliverAs` semantics (canonical table)

From `docs/extensions.md` ~line 1406-1410 (`pi.sendMessage` doc) cross-checked
against `types.d.ts:1110-1116`:

| Mode | Idle | Streaming | Trigger turn |
|------|------|-----------|--------------|
| `steer` (default) | Send now | Queue for after current assistant turn's tool calls, **before next LLM call** | Yes (with `triggerTurn: true`) |
| `followUp` | Send now | Queue until agent has **no more tool calls** | Yes (with `triggerTurn: true`) |
| `nextTurn` | Queued for next user prompt; **never** interrupts | Queued for next user prompt; never interrupts | **No** (ignored) |

`nextTurn` only exists on `pi.sendMessage`. `pi.sendUserMessage` accepts only
`steer` | `followUp`. `[VERIFIED]` from `types.d.ts:1114-1116`.

`triggerTurn` is ignored on `nextTurn` and required to actually fire a turn
when idle for `steer`/`followUp`. `[VERIFIED]`

### 2.2 What this means for swarm

Swarm's mailbox → session bridge must:

- Use `pi.sendUserMessage(content, { deliverAs: ... })` (or `steer`/`followUp`)
  if the swarm user message should appear as user role and always trigger a turn.
- Use `pi.sendMessage({ customType, content, display, details }, { deliverAs: ...,
  triggerTurn: true })` if the message is structured swarm metadata that
  should also reach the LLM as a custom message (e.g. orchestrator
  directives, system-level coordination).
- **Never** expect `await pi.sendMessage(...)` to wait for delivery; it
  returns synchronously. `[INFERRED]`
- **Always** pass `deliverAs` when the agent might be streaming; otherwise
  `pi.sendUserMessage` throws. `[VERIFIED]` from `docs/sdk.md` "Prompting and
  Message Queueing" behaviour table.

---

## 3. Idle / streaming detection

### 3.1 `ctx.isIdle()`

`dist/core/extensions/types.d.ts:232` and `docs/extensions.md` ~line 1016:

```ts
isIdle(): boolean;
```

> "`ctx.isIdle()` is false while Pi is processing an agent run, automatic
> retry, auto-compaction retry, or queued continuation." `[VERIFIED]`

This is the canonical "is the agent available?" check. **It is also `false`
during an active retry or auto-compaction retry**, which means swarm must
not assume idle ⇒ no more work pending. The companion `ctx.hasPendingMessages()`
answers the queue side:

### 3.2 `ctx.hasPendingMessages()`

`types.d.ts:240`: `hasPendingMessages(): boolean;` `[VERIFIED]`

Combined semantics:

| `isIdle` | `hasPendingMessages` | Interpretation |
|----------|----------------------|----------------|
| `true` | `false` | Fully settled, safe to inject without `deliverAs` |
| `true` | `true` | Edge: idle but a follow-up is queued — next prompt is imminent |
| `false` | `false` | Mid-turn (LLM or tool call) |
| `false` | `true` | Mid-turn with queued steering/follow-up |

`[INFERRED]` from the two type signatures + the docstring on `isIdle` —
verify against a live lane if precision matters.

### 3.3 `ctx.signal` — abort signal of current turn

`types.d.ts:236`: `signal: AbortSignal | undefined;` `[VERIFIED]`

> "`ctx.signal` is typically defined during active turn events such as
> `tool_call`, `tool_result`, `message_update`, and `turn_end`.
> It is usually `undefined` in idle or non-turn contexts such as session
> events, extension commands, and shortcuts fired while pi is idle."
> `docs/extensions.md` ~line 980. `[VERIFIED]`

Swarm extensions that start background work inside a `tool_result` or
`message_update` handler must thread `ctx.signal` into any `fetch` /
subprocess to make Esc cancel them. `[VERIFIED]`

---

## 4. Abort, reload, and session replacement

### 4.1 `ctx.abort()`

`types.d.ts:238`: `abort(): void;` (synchronous, returns void). `[VERIFIED]`

For the SDK session: `AgentSession.abort(): Promise<void>` (`agent-session.d.ts:440`)
which "abort[s] current operation and wait[s] for agent to become idle."
`[VERIFIED]`

`ctx.abort()` does **not** await idle; it just signals. Swarm code that
needs to know the abort has been honoured must either listen for `agent_end`
+ `agent_settled` or call `ctx.waitForIdle()` afterwards. `[INFERRED]`

### 4.2 `ctx.shutdown()`

`types.d.ts:242` and `docs/extensions.md` ~line 1020:

> "Interactive mode: Deferred until the agent becomes idle (after processing
> all queued steering and follow-up messages). RPC mode: Deferred until the
> next idle state. Print mode: No-op."
> `[VERIFIED]`

`ctx.shutdown()` does **not** emit `session_shutdown` until the deferral
resolves. Swarm must not assume a synchronous `session_shutdown` after
calling `shutdown()`. `[VERIFIED]`

### 4.3 `ctx.reload()` — extension hot-reload

`docs/extensions.md` "ctx.reload()" section, lines ~1245-1300. Behaviour:

1. Emits `session_shutdown` for the current extension runtime.
2. Reloads resources.
3. Emits `session_start` with `reason: "reload"` and `resources_discover`
   with `reason: "reload"`.
4. The currently running command handler **continues in the old call frame**
   on the **pre-reload** extension instance.
5. Code after `await ctx.reload()` still runs from the pre-reload version
   and must not assume old in-memory extension state is valid.

`[VERIFIED]`

> **Swarm footgun (verified):** any in-process state held by an extension
> factory closure is **lost** on reload. Mailbox state (file-backed JSONL)
> survives; in-memory maps do not. `[INFERRED]` from `session_shutdown`
> ordering — verify against an R12-style reload lane.

### 4.4 Session replacement lifecycle

For `ctx.newSession`, `ctx.switchSession`, `ctx.fork`:

Order of events (from `docs/extensions.md` "Lifecycle Overview" diagram
~line 316 and "Session replacement lifecycle and footguns" section ~line 1230):

1. `session_before_switch` / `session_before_fork` (cancellable).
2. `session_shutdown` for old extension instance.
3. Old runtime torn down.
4. Replacement session rebound.
5. New extension instance receives `session_start`.
6. `withSession(ctx)` callback fires — `ctx` here is a fresh
   `ReplacedSessionContext`.

`[VERIFIED]`

Captured old `pi`, old `ctx.sessionManager`, old tool handles → all stale
after the await. The `ctx` parameter of `withSession()` is the **only** safe
handle to the new session. `[VERIFIED]`

---

## 5. Input interception and `event.source`

`docs/extensions.md` "Input Events → input" section (~line 800):

```ts
pi.on("input", async (event, ctx) => {
  // event.source - "interactive" (typed), "rpc" (API), or "extension" (via sendUserMessage)
  // event.streamingBehavior - "steer" | "followUp" | undefined
});
```

`event.source === "extension"` is the **canonical marker** for messages
injected by swarm via `pi.sendUserMessage`. Swarm code that wants to avoid
double-processing (e.g. a `/swarm-mail` autoparse that should skip messages
it itself injected) must check this. `[VERIFIED]`

`streamingBehavior`:
- `undefined` when idle
- `"steer"` for mid-stream interrupts
- `"followUp"` for messages queued until the agent finishes

`[VERIFIED]`

The `input` event fires **after** extension command lookup but **before**
skill/template expansion. Swarm can intercept with `{ action: "handled" }`
to short-circuit; first handler to return `handled` wins. `[VERIFIED]`

---

## 6. Lifecycle hook order (canonical)

From `docs/extensions.md` "Lifecycle Overview" diagram ~line 295:

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

`session_before_switch` / `session_before_fork` / `session_before_compact`
all gate the corresponding transitions and can return `{ cancel: true }`.
`[VERIFIED]`

`agent_end` is **not** the end of work — auto-retry, auto-compaction retry,
and queued follow-ups may still execute. `agent_settled` is the only
event that guarantees "Pi will not continue running automatically."
`[VERIFIED]` (~line 560).

---

## 7. Extension error handling

`docs/extensions.md` "Error Handling" section, line 2862-2866:

- Extension errors are logged, agent continues. `[VERIFIED]`
- `tool_call` errors block the tool (fail-safe). `[VERIFIED]`
- Tool `execute` errors must be signaled by **throwing**; the thrown
  error is caught, reported to the LLM with `isError: true`, and execution
  continues. `[VERIFIED]`

> **Swarm footgun (verified):** returning `{ isError: true, content: ... }`
> from a tool does **not** mark it as failed. Only `throw` does.
> `docs/extensions.md` "Signaling errors" section (~line 1900):
> "Returning a value never sets the error flag regardless of what
> properties you include in the return object." `[VERIFIED]`

Failed extension handler (e.g. `tool_call` that throws) does not crash the
agent — it's logged and treated as a no-op block. `[INFERRED]` from
"Extension errors are logged, agent continues" + "`tool_call` errors
block the tool (fail-safe)". Verify by writing a mock-llm fixture that
throws from a `tool_call` handler and asserts the next message is still
processed.

---

## 8. RPC mode vs TUI vs JSON vs Print

`docs/extensions.md` "Mode Behavior" table (~line 2870):

| Mode | `ctx.mode` | `ctx.hasUI` | Notes |
|------|-----------|-------------|-------|
| Interactive | `"tui"` | `true` | Full TUI |
| RPC (`--mode rpc`) | `"rpc"` | `true` | Dialogs/notify via JSON protocol; `custom()` returns `undefined` |
| JSON (`--mode json`) | `"json"` | `false` | Event stream to stdout; UI methods no-ops |
| Print (`-p`) | `"print"` | `false` | Extensions run, no prompting |

`[VERIFIED]`

Swarm extensions that touch UI helpers must guard with `ctx.hasUI` (or
`ctx.mode === "tui"` for TUI-specific like `custom()`, terminal input).
`[VERIFIED]`

---

## 9. Swarm-relevant event payload cheat sheet

### 9.1 `tool_call` (mutable input, blockable)

`docs/extensions.md` ~line 700:

- `event.input` is **mutable**; mutate in place to patch arguments.
- No re-validation after your mutation.
- Return `{ block: true, reason?: string }` only.
- Multiple `tool_call` handlers run in extension load order; later
  handlers see earlier mutations.
- Use `isToolCallEventType` from `@earendil-works/pi-coding-agent` for
  type narrowing. `[VERIFIED]`

### 9.2 `tool_result` (chainable patch)

- Each handler sees the latest result; can return partial patches
  (`content`, `details`, `isError`, `usage`).
- In parallel tool mode, `tool_result` and `tool_execution_end` may
  interleave in tool completion order. Final `toolResult` message events
  emit later in assistant source order.
- Use `ctx.signal` for nested async work.
`[VERIFIED]` (~line 800)

### 9.3 `before_provider_request` (payload rewrite)

> "Returning `undefined` keeps the payload unchanged. Returning any other
> value replaces the payload for later handlers and for the actual request."
> `[VERIFIED]`

System-prompt level: changes here **do not** propagate back to
`ctx.getSystemPrompt()`; the latter reports Pi's system prompt string, not
the final serialized provider payload. `[VERIFIED]`

### 9.4 `after_provider_response` (pre-stream inspection)

`event.status` (HTTP code), `event.headers` (normalized). Useful for
429 detection (`status === 429`). Header availability depends on
provider/transport — some providers abstract HTTP and do not expose
headers. `[VERIFIED]`

### 9.5 `message_end` (replaceable)

> "Handlers can return `{ message }` to replace the finalized message.
> The replacement must keep the same `role`." `[VERIFIED]`

---

## 10. Mapping to swarm R12-R15 incident themes

The swarm roadmap (`docs/swarm/reliability-roadmap.md`, `r10-postbatch-synthesis/`)
includes recurring incident classes. Pinning each to a Pi contract anchor:

| Swarm incident class | Pi contract anchor | Evidence section |
|---------------------|--------------------|------------------|
| Edit-not-persisted | `pi.sendUserMessage` returns void ≠ persisted; tool result persistence | §1.1, §9.1 |
| 429-mid-edit | `after_provider_response` carries `status`; no automatic retry back-off by pi itself | §9.4 |
| Response-missing-settle | `agent_end` ≠ settled; need `agent_settled` for status integrations | §6 |
| Settled-with-open-assignment | `ctx.isIdle()` is `false` during queued continuations | §3.1 |
| Drift-then-wake | `agent_settled` is the only "will not auto-continue" signal | §6 |
| Reload loses in-memory state | `session_shutdown` ordering; only file-backed JSONL survives | §4.3 |
| Stale `pi` after replacement | `ReplacedSessionContext` is the only safe handle | §1.3, §4.4 |
| Tool "isError" return ignored | Must `throw` | §7 |

---

## 11. Open questions / `[GAP]` items

1. **`pi.sendMessage` void vs promise return** — docs and types agree
   (`void`), but `AgentSession.sendUserMessage` is `Promise<void>` and
   `ReplacedSessionContext.sendMessage` is `Promise<void>`. The asymmetry
   is real; swarm should standardise on fire-and-forget for `pi.*` calls
   and await only the SDK-layer equivalents. Verify with a mock-llm lane
   that calls `pi.sendMessage` and asserts no `await` is required.
   `[GAP]` — no explicit test fixture yet.
2. **`event.source === "extension"` coverage** — `InputSource = "interactive" | "rpc" | "extension"`
   type-confirmed at `dist/core/extensions/types.d.ts:625`; `event.source`
   field on `InputEvent` at line 634. `[VERIFIED]` — GAP closed.
3. **`nextTurn` turn-trigger semantics when already queued alongside a
   `triggerTurn: true` steer** — both queue items could race for the next
   turn; no docs cover this ordering. `[GAP]` — surface for a mock-llm
   fixture if swarm needs strict ordering.
4. **`ctx.abort()` synchrony vs `session.abort()` async** — confirmed by
   type signature, but actual ordering relative to `agent_end` emission is
   not in docs. `[GAP]` — verify with a mock-llm fixture that aborts
   mid-tool-call.

---

## 12. Proposed knowledge-base outline

To convert this evidence artifact into a durable contract doc for swarm
contributors, the standing doc should follow this structure (top-level
heading order):

1. **Provenance** — same as §0, kept short.
2. **Two API layers** — distilled from §1.
3. **`sendMessage` vs `sendUserMessage`** — distilled from §2.
4. **Idle / streaming / pending** — distilled from §3.
5. **Abort, reload, replacement** — distilled from §4.
6. **Input interception and `event.source`** — distilled from §5.
7. **Lifecycle hook order** — distilled from §6, with a one-line summary
   per hook and a link to `docs/extensions.md` for the full contract.
8. **Error handling rules** — distilled from §7.
9. **Mode matrix** — distilled from §8.
10. **Swarm integration hazards** — distilled from §10 (incident-themed).
11. **Open questions** — link to §11; re-evaluate each Pi minor upgrade.
12. **How to update** — protocol for re-running the probes when
    `@earendil-works/pi-coding-agent` is upgraded.

That doc lives at `docs/swarm/pi-runtime-contract.md` (per the task's
allowed-files list). It should cite this evidence artifact by section
number so reviewers can audit any rule back to a quote.

---

## 13. Reproducing this artifact

```bash
# Verify ExtensionAPI signatures
rg -n "sendMessage|sendUserMessage" \
  /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts

# Verify lifecycle hooks
rg -n "session_start|session_shutdown|agent_settled|input|tool_call" \
  /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md

# Verify SDK layer
rg -n "sendUserMessage|steer\(|followUp\(" \
  /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md

# Confirm error handling rules
rg -n "Extension errors are logged|throw.*isError|Signaling errors" \
  /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md
```

Re-run after every `npm i -g @earendil-works/pi-coding-agent` upgrade. If
any of the cited line numbers moves, diff the surrounding context and
update this artifact's `[VERIFIED]` citations before re-publishing the
contract doc.

---

*Generated by `pi-runtime-researcher` swarm agent, role documented in
`.pi/swarm/agents/pi-runtime-researcher.md`. Treat this file as research
output, not as durable swarm guidance — the contract doc
(`docs/swarm/pi-runtime-contract.md`) is what AGENTS.md should link.*
