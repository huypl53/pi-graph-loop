# Swarm memory policy

> **LEGACY — This feature was removed from swarm core.**
>
> The metric/run/memory/iteration/loop subsystem is no longer supported by the
> packaged extension. This document is kept for historical reference only.

Use task artifacts, `task.json.sharedContext`, mailbox messages, and trace files
for durable coordination instead.

## Current guidance

- **Task artifacts** live under `tasks/<task-id>/artifacts/`.
- **Shared context** lives under `task.json.sharedContext` and is durable task
  state, not persistent memory.
- **Mailbox messages** are for agent-to-agent coordination, not memory.
- **Trace files** provide reviewable history for orchestration and debugging.

The old memory tools, run records, metric contracts, iteration sessions, and
loop planning files may still exist on disk in `.pi/swarm/` for historical
inspection, but they are no longer registered or documented as core behavior.
