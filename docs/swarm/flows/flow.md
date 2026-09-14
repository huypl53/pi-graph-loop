# Swarm runtime flows

> **Purpose.** Show the live message / task / pump / reconcile paths through
> swarm with **clickable, payload-backed edges**. Five diagrams cover the core
> message, task, root-pump, reconcile, and recovery-nudge paths. The page is the entry point
> for review sessions; open it in the local interactive workbench and click
> any node or edge to inspect the actual `SwarmMessage` envelope,
> `MessageRecord` snapshot, `task.json` excerpt, scope-conflict error, pump-tick
> surfaced set, busy-suppression trace, or reconcile result.

> **Tool-count baseline (35).** Verified against `extensions/swarm/src/tools/`:
> agents 19, messages 5, tasks 9, gc 1, audit 1. See `tools.md` for the inventory.

## Conventions

- **`R10-1 boundary`** — the real `pi.sendMessage`/`ctx.abort` boundary where
  swarm crosses from durable mailbox state into the visible surface. The
  per-tick surfaced set deduplicates at this boundary, not at internal helpers.
- **`R15 P0`** — the busy-suppression truth: while the root is mid-turn the
  pump drops a message from the surface plan. No time-bound surface is
  promised for any worker result arriving mid-turn.
- **`withLock`** — every state mutation that the diagrams show happens inside
  the swarm lock; the diagrams do not picture nested locks.
- **Node IDs in the Mermaid source are bare identifiers** (e.g. `sender`,
  `mailbox_jsonl`, `recipient_pane`); the human label is in brackets after
  the id. Interactions map edges by `from`, `to`, and the **visible label
  between the pipes** — labels are whitespace-normalized.

---

## Message lifecycle

```mermaid
flowchart TB
  sender[Sender pi session]
  send_tool[swarm_send_message]
  durable[(Mailbox JSONL +<br/>MessageRecord)]
  delivery[buildSystemDelivery +<br/>tmux send-keys]
  recipient[Recipient pane +<br/>input hook intercept]
  ack[swarm_ack_message<br/>within withLock]
  verified[ACK + response<br/>verified]
  reconcile[swarm_reconcile]
  dead_letter[dead_letter + trace]

  sender -->|intent: ship test| send_tool
  send_tool -->|envelope + idempotency| durable
  durable -->|b64 line| delivery
  delivery -->|SYSTEM_START..END| recipient
  recipient -->|status=intercepted| durable
  recipient -->|seen/processing/done/failed| ack
  ack -->|lastAck stamped| verified
  reconcile -->|no lastAck + pane pi-like| delivery
  reconcile -->|attempts >= ENGINE_MAX_RETRIES| dead_letter
```
```mermaid-interactions
{
  "items": [
    {
      "id": "envelope-send",
      "title": "SwarmMessage envelope",
      "target": {
        "kind": "edge",
        "from": "sender",
        "to": "send_tool",
        "label": "intent: ship test"
      },
      "content": {
        "type": "json",
        "path": "payloads/envelope-swarm-message.json"
      }
    },
    {
      "id": "envelope-durable",
      "title": "Durable append + idempotency",
      "target": {
        "kind": "edge",
        "from": "send_tool",
        "to": "durable",
        "label": "envelope + idempotency"
      },
      "content": {
        "type": "json",
        "path": "payloads/envelope-swarm-message.json"
      }
    },
    {
      "id": "build-system-delivery",
      "title": "buildSystemDelivery on-wire base64",
      "target": {
        "kind": "edge",
        "from": "durable",
        "to": "delivery",
        "label": "b64 line"
      },
      "content": {
        "type": "text",
        "path": "payloads/envelope-on-wire.txt"
      }
    },
    {
      "id": "system-marker-on-wire",
      "title": "SYSTEM_START .. SYSTEM_END delivered to recipient",
      "target": {
        "kind": "edge",
        "from": "delivery",
        "to": "recipient",
        "label": "SYSTEM_START..END"
      },
      "content": {
        "type": "text",
        "path": "payloads/envelope-on-wire.txt"
      }
    },
    {
      "id": "intercepted-status",
      "title": "Input hook stamps intercepted durable state",
      "target": {
        "kind": "edge",
        "from": "recipient",
        "to": "durable",
        "label": "status=intercepted"
      },
      "content": {
        "type": "json",
        "path": "payloads/lifecycle-record.json"
      }
    },
    {
      "id": "ack-tool-call",
      "title": "Recipient ACK lifecycle call",
      "target": {
        "kind": "edge",
        "from": "recipient",
        "to": "ack",
        "label": "seen/processing/done/failed"
      },
      "content": {
        "type": "markdown",
        "path": "payloads/ack-tool-result.md"
      }
    },
    {
      "id": "ack-stamp",
      "title": "lastAck durable record",
      "target": {
        "kind": "edge",
        "from": "ack",
        "to": "verified",
        "label": "lastAck stamped"
      },
      "content": {
        "type": "json",
        "path": "payloads/lifecycle-record.json"
      }
    },
    {
      "id": "reconcile-reinject",
      "title": "Retry only unacknowledged delivery failures",
      "target": {
        "kind": "edge",
        "from": "reconcile",
        "to": "delivery",
        "label": "no lastAck + pane pi-like"
      },
      "content": {
        "type": "markdown",
        "path": "payloads/ack-tool-result.md"
      }
    },
    {
      "id": "dead-letter",
      "title": "Retry budget exhausted",
      "target": {
        "kind": "edge",
        "from": "reconcile",
        "to": "dead_letter",
        "label": "attempts >= ENGINE_MAX_RETRIES"
      },
      "content": {
        "type": "json",
        "path": "payloads/dead-letter-trace.json"
      }
    }
  ]
}
```

---

## Task graph lifecycle

```mermaid
flowchart TB
  root[Root pi session]
  create[swarm_create_task +<br/>qualification-gate.md]
  qualify[Qualification gate<br/>auto or human-discuss]
  assign[swarm_assign_task +<br/>scope preflight]
  scope{ACTIVE_SCOPE_CONFLICT?}
  worker[Assigned worker +<br/>attempt scope lease]
  update[swarm_update_task +<br/>artifact]
  closure[computeTaskStatus +<br/>PM auto-notify]
  cancel[force=true +<br/>cancelTask=true]
  cancelled[Attempts revoked +<br/>assignments superseded]

  root -->|intent + title| create
  create -->|qualify node open| qualify
  qualify -->|ready| assign
  assign -->|effective scope| scope
  scope -->|overlap detected| assign
  scope -->|no overlap| worker
  worker -->|in_progress artifact| update
  update -->|node status changes| closure
  root -->|cancelTask=true| cancel
  cancel -->|revoke attempts| cancelled
```
```mermaid-interactions
{
  "items": [
    {
      "id": "create-task",
      "title": "Create task + qualification artifact",
      "target": {
        "kind": "edge",
        "from": "root",
        "to": "create",
        "label": "intent + title"
      },
      "content": {
        "type": "markdown",
        "path": "payloads/qualification-gate.md"
      }
    },
    {
      "id": "qualify-open",
      "title": "Qualification gate opened",
      "target": {
        "kind": "edge",
        "from": "create",
        "to": "qualify",
        "label": "qualify node open"
      },
      "content": {
        "type": "markdown",
        "path": "payloads/qualification-gate.md"
      }
    },
    {
      "id": "qualify-ready",
      "title": "Qualified implementation may be assigned",
      "target": {
        "kind": "edge",
        "from": "qualify",
        "to": "assign",
        "label": "ready"
      },
      "content": {
        "type": "json",
        "path": "payloads/task-graph.json"
      }
    },
    {
      "id": "scope-preflight-eval",
      "title": "Effective scope evaluation",
      "target": {
        "kind": "edge",
        "from": "assign",
        "to": "scope",
        "label": "effective scope"
      },
      "content": {
        "type": "json",
        "path": "payloads/task-graph.json"
      }
    },
    {
      "id": "scope-conflict",
      "title": "Atomic ACTIVE_SCOPE_CONFLICT rejection",
      "target": {
        "kind": "edge",
        "from": "scope",
        "to": "assign",
        "label": "overlap detected"
      },
      "content": {
        "type": "json",
        "path": "payloads/scope-conflict.json"
      }
    },
    {
      "id": "scope-clear",
      "title": "No overlap: worker gets stamped attempt lease",
      "target": {
        "kind": "edge",
        "from": "scope",
        "to": "worker",
        "label": "no overlap"
      },
      "content": {
        "type": "json",
        "path": "payloads/task-graph.json"
      }
    },
    {
      "id": "assignment-update",
      "title": "Worker progress and artifact update",
      "target": {
        "kind": "edge",
        "from": "worker",
        "to": "update",
        "label": "in_progress artifact"
      },
      "content": {
        "type": "json",
        "path": "payloads/task-graph.json"
      }
    },
    {
      "id": "closure-derived",
      "title": "Closure derives from terminal node state",
      "target": {
        "kind": "edge",
        "from": "update",
        "to": "closure",
        "label": "node status changes"
      },
      "content": {
        "type": "json",
        "path": "payloads/task-graph.json"
      }
    },
    {
      "id": "cancel-task",
      "title": "Root-only cancellation",
      "target": {
        "kind": "edge",
        "from": "root",
        "to": "cancel",
        "label": "cancelTask=true"
      },
      "content": {
        "type": "markdown",
        "path": "payloads/qualification-gate.md"
      }
    },
    {
      "id": "cancel-revoke",
      "title": "Cancellation revokes attempts",
      "target": {
        "kind": "edge",
        "from": "cancel",
        "to": "cancelled",
        "label": "revoke attempts"
      },
      "content": {
        "type": "json",
        "path": "payloads/task-graph.json"
      }
    }
  ]
}
```

---

## Root PM pump

```mermaid
flowchart TB
  durable[(Root mailbox +<br/>task.json + MessageRecord)]
  pump[pumpRootMailbox +<br/>per-tick surfaced set]
  actionable{Actionable and<br/>root idle?}
  pi_send[pi.sendMessage<br/>R10-1 boundary]
  llm_turn[Root LLM turn]
  tool_calls[swarm_send_message +<br/>swarm_update_task + ack]
  busy_drop[Busy: durable only,<br/>no bounded surface promise]
  settled[agent_settled<br/>retrigger]

  durable -->|new durable row| pump
  pump -->|evaluate| actionable
  actionable -->|yes + root idle| pi_send
  actionable -->|root busy| busy_drop
  pi_send -->|visible surface| llm_turn
  llm_turn -->|tool invocations| tool_calls
  tool_calls -->|next durable row| durable
  pi_send -.->|agent_settled retrigger| settled
  settled -.->|retrigger pump| pump
```
```mermaid-interactions
{
  "items": [
    {
      "id": "durable-to-pump",
      "title": "Durable state is the pump input",
      "target": {
        "kind": "edge",
        "from": "durable",
        "to": "pump",
        "label": "new durable row"
      },
      "content": {
        "type": "json",
        "path": "payloads/pump-tick.json"
      }
    },
    {
      "id": "pump-actionable",
      "title": "Actionable/root-idle evaluation",
      "target": {
        "kind": "edge",
        "from": "pump",
        "to": "actionable",
        "label": "evaluate"
      },
      "content": {
        "type": "json",
        "path": "payloads/pump-tick.json"
      }
    },
    {
      "id": "root-idle",
      "title": "Actionable and idle -> queue acceptance",
      "target": {
        "kind": "edge",
        "from": "actionable",
        "to": "pi_send",
        "label": "yes + root idle"
      },
      "content": {
        "type": "json",
        "path": "payloads/pump-tick.json"
      }
    },
    {
      "id": "root-busy",
      "title": "Busy root: no bounded visible surface promise",
      "target": {
        "kind": "edge",
        "from": "actionable",
        "to": "busy_drop",
        "label": "root busy"
      },
      "content": {
        "type": "json",
        "path": "payloads/busy-suppression-trace.json"
      }
    },
    {
      "id": "surface-r10-boundary",
      "title": "R10-1 pi.sendMessage boundary",
      "target": {
        "kind": "edge",
        "from": "pi_send",
        "to": "llm_turn",
        "label": "visible surface"
      },
      "content": {
        "type": "json",
        "path": "payloads/pump-tick.json"
      }
    },
    {
      "id": "llm-tool-calls",
      "title": "Root acts through swarm tools",
      "target": {
        "kind": "edge",
        "from": "llm_turn",
        "to": "tool_calls",
        "label": "tool invocations"
      },
      "content": {
        "type": "markdown",
        "path": "payloads/ack-tool-result.md"
      }
    },
    {
      "id": "tool-loopback",
      "title": "Tool call creates the next durable state",
      "target": {
        "kind": "edge",
        "from": "tool_calls",
        "to": "durable",
        "label": "next durable row"
      },
      "content": {
        "type": "json",
        "path": "payloads/envelope-swarm-message.json"
      }
    },
    {
      "id": "agent-settled",
      "title": "agent_settled signal",
      "target": {
        "kind": "edge",
        "from": "pi_send",
        "to": "settled",
        "label": "agent_settled retrigger"
      },
      "content": {
        "type": "json",
        "path": "payloads/pump-tick.json"
      }
    },
    {
      "id": "pump-retrigger",
      "title": "Settled signal triggers next pump pass",
      "target": {
        "kind": "edge",
        "from": "settled",
        "to": "pump",
        "label": "retrigger pump"
      },
      "content": {
        "type": "json",
        "path": "payloads/pump-tick.json"
      }
    }
  ]
}
```

---

## Reconcile & GC

```mermaid
flowchart LR
  runner[swarm_reconcile<br/>reconcile-core.ts runner]
  dryrun[dryRun=true preview]
  mark[mark=true repair]
  offset[nextOffset action cursor]
  mailbox_sweep[mailbox retryable-failure sweep]
  task_sweep[task derive + advisory staleAt]
  deadline_sweep[response deadline sweep]
  gc_nudge[graph-advance / stall / artifact / heartbeat GC nudges]
  stale_check{checkStallNotificationStale<br/>checkClosureNotificationStale}
  root_notify[PM auto-notify<br/>via pump]
  suppress[notification.stale.suppressed]
  audit[swarm_audit<br/>trace rotation summary]
  prune[swarm_prune<br/>root-only retention]

  caller[Caller: root or worker scope=self] -->|dryRun?| runner
  caller -->|mark=true?| runner
  caller -->|offset| runner
  runner -->|read-only preview| dryrun
  runner -->|stamp staleAt only| mark
  runner -->|nextOffset return| offset
  runner -->|isDeliveryFailureRetryable| mailbox_sweep
  runner -->|derive closure| task_sweep
  runner -->|responseDeadlineMs elapsed| deadline_sweep
  task_sweep -->|stall / advance / artifact| gc_nudge
  gc_nudge -->|durable-state predicate| stale_check
  stale_check -->|fresh| root_notify
  stale_check -->|stale| suppress
  root_notify -->|via pumpRootMailbox| root_notify
  runner -->|summary trace| audit
  audit -->|rotation recommendation| prune
```
```mermaid-interactions
{
  "items": [
    {
      "id": "caller-dryrun",
      "title": "Caller path: dryRun",
      "target": { "kind": "edge", "from": "caller", "to": "runner", "label": "dryRun?" },
      "content": { "type": "markdown", "path": "payloads/ack-tool-result.md" }
    },
    {
      "id": "caller-mark",
      "title": "Caller path: mark=true (root-only)",
      "target": { "kind": "edge", "from": "caller", "to": "runner", "label": "mark=true?" },
      "content": { "type": "json", "path": "payloads/reconcile-result.json" }
    },
    {
      "id": "caller-offset",
      "title": "Caller path: offset cursor",
      "target": { "kind": "edge", "from": "caller", "to": "runner", "label": "offset" },
      "content": { "type": "json", "path": "payloads/reconcile-result.json" }
    },
    {
      "id": "dryrun-preview",
      "title": "dryRun preview (no mutation)",
      "target": { "kind": "edge", "from": "runner", "to": "dryrun", "label": "read-only preview" },
      "content": { "type": "json", "path": "payloads/reconcile-result.json" }
    },
    {
      "id": "mark-stamp",
      "title": "mark=true: stamp staleAt advisory",
      "target": { "kind": "edge", "from": "runner", "to": "mark", "label": "stamp staleAt only" },
      "content": { "type": "json", "path": "payloads/reconcile-result.json" }
    },
    {
      "id": "offset-return",
      "title": "nextOffset action cursor",
      "target": { "kind": "edge", "from": "runner", "to": "offset", "label": "nextOffset return" },
      "content": { "type": "json", "path": "payloads/reconcile-result.json" }
    },
    {
      "id": "mailbox-retry",
      "title": "Mailbox retryable-failure sweep",
      "target": { "kind": "edge", "from": "runner", "to": "mailbox_sweep", "label": "isDeliveryFailureRetryable" },
      "content": { "type": "json", "path": "payloads/reconcile-result.json" }
    },
    {
      "id": "task-derive",
      "title": "Task derive + advisory staleAt",
      "target": { "kind": "edge", "from": "runner", "to": "task_sweep", "label": "derive closure" },
      "content": { "type": "json", "path": "payloads/reconcile-result.json" }
    },
    {
      "id": "deadline-sweep",
      "title": "Response deadline sweep",
      "target": { "kind": "edge", "from": "runner", "to": "deadline_sweep", "label": "responseDeadlineMs elapsed" },
      "content": { "type": "json", "path": "payloads/reconcile-result.json" }
    },
    {
      "id": "nudge-trigger",
      "title": "Graph-advance / stall / artifact nudges",
      "target": { "kind": "edge", "from": "task_sweep", "to": "gc_nudge", "label": "stall / advance / artifact" },
      "content": { "type": "json", "path": "payloads/reconcile-result.json" }
    },
    {
      "id": "stale-predicate",
      "title": "Durable-state predicate gate",
      "target": { "kind": "edge", "from": "gc_nudge", "to": "stale_check", "label": "durable-state predicate" },
      "content": { "type": "json", "path": "payloads/pump-tick.json" }
    },
    {
      "id": "notify-fresh",
      "title": "Fresh -> PM auto-notify via pump",
      "target": { "kind": "edge", "from": "stale_check", "to": "root_notify", "label": "fresh" },
      "content": { "type": "json", "path": "payloads/settled-open-assign-trace.json" }
    },
    {
      "id": "notify-stale",
      "title": "Stale -> notification.stale.suppressed",
      "target": { "kind": "edge", "from": "stale_check", "to": "suppress", "label": "stale" },
      "content": { "type": "json", "path": "payloads/pump-tick.json" }
    },
    {
      "id": "audit-summary",
      "title": "Trace rotation summary",
      "target": { "kind": "edge", "from": "runner", "to": "audit", "label": "summary trace" },
      "content": { "type": "json", "path": "payloads/reconcile-result.json" }
    },
    {
      "id": "prune-followup",
      "title": "Rotation recommendation -> prune",
      "target": { "kind": "edge", "from": "audit", "to": "prune", "label": "rotation recommendation" },
      "content": { "type": "markdown", "path": "payloads/ack-tool-result.md" }
    }
  ]
}
```

---

## Task-graph stall nudge & swarm goal floor

Both nudge families run from the root pump under the swarm lock, but they
answer different questions and keep separate counters. The **task-stall** path
is goal-independent and reads eligible task graphs. The **goal floor** requires
a durable goal and is intentionally task-state-independent: it samples the
live worker pool only. A task-stall message is suppressed when an unacknowledged
graph-advance nudge already covers the same ready, unassigned node.

```mermaid
flowchart TB
  pump[pumpRootMailbox tick<br/>inside withLock]
  task_eval[evaluateTaskGraphStallNudgeLocked]
  task_gate{eligible task with ready<br/>unassigned node after grace?}
  advance_gate{graph-advance nudge<br/>already unacked?}
  task_emit[durable root message<br/>task graph-stall seq]
  task_wait[interval pending or<br/>bounded back-off]
  task_resolve[assign / claim node<br/>or task terminal]
  goal_eval[evaluateIdleGoalNudgeLocked]
  goal_gate{goal exists and effective<br/>worker pool is non-vacuous + idle?}
  goal_wait[hold: busy, assignment<br/>in flight, or no live workers]
  idle_checks[one idle sample each 10s<br/>3 consecutive samples by default]
  goal_emit[durable root message<br/>goal idle-streak seq]
  goal_backoff[3 emits then bounded<br/>check-round back-off]
  goal_resolve[root assistant turn_end stop<br/>or goal cleared/replaced]

  pump -->|scan task graph| task_eval
  task_eval -->|candidate snapshot| task_gate
  task_gate -->|no| task_wait
  task_gate -->|yes| advance_gate
  advance_gate -->|yes: suppress duplicate| task_wait
  advance_gate -->|no: emit seq nudge| task_emit
  task_emit -->|next interval / cap| task_wait
  task_emit -->|graph mutation resets counter| task_resolve

  pump -->|evaluate durable goal| goal_eval
  goal_eval -->|effective-worker predicate| goal_gate
  goal_gate -->|no| goal_wait
  goal_gate -->|yes| idle_checks
  idle_checks -->|streak incomplete| goal_wait
  idle_checks -->|required streak reached| goal_emit
  goal_emit -->|counter reaches 3| goal_backoff
  goal_emit -->|root answers and settles| goal_resolve
  goal_backoff -->|fresh completed streak| goal_emit
```
```mermaid-interactions
{
  "items": [
    {
      "id": "nudge-pump-overview",
      "title": "Pump decision snapshot",
      "target": { "kind": "node", "id": "pump" },
      "content": { "type": "json", "path": "payloads/nudge-predicate-snapshot.json" }
    },
    {
      "id": "task-candidate",
      "title": "Task-stall predicate snapshot",
      "target": { "kind": "edge", "from": "task_eval", "to": "task_gate", "label": "candidate snapshot" },
      "content": { "type": "json", "path": "payloads/nudge-predicate-snapshot.json" }
    },
    {
      "id": "task-emit",
      "title": "Per-task stall nudge record",
      "target": { "kind": "edge", "from": "advance_gate", "to": "task_emit", "label": "no: emit seq nudge" },
      "content": { "type": "json", "path": "payloads/task-stall-nudge.json" }
    },
    {
      "id": "task-resolve",
      "title": "Task-stall reset and graph-advance suppression",
      "target": { "kind": "edge", "from": "task_emit", "to": "task_resolve", "label": "graph mutation resets counter" },
      "content": { "type": "markdown", "path": "payloads/nudge-resolution.md" }
    },
    {
      "id": "goal-predicate",
      "title": "Goal-floor live-worker predicate",
      "target": { "kind": "edge", "from": "goal_eval", "to": "goal_gate", "label": "effective-worker predicate" },
      "content": { "type": "json", "path": "payloads/nudge-predicate-snapshot.json" }
    },
    {
      "id": "goal-emit",
      "title": "Goal idle-check streak and nudge",
      "target": { "kind": "edge", "from": "idle_checks", "to": "goal_emit", "label": "required streak reached" },
      "content": { "type": "json", "path": "payloads/goal-idle-nudge.json" }
    },
    {
      "id": "goal-resolve",
      "title": "Goal-floor reset and suppression rules",
      "target": { "kind": "edge", "from": "goal_emit", "to": "goal_resolve", "label": "root answers and settles" },
      "content": { "type": "markdown", "path": "payloads/nudge-resolution.md" }
    }
  ]
}
```
