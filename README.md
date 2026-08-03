# pi-graph-agents

Pi package for the swarm graph/task extension.

This repository now exposes the swarm extension as a real **pi package** via:

- `package.json` with `keywords: ["pi-package"]`
- `pi.extensions = ["./extensions"]`
- packaged extension entry at `extensions/swarm/index.ts`

The project-local dev entry still works too:

- `.pi/extensions/swarm/index.ts` → re-exports the packaged source from `extensions/swarm/index.ts`

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

## Repository notes

Runtime swarm data is intentionally not committed:

```text
.pi/swarm/
.pi/swarm-uat/runs/
```

The package source of truth is now `extensions/swarm/index.ts`. The project-local `.pi/extensions/swarm/index.ts` file is only a thin development wrapper.
