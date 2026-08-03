# Changelog

Notable changes in this project. Newest first.

## Unreleased

### feat(swarm): production hardening batch 1 (task closure sweep, reconcile task sweep, PM summary, task-graph UAT)

- **Project-local default model/provider config:** the swarm extension now reads `.pi/settings.json` before env vars when resolving default child-agent `model` / `provider`. Recommended keys: top-level `swarm.defaultModel` / `swarm.defaultProvider`. `extensions.swarm.defaultModel` / `extensions.swarm.defaultProvider` are still accepted for backward compatibility. Precedence is explicit tool params → `.pi/settings.json` → `PI_SWARM_DEFAULT_MODEL` / `PI_SWARM_DEFAULT_PROVIDER` → code defaults/model presets.
- **Reconcile task sweep (WS-B.3/4):** `swarm_reconcile` now sweeps every `task.json` in addition to the mailbox. It reports stored-vs-derived status drift, surfaces stale/nudge signals (dead/stopped/unhealthy/tmux-dead assignee, missing assignee, dead-lettered assignment, `in_progress` past 24h stale / 30min nudge thresholds, delivered-but-unacked assignment), and stamps advisory `node.staleAt`. New `mark` param persists the recomputed `task.status` to repair drift; reconcile is otherwise mark-only and never auto-fails a node (kept idempotent, no reminder-message storms).
- **PM summary (WS-C):** `/swarm status` now emits a structured rollup (per-task `status/current/next/unacked`, agent counts by runtime/health, `closure:` line) with stable grep-able prefixes, bounded to non-terminal tasks. `swarm_task_status(runtime=true)` already carries the closure block.
- **Cancel path:** `swarm_update_task(force=true, cancelTask=true)` marks a task `cancelled` (sticky; releases all assignments).
- **Task-level blocked derivation:** `computeTaskStatus` now derives task `blocked` when every active (non-terminal, non-pending) node is `blocked` (resumable). Pure; doesn't regress done/failed/in_progress/ready.
- **roleKind id-first inference + self-heal (orchestrator-flagged bug):** `inferRoleKind` now checks the agent id for a strong role keyword before the role text, so e.g. `implementer-02` classifies as `implementer` even when its role prose mentions "reviewer". `ensureAgentDefaults` re-derives `roleKind` unless explicitly pinned (new `roleKindExplicit`), so records self-heal; `swarm_spawn_agent` accepts an optional `roleKind` override.
- **session_shutdown nudge:** now stamps `node.lastActivityAt` and routes the open-assignment nudge to each stale node's assigner (replyTarget) when registered, else orchestrator.
- **PM auto-notify on closure/settle (engine behavior, not prompt policy):** the orchestrator no longer has to poll to learn a worker closed a node or went idle with open work. `swarm_update_task` enqueues a concise mailbox report to the mailbox-only orchestrator when a node transitions into a closure-ish status (`done`/`failed`/`blocked`) — carrying taskId/nodeId/prev→new/outcome/assignee/artifact/task status/next-ready — with a stronger `task <id> closed (<status>)` variant on task-terminal (`done`/`failed`/`cancelled`). `agent_settled` enqueues an `agent <id> settled idle with open assignment(s)` nudge when a worker settles while still holding open work. Both are mailbox-only to `orchestrator`, `requiresAck=false`, gated on the transition (not every update); the settle nudge is cooldown-guarded per agent via persisted `lastSettleNotifyAt` (`SETTLE_NOTIFY_COOLDOWN_MS`) so repeated settles don't storm. No node-status mutation, no tmux inject, no daemon. **Also fixed a pre-existing auto-pump defect** surfaced by the new notifications: `deliverMessageLocked` no longer pre-marks mailbox-only messages in the shared `st.delivered[to]` dedup/surfaced ledger (that set is also used by `pumpOrchestratorMailbox`/`swarm_check_mailbox`), so the orchestrator auto-pump now actually surfaces close/settle/shutdown notifications to a turn without manual `swarm_check_mailbox` polling. The UAT now cross-references pump-traced surfaced ids with the mailbox to assert auto-surface (not just mailbox arrival).
- **Session-safe + read-safe orchestrator surfacing (review-blocker fix):** the auto-pump previously deduped the orchestrator mailbox against a single shared `st.delivered.orchestrator` ledger that several operations wrote (`pumpOrchestratorMailbox`, `swarm_check_mailbox(markDelivered)`, `swarm_ack_message`, tmux-inject paths), so any one of them — including a second orchestrator lane or a validation `pi -p` run — could mark a notification consumed and starve every other orchestrator session of TUI surfacing. The pump now keys "already surfaced" **per process** in a new `st.orchestratorPumpSessions` map (`process.pid`), deliberately **not** `PI_SESSION_ID` (a child `pi -p` spawned from an agent's bash inherits the parent's `PI_SESSION_ID`, so keying on it would reintroduce starvation), and it never reads `st.delivered.orchestrator`. `swarm_check_mailbox` is decoupled from the pump (it keeps using the shared ledger, which the pump ignores), so a manual `check_mailbox(markDelivered=true)` or an explicit ack can no longer pre-empt a later pump surface. Bounded by `PUMP_SCAN_WINDOW`/`PUMP_SESSION_ID_CAP`/`PUMP_SESSION_TTL_MS`. The `mailbox.orchestrator_pump` trace now carries `cid` (pid) and `sid` (`PI_SESSION_ID`) for attribution. UAT section 12 proves both: two distinct orchestrator sessions each surface one notification (no theft), and `check_mailbox(markDelivered)` does not pre-empt a later pump surface.
- **Orchestrator auto-pump is TUI-only + stale-ctx-safe (loop-blocking fix):** the auto-pump surfaces via session-bound TUI APIs (`pi.sendMessage({triggerTurn})`/`ctx.isIdle()`) that are no-ops in print mode and throw `This extension ctx is stale after session replacement or reload` once the captured ctx is invalidated. Because `PI_SWARM_AGENT_ID` defaults to `orchestrator` when unset, every `pi -p` validation/UAT run was starting the pump and reliably hitting that stale-ctx error (it was reproducible across all UAT step `.err` files). The pump now starts only when `ctx.mode === "tui"` (the single interactive PM session by design); non-interactive callers (`pi -p`/rpc/json) read mailboxes via `swarm_check_mailbox`, which never touches a captured ctx. As defense-in-depth, the pump's interval is wrapped so that any ctx error stops the pump cleanly (traced `mailbox.orchestrator_pump_error`) instead of spamming stderr every 5s; the next interactive orchestrator `session_start` restarts a fresh pump. TUI session-safe surfacing is unchanged (probed in a dedicated tmux lane).
- **Closure on create:** `swarm_create_task` now applies `computeTaskStatus` so a fresh task's status is engine-derived (`ready`).
- **Task-graph UAT (WS-A):** new committed entrypoint `scripts/swarm_task_uat.sh`. It drives the task tools end-to-end against throwaway ids in an **isolated working tree** (never touches live swarm state), running as the orchestrator, and asserts on `task.json`/state/traces (model-independent). Covers create→ready, assign→orchestrator, update→done closure, failed closure, cancel, task-level `blocked` derivation (+resumable), roleKind id-first inference, fabricated-stale reconcile, fabricated-drift `mark=true` repair, and PM auto-notify (node-close → orchestrator mailbox; worker settle-with-open-work → orchestrator mailbox).
- **Docs (WS-D):** `docs/swarm-task-graph.md` documents `computeTaskStatus` rules, the stale/nudge ladder, and marks `swarm_stop_agent`/`swarm_gc_agents`/`swarm_release_agent_task` as deferred; `docs/swarm.md` adds a "Task graph and closure" section + task-graph UAT validation; README adds "Supported now vs deferred".
- Typecheck clean. Existing closure (`computeTaskStatus`/`applyTaskStatus`), validate warning reactivation, and `session_shutdown` nudge are unchanged.

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
