# Swarm docs map

This directory is the **canonical documentation map** for the swarm extension.

Use it when you need to understand, extend, or debug swarm without reading one long file first.

## Start here by goal

### I want to use swarm
- [Architecture overview](./architecture.md) — mental model, runtime, invariants
- [Operations guide](./operations.md) — quickstart, runtime files, debugging, validation entrypoints
  - Start with [Model pool configuration](./operations.md#model-pool-multi-provider-rotation)
    (canonical format, legacy singleton, discover/show/validate commands, preflight)
- [Tooling reference](./tools.md) — grouped tools and `/swarm` commands

### I want to change swarm
- [Contributor guide](./contributor-guide.md) — where code lives, how to add features, change checklists
- [Architecture overview](./architecture.md) — subsystem boundaries and source-of-truth rules
- [Pi runtime contract](./pi-runtime-contract.md) — single source of truth for swarm
  assumptions about Pi lifecycle, delivery, interrupt, reload semantics. **Read before
  changing swarm code that crosses a Pi runtime boundary** (the four layers in
  [§1](./pi-runtime-contract.md#1-the-four-layers) and the false-claim register in
  [§10](./pi-runtime-contract.md#10-r12r15-false--unproven-claims-register) are the
  binding artifacts). Cross-reference: [`AGENTS.md`](../../AGENTS.md#pi-runtime-contract-mandatory-consultation).
- [`extensions/swarm/README.md`](../../extensions/swarm/README.md) — implementation module map

### I need detailed legacy/reference material
- [`../swarm.md`](../swarm.md) — consolidated reference doc kept for compatibility
- [`../swarm-task-graph.md`](../swarm-task-graph.md) — detailed task graph design and semantics
- [`../swarm-memory.md`](../swarm-memory.md) — legacy memory / iteration / loop reference
- [`../swarm-new-project-setup.md`](../swarm-new-project-setup.md) — setup recipe for a new project
- [`../swarm-graph-uat-scenario.md`](../swarm-graph-uat-scenario.md) — UAT scenario and review flow
- [`../swarm-iteration-demo.md`](../swarm-iteration-demo.md) — legacy iteration demo scenario
- [`./pi-runtime-evidence.md`](./pi-runtime-evidence.md) — raw citations and reproduction probes backing the [Pi runtime contract](./pi-runtime-contract.md)

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
- When adding a new subsystem or tool, update both the relevant focused doc here
  and the implementation-facing notes in `extensions/swarm/README.md`.
