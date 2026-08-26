# Swarm architecture overview

This page explains the swarm as a **small file-backed multi-agent system**.

## System model

Swarm turns one pi session into an orchestrated set of cooperating pi agents.

Core properties:
- **No daemon**: there is no background coordinator service.
- **tmux-backed execution**: child agents live in tmux panes/windows.
- **File-backed coordination**: runtime state lives under `.pi/swarm/`.
- **Inspectable by default**: mailboxes, traces, identities, task files, and
  task artifacts are plain files.
- **Best-effort delivery + repair**: delivery uses mailbox append first, tmux
  injection when possible, and reconcile to repair visibility/state drift.

## Main runtime pieces

```text
orchestrator pi session
  └─ extensions/swarm/index.ts
       ├─ src/agents.ts      spawn / reuse / stop / restart / role changes
       ├─ src/mailbox.ts     durable mailbox append/read/delivery helpers
       ├─ src/delivery.ts    lifecycle semantics, retryability, parsing
       ├─ src/taskgraph.ts   graph rules, transitions, closure derivation
       ├─ src/reconcile.ts   repair sweeps, stale signals, PM nudges
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
  traces/events.jsonl           structured trace stream
  traces/tmux/*.txt             pane captures and snapshots
  metrics/                      legacy metric contracts (preserved, unsupported)
  runs/                         legacy run records (preserved, unsupported)
  memory/                       legacy memory records (preserved, unsupported)
  iterations/                   legacy iteration sessions (preserved, unsupported)
  loops/                        legacy loop state (preserved, unsupported)
```

The legacy directories remain on disk for historical review, but the core swarm
extension no longer registers tools or commands for them.

## Subsystems

### 1. Agent lifecycle
Handles spawn, register/adopt, pause, resume, stop, restart, role changes, and
identity reload.

Primary code:
- `src/agents.ts`
- `src/identity.ts`
- `src/hooks.ts`
- `src/tools/agents*.ts`
- `src/pool.ts` (model pool: weighted/round-robin/sticky slot picks, per-slot
  health cooldown with exponential bench backoff, pool-state mutex, restart
  failover, **preflight gate before spawn/restart commits a worker
  assignment**, **non-mutating config discoverability via
  `classifySwarmSettings` / `validateSwarmSettings` / `implicitSingletonPool`**)

### 2. Messaging lifecycle
Handles mailbox append, tmux injection, interception, acknowledgements, retries,
dead letters, and idempotency. A delivery that initially failed tmux injection but is later surfaced/intercepted or ACKed `processing` remains response-tracked until the worker produces a verified result and ACKs `done` with a `resultMessageId`.

Primary code:
- `src/mailbox.ts`
- `src/delivery.ts`
- `src/reconcile.ts`
- `src/tools/messages*.ts`

### 3. Task graph lifecycle
Handles durable tasks, ready/assigned/in-progress/terminal node transitions,
branch outcomes, assignment, closure derivation, shared context, runtime
warnings, and declared rework edges that can re-open a failed/skipped node as `ready` without an orchestrator force-reset. **Cancellation:** the orchestrator-only
`swarm_update_task(force=true, cancelTask=true)` revokes every active attempt,
transitions non-terminal nodes to `cancelled`, supersedes every assignment-class message,
releases agent `activeTaskIds` + advisory edit locks, and sends informational cancellation notices.
Late updates are rejected at the handler boundary (`TASK_CANCELLED`/`NODE_CANCELLED`);
later ACKs on superseded assignment records are rejected (`ASSIGNMENT_SUPERSEDED`). Cancellation
never infers semantic completion and never un-does a node that already finished.

**File-scope ownership (parallel conflict policy):** `swarm_assign_task` runs an atomic
preflight under the swarm lock — the candidate node's effective write scope (node `allowedFiles` ->
`allowedFilesFrom` inheritance -> task default, stamped on the attempt lease) is compared against
every active attempt lease across ALL tasks with a conservative deterministic glob predicate (no
filesystem enumeration). Overlap fails with `ACTIVE_SCOPE_CONFLICT` before any mutation; leases
release auditable (`releasedAt`/`releaseReason`) on terminal/reassign/rework/cancel. Legacy tasks
without ownership metadata stay readable; reconcile reports them as advisory drift.

**Orchestrator leadership and recovery:** the harness is strict-reject, single-leader by default.
`SwarmState.orchestratorLeader` is the durable source of truth for the active orchestrator pid.
A live leader is refreshed via `heartbeatOrchestratorLeader`; a second live pid is rejected with
`ORCHESTRATOR_LEADER_DENIED`. Leader staleness is bounded by `ORCHESTRATOR_LEADER_STALE_MS`
(currently equal to `LOCK_STALE_MS` = 60s), so a pane/process crash can leave a short blind spot
before the next claim replaces the stale leader. During that window, slash-command / tool gates
must still reject unsafe non-orchestrator mutations; the claim/heartbeat path never upgrades a
worker into orchestrator authority.

Primary code:
- `src/taskgraph.ts`
- `src/reconcile.ts`
- `src/tools/tasks*.ts`

### 4. Retention / garbage collection
Handles bounded terminal-message pruning and delivered-ledger capping.

Primary code:
- `src/gc.ts`
- `src/tools/gc*.ts`

## Source-of-truth rules

These rules should stay stable unless there is an intentional design change.

- **`task.json` is the source of truth for task/node state.** Tool handlers
  should not invent an alternate task state model.
- **Task artifacts and `sharedContext` are part of task state.** They live in
  the task graph and are not a replacement for the removed persistent-memory
  subsystem.
- **Mailbox files are append-only durable delivery records.** Delivery state is
  enriched in `swarm-state.json`, not substituted by tmux state.
- **tmux liveness is runtime evidence, not sole truth.** A pane being dead
  explains delivery issues but does not erase durable state.
- **Reconcile repairs and surfaces drift; it should not invent work.** It may
  mark derived status drift, retry delivery, or stamp stale signals.
- **The orchestrator is special.** It is mailbox-oriented coordination state,
  not just another regular pane agent.
- **Identity is generated state plus optional override.** Do not hand-edit
  generated identity files directly when override flow exists.

## What is enforced vs advisory

### Enforced
- durable task transitions and ownership checks
- **file-scope ownership preflight: `swarm_assign_task` rejects overlapping active write scopes with `ACTIVE_SCOPE_CONFLICT` before any mutation**
- **orchestrator-only authority for `force=true` and `cancelTask`** (server-side identity check; a non-orchestrator caller is rejected before any mutation)
- **strict single-orchestrator leadership: `ORCHESTRATOR_LEADER_DENIED` rejects a second live pid on gated tool and command paths**
- assignment state in task files
- ack/response checks for response-required messages
- append-only message/task state
- swarm-state locking for writes
- **slash-command admin guards for `/swarm stop` and `/swarm release`; worker panes are denied before the mutable handler runs**
- **lifecycle-notification fencing: every emit-time site (`agent_settled` response-missing + open-assignment, `session_shutdown`, reconcile graph-advance + initial-ready nudges, `swarm_update_task` closure + cancellation notifies, `swarm_assign_task` defense-in-depth, `/swarm remind`) runs a durable-state predicate (`checkStallNotificationStale` / `checkClosureNotificationStale`) inside its existing `withLock` block; suppressed notifies emit `notification.stale.suppressed` with `site`, `taskId`, `nodeId`, `reason`, and `evidence`**

### Advisory / best-effort
- tmux pane injection
- stale/nudge signals
- runtime health derived from recent events and pane liveness
- **initial-ready recovery nudge** (a freshly created task whose start node stays ready+unassigned past a short grace period is surfaced to the orchestrator; the nudge is idempotent and never auto-assigns/auto-spawns)
- file edit lock coordination

## How work flows through the system

### Message path
1. sender appends to recipient mailbox
2. lifecycle record is stored in `swarm-state.json.messages`
3. recipient pane is injected when available
4. recipient hook intercepts the system marker
5. recipient acks progress or completion
6. reconcile may retry or dead-letter failures
7. a previously failed delivery that is later ACKed `processing` stays visible as an active response-tracked assignment until verified or waived

### Task path
1. orchestrator creates a task graph
2. ready node is assigned to an agent
3. agent updates node state and artifacts
4. graph derives next ready nodes / closure
5. reconcile and PM notifications surface stalls or closure changes
6. a freshly created task with a start node left ready+unassigned past the grace period is nudged to the orchestrator (bounded, idempotent, never auto-assigned)

## Change map: where to implement new work

If you are adding…

- **a spawn/register/pause/restart behavior** → `src/agents.ts`,
  `src/identity.ts`, `src/hooks.ts`, agent tools, docs in
  `docs/swarm/contributor-guide.md`
- **a new message lifecycle field or state** → `src/types.ts`,
  `src/delivery.ts`, `src/mailbox.ts`, `src/reconcile.ts`, message tools,
  `docs/swarm/tools.md`
- **a new task transition or closure rule** → `src/taskgraph.ts`, task tools,
  `docs/swarm-task-graph.md`, `docs/swarm/contributor-guide.md`
- **new slash command behavior** → `src/command.ts` and the relevant subsystem
  docs
- **new persistent runtime files** → `src/state.ts` plus docs in
  `docs/swarm/operations.md` and this page

## Reading strategy

Do not start from the longest document unless you already know the subsystem.
Read in this order:
1. this page
2. [Contributor guide](./contributor-guide.md)
3. subsystem-specific docs only for the area you are touching
