# Nudge reset and suppression rules

## Task-graph stall

A task-stall counter resets when an actionable node is assigned or claimed, or
when its task becomes terminal. It is independent from the goal counter. The
first qualifying stall may emit immediately; later task-stall reminders wait
for the configured continuous all-idle interval. At the cap, the task enters a
bounded back-off window.

An unacknowledged graph-advance nudge for the same ready/unassigned node wins:
the task-stall evaluator skips that node so root does not receive two competing
assignment reminders.

## Swarm goal floor

The goal floor exists only when `state.goal` exists. It considers live worker
records, `runtimeStatus`, and `activeTaskIds`; it intentionally does **not**
read task graph state. It samples an all-idle, non-vacuous pool once per check
interval, emits after the required consecutive samples, and resets the sample
streak whenever the pool is busy, empty, or has an assignment in flight.

A successful root assistant `turn_end` with `stopReason: "stop"` resets the
goal's no-resolve counter. Clearing or replacing the goal also removes its
current reminder state.
