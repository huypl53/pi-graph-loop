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
pi --model glm-4.5 --provider zai-coding-cn -e .pi/extensions/swarm/index.ts
```

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
- `injected`: tmux injection succeeded.
- `intercepted`: recipient pi input hook parsed the system marker.
- `acked`: recipient acknowledged the message.
- `failed`: injection or processing failed and may be retried.
- `dead_letter`: reconcile marked the message unrecoverable.

### `swarm_reconcile`

Repairs stuck mailbox state. It can retry `queued`/`failed` messages, detect stale unacked deliveries, and mark expired/max-attempt messages as `dead_letter`.

Parameters:

- `agentId?`: reconcile one recipient.
- `dryRun?`: report actions without modifying state.

### `swarm_dead_letters`

Lists dead-lettered messages, optionally filtered by recipient or message id.

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

- `injected` means text reached the tmux pane.
- `intercepted` means the recipient extension parsed the marker.
- `acked` means the recipient explicitly called `swarm_ack_message`.

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
SWARM_MODEL=glm-4.5 SWARM_PROVIDER=zai-coding-cn scripts/swarm_uat.sh
```

Artifacts are written to:

```text
.pi/swarm-uat/runs/<run-id>/
```

See `.pi/swarm-uat/README.md` for pass criteria and generated artifact details.

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
