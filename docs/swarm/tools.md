
## Surface / pump — src/surface.ts

The root-facing message surface machinery lives in
`extensions/swarm/src/surface.ts`. It owns:

- `orchSession` — per-process session gate + retrigger counter source-of-truth
- `runtimeTaskWarnings` — task.json closure/warning extractor
- `isActionableRootMessage` — predicate gating root-visible PM surfacing
- `staleSurfaceReason` — actionable→stale edge reasoning (fingerprint + reason code)
- `pumpRootMailbox` — **the per-tick surface pump (R10-1 boundary)** — the
  one place where the root's mailbox is consulted, deduplicated against the
  per-pid surfaced set + durable consumerReceipts, and (if idle) flushed to the
  real `pi.sendMessage` boundary
- `traceStaleSuppressedOnce` — dedupe helper for the stale→suppressed transition

This module is the seam between the swarm state (mailbox + tasks) and the
Pi-runtime engine boundary. Everything that crosses the "visible surface" goes
through `pumpRootMailbox`; the R10-1 counting assertion in
`idle-nudge.test.mjs` measures calls at that boundary, not at internal helpers.


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
| Agent lifecycle, observability, and recovery | 19 | `src/tools/agents.ts` |
| Messaging and reconcile | 5 | `src/tools/messages.ts` |
| Task graph | 8 | `src/tools/tasks.ts` |
| Retention / garbage collection | 1 | `src/tools/gc.ts` |
| **Total** | **33** | `extensions/swarm/index.ts` |

## Configuration

### Config sources and precedence

The swarm model pool reads three config sources with strict precedence:

1. `.pi/settings.json` → `extensions.swarm` block (highest — runtime parity with pi core)
2. `.pi/settings.json` → top-level `swarm` block
3. `.pi/swarm.yml` → top-level keys, no `swarm:` wrapper (the filename is the namespace)

`.pi/swarm.yml` is the comment-friendly home: pi core parses `settings.json` with bare
`JSON.parse` (comments would make pi silently drop the whole project block), so swarm owns
this dedicated YAML file. Comments are allowed anywhere in it.

```yaml
# .pi/swarm.yml
modelPool:
  - model: glm-5.1            # pi model id (required)
    provider: zai-coding-cn   # provider id (recommended)
    weight: 10                # optional; 0 = fallback-only
    roles: [implementer]      # optional role-kind allow-list
    quotaResetMs: 2h          # optional quota-bench floor: duration ("30m", "2h", "1h30m", "1d") or ms
  - model: gpt-5.4-mini
    provider: openai
rotation:
  strategy: weighted         # weighted | round-robin | sticky
  cooldownMs: 900000
  maxRetries: 2
# defaultModel: glm-5.1      # implicit-singleton fallback config
# defaultProvider: zai-coding-cn
```

When settings.json declares a swarm block AND `.pi/swarm.yml` carries recognized config,
`/swarm pool validate` emits a **warning** (never an error): the JSON wins and the yml
contents are ignored. An **empty** (0-byte / comments-only) swarm.yml also warns
(`swarm_yml_empty`) — the file exists but declares nothing, so the JSON config keeps winning.
Corrupt YAML is reported as `swarm_yml_unreadable` (`ok:false`);
all readers degrade to defaults exactly like corrupt JSON does today.

`/swarm pool validate` (and the root's launch-time pool-health check) also runs **live
resolvability checks** per slot when the model registry is available in the session:
`slot_unresolvable` for a provider/model pair not in the registry, and `slot_no_credential`
for a provider without a stored API key. The root session surfaces a warning at launch when
the pool config has errors (or an advisory when warnings exist), traced as `pool.launch_health`.

### Model pool auto-scaffold on first root session (Issue 20)

When the root (`PI_SWARM_IS_ROOT=1`) starts a session and NO source declares
`modelPool`, the extension writes a **comments-only teaching template into
`.pi/swarm.yml`** — the full config surface (modelPool slots with every optional
field, rotation policy, defaultModel/defaultProvider) documented as commented
examples; the file parses to `null` (declares nothing) until the user fills it
in. settings.json is not created. If settings.json already has a `swarm` /
`extensions.swarm` block without `modelPool`, the JSON placeholder merges into
that block instead (unchanged behavior). An **empty** swarm.yml (0 bytes /
comments-only) is treated as not-yet-declared: the scaffold (re)writes the
idempotent template bytes into it when no other source declares a pool; the
durable `poolScaffoldNotifiedAt` flag keeps the notify one-shot.

A one-shot TUI notify fires ONLY when (a) the scaffold actually wrote AND
(b) the durable flag `SwarmState.poolScaffoldNotifiedAt` is absent. After the
notify, the flag is stamped inside the same `withLock` block that creates
the root session record, so subsequent session_starts (and `/reload`
invocations) suppress the notify until the entire `.pi/swarm` directory is
cleared (clean-slate re-notify). The notify text is:

> Created swarm.modelPool placeholder in .pi/settings.json — fill in your
> model/provider. See docs/swarm/tools.md.

See [operations.md § Model pool auto-scaffold](./operations.md#model-pool-auto-scaffold-on-first-root-session-issue-20)
for the durable-flag contract, skip paths, and trace event reference.

## Identity, visibility, and authority

### Tool visibility

A session resolves to one of three identities:

- **Guest**: neither `PI_SWARM_AGENT_ID` nor `PI_SWARM_IS_ROOT` is set.
  All `swarm_*` tools are removed from its active tool set. Built-in tools are
  unaffected.
- **Registered agent**: `PI_SWARM_AGENT_ID=<id>` is set. All 31 swarm tools are
  active.
- **Root**: `PI_SWARM_IS_ROOT=1` is set, or the agent id is
  explicitly `root`. All 31 swarm tools are active.

**Issue 25 Phase 2 profile gating (gate=1 only):** under
`PI_SWARM_MINIMAL_PROTOCOL=1`, identity gating is further narrowed by role
profile allowlists — a worker's active set is exactly 5 tools and the
root's is 12 distinct tool names (13 capabilities). All 31 tools stay
*registered*; only the active set is filtered, and execution-time authority
(`ROOT_AUTHORITY_REQUIRED`) remains the real gate. Gate=0 (default)
keeps the full 31-tool active set for registered agents.

This is identity gating implemented with `pi.setActiveTools` in
`extensions/swarm/src/tools/gating.ts`. The `/swarm` command remains available
for guests so an operator can use `/swarm register here <role>` and re-enable
swarm tools in-process.

### Important authority caveat

Visibility is identity-based (see above) but several destructive tools also enforce
server-side authority at execution time. As of Issue 10 the destructive subset
(`swarm_prune`, `swarm_gc`, `swarm_assign_task`, `swarm_update_task(force=true)`,
`swarm_update_task(cancelTask=true)`, `swarm_stop_agent`, `swarm_release_agent_task`)
rejects non-root callers with `ROOT_AUTHORITY_REQUIRED` (or the
specialized `FORCE_FORBIDDEN`/`CANCEL_FORBIDDEN` for the `force`/`cancelTask` paths
on `swarm_update_task`) before any state mutation. Other swarm tools remain open to
any registered agent and use the description / `promptGuidelines` as the contract.

The following identity checks are also enforced today:

- `swarm_ack_message` normally lets only the message recipient acknowledge a
  message; the root may act on another recipient's message and may
  waive a superseded assignment.
- `swarm_update_task` normally requires the current agent to own the assigned
  node.
- Guest sessions do not receive swarm tools through normal model tool
  visibility.

### Destructive or high-impact operations

Run these from the root after inspecting state first:

- process/pane control: `swarm_spawn_agent`, `swarm_register_agent`,
  `swarm_stop_agent`, `swarm_restart_agent`, `swarm_set_role`,
  `swarm_send_keys`;
- global state mutation: `swarm_assign_task`, `swarm_update_task(force=true)`,
  `swarm_reconcile(mark=true)`, `swarm_prune`, `swarm_gc(dryRun=false)`;
- destructive task cancellation: `swarm_update_task(cancelTask=true, force=true)`.

Both `swarm_prune` and `swarm_gc` are root-only after Issue 10 (server-side
`requireRootAuthority`); other listed tools are operator-led by description
but not currently hard-gated. Prefer the non-mutating inspection tool before every
one of these operations.

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
- `/swarm metrics` — root-only, read-only proxy metric snapshot (hung-but-alive,
  stale-open, supersession-churn); surfaces `SwarmState.proxyMetrics` without mutating state.

### Lifecycle commands

- `/swarm spawn <id> [role]`
- `/swarm register <here|tmux-target> <id> [role…] [flags]`
- `/swarm deregister <here|id> [--force] [--purge]` — self-service exit from a role.
  `here` (or your own agent id) de-registers THIS pane's session: the agent record is
  marked stopped, the pane is kept alive, the in-process identity is un-adopted (env
  cleared, footer reset, guest tool gating re-applied — the swarm tool surface disappears
  on the next prompt). Deregistering ANOTHER agent id is root-only. The root (PM) role
  itself cannot be de-registered (it is pane-lifetime state, not an adoptable record).
  Refuses active tasks unless `--force` (delegated to the same guard as `/swarm stop`).
  `--purge` additionally removes the agent record + delivered ledger from
  `swarm-state.json` (mailbox/identity files stay on disk; a still-live purged pane's
  next `session_start` would resurrect its record as "externally started" — prefer
  plain deregister + `/swarm stop` for remote panes, or use `--purge` only after the
  pane is dead). Traces `agent.deregister`.
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
- `/swarm attention [<#|task-id>]` — root-only, read-only durable recovery attention report
  (task graph + assignment attempts + mailbox state; never tmux/pane state). Advisory only.
- `/swarm remind <task-id> <node-id>` — root-only; the ONLY sending surface for the bounded
  worker reminder. One per attempt, permanently; requires durable receipt ack (`seen`/`processing`),
  the `REMINDER_NO_PROGRESS_MS` (60 min) no-progress interval, and the current active attempt.
  `requiresAck:false`/`requiresResponse:false` — no ack/response debt; never mutates node state.
  The reminder is threaded back to the original assignment (`replyTo=<original assignment message id>`)
  and preserves the assignment `conversationId`, so a reply sent from the reminder thread still
  credits the original record.
- `/swarm pool list` — slot health + rotation status
- `/swarm pool show` — full config view (pool OR implicit singleton fallback); never edits `.pi/settings.json`
- `/swarm protocol migrate [--dry-run]` — operator path for upgrading durable v1 message
  envelopes to v2 evidence fields (Issue 25 Phase 1). Back-fills `mailboxDeliveredAt` from
  existing `delivered[to]` entries; never invents seen/responded/processing/terminal facts.
  Idempotent (re-run yields `migrated: 0`); emits `protocol.migration.completed` summary.
  See `docs/swarm/operations.md` "Operator protocol-migration" for full semantics.
- `/swarm pool validate` — structural check (empty model, duplicates, bad weight, bad rotation); read-only
- `/swarm pool help` — canonical pool format reference
- `/swarm pool preview-preflight [model] [provider]` — dry-run the spawn gate; reports classified errors before commit
- `/swarm pool cooldown <provider/model> <ms>` / `/swarm pool clear <provider/model>` — manual bench control
- `/swarm pool rotate now` — root-only; force-swap the current slot to a healthy alternative via `pi.setModel()`. Bypasses the Issue 17 engine-retry gate, the gate's streak count, AND any `modelPool[i].roles` filter (operator escape hatch); traces `pool.swap_forced_by_manual_override` with `rolesIgnored: true` and `agentRoleKind`. Bumps the swap-chain counter (`MAX_SWAP_CHAIN=2`). Refuses (with a warning notify) if every alternative is benched or the picked slot has no resolvable model registry entry. No new public tool — slash command only.
- `/swarm pool rotate next` — root-only; bench the current slot for `rotation.cooldownMs` so the next normal `pickSlot()` skips it. Does NOT call `setModel()` — the agent keeps its current model for this turn and the next `turn_end` advances organically. Traces `pool.bench_forced_by_manual_override`. Does NOT bump the swap-chain counter (no swap happened) and does NOT call `recordProviderError` (operator bench is a deliberate decision, not a provider error). Reuses `setSlotCooldown` with the operator-configured `rotation.cooldownMs`; idempotent over re-cooldown (extends the window). No new public tool — slash command only.
- `/swarm goal set <text>` — root-only; durably records the swarm's current goal (`st.goal`); while set, the root pump emits an idempotent idle-streak nudge whenever every non-root agent is `runtimeStatus: "idle"` with zero assigned/in-progress task nodes.
- `/swarm goal done [<goalId>]` — root-only; clears the swarm goal and stops the idle-streak nudge loop entirely. Optional `<goalId>` argument is a safety fence (the call fails if it does not match the current goal).

### Grouped aliases

The aliases below use the same command handlers; they do not create another
state or authorization path.

- `/swarm-agents list|status|spawn|register|panes|stop|restart|role|pause|resume|sendkey|attach|release|mailbox|identity ...`
- `/swarm-tasks list|graph|status|next|validate ...`
- `/swarm-msg send <to> <message>`

## Agent lifecycle, observability, and recovery (19)

| Tool | What it does | Key inputs / operating notes |
| --- | --- | --- |
| `swarm_agent_status` | Reports lifecycle, tmux liveness, health, active work, and mailbox counters. | Optional `agentId`. First call when diagnosing a worker. |
| `swarm_list_agents` | Lists persisted agent records, targets, models, roles, and mailboxes. | Read-only. Verify an id before sending or changing it. |
| `swarm_spawn_agent` | Starts a fresh pi worker in a swarm tmux window. | `role` required; optional `id`, `roleKind`, model/provider, initial prompt. Uses configured model pool/defaults. When the pool has `modelPool[i].roles` set, the spawned agent's roleKind filters eligible slots; if no slot matches, a warning trace (`pool.role_filter_all_filtered_fallback`) is emitted and the worker still starts on the next available slot. |
| `swarm_register_agent` | Adopts or retargets an existing tmux pane. | `tmuxTarget` and `role` required. Cannot register the reserved `root` id through this tool. |
| `swarm_stop_agent` | Marks an agent stopped and normally kills its pane/window. | Refuses active work unless `force=true`; use `killPane=false` to keep the pane. |
| `swarm_restart_agent` | Stops then respawns at the same stable id. | Preserves mailbox and identity history; may release active task pointers. Default kills the pane; pass `killPane=false` to keep it alive (the agent record still flips to `running`). The freshly started pi reuses the same id, mailbox, and identity. |
| `swarm_set_role` | Changes role, role kind, and capabilities; regenerates identity. | At least one of role, role kind, or capabilities is required. |
| `swarm_set_agent_paused` | Drains an agent from reuse without killing it. | `paused=true` prevents assignment selection; `false` resumes. |
| `swarm_send_keys` | Sends raw tmux keys to a registered pane. | Escape hatch for interrupt/dismiss/type. Use `literal` and `enter` deliberately. The tool refuses to send keys if the resolved tmux target equals the root record's `tmuxTarget` (typically `"unknown"`), throwing `ROOT_PANE_REJECTED`. This is a principle-based guard: it fires on target equality, not on `agentId`, so it stays correct if any agent's record is ever mis-stamped to the root's target. |
| `swarm_attach_agent` | Returns tmux attach/select commands for a pane. | Read-only convenience output. |
| `swarm_release_agent_task` | Removes stale `activeTaskIds` pointers. | Only terminal/missing task pointers are released unless `force=true`; does not change task nodes. |
| `swarm_agent_identity` | Reads or regenerates an effective agent identity card. | Optional `agentId`, `refresh`; generated card plus optional override. |
| `swarm_reload_identity` | Rebuilds identity and asks a live pane to reread it. | Optional note; injection is best effort when pane is alive. |
| `swarm_trace` | Reads structured swarm trace events. | Optional `limit`; inspect delivery/spawn failures. |
| `swarm_capture_agent_pane` | Captures pane history to `.pi/swarm/traces/tmux/`. | `agentId` required; use for runtime evidence/debugging. |
| `swarm_dead_letters` | Lists terminal delivery failures. | Optional recipient/message filters and limit. |
| `swarm_prune` | Marks dead panes stopped and can remove old stopped records. | **Root-only** (server-side `requireRootAuthority`); defaults to `dryRun=true`; run dry first. Does not delete mailboxes/traces. The Issue 82 heartbeat GC (`agentHeartbeatGCLocked`) now flips dead-pane running records to `stopped` automatically inside `pumpRootMailbox`; `swarm_prune` remains the root escape hatch for already-stopped records. |
| `swarm_set_goal` | Persists a swarm-level goal to `swarm-state.json.goal`. | **Root-only** (server-side `requireRootAuthority`). `text` required, `id` optional. Replaces any current goal and resets `consecutiveNoResolveNudges` + clears back-off. While set, the root pump emits an idempotent idle-streak nudge when every non-root agent is `runtimeStatus: "idle"` with zero assigned/in_progress task nodes. Pair with `swarm_mark_goal_done` when finished. |
| `swarm_mark_goal_done` | Clears the swarm goal and stops the idle nudge loop entirely. | **Root-only** (server-side `requireRootAuthority`). Optional `goalId` is a safety fence (clear fails if it does not match the current goal). Idempotent: a clear with no active goal is a `noop`. |

## Messaging and reconcile (6)

| Tool | What it does | Key inputs / operating notes |
| --- | --- | --- |
| `swarm_send_message` | Appends a durable message and attempts tmux injection. | `to`, `body`; use `requiresResponse=true` for result-bearing work and `idempotencyKey` for retries. **Issue 24.b:** when `conversationId` matches `task:{taskId}:{nodeId}` and `subject` starts with `"Task "` and includes `" assigned"`, `deliverMessageLocked` auto-stamps `node.assignee = msg.to` if the node is registered and the recipient is the assigned agent (or `node.assignee` differs). The auto-stamp runs INSIDE the swarm lock and MUST NOT be re-wrapped in `withLock` — `withLock` is mkdir-based and non-re-entrant (nested acquisition hangs ~120s then throws). The residual `writeTaskState` failure race self-heals via the Issue 24.a claim branch on the recipient's first `swarm_update_task` call. |
| `swarm_check_mailbox` | Reads a mailbox, defaulting to the caller's identity. | Optional `pendingOnly`, `markDelivered`, `limit`. Do not poll another agent's mailbox as a substitute for a handoff. |
| `swarm_ack_message` | Records `seen`, `processing`, `done`, or `failed`. | A `requiresResponse` message needs a validated result message before `done`. ACK is lifecycle state, not the work result. |
| `swarm_message_status` | Shows delivery/ACK/response lifecycle records. | Filter by message, recipient, or lifecycle status. |
| `swarm_reconcile` | Repairs delivery visibility and surfaces/stamps task drift or staleness. | Scope by `agentId` for mailbox-only sweep. Prefer `dryRun=true`; `mark=true` persists derived task-status repairs. It never auto-fails a node. |
| `swarm_audit` | Reads append-only trace history, reconstructs message timelines, probes anomalies, checks invariants, and can rotate trace archives. | Filters: `--event`, `--since`, `--until`, `--agent`, `--task`, `--cid`; modes: `events`, `timeline`, `probes`, `invariants`, `rotate`, `all`. JSON shape: `{ schema: "swarm-audit/v1", mode, generatedAt, durationMs, filters, source, counts, events?, timeline?, probes?, invariants?, rollup? }`. Use `--json` when you want the machine-readable payload, or omit it for the same JSON text in the terminal. |

### Message completion protocol

For an assignment or any message requiring a response:

1. recipient calls `swarm_ack_message(..., status="seen"|"processing")`;
2. recipient performs work and sends a result with `swarm_send_message` using
   `replyTo=<original-message-id>` and the original assignment `conversationId`, or uses
   `swarm_task_message`;
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
| `swarm_create_task` | Creates a durable graph, task markdown, event stream, artifact directory, and qualification-gate artifact. | `title`, `goal`; supports feature-dev defaults or custom `nodes`, `edges`, gates, allowed files, validation commands, shared context, and `qualificationMode: auto\|human-discuss` (defaults to `auto`). |
| `swarm_confirm_qualification` | Records root's human-discuss confirmation and unlocks implementation assignment. | Root-only; requires a concise note of the user-confirmed outcome/trade-off. |
| `swarm_task_status` | Summarizes task/node/gate state. | Set `includeArtifacts=true` and/or `runtime=true` for evidence and liveness warnings. |
| `swarm_validate_graph` | Validates graph structure and optionally runtime consistency. | Supply `taskId` or direct task file path; `runtime=true` checks agents/messages. |
| `swarm_print_graph` | Prints text, Mermaid, or JSON graph view. | Select `format=text|mermaid|json`. Read-only. |
| `swarm_next_nodes` | Computes ready/current nodes and suggests reusable agents. | Read-only; `autoAssign` is reserved and does not mutate. |
| `swarm_assign_task` | Assigns a ready node, updates assignment bookkeeping, and delivers an assignment message. | `taskId`, `nodeId`; optional exact agent, `autoSpawn`, isolated spawn, reply target, and `lease: { kind: "reuse"\|"park", until?, reason? }` (Issue 82: stamp a reuse/park lease on the assignee at assignment time so the task-close sweep honors it). Root operation. Runs the file-scope ownership preflight: an overlapping active write scope across any task fails atomically with `ACTIVE_SCOPE_CONFLICT` (no state mutated). |
| `swarm_update_task` | Updates an assigned node, outcome, evidence artifact, gates, or shared context. | Normal path requires the assigned agent and legal lifecycle transition. `done` with outgoing edges requires a matching `outcome`. `force=true` and `cancelTask` are **root-only** (server-side identity check; a non-root caller is rejected with `FORCE_FORBIDDEN` / `CANCEL_FORBIDDEN` before any mutation). `cancelTask=true` (with force) cancels the whole task: revokes every active attempt, transitions non-terminal nodes to `cancelled`, supersedes every assignment message, and releases agent `activeTaskIds` + advisory edit locks. A cancelled task rejects all later updates with `TASK_CANCELLED` (or `NODE_CANCELLED`) even from the root — re-open is a separately-designed policy. After cancellation, later ACKs on superseded assignment records are rejected with `ASSIGNMENT_SUPERSEDED`. **Issue 24.a:** non-terminal unassigned nodes may be **CLAIMED** by the caller via `mintNodeAttempt` (assignee becomes the caller, status moves to `assigned`, an attempt fence is minted); the claimer's `activeTaskIds` is updated. **In-flight unassigned nodes** (`in_progress`+`null`) are refused with the inline-string `OWNERSHIP_REQUIRED` error code — escalate to the root (`force=true`) or close the in-flight node. Remediation hints are present on every reject listed in the §24.c coverage table (full 21-site audit deferred to follow-up `task-graph-reject-hints-coverage-audit`). |
| `swarm_task_message` | Sends a task-scoped handoff/discussion and records it. | `taskId`, `fromNode`, `to`, `body`; optional target node and artifact refs. It does **not** advance a node. |

### Normal graph execution

1. Root creates a task with `swarm_create_task`, which writes `artifacts/qualification-gate.md`.
2. Choose `qualificationMode=auto` for a clear request (root drafts and reviewer/auditor challenges once) or `human-discuss` for user-owned decisions. In `human-discuss`, root records the user decision with `swarm_confirm_qualification` before source-changing implementation is assignable.
3. Inspect `swarm_next_nodes` and assign a ready node with `swarm_assign_task`.
4. Assignee acknowledges the delivery, performs the work, and calls
   `swarm_update_task` for its own node.
5. Root inspects `swarm_next_nodes` again and assigns the newly-ready
   work.
5. Use `swarm_task_status(runtime=true)`, `swarm_validate_graph`, then
   `swarm_reconcile(dryRun=true)` if execution stalls.

Read [`../swarm-task-graph.md`](../swarm-task-graph.md) for branch outcomes,
gates, closure, and rework semantics.

## Retention / garbage collection (1)

| Tool | What it does | Key inputs / operating notes |
| --- | --- | --- |
| `swarm_gc` | Prunes only terminal messages beyond a retained recent window and caps delivered ledgers. | **Root-only** after Issue 10. Defaults to `dryRun=true`; use `keepMessages` to retain the newest messages. It never drops queued, injected, failed, or ACK-incomplete messages. |

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
   pointers; reassign from the root.
