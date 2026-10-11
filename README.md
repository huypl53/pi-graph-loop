# pi-graph-agents

Pi package for the swarm graph/task extension.

This repository now exposes the swarm extension as a real **pi package** via:

- `package.json` with `keywords: ["pi-package"]`
- `pi.extensions = ["./extensions"]`
- packaged extension entry at `extensions/swarm/index.ts`

The packaged entry at `extensions/swarm/index.ts` is the **only** swarm source. The old project-local `.pi/extensions/swarm/index.ts` dev wrapper was removed when packaging landed (keeping both would double-register the extension).

## What the package provides

The swarm extension provides:

- tmux-backed child pi agents in the same project working directory
- shared project resources, including `.pi/extensions` and `.agents/skills`
- JSON state with locking under `.pi/swarm/swarm-state.json`
- per-agent JSONL mailboxes
- tmux pane injection for inter-agent system messages
- structured traces and tmux pane snapshots
- durable agent identity files
- message lifecycle tracking, acknowledgements, reconciliation, dead letters, and idempotency keys
- task-graph tooling, assignment/update flows, closure derivation, and runtime warnings

Docs are organized as:

```text
docs/swarm/index.md                 # canonical swarm doc map
docs/swarm/architecture.md          # system model and invariants
docs/swarm/contributor-guide.md     # where to implement changes
docs/swarm/operations.md            # runtime/debugging/validation
docs/swarm/tools.md                 # grouped tool and command reference
```

Detailed topic docs remain available in:

```text
docs/swarm.md                       # compact legacy landing/reference
docs/swarm-new-project-setup.md
docs/swarm-memory.md
docs/swarm-task-graph.md
docs/swarm-graph-uat-scenario.md
```

## Install into a new pi project

From the target project, install this repo as a **project-local pi package**:

```bash
pi install -l /absolute/path/to/pi-graph-agents
```

This writes the package path into the target project's `.pi/settings.json` under `packages`.

You can verify it with:

```bash
cat .pi/settings.json
```

Expected shape:

```json
{
  "packages": [
    "/absolute/path/to/pi-graph-agents"
  ]
}
```

Or try it for one run only without changing settings:

```bash
pi -e /absolute/path/to/pi-graph-agents
```

Because this is a pi package, pi loads the packaged extension from:

```text
extensions/swarm/index.ts
```

## Quick start after install

After `pi install -l ...`, start pi normally in the target project. Then inside pi:

```text
/swarm init
/swarm status
/swarm graph <task-id> mermaid
/swarm-agents list
/swarm-tasks status <task-id>
Call swarm_agent_status for all agents.
```

If you want to test the package without editing settings, you can also launch pi directly with the package path:

```bash
pi --model gpt-5.4-mini --provider openai -e /absolute/path/to/pi-graph-agents
```

### Optimization/memory setup for a new project — RETIRED

> **RETIRED (2026-10):** the experimentation subsystem this section described — `swarm_metric_define`, `swarm_run_record`, `swarm_iteration_*`, memory read/propose/accept, and the metric-gate graph unroll — was removed from the extension. The tools are not registered and no demo/watch scripts exist. The setup guide ([`docs/swarm-new-project-setup.md`](docs/swarm-new-project-setup.md)) and memory rules ([`docs/swarm-memory.md`](docs/swarm-memory.md)) are kept as historical evidence only. Do not follow them as current workflow.

## Validation

Recent validation covered:

- happy-path swarm graph execution
- blocked / stale / session-safe probes
- both rework loops
- exact self-stop / stale-nudge case
- package-oriented fresh-run scenario documentation

Typecheck the packaged extension source:

```bash
NODE_PATH=$(npm root -g) npx tsc --noEmit --module nodenext --moduleResolution nodenext --skipLibCheck --target es2022 --lib es2022 extensions/swarm/index.ts
```

### Iteration loop demo — RETIRED

> **RETIRED (2026-10):** the metric/run/memory + iteration loop demo was removed with the experimentation subsystem. `scripts/swarm_iteration_demo.sh` and `scripts/swarm_iteration_watch.sh` no longer exist. See the historical note under "Optimization/memory setup" above; [`docs/swarm-iteration-demo.md`](docs/swarm-iteration-demo.md) is retained as historical evidence.

Task-graph HTML dashboard (static, dependency-free, browser-reviewable) — a read-only visual review surface for task flows and conversations. See [`docs/swarm-dashboard.md`](docs/swarm-dashboard.md) for the current scope and path-safety contract; use `scripts/swarm_dashboard.sh --help` for options.

## Repository notes

Runtime swarm data is intentionally not committed:

```text
.pi/swarm/
.pi/swarm-uat/runs/
```

The package source of truth is `extensions/swarm/index.ts`. There is no longer a project-local `.pi/extensions/swarm/` dev wrapper — it was removed during packaging (since pi would double-register swarm).
