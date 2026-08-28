# Proposal: Minimal Agent Protocol and Inferred Message Lifecycle

**Status:** Draft for swarm review  
**Date:** 2026-08-28  
**Scope:** Simplify the model-facing swarm tool surface without removing operational observability or durable recovery semantics.

## 1. Problem statement

The current swarm extension exposes 33 model-callable tools. Project session logs show that the messaging acknowledgement protocol is the largest source of mechanical tool traffic:

| Observation | Evidence from project session logs |
|---|---:|
| `swarm_ack_message` calls | 4,466 |
| `swarm_check_mailbox` calls | 3,188 |
| `swarm_send_message` calls | 1,954 |
| Total parsed tool calls | 55,964 across 479 session logs |

Today, a message with `requiresAck` often requires an agent to remember a non-business workflow:

```text
check mailbox → ack(seen/processing) → do work → send result → ack(done, resultMessageId)
```

A missed acknowledgement can create `ack_missing` or `response_missing` even when useful work and a report already exist. This increases prompt/tool complexity and can stall task closure. The engine already observes the durable events that matter: delivery, mailbox read, assignment, task mutation, reply, timeout, cancellation, and agent liveness.

The design goal is therefore:

> Agents should express work and results. The engine should derive protocol state wherever the evidence is unambiguous.

This proposal does **not** weaken task ownership, attempt fencing, message persistence, or auditability.

## 2. Desired model-facing surface

### 2.1 Worker surface: four tools

Workers should normally see only:

```text
swarm_check_mailbox
swarm_send_message
swarm_update_task
swarm_task_status
```

Workers do not need direct lifecycle, tmux, graph-creation, repair, or explicit acknowledgement APIs.

### 2.2 Orchestrator surface: thirteen tools

The normal orchestrator surface is **13 tools** (the five worker tools plus six orchestration tools plus two goal tools):

```text
# inherited worker tools (5)
swarm_check_mailbox
swarm_send_message
swarm_update_task
swarm_task_status
swarm_reconcile

# orchestration tools (6)
swarm_agent_status
swarm_list_agents
swarm_spawn_agent
swarm_create_task
swarm_assign_task
swarm_reconcile                    # mutation mode, orchestrator-only

# no-task goal controls (2)
swarm_set_goal
swarm_mark_goal_done
```

`swarm_reconcile` is one tool with role-dependent execution mode and is counted once in the active set. The exact normal orchestrator registry therefore has **12 distinct tool names**: 5 worker tools + 5 additional orchestration tools + 2 goal tools. The former eight-to-nine estimate is superseded; if reporting capabilities rather than registrations, dry-run and mutation reconcile are two separate capabilities (13 capabilities total).

### 2.3 Admin/debug surface: hidden by default

The following should remain implemented but be unavailable to the normal model tool registry. They should be available through explicit admin/debug mode or `/swarm` commands:

```text
swarm_prune
swarm_dead_letters
swarm_send_keys
swarm_attach_agent
swarm_capture_agent_pane
swarm_trace
swarm_reload_identity
swarm_release_agent_task
swarm_register_agent
swarm_restart_agent
swarm_set_agent_paused
swarm_set_role
swarm_gc
```

This preserves recovery capability while reducing accidental and distracting choices.

## 3. Replace explicit acknowledgement with inferred lifecycle

### 3.1 Public message intent

Replace the model-facing `requiresAck` flag with response-oriented intent:

```ts
expectResponse?: boolean;
responseDeadlineMs?: number;
escalateIfSilent?: boolean;
```

`requiresAck` remains accepted internally during migration for existing durable messages, but is not exposed in normal tool schemas.

### 3.2 Engine-derived states

| Durable evidence | Derived lifecycle transition |
|---|---|
| Message injected into a live pane or returned from `swarm_check_mailbox` | `seen` |
| Recipient invokes a task-scoped tool for the matching assignment/task | `processing` |
| Recipient sends `swarm_send_message({ replyTo: originalMessageId })` | `done`, linked to the response message |
| Assigned recipient moves its node to `done`, `failed`, `blocked`, or `skipped` | assignment message reaches matching terminal state |
| Task is cancelled/superseded, recipient dies, or deadline expires | `cancelled`, `failed`, or `expired` as applicable |
| Message is delivered but no observed progress reaches its deadline | stale/escalation signal; **not** an `ack_missing` error |

The engine retains the complete receipt/evidence history in message records and traces. The difference is that the LLM no longer manually stamps a second state transition.

### 3.3 Important distinction: delivery is not understanding

A delivery receipt proves only that a message reached an inbox/pane. It must not be represented as completion. The lifecycle should keep separate fields such as:

```ts
mailboxDeliveredAt?: string;
seenAt?: string;
processingAt?: string;
respondedAt?: string;
terminalAt?: string;
```

`seenAt` is evidence of surfacing/read, not proof that the agent understood or completed the request. The actual safety mechanism is the deadline plus observed task/reply activity.

## 4. Tool consolidation

### 4.1 Merge task message into send message

`swarm_task_message` is a thin task-context wrapper around `swarm_send_message`.

Add optional fields to `swarm_send_message`:

```ts
taskId?: string;
fromNode?: string;
toNode?: string;
artifactRefs?: string[];
```

When `taskId` is supplied, the engine records the same task handoff/audit event currently recorded by `swarm_task_message`. Keep the old wrapper only as a backward-compatible alias during migration, then remove it from normal registration.

### 4.2 Fold graph projections into task status

`swarm_next_nodes` and `swarm_print_graph` are derived views of a task graph. Add to `swarm_task_status`:

```ts
includeReadyNodes?: boolean;
format?: "summary" | "text" | "mermaid" | "json";
includeRuntime?: boolean;
includeArtifacts?: boolean;
```

Migration:

- `swarm_next_nodes` remains an internal/backward-compatible alias for one release.
- `swarm_print_graph` remains an internal/backward-compatible alias for one release.
- Normal model-facing registry exposes `swarm_task_status` only.

### 4.3 Fold lightweight read-only identity/attachment affordances

- Add `includeIdentity?: boolean` to `swarm_agent_status` for the useful identity summary currently read via `swarm_agent_identity`.
- Do not expose `swarm_attach_agent` to the model by default; attach commands belong to `/swarm agents` admin output.

## 5. What remains deliberately separate

The proposal should **not** collapse these responsibilities:

| Capability | Why it remains separate |
|---|---|
| `swarm_assign_task` | Assignment mints attempt leases, records ownership, checks file scope, and sends an assignment; this is not equivalent to generic messaging. |
| `swarm_update_task` | State-machine transition with ownership/attempt fencing; it remains the authoritative graph mutation API. |
| `swarm_reconcile` | Recovery sweep is operationally different from a normal read/status call. |
| `swarm_spawn_agent` | Process lifecycle and model-pool selection have side effects that should remain explicit. |
| Task/stall nudges | Engine-owned recovery, not a tool protocol the worker must memorize. |

## 6. Migration and compatibility

### Phase 1 — inference and telemetry

1. Add inferred receipt/lifecycle fields without changing current tool availability.
2. On old `swarm_ack_message` calls, retain behavior but trace `message.ack_legacy_used`.
3. For new messages, derive lifecycle automatically and emit `message.lifecycle_derived` with its evidence source.
4. Continue recognizing legacy `requiresAck` records on disk.

### Phase 2 — simplify normal tool registry

1. Hide `swarm_ack_message`, `swarm_task_message`, `swarm_next_nodes`, and `swarm_print_graph` from default worker/orchestrator registries.
2. Register aliases only in compatibility/admin mode.
3. Hide lifecycle/debug tools from default model-facing surfaces while keeping slash-command/operator access.

### Phase 3 — remove legacy protocol requirement

1. Deprecate `requiresAck` from normal schemas; use `expectResponse` and deadline/escalation fields.
2. Remove `ack_missing` as a normal workflow failure signal; replace it with response/activity deadline findings.
3. Retain old-message parsing until the durable-state migration window is complete.

## 7. Safety invariants and acceptance criteria

The implementation must preserve these invariants:

1. **No false completion:** delivery/read never means response or task completion.
2. **Fencing preserved:** a stale/superseded worker cannot close a current assignment merely by sending a reply.
3. **Durability preserved:** lifecycle evidence and terminal reasons remain traceable from disk.
4. **No silent loss:** unmet `expectResponse` reaches deadline escalation/reconcile; it is never simply dropped.
5. **Compatibility:** legacy `requiresAck` durable messages continue to be processed safely.
6. **No expanded worker authority:** tool-surface reduction must not enable worker lifecycle/admin actions.
7. **Direct assignment remains authoritative:** `swarm_assign_task`, not a generic message, owns assignment, attempt-minting, and file-scope checks.
8. **Task graph correctness:** task message metadata still records handoffs/artifact references after consolidation.

Suggested measurable acceptance criteria:

- Default worker sees ≤4 swarm tools; default orchestrator sees ≤9.
- `swarm_ack_message` calls drop to zero in a fresh normal workflow.
- A task pipeline closes successfully from assignment → report/result → node terminal state without an explicit ACK call.
- An expected response that never materializes is surfaced by deadline/reconcile with actionable evidence.
- Existing task/message files with `requiresAck` remain readable and reconcile safely.
- Existing attempt-fencing, assignment ownership, cancellation/supersession, and mailbox recovery suites remain green.

## 8. Risks and open decisions

| Question | Options | Recommended direction |
|---|---|---|
| Does pane injection alone set `seen`? | injection-only; mailbox-read-only; either | Record injection separately; set `seen` on successful mailbox surface/read or a subsequent recipient action, so terminal rendering is not mistaken for comprehension. |
| Does any task tool set `processing`? | any tool; matching task/node only | Matching assignment/task only, with trace evidence. |
| Does a reply always terminally satisfy the request? | yes; reply plus semantic classification | Reply marks response received; assignment lifecycle becomes terminal only when its task node reaches terminal status, unless the message is non-task and expects a response only. |
| How long is the compatibility window? | one release; two releases; date-based | At least one stable release plus a state migration/reconcile audit. |
| Who can access hidden admin tools? | slash-only; explicit `PI_SWARM_ADMIN_MODE`; role gate | Slash/admin mode plus strict orchestrator/operator gate. |

## 9. Proposed work breakdown

This is a design proposal, not an implementation commitment. If approved, split work into separately reviewable tasks:

1. **Message lifecycle inference:** durable schema, evidence derivation, legacy compatibility, deadlines/reconcile, tests.
2. **Message/tool consolidation:** `send_message` task fields; compatibility aliases; handoff audit tests.
3. **Task/agent read-surface consolidation:** enhanced `task_status` and `agent_status`; alias migration.
4. **Tool-gating simplification:** worker/orchestrator/admin registry profiles; docs and validation.
5. **Migration/UAT:** old durable states, normal task pipeline with zero ACK calls, stale response escalation, fresh interactive tmux UAT.

## 10. Initial inventory: candidates to hide, merge, or retain

| Current tool | Proposed disposition | Rationale |
|---|---|---|
| `swarm_ack_message` | Hide/deprecate from normal surface | Lifecycle can be inferred from durable evidence. |
| `swarm_task_message` | Merge into `swarm_send_message` | Wrapper-only distinction. |
| `swarm_next_nodes` | Merge into `swarm_task_status` after cache migration | Derived graph projection, but preserve `currentNodes` as a write-through cache in Phase 2; remove legacy writes/readers in Phase 3. |
| `swarm_print_graph` | Merge into `swarm_task_status` | Derived graph rendering. |
| `swarm_message_status` | Admin/diagnostic only | Normal sender needs result/deadline status in status views, not a separate inspection primitive. |
| `swarm_agent_identity` | Fold summary into agent status | Mostly diagnostic read-only data. |
| `swarm_attach_agent` | Slash/admin only | Produces a human tmux command, not a model workflow action. |
| `swarm_set_goal` / `swarm_mark_goal_done` | Reassess; likely task metadata or admin-only | Neither was used in current project logs; task-liveness nudge now covers the critical no-goal case. |
| tmux/recovery/admin tools | Hide from normal surface | Retain implementation for operator recovery, but do not burden worker prompts. |
| `swarm_assign_task` | Retain | Ownership, attempt lease, scope guard, and delivery are authoritative. |
| `swarm_update_task` | Retain | Authoritative fenced graph mutation. |
| `swarm_reconcile` | Retain for orchestrator/admin | Recovery is deliberate and operationally distinct. |

## 11. Review request

Reviewers should specifically challenge:

1. Whether inferred lifecycle can introduce false `seen`, `processing`, or completion states.
2. Whether backward compatibility for durable messages is sufficiently explicit.
3. Whether hiding tools reduces model error without harming emergency recovery.
4. Whether tool consolidation leaves a clean, discoverable path for task handoffs and graph inspection.
5. Whether default worker/orchestrator tool counts are realistic under current role gating.
6. Whether the proposed phased migration is safe enough for an extension with active on-disk task/mailbox state.

---

# Revision v2 — Required implementation contract after swarm review

This section is normative. It incorporates the architecture, UX, and operations review conditions. It replaces any ambiguous language earlier in the draft.

## A. Exact lifecycle schema and evidence mapping

The v2 `MessageRecord` gains evidence fields; it does **not** overload the present delivered/ack fields:

| v2 field | Set only by | Existing related evidence | Meaning |
|---|---|---|---|
| `injectedAt` (existing) | successful tmux injection | `delivered[to]` | Pane transport succeeded; **never** means seen. |
| `mailboxDeliveredAt` | durable mailbox append | message delivery record | Recipient mailbox has an envelope; **never** means seen. |
| `surfacedAt` (existing, generalized) | successful `swarm_check_mailbox` result or explicit receiver tool activity | current orchestrator informational surfacing | The API surfaced the envelope to the recipient. |
| `seenAt` | receipt derivation after `surfacedAt` | new | The recipient has an API-level read/surface receipt. Pane injection alone cannot set this. |
| `processingAt` | a recipient action scoped to the matching task/node or message | new | Work evidence exists; it remains non-terminal. |
| `respondedAt` | accepted, non-superseded `replyTo` response | `response.status`, `response.messageId` | A result response was received; for assignment messages this is not by itself task completion. |
| `terminalAt` | inferred terminal branch | node terminal result / response verification / cancellation | The message lifecycle has a final disposition and an evidence trace. |
| `lastAck` / `ackedAt` (legacy) | legacy explicit ack path only during migration | existing | Preserved without semantic reinterpretation until compatibility expires. |
| `response.*` (existing) | reply/result verification | existing | Remains the canonical response payload/link; inferred branches must populate it with the same validation rules as current ACK verification. |
| `superseded` (existing) | assignment supersession | existing | Terminal fence: a superseded record cannot become responded/verified from a late reply. |

**Invariant:** `injectedAt`, `mailboxDeliveredAt`, and `delivered[to]` are transport receipts only. `seenAt` requires a distinct surface/read receipt. All inferred transitions emit a `message.lifecycle_derived` trace including `messageId`, prior/new lifecycle state, evidence source, task/node/attempt identifiers when applicable, and timestamp. Deadline, supersession, and cancellation also retain their dedicated trace events.

## B. Terminal and response-verification rules

The engine must reuse today’s response validation semantics rather than merely changing message status.

1. When an assigned recipient performs a fenced `swarm_update_task` terminal transition, the existing lock-held update branch must locate its active assignment message and run the equivalent of today’s `validateResultMessage` / response-debt release logic. A terminal node alone therefore cannot leave the agent in `response_missing`, nor leave the assignment record perpetually injected.
2. A `swarm_send_message({ replyTo })` response is accepted only if the original record is not superseded/cancelled and its task/node/attempt context matches the current assignment. Accepted replies auto-populate and verify `response.*`, set `respondedAt`, and release response debt when the response contract is satisfied.
3. A reply to a superseded/cancelled assignment is preserved as an audit event but must not alter the old record from waived/superseded to `sent`/verified, must not clear debt for a current assignment, and emits `message.reply_rejected_superseded`.
4. For a task assignment, response received and node terminal are distinct evidence. The record is fully terminal only when its configured contract is satisfied: a required result response is verified **and** the matching fenced node reaches terminal, except cancellation/supersession/deadline policy branches.
5. The old explicit ACK code path remains available only as compatibility/admin behavior during the migration. The normal flow has **no explicit lifecycle-ACK call**; the acceptance criterion is revised from “zero ACK calls” to “zero normal-workflow calls to `swarm_ack_message` under gate=1.”
6. `response.status === "waived"` remains authoritative for a waived response. A new explicit response expectation may only be created by a new message/assignment, not by a late reply to the waived record.

## C. Deadline, TTL, attempts, and compatibility-derived attention

`responseDeadlineMs` is a response-observation timer, not a delivery retry policy.

| Situation | Required behavior |
|---|---|
| `ttlMs` expires | Existing TTL/dead-letter behavior remains authoritative. |
| `responseDeadlineMs` expires first | Emit `message.response.deadline_exceeded`; create derived attention/escalation evidence; do **not** dead-letter and do **not** consume/bypass the existing `attempts` / `MAX_ATTEMPTS=5` delivery ladder. |
| Transport injection/delivery fails | Existing reconcile reinject/retry distinction remains unchanged. |
| Legacy `requiresAck` is unmet | Continue deriving legacy `ack_missing` attention for `/swarm remind` and `deriveNodeAttention`; do not silently remove these operational inputs. |
| Gate=1 inferred message is silent | Produce equivalent derived attention labelled by response/activity deadline, with an explicit compatibility mapping for legacy dashboards/reminders. |

A reconcile sweep is the sole deadline scheduler. It evaluates deadline eligibility idempotently under the existing lock, records an emitted timestamp/reason, and never converts a response deadline directly into a dead letter. Existing `ack_missing`, reinjection, and delivery-attempt signals remain independently observable throughout compatibility.

## D. Feature gate, migration, and rollout

`PI_SWARM_MINIMAL_PROTOCOL=0|1` is read at module load using the established environment-constant pattern. Default is `0` until rollout approval.

| Gate | Behavior |
|---|---|
| `0` | Existing tools and explicit ACK semantics unchanged; Phase-1 inference runs in shadow/telemetry mode only and cannot change completion/recovery decisions. |
| `1` | Normal role-profile tool surface applies; inferred lifecycle is authoritative for newly created messages; compatibility parsing remains enabled. |

The migration window is **two stable releases** after gate=1 becomes available. Provide an idempotent admin migration tool/command that upgrades v1 durable envelopes to v2 evidence fields without inventing seen/response facts. It records per-record migration provenance and emits `protocol.migration.completed` with counts/skips/errors. The migration may be safely re-run. Legacy `requiresAck` and new `expectResponse` coexist during the window with **AND semantics** when both appear: the stricter response obligation wins. No old record is discarded or dead-lettered merely because it lacks v2 fields.

At the end of the two-release window, the release gate must explicitly review: migrated-state audit, stale legacy records, dead-letter effects, deadline traces, normal-flow ACK-call count, and recovery/UAT evidence before deprecating `requiresAck` from normal schemas.

## E. Role-profile tool gating and recovery access

“Hiding” means role-profile gating at registration and execution time, **not** de-registration. Existing guest/registered gating remains the first gate. A second gate then applies the authenticated swarm role profile; execution-time authority checks remain authoritative even if a schema was exposed accidentally.

| Profile | Normal model-facing surface |
|---|---|
| Worker | `swarm_check_mailbox`, `swarm_send_message`, `swarm_update_task`, `swarm_task_status`, `swarm_reconcile({dryRun:true, scope:"self"})` (**5 tools**, not 4). Worker dry-run reconcile is rate-limited by `PI_SWARM_RECONCILE_DRYRUN_WORKER_RATE_MS` (default 60,000 ms), may inspect only its own task/message scope, and returns a rate-limit error rather than running an unbounded sweep. |
| Orchestrator | Worker tools plus `swarm_agent_status`, `swarm_list_agents`, `swarm_spawn_agent`, `swarm_create_task`, `swarm_assign_task`, `swarm_reconcile` mutation mode, and goal tools. |
| Admin/operator | Recovery/debug tools only through explicit admin mode and slash commands, while retaining existing authority checks. |

`swarm_set_goal` and `swarm_mark_goal_done` remain orchestrator tools: they retain the legitimate idle-no-task goal-nudge use case. Their current low use is not a basis for removal.

Document and test each operator recovery workflow: release stale assignment, waive/supersede legacy response debt, prune/dead-letter inspection, capture/attach/send keys, restart/register agent, reload identity, role/pause changes, and GC. Identity-card generation must stop instructing normal workers to call explicit ACK; reload/regenerate identities under gate=1.

## F. Consolidation details that must retain semantics

1. **`swarm_task_message` → `swarm_send_message`:** add explicit structured task metadata plus an explicit `taskAssignment` boolean/opaque assignment token. Do not infer an assignment from a human-readable subject such as `Task …`; this prevents accidental mailbox auto-stamping. Existing task-handoff audit records must still be emitted.
2. **`swarm_next_nodes` → `swarm_task_status`:** `next_nodes` currently persists `task.currentNodes` under lock. The new status projection must make `currentNodes` derived at read time and stop relying on it as authoritative durable state; preserve text, JSON, and Mermaid views via `format`. Migration must either maintain the legacy field as a cache or remove all consumers deliberately.
3. **`swarm_print_graph` → `swarm_task_status`:** preserve `text`, `mermaid`, and JSON output exactly enough for existing automation. Keep aliases in admin/compatibility mode for the same two-stable-release window defined in §D.
4. **`swarm_message_status`:** admin/diagnostic only, with normal sender visibility supplied by task/status response summaries and deadline evidence.
5. **`swarm_agent_identity`:** fold only a safe identity summary into `swarm_agent_status({includeIdentity:true})`; retain the full identity file reader for admin/debug.

## G. Telemetry and release acceptance

Add a `tool.invoked` trace at the common swarm-tool registration/execution wrapper, with tool name, role profile, gate state, and success/error class. This is required to measure whether the normal flow has eliminated explicit ACK calls without relying on external session parsing.

In addition to earlier invariants, implementation cannot ship until the following are demonstrated with gate=0 and gate=1:

- terminal node updates automatically verify matching required response and clear response debt;
- accepted reply validates automatically; late reply to superseded assignment is fenced and traced;
- injection alone never produces `seenAt`; mailbox surface/read does;
- reconcile emits deadline attention without altering delivery attempt/dead-letter behavior;
- legacy `requiresAck`, remind eligibility, attention categories, and old envelopes remain readable;
- role profile and execution-time authorization agree for every normal/admin tool;
- worker normal flow uses zero `swarm_ack_message` calls under gate=1, measured via `tool.invoked`;
- all inferred lifecycle transitions are traceable;
- goal nudge remains usable by orchestrator;
- task-status replacement preserves ready/current/graph render semantics.

## H. Mandatory tmux UAT matrix

| # | Scenario | Gate | Expected evidence |
|---|---|---|---|
| 1 | Legacy assignment with `requiresAck`, explicit ACK flow | 0 | Existing behavior unchanged; old receipts/reconcile safe. |
| 2 | New assignment: worker reads, replies, terminal-updates with no ACK | 1 | `seenAt` from surface, `processingAt`, verified response, terminal receipt; worker reusable. |
| 3 | Pane injects then recipient process dies before mailbox read | 1 | `injectedAt` only; no `seenAt`; recovery/reinject action remains correct. |
| 4 | Required response deadline expires while delivery retries remain viable | 1 | `message.response.deadline_exceeded`; no premature dead-letter or attempt increment. |
| 5 | Assignment superseded; stale worker replies and attempts update | 1 | Reply fenced/audited; current attempt untouched; fencing rejection trace. |
| 6 | Task handoff through unified `send_message` | 1 | Explicit task metadata preserves handoff/artifact audit; no accidental assignment auto-stamp. |
| 7 | Worker tool discovery and denial | 1 | Worker has 5 normal tools; admin calls denied with actionable route. |
| 8 | Orchestrator goal with no task | 1 | Goal tools available; goal-nudge behavior still works. |
| 9 | Legacy envelope migration run twice | 1 | Second run idempotent; `protocol.migration.completed` provenance/traces correct. |
| 10 | Status graph render/current-node projection | 1 | Ready/current data and text/Mermaid/JSON views match legacy behavior. |

Run all ten scenarios in **both** required model/provider lanes: `glm-5.1` / `zai-coding-cn` and `gpt-5.4-mini` / `openai`. This is a 10×2 UAT matrix; report results independently by lane.

## I. Revised implementation work breakdown

1. **Schema/evidence and compatibility:** v2 fields, mapping, inference traces, migration command, two-release compatibility tests.
2. **Fenced response inference:** lock-held terminal verification, accepted/superseded reply branches, response-debt handling, deadline reconcile sweep.
3. **Profile gating and telemetry:** feature gate, role profiles plus execution checks, `tool.invoked`, regenerated worker identity guidance.
4. **Consolidated APIs:** explicit task metadata, status render formats, compatibility aliases, and phased `currentNodes` handling. Phase 2 keeps `currentNodes` as a write-through compatibility cache because existing code has multiple write sites and a flow-dialog reader; Phase 3 removes its writes/readers only after all consumers use the derived status projection.
5. **Operations release gate:** legacy remind/attention checks, full UAT matrix in a fresh isolated tmux environment, documentation and rollback evidence. Execute every §H scenario in two lanes: `glm-5.1` / `zai-coding-cn` and `gpt-5.4-mini` / `openai` (10×2 matrix). The fast-model lane is a required zero-normal-flow-ACK compliance check.

## J. Binding implementation details from UX delta review

The following are mandatory bindings for the eventual implementation plan:

1. **Single critical section:** terminal task update, response validation, response-debt release, and assignment lifecycle transition must occur in the same existing `withLock(p)` critical section. `withLock` is mkdir-based/non-reentrant; implementations must not acquire it recursively.
2. **Durable assignment token:** the unified assignment payload must carry a durable structured token at least equivalent to `{ taskId, nodeId, attemptId }`. The engine re-verifies it at reply and terminal-update time. A human-readable subject or loose conversation heuristic is insufficient.
3. **Exact worker-tool UAT assertion:** under gate=1, a worker's `pi.getActiveTools()` set must equal exactly `{ swarm_check_mailbox, swarm_send_message, swarm_update_task, swarm_task_status, swarm_reconcile }`; `swarm_reconcile` must reject non-dry-run mutation from a worker. It must not include `swarm_assign_task`, `swarm_create_task`, `swarm_spawn_agent`, `swarm_prune`, `swarm_gc`, `swarm_reload_identity`, or `swarm_message_status`.
4. **Migration idempotence UAT:** two consecutive `/swarm protocol migrate` runs must yield identical `protocol.migration.completed` counts/traces on the second run (zero additional migration work).
5. **Migration command:** expose `/swarm protocol migrate [--dry-run]` as the operator path for durable-envelope migration and audit.
6. **Non-task terminal contract:** an `expectResponse` message with no associated fenced task node becomes fully terminal when its response is accepted and verified (or when its cancellation/supersession/deadline policy reaches terminal disposition).

## K. Binding operational details from operations delta review

1. **Worker reconcile containment:** implement `PI_SWARM_RECONCILE_DRYRUN_WORKER_RATE_MS` (default 60,000 ms) and a `scope: "self" | "all"` parameter. Workers are forced to `dryRun:true, scope:"self"`; orchestrator/admin may use `scope:"all"` subject to existing authority. This prevents cross-task information leakage and repeated whole-swarm scans.
2. **Derived attention trace:** all derived attention must emit `message.attention.derived` with `source: "responseDeadlineMs" | "transportStale" | "legacyAckMissing"`, message/task/node identity, and evidence timestamp. `message.response.deadline_exceeded` remains the specific deadline event; the attention trace provides a stable consumer-facing category.
3. **Identity/runtime hint migration:** update all five explicit-ACK instruction sites: four identity-generation sites and the `formatSwarmMessageContent` runtime body in `delivery.ts`. Gate=1 worker messages must not render `[PI-SWARM ACK REQUIRED]`; legacy gate=0 messages retain it.
4. **Alias policy alignment:** `swarm_next_nodes` and `swarm_print_graph` compatibility aliases stay available for the same two-stable-release window as durable-envelope compatibility, including the second-release UAT lane.
5. **UAT model lanes:** each of the ten §H scenarios runs once under `glm-5.1`/`zai-coding-cn` and once under `gpt-5.4-mini`/`openai`; report each result separately. A single-model UAT is insufficient.
6. **Worker reconcile schema:** add `scope: "self" | "all"` to `swarm_reconcile`. A worker defaults to, and is forcibly constrained to, `scope:"self"`; any other requested scope fails `SCOPE_FORBIDDEN`. Orchestrator/admin may select either scope. Internally reuse the existing `agentId` reconciliation path by resolving `scope:"self"` to the calling agent id.
