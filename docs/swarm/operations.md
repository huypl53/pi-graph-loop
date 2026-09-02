# Swarm operations guide

This page is for operating, debugging, and reviewing a swarm instance.

## Quick start

Start pi with the packaged extension — bare `pi` picks up the defaults from
`~/.pi/agent/settings.json` (defaultModel/defaultProvider) and credentials
from `~/.pi/agent/auth.json`:

```bash
pi -e extensions/swarm/index.ts
```

Only pass `--model`/`--provider` when you have verified the pair works on
this machine (the provider must have a stored API key — check `pi auth` or
`~/.pi/agent/auth.json`; a configured-looking combo without a key exits with
`No API key found for <provider>` and the pane looks dead). If you do use
explicit flags, they are the same for both roles, e.g.

```bash
pi --model glm-5.1 --provider zai-coding-cn -e extensions/swarm/index.ts   # if zai-coding-cn is authenticated
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

### Model pool auto-scaffold on first orchestrator session (Issue 20)

On the orchestrator's first `session_start` in a swarm, the extension checks
`.pi/settings.json`. If neither `swarm.modelPool` nor `extensions.swarm.modelPool`
(runtime precedence: extensions wins per `src/session.ts:readSwarmSettings`) is
declared, the extension writes a placeholder slot `[{ "model": null, "provider": null }]`
into the resolved block while preserving every other top-level key. The write is
atomic (`state.ts:atomicWriteFile`) so a torn write is impossible.

Three skip paths surface as their own return values but emit **no notify** and
leave `.pi/settings.json` untouched:

- `modelpool_present` — either block already declares `modelPool` (even `[]`).
- `no_pi_dir` — `.pi/` directory is absent. We deliberately do NOT `mkdir -p`
  to create a pi directory inside a non-pi project. The `.pi/swarm/...` trace
  pipeline is also skipped (it would mkdir the chain we just refused to create).
- `settings_unparseable` — `.pi/settings.json` exists but is not valid JSON.
  Traced as `pool.scaffold_skipped_unparseable`; the file is left as-is for the
  user to repair manually.

The one-shot `ctx.ui.notify` fires **only** when (a) `modelpool_present` /
`no_pi_dir` / `settings_unparseable` did NOT skip AND (b) the durable flag
`SwarmState.poolScaffoldNotifiedAt` is absent. The flag is stamped inside the
same `withLock` block that creates the leader-orchestrator session record, so
subsequent `session_start` invocations (including `/reload` of the same swarm)
are suppressed until the entire `.pi/swarm` directory is cleared (clean-slate
re-notify is the intended escape hatch). The notify text is stable; see the
`POOL_SCAFFOLD_NOTIFY_TEXT` constant in `extensions/swarm/src/constants.ts`.

Trace events (durable in `.pi/swarm/traces/events.jsonl`):

- `pool.scaffold_created` — `{ path, previousKeys, source, modelPool }`. Fires
  on every successful write; idempotent across calls because the payload is the
  same and the durable flag suppresses the notify.
- `pool.scaffold_skipped_unparseable` — `{ path, error }`.
- `pool.scaffold_error` — `{ error }`. Fires only when the scaffold threw an
  unexpected error (e.g. an EACCES from a read-only mount). The session_start
  handler swallows this and continues; the user can diagnose via `swarm_trace`.

Placeholder `model: null` is intentionally invalid against
`validateSwarmSettings()` (which reports `slot_empty_model`); this nudges the
user to replace it with a real slot before running `/swarm pool validate`.
Concurrent orchestrator session_starts (two PM panes racing) both call
`ensurePoolScaffold`; both observe `modelPool` absent; the first
`atomicWriteFile` wins and the second sees the post-write state on its next read
or simply overwrites with the same idempotent payload — neither the user nor
the swarm state machine observes a torn write.

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
- `roles`: optional array of role-kind names; when set & non-empty, this slot is only eligible for
  `pickSlot()` when the spawning agent's roleKind is in the list. Absent / empty = available for
  all roleKinds (default). The closed set of roleKinds is defined in
  `extensions/swarm/src/completion.ts` `ROLE_KINDS` (seven entries: orchestrator, planner,
  reviewer, tester, implementer, worker, observer). Manual `/swarm pool rotate now` ALWAYS
  bypasses the role filter (operator override) and stamps `rolesIgnored: true` in the swap trace.
  **Strict roles (2026-08-31)**: when at least one slot is tagged for a roleKind, that roleKind is
  served by ONLY its tagged slots — untagged slots are no longer a fallback for it. Untagged
  slots serve only roleKinds that have no tags anywhere in the pool. A roleKind whose tagged
  slots are all benched has no candidate (the agent keeps its current model; spawn falls back
  via the traced `pool.role_filter_all_filtered_fallback` path).
  If every slot is filtered out for a roleKind at spawn time, a warning trace
  (`pool.role_filter_all_filtered_fallback`) is emitted and the worker still starts on the next
  available unfiltered slot. Malformed `roles` values are reported as `slot_bad_roles` by
  `/swarm pool validate` (warning-grade) and treated as "no filter".

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
manually. Read precedence (src/session.ts:34-37): `extensions.swarm` is read first; top-level `swarm` is used only when `extensions.swarm` is absent or not an object.

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
- **Pi engine retry coordination** (Issue 17 gate + Issue 19 manual override): the pi engine itself retries a failed provider request up to `retry.maxRetries` (default `3`) times with exponential backoff (2s, 4s, 8s = 14s total budget) before giving up. The extension cannot subscribe to engine retry events (the `auto_retry_*` family is not in the extension event allowlist), so the gate observes retries **indirectly**: every retry re-enters via `agent.continue()` and emits a fresh `turn_end { stopReason: "error" }` with the SAME `providerKey + errorMessage`. The gate counts consecutive same-error turn_ends per agent; only after `ENGINE_MAX_RETRIES` (`3`) strikes within `ENGINE_RETRY_WINDOW_MS` (`14000`) does it conclude the engine has exhausted retries and let the auto-swap path fire. Below the threshold, the swap path is suppressed: `pool.swap_gated_by_engine_retry` is traced, but there is NO `setModel`, NO bench, NO failure-streak bump. A successful turn (`stopReason: "stop"`) clears any open incident (`pool.engine_retry_recovered`), as does `session_start`, `session_shutdown`, and `agent_settled`. The constants live in `extensions/swarm/src/constants.ts` and are mirrored by pi's own defaults — the swarm does NOT read `retry.maxRetries` from settings; engine policy belongs to the engine.
- **Streak-counting behavior change** (binding C4 of Issue 17, operator-visible in Issue 19): a persistent transient now needs **2 retry-exhaustion cycles** (not 2 consecutive errors) to bench the slot. The engine-retry gate collapses the burst — `ENGINE_MAX_RETRIES` strikes inside one `ENGINE_RETRY_WINDOW_MS` window count as exactly **one** `recordProviderError` call, not three. The bench-streak therefore tracks exhaustion cycles 1:1, not raw error events. Operators who relied on "after the second provider error the slot is benched" should now plan for 2 full 14s retry-exhaustion windows on the slot before it benches. The trace lane (`pool.swap_gated_by_engine_retry` per gated strike, then `pool.engine_retry_exhausted` on the terminal strike, then `pool.slot_failure` / `pool.swap` / `pool.swap_failed`) tells you exactly which cycle you are on.
- **Manual override paths** (Issue 19, orchestrator-only, slash commands only — no new public tools):
  - **`/swarm pool rotate now`** — bypasses the gate, force-swaps the current slot to a healthy alternative via `pi.setModel()`. Traces `pool.swap_forced_by_manual_override` with the same `{ agentId, from, to, reason, target }` shape the auto-swap uses for `pool.swap`. Bumps the swap-chain counter (a swap happened; the operator is accountable for the same `MAX_SWAP_CHAIN=2` cap).
  - **`/swarm pool rotate next`** — benches the current slot for `rotation.cooldownMs` so the next normal `pickSlot()` skips it. Does NOT call `setModel()` — the agent keeps its current model for this turn, and the next `turn_end` (or the next exhaustion) advances organically. Traces `pool.bench_forced_by_manual_override` with `{ agentId, slot, cooldownMs }`. Does NOT bump the swap-chain counter (no swap happened) and does NOT call `recordProviderError` (the bench is a deliberate operator decision, not a provider error).
  - Both commands are orchestrator-gated (`currentAgentId() === "orchestrator"`, same wording as `/swarm goal|attention|remind|stop|release`: `<cmd> is orchestrator-only: run it in the PM session (PI_SWARM_IS_ORCHESTRATOR=1 or /swarm register here orchestrator)`). Guest sessions are naturally refused by the same check.
  - Manual override traces are distinguishable in dashboards (`pool.swap_forced_by_manual_override` vs `pool.swap`, `pool.bench_forced_by_manual_override` vs `pool.slot_failure`) so an operator can audit when the gate was bypassed vs when it fired naturally.
- **Where to look in the trace log**:
  - `pool.swap_gated_by_engine_retry` — gate held (below threshold; no swap, no bench, no streak bump).
  - `pool.engine_retry_exhausted` — gate opened on the terminal strike; the swap path is now free to fire.
  - `pool.engine_retry_recovered` — engine recovered on a later retry attempt (incident cleared on a `stop` turn).
  - `pool.swap_forced_by_manual_override` — operator forced an immediate swap (gate bypassed).
  - `pool.bench_forced_by_manual_override` — operator benched the current slot (gate bypassed, no swap).
  - `pool.manual_rotate_no_alternative` — manual `rotate now` refused because every alternative is benched.
  - `pool.manual_rotate_model_not_found` — manual `rotate now` refused because the picked slot has no resolvable model registry entry (config error).
  - `pool.manual_rotate_no_current_slot` — manual `rotate` refused because the pane's `ctx.model` is empty (not running on a model pool slot).
- **Cross-reference**: Issue 17 commit `1016d7c` introduced the gate. Issue 19 adds the constants extraction (`extensions/swarm/src/constants.ts`), this documentation, the operator-facing traces, and the manual override commands.
- Health state persists in `.pi/swarm/pool-state.json` (includes the classified error); all read-modify-write cycles run under a dedicated lock so concurrent agent processes cannot lose updates. Provider errors classify as `quota` | `rate_limit` | `auth` | `transient`; anything else (e.g. context overflow) is traced (`pool.turn_error_unclassified`) but never benches or swaps a slot. A slot must resolve under its own provider in the model registry — slots with no explicit provider are rejected with `pool.swap_model_not_found`.
- Traces: `pool.slot_failure`, `pool.swap`, `pool.swap_failed`, `pool.swap_no_candidate`, `pool.swap_chain_capped`, `pool.swap_model_not_found`, `pool.swap_gated_by_engine_retry`, `pool.engine_retry_exhausted`, `pool.engine_retry_recovered`, `pool.swap_forced_by_manual_override`, `pool.bench_forced_by_manual_override`, `pool.manual_rotate_no_alternative`, `pool.manual_rotate_model_not_found`, `pool.manual_rotate_no_current_slot`, `pool.slot_success`, `pool.turn_error_unclassified` (`.pi/swarm/traces/`).
- `message.late_result_rejected` — emitted when a worker tries to apply a stale result against a superseded assignment attempt. The trace appears from both the tool-layer `swarm_update_task` fence and the rec-level superseded-message guard, so operators can count late arrivals in the same trace census regardless of where the refusal was detected.
- Commands: `/swarm pool list`, `/swarm pool cooldown <provider/model> <ms>`, `/swarm pool clear <provider/model>`, `/swarm pool rotate now` (orchestrator-only; force-swap current slot, bypass gate), `/swarm pool rotate next` (orchestrator-only; bench current slot for `rotation.cooldownMs`, advance organically), `/swarm pool show`, `/swarm pool validate`, `/swarm pool help`, `/swarm pool preview-preflight`.
- Without `modelPool`, the single `defaultModel`/`defaultProvider` behavior is unchanged.

### Inspect or change agent roles

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

## Trace audit + retention

`swarm audit` is the supported reader for `.pi/swarm/traces/events.jsonl` and the gzip generations produced by trace rotation.

Common use cases:

- `swarm audit --event message. --limit 20` — filter the hot trace stream by event prefix.
- `swarm audit --timeline --message <id> --json` — reconstruct the enqueue → deliver → inject → ack → response path for one message.
- `swarm audit --probes --json` — inspect P1–P4 anomaly probes.
- `swarm audit --invariants --json` — check INV1–INV3 over current swarm state.
- `swarm audit --rotate` — manually rotate traces when the file exceeds the configured cap.

Rotation is retention-aware: the hot `events.jsonl` is size-gated, compressed generations are kept in `events.<n>.gz`, and `events.rollup.json` retains the cumulative generation index. tmux pane captures in `.pi/swarm/traces/tmux/` use the same age window and are pruned by the same rotate pass.

The JSON result shape is stable for ritual artifacts: it includes `schema: "swarm-audit/v1"`, `durationMs`, `counts`, and a `source` block. Timeline mode returns `timeline.stages[]`, probes mode returns `probes`, and invariants mode returns `invariants`.

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

## Orphan-spawn watchdog (Issue 14)

<!-- (sections below kept in original order) -->

The engine emits a structured trace event when `swarm_spawn_agent` mints a NEW agent record but no
follow-up delivery (`swarm_send_message`, `swarm_assign_task` which sends internally, or
`swarm_stop_agent`) occurs within `ORPHAN_SPAWN_WARNING_TIMEOUT_MS` (default **30 000 ms**). The
warning is purely diagnostic — it is **not** a new public tool, **not** a hard error, and **not** a
model-side gate. Ops and dashboards surface it via `swarm_trace` or the `events.jsonl` log.

### Pre-flight auto-clear (Issue 16)

When the same orchestrator session that called `swarm_spawn_agent` follows up with
`swarm_assign_task` resolving to the freshly-spawned agentId within
`PREFLIGHT_ASSIGN_GRACE_MS` (default `max(5_000, ORPHAN_SPAWN_WARNING_TIMEOUT_MS - 1_000)` =
**29 000 ms** at production defaults), the orphan watch is **pre-cleared** before the timer fires:

- The in-process timer is cancelled and the `recentSpawns[]` entry is removed.
- `agent.spawn.orphan_cleared` is emitted with `by: "swarm_assign_task"` and `reason: "preflight"`
  (distinct from the late-delivery backstop which carries `reason: "delivery"`).
- The `spawnedByPid` and `spawnedBySessionStartedAt` stamps carried on the entry are surfaced in
  the trace payload for ops correlation.

Same-orchestrator detection uses `process.pid` + `process.env.PI_SWARM_SESSION_STARTED_AT` stamped
**unconditionally** onto the entry at `armOrphanWatch` time (so it works on the operator's first
tool call after PM opt-in, when the leader record may still be vacant). A foreign orchestrator
session invoking `swarm_assign_task` against the fresh record does **not** preempt — the warning
fires normally, because the spawn was not followed by the spawning orchestrator's intended use.

The existing delivery-side `clearReason="swarm_assign_task"` path inside `deliverMessageLocked`
remains intact as a late-clear backstop; if pre-clear already removed the entry, the delivery-side
clear is a no-op. True orphans (no follow-up) still trip the warning after the full timeout.

Override the grace window for tests via `PI_SWARM_PREFLIGHT_GRACE_MS` (must be set BEFORE module
import):

```bash
PI_SWARM_ORPHAN_TIMEOUT_MS=50 PI_SWARM_PREFLIGHT_GRACE_MS=10 node extensions/swarm/spawn-orphan-warning.test.mjs
```

### Trace events

| Event | When | Payload | Purpose |
|---|---|---|---|
| `agent.spawn.orphan_watch_start` | End of a successful fresh spawn | `{ agentId, deadlineAt, timeoutMs }` | Watchdog arm signal; lets ops confirm the timer is running |
| `agent.spawn.orphan_cleared` | Follow-up delivery (or pre-flight assign) before the deadline | `{ agentId, by, reason, clearedBy, spawnedAt, deadlineAt, spawnedByPid, spawnedBySessionStartedAt }` where `by` is `swarm_send_message` / `swarm_assign_task` / `swarm_stop_agent` and `reason` is `preflight` (Issue 16) or `delivery` (Issue 14 backstop) | Disambiguates averted orphans from real ones in dashboards; preflight vs delivery split tells ops how many were prevented by the auto-clear path |
| `agent.spawn.orphan_warning` | Timer expired with no follow-up delivery | `{ agentId, spawnedAt, deadlineAt, ageMs, source }` | **The warning itself.** Observe via `swarm_trace` |
| `agent.spawn.orphan_resolved_late` | Timer fired but an inbound message already exists | `{ agentId, resolver: "pre-existing-message", messageIds }` | Race-condition backstop; not a warning |

### Where the watchdog does NOT arm

The watchdog arms only on the **fresh-record** branch of `spawnAgent`. The reuse path is excluded:

- `swarm_restart_agent` calls `spawnAgent` with `isNewRecord: false` (refresh, not new).
- `swarm_register_agent` adopts an existing pane and never calls `spawnAgent`.
- `swarm_assign_task` reuse lookup (`findReusableAgent`) does not call `spawnAgent` either.
- Direct `swarm_spawn_agent` for an id whose record already exists (e.g. previously stopped) is treated
  as refresh and skips the watchdog.

A `swarm_spawn_agent` followed quickly by `swarm_send_message` (or `swarm_assign_task` with the new
agent, or `swarm_stop_agent`) is **not** an orphan — the clear path runs inside the same lock as the
delivery or stop and traces `agent.spawn.orphan_cleared` with the reason.

### Configurable timeout

Override the default 30 s window via the `PI_SWARM_ORPHAN_TIMEOUT_MS` env var. Tests use
`PI_SWARM_ORPHAN_TIMEOUT_MS=50` to exercise the timer path in real time:

```bash
PI_SWARM_ORPHAN_TIMEOUT_MS=50 node extensions/swarm/spawn-orphan-warning.test.mjs
```

### v1 limitation

The orphan entry persists in `swarm-state.json` (`recentSpawns[]`), but the timer handle lives in
process-local memory (a module-level `Map`). A process restart **strands** any in-flight entries
they never fire — they remain observable in the state file for forensics but produce no new warning.
Rearming on restart is deferred to a follow-up; see `extensions/swarm/spawn-orphan-warning.test.mjs`

## Operator: task-close worker sweep (Issue 26)

When a task reaches a terminal status via `applyTaskStatus`, the swarm auto-stops every worker
agent whose ONLY active assignment was on that task. This keeps `/swarm status` clean — closed
tasks don't leave behind a long tail of stopped ghost workers.

**Eligibility rules** (all must hold):

1. The agent is NOT the orchestrator pseudo-agent.
2. The agent is NOT paused (`agent.paused === true`).
3. The agent was associated with the closing task AND has no remaining active tasks on other tasks.
4. The agent is NOT protected by `PI_SWARM_KEEP_TASK_WORKERS=1`.

**`spawnedForTaskId` link**: when `swarm_assign_task` spawns a fresh agent for a node (via
`autoSpawn` / `spawnIsolated`), it stamps `agent.spawnedForTaskId = task.taskId`. Reuse-pool
agents that were not spawned for the task are swept ONLY when their only active task was the
closing task (the `task-graph`-derived `node.assignee` membership is the canonical signal).

**Trace events** (every close):

- `agent.task_sweep_stopped` — one per stopped agent (includes taskId, priorActiveTaskIds, releaseReason).
- `task.workers_swept` — one summary per close (includes taskId, stoppedCount).

**Opt-out**: set `PI_SWARM_KEEP_TASK_WORKERS=1` to disable the entire sweep (no per-agent or
summary traces emitted). Default ON. Not gated behind `PI_SWARM_MINIMAL_PROTOCOL`.

**Idempotence**: the sweep is computed from current state on every invocation, so a second call
finds nothing to stop and emits zero traces. Already-stopped agents are skipped with reason
`already_stopped`. Safe under the same `withLock(p)` the caller already holds — no nested locks.

## Operator: heartbeat-driven agent GC (Issue 82, P0)

The heartbeat GC is a periodic pump-tick phase in `pumpOrchestratorMailbox` that reclaims
dead-pane agents and downgrades stale-heartbeat agents. Wired inside the existing
`withLock(p)` so no nested lock acquisition is possible.

**Default stale window**: `DEFAULT_AGENT_HEARTBEAT_STALE_MS = 600_000` (10 min). Override with
`PI_SWARM_AGENT_HEARTBEAT_STALE_MS` env var. tmux probes fire after **2× the stale window**
(`probeAfterMs`) by design — probes are expensive and rate-limited by a per-agent ledger.

**Three cheap gates** (run sequentially per agent after exemption checks):

1. **Gate 1 — known-dead pane**: `tmuxAlive === false && status === "running"` → flip to
   `stopped` + emit `agent.heartbeat_gc.stopped {reason:"tmux_dead"}`.
2. **Gate 2 — heartbeat too old + probe ledger permits**: only fires when
   `hbAge > probeAfterMs && status === "running" && tmuxAlive !== false &&
   (nowMs - lastProbeAtMs) > probeAfterMs`. The `lastProbeAt` ledger field on `SwarmAgent`
   is the **cost-bound** that prevents the per-tick livelock the original implementation was
   vulnerable to: without it, every agent with a stale heartbeat + tmuxTarget would be probed
   on every pump tick forever, holding the swarm lock for seconds. With the ledger, each
   agent is probed at most once per `probeAfterMs` window (~20 min default). When gate 2
   conditions are met but the ledger blocks the probe, the trace `agent.heartbeat_gc.probe_throttled`
   is emitted (with `lastProbeAtMs` + `probeAfterMs`) so dashboards can chart probe-skip rate.
   When the probe fires and returns `false`, emit `agent.heartbeat_gc.stopped {reason:"tmux_dead_after_probe"}`.
   When the probe disagrees with the cached `tmuxAlive` field, emit
   `agent.tmux_liveness_correction` and update the cached field.
3. **Gate 3 — heartbeat too old + idle**: downgrade `health` from `"healthy"` to `"stale"`
   (does NOT touch `status`; a busy agent with a stale heartbeat may be in a long tool call).
   Emit `agent.heartbeat_gc.stale`.

**Exemptions** (skipped entirely before gates):

- Orchestrator pseudo-agent.
- Lease-valid agents (`leaseKind === "reuse" || leaseKind === "park"` AND `leaseUntil > now`).
- Paused agents without a lease, OR paused agents with a VALID lease.

**Expired-lease paused-agent exception** (Review item 3 fix): an agent with
`paused === true && leaseKind in {"reuse","park"} && leaseUntil <= now` is NOT exempted.
Gate 1 still runs, so an expired-park agent whose pane actually died gets flipped to
`stopped` instead of staying a zombie forever. The trace
`agent.heartbeat_gc.expired_park_flipped {reason:"tmux_dead_after_lease_expiry"}` distinguishes
this case from the normal gate-1 dead-pane flip.

**`swarm_prune` remains the orchestrator escape hatch** for already-stopped records that
the heartbeat GC does not touch. The GC is bounded by `probesFired + direct flips`; the
size of the `state.agents` stopped set only grows until prune runs. The R9 a3 graveyard
(177 stopped agents) becomes bounded: the GC flips dead-pane running records automatically,
and prune removes the resulting stopped records on operator demand.

## Operator: Stale-open surfacing (Issue 83 sub-task a, P1)

The liveness/progress subsystem surfaces worker nodes that have been assigned or in-progress
for longer than a threshold without any forward-progress signal. Surfacing is **trace-only**
(no orchestrator mailbox nudge is sent — the plan's nudge was consciously dropped; the
pre-existing task-stall machinery still nudges on stalled nodes per "Pipeline-stall nudge"
below).

**The gate** (in `staleOpenAssignmentScanLocked`, called from `pumpOrchestratorMailbox` after
`agentHeartbeatGCLocked` and before `reconcileGraphAdvanceLocked`):

```
lastProgressAt = node.lastProgressAt ? new Date(node.lastProgressAt).getTime() : 0
lastActivityAt = node.lastActivityAt  ? new Date(node.lastActivityAt).getTime()  : 0
anchorMs       = max(lastProgressAt, lastActivityAt)          # plan §(a) max-anchor
staleAtMs      = anchorMs ? nowMs - anchorMs : +Infinity      # no timestamps → always stale
# gate fires when staleAtMs > thresholdMs AND no surface stamp in this window
```

A freshly-assigned node (recent `lastActivityAt`, no `lastProgressAt` yet) is anchored on
`lastActivityAt` and is NOT stale. Forward progress (any tool call) is captured by
`hooks.ts:tool_execution_end` via `ensureNodeActivityStamp`, which sets `lastProgressAt`
and clears any prior `staleOpenSurfacedAt`. The gate's anchor on the most-recent activity
timestamp means a node is stale only when BOTH signals are older than the threshold.

**Environment override**

`PI_SWARM_STALE_OPEN_THRESHOLD_MS` (default 300_000 = 5 min). Tighten for short-cycle work,
loosen for long-running nodes. The scan is idempotent within the window: re-running before
threshold expiry produces 0 additional surfaces per node.

**Trace event**: `stale_open_surfaced` payload `{ taskId, nodeId, assignee, assignedAt,
lastProgressAt, thresholdMs, staleMs }`. `staleMs` is the rounded stale-age in ms; `null`
when the node has no timestamps at all.

**Pump-phase cost bound** (R10-1, honest, not in-memory):

| per pump tick | op | cost |
| --- | --- | --- |
| 1 | `readdirSync(p.tasksDir)` | O(N) syscalls where N = count of `task-*` subdirs |
| N | `readTaskState(tp.taskJson)` | N file reads (one per task) |
| 0–N | `writeTaskState(tp, task)` | one write per dirty task (rare: only newly-surfaced nodes) |
| 0 | tmux subprocess calls | ZERO — scan is purely in-process |

The scan runs inside the existing pump `withLock` (no nested lock). For a 100-task swarm
this is ~100 file reads per pump tick (~5 s cadence); no interval gate yet
(`PI_SWARM_STALE_OPEN_SCAN_INTERVAL_MS` is a follow-up). Wrapped in `try/catch` so a scan
failure never crashes the tick.

**Hook-side I/O cost per tool call** (also honest, NOT zero):

| per `tool_execution_end` | op | cost |
| --- | --- | --- |
| 1 | `withLock` + `readState` | swarm state |
| N | `readTaskState` | one per active task in `agent.activeTaskIds` |
| M ≤ N | `writeTaskState` | one per dirty task (worker bound to the node) |

N is bounded by `agent.maxConcurrentTasks`. This is **extra I/O vs the pre-83a baseline**
(which did not stamp on tool calls). The cost is honest and bounded, not free.

**C5 R10-1 counting assertion** (in-repo, `extensions/swarm/liveness-progress.test.mjs`):

- **C5** seeds 100 stale-open nodes, asserts ZERO `tmux.list-panes` calls per scan.
- **C11** seeds 3 active tasks (1 dirty, 2 not), asserts exactly the dirty task is stamped.
- **Multi-tick lane** (`/tmp/83a-lane/c5-multi-tick.mjs`, deferred for repo promotion): 5 ticks × 55 slots = 275 potential probe slots → ZERO probes fired. Idempotency across ticks.

**Plan deviations** (accepted; documented per R11):

| plan | implementation | rationale |
| --- | --- | --- |
| 3 stamp surfaces (tool hook + `swarm_update_task` transitions + `swarm_send_message`) | 1 stamp surface (tool hook only) | The max-anchor picks up `lastActivityAt`, which the assign + update paths already stamp. `swarm_send_message` did not add value (mailbox acks are not "progress" in the worker's task context). |
| Send orchestrator mailbox nudge on surface | Trace-only surfacing | Pre-existing task-stall nudge machinery (see "Pipeline-stall nudge") already nudges on stalled nodes. Adding a redundant nudge would inflate the idle-streak budget and create double-fire risk. |
| R10-KR5 (silent-swallow keeper rule) | Documented | Hook's bare-catch is locked in by C9 (integration test exercises the production hook path; swallowed throw fails C9 loudly). |
| R10-KR6 (seed-diversity keeper rule) | Documented | C3 + C10 together pin both sides of the stale boundary; C11 pins the dirty-task selection. |

**Related tools**

- `/swarm trace` to view `stale_open_surfaced` events.
- `swarm_task_status` shows `node.staleOpenSurfacedAt` per node.

## Operator: Late-result fencing (Issue 83 sub-task b, P1)

Two related guards protect against late worker results and reassign churn:

1. **Tool-layer fence** in `swarm_update_task` — when a worker calls `swarm_update_task` against a node whose `activeAttemptId` no longer matches the caller's `attemptId` (because the node was reassigned since the worker was assigned), the tool returns the refusal envelope `{ refused: true, reason: "supersession", ... }`, emits the `message.late_result_rejected` trace, increments `MessageRecord.lateResultRejectionCount`, and **leaves the node untouched** (no status mutation, no evidence rewrite, no shared-context merge). The caller is expected to read the latest assignment message and self-correct.

2. **Reassign rate-limit gate** in `swarm_assign_task` — a fixed-window per-node gate (`supersessionCount` / `supersessionWindowStart` on `TaskNode`) refuses fresh reassigns with `REASSIGN_RATE_LIMITED` once the node has accumulated `PI_SWARM_REASSIGN_RATE_LIMIT` reassigns within `PI_SWARM_REASSIGN_RATE_WINDOW_MS`. The refusal emits `reassign.rate_limited` with the current count, limit, and `windowResetAt`. The gate is HARD — refusals do not queue; the caller must wait for the window to expire.

The rec-level superseded-message guard in `reconcile.ts` (the `isActionableOrchestratorMessage` predicate used by pump re-trigger and migration back-fill) also emits `message.late_result_rejected` with `reason: "rec_superseded"` so operators can count late arrivals from both the tool-layer and rec-level paths in the same trace census.

**Environment overrides**

- `PI_SWARM_REASSIGN_RATE_LIMIT` (default 5) — maximum reassigns per node per window. Must be a positive integer; non-positive falls back to default.
- `PI_SWARM_REASSIGN_RATE_WINDOW_MS` (default 60_000 = 1 min) — fixed-window length in milliseconds. Positive integer; non-positive falls back to default.

**Trace events**

| trace | when | payload |
| --- | --- | --- |
| `message.late_result_rejected` | Tool-layer fence refuses `swarm_update_task` because the caller's attemptId is superseded, OR rec-level superseded-message guard drops a record in pump/migration | `{ taskId, nodeId, attemptId?, supersededBy, lateArrivalAt?, reason: "supersession" \| "rec_superseded" }` |
| `reassign.rate_limited` | `swarm_assign_task` would exceed the per-node rate limit | `{ taskId, nodeId, currentCount, limit, windowMs, windowStart, windowResetAt }` |

**Durable observability fields**

- `TaskNode.supersessionCount` (number) and `TaskNode.supersessionWindowStart` (ISO timestamp) — the per-node gate ledger; reset to fresh window when `(nowMs - windowStart) > PI_SWARM_REASSIGN_RATE_WINDOW_MS`.
- `MessageRecord.lateResultRejectionCount` (number) and `MessageRecord.lastLateResultRejectionAt` (ISO timestamp) — additive observability for repeated late-result attempts against the same message record.

**C9/C10 R10-1 counting assertions** (in-repo, `extensions/swarm/supersession-fencing.test.mjs`):

- **C1/C2** seed 1 hot node + 1 cold node; run 6 reassigns against the hot node within the window. Asserts exactly 5 succeed and the 6th produces `REASSIGN_RATE_LIMITED` + `reassign.rate_limited` trace; the cold node is untouched. After the window expires, a fresh reassign succeeds.
- **C3** seeds a superseded attempt + a newer active attempt; the late-result path returns `{ refused: true, reason: "supersession" }`, emits exactly one `message.late_result_rejected` trace, and asserts NO node mutation (status, evidence, shared-context unchanged across re-reads).
- **C4** asserts the rec-level guard emits `message.late_result_rejected` with `reason: "rec_superseded"` for superseded messages dropped in the pump re-trigger path.

**Mock-LLM fixture**: `extensions/mock-llm/fixtures/supersession-late-result.jsonl` — stale worker attempts to close a node after its attempt was superseded; exercised end-to-end through the mock-LLM registry. Lane command: `pi --no-extensions --provider mock-llm --model supersession-late-result -e ./extensions/mock-llm -e ./extensions/swarm`.

**Related tools**

- `/swarm trace` to view `message.late_result_rejected` and `reassign.rate_limited` events.
- `swarm_task_status` shows `node.supersessionCount` and `node.supersessionWindowStart` per node.

## Operator: Proxy metrics (Issue 83 sub-task c, P1)

Proxy metrics are a cheap, proxy-first snapshot of the swarm's stall surface. The pump writes
`SwarmState.proxyMetrics` after stale-open scanning and before the idle/goal nudge pass, and
`/swarm metrics` reports the same snapshot read-only.

**Snapshot fields**

- `hungButAlive` — count of agents that are running, effectively idle, have a fresh heartbeat,
  and still carry at least one assigned/in_progress node that has gone stale.
- `staleOpen` — count of assigned/in_progress nodes whose `lastProgressAt`/`lastActivityAt`
  anchor is older than `PI_SWARM_STALE_OPEN_THRESHOLD_MS`.
- `supersessionChurn` — count of per-node reassign churn observed within the current
  `PI_SWARM_PROXY_METRIC_INTERVAL_MS` window.

**Environment override**

- `PI_SWARM_PROXY_METRIC_INTERVAL_MS` (default 60_000 = 1 min) — bounds how often the pump emits
  a fresh `proxy.metric_emit` trace and refreshes the durable snapshot.

**Trace event**: `proxy.metric_emit` payload `{ emitAt, hungButAlive, staleOpen, supersessionChurn, intervalMs, thresholdMs, heartbeatStaleMs }`.

**Related tools**

- `/swarm metrics` to read the current proxy snapshot.
- `/swarm status` to see the same snapshot in the rollup line.
- `/swarm trace` to census `proxy.metric_emit` alongside the other Issue 83 traces.

## Operator: explicit reuse lease + park mechanism (Issue 82)

By default the task-close sweep stops task-scoped workers (Issue 26) and the heartbeat GC
flips dead panes. For workers the orchestrator wants to outlive their task scope, the
explicit reuse lease + park mechanism overrides these defaults.

**Lease fields on `SwarmAgent`** (additive; absent == default behavior):

- `leaseKind: "reuse"` — the worker should survive the closing task and be reused for a
  future task. Sweep skips; heartbeat GC exempt.
- `leaseKind: "park"` — the worker should be parked (paused, pane preserved) at task
  close instead of stopped. Sweep pauses (sets `paused: true`, preserves `status: running`);
  heartbeat GC exempt while the lease is valid.
- `leaseUntil: string` — ISO timestamp; lease auto-expires past this. Expired leases fall
  through to default behavior on the next sweep tick.
- `leaseReason: string` — free-text audit annotation.

**Three stamp surfaces**:

1. `/swarm agent lease <id> [--reuse|--park] [--until <iso>] [--reason <text...>] [--clear]`
   (orchestrator-only; `--reason` consumes all remaining tokens). Traces
   `agent.lease_set` / `agent.lease_cleared`. Default flags: `--reuse`,
   `--until now+1h`, `--reason "operator lease"`.
2. `swarm_assign_task({ lease: { kind: "reuse"|"park", until?, reason? } })` — stamps
   the assignee's record at assignment time. Traces `task.lease_stamped`.
3. Direct field mutation (not recommended; use the surfaces above).

**Clear**: pass `--clear` or run `delete agent.leaseKind/leaseUntil/leaseReason`.

**Observability note** (review-item-4 / audit-trace debt): the plan originally called for
a `agent.task_sweep_skipped {reason: "cross_task_default_kept"}` audit trace on every
non-event task close. The implementer did NOT add this trace because the kept path is
the pre-existing Issue-26 default behavior (`wasInClosingTask=false` → early continue);
emitting a trace per kept agent on every close would add noise without changing behavior.
The behavioral correctness is independently verified by the round-2 cross-task lane
(`/tmp/82-lane-m/lane-cross-task.mjs`); a follow-up can add the trace if dashboards need
a per-sweep audit count.

## Operator: Phase 2 authoritative lifecycle (Issue 25)

Phase 2 ships with the gate OFF. Behavior switches only when
`PI_SWARM_MINIMAL_PROTOCOL=1` is set at module load:

- **Gate flip**: set the env var for the orchestrator (and workers) to enable
  authoritative lifecycle derivations, reply auto-verify + fencing, ACK-banner
  removal, and profile-gated active tool sets. Default `0` keeps Phase-1 shadow
  behavior byte-identical.
- **Rollback**: unset the env var and restart sessions — gate=0 is fully
  behavior-preserving; no on-disk migration is required to roll back.
- **Rate-limit env var**: `PI_SWARM_RECONCILE_DRYRUN_WORKER_RATE_MS` (default
  60000) throttles worker-scoped dry-run reconcile; workers are also forced to
  `scope: "self"` while orchestrator/admin may pass `scope: "all"`.
- **New trace events** under gate=1: `message.lifecycle_derived` (per derivation
  site), `message.response.verified`, `message.reply_rejected_superseded`.
- Before flipping the gate in a production swarm, run the proposal §H 10×2 UAT
  matrix (two model lanes × repeated runs).
for the test matrix and `docs/swarm/reliability-execution-plan.md` for issue-tracking history.

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
`task:{taskId}:nudge:initial-ready`, `goal:{goalId}:nudge:idle-streak`), formatted by `formatNotifyKey`,
and the same dedupe/cooldown/cap contract. Every message tells the recipient the concrete next action
(the exact tool call) plus an alternative path (cancel/inspect).

### Goal idle-streak nudge (Issue 18)

The orchestrator's durable goal plus an anti-loop nudge that fires when the swarm has nothing to do.

- **Set the goal**: `/swarm goal set [--interval <ms>] <text>` or `swarm_set_goal({ text, intervalMs? })`. The orchestrator-only
  tool/command stores `swarm-state.json.goal = { id, text, setAt, setBy, consecutiveNoResolveNudges, nudgeIntervalMs? }`.
  Setting a new goal replaces the old one, resets `consecutiveNoResolveNudges` to 0, and clears any
  back-off state (`backoffTicksRemaining`, `lastNudgeAt`, `lastResolvedAt`) so a new intent never
  inherits the previous goal's counter. When `nudgeIntervalMs` is absent the pump falls back to
  `PI_SWARM_GOAL_NUDGE_IDLE_INTERVAL_MS` (default 60s); when present, the durable per-goal value
  controls the goal nudge cadence and is surfaced by `/swarm goal show` and `/swarm status`.
- **Idle predicate** (every pump tick, inside the existing `withLock` in `pumpOrchestratorMailbox`):
  every non-orchestrator agent must be `runtimeStatus: "idle"` AND zero task nodes may be in
  `assigned` or `in_progress` status across `tasks/<taskId>/task.json`. If either fails, no nudge.
- **Anti-loop counter**: `consecutiveNoResolveNudges` resets to 0 on ANY orchestrator turn that ends
  `stopReason: "stop"` AND `role: "assistant"` — the act of ending a turn (vs staying silent) is the
  resolve signal. A `turn_end {error}` is intentionally NOT a resolve (tool/model failures are not
  "I addressed the goal"); a non-orchestrator `turn_end` is also NOT a resolve (workers don't decide
  the goal). The reset runs in a second `pi.on("turn_end", ...)` handler registered AFTER the
  model-pool swap branch, so the resolve observes the post-swap state.
- **Back-off**: once `consecutiveNoResolveNudges` reaches `MAX_CONSECUTIVE_NUDGES_DEFAULT` (3,
  overridable via `PI_SWARM_MAX_NUDGES`), the pump enters a `GOAL_NUDGE_BACKOFF_TICKS`-tick (2)
  back-off: each subsequent tick decrements `backoffTicksRemaining` without emitting. The tick that
  drains the counter to 0 is the back-off exit gate and does NOT emit (avoids a one-tick
  over-emit); the FOLLOWING tick may re-enter the `max_nudges` branch if the counter is still at
  cap and re-arm the back-off. The pattern stabilises at "3 nudges → 2-tick back-off → repeat"
  until the goal is resolved (counter reset) or cleared (`swarm_mark_goal_done`).
- **Idempotency**: the nudge's semantic key is `goal:{goalId}:nudge:idle-streak`, validated via
  `SAFE_ID_RE`. A fresh `swarm_set_goal` mints a new `goalId` so a fresh goal is a fresh emit slot.
  Within the same goal, `findIdempotentMessage(st, "orchestrator", "orchestrator", key)` suppresses
  duplicate emissions across concurrent ticks (matches the existing semantic-key dedupe pattern used
  by `reconcileGraphAdvanceLocked` and `reconcileInitialReadyLocked`).
- **Clear the goal**: `/swarm goal done [<goalId>]` or `swarm_mark_goal_done({ goalId? })`. Deletes
  `state.goal` (no archive), traces `goal.cleared`. Optional `<goalId>` is a safety fence; the call
  throws if it does not match the current goal.
- **Trace events**:
  - `goal.set` — durable write of `st.goal` (from tool or command).
  - `goal.cleared` — `delete st.goal` (from tool or command).
  - `goal.idle_nudge` — successful nudge emit; payload includes `goalId`, `consecutiveCount`, `max`,
    `idleAgents`, `key`, `customType: "goal.idle_nudge"`.
  - `goal.nudge.resolved` — `turn_end {stop}` reset of the counter; payload includes `goalId`,
    `nudges` (counter pre-reset), `hadBackoff`, `by: "turn_end"`.
  - `goal.nudge.backoff` — first tick after the counter reached `MAX`; payload includes `goalId`,
    `nudges`, `max`, `backoffTicks`.
  - `goal.nudge.backoff.skip` — subsequent skipped ticks while `backoffTicksRemaining > 0`.
  - `goal.nudge.backoff.exhausted` — tick when the back-off counter hits 0 (does NOT emit).
  - `goal.nudge.error` — caught exception wrapper (matches the existing `reconcileGraphAdvanceLocked`
    / `reconcileInitialReadyLocked` try/catch pattern; a throw never kills the pump tick).
- **Authoritative gate**: both `swarm_set_goal` and `swarm_mark_goal_done` call
  `requireOrchestratorAuthority(currentAgentId(), "<tool>")` which throws
  `ERR_ORCHESTRATOR_AUTHORITY_REQUIRED` for non-orchestrators. The `/swarm goal` slash command adds
  an explicit `currentAgentId() !== "orchestrator"` notify (matches the `attention`/`remind`/`stop`
  /`release` pattern).
- **No new public schema**: only the two declared tools + the two slash command subcommands. No
  new event hooks, no new env knobs beyond `PI_SWARM_MAX_NUDGES`.

### Pipeline-stall nudge (Issue 23)

The goal-nudge (Issue 18) only fires when the orchestrator has set an explicit `swarm_goal`. If
the operator never sets a goal, a task can stall silently: every node is `ready` (or `assigned`
to a dead agent), every agent is `idle`, and no nudge is ever sent because the predicate
`if (!goal) return { emitted: false, reason: "no_goal" }` short-circuits. The pipeline-stall
nudge is the goal-independent counterpart.

- **Predicate (a nudge fires when ALL hold)**:
  1. At least one `in_progress` task exists in `tasksDir`.
  2. At least one of its nodes has `status === "ready"` AND `assignee === undefined` (the same
     actionable set as `reconcileGraphAdvanceLocked`).
  3. Every non-orchestrator agent is `runtimeStatus === "idle"`.
  4. The task has existed for at least `TASK_INITIAL_READY_GRACE_MS` (60 seconds) so a fresh
     task's first tick is not immediately flagged.
  5. NOT firing the existing `reconcileGraphAdvanceLocked` nudge for the same node already
     (the shared `NOTIFY_KEY_GRAPH_ADVANCE` dedupe key) so two concurrent nudges don't compete.
- **Back-off machinery**: mirrors the goal-nudge but is per-task. New `SwarmTaskStallState` on
  `SwarmState` (per-taskId counter + 2-tick back-off). Cap at `MAX_TASK_STALL_NUDGES` (3,
  overridable via `PI_SWARM_MAX_TASK_STALL_NUDGES`); back-off at `GOAL_NUDGE_BACKOFF_TICKS` (2).
- **Resolve detection**: any reassignment of an actionable node — including a worker's claim of
  an unassigned node via `swarm_update_task` (Issue 24.a) — resets the counter. So does the
  task leaving `in_progress` state (e.g. all nodes reach terminal, or `cancelTask=true`).
- **Resolve hooks** (call sites that mutate the counter):
  - `swarm_assign_task` after stamping `node.assignee` (`tools/tasks.ts`).
  - `swarm_update_task` claim branch after minting an attempt + stamping assignee (Issue 24.a).
  - `applyTaskStatus` terminal-transition sites (`tools/tasks.ts`): create_task auto-close path,
    update_task main path, and update_task second-pass after auto-close.
- **Trace events**:
  - `task_stall.nudge_emitted` — successful nudge emit; payload includes `taskId`,
    `actionableCount`, `actionable` (capped at 5 nodeIds), `consecutiveCount`, `max`,
    `idleAgents`, `key`.
  - `task_stall.nudge.resolved` — counter reset on assign/claim/terminal transition.
  - `task_stall.nudge.backoff` — first tick after the counter reached `MAX`; payload includes
    `taskId`, `nudges`, `max`, `backoffTicks`.
  - `task_stall.nudge.backoff.skip` — subsequent skipped ticks while `backoffTicksRemaining > 0`.
  - `task_stall.nudge.backoff.exhausted` — tick when the back-off counter hits 0 (does NOT emit).
  - `task_stall.nudge_error` — caught exception wrapper (matches the existing nudge error pattern).
- **No new public schema**: reuses existing pump machinery; no new tools or commands.

#### DISTINCTION FROM GOAL-NUDGE (do not conflate)

The goal-nudge resolves on `turn_end` activity at the `hooks.ts` site (`hooks.ts:484-506`); the
task-stall nudge resolves on graph-mutation events (assign, claim, terminal-transition). Two
independent counters with two different reset triggers, both running under the same `withLock`.
Operators may see both nudges in the same pump tick if both predicates fire (goal set + stalled
task); the two messages use different dedupe keys (`goal:{goalId}:nudge:idle-streak` vs
`task:{taskId}:nudge:graph-stall`).

### Node ownership self-heal (Issue 24)

The orchestration engine has two safety nets that prevent orphaned nodes from blocking work
indefinitely.

#### Claim of unassigned nodes (Issue 24.a)

`swarm_update_task` no longer rejects outright when a node has `assignee=undefined`. A
non-terminal unassigned node is claimed by the first caller: status moves to `assigned`,
attempt-mint via the shared `mintNodeAttempt` helper (in `taskgraph.ts`), and the claimer's
`activeTaskIds` is updated. An in-flight unassigned node (`status="in_progress"` + `assignee=undefined`)
is still refused with the inline-string `OWNERSHIP_REQUIRED` error code; the caller is directed
to escalate to the orchestrator (`force=true` or a fresh `swarm_assign_task`).

The trace event `task.node.claimed` is emitted on every successful claim with `{ taskId,
nodeId, claimer, priorAssignee: null, priorStatus, attemptId, created }`.

#### Assignment auto-stamp (Issue 24.b)

`deliverMessageLocked` auto-stamps `node.assignee = msg.to` when the message is assignment-style
(subject starts with `"Task "` and contains `" assigned"`; conversationId matches
`task:{taskId}:{nodeId}`). The auto-stamp runs INSIDE the swarm lock (caller's contract) and
**MUST NOT** re-wrap in `withLock` — `withLock` is mkdir-based and non-re-entrant; nested
acquisition hangs ~120s then throws. The only residual race is a `writeTaskState` failure,
which the claim branch (24.a) self-heals on the recipient's first `swarm_update_task` call.

#### Remediation hints (Issue 24.c)

Every `failTaskTool` reject **listed in the §24.c coverage table** in `tools/tasks.ts` includes
an `actionableHint` or `suggestedNextCall` so the LLM caller has a concrete next step. The full
21-site audit is tracked as follow-up issue `task-graph-reject-hints-coverage-audit` (deferred).

#### Ownership-reject trace (Issue 24.d)

`task.update.ownership_reject` is emitted on every `NODE_ASSIGNEE_MISMATCH` (and the new
`OWNERSHIP_REQUIRED`) so dashboards can surface ownership drift. Payload includes `{ taskId,
nodeId, attemptedBy, priorAssignee, priorStatus, isOrchestrator, remediation, errorCode }`.

#### Assignment-mismatch trace (Issue 24.e)

`message.deliver.assignment_mismatch` warns when an assignment-style message is delivered to a
recipient whose `node.assignee` already differs (reassign race or config error). Advisory only
— the message is still delivered. The recipient may legitimately need context for a handover.

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


## Operator protocol-migration (Issue 25 Phase 1)

`/swarm protocol migrate [--dry-run]` is the operator command for upgrading durable v1 message envelopes to v2 evidence fields (proposal §A + §D, plan §2.7). It runs entirely under the existing `withLock(p)` critical section; no nesting; no state writes outside the lock.

**When to run**

- After every stable release once `PI_SWARM_MINIMAL_PROTOCOL=1` is enabled (Phase 2 gate-flip).
- During the two-stable-release compatibility window before `requiresAck` is deprecated (Phase 3 governance).
- Before an operator wants to roll forward into inferred-lifecycle tooling that consumes `seenAt` / `processingAt` / `respondedAt` / `terminalAt`.

**What it does and does NOT do**

- ✅ Back-fills `mailboxDeliveredAt` from existing `delivered[to]` entries (transport-only).
- ✅ Stamps `migrationRunId` + `migratedAt` audit fields per migrated record.
- ❌ Does NOT invent `seenAt` / `respondedAt` / `processingAt` / `terminalAt` / `lifecycleStage`.
- ❌ Does NOT dead-letter or skip records lacking v2 fields.
- ❌ Does NOT change completion or recovery semantics.

**Dry-run**

```bash
/swarm protocol migrate --dry-run
```

Emits `protocol.migration.record` per record (action `skip` / `plan`) and one `protocol.migration.completed` summary. Does NOT write state.

**Real run**

```bash
/swarm protocol migrate
```

Stamps eligible records; emits `protocol.migration.record` (action `stamp`) + `protocol.migration.completed` summary. Idempotent: a second run yields `migrated: 0`.

**Rollback**

A migration run is additive-only. Deleting the `migrationRunId` and `migratedAt` fields from `swarm-state.json` reverts the audit stamps without affecting durable message state. No other code path consults those fields.

**Trace events**

- `protocol.migration.record` — per record; payload `{ runId, messageId, from, to, action, reason, fields, auditOnly, dryRun }`.
- `protocol.migration.completed` — one per run; payload `{ runId, scanned, migrated, skipped, errors, dryRun, via, gate }`.

**Related tools / commands**

- `/swarm trace` — view the migration trace.
- `swarm_message_status` — inspect a single record's v2 fields (admin/diagnostic; not model-exposed by default).

---

## Operator: R14 pool-empty escalation (2026-09-02)

### When this matters

You have set a user-origin goal (`swarm_set_goal({origin:"user",...})`) and the
worker pool has been empty for >5 minutes. The orchestrator has not seen any
recovery nudge — the pump fired `goal.nudge.held_no_live_workers` every tick
(7_278 traces over ~16h was the live incident; `goal-1788266039522-6eae40`).
Without R14 the user sees a silent stall; the operator sees only the spam
trace; the goal never escalates.

### What R14 changed

Three coupled fixes (live `reconcile.ts`):

- **Fix A — settled-but-alive liveness predicate**
  (`reconcile.ts:308-322` `agentIsEffectivelyAlive`). A worker with
  `tmuxAlive === true`, `status === "running"`, `runtimeStatus === "idle"`,
  and a stale heartbeat (>10min) is now counted as effective. Pre-fix, such
  workers were misclassified as dead; their swarms were always vacuous. The
  `tmuxAlive === false`, `status !== "running"`, and
  `runtimeStatus === "stopped"` early-returns (the genuine ghost signals)
  stay.
- **Fix B — once-per-transition trace dedupe**
  (`reconcile.ts:516+` vacuous branch). `goal.nudge.held_no_live_workers`
  fires only on the `idleAgents.length > 0` → `0` transition (the
  once-per-transition promise in the comment was never enforced; the code
  fired every tick). The flag lives on `st.idleNudgeState.lastWasVacuous`
  and is cleared on the pool-recovered edge
  (`reconcile.ts:updateIdleEpochLocked`).
- **Fix C — bounded user-origin escalation** (new path inside the
  vacuous branch). For an active user/system/batch-origin goal whose pool is
  genuinely vacuous (no worker passes the predicate), the pump emits ONE
  high-priority orchestrator-bound nudge per
  `NOTIFY_DEFAULT_COOLDOWN_MS` (5min default). The nudge goes through the
  existing R13 P0 high-priority surface (mailbox-only durable append +
  pump's R13 bypass). The escalation stops when:
  - the goal clears/cancels (`swarm_mark_goal_done`),
  - the pool becomes non-vacuous (`vacuous: false` for ≥30s — soft reset),
  - the existing escalation message is `acked` with `status: "done"`.

### Six R10-1 boundary counters

| counter | boundary | expected |
| --- | --- | --- |
| `idleAgentsCount` | `reconcile.ts:318` filter | `>0` for settled-but-alive pool (Fix A); `0` for genuinely-vacuous pool |
| `heldNoLiveWorkersTraceCount` | `reconcile.ts:520` trace | `1` per false→true transition (Fix B); `0` once the pool recovers |
| `escalationSendCount` | `reconcile.ts:escalation.deliverMessageLocked` | `1` per cooldown (Fix C); `0` for orchestrator-origin goals |
| `mailboxAppendCount` | `mailbox.ts:362,445` durable append | `1` per escalation (durable contract intact) |
| `sendMessageCallCount` | `reconcile.ts:1763-1773` pump | `1` per escalation when orchestrator idle (R13 path; unchanged) |
| `escalationCancelledOnClearCount` | `goals.ts:32-51` clear | `1` when goal clears mid-cooldown; `0` escalations after clear |

### Diagnosing in the field

If `goal.nudge.held_no_live_workers` is firing repeatedly and
`goal.escalation.pool_empty` is NOT firing:

1. Check `goal.origin`. The escalation only fires for
   `user` / `system` / `batch` origin (NOT `orchestrator`). Use
   `swarm_set_goal({origin:"user",...})` if the goal was set by an automated
   orchestrator and you want escalation.
2. Check the cooldown. `idleNudgeState.lastPoolEmptyEscalationAt` is the
   anchor; one nudge per `NOTIFY_DEFAULT_COOLDOWN_MS` (5min default). The
   second escalation within the cooldown is expected to be silent.
3. Confirm the pool is GENUINELY vacuous. The escalation path runs only
   inside the `if (vacuous)` branch — Fix A makes settled-but-alive pools
   non-vacuous, so a healthy pool with stale-heartbeat workers will resume
   the normal goal-nudge path (NOT the escalation path).

### Verify the fix locally

```bash
# RED shape (pre-fix would yield 12 held traces + 0 escalations):
git stash push extensions/swarm/src/reconcile.ts -m "r14-red-check"
node extensions/swarm/r14-goal-empty-pool-escalation.test.mjs  # FAIL R14-S2, R14-S4
git stash pop

# GREEN shape (post-fix):
node extensions/swarm/r14-goal-empty-pool-escalation.test.mjs  # PASS 15/0

# Live tmux lane (settled-but-alive shape, 12 ticks):
tmux new-session -d -s r14-validate -n r14 -c "$REPO"
tmux send-keys -t r14-validate:r14.0 -l "PI_SWARM_AGENT_ID=orchestrator PI_SWARM_IS_ORCHESTRATOR=1 pi -ne --provider mock-llm --model r14-goal-empty-pool-vacuous -e ./extensions/mock-llm -e ./extensions/swarm" Enter
# Wait 10s, drive scripted turns, observe escalation surfaced once per cooldown.
```

### Trace census (post-fix)

```
goal.set                                         (origin=user, nudgeIntervalMs=5000)
goal.nudge.held_no_live_workers                  (×1 — once per false→true transition; pre-fix was ×N per tick)
goal.escalation.pool_empty                       (×1 — one per cooldown; first cooldown-eligible tick)
message.deliver.mailbox_only                     (×1 — durable escalation append)
[next orchestrator pump tick when orchestrator is idle]
pi.sendMessage → orchestrator                    (×1 — R13 P0 high-priority surface; the escalation finally crosses the swarm→Pi boundary)
```

### Related tools / commands

- `swarm_set_goal({origin:"user",...})` — set a goal with escalation.
- `swarm_check_mailbox` — inspect the durable escalation nudge in the
  orchestrator mailbox (R13 boundary; unchanged).
- `/swarm trace` — view the trace census above.

## Operator: R16 idle-goal ACK-loop + vacuous persistence (2026-09-02)

R16 fixes two regressions that survived R14:

1. **ACK-reset loop:** the resolve hook at `hooks.ts:524-549` reset
   `consecutiveNoResolveNudges` on any text-bearing turn_end, so a
   pure ack ("Got it", "Acknowledged", "Will keep going") reset the counter
   every cycle and the cap at MAX_CONSECUTIVE_NUDGES_DEFAULT=3 was never
   reached. Live incident: 47 idle_nudge / 36 resolved in 10 min for
   `goal-1788266039522-6eae40`.
2. **Post-R14 vacuous state persistence failure:** the `lastWasVacuous` +
   `lastPoolEmptyEscalationAt` mutations lived in RAM and persisted only
   via the pump tail writeState. Live incident: 331 held_no_live_workers
   traces over 27m 54s with zero escalations because the orchestrator
   process had not been /reload'd since before R14 landed.

### When this matters

- The orchestrator emits plain ack text in response to goal nudges (any
  LLM-driven orchestrator does this by default).
- The orchestrator /reload's mid-conversation while a standing user
  goal is still active.

### What R16 changed

- **hooks.ts** — module-scope `SWARM_RESOLVE_TOOLS` set + `turnEndIsResolveAction(event)`
  detector. The turn_end handler gates the counter reset on
  `turnEndIsResolveAction(event).resolve` (true only when the turn
  contained a swarm tool call). Ack-only turns emit
  `goal.nudge.turn_no_resolve_action` (new trace) instead of resetting.
- **reconcile.ts** — vacuous branch ends with an explicit
  `writeState(p, st)` so `lastWasVacuous` + `lastPoolEmptyEscalationAt`
  survive an immediate readState (orchestrator /reload right after the
  pump). The pump tail writeState at `reconcile.ts:1929` still runs as
  the source of truth for OTHER pump mutations; this is the minimum
  additional write that closes the persistence gap.
- **reconcile.ts** — escalation body builder classifies `poolDiag` into
  dead-panes / stopped-agents / stale-heartbeats / fallback hint buckets
  and joins them with `swarm_spawn_agent` / `swarm_restart_agent` /
  `swarm_create_task` / `swarm_mark_goal_done` references. The body is
  now action-oriented per the orchestrator's note.
- **state.ts** — `idleNudgeState` back-fill: narrow to a plain object so
  legacy swarm-state.json files with `idleNudgeState: null` or
  non-object values don't crash the evaluator.
- **types.ts** — `SwarmGoal` extended with optional `lastNonResolveTurnAt`,
  `lastResolveActionAt`, `lastResolveActionTools` (observability metadata;
  not used by the evaluator).

### Ten R10-1 boundary counters

| # | counter | boundary | file:line |
| --- | --- | --- | --- |
| C1 | `goal.idle_nudge` trace count | real trace | `reconcile.ts:744` |
| C2 | `goal.nudge.resolved` trace count | real trace | `hooks.ts:545` |
| C3 | `goal.nudge.held_no_live_workers` trace count | real trace | `reconcile.ts:552` |
| C4 | `goal.escalation.pool_empty` trace count | real trace | `reconcile.ts:572` |
| C5 | `escalationMailboxAppendCount` | durable mailbox append | `mailbox.ts:445` |
| C6 | `escalationSendMessageCount` | real sendMessage | `reconcile.ts:1763-1773` |
| C7 | `consecutiveNoResolveNudges` value | real state mutation | `reconcile.ts:741` / `hooks.ts:540` |
| C8 | `lastWasVacuous` across reload | real persisted flag | `reconcile.ts:551-595` (write) + `state.ts:141-149` (back-fill) |
| C9 | `lastPoolEmptyEscalationAt` across reload | real persisted flag | `reconcile.ts:582` (set) + `reconcile.ts:564` (read) |
| C10 | `backoffTicksRemaining` value | real state mutation | `reconcile.ts:683` (decrement) + `hooks.ts:540` (clear) |

### Diagnosing in the field

- **High `goal.nudge.resolved` rate with no cap reached:** the orchestrator is
  acking (text-only turn_end) without doing work. Look for
  `goal.nudge.turn_no_resolve_action` traces — these are the ack signals
  the fix surfaces.
- **Many `goal.nudge.held_no_live_workers` + zero `goal.escalation.pool_empty`:**
  the orchestrator is running pre-R16 code (no /reload'd yet) OR the
  vacuous-branch writeState is failing silently. Check the file's mtime
  on `swarm-state.json` after a held trace to confirm the writeState
  reached disk.
- **Many `goal.escalation.pool_empty` within NOTIFY_DEFAULT_COOLDOWN_MS:**
  the cooldown flag isn't persisting. Inspect the `lastPoolEmptyEscalationAt`
  field on `idleNudgeState` via `swarm_audit({mode:"events", ...})`.

### Verify the fix locally

```
node extensions/swarm/r16-idle-goal-regression.test.mjs
node extensions/swarm/r14-goal-empty-pool-escalation.test.mjs
node extensions/swarm/idle-nudge.test.mjs
node extensions/swarm/swarm-goal.test.mjs
```

All four MUST be green in the post-fix shape. The R14 + idle-nudge +
swarm-goal tests must continue to pass (no regression of R14 fix).

### Trace census (post-fix)

After R16 lands, a standing user goal on a vacuous pool produces:

```
goal.nudge.held_no_live_workers   1   (one per false→true transition; suppressed on every subsequent vacuous tick)
goal.escalation.pool_empty        1   (one per NOTIFY_DEFAULT_COOLDOWN_MS=5min window)
escalationMailboxAppendCount      1   (durable append per escalation)
escalationSendMessageCount        1   (when the orchestrator is idle at surface time; 0 if busy)
goal.nudge.turn_no_resolve_action N   (one per ack-only turn_end; N climbs as the orchestrator stalls)
```

The post-R16 trace census is bounded: `goal.nudge.held_no_live_workers`
fires once per transition (not every tick), `goal.escalation.pool_empty`
fires once per cooldown (not per tick), and `goal.nudge.turn_no_resolve_action`
fires once per ack turn (observability, not a counter reset).

### Related tools / commands

- `swarm_set_goal({origin:"user",...})` — set a goal with escalation.
- `swarm_mark_goal_done({approvedByUser:true})` — clear a user-origin
  goal (the legitimate resolve path).
- `swarm_audit({mode:"events", since:..., until:..., event:"goal.nudge.turn_no_resolve_action"})` —
  inspect the ack-only turn history.
- `/swarm trace` — view the trace census above.
