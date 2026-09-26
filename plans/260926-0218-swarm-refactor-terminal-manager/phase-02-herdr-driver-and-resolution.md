---
title: "Phase 2: HerdrDriver Implementation & Auto-Resolution"
status: completed
---

# Phase 2: HerdrDriver Implementation & Auto-Resolution

## Overview

Implement `HerdrDriver` in `extensions/swarm/src/terminal/drivers/herdr.ts` using Herdr's CLI and socket APIs with strict process confinement, environment sanitization, and workspace isolation. Update `pool.ts` to generalize session preflight checks. Implement `getTerminalDriver()` factory defaulting safely to `"tmux"` to protect test suite mocks while enabling Herdr via config or environment.

## Requirements

- [x] Create `src/terminal/drivers/herdr.ts` implementing `TerminalDriver` for Herdr:
  - Workspace Confinement: Confine all Herdr commands to the designated swarm workspace ID (`--workspace <workspaceId>`), preventing cross-tenant access to unrelated user panes.
  - Process Binding & Anti-Ghosting: Spawn pi inside Herdr using `exec pi ...` (or native Herdr agent start) so the pane terminates immediately when pi exits or crashes.
  - Process Inspection: Implement `isTargetAlive` by inspecting the foreground process (`herdr pane process-info --pane <id>`), ensuring dead pi processes at shell prompts are detected as dead.
  - Environment Isolation: Pass `--env PI_SWARM_AGENT_ID=<id> --env PI_SWARM_IS_ROOT=0` to prevent spawned workers from inheriting root orchestrator authority.
  - Key Normalization: Add key translation map (e.g. `C-c` -> `ctrl+c`, `Escape` -> `esc`) to support `/swarm sendkey` and interrupt nudges under Herdr syntax.
- [x] Update `pool.ts`:
  - Generalize `checkTmuxSession(session)` to `checkTerminalSession(driver, session)`. Under Herdr, verify Herdr workspace/session instead of requiring `$TMUX`.
- [x] Implement `getTerminalDriver(cfg?: SwarmConfig)` factory in `src/terminal/index.ts`:
  - Precedence: (1) `process.env.PI_SWARM_TERMINAL_MANAGER`, (2) config file `swarm.terminalManager`, (3) default to `"tmux"`.
  - Do NOT auto-activate Herdr purely because `HERDR_ENV=1` is present, protecting the 40+ test suites stubbing `pi.exec("tmux", ...)`.
- [x] Migrate `agents.ts`, `mailbox.ts`, `focus.ts`, `nudges/graph-advance.ts`, and `command.ts` to call driver methods.
- [x] Add `extensions/swarm/tests/herdr-driver.test.mjs` verifying Herdr driver interactions with mocked CLI responses.

## Related Code Files

- Create: `extensions/swarm/src/terminal/drivers/herdr.ts`
- Create: `extensions/swarm/tests/herdr-driver.test.mjs`
- Modify: `extensions/swarm/src/terminal/index.ts`
- Modify: `extensions/swarm/src/pool.ts` (generalize checkTmuxSession)
- Modify: `extensions/swarm/src/agents.ts`
- Modify: `extensions/swarm/src/mailbox.ts`
- Modify: `extensions/swarm/src/focus.ts`
- Modify: `extensions/swarm/src/config.ts`

## Implementation Steps

1. Build `HerdrDriver`:
   - Enforce workspace parameterization: `herdr workspace create --label <session>` stores workspace ID.
   - `spawnAgent`: creates tab with isolated environment (`--env PI_SWARM_AGENT_ID=<id> --env PI_SWARM_IS_ROOT=0`) and executes command with `exec ...`.
   - `isTargetAlive`: inspects foreground process via `herdr pane process-info` to verify pi is running.
   - `sendText`: calls `herdr pane send-text` and `herdr pane send-keys Enter`.
   - `capturePane`: calls `herdr pane read --workspace <ws> --source recent-unwrapped`.
   - `focusWindow`: calls `herdr tab focus`.
   - `sendKeys`: translates tmux key tokens to Herdr key syntax before sending.
2. Update `pool.ts`:
   - Allow `checkTerminalSession` to validate Herdr workspace status without requiring `$TMUX`.
3. Implement factory `getTerminalDriver(cfg)` with safe defaults.
4. Wire consumers across `agents.ts`, `mailbox.ts`, `focus.ts`.
5. Run `npm run test:swarm` and the new `herdr-driver.test.mjs`.

## Todo

- [x] Implement `HerdrDriver` with workspace scoping & process binding
- [x] Generalize `checkTmuxSession` in `pool.ts`
- [x] Implement driver factory with safe defaults
- [x] Update `agents.ts`, `mailbox.ts`, `focus.ts`
- [x] Author `herdr-driver.test.mjs`
- [x] Verify test suite passes

## Success Criteria

- `herdr-driver.test.mjs` passes with simulated JSON responses.
- `spawnAgent` succeeds under Herdr without `$TMUX` errors.
- Dead agent panes are correctly identified as stopped by heartbeat GC.
- Zero bare catch blocks (`grep -rnE "catch\s*\{\s*\}"` returns 0).
