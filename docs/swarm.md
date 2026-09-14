# Pi Swarm Extension

This file is the **legacy consolidated reference** for swarm.

For the current, smaller core surface, start with the focused doc set:

- [`docs/swarm/index.md`](./swarm/index.md) — canonical doc map
- [`docs/swarm/architecture.md`](./swarm/architecture.md) — system model, invariants, boundaries
- [`docs/swarm/operations.md`](./swarm/operations.md) — runtime files, debugging, validation
- [`docs/swarm/tools.md`](./swarm/tools.md) — grouped commands and tools
- [`docs/swarm/contributor-guide.md`](./swarm/contributor-guide.md) — where to implement changes

The old metric/run/memory/iteration/loop subsystem has been removed from the
packaged core. The legacy pages remain only for historical reference.

---

`pi-swarm` is a project-local pi extension that turns a single pi session into a
tmux-backed group of cooperating pi agents. It is intentionally simple and
inspectable: there is no daemon or mini server. Coordination uses tmux panes,
JSON state, JSONL mailboxes, task graphs, and structured trace files under the
project `.pi/swarm/` runtime directory.

## Current core surface

The packaged extension registers **35 tools** (registration modules in
`extensions/swarm/src/tools/`):

| Domain | Count | Registration module |
| --- | ---: | --- |
| Agent lifecycle, observability, and recovery | 19 | `src/tools/agents.ts` |
| Messaging and reconcile | 5 | `src/tools/messages.ts` |
| Task graph | 9 | `src/tools/tasks.ts` |
| Retention / garbage collection | 1 | `src/tools/gc.ts` |
| Diagnostics and audit (retention/trace summary) | 1 | `src/tools/audit.ts` |

The old metric/run/memory/iteration/loop tools are no longer registered.
See [`docs/swarm/tools.md`](./swarm/tools.md) for the full inventory and
[`docs/swarm/flows/flow.md`](./swarm/flows/flow.md) for the live message/task/pump/reconcile
flows with payload-backed edges.

## Runtime layout

```text
.pi/swarm/
  swarm-state.json              # agents, tmux session, message lifecycle records
  swarm-state.lock/             # lock directory used for atomic state updates
  agents/<agent-id>.md          # durable identity/role card for each agent
  agents/<agent-id>.override.md  # optional human-editable identity overrides
  mailboxes/<agent-id>.jsonl     # append-only mailbox per recipient
  tasks/<task-id>/               # task graph state, events, artifacts, sharedContext
  traces/events.jsonl            # structured event stream
  traces/tmux/*.txt              # before/after pane snapshots and manual captures
  metrics/ runs/ memory/ iterations/ loops/  # legacy files, preserved but unsupported
```

## Slash commands

The extension registers `/swarm` for quick TUI use:

| Command | Purpose |
| --- | --- |
| `/swarm init` | Ensure runtime directories/state exist. |
| `/swarm status` or `/swarm list` | Show agent count and tmux session. `/swarm status` emits a PM rollup (tasks/agents/closure). |
| `/swarm graph <task-id> [text\|mermaid\|json]` | Render a task graph and write it to `.pi/swarm/traces/graphs/`. |
| `/swarm spawn <id> [role]` | Spawn a child pi agent in tmux. |
| `/swarm register <here\|tmux-target> <id> [role…] [flags]` | Adopt an **existing** tmux pane into a role without spawning (upsert/retarget). |
| `/swarm panes` | List every tmux pane with a copy-pasteable target (and flag the current one). |
| `/swarm stop <id> [--force] [--no-kill]` | Stop an agent (refuses active tasks unless `--force`). |
| `/swarm restart <id>` | Stop + respawn a fresh pi at the same id (mailbox/identity persist). |
| `/swarm role <id> <role…> [--kind K] [--caps a,b]` | Repurpose role/roleKind/capabilities + identity reload, no respawn. |
| `/swarm pause <id>` / `/swarm resume <id>` | Drain an agent from the reuse pool without killing its pane (and resume). |
| `/swarm sendkey <id> <keys…> [--literal] [--enter]` | Send raw tmux keys to an agent pane. |
| `/swarm attach <id>` | Print tmux attach/select commands for an agent pane. |
| `/swarm release <id> [<task-id>] [--force]` | Clear a stale active-task pointer (refuses non-terminal tasks unless `--force`). |
| `/swarm mailbox reset <id\|here> --yes` | Emergency human-initiated mailbox reset. |
| `/swarm deregister <here\|tmux-target>` | Self-service de-registration of a pi session from its swarm role (pane stays alive; root-style entry only — workers can only deregister themselves). |
| `/swarm send <to> <message>` | Send a mailbox/tmux-injected message. |
| `/swarm trace` | Show recent structured trace events. |
| `/swarm capture <id>` | Capture an agent pane to `.pi/swarm/traces/tmux/`. |
| `/swarm pool list` | Model pool health (weighted/round-robin/sticky slot picks, cooldown state). |
| `/swarm pool show` | Full pool config view (pool OR implicit singleton fallback). |
| `/swarm pool validate` | Structural check (read-only); warns on `swarm_yml_empty` / `swarm_yml_unreadable` and per-slot `slot_unresolvable` / `slot_no_credential`. |
| `/swarm pool preview-preflight` | Dry-run spawn gate (read-only). |
| `/swarm pool cooldown <provider/model> <ms>` | Bench a slot for a cooldown window. |
| `/swarm pool clear <provider/model>` | Clear a bench. |
| `/swarm pool help` | Canonical format reference (read-only). |

Configuration lives in `.pi/settings.json` (`extensions.swarm` block, highest
precedence) or in the comment-friendly `.pi/swarm.yml` (preferred for hand
edits; pi core would silently drop comments in `settings.json`). The
extension never edits `.pi/settings.json`. See
[`docs/swarm/tools.md#configuration`](./swarm/tools.md#configuration).

## Task graph and shared context

The task graph layer is implemented and remains the primary workflow system:

- `swarm_create_task` (auto + human-discuss qualification gate)
- `swarm_confirm_qualification` (records the human-decision branch)
- `swarm_assign_task` (runs the file-scope ownership preflight)
- `swarm_update_task` (transitions nodes; `force=true, cancelTask=true` is
  root-only and revokes active attempts with `TASK_CANCELLED`/
  `NODE_CANCELLED`/`ASSIGNMENT_SUPERSEDED`)
- `swarm_task_message` (task-scoped out-of-band message)
- `swarm_task_status`
- `swarm_validate_graph`
- `swarm_print_graph`
- `swarm_next_nodes`

`task.json` remains the source of truth for task/node state. The durable
`sharedContext` block, qualification record, and task artifacts under
`tasks/<task-id>/artifacts/` are still supported. Rework edges are
first-class: a declared `rework: true` edge can re-open a failed/skipped node
as `ready` without a root force-reset.

For the live runtime flow (qualification → assign → worker update →
closure → PM notify), see [`docs/swarm/flows/flow.md`](./swarm/flows/flow.md#task-graph-lifecycle).

## Validation

Run the core TypeScript check with GLM/Zai:

```bash
NODE_PATH=$(npm root -g) npx tsc --noEmit --module nodenext --moduleResolution nodenext --skipLibCheck --target es2022 --lib es2022 extensions/swarm/index.ts
```

## Known limitations

- No central server/daemon: all coordination is filesystem + tmux + pi extension hooks.
- No cross-host support.
- No cryptographic authentication for local mailbox writes.
- `session_shutdown` may not fire on hard kills; use `tmuxAlive` and stale heartbeat age to detect that case.
- `/swarm status` is intentionally brief; use `swarm_agent_status` for detailed JSON.
