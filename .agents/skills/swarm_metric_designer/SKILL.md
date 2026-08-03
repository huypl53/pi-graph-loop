---
name: swarm-metric-designer
description: >-
  Use this whenever the user wants pi-swarm or a swarm graph to optimize, iterate,
  compare improvement, define project-specific metrics, record run evidence, or
  persist swarm memory from prior runs. Trigger on requests like "tối ưu", "metric",
  "accuracy/improvement", "iteration loop", "benchmark", "swarm memory", "lưu kinh nghiệm",
  "evidence-backed memory", or "demo optimization loop" in the context of swarm agents/graphs.
---

# swarm_metric_designer

Design a **project-specific metric contract** and a minimal evidence-backed iteration loop for pi-swarm. Do **not** assume a fixed metric such as accuracy, latency, or cost unless the project/user defines it.

## Core principle

Swarm is the harness. The project defines the metric.

The skill should produce a small, reviewable contract and a demo/run plan. Avoid complex optimizer machinery until the file-backed evidence flow works.

## Conversation flow

When this skill triggers, first extract any answers already present, then ask only the missing questions:

1. What is the goal to improve?
2. What is the primary metric called?
3. Is higher better, lower better, target-based, or boolean pass/fail?
4. Where does the metric value come from?
   - artifact JSON
   - command output
   - markdown report
   - human/reviewer verdict
   - external system
5. Which artifact path should be authoritative for the value?
6. What makes a run invalid even if the score looks better?
7. What evidence must exist before a claim can become swarm memory?
8. What minimum change should count as meaningful improvement?

If the user says to keep it simple, prefer artifact-based metrics:

```text
artifacts/metrics.json -> $.<metric_id>
```

## Output 1: metric contract draft

Create or propose `.pi/swarm/metrics/<metric-id>.json` and `.md` only after user confirmation, unless explicitly asked to write files.

Minimal JSON:

```json
{
  "id": "metric-demo-quality",
  "title": "Demo Quality Metric",
  "primaryMetric": {
    "id": "quality_score",
    "direction": "maximize",
    "valueType": "number",
    "source": {
      "type": "artifact",
      "artifactPath": "artifacts/metrics.json",
      "jsonPath": "$.quality_score"
    },
    "minimumMeaningfulChange": 0.01
  },
  "validityRules": [
    "metrics artifact must exist",
    "summary artifact must exist",
    "diff or git commit evidence must exist"
  ],
  "evidenceRequired": [
    "metrics.json",
    "summary.md",
    "diff.patch or git commit"
  ],
  "status": "draft"
}
```

Keep run-specific fields out of the metric contract. `runId`, `agentId`, `taskId`, `model`, `provider`, and timestamps belong in run records.

## Output 2: run record protocol

Each graph execution should create an append-only record plus artifact files.

Recommended layout:

```text
.pi/swarm/runs/runs.jsonl
.pi/swarm/runs/<run-id>/artifacts/
```

Record shape:

```json
{
  "runId": "run-001",
  "metricContractId": "metric-demo-quality",
  "taskId": "task-...",
  "nodeId": "evaluate",
  "agentId": "tester",
  "model": "gpt-5.4-mini",
  "provider": "openai",
  "startedAt": "...",
  "endedAt": "...",
  "status": "done",
  "verdict": "pass",
  "metrics": {
    "quality_score": 0.67
  },
  "inputs": {
    "summary": "Strategy B candidate"
  },
  "evidenceRefs": [
    ".pi/swarm/runs/run-001/artifacts/metrics.json",
    ".pi/swarm/runs/run-001/artifacts/summary.md",
    ".pi/swarm/runs/run-001/artifacts/diff.patch"
  ],
  "git": {
    "baseCommit": "abc123",
    "headCommit": "def456"
  },
  "notes": "quality_score improved from baseline"
}
```

If tied to a swarm task graph, prefer task artifacts and `task.json.sharedContext`/`task.json.evidence` as the durable source of truth. Mailbox messages are notifications, not authoritative memory.

## Output 3: memory promotion rule

Memory is not free-form notes. Promote only evidence-backed claims.

A memory claim may be accepted only if:

- source run exists;
- verdict is `pass` or explicitly reviewer-approved;
- required evidenceRefs exist and are readable;
- evidence includes git commit or diff artifact when code/config changed;
- reviewer/curator approves or user explicitly waives review.

Memory record shape:

```json
{
  "memoryId": "mem-001",
  "claim": "Strategy B improved quality_score from 0.60 to 0.67 in run-001.",
  "scope": {
    "kind": "metric-contract",
    "id": "metric-demo-quality"
  },
  "sourceRunId": "run-001",
  "evidenceRefs": [
    ".pi/swarm/runs/run-001/artifacts/metrics.json",
    ".pi/swarm/runs/run-001/artifacts/summary.md",
    ".pi/swarm/runs/run-001/artifacts/diff.patch"
  ],
  "verdict": "pass",
  "confidence": 0.8,
  "reviewedBy": "reviewer",
  "createdAt": "...",
  "status": "active",
  "expiresAt": null
}
```

Do not promote from:

- pane-only text;
- ack notes;
- mailbox-only claims without artifact refs;
- incomplete runs;
- unreviewed impressions.

## Implemented tool surface (V1)

These `swarm_*` tools implement the contract above (file-backed, no daemon, no vector DB):

- **Metric contracts**: `swarm_metric_define` (create/replace `.pi/swarm/metrics/<id>.json`), `swarm_metric_get`.
- **Run records**: `swarm_run_record` (append-only `.pi/swarm/runs/runs.jsonl` with best-effort git capture + safe evidence refs), `swarm_run_get`, `swarm_run_compare` (generic 2..N run comparison; contract `direction` wins, else `higherBetter` is a hint).
- **Evidence-backed memory**: `swarm_memory_propose` (runs the evidence gate; rejects pane-only/ack-only/incomplete claims but still appends them as `rejected` for audit), `swarm_memory_search` (substring + scope filter), `swarm_memory_accept` (`proposed`→`active`/`rejected`, re-runs the gate before activating).

The **evidence gate** (propose + accept): source run must exist with verdict `pass`/`approved`; `evidenceRefs` must be non-empty, safe relative paths that exist and are readable; a code/config-changing run must carry a git commit or a `.patch`/`.diff` ref. Promotion is never automatic.

## Demo iteration pattern

Use a two-case demo:

1. Valid improvement (uses the real tools above):
   - `swarm_metric_define` (project metric, e.g. `quality_score`)
   - baseline run via `swarm_run_record` (score 0.60, full evidence + git)
   - `swarm_run_record` run-001 (score 0.67, full evidence + commit)
   - `swarm_run_compare([baseline, run-001], metricId="quality_score")` → shows improvement
   - `swarm_memory_propose(sourceRunId=run-001)` → `status=proposed` (gate passes)
   - `swarm_memory_accept(memoryId=..., status="active")` → `status=active`
   - `swarm_memory_search(status="active")` returns it
2. Incomplete evidence:
   - run-002 (score 0.72) with missing summary/diff evidence
   - `swarm_run_compare` may still record the metric value
   - `swarm_memory_propose(sourceRunId=run-002)` → `status=rejected` with `rejectionReason`
   - `swarm_memory_search(status="active")` must NOT return it

Success question:

```text
Can we reconstruct what happened from only git commit, artifact files, task.json/sharedContext, and trace lines?
```

If yes, V1 is good. If no, add the minimum missing file-backed field; do not add a new subsystem.

## Iteration loop V1

On top of metric/run/memory, a thin **iteration session** coordinates an evidence-backed improvement loop. No daemon, no native graph cycles — the "loop" is a sequence of explicit tool calls. Session state lives in `.pi/swarm/iterations/<iteration-id>.json` and stores **ids only** (it references `metricContractId`, `runId`s, pinned `memoryId`s; it never duplicates run/memory payloads).

Tools (4):

- `swarm_iteration_create(metricContractId, baselineRunId?, memoryIds?)` — start a session over an existing metric contract (all ids validated to exist).
- `swarm_iteration_record(iterationId, runId, label?, memoryIds?)` — add an existing run, recompute best/improvement, optionally pin more active memories; warns (trace) on cross-contract runs.
- `swarm_iteration_status(iterationId, includeContext?)` — session JSON + derived best/improvement roll-up (per-run value, baseline/best, `improvement`, `meaningful`, missing-metric count).
- `swarm_iteration_context(iterationId, memoryLimit?)` — next-iteration retrieval: previous best run summary + active evidence-backed memories for the session scope (pinned or scope-matching). Proposed/rejected memories are never carried forward.

Best/improvement is **generic**: `computeIterationBest` reads `run.metrics[contract.primaryMetric.id]` and honors the contract `direction` (`maximize`/`minimize`/`target`/`passfail`); `meaningful` uses `minimumMeaningfulChange` when set. No hard-coded accuracy/latency/cost anywhere.

Iteration demo flow (real tools):

1. `swarm_metric_define` → contract `metric-demo-quality`, primary `quality_score`, `direction=maximize`, `minimumMeaningfulChange=0.01`.
2. `swarm_run_record` baseline → `quality_score=0.60`, full evidence + git commit.
3. `swarm_iteration_create(metricContractId, baselineRunId)`.
4. Attempt iteration 1 → `swarm_run_record` run-001 (`quality_score=0.67`, evidence + commit).
5. `swarm_iteration_record(iterationId, runId=run-001)` → `bestRunId=run-001`, improvement +0.07, `meaningful=true`.
6. `swarm_memory_propose(sourceRunId=run-001)` → proposed; `swarm_memory_accept` → active.
7. `swarm_iteration_context(iterationId)` → returns best run summary + active memory → feeds the next agent.
8. Repeat for iteration 2; `swarm_iteration_status` shows the trend + best.

Negative case: record an iteration run missing the primary metric → `status` reports `present:false` and `bestRunId` is unchanged; the run is counted but does not win.

Success question: from the session JSON + `runs.jsonl` + `memory.jsonl` + trace lines alone, can an agent reconstruct the best run, the improvement, and the carry-forward memories? If yes → V1 done.

## Harness response rule

For swarm messages with `requiresResponse=true`, ack is lifecycle only. The receiving agent must send a result message using `swarm_send_message(replyTo=<original>)` or `swarm_task_message`, then ack `done` with `resultMessageId`. If a worker only acked/pane-printed, treat the run/memory as invalid until artifact-backed response exists.
