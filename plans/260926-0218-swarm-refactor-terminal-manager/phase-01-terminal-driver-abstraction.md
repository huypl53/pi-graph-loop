---
title: "Phase 1: Terminal Driver Abstraction & TmuxDriver"
status: completed
---

# Phase 1: Terminal Driver Abstraction & TmuxDriver

## Overview

Define the pluggable `TerminalDriver` interface and types in `extensions/swarm/src/terminal/types.ts`. Extract current verbatim tmux logic from `extensions/swarm/src/tmux.ts` into `extensions/swarm/src/terminal/drivers/tmux.ts`. Ensure `src/tmux.ts` remains a 100% backward-compatible re-export facade so no consumer or test is broken. Prevent dual-property state drift by keeping `tmuxTarget`, `tmuxSession`, and `tmuxAlive` as the canonical stored fields.

## Requirements

- [x] Create `src/terminal/types.ts` defining `TerminalDriver`, `TerminalTargetRef`, `TerminalPaneInfo`, `SpawnAgentOptions`, and `FocusStatus`.
  - Maintain `tmuxTarget`, `tmuxSession`, and `tmuxAlive` on `SwarmAgent` as canonical properties (no dual-property desynchronization).
  - Add dynamic `detectCurrentPane(pi)` to identify the operator's current host terminal.
  - Require drivers to implement `isSameTarget(targetA, targetB)` for safe comparison across formats.
- [x] Create `src/terminal/drivers/tmux.ts` implementing `TerminalDriver` by adapting existing logic in `src/tmux.ts`.
- [x] Implement `isRootHostPane(target)` helper in `src/terminal/` to prevent `ERR_ROOT_PANE_REJECTED` bypass even when `root.tmuxTarget` is `"unknown"`.
- [x] Re-export all functions from `src/tmux.ts` by delegating to `TmuxDriver` or keeping compatibility wrappers.
- [x] Add `MockTerminalDriver` in `src/terminal/drivers/mock.ts` for fast, offline unit testing.
- [x] Verify all 117 tests pass with zero regressions.

## Related Code Files

- Modify: `extensions/swarm/src/tmux.ts` (turn into facade delegating to TmuxDriver)
- Modify: `extensions/swarm/src/identity.ts` (ensure root host pane detection)
- Create: `extensions/swarm/src/terminal/types.ts`
- Create: `extensions/swarm/src/terminal/drivers/tmux.ts`
- Create: `extensions/swarm/src/terminal/drivers/mock.ts`
- Create: `extensions/swarm/src/terminal/index.ts`

## Implementation Steps

1. Create `src/terminal/types.ts` with all core interface contracts:
   - `isAvailable(pi)`
   - `detectCurrentPane(pi)`
   - `listPanes(pi)`
   - `spawnAgent(pi, opts)`
   - `killAgent(pi, target)`
   - `isTargetAlive(pi, target)`
   - `inspectProcess(pi, target)`
   - `sendText(pi, target, text)`
   - `sendKeys(pi, target, keys, opts)`
   - `capturePane(pi, target, lines)`
   - `focusWindow(pi, target)`
   - `getFocusStatus(pi, session)`
   - `getAttachCommands(target)`
   - `isSameTarget(targetA, targetB)`
2. Author `src/terminal/drivers/tmux.ts` implementing `TerminalDriver`:
   - Port `tmux()`, `capturePane()`, `sendToPane()`, `isTmuxRunning()`, `isPanePiLike()`, `currentPaneTarget()`, `resolveRegisterTarget()`, `listAllPanes()`.
   - Maintain the `PANE_SEND_CHUNK_CHARS = 2_000`, `PANE_SEND_CHUNK_GAP_MS = 120`, and `PANE_SEND_ENTER_DEBOUNCE_MS = 450` chunking and debouncing invariants.
3. Fix root pane rejection guard:
   - In `identity.ts` and `tools/agents.ts`, check `driver.detectCurrentPane()` dynamically to prevent host shell keystroke injection.
4. Update `src/tmux.ts` to instantiate `TmuxDriver` and re-export helper functions to preserve existing call signatures.
5. Run `npm run test:swarm` to confirm tests remain green.

## Todo

- [x] Draft `src/terminal/types.ts`
- [x] Implement `src/terminal/drivers/tmux.ts`
- [x] Author `src/terminal/drivers/mock.ts`
- [x] Implement dynamic host pane detection to fix root guard
- [x] Facade `src/tmux.ts`
- [x] Run test suite verification

## Success Criteria

- All existing tmux tests (`tmux-alive-fallback-reproduce.test.mjs`, `pane-pi-like.test.mjs`, `send-keys-guard.test.mjs`, `auto-focus.test.mjs`) pass with 0 errors.
- `grep -rnE "catch\s*\{\s*\}" extensions/swarm/src/terminal` returns 0.
