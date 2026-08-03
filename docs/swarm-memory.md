# Swarm memory policy

> Runtime policy for pi-swarm **memory**. This is the agent-readable contract for *when* to
> read, propose, and accept memory, what makes a claim acceptable, what evidence is required,
> and which roles may do what. Generated agent identity files link here, and the iteration
> context bundle surfaces this path as `memoryPolicyRef`.
>
> Swarm memory is **file-backed** and **evidence-gated**. There is **no daemon, no vector DB,
> no optimizer loop, and no embeddings** — every step is an explicit tool call over append-only
> JSONL. The harness never promotes a claim by itself.

Related: [`docs/swarm.md`](./swarm.md) (Metric / run / memory V1, Iteration loop V1),
[`docs/swarm-task-graph.md`](./swarm-task-graph.md), and the `swarm_metric_designer` skill.

## 1. What memory is (and is not)

- Memory is a **durable, reusable finding** learned from a *completed, verified* run — for
  example "applying change X improved metric Y from a to b", or "approach Z fails gate G".
- Memory is **not** a scratchpad, a chat log, or a task status. Task state lives in task graphs;
  messages live in mailboxes; trace lives in `trace.jsonl`. None of those become memory on
  their own.
- Memory is **project-scoped** and stored under `.pi/swarm/memory/memory.jsonl` (append-only;
  latest line per `memoryId` wins). A claim may optionally bind to a `scope` (`{ kind, id }`,
  e.g. a metric contract or a task) so retrieval is relevant.

Record lifecycle: `proposed` → `active` (via reviewer/orchestrator accept) or `rejected`;
`active` → `rejected`; `expired` is informational. Rejected claims are **auditable** — they stay
in the file with a `rejectionReason` — never silently dropped.

## 2. When to READ memory

Call `swarm_memory_search` (file-backed substring + scope/status filter; no embeddings):

- **At task start / when picking up an assigned node** — especially before an `implement_*` or
  optimization node. Retrieve `status=active` memories matching the task/metric scope so you do
  not redo solved work or repeat a known failure.
- **Before proposing a change or an iteration** — read the carry-forward bundle from
  `swarm_iteration_context` (it returns active memories already revalidated against current
  evidence digests). Do not assume a memory is still valid; the tool excludes stale ones into
  `excludedMemories`.
- **When blocked or about to repeat prior work** — search before escalating; a prior run may have
  recorded exactly the failure mode you are hitting.
- **When reviewing** — before approving/rejecting, check whether prior active memory already
  contradicts or supports the work in front of you.

> Scope-first retrieval: prefer `scopeId`/`kind` filters tied to the metric contract or task over
> broad free-text queries, so the memories returned are actually about your work.

## 3. When to PROPOSE memory

Use `swarm_memory_propose` (it runs the evidence gate; a failing gate still appends an audited
`rejected` record — proposing is safe, activation is not automatic). Propose **only** when:

- The source run is **terminal `done`** with verdict **`pass`** or **`approved`** (not `running`,
  `blocked`, `failed`, or `rejected`).
- The run is bound to the **current** metric-contract id + version (not a stale contract).
- You have **complete, file-backed evidence** that still exists and still reads (see §5).
- The finding is **genuinely reusable** beyond this single run — one distinct claim per finding.
- You can **reconstruct the claim** from git state + artifact files + trace alone (see §6).

**Do not propose** from: pane-only observations, ack-only confirmations, mailbox chatter,
unstaged/uncommitted code with no `.patch`/`.diff` or git commit, speculative hunches, or a run
that is not yet finished. If the evidence is incomplete, finish the run and gather evidence first;
do not propose "to be safe".

## 4. Claim quality rules

A good claim is **specific, falsifiable, scoped, and tied to evidence**:

- **Specific, not generic.** ✗ "the model is good". ✓ "switching prompt-template P from v1→v2
  raised `answer_quality` from 0.71→0.84 on run-0017 (metric `eval-v3`)." State the metric and the
  run it came from.
- **Falsifiable.** The claim must describe a check another agent could re-run and observe.
  Assertions like "feels better" are not claims.
- **Scoped.** Set `scope` (`{ kind, id }`) to the metric contract or task the claim applies to, so
  retrieval returns it to the right work and not as noise everywhere else.
- **One finding per claim.** Split compound findings; each `memoryId` should be independently
  revalidatable and independently rejectable.
- **Confidence is calibrated.** Set `confidence` (0–1) honestly; a single passing run is not high
  confidence. The carry-forward rank orders pinned-first, then confidence, then recency.
- **Cite the run.** `sourceRunId` is mandatory; the claim must trace back to one real run record.

## 5. Evidence requirements

These mirror the implemented `evaluateMemoryGate` (enforced at propose, accept, and on every
iteration-context retrieval):

- **`evidenceRefs` must be non-empty, safe relative paths** that exist and are readable. Defaults
  to the source run's `evidenceRefs`; supply explicit refs when the run's set is too broad/narrow.
- **Every contract `evidenceRequired` entry must be present.** If the metric contract lists
  required artifacts, all of them must be among the refs.
- **Artifacts must match their recorded digest.** Each ref is hashed (SHA-256) when the run is
  recorded; promotion/accept/retrieval re-hash and reject on drift. Do not edit evidence files
  after recording a run and expect its memory to survive.
- **Code/config-change claims need reconstruction.** A run that describes a code or config change
  must carry a `.patch`/`.diff` ref **or** distinct git base/head commits (`gitBase`/`gitHead`),
  so the change is reconstructable from the repo alone.
- **Verdict must be pass/approved.** `failed`/`rejected`/`running` runs never pass the gate.

If you cannot satisfy these, do not propose — record the run (evidence existence is *not* required
to log a run, only to promote memory from it), fix the evidence, and propose once it is complete.

## 6. Self-check (propose only if all are true)

Before calling `swarm_memory_propose`, answer yes to every line:

1. Is the source run terminal `done` with verdict `pass`/`approved`?
2. Is it bound to the **current** metric-contract id + version?
3. Do all `evidenceRefs` exist, read, and match their recorded SHA-256 (none mutated)?
4. Are all contract `evidenceRequired` artifacts present?
5. If it is a code/config change, is there a `.patch`/`.diff` or distinct git base/head?
6. Is the claim specific, falsifiable, scoped, and tied to that run?
7. **Can I reconstruct this claim from git + artifact files + trace alone?**

> If any answer is no — **do not propose it.** Fix the evidence or finish the run first.

## 7. Role permissions

- **Any agent may `swarm_memory_propose`** (and `swarm_memory_search`). Proposing is safe; it never
  auto-activates.
- **Only `reviewer` or `orchestrator` may `swarm_memory_accept`** (`proposed`→`active` or →`rejected`,
  and `active`→`rejected`). The tool re-runs the evidence gate before activating, and forbids
  reviewer impersonation (only the orchestrator may override `reviewedBy`).
- **Never promote from pane-only / ack-only / mailbox-only / incomplete claims.** The evidence gate
  exists precisely to block these; do not work around it by editing artifacts to match a digest.
- **Rejected is auditable.** Use rejection reasons to teach: a rejected claim with a clear reason is
  useful history; quietly dropping or overwriting claims is not.
- Memory does not bypass roles, locks, or task ownership. It informs decisions; it does not authorize
  an agent to edit files outside its assigned node's `allowedFiles`.

## 8. Acceptance (reviewer / orchestrator)

When reviewing a `proposed` memory:

1. Re-read the source run (`swarm_run_get`) and confirm it is `done`/`pass`|`approved` on the current
   contract version.
2. Open each `evidenceRefs` path; confirm it exists, reads, and (for code/config changes) is
   reconstructable from git.
3. Judge the claim against §4 (specific, falsifiable, scoped, one finding). If two claims duplicate,
  activate the stronger and reject the other with a reason.
4. `swarm_memory_accept(status="active")` to carry it forward, or `status="rejected"` with a reason.
   Activation re-runs the gate — if it now fails (e.g. evidence drifted), the tool throws
   `GATE_FAILED`; fix or reject, do not force.

## 9. Iteration context (how memory carries forward)

`swarm_iteration_context` returns the next-iteration bundle: best run summary + active memories
matching the session scope (or explicitly pinned), **revalidated against current evidence digests**,
ranked pinned-first → confidence → recency, and capped by `memoryLimit`. Stale memories (drifted
evidence, stale contract, etc.) are returned under `excludedMemories` with reasons rather than
carried forward.

The bundle includes `memoryPolicyRef` (this file). Read it before deciding what to do next, and
propose new memory only per §3–§6.

## 10. Anti-patterns

- Proposing from a run that is still `running` or `failed`.
- Proposing a generality ("works well") with no metric/run/scope.
- Proposing before committing code, with no `.patch`/`.diff` evidence.
- Editing an evidence artifact after recording the run to make a claim "pass".
- Treating `swarm_memory_search` as authoritative without checking the run/contract version.
- Re-proposing an already-active claim instead of accepting or extending it.
- Promoting memory to justify editing files outside your assigned node scope.

## 11. Tools quick reference

| Tool | Who | When |
|---|---|---|
| `swarm_memory_search` | any agent | read: task start, before changes, when blocked, during review |
| `swarm_memory_propose` | any agent | only after a pass/approved run with complete file-backed evidence (§3, §6) |
| `swarm_memory_accept` | reviewer / orchestrator | promote `proposed`→`active` or →`rejected`; gate re-runs (§7, §8) |

Memory is a record of *verified, reusable* learning. If you cannot prove it from files alone, it is
not memory yet — finish the run, gather evidence, and try again.
