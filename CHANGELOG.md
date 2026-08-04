# Changelog

Notable changes in this project. Newest first.

## Unreleased

### refactor(swarm): split the monolithic index.ts (5310 lines) into a layered module tree

- `extensions/swarm/index.ts` went from **5310 lines / 310KB** (one file: types, helpers, state IO, task-graph, metrics, mailbox, loop, reconcile, 36 tool defs, 8 hooks, command) down to a **21-line entry point** that just wires the modules together and re-exports the 3 unit-tested helpers (`isDeliveryFailureRetryable`, `validateRunAgainstContract`, `computeIterationBest`).
- New layout under `extensions/swarm/src/`:
  - `types.ts` (all type/interface defs), `constants.ts` (all module-level consts), `utils.ts` (pure helpers), `state.ts` (paths + state/lock/trace/JSONL/evidence file IO).
  - `taskgraph.ts` (graph algorithms + status/closure/transitions/render), `metric.ts` (run/memory/iteration validation + ranking), `delivery.ts` (message parsing + retry predicate).
  - `session.ts` (model/orchestrator detection), `identity.ts` (identity markdown + write), `tmux.ts` (tmux wrappers), `mailbox.ts` (read/deliver/pump helpers), `agents.ts` (spawn/reuse/reload), `loop.ts` (loop state), `reconcile.ts` (mail+task sweep + status summary + pump).
  - `hooks.ts` (8 event hooks + orchestrator mailbox pump), `command.ts` (`/swarm` slash command).
  - `tools/{agents,messages,tasks,metrics,loop}.ts` — the 36 tool registrations grouped by domain (9/5/8/12/2).
- Method: every function/const/type body was extracted **verbatim** via a block-splitter (behavior preserved exactly); cross-module + external imports were generated per module. Largest file is now `reconcile.ts` (526 lines); nothing exceeds ~530.
- Verified equivalent: all existing checks stay green — `delivery.test.mjs` (7), `memory.test.mjs` (12), `loop-reconcile.validate.mjs`, `pump-retrigger.validate.mjs`, `reconcile-loop.validate.mjs` (5); plus a new smoke test (full 36-tool load via mock pi) and a functional test (12 tool execute paths). Loaded + exercised live in tmux (`pi v0.83.0`, glm-5.1/zai): `[Extensions] swarm`, `swarm:orchestrator` status line, `/swarm status`, and `.pi/swarm/` state written — all from the refactored tree.

### feat(swarm): graph-advance watcher — harness nudges the orchestrator to assign any ready-but-unassigned node so a graph never stalls mid-flight

- Symptom (seen live in `vai-race-clinic`): `plan_iteration` completes and `implement_change` becomes ready, but the orchestrator only DESCRIBES the next step ("implement_change now just needs to prepare the git toggle…") and ends its turn without calling `swarm_assign_task`. The worker's result message is informational (`requiresAck:false`), so nothing compels the orchestrator to advance, and — unlike the loop boundary states — there was NO harness nudge for a node that is merely ready-but-unassigned mid-graph. The graph stalls until a human intervenes.
- Fix, staying in the harness-as-watcher model (the harness checks state + nudges; the orchestrator remains the actor that assigns): a new `reconcileGraphAdvanceLocked` runs in the same throttled orchestrator-pump tick as the loop watcher. For every `in_progress` task it computes actionable nodes (deps satisfied, `computeReadyNodes`, unassigned) and, after ~`LOOP_RECONCILE_INTERVAL_MS`, sends one idempotent, action-critical (`requiresAck:true`) nudge per stalled node telling the orchestrator the exact call: `swarm_assign_task(taskId=…, nodeId=…)`, plus "keep driving the graph to completion — never end a turn by merely describing the next step, ACT on it". The nudge is auto-acked the moment the node is assigned/terminal (next reconcile tick), so reminders stop as soon as the orchestrator moves.
- This is the mid-graph counterpart to the loop watcher: the loop watcher drives iteration boundaries (plan / reopen / execute); the graph-advance watcher drives the nodes IN BETWEEN, so an `in_progress` task with the orchestrator paying attention runs end-to-end on its own. Safety net only — if the orchestrator assigns immediately on its own, the nudge never fires; it only catches stalls.
- New helper `sendGraphAdvanceNudgeLocked` + watcher `reconcileGraphAdvanceLocked`; reuses `computeReadyNodes` / `ackLoopNudgeLocked`. Validated deterministically by `extensions/swarm/graph-advance.validate.mjs` (6 scenarios: ready-unassigned nudge, assigned→auto-ack, done-task skip, idempotency, unsatisfied-deps skip, parallel-ready) and end-to-end in tmux on a seeded in_progress task (`implement_change` ready-but-unassigned): the orchestrator pump's `session_start` reconcile emitted the assign nudge, the orchestrator acted on it and assigned `implement_change → comp-implementer`, and the next tick auto-acked the nudge.

### feat(swarm): loop-watcher — harness detects loop states and nudges the orchestrator to drive every iteration autonomously

- After the pump fix, a loop-enabled task still stalled at two dead-ends the orchestrator was never told about: (1) **empty `proposalAgents`** (e.g. `vai-race-clinic`'s 20-iter task) kicks off at `phase=awaiting_plan` with nothing to wait for — the orchestrator got a kickoff nudge, acked it, and the loop never advanced because no harness logic reminded it to synthesize a plan; (2) after `swarm_loop_plan` records a plan, `loop.phase` becomes `planned` but **`recordLoopPlan` never reopens the task graph**, so iteration N+1 never executes and no nudge said so.
- Aligned to the loop's design model — **the harness is a state-checker + nudger; the orchestrator (an agent) performs every state change** (plan, reopen graph, execute). Added a throttled (`LOOP_RECONCILE_INTERVAL_MS = 30s`) `reconcileLoopNudgesLocked` watcher that runs inside the orchestrator pump and sends idempotent, action-critical (`requiresAck:true`) nudges for three states, auto-acking once each is resolved:
  - **ready_to_plan** — `phase≠planned` AND no pending proposals (empty pool OR all replied) → nudge "synthesize the next plan now" with carry-forward pointers (`swarm_iteration_context` / `swarm_iteration_status` + latest `distill_memory`). This is the direct fix for the empty-`proposalAgents` dead-end: it explicitly says "there is nothing to wait for". Auto-acked when `phase→planned`.
  - **plan recorded but graph closed** — `phase=planned` AND `task.status=done` → nudge to REOPEN the graph (`swarm_update_task(...,status="pending",force=true)` on the iteration nodes), listing them by name. Sent both immediately from `recordLoopPlan` and as a safety net by the throttled watcher. Auto-acked when the task leaves `done`.
  - **task executing** — `task.status≠done` → auto-ack that round's reopen + plan-now nudges so reminders stop while work runs.
- **Flow A — empty pool is an *intentional* no-op fanout, not a bug, but the nudges now give the orchestrator a choice instead of silently skipping proposals.** `proposalAgents` is an optional config (default `[]`, "no-op fanout is valid" per `getLoopConfig`); it is NOT auto-populated from registered agents and kickoff does NOT auto-fan-out. So an empty pool means the orchestrator plans directly. To keep that useful (an optimization loop benefits from diverse ideas) the kickoff + plan-now nudges now surface a Flow-A option when the pool is empty: "(1) synthesize directly, OR (2) if you want diverse ideas first, send proposal requests yourself to [worker agents] (`swarm_send_message` requiresResponse / `swarm_task_message`), read their replies, then plan". The worker list is computed by a new `availableProposers(st)` helper (every registered agent except the orchestrator). The harness never auto-fans-out — it only tells the orchestrator WHO it can ask; the orchestrator (an agent) decides. (Loop status does not auto-track ad-hoc proposals; the orchestrator collects them.)
- **Design B + kickoff-auto-ack (found diagnosing the live `vai-race-clinic` stall):** the loop used to REQUIRE `swarm_loop_plan` to advance rounds — kickoff's guard skips a new round while `phase ∈ {collecting_proposals, awaiting_plan, refreshing}`, so if the orchestrator reopened the graph WITHOUT recording a loop plan (reasonable, since this task's graph has its own `plan_iteration` node) the loop stuck at that round forever. Two fixes: (1) new `executing` phase — when reconcile sees the graph reopen (`task.status≠done`) it advances the current round's phase from `awaiting_plan`/`collecting_proposals` to `executing`, so the next close-done lets kickoff start a fresh round WITHOUT a separate `swarm_loop_plan` (the graph owns the iteration); `loopStatusSnapshot` + the `/swarm loop status` render report `executing` as "round executing (graph reopened — let it run)". (2) the kickoff nudge (`...:nudge:orchestrator`) was only auto-acked by `recordLoopPlan`, so reopening-without-plan left it unacked → the pump re-triggered it (capped 3×) → wasted turns on "duplicate" responses. reconcile now auto-acks the kickoff nudge too when the task leaves `done`. Validated live: `vai-race-clinic` round 2 (staged but idle) received a clean assign nudge and the orchestrator assigned `plan_iteration` → comp-planner and ran; round 2's phase is `executing` so round 3 will kick off on close-done.
- Also rewrote the **kickoff nudge body** to branch on pool size and to tell the orchestrator up front about the plan → reopen → execute sequence.
- New helpers: `sendLoopPlanNowNudgeLocked`, `sendLoopReopenNudgeLocked`, `ackLoopNudgeLocked`, `reconcileLoopNudgesLocked`; `SwarmState.lastLoopReconcileAt`. Validated deterministically by `extensions/swarm/loop-reconcile.validate.mjs` (10 scenarios across both cells) and end-to-end in tmux on a seeded empty-pool task: reconcile fired on `session_start` and emitted the **plan-now** nudge ("round 1 ready to plan… nothing to wait for"), then after simulating `phase→planned` auto-acked it and emitted the **reopen** nudge, then after reopening the graph auto-acked the reopen nudge — all three cells confirmed in the mailbox + state ledger.

### fix(swarm): orchestrator auto-pump no longer swallows nudges that arrive while busy (loop-nudge-stuck-at-awaiting_plan)

- Root cause: `pumpOrchestratorMailbox` marked a message "surfaced" in the per-pid ledger at read time, BEFORE knowing whether delivery would actually trigger a turn. Delivery used `triggerTurn: true` only when `ctx.isIdle()`; when the orchestrator was busy it fell back to `deliverAs: "followUp"` with no trigger. So a nudge landing while busy (e.g. the iteration-loop nudge fired right at task-close) was followUp-delivered and marked surfaced, then permanently skipped by every later idle pump (incl. `agent_settled`). In `vai-race-clinic` this stranded the 20-iteration loop at `awaiting_plan` forever — the orchestrator was never prompted to record a plan.
- Fix (thorough, 3 parts): (1) **Defer when busy** — a busy pump surfaces/marks nothing and delivers no dead followUp, so the next idle pump (`session_start` / `agent_settled` / 5s interval) re-reads the message and delivers it WITH a real `triggerTurn`. This also stops queuing followUps that could themselves keep `isIdle()` false. (2) **Bounded re-trigger** — a surfaced+triggered but still-unacked `requiresAck` message is re-delivered with a fresh `triggerTurn` after 60s, up to 3 times, so a triggered-but-ignored nudge is not silently lost. Informational (`requiresAck:false`) messages still get exactly one triggered delivery. (3) **Loop nudge is now `requiresAck:true`** (it is action-critical, not informational) and `recordLoopPlan` auto-acks it by idempotencyKey, so reminders stop once a plan is recorded.
- New per-session ledger fields `triggeredAt` / `retriggerCount` (bounded by `PUMP_SESSION_ID_CAP` via a new `capMap` helper); pump trace now reports `idleAtStart`, `deferred`, and `retriggered`. Logic validated deterministically by `extensions/swarm/pump-retrigger.validate.mjs` (busy-defer, idle-trigger, bounded re-trigger, informational-not-retriggered, acked-skipped, fresh-vs-overdue ordering) and end-to-end in tmux: an orchestrator TUI session surfaced+triggered a seeded nudge on `session_start` (`count=1, idleAtStart=true, retriggered=0`) and the orchestrator acked it; interval pumps while that turn ran correctly reported `deferred=1`; the `agent_settled` pump re-ran idle.

### feat(swarm): pick tasks by `#`, uuid, or substring in graph/task/next/validate; `/swarm graph` now lists tasks with age

- Operators had to know a task-id verbatim to use `/swarm graph <id>`. Now every graph-flow command (`graph`, `task`, `next`, `validate`) accepts a **list index** (`1`, `2`, …), a **full task-id/uuid**, or a **distinctive substring** (e.g. `dashboard`, `iteration-demo`, `uat-clean`) — multiple substring hits return an `Ambiguous …` hint plus the list instead of guessing.
- `/swarm graph` (and `task`/`next`/`validate`) with **no argument now prints the indexed task list** so you can discover the `#`/id before re-running. `/swarm tasks` was rebuilt on the same renderer.
- The list is **sorted deterministically** (createdAt asc, task-id tiebreak) so a number you just saw maps to the same task on the next call, and now shows **age** (`17h`, `2d`, …) and an **updated** timestamp per task, plus node completion and `current → next`.
- Shared helpers added: `humanAge`, `listTasksIndexed`, `renderTasksIndexedList`, `resolveTaskArg`. Validated end-to-end in a fresh pi run: `/swarm graph` → `swarm.tasks via:graph-noarg` count=15; `/swarm graph 1` → `task.print` resolved to the oldest task and wrote its graph file; `validate 1`/`next 1` resolve consistently; substring `iteration-demo` resolves uniquely while `dashboard` reports ambiguous — all exit 0 with no crashes.

### feat(swarm): human-facing graph-flow viewing commands (`/swarm tasks|task|next|validate`)

- The agent has rich tools to inspect swarm graph flow (`swarm_task_status`, `swarm_print_graph`, `swarm_next_nodes`, `swarm_validate_graph`), but human operators only had `/swarm graph` and the `/swarm status` rollup. Added four `/swarm` subcommands so a user can see the same graph-flow state from the prompt without asking the model to call a tool:
  - `/swarm tasks` — lists every task graph with status, node completion count, and current/next nodes (so operators can discover task-ids before running the per-task commands).
  - `/swarm task <task-id> [runtime]` — full node/gate table + artifact existence; with `runtime` it also shows the closure roll-up (stored vs derived status, closed/open/stale counts) and agent/message/liveness warnings. Mirrors `swarm_task_status`.
  - `/swarm next <task-id>` — ready/next nodes plus a suggested reusable agent per ready node. Mirrors `swarm_next_nodes`.
  - `/swarm validate <task-id> [runtime]` — structural graph validation (ids, edges, reachability, terminals, ambiguous branches, rework cycles, path safety) plus optional runtime warnings. Mirrors `swarm_validate_graph`.
- All four reuse the existing module-level helpers the agent tools already use, so behavior is identical to the tool path. Validated end-to-end in a fresh pi session: each command fired its `via: "command"` trace (`swarm.tasks` count=15, `task.status.read` runtime=true, `task.next_nodes`, `task.validate` ok=true) and `/swarm task ... runtime` wrote the full graph + closure render to `.pi/swarm/traces/graphs/<id>.task.txt`.

### fix(swarm): stop the "ack then re-deliver" loop for acked-failed messages

- `swarm_ack_message(status="failed")` set the message record `status = "failed"`, which is the SAME status `swarm_reconcile` uses for retryable DELIVERY failures. So reconcile re-injected messages the recipient had already received and acknowledged as failed -> the agent saw the same message again, acked-failed again, looping until `MAX_ATTEMPTS`/TTL -> `dead_letter`.
- New helper `isDeliveryFailureRetryable(rec)` discriminates via `lastAck`: a `queued`/`failed` message the recipient has ALREADY acknowledged (any ack, incl. `failed`) is terminal and must never be re-injected. Reconcile's re-inject branch, its pending/mailbox branch, and the agent-status `pendingMessages` count now all use it.
- Net effect: acked-failed messages are no longer re-delivered or counted as pending, while genuine never-delivered `queued`/`failed` messages are still retried. Verified end-to-end against live state (the 3 acked-failed records no longer appear as `would_retry`/`pending`/`retried`) plus regression scripts `extensions/swarm/delivery.test.mjs` and `extensions/swarm/reconcile-loop.validate.mjs`.

### feat(swarm): human-facing `/swarm graph` command

- Added `/swarm graph <task-id> [text|mermaid|json]` so a human operator can render a task graph directly without asking the model to call `swarm_print_graph`.
- Supports text, Mermaid, and JSON output using the same graph-print helpers as the tool path.

### feat(packages): expose swarm extension as a real pi package

- Added a real `package.json` manifest with `keywords: ["pi-package"]` and `pi.extensions = ["./extensions"]` so the repo can be installed into another pi project with `pi install /path/to/pi-graph-agents`.
- Added packaged extension entry `extensions/swarm/index.ts` and repointed the local dev entry `.pi/extensions/swarm/index.ts` to re-export from the packaged source.
- Updated `README.md` with package install/usage instructions for a fresh pi project.

### docs(swarm): fresh graph UAT scenario + gap-closure validation

- Added `docs/swarm-graph-uat-scenario.md`, a clean-reset swarm graph UAT scenario covering the happy path, blocked/stale/session probes, both rework loops, and the exact last-live-holder self-stop case.
- Re-ran the scenario from a fresh swarm reset with newly spawned agents and confirmed the previously missing coverage gaps are now exercised end-to-end.
- Recorded two non-blocking findings from the rework loops: after `fix_from_test` the `test` node did not auto-reopen, and after `fix_from_review` the `review` node did not auto-reopen; both required an orchestrator/manual reopen to complete coverage.

### feat(swarm): production hardening batch 1 (task closure sweep, reconcile task sweep, PM summary, task-graph UAT)

- **Project-local default model/provider config:** the swarm extension now reads `.pi/settings.json` before env vars when resolving default child-agent `model` / `provider`. Recommended keys: top-level `swarm.defaultModel` / `swarm.defaultProvider`. `extensions.swarm.defaultModel` / `extensions.swarm.defaultProvider` are still accepted for backward compatibility. Precedence is explicit tool params → `.pi/settings.json` → `PI_SWARM_DEFAULT_MODEL` / `PI_SWARM_DEFAULT_PROVIDER` → code defaults/model presets.
- **Reconcile task sweep (WS-B.3/4):** `swarm_reconcile` now sweeps every `task.json` in addition to the mailbox. It reports stored-vs-derived status drift, surfaces stale/nudge signals (dead/stopped/unhealthy/tmux-dead assignee, missing assignee, dead-lettered assignment, `in_progress` past 24h stale / 30min nudge thresholds, delivered-but-unacked assignment), and stamps advisory `node.staleAt`. New `mark` param persists the recomputed `task.status` to repair drift; reconcile is otherwise mark-only and never auto-fails a node (kept idempotent, no reminder-message storms).
- **PM summary (WS-C):** `/swarm status` now emits a structured rollup (per-task `status/current/next/unacked`, agent counts by runtime/health, `closure:` line) with stable grep-able prefixes, bounded to non-terminal tasks. `swarm_task_status(runtime=true)` already carries the closure block.
- **Cancel path:** `swarm_update_task(force=true, cancelTask=true)` marks a task `cancelled` (sticky; releases all assignments).
- **Task-level blocked derivation:** `computeTaskStatus` now derives task `blocked` when every active (non-terminal, non-pending) node is `blocked` (resumable). Pure; doesn't regress done/failed/in_progress/ready.
- **roleKind id-first inference + self-heal (orchestrator-flagged bug):** `inferRoleKind` now checks the agent id for a strong role keyword before the role text, so e.g. `implementer-02` classifies as `implementer` even when its role prose mentions "reviewer". `ensureAgentDefaults` re-derives `roleKind` unless explicitly pinned (new `roleKindExplicit`), so records self-heal; `swarm_spawn_agent` accepts an optional `roleKind` override.
- **session_shutdown nudge:** now stamps `node.lastActivityAt` and routes the open-assignment nudge to each stale node's assigner (replyTarget) when registered, else orchestrator.
- **PM auto-notify on closure/settle (engine behavior, not prompt policy):** the orchestrator no longer has to poll to learn a worker closed a node or went idle with open work. `swarm_update_task` enqueues a concise mailbox report to the mailbox-only orchestrator when a node transitions into a closure-ish status (`done`/`failed`/`blocked`) — carrying taskId/nodeId/prev→new/outcome/assignee/artifact/task status/next-ready — with a stronger `task <id> closed (<status>)` variant on task-terminal (`done`/`failed`/`cancelled`). `agent_settled` enqueues an `agent <id> settled idle with open assignment(s)` nudge when a worker settles while still holding open work. Both are mailbox-only to `orchestrator`, `requiresAck=false`, gated on the transition (not every update); the settle nudge is cooldown-guarded per agent via persisted `lastSettleNotifyAt` (`SETTLE_NOTIFY_COOLDOWN_MS`) so repeated settles don't storm. No node-status mutation, no tmux inject, no daemon. **Also fixed a pre-existing auto-pump defect** surfaced by the new notifications: `deliverMessageLocked` no longer pre-marks mailbox-only messages in the shared `st.delivered[to]` dedup/surfaced ledger (that set is also used by `pumpOrchestratorMailbox`/`swarm_check_mailbox`), so the orchestrator auto-pump now actually surfaces close/settle/shutdown notifications to a turn without manual `swarm_check_mailbox` polling. The UAT now cross-references pump-traced surfaced ids with the mailbox to assert auto-surface (not just mailbox arrival).
- **Autonomous terminal closer for orchestrator-owned final nodes:** when a worker/tester/reviewer transition makes a ready **orchestrator-owned graph-terminal** node reachable (for example `review --approved--> commit` in the default workflow), the engine now auto-closes that terminal orchestrator node inside the same locked task update instead of waiting for a human PM turn to manually advance the final step. This fixes the graph-loop bug where all worker/reviewer lanes could be finished and idle while the task remained `in_progress` only because the pseudo-orchestrator final node had no autonomous executor.
- **Session-safe + read-safe orchestrator surfacing (review-blocker fix):** the auto-pump previously deduped the orchestrator mailbox against a single shared `st.delivered.orchestrator` ledger that several operations wrote (`pumpOrchestratorMailbox`, `swarm_check_mailbox(markDelivered)`, `swarm_ack_message`, tmux-inject paths), so any one of them — including a second orchestrator lane or a validation `pi -p` run — could mark a notification consumed and starve every other orchestrator session of TUI surfacing. The pump now keys "already surfaced" **per process** in a new `st.orchestratorPumpSessions` map (`process.pid`), deliberately **not** `PI_SESSION_ID` (a child `pi -p` spawned from an agent's bash inherits the parent's `PI_SESSION_ID`, so keying on it would reintroduce starvation), and it never reads `st.delivered.orchestrator`. `swarm_check_mailbox` is decoupled from the pump (it keeps using the shared ledger, which the pump ignores), so a manual `check_mailbox(markDelivered=true)` or an explicit ack can no longer pre-empt a later pump surface. Bounded by `PUMP_SCAN_WINDOW`/`PUMP_SESSION_ID_CAP`/`PUMP_SESSION_TTL_MS`. The `mailbox.orchestrator_pump` trace now carries `cid` (pid) and `sid` (`PI_SESSION_ID`) for attribution. UAT section 12 proves both: two distinct orchestrator sessions each surface one notification (no theft), and `check_mailbox(markDelivered)` does not pre-empt a later pump surface.
- **Orchestrator auto-pump: decision/delivery split + print-mode-safe + identity fix (loop-blocking fix):** two corrections. (1) The pump now splits **decision** from **delivery**: the surfacing decision (scan mailbox, update the per-pid `orchestratorPumpSessions` set, emit `mailbox.orchestrator_pump`) is ctx-free file IO and runs in **every** orchestrator session including `pi -p`/rpc/json — the `session_start` one-shot is now **awaited** (was fire-and-forget, so it raced print-mode process exit) so a short-lived validation turn reliably completes the decision before teardown. The **TUI delivery** (`pi.sendMessage`/`ctx.isIdle()`) is mode-gated to the live interactive orchestrator session (no-op in print mode). The 5s polling **interval** stays tui-only because its long-lived captured ctx is the real source of the `This extension ctx is stale after session replacement or reload` error; on any ctx error the pump stops itself cleanly (traced `mailbox.orchestrator_pump_error`) and the next `session_start` restarts a fresh pump. (2) **Identity fix:** `unset PI_SWARM_AGENT_ID` does **not** make a session the orchestrator — `currentAgentId()` returns the inert `swarm-guest` unless `PI_SWARM_IS_ORCHESTRATOR=1` is set, and the `session_start` hook returns early for guests (so the pump never started and PM auto-surface could not be exercised). `scripts/swarm_task_uat.sh` now `export PI_SWARM_IS_ORCHESTRATOR=1` (worker lanes still override via `PI_SWARM_AGENT_ID`, which wins in `currentAgentId`). Documented the reload contract (extension code is not hot-applied; `/reload` required; multi-process-safe pid keying; on reload it re-surfaces recent un-acked notifies as recovery).
- **Closure on create:** `swarm_create_task` now applies `computeTaskStatus` so a fresh task's status is engine-derived (`ready`).
- **Task-graph UAT (WS-A):** new committed entrypoint `scripts/swarm_task_uat.sh`. It drives the task tools end-to-end against throwaway ids in an **isolated working tree** (never touches live swarm state), running as the orchestrator, and asserts on `task.json`/state/traces (model-independent). Covers create→ready, assign→orchestrator, update→done closure, **auto-close of orchestrator-owned terminal nodes**, failed closure, cancel, task-level `blocked` derivation (+resumable), roleKind id-first inference, fabricated-stale reconcile, fabricated-drift `mark=true` repair, and PM auto-notify (node-close → orchestrator mailbox; worker settle-with-open-work → orchestrator mailbox).
- **Docs (WS-D):** `docs/swarm-task-graph.md` documents `computeTaskStatus` rules, the stale/nudge ladder, and marks `swarm_stop_agent`/`swarm_gc_agents`/`swarm_release_agent_task` as deferred; `docs/swarm.md` adds a "Task graph and closure" section + task-graph UAT validation; README adds "Supported now vs deferred".
- Typecheck clean. Existing closure (`computeTaskStatus`/`applyTaskStatus`), validate warning reactivation, and `session_shutdown` nudge are unchanged.

### feat(extensions): `message-timestamp` — time at the start of every agent message

- New project-local extension `.pi/extensions/message-timestamp.ts`. It renders a small dim `HH:MM:SS` timestamp line at the very beginning of each agent (assistant) message in the TUI, including every assistant message in a multi-turn (tool-using) reply.
- Implementation: hooks `message_start` for `role === "assistant"` and appends a TUI-only custom entry (`appendEntry` + `registerEntryRenderer`). Using a custom entry means the timestamp is purely visual — it is **not** added to the message content, so it never pollutes the LLM context.
- Hook choice matters: `turn_start` fires before the user message is committed to the log (so an entry there renders above the user message); `message_start` for the assistant role fires as the agent reply itself begins, so the entry lands right at the top of the agent message.
- Validated in an isolated tmux session (`ext-validate-msgts-*`, pi 0.83.0, glm-5.1/zai-coding-cn): confirmed correct placement for both a single-turn reply and a two-turn tool-using reply (one timestamp per assistant message). Snapshots under `tmux-snapshots/`.

### fix(swarm): auto-pump orchestrator mailbox reports

- Fixed a PM/orchestrator reporting bug where workers could correctly update task state and send `swarm_send_message(to="orchestrator")`, but the orchestrator would not notice until it manually polled the mailbox.
- The orchestrator session now runs a session-scoped mailbox pump that marks pending orchestrator messages delivered and surfaces them locally as `swarm-message` events, using `triggerTurn` when idle and `followUp` while busy.
- This preserves mailbox-only routing for the orchestrator pseudo-agent while making completion reports and handoffs visible without manual `swarm_check_mailbox`.

### feat(swarm): engine-enforced task closure for task graph loop

- Added Commit 4 task-graph execution tools to `.pi/extensions/swarm/index.ts`: `swarm_assign_task`, `swarm_update_task`, and `swarm_task_message`.
- Made assignment a durable runtime contract in `task.json`, with task-scoped handoff metadata, active-task lifecycle bookkeeping, and task-state-driven graph advancement.
- Added engine-enforced closure behavior and PM-facing closure summaries/runtime warnings so stale/open assignments, dead-lettered handoffs, ack-done-without-task-update, and other closeout inconsistencies are surfaced from machine state instead of pane text.
- Validated through swarm review/self-validation loops with typecheck-clean current tree and dedicated task-graph closure/detector evidence under `.pi/swarm-uat/runs/`.

### fix(extensions): `compact-resume` — avoid double agent-run on pre-prompt compaction

- **Bug:** the `ctx.isIdle()` delivery branch conflated two idle cases. A
  threshold compaction can also run *before* a queued user message is sent
  (`prompt()` → `_checkCompaction` → `_runAgentPrompt`, while idle) — e.g. after
  resuming a large session, or aborting a huge response then typing. There the
  old code fired `triggerTurn`, starting a second `_runAgentPrompt` that raced
  the user's own run and could corrupt agent state or throw "Agent is already
  processing".
- **Fix:** delivery is now trigger-specific, not just idle-state: manual
  `/compact` (idle, nothing pending) → `triggerTurn`; threshold mid-run
  (`!idle`) → `followUp` (drained by the continuation loop); threshold while
  idle (pre-prompt) → **skip** (a user turn is already imminent, so resuming is
  redundant and unsafe).
- **Validation:** regression-checked both preserved paths in an isolated tmux
  session — the `followUp` probe still yields `FOLLOWUP_OK`, and a manual
  `/compact` still auto-resumes. Snapshot under
  `tmux-snapshots/compact-resume-validation/fix-regression-run.txt` (gitignored).

### feat(swarm): task graph MVP (create/status/validate/print/next)

- Added the first task-graph layer to `.pi/extensions/swarm/index.ts` with task state/types, atomic `task.json` writes, and `.pi/swarm/tasks/<task-id>/` runtime layout.
- Added swarm tools: `swarm_create_task`, `swarm_task_status`, `swarm_validate_graph`, `swarm_print_graph`, and `swarm_next_nodes`.
- Added backward-compatible structured agent metadata defaults for reuse (`roleKind`, `capabilities`, `activeTaskIds`, `maxConcurrentTasks`) plus internal reusable-agent matching.
- Validated in dedicated tmux UAT lanes with real task creation/printing/validation/status flows; evidence kept under `.pi/swarm-uat/runs/`.

### harden(extensions): `compact-resume` followUp probe + settings.json config

- Added a dedicated validation probe at `scripts/compact_resume_followup_probe.ts` to empirically confirm that a `turn_end` hook can queue `pi.sendMessage(..., { deliverAs: "followUp" })` and have pi's continuation loop drain it without user input.
- Hardened `.pi/extensions/compact-resume.ts` config loading so env vars still win, but project-local `.pi/settings.json` can now override `enabled`, `manual`, and `max` under `extensions["compact-resume"]` (or top-level `compactResume`).
- Kept default-on behavior intentionally; the extension exists to close a project-wide usability gap, while `.pi/settings.json` now provides a no-code project override.

### feat(extensions): `compact-resume` — auto-continue the task after compaction

- **Problem:** pi goes idle after an ordinary auto-compaction (`reason:
  "threshold"`) or a manual `/compact` (`reason: "manual"`), because both set
  `willRetry: false`. Only `reason: "overflow"` (a hard context-overflow error
  caught mid-run) auto-retries. So after a normal compact the agent stops and
  you have to type "continue" yourself, even when it was mid-task.
- **Fix:** new project-local extension `.pi/extensions/compact-resume.ts`. It
  hooks the `session_compact` event and injects one `[compact-resume]` message
  that tells the agent to resume in-progress work (or confirm completion).
  Delivery branches on `ctx.isIdle()`: a `followUp` (fed into pi's existing
  continuation loop) during a run, or `triggerTurn: true` when idle.
- **Loop safety:** skips `overflow` (already retries); smart guard stops once a
  resume turn does no tool work; hard cap of consecutive auto-resumes since the
  last real user message (default 5).
- **Config (env):** `PI_COMPACT_RESUME` (0 disables), `PI_COMPACT_RESUME_MANUAL`
  (1 to also resume after explicit `/compact`), `PI_COMPACT_RESUME_MAX`. Status
  via the `/compact-resume` command.
- **Validated:** end-to-end in an isolated tmux session (pi 0.83.0,
  glm-5.1/zai-coding-cn) — after `/compact` the agent automatically started a
  continuation turn, inspected state, and stopped gracefully. Snapshot kept
  under `tmux-snapshots/compact-resume-validation/` (gitignored).
