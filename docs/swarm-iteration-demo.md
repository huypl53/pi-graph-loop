# Swarm Iteration Loop Demo (Legacy)

> **LEGACY — This feature was removed from swarm core.**
>
> The metric/run/memory/iteration/loop subsystem is no longer supported by the
> packaged extension. This document is kept for historical reference only.

The historical demo described a file-backed metric contract → runs → memory →
iteration-context flow. That workflow is preserved here only as documentation of
what used to exist.

## Current recommendation

For durable coordination in the current swarm core:
- use task artifacts under `tasks/<task-id>/artifacts/`;
- use `task.json.sharedContext` for cross-node coordination;
- use mailbox messages for agent-to-agent discussion;
- use `swarm_reconcile` and task-graph tooling for state repair and review.
