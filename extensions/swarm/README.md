# Swarm extension

Project-local pi package extension for spawning and coordinating tmux-backed pi agents.

Main file:

```text
extensions/swarm/index.ts
```

This is the entry point (a thin wiring file). The implementation lives under
`extensions/swarm/src/`:

```text
src/types.ts         type/interface definitions
src/constants.ts     module-level constants
src/utils.ts         pure helpers (now, safeId, inferRoleKind, ...)
src/state.ts         paths + state/lock/trace/JSONL/evidence file IO
src/taskgraph.ts     graph algorithms, status/closure/transitions, rendering
src/metric.ts        run/memory/iteration validation + ranking
src/delivery.ts      message parsing + retry predicate
src/session.ts       model/orchestrator detection
src/identity.ts      identity markdown generation + write
src/tmux.ts          tmux wrappers
src/mailbox.ts       mailbox read/deliver helpers
src/agents.ts        spawn/reuse/reload
src/loop.ts          V1.5 loop state
src/reconcile.ts     mail+task sweep, status summary, orchestrator pump
src/hooks.ts         event hooks + orchestrator mailbox pump
src/command.ts       /swarm slash command
src/tools/*.ts       the tool registrations, grouped by domain
                     (agents / messages / tasks / metrics / loop)
```

`index.ts` re-exports `isDeliveryFailureRetryable`, `validateRunAgainstContract`,
and `computeIterationBest` (used by the `.test.mjs` regression suites) and calls
`registerSwarmHooks` + the five `register<Domain>Tools` functions +
`registerSwarmCommand`.

This is the packaged extension source (see `package.json` → `pi.extensions = ["./extensions"]`). The old `.pi/extensions/swarm/index.ts` dev wrapper was removed; load the extension from `extensions/swarm/index.ts`.

Full documentation:

```text
docs/swarm.md
```

Quick start:

```bash
PI_SWARM_IS_ORCHESTRATOR=1 pi --model glm-5.1 --provider zai-coding-cn -e extensions/swarm/index.ts
```

Project-local swarm defaults can be set in `.pi/settings.json`:

```json
{
  "swarm": {
    "defaultModel": "gpt-5.4-mini",
    "defaultProvider": "openai"
  }
}
```

A nested `extensions.swarm` object is also accepted for backward compatibility, but top-level `swarm` is the safer recommendation because pi itself may use top-level `extensions` for extension discovery/config.

Precedence is explicit tool parameters, then `.pi/settings.json`, then env vars (`PI_SWARM_DEFAULT_MODEL`, `PI_SWARM_DEFAULT_PROVIDER`), then code defaults/model presets.

Inside pi:

```text
/swarm init
/swarm spawn reviewer Review the current diff and report risks. Do not edit files.
/swarm panes                                                # list tmux panes + which one you're in
/swarm register here reviewer Review the diff              # adopt the CURRENT pane (no target needed)
/swarm register mysession:research.1 researcher Research planner   # adopt another existing pane
/swarm role reviewer Senior reviewer --kind reviewer                # repurpose without respawn
/swarm pause reviewer                                              # drain from reuse (pane stays alive)
/swarm resume reviewer
/swarm stop reviewer                                               # refuse if active tasks; --force to override
/swarm status
```

Useful tools:

- `swarm_spawn_agent`
- `swarm_register_agent` (adopt an existing tmux pane into a role; upsert/retarget)
- `swarm_stop_agent` (refuses active tasks unless `force`; `killPane=false` to mark stopped only)
- `swarm_restart_agent` (stop + respawn at the same id; mailbox/identity persist)
- `swarm_set_role` (repurpose role/roleKind/capabilities + identity reload, no respawn)
- `swarm_set_agent_paused` (drain from reuse without killing the pane)
- `swarm_send_keys` (raw tmux keys to a pane — interrupt/dismiss/type)
- `swarm_attach_agent` (tmux attach/select commands for a pane)
- `swarm_release_agent_task` (clear a stale active-task pointer)
- `swarm_list_agents`
- `swarm_agent_status`
- `swarm_send_message`
- `swarm_check_mailbox`
- `swarm_ack_message`
- `swarm_message_status`
- `swarm_reconcile` (mail + task sweep; `mark=true` repairs task status drift)
- `swarm_prune`
- `swarm_dead_letters`
- `swarm_trace`
- `swarm_capture_agent_pane`
- `swarm_agent_identity`

Task-graph tools:

- `swarm_create_task`, `swarm_assign_task`, `swarm_update_task`, `swarm_task_message`
- `swarm_task_status` (closure rollup when `runtime=true`), `swarm_validate_graph`, `swarm_print_graph`, `swarm_next_nodes`

Runtime state is written under `.pi/swarm/` and ignored by git.

## Supported now vs deferred

**Supported now:** spawning tmux-backed agents; mailbox messaging with ACK/idempotency/dead-letter;
engine-enforced task closure (`computeTaskStatus` — `done`/`failed`/`in_progress`/`ready` derived from
node states on every create/assign/update, `cancelled` sticky); `swarm_reconcile` sweeping both mail
and tasks (mark-only; `mark=true` repairs drift; stamps advisory `node.staleAt`); a stale/nudge
ladder surfaced via reconcile, `session_shutdown` nudge, `/swarm status` PM rollup, and **PM
auto-notify** (node-close → orchestrator mailbox on a closure-ish transition; worker settled with
open work → orchestrator mailbox; settle nudge cooldown-guarded per agent) surfaced by a **session-safe
+ read-safe orchestrator auto-pump** (per-process surfaced set; `check_mailbox(markDelivered)`/ack
cannot pre-empt a pump surface; a second orchestrator lane or validation `pi -p` run cannot starve the
PM); a repeatable
task-graph UAT entrypoint at `scripts/swarm_task_uat.sh`; and a full **agent lifecycle** surface —
`swarm_register_agent` (adopt/retarget an existing tmux pane), `swarm_stop_agent` (refuses active
tasks unless `force`), `swarm_restart_agent` (respawn at the same id, preserving mailbox/identity),
`swarm_set_role` (repurpose + identity reload), `swarm_set_agent_paused` (drain from reuse without
killing), `swarm_send_keys`/`swarm_attach_agent`, and `swarm_release_agent_task` (clear stale
active-task pointers) — each mirrored as a `/swarm` subcommand (`register | stop | restart | role |
pause | resume | sendkey | attach | release`).

**Deferred (not first-class V1 tools):** `swarm_gc_agents` (use batch `swarm_stop_agent` + admin
`swarm_prune` meanwhile); destructive
auto-cleanup (auto-kill tmux windows, auto-remove agents); reminder-message re-injection from
reconcile (kept idempotent/storm-free); cross-host support, cryptographic mailbox auth, and a
consensus/heartbeat daemon. Advisory file edit locks stay advisory (not hard-enforced).
