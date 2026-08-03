# Pi Swarm Extension

`pi-swarm` is a project-local pi extension that turns a single pi session into a tmux-backed group of cooperating pi agents. It is intentionally simple and inspectable: there is no daemon or mini server. Coordination uses tmux panes, JSON state, JSONL mailboxes, and structured trace files under the project `.pi/swarm/` runtime directory.

## Architecture

```text
orchestrator pi session
  └─ .pi/extensions/swarm/index.ts
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

Start pi with the project-local extension:

```bash
pi --model glm-5.1 --provider zai-coding-cn -e .pi/extensions/swarm/index.ts
```

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
| `/swarm status` or `/swarm list` | Show agent count and tmux session. |
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

Ack statuses are free-form strings, but the intended values are:

- `seen`
- `processing`
- `done`
- `failed`

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

Reads or refreshes the durable identity card at `.pi/swarm/agents/<agent-id>.md`.

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

## Liveness and status

Agent liveness is partly persisted and partly observed:

- Persisted lifecycle fields are updated by pi events.
- `tmuxAlive` is computed by checking the agent's tmux target.
- Message health is derived from mailbox lifecycle records.

This is not a distributed consensus system and does not run a heartbeat daemon. If a process dies without a `session_shutdown` event, `tmuxAlive` and stale `lastHeartbeatAt` are the primary signals.

## Task graph and closure

The task-graph layer specified in [`docs/swarm-task-graph.md`](./swarm-task-graph.md) is **implemented**: durable task folders under `.pi/swarm/tasks/<task-id>/`, `task.json` state, workflow templates, artifacts, and the task tools (`swarm_create_task`, `swarm_assign_task`, `swarm_update_task`, `swarm_task_message`, `swarm_task_status`, `swarm_validate_graph`, `swarm_print_graph`, `swarm_next_nodes`).

Task closure is **engine-enforced**, not polled: every create/assign/update recomputes `task.status` from node states via `computeTaskStatus` inside the same locked write. A task is `done` when every terminal node is `done`/`skipped`, `failed` if any node failed, `in_progress` once work starts, and `ready` before that. `cancelled` is orchestrator-explicit and sticky.

**PM auto-notify (no manual polling).** The orchestrator does not need to poll to learn a node closed or a worker went idle with open work. When `swarm_update_task` transitions a node into a closure-ish status (`done`/`failed`/`blocked`), the engine enqueues a concise mailbox report to the mailbox-only `orchestrator` (taskId/nodeId, prev→new, outcome, assignee, artifact, task status, next-ready), with a stronger `task <id> closed (<status>)` variant on task-terminal (`done`/`failed`/`cancelled`). When a worker's `agent_settled` fires while it still holds open assignment(s), the engine enqueues an `agent <id> settled idle with open assignment(s)` nudge to `orchestrator`. Both notifications are mailbox-only to `orchestrator`, `requiresAck=false` (informational; the orchestrator's session mailbox pump surfaces them), gated on the transition (not every update), and the settle nudge is cooldown-guarded per agent via persisted `lastSettleNotifyAt` (`SETTLE_NOTIFY_COOLDOWN_MS`, 2 min) so repeated settles don't storm. They never mutate node status and run no daemon — they only surface what already happened in machine state.

**Session-safe + read-safe orchestrator surfacing.** Mailbox-only notifications to `orchestrator` are surfaced to the orchestrator's TUI by an auto-pump (`pumpOrchestratorMailbox`) that fires on `session_start`/`agent_settled`/interval. The pump keys "already surfaced" **per process** (`process.pid` in `st.orchestratorPumpSessions`), so every orchestrator-context process surfaces each notification once — a second orchestrator lane or a validation `pi -p` run cannot steal a notification from the primary PM session. It deliberately does **not** key on `PI_SESSION_ID` (a child `pi -p` spawned from an agent's bash inherits the parent's `PI_SESSION_ID`, so keying on it would reintroduce starvation), and it deliberately never reads the shared `st.delivered.orchestrator` ledger — that set is written by `swarm_check_mailbox(markDelivered=true)` and `swarm_ack_message`, so a manual mailbox read or an explicit ack can no longer pre-empt a later pump surface. The pump trace event `mailbox.orchestrator_pump` carries `cid` (the process pid) and `sid` (`PI_SESSION_ID`) for attribution. The single-consumer assumption from earlier docs is therefore no longer load-bearing for visibility: every orchestrator session reliably sees its notifications without polling. The auto-pump only starts in interactive TUI mode (`ctx.mode === "tui"`): it surfaces via session-bound TUI APIs (`pi.sendMessage`/`ctx.isIdle()`), which are no-ops in print mode and throw `This extension ctx is stale after session replacement or reload` once the captured ctx is invalidated on teardown/replacement. Non-interactive callers (`pi -p`/rpc/json — including validation and UAT runs) read mailboxes via `swarm_check_mailbox`; if the pump ever hits a ctx error it stops itself cleanly (traced `mailbox.orchestrator_pump_error`) rather than retrying into a stale ctx, and the next interactive orchestrator `session_start` restarts a fresh pump.

See the closure rules, stale/nudge ladder, and deferred destructive tools in [`docs/swarm-task-graph.md`](./swarm-task-graph.md). This is still not a distributed consensus system and runs no heartbeat daemon; `tmuxAlive`, stale `lastHeartbeatAt`, `node.staleAt`, and the reconcile sweep are the primary liveness signals.

## Recommended agent protocol

Spawned agents receive an identity card and should:

1. Read `.pi/swarm/agents/<agent-id>.md` at startup.
2. Use `swarm_check_mailbox` to inspect pending work.
3. Use `swarm_ack_message` with `seen`/`processing`/`done`/`failed` for tasks that require acknowledgement.
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
NODE_PATH=$(npm root -g) npx tsc --noEmit --module nodenext --moduleResolution nodenext --skipLibCheck --target es2022 --lib es2022 .pi/extensions/swarm/index.ts
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

Do not remove `.pi/extensions/swarm/index.ts` unless you intend to delete the extension.

## Known limitations

- No central server/daemon: all coordination is filesystem + tmux + pi extension hooks.
- No cross-host support.
- No cryptographic authentication for local mailbox writes.
- `session_shutdown` may not fire on hard kills; use `tmuxAlive` and stale heartbeat age to detect that case.
- `/swarm status` is intentionally brief; use `swarm_agent_status` for detailed JSON.
