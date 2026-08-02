---
name: tmux-pane-operator
description: Safely interact with tmux panes and windows by discovering available targets, capturing pane state before and after actions, sending commands with a debounce before C-m, and returning structured JSON feedback from the updated pane output. Use this whenever the user asks to inspect, control, automate, or debug tmux panes/windows, send commands into a tmux session, or compare tmux state before and after an action.
---

# tmux-pane-operator

Use this skill to make tmux interactions reproducible, inspectable, and easy to feed back into later agent steps.

## Goals
- Discover sessions, windows, and panes when the target is not explicit.
- Capture pane/window state before acting.
- Send the intended command into a specific tmux pane.
- Wait briefly before Enter so keys do not get dropped.
- Capture the state again after the command runs.
- Return machine-readable JSON plus a human-readable diff excerpt.

## Bundled helper
Use the bundled script for most operations:

- `./scripts/tmux_send_capture.sh`

It supports three core capabilities:
1. **Pane/window discovery**
2. **Safe command send with debounce**
3. **Before/after capture with diff + JSON result**

## Standard workflow
1. **Discover the target first when needed**
   - If the user gave `session:window.pane` or a tmux pane id like `%123`, use it directly.
   - Otherwise run discovery and choose the active pane or the pane that best matches the request.
   - If multiple panes look plausible, mention the ambiguity.

2. **Snapshot before touching the pane**
   - Save both pane text and metadata.
   - Also save global `list-panes` and `list-windows` output when window context matters.

3. **Send the command in two steps**
   - Send literal command text first with `send-keys -l`.
   - Sleep briefly.
   - Then send `C-m` separately.

4. **Capture after the command**
   - Wait a short time after submit.
   - Capture the pane again.
   - Produce a diff and a short changed-output excerpt.

5. **Return structured feedback**
   - Prefer returning `result.json` content or summarizing it.
   - Include resolved target, snapshot paths, whether output changed, and the excerpt.

## Commands

### 1) Discover panes/windows
```bash
.agents/skills/tmux-pane-operator/scripts/tmux_send_capture.sh --list
```

This writes discovery files under `./tmux-snapshots/<timestamp>/` and prints JSON like:

```json
{
  "mode": "discovery",
  "resolved_target": "mysession:0.1",
  "snapdir": "./tmux-snapshots/20250926-153000",
  "files": {
    "panes": "./tmux-snapshots/20250926-153000/panes.discovery.txt",
    "windows": "./tmux-snapshots/20250926-153000/windows.discovery.txt"
  }
}
```

### 2) Send a command to an explicit pane
```bash
.agents/skills/tmux-pane-operator/scripts/tmux_send_capture.sh \
  -t mysession:0.1 \
  -c "pytest -q" \
  -d 0.15 \
  -p 0.50
```

Pane ids like `%123` are also supported:

```bash
.agents/skills/tmux-pane-operator/scripts/tmux_send_capture.sh \
  -t %123 \
  -c "pwd"
```

### 3) Send a command to the active pane automatically
```bash
.agents/skills/tmux-pane-operator/scripts/tmux_send_capture.sh \
  -c "npm test" \
  -d 0.15 \
  -p 0.50
```

## Output files
Each run writes a snapshot directory containing:
- `before.meta`  (includes `id=%...` and `target=session:window.pane`)
- `before.txt`
- `after.meta`   (includes `id=%...` and `target=session:window.pane`)
- `after.txt`
- `panes.before.txt`  (includes both `id=%...` and `target=...`)
- `panes.after.txt`
- `windows.before.txt`
- `windows.after.txt`
- `diff.txt`
- `excerpt.txt`
- `result.json`

## JSON contract
`result.json` contains:
- `status`
- `snapdir`
- `requested_target`
- `resolved_target`
- `command`
- `debounce_seconds`
- `post_pause_seconds`
- `history_start`
- `files`
- `feedback.changed`
- `feedback.added_line_count`
- `feedback.removed_line_count`
- `feedback.excerpt`

Use this JSON when another tool or agent step needs structured feedback.

## Good operating rules
- Use `send-keys -l` for literal command text.
- Keep `C-m` separate from the typed command.
- Default debounce is `0.15s`; increase if tmux or the remote shell is laggy.
- If output is noisy, increase history capture with `--history-start -4000`.
- For long-running commands, capture more than once if the user wants a later steady-state result.
- If the action may change windows/panes, review `panes.after.txt` and `windows.after.txt`, not just the pane text.

## Reporting back to the user
When using this skill, report:
- target requested vs resolved,
- command sent,
- where snapshots were saved,
- whether the pane output changed,
- and a short excerpt from `feedback.excerpt`.

## What success looks like
A good tmux interaction always leaves behind:
- discovery context,
- the target pane/window identifier,
- the pre-action snapshot,
- the sent command,
- the post-action snapshot,
- a diff,
- and concise structured feedback.
