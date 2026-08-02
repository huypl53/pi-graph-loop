# Swarm Task Graph Design

This document proposes the next architecture layer for `pi-swarm`: task management and workflow orchestration. The current swarm already has agents, tmux transport, mailbox messaging, lifecycle traces, acknowledgements, reconcile/dead-letter handling, idempotency, and runtime status. What is missing is a durable model for **what work exists**, **who owns each piece**, **which node is ready next**, and **what evidence proves completion**.

## Problem

Current primitives answer only part of the coordination problem:

| Existing primitive | Answers |
| --- | --- |
| `.pi/swarm/agents/<agent-id>.md` | Who is this agent? What role/protocol should it follow? |
| `.pi/swarm/mailboxes/<agent-id>.jsonl` | What messages were sent to this agent? |
| `.pi/swarm/swarm-state.json.messages` | What is the lifecycle state of each message? |
| `.pi/swarm/traces/events.jsonl` | What happened in the swarm runtime? |
| `swarm_agent_status` | Is an agent alive/idle/busy/tool-running/stopped? |

Missing answers:

- What task is the team working on?
- What files are in scope?
- What are the acceptance criteria?
- Which workflow node is ready, assigned, blocked, or done?
- Which agent owns each node?
- What artifacts/evidence prove the node is complete?
- Which gates must pass before commit?

Without this layer, orchestration depends too much on long prompts from the human/orchestrator. Agents can communicate, but they do not yet have a shared task graph to organize around.

## Design goals

1. Reduce prompt bloat: agents should receive a task id/node id and discover the rest from durable files.
2. Keep the system inspectable: all state should be local files under `.pi/swarm/`.
3. Separate LLM-readable context from machine-updated state.
4. Preserve tmux/file-based architecture for now; do not introduce a daemon yet.
5. Make review/test/commit gates explicit.
6. Support small incremental workflows first, then larger graph automation later.

## Recommended file model

Use a hybrid format:

| Concern | Format | Reason |
| --- | --- | --- |
| Agent identity/protocol | Markdown | Best for LLM + human reading. |
| Task brief | Markdown | Natural for goals, context, scope, acceptance criteria. |
| Mutable task state | JSON | Easy atomic update, lock, query, validate. |
| Reusable workflow graph | YAML later; embedded JSON graph for V1 | YAML is best for hand-authored templates, but V1 should not depend on a YAML parser until workflow loading is implemented. |
| Append-only events | JSONL | Traceable, stream-friendly, easy grep/tail. |
| Reports/evidence | Markdown/log files | Easy review and durable artifacts. |

Proposed layout:

```text
.pi/swarm/
  agents/
    <agent-id>.md

  workflows/                 # optional in V1; introduced when YAML parsing lands
    feature-dev.yaml
    bugfix.yaml
    docs-review.yaml

  tasks/
    <task-id>/
      task.md
      task.json
      events.jsonl
      artifacts/
        plan.md
        implementation-report.md
        review.md
        test-report.md
        final-summary.md
        typecheck.log
        uat.log

  swarm-state.json
  swarm-state.lock/
  mailboxes/
  traces/
```

## Agent identity cards

Keep `.pi/swarm/agents/<agent-id>.md`, but make the work loop mandatory and task-aware.

Template additions:

```md
## Mandatory Swarm Work Loop

On each turn:

1. Read your identity card if you have not already done so.
2. Check your mailbox with `swarm_check_mailbox`.
3. For each message requiring ack:
   - ack `seen` after reading,
   - ack `processing` before doing work,
   - ack `done` or `failed` when finished.
4. If assigned a task node, read:
   - `.pi/swarm/tasks/<task-id>/task.md`
   - `.pi/swarm/tasks/<task-id>/task.json`
   - relevant prior artifacts.
5. Work only within the task scope and allowed files.
6. Write/update required artifacts.
7. Send a result message to the sender/orchestrator.
8. Return to idle.

Do not ask the human to relay inter-agent messages. Use swarm tools.
```

## Task brief: `task.md`

`task.md` is the LLM-readable brief. It should be stable enough that every role can read it without needing a long prompt.

Example:

```md
# Task: Add runtime status tracking

Task ID: `task-20260802-runtime-status`
Workflow: `feature-dev`
Owner: `orchestrator`

## Goal

Add runtime/liveness/status tracking to the swarm extension so the orchestrator can inspect whether agents are starting, busy, idle, tool-running, stopped, and tmux-alive.

## Background

The swarm already supports spawn, mailbox, ACK, reconcile, dead-letter, idempotency, and traces. It needs a first-class status view.

## Scope

Allowed files:

- `.pi/extensions/swarm/index.ts`
- `scripts/swarm_uat.sh`
- `docs/swarm.md`

Out of scope:

- Mini server/daemon.
- Cross-host swarm.
- Major transport rewrite.

## Acceptance Criteria

- `SwarmAgent` has runtime fields.
- Lifecycle events update state.
- `swarm_agent_status` exists.
- Typecheck passes.
- At least one real spawned agent validates status transitions.
- Reviewer approves.
- Orchestrator commits.

## Validation Commands

```bash
NODE_PATH=$(npm root -g) npx tsc --noEmit --module nodenext --moduleResolution nodenext --skipLibCheck --target es2022 --lib es2022 .pi/extensions/swarm/index.ts
```

## Required Evidence

- Diff summary.
- Typecheck output.
- Trace events.
- Reviewer report.
- Commit hash, if committed.
```

## Task state: `task.json`

`task.json` is the machine-readable state file. It should be updated only under a lock.

Example:

```json
{
  "version": 1,
  "taskId": "task-20260802-runtime-status",
  "title": "Add runtime status tracking",
  "status": "in_progress",
  "priority": "normal",
  "createdAt": "2026-08-02T15:30:00.000Z",
  "updatedAt": "2026-08-02T15:45:00.000Z",
  "owner": "orchestrator",
  "workflow": "feature-dev",
  "allowedFiles": [
    ".pi/extensions/swarm/index.ts",
    "scripts/swarm_uat.sh",
    "docs/swarm.md"
  ],
  "start": "plan",
  "currentNodes": ["test"],
  "sharedContext": {
    "summary": "We are adding runtime/liveness/status tracking to the swarm extension.",
    "decisions": [
      {
        "id": "decision-001",
        "by": "orchestrator",
        "at": "2026-08-02T15:31:00.000Z",
        "text": "Keep the implementation file-based and tmux-backed; do not introduce a daemon for this task."
      }
    ],
    "openQuestions": [],
    "risks": [
      {
        "id": "risk-001",
        "by": "reviewer-01",
        "severity": "high",
        "text": "File locks are advisory until enforcement hooks are implemented.",
        "status": "accepted"
      }
    ]
  },
  "nodes": {
    "plan": {
      "status": "done",
      "outcome": "planned",
      "role": "planner",
      "assignee": "planner-01",
      "dependsOn": [],
      "readArtifacts": [],
      "writeArtifacts": ["artifacts/plan.md"],
      "messageIds": ["msg-plan-001"],
      "attempts": 1,
      "maxAttempts": 1
    },
    "implement": {
      "status": "done",
      "outcome": "implemented",
      "role": "implementer",
      "assignee": "implementer-01",
      "dependsOn": ["plan"],
      "allowedFiles": [".pi/extensions/swarm/index.ts"],
      "readArtifacts": ["artifacts/plan.md"],
      "writeArtifacts": ["artifacts/implementation-report.md"],
      "messageIds": ["msg-impl-001"],
      "attempts": 1,
      "maxAttempts": 3
    },
    "test": {
      "status": "in_progress",
      "outcome": null,
      "role": "tester",
      "assignee": "tester-01",
      "dependsOn": ["implement"],
      "readArtifacts": ["artifacts/implementation-report.md"],
      "writeArtifacts": ["artifacts/test-report.md"],
      "messageIds": ["msg-test-001"],
      "attempts": 1,
      "maxAttempts": 3
    },
    "fix": {
      "status": "pending",
      "outcome": null,
      "role": "implementer",
      "assigneePolicy": "same_as:implement",
      "dependsOn": ["test"],
      "allowedFilesFrom": "implement",
      "readArtifacts": ["artifacts/test-report.md"],
      "writeArtifacts": ["artifacts/fix-report.md"],
      "messageIds": [],
      "attempts": 0,
      "maxAttempts": 3
    },
    "review": {
      "status": "pending",
      "outcome": null,
      "role": "reviewer",
      "assignee": "reviewer-01",
      "dependsOn": ["test"],
      "readArtifacts": ["artifacts/implementation-report.md", "artifacts/test-report.md"],
      "writeArtifacts": ["artifacts/review.md"],
      "messageIds": [],
      "attempts": 0,
      "maxAttempts": 2
    },
    "commit": {
      "status": "pending",
      "outcome": null,
      "role": "orchestrator",
      "assignee": "orchestrator",
      "dependsOn": ["review"],
      "terminal": true,
      "writeArtifacts": ["artifacts/final-summary.md"],
      "messageIds": []
    }
  },
  "edges": [
    { "from": "plan", "to": "implement", "when": "planned" },
    { "from": "implement", "to": "test", "when": "implemented" },
    { "from": "test", "to": "review", "when": "passed" },
    { "from": "test", "to": "fix", "when": "failed", "rework": true },
    { "from": "fix", "to": "test", "when": "implemented", "rework": true },
    { "from": "review", "to": "commit", "when": "approved" },
    { "from": "review", "to": "fix", "when": "rejected", "rework": true }
  ],
  "handoffs": [
    {
      "fromNode": "implement",
      "toNode": "test",
      "fromAgent": "implementer-01",
      "toAgent": "tester-01",
      "messageId": "msg-test-001",
      "status": "acked"
    }
  ],
  "gates": {
    "reviewApproved": {
      "status": "open",
      "by": null,
      "artifact": null
    },
    "testsPassed": {
      "status": "open",
      "by": null,
      "artifact": null
    }
  },
  "editLocks": {},
  "evidence": {
    "typecheck": {
      "status": "passed",
      "command": "NODE_PATH=$(npm root -g) npx tsc --noEmit ...",
      "artifact": "artifacts/typecheck.log"
    }
  }
}
```

## Status model

Task statuses:

```text
draft
ready
in_progress
blocked
reviewing
validating
done
failed
cancelled
```

Node statuses:

```text
pending
ready
assigned
in_progress
blocked
done
failed
skipped
```

Gate statuses:

```text
open
passed
failed
waived
```

Node outcome values are branch signals and should be separate from node lifecycle status:

```text
planned
implemented
passed
failed
approved
rejected
changes_requested
needs_clarification
environment_blocked
lock_conflict
skipped
```

Examples:

- Tester ran validation successfully but the feature failed: `status=done`, `outcome=failed`.
- Tester could not run validation because the environment is broken: `status=blocked`, `outcome=needs_clarification` or `environment_blocked`.
- Reviewer completed review and rejects the diff: `status=done`, `outcome=rejected` or `changes_requested`.

## Shared task state

Task state is the common workspace for all agents assigned to the graph. It is not just a node-status map. It should include durable, concise facts that help downstream agents understand what happened before them without rereading every message.

Recommended shared sections:

| Section | Purpose |
| --- | --- |
| `sharedContext.summary` | Short task/team memory. |
| `sharedContext.decisions[]` | Durable decisions with `id`, `by`, `at`, `text`. |
| `sharedContext.openQuestions[]` | Questions that block or influence work. |
| `sharedContext.risks[]` | Known risks, severity, mitigation status. |
| `nodes` | Work units and their lifecycle/outcome/ownership. |
| `edges` | Transition rules between nodes. |
| `handoffs` | Durable record of node-to-node/agent-to-agent transfers. |
| `editLocks` | Advisory file-edit ownership. |
| `evidence` | Pointers to validation/review artifacts. |

Rules:

1. Agents should update `sharedContext` only with durable facts, not chatty commentary.
2. Free-form discussion belongs in mailbox messages and task artifacts.
3. `task.json` should remain compact; large output goes under `artifacts/`.
4. Updates must be scoped: an agent may update its assigned node, write declared artifacts, and add evidence/risks/questions related to that node. Cross-node changes require orchestrator authority or a dedicated graph tool transition.
5. Downstream agents should read prior node artifacts plus `sharedContext` before acting.

## Ownership and overlap prevention

The task graph prevents agents from stepping on each other through three layers.

### 1. Role scope

The role identity card says what the agent may do generally. Example: a reviewer reviews and reports; it does not edit unless explicitly assigned an edit node.

### 2. Node scope

A node names the exact `assignee`, role, files, and artifacts. Tools should reject updates when the current swarm agent id (from `PI_SWARM_AGENT_ID`, exposed internally by `currentAgentId()`) is not the node assignee, unless the current agent is the orchestrator or an override is explicitly allowed.

Example rejection:

```text
Invalid task update: node implement is assigned to dev-01, but current agent is reviewer-01. Reviewers may write review artifacts, not implementation node state.
```

### 3. Advisory edit locks

Before editing, developer/fixer nodes should claim `editLocks` for their allowed files. In V1 this is cooperative, not enforced by pi core edit/write tools. Review/test/commit gates should at least warn if an implementation modified files without a matching node assignment and edit lock. A later enforcement hook can turn this warning into a hard block.

## Workflow templates

Workflow templates should eventually be YAML because they are reusable graph definitions, not mutable runtime state. For V1, however, task creation should not require a YAML parser. `swarm_create_task` should either synthesize a built-in `feature-dev` graph or accept an explicit JSON `nodes` override and persist the resulting graph into `task.json`. YAML parsing can land in a later commit with an explicit dependency.

Example `.pi/swarm/workflows/feature-dev.yaml`:

```yaml
id: feature-dev
description: Standard feature development workflow

roles:
  orchestrator:
    responsibility: Own task graph, assign work, decide commit.
  planner:
    responsibility: Clarify approach and split work.
  implementer:
    responsibility: Make scoped code changes.
  reviewer:
    responsibility: Review diff, check correctness and maintainability.
  tester:
    responsibility: Run validation and collect evidence.

nodes:
  plan:
    role: planner
    prompt: |
      Read task.md. Produce a concise implementation plan.
      Do not edit files.
    outputs:
      - artifacts/plan.md

  implement:
    role: implementer
    dependsOn:
      - plan
    prompt: |
      Read task.md and artifacts/plan.md.
      Implement only allowed files.
      Run required validation.
      Write artifacts/implementation-report.md.
    outputs:
      - artifacts/implementation-report.md

  review:
    role: reviewer
    dependsOn:
      - implement
    prompt: |
      Review git diff and implementation report.
      Do not edit files.
      Write artifacts/review.md with APPROVED or BLOCKED.
    outputs:
      - artifacts/review.md

  test:
    role: tester
    dependsOn:
      - implement
    prompt: |
      Run validation commands from task.md.
      Capture logs and write artifacts/test-report.md.
    outputs:
      - artifacts/test-report.md

  commit:
    role: orchestrator
    dependsOn:
      - review
      - test
    gate:
      review: APPROVED
      tests: passed
    prompt: |
      Commit only scoped files with a focused commit message.
```

## New tools

### `swarm_create_task`

Creates `.pi/swarm/tasks/<task-id>/` with `task.md`, `task.json`, `events.jsonl`, and `artifacts/`.

Input fields:

- `title`
- `goal`
- `workflow`
- `allowedFiles`
- `acceptanceCriteria`
- `validationCommands`
- `priority?`
- `taskId?`: optional explicit id; otherwise generate `task-<timestamp>-<slug>` and normalize with the existing safe-id rules.
- `nodes?`: optional JSON node graph override. If omitted in V1, synthesize the built-in `feature-dev` graph.

### `swarm_task_status`

Reads `task.json` and summarizes task/node/gate state.

Input fields:

- `taskId`
- `includeArtifacts?`
- `runtime?`: include liveness/message warnings using swarm state.

### `swarm_assign_task`

Assigns a workflow node to an agent and sends a structured swarm message. It should reuse an existing idle role agent by default and spawn only when necessary or explicitly requested.

Input fields:

- `taskId`
- `nodeId`
- `agentId?`: exact existing agent to use.
- `reusePolicy?`: `prefer_idle_existing` by default.
- `autoSpawn?`: allow spawning when no reusable agent exists.
- `spawnIsolated?`: force an isolated ephemeral agent for this node.
- `replyTarget?`: where the assignee should send completion/clarification messages.

Behavior:

1. Resolve/validate the assignee using `agentId` or the reuse policy.
2. Update `task.json.nodes[nodeId].assignee`.
3. Set node status to `assigned`.
4. Add task id to assignee `activeTaskIds`.
5. Send `swarm_send_message` with `taskId`, `nodeId`, and a shared `conversationId`.
6. Store message id on the node.
7. Trace `task.assign`.

### `swarm_update_task`

Lets an agent update node status and attach notes/artifacts.

Input fields:

- `taskId`
- `nodeId`
- `status`
- `note?`
- `artifact?`
- `gateUpdates?`
- `sharedContextUpdates?`: append decisions, risks, open questions, or compact summary updates related to the assigned node.

### `swarm_claim_file_lock`

Claims task-scoped file locks before editing. In V1 these locks are **advisory/cooperative**: pi core edit/write tools do not enforce them. Enforcement comes from agent protocol, review gates, and later optional `tool_call` hooks.

Input fields:

- `taskId`
- `nodeId`
- `files`
- `ttlMs?`
- `forceReclaimExpired?`: if true, reclaim expired advisory edit locks during claim.

### `swarm_release_file_lock`

Releases task-scoped file locks.

Input fields:

- `taskId`
- `nodeId`
- `files?`

### `swarm_write_task_artifact`

Writes a task artifact and traces it.

Input fields:

- `taskId`
- `relativePath`
- `content`

### `swarm_find_agent`

Finds reusable agents by role/capability/liveness before assignment.

Input fields:

- `roleKind?`
- `capabilities?`
- `requireIdle?`
- `requireTmuxAlive?`
- `includeBusy?`

### `swarm_task_message`

Sends task-scoped discussion or handoff messages. This is a wrapper around `swarm_send_message` that records handoffs and attaches task metadata.

Input fields:

- `taskId`
- `fromNode`
- `to`
- `subject`
- `body`
- `toNode?`
- `artifactRefs?`
- `replyExpected?`

### `swarm_validate_graph`

Validates task/workflow structure and runtime consistency. It should be available both as an extension tool and a script for CI-style review.

Input fields:

- `taskId` or `path`
- `runtime?`: include agent/message/liveness checks when true.

### `swarm_print_graph`

Prints a task graph in text, Mermaid, or JSON summary form.

Input fields:

- `taskId` or `path`
- `format`: `text`, `mermaid`, or `json`.

### `swarm_next_nodes`

Computes ready nodes based on node statuses, outcomes, dependencies, gates, and edge rules.

Input fields:

- `taskId`
- `autoAssign?`: if true, assign ready nodes using explicit policies where unambiguous.

## V1 locking and atomicity

For V1, use the existing global `.pi/swarm/swarm-state.lock/` mutex for task mutations too. This is coarser than per-task locks but avoids cross-lock deadlocks when `swarm_assign_task` must update task state and send a swarm message in one operation. A later version can generalize to per-task locks with a strict global-first lock ordering.

All hot JSON writes should use temp-file plus rename semantics. This applies to new `task.json` writes and should be back-ported to `swarm-state.json` when task tools are implemented. Plain `writeFile` risks torn/corrupt JSON on crash.

Avoid the naming collision between a lock directory and logical file locks. Use `editLocks` for advisory file-edit claims inside `task.json`; reserve `*.lock/` names for filesystem mutex directories.

## TaskNode field reference

Core node fields:

| Field | Meaning |
| --- | --- |
| `status` | Lifecycle status: pending/ready/assigned/in_progress/blocked/done/failed/skipped. |
| `outcome` | Branch signal emitted when work completes, e.g. passed/failed/approved/rejected. |
| `role` | Required role. |
| `assignee` | Explicit assigned agent id. |
| `assigneePolicy` | Optional policy such as `same_as:implement` used by `swarm_next_nodes` suggestions. |
| `dependsOn` | AND-join dependencies. |
| `allowedFiles` | Files this node may edit. |
| `allowedFilesFrom` | Copy allowed-file scope from another node, useful for `fix`. |
| `readArtifacts` | Artifacts the agent should inspect. |
| `writeArtifacts` | Artifacts the agent should produce. |
| `messageIds` | Assignment/handoff messages associated with this node. |
| `attempts` / `maxAttempts` | Loop control for rework cycles. |
| `terminal` | Marks a graph terminal node. |
| `lastActivityAt` | Optional node-level timestamp updated by task tools; agent heartbeat remains sourced from `swarm_agent_status`. |

## Edge field reference

Core edge fields:

| Field | Meaning |
| --- | --- |
| `from` | Source node id. |
| `to` | Target node id. |
| `when` | Required source-node outcome that activates this edge. |
| `rework` | Allows intentional cycles such as `test -> fix -> test`. |
| `parallel` | Allows multiple edges with the same `from`/`when` to activate concurrently. Defaults false. |
| `handoff` | Optional handoff metadata for assignment messages. |
| `handoff.toRole` | Suggested role for the target node. |
| `handoff.assigneePolicy` | Suggested policy such as `same_as:implement`. |
| `handoff.message` | Short assignment/handoff message template. |

Validation should reject edge references to missing nodes, duplicate non-parallel `from`/`when` transitions, and unmarked cycles.

## Source of truth and transitions

Nodes and gates must not duplicate each other semantically. Recommended rule:

- `node.status` is the lifecycle of the work unit.
- `gates.<gate>.status` is the authoritative commit/release blocker.

For example, review node `done` means the reviewer finished writing a review artifact; `gates.reviewApproved=passed|failed` says whether the review approves commit.

Dependency semantics are AND-join by default: a node becomes ready only when all `dependsOn` nodes are `done` and no relevant gate is failed.

Failure propagation for V1:

- `failed` node blocks dependent nodes.
- `rejected` or `changes_requested` review outcome should re-open the implementation node by setting it back to `ready` or assigning a follow-up implementation node.
- `skipped` only satisfies dependencies if the workflow explicitly marks the dependency optional.
- `cancelled` makes the task terminal unless waived by orchestrator.

`swarm_update_task` should enforce basic transitions, for example `pending -> assigned -> in_progress -> done|failed|blocked`; terminal states should not regress without an orchestrator override.

## Orchestrator-directed replies

The runtime now registers `orchestrator` as a routable pseudo-agent with its own mailbox. Child agents can call `swarm_send_message(to="orchestrator")` without hitting `Unknown swarm agent`; `ensureOrchestrator()` lazily creates/refreshes the record (also on `session_start` for the orchestrator's own session). Because the orchestrator has no dedicated swarm tmux pane, delivery to it is **mailbox-only**: the message is appended to `.pi/swarm/mailboxes/orchestrator.jsonl`, kept in lifecycle status `queued`, and surfaced via `swarm_check_mailbox` / `swarm_agent_status`. It is not treated as a tmux injection failure, and `swarm_reconcile` reports such messages as `awaiting_mailbox_pickup` rather than retrying injection.

Historically the runtime rejected unknown recipients, so earlier reviewers could not reliably reply to `orchestrator`. That gap is closed; task design can simply reply to `orchestrator`, or assign a real coordinator agent id as the reply target per task if preferred.

## Agent reuse and role pools

`swarm_spawn_agent` is a low-level primitive. It intentionally creates a new tmux window for a new agent id because one pane per agent is easy to inspect, capture, and debug. Task graph orchestration should not call it blindly for every node.

Default task assignment should prefer a long-lived, already-running agent that matches the node role/capabilities and is idle. Spawn a new agent only when reuse is impossible or explicit isolation is desired.

Recommended long-lived role pool:

```text
planner-01
implementer-01
tester-01
reviewer-01
observer-01
```

Ephemeral agents are still useful for isolated validation, adversarial review, or experiments, but they should be the exception. Otherwise the tmux session grows unbounded and the team loses continuity.

### Agent metadata needed for reuse

Current `SwarmAgent.role` is a free-text role card. That is useful for humans/LLMs but weak for matching. Task graph V1 should add or derive structured metadata:

```json
{
  "id": "reviewer-01",
  "role": "Review implementation diffs and report blockers.",
  "roleKind": "reviewer",
  "capabilities": ["review", "typescript", "docs"],
  "activeTaskIds": [],
  "maxConcurrentTasks": 1
}
```

`roleKind` should match graph node roles such as `planner`, `implementer`, `tester`, `reviewer`, and `observer`. `capabilities` refine matching when multiple agents have the same role kind. The `health` field is the same persisted/derived health concept exposed by `swarm_agent_status` (`healthy`, `degraded`, `unhealthy`); `tmuxAlive` remains a live check of the target pane.

### Reuse policy

When assigning a node, use this order:

1. If `agentId` is provided, validate and use that exact existing agent.
2. Otherwise find agents where:
   - `roleKind` matches the node role,
   - required capabilities are present,
   - `runtimeStatus` is `idle`,
   - `health` is `healthy`,
   - `tmuxAlive` is true,
   - active task count is below `maxConcurrentTasks`.
3. If one match exists, assign to it.
4. If multiple matches exist, choose the least-loaded agent or return choices to the orchestrator.
5. If no match exists and `autoSpawn=true`, call `swarm_spawn_agent` once to create a new long-lived role agent.
6. If no match exists and `autoSpawn=false`, return a corrective error such as `NO_AVAILABLE_AGENT` with suggested existing candidates or spawn parameters.

### Proposed agent lookup tool

Add a reusable lookup tool before or alongside task assignment. This section is the canonical behavior reference; the New tools list below should cross-reference it instead of duplicating semantics.

```text
swarm_find_agent
```

Input fields:

- `roleKind?`
- `capabilities?`
- `requireIdle?`
- `requireTmuxAlive?`
- `includeBusy?`

Example result:

```json
{
  "matches": [
    {
      "agentId": "reviewer-01",
      "roleKind": "reviewer",
      "runtimeStatus": "idle",
      "health": "healthy",
      "tmuxAlive": true,
      "activeTaskIds": []
    }
  ],
  "recommended": "reviewer-01"
}
```

### `swarm_assign_task` reuse parameters

`swarm_assign_task` should support reuse directly:

```json
{
  "taskId": "task-x",
  "nodeId": "review",
  "agentId": null,
  "reusePolicy": "prefer_idle_existing",
  "autoSpawn": true,
  "spawnIsolated": false
}
```

Important semantics:

- `swarm_send_message(to=<existing-agent-id>)` already delivers to that agent's existing tmux pane.
- `swarm_spawn_agent` should be used only when there is no suitable reusable agent or when `spawnIsolated=true`.
- Reassignment to an existing agent should update `activeTaskIds`/node state and send a task message, not create a new tmux window.
- Assignment completion should remove the task from `activeTaskIds`.

### Validation and cleanup implications

Agent reuse adds new validation checks:

- warn if a node assignment would exceed `maxConcurrentTasks`;
- warn if a role has no reusable agent and `autoSpawn=false`;
- flag stale `activeTaskIds` when a task is terminal;
- ensure an existing agent's tmux target is alive before assignment.

Known V1 cleanup gap: `swarm_assign_task` may add a task id to `activeTaskIds` before dedicated cleanup tooling exists. Until `swarm_update_task` or a lifecycle helper removes completed assignments automatically, validators must flag stale active-task pointers on terminal tasks.

It also implies future lifecycle tools:

- `swarm_stop_agent`: stop one long-lived or ephemeral agent safely;
- `swarm_gc_agents`: list/stop stale ephemeral agents and clean stale active-task pointers;
- `swarm_release_agent_task`: remove an active task assignment after done/failed/cancelled.

## Graph start, edges, and branching

Every workflow instance must have an explicit start node:

```json
{
  "start": "plan",
  "currentNodes": ["plan"]
}
```

Graph execution begins when the human/orchestrator creates a task and assigns the start node. V1 is orchestrator-driven; no daemon automatically starts work.

`currentNodes` is a cached/derived convenience field, not the source of truth. The authoritative state is the per-node `status`, `outcome`, gates, and edges. `swarm_next_nodes` should recompute ready/current nodes and refresh `currentNodes` under lock. It is an array because multiple branches may be ready concurrently in later workflows.

Edges define branch rules. The `when` field matches the source node's `outcome`, not necessarily its lifecycle `status`. Branch conditions belong on edges, not duplicated as `condition` fields on nodes.

```json
{
  "from": "test",
  "to": "fix",
  "when": "failed",
  "rework": true,
  "handoff": {
    "toRole": "implementer",
    "assigneePolicy": "same_as:implement",
    "message": "Tests failed. Read artifacts/test-report.md and fix within allowed files."
  }
}
```

Happy path:

```text
plan -> implement -> test --passed--> review --approved--> commit
```

Failure/rework path:

```text
plan -> implement -> test --failed--> fix -> test
                         review --rejected-> fix -> test
```

A cycle is allowed only when all cycle-forming edges are marked `rework: true` and at least one node in the loop has `maxAttempts` to avoid infinite loops.

## Failure routing

Different failures have different owners:

| Situation | Node status | Node outcome | Next owner |
| --- | --- | --- | --- |
| Tests ran and feature failed | `done` | `failed` | Implementer/fix node |
| Tester could not run due environment | `blocked` | `environment_blocked` | Orchestrator |
| Reviewer completed review but rejects diff | `done` | `rejected` or `changes_requested` | Implementer/fix node |
| Developer cannot proceed due unclear requirement | `blocked` | `needs_clarification` | Orchestrator/planner |
| Agent died or stopped responding | node unchanged/stale | n/a | Orchestrator/reconcile |
| Assignment message dead-lettered | node `assigned` stale | n/a | Orchestrator/reconcile |
| File lock conflict | `blocked` or unchanged | `lock_conflict` | Orchestrator |

The important distinction is: a node can successfully complete its work and still produce a failing outcome. Example: tester node `status=done, outcome=failed` means the tester did its job and the feature needs a fix.

## Dev/tester/reviewer communication

Use two channels:

### Structured task state

Durable facts go through task tools:

- `swarm_update_task`: status/outcome/gate/evidence updates.
- `swarm_write_task_artifact`: reports and logs.
- `swarm_task_status`: current state; may include liveness warnings when requested.
- `swarm_validate_graph`: runtime consistency and liveness/dead-letter checks when `runtime=true`.
- `swarm_next_nodes`: ready next work.

This is the source of truth.

### Mailbox task messages

Clarifications and handoffs go through a task-aware wrapper around swarm messages:

```text
swarm_task_message
```

It should wrap `swarm_send_message` and automatically attach:

- `taskId`
- `fromNode`
- `toNode?`
- `conversationId`
- `replyTarget`
- `artifactRefs[]`

Example flow after test failure:

1. Tester writes `artifacts/test-report.md`.
2. Tester updates node `test` with `status=done, outcome=failed`.
3. Orchestrator or `swarm_next_nodes` activates `fix`.
4. `swarm_assign_task` sends `fix` to the implementer with the test report artifact reference.
5. Developer may ask tester clarification via `swarm_task_message`, but the graph advances only after `swarm_update_task` changes node state.

Mailbox chat never replaces task state. It explains, asks, or hands off; `task.json` records durable truth.

## Graph validation and printing

A graph should be reviewable before and during execution. Provide both a script and, later, extension tools.

### Script

```bash
node scripts/swarm_graph_validate.js .pi/swarm/tasks/<task-id>/task.json
node scripts/swarm_graph_print.js .pi/swarm/tasks/<task-id>/task.json
```

These can be one script with `--format text|mermaid|json` if simpler.

Example text output:

```text
Task: task-add-task-graph — Add task graph orchestration
Status: in_progress
Start: plan
Current: test

Nodes:
  ✓ plan        planner-01    done         outcome=planned
  ✓ implement   dev-01        done         outcome=implemented
  ● test        tester-01     in_progress
  ○ fix         dev-01        pending
  ○ review      reviewer-01   pending
  ○ commit      orchestrator  pending

Edges:
  plan      --planned-----> implement
  implement --implemented-> test
  test      --passed------> review
  test      --failed------> fix      [rework]
  fix       --implemented-> test     [rework]
  review    --approved----> commit
  review    --rejected----> fix      [rework]

Artifacts:
  ✓ artifacts/plan.md
  ✓ artifacts/implementation-report.md
  ○ artifacts/test-report.md
  ○ artifacts/review.md

Validation:
  ✓ all edge sources exist
  ✓ all edge targets exist
  ✓ start node exists
  ✓ terminal node reachable
  ⚠ cycle detected: test -> fix -> test, allowed because rework=true
```

Example Mermaid output:

```mermaid
flowchart TD
  plan["plan ✓ planned"]
  implement["implement ✓ implemented"]
  test["test ● in_progress"]
  fix["fix ○ pending"]
  review["review ○ pending"]
  commit["commit ○ pending"]

  plan -->|planned| implement
  implement -->|implemented| test
  test -->|passed| review
  test -->|failed| fix
  fix -->|implemented| test
  review -->|approved| commit
  review -->|rejected| fix
```

### Validation checks

Structural:

- `taskId`, `start`, and all node ids are valid safe ids.
- `start` exists.
- every `edge.from` and `edge.to` exists.
- every `dependsOn` target exists.
- every non-optional node is reachable from `start`.
- at least one terminal node is reachable.
- branch conditions are not ambiguous; do not allow two edges from the same node with the same `when` unless explicitly marked parallel.
- cycles are rejected unless cycle-forming edges are marked `rework: true`.

Role/agent:

- assigned agents exist in `swarm-state.json.agents`, except pseudo-agent `orchestrator` if enabled.
- assigned agent role matches node role or an override is recorded.
- no stopped/dead agent is assigned a ready/in-progress node without a warning.
- no node assignment exceeds the agent's `maxConcurrentTasks` without an orchestrator override.
- no terminal task leaves stale `activeTaskIds` without a cleanup warning.

Scope/artifact:

- all `allowedFiles`, `readArtifacts`, and `writeArtifacts` stay inside the project/task directories as appropriate.
- artifact paths cannot use `../` path traversal.
- required artifacts for completed nodes exist.
- active nodes do not hold conflicting `editLocks`.

Runtime:

- assigned message ids exist in message lifecycle state.
- messages requiring ack are `acked` before node is considered fully handled.
- stale in-progress nodes are flagged using node `lastActivityAt` plus assignee liveness from `swarm_agent_status`.
- tmux liveness is checked before assignment when `requireTmuxAlive` or `reusePolicy=prefer_idle_existing` is used.
- gates that are `passed` or `failed` point to evidence artifacts.

### Extension tools later

- `swarm_validate_graph`: run validation and return structured warnings/errors.
- `swarm_print_graph`: return text/Mermaid view.
- `swarm_next_nodes`: compute ready nodes and suggested assignments.

## Execution scenarios

These scenarios should become UAT fixtures once task tools are implemented. Each scenario should write a run directory under `.pi/swarm-uat/runs/<run-id>/` with the task directory copy, graph printout, validation output, trace, mailbox snippets, artifacts, and tmux captures.

### Scenario 1: happy-path feature development

Goal: prove the graph can move through plan, implementation, test, review, and commit gates.

Flow:

```text
create_task -> assign plan -> plan done/planned
            -> assign implement -> implement done/implemented
            -> assign test -> test done/passed
            -> assign review -> review done/approved + gate reviewApproved passed
            -> commit ready/done
```

Expected evidence:

- graph print shows only happy-path nodes activated.
- `artifacts/plan.md`, `implementation-report.md`, `test-report.md`, `review.md`, and `final-summary.md` exist.
- assignment messages are acked.
- `swarm_task_status` reports task `done`.
- trace has `task.create`, `task.assign`, `task.update`, `task.artifact.write`, and `task.gate.passed`.

### Scenario 2: test failure and fix loop

Goal: prove branch routing from tester failure back to developer.

Flow:

```text
implement done/implemented
  -> test done/failed
  -> fix ready/assigned to same implementer
  -> fix done/implemented
  -> test done/passed
  -> review
```

Expected evidence:

- first test report says failed.
- fix report references first test report.
- second test report says passed.
- graph print marks `test -> fix -> test` as allowed rework.
- `fix.attempts` increments and does not exceed `maxAttempts`.

### Scenario 3: review rejected and rework

Goal: prove reviewer can block without editing and route work back to developer.

Flow:

```text
test passed -> review done/rejected -> fix -> test -> review done/approved
```

Expected evidence:

- review artifact contains `BLOCKED` with findings.
- gate `reviewApproved` is `failed` or open until the second review.
- commit node is not ready while review is rejected.
- follow-up fix assignment cites `artifacts/review.md`.

### Scenario 4: agent unavailable/dead-letter

Goal: prove assignment failure does not silently stall the graph.

Flow:

```text
assign test to stopped/missing tester -> message failed/dead_letter -> reconcile -> node blocked or reassigned
```

Expected evidence:

- `swarm_reconcile` reports retry/dead-letter action.
- `swarm_task_status` warns assignment agent not alive or message dead-lettered.
- orchestrator can reassign the node to another tester.

### Scenario 5: bad tool call recovery

Goal: prove agents are redirected when they call task tools incorrectly.

Flow examples:

- agent tries to update a node assigned to another agent.
- agent uses invalid transition `pending -> done` without assignment.
- agent writes artifact path `../outside.md`.
- agent omits required `outcome` for a branching node.

Expected evidence:

- tool returns structured validation error with `errorCode`, `message`, `expected`, `received`, and `suggestedNextCall`.
- no state mutation occurs.
- agent retries with corrected parameters.
- trace records `task.tool.invalid` and then successful corrected call.

## Tool-call validation and corrective responses

As the swarm gains more tools, parameter descriptions are not enough. Tools should validate input semantically and return corrective, machine-readable errors that help the LLM recover.

### Validation layers

1. **Schema validation**: Typebox checks required parameter shape.
2. **Normalization**: safe-id normalization for agent ids/task ids/node ids; path normalization for artifacts/files.
3. **Existence checks**: task exists, node exists, agent exists, artifact exists when required.
4. **Ownership checks**: current agent may only update assigned node or allowed shared sections.
5. **Transition checks**: status/outcome changes follow allowed lifecycle and graph semantics.
6. **Scope checks**: allowed files/artifacts remain in project/task directories.
7. **Runtime checks**: target agent alive, assignment message not dead-lettered, stale locks/heartbeats surfaced.

### Error response contract

When a tool call is invalid, prefer throwing an error that includes a compact JSON block in the message. The throw marks the tool result as an error for pi, while the JSON gives the agent enough information to self-correct.

Template:

```json
{
  "ok": false,
  "errorCode": "TASK_NODE_NOT_ASSIGNED_TO_AGENT",
  "message": "Node implement is assigned to dev-01, but current agent is reviewer-01.",
  "taskId": "task-x",
  "nodeId": "implement",
  "expected": {
    "assignee": "dev-01",
    "allowedAction": "reviewer may update node review or send a task message"
  },
  "received": {
    "agentId": "reviewer-01",
    "requestedStatus": "done"
  },
  "suggestedNextCall": {
    "tool": "swarm_update_task",
    "params": {
      "taskId": "task-x",
      "nodeId": "review",
      "status": "done",
      "outcome": "approved",
      "artifact": "artifacts/review.md"
    }
  },
  "doc": "docs/swarm-task-graph.md#tool-call-validation-and-corrective-responses"
}
```

### Common error codes

| Code | Meaning | Suggested recovery |
| --- | --- | --- |
| `TASK_NOT_FOUND` | Unknown task id. | Call `swarm_task_status` without id/list tasks, or ask orchestrator for task id. |
| `TASK_NODE_NOT_FOUND` | Unknown node id for task. | Call `swarm_print_graph` or `swarm_task_status`. |
| `AGENT_NOT_FOUND` | Assignee/reply target is not registered. | Spawn/reuse a valid agent or configure pseudo-agent `orchestrator`. |
| `NO_AVAILABLE_AGENT` | No registered agent satisfies role/capability/idle/liveness constraints. | Relax reuse constraints, choose a busy agent explicitly, or call `swarm_spawn_agent`/enable `autoSpawn`. |
| `NODE_NOT_READY` | Dependencies/gates do not allow assignment yet. | Call `swarm_next_nodes` and assign one of the ready nodes. |
| `NODE_ASSIGNEE_MISMATCH` | Current agent is not node assignee. | Update your assigned node or send a task message to the assignee. |
| `INVALID_TRANSITION` | Requested status/outcome transition is not allowed. | Follow lifecycle sequence or use orchestrator override. |
| `OUTCOME_REQUIRED` | Node has outgoing branches but no outcome was supplied. | Retry with a valid `outcome` matching an edge `when`. |
| `NO_EDGE_FOR_OUTCOME` | Outcome has no matching next edge. | Use a valid outcome or update workflow. |
| `PATH_OUTSIDE_TASK` | Artifact path escapes task artifacts directory. | Use `artifacts/<name>.md` or another allowed relative artifact path. |
| `FILE_OUT_OF_SCOPE` | Agent/node tried to claim/edit a file outside allowed files. | Restrict to node `allowedFiles` or ask orchestrator to expand scope. |
| `EDIT_LOCK_HELD` | Another active node holds the advisory edit lock. | Wait, ask orchestrator, or use stale-lock reclaim if expired. |
| `MESSAGE_DEAD_LETTERED` | Assignment/handoff message failed permanently. | Reassign node or reconcile/requeue. |

### Corrective prompting in tool descriptions

Each task tool should include prompt guidelines that tell the agent what to do after errors. Example:

```text
If `swarm_update_task` returns `OUTCOME_REQUIRED`, retry the same node update with an outcome matching one of the outgoing edges shown in the error. If it returns `NODE_ASSIGNEE_MISMATCH`, do not force the update; send a task message to the assigned agent or ask orchestrator.
```

### No mutation on invalid call

Validation should happen before any write. If validation fails, the tool must not partially update task state, append artifacts, or send messages. Trace the invalid attempt as `task.tool.invalid` with the error code and sanitized parameters.

## Orchestrator-driven graph loop

Version 1 should not implement a daemon. The orchestrator should drive the graph through tools:

```text
1. swarm_create_task
2. spawn/reuse agents for required roles
3. assign all ready nodes with no unmet dependencies
4. wait for message ACKs and task node updates
5. assign newly ready dependent nodes
6. require review/test gates before commit
7. write final artifact and commit scoped files
```

Pseudo-code:

```text
while task not terminal:
  task = swarm_task_status(taskId)
  readyNodes = swarm_next_nodes(taskId)
  for node in readyNodes:
    agent = chooseAgent(node.role)
    swarm_assign_task(taskId, node.id, agent)

  inspect ACKs and node statuses
  if gates failed:
    mark task blocked/failed
  if all terminal gates passed:
    commit/report
```

## Prompt architecture

Use three prompt layers.

### Layer 1: global swarm system protocol

Injected for every swarm agent:

```text
You are running inside pi-swarm, a tmux-backed multi-agent system.
Read your identity card. Communicate with peers using swarm tools. Acknowledge task messages. Work only on assigned task scope. Write required artifacts. Never ask the human to relay inter-agent messages.
```

### Layer 2: role identity

Read from `.pi/swarm/agents/<agent-id>.md`.

Examples:

- orchestrator owns graph and commits.
- implementer edits allowed files and writes implementation reports.
- reviewer reviews diff, does not edit files unless explicitly assigned.
- tester runs validation and captures evidence.

### Layer 3: task/node assignment

Delivered via mailbox:

```text
You are assigned task <task-id>, node <node-id>.
Read task.md, task.json, and prior artifacts. Follow your role protocol and update the task when done.
```

This replaces long ad hoc prompts.

## Minimal-prompt UAT

Add `scripts/swarm_task_uat.sh` later.

Pass criteria:

1. A task directory is created.
2. `swarm_validate_graph` reports no blocking structural errors.
3. `swarm_print_graph` produces readable text and Mermaid output.
4. Planner writes `artifacts/plan.md`.
5. Implementer writes `artifacts/implementation-report.md`.
6. Reviewer writes `artifacts/review.md` with `APPROVED` or `BLOCKED`.
7. Tester writes `artifacts/test-report.md`.
8. Every assigned message requiring ack reaches `acked` or `failed`.
9. `task.json` nodes progress through assigned/in_progress/done and include branch `outcome` values where needed.
10. Failure/rework scenarios route back to the correct owner.
11. Bad tool calls return structured corrective errors without mutating state.
12. Trace contains `task.create`, `task.assign`, `task.update`, `task.artifact.write`, `task.tool.invalid`, `task.gate.*`, and `task.lock.*`.
13. Orchestrator prompting is measurably short: assignment messages include task metadata instead of restating the whole task brief.

## Incremental implementation plan

### Commit 1: docs/spec

- Add this design doc.
- Add default workflow YAML template.
- Update swarm docs to link to task graph design.

### Commit 2: task create/status tools

- Add task path helpers and types.
- Add TaskState/TaskNode/Gate TypeScript types.
- Add structured agent reuse fields (`roleKind`, `capabilities`, `activeTaskIds`, `maxConcurrentTasks`) with backward-compatible defaults for existing agents.
- Add path helpers for `.pi/swarm/tasks/<task-id>/`.
- Add `swarm_create_task`.
- Add `swarm_task_status`.
- Add `swarm_find_agent`.
- Use temp-file + rename for `task.json`; back-port atomic writes to `swarm-state.json`.
- Use the existing global lock for V1 task mutations.
- Trace `task.create`, `task.status.read`, and `agent.find`.

### Commit 3: graph validation and printing

- Add `swarm_validate_graph` and `swarm_print_graph`.
- Add script entrypoints for validating/printing task JSON.
- Validate structure, roles/agents, paths/artifacts, runtime message references, and allowed rework cycles.
- Emit text and Mermaid graph views.

### Commit 4: assign/update and task messaging

- Add `swarm_assign_task`.
- Add `swarm_update_task`.
- Add `swarm_task_message` for task-scoped chat/handoffs.
- Include `taskId`/`nodeId`/`replyTarget` in message headers/details.
- Store assignment message ids in task state.
- Enforce basic node/gate transition rules.
- Keep gates as the authoritative commit blockers.
- Return structured corrective errors for invalid calls and trace `task.tool.invalid`.

### Commit 5: artifacts and file locks

- Add `swarm_write_task_artifact`.
- Add `swarm_claim_file_lock`.
- Add `swarm_release_file_lock`.
- Make locks advisory/cooperative in docs and tool descriptions.
- Enforce stale lock expiry using the existing lock stale timeout.

### Commit 6: prompt/identity hardening

- Add mandatory task-aware work loop to identity cards.
- Add global swarm protocol to `before_agent_start`.
- Ensure child agents know to use task tools.

### Commit 7: task graph UAT

- Add `scripts/swarm_task_uat.sh`.
- Validate with `glm-5.1` and provider `zai-coding-cn` by default for new work.
- Cover happy path, test failure/fix loop, review rejected/rework loop, agent unavailable/dead-letter, and bad tool-call recovery.
- Assert task graph state, graph print output, validation output, artifacts, message ACKs, and traces.

## Recommendation

Adopt the hybrid model:

```text
Markdown for meaning.
JSON for mutable state.
YAML for reusable graph templates.
JSONL for events.
```

This keeps the swarm transparent to humans while giving tools a reliable state model. It is the smallest step from the current working prototype toward a more natural swarm where agents coordinate around durable tasks instead of long orchestrator prompts.
