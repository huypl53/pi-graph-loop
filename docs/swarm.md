# Pi Swarm Extension

`pi-swarm` is a project-local pi extension that turns a single pi session into a tmux-backed group of cooperating pi agents. It is intentionally simple and inspectable: there is no daemon or mini server. Coordination uses tmux panes, JSON state, JSONL mailboxes, and structured trace files under the project `.pi/swarm/` runtime directory.

## Architecture

```text
orchestrator pi session
  └─ extensions/swarm/index.ts
       ├─ spawns child pi sessions in tmux windows
       ├─ stores shared state in .pi/swarm/swarm-state.json
       ├─ serializes writes with .pi/swarm/swarm-state.lock/
       ├─ appends messages to .pi/swarm/mailboxes/<agent-id>.jsonl
       ├─ injects system messages into recipient tmux panes
       └─ writes traces to .pi/swarm/traces/events.jsonl
```

Runtime files are local to the current working directory and are ignored by git.

## Runtime layout

```text
.pi/swarm/
  swarm-state.json              # agents, tmux session, message lifecycle records
  swarm-state.lock/             # lock directory used for atomic state updates
  agents/<agent-id>.md          # durable identity/role card for each agent
  mailboxes/<agent-id>.jsonl    # append-only mailbox per recipient
  traces/events.jsonl           # structured event stream
  traces/tmux/*.txt             # before/after pane snapshots and manual captures
```

## Quick start

Start pi with the packaged extension:

```bash
pi --model glm-5.1 --provider zai-coding-cn -e extensions/swarm/index.ts
```

(The source of truth is now the packaged `extensions/swarm/index.ts`. The old project-local `.pi/extensions/swarm/index.ts` dev wrapper was removed during packaging; do not recreate it, or pi would double-register swarm.)

The extension defaults to `glm-5.1` / `zai-coding-cn`. It also knows the fast preset `gpt-5.4-mini`: when `swarm_spawn_agent` receives `model: "gpt-5.4-mini"` and no explicit provider/default-provider override, it auto-selects provider `openai`.

You can set project-local swarm defaults in `.pi/settings.json`:

```json
{
  "swarm": {
    "defaultModel": "gpt-5.4-mini",
    "defaultProvider": "openai"
  }
}
```

A nested `extensions.swarm` object is also accepted for backward compatibility, but the top-level `swarm` object is the safer recommendation because pi itself may use top-level `extensions` for extension discovery/config. Precedence is:

1. explicit tool parameter (`model` / `provider`)
2. `.pi/settings.json` (`extensions.swarm` or top-level `swarm`)
3. env vars (`PI_SWARM_DEFAULT_MODEL`, `PI_SWARM_DEFAULT_PROVIDER`)
4. code defaults / model preset (`glm-5.1` / `zai-coding-cn`, fast preset `gpt-5.4-mini` → `openai`)

Inside pi, initialize/check the swarm:

```text
/swarm init
/swarm status
```

Spawn an agent:

```text
/swarm spawn reviewer Review the current diff and report risks. Do not edit files.
```

Or ask pi to call the tool directly for richer options:

```text
Use swarm_spawn_agent to create an agent named reviewer with role "Review the current diff and report risks".
```

Attach to the tmux session when you want to inspect all agents:

```bash
tmux attach -t <tmux-session-from-swarm-state>
```

The active session is also listed in `.pi/swarm/swarm-state.json`.

## Slash command

The extension registers `/swarm` for quick TUI use:

| Command | Purpose |
| --- | --- |
| `/swarm init` | Ensure runtime directories/state exist. |
| `/swarm status` or `/swarm list` | Show agent count and tmux session. `/swarm status` emits a PM rollup (tasks/agents/closure). |
| `/swarm graph <task-id> [text\|mermaid\|json]` | Render a task graph and write it to `.pi/swarm/traces/graphs/`. |
| `/swarm spawn <id> [role]` | Spawn a child pi agent in tmux. |
| `/swarm send <to> <message>` | Send a mailbox/tmux-injected message. |
| `/swarm trace` | Show recent structured trace events. |
| `/swarm capture <id>` | Capture an agent pane to `.pi/swarm/traces/tmux/`. |

For detailed JSON results, prefer the tools below.

## Tools

### `swarm_spawn_agent`

Spawns a new pi session in a tmux window in the same cwd, using the same project-local extension and shared project resources.

Parameters:

- `id?`: stable agent id. Non-safe characters are normalized.
- `role`: durable role/instructions for the agent.
- `model?`: model id. Defaults to current/default swarm model.
- `provider?`: provider id. Defaults to current/default swarm provider.
- `initialPrompt?`: optional first prompt injected into the child pane after pi starts.

Outputs include the agent record, tmux target, identity path, and initial pane snapshot.

### `swarm_list_agents`

Lists known agents, their tmux targets, model/provider, mailbox paths, and persisted lifecycle fields.

### `swarm_agent_status`

Combines persisted state, tmux liveness, and mailbox counts.

Runtime statuses:

- `starting`: agent has been spawned/session is initializing.
- `idle`: agent is settled and waiting.
- `busy`: agent turn is running.
- `tool_running`: agent is executing a tool.
- `shutting_down`: reserved for shutdown flow.
- `stopped`: pi session shutdown event was observed.

Health statuses:

- `healthy`: recent lifecycle event observed.
- `degraded`: used by status reporting when persisted health is absent and tmux is not alive.
- `unhealthy`: shutdown was observed.

Message counters:

- `pendingMessages`: queued or failed messages awaiting injection/retry.
- `unackedMessages`: injected/intercepted messages requiring ack.
- `deadLetters`: messages permanently failed by reconcile.

### `swarm_send_message`

Sends an inter-agent message by:

1. Appending the message to `.pi/swarm/mailboxes/<to>.jsonl`.
2. Creating/updating a lifecycle record in `swarm-state.json.messages`.
3. Injecting a base64 system message marker into the recipient tmux pane when possible.

Parameters:

- `to`: recipient agent id.
- `body`: message body.
- `subject?`: short subject.
- `priority?`: `low`, `normal`, or `high`.
- `conversationId?`: thread id for related messages.
- `replyTo?`: parent message id.
- `requiresAck?`: defaults to `true`.
- `requiresResponse?`: defaults to `false`. When `true`, the recipient must send a result/reply message (with `replyTo` set to this message) and then ack `done` with `resultMessageId` before the message counts as fully satisfied.
- `ttlMs?`: optional time-to-live for reconcile/dead-letter handling.
- `idempotencyKey?`: optional dedupe key scoped by `from + to + idempotencyKey`.

### `swarm_check_mailbox`

Reads mailbox JSONL for an agent.

Parameters:

- `agentId?`: defaults to current swarm agent id.
- `limit?`: max returned messages, default 20.
- `pendingOnly?`: only messages not marked delivered/read.
- `markDelivered?`: mark matched messages as delivered/read in swarm state.

### `swarm_ack_message`

Records recipient progress for a message.

Parameters:

- `messageId`: message id to acknowledge.
- `status`: `seen`, `processing`, `done`, or `failed`.
- `note?`: short note about what happened.
- `resultMessageId?`: id of the result/reply message produced from this message. **Required when acking `done` (or `failed`) on a `requiresResponse` message.**

Ack is lifecycle only — it is not the work result. For a `requiresResponse` message, the recipient must send a result first via `swarm_send_message(to=<original-from>, replyTo=<original-id>)` (or `swarm_task_message`), then ack `done` with that result message id. If `done` is acked without a valid `resultMessageId`, the ack throws `RESPONSE_REQUIRED`; the result is validated (it must exist, come from the acking agent, be addressed back to the original sender, and reply to or share the conversation of the original) and throws `INVALID_RESULT_MESSAGE` otherwise.

A `failed` ack moves the lifecycle record to `failed`; other ack statuses move it to `acked`.

### `swarm_message_status`

Inspects lifecycle records, optionally filtered by:

- `messageId`
- `agentId`
- `status`
- `limit`

Lifecycle statuses:

- `queued`: mailbox append happened, injection pending.
- `mailbox_delivered`: message was durably appended for a mailbox-only recipient, such as the orchestrator pseudo-agent with no tmux pane.
- `injected`: tmux injection succeeded.
- `intercepted`: recipient pi input hook parsed the system marker.
- `acked`: recipient acknowledged the message.
- `failed`: injection or processing failed and may be retried.
- `dead_letter`: reconcile marked the message unrecoverable.

### `swarm_reconcile`

Repairs stuck mailbox state AND task graph state. For mail it can retry `queued`/`failed` messages, detect stale unacked deliveries (`ack_missing`), and mark expired/max-attempt messages as `dead_letter`. For tasks it sweeps every `task.json`: reports stored-vs-derived status drift, surfaces stale/nudge signals (dead/stopped/unhealthy/tmux-dead assignee, missing assignee, dead-lettered assignment, `in_progress` past the stale/nudge thresholds, delivered-but-unacked assignment), and stamps advisory `node.staleAt`.

Parameters:

- `agentId?`: reconcile one recipient's messages (task sweep is skipped when scoped to one agent).
- `dryRun?`: report actions without modifying state.
- `mark?`: persist the recomputed `task.status` when stored/derived drift is detected (repairs closure). Still never auto-fails a node. Defaults to false.

Reconcile is mark-only and idempotent; it does not auto-fail nodes or re-inject reminder messages. The PM summary and `swarm_task_status(runtime=true)` make the surfaced signals visible.

### `swarm_dead_letters`

Lists dead-lettered messages, optionally filtered by recipient or message id.

### `swarm_prune`

Orchestrator/admin cleanup tool. Dry-run by default. It detects zombie agents whose tmux panes are gone, can mark them stopped, and can optionally remove stopped agent records from swarm state. It does not delete mailboxes or traces in V1.

### `swarm_trace`

Reads recent lines from `.pi/swarm/traces/events.jsonl`.

### `swarm_capture_agent_pane`

Captures a child agent's tmux pane to `.pi/swarm/traces/tmux/` for review/debugging.

### `swarm_agent_identity`

Reads or refreshes the durable identity card at `.pi/swarm/agents/<agent-id>.md`. With `refresh: true` (or when no effective file exists yet) it rebuilds the **effective** identity = generated card + optional override + provenance footer (see [Identity override & reload](#identity-override--reload)) and stamps `identityVersion`/`identityHash`/`identityLoadedAt` on the agent record.

## Identity override & reload

Every swarm agent has a **generated** identity card (role, operating protocol, ACK protocol, peer-discovery, memory link). Generation alone would overwrite human edits, so an agent's effective identity is built from two sources:

1. **Generated base** — `.pi/swarm/agents/<agent-id>.md` (fully rebuilt each time from swarm state).
2. **Editable override** — `.pi/swarm/agents/<agent-id>.override.md` (a separate, optional file that is **only ever read**, never written or deleted by the extension).

The effective file written to `<agent-id>.md` is `base + override (if present) + Identity provenance footer`. Regeneration always rebuilds base+override, so edits in `.override.md` survive. The override body is wrapped in clearly delimited markers:

```text
<!-- PI-SWARM IDENTITY OVERRIDE START -->
## Custom instructions (from override)

<your override text>
<!-- PI-SWARM IDENTITY OVERRIDE END -->
```

### Provenance: version / hash / loadedAt

Each effective-identity write stamps the agent record and appends an `## Identity provenance` footer:

- `identityVersion` — monotonically bumps when the effective **content** (base + override body) changes since the last stamp, or on first creation. A no-op rewrite is idempotent; adding, removing, or editing the override (or a role/state change) bumps the version.
- `identityHash` — sha256 hex of the effective content (base + override body; the provenance footer is excluded so version-bump detection stays stable).
- `identityLoadedAt` — ISO timestamp of the last effective-identity write.

### Reloading a running agent

Use `swarm_reload_identity` (tool) or `/swarm identity reload <agent-id> [note]` (command) to regenerate the effective identity for a live agent. If the agent's tmux pane is alive, a `[PI-SWARM IDENTITY RELOAD]` instruction is injected into the pane telling the agent to re-read its identity now; if the pane is dead, the new identity still takes effect on the next `session_start`/identity read. Injection is **best-effort and never fails the reload** — a dead pane or transient tmux error is traced (`agent.identity.reload_inject_failed`) and reported as `injected: false`.

`/swarm identity show <agent-id>` prints the effective identity file plus the current version/hash/loadedAt/override-present header.

The reload re-injects into living agents so an operator can push new instructions (via the override file) without restarting the agent — see [docs/swarm-task-graph.md](./swarm-task-graph.md) for how this interacts with living assigned agents.

## Message delivery semantics

A swarm message has two durable records:

1. A mailbox JSONL entry in the recipient mailbox.
2. A lifecycle record in `swarm-state.json.messages`.

Delivery to a live agent is done via tmux pane injection with a system marker:

```text
[PI-SWARM SYSTEM MESSAGE] b64:<payload> [/PI-SWARM SYSTEM MESSAGE]
```

The recipient extension input hook decodes the payload, marks the lifecycle record `intercepted`, then emits a custom `swarm-message` into pi using `pi.sendMessage`.

Important distinctions:

- `mailbox_delivered` means the recipient is mailbox-only; no tmux injection was attempted.
- `injected` means text reached the tmux pane.
- `intercepted` means the recipient extension parsed the marker.
- `acked` means the recipient explicitly called `swarm_ack_message` with a final `done` ack. Progress acks such as `seen`/`processing` update `lastAck` but do not complete the message.

## Idempotency

`swarm_send_message` accepts `idempotencyKey`. If the sender has already sent a message to the same recipient with the same key, the existing message is returned and no new mailbox line/injection is produced.

Scope:

```text
from + to + idempotencyKey
```

This prevents duplicate task assignment when a coordinator retries a send prompt.

### Assignment idempotency & supersede

`swarm_assign_task` is **idempotent per task/node/assignee/attempt**. It derives a deterministic key `assign:<taskId>:<nodeId>:<assignee>:<attempt>` and passes it to the message send, so an exact retry of the same assignment (same attempt) **returns the existing message** (`message.idempotent_reuse` trace) instead of creating a duplicate. The node also records the canonical current assignment as `node.assignmentMessageId`.

When a **new** assignment supersedes prior open ones for the same task/node (e.g. a reassign after stale-status repair bumped the attempt), the older still-open assignment messages are **superseded + waived** automatically:

- `message.superseded = { at, by, supersededBy }` and `response.status = "waived"` are stamped on the prior message (`message.superseded` trace).
- Because the response becomes `waived`, the existing reconcile/reuse logic already **excludes** it from `response_missing` nagging and from reuse blocking — no special-case reconcile code is needed. `runtimeTaskWarnings`/closure summaries skip superseded messages and prefer `assignmentMessageId`.
- `node.messageIds[]` keeps the full audit history; `assignmentMessageId` is the single completable current assignment.

**Retries do not require a duplicate response.** `swarm_ack_message` guards superseded assignments: a `done` or `processing` ack on a superseded message throws `ASSIGNMENT_SUPERSEDED` (pointing at the current assignment) so an implementer replying to an old assignment cannot double-complete. A `failed` ack is always allowed (informational). The orchestrator can override with `swarm_ack_message(..., status="done", waive=true)` to accept a superseded assignment as `waived`. This preserves `requiresResponse` semantics on the **current** assignment while making retries safe and non-duplicative.

### Stale & reassignment cleanup

When a node is **reassigned** (e.g. the old owner died and was replaced), the harness cleans up so the prior owner's lifecycle cannot pollute the new assignment:

- **`node.staleAt` is cleared on (re)assign.** A fresh `swarm_assign_task` deletes any prior `staleAt` (`task.stale.cleared` trace), and `swarm_update_task` clearing it on active (re)entry (`assigned`/`in_progress`/`ready`) — so a marker stamped by a dead previous owner never carries onto the new owner. (It is advisory only; `swarm_reconcile` may re-stamp it later if the new owner actually goes idle.)
- **Old assignment messages are superseded + waived** (see above), so they are already excluded from `response_missing` nagging and reuse blocking — no special-case reconcile code is needed.
- **Old assignee `activeTaskIds` is released** on reassign and on terminal-ish transitions.
- **Shutdown/settle only claims a node while it is the *canonical* owner.** The dying-agent scan skips a node when `node.assignee !== agentId`, when the canonical `assignmentMessageId` is missing/superseded, or when that canonical message is addressed to a different agent. So an old owner that shuts down/settles after a reassign will **not** be reported as still holding the node, and will **not** stamp `staleAt` onto the new owner.

## Response-required protocol

An ACK proves the recipient processed a message; it does not prove the work was delivered back. The `requiresResponse` flag closes that gap.

- **Opt-in.** `swarm_send_message` accepts `requiresResponse` (default `false`).
- **Task traffic is response-required.** `swarm_assign_task` always sends with `requiresResponse=true`, and `swarm_task_message` sends with `requiresResponse` whenever a reply is expected (`replyExpected !== false`).
- **Verified before done.** A recipient cannot ack `done` on a `requiresResponse` message without a `resultMessageId`. The harness validates the result message exists, was sent by the acking agent back to the original sender, and is linked by `replyTo` or `conversationId`.
- **Response sub-state.** Each message carries a `response` object: `not_required`, `missing`, `sent`, `verified`, or `waived`. Sending a reply with `replyTo` moves it to `sent`; the verified `done` ack moves it to `verified`.
- **Surfaced as `response_missing`.** If a `requiresResponse` message is not yet verified, `swarm_reconcile` records `response_missing`, `swarm_agent_status` reports `responseMissing`/`responsesVerified`/`blockedFromReuse`, and the agent's `runtimeStatus` becomes `response_missing`. An agent with any pending `requiresResponse` message is blocked from reuse (`findReusableAgent` skips it) until it sends replies and acks `done` with valid result ids.
- **Settle protection.** If a worker settles (`agent_settled`) while still owing a verified response, it is marked `response_missing` and the orchestrator is notified; the task does not auto-close and the agent stays blocked from reuse.

This keeps graph advancement driven by verified machine state, not by mailbox-only activity or a bare ACK.

## Liveness and status

Agent liveness is partly persisted and partly observed:

- Persisted lifecycle fields are updated by pi events.
- `tmuxAlive` is computed by checking the agent's tmux target.
- Message health is derived from mailbox lifecycle records.
- `runtimeStatus` is `starting`/`idle`/`busy`/`tool_running`/`response_missing`/`shutting_down`/`stopped`; `response_missing` means the agent still owes a verified result for one or more `requiresResponse` messages, which blocks reuse.

This is not a distributed consensus system and does not run a heartbeat daemon. If a process dies without a `session_shutdown` event, `tmuxAlive` and stale `lastHeartbeatAt` are the primary signals.

## Task graph and closure

The task-graph layer specified in [`docs/swarm-task-graph.md`](./swarm-task-graph.md) is **implemented**: durable task folders under `.pi/swarm/tasks/<task-id>/`, `task.json` state, workflow templates, artifacts, and the task tools (`swarm_create_task`, `swarm_assign_task`, `swarm_update_task`, `swarm_task_message`, `swarm_task_status`, `swarm_validate_graph`, `swarm_print_graph`, `swarm_next_nodes`).

Task closure is **engine-enforced**, not polled: every create/assign/update recomputes `task.status` from node states via `computeTaskStatus` inside the same locked write. A task is `done` when every terminal node is `done`/`skipped`, `failed` if any node failed, `in_progress` once work starts, and `ready` before that. `cancelled` is orchestrator-explicit and sticky.

**PM auto-notify (no manual polling).** The orchestrator does not need to poll to learn a node closed or a worker went idle with open work. When `swarm_update_task` transitions a node into a closure-ish status (`done`/`failed`/`blocked`), the engine enqueues a concise mailbox report to the mailbox-only `orchestrator` (taskId/nodeId, prev→new, outcome, assignee, artifact, task status, next-ready), with a stronger `task <id> closed (<status>)` variant on task-terminal (`done`/`failed`/`cancelled`). When a worker's `agent_settled` fires while it still holds open assignment(s), the engine enqueues an `agent <id> settled idle with open assignment(s)` nudge to `orchestrator`. Both notifications are mailbox-only to `orchestrator`, `requiresAck=false` (informational; the orchestrator's session mailbox pump surfaces them), gated on the transition (not every update), and the settle nudge is cooldown-guarded per agent via persisted `lastSettleNotifyAt` (`SETTLE_NOTIFY_COOLDOWN_MS`, 2 min) so repeated settles don't storm. They never mutate node status and run no daemon — they only surface what already happened in machine state.

**Session-safe + read-safe orchestrator surfacing.** Mailbox-only notifications to `orchestrator` are surfaced to the orchestrator's TUI by an auto-pump (`pumpOrchestratorMailbox`) that fires on `session_start`/`agent_settled`/interval. The pump keys "already surfaced" **per process** (`process.pid` in `st.orchestratorPumpSessions`), so every orchestrator-context process surfaces each notification once — a second orchestrator lane or a validation `pi -p` run cannot steal a notification from the primary PM session. It deliberately does **not** key on `PI_SESSION_ID` (a child `pi -p` spawned from an agent's bash inherits the parent's `PI_SESSION_ID`, so keying on it would reintroduce starvation), and it deliberately never reads the shared `st.delivered.orchestrator` ledger — that set is written by `swarm_check_mailbox(markDelivered=true)` and `swarm_ack_message`, so a manual mailbox read or an explicit ack can no longer pre-empt a later pump surface. The pump trace event `mailbox.orchestrator_pump` carries `cid` (the process pid) and `sid` (`PI_SESSION_ID`) for attribution. The single-consumer assumption from earlier docs is therefore no longer load-bearing for visibility: every orchestrator session reliably sees its notifications without polling. The pump has two layers. The **surfacing decision** (scan the mailbox, update the per-pid set, emit `mailbox.orchestrator_pump`) runs in **every** orchestrator session — it is ctx-free file IO, so it is safe in `pi -p`/rpc/json too (this is exactly what makes the session-safe/read-safe properties repeatable in the UAT without an interactive TUI). The **TUI delivery** (`pi.sendMessage`/`ctx.isIdle()`) is mode-gated to the live interactive orchestrator session, where those session-bound APIs actually render into the PM view; in print mode they are no-ops (no TUI to deliver to). The one-shot at `session_start` is awaited (so a short-lived `pi -p` turn completes the decision before exit); the 5s polling **interval** is tui-only, because its long-lived captured ctx is the real source of the `This extension ctx is stale after session replacement or reload` error once the session is replaced/reloaded. Non-interactive callers read mailboxes via `swarm_check_mailbox`; if the pump ever hits a ctx error it stops itself cleanly (traced `mailbox.orchestrator_pump_error`) rather than retrying into a stale ctx, and the next orchestrator `session_start` restarts a fresh pump.

**Reload contract (important).** Extension code is **not hot-applied** to a running orchestrator session — after editing `extensions/swarm/index.ts` the orchestrator must `/reload` (or restart) to load the updated pump. The pump is **multi-process-safe** (pid-keyed): every orchestrator process surfaces its notifications independently, so it does not assume a single live orchestrator. On `/reload` the orchestrator gets a new pid with an empty surfaced set, so the pump **re-surfaces recent un-acked notifications** (bounded by the scan window) — the desired recovery for a stale session that missed them while running old code; already-acked messages are not re-surfaced. `requiresAck:false` informational notifies (close/settle) may re-surface once after a restart; this is bounded and intentional.

See the closure rules, stale/nudge ladder, and deferred destructive tools in [`docs/swarm-task-graph.md`](./swarm-task-graph.md). This is still not a distributed consensus system and runs no heartbeat daemon; `tmuxAlive`, stale `lastHeartbeatAt`, `node.staleAt`, and the reconcile sweep are the primary liveness signals.

## Metric / run / memory V1

A minimal, file-backed metric/run/memory layer lives under `.pi/swarm/`. Swarm is the **harness**; the project defines the metric (nothing hard-codes accuracy/latency/cost). There is **no daemon, no vector DB, no optimizer loop** in V1 — everything is append-only JSONL plus atomic contract writes, gated on file-backed evidence.

File layout:

```text
.pi/swarm/
  metrics/<metric-id>.json   # authoritative project-specific metric contract
  runs/runs.jsonl            # append-only run records (latest line per runId wins)
  memory/memory.jsonl        # append-only memory records (status: proposed|active|rejected|expired)
```

Tools (8):

- `swarm_metric_define` — create/replace a versioned project metric contract (validates safe id, direction, value type; replacement increments `version`).
- `swarm_metric_get` — read a metric contract by id.
- `swarm_run_record` — validate status/verdict/primary metric, bind the run to the current contract version, capture SHA-256 evidence digests plus best-effort git state, and append under the swarm lock.
- `swarm_run_get` — read the latest record for a runId.
- `swarm_run_compare` — generic comparison of 2..N runs against an optional metric (contract `direction` wins; otherwise `higherBetter` is a hint).
- `swarm_memory_propose` — propose a claim sourced from a run; runs the evidence gate (still appends as `rejected` with a `rejectionReason` on failure, never auto-activates).
- `swarm_memory_search` — file-backed substring + scope filter (no vector DB/embeddings).
- `swarm_memory_accept` — reviewer/orchestrator moves `proposed`→`active`/`rejected`, re-running the evidence gate before activating.

**Evidence gate** (enforced at propose, accept, and iteration-context retrieval): the source run must be `done` with verdict `pass`/`approved`, match the current metric-contract id + version, and carry a correctly typed primary metric. `evidenceRefs` must be non-empty, safe relative paths that exist/read; every contract `evidenceRequired` entry must be present; and each artifact must still match the SHA-256 digest captured when the run was recorded. A run that describes a code/config change must carry a `.patch`/`.diff` ref or distinct git base/head commits. Pane-only, ack-only, mailbox-only, mutated, stale-contract, or incomplete claims never promote or carry forward. `swarm_memory_accept` is role-gated to reviewer/orchestrator and enforces `proposed→active`; append transitions use the global swarm lock.

Run records can optionally link to a swarm task via `taskId`/`nodeId`; when tied to a graph, also stamp `task.json.sharedContext`/`task.json.evidence`, but `runs.jsonl` remains the authoritative metric/evidence store. See [`docs/swarm-task-graph.md`](./swarm-task-graph.md) and the `swarm_metric_designer` skill for the iteration demo flow.

### New-project optimization setup checklist

After installing this package into a new project, set up optimization explicitly; swarm does not invent project metrics for you.

1. **Define the quality/metric contract** with `swarm_metric_define` before recording runs. Pick a project-specific primary metric (`quality_score`, `pass_rate`, `eval_score`, etc.), direction (`maximize|minimize|target|passfail`), type, source artifact/command/report, and `evidenceRequired` refs. This contract is the quality gate for iteration ranking and memory eligibility.
2. **Create an evidence convention** in the target project, e.g. `.pi/swarm/evidence/<task-or-run>/summary.md` plus `.patch`/`.diff` for code/config changes. `swarm_run_record` captures SHA-256 digests for every evidence ref; later memory promotion fails if evidence is missing or mutated.
3. **Run a baseline** with `swarm_run_record(status="done", verdict="pass", metrics={...}, evidenceRefs=[...])`, then `swarm_iteration_create(metricContractId=..., baselineRunId=...)`.
4. **For each candidate iteration**, give the agent the `swarm_iteration_context` bundle first. It includes `memoryPolicyRef: "docs/swarm-memory.md"`, previous best, active/pinned memories, and excluded stale memories. The agent should read memory before planning changes.
5. **Record the candidate** with `swarm_run_record`, then append it with `swarm_iteration_record`. The best/improvement roll-up is recomputed from the metric contract; failed/running/cross-contract/stale-version/wrong-type runs cannot win.
6. **Memory write path**: agents may `swarm_memory_propose` only from a passing/approved run with complete file-backed evidence. A reviewer/orchestrator must `swarm_memory_accept` before the claim becomes active. Pane-only, ack-only, mailbox-only, generic, or evidence-incomplete claims stay rejected/auditable and are not carried forward.
7. **Dashboard/review**: use `swarm_iteration_status(includeContext=true)`, `scripts/swarm_iteration_watch.sh`, or `scripts/swarm_dashboard.sh` to see per-iteration improvement, memory carry-forward, and task/message evidence.

**Iteration count:** V1 has no daemon and no native graph-cycle runner. Iterations are explicit `swarm_run_record` + `swarm_iteration_record` calls; you can append as many candidate entries as your file-backed session can reasonably handle. The demo validates a baseline, one accepted candidate, and one rejected/incomplete-evidence run; longer loops are just repeated candidate records. If you want an automatic loop, model it as an orchestrated sequence or create a new task node per iteration — do not rely on graph cycles in V1.

## Memory protocol

Memory is governed by a dedicated runtime policy: [`docs/swarm-memory.md`](./swarm-memory.md). Generated agent identity files link to it, and the iteration-context bundle surfaces its path as `memoryPolicyRef`. In short:

- **Read** memory (`swarm_memory_search`) at task start, before proposing changes, when blocked, and during review — scope-first retrieval.
- **Propose** (`swarm_memory_propose`, any agent) only after a terminal `done`/`pass`|`approved` run bound to the current metric-contract version, with complete file-backed evidence that still matches its recorded SHA-256 digests.
- **Claim quality**: specific, falsifiable, scoped (`scope.kind/id`), one finding per claim, tied to a `sourceRunId`. No generalities.
- **Evidence**: non-empty existing `evidenceRefs`, all contract `evidenceRequired` present, digests unmutated; code/config claims need a `.patch`/`.diff` or distinct git base/head. Pane-only / ack-only / mailbox-only / incomplete claims never promote.
- **Roles**: any agent may propose; only reviewer/orchestrator may `swarm_memory_accept` (gate re-runs before activation). Rejected claims are auditable, never dropped.
- **Self-check**: if you cannot reconstruct the claim from git + artifact files + trace alone, do not propose it.

The evidence gate is enforced at propose, accept, and on every iteration-context retrieval; see [`docs/swarm-memory.md`](./swarm-memory.md) for the full policy.

## Iteration loop V1

A thin, file-backed **iteration session** layer sits on top of the metric/run/memory tools. A session points at a `metricContractId`, a list of `runId`s, and pinned active `memoryId`s — it stores **ids only**, never copies run/memory payloads. There is **no daemon and no native graph cycle**: each step is an explicit tool call; the "loop" is a sequence of calls driven by an agent/orchestrator.

File layout:

```text
.pi/swarm/iterations/<iteration-id>.json   # mutable session state (atomicWriteFile + global lock)
```

Tools (4):

- `swarm_iteration_create` — create a session over an existing metric contract; the optional baseline must be a valid terminal run and pinned memories must be active.
- `swarm_iteration_record` — append a unique, valid run bound to the same contract/version, then recompute best/improvement; failed/running/cross-contract/stale-version runs are rejected and cannot win.
- `swarm_iteration_status` — session JSON + the derived best/improvement roll-up (per-run value, baseline/best, `improvement`, `meaningful`, missing-metric count); optional `includeContext`.
- `swarm_iteration_context` — next-iteration retrieval: previous best run summary + active memories matching scope `kind+id` (or explicitly pinned). Memories are revalidated against current evidence digests, ranked pinned-first then confidence/recency, and stale entries are returned under `excludedMemories` instead of being carried forward.

**Best/improvement is generic and eligibility-gated**: `computeIterationBest` is the single decision point. It first excludes missing, running, failed/rejected, cross-contract, stale-version, or wrongly typed runs, exposing per-run `exclusionReasons` plus `invalidCount`. It then reads `run.metrics[contract.primaryMetric.id]` (never a hard-coded key) and honors the contract `direction` — `maximize` (max), `minimize` (min), `target` (closest to `primaryMetric.target`, falls back to maximize if unset), `passfail` (a passing boolean run). `improvement` is signed in the favored direction; zero delta is never meaningful, and positive delta must meet `primaryMetric.minimumMeaningfulChange` when set.

Demo flow (uses only real tools): `swarm_metric_define` → `swarm_run_record` baseline → `swarm_iteration_create` → `swarm_run_record` run-001 → `swarm_iteration_record(runId=run-001)` → `swarm_memory_propose`/`swarm_memory_accept` → `swarm_iteration_context` feeds the next agent → repeat; `swarm_iteration_status` shows the trend. Success question: from the session JSON + `runs.jsonl` + `memory.jsonl` + trace lines alone, can an agent reconstruct the best run, improvement, and carry-forward memories?

### Iteration loop demo

A runnable UAT exercises the full metric contract → runs → memory → iteration context flow in an isolated fresh session, including the negative case (incomplete evidence must not promote memory). The 4 iteration tools (`swarm_iteration_create`, `swarm_iteration_record`, `swarm_iteration_status`, `swarm_iteration_context`) are driven end-to-end with file-backed assertions.

```bash
bash scripts/swarm_iteration_demo.sh
```

See [`docs/swarm-iteration-demo.md`](swarm-iteration-demo.md) for the scenario, assertions, review artifact paths, and cleanup notes.

### Live + completed iteration reviewer

A dependency-free (python3 + bash) reviewer renders `.pi/swarm` iteration state two ways: a **live watch** while a loop runs, and a **completed/historical review** of finished task graphs/iterations as a one-shot report or Markdown dashboard. Read-only; `--format text|mermaid|markdown`, `--out FILE`, `--all-tasks`, and `--task/--run/--iteration` focus flags.

```bash
scripts/swarm_iteration_watch.sh --once                              # text review report
scripts/swarm_iteration_watch.sh --interval 2                         # live watch (Ctrl-C to stop)
scripts/swarm_iteration_watch.sh --format markdown --out review.md    # Mermaid dashboard
scripts/swarm_iteration_watch.sh --task <taskId> --once               # one completed task graph
```

The Markdown dashboard emits three Mermaid diagrams: a task-graph **flowchart** (nodes by status/outcome/artifact + edges), an agent **sequenceDiagram** (messages/handoffs with ack/response/result links), and an **iteration metric timeline** (per-iteration values + Δ, best highlighted). See [`docs/swarm-iteration-demo.md`](swarm-iteration-demo.md) ("Reviewing iteration state (live + completed)") for flags and usage.

### Static HTML dashboard

For a visual/browser review, `scripts/swarm_dashboard.sh` generates a **single self-contained, dependency-free HTML dashboard** (inline CSS, no CDN/build) prioritizing per-iteration metric improvement (inline SVG chart), task-graph node flow (status-colored node cards), and agent conversation (message timeline with ack/result links), plus memory/evidence state and a raw inspector. One-shot (historical/completed) and `--live` regeneration modes.

```bash
scripts/swarm_dashboard.sh --out dashboard.html        # one-shot, open in a browser
scripts/swarm_dashboard.sh --live --interval 3           # regenerate + auto-refresh
scripts/swarm_dashboard.sh --task <taskId> --out t.html  # focus one task graph
```

See [`docs/swarm-dashboard.md`](swarm-dashboard.md) for sections, accessibility/responsive details, and validation.

## Recommended agent protocol

Spawned agents receive an identity card and should:

1. Read `.pi/swarm/agents/<agent-id>.md` at startup.
2. Use `swarm_check_mailbox` to inspect pending work.
3. For `requiresResponse` messages (task assignments and reply-expected task messages), send a result first via `swarm_send_message(to=<requester>, replyTo=<original-id>)` or `swarm_task_message`, then call `swarm_ack_message` with `done` and `resultMessageId`. For plain `requiresAck` messages, ack with `seen`/`processing`/`done`/`failed`.
4. Use `swarm_send_message` for peer coordination.
5. Use `swarm_trace`, `swarm_agent_status`, and `swarm_capture_agent_pane` when debugging.
6. Avoid asking the human to relay messages between agents.

## Validation

Run the UAT harness with GLM/Zai:

```bash
SWARM_MODEL=glm-5.1 SWARM_PROVIDER=zai-coding-cn scripts/swarm_uat.sh
```

Artifacts are written to:

```text
.pi/swarm-uat/runs/<run-id>/
```

See `.pi/swarm-uat/README.md` for pass criteria and generated artifact details.

For the **task-graph** UAT (Commit 4/5-class flows: assign → update → terminal → closure; stale/reconcile; cancel; drift repair), run it in a dedicated tmux lane. It runs in an isolated working tree so it never touches the live project swarm state:

```bash
scripts/swarm_task_uat.sh
# or: SWARM_MODEL=glm-5.1 SWARM_PROVIDER=zai-coding-cn scripts/swarm_task_uat.sh
```

It asserts on `task.json` / swarm-state / trace events (model-independent) and prints `UAT_STATUS: PASS|FAIL`. Evidence under `.pi/swarm-uat/runs/<run-id>/`.

For a fast TypeScript check:

```bash
NODE_PATH=$(npm root -g) npx tsc --noEmit --module nodenext --moduleResolution nodenext --skipLibCheck --target es2022 --lib es2022 extensions/swarm/index.ts
```

## Troubleshooting

### Tool says injected false

Check the recipient agent status:

```text
Call swarm_agent_status for the recipient.
```

Then run reconcile:

```text
Call swarm_reconcile with dryRun true.
```

If the tmux pane is alive, run reconcile without dry run to retry.

### Agent did not respond

Check in this order:

1. `swarm_agent_status`
2. `swarm_message_status` for the message id
3. `swarm_trace`
4. `swarm_capture_agent_pane`
5. `tmux attach -t <swarm-session>`

### Duplicate task assignment

Use `idempotencyKey` on `swarm_send_message` for coordinator retries.

### Runtime state is corrupt during development

Stop/ignore old tmux agents if needed, then remove runtime state:

```bash
rm -rf .pi/swarm
```

The extension source is `extensions/swarm/index.ts` (packaged). Do not recreate a `.pi/extensions/swarm/index.ts` copy — pi would double-register the swarm extension; `scripts/swarm_iteration_demo.sh` aborts if both exist.

## Known limitations

- No central server/daemon: all coordination is filesystem + tmux + pi extension hooks.
- No cross-host support.
- No cryptographic authentication for local mailbox writes.
- `session_shutdown` may not fire on hard kills; use `tmuxAlive` and stale heartbeat age to detect that case.
- `/swarm status` is intentionally brief; use `swarm_agent_status` for detailed JSON.
