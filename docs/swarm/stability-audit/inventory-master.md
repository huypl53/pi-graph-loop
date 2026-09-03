# Stability audit master feature inventory

Synthesis date: current repo state read from `docs/swarm/index.md`, `docs/swarm/architecture.md`, and `docs/swarm/tools.md`.

Note: the four peer inventory artifacts (`inventory-messaging.md`, `inventory-taskgraph.md`, `inventory-lifecycle.md`, `inventory-commands.md`) were not present in `.pi/swarm/tasks/task-stability-audit/artifacts/` at synthesis time, so this master list is based on the canonical docs plus the existing mock-LLM fixture templates in `extensions/mock-llm/fixtures/`.

Priority legend:
- **P0** = engine-critical paths: assignment fencing, response credit, auto-close evidence, reconcile sweeps, wake/escalation
- **P1** = common ops and durability surfaces
- **P2** = UX / cosmetic / command-surface convenience

Surface legend:
- **M** messaging / reconcile
- **T** task graph
- **L** lifecycle / agents / tmux / recovery
- **C** commands / aliases / operator wrappers

---

## 1) Master feature list, deduped across surfaces

| ID | Feature | Surfaces | Priority | Scenario coverage note |
|---|---|---:|---:|---|
| F1 | Assignment fencing: durable assignment delivery, active-attempt fencing, file-scope ownership preflight, stale/superseded attempt rejection, and claim-vs-force boundaries | T, M, L | P0 | Core “don’t let the wrong agent mutate work” path |
| F2 | Response credit chain: `seen` → `processing` → verified `done` with `resultMessageId`, plus response-required gating | M, T | P0 | Must prove result credit is not just an ACK |
| F3 | Auto-close evidence: terminal node updates, outcome requirements on branching nodes, artifact/evidence capture, closure derivation, and closure notifications | T, M | P0 | Must show completion only happens with evidence |
| F4 | Reconcile sweeps: delivery retry, stale mailbox repair, dead-lettering, task drift detection, and stale-signal stamping | M, T, L | P0 | Recovery path for “something is stuck” |
| F5 | Wake / escalation: reminder threading, response-deadline escalation, goal-driven idle nudges, and late-progress recovery | M, T, L, C | P0 | Proves the system can wake itself back up |
| F6 | Durable mailbox delivery/read: append-only mailboxes, pending-only reads, delivered ledger, and mark-delivered semantics | M | P1 | Everyday delivery and inbox inspection |
| F7 | Message lifecycle bookkeeping: ACK statuses (`seen`/`processing`/`done`/`failed`), lifecycle status queries, and response-tracked message state | M | P1 | Needed for correct operator visibility |
| F8 | Idempotency and delivery repair: retry-safe sends, failed tmux injection recovery, intercepted/response-tracked messages, and dead letters | M, L | P1 | Durable error handling beyond the happy path |
| F9 | Task graph creation and inspection: create task, show status, print graph, validate structure, and compute ready/next nodes | T | P1 | Foundational workflow entrypoints |
| F10 | Task node execution semantics: pending/ready/assigned/in_progress/done/failed/blocked/skipped transitions, branch outcomes, shared context, artifacts | T | P1 | The normal task lifecycle surface |
| F11 | Task-scoped discussion/handoffs: `swarm_task_message` / node-to-node coordination without advancing state | T, M | P1 | Clarification channel, not a state transition |
| F12 | Task cancellation and supersession: root-only cancel, revocation of active attempts, rejection of late updates/acks | T, M, L | P1 | Important safety rail, but not one of the core P0 flows |
| F13 | Agent lifecycle operations: spawn, register/adopt, stop, restart, pause/resume | L, C | P1 | Common ops; high value but not usually engine-critical |
| F14 | Identity and role management: `set_role`, capability remap, identity reload, stable identity cards | L, C | P1 | Needed for repurposing agents safely |
| F15 | tmux-backed observability and control: status, attach, capture, sendkeys, pane liveness, trace capture | L, C | P1 | Debugging and incident response surface |
| F16 | Root authority and leadership gating: destructive tool gating, leader claims, stale-leader recovery, and admin-only mutation fences | L, C | P1 | Safety-critical, but more guardrail than core workflow |
| F17 | Model pool selection / preflight / rotation: slot validation, provider/model pick, cooldown, and manual rotate/bench | L, C | P1 | Relevant when validating spawn/restart lanes |
| F18 | Protocol migration: upgrade durable message envelopes to v2 evidence fields without inventing facts | M, C | P1 | One-time operator maintenance, not streaming-heavy |
| F19 | Retention / garbage collection: bounded prune of terminal messages and delivered-ledger capping | M, C | P1 | Maintenance surface; dry-run first |
| F20 | Swarm goal / idle-streak loop: durable goal set/done plus root idle nudges | L, C | P0 | This is part of wake/escalation and deserves P0 coverage |
| F21 | Read-only recovery and status views: attention reports, list/status/trace/graph views, dead-letter inspection | L, M, T, C | P2 | Mostly UX and operator visibility |
| F22 | Slash-command aliasing and command discoverability: `/swarm-*` aliases, short wrappers, and command ergonomics | C | P2 | Pure convenience/UX; low risk |
| F23 | Mailbox reset emergency repair: archive/reset live mailbox state while preserving durable message records | M, C | P2 | Incident-only operator escape hatch |
| F24 | Initial-ready recovery nudge: fresh task left ready/unassigned long enough gets surfaced to root | T, L | P0 | A wake-up signal that prevents silent stalls |

### Dedup notes
- `swarm_send_message`, `swarm_check_mailbox`, `swarm_ack_message`, `swarm_message_status`, and `swarm_reconcile` overlap in a single messaging lifecycle, so they are grouped into F6–F8 rather than split per tool.
- `swarm_update_task`, `swarm_assign_task`, `swarm_next_nodes`, `swarm_task_status`, and `swarm_validate_graph` are grouped under the task-graph semantics in F1/F3/F9/F10/F12/F24.
- `/swarm` commands are treated as wrappers around the same engine features, not separate product features.

---

## 2) Top P0 features: concrete mock-LLM fixture specs

The existing five fixtures establish the style to match:
- `429-mid-edit.jsonl` — streaming text + toolcall + error
- `response-missing-settle.jsonl` — partial response then hang/abort
- `edit-not-persisted.jsonl` — toolcall + claim of success + repeat/no-op loop
- `settled-with-open-assignment.jsonl` — false settle while work remains open
- `drift-then-wake.jsonl` — stall then later recovery turn

### F1 — Assignment fencing / stale attempt rejection

**Proposed fixture:** `assignment-fence-stale-attempt.jsonl`

**Goal:** prove an agent cannot close or mutate a node after its attempt is superseded, and that file-scope ownership preflight blocks conflicting work.

**Turn sketch:**
1. **Turn 1** — agent receives an assignment, acknowledges it, and starts work.
   ```json
   {"type":"text","delayMs":15,"text":"I’ve got the assignment and I’m checking the node state.","chunks":["I’ve got the assignment ","and I’m checking the node state."]}
   {"type":"toolcall","delayMs":15,"name":"swarm_check_mailbox","id":"mb-1","arguments":{"pendingOnly":true,"markDelivered":true}}
   {"type":"toolcall","delayMs":15,"name":"swarm_ack_message","id":"ack-1","arguments":{"messageId":"<assignment-id>","status":"processing"}}
   ```
2. **Turn 2** — the node is now superseded or the write scope conflicts; agent attempts the stale update anyway.
   ```json
   {"type":"text","delayMs":20,"text":"I’m ready to close this out.","chunks":["I’m ready to ","close this out."]}
   {"type":"toolcall","delayMs":15,"name":"swarm_update_task","id":"upd-1","arguments":{"taskId":"<task-id>","nodeId":"<node-id>","status":"done","outcome":"implemented","attemptId":"<stale-attempt-id>","artifact":"artifacts/evidence.md"}}
   ```
3. **Turn 3** — agent handles the rejection cleanly and does not pretend success.
   ```json
   {"type":"text","delayMs":15,"text":"That attempt is fenced off; I need the current assignee or a fresh assignment.","chunks":["That attempt is fenced off; ","I need the current assignee or a fresh assignment."]}
   {"type":"stop","delayMs":5,"reason":"stop"}
   ```

**Expected transcript shape:**
- ACK to the original assignment
- explicit stale/rejected update path, not a silent pass
- no second completion claim after the reject

**Pass criteria:**
- the fixture produces a stale-attempt rejection path (`ASSIGNMENT_SUPERSEDED`, `OWNERSHIP_REQUIRED`, or equivalent fencing error)
- no terminal success text after the failed update
- the transcript preserves the distinction between “received assignment” and “authorized to mutate”

**Why this is P0:** without fencing, stale workers can overwrite valid work.

---

### F2 — Response credit chain / verified result requirement

**Proposed fixture:** `response-credit-verified-result.jsonl`

**Goal:** prove that a response-required assignment is only credited when the worker sends a real result and then ACKs `done` with that result message id.

**Turn sketch:**
1. **Turn 1** — worker acknowledges receipt and begins processing.
   ```json
   {"type":"text","delayMs":15,"text":"I’m processing the assignment now.","chunks":["I’m processing ","the assignment now."]}
   {"type":"toolcall","delayMs":10,"name":"swarm_ack_message","id":"ack-1","arguments":{"messageId":"<assignment-id>","status":"seen"}}
   {"type":"toolcall","delayMs":10,"name":"swarm_ack_message","id":"ack-2","arguments":{"messageId":"<assignment-id>","status":"processing"}}
   ```
2. **Turn 2** — worker sends a result message that replies to the original assignment thread.
   ```json
   {"type":"toolcall","delayMs":20,"name":"swarm_send_message","id":"msg-1","arguments":{"to":"root","body":"Result: the node is ready to close.","replyTo":"<assignment-id>","conversationId":"task:<task-id>:<node-id>","requiresAck":true}}
   {"type":"text","delayMs":10,"text":"I’ve sent the result message and am closing the response loop.","chunks":["I’ve sent the result message ","and am closing the response loop."]}
   ```
3. **Turn 3** — worker credits the result and finishes.
   ```json
   {"type":"toolcall","delayMs":10,"name":"swarm_ack_message","id":"ack-3","arguments":{"messageId":"<assignment-id>","status":"done","resultMessageId":"<result-message-id>"}}
   {"type":"stop","delayMs":5,"reason":"stop"}
   ```

**Expected transcript shape:**
- seen/processing ACKs appear before the result
- a concrete response message exists in the transcript, not just a terminal ACK
- done ACK references the result message id

**Pass criteria:**
- result message is durable and threaded to the original assignment
- final ACK is `done` and includes the result message id
- no “settled” state is claimed before the result exists

**Why this is P0:** the system must distinguish “I looked at it” from “I actually delivered the work result.”

---

### F3 — Auto-close evidence / closure derivation

**Proposed fixture:** `auto-close-evidence-closure.jsonl`

**Goal:** prove that a node only closes with the correct outcome/artifact evidence, and that the agent does not claim closure on a branching node without an outcome.

**Turn sketch:**
1. **Turn 1** — agent gathers evidence and reports a near-finish state.
   ```json
   {"type":"text","delayMs":15,"text":"I’m at the finish line and checking the closing requirements.","chunks":["I’m at the finish line ","and checking the closing requirements."]}
   {"type":"toolcall","delayMs":15,"name":"swarm_task_message","id":"tm-1","arguments":{"taskId":"<task-id>","fromNode":"<node-id>","to":"root","subject":"Closure evidence check","body":"I have the implementation artifact and I’m validating the terminal outcome.","artifactRefs":["artifacts/proof.md"],"replyExpected":true}}
   ```
2. **Turn 2** — agent attempts to close without an outcome and is corrected by the script or by the tool response.
   ```json
   {"type":"toolcall","delayMs":15,"name":"swarm_update_task","id":"upd-1","arguments":{"taskId":"<task-id>","nodeId":"<node-id>","status":"done","artifact":"artifacts/proof.md"}}
   {"type":"text","delayMs":10,"text":"I still need a branch outcome before I can close this node cleanly.","chunks":["I still need a branch outcome ","before I can close this node cleanly."]}
   ```
3. **Turn 3** — agent retries with a valid outcome and terminal evidence.
   ```json
   {"type":"toolcall","delayMs":15,"name":"swarm_update_task","id":"upd-2","arguments":{"taskId":"<task-id>","nodeId":"<node-id>","status":"done","outcome":"implemented","artifact":"artifacts/proof.md","note":"Closed with evidence attached."}}
   {"type":"stop","delayMs":5,"reason":"stop"}
   ```

**Expected transcript shape:**
- first close attempt is incomplete
- second close attempt includes a valid outcome and artifact evidence
- no ambiguous “done” without proof

**Pass criteria:**
- branching node closure is outcome-gated
- artifact evidence is attached and visible in the transcript
- closure is only claimed once the evidence contract is satisfied

**Why this is P0:** auto-close without evidence is the fastest route to false completion.

---

### F4 — Reconcile sweeps / delivery repair and stale drift

**Proposed fixture:** `reconcile-drift-repair.jsonl`

**Goal:** prove the worker can survive a stale delivery / stale-state window, and that reconcile-style recovery surfaces the right next action.

**Turn sketch:**
1. **Turn 1** — worker starts with stale state or an interrupted mailbox delivery.
   ```json
   {"type":"text","delayMs":15,"text":"I may be looking at stale state; I’m checking what actually landed.","chunks":["I may be looking at stale state; ","I’m checking what actually landed."]}
   {"type":"toolcall","delayMs":15,"name":"swarm_check_mailbox","id":"mb-1","arguments":{"pendingOnly":true,"markDelivered":true}}
   {"type":"hang","delayMs":15,"until":"abort"}
   ```
2. **Turn 2** — after the drift is repaired, the worker wakes up and observes the delivered work or the reconcile result.
   ```json
   {"type":"text","delayMs":15,"text":"The repaired mailbox now shows the assignment; I can continue.","chunks":["The repaired mailbox now shows the assignment; ","I can continue."]}
   {"type":"toolcall","delayMs":10,"name":"swarm_ack_message","id":"ack-1","arguments":{"messageId":"<assignment-id>","status":"processing"}}
   ```
3. **Turn 3** — worker proceeds to a clean close or a well-formed handoff, depending on the recovered state.
   ```json
   {"type":"toolcall","delayMs":15,"name":"swarm_send_message","id":"msg-1","arguments":{"to":"root","body":"Recovered after reconcile; continuing with the assignment.","replyTo":"<assignment-id>","conversationId":"task:<task-id>:<node-id>","requiresAck":true}}
   {"type":"stop","delayMs":5,"reason":"stop"}
   ```

**Expected transcript shape:**
- one stalled/hung turn
- later recovery after the repair window
- no duplicate “I’m done” before the repaired state is observed

**Pass criteria:**
- the recovered turn shows that the worker can continue from reconciled state
- the transcript makes the stale-vs-repaired transition visible
- no dead-letter / stale state is mistaken for success

**Why this is P0:** reconcile is the recovery valve for delivery drift and stale task state.

---

### F5 — Wake / escalation path

**Proposed fixture:** `wake-escalation-reminder.jsonl`

**Goal:** prove that silence turns into a bounded reminder/escalation thread, and that the worker wakes up and responds with fresh progress instead of looping forever.

**Turn sketch:**
1. **Turn 1** — worker is quiet or appears settled while the assignment remains open.
   ```json
   {"type":"text","delayMs":15,"text":"I’ve reviewed the task and I’m waiting for the next cue.","chunks":["I’ve reviewed the task ","and I’m waiting for the next cue."]}
   {"type":"stop","delayMs":5,"reason":"stop"}
   ```
2. **Turn 2** — reminder / nudge arrives; the worker acknowledges the wake-up signal.
   ```json
   {"type":"text","delayMs":15,"text":"I got the reminder and I’m resuming work now.","chunks":["I got the reminder ","and I’m resuming work now."]}
   {"type":"toolcall","delayMs":10,"name":"swarm_ack_message","id":"ack-1","arguments":{"messageId":"<reminder-id>","status":"seen"}}
   ```
3. **Turn 3** — worker sends a real progress/result update tied to the original thread.
   ```json
   {"type":"toolcall","delayMs":15,"name":"swarm_send_message","id":"msg-1","arguments":{"to":"root","body":"Wake-up complete; I’ve resumed and made forward progress.","replyTo":"<assignment-id>","conversationId":"task:<task-id>:<node-id>","requiresAck":true}}
   {"type":"toolcall","delayMs":10,"name":"swarm_ack_message","id":"ack-2","arguments":{"messageId":"<assignment-id>","status":"processing"}}
   ```
4. **Turn 4** — if the work is now complete, the worker closes the loop.
   ```json
   {"type":"toolcall","delayMs":10,"name":"swarm_ack_message","id":"ack-3","arguments":{"messageId":"<assignment-id>","status":"done","resultMessageId":"<result-message-id>"}}
   {"type":"stop","delayMs":5,"reason":"stop"}
   ```

**Expected transcript shape:**
- an idle / quiet turn
- a wake-up turn that acknowledges the reminder
- a follow-through turn with substantive work, not a looped “still waiting” message

**Pass criteria:**
- reminder or escalation thread is visible and credited to the original assignment
- the worker transitions from silent/idle to active progress
- the fixture does not end in another false-settle state

**Why this is P0:** the system needs a reliable way to wake stalled work before humans intervene.

---

## 3) Features where streaming is impractical and OpenAI-completions mock is a better fit

These are not “bad” features; they are just poor candidates for a streaming transcript because the interesting behavior is a single deterministic completion, a command-style response, or a static maintenance action.

| Feature | Better mock style | Why completions wins |
|---|---|---|
| F17 model pool selection / preflight / rotation | OpenAI-completions mock | Mostly command output and discrete state checks; chunked streaming adds no signal |
| F18 protocol migration | OpenAI-completions mock | Maintenance output is deterministic and summary-driven; no need for incremental token behavior |
| F19 retention / garbage collection | OpenAI-completions mock | Dry-run and prune summaries are static operator reports |
| F21 read-only recovery/status views | OpenAI-completions mock | Status, graph, trace, and dead-letter views are inspection results, not streaming conversations |
| F22 slash-command wrappers / aliases | OpenAI-completions mock | Alias behavior is command routing, not model streaming |
| F23 mailbox reset emergency repair | OpenAI-completions mock | The interesting part is the state mutation/report, which is deterministic and not conversational |

**Reasoning pattern:** if the success criterion is “the operator gets the right deterministic report or state change,” completions is simpler, less brittle, and easier to diff than a stream of partial tokens.

---

## 4) Suggested audit batch plan

### Batch 1 — Message credit core
**Targets:** F1, F2, F6, F7, F8

Why:
- concentrates the assignment/response plumbing first
- gives immediate coverage of fencing, ACK lifecycle, and failed-delivery recovery
- establishes the deterministic transcript patterns for later batches

### Batch 2 — Task closure and branch semantics
**Targets:** F3, F9, F10, F11, F12, F24

Why:
- covers task graph creation, transitions, outcomes, evidence, handoff, cancellation, and initial-ready wake-up
- validates the closure path before expanding into broader ops

### Batch 3 — Recovery, wake-up, and operator intervention
**Targets:** F4, F5, F20, F21

Why:
- isolates reconcile and escalation behavior
- good fit for the existing stall / drift / wake fixture style
- ensures the system can recover and re-signal work without human babysitting

### Batch 4 — Lifecycle and maintenance surface
**Targets:** F13, F14, F15, F16, F17, F18, F19, F22, F23

Why:
- groups agent/tmux/admin tooling and static command surfaces
- can use more completions-style mocks where streaming is unnecessary
- keeps maintenance and UX work separate from the core engine-path fixtures

**If the team wants only 3 batches:** merge Batch 4 into Batch 3, but keep F1–F5 in the first two batches so the engine-critical paths are audited earliest.

---

## 5) Short takeaways

1. The real P0s are not just “task graph” or “messaging” in the abstract; they are the interplay between assignment fencing, response credit, closure evidence, reconcile recovery, and wake/escalation.
2. The five existing fixtures are a good style guide: partial text, toolcalls, hangs/aborts, false settle, and recovery wake-up.
3. The command-heavy maintenance surface should mostly use completions-style mocks; the streaming harness is best reserved for the engine-critical conversational paths.
