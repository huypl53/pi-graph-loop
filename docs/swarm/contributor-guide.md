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
- `extensions/swarm/src/session.ts` — orchestrator/model/session detection
- `extensions/swarm/src/identity.ts` — generated identity cards and overrides
- `extensions/swarm/src/tmux.ts` — tmux integration and pane capture
- `extensions/swarm/src/mailbox.ts` — mailbox append/read helpers
- `extensions/swarm/src/agents.ts` — lifecycle operations
- `extensions/swarm/src/reconcile.ts` — repair sweeps and PM notifications
- `extensions/swarm/src/hooks.ts` — session hooks and mailbox pump
- `extensions/swarm/src/command.ts` — `/swarm` command surface
- `extensions/swarm/src/tools/` — tool registrations grouped by domain

## Change discipline

### If you add a new tool
Checklist:
1. implement the behavior in the right subsystem module first
2. expose it from the relevant `src/tools/*` registration file
3. add or update `/swarm` command parity only if needed
4. document it in `docs/swarm/tools.md`
5. mention it in `extensions/swarm/README.md` if it changes the contributor-facing map
6. add validation coverage

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
6. if the rule adds a forced/authoritative mutation, gate it through `isOrchestratorAuthority()` at the real mutation boundary — never trust caller-supplied parameters as authority
7. add scenario or regression coverage

### If you add a new runtime file
Checklist:
1. centralize path creation in `src/state.ts`
2. document retention/purpose in `docs/swarm/operations.md`
3. describe whether it is source-of-truth, cache, or trace output
4. keep file format inspectable

## Invariants to protect

- Do not create a hidden daemon dependency for core behavior.
- Do not move source-of-truth task state out of task files.
- Do not make tmux liveness the only truth for delivery or ownership.
- Do not bypass reconcile semantics with ad hoc repair logic in unrelated modules.
- Do not handwave evidence rules for run/memory promotion.
- Do not let `/swarm` command help become the only documentation of a feature.

## Orchestrator-authoritative mutations

Some mutations are only safe when the current identity is the active orchestrator leader.
The check is two-part:

1. **authority** — `isOrchestratorAuthority(currentAgentId())` must be true for the caller;
2. **leadership** — the durable `SwarmState.orchestratorLeader` record must be claimed/heartbeated
   by the current pid before the mutation proceeds.

Apply the gate at the real mutation boundary, not just in UI wrappers.
Create-only paths can materialize the orchestrator record without refreshing heartbeat; that is
how a fresh PM session becomes visible without claiming extra authority.

Required examples in this issue family:
- `swarm_create_task`
- `swarm_assign_task`
- `swarm_stop_agent`
- `swarm_release_agent_task`
- `swarm_reconcile(mark=true)`
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

For docs-only changes, it is acceptable to skip interactive validation, but say so explicitly in the final report.

## Suggested workflow for a non-trivial feature

1. update or write down the invariant/behavior change first
2. implement in the subsystem module
3. wire the tool/command entrypoint
4. add regression coverage
5. update focused docs
6. run validation
7. capture any remaining design debt in docs instead of leaving it implicit
