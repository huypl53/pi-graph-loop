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
- `swarm_reconcile`
- `swarm_release_agent_task` for stale pointers after confirming reconcile results

### Inspect or change agent roles

### Model pool (multi-provider rotation)

`.pi/settings.json` (under `swarm` or `extensions.swarm`) supports a weighted model pool. When configured, agent spawn picks a healthy slot via rotation; restart fails over off a benched slot automatically.

```json
{
  "swarm": {
    "modelPool": [
      { "model": "glm-5.1", "provider": "zai-coding-cn", "weight": 50 },
      { "model": "gpt-5.4-mini", "provider": "openai", "weight": 30 },
      { "model": "claude-sonnet-4", "provider": "anthropic", "weight": 0 }
    ],
    "rotation": { "strategy": "weighted", "cooldownMs": 900000, "maxRetries": 2 }
  }
}
```

- `weight`: relative share; `0` = fallback-only (used when every weighted slot is benched).
- `strategy`: `weighted` (default) | `round-robin` | `sticky` (per-agent-id deterministic).
- **Auto-swap on provider errors (in-process)**: pi never exits on 429/401/5xx — the turn fails with `stopReason "error"`. The swarm `turn_end` hook classifies the error, benches the exact failing slot (quota/auth immediately; auth ≥6h), and `setModel()`s the session to another healthy slot in-process. Context, mailbox and identity are preserved; the agent retries its work on the new model.
- Health state persists in `.pi/swarm/pool-state.json` (includes the classified error); `maxRetries` consecutive rate_limit/transient failures bench a slot for `cooldownMs`.
- Commands: `/swarm pool list`, `/swarm pool cooldown <provider/model> <ms>`, `/swarm pool clear <provider/model>`.
- Without `modelPool`, the single `defaultModel`/`defaultProvider` behavior is unchanged.

- `swarm_agent_identity`
- `swarm_reload_identity`
- `swarm_set_role`
- `swarm_set_agent_paused`
- `swarm_restart_agent`

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

## Validation entrypoints

Use these when validating behavior, not just reading docs:

```bash
NODE_PATH=$(npm root -g) npx tsc --noEmit --module nodenext --moduleResolution nodenext --skipLibCheck --target es2022 --lib es2022 extensions/swarm/index.ts
bash scripts/swarm_task_uat.sh
bash scripts/swarm_iteration_demo.sh
```

Related review docs:
- [`../swarm-graph-uat-scenario.md`](../swarm-graph-uat-scenario.md)
- [`../swarm-iteration-demo.md`](../swarm-iteration-demo.md)
- [`../swarm-dashboard.md`](../swarm-dashboard.md)

## Documentation entrypoints for operators

- [Architecture overview](./architecture.md)
- [Tooling reference](./tools.md)
- [`../swarm.md`](../swarm.md) for full consolidated reference
