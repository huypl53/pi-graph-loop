---
name: swarm-metric-designer
description: DEPRECATED — The metric/run/memory/iteration/loop subsystem was removed from swarm core.
---

# swarm_metric_designer — DEPRECATED

This skill is **inactive and obsolete**.

The metric-contract, run-record, evidence-memory, iteration-session, and loop
subsystems were removed from the swarm extension core.

## What this means

- `swarm_metric_*`, `swarm_run_*`, `swarm_memory_*`, `swarm_iteration_*`, and
  `swarm_loop_*` tools are no longer registered.
- Task artifacts and `task.json.sharedContext` remain supported.
- Existing `.pi/swarm/metrics/`, `.pi/swarm/runs/`, `.pi/swarm/memory/`,
  `.pi/swarm/iterations/`, and `.pi/swarm/loops/` files are preserved but not
  actively used by the packaged core.

## Current guidance

- Use task artifacts (`tasks/<task-id>/artifacts/`) for durable outputs.
- Use `task.json.sharedContext` for cross-node coordination.
- Use mailbox messaging for inter-agent discussion.
- Use `swarm_reconcile`, task status, and trace files for repair/review.

See `docs/swarm/tools.md` for the current 31-tool core surface.
