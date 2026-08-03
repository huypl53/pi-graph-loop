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

Full docs are in:

```text
docs/swarm.md
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
Call swarm_agent_status for all agents.
```

If you want to test the package without editing settings, you can also launch pi directly with the package path:

```bash
pi --model gpt-5.4-mini --provider openai -e /absolute/path/to/pi-graph-agents
```

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

### Iteration loop demo

Run the metric/run/memory + iteration loop V1 demo in an isolated fresh session:

```bash
bash scripts/swarm_iteration_demo.sh
```

See [`docs/swarm-iteration-demo.md`](docs/swarm-iteration-demo.md) for the scenario, file-backed assertions, and review artifact paths.

Review iteration state live **or** as a completed-task dashboard (read-only, dependency-free):

```bash
scripts/swarm_iteration_watch.sh --once                                 # text review report
scripts/swarm_iteration_watch.sh --format markdown --out review.md      # Mermaid dashboard
scripts/swarm_iteration_watch.sh --task <taskId> --once                 # review a completed task graph
```

Visual HTML dashboard (static, dependency-free, browser-reviewable):

```bash
scripts/swarm_dashboard.sh --out dashboard.html        # one-shot V2 dashboard (collapsible sections + floating outline + role/branch lanes)
scripts/swarm_dashboard.sh --live --interval 3           # regenerate + auto-refresh
```

## Repository notes

Runtime swarm data is intentionally not committed:

```text
.pi/swarm/
.pi/swarm-uat/runs/
```

The package source of truth is `extensions/swarm/index.ts`. There is no longer a project-local `.pi/extensions/swarm/` dev wrapper — it was removed during packaging (a `scripts/swarm_iteration_demo.sh` guard aborts if both copies ever exist, since pi would double-register swarm).
