---
name: pi-extension-creator
description: >-
  Use whenever someone wants pi — Earendil's terminal coding agent (package
  pi-coding-agent; not the number π or a Raspberry Pi) — to behave, look, or
  respond differently than out of the box. Any feature request aimed at pi
  counts, even without the word "extension": a new tool the LLM can call,
  confirming or blocking risky actions, a status line/footer/widget/dialog,
  connecting pi to another model or provider, a /slash command, custom TUI editors
  or screens, reacting to pi starting/compacting/switching models, or state that
  survives /reload. All of these mean writing a TypeScript module against pi's
  ExtensionAPI (registerTool, registerCommand, registerProvider, event hooks like
  tool_call and session_start, render TUI). Covers scaffolding, writing, editing,
  and debugging them. Also matches ~/.pi/agent/extensions, .pi/extensions, the
  -e/--extension flag, or imports from @earendil-works/pi-coding-agent. Not for
  browser or VS Code extensions, unrelated shell scripting, or generic skill
  authoring.
---

# Pi Extension Creator

A **pi extension** is a TypeScript module (no compilation step — pi loads it via
[jiti](https://github.com/unjs/jiti)) that exports a default factory function
receiving an `ExtensionAPI` (conventionally named `pi`). Inside it you subscribe
to lifecycle **events**, register **tools** the LLM can call, add **commands**,
render custom **UI**, and register **providers**.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_e, ctx) => ctx.ui.notify("loaded", "info"));
  pi.registerTool(/* ... */);
  pi.registerCommand("hi", { handler: (_a, ctx) => ctx.ui.notify("hi", "info") });
}
```

## The single most effective move: copy the closest example

pi ships ~60 complete, working example extensions. The fastest path to a correct
extension is to **find the closest example, read it, and adapt it** — you inherit
real working imports, signatures, and patterns. Locate them:

```bash
npm root -g   # → .../node_modules — examples live under
              #   @earendil-works/pi-coding-agent/examples/extensions/
```

The full reference doc is at `…/@earendil-works/pi-coding-agent/docs/extensions.md`
(2963 lines — do NOT read it whole; this skill's `references/` are the condensed,
load-on-demand version).

There is also an **examples map** at the end of this file (section "Examples by
use case") that names the right example for common requests.

## Step 1 — Classify the request

Most extension requests fall into one bucket. Pick the mechanism, then read the
matching reference in this skill for the full API.

| The user wants… | Mechanism | Read this |
|---|---|---|
| A capability the **LLM can call** (query a DB/API, transform data, run a wizard) | `pi.registerTool()` / `defineTool()` | `references/custom-tools.md` |
| **Block or modify** an agent action (dangerous bash, protected paths, log reads) | `pi.on("tool_call")` → `{ block, reason }` | `references/events.md` |
| Intercept/transform **user input** or `!`/`!!` shell commands | `pi.on("input")`, `pi.on("user_bash")` | `references/events.md` |
| A **`/slash` command** | `pi.registerCommand(name, {...})` | `references/api-and-context.md` |
| **Status / footer / widget / notification** in the TUI | `ctx.ui.setStatus/setWidget/setFooter/notify` | `references/custom-ui.md` |
| **Ask the user** something (pick / confirm / type / edit) | `ctx.ui.select/confirm/input/editor` | `references/custom-ui.md` |
| **Full-screen custom UI** (game, wizard, picker, overlay) | `ctx.ui.custom(callback)` | `references/custom-ui.md` |
| A **custom editor** (vim/emacs mode) | `ctx.ui.setEditorComponent()` + `CustomEditor` | `references/custom-ui.md` |
| React to **lifecycle** (git checkpoint, auto-commit, model change, shutdown) | `session_*` / `agent_*` / `model_select` events | `references/events.md` |
| **Modify the system prompt** per turn / inject context | `before_agent_start` (and `systemPromptOptions`) | `references/events.md` |
| **Persist state** across `/reload` or restarts | `pi.appendEntry()` + restore in `session_start` | `references/api-and-context.md` |
| Add a **model / provider** (proxy, local server, OAuth) | `pi.registerProvider(name, config)` | `references/providers.md` |
| A **CLI flag** or **keyboard shortcut** | `pi.registerFlag()` / `pi.registerShortcut()` | `references/api-and-context.md` |
| **Custom rendering** of tool calls/results or messages | `renderCall`/`renderResult`, `registerMessageRenderer` | `references/custom-tools.md`, `references/custom-ui.md` |
| Tools that **load on demand** (too many to keep active) | dynamic tool loading via `pi.setActiveTools()` | `references/custom-tools.md` |

Many real extensions combine several (e.g. a tool + a command + custom rendering
+ persisted state — see `todo.ts`, `plan-mode/`).

## Step 2 — Scaffold

### Where the file goes (matters for `/reload`)

| Location | Scope |
|----------|-------|
| `~/.pi/agent/extensions/<name>.ts` | Global, all projects |
| `~/.pi/agent/extensions/<name>/index.ts` | Global, multi-file |
| `.pi/extensions/<name>.ts` | Project-local (loads only after the project is **trusted**) |
| `.pi/extensions/<name>/index.ts` | Project-local, multi-file |

Put extensions in one of these for **auto-discovery + hot-reload** via `/reload`.
Use the `-e/--extension ./path.ts` flag only for quick one-off tests.

**Structure by complexity:**
- **Single file** (default): one `.ts`. Start here.
- **Directory** (`<name>/index.ts`): split helpers across files.
- **Package** (`<name>/` with `package.json` declaring `dependencies` and a `pi.extensions` entry pointing at the source): only when you need npm deps. Run `npm install` in the dir; `node_modules/` imports resolve automatically. Node built-ins (`node:fs`, `node:path`…) are always available.

### Security note to pass on
Extensions run with the user's full system permissions and can execute arbitrary
code. Say so if you're installing/running something from an untrusted source.

## Minimal templates

Copy, rename, fill in. All are valid as-is.

### Custom tool (the most common request)
```typescript
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const myTool = defineTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does (this text is shown to the LLM).",
  // promptSnippet: "...",          // optional: one line in the system prompt's "Available tools"
  // promptGuidelines: ["Use my_tool when ..."],  // must NAME the tool (no "this tool")
  parameters: Type.Object({
    input: Type.String({ description: "..." }),
    // choice: StringEnum(["a","b"] as const),   // enums: use StringEnum from @earendil-works/pi-ai, NOT Type.Union
  }),
  async execute(_toolCallId, params, signal, onUpdate, ctx) {
    // Signal errors by THROWING (sets isError: true, reported to LLM). Returning never sets the error flag.
    // Stream progress: onUpdate?.({ content: [{ type: "text", text: "Working..." }] });
    return {
      content: [{ type: "text", text: `Result for ${params.input}` }],
      details: {}, // put reconstructable state here (see "State" in api-and-context.md)
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(myTool);
}
```

### Permission gate / event hook
```typescript
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      const cmd = event.input.command;            // typed: { command: string; timeout?: number }
      if (/\brm\s+-rf\b/.test(cmd)) {
        if (!ctx.hasUI) return { block: true, reason: "dangerous, no UI to confirm" };
        const ok = await ctx.ui.confirm("Dangerous!", `Allow?\n\n${cmd}`);
        if (!ok) return { block: true, reason: "Blocked by user" };
      }
    }
    // To MUTATE args instead of blocking: event.input.command = "source ~/.profile\n" + event.input.command;
    return undefined; // pass through
  });
}
```

### Slash command
```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("stats", {
    description: "Show entry count",
    // getArgumentCompletions: (prefix) => [...]?,   // optional autocomplete
    handler: async (_args, ctx) => {
      ctx.ui.notify(`${ctx.sessionManager.getEntries().length} entries`, "info");
    },
  });
}
```

### Status / widget (TUI-only features must be guarded)
```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("turn_start", (_e, ctx) => {
    if (!ctx.hasUI) return;                 // print/json mode: no UI
    ctx.ui.setStatus("my-ext", "thinking…"); // footer; clear with setStatus("my-ext", undefined)
  });
}
```

### Provider (proxy / local server)
```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("my-proxy", {
    name: "My Proxy",
    baseUrl: "https://proxy.example.com",
    apiKey: "$PROXY_API_KEY",          // env var; $$ escapes a literal $
    api: "anthropic-messages",          // or "openai-completions" / "openai-responses"
    models: [
      {
        id: "claude-sonnet-4-5",
        name: "Sonnet (proxy)",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  });
}
```
For dynamic model discovery, OAuth, or native provider objects, see `references/providers.md`.

## Critical rules (these bite)

These are the high-value correctness rules. Explanations are in the references;
this is the checklist.

1. **TypeScript runs uncompiled.** No build step. Just write `.ts`.
2. **Guard UI.** Extensions also run in `print`/`json`/`rpc` modes. Use `ctx.hasUI`
   before `select/confirm/input/editor` and `notify/setStatus/setWidget`. Use
   `ctx.mode === "tui"` before `ctx.ui.custom()` and component factories.
3. **Truncate large tool output.** Only tools that return large or unbounded output
   (shell commands, search/grep, file reads, logs, big API responses) need it — cap
   ~50KB / 2000 lines or the LLM context overflows. Small fixed-size results (a value,
   a short list, compact JSON) don't need truncation. Use `truncateHead`/`truncateTail`
   from the package; tell the LLM where the full output was saved. (See `custom-tools.md`.)
4. **Enums → `StringEnum`** from `@earendil-works/pi-ai`. `Type.Union`/`Type.Literal`
   breaks Google's API.
5. **File-mutating tools → `withFileMutationQueue(path, fn)`.** Tool calls run in
   parallel; without the queue two tools read stale contents and one write is lost.
   Pass the resolved absolute target path; queue the whole read-modify-write window.
6. **Don't start background resources in the factory** (processes, sockets, watchers,
   timers). Factories can run with no session. Defer to `session_start` and clean up
   in an idempotent `session_shutdown` handler.
7. **Signal tool errors by throwing**, not by returning something. The thrown error
   is caught, marked `isError: true`, reported to the LLM, and execution continues.
8. **State lives in tool-result `details`**, then reconstruct it in `session_start`
   by scanning `ctx.sessionManager.getBranch()`. This is what makes branching/`/fork`
   work correctly.
9. **Strip a leading `@`** from path arguments in custom tools (some models add it).
   Built-in tools already do this.
10. **`promptGuidelines` must name the tool.** Bullets are appended flat with no
    prefix, so write "Use `my_tool` when…" never "Use this tool when…".
11. **`event.input` is mutable in `tool_call`** — mutate in place to patch args
    before execution. Return values there only control *blocking*.
12. **`defineTool()` + `pi.registerTool()`** is the clean way to define tools; you
    can also pass the definition inline to `registerTool`. Tools registered after
    startup appear immediately (no `/reload` needed).

## Step 3 — Verify the extension

1. **Quick test (works out of the box):** load it and watch for load errors.
   ```bash
   pi -e ./<your-extension>.ts
   ```
   pi loads via jiti (no build step). Load errors are logged while pi keeps
   running, so a silently-missing extension usually means a thrown error in the
   factory or a bad import.
2. **Iterate without restarting:** once the file is in an auto-discovered location
   (`~/.pi/agent/extensions/` or `.pi/extensions/`), run `/reload` inside pi to
   hot-reload it.
3. **Optional type-check** — only useful where the pi packages resolve, i.e. a
   package-based extension dir with its own `node_modules/`, or a workspace that
   has `@earendil-works/pi-coding-agent` installed. A lone `.ts` in an arbitrary
   folder will NOT resolve `@earendil-works/*` imports (the global install lives
   off the node resolution path), so skip tsc there and rely on step 1:
   ```bash
   npx tsc --noEmit --module nodenext --moduleResolution nodenext \
     --skipLibCheck --target es2022 --lib es2022 ./<your-extension>.ts
   ```
   (jiti is type-lenient at runtime, so a tsc pass before testing is a bonus, not
   a requirement.)

## Reference map (read on demand)

Detailed, condensed API docs live in `references/` next to this file. Read the one
that matches Step 1 when you need more than the minimal template:

- **`references/events.md`** — every event (lifecycle overview, `session_*`,
  `agent_*`, `tool_call`/`tool_result`, `input`, `user_bash`, provider hooks,
  `model_select`), their event payloads and return shapes.
- **`references/api-and-context.md`** — all `pi.*` methods (`registerCommand`,
  `sendMessage`/`sendUserMessage`, `appendEntry`, `registerShortcut`/`registerFlag`,
  `exec`, tool/model management, `events` bus), the full `ExtensionContext` (`ctx.*`)
  and `ExtensionCommandContext`, and state-management patterns.
- **`references/custom-tools.md`** — tool definition in depth, `prepareArguments`,
  truncation, overriding built-ins, remote/SSH execution, custom `renderCall`/
  `renderResult`, and dynamic tool loading.
- **`references/custom-ui.md`** — `ctx.ui` dialogs (incl. timeouts/AbortSignal),
  widgets/status/footer, autocomplete providers, `ctx.ui.custom()` + overlays,
  custom editors (`CustomEditor`), message/entry renderers, theme colors, syntax
  highlighting.
- **`references/providers.md`** — `registerProvider` config options, dynamic
  `refreshModels`, OAuth, native `Provider` objects, `unregisterProvider`.

## Examples by use case

Read the named example file under `…/@earendil-works/pi-coding-agent/examples/extensions/`
and adapt it. (See "The single most effective move" above for how to find the dir.)

| Request | Example(s) |
|---|---|
| Minimal tool | `hello.ts` |
| Tool that asks the user a question | `question.ts`, `questionnaire.ts` |
| Stateful tool + custom rendering + persistence | `todo.ts` |
| Tool with truncated output (wraps `rg`) | `truncated-tool.ts` |
| Override a built-in tool (e.g. `read`) | `tool-override.ts` |
| Structured-output tool that ends the turn | `structured-output.ts` |
| Register tools at runtime / after startup | `dynamic-tools.ts`, `dynamic-tools/` |
| Block dangerous bash / protected paths | `permission-gate.ts`, `protected-paths.ts` |
| Transform user input | `input-transform.ts`, `input-transform-streaming.ts` |
| Adjust bash command/cwd/env | `bash-spawn-hook.ts` |
| System prompt changes per turn | `pirate.ts`, `prompt-customizer.ts`, `claude-rules.ts` |
| Custom compaction | `custom-compaction.ts`, `trigger-compact.ts` |
| Git checkpoint / auto-commit | `git-checkpoint.ts`, `auto-commit-on-exit.ts` |
| Footer status / model status | `status-line.ts`, `model-status.ts` |
| Widget above/below editor | `widget-placement.ts`, `custom-footer.ts`, `custom-header.ts` |
| Custom working spinner | `working-indicator.ts` |
| Autocomplete (e.g. `#1234` issues) | `github-issue-autocomplete.ts` |
| Full-screen interactive UI / game | `snake.ts`, `qna.ts`, `summarize.ts` |
| Overlay component | `overlay-test.ts` |
| Custom (modal) editor | `modal-editor.ts`, `rainbow-editor.ts` |
| Inter-extension event bus | `event-bus.ts` |
| Inject user messages / send messages | `send-user-message.ts`, `file-trigger.ts` |
| Reload runtime via tool | `reload-runtime.ts` |
| Session name / bookmarks | `session-name.ts`, `bookmark.ts` |
| SSH / sandbox / remote tools | `ssh.ts`, `sandbox/`, `gondolin/` |
| Sub-agents | `subagent/` |
| Custom provider (proxy / OAuth) | `custom-provider-anthropic/`, `custom-provider-gitlab-duo/` |
| Full kitchen-sink extension | `plan-mode/`, `preset.ts`, `tools.ts` |
| Extension with npm dependencies | `with-deps/` |

When several examples are close, prefer reading the **smallest** one that
demonstrates the API you need, then borrow structure from a larger one.
