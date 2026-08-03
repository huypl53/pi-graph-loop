# Swarm Iteration Loop Demo (UAT)

A small, runnable UAT that exercises the full file-backed metric/run/memory + iteration loop V1 stack in a **fresh, isolated** pi session:

```text
metric contract -> runs -> memory -> iteration context
```

…plus the **negative case**: a run with incomplete evidence must NOT promote memory (the evidence gate rejects it; zero active memories may reference it).

## What the demo proves

- A project-specific metric contract (`demo-quality-score`, `quality_score`, `maximize`) can be defined and used without any hard-coded metric.
- Runs are recorded append-only with evidence refs + best-effort git capture.
- An evidence-backed memory proposes → accepts → is searchable as `active`.
- An **incomplete-evidence** run (`demo-run-002` references a deliberately-absent `missing-summary.md`) is **rejected** by the gate; it never becomes `active`.
- An iteration session derives best/improvement generically from the contract `direction` and carries forward only `active` evidence-backed memories via `swarm_iteration_context`.

## Prerequisites

- `pi` installed and on `PATH`.
- A reachable model/provider (default `glm-5.1` / `zai-coding-cn`; override with `SWARM_MODEL` / `SWARM_PROVIDER`).
- `python3` on `PATH` (used for the file-backed assertions; `jq` is **not** required).
- The packaged extension source present at `extensions/swarm/index.ts`. The script aborts if `.pi/extensions/swarm/index.ts` also exists (duplicate-extension guard).

## Quick start

```bash
bash scripts/swarm_iteration_demo.sh
# or with overrides:
SWARM_MODEL=glm-5.1 SWARM_PROVIDER=zai-coding-cn bash scripts/swarm_iteration_demo.sh
DEMO_MODE=single bash scripts/swarm_iteration_demo.sh   # one pi -p with the full narrative (LLM-flaky)
```

Env overrides: `SWARM_MODEL`, `SWARM_PROVIDER`, `SWARM_CWD`, `DEMO_MODE` (`steps` default | `single`), `SWARM_MAX_ATTEMPTS`, `SWARM_STEP_DELAY`.

The script prints a final line:

```text
ITER_DEMO_RESULT: PASS|FAIL (failures=N)
```

and exits non-zero on any failure.

## The deterministic scenario

Shared by the script (`DEMO_MODE=steps`) and the docs narrative. Fixed literal ids run inside an isolated cwd so re-runs never collide.

### Part A — metric / run / memory + negative case

| # | Tool call (literal) | Marker |
|---|---|---|
| 1 | `swarm_metric_define` `id=demo-quality-score`, primaryMetric `{quality_score, maximize, number, source artifact}`, evidenceRequired `[run-001-summary.md]` | `DEMO_METRIC_DEFINED: demo-quality-score` |
| 2 | `swarm_run_record` `demo-baseline`, verdict `pass`, `quality_score=0.60`, evidence `[baseline-summary.md]` | `DEMO_BASELINE: demo-baseline` |
| 3 | `swarm_run_record` `demo-run-001`, verdict `pass`, `quality_score=0.67`, evidence `[run-001-summary.md, run-001.patch]` | `DEMO_RUN001: demo-run-001` |
| 4 | `swarm_run_compare` `[demo-baseline, demo-run-001]`, `metricId=quality_score` | `DEMO_COMPARE: best=demo-run-001` |
| 5 | `swarm_memory_propose` claim about run-001, `sourceRunId=demo-run-001`, scope `demo-quality-score` | `DEMO_PROPOSE_VALID` |
| 6 | `swarm_memory_accept` `<mem001>` → `active` | `DEMO_ACCEPT: active` |
| 7 | `swarm_memory_search` `status=active` | (search performed) |
| 8 | `swarm_run_record` `demo-run-002`, verdict `pass`, `quality_score=0.72`, evidence `[missing-summary.md]` (**absent**) | `DEMO_RUN002: demo-run-002` |
| 9 | `swarm_memory_propose` claim about run-002, `sourceRunId=demo-run-002` | `DEMO_PROPOSE_INCOMPLETE` (gate rejects) |
| 10 | `swarm_memory_search` `status=active` | `DEMO_RUN002_PROMOTED: no` |

**Negative-case invariant (primary proof):** step 8's run-002 references `missing-summary.md`, which the script intentionally does **not** create. The evidence gate rejects the step-9 proposal; no active memory may source run-002.

### Part B — iteration loop on top

| # | Tool call | Marker |
|---|---|---|
| 11 | `swarm_iteration_create` `demo-iter-001`, `metricContractId=demo-quality-score`, `baselineRunId=demo-baseline`, `memoryIds=[<mem001>]` | `DEMO_ITER_CREATE: demo-iter-001` |
| 12 | `swarm_iteration_record` run `demo-run-001`, label `prompt-tightening` → best, improvement +0.07, meaningful | `DEMO_ITER_RECORD: best=demo-run-001` |
| 13 | `swarm_iteration_status` `includeContext=true` | (status roll-up) |
| 14 | `swarm_iteration_context` → best run summary + active memory | (context bundle) |

`mem001` (step 5's memoryId) is threaded from the file-backed store (`memory.jsonl`) — not from fragile stdout parsing. `iterId` is the fixed literal `demo-iter-001`.

## File-backed assertions (primary; model-independent)

All under the isolated `$SWARM_CWD/.pi/swarm/`:

- `metrics/demo-quality-score.json` exists, `primaryMetric.direction == maximize`.
- `runs/runs.jsonl` contains exactly 3 distinct run ids: `demo-baseline`, `demo-run-001`, `demo-run-002`.
- `memory/memory.jsonl`: exactly one record with `status == active` and `sourceRunId == demo-run-001`.
- `memory/memory.jsonl`: the run-002 proposal has `status == rejected` with a non-empty `rejectionReason`.
- **Key invariant:** zero active memories reference `sourceRunId == demo-run-002` (proves incomplete evidence does not promote).
- `iterations/demo-iter-001.json` exists, `bestRunId == demo-run-001`, `iterations.length >= 2`, `pinnedMemoryIds` includes `<mem001>`.
- `traces/events.jsonl` contains: `metric.define`, `run.record`×3, `run.compare`, `memory.propose`×2, `memory.accept`, `iteration.create`, `iteration.record`, `iteration.status`, `iteration.context`.

Stdout markers (e.g. `DEMO_RUN002_PROMOTED: no`, `DEMO_ITER_RECORD: best=demo-run-001`, `DEMO_DONE`) are secondary/best-effort only.

## Review artifacts / log paths

The script resolves and prints `LOG_DIR` at the end of every run:

```text
<repo>/.pi/swarm-uat/runs/iter-demo-<STAMP>/
  harness.log                 # step-by-step log + PASS/FAIL assertion lines
  demo.prompt.txt             # the deterministic narrative (reference for reviewers)
  <step>.out / <step>.err / <step>.code   # per-step pi output (steps mode)
  single.out / single.err / single.code   # single-mode output (if DEMO_MODE=single)
  cwd/.pi/swarm/metrics/demo-quality-score.json
  cwd/.pi/swarm/runs/runs.jsonl
  cwd/.pi/swarm/memory/memory.jsonl
  cwd/.pi/swarm/iterations/demo-iter-001.json
  cwd/.pi/swarm/traces/events.jsonl
  cwd/.pi/swarm/demo-evidence/             # baseline-summary.md, run-001-summary.md, run-001.patch
```

## Reviewing iteration state (live + completed)

A dependency-free (python3 + bash) reviewer renders `.pi/swarm` iteration state **two ways**: a **live watch** while a demo/loop runs, and a **completed/historical review** (e.g. a finished task graph or iteration) as a one-shot report or Markdown dashboard. It is **read-only** and writes nothing unless you pass `--out FILE`.

```bash
DEMO_CWD="$(ls -td .pi/swarm-uat/runs/iter-demo-*/cwd | head -1)"

# live review while/after the demo (clear + refresh + sleep until Ctrl-C):
scripts/swarm_iteration_watch.sh --cwd "$DEMO_CWD" --interval 2

# one snapshot for a review artifact (exits 0):
scripts/swarm_iteration_watch.sh --cwd "$DEMO_CWD" --once > "$DEMO_CWD/watch.txt"

# review a COMPLETED swarm loop (repo root, default --cwd .):
scripts/swarm_iteration_watch.sh --once                      # full text review report
scripts/swarm_iteration_watch.sh --all-tasks --once           # browse every task graph
scripts/swarm_iteration_watch.sh --task <taskId> --once       # one completed task graph

# Markdown dashboard with Mermaid diagrams (renders in any MD viewer/GitHub):
scripts/swarm_iteration_watch.sh --format markdown --out review.md
scripts/swarm_iteration_watch.sh --format markdown --task <taskId> --out task-review.md
scripts/swarm_iteration_watch.sh --format mermaid  --once > diagrams.mmd   # fenced blocks only

# focus one session / run / task graph:
scripts/swarm_iteration_watch.sh --iteration <id> --once
scripts/swarm_iteration_watch.sh --run <runId> --once
scripts/swarm_iteration_watch.sh --task <taskId> --messages full --once
```

Also works against repo-root live state: `scripts/swarm_iteration_watch.sh` (default `--cwd .`), or `WATCH_CWD=<dir> scripts/swarm_iteration_watch.sh --once`.

Flags: `--cwd DIR`, `--iteration ID`, `--run ID`, `--task ID`, `--all-tasks`, `--messages N|full`, `--format text|mermaid|markdown`, `--out FILE`, `--tasks-limit N`, `--interval SEC`, `--once`, `--no-clear`, `--runs N`, `--events N`. Default mode is **watch** (clear + refresh + sleep until Ctrl-C or `kill`); `--once` prints one snapshot and exits 0; `--format markdown`/`mermaid` are always one-shot review artifacts.

**Output formats.** `text` (default) renders sections: task graphs overview, sessions, per-session detail, **per-iteration correlation** (metric delta Δ vs previous entry + Δ vs baseline, linked task-graph node timeline from `tasks/<taskId>/events.jsonl`: assign/update/message/close, and the **agent conversation** resolved from `task.handoffs`/`nodes.messageIds` → `swarm-state.json.messages` + mailbox bodies, showing `from→to`, ack status, `replyTo`, `result→resultMessageId`), memories, recent runs, recent trace events. `markdown` produces a reviewable **dashboard** with three kinds of fenced Mermaid diagrams: (1) **task-graph flowchart** (nodes by status/outcome/role/artifact + edges, color-coded by status), (2) **agent sequenceDiagram** (messages/handoffs with `from→to`, subject, ack/response/result status, dashed reply for `resultMessageId`), (3) **iteration metric timeline** (per-iteration values + Δ, best highlighted). `mermaid` emits just the fenced diagram blocks (pipe-friendly).

It recomputes best/improvement from the metric contract `direction` (so it can flag stored-vs-recomputed `DRIFT`), supports `maximize`/`minimize`/`target`/`passfail`, and is crash-safe (missing/malformed files and sections with no linked task graph are skipped gracefully). Completed task graphs with terminal node statuses/artifacts/messages review the same way as live ones — live refresh is simply watch mode over the same renderer.

Validation gates: `python3 -m py_compile scripts/swarm_iteration_watch.py` and `bash -n scripts/swarm_iteration_watch.sh`. The reviewer is read-only — no cleanup is needed (other than any `--out FILE` you choose to write). Demo artifacts it points at live under `.pi/swarm-uat/runs/iter-demo-<stamp>/` (gitignored; safe to `rm -rf`).

## Cleanup

- Everything lives under `<repo>/.pi/swarm-uat/runs/` (gitignored). Safe to remove a run:
  ```bash
  rm -rf "<repo>/.pi/swarm-uat/runs/iter-demo-<STAMP>"
  ```
- The demo **never touches the repo-root `.pi/swarm/`**; re-running just creates a new dated isolated cwd. No cleanup of live state is required.
- A pre-existing repo-root `.pi/swarm/demo-evidence/` (if any, left by an earlier node) is **not** used by this isolated demo — it can be left or removed separately. This script does not delete it.

## Troubleshooting / environment blockers

- **Provider 429 / rate limits:** the most likely real blocker. `run_step` retries with linear backoff (`SWARM_MAX_ATTEMPTS`, default 3). If retries are exhausted, the affected step's `.code` is non-zero and the file-backed assertions will flag the missing data. Record the exact command + output rather than forcing a PASS.
- **Duplicate-extension guard fired:** the script aborts if both `extensions/swarm/index.ts` and `.pi/extensions/swarm/index.ts` exist. Remove the `.pi/extensions/swarm` duplicate and re-run.
- **Wrong EXT path:** the script hard-codes `EXT=extensions/swarm/index.ts` (the real packaged source). Do not point it at the deleted `.pi/extensions/swarm/index.ts`.
- **`DEMO_MODE=single` is LLM-flaky:** prefer `DEMO_MODE=steps` (the default) for CI-style determinism; single mode is a convenience for interactive review.
- **Model unreachable / no network:** document the exact command and output (e.g. into `artifacts/validation.md`) and mark the run accordingly; do not fake success.

## Validation gate

```bash
bash -n scripts/swarm_iteration_demo.sh
```

must pass (syntax clean) before the script is considered ready.
