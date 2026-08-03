# Swarm Task Graph Review Notes

Two glm-5.1 swarm agents reviewed `docs/swarm-task-graph.md` in tmux session `pi-swarm-pi-graph-agents-152d8e`.

Review agents:

- `task-design-reviewer-223543`: architecture/data-model review.
- `task-design-implementability-223543`: implementation/MVP/testability review.

Both agents were instructed not to edit files.

> **Status (historical notes).** These notes capture the design review that shaped `docs/swarm-task-graph.md`. The task graph has since been **implemented** (see [`docs/swarm.md`](./swarm.md)). In particular, finding #8 and the "Delivery limitation observed" below are **resolved**: `orchestrator` is now a routable mailbox-only pseudo-agent, so child agents can call `swarm_send_message(to="orchestrator")` and task assignments take an explicit `replyTarget`. Read the limitations below as design-driving evidence, not as current behavior.

## Shared verdict

The proposed hybrid model is sound:

```text
Markdown for LLM/human meaning.
JSON for mutable task state.
YAML later for reusable workflow templates.
JSONL for append-only events.
```

The design is implementable, but reviewers identified several decisions that should be resolved before coding task tools.

## Required revisions incorporated

The main design doc was updated to address these review points:

1. **V1 should not depend on YAML parsing.**
   - `swarm_create_task` should synthesize a built-in `feature-dev` graph or accept an explicit JSON `nodes` override.
   - YAML workflow files can land later with an explicit parser dependency.

2. **Use the existing global swarm lock for V1 task mutations.**
   - Avoid cross-lock deadlocks between task writes and message sends.
   - Generalize to per-task locks only after contention justifies it.

3. **Use atomic temp-file + rename writes for hot JSON files.**
   - New `task.json` writes should be atomic.
   - This should also be back-ported to `swarm-state.json`.

4. **Declare source of truth.**
   - `node.status` is lifecycle only.
   - `gates.*.status` is the authoritative commit/release blocker.

5. **Add dependency/failure semantics.**
   - Dependencies are AND-join.
   - Failed nodes block dependents.
   - Blocked review should reopen implementation or create a follow-up implementation node.

6. **Make assignee explicit.**
   - `swarm_assign_task` should take `agentId`; it should not infer from role alone.

7. **Mark file locks advisory/cooperative for V1.**
   - Core pi edit/write tools do not yet enforce swarm task locks.
   - Enforcement comes from protocol and review gates unless a future hook is added.

8. **Handle orchestrator routing explicitly.**
   - Current swarm does not register `orchestrator` as a recipient agent.
   - Review agents could not `swarm_send_message` to `orchestrator` because the extension rejects unknown recipients.
   - V1 task flow should either create a pseudo-agent mailbox for `orchestrator` or use a real coordinator agent id as `replyTarget`.

9. **Strengthen UAT.**
   - Add deterministic tool-level UAT before LLM-heavy integration UAT.
   - Add failure-path assertions.
   - Make “minimal prompting” measurable.

## Delivery limitation observed

Both reviewers discovered a real swarm limitation: child agents cannot currently send a result message to `orchestrator` unless `orchestrator` exists in `swarm-state.json.agents`.

Observed behavior from `task-design-implementability-223543`:

```text
swarm_send_message failed with Unknown swarm agent: orchestrator
```

This is valuable evidence for the task graph design: task assignment must include an explicit `replyTarget`, or the extension must create a routable orchestrator pseudo-agent.

**Resolved.** The extension now lazily creates/refreshes an `orchestrator` pseudo-agent (also on the orchestrator's own `session_start`). Delivery to it is mailbox-only and surfaced by an auto-pump (`pumpOrchestratorMailbox`) plus `swarm_check_mailbox` / `swarm_agent_status`; it is not treated as a tmux-injection failure. See [`docs/swarm.md`](./swarm.md) ("Task graph and closure") and [`docs/swarm-task-graph.md`](./swarm-task-graph.md) ("Orchestrator-directed replies").
