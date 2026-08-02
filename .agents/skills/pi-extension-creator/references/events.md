# Events reference

Subscribe with `pi.on(eventName, async (event, ctx) => { ... })`. Handlers are
async; return values shape behavior (block, cancel, transform, replace). Return
`undefined` / nothing to pass through. Handlers run in extension load order.

This is a condensed but complete reference. For the full prose see
`docs/extensions.md`.

## Lifecycle overview

```
pi starts
  ├─► project_trust            (user/global + CLI extensions only)
  ├─► session_start { reason: "startup" }
  └─► resources_discover { reason: "startup" }

user prompt
  ├─► (extension /commands checked first — if matched, input event is SKIPPED)
  ├─► input            (intercept / transform / handle without LLM)
  ├─► (skill & template expansion, if not handled)
  ├─► before_agent_start  (inject message, modify system prompt)
  ├─► agent_start
  ├─► message_start / message_update / message_end
  │   ┌── turn (repeats while LLM calls tools) ──┐
  │   ├─► turn_start                              │
  │   ├─► context              (modify messages)  │
  │   ├─► before_provider_headers                 │
  │   ├─► before_provider_request                 │
  │   ├─► after_provider_response                 │
  │   │   LLM may call tools:                      │
  │   │     tool_execution_start                   │
  │   │     tool_call           (can block/mutate) │
  │   │     tool_execution_update                  │
  │   │     tool_result         (can modify)       │
  │   │     tool_execution_end                     │
  │   └─► turn_end                                │
  ├─► agent_end
  └─► agent_settled  (no retry / compaction / follow-up remaining)

/new · /resume → session_before_switch → session_shutdown → session_start{new|resume}
/fork · /clone → session_before_fork  → session_shutdown → session_start{fork}
/name · setSessionName() → session_info_changed
/compact · auto → session_before_compact (→ session_compact)
/tree        → session_before_tree (→ session_tree)
/model · Ctrl+P → (thinking_level_select) → model_select
exit          → session_shutdown
```

## Startup / resource events

### project_trust
Fires before pi decides whether to trust a project (dynamic `.pi` / `.agents/skills`
configs). Only **user/global** and **CLI `-e`** extensions participate; project-local
ones aren't loaded until trust is resolved. `ctx` here is limited (`cwd`, `mode`,
`hasUI`, and the `select/confirm/input/notify` UI helpers). Check `ctx.hasUI`
before prompting.

```typescript
pi.on("project_trust", async (event, ctx) => {
  if (await ctx.ui.confirm("Trust project?", event.cwd)) return { trusted: "yes", remember: true };
  return { trusted: "undecided" }; // first yes/no wins & suppresses built-in prompt
});
```

### resources_discover
Contribute extra skill / prompt / theme paths. `reason`: `"startup" | "reload"`.
```typescript
pi.on("resources_discover", async (event) => ({
  skillPaths: ["/abs/path/to/skills"],
  promptPaths: ["..."],
  themePaths: ["..."],
}));
```

## Session events

### session_start
`event.reason`: `"startup" | "reload" | "new" | "resume" | "fork"`; `event.previousSessionFile`
present for new/resume/fork. Use this to (re)establish in-memory state, register
runtime tools, etc.
```typescript
pi.on("session_start", async (event, ctx) => {
  // restore state from ctx.sessionManager.getBranch() here
});
```

### session_shutdown
`event.reason`: `"quit" | "reload" | "new" | "resume" | "fork"`. Clean up
session-scoped resources (processes, sockets, watchers) you started. Make it
idempotent.
```typescript
pi.on("session_shutdown", async () => { timer?.close(); });
```

### session_info_changed
Fires when the session display name changes (`/name`, RPC, `setSessionName`).
`event.name` is the normalized name or `undefined`.

### session_before_switch — can cancel
Before `/new` or `/resume`. `event.reason`: `"new" | "resume"`; `event.targetSessionFile`
for resume. After success pi emits `session_shutdown`, rebinds extensions, then
`session_start{new|resume}`.
```typescript
pi.on("session_before_switch", async (event, ctx) => {
  if (event.reason === "new" && !await ctx.ui.confirm("Clear?", "Delete messages?")) {
    return { cancel: true };
  }
});
```

### session_before_fork — can cancel
Before `/fork` (`position: "before"`) or `/clone` (`position: "at"`). `event.entryId`.
Return `{ cancel: true }` or `{ skipConversationRestore: true }` (reserved).

### session_before_compact / session_compact
See `compaction.md` for full detail. `reason`: `"manual" | "threshold" | "overflow"`;
`willRetry` = whether the aborted turn is retried (overflow recovery).
```typescript
pi.on("session_before_compact", async (event) => {
  const { preparation, reason, willRetry, signal } = event;
  return { cancel: true };                         // cancel compaction
  // OR provide a custom summary:
  return { compaction: { summary: "...", firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore } };
});
pi.on("session_compact", async (event) => {
  // event.compactionEntry, event.fromExtension, event.reason, event.willRetry
});
```

### session_before_tree / session_tree
On `/tree` navigation. `event.preparation`, `signal`.
```typescript
pi.on("session_before_tree", async (event) => ({
  cancel: true,
  // OR { summary: { summary: "...", details: {} } }
}));
pi.on("session_tree", async (event) => {
  // event.newLeafId, event.oldLeafId, event.summaryEntry, event.fromExtension
});
```

## Agent events

### before_agent_start — can inject message + modify system prompt
After the user submits, before the agent loop.
```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // event.prompt, event.images, event.systemPrompt (chained across handlers)
  // event.systemPromptOptions — structured inputs pi used to build it:
  //   .customPrompt, .selectedTools, .toolSnippets, .promptGuidelines,
  //   .appendSystemPrompt, .cwd, .contextFiles, .skills
  return {
    message: { customType: "my-ext", content: "extra context for the LLM", display: true },
    systemPrompt: event.systemPrompt + "\n\nExtra rules for this turn",
  };
});
```
`event.systemPrompt` and `ctx.getSystemPrompt()` both reflect the chained prompt as
of the current handler. Payload-level rewrites from `before_provider_request` are
NOT reflected here.

### agent_start / agent_end / agent_settled
`agent_start` when a low-level run begins. `agent_end` when it ends (pi may still
retry/compact/continue). Use **`agent_settled`** for "pi is done" integrations
(`ctx.isIdle()` is true unless another extension started a run). `agent_end` gives
`event.messages`.

### turn_start / turn_end
Per turn (one LLM response + its tool calls). `event.turnIndex`, `event.timestamp`;
`turn_end` also has `event.message`, `event.toolResults`.

### message_start / message_update / message_end
`message_start`/`message_end` fire for user/assistant/toolResult messages;
`message_update` for assistant streaming. `message_end` may `return { message }`
to replace the finalized message (keep the same `role`).
```typescript
pi.on("message_end", async (event) => {
  if (event.message.role !== "assistant") return;
  return { message: { ...event.message, /* e.g. override usage.cost */ } };
});
```

### tool_execution_start / tool_execution_update / tool_execution_end
Tool execution lifecycle. In parallel-tool mode, `start` is in assistant source
order, `update` may interleave, `end` is in completion order; final toolResult
message events still fire later in source order. Fields: `toolCallId`, `toolName`,
`args`/`partialResult`/`result`, `isError`.

### context — modify messages per LLM call
`event.messages` is a deep copy, safe to mutate/filter.
```typescript
pi.on("context", async (event) => ({ messages: event.messages.filter(m => !shouldPrune(m)) }));
```

### before_provider_headers — mutate headers in place
Runs once per provider request (retries reuse the same headers).
```typescript
pi.on("before_provider_headers", (event) => {
  event.headers["x-session-id"] = "abc";      // add/override
  event.headers["X-OpenRouter-Title"] = null; // delete
});
```

### before_provider_request — inspect or replace payload
After the provider payload is built, before sending. `console.log` it for debugging;
`return` a value to replace it (later handlers + the request use it). Payload-level
system-instruction rewrites are NOT visible via `ctx.getSystemPrompt()`.

### after_provider_response
After the HTTP response, before the body stream is consumed. `event.status`,
`event.headers` (availability depends on provider/transport).

## Model events

### model_select
On `/model`, model cycling (Ctrl+P), or session restore. `event.model`,
`event.previousModel`, `event.source` (`"set" | "cycle" | "restore"`).

### thinking_level_select — notification only
Return values are ignored. `event.level`, `event.previousLevel`.

## Tool events

### tool_call — can block; `event.input` is mutable
After `tool_execution_start`, before execution. Use `isToolCallEventType("bash", event)`
to narrow and get typed `event.input`.
- Mutations to `event.input` affect execution; later handlers see them; **no re-validation**.
- Return `{ block: true, reason?: string }` to block; any other return is ignored.
- Before `tool_call` runs, prior Agent events have drained, so `ctx.sessionManager`
  is current through this assistant message — but in parallel mode sibling tool
  results from the same message are NOT guaranteed visible.

```typescript
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  if (isToolCallEventType("bash", event)) {
    event.input.command = `source ~/.profile\n${event.input.command}`;   // mutate
    if (event.input.command.includes("rm -rf")) return { block: true, reason: "dangerous" };
  }
});
```
Custom tool inputs: export the input type and narrow with type params:
`isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)`.

### tool_result — can modify result (chains like middleware)
After execution, before `tool_execution_end` + final toolResult message events.
Each handler sees the latest result; return partial patches (`content`, `details`,
`isError`, `usage`) — omitted fields keep current values. Use `ctx.signal` for nested
async work. Use `isBashToolResult(event)` etc. to type `event.details`.
```typescript
pi.on("tool_result", async (event, ctx) => {
  return { details: { ...(event.details ?? {}), annotated: true } };
});
```

## User bash event

### user_bash — can intercept `!` / `!!` commands
```typescript
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

pi.on("user_bash", (event) => {
  // event.command, event.excludeFromContext (!! prefix), event.cwd
  return { operations: remoteBashOps };                 // custom backend
  // OR wrap built-in local backend:
  const local = createLocalBashOperations();
  return { operations: { exec(c, cwd, o) { return local.exec(`source ~/.profile\n${c}`, cwd, o); } } };
  // OR return a result directly:
  return { result: { output: "...", exitCode: 0, cancelled: false, truncated: false } };
});
```

## Input event

### input — intercept / transform / handle user input
Fires after extension commands are checked, before skill/template expansion, so you
see raw text (`/skill:foo`, `/template` not yet expanded). `event.text`, `event.images`,
`event.source` (`"interactive" | "rpc" | "extension"`), `event.streamingBehavior`
(`"steer" | "followUp" | undefined`).

Results:
- `{ action: "continue" }` — pass through (default)
- `{ action: "transform", text, images? }` — rewrite then continue to expansion
- `{ action: "handled" }` — skip the agent entirely (first handler returning this wins)

Transforms chain across handlers.
```typescript
pi.on("input", async (event, ctx) => {
  if (event.text === "ping") { ctx.ui.notify("pong", "info"); return { action: "handled" }; }
  if (event.text.startsWith("?quick "))
    return { action: "transform", text: `Respond briefly: ${event.text.slice(7)}` };
  return { action: "continue" };
});
```
For streaming-aware routing see `input-transform-streaming.ts`.
