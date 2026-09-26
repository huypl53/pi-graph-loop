---
title: "Phase 4: Modularize Commands & Flow Dialog"
status: completed
---

# Phase 4: Modularize Commands & Flow Dialog

## Overview

Decompose `command.ts` (2,656 LOC) into modular command handlers under `extensions/swarm/src/commands/` (<350 LOC each). Decompose `flow-dialog.ts` (2,442 LOC) into structured components under `extensions/swarm/src/flow/` (<350 LOC each). Preserve backward compatibility by maintaining `src/command.ts` and `src/flow-dialog.ts` as re-export facades.

## Requirements

- [x] Decompose `command.ts` into `src/commands/`:
  - `commands/index.ts`: command registrations via `pi.registerCommand`.
  - `commands/parser.ts`: tokenizing, option extraction, flags normalizer.
  - `commands/agents.ts`: `/swarm spawn`, `register`, `stop`, `restart`, `role`, `pause`, `panes`, `attach`, `sendkey`.
  - `commands/tasks.ts`: `/swarm tasks`, `task`, `graph`, `next`, `validate`.
  - `commands/pool.ts`: `/swarm pool status`, `pool test`, `pool reload`, `pool retry-*`.
  - `commands/goal.ts`: `/swarm goal set`, `clear`, `cancel`, `max-nudges`.
  - `commands/attention.ts`: `/swarm attention`, `remind`.
  - `commands/markers.ts`: `/swarm mark`, `markers`, `capture`.
  - `commands/messaging.ts`: `/swarm send`, `mailbox`.
  - `commands/observability.ts`: `/swarm flow`, `trace`, `metrics`, `focus`, `auto-focus`.
  - `commands/protocol.ts`: `/swarm protocol`.
- [x] Decompose `flow-dialog.ts` into `src/flow/`:
  - `flow/index.ts`: public entry points `openFlowDialog`, `openFlowPicker`, `pickFlowTask`.
  - `flow/types.ts`: dialog data models and contracts.
  - `flow/tree.ts`: graph tree traversal and hierarchy construction.
  - `flow/collectors.ts`: aggregate mailbox lines, attention items, lanes, handoffs.
  - `flow/formatting.ts`: story lines, node status badges, event grouping.
  - `flow/picker-dialog.ts`: task selection picker dialog.
  - `flow/flow-dialog.ts`: full-screen dialog state machine, layout, keybindings.
  - `flow/flow-render.ts`: viewport rendering, message drawer, ANSI coloring.
- [x] Convert `src/command.ts` and `src/flow-dialog.ts` into facade re-exports.
- [x] Verify all command tests (`command-alias.test.mjs`, `flow-dialog.test.mjs`, `smoke.test.mjs`) pass green.

## Related Code Files

- Modify: `extensions/swarm/src/command.ts` (convert to facade)
- Modify: `extensions/swarm/src/flow-dialog.ts` (convert to facade)
- Create: `extensions/swarm/src/commands/*.ts`
- Create: `extensions/swarm/src/flow/*.ts`

## Implementation Steps

1. Extract `src/flow/` modules:
   - Extract tree traversal into `flow/tree.ts`.
   - Extract data aggregation into `flow/collectors.ts`.
   - Extract rendering & dialog classes into `flow/flow-dialog.ts` and `flow/picker-dialog.ts`.
   - Wire facade in `src/flow-dialog.ts`.
   - Test with `node extensions/swarm/tests/flow-dialog.test.mjs`.
2. Extract `src/commands/` modules:
   - Extract parser into `commands/parser.ts`.
   - Extract command groups by domain into separate files.
   - Wire facade in `src/command.ts`.
   - Test with `node extensions/swarm/tests/command-alias.test.mjs` and `smoke.test.mjs`.
3. Check `grep -rnE "catch\s*\{\s*\}"` on newly created directories.
4. Run full test suite.

## Todo

- [x] Extract `src/flow/*.ts` modules
- [x] Convert `src/flow-dialog.ts` to facade
- [x] Extract `src/commands/*.ts` modules
- [x] Convert `src/command.ts` to facade
- [x] Run test suite verification

## Success Criteria

- Both original files reduced from ~2,500 LOC to <150 LOC facades.
- Every new submodule is <350 LOC.
- `command-alias.test.mjs` and `flow-dialog.test.mjs` pass with 0 errors.
