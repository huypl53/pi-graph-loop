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
  "nodes": {
    "plan": {
      "status": "done",
      "role": "planner",
      "assignee": "planner-01",
      "dependsOn": [],
      "outputs": ["artifacts/plan.md"],
      "messageIds": ["msg-plan-001"]
    },
    "implement": {
      "status": "done",
      "role": "implementer",
      "assignee": "implementer-01",
      "dependsOn": ["plan"],
      "outputs": ["artifacts/implementation-report.md"],
      "messageIds": ["msg-impl-001"]
    },
    "review": {
      "status": "done",
      "role": "reviewer",
      "assignee": "reviewer-01",
      "dependsOn": ["implement"],
      "outputs": ["artifacts/review.md"],
      "messageIds": ["msg-review-001"]
    },
    "test": {
      "status": "done",
      "role": "tester",
      "assignee": "tester-01",
      "dependsOn": ["implement"],
      "outputs": ["artifacts/test-report.md"],
      "messageIds": ["msg-test-001"]
    },
    "commit": {
      "status": "ready",
      "role": "orchestrator",
      "assignee": "orchestrator",
      "dependsOn": ["review", "test"],
      "outputs": []
    }
  },
  "gates": {
    "reviewApproved": {
      "status": "passed",
      "by": "reviewer-01",
      "artifact": "artifacts/review.md"
    },
    "testsPassed": {
      "status": "passed",
      "by": "tester-01",
      "artifact": "artifacts/test-report.md"
    }
  },
  "fileLocks": {
    ".pi/extensions/swarm/index.ts": {
      "holder": "implementer-01",
      "nodeId": "implement",
      "acquiredAt": "2026-08-02T15:32:00.000Z",
      "expiresAt": "2026-08-02T16:32:00.000Z"
    }
  },
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

### `swarm_assign_task`

Assigns a workflow node to an agent and sends a structured swarm message.

Behavior:

1. Update `task.json.nodes[nodeId].assignee`.
2. Set node status to `assigned`.
3. Send `swarm_send_message` with `taskId`, `nodeId`, and a shared `conversationId`.
4. Store message id on the node.
5. Trace `task.assign`.

### `swarm_update_task`

Lets an agent update node status and attach notes/artifacts.

Input fields:

- `taskId`
- `nodeId`
- `status`
- `note?`
- `artifact?`
- `gateUpdates?`

### `swarm_claim_file_lock`

Claims task-scoped file locks before editing. In V1 these locks are **advisory/cooperative**: pi core edit/write tools do not enforce them. Enforcement comes from agent protocol, review gates, and later optional `tool_call` hooks.

Input fields:

- `taskId`
- `nodeId`
- `files`
- `ttlMs?`

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

## V1 locking and atomicity

For V1, use the existing global `.pi/swarm/swarm-state.lock/` mutex for task mutations too. This is coarser than per-task locks but avoids cross-lock deadlocks when `swarm_assign_task` must update task state and send a swarm message in one operation. A later version can generalize to per-task locks with a strict global-first lock ordering.

All hot JSON writes should use temp-file plus rename semantics. This applies to new `task.json` writes and should be back-ported to `swarm-state.json` when task tools are implemented. Plain `writeFile` risks torn/corrupt JSON on crash.

Avoid the naming collision between a lock directory and logical file locks. Use `editLocks` for advisory file-edit claims inside `task.json`; reserve `*.lock/` names for filesystem mutex directories.

## Source of truth and transitions

Nodes and gates must not duplicate each other semantically. Recommended rule:

- `node.status` is the lifecycle of the work unit.
- `gates.<gate>.status` is the authoritative commit/release blocker.

For example, review node `done` means the reviewer finished writing a review artifact; `gates.reviewApproved=passed|failed` says whether the review approves commit.

Dependency semantics are AND-join by default: a node becomes ready only when all `dependsOn` nodes are `done` and no relevant gate is failed.

Failure propagation for V1:

- `failed` node blocks dependent nodes.
- `blocked` review should re-open the implementation node by setting it back to `ready` or assigning a follow-up implementation node.
- `skipped` only satisfies dependencies if the workflow explicitly marks the dependency optional.
- `cancelled` makes the task terminal unless waived by orchestrator.

`swarm_update_task` should enforce basic transitions, for example `pending -> assigned -> in_progress -> done|failed|blocked`; terminal states should not regress without an orchestrator override.

## Orchestrator-directed replies

The current runtime does not register `orchestrator` as a routable swarm agent, so child agents cannot reliably `swarm_send_message` to `orchestrator` today. V1 task design should handle this explicitly by either:

1. creating a pseudo-agent record/mailbox for `orchestrator`, or
2. assigning a real coordinator agent id as the reply target for each task.

This gap surfaced during review of this document: both glm-5.1 reviewers attempted or considered `swarm_send_message` to `orchestrator`, but the extension rejects unknown recipients.

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
  readyNodes = nodes where status=pending and dependencies=done
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
2. Planner writes `artifacts/plan.md`.
3. Implementer writes `artifacts/implementation-report.md`.
4. Reviewer writes `artifacts/review.md` with `APPROVED` or `BLOCKED`.
5. Tester writes `artifacts/test-report.md`.
6. Every assigned message requiring ack reaches `acked` or `failed`.
7. `task.json` nodes progress through assigned/in_progress/done.
8. Trace contains `task.create`, `task.assign`, `task.update`, `task.artifact.write`.
9. Orchestrator prompt is intentionally short; workflow details come from task/workflow files.

## Incremental implementation plan

### Commit 1: docs/spec

- Add this design doc.
- Add default workflow YAML template.
- Update swarm docs to link to task graph design.

### Commit 2: task create/status tools

- Add task path helpers and types.
- Add TaskState/TaskNode/Gate TypeScript types.
- Add path helpers for `.pi/swarm/tasks/<task-id>/`.
- Add `swarm_create_task`.
- Add `swarm_task_status`.
- Use temp-file + rename for `task.json`; back-port atomic writes to `swarm-state.json`.
- Use the existing global lock for V1 task mutations.
- Trace `task.create` and `task.status.read`.

### Commit 3: assign/update tools

- Add `swarm_assign_task`.
- Add `swarm_update_task`.
- Include `taskId`/`nodeId`/`replyTarget` in message headers/details.
- Store assignment message ids in task state.
- Enforce basic node/gate transition rules.
- Keep gates as the authoritative commit blockers.

### Commit 4: artifacts and file locks

- Add `swarm_write_task_artifact`.
- Add `swarm_claim_file_lock`.
- Add `swarm_release_file_lock`.
- Make locks advisory/cooperative in docs and tool descriptions.
- Enforce stale lock expiry using the existing lock stale timeout.

### Commit 5: prompt/identity hardening

- Add mandatory task-aware work loop to identity cards.
- Add global swarm protocol to `before_agent_start`.
- Ensure child agents know to use task tools.

### Commit 6: task graph UAT

- Add `scripts/swarm_task_uat.sh`.
- Validate with `glm-5.1` and provider `zai-coding-cn` by default for new work.
- Assert task graph state, artifacts, message ACKs, and traces.

## Recommendation

Adopt the hybrid model:

```text
Markdown for meaning.
JSON for mutable state.
YAML for reusable graph templates.
JSONL for events.
```

This keeps the swarm transparent to humans while giving tools a reliable state model. It is the smallest step from the current working prototype toward a more natural swarm where agents coordinate around durable tasks instead of long orchestrator prompts.
