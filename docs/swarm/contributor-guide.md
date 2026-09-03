# Swarm contributor guide

Use this guide when implementing or refactoring swarm features.

## First principle

Treat swarm as a set of **bounded subsystems**. Avoid implementing cross-cutting behavior in the nearest tool handler just because it is convenient.

## Code map

Implementation entrypoint:
- `extensions/swarm/index.ts` — thin wiring file

Implementation modules:
- `extensions/swarm/src/types.ts` — shared runtime types and enums
- `extensions/swarm/src/constants.ts` — constants and defaults
- `extensions/swarm/src/utils.ts` — pure helpers
- `extensions/swarm/src/state.ts` — paths, locks, file IO, traces
- `extensions/swarm/src/taskgraph.ts` — graph rules and closure logic
- `extensions/swarm/src/delivery.ts` — message semantics and retryability
- `extensions/swarm/src/session.ts` — root/model/session detection
- `extensions/swarm/src/identity.ts` — generated identity cards and overrides
- `extensions/swarm/src/tmux.ts` — tmux integration and pane capture
- `extensions/swarm/src/mailbox.ts` — mailbox append/read helpers
- `extensions/swarm/src/agents.ts` — lifecycle operations
- `extensions/swarm/src/reconcile.ts` — repair sweeps and PM notifications
- `extensions/swarm/src/hooks.ts` — session hooks and mailbox pump
- `extensions/swarm/src/command.ts` — `/swarm` command surface
- `extensions/swarm/src/tools/` — tool registrations grouped by domain


## Test layout

All test suites live under `extensions/swarm/tests/` (not the repo root) and
`extensions/mock-llm/tests/` for mock-llm-specific suites. The git mv preserved
the original history. Imports of `./src/...` were rewritten to `../src/...`.

- Run a single suite: `node extensions/swarm/tests/<name>.test.mjs`
- Run the swarm inventory: `npm run test:swarm` (sets
  `PI_SWARM_AGENT_ID=root PI_SWARM_IS_ROOT=1` so the
  authority-gated suites do not crash)
- Run the mock-llm inventory: `npm run test:mockllm`

Pre-existing failures (kept byte-identical by this refactor — do NOT fix in this
refactor; record new R-rows for fixes):

```text
ct-contract-probes.test.mjs         19 passed / 4 failed       (CT-2.B/C known)
minimal-protocol-authoritative      29 pass / 18 fail
model-routing.test.mjs              4 passed / 1 failed
root-wake.test.mjs          31 passed / 3 failed
functional.test.mjs                 env-crash (caller=implementer-01)
pool-config.test.mjs                TypeError (provider-config-dependent)
row75-graph-guardrails.test.mjs     assertion crash
supersession-fencing.test.mjs       17 pass / 3 fail
```

Baseline inventory script: `.pi/swarm/tasks/task-20260903-structure-refactor/artifacts/baseline-inventory.sh`.
This IS the refactor gate — diff the new run's `baseline-inventory.txt` line-by-line
against the committed baseline to detect drift.

## Change discipline

### If you add a new tool
Checklist:
1. implement the behavior in the right subsystem module first
2. expose it from the relevant `src/tools/*` registration file
3. add or update `/swarm` command parity only if needed
4. document it in `docs/swarm/tools.md`
5. mention it in `extensions/swarm/README.md` if it changes the contributor-facing map
6. add validation coverage

### If you add or change Pi-runtime semantics
Checklist (mandatory per AGENTS.md "Pi runtime contract (mandatory consultation)"):
- [ ] Consult [`docs/swarm/pi-runtime-contract.md`](./pi-runtime-contract.md) and
      identify which of the four layers ([§1](./pi-runtime-contract.md#1-the-four-layers))
      the change crosses (durable mailbox / Pi queue acceptance / visible surface /
      LLM consumption).
- [ ] Read the matching section in
      [`docs/swarm/pi-runtime-evidence.md`](./pi-runtime-evidence.md) for the
      `[VERIFIED]` / `[INFERRED]` / `[GAP]` citations.
- [ ] Add or update a row in
      [`pi-runtime-contract.md §10`](./pi-runtime-contract.md#10-r12r15-false--unproven-claims-register)
      if the change introduces, removes, or modifies a false / unproven claim
      about Pi runtime.
- [ ] Include an R10-1 boundary-counting assertion if the change adds a new
      code path that crosses a Pi runtime boundary (count at the real
      `pi.sendMessage` / `ctx.abort` / `pi.registerTool` / `ctx.reload`
      boundary, not at an internal helper).
- [ ] If the change touches a claim in
      [`pi-runtime-contract.md §10`](./pi-runtime-contract.md#10-r12r15-false--unproven-claims-register),
      file a separate R-row task for the production fix — this KB task does
      NOT ship swarm behavior changes.

### If you add a new message lifecycle state or field
Checklist:
1. update shared types
2. update storage/read paths
3. update reconcile behavior
4. update rendering/status summaries
5. document semantics and retry/dead-letter behavior
6. add regression tests for failure and repair paths

### If you add a new task lifecycle rule
Checklist:
1. put transition/closure logic in `src/taskgraph.ts`
2. keep tool handlers thin; they should validate and delegate
3. update task status/print/validation behavior as needed
4. document branch/outcome semantics in `docs/swarm-task-graph.md`
5. if the rule re-opens failed work via a declared `rework` edge, keep the reopened node state explicit (`ready`) rather than inventing a hidden reset path
6. if the rule adds a forced/authoritative mutation, gate it through `isRootAuthority()` at the real mutation boundary — never trust caller-supplied parameters as authority
7. add scenario or regression coverage

### If you add a new runtime file
Checklist:
1. centralize path creation in `src/state.ts`
2. document retention/purpose in `docs/swarm/operations.md`
3. describe whether it is source-of-truth, cache, or trace output
4. keep file format inspectable

### Scope syntax (allowedFiles / file-scope ownership)

The ownership preflight (`swarm_assign_task`, `src/taskgraph.ts`) compares each node's
effective write scope — node `allowedFiles` → recursive `allowedFilesFrom` → task default —
with a deterministic glob predicate. Pattern semantics (`normalizeScopePattern`):

- **Trailing slash = directory subtree** — `dir/` ≡ `dir/**`. It covers the directory node
  itself and every descendant. This is the ONLY form the task-default scope generator
  emits (the root writes `artifacts/`, `extensions/swarm/src/`, `extensions/swarm/tests/`,
  …). **Prefer trailing slash for directory scopes in plans** so two disjoint dirs are seen
  as non-overlapping and can run in parallel.
  - `('a/b/', 'c/d/')` → `false` (disjoint dirs coexist)
  - `('a/b/', 'a/b/c.ts')` → `true` (dir covers a file inside it)
  - `('a/b/', 'a/b')` → `true` (dir covers its own bare prefix)
- **Bare path without slash = exact prefix** — `a/b` matches exactly `a/b` and NOT `a/b/c`.
  This is the pre-existing semantics and is unchanged. Use a trailing slash (or `**`) when
  you mean subtree.
- **Glob** — `*` matches within a single segment (`src/*.ts`); `**` matches zero-or-more
  segments (`src/**`); `{a,b}` / `?` / `[x]` / `!` are unsupported.
- **Unknown syntax is conservatively conflicting** — `normalizeScopePattern` returns `null`
  (absolute paths, `a/../b`, internal `//`, brace-globs), `scopesOverlap` reports
  `{overlap:true, relation:"unknown-syntax"}`, and preflight fails with
  `ACTIVE_SCOPE_CONFLICT`. Preflight can never pass on ambiguity.

R26 added the trailing-slash → subtree mapping; prior to that, any trailing-slash pattern
was treated as unknown syntax and blocked ALL parallel assignment of dir-scoped work.

## Invariants to protect

- Do not create a hidden daemon dependency for core behavior.
- Do not move source-of-truth task state out of task files.
- Do not make tmux liveness the only truth for delivery or ownership.
- Do not bypass reconcile semantics with ad hoc repair logic in unrelated modules.
- Do not handwave evidence rules for run/memory promotion.
- Do not let `/swarm` command help become the only documentation of a feature.

## Root-authoritative mutations

Some mutations are only safe when the current identity is the active root leader.
The check is two-part:

1. **authority** — `isRootAuthority(currentAgentId())` must be true for the caller;
2. **leadership** — the durable `SwarmState.rootLeader` record must be claimed/heartbeated
   by the current pid before the mutation proceeds.

Apply the gate at the real mutation boundary, not just in UI wrappers.
Create-only paths can materialize the root record without refreshing heartbeat; that is
how a fresh PM session becomes visible without claiming extra authority.

Required examples in this issue family:
- `swarm_create_task`
- `swarm_assign_task`
- `swarm_stop_agent`
- `swarm_release_agent_task`
- `swarm_reconcile(mark=true)`
- `swarm_prune` (Issue 10: added to the root-only set; previously description-only)
- `swarm_gc` (Issue 10: added to the root-only set; previously description-only)
- `/swarm stop`
- `/swarm release`

## Where new code usually belongs

| Change | Primary module(s) |
| --- | --- |
| spawn/restart/register/pause/role changes | `src/agents.ts`, `src/identity.ts`, `src/hooks.ts` |
| model pool, rotation, preflight, config discoverability | `src/pool.ts` |
| task cancellation / supersession / late-update fencing | `src/tools/tasks.ts`, `src/taskgraph.ts`, `src/mailbox.ts`, `src/types.ts` |
| lifecycle-notification fencing (stall + closure predicates) | `src/taskgraph.ts` (predicates), `src/hooks.ts`, `src/reconcile.ts`, `src/command.ts`, `src/tools/tasks.ts` (emitter sites) |
| mailbox append/read/inject/ack | `src/mailbox.ts`, `src/delivery.ts`, `src/reconcile.ts` |
| graph transitions/closure/validation | `src/taskgraph.ts` |
| slash command UX | `src/command.ts` |
| paths/locks/traces/runtime layout | `src/state.ts` |
| graph closure/ownership/evidence | `src/taskgraph.ts` |
| message delivery and retries | `src/delivery.ts` |
| agent lifecycle and tmux integration | `src/agents.ts`, `src/tmux.ts` |
| tmux behavior | `src/tmux.ts` |

## Review and evidence rules (R10 keepers)

- **Cost-bound claims require counting assertions.** Any plan/comment/report claiming a bound (probe rate, lock-hold, message rate; trigger words: only/at most/bounded/throttled/rate-limited/once-per) must carry a counting test at the real I/O boundary that fails when violated. State assertions see "what happened once", never "how often". Template: heartbeat-gc C10-C13 (seed rejected population, counting mock at boundary, N≥2 passes, assert ≤bound, surgical-RED by reverting only the bound). Full checklist: docs/swarm/r10-postbatch-synthesis/consolidated-findings.md.
- **No reject smell.** A clean batch with zero reviewer rejections is a review-depth smell, not a success metric. Reviewer rejections must cite: specific code location + concern + consequence + fix proposal.
- **Name the red assertion.** Plans name the exact assertion that must go red; RED reports reference named assertions, not "tests fail". TypeError-class REDs prove newness, not discrimination.
- **Every shipped fixture is exercised by an independent tester in a fresh tmux lane** (durable-state + trace census asserted), not just unit-test PASS counts.
- **KR5 (silent-swallow anti-pattern).** A `try { ... } catch { /* swallow */ }` or `.catch(() => {})` wrapping an engine-wiring path (hook body, pump-tick phase, message-delivery callback) MUST have at least one integration test exercising the production factory/registration path that would FAIL if the wrapped body throws. Helper-only unit tests that bypass the wrapping layer cannot catch silent failures inside the swallowed region. Corollary: when the production entry point is a hook (`pi.on("tool_execution_end", ...)`), at least one assertion must go through the hook, not the helper.
- **KR6 (seed diversity for threshold gates).** Tests that verify threshold/staleness/boundary logic MUST seed BOTH sides of the boundary: stale-above (gate SHOULD fire) + fresh-below (gate SHOULD NOT fire). One-sided suites cannot detect gate-polarity bugs (an implementer flipping the gate direction passes the one-sided suite). Apply at plan-writing time too: plans should specify the negative case explicitly.

## Qualification-gate skill

The package-shipped qualification playbook is
`extensions/swarm/qualification-skills/qualification-gate/SKILL.md`. It is included
with the swarm extension under the package's existing `extensions/` publish rule and
is surfaced by generated identity only to root, reviewer, and auditor. See
[`tools.md`](./tools.md#normal-graph-execution) for the `auto` and `human-discuss`
task-creation modes.

## Documentation update checklist

When you change behavior, update docs in this order:
1. `docs/swarm/index.md` if the doc map changes
2. `docs/swarm/architecture.md` if a boundary or invariant changes
3. `docs/swarm/tools.md` for new public tool/command behavior
4. topic-specific detailed docs (`docs/swarm-task-graph.md`, `docs/swarm-memory.md`, etc.)
5. `README.md` only for package install/start/doc navigation changes
6. `AGENTS.md` only when future agents need new standing guidance

## Validation expectations

Preferred validation layers:
- focused regression tests under `extensions/swarm/*.test.mjs` or `*.validate.mjs`
- typecheck of `extensions/swarm/index.ts`
- scenario scripts such as `scripts/swarm_task_uat.sh`
- fresh interactive tmux/pi validation for extension behavior changes
- mock-LLM fixture replay lanes for any agent-facing behavior (see "Testing philosophy: real engine, scripted LLM" below)

For docs-only changes, it is acceptable to skip interactive validation, but say so explicitly in the final report.

## Testing philosophy: real engine, scripted LLM

Every swarm behavior change ships a mock-LLM fixture (AGENTS.md makes this compulsory). The philosophy behind it:

- **The engine is never mocked.** A fixture lane runs a real `pi` process with the real swarm extension: hooks fire, the root pump ticks, reconcile walks task.json, mailbox delivery + tmux injection + idempotency dedupe are all production code paths. Only the model is replaced by a scripted stream (`extensions/mock-llm/`, one JSONL turn per request; when the script runs out the provider returns `script_exhausted` rather than hanging).
- **Engine-side behavior is driven by seeding, not scripting.** Pumps, nudges, cooldowns, caps, and fences react to *state on disk*. To test them you seed the precondition (a stale `allIdleSinceAt`, an acked deferral message older than the cooldown, a ready-but-unassigned node) and then assert the engine's side effects: trace events in `events.jsonl`, new mailbox records with distinct ids, task.json node transitions.
- **Assertions read disk, not console.** Evidence is what the engine wrote: `.pi/mock-llm/transcripts/<fixture>/` (ordered tool calls + stopReasons), `swarm-state.json` ledgers (delivered/acked/idempotency keys/seq counters), `events.jsonl` traces, mailbox JSONL. A deterministic fixture replayed twice must produce semantically identical output (same final statuses, same ordered tool-call sequence, same boundary values).
- **Deterministic and offline.** Milliseconds, no network, no provider keys. `delayMs` values are part of the contract; no hidden randomness or environment-sensitive branching. This is what makes a fixture a regression test rather than a demo.

For multi-agent interaction patterns (handoff chains, seeded worlds, parallel lanes) see the `mock-llm-scenarios` skill — the authoring reference for fixtures.

## Suggested workflow for a non-trivial feature

1. update or write down the invariant/behavior change first
2. implement in the subsystem module
3. wire the tool/command entrypoint
4. add regression coverage
5. update focused docs
6. run validation
7. capture any remaining design debt in docs instead of leaving it implicit
