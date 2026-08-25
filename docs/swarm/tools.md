# Swarm tooling reference

This is the public reference for the swarm extension's **31 registered `swarm_*`
tools** and `/swarm` command surface. It describes the source-of-truth runtime
behavior in `extensions/swarm/`; it is not a promise that a role instruction in
an identity card is an authorization boundary.

For lifecycle and runtime-file concepts, read [architecture](./architecture.md)
and [operations](./operations.md). For task-graph semantics, read
[`../swarm-task-graph.md`](../swarm-task-graph.md).

> **Note:** task artifacts and `task.json.sharedContext` remain supported and are
durable task-graph state. The removed metric/run/memory/iteration/loop subsystem
was a separate persistence layer and is no longer part of the core surface.

## Tool inventory

| Domain | Count | Registration module |
| --- | ---: | --- |
| Agent lifecycle, observability, and recovery | 17 | `src/tools/agents.ts` |
| Messaging and reconcile | 5 | `src/tools/messages.ts` |
| Task graph | 8 | `src/tools/tasks.ts` |
| Retention / garbage collection | 1 | `src/tools/gc.ts` |
| **Total** | **31** | `extensions/swarm/index.ts` |

## Identity, visibility, and authority

### Tool visibility

A session resolves to one of three identities:

- **Guest**: neither `PI_SWARM_AGENT_ID` nor `PI_SWARM_IS_ORCHESTRATOR` is set.
  All `swarm_*` tools are removed from its active tool set. Built-in tools are
  unaffected.
- **Registered agent**: `PI_SWARM_AGENT_ID=<id>` is set. All 31 swarm tools are
  active.
- **Orchestrator**: `PI_SWARM_IS_ORCHESTRATOR=1` is set, or the agent id is
  explicitly `orchestrator`. All 31 swarm tools are active.

This is identity gating implemented with `pi.setActiveTools` in
`extensions/swarm/src/tools/gating.ts`. The `/swarm` command remains available
for guests so an operator can use `/swarm register here <role>` and re-enable
swarm tools in-process.

### Important authority caveat

Current visibility is **not role-based RBAC**. A planner, implementer, tester,
or reviewer that is a registered agent receives the same swarm tool inventory
as the orchestrator. Identity cards and tool descriptions express intended use,
but most control-plane tools do not yet enforce that intended role at execution
time.

The following checks are enforced today:

- `swarm_ack_message` normally lets only the message recipient acknowledge a
  message; the orchestrator may act on another recipient's message and may
  waive a superseded assignment.
- `swarm_update_task` normally requires the current agent to own the assigned
  node.
- Guest sessions do not receive swarm tools through normal model tool
  visibility.

> **Review note:** `swarm_update_task(force=true)` currently treats `force` as
> an orchestrator override. Consequently, a registered non-orchestrator can
> bypass normal node ownership and transition checks by supplying `force: true`.
> Treat `force`, lifecycle tools, assignment, reconciliation, and GC as
> human/orchestrator operations until server-side RBAC is added.

### Destructive or high-impact operations

Run these from the orchestrator after inspecting state first:

- process/pane control: `swarm_spawn_agent`, `swarm_register_agent`,
  `swarm_stop_agent`, `swarm_restart_agent`, `swarm_set_role`,
  `swarm_send_keys`;
- global state mutation: `swarm_assign_task`, `swarm_update_task(force=true)`,
  `swarm_reconcile(mark=true)`, `swarm_prune`, `swarm_gc(dryRun=false)`;
- destructive task cancellation: `swarm_update_task(cancelTask=true, force=true)`.

Prefer the non-mutating inspection tool before every one of these operations.

## `/swarm` commands

Use slash commands for short human-driven operations. Use tools when an agent
needs structured parameters or machine-readable results.

### Setup and inspection

- `/swarm init`
- `/swarm status`
- `/swarm list`
- `/swarm panes`
- `/swarm trace`
- `/swarm capture <id>`
- `/swarm graph <task-id> [text|mermaid|json]`
- `/swarm flow <task-id> [--events N]` — read-only task graph, agent lanes, and
  recent events; opens an interactive Flow dialog in TUI mode.

### Lifecycle commands

- `/swarm spawn <id> [role]`
- `/swarm register <here|tmux-target> <id> [role…] [flags]`
- `/swarm stop <id> [--force] [--no-kill]`
- `/swarm restart <id>`
- `/swarm role <id> <role…> [--kind K] [--caps a,b]`
- `/swarm pause <id>` / `/swarm resume <id>`
- `/swarm sendkey <id> <keys…> [--literal] [--enter]`
- `/swarm attach <id>`
- `/swarm release <id> [<task-id>] [--force]`
- `/swarm mailbox reset <id|here> --yes` — emergency repair; archives the live
  mailbox, clears the mailbox JSONL and its delivered ledger, but preserves
  message records in `swarm-state.json`.
- `/swarm send <to> <message>`
- `/swarm pool list` — slot health + rotation status
- `/swarm pool show` — full config view (pool OR implicit singleton fallback); never edits `.pi/settings.json`
- `/swarm pool validate` — structural check (empty model, duplicates, bad weight, bad rotation); read-only
- `/swarm pool help` — canonical pool format reference
- `/swarm pool preview-preflight [model] [provider]` — dry-run the spawn gate; reports classified errors before commit
- `/swarm pool cooldown <provider/model> <ms>` / `/swarm pool clear <provider/model>` — manual bench control

### Grouped aliases

The aliases below use the same command handlers; they do not create another
state or authorization path.

- `/swarm-agents list|status|spawn|register|panes|stop|restart|role|pause|resume|sendkey|attach|release|identity ...`
- `/swarm-tasks list|graph|status|next|validate ...`
- `/swarm-msg send <to> <message>`

## Agent lifecycle, observability, and recovery (17)

| Tool | What it does | Key inputs / operating notes |
| --- | --- | --- |
| `swarm_agent_status` | Reports lifecycle, tmux liveness, health, active work, and mailbox counters. | Optional `agentId`. First call when diagnosing a worker. |
| `swarm_list_agents` | Lists persisted agent records, targets, models, roles, and mailboxes. | Read-only. Verify an id before sending or changing it. |
| `swarm_spawn_agent` | Starts a fresh pi worker in a swarm tmux window. | `role` required; optional `id`, `roleKind`, model/provider, initial prompt. Uses configured model pool/defaults. |
| `swarm_register_agent` | Adopts or retargets an existing tmux pane. | `tmuxTarget` and `role` required. Cannot register the reserved `orchestrator` id through this tool. |
| `swarm_stop_agent` | Marks an agent stopped and normally kills its pane/window. | Refuses active work unless `force=true`; use `killPane=false` to keep the pane. |
| `swarm_restart_agent` | Stops then respawns at the same stable id. | Preserves mailbox and identity history; may release active task pointers. |
| `swarm_set_role` | Changes role, role kind, and capabilities; regenerates identity. | At least one of role, role kind, or capabilities is required. |
| `swarm_set_agent_paused` | Drains an agent from reuse without killing it. | `paused=true` prevents assignment selection; `false` resumes. |
| `swarm_send_keys` | Sends raw tmux keys to a registered pane. | Escape hatch for interrupt/dismiss/type. Use `literal` and `enter` deliberately. |
| `swarm_attach_agent` | Returns tmux attach/select commands for a pane. | Read-only convenience output. |
| `swarm_release_agent_task` | Removes stale `activeTaskIds` pointers. | Only terminal/missing task pointers are released unless `force=true`; does not change task nodes. |
| `swarm_agent_identity` | Reads or regenerates an effective agent identity card. | Optional `agentId`, `refresh`; generated card plus optional override. |
| `swarm_reload_identity` | Rebuilds identity and asks a live pane to reread it. | Optional note; injection is best effort when pane is alive. |
| `swarm_trace` | Reads structured swarm trace events. | Optional `limit`; inspect delivery/spawn failures. |
| `swarm_capture_agent_pane` | Captures pane history to `.pi/swarm/traces/tmux/`. | `agentId` required; use for runtime evidence/debugging. |
| `swarm_dead_letters` | Lists terminal delivery failures. | Optional recipient/message filters and limit. |
| `swarm_prune` | Marks dead panes stopped and can remove old stopped records. | Administrative cleanup. Defaults to `dryRun=true`; run dry first. Does not delete mailboxes/traces. |

## Messaging and reconcile (5)

| Tool | What it does | Key inputs / operating notes |
| --- | --- | --- |
| `swarm_send_message` | Appends a durable message and attempts tmux injection. | `to`, `body`; use `requiresResponse=true` for result-bearing work and `idempotencyKey` for retries. |
| `swarm_check_mailbox` | Reads a mailbox, defaulting to the caller's identity. | Optional `pendingOnly`, `markDelivered`, `limit`. Do not poll another agent's mailbox as a substitute for a handoff. |
| `swarm_ack_message` | Records `seen`, `processing`, `done`, or `failed`. | A `requiresResponse` message needs a validated result message before `done`. ACK is lifecycle state, not the work result. |
| `swarm_message_status` | Shows delivery/ACK/response lifecycle records. | Filter by message, recipient, or lifecycle status. |
| `swarm_reconcile` | Repairs delivery visibility and surfaces/stamps task drift or staleness. | Scope by `agentId` for mailbox-only sweep. Prefer `dryRun=true`; `mark=true` persists derived task-status repairs. It never auto-fails a node. |

### Message completion protocol

For an assignment or any message requiring a response:

1. recipient calls `swarm_ack_message(..., status="seen"|"processing")`;
2. recipient performs work and sends a result with `swarm_send_message` using
   `replyTo=<original-message-id>`, or uses `swarm_task_message`;
3. recipient calls `swarm_ack_message(..., status="done",
   resultMessageId=<result-message-id>)`.

If the original delivery had already failed tmux injection, a later `processing`
ACK still moves the message into the response-tracked recovery path; it is not
considered resolved until `done` includes a verified result message. This
preserves a durable response link and prevents a completed ACK from being
mistaken for an actual work result.

## Task graph tools (8)

`task.json` is the source of truth. Use graph tools for workflow state; use
mail tools for discussion without advancing a graph.

| Tool | What it does | Key inputs / operating notes |
| --- | --- | --- |
| `swarm_create_task` | Creates a durable graph, task markdown, event stream, and artifact directory. | `title`, `goal`; supports feature-dev defaults or custom `nodes`, `edges`, gates, allowed files, validation commands, and shared context. |
| `swarm_task_status` | Summarizes task/node/gate state. | Set `includeArtifacts=true` and/or `runtime=true` for evidence and liveness warnings. |
| `swarm_validate_graph` | Validates graph structure and optionally runtime consistency. | Supply `taskId` or direct task file path; `runtime=true` checks agents/messages. |
| `swarm_print_graph` | Prints text, Mermaid, or JSON graph view. | Select `format=text|mermaid|json`. Read-only. |
| `swarm_next_nodes` | Computes ready/current nodes and suggests reusable agents. | Read-only; `autoAssign` is reserved and does not mutate. |
| `swarm_assign_task` | Assigns a ready node, updates assignment bookkeeping, and delivers an assignment message. | `taskId`, `nodeId`; optional exact agent, `autoSpawn`, isolated spawn, and reply target. Orchestrator operation. |
| `swarm_update_task` | Updates an assigned node, outcome, evidence artifact, gates, or shared context. | Normal path requires the assigned agent and legal lifecycle transition. `done` with outgoing edges requires a matching `outcome`. `force=true` and `cancelTask` are **orchestrator-only** (server-side identity check; a non-orchestrator caller is rejected with `FORCE_FORBIDDEN` / `CANCEL_FORBIDDEN` before any mutation). |
| `swarm_task_message` | Sends a task-scoped handoff/discussion and records it. | `taskId`, `fromNode`, `to`, `body`; optional target node and artifact refs. It does **not** advance a node. |

### Normal graph execution

1. Orchestrator creates a task with `swarm_create_task`.
2. Inspect `swarm_next_nodes` and assign a ready node with `swarm_assign_task`.
3. Assignee acknowledges the delivery, performs the work, and calls
   `swarm_update_task` for its own node.
4. Orchestrator inspects `swarm_next_nodes` again and assigns the newly-ready
   work.
5. Use `swarm_task_status(runtime=true)`, `swarm_validate_graph`, then
   `swarm_reconcile(dryRun=true)` if execution stalls.

Read [`../swarm-task-graph.md`](../swarm-task-graph.md) for branch outcomes,
gates, closure, and rework semantics.

## Retention / garbage collection (1)

| Tool | What it does | Key inputs / operating notes |
| --- | --- | --- |
| `swarm_gc` | Prunes only terminal messages beyond a retained recent window and caps delivered ledgers. | Defaults to `dryRun=true`; use `keepMessages` to retain the newest messages. It never drops queued, injected, failed, or ACK-incomplete messages. |

`swarm_gc` is bounded maintenance, not an incident-repair tool. Use
`swarm_reconcile` first when delivery or task state is actionable.

## Recommended operating paths

### A worker received an assignment

1. `swarm_check_mailbox(pendingOnly=true)`.
2. `swarm_ack_message(status="processing")`.
3. Read assignment task/artifacts and work only within the node's declared
   boundaries.
4. Send a result message or task handoff.
5. `swarm_update_task` only for the caller's assigned node.
6. `swarm_ack_message(status="done", resultMessageId=...)`.

### Delivery is missing or a pane looks stuck

1. `swarm_message_status` and `swarm_agent_status`.
2. `swarm_capture_agent_pane` and inspect trace events.
3. `swarm_reconcile(dryRun=true)`.
4. Apply repair only after understanding the reported action; use
   `swarm_reconcile(mark=true)` for status drift or lifecycle tools for a
   confirmed dead pane.

### A task is stalled

1. `swarm_task_status(taskId, runtime=true)`.
2. `swarm_validate_graph(taskId, runtime=true)`.
3. `swarm_next_nodes(taskId)`.
4. `swarm_reconcile(dryRun=true)`.
5. Use `swarm_release_agent_task` only after reconcile confirms stale task
   pointers; reassign from the orchestrator.
