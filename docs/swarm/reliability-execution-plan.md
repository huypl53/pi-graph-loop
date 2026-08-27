# Reliability Roadmap Execution Plan

> **Status:** approved for sequential execution.
>
> Source proposal: [`reliability-roadmap.md`](./reliability-roadmap.md).
>
> This file turns the reviewed roadmap into a release-gated queue. **Only one implementation issue is active at a time.** A later issue is not assigned until the previous issue has passed independent test, review, and a fresh interactive Pi/tmux UAT.

## Non-negotiable release gates for every issue

Each issue must complete all gates below before the next issue begins:

1. **Plan gate** — exact invariants, migration/compatibility impact, negative cases, and failure-injection tests are written before production edits.
2. **Implementation gate** — scope is limited to the issue's declared files/behavior; no incidental feature additions.
3. **Independent test gate** — a tester who did not implement the change runs focused regressions plus the core suite.
4. **Review gate** — reviewer checks authority, idempotency, state mutation location, stale-write safety, and absence of scope creep.
5. **Fresh UAT gate** — in a dedicated tmux session, load the packaged extension into a fresh Pi process using the configured default model/provider; exercise one realistic success path and the relevant failure/recovery path.
6. **Evidence gate** — task artifacts contain plan, implementation report, test report, review, final summary, commands, tmux target, and captured-pane/log paths.
7. **No-go rule** — a rejected review, failed UAT, or incomplete evidence routes only to that issue's `fix` node. It blocks all later issues.

Baseline compatibility check for every issue:

```bash
NODE_PATH=$(npm root -g) npx tsc --noEmit --allowImportingTsExtensions --module nodenext --moduleResolution nodenext --skipLibCheck --target es2022 --lib es2022 extensions/swarm/index.ts
```

Bare `tsc` TS5097 caused by existing `.ts` import specifiers is not treated as a change regression.

## Sequential queue

| Order | Issue | Scope / exit condition | Status |
|---:|---|---|---|
| 1 | Authority, initial-ready nudge, nudge-policy foundation | Enforce server-side `force` / cancellation authority; alert the PM about a newly-created unassigned start node; centralize only the dedupe/cooldown/cap contract needed by this work. | Complete: `reliability-hardening-phase-1` |
| 2 | Assignment attempt / lease fencing | Add a durable assignment attempt identity and reject late updates/results from a superseded/reopened/reassigned attempt. No silent compatibility break. | Complete: `assignment-attempt-lease-fencing` |
| 3 | Cancellation and supersession | Define cancellation as lease revocation, cancel/supersede in-flight assignment messages, release resources, reject late task mutations, and provide auditable recovery. | Complete: `cancellation-and-supersession-semantics` |
| 4 | File ownership / parallel conflict policy | After leases exist, prevent unsafe overlapping concurrent write scopes or add explicit orchestrator-approved lock policy. | Complete: `file-ownership-parallel-conflict-policy-v2` |
| 5 | Recovery attention and worker reminder | Add one decision-oriented, bounded worker reminder and a synthesized orchestrator attention view. It must rely on durable assignment/message state, not idle panes as semantic proof. | Complete: `recovery-attention-worker-reminder` |
| 6 | Provider/pool preflight | Classify provider/model/tmux/pool failures before spawn/assignment and give actionable fallback/recovery output. | Complete: `pool-config-ux-and-preflight` |
| 7 | Crash consistency and failure injection | Harden and test locks/state/task/mailbox recovery under interrupted writes and concurrent mutation; document repair boundaries. | Complete: `crash-consistency-and-failure-injection` |
| 8 | Multi-orchestrator policy | Either explicitly reject a second active orchestrator or introduce and test a durable leader lease/fencing protocol. This is not enabled partially. | Complete: `multi-orchestrator-policy` |
| 9 | Lifecycle-notification fencing and stale-event suppression | Prevent an old `agent_settled` / open-assignment notification from remaining actionable after its assignment was released, superseded, cancelled, reassigned, or worker stopped. Fence creation and delivery using durable task/attempt/agent state; preserve audit without semantic mutation. | Complete: `lifecycle-notification-fencing` |
| 10 | Final surface and architecture review | Re-evaluate public tool/command exposure after operational semantics settle; keep core minimal and move debug/admin exposure behind appropriate role gates or commands. | Complete: `final-surface-architecture-review` (`6cc71c2`) |
| 11 | Orchestrator wake-up escalation | Escalating re-nudge (bounded, durable-state driven) plus optional leader-gated PM-pane wake-up via existing tmux injection when a ready node sits unassigned after the first nudge. | Complete: `orchestrator-wake-up-escalation` (`4daede3`) |
| 12 | Surface tension C6 micro-fix | Add explicit orchestrator-pane reject guard in `swarm_send_keys` so a future refactor cannot silently route raw keystrokes into the orchestrator host pane. No behavior change for valid worker→worker targets. | Complete: `surface-tension-c6-mic-fix` (`c0cdb3f`) |
| 13 | Documentation staleness audit | Audit every `docs/swarm/*.md` page against current source of truth; produce per-page diff list; apply minimal additive fixes. | Complete: `docs-staleness-audit` (`495922e`). E4/E5 deferred to follow-up. |
| 14 | Spawn-without-message engine warning | Detect operator error where `swarm_spawn_agent` returns but no `swarm_send_message` follows within a turn window. Emit a structured warning trace event (no new public tool, no hard error). Cancel on follow-up call or `swarm_assign_task` (which sends internally) or `stop_agent`. | Complete: `spawn-without-message-engine-warning` (`4547001`) |
| 15 | Operations.md deferred edits + clearReason attribution | Apply deferred E4 + E5 from Issue 13 (operations.md:139 precedence sentence; operations.md:188 heading) AND add optional clearReason parameter to deliverMessageLocked so by='swarm_assign_task' is distinguishable from by='swarm_send_message'. | Complete: `operations-deferred-edits-and-clearreason` (`41e7f66`) |
| 16 | Pre-flight spawn + assign auto-clear | Detect spawn-then-assign-by-same-orchestrator pattern and pre-clear the orphan entry before timer expires (no false-positive warning). Cross-orchestrator assign does NOT pre-clear. True orphans still fire. New constant `PREFLIGHT_ASSIGN_GRACE_MS` (default `max(5_000, ORPHAN_SPAWN_WARNING_TIMEOUT_MS - 1_000)`); `RecentSpawn` stamp fields (`spawnedByPid`, `spawnedBySessionStartedAt`); new `clearOrphanWatch(..., kind)` signature with `reason: "preflight"\|"delivery"` trace field; env-var stamp added at the top of the existing `session_start` handler in `extensions/swarm/src/hooks.ts`. | Complete: `preflight-spawn-and-assign-auto-clear` (4 review cycles) |
| 17 | Model pool rotation should respect pi engine retries | Model pool currently rotates on first error, but pi engine has its own 3-retry before giving up on a request. Pool rotation should only kick in AFTER pi retries are exhausted for the current model, not after a single transient failure. Otherwise transient 5xx/429/timeout causes unnecessary model swap, context loss, and tmux churn. | Complete: `1016d7c` + `538b368`; deferrals applied in Issue 19 commit `<hash>`. |
| 18 | Swarm goal: idle-streak nudge with back-off | swarm_set_goal + swarm_mark_goal_done tools + /swarm goal set/done commands. Orchestrator pump nudges when goal set + all agents idle. Anti-loop: 3 nudges without resolve → skip 2 ticks. | Complete: `swarm-goal-idle-nudge` (`7253efb`). |
| 19 | Model pool: apply Issue 17 deferrals + manual /swarm pool rotate override | Extract ENGINE_MAX_RETRIES + ENGINE_RETRY_WINDOW_MS to constants.ts. Add `Pi engine retry coordination` subsection to operations.md. Implement `/swarm pool rotate now` (force-swap, bypass gate, bump swap-chain) + `/swarm pool rotate next` (bench current slot, no setModel). Both orchestrator-only. | Complete: `model-pool-deferrals-and-manual-override` (`60b0dea`). |

## Cross-issue invariants

These rules apply throughout the queue:

```text
- task.json remains task-graph source of truth
- mailbox delivery is at-least-once and must be idempotent
- transport delivery, response protocol, and node execution are separate state machines
- readiness derivation remains pure; graph reopening is an explicit, audited transition
- only declared rework:true edges may re-enter terminal nodes
- a failed ordinary dependency never means successful dependency satisfaction
- stale is advisory; harness never infers semantic done/failed from process/pane idleness
- retry, reminder, reassign, cancellation, and supersession remain distinct actions
- no automatic reassign or semantic completion without an explicit task policy and authority decision
- every recovery nudge is semantically deduplicated, bounded, and action-oriented
```

## UAT protocol

For each issue create an isolated validation target, e.g.:

```bash
tmux new-session -d -s swarm-uat-issue-<n> -n pi
```

Start fresh Pi with the **project-configured default model/provider**; do not hard-code a different pool unless the UAT itself is specifically testing provider fallback:

```bash
PI_SWARM_IS_ORCHESTRATOR=1 pi -e extensions/swarm/index.ts
```

Capture before/after panes and record:

```text
tmux target
exact Pi command
scenario actions
expected vs observed result
snapshot/log paths
any failure and corrective follow-up
```

The UAT must include at least one negative assertion for the issue (for example: worker `force=true` is rejected; stale assignment result cannot mutate a newer lease; cancelled assignment cannot close a node).

## Decision log

- Execute the roadmap one issue at a time, not through a single broad implementation task.
- Use the configured default model/provider for assigned agents.
- Do not delete historical `.pi/swarm/` runtime state.
- Do not expand the model-facing tool surface merely to support recovery operations; prefer validated orchestrator actions/commands when possible.
