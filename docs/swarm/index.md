# Swarm docs map

This directory is the **canonical documentation map** for the swarm extension.

Use it when you need to understand, extend, or debug swarm without reading one long file first.

## Start here by goal

### I want to use swarm
- [Architecture overview](./architecture.md) — mental model, runtime, invariants
- [Operations guide](./operations.md) — quickstart, runtime files, debugging, validation entrypoints
- [Tooling reference](./tools.md) — grouped tools and `/swarm` commands

### I want to change swarm
- [Contributor guide](./contributor-guide.md) — where code lives, how to add features, change checklists
- [Architecture overview](./architecture.md) — subsystem boundaries and source-of-truth rules
- [`extensions/swarm/README.md`](../../extensions/swarm/README.md) — implementation module map

### I need detailed legacy/reference material
- [`../swarm.md`](../swarm.md) — consolidated reference doc kept for compatibility
- [`../swarm-task-graph.md`](../swarm-task-graph.md) — detailed task graph design and semantics
- [`../swarm-memory.md`](../swarm-memory.md) — run / memory / evidence protocol
- [`../swarm-new-project-setup.md`](../swarm-new-project-setup.md) — setup recipe for a new project
- [`../swarm-graph-uat-scenario.md`](../swarm-graph-uat-scenario.md) — UAT scenario and review flow
- [`../swarm-iteration-demo.md`](../swarm-iteration-demo.md) — iteration demo scenario

## Recommended reading order for contributors
1. [Architecture overview](./architecture.md)
2. [Contributor guide](./contributor-guide.md)
3. [`extensions/swarm/README.md`](../../extensions/swarm/README.md)
4. Detailed topic docs only for the subsystem you are changing

## Documentation rules
- Prefer adding new behavior docs under `docs/swarm/` first.
- Keep root `README.md` short and package-oriented.
- Keep `extensions/swarm/README.md` focused on the code map and contributor entrypoints.
- Keep `docs/swarm.md` as a compatibility/reference page, not the only place new concepts are explained.
- When adding a new subsystem, lifecycle state, or tool, update both the relevant focused doc here and the implementation-facing notes in `extensions/swarm/README.md`.
