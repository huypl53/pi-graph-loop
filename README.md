# pi-graph-agents

Experimental graph/loop agent harness built on top of [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). The current focus is a project-local `swarm` extension that lets one orchestrator pi session spawn and coordinate multiple child pi agents in tmux.

## Swarm extension

The swarm extension lives at:

```text
.pi/extensions/swarm/index.ts
```

It provides:

- tmux-backed child pi agents in the same project working directory
- shared project resources, including `.pi/extensions` and `.agents/skills`
- JSON state with locking under `.pi/swarm/swarm-state.json`
- per-agent JSONL mailboxes
- tmux pane injection for inter-agent system messages
- structured traces and tmux pane snapshots
- durable agent identity files
- message lifecycle tracking, acknowledgements, reconciliation, dead letters, and idempotency keys
- runtime status/heartbeat fields from pi lifecycle events

Full docs are in:

```text
docs/swarm.md
```

## Quick start

Start pi with the local extension:

```bash
pi --model glm-4.5 --provider zai-coding-cn -e .pi/extensions/swarm/index.ts
```

Then inside pi:

```text
/swarm init
/swarm status
/swarm spawn reviewer Review the current diff and report risks. Do not edit files.
```

For richer JSON output, ask pi to use the swarm tools, for example:

```text
Call swarm_agent_status for all agents.
```

## Validation

Run the UAT harness:

```bash
SWARM_MODEL=glm-4.5 SWARM_PROVIDER=zai-coding-cn scripts/swarm_uat.sh
```

UAT docs and artifacts:

```text
.pi/swarm-uat/README.md
.pi/swarm-uat/runs/<run-id>/
```

Typecheck the extension:

```bash
NODE_PATH=$(npm root -g) npx tsc --noEmit --module nodenext --moduleResolution nodenext --skipLibCheck --target es2022 --lib es2022 .pi/extensions/swarm/index.ts
```

## Repository notes

Runtime swarm data is intentionally not committed:

```text
.pi/swarm/
.pi/swarm-uat/runs/
```

This project also contains early package scaffolding from `bun init`; the swarm extension is currently the active development target.
