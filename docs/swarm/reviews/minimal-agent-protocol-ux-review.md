# Review: minimal-agent-protocol proposal — agent UX & tool-gating

**Reviewer:** `protocol-ux-reviewer` (agent UX / tool-surface reduction / tool-gating)
**Document:** `docs/swarm/minimal-agent-protocol-proposal.md` (draft, 2026-08-28; Revision v2 added after swarm review)
**Scope of review:** whether removing explicit ACK is actually simpler, the proposed
worker/orchestrator tool surfaces, candidates to merge/hide, failure/recovery
discoverability, slash vs tool boundary, and whether the proposed status surfaces
replace `swarm_next_nodes` / `swarm_print_graph` / `swarm_message_status` adequately.
**Mode:** review-only. No production code or proposal text changed.

---

## 0. Verdict history

| Revision | Date | Verdict | Outstanding blockers |
|---|---|---|---|
| v1 (initial draft) | 2026-08-28 | **APPROVE WITH CONDITIONS** | B1, B2, B3, B4 |
| v2 (post-review revision) | 2026-08-28 | **APPROVE** | none blocking; see §9 minor follow-ups |

The v2 revision explicitly incorporates every blocker (B1–B4) and every non-
blocker recommendation (N1–N8) from the v1 review. See §9 for the delta walk-
through and any residual minor items.

---

## 1. Evidence base

Verified against the following sources:

- `extensions/swarm/src/tools/messages.ts` — current `swarm_send_message` /
  `swarm_ack_message` / `swarm_check_mailbox` / `swarm_message_status` /
  `swarm_reconcile` registration (5 messaging tools, default `requiresAck: true`).
- `extensions/swarm/src/tools/tasks.ts` — current `swarm_create_task` /
  `swarm_task_status` / `swarm_validate_graph` / `swarm_print_graph` /
  `swarm_next_nodes` / `swarm_assign_task` / `swarm_update_task` /
  `swarm_task_message` registration (8 task tools).
- `extensions/swarm/src/tools/agents.ts` — 19 lifecycle/observability/recovery tools;
  orchestrator-only server-side gates live on `swarm_prune`, `swarm_gc`,
  `swarm_stop_agent`, `swarm_release_agent_task`, `swarm_set_goal`,
  `swarm_mark_goal_done`, `swarm_assign_task`, `swarm_create_task`,
  `swarm_update_task(force|cancelTask)`.
- `extensions/swarm/src/tools/gc.ts` — `swarm_gc` (orchestrator-only).
- `extensions/swarm/src/tools/gating.ts` — current gating is binary
  (guest vs registered/orchestrator). `setActiveTools` drops or ensures all 31
  swarm tools; there is **no** worker-vs-orchestrator split in the active tool
  set today.
- `extensions/swarm/src/mailbox.ts` — durable `SwarmMessage` schema; lifecycle
  states `queued | mailbox_delivered | injected | intercepted | acked | failed |
  dead_letter`; record fields `ackedAt`, `surfacedAt`, `ackMissingAt`, `failedAt`,
  `lastAck`, `response.{status,resultMessageId,verifiedAt,waivedAt}`.
- `extensions/swarm/src/types.ts` — `MessageRecord` already carries timestamps for
  the delivery side, but **no** `seenAt` / `processingAt` / `respondedAt` /
  `terminalAt` — those are proposed additions.
- `extensions/swarm/src/reconcile.ts` — today’s recovery derives `ack_missing`
  purely from `(rec.requiresAck && !rec.ackedAt)` and re-triggers bounded by
  `MAX_REINJECTS`. `response_missing` derives from
  `(rec.requiresResponse && rec.response.status !== "verified"|"waived")`.
- `extensions/swarm/src/command.ts` — slash-command surface already covers
  `attach`, `capture`, `trace`, `identity reload/show`, `spawn`, `register`,
  `stop`, `restart`, `role`, `pause`, `resume`, `sendkey`, `release`,
  `mailbox reset`, `send`, `goal set/done`, `pool list|show|validate|help|…`,
  `flow`, `graph`, `attention`, `remind`. So moving the model-facing surface to
  slash/admin for the listed tools is consistent with what already exists.
- `docs/swarm/tools.md` — current docs say all 31 swarm tools are active for any
  registered agent or the orchestrator (visibility is identity-based, but there
  is **no** worker tool-set distinct from an orchestrator tool-set).
- `extensions/swarm/src/taskgraph.ts` / `tools/tasks.ts:199-237` —
  `swarm_next_nodes` writes `task.currentNodes` inside `withLock` as a side
  effect, plus returns `findReusableAgent` suggestions. `swarm_print_graph`
  produces `text|mermaid|json` formats; `swarm_task_status` currently only
  produces a `printGraphText`-derived summary, not `mermaid`/`json` outputs.

---

## 2. Verdict rationale

The proposal is directionally correct: removing a five-state ACK ritual from the
model prompt and substituting engine-derived evidence will reduce mechanical
tool traffic and is consistent with how the durable state already evolves. The
worker-surface count is realistic (≤4 tools), the orchestrator surface count is
realistic (≤9 tools), the proposed merges are mostly compatible with the
existing engine, and the slash-vs-tool boundary lines up with the slash command
catalog that already exists.

The conditions are non-trivial. Several of the proposal’s claims are only true
under explicit implementation work that the proposal currently glosses over:
(1) `swarm_next_nodes` and `swarm_print_graph` carry real semantics beyond
`swarm_task_status` (side-effect write of `currentNodes`; mermaid/json output);
(2) the proposed `expectResponse` / `responseDeadlineMs` / `escalateIfSilent`
fields are net-new schema with no current equivalent and need a real scheduler,
not just a flag rename; (3) gating today is binary — moving to a worker-vs-
orchestrator split is a new gating dimension, not a refactor; (4) the
deliver-is-not-seen invariant is stated but not enforced (the proposal
acknowledges this and recommends “either injection or mailbox surface” in §8,
which means there is still ambiguity to resolve before code); (5) several
recovery paths that today are reachable through `swarm_reconcile` from a worker
pane become invisible under a 4-tool worker surface unless `swarm_reconcile`
or an equivalent diagnostic surfaces elsewhere.

If the four blockers in §3 are satisfied, this proposal will make the worker
prompt meaningfully smaller without losing recovery. If they aren’t, it will
either remove debug capability that current sessions rely on, or it will leave
workers blocked on issues they cannot diagnose.

---

## 3. Blockers (must be addressed before approval lands as implementation)

### B1. `swarm_next_nodes` is not a pure read; do not silently absorb it

**Finding.** `swarm_next_nodes` (extensions/swarm/src/tools/tasks.ts:199-237)
mutates `task.currentNodes` under `withLock` and emits `agent.find` traces per
ready node. `swarm_print_graph(format: mermaid|json)` produces output shapes
that `swarm_task_status` does not currently produce.

**Why it matters.** Folding both into `swarm_task_status` changes behavior in
two ways that are easy to miss: (a) callers that read status without wanting to
re-stamp `currentNodes` will start to write it as a side effect of a read; (b)
agents that want a Mermaid rendering for a handoff or a JSON dump for tooling
will lose access unless the merged tool covers both.

**Required.** Specify in the proposal §4.2 which call site owns the
`currentNodes` write after the merge. Options to make explicit:
- `swarm_task_status` writes `currentNodes` only when `includeReadyNodes: true`
  (default-on); deprecation note that this is now a side effect.
- A separate, scheduler-internal caller keeps writing `currentNodes` and the
  model tool is read-only.
- The `currentNodes` field becomes a derived view (computed on read), removing
  the write entirely — preferred because it removes a class of lock contention.

Also explicitly state whether `format: "mermaid" | "json"` is preserved in the
merged `swarm_task_status`, and what the type signature of the merged parameter
shape is. The current `printGraphMermaid` and `graphJsonSummary` helpers are
already reusable, so this is mostly a parameter-routing decision.

### B2. `expectResponse` / `responseDeadlineMs` / `escalateIfSilent` are net-new engine behavior, not field renames

**Finding.** The proposal §3.1 introduces three new message fields:
`expectResponse`, `responseDeadlineMs`, `escalateIfSilent`. The current
durable schema (extensions/swarm/src/types.ts:120-159) and engine
(extensions/swarm/src/mailbox.ts:230-269, extensions/swarm/src/reconcile.ts:641-1311)
have no concept of a per-message response deadline. Today’s `response_missing`
is driven by `rec.response.status !== "verified"|"waived"` with no time bound;
`ack_missing` is driven by `ACK_MISSING_MS` after delivery. The proposal
replaces those semantics but does not describe the scheduler that emits
escalations or the place those fields live in `MessageRecord`.

**Why it matters.** Without a deadline scheduler, the engine cannot honor
“escalate if silent” and the proposal’s acceptance criterion #4 (“no silent
loss”) cannot be met. Without `seenAt / processingAt / respondedAt` on the
record, downstream consumers (reconcile, attention report, flow dialog,
`runtimeTaskWarnings`) cannot display inferred state.

**Required.** Before merging: (i) add the four timestamp fields to
`MessageRecord` in types.ts with a migration that back-fills from existing
records (`surfacedAt → seenAt?`, `ackedAt → processingAt?`, `response.verifiedAt
→ respondedAt?`); (ii) describe the scheduler: hook into the existing
`reconcile` sweep with a new pass `reconcile.response_deadline`, gated by
`now - injectedAt > responseDeadlineMs`, that flips the record to `expired`
or `failed` and emits an `escalation` trace; (iii) keep the existing
`requiresAck` flag round-tripping on disk through the migration window so
legacy durable messages reconcile correctly (the proposal mentions this in
§6 phase 1 but the reconcile sweep changes need explicit list).

### B3. The new gating dimension (worker vs orchestrator) is net-new infrastructure, not a refactor

**Finding.** Today’s `extensions/swarm/src/tools/gating.ts` implements
`applySwarmToolGating` as a binary function: guest loses all swarm tools,
everyone else gets all 31. The proposal §2.1-2.3 introduces three tiers
(worker, orchestrator, admin). This is a new third axis on top of
identity-based gating and has no implementation today.

**Why it matters.** “Hide from normal model registry” sounds like a config
change but it actually requires: (a) deciding the rule that maps
`roleKind` → tool-set (the `roleKind` field exists on agents but is not
yet used for gating); (b) deciding the ordering — does the gating tier win,
or does server-side `requireOrchestratorAuthority` still apply? (current
tools enforce authority at execution time, which is fine, but the active
tool set is a separate concern); (c) ensuring slash commands remain
reachable when the model surface is hidden (`/swarm attach` already exists
in command.ts; the slash surface is the recovery path); (d) ensuring
the `setActiveTools` rebuild does not flatten non-swarm tools.

**Required.** Specify the gating rule explicitly. Recommend:
- Worker (`roleKind` ∈ `worker|planner|implementer|reviewer|tester|observer`):
  active tools = `swarm_check_mailbox`, `swarm_send_message`,
  `swarm_update_task`, `swarm_task_status`.
- Orchestrator (`roleKind: orchestrator` or agent id `orchestrator`):
  active tools = the worker four + `swarm_agent_status`,
  `swarm_list_agents`, `swarm_spawn_agent`, `swarm_create_task`,
  `swarm_assign_task`, `swarm_reconcile`.
- Admin: not exposed via the model tool registry; reachable only through
  `/swarm` subcommands and explicit `PI_SWARM_ADMIN_MODE` opt-in.

Decide and document the precedence between tier-gating and execution-time
authority. The cleanest model is tier-gating determines what the model can
*call*; server-side `requireOrchestratorAuthority` still rejects calls that
slip through (defense in depth). State this explicitly so reviewers can
verify the worker can never accidentally invoke `swarm_assign_task`.

Also: `swarm_create_task` is currently orchestrator-only by execution but
exposed to all registered agents in the active tool set. After this
proposal, it should be hidden from the worker active set. The execution-
time check stays; the model prompt stops suggesting it.

### B4. The four-tool worker surface must still let workers diagnose a stuck delivery

**Finding.** The proposal’s worker surface is `swarm_check_mailbox`,
`swarm_send_message`, `swarm_update_task`, `swarm_task_status`. Today’s
docs/swarm/tools.md “Delivery is missing or a pane looks stuck” path uses
`swarm_message_status`, `swarm_agent_status`, `swarm_capture_agent_pane`,
and `swarm_reconcile(dryRun=true)` — none of which are in the proposed
worker four. The “A task is stalled” path uses `swarm_task_status(runtime=true)`,
`swarm_validate_graph`, `swarm_next_nodes`, `swarm_reconcile(dryRun=true)` —
again, none of the latter three are in the worker four.

**Why it matters.** When an assignment is dead-lettered, or when a node goes
silent, the worker needs *some* tool path to detect it and ask for help.
Without that path, workers either ignore symptoms or spam the orchestrator.
Both outcomes are worse than today.

**Required.** Pick one of the following, and state it in the proposal:
- (a) `swarm_reconcile(dryRun=true)` stays in the worker four. It is read-only
  in dry-run mode, surfaces real diagnostics, and workers already call it
  in the recommended operating path. Cost: +1 tool, +1 prompt bullet.
- (b) Add a read-only `swarm_diagnostics` tool that combines
  `swarm_message_status` and `swarm_reconcile(dryRun=true)` and hides the
  mutation flag. Cost: net-new tool.
- (c) Hide reconcile entirely; require workers to call
  `swarm_task_status(runtime=true)` and use the warnings that emit. Cost:
  weaker diagnostics, but acceptable if the runtime-warning surface is
  beefed up to include unacked delivery counts.

Recommended: (a). The dry-run mode is genuinely safe (no state mutation,
no lock side effects beyond reading); keeping the existing tool name is
cheaper than a new tool; and the current docs already train workers to
use it. The proposal should commit to this and revise the worker tool
count from “≤4” to “5” with `swarm_reconcile(dryRun=true)` only.

---

## 4. Non-blockers (recommendations that improve clarity or safety)

### N1. Pin the deliver-is-not-seen invariant at the schema level

**Finding.** Proposal §3.3 explicitly warns that delivery is not understanding
and recommends keeping `mailboxDeliveredAt` separate from `seenAt`. The §8
open question “Does pane injection alone set `seen`?” admits three options
(injection-only, mailbox-read-only, either). This is the most subtle source of
false-completion risk in the proposal.

**Recommendation.** Pick “either” (injection OR mailbox-read), but require
that `seenAt` only transitions from `mailboxDeliveredAt` when the *recipient*
tool-call surface observes it (e.g. `swarm_check_mailbox` returning the message
in its result, or the inbox subsystem surfacing it via the pump’s surfaced
set). Do not let `injectedAt` alone set `seenAt`; tmux injection proves the
keystrokes landed, not that the agent read the prompt. Document the decision
in `extensions/swarm/src/mailbox.ts` next to where `mailboxDeliveredAt` is
stamped.

### N2. `swarm_message_status` should be downgraded, not deleted

**Finding.** The proposal §10 marks `swarm_message_status` as
“admin/diagnostic only.” That is the right call for the model surface —
normal senders do not need it — but the function is also used by
`swarm_reconcile` (extensions/swarm/src/reconcile.ts:658, 691, 905) for
internal recovery. Keep the implementation, just drop it from the active
tool registry for worker and orchestrator.

**Recommendation.** Move `swarm_message_status` to the admin tier. Add an
`/swarm message <id>` slash command as the operator-facing equivalent, and
make the internal reconcile caller use a shared private helper instead of
the public tool name.

### N3. `swarm_agent_identity` → `includeIdentity` on `swarm_agent_status` is mostly safe

**Finding.** `swarm_agent_identity` is a regenerable read. The proposal’s
folding (`includeIdentity: true`) keeps the information accessible. There
is one subtle case: `swarm_reload_identity` is the only way to *inject* an
identity-reload request into a live pane. That cannot be folded into a
read — it must stay as either a tool (admin tier) or a slash command
(`/swarm identity reload <id>`). The latter already exists in command.ts,
so the proposal should call this out and explicitly retire the tool.

**Recommendation.** Fold `swarm_agent_identity` into `swarm_agent_status`
with `includeIdentity: true`. Retire `swarm_reload_identity` as a model
tool; document `/swarm identity reload <id>` as the operator surface.

### N4. `swarm_set_goal` / `swarm_mark_goal_done` — reassess, don’t delete

**Finding.** The proposal §10 says these “were not used in current project
logs.” That is consistent with the observation that goal-driven idle nudges
are a recent addition (Issue 18) and may not yet have measurable traffic.
But “unused” is a weak signal: the same logs likely also under-represent
`/swarm remind` and the bounded worker reminder path, which were just
introduced.

**Recommendation.** Keep both tools but move them to the orchestrator
active set (they are already execution-time gated). Do not move them to
admin. If the project later decides they were a premature addition,
retire them in a separate change. Coupling retirement to this proposal
adds risk without a clear win.

### N5. Be explicit that “removal” is tier-gating, not de-registration

**Finding.** Proposal §6 phase 2 says “Hide `swarm_ack_message`,
`swarm_task_message`, `swarm_next_nodes`, `swarm_print_graph` from
default worker/orchestrator registries. Register aliases only in
compatibility/admin mode.”

**Recommendation.** State in the proposal that hidden tools remain
registered (so `getAllTools()` and the smoke test stay stable, as the
current `gating.ts` rationale comments require), and that
`applySwarmToolGating` is extended to consult `roleKind` against a
worker/orchestrator/admin allow-list before calling `setActiveTools`.
This avoids the trap of accidentally removing tools that other extension
code (tests, slash command handlers, reconcile) calls by name.

### N6. Update `docs/swarm/tools.md` and the “Recommended operating paths” section

**Finding.** `docs/swarm/tools.md` currently states the tool count is 33,
documents `requiresAck` semantics as required behavior, and lists worker
operating paths that use `swarm_ack_message` and `swarm_next_nodes`. After
this proposal lands, all three become inaccurate.

**Recommendation.** As part of the same change set:
- Update the tool count to “33 registered, ≤4 in default worker surface,
  ≤9 in default orchestrator surface, the rest admin/slash-only.”
- Replace the “Message completion protocol” three-step recipe with a
  one-step recipe (“reply with `swarm_send_message(replyTo=...)`; engine
  derives the rest”).
- Update the “A worker received an assignment” path to drop the
  `swarm_ack_message` step.

The proposal mentions “docs and validation” in §9 item 4 but doesn’t call
out the specific doc sections. Spell them out in the implementation task.

### N7. Validation step needs a tmux UAT, not just unit tests

**Finding.** The proposal §9 item 5 calls for “fresh interactive tmux
UAT” but doesn’t specify what behavior is exercised. This proposal changes
prompt-level ergonomics; unit tests on the engine don’t catch regressions
in what the model actually does.

**Recommendation.** The UAT scenario should at minimum:
- Spawn two workers, run a feature-dev task, count `swarm_ack_message`
  invocations across the session log. Target: zero.
- Inject a stalled pane (worker pane alive but unresponsive), verify the
  orchestrator’s `swarm_reconcile(dryRun=true)` surfaces the stale node
  through the runtime warnings of `swarm_task_status(runtime=true)`.
- Replay a legacy durable message (existing `requiresAck: true` record)
  into a fresh pi and verify it is reconciled without manual ack.
- Verify the worker’s active tool set does not include `swarm_assign_task`,
  `swarm_create_task`, or any admin tool, by reading the system prompt
  snapshot from a fresh pi session.

Use the project’s `tmux-pane-operator` skill and the existing
`docs/swarm-graph-uat-scenario.md` as a starting point.

### N8. Worker promptGuidelines need to be rewritten, not just hidden

**Finding.** Hiding tools is necessary but not sufficient. The identity
card `extensions/swarm/src/identity.ts:129-132` and the
`/pi/swarm/agents/*.md` durable role cards currently say things like
“For every swarm message with `requiresAck=true`, you MUST acknowledge it
with `swarm_ack_message`.” After the proposal lands, that instruction
becomes false and misleading.

**Recommendation.** As part of the same change set, regenerate the
identity cards and remove the explicit-ACK instruction. The regenerated
prompt should say something like: “Reply with `swarm_send_message(
replyTo=...)` when you have a result. The engine derives the lifecycle
from your reply and your `swarm_update_task` calls; you do not need to
ack messages.” Use the existing `swarm_reload_identity` / `swarm_set_role`
plumbing to propagate the change to live agents, or rely on natural
`/reload` to pick up the new identity template.

---

## 5. Compatibility questions raised by reviewers

Reviewers are asked to challenge the proposal on six points. Answers below.

1. **Whether inferred lifecycle can introduce false `seen`, `processing`, or
   completion states.** Possible if `seenAt` is set on injection alone. See
   **N1**: gate `seenAt` on recipient-side observation. The `processingAt`
   proposal (“any task-scoped tool for the matching assignment/task”) is also
   risky — a worker might invoke `swarm_update_task` for an unrelated prior
   node. Tighten to “matching taskId + assignee” and trace the evidence.
2. **Whether backward compatibility for durable messages is sufficiently
   explicit.** Mostly yes, but **B2** adds the missing deadline scheduler
   detail. The `requiresAck` records on disk must continue to surface as
   informational (with the legacy `seen`/`processing`/`done` flow intact)
   until the durable state migration window closes.
3. **Whether hiding tools reduces model error without harming emergency
   recovery.** Hiding is a net win for the worker four but loses diagnostic
   reachability — see **B4**. The slash-command surface already covers the
   admin tools, so the recovery path is intact as long as the model is told
   to escalate rather than self-diagnose.
4. **Whether tool consolidation leaves a clean, discoverable path for task
   handoffs and graph inspection.** Mostly yes after **B1** is resolved. The
   proposal should commit to keeping the Mermaid and JSON graph views
   reachable through the merged `swarm_task_status`, not just the text view.
5. **Whether default worker/orchestrator tool counts are realistic under
   current role gating.** Worker ≤4 + diagnostic reconcile = 5 is realistic;
   orchestrator ≤9 is realistic given that `swarm_validate_graph`,
   `swarm_print_graph`, and `swarm_next_nodes` move into a merged
   `swarm_task_status` view. See **B3** for the gating-tier implementation.
6. **Whether the proposed phased migration is safe enough for an extension
   with active on-disk task/mailbox state.** Phase 1 (inference + telemetry,
   no schema break) is safe. Phase 2 (hide tools, aliases for compat) is
   safe as long as **N5** is observed (tools remain registered, only the
   active set changes). Phase 3 (drop `ack_missing` as a normal failure
   signal) needs a clear “no silent loss” test — see **B2**’s scheduler and
   **N7**’s UAT.

---

## 6. Approval conditions summary

Before this proposal moves from design to implementation, the following must
be addressed:

- **B1.** Decide and document the `currentNodes` write semantics after the
  `swarm_next_nodes` → `swarm_task_status` merge; preserve mermaid/json
  output formats.
- **B2.** Add `seenAt` / `processingAt` / `respondedAt` / `terminalAt` to
  `MessageRecord` with a migration; design the deadline/escalation scheduler
  as part of the reconcile sweep.
- **B3.** Specify the roleKind → tool-set gating rule and the precedence
  between tier-gating and execution-time authority.
- **B4.** Decide whether workers keep a read-only diagnostics tool
  (`swarm_reconcile(dryRun=true)` or a new `swarm_diagnostics`); revise the
  “≤4 worker tools” claim accordingly.

Recommendations N1–N8 should be incorporated into the implementation tasks
even though they are non-blocking.

---

## 9. Revision v2 — delta review

### 9.1 What changed

Revision v2 adds a normative §A–§I block (lines 270-390) that addresses each
v1 condition explicitly:

| v1 condition | v2 resolution |
|---|---|
| **B1** (currentNodes side-effect) | §F.2: `currentNodes` becomes a derived view at read time; legacy field is either cached or deliberately removed. text/mermaid/json render formats preserved. |
| **B2** (lifecycle schema + deadline scheduler) | §A: explicit field table with set-only-by/meaning; §B: terminal/response-verification rules; §C: deadline sweep is the reconcile scheduler, idempotent under lock, never dead-letters directly. |
| **B3** (worker/orchestrator gating) | §D: feature gate `PI_SWARM_MINIMAL_PROTOCOL=0|1`; §E: role-profile gating is layered (guest → registered → role profile), execution-time authority remains authoritative. |
| **B4** (worker diagnostic path) | §E: worker surface is 5 tools (mailbox/send/update/status/reconcile(dryRun:true)). Acceptance criterion revised from "zero ACK calls" to "zero normal-workflow calls under gate=1". |
| **N1** (deliver-is-not-seen invariant) | §A: explicit invariant; `seenAt` requires surface/read receipt, never injection alone. |
| **N2** (downgrade message_status) | §F.4: admin/diagnostic only; sender visibility through task/status summaries and deadline evidence. |
| **N3** (fold identity, keep reload) | §F.5: identity summary folded into agent_status; full identity file reader retained for admin/debug. Slash-equivalent for reload already exists. |
| **N4** (retain goal tools) | §E: explicit — `swarm_set_goal` / `swarm_mark_goal_done` stay on orchestrator. |
| **N5** (hide ≠ de-registration) | §E: explicit — role-profile gating at registration + execution time, tools remain in `getAllTools()`. |
| **N6** (docs update) | §I.5: documentation in the release gate; §E: regenerate identity cards under gate=1. |
| **N7** (tmux UAT) | §H: explicit 10-row UAT matrix covering legacy ACK, zero-ACK new flow, dead pane, deadline, supersede fencing, unified send_message task metadata, worker tool discovery, orchestrator goal, legacy envelope migration idempotence, and graph render compatibility. |
| **N8** (identity regeneration) | §E + §I.5: identity-card generation must stop instructing normal workers to call explicit ACK; reload/regenerate identities under gate=1. |

### 9.2 Verification against current code (v2 spot-checks)

- **Deadline scheduler is genuinely idempotent and non-dead-lettering.**
  v2 §C states the reconcile sweep is the sole deadline scheduler, never
  converts a response deadline directly into a dead letter, and emits
  `message.response.deadline_exceeded`. Compatible with today's reconcile
  (extensions/swarm/src/reconcile.ts:1118-1210), which already gates every
  state mutation by `!options.dryRun` and never overwrites `attempts` /
  `MAX_ATTEMPTS=5` from deadline logic. ✓
- **`PI_SWARM_MINIMAL_PROTOCOL` follows the established env-var pattern.**
  The codebase already reads `PI_SWARM_ORPHAN_TIMEOUT_MS`,
  `PI_SWARM_PREFLIGHT_GRACE_MS`, `PI_SWARM_MAX_NUDGES`,
  `PI_SWARM_SESSION_STARTED_AT`, etc. (extensions/swarm/src/agents.ts:75,
  operations.md §env-knobs). Adding one more follows convention. ✓
- **`swarm_reconcile(dryRun=true)` is genuinely read-only.**
  Confirmed in extensions/swarm/src/reconcile.ts:1043-1210: every state
  write is gated by `if (!options.dryRun)`. Safe for the worker surface. ✓
- **Mermaid/JSON render preservation is implementable.**
  v2 §F.3 commits to keeping text/mermaid/json renderers accessible via
  `swarm_task_status(format=...)`. The existing `printGraphMermaid` and
  `graphJsonSummary` helpers in extensions/swarm/src/taskgraph.ts already
  cover both. ✓
- **Hardening the assignment auto-stamp (§F.1).** Today's
  `message.deliver.assignment_auto_stamp` in extensions/swarm/src/mailbox.ts:288-330
  triggers on `(conversationId matches task:<id>:<node>) AND (subject starts
  with "Task " AND includes " assigned")`. The subject heuristic is fragile:
  any caller can auto-stamp an assignee by accident. v2 §F.1 replaces this with
  an explicit `taskAssignment` boolean/opaque token. **This is a behavior
  change** that requires the orchestrator's `swarm_assign_task` to be updated
  to pass the new token. Worth calling out so reviewers don't miss it; it is
  a hardening, not a regression. ✓ (with caveat: must keep `swarm_assign_task`
  on the orchestrator surface so the token can always be set by an authorized
  caller.)
- **Compatibility window is two stable releases, not one.** v2 §D commits to
  two stable releases plus a release-gate audit before deprecating
  `requiresAck`. This addresses v1's open question about migration duration
  (originally "at least one stable release"). ✓
- **Telemetry is built in.** v2 §G adds a `tool.invoked` trace at the common
  tool wrapper, with role profile + gate state. This makes the "zero normal-
  workflow ACK calls under gate=1" acceptance criterion machine-checkable
  instead of relying on external session-log parsing. ✓

### 9.3 Minor follow-ups (non-blocking)

These are not blockers. They are small clarity or completeness items that
would tighten the implementation.

- **MU1.** §B.1 says the lock-held terminal-update branch must "locate its
  active assignment message and run the equivalent of today's
  `validateResultMessage`." Worth specifying whether this lookup happens
  inside the existing `withLock(p)` for `swarm_update_task` or in a separate
  narrow lock window — affects whether response-debt release blocks task
  status writes or piggybacks on them. Recommendation: piggyback inside the
  same lock for atomicity; the existing `withLock` is mkdir-based and the
  critical section already touches state.
- **MU2.** §F.1 introduces a `taskAssignment` token. Spell out whether this is
  a JWT-like signed value, a random opaque nonce, or a structured record
  (e.g. `{ taskId, nodeId, attemptId }`). Whatever the format, it must be
  re-checked at terminal-update time so a forged message can't claim
  assignment authority. Today the auto-stamp is gated by both the
  conversationId regex AND the subject heuristic; v2 needs at least one
  equivalent durable check.
- **MU3.** §H.7 ("Worker tool discovery and denial") needs a concrete
  assertion: probably read the active tool set via `pi.getActiveTools()` and
  assert it contains exactly the 5 worker tools and not the 8 admin
  subcommand-backed tools. Without that, a regression that re-exposes
  `swarm_assign_task` to a worker would slip through.
- **MU4.** §H.9 ("Legacy envelope migration run twice") should additionally
  assert that the migration produces identical `protocol.migration.completed`
  counts/traces on both runs. Idempotence is claimed in §D; the UAT row
  should explicitly verify it.
- **MU5.** The proposal doesn't name a tool/command for the migration. The
  v2 contract says "idempotent admin migration tool/command" — pin one.
  Recommendation: `/swarm protocol migrate [--dry-run]` slash command,
  parallels `/swarm mailbox reset` for emergency repair.
- **MU6.** §B.4 says "the record is fully terminal only when its configured
  contract is satisfied: a required result response is verified AND the
  matching fenced node reaches terminal." What about a non-task
  `expectResponse: true` direct message that has no node? Spec clarifies
  implicitly (only assignment messages have a fenced node), but an explicit
  sentence saves reviewers from inferring it.

### 9.4 v2 verdict

**APPROVE.**

Revision v2 closes every v1 blocker, accepts every v1 recommendation, and
adds an explicit acceptance matrix that the previous draft was missing.
The schema/deadline work is the most consequential engineering change and
the proposal correctly isolates it behind a feature gate and a two-release
migration window. The role-profile gating is layered onto today's binary
gating without disturbing it. The UAT matrix is concrete enough to gate a
release on.

Minor follow-ups MU1–MU6 are documentation/clarification items, not
implementation blockers. They can land in the implementation tasks without
re-routing review.

### 9.5 Reviewer sign-off (v2)

Conditions from v1: **all closed.**
Recommendations from v1: **all accepted; N6/N7/N8 promoted to normative
release-gate items in §I.5.**
New minor items (MU1–MU6): **non-blocking; recommend folding into
implementation tasks.**
Recommendation: **proceed to implementation under `PI_SWARM_MINIMAL_PROTOCOL=0`
(Phase 1 telemetry), then gate=1 once the UAT matrix passes.**
