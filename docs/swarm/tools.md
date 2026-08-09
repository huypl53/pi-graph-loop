# Swarm tooling reference

This page groups the public swarm surface by purpose. It is intentionally shorter than the full legacy reference.

For full parameter-by-parameter details, see [`../swarm.md`](../swarm.md).

## `/swarm` commands

### Setup and visibility
- `/swarm init`
- `/swarm status`
- `/swarm list`
- `/swarm panes`
- `/swarm trace`
- `/swarm capture <id>`
- `/swarm graph <task-id> [text|mermaid|json]`

### Agent lifecycle
- `/swarm spawn <id> [role]`
- `/swarm register <here|tmux-target> <id> [role…] [flags]`
- `/swarm stop <id> [--force] [--no-kill]`
- `/swarm restart <id>`
- `/swarm role <id> <role…> [--kind K] [--caps a,b]`
- `/swarm pause <id>` / `/swarm resume <id>`
- `/swarm sendkey <id> <keys…> [--literal] [--enter]`
- `/swarm attach <id>`
- `/swarm release <id> [<task-id>] [--force]`

### Loop planning
- `/swarm loop status <task-id>`
- `/swarm loop plan <task-id> <summary…>`

## Tool groups

### Agent lifecycle tools
Use for spawn/adopt/restart/role control.

- `swarm_spawn_agent`
- `swarm_register_agent`
- `swarm_list_agents`
- `swarm_agent_status`
- `swarm_stop_agent`
- `swarm_restart_agent`
- `swarm_set_role`
- `swarm_set_agent_paused`
- `swarm_send_keys`
- `swarm_attach_agent`
- `swarm_release_agent_task`
- `swarm_agent_identity`
- `swarm_reload_identity`

### Messaging and delivery tools
Use for mailbox coordination, ack tracking, and repair.

- `swarm_send_message`
- `swarm_check_mailbox`
- `swarm_ack_message`
- `swarm_message_status`
- `swarm_reconcile`
- `swarm_dead_letters`
- `swarm_trace`
- `swarm_capture_agent_pane`
- `swarm_prune` (admin cleanup)

### Task graph tools
Use for durable graph execution and handoff.

- `swarm_create_task`
- `swarm_task_status`
- `swarm_validate_graph`
- `swarm_print_graph`
- `swarm_next_nodes`
- `swarm_assign_task`
- `swarm_update_task`
- `swarm_task_message`

Detailed semantics live in [`../swarm-task-graph.md`](../swarm-task-graph.md).

### Metric / memory / iteration tools
Use for evidence-backed optimization workflows.

- `swarm_metric_define`
- `swarm_metric_get`
- `swarm_run_record`
- `swarm_run_get`
- `swarm_run_compare`
- `swarm_memory_propose`
- `swarm_memory_search`
- `swarm_memory_accept`
- `swarm_iteration_create`
- `swarm_iteration_record`
- `swarm_iteration_status`
- `swarm_iteration_context`

Detailed semantics live in [`../swarm-memory.md`](../swarm-memory.md) and [`../swarm-new-project-setup.md`](../swarm-new-project-setup.md).

### Loop tools
Use for the opt-in V1.5 post-close proposal loop.

- `swarm_loop_status`
- `swarm_loop_plan`

Detailed semantics live in [`../swarm-task-graph.md`](../swarm-task-graph.md#task-graph-iteration-proposal-loop-v15).

## Which surface to use

- Use `/swarm ...` for quick human-driven TUI operations.
- Use tools for structured automation and richer parameters.
- Use task tools for durable workflow state.
- Use message tools for discussion/handoff without advancing graph state.
- Use reconcile before manual repair.
