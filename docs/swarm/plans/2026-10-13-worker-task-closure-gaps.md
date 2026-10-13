# Plan: Worker task-closure gaps — structured update-task errors, class-based failure signals, spawn-assign hint, taskless-worker detector

> **Status:** PLAN (2026-10-13, before any source change). Derived from live incident
> `p9-prompt-assembly-fix` (workflow-agents, 2026-10-13T02:07Z) + gap review in session
> `2026-10-13T03-10-12` (pi-graph-agents).
> **Incident summary:** root spawned a worker via `swarm_spawn_agent(initialPrompt=…)` with NO
> task graph; worker finished, messaged root OK, then `swarm_update_task(taskId="p9-prompt-assembly-fix")`
> failed with bare `Task not found` (no errorCode, no valid ids, no guidance); worker got zero
> nudges (all nets are assignment-keyed), improvised by `ls`-ing `.pi/swarm/tasks/`, and went
> idle. Node tracking never existed; recovery depended on model luck.
> **Bug-fix mandate:** every stage below is RED-first: the named reproduction (pure test or
> mock-llm fixture lane) is written and observed failing BEFORE the source fix for that stage.
> **No silent swallowing:** all new catch paths route to `logSwarmError` (or carry an explicit
> `expected()`-style compaction comment); no empty catches anywhere.

## 0. Problem — four confirmed gaps

| # | Layer | Gap | Evidence |
|---|---|---|---|
| G1+G3 | Error contract | `readTaskByRef` throws bare `Task not found: <id>` (`state.ts:319`) — the FIRST failure a finishing worker hits is the only `swarm_update_task` failure site that bypasses `failTaskTool` entirely. No errorCode, no valid task ids, no "you may not need this tool" guidance. | incident step [174]; grep: every other failure site in `task-core.ts` uses `failTaskTool` |
| G2 | Runtime signals | A failed `swarm_update_task` emits NO recoverable signal. Settle-notify requires non-empty `activeTaskIds` (empty here); artifact-progress sweep needs an assigned node; task-stall needs an existing task; `tool.invoked cls:"thrown"` is trace-only, nobody consumes it. | `hooks/settled.ts` predicate; `nudges/artifact-progress.ts`; `tools/wrapper.ts` |
| G4a | Spawn surface | `swarm_spawn_agent` has no taskId/nodeId params (by design, confirmed) and its success response never tells root that the new worker is tracked by NO task graph until a separate `swarm_assign_task` call. Root must remember an invisible second step. | `tools/agents/lifecycle.ts:30-92` |
| G4b | Lifecycle detection | A running worker with zero tasks and zero requiresResponse inbound is invisible: orphan-watch clears on ANY delivered message (the spawn prompt itself clears it, `mailbox.ts:943`), and its warning path is trace-only anyway. Identity explicitly blesses taskless workers ("remain available") but nothing tells root the worker exists untracked. | `agents.ts:44-91`; `identity.ts:250` |

## 1. Contract

### 1.1 Stage A — structured `TASK_NOT_FOUND` payload (G1+G3)

In `updateTaskCore` (and the same wrap in `tools/tasks/assign.ts` + `tools/tasks/inspect.ts`
call sites that surface to agents), the `readTaskByRef` failure is converted to `failTaskTool`:

- errorCode: `TASK_NOT_FOUND` (new constant).
- `expected.validTaskIds`: readdir of `p.tasksDir` (existing task.json only), sorted, capped at
  20 ids + `"(+N more)"` suffix.
- `expected.myActiveTaskIds`: `st.agents[me].activeTaskIds ?? []`.
- `actionableHint` (conditional):
  - if `myActiveTaskIds` is empty AND caller is not root: *"No task graph is tracking your work.
    If the work is done or blocked, report it with swarm_send_message(to=\"root\") —
    swarm_update_task is not required without an assigned node. If you expected an assignment,
    ask root to assign one (swarm_assign_task)."*
  - otherwise: *"Run swarm_task_status for a valid task id, or pick from validTaskIds."*
- `suggestedNextCall`: `{ tool: "swarm_task_status" }` when tasks exist; omitted (hint carries
  the message-only guidance) when the task dir is empty for this caller.
- Message lifecycle side effect: a `TASK_NOT_FOUND` failure must NOT mutate any state (already
  true — throw precedes writes) and must NOT mark anything stale.

### 1.2 Stage B — update-failure signals: class-based, NOT pure streak (G2)

> **Design correction (review 2026-10-13):** the incident worker called `swarm_update_task`
> ONCE, failed, and STOPPED — a streak-3 gate never fires in exactly the motivating scenario.
> Failures are therefore classified; closure-intent and orphan-context failures notify
> IMMEDIATELY, only mid-work failures use the streak.

New module `extensions/swarm/src/nudges/update-failure.ts`:

- State: `st.agents[agentId].updateFailureStreak?: number`,
  `lastUpdateFailureAt?: string`, `lastUpdateFailureCode?: string`,
  `lastUpdateFailureClass?: "closure" | "orphan" | "work"` (optional agent-record fields;
  reset on success).
- `classifyUpdateFailure(params, errorCode, myActiveTaskIds)` (pure):
  - `"closure"` — the call carried terminal intent: `params.status ∈ {done, failed, blocked,
    cancelled}` or `params.cancelTask === true` (the worker believes the work is FINISHED and
    tried to record it; a failed attempt leaves a dangling done-in-head worker).
  - `"orphan"` — errorCode `TASK_NOT_FOUND` AND `myActiveTaskIds` empty (no net exists for
    this worker: settle-notify is keyed on activeTaskIds, artifact-progress on assigned nodes).
  - `"work"` — everything else (mid-work transition/outcome/ownership errors; the model is
    still in-turn, reads the Stage A error text, and may self-correct).
- `recordUpdateOutcomeLocked(st, agentId, ok, errorCode?, classification?)` — pure state
  mutation, called inside the EXISTING `withLock` in `tools/tasks/update.ts` execute: on thrown
  error or `ok:false` result → stamp class + increment streak; on success → reset streak to 0
  and clear code/class. Root calls do not count (root failures are root-visible by
  construction).
- Emission (same lock, after recording):
  - **class `closure` OR `orphan` (IMMEDIATE, first failure):**
    - self-nudge to the WORKER via `deliverMessageLocked` (priority high, requiresAck false,
      requiresResponse false, idempotencyKey `update-failure:{agentId}:self:{taskId}:{nodeId}:{class}`):
      names the errorCode + the corrective hint (single source: `hintForErrorCode(code, ctx)`
      exported from the Stage A wrap so nudge and error payload never drift) + instruction:
      *"if you cannot fix the call, report status to root via swarm_send_message — do not
      silently go idle believing the node is recorded."* Delivery note: if the worker goes
      idle anyway, the settled hook's `surfaceAgentPending` re-surfaces this unacked message
      at settle — the nudge is not lost to an early stop.
    - root notice via `deliverMessageLocked(to:"root")` (idempotencyKey
      `update-failure:{agentId}:root:{taskId}:{nodeId}:{class}`, cap 2 per
      (agent,taskId,node), cooldown `UPDATE_FAILURE_ROOT_COOLDOWN_MS` default 600_000):
      agent id, task/node id, errorCode, classification, and the recommendation set (inspect
      the worker, reassign, or force-close/waive). Durable + reconcile re-injected — this is
      the guaranteed net when the worker cannot even message root.
  - **class `work` (streak-gated):**
    - **streak === UPDATE_FAILURE_SELF_NUDGE_AT (default 3):** self-nudge as above
      (idempotencyKey `update-failure:{agentId}:self:streak:{streak}`).
    - **streak === UPDATE_FAILURE_ROOT_ESCALATE_AT (default 6):** root notice as above.
    - Beyond the escalate threshold: silent increment (root already has the escalation;
      re-escalate only after a successful update resets the streak).
- De-path rule: nudge bodies name tools + ids only, zero raw filesystem paths.
- Trace: `update_failure.recorded` `{ agentId, class, code, streak }` on every failure;
  `update_failure.self_nudge` / `update_failure.root_notice` on emission; emission failures
  go to `logSwarmError` and never fail the tool result.

### 1.3 Stage C — spawn response assign hint (G4a)

`swarm_spawn_agent` success `textResult` gains a deterministic second paragraph (always, when
the caller is root or any coordinator — i.e. always, since spawn is coordinator-only):

```
NOTE: this agent is NOT tracked by any task graph yet. To attach its work to the task graph
(and get progress/closure nudges), assign a node:
  swarm_assign_task(taskId="<taskId>", nodeId="<nodeId>", agentId="<spawnedId>")
If this is a message-only helper (no task graph), it will report back via swarm messages.
```

No new params, no behavior change to spawn itself. Pure response-text + docs change.

### 1.4 Stage D — taskless-worker detector (G4b)

New pump maintenance phase `evaluateTasklessWorkerNudgeLocked(pi, cwd, p, st, nowMs)` in
`nudges/taskless-worker.ts`, wired in `surface/pump-phases.ts` AFTER the idle-agent-GC phase
(that phase owns reclamation; this one owns "never got a task" visibility).

Eligibility per non-root agent (ALL must hold):
- `status === "running"`
- `activeTaskIds.length === 0`
- agent age (`now - createdAt`) > `TASKLESS_GRACE_MS` (default 15′, env
  `PI_SWARM_TASKLESS_GRACE_MS`)
- NO unresolved requiresResponse inbound message addressed to it (same inbound scan shape as
  `fireOrphanWarning` — a worker holding a contractual reply is NOT taskless)
- no open graph node assigns it (`isTaskReferenced` from `agent-gc.ts`)
- no valid reuse/park lease, `paused !== true` (mirror idle-gc gates)

Per-agent state `st.tasklessNudgeState[agentId] = { selfNudges, rootNotices, lastNudgeAt }`:
- self-nudge to the worker: cap 1 per spawn-era (reset when the agent gains then loses a task —
  simple rule: cap 1 per agent record; the message says "if your work is done, report to root;
  if you are a message-only helper, ignore this").
- root notice: cap 2, cooldown `TASKLESS_ROOT_COOLDOWN_MS` (default 30′). Subject
  `Agent ${agentId} is running with no task-graph assignment`; body offers exactly:
  `swarm_assign_task` (names the agent) or ignore-if-message-only. Names ONLY LLM-callable tools.
- idempotencyKeys: `taskless:{agentId}:self:1` / `taskless:{agentId}:root:{seq}`.
- Config: optional `tasklessNudge:` block (enabled/afterMs/rootCooldownMs) parsed by the same
  layering as `agentGc.idleNudge`; env kill-switch `PI_SWARM_TASKLESS_NUDGE_OFF=1`; disabled
  state traced once per process.
- Overlap with idle-agent-GC is intentional and documented: idle-GC = "alive too long, reclaim
  it" (20′ idle-gated); taskless = "spawned but never attached" (age-gated, fires even while
  busy — that is the incident shape). Different thresholds, different bodies, no dedupe required.

### 1.5 Pi-runtime contract (mandatory consultation — done)

- No new Pi-runtime crossing is introduced: both nudge families deliver through the existing
  `deliverMessageLocked` → `pi.sendMessage` path (L1 durable record + existing pump/inject
  surface). No new claim is made about Pi queue/interrupt semantics → **no new §10 R-row**;
  this plan cites the existing mailbox-delivery rows.
- R10-1 boundary-counting assertions (required because new code paths cross the delivery
  boundary): per family, a test counts `pi.sendMessage` calls at the REAL boundary and asserts
  `sendMessageCalls === nudgesEmitted` (self + root), and `=== 0` when disabled / capped /
  cooldown-gated.
- No use of `ctx.abort` / `ctx.reload` / input events anywhere in the new modules.

## 2. Files

| File | Change |
|---|---|
| `extensions/swarm/src/state.ts` | `readTaskByRef` gains an exported structured failure helper (`taskNotFoundDetails`) — throw site stays, callers convert |
| `extensions/swarm/src/primitives/task-core.ts` | Stage A wrap (`TASK_NOT_FOUND` via `failTaskTool`) + `hintForErrorCode` export |
| `extensions/swarm/src/tools/tasks/assign.ts`, `inspect.ts` | same Stage A wrap at their `readTaskByRef` agent-facing sites |
| `extensions/swarm/src/nudges/update-failure.ts` | NEW — Stage B recording + emissions |
| `extensions/swarm/src/tools/tasks/update.ts` | call `recordUpdateOutcomeLocked` in the existing lock; pass thrown errorCode |
| `extensions/swarm/src/types/state.ts` | optional agent fields + `SwarmTasklessNudgeState` + `SwarmState.tasklessNudgeState?` |
| `extensions/swarm/src/constants.ts` | `TASK_NOT_FOUND`, `NOTIFY_KEY_*` templates, thresholds + `UPDATE_FAILURE_ROOT_COOLDOWN_MS`, trace names, env overrides, scaffold-comment block |
| `extensions/swarm/src/tools/agents/lifecycle.ts` | Stage C hint text |
| `extensions/swarm/src/nudges/taskless-worker.ts` | NEW — Stage D evaluator |
| `extensions/swarm/src/surface/pump-phases.ts` | wire Stage D phase (after idle-GC, try/caught → `logSwarmError`) |
| `extensions/swarm/src/nudges/graph-advance.ts` | re-export new evaluators (facade convention) |
| `extensions/swarm/src/agent-gc-auto.ts` (config reader) | parse `tasklessNudge` block (layering identical to `idleNudge`) |
| `extensions/swarm/src/pool-scaffold.ts` via constants | commented `tasklessNudge` scaffold block (comments-only, parse-to-null invariant) |
| `docs/swarm/tools.md`, `extensions/swarm/README.md`, `docs/swarm/operations.md` | error-contract + nudge-family + module-map rows |
| `CHANGELOG.md` | entries after green, per changelog-guide |

## 3. Fixtures (compulsory, mock-llm — one per behavior change)

- **`extensions/mock-llm/fixtures/update-task-not-found.jsonl`** — worker turn calls real
  `swarm_update_task(taskId="does-not-exist", …)`. Assert: error payload carries
  `errorCode:"TASK_NOT_FOUND"`, `expected.validTaskIds` (seeded), `myActiveTaskIds: []`, and
  the message-only hint naming `swarm_send_message`; NO state mutation (task dir untouched,
  no mailbox records).
- **`extensions/mock-llm/fixtures/update-failure-signals.jsonl`** — seeded worker WITHOUT any
  task graph (the incident shape); scripted turns:
  1. ONE closure-intent failing call (`status:"done"` on a nonexistent task) → assert BOTH the
     worker self-nudge AND the root notice exist immediately (no streak gate);
  2. worker settles → assert the self-nudge is surfaced by the settled catch-up path;
  3. a `work`-class failure (INVALID_TRANSITION on a seeded task) ×3 → self-nudge at 3;
  4. 3 more `work` failures → root escalation at 6; then 1 successful update → streak reset
     (a subsequent single `work` failure does NOT re-escalate).
  Timing-controlled via `delayMs`; abortable, deterministic.
- **`extensions/mock-llm/fixtures/spawn-taskless-hint.jsonl`** — root turn spawns an agent;
  assert spawn result text contains the assign-hint paragraph with the spawned agent id; then
  root calls `swarm_assign_task` on a seeded graph and the assignment succeeds normally.
- **`extensions/mock-llm/fixtures/taskless-worker-detect.jsonl`** — seeded world: `worker-fresh`
  (running, no tasks, age < grace → untouched), `worker-taskless` (running, no tasks, age 20′,
  no requiresResponse inbound → self-nudged + root-noticed), `worker-contractual` (no tasks but
  unresolved requiresResponse inbound → untouched), `worker-busy-taskless` (busy, no tasks, old
  → noticed: fires while busy, the incident shape), `worker-with-task` (untouched). Assert
  mailbox rows + idempotency keys + caps.

## 4. RED tests (written first, observed red, then green)

1. `extensions/swarm/tests/task-not-found-payload.test.mjs` — pure: missing task dir → throw
   carries `errorCode/expected.validTaskIds/expected.myActiveTaskIds/actionableHint`; hint text
   switches on `myActiveTaskIds`; seeded dir lists real ids; cap-20 rendering; guest/root
   behavior unchanged.
2. `extensions/swarm/tests/update-failure-signals.test.mjs` — pure state machine:
   `classifyUpdateFailure` matrix (closure / orphan / work); closure-intent FIRST failure →
   immediate self-nudge + root notice (once; 2nd within cooldown suppressed; cap 2);
   orphan-class (TASK_NOT_FOUND + empty activeTaskIds) → immediate; `work`-class: self-nudge
   exactly at 3 (once), root escalate exactly at 6 (once), silent beyond; reset-on-success;
   root-calls-don't-count; **R10-1: sendMessageCalls === emissions, 0 when gated**;
   `hintForErrorCode` single-source assertion (nudge body reuses the Stage A hint verbatim).
3. `extensions/swarm/tests/spawn-taskless-hint.test.mjs` — pure: spawn `textResult` contains
   the hint with the spawned id; regression: existing warning header + status line unchanged.
4. `extensions/swarm/tests/taskless-worker-detect.test.mjs` — eligibility matrix (fixture §3
   rows, seeded state, no LLM); cap 1 self / 2 root; cooldown; disabled → zero emissions;
   **R10-1 boundary count**.
5. Mock-llm fixture lanes under `extensions/mock-llm/tests/` driving the REAL registered tools
   for each fixture (pattern: `mock-llm/tests/agent-stopped-gc.test.mjs`).

## 5. Implementation order + validation

Stages are independently shippable; each lands red→green with its own tests before the next:

1. **Stage A** (smallest, unblocks everything) → 2. **Stage B** → 3. **Stage C** → 4. **Stage D**.

Validation per AGENTS.md: dedicated tmux session `ext-validate-closure-gaps-<hhmmss>`; run
`pi --provider mock-llm --model <fixture> -e ./extensions/mock-llm -e ./extensions/swarm` for
each fixture in a scratch cwd; capture before/after panes; cite
`.pi/mock-llm/transcripts/<fixture>/` + `errors.jsonl` (must contain zero new entries) in the
final report. Gates: `npm run test:swarm` + `npm run test:mockllm` green (per-suite exit codes).

## 6. Out of scope

- Adding taskId/nodeId params to `swarm_spawn_agent` (rejected in review — hint-only, keeps
  spawn single-responsibility).
- Changing orphan-watch clear semantics (watch = "got any contractual message", by design;
  taskless detector supersedes its blind spot).
- Auto-assign, auto-retry of failed updates, or any auto-stop (root decides; worker self-nudge
  only advises messaging root).
- Making `tool.invoked` telemetry a consumption surface (the class-based failure recorder is
  the signal).
