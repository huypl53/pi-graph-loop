---
title: "Phase 8: strict harness, terminal-manager-switch fixture, live tmux+herdr validation; 2 herdr bugs fixed red-green"
date: 2026-09-26
summary: Strict 129-test ledger parity vs HEAD; new mock-LLM fixture lane green headless; live tmux + herdr lanes; found+fixed herdr capturePane --workspace and inspectProcess shape/resolve bugs; report docs/swarm/validation-report-refactor.md
---

# Phase 8: strict harness, terminal-manager-switch fixture, live tmux+herdr validation; 2 herdr bugs fixed red-green

## What happened
Phase 8 of plans/260926-0218-swarm-refactor-terminal-manager completed.

- Tier 1 strict harness: background task swarm-phase8-strict-harness → /tmp/swarm-phase8/ledger.txt (TOTAL=129 FAILED=33). Fail-set = 30 pre-existing Phase-7 reds + ml:selftest (fixture-count drift, fixed: counts 85→87, selftest PASS) + ml:qualification-gate-human-discuss + ml:swarm-yml-pool (both identical at HEAD).
- swarm-yml-pool root cause (pre-existing test bug, disclosed): headless lane never sets $TMUX → checkTmuxSession (pool.ts:950) throws "PREFLIGHT: tmux is not running". Secondary trap reproduced: lane cwd must equal seeded scratch before pi launch — readSwarmSettings reads process.cwd() (session.ts:30); repo .pi/swarm.yml is all comments → DEFAULT_MODEL glm-5.1/zai-coding-cn → provider_not_found.
- Tier 2 silent-catch audit: 2 real bare catches in errorlog.ts → expected("console_breadcrumb_never_throws"); grep now 0.
- Tier 3 fixture: extensions/mock-llm/fixtures/terminal-manager-switch.jsonl (3 turns, Pattern 2). Lane headless (TUI+mock-llm hangs; use -p always): fresh scratch + seeded .pi/swarm.yaml pool, cd scratch, test tmux socket TMUX=/tmp/tmux-fixture,123,0, PI_SWARM_MINIMAL_PROTOCOL=0, MOCK_LLM_API_KEY=mock, PI_SWARM_CHILD_ARGS with -e flags. Lane green: spawn ok, worker pane alive cmd=pi, send_keys/capture success, pool.spawn_pick from yml, errors.jsonl EMPTY, 6 transcripts.
- Tier 4 live tmux (session swarm-val-refactor): /swarm init traced; readme-summarizer spawned — preflight correctly blocked unauthenticated zai-coding-cn, retried glm-5.1/ccs; identity injected+read; orphan watchdog armed; status 2/2 healthy. Gap: default childPiArgs="--approve" → child has no swarm tools (no -e flags) → live round-trip not completable (disclosed).
- Tier 5 live herdr (0.8.2, tab w1:t6): lane completed; TWO BUGS found and fixed red-green in src/terminal/drivers/herdr.ts:
  BUG-A capturePane passed --workspace to `herdr pane read` (unsupported → exit 2 every capture). Fixed: dropped flag.
  BUG-B inspectProcess passed tmux-composite targets ("sess:win.0") to `pane process-info` (pane_not_found) and parsed result.process instead of result.process_info.foreground_processes[0] → piLike always false. Fixed: resolvePaneIdByLabel via pane list + correct shape parsing.
  RED: live CLI probes (exit 2 / exit 1). GREEN: /tmp/p8-bug-verify2.mjs isTargetAlive(w1:p1 running pi)=true with pid. herdr-driver.test.mjs 16/16 (was 14/2), terminal-driver 4/4. Neighbor fail-sets identical to HEAD baselines (send-keys-guard, dash-prompt, heartbeat-gc). Cycles 0; bare-catch grep 0.
## Decisions
- Disclosed (not fixed): ml:swarm-yml-pool TMUX test bug (pre-existing, identical at HEAD); agents.ts spawnAgent still raw tmux() facade — driver-seam wiring named follow-up; TUI+mock-llm hang → headless -p lanes mandatory.
- plan.md Success Criteria amended: "all 117 suites green" was never true at HEAD; parity is the honest criterion (30 pre-existing reds proven by strict harness).
## Impact
- HerdrDriver now actually works against herdr 0.8.2 (captures + aliveness were silently broken).
- Report: docs/swarm/validation-report-refactor.md; phase-08 file completed; plan.md phase 8 Completed; CHANGELOG Unreleased (Fixed + Tested).
## Next steps
- Follow-up: wire agents.ts spawnAgent to getTerminalDriver().spawnAgent (map herdr pane ids into agent records); fix swarm-yml-pool headless TMUX test bug; consider childPiArgs -e defaults.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
