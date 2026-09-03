# Swarm Flow UI — UX & use-case review

> Review document for the proposed Swarm Observatory UI.
>
> **Current implementation:** `/swarm flow <#|task-id> [--events N]` is a read-only textual flow snapshot. It is an observability foundation, not yet a full interactive visual UI.

## 1. Product intent

Swarm is a tmux-backed, file-backed multi-agent coordination extension. A user needs to answer, quickly and confidently:

1. **What is the swarm doing now?**
2. **Which task/node is blocking progress, and who owns it?**
3. **Do I need to intervene?**
4. **What happened immediately before this state?**
5. **Where can I inspect an agent or its evidence?**

The Flow UI should make these answers available without requiring the user to manually inspect `.pi/swarm/` JSON/JSONL files, understand message lifecycle internals, or attach to every tmux pane.

### Non-goals for the first UI version

- Replace durable task graph tools or task transition validation.
- Create a second source of truth besides `task.json`, `swarm-state.json`, mailboxes, and traces.
- Infer ownership solely from tmux liveness.
- Auto-repair, auto-assign, or mutate the task graph from a monitoring screen.
- Require a daemon or a web server.

## 2. Existing swarm capabilities

The extension already has a strong coordination substrate. The UI should project these capabilities rather than reimplement them.

| Capability | Existing surface / source | User value | UI opportunity |
| --- | --- | --- | --- |
| Agent lifecycle | spawn, register, role, pause, resume, restart, stop | Know who is available and how they are configured | Agent lanes, health and lifecycle actions |
| tmux execution evidence | agent tmux target, liveness checks, pane capture | Distinguish a healthy agent from a dead/stuck pane | Live status badge; capture/attach shortcut |
| Durable messages | mailbox JSONL, delivery state, ACK/response tracking | Explain whether work was delivered and acknowledged | Message timeline and delivery warnings |
| Task graph | `task.json`, node dependencies, branch outcomes, gates | Understand work order, owner, and closure | Visual graph / dependency chain |
| Reconcile and stale signals | reconcile state, runtime warnings, stale fields | Surface work that needs PM attention | Attention queue, severity grouping |
| Evidence/artifacts | declared task artifacts, task artifact directory | Review what an agent produced | Node detail links to artifacts |
| Metrics/memory/iterations | contracts, runs, memories, loop state | Understand optimization work across iterations | Optional iteration context panel |
| Existing graph export | `/swarm graph … text|mermaid|json` | Share a graph outside Pi | Export action / inspectable artifact |

## 3. Current Flow feature

### Command

```text
/swarm flow <#|task-id> [--events N]
```

- Task identifier accepts the existing task index, full ID, or unique prefix.
- `--events N` selects the event tail; default is `20`, capped at `100`.
- No task argument lists tasks and shows usage.

### Current output coverage

The output combines existing file-backed sources:

- **Task header:** task status, open-node count, stale-node count.
- **Node lines:** node status, assignee, role, dependency, outcome, stale timestamp.
- **Agent lanes:** all registered agents, agent status, role kind, active task assignment.
- **Readiness:** ready and current nodes.
- **Events:** recent merged records from global swarm trace and task event trace.
- **Optional loop line:** loop round/phase if the task has an enabled iteration loop.

It also writes an inspectable snapshot under:

```text
.pi/swarm/traces/graphs/<task-id>.flow.txt
```

and appends a `task.flow.read` audit event. It does not mutate `task.json` or `swarm-state.json`.

### What this version is good for

- A PM debugging why a known task is not advancing.
- A developer verifying handoffs, assignees, and node closure.
- Incident/forensic review using a saved snapshot and durable event history.
- A text-only terminal workflow where no browser or daemon is desired.

### What it is not yet

- A full-screen custom Pi UI.
- A visual dependency graph.
- A live or refreshable dashboard.
- An attention-first operational view.
- A task picker optimized for users who do not know the task ID.

## 4. Primary users and their jobs-to-be-done

### A. Root / PM

**Goal:** run multi-agent work without constantly opening panes or parsing JSON.

| Job | Current coverage | UX gap |
| --- | --- | --- |
| See active work | Partial: `/swarm status`, `/swarm flow <task>` | Must know/select a task; agent list is noisy |
| Know what needs intervention | Partial: stale/open counts and raw events | No prominent action-oriented alert queue |
| Decide next assignment | Covered by `/swarm next <task>` | Flow view does not link/jump to next-node recommendation |
| Verify an agent is actually alive | Covered by status, tmux data, capture tools | Flow does not clearly separate runtime health and durable ownership |
| Inspect the output/evidence | Covered by task artifacts and pane capture | Flow does not expose artifact/pane shortcuts |

### B. Agent operator / developer

**Goal:** understand a specific assignment and diagnose a failed handoff.

| Job | Current coverage | UX gap |
| --- | --- | --- |
| Find its current node and dependencies | Good: node lines + current/ready lists | Text scan is slower than graph focus |
| Tell whether a message reached the recipient | Partial: event tail contains delivery events | No delivery-state visualization or correlation to a node |
| Review what happened before a failure | Partial: events are merged and timestamped | Events are technical, noisy, and not grouped by failure/interaction |
| Open the exact agent pane | Existing `/swarm attach` and `/swarm capture` | Not discoverable from Flow output |

### C. Reviewer / stakeholder

**Goal:** review progress and risk without driving the swarm.

| Job | Current coverage | UX gap |
| --- | --- | --- |
| Understand task progress | Good for a known task | Needs a simpler summary/progress visualization |
| See blocked/failed work | Partial | Failure severity and recommended owner/action are absent |
| Audit decisions and artifacts | Durable traces/artifacts exist | No concise activity narrative or evidence links |

## 5. Core use cases and coverage matrix

Legend: **Covered** = available in present command/tooling; **Partial** = data exists but workflow is awkward; **Missing** = requires a later UI feature.

| # | Use case | Desired user question | Current coverage | Why |
| --- | --- | --- | --- | --- |
| 1 | Check a known task's progress | “Where is `feature-login` now?” | **Covered** | `/swarm flow <task>` shows node status, owner, ready/current nodes |
| 2 | Find the active task from scratch | “What is the swarm currently working on?” | **Partial** | `/swarm flow` lists tasks but does not select/focus the best candidate |
| 3 | Find a blocked handoff | “Why has implementation not moved to testing?” | **Partial** | Nodes and events are visible, but no explicit delivery/ACK diagnosis summary |
| 4 | Identify action needed from PM | “What should I do next?” | **Partial** | Stale/open counts exist, but alerts do not rank severity or recommend an action |
| 5 | See dependency flow at a glance | “What comes before/after this node?” | **Partial** | `depends:` text and `/swarm graph` exist, but Flow has no visual graph |
| 6 | Find a responsible agent | “Who owns the blocker?” | **Covered** | Node lines expose assignee and agent lanes show status |
| 7 | Determine whether an agent is healthy | “Is this worker stuck or just waiting?” | **Partial** | State contains health/runtime/tmux data, but output reduces it to agent status |
| 8 | Inspect the worker | “Open/capture the pane for this agent.” | **Partial** | Existing attach/capture tools work, but Flow has no contextual interaction |
| 9 | Understand recent changes | “What happened in the last few minutes?” | **Covered** | Merged recent event timeline; `--events` controls volume |
| 10 | Filter technical noise | “Show only failures/messages for this task.” | **Missing** | No event type/source/severity filter |
| 11 | Monitor an iteration loop | “Which round and proposal phase are we in?” | **Partial** | Loop phase can render, but proposal and plan details do not have a dedicated view |
| 12 | Share task state externally | “Put the flow in a PR or incident report.” | **Partial** | Text snapshot and Mermaid graph exist; no intentional Flow export UX |
| 13 | Observe many parallel tasks | “Which task is at risk across the swarm?” | **Missing** | Flow is task-scoped, no portfolio overview |
| 14 | Live monitoring | “Has the state changed while I am watching?” | **Missing** | Snapshot is one-time; operator reruns the command manually |

## 6. UX assessment of the current command

### Strengths

1. **Safe mental model:** it is read-only and uses durable existing state.
2. **Low infrastructure cost:** no new process, server, database, or sync layer.
3. **Inspectable:** output is saved as a trace artifact and can be reviewed later.
4. **Consistent command behavior:** task IDs/indexes use the existing resolver and completion patterns.
5. **Good debugging baseline:** node ownership plus event tail provides more context than task status alone.

### Friction points

1. **Task discovery costs an extra step.** A user without a task ID sees a list, then must decide and rerun the command.
2. **The agent lane is not task-focused.** Historical/stopped agents can dominate output even when irrelevant to the selected task.
3. **Raw events are not equivalent to an operational narrative.** Pump/reconcile events can hide the important message, failure, or handoff.
4. **Open/stale counters lack prioritization.** `open=2 stale=0` does not state whether the PM should act.
5. **Text is not a graph.** Dependency relations need visual scanning effort, especially with parallel branches.
6. **No drill-down action.** A user cannot select an agent/node to inspect its pane, artifact, message, or task detail.
7. **No refresh affordance.** A running swarm forces repeated command invocation.

## 7. Recommended UX model

The target should be an **attention-first observability screen**, not merely a graph renderer.

### Default user journey

```text
/swarm flow
  → if no task is specified, open a compact picker of actionable tasks
  → render one selected task by default
  → show attention items first
  → show task graph and task-relevant agent lanes
  → offer drill-down, refresh, and next-action hints
```

For V1, `/swarm flow` must not guess silently. If the selection is ambiguous, the user chooses from a compact picker. A later release may auto-focus the highest-priority active task, but only if the ranking rules are documented and the picker remains the fallback when choice is unclear.

Suggested task ordering when a picker is shown:

1. a task with failed or blocked nodes;
2. a task with stale nodes or delivery/ACK warnings;
3. an in-progress task with assigned or in-progress nodes;
4. a ready task;
5. the most recently updated task.

### Screen hierarchy

```text
Swarm Observatory · feature-login · in progress · refreshed 12:31:06

ATTENTION (actionable only)
  ! reviewer pane unavailable while review is assigned
  ⚠ test message has not been acknowledged for 4m

FLOW
  ✓ plan ──────> ● implement ──────> ○ test ──────> ○ review
    planner        implementer          tester         reviewer

ACTIVE LANES (task-relevant)
  ● implementer  tool running · node=implement · healthy
  ○ tester       idle · ready for test
  ! reviewer     pane unavailable · assigned review
  + other agents  2 inactive / 1 historical lane collapsed

RECENT ACTIVITY
  12:30 implement completed · artifact: artifacts/implementation.md
  12:29 implementation handoff → tester
  12:28 planner plan approved

[r] refresh  [Enter] detail  [f] filter  [a] alerts  [n] next action  [Esc] close
```

### Attention hierarchy

Flow must rank actionable information in a fixed order so the user can answer “what needs me?” immediately:

1. failed or blocked nodes;
2. stale nodes;
3. ACK / response / delivery warnings;
4. dead or unhealthy pane for an active assignee;
5. current node and accountable agent;
6. ready nodes and suggested next action;
7. graph/dependencies;
8. historical event stream.

### Information priorities

| Priority | Information | Reason |
| --- | --- | --- |
| First | blocked, failed, stale, ACK missing, response missing, dead pane for active assignee | These need intervention |
| Second | current node and owner | Shows active progress |
| Third | ready node and suggested next action | Helps orchestration |
| Fourth | graph/dependencies | Supplies context |
| Fifth | historical event stream | Supports diagnosis/audit |

### Interaction model

The first release is still text-first, but it should define a concrete interaction contract so the eventual Pi TUI is predictable and testable.

Minimum target behavior:

- `r` refresh
- `Enter` or `o` open the selected detail
- `Tab` / arrows move focus
- `/` filter nodes or events
- `Esc` close or go back
- visible footer showing the available shortcuts

If the view remains pure text in a given command mode, the footer can be rendered as static hints; if the view is interactive later, these become real keyboard bindings.

### Task-relevant filtering

The default task view should prefer relevance over exhaustiveness:

- show the selected task’s assignee lanes;
- show agents with active alerts for that task;
- collapse inactive or historical agents by default;
- surface a compact “other agents” summary when needed.

### Next-action affordances

The UI should guide the operator toward the next safe step, not only describe the current state.

Examples:

- inspect the next node via `/swarm next <task>`;
- capture or attach to the relevant agent pane;
- open task artifacts;
- refresh after reconcile or handoff;
- jump to the task detail or graph view.

These should be rendered as hints or shortcuts, not as hidden documentation.

## 8. Proposed phased roadmap

### Phase 1 — Make the current text command operationally easy

No custom TUI required.

- `/swarm flow` selects/focuses the best active task or offers a compact picker.
- Default agent lanes to agents assigned to the task plus agents with active alerts.
- Add an **Attention** block with severity and suggested next command/action.
- Group/filter events by `messages`, `task`, `errors`, and `all`.
- Add direct hints for related operations: `/swarm task`, `/swarm next`, `/swarm capture`, `/swarm attach`.
- Add an intentional export option such as `--format text|json|mermaid` if it does not overlap confusingly with `/swarm graph`.

**Expected outcome:** a PM can answer “what needs me?” in one command.

### Phase 2 — Full-screen Pi TUI overlay

Use the existing background-runs dialog as the concrete interaction and implementation reference: `extensions/background-tasks/src/dialog.ts` (`BgDialog` opened by `openBgDialog`). Flow should use `ctx.ui.custom(..., { overlay: true })` in TUI mode with static responsive overlay dimensions, a bordered list/detail layout, visible keyboard footer, and cleanup of any refresh timer in `dispose()`. Retain a text fallback for print/JSON/RPC modes.

- Three focusable panes: Attention + Graph, Agent Lanes, Event Timeline.
- Keyboard navigation: `Tab`, arrows, `Enter`, `r`, `f`, `Esc`.
- Detail overlay for selected node/agent/event.
- Explicit refresh triggered by `r`; optional bounded refresh while the screen is open.
- Pane capture/attach is a confirmable shortcut, not a background action.
- Do not copy background-runs' destructive shortcuts (`stop`, `kill`, `prune`) into Flow; Flow remains read-only and links to validated swarm commands instead.

**Expected outcome:** a user can observe and diagnose a running swarm without repeatedly retyping commands.

### Phase 3 — Portfolio and iteration observability

- Swarm-wide task board: active / ready / blocked / completed task groups.
- Cross-task alert queue.
- Loop round/proposal/plan view.
- Optional Mermaid/HTML export for reporting and postmortems.

**Expected outcome:** supports longer-running projects and many concurrent task graphs.

### Phase 4 — Optional browser view

Only justify this when graph size, historical timeline, zooming, or multiple human observers exceed Pi TUI ergonomics. It should remain a local, read-only projection of file-backed state; it must not introduce a required daemon for core swarm operation.

## 9. Reliability contract

Flow must remain a read-only observability surface, with durable task state and runtime state kept separate.

### Source-of-truth boundaries

- `task.json` is the source of truth for node state, ownership, outcomes, and graph transitions.
- `swarm-state.json` and tmux probes are the source of truth for agent runtime health.
- mailbox JSONL and trace JSONL files are the source of truth for message and event history.
- tmux liveness is advisory evidence only; it must never be treated as durable ownership by itself.

### Refresh, concurrency, and staleness

- Every live or interactive view must show a visible “last refreshed” timestamp.
- Stale snapshots must be labeled clearly.
- Explicit refresh is required for the first release; any later auto-refresh must be bounded and opt-in.
- Refresh is read-only: it must never silently invoke reconcile, retry delivery, or mutate task state.
- Flow is a snapshot over eventually consistent files. It must tolerate brief cross-file disagreement and partial transitions; it must surface a `data in transition`/disagreement marker rather than invent a merged state or attempt repair.
- The UI must not speculate about missing state just because a pane is alive or dead.

### Attention alert taxonomy

The Attention block preserves lifecycle distinctions instead of flattening every problem into “blocked.” Its fixed order is:

1. failed/blocked nodes, unresolved gates, and required branch outcomes;
2. stale nodes;
3. message states: delivery pending/intercepted (**watch**), failed delivery/dead letter (**act now**), ACK missing, and response missing;
4. dead or unhealthy pane for an actively assigned node (runtime evidence only);
5. current/ready work and historical activity.

Each alert must name the related task/node/agent/message and show a safe next-action hint.

### Failure modes

- Missing task state: show a clear empty/error state and keep the UI read-only.
- Malformed event or trace lines: ignore the bad record and continue.
- Missing agent record: show unknown/unavailable.
- Unreadable pane or capture target: show a capture/inspect hint rather than crashing.
- Partially written files or concurrent churn: prefer snapshot consistency and explicit refresh over repair logic.

### Scale limits

- Default to a small recent-event window.
- Collapse idle or historical agents by default.
- Keep the task-scoped snapshot compact enough for terminal use.

## 10. Interaction safety rules

The Flow UI may offer shortcuts, but task mutations must continue through existing validated tools.

| UI action | Allowed behavior |
| --- | --- |
| Refresh | Re-read files / runtime status only |
| View node, agent, event, artifact | Read-only |
| Copy attach command | Read-only |
| Capture a pane | Explicit user action; write only a trace capture |
| Attach/select tmux pane | Explicit user action |
| Assign/update/restart/stop | Link to existing commands/tools; confirm destructive operations |
| Reconcile | Never automatic from UI; present as explicit repair action with preview first |

Accessibility and readability requirements:

- use color plus text/icon, not color alone;
- keep a stable section order;
- truncate long lines safely;
- support narrow terminals without hiding the key state;
- provide non-color status/severity fallbacks.

This preserves the existing source-of-truth and ownership invariants.

## 11. Review questions / decisions requested

1. **Primary user:** is the first target the PM/root, individual agent operator, or a stakeholder observer?
2. **Default scope:** should `/swarm flow` focus one inferred active task, always show a picker, or show a portfolio board?
3. **Interaction level:** is read-only plus inspect/attach/capture enough for V1, or should node assignment and retry actions be available from the UI?
4. **Agent filtering:** should stopped/historical agents be hidden by default? Recommended: yes.
5. **Alert policy:** which conditions count as intervention-worthy: blocked, failed, stale, ACK missing, response missing, dead active pane, open gate, delivery retry?
6. **Live behavior:** explicit `r` refresh only, or bounded auto-refresh while a full-screen view is open?
7. **Output target:** Pi TUI first is recommended. Is an optional browser/HTML export a near-term need?
8. **Information disclosure:** should observers see message bodies by default, or only subjects/metadata until deliberate drill-down?

## 12. Success criteria for a real Flow UI

A first-time PM should be able to open the view and, within roughly 10 seconds, identify:

- the active or highest-risk task;
- the current node and accountable agent;
- whether there is a blocker requiring intervention;
- the recommended next operation; and
- where to inspect the detailed evidence.

The implementation should remain:

- file-backed and inspectable;
- no-daemon for core operation;
- read-only by default;
- compatible with existing task graph validation and message lifecycle semantics;
- usable in text fallback mode outside interactive Pi TUI.

## 13. V2 — human-comprehension redesign (adopted)

> Amended after user feedback and the UX/graph-model review cycle (task `task-202608231104-human-comprehension-rede`, artifacts: ux-review.md, graph-model-review.md, synthesis.md). The V1 contract above is unchanged; this section defines the V2 presentation layer.

### Problem

The V1 dialog answers with flat rows (ATTENTION/FLOW/LANES/EVENTS). A human cannot see in one glance: the graph shape, which node is running now, and whether the handoff message between nodes is healthy. The redesign makes those three answers the primary surface.

### Target render (linear task)

```text
╭─ swarm observatory · feature-login · 62% · implement running (12m) · next: review · 1 needs attention ─╮
│ refreshed 12:31:06 · fresh                                                                          │
│ GRAPH                                                                                                 │
│   ✓ plan ──▶ ▶ implement ──▶ ○ review                                                                │
│   handoff: plan→implement delivered ✓ acked                                                          │
│   current: ▶ implement · obs-implementer · 12m                                                       │
│ ATTENTION                                                                                             │
│   ! implement is waiting for ACK from root — capture pane                                    │
│ FLOW / LANES / EVENTS(grouped)                                                                        │
│ [r] refresh [Enter] detail [/] filter [o] lanes [a] attention [d] debug raw [Esc] close               │
╰────────────────────────────────────────────────────────────────────────────────────────────╱╯
```

### Summary decision table

| # | Decision | Priority |
|---|---|---|
| D1 | Story line: one-sentence header (percent · running node+owner+age · next · attention count) | P0 |
| D2 | GRAPH overview pane: chain-per-path from `task.nodes`+`task.edges`; branch `when` labels, `↺` rework marker; wide graphs wrap or collapse done prefix to `✓…` | P0 |
| D3 | Current-node highlight: `task.currentNodes` → in_progress → assigned → ready; multi-current labeled `parallel current`; ambiguity bannered, never guessed | P0 |
| D4 | Plain-language attention sentences (owner + action); technical terms kept in detail view | P0 |
| D5 | Handoff indicators: linkage via `assignmentMessageId` → `messageIds` → task events → message lifecycle; inline phrases `delivered ✓ acked` / `in flight` / `stuck` / `no handoff record`. **Aggregation rule:** when a node references multiple messages, render the latest non-superseded assignment/handoff message inline; superseded ones remain in the node detail panel | P1 |
| D6 | Node detail panel: edges in/out, message chain with lifecycle, events, lane health, gates | P1 |
| D7 | Events grouped (transition / assignment / delivery / error), not a raw dump | P1 |
| D8 | Lanes remain secondary (task-relevant + collapsed others) | P1 |
| D9 | `d` debug toggle: opt-in raw row view (V1 rendering) for operators | P1 |
| D10 | Gates as node-adjacent or `task-level/unmapped` metadata | P2 |
| D11 | Schema-change ideas (currentNodeId, messageLinks, per-edge gates, persisted UI state, layout metadata) deferred | P2 |

### Cross-cutting invariants

- Read-only: rendering only; no mutation shortcuts, no auto-reconcile.
- Sources of truth unchanged (task.json / swarm-state.json / traces); disagreements surfaced as `state mismatch`, never merged.
- Unknown states are explicit: `no handoff record`, `message not found`, `agent unavailable`, `orphan edge` — never infer success from absence of failure.
- Accessibility: icon+color (never color alone), stable section order, narrow-terminal collapse rules.
- No schema changes required for P0/P1.

The full derivation rules (topology traversal, current-node priority, message-linkage precedence, special states) are specified in the task's `artifacts/synthesis.md` decision table, which is the implementation contract for V2.

### V2 section order

Keep the V2 surface ordered as:

1. story line
2. GRAPH overview
3. ATTENTION items
4. FLOW rows (secondary)
5. LANES (collapsed by default)
6. grouped EVENTS
7. `d` raw/debug toggle only as an opt-in operator escape hatch

The render must stay read-only: refresh re-reads files, hints are copyable commands only, and no UI action may auto-reconcile, mutate, or retry swarm state.
