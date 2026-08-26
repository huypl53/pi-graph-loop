# Swarm operations guide

This page is for operating, debugging, and reviewing a swarm instance.

## Quick start

Start pi with the packaged extension:

```bash
pi --model glm-5.1 --provider zai-coding-cn -e extensions/swarm/index.ts
```

Inside pi:

```text
/swarm init
/swarm status
/swarm panes
```

Common first actions:
- spawn an agent: `/swarm spawn reviewer Review the current diff`
- register the current pane: `/swarm register here reviewer Review the diff`
- inspect status: `/swarm status`
- inspect traces: `/swarm trace`

## Runtime files you will inspect most often

```text
.pi/swarm/swarm-state.json
.pi/swarm/mailboxes/<agent-id>.jsonl
.pi/swarm/agents/<agent-id>.md
.pi/swarm/tasks/<task-id>/task.json
.pi/swarm/tasks/<task-id>/artifacts/
.pi/swarm/traces/events.jsonl
.pi/swarm/traces/tmux/*.txt
```

## Common operating tasks

### See what exists
- `/swarm status`
- `/swarm panes`
- `swarm_list_agents`
- `swarm_agent_status`
- `swarm_task_status`

### Recover or debug delivery
- `swarm_message_status`
- `swarm_check_mailbox`
- `swarm_reconcile` (`dryRun` first)
- `swarm_dead_letters`
- `swarm_capture_agent_pane`

### Recover or debug task execution
- `swarm_task_status(..., runtime=true)`
- `swarm_validate_graph`
- `swarm_print_graph`
- `swarm_reconcile` (also reports advisory `task_node_ownership_legacy` drift for active nodes on pre-policy tasks; never fabricates ownership)
- `swarm_release_agent_task` for stale pointers after confirming reconcile results

### Cancel a task (orchestrator-only)

Cancel a stuck or obsolete task with the existing `swarm_update_task(force=true, cancelTask=true)`:

```text
swarm_update_task(taskId=<id>, nodeId=<any-node>, force=true, cancelTask=true)
```

This is the ONLY cancellation surface — no separate `swarm_cancel_task` tool was added. On cancel:

- `task.status` becomes `cancelled` (sticky terminal; never auto-reopens).
- Every non-terminal node is marked `cancelled`; already-terminal nodes (done/failed/skipped) are
  left untouched so real work is never un-done.
- Every active attempt lease is revoked (`attempt.status = "cancelled"`).
- Every per-node assignment message is marked superseded (waived) so late ACKs/results are
  non-actionable.
- Agent `activeTaskIds` and advisory edit locks for affected nodes are released.
- Informational cancellation notices are sent to the pre-cancel assignees.

After cancellation:

- Any `swarm_update_task` call on that task is rejected with `TASK_CANCELLED` (or `NODE_CANCELLED`),
  even from the orchestrator. Re-opening requires a separately-designed policy.
- A later ACK on a superseded assignment is rejected with `ASSIGNMENT_SUPERSEDED` (the orchestrator
  may pass `waive=true` to accept it as waived).
- The audit trail is preserved: task.json, per-task events, message records (marked superseded, not
  deleted), and attempt history all remain readable.

Un-cancelling is not supported in this release. To work on the same goal again, create a new task.

### Inspect or change agent roles

### Model pool (multi-provider rotation)

`.pi/settings.json` (under `swarm` or `extensions.swarm`) supports a weighted
model pool. When configured, agent spawn picks a healthy slot via rotation;
restart fails over off a benched slot automatically.

#### Canonical format (copy-paste-ready)

```json
{
  "swarm": {
    "modelPool": [
      { "model": "gpt-5.4-mini", "provider": "openai", "weight": 50 },
      { "model": "claude-sonnet-4", "provider": "anthropic", "weight": 30 },
      { "model": "glm-5.1", "provider": "zai-coding-cn", "weight": 0 }
    ],
    "rotation": { "strategy": "weighted", "cooldownMs": 900000, "maxRetries": 2 }
  }
}
```

Slot fields:
- `model`: required, non-empty string
- `provider`: optional; defaults to the provider registry
- `weight`: non-negative number; default 1; `0` = fallback-only (used when every weighted slot is benched)

Rotation fields:
- `strategy`: `weighted` (default) | `round-robin` | `sticky` (per-agent-id deterministic)
- `cooldownMs`: bench duration after `maxRetries` failures (default: `900000` = 15min)
- `maxRetries`: consecutive failures before bench (default: `2`)

#### Legacy singleton (still supported — observable as an implicit singleton pool)

```json
{
  "swarm": {
    "defaultModel": "glm-5.1",
    "defaultProvider": "zai-coding-cn"
  }
}
```

A settings file with only `defaultModel`/`defaultProvider` is treated as a 1-slot
implicit singleton pool (no rotation, no cooldown). The same `poolStatus`,
`pickSlot`, and preflight code paths apply; the user is never asked to migrate
manually. Top-level `swarm` is preferred; `extensions.swarm` is accepted for
backward compatibility.

#### Discover your config (read-only)

```text
/swarm pool show           # current config (explicit pool OR implicit singleton) + rotation + health
/swarm pool validate       # structural check — empty/dup/bad weights/bad strategy/cooldown/maxRetries
/swarm pool help           # canonical format reference (this doc, surfaced as a notify)
/swarm pool preview-preflight  # dry-run the spawn gate; reports classified errors before commit
```

None of these commands edit `.pi/settings.json`. The user's settings file is the
single source of truth and is never rewritten by the swarm extension.

#### Preflight before spawn / restart

Before committing a worker assignment, `spawnAgent` and `restartAgent` run
`preflightSpawn(p, opts)` which validates:

1. **Settings shape** — if a pool is configured but has bad data (empty model,
   duplicate slot, bad weight, unknown strategy), spawn is refused with
   `invalid_settings` and the first error listed. Fix: run `/swarm pool validate`.
2. **Pool eligibility** — if a pool is configured, at least one slot must be
   eligible (not benched). When all slots are benched, spawn is refused with
   `pool_exhausted`. Fix: `/swarm pool clear <slot>` or wait for cooldown.
3. **Model/provider resolution** — the resolved model/provider must be
   non-empty strings. Empty model → `unknown_model`; empty provider →
   `provider_not_found`. Fix: set `swarm.defaultModel`/`defaultProvider` or
   `PI_SWARM_DEFAULT_MODEL`/`PI_SWARM_DEFAULT_PROVIDER`.
4. **tmux prerequisites** — when the caller passes a `tmuxSession`, the swarm
   verifies `$TMUX` (or `PI_SWARM_TMUX_OK`) is set. Missing → `tmux_not_running`.
   Fix: start tmux: `tmux new-session -d -s <session>`.

Each error carries a `kind` and a concrete `suggestion` line; the formatter
prints the action directly so the operator never has to guess the fix.

#### Rotation + health (unchanged)

- **Auto-swap on provider errors (in-process)**: pi never exits on 429/401/5xx — the turn fails with `stopReason "error"`. The swarm `turn_end` hook classifies the error, benches the exact failing slot, and `setModel()`s the session to another healthy slot in-process. Context, mailbox and identity are preserved; the agent retries its work on the new model.
- **Healthy turns reset the streak**: a turn that ends `stopReason "stop"` clears that slot's failure streak and bench backoff — one transient blip never benches a slot that is otherwise serving fine.
- **Incident dedupe**: pi may emit several error turns for one underlying failure (internal stream retries, overflow-recovery re-runs). An identical error on the same slot within 30s counts once toward `maxRetries`.
- **Exponential bench backoff**: consecutive benches without an intervening success double the cooldown (capped at 24h). A long outage (e.g. monthly quota) costs one probe per doubling instead of one retry per `cooldownMs`.
- **Swap-chain cap**: at most 2 consecutive swaps per agent (chain resets after 5 idle minutes). A fully-dead pool cannot cascade fail→swap→retry through every slot; beyond the cap the turn fails naturally and the trace `pool.swap_chain_capped` makes it visible.
- Health state persists in `.pi/swarm/pool-state.json` (includes the classified error); all read-modify-write cycles run under a dedicated lock so concurrent agent processes cannot lose updates. Provider errors classify as `quota` | `rate_limit` | `auth` | `transient`; anything else (e.g. context overflow) is traced (`pool.turn_error_unclassified`) but never benches or swaps a slot. A slot must resolve under its own provider in the model registry — slots with no explicit provider are rejected with `pool.swap_model_not_found`.
- Traces: `pool.slot_failure`, `pool.swap`, `pool.swap_failed`, `pool.swap_no_candidate`, `pool.swap_chain_capped`, `pool.swap_model_not_found`, `pool.slot_success`, `pool.turn_error_unclassified` (`.pi/swarm/traces/`).
- Commands: `/swarm pool list`, `/swarm pool cooldown <provider/model> <ms>`, `/swarm pool clear <provider/model>`, `/swarm pool show`, `/swarm pool validate`, `/swarm pool help`, `/swarm pool preview-preflight`.
- Without `modelPool`, the single `defaultModel`/`defaultProvider` behavior is unchanged.

- `swarm_agent_identity`
- `swarm_reload_identity`
- `swarm_set_role`
- `swarm_set_agent_paused`
- `swarm_restart_agent`

## Orchestrator leadership and recovery

The swarm is intentionally strict-reject: one live orchestrator leadership record is the source of truth
for authority-sensitive mutations. The durable record lives in `swarm-state.json.orchestratorLeader`.

### Leadership rules
- The current orchestrator pid must be the active holder of the leader record before any gated
  orchestrator mutation runs.
- A second live pid is rejected with `ORCHESTRATOR_LEADER_DENIED`.
- Legacy/absent leader state is treated as vacant.
- `ORCHESTRATOR_LEADER_STALE_MS` is the leadership blind-spot bound; today it matches `LOCK_STALE_MS`
  (60s). That means a pane crash or hard stop can leave a short window before a fresh claim replaces
  the stale leader.

### Recovery behavior
- `heartbeatOrchestratorLeader` refreshes the durable leader record during gated tool/command paths.
- Create-only orchestrator materialization is allowed for startup normalization, but it does not upgrade
  a worker pane into authority.
- Command and tool gates still reject unsafe non-orchestrator mutations even if a stale leader has not
  yet been replaced.
- When debugging leadership drift, inspect `swarm-state.json`, the orchestrator mailbox, and the tmux
  capture for the fresh session before assuming the recorded leader is current.

### What to do on recovery
1. Start or reattach the intended PM session.
2. Confirm the session is the one that should claim leadership.
3. Use the orchestrator-gated command or tool path so the leader record is refreshed.
4. If another pane still believes it is leader, capture its pane and stop/release it only after
   confirming it is not the active PM.

The leadership blind spot is a documented trade-off, not a semantic failure: the harness treats the
stale record as recoverable state, not evidence that a worker may take over.

## Recommended debugging flow

### Message did not arrive
1. inspect `swarm_message_status`
2. inspect recipient mailbox JSONL
3. capture recipient pane
4. run `swarm_reconcile` with `dryRun=true`
5. if needed, rerun reconcile with mutation enabled per the tool options

### Agent looks dead or stale
1. inspect `swarm_agent_status`
2. check tmux pane/window existence
3. inspect the latest pane capture or take a fresh one
4. restart or stop/re-register only after checking active tasks

### Task is stuck
1. inspect `swarm_task_status(..., runtime=true)`
2. inspect node assignment and mailbox status
3. run `swarm_validate_graph`
4. run `swarm_reconcile`
5. only force-update state when you understand why the task drifted

## Recovery nudges (Phase 1)

Recovery nudges are orchestrator-bound messages that surface a concrete decision. They never
auto-assign, auto-spawn, or mark semantic work complete; a worker's idle/pane state is never treated as
proof that work finished.

### Initial-ready nudge
- A freshly created task whose **start node stays ready and unassigned** past `TASK_INITIAL_READY_GRACE_MS`
  (1 minute) is surfaced to the orchestrator with an action-required message.
- The nudge is **idempotent** (one per task key), bounded by `NOTIFY_DEFAULT_MAX_NUDGES` and a
  `NOTIFY_DEFAULT_COOLDOWN_MS` (5 minutes), and auto-clears once the node is assigned or the task leaves
  the ready state.
- It only directs the orchestrator to `swarm_assign_task` (or cancel); it does not assign anything itself.

### Unified notification policy
All recovery nudges share one semantic key space (`task:{taskId}:node:{nodeId}:nudge:...`,
`task:{taskId}:nudge:initial-ready`), formatted by `formatNotifyKey`, and the same dedupe/cooldown/cap
contract. Every message tells the recipient the concrete next action (the exact tool call) plus an
alternative path (cancel/inspect).

### Recovery attention and bounded worker reminder (roadmap issue 5)

The orchestrator can derive a durable, decision-oriented **attention report** from persisted state
only (task graph + assignment attempts + mailbox records). Pane/process/tmux idle state is NEVER
semantic evidence of completion or failure.

- **`/swarm attention [<#|task-id>]`** (orchestrator-only, read-only): per-node classification —
  `unassigned_ready`, `ack_missing`, `response_missing`, `delivery_failed`, `dead_letter`,
  `transport_unavailable`, `no_progress`, `reminder_eligible`, `reminder_sent`, `superseded`,
  `cancelled`, `terminal` — each with evidence lines and a summary of orchestrator decisions.
  Advisory only: it never reassigns, cancels, completes, or alters graph readiness.
- **`swarm_task_status(runtime=true)`** appends the same `attention:` warning lines for
  reminder-eligible nodes (no new tool parameter).
- **`swarm_reconcile`** reports an informational `reminder_eligible` action naming the exact
  `/swarm remind` invocation. **Reconcile never sends anything.**
- **`/swarm remind <task-id> <node-id>`** (orchestrator-only): the ONLY sending surface. Sends at
  most **one reminder per attempt, permanently** (idempotency key
  `task:{taskId}:node:{nodeId}:attempt:{attemptId}:reminder`), and only when ALL hold:
  1. canonical, non-superseded assignment message exists;
  2. receipt/processing is confirmed by a durable ack (`lastAck.status` exactly `seen` or `processing` —
     `injected`/`intercepted`/`mailbox_delivered` alone is never receipt; `done` is a closure problem);
  3. the no-progress anchor — the most recent of `lastAck.at`, `node.lastActivityAt`,
     `attempt.lastActivityAt`, `attempt.assignedAt` — is older than `REMINDER_NO_PROGRESS_MS` (60 min);
  4. the attempt is the current active attempt (reassign/rework/cancel fences obsolete reminders);
  5. the node is `assigned`/`in_progress` on a non-cancelled task;

### Interpreting `notification.stale.suppressed` traces (roadmap issue 9)

Every emit-time lifecycle-notification site runs a durable-state predicate before delivery; if the
predicate says the assignment is no longer actionable, the notify is **not delivered** and a
`notification.stale.suppressed` event is appended to `.pi/swarm/traces/events.jsonl` with `site`,
`taskId`, `nodeId`, `reason`, and `evidence` fields. This is the authoritative record that an old
notification was caught before it could mislead the recipient.

- **When you see one**: the system intentionally chose **audit over delivery**. The predicate
  matched one of the staleness conditions below; the notify was suppressed to prevent the
  recipient from acting on stale evidence. The original observation is NOT lost — look up the
  same `taskId`+`nodeId` in the events trace preceding this event for the original observation.
- **`reason` values** (canonical set):
  - `task_closed` — the task's own `status` is terminal (`done`/`cancelled`/`failed`); notifies
    that would have pointed back at this task are obsolete.
  - `node_terminal` — the node's `status` is in `TERMINAL_NODE_STATUSES`; the assignment
    authority is gone.
  - `superseded_message` — the canonical assignment message has a non-empty `supersededBy`
    field; a newer attempt owns the assignment.
  - `superseded_attempt` — `activeAttemptId` is set and no canonical message exists with that
    attempt id (legacy short-circuit when attempt metadata is absent returns `stale:false`).
  - `assignee_drift` — the canonical message's `to` does not match the current node assignee
    (reassign/rework completed but the message still names the old agent).
  - `agent_stopped` — the assignee's agent record is `status: stopped` and either
    `runtimeStatus` is `idle`/`unavailable`/empty, or the canonical message is older than
    `SETTLE_NOTIFY_COOLDOWN_MS` (2 min) grace.
  - `node_missing` (closure predicate) — the node id no longer exists in `task.nodes`.
  - `reopened_reassigned` (closure predicate) — the node is `ready` and its current
    assignee differs from the triggering closure assignee.
- **Aggregate traces**: `agent_settled` emits `all_recs_superseded_or_drifted` (site 1) or
  `all_open_stale_or_deduped` (site 2) when EVERY entry in the notifiable set was suppressed or
  deduped. This is the same predicate fan-out per entry; the aggregate event summarises the
  empty-notify outcome.
- **What it is NOT**: it is not a failure, not an error, and not a request for action. The
  orchestrator does not need to re-issue, retry, or inspect anything unless the volume of
  suppressions for a given `taskId`+`nodeId` looks wrong for the timeline (e.g. a single node
  whose notify keeps being suppressed while no fresh assignment is being issued).


