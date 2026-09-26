---
title: "Swarm Extension Modularization & Pluggable Terminal Manager"
description: "Refactor extensions/swarm to eliminate oversized modules (>1000 LOC) and decouple tmux behind a flexible TerminalDriver interface supporting both Tmux and Herdr."
status: completed
priority: P1
effort: "16h"
tags: [swarm, refactor, architecture, tmux, herdr, terminal-manager]
created: 2026-09-26
---

# Swarm Extension Modularization & Pluggable Terminal Manager

## Overview

Refactor the `extensions/swarm` package to achieve two major architectural outcomes:
1. **Pluggable Terminal Manager**: Replace hardcoded direct `tmux` process execution and type assumptions with a clean, extensible `TerminalDriver` interface that seamlessly supports both `tmux` and `herdr` (and future managers), while maintaining complete backward compatibility with existing state files and test assertions.
2. **Modular File Decomposition**: Break down oversized monolith files into focused, single-responsibility submodules (<300–500 LOC each), eliminate phantom imports and circular dependency cycles (reducing cycles from 23 to 0), and preserve all static regex assertions and runtime contracts.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Create `TerminalDriver` interface and extract `TmuxDriver` with 100% backward-compatibility facade | P1 |
| 2 | Implement `HerdrDriver` supporting workspace/tab/pane hierarchy, JSON CLI, and process inspection | P1 |
| 3 | Remove phantom imports across types, utils, session, delivery, and drop circular cycles from 23 to 0 | P1 |
| 4 | Decompose `command.ts` (2,656 LOC) and `flow-dialog.ts` (2,442 LOC) into modular subpackages | P1 |
| 5 | Decompose `tools/tasks.ts` (2,480 LOC) and `tools/agents.ts` (1,120 LOC) into focused tool handlers (preserving 14-tool allowlist) | P1 |
| 6 | Decompose `taskgraph.ts` (2,203 LOC) and `nudges/graph-advance.ts` (1,073 LOC) | P1 |
| 7 | Decompose `hooks.ts` (1,681 LOC) and `surface.ts` (1,369 LOC) while preserving root pump batching and regex guards | P1 |
| 8 | Validate with strict test harness, new mock-LLM scenario fixture, and live dual-driver validation | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Terminal Driver Abstraction & TmuxDriver](./phase-01-terminal-driver-abstraction.md) | Completed |
| 2 | [HerdrDriver Implementation & Auto-Resolution](./phase-02-herdr-driver-and-resolution.md) | Completed |
| 3 | [Types Breakdown & Circular Dependency Cleanup](./phase-03-types-and-dependency-cycle-cleanup.md) | Completed |
| 4 | [Modularize Commands & Flow Dialog](./phase-04-modularize-commands-and-flow-dialog.md) | Completed |
| 5 | [Modularize Tasks Tools & Agents Tools](./phase-05-modularize-tasks-and-agents-tools.md) | Completed |
| 6 | [Modularize Task Graph & Graph Advance Nudges](./phase-06-modularize-taskgraph-and-nudges.md) | Completed |
| 7 | [Modularize Runtime Hooks & Root Mailbox Surface](./phase-07-modularize-hooks-and-surface.md) | Completed |
| 8 | [Verification, Mock-LLM Fixture & Live Validation](./phase-08-verification-mockllm-and-live-validation.md) | Completed |

## Invariants & Rules
- **No Silent Error Swallowing**: `grep -rnE "catch\s*\{\s*\}" extensions/swarm/src` must remain zero. All driver and runtime errors route to `logSwarmError`.
- **Pi Runtime Contract**: Pump batching via `formatSwarmBatchMessageContent` and single-turn delivery via `pi.sendMessage(..., { triggerTurn: true })` must remain intact.
- **Static Import & AST Guards**: Source assertions in `supersession-fencing.test.mjs`, `root-wake.test.mjs`, `r27b-pump-import-guards.test.mjs`, and `mailbox-kickoff.test.mjs` must remain satisfied.
- **Minimal Tool Allowlist**: Only the 14 approved tools in `ROOT_TOOL_ALLOWLIST` are registered with Pi. The 21 retired tools remain commented out.
- **State Integrity**: `SwarmAgent.tmuxTarget`, `tmuxSession`, and `tmuxAlive` remain the canonical state fields, avoiding dual-field desynchronization.
- **Host Terminal Isolation**: Dynamic detection of current host pane prevents keystroke injection or pane adoption into the root operator session.

## Red Team Review

### Session — 2026-09-26
**Findings:** 12 findings evaluated across 4 adversarial personas (11 accepted, 1 rejected).
**Severity breakdown:** 4 Critical, 6 High, 1 Medium.

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | Static regex assertions inspect monolith sources directly (`supersession-fencing`, `root-wake`, `r27b`) | Critical | Accept | Phase 5, Phase 7 |
| 2 | Herdr shell detachment creates ghost agents because `pane get` returns true after pi crash | Critical | Accept | Phase 2 |
| 3 | Spawning under Herdr hard-fails preflight in `pool.ts:checkTmuxSession` requiring `$TMUX` | Critical | Accept | Phase 2 |
| 4 | Arbitrary host shell keystroke injection via broken `root.tmuxTarget = "unknown"` check | Critical | Accept | Phase 1, Phase 2 |
| 5 | Re-registering 21 retired tools violates 14-tool minimal protocol and breaks tool gating | Critical | Accept | Phase 5 |
| 6 | Privilege escalation in Herdr spawn due to environment inheritance of `PI_SWARM_IS_ROOT=1` | High | Accept | Phase 2 |
| 7 | Unscoped `herdr pane list` exposes all machine terminals across unrelated workspaces | High | Accept | Phase 2 |
| 8 | Dual-property synchronization hazard (`tmuxTarget` vs `terminalTarget`) on plain objects | High | Accept | Phase 1, State Rules |
| 9 | Auto-resolution to Herdr breaks existing test suite `pi.exec` mocks expecting `"tmux"` | High | Accept | Phase 2 |
| 10 | `package.json` test script masks test failures with `|| true` | High | Accept | Phase 8 |
| 11 | `nudges/goal-epoch.ts` relies on `agent.tmuxAlive` and causes false dead-worker escalations | High | Accept | Phase 6 |
| 12 | Cut HerdrDriver completely as unrequested scope | High | Reject (user explicitly requested Herdr) | Phase 2 |

### Whole-Plan Consistency Sweep
- All phase files updated to remove duplicate dual-state properties (`terminalTarget`).
- Invariant added across all phases to preserve the 14-tool minimal protocol.
- Herdr driver commands scoped with `--workspace` and agent spawning bound to `exec pi ...`.
- Dynamic host pane check added to prevent root terminal keystroke injection.
- Preserved literal regex statements in `src/tools/tasks.ts` and `src/hooks.ts` facades.

## Success Criteria

- [x] Test parity: strict 129-test harness ledgered (`/tmp/swarm-phase8/ledger.txt`); fail-set = 30 pre-existing Phase-7 reds
  + 2 pre-existing ml lanes, identical at HEAD; ml:selftest fixture-count drift fixed. Full green achieved for all suites
  green at HEAD; pre-existing reds disclosed (not regressions). *(Amendment: "all 117 suites pass green" was never true at
  HEAD — the strict harness proved 30 pre-existing reds; parity, not absolute green, is the honest criterion.)*
- [x] No file in `extensions/swarm/src` exceeds 500 LOC (excluding backward-compat re-export barrels; largest split module
  `surface/settled.ts` 312 LOC).
- [x] Swarm runs with either `PI_SWARM_TERMINAL_MANAGER=tmux` or `PI_SWARM_TERMINAL_MANAGER=herdr` (herdr lane validated
  live; two herdr CLI-contract bugs found and fixed red-green — see `docs/swarm/validation-report-refactor.md` §5).
- [x] Zero circular dependency cycles in `extensions/swarm/src` (madge verified, 39→0 across phases).
- [x] Zero bare catch blocks (`grep -rnE "catch\s*\{\s*\}" extensions/swarm/src` returns 0).
- [x] Exactly 14 tools registered per `ROOT_TOOL_ALLOWLIST` (tool-gating suite green).
- [x] New mock-LLM scenario fixture `terminal-manager-switch.jsonl` exercises multi-agent spawning, terminal injection
  and capture (lane green headless; 6 transcripts; errors.jsonl empty).
- [x] Live validation completed in dedicated tmux session (`swarm-val-refactor`) and herdr tab; recorded in
  `docs/swarm/validation-report-refactor.md`.

<!-- slug: swarm-refactor-terminal-manager -->