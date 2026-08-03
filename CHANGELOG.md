# Changelog

Notable changes in this project. Newest first.

## Unreleased

### feat(extensions): `message-timestamp` — time at the start of every agent message

- New project-local extension `.pi/extensions/message-timestamp.ts`. It renders a small dim `HH:MM:SS` timestamp line at the very beginning of each agent (assistant) message in the TUI, including every assistant message in a multi-turn (tool-using) reply.
- Implementation: hooks `message_start` for `role === "assistant"` and appends a TUI-only custom entry (`appendEntry` + `registerEntryRenderer`). Using a custom entry means the timestamp is purely visual — it is **not** added to the message content, so it never pollutes the LLM context.
- Hook choice matters: `turn_start` fires before the user message is committed to the log (so an entry there renders above the user message); `message_start` for the assistant role fires as the agent reply itself begins, so the entry lands right at the top of the agent message.
- Validated in an isolated tmux session (`ext-validate-msgts-*`, pi 0.83.0, glm-5.1/zai-coding-cn): confirmed correct placement for both a single-turn reply and a two-turn tool-using reply (one timestamp per assistant message). Snapshots under `tmux-snapshots/`.

### fix(swarm): auto-pump orchestrator mailbox reports

- Fixed a PM/orchestrator reporting bug where workers could correctly update task state and send `swarm_send_message(to="orchestrator")`, but the orchestrator would not notice until it manually polled the mailbox.
- The orchestrator session now runs a session-scoped mailbox pump that marks pending orchestrator messages delivered and surfaces them locally as `swarm-message` events, using `triggerTurn` when idle and `followUp` while busy.
- This preserves mailbox-only routing for the orchestrator pseudo-agent while making completion reports and handoffs visible without manual `swarm_check_mailbox`.

### feat(swarm): engine-enforced task closure for task graph loop

- Added Commit 4 task-graph execution tools to `.pi/extensions/swarm/index.ts`: `swarm_assign_task`, `swarm_update_task`, and `swarm_task_message`.
- Made assignment a durable runtime contract in `task.json`, with task-scoped handoff metadata, active-task lifecycle bookkeeping, and task-state-driven graph advancement.
- Added engine-enforced closure behavior and PM-facing closure summaries/runtime warnings so stale/open assignments, dead-lettered handoffs, ack-done-without-task-update, and other closeout inconsistencies are surfaced from machine state instead of pane text.
- Validated through swarm review/self-validation loops with typecheck-clean current tree and dedicated task-graph closure/detector evidence under `.pi/swarm-uat/runs/`.

### fix(extensions): `compact-resume` — avoid double agent-run on pre-prompt compaction

- **Bug:** the `ctx.isIdle()` delivery branch conflated two idle cases. A
  threshold compaction can also run *before* a queued user message is sent
  (`prompt()` → `_checkCompaction` → `_runAgentPrompt`, while idle) — e.g. after
  resuming a large session, or aborting a huge response then typing. There the
  old code fired `triggerTurn`, starting a second `_runAgentPrompt` that raced
  the user's own run and could corrupt agent state or throw "Agent is already
  processing".
- **Fix:** delivery is now trigger-specific, not just idle-state: manual
  `/compact` (idle, nothing pending) → `triggerTurn`; threshold mid-run
  (`!idle`) → `followUp` (drained by the continuation loop); threshold while
  idle (pre-prompt) → **skip** (a user turn is already imminent, so resuming is
  redundant and unsafe).
- **Validation:** regression-checked both preserved paths in an isolated tmux
  session — the `followUp` probe still yields `FOLLOWUP_OK`, and a manual
  `/compact` still auto-resumes. Snapshot under
  `tmux-snapshots/compact-resume-validation/fix-regression-run.txt` (gitignored).

### feat(swarm): task graph MVP (create/status/validate/print/next)

- Added the first task-graph layer to `.pi/extensions/swarm/index.ts` with task state/types, atomic `task.json` writes, and `.pi/swarm/tasks/<task-id>/` runtime layout.
- Added swarm tools: `swarm_create_task`, `swarm_task_status`, `swarm_validate_graph`, `swarm_print_graph`, and `swarm_next_nodes`.
- Added backward-compatible structured agent metadata defaults for reuse (`roleKind`, `capabilities`, `activeTaskIds`, `maxConcurrentTasks`) plus internal reusable-agent matching.
- Validated in dedicated tmux UAT lanes with real task creation/printing/validation/status flows; evidence kept under `.pi/swarm-uat/runs/`.

### harden(extensions): `compact-resume` followUp probe + settings.json config

- Added a dedicated validation probe at `scripts/compact_resume_followup_probe.ts` to empirically confirm that a `turn_end` hook can queue `pi.sendMessage(..., { deliverAs: "followUp" })` and have pi's continuation loop drain it without user input.
- Hardened `.pi/extensions/compact-resume.ts` config loading so env vars still win, but project-local `.pi/settings.json` can now override `enabled`, `manual`, and `max` under `extensions["compact-resume"]` (or top-level `compactResume`).
- Kept default-on behavior intentionally; the extension exists to close a project-wide usability gap, while `.pi/settings.json` now provides a no-code project override.

### feat(extensions): `compact-resume` — auto-continue the task after compaction

- **Problem:** pi goes idle after an ordinary auto-compaction (`reason:
  "threshold"`) or a manual `/compact` (`reason: "manual"`), because both set
  `willRetry: false`. Only `reason: "overflow"` (a hard context-overflow error
  caught mid-run) auto-retries. So after a normal compact the agent stops and
  you have to type "continue" yourself, even when it was mid-task.
- **Fix:** new project-local extension `.pi/extensions/compact-resume.ts`. It
  hooks the `session_compact` event and injects one `[compact-resume]` message
  that tells the agent to resume in-progress work (or confirm completion).
  Delivery branches on `ctx.isIdle()`: a `followUp` (fed into pi's existing
  continuation loop) during a run, or `triggerTurn: true` when idle.
- **Loop safety:** skips `overflow` (already retries); smart guard stops once a
  resume turn does no tool work; hard cap of consecutive auto-resumes since the
  last real user message (default 5).
- **Config (env):** `PI_COMPACT_RESUME` (0 disables), `PI_COMPACT_RESUME_MANUAL`
  (1 to also resume after explicit `/compact`), `PI_COMPACT_RESUME_MAX`. Status
  via the `/compact-resume` command.
- **Validated:** end-to-end in an isolated tmux session (pi 0.83.0,
  glm-5.1/zai-coding-cn) — after `/compact` the agent automatically started a
  continuation turn, inspected state, and stopped gracefully. Snapshot kept
  under `tmux-snapshots/compact-resume-validation/` (gitignored).
