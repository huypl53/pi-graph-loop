# Architecture Review: Minimal Agent Protocol Proposal

**Reviewer:** `protocol-arch-reviewer` (swarm role: skeptical architecture reviewer)
**Artifact under review:** `docs/swarm/minimal-agent-protocol-proposal.md` (v1 draft, 2026-08-28)
**Scope:** Inferred message lifecycle, tool consolidation, attempt-fencing, durability, concurrency, authority, BC.
**Out of scope:** production code changes (explicit constraint of this assignment).

## Verdict: **APPROVE WITH CONDITIONS**

The design intent — let the engine derive what the evidence already proves, and stop forcing
the LLM to mechanically stamp a second state transition — is correct, and it is compatible
with the durable-state model already used by `mailbox.ts`, `taskgraph.ts`, and `reconcile.ts`.
A worker calling `swarm_update_task` already mutates task state inside the same lock that
records the worker's "done" intent; from that single durable event the engine *can* derive
the terminal lifecycle of an assignment. The proposal is structurally sound.

However, the draft as written leaves four classes of failure mode that the current code
explicitly guards against, and the migration plan does not say how those guards survive the
transition. Those gaps are blockers for shipping this without conditions. The remaining
items are non-blockers that will need to be addressed before the migration window closes.

The proposal should NOT be approved as-is. It should be approved subject to the four blockers
below being resolved in the proposal text (or in the implementation it precedes), with the
non-blockers tracked in the migration plan.

---

## Evidence Map

Implementation files inspected for grounding this review:

- `extensions/swarm/src/mailbox.ts` — `deliverMessageLocked`, `deliver`, `supersedeOpenAssignments`, `supersedeTaskAssignmentMessages`, `enqueueAndDeliver`, response-tracking helpers.
- `extensions/swarm/src/tools/messages.ts` — `swarm_send_message`, `swarm_ack_message`, `swarm_check_mailbox`, `swarm_reconcile`.
- `extensions/swarm/src/tools/tasks.ts` — `swarm_create_task`, `swarm_assign_task`, `swarm_update_task` (claim branch + cancellation fence + attempt fencing), `swarm_task_message`.
- `extensions/swarm/src/taskgraph.ts` — `mintNodeAttempt`, `deriveNodeAttention`, `checkStallNotificationStale`, `checkClosureNotificationStale`, `computeTaskStatus`, `releaseNodeAssignment`.
- `extensions/swarm/src/reconcile.ts` — `reconcileGraphAdvanceLocked`, `reconcileInitialReadyLocked`, `evaluateIdleGoalNudgeLocked`, `evaluateTaskGraphStallNudgeLocked`, `pumpRootMailbox`.
- `extensions/swarm/src/types.ts` — `MessageRecord`, `SwarmMessage`, `TaskNode`, `TaskNodeAttempt`, `MessageResponseStatus`.

---

## BLOCKER 1 — "Done" derivation collapses two distinct terminal states that the current code treats differently

The proposal (§3.2) maps a recipient's `swarm_send_message({ replyTo: originalMessageId })` to
`done`, and separately maps "node reaches `done`/`failed`/`blocked`/`skipped`" to a *matching*
terminal state on the assignment message. The current code maintains **two parallel terminal
concepts that must NOT be conflated**:

- **Recipient ack done** — the worker says "I have processed this message." Carried by
  `MessageRecord.lastAck.status === "done"` and stamped into `status: "acked"` by
  `messages.ts:99`. This is the *only* transition that frees the worker from response debt
  *and* verifies a `requiresResponse` payload via `validateResultMessage`
  (`messages.ts:79-85`).
- **Node reaches terminal** — the *task graph* says "the work is done." Carried by
  `TaskNode.status ∈ TERMINAL_NODE_STATUSES` and computed by `computeTaskStatus` in
  `taskgraph.ts`. This is what lets the *task* close; it does **not** auto-ack the
  assignment message.

Today a single tool call (`swarm_update_task`) emits both — but only because the same code
path stamps `node.lastActivityAt`, the assignment message's `lastAck`, and the task graph
mutation under one `withLock(p)` (`tasks.ts:614-636` and the lock-handoff at
`tasks.ts:518`). If the proposal removes `swarm_ack_message` from the worker surface, then
a worker that calls **only** `swarm_update_task` will *never* set
`MessageRecord.status: "acked"`, which today is what frees the assignee's mailbox from the
assignment and what closes the response-verification branch
(`messages.ts:75-83`). The visible bug:

1. Worker advances node to `done` via `swarm_update_task`.
2. `deriveNodeAttention` will still treat `node.status === "done"` as terminal
   (`taskgraph.ts:215`) and suppress reminders — that part is fine.
3. But `MessageRecord.status` stays `"injected"`, `ackedAt` stays undefined, and the
   durable `lastAck` field is never populated.
4. `runtimeTaskWarnings` will then re-emit `node <id> message <mid> requires ack but is
   injected` forever (`reconcile.ts:63-65`) — *false `ack_missing`-like noise* on a
   correctly-closed node.
5. More importantly, `responseMissingRecords` (`mailbox.ts:42-47`) will continue to count
   this message as response-active (because `rec.status !== "acked"`), so the worker's
   pool reuse gate stays blocked and `runtimeStatus: response_missing` may persist on
   the assignee until the next `swarm_reconcile` sweep.

The proposal's row in §3.2 ("Recipient sends `swarm_send_message({ replyTo })`") for the
`done` transition is also wrong for task-scoped messages. The reply message carries the
**response** (which today requires a separate `swarm_ack_message(status=done,
resultMessageId=...)` to verify per `messages.ts:79-83` and `validateResultMessage` at
`mailbox.ts:55-65`). If `done` is derived from "the recipient sent a reply," then a reply
without an explicit verification step will mark the assignment done *without ever running
`validateResultMessage`* — that is a real safety regression. The proposal should be
specific that `done` (a) requires both a reply AND a verified response payload check, and
(b) is NOT the same event as the node reaching `done`.

**Required condition:** The implementation must keep a single, atomic
"assignment-message-marked-done" event in the durable state when `swarm_update_task`
closes the node, AND must keep `validateResultMessage` running for `requiresResponse`
assignments. A clean way to do this without exposing `swarm_ack_message` to the model is
to move the verification step inside the lock-held branch of `swarm_update_task`'s
terminal transition (it already holds the lock at `tasks.ts:518`). The proposal must state
this explicitly and remove the ambiguity in §3.2.

## BLOCKER 2 — Acceptance criterion "pipeline closes without explicit ACK" is not yet grounded in current code

The acceptance criterion §7 — "A task pipeline closes successfully from assignment →
report/result → node terminal state without an explicit ACK call" — does not currently
hold. Today the worker must do **all** of:

1. `swarm_check_mailbox` (to see the assignment).
2. `swarm_update_task` to advance the node.
3. `swarm_send_message({ replyTo, to: originalSender })` to send the result (if
   `requiresResponse: true`, which `swarm_assign_task` *always* sets — see
   `tasks.ts:431`).
4. `swarm_ack_message({ status: done, resultMessageId })` to verify the response and
   close out the assignment message (`messages.ts:75-83`).

Steps 3 and 4 together are the verification contract. If only step 3 runs, then
`validateResultMessage` is skipped, the response is recorded as `sent` but never
`verified`, and the `response.status` stays `"sent"` rather than `"verified"`
(`mailbox.ts:317-319`). That keeps `responseMissingRecords` non-empty for the assignee,
and the `runtimeStatus: response_missing` signal will fire on the next reconcile tick
(`reconcile.ts:42` — see `isResponseTrackingActive` predicate that returns true while
`response.status !== "verified"`).

So "zero ACK calls" is a stronger claim than the current code supports for
`requiresResponse: true` assignments. The proposal must either:

- (a) Move the response verification into the same code path that calls
  `swarm_send_message` (so a reply implicitly verifies the response — but then the
  `validateResultMessage` checks must still run, and that requires the message record of
  the original to be loaded under the same lock — which is doable from within
  `deliverMessageLocked` if the `replyTo` chain is followed there);
- (b) Keep `swarm_ack_message` available for the worker surface as an explicit
  response-verification step but reframe its semantics as "verify response" only (no
  `seen` / `processing` / lifecycle states); OR
- (c) Lower the assertion to "without an explicit **lifecycle** ACK call" (i.e. still
  call something at `done`, but it's an automatic derivation, not a model action).

The proposal as written picks (c) by implication but calls it "without an explicit ACK
call," which overstates what the implementation will deliver. **Required condition:**
tighten the acceptance criterion to one of (a)/(b)/(c), with the chosen option spelled out
in the migration plan and reflected in §3.2.

## BLOCKER 3 — Attempt fencing has no engine-side answer once `swarm_ack_message` is hidden

The current fencing model is two-layered:

1. **`attemptId` parameter** on `swarm_update_task` — required for non-root
   callers when `node.activeAttemptId` is set, rejected on mismatch with
   `ATTEMPT_TOKEN_MISMATCH` (`tasks.ts:618-636`). This is the worker's primary fence
   against accidentally completing a superseded attempt.
2. **Supersede guard** on `swarm_ack_message` — `messages.ts:61-69` rejects progress acks
   on a superseded message and (when the root waves) accepts them as waived.

If the proposal hides `swarm_ack_message` from the worker surface, then the worker's
*only* interaction with the engine is `swarm_update_task`, `swarm_send_message`, and
`swarm_check_mailbox`. The fence in (1) is preserved (it lives on `swarm_update_task`).
The fence in (2) is **not** — but is it needed?

Consider: a superseded worker calls `swarm_update_task(status=done, attemptId=<old>)`.
Layer (1) rejects with `ATTEMPT_TOKEN_MISMATCH` (`tasks.ts:624-636`). Good — that fence
holds without `swarm_ack_message`.

But consider: a superseded worker calls `swarm_send_message({ replyTo: <old assignment id>,
to: <root>, body: "I finished" })`. This is **NOT** fenced. The reply message
gets a fresh message id, the `original.response.status` flips from `"missing"` to
`"sent"` (`mailbox.ts:317-319`), and a stale worker can still signal work-completion on
an obsolete assignment. If the root then issues `swarm_ack_message(status=done,
resultMessageId=<replyId>)`, the `supersede` guard on the root's *ack* (`messages.ts:61-69`)
saves it — but the root's own view of "who finished what" is now polluted.

The proposal's §5 correctly preserves `swarm_update_task` as the authoritative fenced
mutation, but it is silent on what happens to replies on superseded assignments. A worker
who calls only `swarm_send_message` (no ack path) can still *appear* to satisfy a
superseded assignment via reply. The root must treat every reply on a
superseded/orphaned assignment as informational only, but the current
`deliverMessageLocked` code path flips `response.status` to `"sent"` unconditionally
(`mailbox.ts:317-319`) — no check against `rec.superseded`.

**Required condition:** Either

- (a) Add a `rec.superseded` short-circuit in `deliverMessageLocked`'s reply branch so
  that a reply on a superseded message does NOT flip `response.status` from `"missing"`
  / `"waived"`, OR
- (b) Add a `lastAck`-style derivation that `deriveNodeAttention` consumes to suppress
  the reply from "task completion" inferences, OR
- (c) Explicitly document that "replies on superseded messages are advisory only" and
  remove the `response.status = "sent"` mutation in that branch.

Any of these prevents the root from being misled by a stale worker's reply.

## BLOCKER 4 — `seen`/`processing` derivation introduces false early state when injection and mailbox-read happen concurrently

The proposal (§3.2 row 1) maps both *"message injected into a live pane"* AND *"returned
from `swarm_check_mailbox`"* to `seen`. The current `delivery()` path already records
`st.delivered[to]` on successful injection (`mailbox.ts:307-311`), which is what the
check_mailbox `pendingOnly: true` filter uses (`messages.ts:139`). So a `seen` derivation
from either side is mechanically consistent.

However, the proposal's recommendation in §8 (first row) says *"Record injection
separately; set `seen` on successful mailbox surface/read or a subsequent recipient
action, so terminal rendering is not mistaken for comprehension."* That is the right
direction, but the current `delivered[]` ledger is a **single shared set per recipient**
and conflates three distinct events:

- "Pane was alive and accepted the injection" — `delivered[]` is updated on tmux injection
  success only (`mailbox.ts:307-311`).
- "Agent surfaced the message via `swarm_check_mailbox`" — `delivered[]` is also updated
  here when `markDelivered: true` (`messages.ts:147-153`).
- "Root pump surfaced the message into a TUI delivery" — recorded on
  `consumerReceipts.root.entries` (a different ledger entirely, see
  `reconcile.ts:769-787`).

Splitting `seen` derivation requires at minimum a `surfaceDeliveredAt` and an
`injectionDeliveredAt` field on `MessageRecord` to disambiguate. Without that
disambiguation, the `seen` derivation will be coarser than the evidence (good enough for
"not `dead_letter`", not good enough for "actually read"). The proposal's §3.3 explicitly
acknowledges this distinction but does not commit to a schema split.

There is also a concurrency hazard: `deliver()` writes to `st.delivered[to]` under the
lock held by `enqueueAndDeliver`, but the tmux `sendToPane` call *itself* is an
external side effect that happens inside the lock (`mailbox.ts:158-160`). A pane that
crashes between injection and capture will leave the message as `delivered = true` in
state but unread in tmux. The current pump handles this via `isPanePiLike`
(`mailbox.ts:151-156`), which gates re-injection on subsequent deliveries — but a
`seen` derivation keyed on the `delivered[]` set will report `seen` for a message that
was injected into a pane that subsequently died before the recipient ever acted on it.
This is a *false `seen`*, and the proposal does not address it.

**Required condition:** The implementation must split `delivered[]` (or augment
`MessageRecord` with separate `injectedAt` + `surfaceDeliveredAt` fields, which already
exist partially: `MessageRecord.injectedAt` and `MessageRecord.surfacedAt` in `types.ts:454, 458`)
and ensure the `seen` derivation requires BOTH conditions: a successful pane injection
AND either a `surfacedAt` (TUI delivery) or a successful `check_mailbox(markDelivered)`
read. Today the second condition is recorded on `MessageRecord.surfacedAt` only for
root informational reads (`messages.ts:155-160`); extending it to all
recipients is straightforward but must be in scope of Phase 1.

---

## NON-BLOCKER 5 — Concurrency: assignment-mint + supersede race window

The auto-stamp branch in `deliverMessageLocked` (`mailbox.ts:280-294`) runs inside the
caller's lock and checks `node.assignee !== to` before stamping. A concurrent
`swarm_assign_task` call from a different root lane would race here, but
`swarm_assign_task` itself calls `requireRootAuthority` (`tasks.ts:262`) and
the multi-root policy is strict-reject (`types.ts:553-563`). So the
auto-stamp window is safe under the current leader-lease invariant.

However, the proposal to add `seen`/`processing`/`done` derivation introduces a
*new* lock-held state mutation: setting `seenAt`/`processingAt` on a message record
from inside the `swarm_update_task` lock branch. If `swarm_update_task` (which runs
under `withLock(p)` at `tasks.ts:518`) and `pumpRootMailbox` (which also runs
under `withLock(p)` at `reconcile.ts:660`) both want to write to the same message
record, the existing lock discipline is sufficient — they serialize naturally.

The risk is *not* concurrency but *order*: if the pump sets `seenAt` after the
worker has already called `swarm_update_task` to close the node, the durable sequence
will read `processing -> done -> seen` (out of order on the timeline). The proposal
should specify whether `seenAt` is allowed to post-date `terminalAt`, and if so, the
closure derivation must be terminal-event-ordered (not seen-event-ordered). The current
code's `response.status` tracking (`mailbox.ts:43-47`) is order-tolerant because it keys
off `lastAck.status` rather than timestamp ordering — the proposal should match that
tolerance rather than introduce a stricter one.

## NON-BLOCKER 6 — Direct assignment authority preserved; but supersession + reassign under the new derivation

§5 row 1 is correct: `swarm_assign_task` remains authoritative. The proposal does not
disturb `mintNodeAttempt` (`taskgraph.ts:723-787`), `supersedeOpenAssignments`
(`mailbox.ts:400-456`), or `supersedeTaskAssignmentMessages` (`mailbox.ts:459-516`).
Good.

What the proposal does NOT spell out is how the new `expectResponse` /
`responseDeadlineMs` / `escalateIfSilent` semantics interact with the existing
`supersede*` functions. Today, an assignment that is superseded gets its
`response.status` set to `"waived"` (`mailbox.ts:434-438`) — which is precisely the
"this assignment no longer expects a response" signal the proposal wants to derive.
That mapping should be made explicit so the new fields are not redundantly set on
messages that the engine has already waived.

**Recommendation:** Add a note in §6 (migration) that `response.status === "waived"`
remains the engine's authoritative "no response expected" marker, and that
`expectResponse: true` on a new message whose prior was waived is the only condition
under which the worker is *re*-expected to respond.

## NON-BLOCKER 7 — `swarm_task_message` consolidation loses a real distinction

§4.1 proposes adding `taskId` / `fromNode` / `toNode` / `artifactRefs` to
`swarm_send_message` and deprecating `swarm_task_message`. Looking at the current
implementation (`tasks.ts:837-882`), `swarm_task_message` is not just a wrapper — it
also:

- Validates `fromNode` exists in the task (`tasks.ts:856`).
- Validates `toNode` (optional) exists (`tasks.ts:857`).
- Validates `artifactRefs` paths are safe relative (`tasks.ts:858`).
- Mutates `task.nodes[fromNode].messageIds` to record the message on the source node
  (`tasks.ts:873`).
- Pushes a `handoffs` row only when `toNode` is set (`tasks.ts:874`).
- Uses a `conversationId` shape of `task:<taskId>:<fromNode>-><toNode>` which is
  *different* from the assignment-message shape `task:<taskId>:<nodeId>` used by
  `swarm_assign_task` (`tasks.ts:426`).

The conversation-id shape difference is the load-bearing detail: it is how the
auto-stamp branch in `mailbox.ts:280-294` distinguishes an assignment message
(subject starts with "Task ", conversationId `task:taskId:nodeId`) from a task-scoped
chat message. If the consolidated `swarm_send_message` is to subsume both, the
auto-stamp predicate needs to be re-specified so it does NOT trigger on task-scoped
chat messages that incidentally have `subject: "Task <id> / node X"` patterns. Today
this is OK because only `swarm_assign_task` produces such subjects, but after
consolidation any agent could produce them.

**Recommendation:** Phase 2 should add a server-side gate: the auto-stamp branch
should require either an explicit `taskAssignment: true` opt-in flag on the new
combined message, OR the assignment subject prefix should change to something the
LLM is unlikely to produce by hand (e.g. include an opaque `assignment-<uuid>`
token). Otherwise the auto-stamp could misfire on chat messages, which would
incorrectly set `node.assignee` and silently take a node away from its rightful
assignee.

## NON-BLOCKER 8 — `swarm_next_nodes` and `swarm_print_graph` consolidation: minor fencing regression for `swarm_next_nodes`

`swarm_next_nodes` (`tasks.ts:231-275`) does *not* mutate state except for
`task.currentNodes = current` and a `writeTaskState` (`tasks.ts:248-251`). This is a
small but real write under the lock — it keeps `currentNodes` fresh in the durable
task graph so `swarm_task_status` does not return stale values.

If the consolidated `swarm_task_status({ includeReadyNodes: true })` does the same
write under the same lock, no regression. If it does not (e.g. for performance
reasons), `currentNodes` will drift until the next `swarm_update_task` call.

**Recommendation:** Specify in §4.2 that the consolidated read refreshes `currentNodes`
inside the same lock-held read, OR that `currentNodes` is removed as a persisted
field and computed on demand (it is already computed by `computeReadyNodes`, so
removing the persistence is a viable simplification).

## NON-BLOCKER 9 — Backward compatibility window is underspecified

§6 Phase 3 says "retain old-message parsing until the durable-state migration window
is complete." But the proposal does not specify:

- A field-level migration path (does the engine *upgrade* old `requiresAck: true`
  messages on read, or does it leave them in place and treat them as legacy?).
- A deadline after which `requiresAck` records older than N are dead-lettered rather
  than honored.
- The behaviour for a swarm that has `requiresAck: true` AND `expectResponse: true`
  simultaneously in `swarm_send_message` after the schema merge (does the engine
  treat them as AND — both ack and response required — or as OR — either is
  sufficient?).

Today the existing `validateResultMessage` (`mailbox.ts:55-65`) effectively makes
`requiresResponse` *depend* on `requiresAck` (an ack `done` without a verified
result is rejected with `RESPONSE_REQUIRED` at `messages.ts:80`), so the AND semantics
are already implicit. The proposal should make this explicit in §3.1 / §6.

**Recommendation:** Specify the merge semantics in §3.1 (`expectResponse` implies
`requiresAck` for the purposes of durable state; explicit `requiresAck: false` with
`expectResponse: true` is allowed only for non-task messages and is treated as
advisory response-tracking with no response-debt gate), and pin a migration deadline.

## NON-BLOCKER 10 — "Agent lifecycle / admin tools hidden by default" is correct but missing the recovery ergonomics story

§2.3 / §10 list 13 admin/debug tools to hide. The proposal correctly notes that
operator recovery must remain possible. What it does not say is *how* a worker is
expected to recover from a tool surface that does not expose the recovery primitives.
Examples:

- A worker that detects a stale assignment (via `swarm_task_status({ runtime: true })`)
  cannot currently call `swarm_release_agent_task` to clear its own stuck pointer —
  and the proposal's worker surface (4 tools) does not include any release/admin
  primitive. That is correct (a worker should not self-release), but the *operator*
  must run an admin-mode session to clear it. The proposal should name the operator
  workflow ("`/swarm admin` mode or `PI_SWARM_ADMIN_MODE=1`") in §2.3.

- An root that wants to send a `waive` ack on a superseded message
  (`messages.ts:61-69`) currently uses `swarm_ack_message({ waive: true })`. If
  `swarm_ack_message` is hidden from the root's normal surface (§2.2 does
  NOT list it as one of the 8-9), the root loses the ability to waive. The
  proposal should either include `swarm_ack_message({ waive: true })` on the
  root's admin surface or add an equivalent `swarm_waive_message` tool.

**Recommendation:** §2.3 should enumerate the exact recovery paths an operator must
be able to invoke via admin mode: release-agent-task, waive-superseded-ack,
prune-dead-letters, capture-pane, attach-pane, send-keys, restart-agent,
register-agent, reload-identity, set-role, set-paused, gc.

## NON-BLOCKER 11 — `swarm_set_goal` / `swarm_mark_goal_done` disposition

§10 marks these as "Reassess; likely task metadata or admin-only." The proposal notes
that "task-liveness nudge now covers the critical no-goal case" — referring to
`evaluateTaskGraphStallNudgeLocked` in `reconcile.ts:331-475`. That is correct: the
task-stall nudge covers the case of stalled task graphs without needing a goal. But
`evaluateIdleGoalNudgeLocked` (`reconcile.ts:158-235`) handles the case where *no*
tasks exist and the swarm is idle with a goal set — that case is not covered by the
task-stall nudge.

**Recommendation:** Keep `swarm_set_goal` / `swarm_mark_goal_done` on the root
surface (they emit idempotent nudges with anti-loop back-off and trace evidence) or
explicitly document the regression: "After Phase 2, an idle swarm with no tasks and a
set goal will no longer receive a goal-nudge; the operator must rely on
`swarm_task_status` to discover stalled state." Today the project logs show
zero `swarm_set_goal` calls, so the regression may be acceptable — but it should be
called out, not silently dropped.

---

## Summary of Conditions

| # | Severity | Subject | Action required before approval |
|---|---|---|---|
| 1 | BLOCKER | "Done" derivation conflates ack-done and node-done | Specify that `validateResultMessage` runs at terminal node transition; tighten §3.2 |
| 2 | BLOCKER | "Zero ACK calls" claim is stronger than current code supports | Pick (a)/(b)/(c) and reflect in §7 acceptance criterion + Phase 1 plan |
| 3 | BLOCKER | Reply on superseded assignment is not fenced | Add `rec.superseded` short-circuit in `deliverMessageLocked`'s reply branch, or document advisory-only semantics |
| 4 | BLOCKER | `seen` derivation conflates injection, surface, and read | Split `delivered[]` into injection vs surface; require both for `seen`; update Phase 1 schema |
| 5 | non-blocker | Concurrency: ordering between pump-set `seenAt` and worker-set `terminalAt` | Specify event-order independence; match `lastAck`-style tolerance |
| 6 | non-blocker | `expectResponse` interaction with `waived` supersede | Document `response.status === "waived"` as the authoritative "no response" marker |
| 7 | non-blocker | `swarm_task_message` consolidation loses a real distinction | Add server-side gate so auto-stamp branch does not misfire on chat messages |
| 8 | non-blocker | `swarm_next_nodes` consolidation refreshes `currentNodes` | Either preserve the write or remove `currentNodes` as a persisted field |
| 9 | non-blocker | BC window underspecified | Pin schema merge semantics, migration deadline, dead-letter cutoff |
| 10 | non-blocker | Admin tool hiding missing recovery ergonomics | Enumerate exact admin-mode operator workflows in §2.3 |
| 11 | non-blocker | `swarm_set_goal` disposition drops idle-no-task nudge | Either keep on root surface or explicitly accept the regression |

## Recommended disposition

**APPROVE WITH CONDITIONS.** The design is sound and grounded in the durable evidence
the engine already records. The four blockers are mechanical, addressable in Phase 1
(the schema split and `deliverMessageLocked` branch addition), and do not require
rethinking the lifecycle model. Once the conditions above are reflected in the proposal
text and the Phase 1 / Phase 2 migration plans, this can ship without touching the
fencing, scope-preflight, or attempt-mint primitives — which are the load-bearing
safety machinery and should remain undisturbed.

---

# Revision v2 — Delta Re-Review

**Reviewer:** `protocol-arch-reviewer`
**Date:** 2026-08-28
**Artifact under review:** `docs/swarm/minimal-agent-protocol-proposal.md` v2 (lines 270–391, normative `Revision v2` section)
**Scope of delta:** B1–B4 + architecture non-blockers (NB5, NB6, NB7, NB8, NB9, NB10, NB11)
**Out of scope:** production code (unchanged constraint).

## Delta Verdict: **APPROVED** (all four blockers resolved; non-blockers accepted or specified)

The v2 revision is a substantive, contract-grade rewrite of the proposal. It replaces
ambiguous language with normative schema tables, terminal-verification rules, deadline
semantics, feature-gate rollout, role-profile gating, telemetry requirements, and a
mandatory UAT matrix. Every one of my four blockers is directly addressed, and every
non-blocker is either resolved on the merits or explicitly acknowledged with a
contract decision.

The remaining items below are residual observations about *how* the v2 contract will be
implemented, not objections to the contract itself. They are non-blocking and should be
tracked in the implementer's plan review, not reopened at the architecture level.

## Delta Evidence Map (v2 sections)

- §A "Exact lifecycle schema and evidence mapping" — schema split
- §B "Terminal and response-verification rules" — terminal verification + reply fencing
- §C "Deadline, TTL, attempts, and compatibility-derived attention" — deadline semantics
- §D "Feature gate, migration, and rollout" — gate + AND-semantics BC
- §E "Role-profile tool gating and recovery access" — admin workflows
- §F "Consolidation details that must retain semantics" — taskAssignment token + currentNodes derivation
- §G "Telemetry and release acceptance" — `tool.invoked` trace + acceptance gate
- §H "Mandatory tmux UAT matrix" — 10 explicit scenarios
- §I "Revised implementation work breakdown" — 5 work units

## Blocker Resolution

### B1 — "Done" derivation conflates ack-done and node-done → **RESOLVED**

v2 §B.1 explicitly mandates: "When an assigned recipient performs a fenced
`swarm_update_task` terminal transition, the existing lock-held update branch must
locate its active assignment message and run the equivalent of today's
`validateResultMessage` / response-debt release logic."

This is exactly the contract option I preferred in my v1 review. It places the
response verification inside the same `withLock(p)` branch that `swarm_update_task`
already holds at `tasks.ts:518`, which means:
- `MessageRecord.status` will be set to `acked` atomically with the node transition.
- `validateResultMessage` runs against the same durable state, not against a
  separate later call.
- `responseMissingRecords` (`mailbox.ts:42-47`) cannot race the close.
- `runtimeStatus: response_missing` is impossible to leave lingering on a closed node.

Also §B.4 nails the second axis of B1 — response-received vs node-terminal are
distinct evidence, and a record is "fully terminal only when its configured contract
is satisfied: a required result response is verified **and** the matching fenced
node reaches terminal."

### B2 — "Zero ACK calls" claim overstates current code → **RESOLVED**

v2 §B.5 reframes the acceptance criterion precisely: "The acceptance criterion is
revised from 'zero ACK calls' to 'zero normal-workflow calls to `swarm_ack_message`
under gate=1`." And §B.2 commits to auto-verification on accepted reply: "Accepted
replies auto-populate and verify `response.*`, set `respondedAt`, and release
response debt when the response contract is satisfied."

Combined with §B.1 (terminal-update also verifies), this delivers option (a) from my
v1 review — auto-verify on both paths — without surfacing any explicit lifecycle-ACK
tool to the worker. The legacy `swarm_ack_message` path remains available for
migration/admin (per §B.5 + §D gate=0 fallback), so existing durable messages stay
readable.

This also implicitly closes NB9 (BC semantics): §D specifies "Legacy `requiresAck`
and new `expectResponse` coexist during the window with **AND semantics** when both
appear: the stricter response obligation wins."

### B3 — Reply on superseded assignment not fenced → **RESOLVED**

v2 §B.3 is explicit: "A reply to a superseded/cancelled assignment is preserved as
an audit event but must not alter the old record from waived/superseded to
`sent`/verified, must not clear debt for a current assignment, and emits
`message.reply_rejected_superseded`."

This is the strongest possible fence — the reply is recorded (so the audit trail
preserves what the stale worker did) but state is unchanged and a trace event is
emitted. Combined with §B.2 ("accepted only if the original record is not
superseded/cancelled and its task/node/attempt context matches the current
assignment"), the root-side waiver is no longer load-bearing — the fence
moves into the engine.

NB6 (waived as authoritative) is also closed by §B.6: "response.status === 'waived'
remains authoritative for a waived response. A new explicit response expectation
may only be created by a new message/assignment, not by a late reply to the waived
record."

### B4 — `seen` derivation conflates injection, surface, and read → **RESOLVED**

v2 §A defines a clean separation in the schema table:

| v2 field | Set only by | Meaning |
|---|---|---|
| `injectedAt` | successful tmux injection | Transport receipt; never means seen. |
| `mailboxDeliveredAt` | durable mailbox append | Mailbox transport receipt; never means seen. |
| `surfacedAt` | `swarm_check_mailbox` or explicit receiver tool activity | The API surfaced the envelope. |
| `seenAt` | receipt derivation **after** `surfacedAt` | API-level read receipt. Pane injection alone cannot set this. |

And the invariant at the end of §A: "`injectedAt`, `mailboxDeliveredAt`, and
`delivered[to]` are transport receipts only. `seenAt` requires a distinct
surface/read receipt."

This is exactly the split I asked for. The current `MessageRecord.surfacedAt`
(`types.ts:458`) becomes the canonical surface-read timestamp, generalized from
"root informational" to "any recipient surface" — which is a minimal additive
change.

UAT matrix row 3 in §H confirms the regression test: "Pane injects then recipient
process dies before mailbox read | 1 | `injectedAt` only; no `seenAt`; recovery/
reinject action remains correct."

## Non-Blocker Resolution

### NB5 (event-order independence) → **ACCEPTED**
Implicit in v2 §A's separate-field design. `seenAt`, `processingAt`, `respondedAt`,
`terminalAt` are independent timestamps; the contract makes no ordering
requirement. Mirrors current `lastAck`-style tolerance.

### NB6 (waived as authoritative) → **RESOLVED** (see B3 above)

### NB7 (taskAssignment token gate) → **RESOLVED**
v2 §F.1: "add explicit structured task metadata plus an explicit `taskAssignment`
boolean/opaque assignment token. Do not infer an assignment from a human-readable
subject such as `Task …`; this prevents accidental mailbox auto-stamp branch misfire."

This is the exact server-side gate I asked for. The auto-stamp branch in
`mailbox.ts:280-294` now requires an explicit opt-in rather than inferring from a
subject pattern.

### NB8 (currentNodes derived, not persisted) → **RESOLVED**
v2 §F.2: "`next_nodes` currently persists `task.currentNodes` under lock. The new
status projection must make `currentNodes` derived at read time and stop relying
on it as authoritative durable state; preserve text, JSON, and Mermaid views via
`format`. Migration must either maintain the legacy field as a cache or remove all
consumers deliberately."

The implementer must choose between "cache" and "remove." Removing is cleaner
(computation is cheap, `computeReadyNodes` is the source of truth); caching is
safer for unknown consumers. Either is acceptable per the contract. Implementation
note (not a blocker): I recommend `remove` because the field is computed from
`node.status` which is itself durable, so the cache adds no resilience.

### NB9 (BC window + AND-semantics + migration deadline) → **RESOLVED**
v2 §D specifies:
- Two stable releases migration window
- AND semantics when `requiresAck` + `expectResponse` coexist
- Idempotent admin migration tool (re-runnable) with `protocol.migration.completed` trace
- "No old record is discarded or dead-lettered merely because it lacks v2 fields"
- End-of-window review checklist (migrated-state audit, stale records, dead-letter effects, deadline traces, ACK-call count, UAT evidence)

### NB10 (admin-mode tool enumeration) → **RESOLVED**
v2 §E explicitly enumerates the operator recovery workflows to document and test:
"release stale assignment, waive/supersede legacy response debt, prune/dead-letter
inspection, capture/attach/send keys, restart/register agent, reload identity,
role/pause changes, and GC."

Also §E: "Identity-card generation must stop instructing normal workers to call
explicit ACK; reload/regenerate identities under gate=1." — this closes the
behavioral drift where identity prompts could re-teach the old protocol.

### NB11 (swarm_set_goal disposition) → **RESOLVED**
v2 §E: "`swarm_set_goal` and `swarm_mark_goal_done` remain root tools: they
retain the legitimate idle-no-task goal-nudge use case. Their current low use is
not a basis for removal."

Also UAT row 8 in §H confirms the regression test: "Root goal with no task |
1 | Goal tools available; goal-nudge behavior still works."

## Additional Strengths in v2

These were not in my v1 findings but are load-bearing in v2:

1. **§C deadline semantics** explicitly rejects the dangerous pattern of
   converting a response deadline into a dead letter. The implementation must use
   reconcile-driven deadline evaluation, never TTL/attempts bypass. This is a
   stronger correctness invariant than my v1 NB9 implied.

2. **§D gate=0 shadow mode** is the right way to ship the inference code without
   behavioral risk: "Phase-1 inference runs in shadow/telemetry mode only and
   cannot change completion/recovery decisions." This means the schema fields and
   `message.lifecycle_derived` traces can be deployed and validated before any
   semantics change.

3. **§G `tool.invoked` trace** closes the measurement gap. The v1 review noted
   that the project logs (4,466 `swarm_ack_message` calls) were the *only* evidence
   of legacy ACK usage. The new trace gives the engine its own measurement.

4. **§H UAT matrix** is genuinely mandatory, not aspirational — §G says
   "implementation cannot ship until the following are demonstrated." All four
   blocker regressions have dedicated scenarios (rows 2, 3, 5, 6), and several
   non-blocker regressions are covered too (rows 7, 8, 9, 10).

## Residual (Non-Blocking) Observations for the Implementer

These are not objections to the contract — they are implementation hazards that
should be addressed in the implementer's plan review, not at this architecture level.

**R1.** §B.2 says accepted replies must match "task/node/attempt context" with the
*current* assignment. The implementer must be careful that this match is computed
under the same `withLock(p)` the reply is enqueued under, otherwise a concurrent
reassignment could let a stale reply validate against a fresh node. Use the
existing `deliverMessageLocked` lock-held path (`mailbox.ts:230`) and read the
`node.assignmentMessageId` after acquiring the swarm lock, not before.

**R2.** §F.1 introduces a `taskAssignment` boolean/opaque token. The implementer
should choose ONE shape (boolean vs opaque) and document the choice — a boolean is
simpler but exposes the auto-stamp intent to the model; an opaque server-generated
token is safer. Recommend opaque UUID.

**R3.** §A's `mailboxDeliveredAt` field is new. The current `st.delivered[to]` set
is the source of truth for injection + mailbox-only delivery; the field name
collision is mild but worth a brief note in the migration section so the implementer
doesn't confuse the two.

**R4.** §D's "two stable releases" window should be tied to a release-version
constant (e.g. `MINIMAL_PROTOCOL_COMPAT_RELEASE`), not left as an editorial promise,
so the implementer can test the end-of-window audit trail deterministically.

**R5.** §G's `tool.invoked` trace is a per-tool wrapper. The implementer should
place it in the common registration path (already exists in `tools/gating.ts` per
my earlier read), not in each tool's `execute`, so coverage is guaranteed.

## Delta Summary Table

| v1 finding | v2 resolution |
|---|---|
| B1 done-derivation conflates two terminals | §B.1, §B.4 |
| B2 zero-ACK AC overstated | §B.5, §B.2 |
| B3 reply on superseded not fenced | §B.3 |
| B4 seen-derivation conflates events | §A (schema split) |
| NB5 event-order independence | §A (implicit, separate fields) |
| NB6 waived authoritative | §B.6 |
| NB7 taskAssignment token gate | §F.1 |
| NB8 currentNodes derived | §F.2 |
| NB9 BC window + AND-semantics | §D |
| NB10 admin-mode tool enumeration | §E |
| NB11 goal tools disposition | §E |

## Verdict on v2

**APPROVED.** Every blocker is resolved by a normative contract section; every
non-blocker is either resolved on the merits or explicitly acknowledged. The
remaining items (R1–R5) are implementer-level hazards that belong in the plan
review, not in this architecture review. The proposal is ready for implementation
gating per §D and §G.
