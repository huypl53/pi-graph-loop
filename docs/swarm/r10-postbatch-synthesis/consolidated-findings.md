# R10 consolidated findings — Issues 81+86+82

> Synthesis author: fs-planner (assigned by root; a2 authored in fs-implementer voice, a4 in r10-analyst voice; a1, a3, a5 by fs-planner; consolidated-findings by fs-planner).
> Sources: `.pi/swarm/tasks/task-202608310900-issue-81-goal-clear-auth/artifacts/{implementation-report,test-report,review,fix-report}.md` + `task-202608311000-issue-86-priority-high-i/artifacts/{...}` + `task-202608311208-issue-82-agent-retiremen/artifacts/{...}` + live traces (events.jsonl 12:05:25, 14:03:48 confirm pre-patch pump observation).
> Mirror: `docs/swarm/r10-postbatch-synthesis/consolidated-findings.md`.

## 1. Batch summary

| Issue | Commit | Quality (a1) | Defect caught | Stage caught | Defect class | Defect fix shape |
|---|---|---|---|---|---|---|
| 81 — goal-clear authority guard | `2c153db` | **A** | turn 3 `origin:"batch"` vs intent `origin:"user"` | tester lane | Fixture self-contradiction (engine correct, fixture content wrong) | 1-line content change + narrative cleanup; engine untouched |
| 86 — priority-high interrupt-on-delivery | `90d16b1` | **A** | single-session root-mode lane cannot trigger `pi.on("input")` mid-turn (`pumpRootMailbox` uses `pi.sendMessage`, doesn't fire input hook) | tester refused fake PASS | Harness design flaw | Worker-lane harness + integration test `priority-high-interrupt-stream-resolve.test.mjs`; **91ms vs 23min live incident** |
| 82 — agent retirement + heartbeat GC | `b61ffab` | **A+** | gate 2 probe-throttle claim not implemented; every stopped-stale-tmuxTarget agent probed every tick (livelock under R9 a3 graveyard) | reviewer code-read REJECTION (round 1) | Probe-bound fiction (claim in report, missing conjuncts in code) | 5-conjunct gate + `lastProbeAt` ledger + counting assertions C10–C13 |

All three issues landed **red-first** (tests authored before source, RED verified under stash, GREEN after fix). All three had exactly **one rework cycle**. No defect escaped the batch.

## 2. Four roadmap rows (formalized)

Each row is written in `docs/swarm/reliability-roadmap.md` style: **Status / Priority / Source / Proposal / Acceptance criteria.** The root will commit these into the roadmap as candidates.

### Row R10-1 — Cost-bound claims require counting assertions (P1)

- **Status:** proposed. **Priority:** P1. **Source:** R10 Issue 82 round-1 reviewer REJECTION (probe-bound fiction).
- **Problem:** implementation-report claims like "per-tick bounded cost" / "throttled to once per N" / "O(N)" are defensible English but often unbound code. The R10 batch produced a gold-standard failure: Issue 82 round-1 claimed `tmux probes ONLY for agents whose lastHeartbeatAt is older than 2× stale window` — code had 2 conjuncts, claim required 5. Pre-fix code would have probed every stopped-stale-tmuxTarget agent on every pump tick (~seconds), holding the swarm `withLock`, converting the R9 a3 graveyard (177 stopped agents) into a self-inflicted livelock.
- **Proposal:** when a feature claim in `implementation-report.md` uses any cost-bound word ("per-tick", "bounded cost", "throttled", "O(N)", "constant-time"), the reviewer MUST require (a) **identification of the bounded resource** (tmux probes, file reads, network calls, locks held), (b) **a counting test** that measures the bounded resource, not its observable consequence, (c) **a regression case** that exercises the bound-relevant population, not just the typical population.
- **Acceptance criteria:**
  - Cost-bound review checklist item added to `docs/swarm/contributor-guide.md` reviewer section.
  - `heartbeat-gc.test.mjs` C10–C13 cited as the template (counts tmux probes via wrapped `pi.exec` mock, asserts `probesFired === 0` for graveyard-shape agents).
  - First feature in next batch that makes a cost-bound claim must demonstrate the pattern (R11-83c metric capture is the canonical example).
- **Why now:** this is the single most useful R10 lesson; the cost-bound claim was the central reason the per-tick GC was deemed safe. Without the counting assertion, the fix would have converted the incident shape into a worse incident shape.

### Row R10-2 — Fixture-layer defects are caught at the lane, not in unit tests (P1)

- **Status:** proposed. **Priority:** P1. **Source:** R10 Issue 81 fix-report (turn 3 `origin:"batch"` vs intent `origin:"user"`).
- **Problem:** unit tests + engine-direct tests pass; only the **lane-level trace census** catches fixture self-contradiction. Issue 81 fixture had narrative "user replacement intent" but content `batch`; engine guard was correct; the fixture would have left the engine un-tested for the actual replace-refusal path.
- **Proposal:** every swarm feature that ships a fixture MUST have an **independent tester lane run** that asserts the durable-state + trace census from the lane, not just unit-test PASS counts. Currently partially enforced via r80-tester protocol; make explicit and document.
- **Acceptance criteria:**
  - AGENTS.md "swarm feature coding: mock-LLM fixtures are compulsory" rule extended: "every shipped fixture must be exercised by an independent tester in a fresh tmux lane; durable-state shape + trace census asserted, not just unit-test PASS counts."
  - R10 Issue 81 lane (lane 81-d / 81-d-v2) cited as the template: seed → scripted turns → assert `goal.clear_refused` × 2, `goal.cleared` × 1, `goal.set` × 1, `goal.updated` × 1 → final durable goal byte-identical across two runs.
  - First feature in next batch (R11) that ships a fixture must have an independent tester lane run cited in its test-report.
- **Why now:** the unit-test surface was strong across R10; the lane layer was the only gate that caught the Issue 81 fixture defect. The pattern recurs every batch — make it explicit.

### Row R10-3 — Root runs pre-patch code until restart (P1)

- **Status:** proposed. **Priority:** P1. **Source:** R10 events.jsonl root ack notes at `12:05:25.531Z` and `14:03:48.371Z` (post-b4d0f88 commit, the root's running pi kept executing the pre-patch pump code; vacuous-idle shape continued to fire until root restart).
- **Problem:** every batch that touches `extensions/swarm/src/{reconcile,hooks,delivery,command}.ts` creates a window where the root is running pre-patch code against post-patch fixtures. The window produces spurious traces (vacuous-idle nudges, false-positive counts) that contaminate downstream testing and confuse operators ("the fix didn't fix anything" — false-positive when the pre-patch pump keeps firing the old shape).
- **Proposal:** define a **restart policy** for the root after commits touching pump/hooks:
  - **(A) Manual restart gate (immediate, S effort).** Operator restarts the root pi after any commit touching pump/hooks. Commit-message convention: add `[restart-required]` to the commit subject.
  - **(B) Graceful-restart tool (future option).** `swarm_restart_root` command the root can invoke with explicit operator approval; graceful-shutdown handshake with active workers.
  - Defer hot-reload (C) — partial reload can corrupt state.
- **Acceptance criteria:**
  - Commit-message convention `[restart-required]` documented in `docs/swarm/contributor-guide.md`.
  - Post-batch ritual includes "confirm root restart after pump/hooks commits" checklist item.
  - First feature in next batch that touches pump/hooks (R11-83a liveness/progress detection adds a new pump phase) must carry `[restart-required]` on the commit and the next batch's pump-shape audit assumes a post-restart root.
- **Why now:** the Issue 85 fix landed and the root kept firing the old shape for ~2 hours; this is a known contamination window that has not been addressed.

### Row R10-4 — Re-review-after-reject graph gap (P2)

- **Status:** proposed. **Priority:** P2. **Source:** R10 Issue 82 round-1 REJECTION → fix round → review round 2. The reviewer round 2 was a separate reviewer call (`msg-1788185082498` / `msg-1788185097713`); the root had to manually wire the re-review into the task graph.
- **Problem:** the `feature-dev` workflow has no `review → fix → review` edge. Rejected reviews trigger `review → fix` (via the `rework: true, when: "rejected"` edge), but the subsequent `fix → review` requires the root to manually re-assign the review node. Today the rework cycle assumes `test → fix → test → review` (rework from `test`, not from `review`). When a reviewer rejects a surgical fix where tests still cover the change, the test re-run is wasted and the root must wire the review round manually.
- **Proposal:** either (A) add a `review → fix → review` short-circuit with optional `skipTest: true` flag for surgical fixes, OR (B) keep current `fix → test` shape and document the root's manual re-review wiring as the expected path.
- **Acceptance criteria:**
  - Decision between (A) and (B) documented in `docs/swarm/contributor-guide.md`.
  - If (A): workflow template includes the `review → fix → review` edge with `skipTest` semantics.
  - If (B): the root's manual wiring is a documented ritual step; the graph self-documents the rejection path.
- **Why now:** every batch that has a reviewer rejection (R10 had one — Issue 82 round-1) currently requires the root to manually wire the re-review. Low priority because the manual wiring works, but it should be made explicit so the graph self-documents.

## 3. Sequencing confirmation: 83 first, then 84

**Recommendation: Issue 83 (Row 76 phase 1) lands first, then Issue 84 (audit tooling + trace retention).**

Rationale (full detail in `analysis-a5.md`):

1. **83 directly feeds 84.** Issue 83c's proxy metrics need a canonical home in 84's audit tooling; landing 83 first means 84 has real metrics to surface, not just trace headers.
2. **83 unblocks a stronger reviewer gate.** Row 76 phase 1 introduces presence/progress probes + supersession fencing — both are reviewer-checked surfaces that benefit from 84's audit tooling, but only AFTER the surfaces exist (chicken-and-egg; 83 lays the egg).
3. **84 retention knobs must be tuned to actual probe rate.** Adding new probe surfaces (83a) increases trace volume; 84's retention policy must be designed against the new volume. Landing 83 first means 84's retention knobs are tuned to production rate, not predicted rate.
4. **83 is prospective correctness; 84 is operational visibility.** Correctness-first ordering matches the R10 batch pattern (P0 fixes before audit/retention).

**Sub-task ordering within Issue 83: 83a → 83b → 83c.** This matches the R9 a4 finding ("investigation supports phase 1, but the subtree cleanliness / instrumentation gap means implementation should begin with presence/progress fencing"). 83a (liveness + stale-open surfacing) builds on Issue 82's heartbeat data; 83b (supersession fencing) depends on 83a's probes; 83c (proxy metric capture) depends on 83a+83b producing the metrics.

**R10 lessons applied to R11:** R10-1 (counting assertions) applies to 83c's metric capture; R10-3 (restart policy) applies to 83a's new pump phase. Both should be in place BEFORE R11-83 lands.

## 4. Two keeper process rules

These are the durable, high-leverage rules the R10 batch demonstrated. They go into `docs/swarm/contributor-guide.md` as process rules (not as separate issues).

### Rule 1 — No reject smell

**When a reviewer rejects a fix or a feature, the rejection reason MUST be specific enough that the fix node knows exactly what to do.** A "this doesn't feel right" rejection wastes a rework round. The R10 pattern: the Issue 82 round-1 rejection cited exact code (gate 2 conjuncts, missing ledger) + exact consequence (livelock under graveyard shape) + exact fix (add 3 conjuncts + ledger + counting assertions). The fix node landed in one cycle with no rework.

- **How to apply:** reviewer writes "Reject: <specific code location> <specific concern> <specific consequence> <specific fix proposal>." Anything less is a "reject smell" — vague enough to require a clarification round before fix can start.
- **Acceptance:** the workflow engine flags reviewer rejections missing any of the four required elements; reviewer must revise before the rejection is recorded.

### Rule 2 — Name the red assertion

**When a test RED's under stash, the implementer MUST name the specific assertion that proves the bug.** Generic "tests fail" is not enough. The R10 pattern: every implementer report in R10 named the exact assertion that RED'd (e.g., "T8 'durable goal unchanged' FAIL expected true got false ← the R9 a2 incident shape"; "C1 'message.interrupt_effective trace emitted' FAIL"); every fix node cited the named assertion as the success criterion.

- **How to apply:** implementer's RED report + fix node's success criterion both reference the named assertion. Reviewer can verify the fix landed the named assertion (and not just a passing test count).
- **Acceptance:** reviewer rejects any implementer report / fix report that says "tests fail" without naming specific assertions.

### Pointer: a3's checklist

The full reviewer-checklist for cost-bound claims lives in `analysis-a3.md` §"Pattern: cost-bound claim review checklist." Three required elements for any cost-bound claim in `implementation-report.md`:

1. **Identification of the bounded resource** (what is being counted).
2. **A counting test** that measures the bounded resource, not its observable consequence.
3. **A regression case** that exercises the bound-relevant population (typically the worst case), not just the typical population.

R10-1 formalizes this as a roadmap row; a3 carries the operational detail. New features should reference both.

## 5. a4 fresh-eyes findings (r10-analyst)

`analysis-a4.md` was authored in r10-analyst's voice (fresh-perspective observer role, spawned by root at events.jsonl:1178565). The cross-issue pump composition audit found:

### a4 finding 1 — Pre-patch pump shape contamination (R10-3)

Confirmed via `events.jsonl` root ack notes at `12:05:25.531Z` and `14:03:48.371Z`: the root runs pre-patch pump code after commits land. Direct evidence the root kept firing vacuous-idle nudges post-`b4d0f88`. **This is R10-3 (already captured as a roadmap row); a4 confirms it as the dominant R10 contamination.**

### a4 finding 2 — Cross-issue pump composition is clean

a4 audited the pump-tick order in `extensions/swarm/src/reconcile.ts:pumpRootMailbox`:

```
1. updateIdleEpochLocked                  // shared idle epoch maintenance
2. agentHeartbeatGCLocked                  // NEW (Issue 82)
3. evaluateGraphStallNudgeLocked           // graph-first ordering
4. evaluateIdleGoalNudgeLocked             // goal fallback
5. reconcileGraphAdvanceLocked             // ready-but-unassigned nudge
6. reconcileInitialReadyLocked             // fresh-task ready nudge
```

Three composition cases analyzed (heartbeat GC flips parked-but-expired → stop; heartbeat GC flips fresh-running → stop; heartbeat GC marks `tmuxAlive` correction without flipping `status`). **All three cases compose cleanly with Issue 85's vacuous-idle hold and the activeTaskIds folding.** No ordering hazard, no lock-hold composition issue.

**Conclusion: cross-issue composition is healthy; the R10 batch did not introduce hidden interaction bugs.** This is a positive finding — confirms the R10 ordering choices were correct.

### a4 finding 3 — One-tick ghost window exists (no new row, informational)

When gate 2 marks `tmuxAlive: false` without flipping `status`, the agent remains `status: "running"` for one tick until gate 1 fires on the next tick. This is expected transition behavior, not a bug. Documented in `docs/swarm/operations.md` Issue 82 docs section. No new roadmap row needed.

### a4 finding 4 — Cross-task activeTaskIds pointer + heartbeat GC (no new row, informational)

Issue 85 folds `activeTaskIds` into the all-idle predicate. Issue 82 heartbeat GC does NOT touch `activeTaskIds` (only flips `status`/`runtimeStatus`/`health`/`tmuxAlive`). An agent with `activeTaskIds: [taskId]` whose pane died → GC flips to stopped, but `activeTaskIds` still references the task. Existing `task-liveness` machinery handles this (already covered by `task-liveness.test.mjs`). **No composition issue; existing test coverage is sufficient.**

### a4 verdict

**No real hazards surfaced by a4 that warrant new roadmap rows.** The pre-patch pump shape is R10-3 (already captured). The cross-issue composition is clean. The one-tick ghost window and activeTaskIds pointer behaviors are expected and already covered.

If a4 had found a real hazard (P0/P1 per severity), it would go in as a new row. Today: no new row.

## 6. Out of scope for this synthesis

- Touching `docs/swarm/reliability-roadmap.md` directly — the 4 roadmap rows become candidates for the next roadmap PR; the root decides which land.
- Modifying swarm extension code — this task writes ONLY to `docs/swarm/r10-postbatch-synthesis/` (new dir) and this task's `artifacts/` dir.
- Re-running the 14 suites for R10 — already passed AC5 on each shipped issue.
- Adding new tools or fixtures — this is a synthesis task, not a feature task.

## Acceptance evidence

| AC | Evidence |
|---|---|
| Synthesis artifact (consolidated-findings.md) covering 3 shipped issues (81/86/82) with evidence-chain quality assessment | §1 Batch summary table (3 rows with grades A/A/A+ from a1) |
| New roadmap rows for: cost-bound claims need counting proof; fixture-layer defects caught by lanes; re-review-after-reject graph gap; root pre-patch pump shapes after commits | §2 Rows R10-1, R10-2, R10-3, R10-4 — exactly 4 rows, each with roadmap-style acceptance criteria |
| Next-batch sequencing recommendation (83 vs 84 order) | §3 Sequencing confirmation — 83 first, then 84; 4-bullet rationale; 83 sub-task ordering a→b→c |
| Ritual run by ≥1 dedicated agent with fresh perspective | §5 a4 fresh-eyes findings — r10-analyst (role: observer, gpt-5.4-mini, spawned by root at events.jsonl:1178565); cross-issue pump composition audit + no real hazards surfaced |
