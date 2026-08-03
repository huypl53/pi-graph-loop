# Swarm extension

Project-local pi package extension for spawning and coordinating tmux-backed pi agents.

Main file:

```text
extensions/swarm/index.ts
```

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
/swarm status
```

Useful tools:

- `swarm_spawn_agent`
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
PM); and a repeatable
task-graph UAT entrypoint at `scripts/swarm_task_uat.sh`.

**Deferred (not first-class V1 tools):** `swarm_stop_agent`, `swarm_gc_agents`,
`swarm_release_agent_task` (use `swarm_reconcile` + admin `swarm_prune` meanwhile); destructive
auto-cleanup (auto-kill tmux windows, auto-remove agents); reminder-message re-injection from
reconcile (kept idempotent/storm-free); cross-host support, cryptographic mailbox auth, and a
consensus/heartbeat daemon. Advisory file edit locks stay advisory (not hard-enforced).
