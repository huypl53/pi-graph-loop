# Custom tools reference

Tools are capabilities the LLM can call via `pi.registerTool()` (or `defineTool()`
+ register). They appear in the system prompt and can have custom rendering. Full
prose in `docs/extensions.md` → "Custom Tools".

## Definition

```typescript
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const myTool = defineTool({
  name: "my_tool",                       // must be unique; same name as a built-in → override
  label: "My Tool",                      // TUI label
  description: "Shown to the LLM.",      // THE most important field for triggering
  promptSnippet: "One-liner for the system prompt 'Available tools' section",  // omit to stay out of that section
  promptGuidelines: [                    // bullets added to 'Guidelines' while tool is active
    "Use my_tool when the user asks to X. Prefer it over editing files directly.",
  ],
  parameters: Type.Object({              // typebox schema. Use StringEnum for enums (NOT Type.Union/Literal — breaks Google)
    action: StringEnum(["list", "add"] as const),
    text: Type.Optional(Type.String({ description: "..." })),
  }),
  prepareArguments(args) { /* optional shim, see below */ return args; },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    if (signal?.aborted) return { content: [{ type: "text", text: "Cancelled" }] };
    onUpdate?.({ content: [{ type: "text", text: "Working..." }], details: { progress: 50 } });

    // Run shell commands via the captured pi closure:
    const r = await pi.exec("echo", [params.text ?? ""]);

    return {
      content: [{ type: "text", text: "Done" }],  // sent to the LLM
      details: { out: r.stdout },                  // for rendering + state reconstruction
      // usage: nestedModelUsage,   // optional: nested LLM calls' combined Usage
      // terminate: true,           // optional: skip the follow-up LLM call if every result in the batch terminates
    };
  },

  // Optional custom rendering (see "Custom rendering"):
  renderCall(args, theme, context) { /* ... */ },
  renderResult(result, options, theme, context) { /* ... */ },
});

export default function (pi: ExtensionAPI) { pi.registerTool(myTool); }
```

### `promptGuidelines` rule
Bullets are appended **flat** to the `Guidelines` section with no tool-name prefix.
Each bullet MUST name its tool: "Use `my_tool` when…" — never "Use this tool when…".

## Signaling errors
**Throw** from `execute` to mark the result failed (`isError: true`, reported to the
LLM, execution continues). Returning a value never sets the error flag.
```typescript
async execute(_id, params) {
  if (!valid(params.x)) throw new Error(`Invalid x: ${params.x}`);
  return { content: [{ type: "text", text: "OK" }], details: {} };
}
```

## `prepareArguments(args)` — optional compatibility shim
Runs BEFORE schema validation and `execute`. Use to fold legacy field shapes into
the current schema (e.g. old sessions stored top-level `oldText`/`newText` but the
schema now wants `edits: [{oldText,newText}]`). Keep the public `parameters` strict
— don't add deprecated fields just to resume old sessions. Returns the object to
validate against `parameters`.

## Output truncation (for large/unbounded outputs)
Not every tool needs this — only ones that may return large or unbounded output
(shell commands, search/grep, file reads, logs, big API responses). Small
fixed-size results (a converted value, a short list, compact JSON) don't need
truncation. When it applies, cap **50KB / 2000 lines** (whichever first). Helpers:
```typescript
import {
  truncateHead, truncateTail, truncateLine, formatSize,
  DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";

const t = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
let result = t.content;
if (t.truncated) {
  const tmp = writeTempFile(output);   // save full output
  result += `\n\n[Output truncated: ${t.outputLines}/${t.totalLines} lines (${formatSize(t.outputBytes)}/${formatSize(t.totalBytes)}). Full output: ${tmp}]`;
}
```
`truncateHead` for beginnings that matter (search results, file reads); `truncateTail`
for endings that matter (logs, command output). Always tell the LLM it was truncated
and where the full output is. State the limits in the tool `description`. See
`truncated-tool.ts`.

## File-mutating tools → `withFileMutationQueue`
Tool calls run **in parallel** by default. Without the queue, two tools can both
read the original file, compute separate edits, and one write silently wins. Queue
the entire read-modify-write window on the resolved absolute target path (realpath'd
for existing files so symlinks share a queue).
```typescript
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async execute(_id, params, _s, _u, ctx) {
  const abs = resolve(ctx.cwd, params.path);
  return withFileMutationQueue(abs, async () => {
    await mkdir(dirname(abs), { recursive: true });
    const cur = await readFile(abs, "utf8");
    await writeFile(abs, cur.replace(params.oldText, params.newText), "utf8");
    return { content: [{ type: "text", text: `Updated ${params.path}` }], details: {} };
  });
}
```

Also: **strip a leading `@`** from path args (some models add it; built-in tools do).

## Multiple tools sharing state
One extension can register many tools + session handlers for shared resources:
```typescript
let conn: any = null;
pi.registerTool({ name: "db_connect", /* ... */ });
pi.registerTool({ name: "db_query", /* ... */ });
pi.registerTool({ name: "db_close", /* ... */ });
pi.on("session_shutdown", async () => { conn?.close(); conn = null; });
```
Put reconstructable state in each tool result's `details` (see api-and-context.md "State").

## Overriding built-in tools
Register a tool with a built-in name (`read`, `bash`, `edit`, `write`, `grep`,
`find`, `ls`) to override it. Interactive mode warns. Or start with no built-ins:
`pi --no-builtin-tools -e ./ext.ts`.
- **Rendering is independent per slot.** If your override omits `renderCall`, the
  built-in `renderCall` is used (same for `renderResult`). So you can wrap a tool
  for logging/access-control without reimplementing its UI.
- **`promptSnippet`/`promptGuidelines` are NOT inherited** — redefine them on the
  override if needed.
- **Your result `details` must match the built-in's exact shape** (UI/session logic
  depends on it). Built-in result types: `isReadToolResult`/`ReadToolDetails`,
  `isBashToolResult`/`BashToolDetails`, `isEditToolResult`, `isWriteToolResult`,
  `isGrepToolResult`/`GrepToolDetails`, `isFindToolResult`/`FindToolDetails`,
  `isLsToolResult`/`LsToolDetails`. See `tool-override.ts`.

## Remote / SSH / sandbox execution
Built-in tools accept pluggable `operations` to delegate to remote systems:
```typescript
import { createReadTool, createBashTool, type ReadOperations } from "@earendil-works/pi-coding-agent";

const remoteRead = createReadTool(cwd, {
  operations: { readFile: (p) => sshExec(remote, `cat ${p}`), access: async (p) => { try { await sshExec(remote, `test -r ${p}`); } catch {} } },
});
```
Operations interfaces: `ReadOperations`, `WriteOperations`, `EditOperations`,
`BashOperations`, `LsOperations`, `GrepOperations`, `FindOperations`. For `user_bash`,
reuse pi's local backend via `createLocalBashOperations()`.

Bash tool **spawn hook** (adjust command/cwd/env before execution):
```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: ({ command, cwd, env }) => ({
    command: `source ~/.profile\n${command}`,
    cwd: `/mnt/sandbox${cwd}`,
    env: { ...env, CI: "1" },
  }),
  exposeSessionEnvironment: false, // disable PI_SESSION_ID/FILE/PROVIDER/MODEL/REASONING_LEVEL injection
});
```
See `ssh.ts`, `sandbox/`, `gondolin/`, `interactive-shell.ts`.

## Custom rendering (`renderCall` / `renderResult` / `renderShell`)
By default tool output is wrapped in a `Box` (padding + background). A defined
renderer must return a `Component`. If a slot renderer is omitted/throws, pi falls
back (call → tool name; result → raw `content` text). See `tui.md` for the component
API.

`renderCall(args, theme, context)` and `renderResult(result, options, theme, context)`
each get a `context` with: `args`, `state` (shared across slots), `lastComponent`,
`invalidate()`, `toolCallId`, `cwd`, `executionStarted`, `argsComplete`, `isPartial`,
`expanded`, `showImages`, `isError`. `options` for result also has `expanded`,
`isPartial`.

```typescript
import { Text } from "@earendil-works/pi-tui";
import { keyHint } from "@earendil-works/pi-coding-agent";

renderCall(args, theme, context) {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  let s = theme.fg("toolTitle", theme.bold("my_tool ")) + theme.fg("muted", args.action);
  if (args.text) s += " " + theme.fg("dim", `"${args.text}"`);
  text.setText(s); return text;
},
renderResult(result, { expanded, isPartial }, theme) {
  if (isPartial) return new Text(theme.fg("warning", "Processing…"), 0, 0);
  let s = theme.fg("success", "✓ Done");
  if (expanded && result.details?.items) for (const it of result.details.items) s += "\n  " + theme.fg("dim", it);
  if (!expanded) s += ` (${keyHint("app.tools.expand", "expand")})`;
  return new Text(s, 0, 0);
},
```
- Use `Text` with padding `(0,0)`; the default `Box` handles padding.
- Read `context.args` in `renderResult` (don't copy args into `state`); use `state`
  only for cross-slot data; reuse `context.lastComponent` when you can update in place.
- `renderShell: "self"` → the tool renders its own shell (use only when the default
  box gets in the way; then you own framing/padding/background).

Keybinding hints: `keyHint(id, desc)`, `keyText(id)`, `rawKeyHint(key, desc)`. IDs:
`app.*` (coding-agent, e.g. `app.tools.expand`) and `tui.*` (e.g. `tui.select.confirm`).
See `keybindings.md`.

Syntax highlighting:
```typescript
import { highlightCode, getLanguageFromPath } from "@earendil-works/pi-coding-agent";
highlightCode(code, getLanguageFromPath("/p/file.rs"), theme); // "rust"
```

## Dynamic tool loading
Register many tools, keep a small set active, and have a "loader" tool expand the
active set during execution. Works with every model; on native-capable models the
new definitions are added with stable prompt prefix (deferred loading).
1. Register every tool with `registerTool` (so it's in `getAllTools`).
2. Keep loader tools active; leave searchable tools inactive.
3. In loader `execute`: `pi.setActiveTools([...pi.getActiveTools(), ...matches])` —
   the change must be **additive** (don't remove active tools in the same call).
4. Pi records added tools on the loader's result and exposes them on the next request.

**Native deferred loading:** Anthropic Sonnet/Opus/Fable 4.5+ (not Haiku);
OpenAI `gpt-5.4+`. For a verified custom/proxy model, enable via
`compat.supportsToolReferences: true` (anthropic-messages) or
`compat.supportsToolSearch: true` (openai-responses/-codex-responses). Otherwise the
safe fallback sends the full active tool list (may invalidate the cached prefix).

Keep the loader active all session and **add** tools rather than swapping sets.
Lazily loaded tools should usually rely on their `description` and omit
`promptSnippet`/`promptGuidelines` (activating those rebuilds the system prompt and
can invalidate the prefix even on native-capable providers). See
`dynamic-tools.ts`, `kimi-deferred-tools.ts`, and the full `search_tools` example in
the docs.
