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
| 3 | Cancellation and supersession | Define cancellation as lease revocation, cancel/supersede in-flight assignment messages, release resources, reject late task mutations, and provide auditable recovery. | Queued |
| 4 | File ownership / parallel conflict policy | After leases exist, prevent unsafe overlapping concurrent write scopes or add explicit orchestrator-approved lock policy. | Queued |
| 5 | Recovery attention and worker reminder | Add one decision-oriented, bounded worker reminder and a synthesized orchestrator attention view. It must rely on durable assignment/message state, not idle panes as semantic proof. | Queued |
| 6 | Provider/pool preflight | Classify provider/model/tmux/pool failures before spawn/assignment and give actionable fallback/recovery output. | Complete: `pool-config-ux-and-preflight` |
| 7 | Crash consistency and failure injection | Harden and test locks/state/task/mailbox recovery under interrupted writes and concurrent mutation; document repair boundaries. | Queued |
| 8 | Multi-orchestrator policy | Either explicitly reject a second active orchestrator or introduce and test a durable leader lease/fencing protocol. This is not enabled partially. | Queued |
| 9 | Final surface and architecture review | Re-evaluate public tool/command exposure after operational semantics settle; keep core minimal and move debug/admin exposure behind appropriate role gates or commands. | Queued |

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
