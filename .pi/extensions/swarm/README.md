# Swarm extension

Project-local pi extension for spawning and coordinating tmux-backed pi agents.

Main file:

```text
.pi/extensions/swarm/index.ts
```

Full documentation:

```text
docs/swarm.md
```

Quick start:

```bash
pi --model glm-5.1 --provider zai-coding-cn -e .pi/extensions/swarm/index.ts
```

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
- `swarm_reconcile`
- `swarm_prune`
- `swarm_dead_letters`
- `swarm_trace`
- `swarm_capture_agent_pane`
- `swarm_agent_identity`

Runtime state is written under `.pi/swarm/` and ignored by git.
