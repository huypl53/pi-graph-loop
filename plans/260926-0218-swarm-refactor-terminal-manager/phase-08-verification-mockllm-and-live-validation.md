---
title: "Phase 8: Verification, Mock-LLM Fixture & Live Validation"
status: completed
---

# Phase 8: Verification, Mock-LLM Fixture & Live Validation

## Overview

Execute comprehensive validation across all 5 verification tiers: run the full 117-suite test harness with strict failure tracking (no masking via `|| true`), verify zero silent error catches, author and execute a compulsory mock-LLM end-to-end scenario fixture, and perform interactive validation in dedicated tmux and herdr sessions per `AGENTS.md`.

## Requirements

- [x] Run complete 129-test strict harness with explicit failure tracking:
  - Background task `swarm-phase8-strict-harness` (pid 121442) exit 0 → `/tmp/swarm-phase8/ledger.txt` (TOTAL=129, FAILED=33).
  - Fail-set diffed against Phase-7 baseline: 30 identical pre-existing reds (`/tmp/p7-failing.txt`) + 3 ml:* entries —
    `ml:selftest` (fixture-count drift, **fixed in this phase**), `ml:qualification-gate-human-discuss` and
    `ml:swarm-yml-pool` (both re-run identical at HEAD; swarm-yml-pool root cause = pre-existing test bug:
    `checkTmuxSession` requires `$TMUX`/`PI_SWARM_TMUX_OK`, the headless lane never sets TMUX — disclosed, not fixed).
- [x] Run silent error audit: `grep -rnE "catch\s*\{\s*\}" extensions/swarm/src` → 0 matches (re-checked after herdr fixes).
  - Tier 2 cleanup: 2 real bare catches in `errorlog.ts` (~102, ~127) → `catch { expected("console_breadcrumb_never_throws"); }`.
- [x] Author mock-LLM scenario fixture `extensions/mock-llm/fixtures/terminal-manager-switch.jsonl`:
  - 3 scripted root turns (Pattern 2: seeded world + single-actor root script): T1 list+spawn, T2 send_keys+capture, T3 settle/stop.
  - Selftest counts updated 85→87 (fixture discovery + registered models); selftest PASSES.
- [x] Run mock-LLM testbed lane headless (`pi -ne … --provider mock-llm --model terminal-manager-switch -p …`):
  - TUI + mock-llm hangs (no tokens) — headless `-p` used for all fixture lanes (2 failed TUI attempts documented).
  - Lane green: spawn/injection/capture all routed through the resolved TerminalDriver; worker pane alive (cmd=pi);
    trace `pool.spawn_pick` from seeded `.pi/swarm.yaml` pool slot; errors.jsonl EMPTY; 6 transcripts under
    `.pi/mock-llm/transcripts/terminal-manager-switch/` (root 3 + worker 3), final done/stop.
- [x] Live tmux validation in dedicated tmux session `swarm-val-refactor` (pi TUI, repo cwd):
  - /swarm init traced + dirs verified; worker `readme-summarizer` spawned (preflight correctly blocked
    unauthenticated zai-coding-cn; retried on authenticated glm-5.1/ccs); pane alive (cmd=pi); identity injected +
    read by worker; orphan watchdog armed; /swarm status 2/2 agents running healthy.
  - Pane captures: `/tmp/phase8-tmux-validation.txt`, `/tmp/phase8-worker-pane.txt`.
  - Gap disclosed: child worker defaults to `PI_SWARM_CHILD_ARGS="--approve"` (no `-e` args) → no swarm tools in
    child; live send round-trip not completable in this lane (covered by fixture lane + r30/delivery suites).
- [x] Live Herdr validation under herdr 0.8.2 (tab w1:t6, `PI_SWARM_TERMINAL_MANAGER=herdr`):
  - Lane completed end-to-end; driver resolved herdr (`checkTmuxSession` short-circuit); spawn/send_keys/capture executed.
  - **Bugs found by live validation and FIXED (red-green)** in `src/terminal/drivers/herdr.ts`:
    - BUG-A: `capturePane` passed `--workspace` to `herdr pane read` (unsupported in 0.8.2 → exit 2, every capture failed).
    - BUG-B: `inspectProcess` passed tmux-composite targets to `pane process-info` (→ pane_not_found) and parsed
      `result.process` instead of the real `result.process_info.foreground_processes[0]` shape → aliveness always false.
    - RED repros: live CLI probes (exit 2 "unknown option: --workspace"; exit 1 "pane_not_found") — `/tmp/p8-buga-repro2.mjs`, `/tmp/p8-bugb-repro.mjs`.
    - GREEN verify against real CLI: capture ok; `isTargetAlive` detects a live pi pane (pid surfaced).
    - `herdr-driver.test.mjs` 16/16 PASS after fix (was 14/2); `terminal-driver.test.mjs` 4/4 PASS; fail-set parity vs HEAD baselines re-verified on touched neighbors (send-keys-guard, dash-prompt, heartbeat-gc — identical).
- [x] Validation report: `docs/swarm/validation-report-refactor.md`.

## Related Code Files

- `extensions/swarm/src/terminal/drivers/herdr.ts` (BUG-A/BUG-B fixes)
- `extensions/swarm/src/errorlog.ts` (bare-catch → `expected(...)` markers)
- `extensions/mock-llm/fixtures/terminal-manager-switch.jsonl` (new fixture)
- `extensions/mock-llm/tests/selftest.test.mjs` (fixture-count/list updates — selftest-mandated)
- `docs/swarm/validation-report-refactor.md` (new report)

## Validation Evidence

- Strict ledger: `/tmp/swarm-phase8/ledger.txt` (TOTAL=129 FAILED=33; 33 = 30 pre-existing + 2 pre-existing ml + selftest-then-fixed)
- Baselines: `/tmp/swarm-head-baseline/` (HEAD), `/tmp/p7-failing.txt`, fail-multiset diff method from Phase 7.
- Fixture lane: scratch pointer `/tmp/p8-tmswitch-scratch.txt`; harness `/tmp/p8tm-run6.sh`; transcripts copied to `/tmp/p8-tmswitch-transcripts-final/`.
- Live lanes: `/tmp/phase8-tmux-validation.txt`, `/tmp/phase8-worker-pane.txt`, `/tmp/p8-herdr-out.txt`, `/tmp/p8-evidence-summary.txt`.
- Herdr bug repro/verify scripts: `/tmp/p8-buga-repro.mjs`, `/tmp/p8-buga-repro2.mjs`, `/tmp/p8-bugb-repro.mjs`, `/tmp/p8-bug-verify.mjs`, `/tmp/p8-bug-verify2.mjs`.
- madge cycles: 0; bare-catch grep: clean; errorlog tests pass.

## Notes / Disclosures

- `swarm-yml-pool` lane throw root-caused to a pre-existing test bug (missing `$TMUX` in headless lanes → preflight
  `PREFLIGHT: tmux is not running`); fail-set identical at HEAD → disclosed, not fixed (test-file edit prohibition).
- Secondary trap reproduced during that investigation: lane cwd must equal the seeded scratch dir before launch —
  `readSwarmSettings(cwd = process.cwd())` (session.ts:30); launching from the repo root reads repo `.pi/swarm.yml`
  (all comments) → DEFAULT_MODEL glm-5.1/zai-coding-cn → `provider_not_found`.
- Known gap (pre-existing, follow-up): `agents.ts spawnAgent` still issues raw `tmux()` facade calls (always
  tmuxDriver) instead of `getTerminalDriver().spawnAgent`; under `PI_SWARM_TERMINAL_MANAGER=herdr` spawn therefore
  still creates a tmux session. Driver-level spawn is validated by `herdr-driver.test.mjs`; wiring the seam is follow-up work.
- Herdr capture snapshot for the herdr lane worker is empty (worker pane idled at zsh prompt at capture time); the
  fixture lane (tmux driver) provides the populated spawn-after snapshot evidence.
