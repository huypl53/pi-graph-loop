# ExtensionAPI, contexts & state

Condensed reference for `pi.*` methods, the `ExtensionContext` (`ctx`) handed to
every handler, the richer `ExtensionCommandContext` for commands, and state
patterns. Full prose in `docs/extensions.md`.

## `pi.*` methods

### pi.on(event, handler)
Subscribe to an event. See `references/events.md`.

### pi.registerTool(definition) / defineTool(definition)
Register an LLM-callable tool. Works during load AND after startup (new tools are
refreshed immediately — no `/reload`). See `references/custom-tools.md` for the full
definition. Prefer `defineTool({...})` assigned to a const, then `pi.registerTool(it)`.

### pi.registerCommand(name, options)
Register a `/<name>` command. Handlers get `ExtensionCommandContext` (session control
methods, see below). Duplicate names across extensions get `:1`/`:2` suffixes.
```typescript
pi.registerCommand("deploy", {
  description: "Deploy to an env",
  getArgumentCompletions: (prefix: string) => {
    const items = ["dev","staging","prod"].filter(v => v.startsWith(prefix)).map(v => ({ value: v, label: v }));
    return items.length ? items : null;
  },
  handler: async (args, ctx) => { ctx.ui.notify(`Deploying: ${args}`, "info"); },
});
```

### pi.getCommands()
Slash commands invokable via `prompt` in this session (extensions first, then
templates, then skills). Each: `{ name, description?, source, sourceInfo: { path, source, scope: "user"|"project"|"temporary", origin, baseDir? } }`.
Use `sourceInfo` for provenance (don't parse paths). Built-in interactive commands
(`/model`, `/settings`…) are NOT included.

### pi.sendMessage(message, options?)
Inject a **custom** message (participates in LLM context). Pair with
`registerMessageRenderer` for custom TUI display. Options:
- `deliverAs`: `"steer"` (default — after current turn's tool calls, before next LLM call) | `"followUp"` (after agent finishes all tools) | `"nextTurn"` (queued for next prompt)
- `triggerTurn: true` — if idle, trigger an LLM response now (only steer/followUp)
```typescript
pi.sendMessage({ customType: "my-ext", content: "note for the LLM", display: true, details: {} },
               { triggerTurn: true });
```
For **TUI-only** content that must NOT reach the LLM, use `appendEntry` + `registerEntryRenderer`.

### pi.sendUserMessage(content, options?)
Send an actual **user** message (looks typed); always triggers a turn. Accepts a
string or a content array (`text` + `image` parts). While streaming you MUST pass
`deliverAs: "steer" | "followUp"`.

### pi.appendEntry(customType, data?)
Persist extension data as a custom entry that does **not** participate in LLM
context. In TUI it can render in the transcript via `registerEntryRenderer`. Restore
on reload by scanning entries in `session_start` (see State below).
```typescript
pi.appendEntry("status-card", { title: "Indexed", count: 17 });
```

### pi.registerMessageRenderer(customType, renderer) / pi.registerEntryRenderer(customType, renderer)
Custom TUI renderers. See `references/custom-ui.md`.

### pi.setSessionName(name) / pi.getSessionName()
Set/get the display name shown in the session selector.

### pi.setLabel(entryId, label?) / (read via ctx.sessionManager.getLabel(entryId))
User-defined markers shown in `/tree`. Labels persist across restarts.

### pi.registerShortcut(shortcut, options)
`pi.registerShortcut("ctrl+shift+p", { description: "...", handler: async (ctx) => {} })`.
Shortcut format & built-ins: `keybindings.md`.

### pi.registerFlag(name, options)
Register a CLI flag: `pi.registerFlag("plan", { description, type: "boolean", default: false })`.
Read with `pi.getFlag("plan")`.

### pi.exec(command, args, options?)
Run a shell command. `result = { stdout, stderr, code, killed }`.
```typescript
const r = await pi.exec("git", ["status"], { signal, timeout: 5000 });
```

### pi.getActiveTools() / pi.getAllTools() / pi.setActiveTools(names)
`getActiveTools()` → `string[]`. `getAllTools()` → metadata `{ name, description, parameters, promptGuidelines, sourceInfo }`.
`sourceInfo.source` is `"builtin"`, `"sdk"`, or extension metadata. `setActiveTools`
controls which are active (additive changes enable dynamic loading — see custom-tools.md).

### pi.setModel(model)
Returns `false` if no API key is available. See `models.md` for configuring models.

### pi.getThinkingLevel() / pi.setThinkingLevel(level)
`level` ∈ `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`, clamped
to model capability. Emits `thinking_level_select`.

### pi.events
Shared event bus between extensions: `pi.events.on("ns:event", cb)` / `.emit("ns:event", data)`.

### pi.registerProvider(name, config) / pi.unregisterProvider(name)
See `references/providers.md`. Calls after the load phase take effect immediately.

## ExtensionContext (`ctx`) — all handlers

| Field | Notes |
|---|---|
| `ctx.ui` | UI methods (dialogs, status, widgets, components). See custom-ui.md. |
| `ctx.mode` | `"tui" | "rpc" | "json" | "print"`. Guard TUI-only features with `=== "tui"`. |
| `ctx.hasUI` | `true` in TUI & RPC, `false` in print/json. Guard dialogs AND notify/status/widget with it. |
| `ctx.cwd` | Current working directory. Use `CONFIG_DIR_NAME` (not a hardcoded `.pi`) for project-local config paths. |
| `ctx.isProjectTrusted()` | Whether project-local trust is active (incl. temp/CLI overrides). Check before honoring project-local config. |
| `ctx.sessionManager` | Read-only session state: `getEntries()`, `getBranch()`, `buildContextEntries()`, `getLeafId()`, `getSessionFile()`, `getLabel(id)`. See session-format.md. |
| `ctx.modelRegistry` / `ctx.model` / `ctx.thinkingLevel` / `ctx.scopedModels` | Models/providers/auth. `getProvider(id)`, `getProviderAuth(id)`, `find(provider,id)`, `getAvailable()`. `scopedModels` mirrors `/scoped-models`. |
| `ctx.signal` | Current agent AbortSignal during active turns (`tool_call`, `tool_result`, `message_update`, `turn_end`); usually `undefined` when idle. Use for `fetch(..., { signal })`, model calls, abort-aware helpers. |
| `ctx.isIdle()` / `ctx.abort()` / `ctx.hasPendingMessages()` | `isIdle()` is false during runs, retries, auto-compaction retries, queued continuations. |
| `ctx.shutdown()` | Graceful shutdown (deferred until idle in interactive/RPC; no-op in print). Emits `session_shutdown`. |
| `ctx.getContextUsage()` | `{ tokens, ... }` for the active model (last assistant usage, else estimate). |
| `ctx.compact({ customInstructions?, onComplete?, onError? })` | Trigger compaction (does not await). |
| `ctx.getSystemPrompt()` | Pi's current system-prompt string (reflects chained `before_agent_start` changes; excludes `context`/`before_provider_request` rewrites). |

`CONFIG_DIR_NAME` import for portable project paths:
```typescript
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
const cfg = join(ctx.cwd, CONFIG_DIR_NAME, "my-ext.json");
```

## ExtensionCommandContext (`ctx`) — command handlers only

Extends `ExtensionContext` with session-control methods. These are command-only
because calling them from event handlers can deadlock.

| Method | Notes |
|---|---|
| `ctx.getSystemPromptOptions()` | Same shape/mutability as `before_agent_start` `event.systemPromptOptions`. Treat as sensitive. |
| `ctx.waitForIdle()` | Await full settle (retries, auto-compaction retries, queued continuations). |
| `ctx.newSession(options?)` | Start a new session. `options: { parentSession?, setup?(sm), withSession?(ctx) }`. Returns `{ cancelled }`. |
| `ctx.fork(entryId, options?)` | Fork/clone. `options.position`: `"before"` (default, restores prompt to editor) \| `"at"` (clone). |
| `ctx.navigateTree(targetId, options?)` | `{ summarize?, customInstructions?, replaceInstructions?, label? }`. |
| `ctx.switchSession(sessionPath, options?)` | `{ withSession?(ctx) }`. Can be cancelled via `session_before_switch`. Discover sessions with `SessionManager.list(cwd)` / `SessionManager.listAll()`. |
| `ctx.reload()` | Same as `/reload`. Emits `session_shutdown` then `session_start{reload}` + `resources_discover{reload}`. Code after `await ctx.reload()` still runs in the OLD frame — treat reload as terminal (`await ctx.reload(); return;`). |

### Session-replacement footguns (`withSession`)
`withSession(ctx)` receives a fresh `ReplacedSessionContext` (adds async
`sendMessage()`/`sendUserMessage()` bound to the new session). It runs only AFTER
the old session emitted `session_shutdown`, was torn down, reloaded, and rebinds.
- The callback runs in the OLD closure. Old `pi`/`ctx`/captured `sessionManager` are
  **stale** and will throw if reused after replacement.
- Only capture plain serializable data (strings, ids, config). Re-establish any
  state your `session_shutdown` cleared.

```typescript
// SAFE
pi.registerCommand("handoff", {
  handler: async (_args, _ctx) => {
    const kickoff = "Continue from the replacement session";
    await _ctx.newSession({ withSession: async (ctx) => { await ctx.sendUserMessage(kickoff); } });
  },
});
```

## State management

**Stateful extensions store state in tool-result `details`** and reconstruct it in
`session_start`. This is what makes `/fork`, branching, and resume work — a variable
in your closure is lost on reload/fork.

```typescript
export default function (pi: ExtensionAPI) {
  let items: string[] = [];

  pi.on("session_start", async (_e, ctx) => {
    items = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult"
          && entry.message.toolName === "my_tool") {
        items = entry.message.details?.items ?? [];
      }
    }
  });

  pi.registerTool({
    name: "my_tool",
    /* ... */
    async execute(_id, params) {
      items.push(params.text);
      return { content: [{ type: "text", text: "Added" }], details: { items: [...items] } };
    },
  });
}
```

For UI-only / non-LLM state, use `pi.appendEntry(customType, data)` and read it back
from `ctx.sessionManager.getEntries()` (filter `entry.type === "custom" && entry.customType === ...`).
