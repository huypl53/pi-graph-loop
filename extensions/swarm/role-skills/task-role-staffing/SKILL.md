---
name: task-role-staffing
description: Staff a swarm task with role-specific agents after task creation. Use when root needs to spawn planner/reviewer/tester/implementer/worker agents for a task and assign them to ready nodes. Composes only the existing swarm_spawn_agent and swarm_assign_task tools; no new tool surface.
---

# Task Role Staffing

Use this skill **after `swarm_create_task` returns** and before the first
`swarm_assign_task` call, when root wants to staff the task with
role-specific agents. The skill is a packaged reference doc — it does not
add a new tool, schema field, or workflow step. It composes the existing
`swarm_spawn_agent` and `swarm_assign_task` tools.

## When to Use

- Root has just created a task (or is about to assign its first ready node)
  and wants to staff it with role-specific agents.
- The task graph declares role kinds (planner / reviewer / tester /
  implementer / worker) and root wants one agent per role.
- Root wants a planning aid for which roles to spawn and which ready nodes
  to assign them to.

## Procedure

1. (Optional) Write `.pi/swarm/tasks/<task-id>/roles.yml` listing the role
   kinds you want (planner / reviewer / tester / implementer / worker) and
   any per-role `initialPrompt` notes. The file is documentation-only; the
   engine does not read it.
2. For each role, call `swarm_spawn_agent({ id, role, roleKind, initialPrompt? })`.
   Do NOT pass `model` or `provider` — they inherit from `.pi/swarm.yaml`.
3. Call `swarm_assign_task({ taskId, nodeId, agentId })` (or omit `agentId`
   to let the reuse pool pick) for each ready node.

## Pitfalls

- Do not invent a new tool (`swarm_staff_task`, `swarm_role_*`, etc.) — the
  skill composes existing tools only.
- Do not bypass `swarm_assign_task`'s file-scope preflight — overlapping
  write scopes across tasks fail atomically with `ACTIVE_SCOPE_CONFLICT`.
- Do not pass `model` / `provider` to `swarm_spawn_agent` — they inherit
  from `.pi/swarm.yaml`; explicit overrides break the pool rotation.
- `roles.yml` is a planning aid, not engine input — the engine never reads
  it; do not rely on it for runtime behavior.
- Do not assign a node before the corresponding agent is spawned (or
  available in the reuse pool) — `swarm_assign_task` will fail with
  `NO_AVAILABLE_AGENT`.

## Verification

After staffing, `swarm_task_status(taskId, runtime=true)` shows the expected
agents with `activeTaskIds` containing the task id, and the assigned nodes
are `assigned` (not `ready`).
