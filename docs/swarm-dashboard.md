# Swarm dashboard (static HTML)

`scripts/swarm_dashboard.sh` / `scripts/swarm_dashboard.py` generate a **single, self-contained, dependency-free HTML dashboard** from `.pi/swarm` state. Inline CSS + minimal markup only — no CDN, no JavaScript framework, no build step, works offline from `file://`.

Dashboard V2 keeps the same static/offline contract but makes the operator view easier to scan: task graphs can render as **role lanes** or **branch lanes**, compact cards collapse into chips, conversations are grouped by **conversationId → node pair**, and the inspector can focus a **node** or **artifact** as well as runs/messages/memories.

It prioritizes four sections: **per-iteration metric improvement**, **task-graph node flow**, **agent conversation**, and **inspector/raw details**, while still showing memory/evidence, runs, and trace events.

Data loaders are shared with [`scripts/swarm_iteration_watch.sh`](../scripts/swarm_iteration_watch.py) (the text/Markdown reviewer), so the two tools reflect one data model.

## Quick start

```bash
# one-shot dashboard from the repo root (live swarm state) -> file:
scripts/swarm_dashboard.sh --out dashboard.html
open dashboard.html        # macOS; or xdg-open on Linux

# role lanes are the default; branch lanes are handy for fan-out/rework:
scripts/swarm_dashboard.sh --lanes branch --compact --task <task-id> --out dashboard.html

# to stdout instead of a file (pipe anywhere):
scripts/swarm_dashboard.sh | head

# live: regenerate the file in a loop and auto-refresh the browser tab:
scripts/swarm_dashboard.sh --live --interval 3 --out dashboard.html
# (the HTML includes a <meta refresh> so a viewing browser reloads itself)

# against the isolated iteration demo cwd:
DEMO_CWD="$(ls -td .pi/swarm-uat/runs/iter-demo-*/cwd | head -1)"
scripts/swarm_dashboard.sh --cwd "$DEMO_CWD" --out demo-dashboard.html
```

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `--cwd DIR` | `.` (env `WATCH_CWD`) | swarm cwd to read state from |
| `--out FILE` | stdout (`--once`) / `swarm-dashboard.html` (`--live`) | write HTML to FILE |
| `--once` | (default behavior) | generate once and exit |
| `--live` | off | regenerate the dashboard in a loop every `--interval` |
| `--interval SEC` | 3 | live regeneration interval |
| `--lanes role|branch|none` | `role` | task-graph lane mode |
| `--compact` | off | collapse node cards to compact chips |
| `--iteration ID` | – | focus one iteration session (metric section + inspector) |
| `--task ID` | – | focus one task graph (flow + conversation + inspector) |
| `--node ID` | – | focus one node inside the selected task |
| `--run ID` | – | focus one run (inspector raw JSON) |
| `--message ID` / `--memory ID` | – | focus one message / memory (inspector raw JSON) |
| `--artifact PATH` | – | focus one artifact path (inline text for `.pi/swarm`) |
| `--messages N` | 20 | messages per task in the conversation view |
| `--tasks-limit N` | 6 | task graphs shown in flow/conversation |
| `--runs N` / `--events N` | 10 / 15 | recent runs / trace events shown |

## Sections

1. **Overview** — counts (tasks/iterations/runs/memories) + a task-graphs table linking into the flow section.
2. **Per-iteration metric improvement** *(primary)* — per session: contract/direction, baseline, **recomputed** best (improvement/meaningful, `DRIFT` flag vs stored `bestRunId`), an inline **SVG bar chart** of per-iteration values with Δ labels and a dashed target line, and a visible **text summary** of the trend. `compute_best` mirrors the extension's `computeIterationBest` (maximize/minimize/target/passfail).
3. **Task graph node flow** *(primary)* — V2 supports `--lanes role|branch|none`. Role lanes group nodes by owner type, branch lanes group by topological layer, and `--compact` collapses cards to chips for dense graphs. Status is conveyed by color **and** text/icon (not color alone). Parallel branches render side-by-side instead of a single brittle spine.
4. **Agent conversation** *(primary)* — per task: messages are grouped by conversation/thread and node pair, with `from → to`, subject, ack badge, response/result status, expandable body, and dashed reply links for `resultMessageId`. When a task is focused, the section shows node jump chips for the task's nodes.
5. **Memory & evidence** — status cards (active/proposed/rejected/expired) + a table with per-ref evidence ✓/✗ present/missing and rejection reasons.
6. **Inspector / raw details** — when a focus flag is passed (`--run`/`--task`/`--node`/`--iteration`/`--message`/`--memory`/`--artifact`), shows the selected raw JSON or artifact text in a `<pre>`; otherwise a collapsible raw-state summary with counts and ids.
7. **Recent runs** / **Recent trace events** — tables.

A sticky header shows a **mode/refresh banner** (`role=status`, `aria-live=polite`) with `ONE-SHOT` vs `● LIVE`, the interval, and the generation timestamp.

## Accessibility & responsiveness

- Semantic landmarks (`header`/`nav`/`main`/`section`/`footer`), a "Skip to content" link, logical heading order, `<table>` with `<caption>` and `scope=col`, and charts carry `role="img"` + `aria-label` plus a visible text summary.
- Status uses text + icon + color (never color alone); focus styles and `prefers-reduced-motion` are respected.
- Responsive CSS: multi-column cards on desktop, lane grids for branch/role grouping, collapsing to single column + horizontally-scrollable tables on tablet (≤900px) and mobile (≤600px); the node pipeline and lane grids stack vertically on mobile.

## Relationship to the other tools

- `scripts/swarm_iteration_watch.sh` — text + Markdown/Mermaid **terminal** reviewer for the same state (live watch or one-shot). Use it in the terminal; use the dashboard for a visual/browser review.
- `scripts/swarm_iteration_demo.sh` — creates isolated demo state you can point `--cwd` at.

## Validation gates

```bash
python3 -m py_compile scripts/swarm_dashboard.py
bash -n scripts/swarm_dashboard.sh
scripts/swarm_dashboard.sh --cwd . --out dashboard.html
```

Validation should include at least one generated dashboard artifact and a browser/tmux review when available. The dashboard is **read-only** — the only thing it writes is the `--out` HTML file you choose.

## Cleanup

The dashboard writes only the `--out` file (default `swarm-dashboard.html` in the cwd for `--live`). Remove it when done: `rm -f swarm-dashboard.html`. Demo state it can point at lives under `.pi/swarm-uat/runs/iter-demo-<stamp>/` (gitignored; safe to `rm -rf`).
