# Custom UI reference

`ctx.ui` is the surface for user interaction and TUI customization. Full prose in
`docs/extensions.md` → "Custom UI"; component API in `tui.md`.

**Always guard:** `ctx.hasUI` (true in TUI + RPC) before dialogs and notify/status/
widget; `ctx.mode === "tui"` before `custom()`, component factories, terminal input,
direct rendering. In RPC some TUI methods are no-ops/return defaults (see rpc.md).

## Dialogs
```typescript
const choice  = await ctx.ui.select("Pick:", ["A", "B", "C"]);   // string | undefined
const ok      = await ctx.ui.confirm("Delete?", "Cannot undo");  // boolean
const name    = await ctx.ui.input("Name:", "placeholder");      // string | undefined
const text    = await ctx.ui.editor("Edit:", "prefilled");       // multi-line
ctx.ui.notify("Done!", "info");                                  // "info" | "warning" | "error" (non-blocking)
```
### Timeout / AbortSignal
`{ timeout }` shows a live countdown and auto-dismisses (select→undefined,
confirm→false, input→undefined). Or pass `{ signal }` for manual control:
```typescript
const ok = await ctx.ui.confirm("Title", "msg", { timeout: 5000 });
const ac = new AbortController(); const id = setTimeout(() => ac.abort(), 5000);
const ok2 = await ctx.ui.confirm("Title", "msg", { signal: ac.signal }); clearTimeout(id);
if (!ok2 && ac.signal.aborted) { /* timed out */ } else if (!ok2) { /* user cancelled */ }
```
See `timed-confirm.ts`.

## Widgets, status, footer, working indicator
```typescript
ctx.ui.setStatus("my-ext", "Processing…");   // footer; clear: setStatus("my-ext", undefined)
ctx.ui.setWidget("my-widget", ["Line 1", "Line 2"]);                       // above editor (default)
ctx.ui.setWidget("my-widget", ["..."], { placement: "belowEditor" });      // below editor
ctx.ui.setWidget("my-widget", (tui, theme) => new Text(theme.fg("accent", "Hi"), 0, 0)); // component
ctx.ui.setWidget("my-widget", undefined);                                  // clear

ctx.ui.setWorkingMessage("Thinking deeply…"); ctx.ui.setWorkingMessage();  // restore default
ctx.ui.setWorkingVisible(false);                                           // hide the loader row entirely
ctx.ui.setWorkingIndicator({ frames: [ctx.ui.theme.fg("accent", "●")] });  // static; add frames + intervalMs for animation
ctx.ui.setWorkingIndicator({ frames: [t.fg("dim","·"), t.fg("muted","•"), t.fg("accent","●"), t.fg("muted","•")], intervalMs: 120 });
ctx.ui.setWorkingIndicator({ frames: [] });  // hide;  setWorkingIndicator() restores default

ctx.ui.setFooter((tui, theme) => ({ render: (width) => [theme.fg("dim", "custom footer")], invalidate() {} }));
ctx.ui.setFooter(undefined);                // restore built-in footer
ctx.ui.setTitle("pi - my-project");         // terminal title
ctx.ui.setEditorText("prefill"); const cur = ctx.ui.getEditorText();
ctx.ui.pasteToEditor("pasted");             // triggers paste handling (collapse for large content)
const was = ctx.ui.getToolsExpanded(); ctx.ui.setToolsExpanded(true); ctx.ui.setToolsExpanded(was);
```
Working-indicator frames render verbatim — add color via `ctx.ui.theme.fg(...)` yourself.

## Autocomplete providers
Stack custom completion on top of the built-in slash/path provider. Inspect text
before the cursor; return your suggestions when your syntax matches, else delegate
to `current`. Set `triggerCharacters` for custom triggers (e.g. `["#"]`).
```typescript
ctx.ui.addAutocompleteProvider((current) => ({
  triggerCharacters: ["#"],
  async getSuggestions(lines, line, col, options) {
    const before = (lines[line] ?? "").slice(0, col);
    const m = before.match(/(?:^|[ \t])#([^\s#]*)$/);
    if (!m) return current.getSuggestions(lines, line, col, options);
    return { prefix: `#${m[1] ?? ""}`, items: [{ value: "#123", label: "#123", description: "..." }] };
  },
  applyCompletion(lines, line, col, item, prefix) { return current.applyCompletion(lines, line, col, item, prefix); },
  shouldTriggerFileCompletion(lines, line, col) { return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true; },
}));
```
See `github-issue-autocomplete.ts` (preloads open issues from `gh issue list`).

## Theme management
```typescript
const themes = ctx.ui.getAllThemes();           // [{ name, path }]
const t = ctx.ui.getTheme("light");             // load without switching
const r = ctx.ui.setTheme("light");             // switch by name; r.success / r.error
ctx.ui.setTheme(t!);                            // or by Theme object
ctx.ui.theme.fg("accent", "styled");            // current theme helpers (see Theme colors)
```

## Theme colors & styles (all render fns get `theme`)
```typescript
theme.fg("toolTitle", text); theme.fg("accent"|"success"|"error"|"warning"|"muted"|"dim", text);
theme.bold(text); theme.italic(text); theme.strikethrough(text);
```

## Full-screen custom component: `ctx.ui.custom(cb)`
Temporarily replaces the editor with your component until `done(value)` is called.
Returns the value passed to `done`. **TUI only.**
```typescript
import { Text } from "@earendil-works/pi-tui";
const result = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
  const t = new Text("Enter=confirm, Esc=cancel", 1, 1);
  t.onKey = (key) => { if (key === "return") done(true); if (key === "escape") done(false); return true; };
  return t;
});
```
Callback receives `tui`, `theme`, `keybindings` (KeybindingsManager), `done(value)`.

### Overlay mode (experimental) — modal without clearing the screen
```typescript
const r = await ctx.ui.custom<string | null>((t, th, kb, done) => new MyOverlay({ onClose: done }), { overlay: true });
// Advanced positioning + programmatic control:
await ctx.ui.custom(/*...*/, {
  overlay: true,
  overlayOptions: { anchor: "top-right", width: "50%", margin: 2 },
  onHandle: (handle) => { handle.focus(); /* handle.unfocus({target}); handle.setHidden(b); handle.hide(); */ },
});
```
`handle.unfocus({ target })` releases input to a specific component (`{target:null}`
releases without focusing another). See tui.md for full `OverlayOptions`/`OverlayHandle`,
and `overlay-test.ts` / `overlay-qa-tests.ts`.

## Custom editor (vim/emacs mode)
Replace the main input editor. **Extend `CustomEditor`** (not base `Editor`) to keep
app keybindings (Esc abort, Ctrl+D, model switching); call `super.handleInput(data)`
for keys you don't handle.
```typescript
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

class VimEditor extends CustomEditor {
  private mode: "normal" | "insert" = "insert";
  handleInput(data: string) {
    if (matchesKey(data, "escape") && this.mode === "insert") { this.mode = "normal"; return; }
    if (this.mode === "normal" && data === "i") { this.mode = "insert"; return; }
    super.handleInput(data);
  }
}

pi.on("session_start", (_e, ctx) => {
  const prev = ctx.ui.getEditorComponent();                 // capture to compose/wrap
  ctx.ui.setEditorComponent((t, th, kb) => new VimEditor(t, th, kb));
  // ctx.ui.setEditorComponent(undefined);                  // restore default
});
```
To compose with another extension's editor, wrap `prev?.(t,th,kb)`. Custom editors
and `custom()` components receive `keybindings: KeybindingsManager` as an injected
arg — use that directly, not `getKeybindings()`/`setKeybindings()`.

## Message & entry rendering
Custom **messages** participate in LLM context (sent via `pi.sendMessage`); custom
**entries** do NOT (sent via `pi.appendEntry`, TUI-only).
```typescript
import { Text, Box } from "@earendil-works/pi-tui";

// Message renderer (has LLM context)
pi.registerMessageRenderer("my-ext", (message, { expanded, outputPad }, theme) => {
  let s = theme.fg("accent", `[${message.customType}] `) + message.content;
  if (expanded && message.details) s += "\n" + theme.fg("dim", JSON.stringify(message.details, null, 2));
  return new Text(s, outputPad, 0);
});

// Entry renderer (TUI-only)
pi.registerEntryRenderer("status-card", (entry, { expanded }, theme) => {
  const d = entry.data as { title: string; count: number };
  const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
  box.addChild(new Text(`${theme.bold(d.title)}: ${d.count}`));
  if (expanded) box.addChild(new Text(theme.fg("dim", JSON.stringify(d, null, 2))));
  return box;
});
pi.appendEntry("status-card", { title: "Indexed files", count: 17 });
```

## Mode behavior cheatsheet
| Mode | `ctx.mode` | `ctx.hasUI` | Notes |
|---|---|---|---|
| Interactive | `"tui"` | `true` | Full TUI |
| RPC (`--mode rpc`) | `"rpc"` | `true` | Dialogs/notify via JSON protocol; `custom()` returns `undefined` |
| JSON (`--mode json`) | `"json"` | `false` | Event stream to stdout; UI methods are no-ops |
| Print (`-p`) | `"print"` | `false` | Runs but can't prompt |
