# Plan: clear flow + payload docs for swarm runtime

## TL;DR

The swarm docs are stale in two measurable ways and missing the **interactive
flow-and-payload** artifact the user asked for. Fix the stale numbers and
author a new `docs/swarm/flows/flow.md` (with `mermaid-interactions` JSON layers)
that walks the four runtime flows end-to-end with clickable payloads.

## Stale facts (measured against current source)

Verified by `grep -c 'name: "' extensions/swarm/src/tools/*.ts`:

| Location | Claim | Source of truth |
| --- | --- | --- |
| `docs/swarm.md` (core surface) | "31 tools" | **35** (agents 19 + messages 5 + tasks 9 + gc 1 + audit 1) |
| `extensions/swarm/README.md` (paragraph + Inventory note) | "31 tools" | **35** |
| `docs/swarm/tools.md` (Tool inventory table) | "Total 33" (19+5+8+1) | **35** (task row missed `swarm_audit`/`swarm_gc` separation; agents row has 19 not 17) |

The `/swarm deregister` slash command (added 2026-09-01, commit `2079bbd`)
is described in `extensions/swarm/README.md` but **not** in `docs/swarm.md`'s
slash-command table or in `docs/swarm/tools.md`. Confirmed:

```
extensions/swarm/src/command.ts: registerSwarmCommand
  -> "deregister" subcommand present, not in docs/swarm.md table
```

The new `.pi/swarm.yml` config source (commit `acbfc6f`) is mentioned in
`extensions/swarm/README.md` but `docs/swarm/operations.md` still tells
operators to edit `.pi/settings.json`. The `/swarm pool` subcommand family
(`list/show/validate/preview-preflight/help/cooldown/clear`) is referenced
in the README but absent from `docs/swarm.md`'s slash-command table.

## What's missing (user's explicit ask: "clear flow and payload")

The repo already has Mermaid diagrams (3 fences in `docs/`) but **zero
`mermaid-interactions` JSON layers**. The user wants clickable, payload-backed
flow diagrams. The `interactive-mermaid-docs` skill is purpose-built for
this and is a perfect fit. The AGENTS.md "swarm feature coding: mock-LLM
fixtures are compulsory" rule does **not** apply — this is a documentation
update, not an `extensions/swarm/` source change.

## Target flows (4 diagrams, 1 file)

`docs/swarm/flows/flow.md` (new) carries four Mermaid fences, each immediately
followed by a `mermaid-interactions` JSON layer. Each edge maps to a payload
file under `docs/swarm/flows/payloads/. One Mermaid fence per flow keeps the
validator simple and each diagram focused on one concern.

1. **Message lifecycle** — sender → mailbox JSONL → recipient pane inject →
   input hook intercept → `swarm_ack_message` → reconcile retry / dead-letter.
   Edges map to the actual `SwarmMessage` JSON envelope, the on-wire
   `buildSystemDelivery` base64 line, the `MessageRecord` lifecycle status
   transitions, and the `swarm_send_message` tool result.
2. **Task graph lifecycle** — `swarm_create_task` (qualification gate
   open) → `swarm_confirm_qualification` → `swarm_assign_task` (scope
   preflight) → node worker update → `computeTaskStatus` closure →
   reconcile + PM auto-notify. Edges map to `task.json`, the scope
   preflight `ACTIVE_SCOPE_CONFLICT` failure, the `swarm_update_task` tool
   result, and a cancel path through `cancelTask=true`.
3. **Root PM pump** — durable mailbox state → `pumpRootMailbox`
   (R10-1 boundary) → `pi.sendMessage` → LLM turn → `swarm_send_message` /
   `swarm_update_task` / `swarm_ack_message` tool calls. Edges map to the
   per-tick surfaced set, the busy-suppression drop case (R15 P0 truth), the
   `agent_settled` retrigger, and the in-page sent message record.
4. **Reconcile & GC** — `swarm_reconcile(mark=true)` → deadline sweep →
   graph-advance / stall / artifact / heartbeat GC nudges →
   `notification.stale.suppressed` trace. Edges map to the reconcile dry-run
   preview, the `swarm_reconcile` tool result with `nextOffset`, and a
   settled-with-open-assignment notify.

One node per major component (root, agent, mailbox JSONL file, tmux pane,
task JSON file, etc.) and one edge per meaningful state change. Stable IDs
(`root`, `worker-pane`, `mailbox-jsonl`, `task-json`, `pump-boundary`,
`pi-sendmessage`, `llm-turn`, `reconcile-runner`, `pm-trace`, etc.) so the
mappings stay valid as prose evolves.

## Payload files (under `docs/swarm/flows/`)

Twelve small payload files, one per edge that warrants a real example. Mix of
`.json`, `.md`, `.txt`:

| File | Backs edge | Content |
| --- | --- | --- |
| `envelope-swarm-message.json` | `sender → mailbox-jsonl` | Minimal `SwarmMessage` (id, swarmId, from, to, body, requiresAck, headers) |
| `envelope-on-wire.txt` | `mailbox-jsonl → recipient-pane` | Literal `__PI_SWARM_BEGIN__ b64:… __PI_SWARM_END__` line |
| `lifecycle-record.json` | `recipient-pane → input-hook` | `MessageRecord` snapshot through `seen→processing→done` |
| `ack-tool-result.md` | `input-hook → acked` | `swarm_ack_message` tool result body and ack shape |
| `dead-letter-trace.json` | `reconcile → dead-letter` | `trace.events.jsonl` line with `dead_letter` outcome |
| `task-graph.json` | `task-json` node | `task.json` excerpt (nodes, attempts, scope) |
| `qualification-gate.md` | `qualify → assign` | `artifacts/qualification-gate.md` template |
| `scope-conflict.json` | `scope-preflight` node | `ACTIVE_SCOPE_CONFLICT` error envelope |
| `pump-tick.json` | `pump-boundary` node | `pumpRootMailbox` per-tick surfaced set |
| `busy-suppression-trace.json` | `busy-drop` edge | `message.busy_suppressed` trace line |
| `reconcile-result.json` | `reconcile-runner → pm-trace` | `swarm_reconcile` tool result with `nextOffset` |
| `settled-open-assign-trace.json` | `settled-notify` edge | `notify.settled_with_open_assignment` trace |

Redacted samples only — no real swarmIds, no real agent content. The skill's
security policy already enforces this.

## Stale-number fixes

1. `docs/swarm.md` line "31 tools" → "**35 tools**"; split inventory into
   the same 5-row table style as `tools.md`; add `/swarm deregister`,
   `/swarm pool list|show|validate|preview-preflight|help|cooldown|clear` to
   the slash-command table; add `.pi/swarm.yml` to the runtime config
   paragraph.
2. `extensions/swarm/README.md` "31 tools" → "**35 tools**" (two places:
   the intro paragraph and the supported-now note). Add `.pi/swarm.yml`
   mention + `/swarm pool` subcommands where they belong.
3. `docs/swarm/tools.md` table — fix counts: agents **19**, messages **5**,
   tasks **9**, gc **1**, audit **1**, total **35**. Add a note that `swarm_audit`
   lives under `src/tools/audit.ts` (separate registration module) and is
   grouped with retention/diagnostic tools.

## Cross-doc updates

- `docs/swarm/index.md` → add `flows/flow.md` under "I want to use swarm" and
  "Recommended reading order" so it's discoverable.
- `docs/swarm/operations.md` → add a one-line pointer to `flows/flow.md` next to
  "Recover or debug delivery" and "Recover or debug task execution".

## Validation gates (must pass before declaring done)

The `interactive-mermaid-docs` skill is blocking on three gates; every error
must be fixed:

1. `python3 scripts/interactive_mermaid.py validate docs/swarm/flows/flow.md`
   — interaction JSON well-formed, mappings resolve to real fences and
   payloads, no path-escape, no duplicates. Exit 0.
2. `python3 scripts/check_mermaid.py docs/swarm/flows/flow.md` — real
   `mmdc` parser, per-diagram line-accurate errors. Exit 0.
3. `python3 scripts/interactive_mermaid.py serve docs/swarm/flows/flow.md
   --port 4317` — open `http://127.0.0.1:4317/.interactive-mermaid-workbench.html`
   in a tmux pane, click at least one edge per diagram, capture pane output
   showing the inspector loaded the right payload. (Mock-LLM rule does not
   apply; this is the editor preview lane the skill mandates.)

The skill's own test suite (`python3 -m unittest discover -s
$SKILL/scripts/tests -v`) is unrelated to our changes and is not in scope
unless the skill scripts themselves change. We do not change skill scripts.

## Reproducing the staleness claim

```bash
grep -c 'name: "' extensions/swarm/src/tools/*.ts
# agents.ts:19  audit.ts:1  gc.ts:1  messages.ts:5  tasks.ts:9 = 35
```

```bash
grep -n "31 tools\|Total.*33" docs/swarm.md docs/swarm/tools.md \
  extensions/swarm/README.md
# docs/swarm.md:31: …"31 tools"…
# docs/swarm/tools.md: …"Total" "33"…
# extensions/swarm/README.md: …"31 tools"…
```

```bash
grep -n "deregister\|\.pi/swarm\.yml" docs/swarm.md docs/swarm/tools.md \
  docs/swarm/operations.md
# docs/swarm.md and docs/swarm/operations.md miss /swarm deregister and
# .pi/swarm.yml; tools.md misses /swarm pool subcommand family.
```

## Why this is enough

The user asked for "clear flow and payload in swarm runtime". The four
diagrams cover the four message/task/pump/reconcile flows; the payload
files give every meaningful edge a real example; the stale numbers get
fixed where they actually mislead operators. Nothing here changes
`extensions/swarm/` source — the swarm-feature mock-LLM rule is correctly
noted as out of scope.
