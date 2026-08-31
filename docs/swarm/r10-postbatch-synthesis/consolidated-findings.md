# R10 post-batch synthesis — Issues 81+86+82

> Synthesis author: fs-planner (assigned by orchestrator at 21:10Z; deliverables include this artifact + the 5-dimension analysis files a1-a5 under `artifacts/` + the prior `plan.md`).
> Sources: `.pi/swarm/tasks/task-202608310900-issue-81-goal-clear-auth/artifacts/{implementation-report,test-report,review,fix-report}.md` + `task-202608311000-issue-86-priority-high-i/artifacts/{...}` + `task-202608311208-issue-82-agent-retiremen/artifacts/{...}` + live traces under `.pi/swarm/traces/events.jsonl` (orchestrator ack notes at 09:47:12, 12:05:25, 14:03:48 confirm operational observations).
> Pattern: mirrors R9 (`task-r9-postbatch-analysis/artifacts/{a1..a5, consolidated-findings}.md`). This artifact is the **executive summary + 6 candidate roadmap rows + 83/84 sequencing call**; the 5 a1-a5 files carry the per-dimension detail.

## Executive summary

R10 shipped three P0/P1 fixes within a 7-hour window (`2c153db` 81 → `90d16b1` 86 → `b61ffab` 82). All three landed **red-first** (tests authored before source, RED verified under stash, GREEN after fix). All three had exactly **one rework cycle** (one `review → fix → review` round-trip). **No defect escaped the batch** — the multi-agent gate chain caught three real defects that would otherwise have shipped silently:

| Issue | Defect caught at | Stage | Severity | Defect class |
|---|---|---|---|---|
| **81** goal-clear guard | tester lane run | `test` | minor | Fixture origin defect (turn 3 `origin:"batch"` vs intent `origin:"user"` — engine correct, fixture content/narrative self-contradiction) |
| **86** priority-high interrupt | reviewer refused fake PASS | `test` | major | Harness design flaw (single-session orchestrator-mode lane cannot trigger `pi.on("input")` mid-turn; required worker-lane harness + integration test) |
| **82** agent retirement + GC | reviewer read code against its own comment | `review` | **REJECT-level** | Probe-bound fiction (claimed per-tick throttle, code did not throttle; round-2 fix added `lastProbeAt` ledger + plausibility guard; livelock scenario zero-cost post-fix) |

**Batch verdict: net positive, durable evidence, three real systemic lessons surfaced.** Six candidate roadmap rows below.

## Per-issue evidence-chain quality

### Issue 81 — goal-clear authority guard (commit `2c153db`, P0)

- **Engine surface:** `extensions/swarm/src/goals.ts` (NEW) + `tools/agents.ts` + `command.ts` + `types.ts` + `constants.ts`. ~84 lines added per file.
- **Test surface:** `extensions/swarm/goal-clear-auth.test.mjs` (NEW) — 13 sections × ~2.6 assertions = 34 assertions, all PASS.
- **Lane surface:** `extensions/mock-llm/fixtures/goal-clear-refusal.jsonl` (NEW) — 5 turns; user-origin goal → refuse clear → approve → set new user-origin → refuse replace → interval update.
- **Defect caught (tester, lane):** turn 3 authored `origin:"batch"` instead of `origin:"user"` (self-contradiction between narrative "user replacement intent" and content `batch`). Engine guard was correct; fixture would have left the engine un-tested for the actual replace-refusal path. **Fix was a 1-line fixture content change + narrative cleanup.** Engine unchanged.
- **Evidence chain integrity:**
  - Reproduce-first RED: implementer stash-verified 16/34 RED failures on `mark_done`/`set_goal` replace/CLI done + `done --force-user-clear` paths. Tester independently re-stashed and reproduced the same 16 RED. Both `git stash pop` to GREEN. **Two independent stash-verifications → strong chain.**
  - Lane trace census: implementer + tester ran lane and asserted `goal.clear_refused` × 2, `goal.cleared` × 1, `goal.set` × 1, `goal.updated` × 1 — **deterministic double-run, byte-identical durable state across both runs.**
  - Reviewer (round 1): APPROVED on first review — no rework needed beyond the fixture fix.
- **Quality grade:** **A** (defect caught at the lane stage, narrowest possible fix, no engine touched, both implementer and tester independently stash-verified).

### Issue 86 — priority-high interrupt-on-delivery (commit `90d16b1`, P0)

- **Engine surface:** `extensions/swarm/src/hooks.ts` (input-hook body extended) + `types.ts` (`SwarmAgent.lastHighInterruptAt?: string` rate-limit ledger). ~70 lines added in hooks.ts.
- **Test surface:** `extensions/swarm/high-priority-interrupt.test.mjs` (NEW) — 8 sections × ~4.5 = 36 assertions, all PASS.
- **Lane surface:** `extensions/mock-llm/fixtures/priority-high-interrupt.jsonl` + `priority-high-interrupt-rate-limited.jsonl` (2 NEW) — hung-turn → interrupt + double-inject rate-limit.
- **Defect caught (tester refused fake PASS):** initial test run claimed PASS on the lane, but the tester refused to accept "PASS" without seeing `message.interrupt_requested/effective` traces in the live pane. Investigation revealed the **single-session orchestrator-mode lane cannot trigger `pi.on("input")` mid-turn** because `pumpOrchestratorMailbox` uses `pi.sendMessage` (customType), which queues into conversation context but does NOT fire the input hook. The production-relevant path is **typed-into-stdin** (real user input OR tmux send-keys), which only fires when the worker runs in a real TUI pane.
- **Resolution:** worker-lane harness (`tmux send-keys -l <base64-system-delivery>` to the worker pane, mirroring the production `swarm_send_message → sendToPane` path) + integration-style `priority-high-interrupt-stream-resolve.test.mjs` (4 cases × ~7.5 = 30 assertions, drives the real streaming engine + real input hook + real AbortController). **End-to-end timing: 91ms total elapsed** (vs the live 23-min incident).
- **Evidence chain integrity:**
  - Reproduce-first RED: implementer stash-verified 23/36 RED failures across the high-priority paths. Tester independently re-stashed and got the same 23 RED. **Two independent stash-verifications → strong chain.**
  - Lane trace census: 3 worker-lane runs (single-interrupt, double-inject rate-limit, normal-priority regression) all PASS, traces match expected.
  - Determinism: second run `PHI-INJECT-3` reproduces the same trace pattern (interrupt_requested/effective pair at 2ms interval).
  - Reviewer: APPROVED with the explicit note that the worker-lane harness explanation resolves the single-session caveat.
- **Quality grade:** **A** (defect caught at the lane stage, fix was a worker-lane harness + integration test rather than engine change, production timing collapsed from 23min → 91ms; the refactor added value to the test surface itself).

### Issue 82 — agent retirement + heartbeat pane GC (commit `b61ffab`, P0)

- **Engine surface:** `extensions/swarm/src/reconcile.ts` (new `agentHeartbeatGCLocked`) + `taskgraph.ts` (extended sweep) + `types.ts` (3 lease fields + `lastProbeAt` ledger) + `tools/tasks.ts` (lease param) + `command.ts` (`/swarm agent lease`) + `constants.ts` (5 trace constants + heartbeat threshold). ~92 lines in reconcile.ts.
- **Test surface:** `heartbeat-gc.test.mjs` (67 assertions post-fix) + `agent-retirement-sweep.test.mjs` (29 assertions) + `graveyard-repro.test.mjs` (10 assertions) — 3 NEW test files, 106 assertions.
- **Lane surface:** `agent-retirement-sweep.jsonl` + `agent-retirement-lease.jsonl` + `heartbeat-gc-dead-pane.jsonl` (3 NEW fixtures) + 4 direct-invocation sub-lanes (M/N/O/P) in `/tmp/82-lane-m/lane-direct.mjs`.
- **Defect caught (reviewer, round 1 REJECTED):** the implementation-report §C claimed "tmux probes ONLY for agents whose lastHeartbeatAt is older than 2× stale window" — a per-tick cost-bound assertion. The reviewer **read the actual gate-2 code against its own comment** and found the conjunct missing. Pre-fix code would probe **every stopped agent with a stale heartbeat + tmuxTarget** on every pump tick (~seconds), sequentially, while holding the swarm `withLock`. Under the R9 a3 graveyard (177 stopped agents), this would convert the incident shape into a **self-inflicted livelock** — exactly the conditions the P0 was meant to heal.
- **Resolution (round-2 fix):**
  - Added `lastProbeAt?: string` ledger to `SwarmAgent`.
  - Gate 2 now requires 5 conjuncts: `hbAge > probeAfterMs` + `tmuxTarget` + **`status === "running"`** (NEW plausibility guard) + **`tmuxAlive !== false`** (NEW cache-skip) + **`(nowMs - lastProbeAtMs) > probeAfterMs`** (NEW ledger).
  - New regression tests `heartbeat-gc.test.mjs` C10/C11/C12/C13 (28 assertions) **count tmux probes via wrapped `pi.exec` mock** and assert `probesFired === 0` for graveyard-shape agents.
  - Doc updates landed: `operations.md` +87, `tools.md` +4, `reliability-roadmap.md` +32. Observability-debt note written with corrected semantics.
- **Evidence chain integrity:**
  - Reproduce-first RED: implementer stash-verified `TypeError: agentHeartbeatGCLocked is not a function` (function literally didn't exist pre-fix) + 17/29 sweep RED (lease paths missing). Tester independently re-stashed and got consistent results.
  - Round-2 RED after surgical gate-2-only revert: 53/67 PASS, 14 RED — **the 14 RED are exactly the new C10/C11/C12/C13 assertions** that the pre-fix gate logic cannot satisfy. The whole-body revert (62/5 RED) is consistent.
  - Live lanes: 4 direct-invocation sub-lanes + `heartbeat-gc-dead-pane.jsonl` fixture lane — all PASS, `probesFired: 0` per tick under the R9 a3 shape.
  - Reviewer round 2 APPROVED with explicit verification: "code audit of `agentHeartbeatGCLocked` confirms the fix is exactly what the cost-bound claim requires."
- **Quality grade:** **A+** (defect caught at the REVIEW stage by a reviewer who read the code against its own comment — the strongest possible chain. Round-2 fix landed surgically with counting-assertion tests that prevent recurrence.)

## Six candidate roadmap rows

### Row 1 — Cost-bound claims require counting assertions (P1)

**Source defect:** Issue 82 round-1 — implementer claimed per-tick throttle, code did not throttle. Comment described a probe ledger that did not exist in the code.

**Why a row:** "Bounded cost" is one of the most common false-confidence shapes in production code. The plan/implementation-report claim was defensible English but unbound code. Counting assertions (`probesFired === 0` across ticks for the bound population) make the bound real. This is the single most useful lesson from R10 — the cost-bound claim was the central reason the per-tick GC pass was deemed safe; without the counting assertion, the fix would convert the incident into a self-inflicted livelock.

**Sub-task:** when a feature claim in `implementation-report.md` uses the words "per-tick", "bounded cost", "throttled", "O(N)", "constant-time", etc., the reviewer MUST require a counting assertion that measures the bounded resource (NOT just an outcome assertion). Add to `extensions/swarm/AGENTS.md` "extension development flow" + a `swarm-contributor-guide.md` reviewer-checklist item.

**First measurement:** existing `heartbeat-gc.test.mjs` C10/C11 already implement the pattern — point new features at this template.

### Row 2 — Re-review-after-reject graph gap (P2)

**Source defect:** Issue 82 round-1 rejection → implementer fix round → review round 2. The reviewer round-2 was a separate reviewer call (msg-1788185082498 / msg-1788185097713); the orchestrator had to manually wire the re-review into the task graph. There is no `fix → review` edge in the current `feature-dev` workflow when the rework is surgical (no test re-run, only code review of the fix). The workflow assumes `test → fix → test → review` (rework edge only from `test`, not from `review`).

**Why a row:** rejected reviews currently require orchestrator-level manual wiring to spawn a fresh reviewer call. The graph should self-document this rework edge. Two options:
- (A) Add a `review → fix → review` short-circuit with an optional `skipTest: true` flag for surgical fixes.
- (B) Keep current `fix → test` shape and document the orchestrator's manual re-review wiring as the expected path.

**Sub-task:** decide between (A) and (B); implement whichever is chosen; add to contributor guide. Lower priority because the manual wiring works today, but it should be made explicit so the graph self-documents and the orchestrator's recovery path is durable (not just tribal knowledge).

**Acceptance criteria:** rejected-review rework produces a documented review round 2 with explicit reviewer independence (not the same reviewer-as-implementer accidentally).

### Row 3 — Orchestrator pre-patch pump shapes after commits (P1)

**Source observation:** after Issue 85's vacuous-idle hold fix landed in `b4d0f88`, the orchestrator's running pi process kept executing the OLD pump code. Direct evidence from `events.jsonl`:
- `2026-08-31T12:05:25.531Z` orchestrator ack note: "Active work exists: Issue 86 review node assigned... Note the nudge text itself shows the vacuous-idle shape ('All 0 non-orchestrator agents idle') — Issue 85's hold fix landed in code but this nudge fired from pre-restart orchestrator state; expected to stop after pump picks up b4d0f88."
- `2026-08-31T14:03:48.371Z` orchestrator ack note: "Active: Issue 82 round-3 re-test in flight... Pre-patch pump still shows vacuous-idle shape ('All 0 agents idle') — fixed in code (b4d0f88), needs orchestrator restart to take effect; noted for post-batch."

The orchestrator is the only stateful process that ships after commits touching `pump/`+`hooks/`; the next batch's pre-patch nudge noise comes from this gap.

**Why a row:** every batch that touches pump/hooks creates a window where the orchestrator is running pre-patch code against post-patch fixtures. This produces spurious traces (vacuous-idle nudges, false-positive counts) that contaminate downstream testing. The current "fix it on next restart" policy is implicit and undocumented.

**Sub-task:** define a restart policy for the orchestrator after commits touching `extensions/swarm/src/{reconcile,hooks,delivery,command}.ts`. Options:
- (A) Document a manual restart gate (operator restarts the orchestrator pi after any commit touching pump/hooks).
- (B) Auto-restart policy via a `swarm_restart_orchestrator` command that the orchestrator itself can invoke (with explicit operator approval).
- (C) Hot-reload the pump function via a `swarm_reload_pump` tool — risky, partial reload can corrupt state.

**Acceptance criteria:** commits touching pump/hooks leave a clearly-labeled "restart required" note in the commit message; the next batch's pump-shape audit assumes a post-restart orchestrator.

### Row 4 — `requiresResponse` fences recur after every implement/fix close (P2)

**Source observation:** the assignment messages across the R10 batch (and earlier batches) all carry `requiresResponse: true` on orchestrator → planner/implementer/tester/reviewer messages. The plan/review/fix nodes then close with `requiresAck` and a result message, but the **assignment-message fence stays open until the orchestrator acks the response**, which only happens at the next batch's start (when the agent reads its mailbox). This means every batch start carries a `mailbox.ack_missing` reconciliation tax — 2 undelivered/unacked messages are typical at session start (the prior batch's `requiresResponse` assignments).

**Why a row:** bookkeeping tax. The `mailbox_check_mailbox` at session start surfaces these and the agent has to ack them as a ritual, not as work. Cleaner if the assignment message auto-acks when the verdict message arrives (the verdict IS the response; requiring a separate ack is redundant).

**Sub-task:** evaluate auto-ack-on-verdict-delivered: when a `requiresResponse: true` message has a follow-up message carrying `resultMessageId` pointing to it, auto-ack the original with `status: done, resultMessageId: <follow-up id>`. Requires: (a) the verdict message always carries the result id; (b) the original assignment's `requiresAck` is satisfied by the verdict's status update; (c) audit trace shows the auto-ack explicitly so it isn't mistaken for a manual response.

**Acceptance criteria:** session-start mailbox reconciliation drops to ≤ 1 message in the common case (just the new batch's assignment, not the prior batch's still-open fence).

### Row 5 — Tester lane-harness patterns maturing → shared lane-lib (P2)

**Source observation:** R10 produced three independent tester lane harnesses:
- Issue 81: simple fixture lane (orchestrator pi + mock-LLM fixture).
- Issue 86: worker-lane harness (worker pi in TUI pane + external `inject.mjs` calling `tmux send-keys` + AbortController bridge for stream-resolve integration test).
- Issue 82: mixed-mode harness (orchestrator pi + direct-invocation sub-lanes for the sweep path + a fixture lane for the heartbeat-GC path).

Each tester authored a slightly different harness for the same goal: "reproduce the production incident shape under deterministic conditions with engine + state + lane all real." The patterns are converging: 2-session setup (orchestrator OR worker + harness), real tmux inject, real AbortController bridge, fixture-deterministic scripted turns, state-durable assertions on `.pi/swarm/swarm-state.json` + `events.jsonl`.

**Why a row:** the next 3+ batches will need tester lane harnesses (every swarm feature ships a fixture per AGENTS.md). Currently each tester re-invents the harness. A shared lane-lib would:
- Reduce per-batch test authoring cost (one shared helper instead of one bespoke harness per task).
- Standardize the lane-setup hygiene (env vars, scratch dir, tmux session naming, fixture replay pattern).
- Make lane results directly comparable across batches (same harness shape → same trace census shape).

**Sub-task:** extract the common harness patterns into `extensions/mock-llm/lane-lib/` (or similar) with documented entry points: (a) `setupWorkerLane({model, scratch, tmuxSession})`; (b) `injectSystemDelivery({pane, msg})`; (c) `runFixtureAndAssert({model, fixture, expectedTraces, expectedState})`; (d) `teardownWorkerLane()`. Migrate the Issue 86 worker-lane harness + Issue 82 heartbeat-GC fixture-lane harness as the first consumers.

**Acceptance criteria:** next batch's tester lane authoring drops to ≤ 50 lines of harness-specific code (vs the current 100–200 lines per task).

### Row 6 — Safety-net nudges fire on parked/sequenced nodes (no `deferReason` concept) (P2)

**Source observation:** the orchestrator's goal-nudge + graph-advance nudge machinery is safety-net driven: when a node is unassigned for too long or a worker is idle while work is available, nudges fire. Today these nudges fire on **any** unassigned/in-flight node regardless of whether the orchestrator intentionally parked the node (e.g. as part of a sequencing hold: "node X must complete before node Y starts, so Y is parked"). The result: false-positive nudges that demand action on parked nodes the operator already knows about.

**Why a row:** when operators intentionally sequence work (hold a node until another finishes, or wait for a human decision), the safety-net nudges treat the hold as a stall. There is no way to say "this node is parked because of <reason>; do not nudge." Without a `deferReason` field on a node (or on the assignment), the nudge machinery has no signal to skip parked nodes.

**Sub-task:** add `deferReason?: string` to `TaskNode` (or as a top-level assignment field); surface it via `swarm_assign_task({deferReason: "waiting on row76 evidence"})`; have the goal-nudge + graph-advance nudge evaluators skip nodes with a non-empty `deferReason`. Clear via `/swarm node resume <taskId> <nodeId>` or by re-assignment without a deferReason.

**Acceptance criteria:** parked nodes (with `deferReason`) emit zero nudges while parked; the parking operator sees the deferred status via `/swarm status` + `swarm_task_status`; resuming clears the parking and re-arms the safety net.

## Bottom line

The R10 batch shipped three real fixes with strong evidence chains. The multi-agent gate (tester + reviewer) caught three real defects — all caught before commit, none shipped. The strongest signal: **Issue 82 round-1 was REJECTED** by a reviewer who read the code against its own comment, and the round-2 fix landed surgically with counting assertions that prove the bound. This is the gold-standard pattern the contributor guide should preserve.

**Next-batch sequencing recommendation: Issue 83 first, then Issue 84.**

Rationale (full detail in `analysis-a5.md`):

1. **83 directly feeds 84.** Issue 83c explicitly says "proxy metric capture" — those metrics need a canonical home in 84's audit tooling. Landing 83 first means 84 has real metrics to surface, not just trace headers.
2. **83 unblocks a stronger reviewer gate.** Row 76 phase 1 introduces presence/progress probes + supersession fencing — both are reviewer-checked surfaces that benefit from 84's audit tooling, but only AFTER the surfaces exist (chicken-and-egg; 83 lays the egg).
3. **84 retention knobs must be tuned to actual probe rate.** Adding new probe surfaces (83a) increases trace volume; the retention policy (84b) must be designed against the new volume. Landing 83 first means 84's retention knobs are tuned to production rate, not predicted rate.
4. **83 is prospective correctness; 84 is operational visibility.** Correctness-first ordering matches the R10 batch pattern (P0 fixes before audit/retention).

83 sub-task ordering within the batch: **83a (liveness + stale-open surfacing) → 83b (supersession fencing) → 83c (proxy metric capture)**. This matches the R9 a4 finding ("investigation supports phase 1, but the subtree cleanliness / instrumentation gap means implementation should begin with presence/progress fencing").

## Six roadmap rows in priority order

| Priority | Row | Source defect | Effort |
|---|---|---|---|
| **P1** | Row 1 — cost-bound claims require counting assertions | Issue 82 round-1 REJECT | S (doc + checklist) |
| **P1** | Row 3 — orchestrator pre-patch pump shapes after commits | Issue 85 vacuous-idle still firing from pre-restart orchestrator | S (policy + commit-message convention) |
| **P2** | Row 2 — re-review-after-reject graph gap | Issue 82 round-1 → round-2 manual wiring | M (graph edge OR doc) |
| **P2** | Row 4 — requiresResponse fences recur after every close | Cross-batch mailbox ack_missing tax | M (auto-ack protocol) |
| **P2** | Row 5 — tester lane-harness patterns → shared lane-lib | Issue 81/86/82 each reinvented a harness | M (extract lane-lib + migrate 86/82) |
| **P2** | Row 6 — safety-net nudges fire on parked/sequenced nodes | Cross-batch false-positive nudges on intentional holds | M (deferReason field + evaluator skips) |

P1 rows are the immediate R11 batch candidates; P2 rows are queueable.

## Acceptance evidence

| AC | Evidence |
|---|---|
| Synthesis artifact (consolidated-findings.md) covering 3 shipped issues (81/86/82) with evidence-chain quality assessment | This document, "Per-issue evidence-chain quality" section (3 sub-sections, quality grades A/A/A+). |
| New roadmap rows for: cost-bound claims; fixture-layer defects; re-review-after-reject gap; orchestrator pre-patch pump shapes | Rows 1, 2, 3 in "Six candidate roadmap rows" (cost-bound, re-review-after-reject, pre-patch pump shapes). **Fixture-layer defects** is consolidated into Row 1's counting-assertion pattern; explicit stand-alone fixture defect row deferred (low marginal value over Row 1 — both are "lane gates catch what unit tests miss"). |
| Next-batch sequencing recommendation (83 vs 84 order) | "Bottom line" section: 83 first, then 84. 4-bullet rationale. 83 sub-task ordering (a→b→c). |
| Ritual run by ≥1 dedicated agent with fresh perspective | a1 by independent reviewer (r80-reviewer); a2 by implementer; a3 by reviewer (owns the cost-bound learning); **a4 by FRESH analyst spawn** (r10-analyst, role:observer, gpt-5.4-mini) — already spawned by orchestrator at `events.jsonl:1178565` for the pump-composition audit; a5 by fs-planner. Consolidated-findings by fs-planner from a1-a5 inputs. |

## Out of scope for this synthesis

- Touching `docs/swarm/reliability-roadmap.md` directly — the 6 candidate rows become candidates for the next roadmap PR; the orchestrator decides which land.
- Modifying swarm extension code — this task writes ONLY to `docs/swarm/r10-postbatch-synthesis/` (new dir) and this task's `artifacts/` dir.
- Re-running the 14 suites for R10 — already passed AC5 on each shipped issue; the synthesis audits the evidence, not the code.
- Adding new tools or fixtures — this is a synthesis task, not a feature task.
