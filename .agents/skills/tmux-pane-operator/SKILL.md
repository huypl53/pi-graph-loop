---
name: tmux-pane-operator
description: Safely interact with tmux panes and windows by discovering available targets, creating isolated validation sessions when needed, capturing pane state before and after actions, sending commands with a debounce before C-m, and returning structured JSON feedback from the updated pane output. Use this whenever the user asks to inspect, control, automate, or debug tmux panes/windows, send commands into a tmux session, create a tmux validation/review environment, or compare tmux state before and after an action.
---

# tmux-pane-operator

Use this skill to make tmux interactions reproducible, inspectable, and easy to feed back into later agent steps.

## Goals
- Discover sessions, windows, and panes when the target is not explicit.
- Create an isolated tmux session for validation or review when the workflow needs a fresh environment.
- Capture pane/window state before acting.
- Send the intended command into a specific tmux pane.
- Wait briefly before Enter so keys do not get dropped.
- Optionally wait for a readiness pattern in pane output.
- Capture the state again after the command runs.
- Return machine-readable JSON plus a human-readable diff excerpt.

## Bundled helper
Use the bundled script for most operations:

- `./scripts/tmux_run_capture.sh`

It supports four core capabilities:
1. **Pane/window discovery**
2. **Isolated tmux session creation for validation/review**
3. **Safe command send with debounce**
4. **Before/after capture with diff + JSON result**

## Standard workflow
1. **Discover or provision the target first**
   - If the user gave `session:window.pane` or a tmux pane id like `%123`, use it directly.
   - If the task needs a fresh validation environment, create a dedicated session first.
   - Otherwise run discovery and choose the active pane or the pane that best matches the request.
   - If multiple panes look plausible, mention the ambiguity.

2. **Prefer isolated sessions for validation/review**
   - For extension testing, long-running commands, or anything the user may want to inspect later, create a dedicated tmux session.
   - Use a clear name such as `ext-validate-<feature>-<timestamp>`.
   - Reuse a named session only when you intentionally want continuity.

3. **Snapshot before touching the pane**
   - Save both pane text and metadata.
   - Also save global `list-panes` and `list-windows` output when window context matters.

4. **Send the command in two steps**
   - Send literal command text first with `send-keys -l`.
   - Sleep briefly.
   - Then send `C-m` separately.

5. **Wait for readiness when appropriate**
   - For interactive tools like `pi`, use `--wait-for` to wait for a prompt or expected startup text.
   - Prefer a short regex that proves the pane is ready for the next step.

6. **Capture after the command**
   - Wait a short time after submit.
   - Capture the pane again.
   - Produce a diff and a short changed-output excerpt.

7. **Return structured feedback**
   - Prefer returning `result.json` content or summarizing it.
   - Include resolved target, session name if created, snapshot paths, whether output changed, and the excerpt.

## Commands

### 1) Discover panes/windows
```bash
.agents/skills/tmux-pane-operator/scripts/tmux_run_capture.sh --list
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

### 2) Create a dedicated validation session
```bash
.agents/skills/tmux-pane-operator/scripts/tmux_run_capture.sh \
  --create-session ext-validate-my-feature-$(date +%H%M%S) \
  --window-name validate \
  --cwd /path/to/project
```

This creates a detached tmux session, captures its initial pane state, and returns JSON containing the resolved target so later steps can send commands into the same pane.

### 3) Create or reuse a dedicated session, then start pi in it

Bare `pi` uses the defaults already configured in `~/.pi/agent/settings.json`
(defaultModel/defaultProvider) with credentials from `~/.pi/agent/auth.json` —
prefer this whenever you do not need a specific model. Only pass
`--model`/`--provider` flags when you have verified BOTH the model id and the
provider's API key exist (`pi auth` or check `~/.pi/agent/auth.json`); a valid
-looking combo without a stored key makes pi exit with `No API key found for
<provider>` and the pane looks mysteriously dead:

```bash
.agents/skills/tmux-pane-operator/scripts/tmux_run_capture.sh \
  --create-session ext-validate-<name>-$(date +%H%M%S) \
  --window-name validate \
  --cwd /path/to/project \
  -c "pi" \
  --wait-for "pi|>"
```

(If you do need a specific lane, first confirm the provider is authenticated,
then e.g. `-c "pi --model gpt-5.4-mini --provider openai"`.)

If you want to reuse a known session name:
```bash
.agents/skills/tmux-pane-operator/scripts/tmux_run_capture.sh \
  --create-session ext-validate-shared \
  --reuse-session \
  -c "pwd"
```

### 4) Send a command to an explicit pane
```bash
.agents/skills/tmux-pane-operator/scripts/tmux_run_capture.sh \
  -t mysession:0.1 \
  -c "pytest -q" \
  -d 1.0 \
  -p 0.50
```

Pane ids like `%123` are also supported:

```bash
.agents/skills/tmux-pane-operator/scripts/tmux_run_capture.sh \
  -t %123 \
  -c "pwd"
```

### 5) Send a command to the active pane automatically
```bash
.agents/skills/tmux-pane-operator/scripts/tmux_run_capture.sh \
  -c "npm test" \
  -d 1.0 \
  -p 0.50
```

### 6) Wait for specific output before reporting success
```bash
.agents/skills/tmux-pane-operator/scripts/tmux_run_capture.sh \
  -t mysession:0.1 \
  -c "pi" \
  --wait-for "provider|model|>" \
  --wait-timeout 15
```

## Recommended extension validation flow
When validating a pi extension, prefer this sequence:
1. Create a dedicated tmux session for the run.
2. Start `pi` in that session — bare `pi` unless you have verified a specific
   model/provider pair is authenticated (see §3).
3. Wait for startup text or prompt with `--wait-for`.
4. Send the smallest realistic validation action that exercises the extension.
5. Capture the result JSON and keep the tmux target + snapshot paths for the final report.
6. Leave the session alive unless the user explicitly wants cleanup, so they can review it.

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
- `mode` (`discovery`, `create`, or `send`)
- `snapdir`
- `requested_target`
- `resolved_target`
- `command`
- `debounce_seconds`
- `post_pause_seconds`
- `history_start`
- `session.requested_name`
- `session.created`
- `wait.pattern`
- `wait.status`
- `wait.timeout_seconds`
- `wait.interval_seconds`
- `wait.elapsed_seconds`
- `files`
- `feedback.changed`
- `feedback.added_line_count`
- `feedback.removed_line_count`
- `feedback.excerpt`

Use this JSON when another tool or agent step needs structured feedback.

## Good operating rules
- Use `send-keys -l` for literal command text.
- Keep `C-m` separate from the typed command.
- Default debounce is `1.0s`; reduce or increase it depending on how quickly the target shell/TUI reliably accepts Enter after pasted text.
- If output is noisy, increase history capture with `--history-start -4000`.
- For interactive startup flows, use `--wait-for` instead of relying only on fixed sleeps.
- For long-running commands, capture more than once if the user wants a later steady-state result.
- If the action may change windows/panes, review `panes.after.txt` and `windows.after.txt`, not just the pane text.
- For user review, do not destroy the validation session unless cleanup was requested.

## Reporting back to the user
When using this skill, report:
- target requested vs resolved,
- whether a new session was created or reused,
- command sent,
- wait pattern and whether it matched,
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
- concise structured feedback,
- and, for validation runs, a persistent tmux session the user can inspect afterward.
