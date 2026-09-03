# Swarm extension

Project-local pi package extension for spawning and coordinating tmux-backed pi agents.

Main file:

```text
extensions/swarm/index.ts
```

This is the entry point (a thin wiring file). The implementation lives under
`extensions/swarm/src/`:

```text
src/types.ts         type/interface definitions
src/constants.ts     module-level constants
src/utils.ts         pure helpers (now, safeId, inferRoleKind, ...)
src/state.ts         paths + state/lock/trace/JSON/JSONL file IO
src/taskgraph.ts     graph algorithms, status/closure/transitions, rendering
src/observability.ts read-only text flow snapshot renderer for `/swarm flow`
src/flow-dialog.ts   interactive TUI picker/dialog for `/swarm flow`
src/delivery.ts      message parsing + retry predicate
src/session.ts       model/root detection
src/identity.ts      identity markdown generation + write
src/tmux.ts          tmux wrappers
src/mailbox.ts       mailbox read/deliver helpers
src/agents.ts        spawn/reuse/reload
src/nudges/goal-epoch.ts       swarm-level idle epoch + goal-floor emission
src/nudges/graph-advance.ts    graph-advance / stall / artifact / heartbeat GC nudges
src/nudges/status-predicates.ts pure predicates over TaskState["status"]
src/surface.ts                 root-facing message surface machinery
src/tasks-index.ts             PM-facing rollup + task indexer
src/reconcile-core.ts          reconcile runner (entry points)
src/reconcile.ts               **barrel re-export** — backward-compat surface for hooks/command/tools/tests
src/hooks.ts         event hooks + root mailbox pump
src/command.ts       /swarm slash command
src/tools/*.ts       the tool registrations, grouped by domain
src/pool.ts          model slot picker + quota bench
src/pool-scaffold.ts pool CLI scaffolding
src/goals.ts         goal CRUD helpers
src/gc.ts            mailbox GC for terminal message records
                     (agents / messages / tasks / gc)
```

`index.ts` re-exports `isDeliveryFailureRetryable` and calls
`registerSwarmHooks` + the four `register<Domain>Tools` functions +
`registerSwarmCommand`.

This is the packaged extension source (see `package.json` → `pi.extensions = ["./extensions"]`). The old `.pi/extensions/swarm/index.ts` dev wrapper was removed; load the extension from `extensions/swarm/index.ts`.

Documentation entrypoints:

```text
docs/swarm/index.md                 # canonical swarm doc map
docs/swarm/architecture.md          # system model and invariants
docs/swarm/contributor-guide.md     # contributor workflow + change checklists
docs/swarm/operations.md            # runtime files, debugging, validation
docs/swarm/tools.md                 # grouped tools and /swarm commands
docs/swarm/pi-runtime-contract.md   # Pi lifecycle / delivery / interrupt / reload contract (mandatory consultation per AGENTS.md)
docs/swarm/pi-runtime-evidence.md   # raw citations backing the contract doc
docs/swarm.md                       # compact legacy landing/reference
```

## Pi runtime contract

Swarm's assumptions about Pi runtime semantics are documented in
[`../docs/swarm/pi-runtime-contract.md`](../docs/swarm/pi-runtime-contract.md). Contributors
changing `src/hooks.ts`, `src/reconcile.ts` (or any barrel-exported module under `src/nudges/`,
`src/surface.ts`, `src/tasks-index.ts`, `src/reconcile-core.ts`), `src/tools/messages.ts`, or `src/mailbox.ts`
MUST consult that contract first. See also the citation artifact
[`../docs/swarm/pi-runtime-evidence.md`](../docs/swarm/pi-runtime-evidence.md) and the
standing rule in [`../../AGENTS.md`](../../AGENTS.md#pi-runtime-contract-mandatory-consultation).

The contract enumerates the four layers (durable mailbox state / Pi queue acceptance /
visible surface / LLM consumption) and the R12–R15 false-claim register that names the
specific lines in this repo (e.g. `src/tools/messages.ts:42-48`) where swarm has made
unproven claims about Pi runtime semantics.

Quick start:

```bash
PI_SWARM_IS_ROOT=1 pi --model glm-5.1 --provider zai-coding-cn -e extensions/swarm/index.ts
```

Project-local swarm defaults can be set in `.pi/settings.json`:

```json
{
  "swarm": {
    "defaultModel": "gpt-5.4-mini",
    "defaultProvider": "openai"
  }
}
```

A nested `extensions.swarm` object is also accepted for backward compatibility,
but top-level `swarm` is the safer recommendation because pi itself may use
top-level `extensions` for extension discovery/config.

For multi-provider rotation, configure `modelPool` + `rotation` instead. The
canonical format is discoverable in-pi via `/swarm pool help`; read-only
`/swarm pool show`, `/swarm pool validate`, and `/swarm pool preview-preflight`
let you inspect the effective pool (or implicit singleton fallback), catch
structural errors, and dry-run the spawn gate before any worker is committed.
The extension never edits `.pi/settings.json`.

Inside pi:

```text
/swarm init
/swarm spawn reviewer Review the current diff. Do not edit files.
/swarm panes                                                # list tmux panes + which one you're in
/swarm register here reviewer Review the diff              # adopt the CURRENT pane
/swarm register mysession:research.1 researcher Research planner   # adopt another existing pane
/swarm role reviewer Senior reviewer --kind reviewer                # repurpose without respawn
/swarm pause reviewer                                              # drain from reuse (pane stays alive)
/swarm resume reviewer
/swarm stop reviewer                                               # refuse if active tasks; --force to override
/swarm status
/swarm pool list                                            # weighted/rr/sticky slot health + rotation
/swarm pool show                                           # full config view (pool OR implicit singleton)
/swarm pool validate                                       # structural check (read-only)
/swarm pool help                                           # canonical format reference (read-only)
/swarm pool preview-preflight                              # dry-run spawn gate (read-only)
/swarm pool cooldown <provider/model> <ms>                  # bench a slot
/swarm pool clear <provider/model>                          # clear a bench
```

Useful tools:

- `swarm_spawn_agent`
- `swarm_register_agent` (adopt an existing tmux pane into a role; upsert/retarget)
- `swarm_stop_agent` (refuses active tasks unless `force`; `killPane=false` to keep the pane)
- `swarm_restart_agent` (stop + respawn at the same id; mailbox/identity persist)
- `swarm_set_role` (repurpose role/roleKind/capabilities + identity reload, no respawn)
- `swarm_set_agent_paused` (drain from reuse without killing the pane)
- `swarm_send_keys` (raw tmux keys to a pane — interrupt/dismiss/type)
- `swarm_attach_agent` (tmux attach/select commands for a pane)
- `/swarm mailbox reset <id|here> --yes` — emergency mailbox reset; archives live mailbox + clears delivered ledger (preserves message records in `swarm-state.json`).
- `swarm_release_agent_task` (clear a stale active-task pointer)
- `swarm_list_agents`
- `swarm_agent_status`
- `swarm_send_message`
- `swarm_check_mailbox`
- `swarm_ack_message`
- `swarm_message_status`
- `swarm_reconcile` (mail + task sweep; `mark=true` repairs task status drift)
- `swarm_prune` (root-only after Issue 10; dry-run by default)
- `swarm_dead_letters`
- `swarm_trace`
- `swarm_capture_agent_pane`
- `swarm_agent_identity`

> Tools marked **root-only** in `docs/swarm/tools.md` (e.g. `swarm_prune`,
> `swarm_gc`) reject non-root callers with a server-side error before any state
> mutation.

Task-graph tools:

- `swarm_create_task`, `swarm_confirm_qualification`, `swarm_assign_task`, `swarm_update_task`, `swarm_task_message`
- Package skill: `qualification-skills/qualification-gate/SKILL.md` ships inside `extensions/swarm/` and is surfaced only in generated root/reviewer/auditor identities. It guides the short task-creation qualification gate (`auto` or `human-discuss`).
- `swarm_task_status`, `swarm_validate_graph`, `swarm_print_graph`, `swarm_next_nodes`
- Rework edges are first-class: a declared `rework: true` edge can re-open a failed/skipped node as `ready` so follow-up validation is a normal graph transition, not an root force-reset.
- `/swarm flow <#|task-id> [--events N]` — read-only observatory snapshot (task graph, agent lanes, recent events)

Runtime state is written under `.pi/swarm/` and ignored by git.

## Supported now vs deferred

**Supported now:** spawning tmux-backed agents; mailbox messaging with
ACK/idempotency/dead-letter; engine-enforced task closure (`computeTaskStatus`
— `done`/`failed`/`in_progress`/`ready` derived from node states on every
create/assign/update, `cancelled` sticky); `swarm_reconcile` sweeping both mail
and tasks (mark-only; `mark=true` repairs drift; stamps advisory `node.staleAt`);
a stale/nudge ladder surfaced via reconcile, `session_shutdown` nudge, `/swarm
status` PM rollup, and **PM auto-notify** (node-close → root mailbox on a
closure-ish transition; worker settled with open work → root mailbox;
settle nudge cooldown-guarded per agent) surfaced by a **session-safe + read-safe
root auto-pump** (per-process surfaced set; `check_mailbox(markDelivered)`/ack
cannot pre-empt a pump surface; a second root lane or validation `pi -p`
run cannot starve the PM); **server-side RBAC**: `swarm_update_task(force=true)`
and `cancelTask` are root-only (a non-root caller is rejected
before any mutation); **root-explicit task cancellation** via
`swarm_update_task(force=true, cancelTask=true)` — revokes every active attempt,
transitions non-terminal nodes to `cancelled`, supersedes every assignment
message, releases agent `activeTaskIds` + advisory edit locks, sends
informational cancellation notices, and rejects all later updates with
`TASK_CANCELLED`/`NODE_CANCELLED` (with later ACKs on superseded assignment
records rejected via `ASSIGNMENT_SUPERSEDED`); **file-scope ownership preflight** on
`swarm_assign_task`: the candidate node's effective write scope (node `allowedFiles` ->
`allowedFilesFrom` inheritance -> task default, stamped on the attempt lease) is compared against
every active attempt lease across all tasks under the swarm lock with a conservative deterministic
glob predicate — overlap fails atomically with `ACTIVE_SCOPE_CONFLICT` (no state mutated), and
leases release with audit `releasedAt`/`releaseReason` on terminal/reassign/rework/cancel
(`file-ownership.test.mjs`); an **initial-ready recovery
nudge** that surfaces a fresh
task whose start node stays ready+unassigned past a short grace period to the
root (bounded, idempotent, never auto-assigns); a repeatable
**task-graph UAT** entrypoint at `scripts/swarm_task_uat.sh`; and a full **agent
lifecycle** surface —
`swarm_register_agent` (adopt/retarget an existing tmux pane),
`swarm_stop_agent` (refuses active tasks unless `force`), `swarm_restart_agent`
(respawn at the same id, preserving mailbox/identity), `swarm_set_role`
(repurpose + identity reload), `swarm_set_agent_paused` (drain from reuse
without killing), `swarm_send_keys`/`swarm_attach_agent`, and
`swarm_release_agent_task` (clear stale active-task pointers) — each mirrored as
a `/swarm` subcommand (`register | stop | restart | role | pause | resume |
sendkey | attach | release`).

**Deferred (not first-class V1 tools):** destructive auto-cleanup (auto-kill tmux
windows, auto-remove agents); reminder-message re-injection from reconcile
(kept idempotent/storm-free); cross-host support, cryptographic mailbox auth,
and a consensus/heartbeat daemon. Advisory file edit locks stay advisory
(not hard-enforced).
