# Swarm architecture overview

This page explains the swarm as a **small file-backed multi-agent system**, not as a flat list of features.

## System model

Swarm turns one pi session into an orchestrated set of cooperating pi agents.

Core properties:
- **No daemon**: there is no background coordinator service.
- **tmux-backed execution**: child agents live in tmux panes/windows.
- **File-backed coordination**: runtime state lives under `.pi/swarm/`.
- **Inspectable by default**: mailboxes, traces, identities, task files, and run records are plain files.
- **Best-effort delivery + repair**: delivery uses mailbox append first, tmux injection when possible, and reconcile to repair visibility/state drift.

## Main runtime pieces

```text
orchestrator pi session
  └─ extensions/swarm/index.ts
       ├─ src/agents.ts      spawn / reuse / stop / restart / role changes
       ├─ src/mailbox.ts     durable mailbox append/read/delivery helpers
       ├─ src/delivery.ts    lifecycle semantics, retryability, parsing
       ├─ src/taskgraph.ts   graph rules, transitions, closure derivation
       ├─ src/reconcile.ts   repair sweeps, stale signals, PM nudges
       ├─ src/metric.ts      runs, memories, iteration sessions
       ├─ src/loop.ts        V1.5 post-close proposal loop state
       ├─ src/tmux.ts        tmux wrappers and pane capture/injection
       ├─ src/state.ts       paths, locks, JSON/JSONL writes, traces
       └─ src/hooks.ts       lifecycle hooks and orchestrator mailbox pump
```

## Runtime layout

```text
.pi/swarm/
  swarm-state.json              shared agent/message state
  swarm-state.lock/             lock directory for atomic updates
  agents/<agent-id>.md          generated effective identity cards
  agents/<agent-id>.override.md optional human-editable identity overrides
  mailboxes/<agent-id>.jsonl    append-only mailbox per recipient
  tasks/<task-id>/              task graph state, events, artifacts
  metrics/<id>.json             metric contracts
  runs/runs.jsonl               append-only run records
  memory/memory.jsonl           append-only memory records
  iterations/<id>.json          iteration sessions
  traces/events.jsonl           structured trace stream
  traces/tmux/*.txt             pane captures and snapshots
```

## Subsystems

### 1. Agent lifecycle
Handles spawn, register/adopt, pause, resume, stop, restart, role changes, and identity reload.

Primary code:
- `src/agents.ts`
- `src/identity.ts`
- `src/session.ts`
- `src/hooks.ts`
- `src/tools/agents*.ts`

### 2. Messaging lifecycle
Handles mailbox append, tmux injection, interception, acknowledgements, retries, dead letters, and idempotency.

Primary code:
- `src/mailbox.ts`
- `src/delivery.ts`
- `src/reconcile.ts`
- `src/tools/messages*.ts`

### 3. Task graph lifecycle
Handles durable tasks, ready/assigned/in-progress/terminal node transitions, branch outcomes, assignment, closure derivation, and runtime warnings.

Primary code:
- `src/taskgraph.ts`
- `src/reconcile.ts`
- `src/tools/tasks*.ts`

### 4. Metrics, memory, and iteration
Handles metric contracts, run evidence, memory proposal/acceptance, and explicit iteration sessions.

Primary code:
- `src/metric.ts`
- `src/tools/metrics*.ts`

### 5. Loop planning (V1.5)
Handles the opt-in post-task-close proposal loop: proposal collection state, next-plan recording, and refresh hooks.

Primary code:
- `src/loop.ts`
- `src/reconcile.ts`
- `src/tools/loop*.ts`

## Source-of-truth rules

These rules should stay stable unless there is an intentional design change.

- **`task.json` is the source of truth for task/node state.** Tool handlers should not invent an alternate task state model.
- **Mailbox files are append-only durable delivery records.** Delivery state is enriched in `swarm-state.json`, not substituted by tmux state.
- **tmux liveness is runtime evidence, not sole truth.** A pane being dead explains delivery issues but does not erase durable state.
- **Reconcile repairs and surfaces drift; it should not invent work.** It may mark derived status drift, retry delivery, or stamp stale signals.
- **The orchestrator is special.** It is mailbox-oriented coordination state, not just another regular pane agent.
- **Identity is generated state plus optional override.** Do not hand-edit generated identity files directly when override flow exists.

## What is enforced vs advisory

### Enforced
- durable task transitions and ownership checks
- assignment state in task files
- ack/response checks for response-required messages
- append-only run/memory records
- swarm-state locking for writes

### Advisory / best-effort
- tmux pane injection
- stale/nudge signals
- runtime health derived from recent events and pane liveness
- file edit lock coordination
- agent refresh after loop planning

## How work flows through the system

### Message path
1. sender appends to recipient mailbox
2. lifecycle record is stored in `swarm-state.json`
3. recipient pane is injected when available
4. recipient hook intercepts the system marker
5. recipient acks progress or completion
6. reconcile may retry or dead-letter failures

### Task path
1. orchestrator creates a task graph
2. ready node is assigned to an agent
3. agent updates node state and artifacts
4. graph derives next ready nodes / closure
5. reconcile and PM notifications surface stalls or closure changes

### Iteration path
1. define a metric contract
2. record runs with evidence
3. optionally promote memory from passing runs
4. bind runs to an iteration session
5. derive best/improvement from the contract

## Change map: where to implement new work

If you are adding…

- **a spawn/register/pause/restart behavior** → `src/agents.ts`, `src/identity.ts`, `src/hooks.ts`, agent tools, docs in `docs/swarm/contributor-guide.md`
- **a new message lifecycle field or state** → `src/types.ts`, `src/delivery.ts`, `src/mailbox.ts`, `src/reconcile.ts`, message tools, `docs/swarm/tools.md`
- **a new task transition or closure rule** → `src/taskgraph.ts`, task tools, `docs/swarm-task-graph.md`, `docs/swarm/contributor-guide.md`
- **a new metric/run/memory behavior** → `src/metric.ts`, metric tools, `docs/swarm-memory.md`
- **new slash command behavior** → `src/command.ts` and the relevant subsystem docs
- **new persistent runtime files** → `src/state.ts` plus docs in `docs/swarm/operations.md` and this page

## Reading strategy

Do not start from the longest document unless you already know the subsystem. Read in this order:
1. this page
2. [Contributor guide](./contributor-guide.md)
3. subsystem-specific docs only for the area you are touching
