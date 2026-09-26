# Swarm Refactor Validation Report — Terminal Manager Decomposition (Phases 7–8)

**Date:** 2026-09-26
**Scope:** Validation of the hooks/surface monolith split (Phase 7) and terminal-manager driver seam, including the compulsory mock-LLM fixture lane, strict full-suite harness, and live tmux + herdr validation lanes (Phase 8).
**Verdict:** PASS — with two herdr-driver bugs found by live validation, fixed red-green; one pre-existing test bug and one pre-existing spawn-seam gap disclosed.

---

## 1. Tier 1 — Strict full-suite harness

- Runner: background task `swarm-phase8-strict-harness` (explicit failure tracking, no `|| true` masking).
- Result: `TOTAL=129, FAILED=33` → `/tmp/swarm-phase8/ledger.txt`, exit 0 (ledger written).
- Fail-set comparison vs Phase-7 HEAD baseline (`/tmp/p7-failing.txt`, 30 entries):
  - 30 suites identical to HEAD (pre-existing reds — swarm-suite parity preserved).
  - +3 `ml:*` entries:
    - `ml:selftest` — fixture-count drift (85 expected, 87 on disk). **Fixed in this phase** (selftest counts updated; selftest now passes).
    - `ml:qualification-gate-human-discuss` (5/2) — re-run identical at HEAD. Pre-existing.
    - `ml:swarm-yml-pool` (5/4) — re-run identical at HEAD. Pre-existing; root cause below.

### Root cause: `ml:swarm-yml-pool` lane throw (pre-existing test bug)

Real in-lane error found in the pi session JSONL (`~/.pi/agent/sessions/<cwd-slug>/*.jsonl` toolResult text; mock-llm
transcripts only keep sanitized previews):

```
PREFLIGHT: tmux is not running. Reason: No $TMUX env var set — the swarm normally runs inside tmux. Session requested: pi-swarm-…
```

`checkTmuxSession` (`pool.ts:950-956`) requires `$TMUX` or `PI_SWARM_TMUX_OK` (short-circuits ok when
`PI_SWARM_TERMINAL_MANAGER=herdr`). The headless lane test never sets `TMUX`, so the lane cannot pass on a machine
without an ambient tmux env var. Fail-set is identical at HEAD → **pre-existing test bug, not a src regression**;
disclosed rather than fixed (test-file edit prohibition for this phase).

Secondary trap reproduced while chasing it: the lane cwd must be the seeded scratch dir **before** launching pi —
`readSwarmSettings(cwd = process.cwd())` (`session.ts:30`, since 9fe176a) reads `process.cwd()`, not `ctx.cwd`.
Launching from the repo root reads the repo's `.pi/swarm.yml` (all comments) → falls back to
DEFAULT_MODEL glm-5.1/zai-coding-cn → `provider_not_found`.

## 2. Tier 2 — Silent-catch audit

- `grep -rnE "catch\s*\{\s*\}" extensions/swarm/src` → **0 matches** (re-checked after the herdr fixes).
- Cleanup landed: the 2 real bare catches in `errorlog.ts` (~102, ~127) → `catch { expected("console_breadcrumb_never_throws"); }`
  (errorlog.ts itself stays self-silent by contract; the `expected(reason)` marker documents why silence is correct).
- Every remaining `.catch(() => …)` net sits on `trace()`/`traceTask()` choke-point-protected calls (failure already
  durable in `errors.jsonl` before the net runs), per the 2026-09-08 mandate.
- madge circular-dep check: **0 cycles** across `extensions/swarm/src/` + `extensions/swarm/index.ts` (Phase-7 result maintained).

## 3. Tier 3 — Mock-LLM fixture (compulsory)

- Fixture: `extensions/mock-llm/fixtures/terminal-manager-switch.jsonl` — 3 scripted root turns (Pattern 2: seeded
  world + single-actor root script):
  - T1: inspect driver + `swarm_list_agents` + `swarm_spawn_agent` (agent `tm-switch-worker`)
  - T2: `swarm_send_keys` (C-c) + `swarm_capture_agent_pane`
  - T3: settle/stop
- Selftest: counts updated 85→87 (`registered.config.models.length`, `listFixtureDiscovery`); list deepEqual updated.
  `node extensions/mock-llm/tests/selftest.test.mjs` → **PASS**.

### Fixture lane (headless)

TUI + mock-llm hangs (no tokens produced, no transcript written — 2 attempts documented); **all fixture lanes run
headless** with `pi -ne … -p` from now on.

Harness requirements (all validated):
1. Fresh scratch dir with seeded `.pi/swarm.yaml` (modelPool slot `terminal-manager-switch/mock-llm`, weight 10)
2. `cd $SCRATCH` before launch (`readSwarmSettings` reads `process.cwd()`)
3. Live test socket: `tmux -f /dev/null -S /tmp/tmux-fixture new-session -d` + `TMUX=/tmp/tmux-fixture,123,0`
4. `PI_SWARM_MINIMAL_PROTOCOL=0` (send_keys/capture are not in ROOT_TOOL_ALLOWLIST)
5. `MOCK_LLM_API_KEY=mock` + `PI_SWARM_DEFAULT_MODEL/PROVIDER` + `PI_SWARM_CHILD_ARGS="--approve -e <mock-llm> -e <swarm>"`

Result (final run `/tmp/p8tm-run6.sh`, scratch in `/tmp/p8-tmswitch-scratch.txt`):
- stdout: `Terminal-manager lane complete: spawn, injection, and capture all routed through the resolved TerminalDriver.` exit 0.
- Traces: `pool.spawn_pick` (slot resolved from seeded pool), `agent.identity.write`, `agent.spawn.ok`,
  `agent.spawn.orphan_watch_start`, `tool.executed` success for `swarm_list_agents` / `swarm_spawn_agent` /
  `swarm_send_keys` / `swarm_capture_agent_pane`.
- Worker pane **alive** in the fixture tmux server (`pi-swarm-p8tm-v5-ofbsua-6651d2:tm-switch-worker cmd=pi`).
- Capture snapshot `traces/tmux/tm-switch-worker-spawn-after.txt` contains the worker's pi startup screen (identity injection visible).
- Transcripts: 6 under `.pi/mock-llm/transcripts/terminal-manager-switch/` (root 3 turns + worker 3 turns, spawned child
  also ran mock-llm), final state done/stop.
- `errors.jsonl`: **empty**.

## 4. Tier 4 — Live tmux validation

Session `swarm-val-refactor` (dedicated tmux server, repo cwd, real model glm-5.1 via authenticated `ccs` lane).

| Action | Result |
|---|---|
| `/swarm init` | `swarm.init` traced; dirs verified; tmuxSession `pi-swarm-pi-graph-loop-30e92a` |
| Spawn worker `readme-summarizer` | preflight **correctly blocked** unauthenticated zai-coding-cn (auth.json only has `ccs`); retried `--model glm-5.1 --provider ccs` → worker pane alive (`…:readme-summarizer.0 cmd=pi`), identity injected + read by worker, orphan watchdog armed |
| `/swarm status` | 2/2 agents running healthy |
| Pane captures | `/tmp/phase8-tmux-validation.txt` (550 lines root), `/tmp/phase8-worker-pane.txt` (100 lines worker) |
| Repo trace | `agent.spawn.ok` count = 2 (fixture lane + live lane) |

**Gap (pre-existing, disclosed):** the spawned child uses default `childPiArgs()` = `--approve` only
(`session.ts:46-50`) → the worker pi has **no swarm tools** ("No mailbox tools available in this harness"), so the
root→worker send round-trip could not be completed live in this lane. The round-trip is covered by the fixture lane
and the r30/delivery suites. Setting `PI_SWARM_CHILD_ARGS` with `-e` flags (as the fixture harness does) is the
workaround for future live lanes.

## 5. Tier 5 — Live herdr validation

Environment: herdr 0.8.2 server; dedicated tab `w1:t6` (pane `w1:p8`, cwd `/tmp/p8herdr` with seeded swarm.yaml);
lane run inside the herdr pane with `HERDR_ENV=1 HERDR_PANE_ID=w1:p8 HERDR_WORKSPACE_ID=w1 PI_SWARM_TERMINAL_MANAGER=herdr`.

- Lane completed: `Terminal-manager lane complete: …` ; `pool.spawn_pick` + `agent.spawn.ok` + send_keys/capture executed.
- `checkTmuxSession` short-circuit for herdr verified (no `$TMUX` needed).

### Bugs found by live validation → FIXED (red-green)

Both bugs were invisible to the unit suite (mock accepted any args; mocked herdr 0.4.0 shapes) and only surfaced
against the real 0.8.2 CLI.

**BUG-A — `capturePane` sent unsupported `--workspace`**
- Symptom (live, durable): `/tmp/p8herdr/.pi/swarm/traces/errors.jsonl` → `herdr pane read … --workspace w1 failed (2): unknown option: --workspace`; capture snapshot empty.
- RED: `herdr pane read w1:p8 --source recent-unwrapped --lines 3 --workspace w1` → exit 2 `unknown option: --workspace` (`/tmp/p8-buga-repro2.mjs`; deterministic no-throw repro `/tmp/p8-buga-repro.mjs` showing the driver emitted the flag).
- FIX: dropped the flag (herdr pane ids are already workspace-qualified `wN:pM`); comment cites the live verification.
- GREEN: real-CLI capture returns exit 0 with content (`/tmp/p8-bug-verify.mjs`).

**BUG-B — `inspectProcess`/`isTargetAlive` broke on composite targets + wrong response shape**
- Symptom: tmux-composite targets (`pi-swarm-…:worker.0`, what agent records carry) → `pane_not_found`; and even valid
  pane ids parsed `result.process` while the real 0.8.2 payload is `result.process_info.foreground_processes[0]` →
  `piLike` always false (aliveness detection dead).
- RED: `herdr pane process-info --pane "pi-swarm-x:worker.0"` → exit 1 `pane_not_found`; live pi pane `w1:p1` reported `piLike:false` (`/tmp/p8-bugb-repro.mjs` + verify script).
- FIX: (1) composite targets are resolved through `pane list` by tab label (spawnAgent sets label = agent window id) via
  new `resolvePaneIdByLabel`; (2) response parsing reads `result.process_info.foreground_processes[0]` (older scalar
  shapes kept as fallbacks).
- GREEN: `isTargetAlive(w1:p1)` (pane running pi) → `true`, command `pi`, pid surfaced (`/tmp/p8-bug-verify2.mjs`).
- Suite: `herdr-driver.test.mjs` **16/16 PASS** after fix (was 14/2 — the 2 failures were the aliveness assertions
  invalidated by the parser change, then restored); `terminal-driver.test.mjs` 4/4 PASS.

### Regression parity re-check after herdr fixes

Fail-sets of touched-path neighbours compared against HEAD baselines (`/tmp/swarm-head-baseline/`): `send-keys-guard`,
`send-keys-dash-prompt`, `heartbeat-gc` — **identical to HEAD** (all pre-existing reds, no new failures). Cycle count
still 0; bare-catch grep still clean.

## 6. Disclosures & follow-ups

1. **`agents.ts spawnAgent` bypasses the driver seam (pre-existing).** `agents.ts` spawns via raw `tmux()` facade calls
   (`tmux.ts` routes to `tmuxDriver` unconditionally), so under `PI_SWARM_TERMINAL_MANAGER=herdr` the spawn path still
   creates a **tmux** session; `HerdrDriver.spawnAgent` (tab-create path) is only exercised by `herdr-driver.test.mjs`.
   Wiring `agents.ts` to `getTerminalDriver().spawnAgent` (and mapping the returned herdr pane id into agent records)
   is the named follow-up; until then herdr spawn parity is not live-verified end-to-end.
2. **`ml:swarm-yml-pool` headless TMUX test bug (pre-existing)** — see §1; disclosed, not fixed.
3. **TUI + mock-llm hang** — fixture lanes must run headless (`-p`); documented harness recipe in §3.
4. **`childPiArgs()` default `--approve`** — live child workers need `PI_SWARM_CHILD_ARGS` with `-e` extension flags to
   be useful; documented in §4.
5. Herdr-lane worker capture snapshot is empty (worker idled at zsh prompt at capture time); the tmux fixture lane
   provides the populated snapshot evidence.

## 7. Evidence index

| Artifact | Path |
|---|---|
| Strict ledger (Tier 1) | `/tmp/swarm-phase8/ledger.txt` |
| HEAD baseline logs | `/tmp/swarm-head-baseline/` |
| Phase-7 fail list | `/tmp/p7-failing.txt` |
| Fixture file | `extensions/mock-llm/fixtures/terminal-manager-switch.jsonl` |
| Fixture lane scratch | `/tmp/p8-tmswitch-scratch.txt` (→ `/tmp/p8tm-v5-ofbsua`) |
| Fixture lane harness | `/tmp/p8tm-run6.sh` |
| Fixture transcripts copy | `/tmp/p8-tmswitch-transcripts-final/` |
| Live tmux captures | `/tmp/phase8-tmux-validation.txt`, `/tmp/phase8-worker-pane.txt` |
| Herdr lane output/state | `/tmp/p8-herdr-out.txt`, `/tmp/p8herdr/.pi/swarm/` |
| Herdr bug repro/verify | `/tmp/p8-buga-repro.mjs`, `/tmp/p8-buga-repro2.mjs`, `/tmp/p8-bugb-repro.mjs`, `/tmp/p8-bug-verify.mjs`, `/tmp/p8-bug-verify2.mjs` |
| Evidence summary | `/tmp/p8-evidence-summary.txt` |
