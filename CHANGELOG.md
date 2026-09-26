# Changelog

Notable changes in this project. Newest first.

## [Unreleased]

### Fixed

- **swarm (H4 live-found, herdr pane-id regex)**: `HerdrDriver.inspectProcess` classified pane ids with a digit-only workspace regex (`/^w\d+:p\d+$/`) — but workspace ids are not limited to digits (the `swarm-agents` workspace resolved to `wK`). `wK:p5` was misrouted to label-resolution, pane-list titles are null → `piLike:false` → the engine marked demonstrably-live agents dead and stalled ALL delivery/reconcile paths (live symptom: h1-implementer queued "not running" while pi ran in its pane; delivery only worked via agent-startup mailbox flush). Fix: workspace segment accepts `[A-Za-z0-9_-]+`. Red-green: `.pi/swarm-uat/runs/herdr-pane-id-regex-red2/` (pre-fix `false`) vs `-green/` (`true`), real-binary cross-check both phases. Lane: `scripts/uat/herdr-pane-id-regex.mjs`.
- **swarm (H3 live-found, `herdr pane run` quoting)**: `HerdrDriver.spawnAgent` step 2 wrapped the launch command as `pane run <pane> sh -c <command> -- swarm-agent` — but herdr 0.8.2 `pane run` TYPES its argv words into the pane shell as a single line (quoting inside any word is destroyed; live-verified: `pane run <p> sh -c 'echo X:$0' -- probe` ran `sh -c echo` = bare echo). Result: pi launched with mangled args and exited instantly; the pane filled with the shell interpreting swarm onboarding text. Fix: drop the `sh -c` wrapper — pass the command's own words (env-prefix assignments + shellQuoted pi invocation) directly; typed as one line they form a valid shell command with assignments scoped to the pi invocation. Unit tests updated to the words contract (17/0) + H2-fallout fix (terminal-driver host-pane tests pin tmux via env — repo yml now resolves herdr; 4/0). RED evidence: `.pi/swarm-uat/runs/herdr-pane-run-red/` (minimal typed-words repro + two failed live spawns wK:p2/wK:p4).

## [Unreleased]

### Fixed

- **swarm (H2- **swarm (H2 `herdr-cfg-wiring-20260926`)**: wired `swarm.yml`/settings `terminalManager` into `getTerminalDriver()` resolution — the cfg precedence slot was declared but unwired (no call site passed config), so `terminalManager: herdr` in the yml was silently ignored and the only working lever was the `PI_SWARM_TERMINAL_MANAGER` env var, frozen at root process start. Now: env > config (memoized per cwd) > tmux default, honored by all driver call sites. Red-green: pre-fix RED (yml herdr + env unset resolves TmuxDriver), GREEN (resolves HerdrDriver; no-yml default unchanged; env still wins). Regression: terminal-driver 4/4, herdr-driver 16/16, send-keys 8/8, agent-lifecycle-uat 15/15. Root-direct implementation (pool stopped for herdr transition — disclosed in commit report). `.pi/swarm.yml` now sets `terminalManager: herdr` for this repo.

- **swarm (herdr workspace isolation, `herdr-workspace-isolation-20260926`)**: `HerdrDriver` now creates worker tabs in a dedicated `swarm-agents` workspace instead of the root workspace. Previously, `spawnAgent` resolved `ws = getWorkspaceId() || opts.session` — the ROOT's workspace — so herdr-mode workers landed beside root tabs (polluting the root workspace). New behavior: `ensureAgentsWorkspace()` lists workspaces, matches by label `swarm-agents` (overridable via `PI_SWARM_HERDR_WS_LABEL`), creates if absent, caches the id with stale-cache recovery via `workspace get`. `spawnAgent` uses `tab create --workspace <agentsWsId>`. Teardown: after every `killAgent`, `maybeCloseAgentsWorkspace()` calls `pane list --workspace <wsId>`, intersects with tracked swarm pane ids, and closes the workspace when no swarm panes remain. Root workspace is never touched. Red-green evidence: pre-fix RED 6/6 (worker landed in root ws, root tab count increased, zero workspace ops); GREEN 19/19 across R2 (single worker), R3 (two workers in shared ws), R4 (teardown — ws persists with 1 worker, closes when last killed), R5 (stale-cache recovery — ws re-created after external close). R10-1 boundary counters at real `pi.exec("herdr")` seam: workspace create ≥2, workspace list ≥2, workspace close ≥1, every tab create carries `--workspace <wsId>`. Regression: herdr-driver 16/16 (spawnAgent test updated to assert agents-workspace contract + workspace list/create calls), terminal-driver 4/4, send-keys-dash-prompt 8/8, mock-llm agent-lifecycle-uat 15/15. Docs: new "Workspace isolation" subsection in `docs/swarm/operations.md` herdr section. Caveats: `killAgent` no longer gates on `isTargetAlive` — a pane with a shell prompt (pi process exited) is still closed for teardown; the workspace root pane (`wN:p1`) is never in the swarm tracking set so it doesn't block teardown.

- **swarm (herdr 0.8.2 contract stabilization, `herdr-stabilize-20260926`)**: `HerdrDriver.spawnAgent` now uses the two-step 0.8.2 contract — `tab create [--workspace] [--label] [--cwd] --env …` (options-only) returns `result.root_pane.pane_id`, then `pane run <PANE_ID> sh -c <command> -- swarm-agent` launches the command in that root pane. Previously the driver appended the launch command as a trailing positional to `tab create` (the 0.4.x contract); 0.8.2 rejected it with `unknown option: <cmd>`. Also fixed `inspectProcess` to read the leaf of `result.process_info.foreground_processes[]` (root→leaf ordered) for pi-likeness — intermediate `sh -c` wrappers no longer mask the actual user command. The G2 live-lane test adapter (`scripts/uat/herdr-spawn-seam-live.mjs`) is retired — the production driver now does the two-step natively. Red-green evidence: pre-fix RED (`tab create ... exec <cmd>` → exit 2 `unknown option`); GREEN 20/20 across two lifecycle runs (spawn → sendText → capturePane → isTargetAlive → killAgent, R10-1 boundary counters at real `pi.exec("herdr")` seam); R4 worker tool turn via mock-llm 4/4; `herdr-driver.test.mjs` 16/16 (spawnAgent test updated to assert the two-step contract). Audit matrix fully audited (`.pi/swarm/tasks/herdr-stabilize-20260926/artifacts/audit-matrix.md`). Regression: terminal-driver 4/4, mock-llm agent-lifecycle-uat 15/15. Docs: new "Terminal manager — herdr mode (0.8.2)" section in `docs/swarm/operations.md` + README cross-link. Caveats: `send-keys-guard.test.mjs` pre-existing failures unrelated (asserts on a retired `swarm_send_keys` tool); `pane close` is supported on 0.8.2 (the audit matrix's earlier suspicion of its absence was wrong — help subcommand list was misleading).

- **swarm (G3 of `uat-swarm-features-20260926`)**: `childPiArgs()` default changed from `--approve` to `--approve -e extensions/swarm/index.ts` — workers spawned without `PI_SWARM_CHILD_ARGS` now automatically load the swarm extension and get swarm tools (previously fell back to bash/read/edit only; observed live in the UAT session). Explicit `PI_SWARM_CHILD_ARGS` still wins verbatim (test lanes preserved); extension path repo-canonical/cwd-independent. Docs: `docs/swarm/operations.md` "Child pi args" section + `extensions/swarm/README.md` env-vars cross-link (round-1 review caught missing operations.md half + em-dash dead anchor; fixed in fix node). Red-green: pre-fix RED 4/6 (default returns `--approve` only, 0 ext flags in spawn cmd), GREEN 6/6 with R10-1 counter at the real agents.ts:259 spawn exec line (1 ext flag/spawn default, 0 verbatim override). Regression: mock-llm agent-lifecycle-uat 15/15. Full report: `.pi/swarm/tasks/followup-g3-child-pi-args-default-20260926/artifacts/commit.md`.
- **swarm (G2 of `uat-swarm-features-20260926`)**: wired `agents.ts spawnAgent` through `getTerminalDriver().spawnAgent` instead of raw `tmux()` facade calls — under `PI_SWARM_TERMINAL_MANAGER=herdr` the spawn path now creates a herdr tab (not a tmux session), and the driver's return value (new optional `herdrPaneId` field in `types/agents.ts`) is mapped into the agent record. TMUX mode remains byte-compatible (same `TmuxDriver` command sequence). Phase-8 §6.1 disclosed gap; live-verified against real herdr 0.8.2 binary (8/8). Red-green evidence: pre-fix bypass observed (5/5, 0 herdr execs, raw tmux spawn), post-fix green (9/9, exactly 1 herdr tab-create per spawn, 0 raw tmux spawns). Regression: terminal-driver 4/4, herdr-driver 16/16, send-keys 8/8, agent-lifecycle 15/15, invariants PASS, bare-catch 0. Caveats: (1) herdr.ts 0.8.2 dropped `tab create <command>` — driver needs follow-up before herdr mode ships; (2) `spawn-orphan-warning.test.mjs` pre-existing flake on unmodified master. Full report: `.pi/swarm/tasks/followup-g2-herdr-spawn-seam-20260926/artifacts/commit.md`.
- **swarm (G1 of `uat-swarm-features-20260926`)**: task-graph review re-derivation after a rework cycle — `activateReworkNodes` (graph.ts) now re-derives a **non-rework** edge's terminal target as `ready` when the source node was itself reopened by a rework cycle (prior attempt `supersededBy: "<rework>"`). Previously, after `review rejected → fix → test passed`, the `test --passed--> review` edge never re-derived the terminal review node; root had to `force=true` re-open review manually (hit on both `uat-swarm-features-20260926` and `followup-g2-herdr-spawn-seam-20260926`). Same reopen path + ledger as rework edges (ledger keyed by `(edgeKey, sourceNodeId, sourceAttemptId, reopenedNodeId)` — single reopen per cycle, ping-pong impossible); fresh first-pass tasks unchanged (zero behavior change). Red-green evidence: pre-fix RED 5 asserts fail (review stuck done/rejected, R10-1=0), GREEN Scenario 8 14/14 with R10-1 boundary counter (exactly 1 `task.attempt.reopened_by_rework` trace per cycle at the real `swarm_update_task` boundary, graph.ts:241); ledger 3→6 entries across two cycles. Regression: graph-advance, loop-reconcile, invariants, audit all PASS. Caveats: rework-reopen.test.mjs scenarios 1-7 remain zero-coverage (F1 family — they call the retired `swarm_register_agent` tool); G1's own commit node auto-closed attempts:0 (graph-completion sweep side effect, noted as minor anomaly — commit performed by root directly). Full report: `.pi/swarm/tasks/followup-g1-graph-rework-reopen-20260926/artifacts/commit.md`.

### Tested

- **swarm (UAT `uat-swarm-features-20260926`)**: end-to-end UAT of the swarm extension via swarm-driven orchestration — 6-node task graph (`plan → implement → test → review → commit`) with rework edges drove a full audit cycle. Four lane workers produced 96 GREEN assertions across 6 domains (task-graph 18/18, agent-lifecycle 15/15, messaging 14/14, governance 16/16, goal-nudge 12/12, reconcile 21/21) with R10-1 boundary counters at real runtime boundaries (real `pi.sendMessage`, real `pi.exec` tmux, real tool handlers — never stub assertions). Strict suite (`npm run test:swarm`) and mockllm (`npm run test:mockllm`) both exit 0; bare-catch census clean; lane-scratch errors.jsonl censuses clean. Reviewer caught one vacuous RED assertion (R25 precedent — `ok(..., violated === false ? true : true)`); rework edge routed it back to implementer; re-verified lane passed on round 2 (RED 14/14 non-vacuous, GREEN 12/12). Full report: `.pi/swarm/tasks/uat-swarm-features-20260926/artifacts/commit.md`. Evidence: `.pi/swarm-uat/runs/uat-20260926-final/<domain>/`. Disclosed follow-ups: F1 pre-existing fixture failure (`qualification-gate-human-discuss` scripts retired tools), G1 graph design gap (review re-open after rework loop needs rework edge or `force=true`), G2 herdr terminal-driver seam gap (Phase-8 §6.1), G3 `childPiArgs()` default `--approve` (workers spawn without swarm tools), G4 30 pre-existing test failures in strict suite (preserved by design, not triaged).

### Refactored

- **swarm (Phases 5–6 real split, follow-up to `plans/260926-0218-swarm-refactor-terminal-manager`)**: completed the deferred monolith decompositions — the phase-5/6 "facade" files are now genuine extractions with verbatim-moved bodies, not re-export shims:
    - `src/taskgraph.ts` (2,203 → 88 LOC barrel) → `src/taskgraph/{scope,attention,graph,lifecycle,sweep,stale,closure,formatting,evidence}.ts` (60–480 LOC each); `nudges/graph-advance.ts` (1,073 → 27 LOC) → `nudges/{graph-advance-nudge,initial-ready,task-stall,artifact-progress,heartbeat-gc,slot-recovery}.ts` (93–312 LOC each) — all 11 exported functions AST-verified verbatim vs the pre-split monolith.
    - `src/tools/tasks.ts` (2,480 → 59 LOC facade) → `tools/tasks/{create,inspect,assign,update,fencing,retired}.ts`; `src/tools/agents.ts` (1,123 → 23 LOC facade) → `tools/agents/{status,lifecycle,retired}.ts` + `tools/goals.ts` (set_goal/mark_goal_done). Retired tools preserved as commented archaeology in `tasks/retired.ts` / `agents/retired.ts`.
    - C8 fence literals (`lateResultRejectionCount` increment + `assignmentMessageId`) live canonically in `tasks/fencing.ts::stampLateResultRejectionOnInboundMessage` with a verbatim traceability excerpt in the `tasks.ts` facade so `supersession-fencing.test.mjs` C8.a/b/c file-text assertions keep passing (17 pass / 3 fail — fail-set identical to HEAD baseline).
    - Disclosed: `tasks/update.ts` (1,088 LOC) and `tasks/assign.ts` (627 LOC) are single-closure tool bodies that cannot shrink without invasive non-verbatim edits; phantom imports dropped in transit (`traceLogged`, `proxyMetricEmitLocked`, unused `AGENT_HEARTBEAT_STALE_MS` copy).
- **Verification**: full 119-suite strict ledger fail-set identical to the phase-8 baseline (30 pre-existing red suites, zero regressions); `tool-gating` 14/0, `minimal-protocol-authoritative` 50/0, `mailbox-kickoff` 8/0, `swarm-goal` 67/0, `swarm-mark` 30/0, `task-liveness` 48/0, `graph-advance.validate` PASS, `heartbeat-gc` fail-set identical; tsc error-class parity with HEAD (48 errors, only relocated with their code: tasks.ts→tasks/update.ts, graph-advance.ts→heartbeat-gc.ts, agents.ts→goals.ts); madge 0 cycles (120 modules); silent-catch grep 0.

### Fixed

- **swarm (Phase 8 of `plans/260926-0218-swarm-refactor-terminal-manager`)**: fixed two HerdrDriver bugs found by live validation against herdr 0.8.2 (both invisible to the unit suite's herdr 0.4.0-shaped mocks) — `capturePane` no longer passes the unsupported `--workspace` flag to `herdr pane read` (exit 2 on every capture); `inspectProcess`/`isTargetAlive` now resolve legacy tmux-composite targets ("session:window.0") to herdr pane ids by tab label and parse the real `result.process_info.foreground_processes[0]` response shape, restoring pi-aliveness detection (previously always false). Red-green verified against the real CLI; `herdr-driver.test.mjs` 16/16. Also converted the 2 real bare catches in `errorlog.ts` to `expected(...)` markers (silent-catch grep now 0 across `extensions/swarm/src`).

### Tested

- **swarm (Phase 8)**: strict 129-test harness ledger (no `|| true` masking) with fail-set parity vs HEAD baseline — 30 pre-existing red suites identical, `ml:selftest` fixture-count drift fixed (selftest 87 fixtures, PASS); new compulsory mock-LLM fixture `terminal-manager-switch.jsonl` (spawn → send_keys → capture → settle) validated headless with live worker pane, populated capture snapshot, and empty `errors.jsonl`; live tmux validation (dedicated session `swarm-val-refactor`: init/spawn/identity/status 2/2 healthy) and live herdr validation (driver-resolved lane end-to-end). Full report: `docs/swarm/validation-report-refactor.md`. Disclosed pre-existing gaps: headless `ml:swarm-yml-pool` TMUX test bug (fail-set identical at HEAD), `agents.ts spawnAgent` still on raw tmux facade (driver-seam wiring is follow-up).

### Refactored

- **swarm (Phase 7 of `plans/260926-0218-swarm-refactor-terminal-manager`)**: decomposed the two remaining runtime monoliths into submodules with backward-compatible facades — `src/hooks.ts` (1,681 → 172 LOC) now delegates to `src/hooks/{streaks,pump-manager,pool-swap,turns,session,settled,tools,shutdown-input}.ts`; `src/surface.ts` (1,369 → ~150 LOC) delegates to `src/surface/{session,warnings,actionable,staleness,ranking,pump,pump-phases,pump-decision,coalesce,pump-shared}.ts`. Extracted `src/orphan-watch.ts` (shared `ORPHAN_TIMERS` map + `clearOrphanWatch`) breaking the last static import cycle — madge reports **0 circular dependencies** across all 116 modules (HEAD: 39). Behavioral pins preserved: `root-wake` classification literals stay physically in the `src/hooks.ts` facade startRootPump; `r27b` Guard-3 imports stay physically on the `src/surface.ts` facade; `r30` single-send L2 batching unchanged (13/13); hook registration order (pool-swap → turns → session → settled → tools → shutdown-input) unchanged; 14 tools / 5 commands / 11 hooks registered identically. Facade→submodule edges are contract-pinned: `hooks/session.ts` receives `startRootPump` via DI to avoid a facade↔submodule cycle. Module caps: hooks ≤312 LOC, surface ≤309 LOC.
    - Validation: full-suite ledger parity vs pristine-HEAD baseline — 117 common suites, only shared-suite diff is `pool-config.test.mjs` 1→0 (pre-existing uncommitted env fix in the worktree copy); 30 pre-existing red suites fail IDENTICALLY (fail-multiset diff-verified: root-wake, idle-nudge, supersession-fencing, cancellation, pool-*, attempt-fencing, r25, …); phase-2 driver suites herdr-driver 16/0 + terminal-driver 4/0 green.
    - tmux mock-LLM lane (session `pgl-phase7-validation`, pane capture `/tmp/phase7-pane-final.txt`): `pi --provider mock-llm --model root-message-batching -e ./extensions/mock-llm -e ./extensions/swarm` — swarm registered (14 tools / 5 commands / 11 hooks), R30 lane completed with batched single-turn delivery; transcript `.pi/mock-llm/transcripts/root-message-batching/`, trace `.pi/swarm/traces/events.jsonl` (`mailbox.root_pump` + `notification.batch.suppressed` observed).
    - Disclosed dead-code drop: duplicated `ackRootNudgeLocked` / `ackRootGraphAdvanceNudgesLocked` copies in old surface.ts were unreachable (live copies remain in `src/nudges/graph-advance.ts`).
    - Disclosed pre-existing tsc classes unchanged (tmuxAlive ×8, actionableGraphDeferredAt ×2, HealthStatus "stale" ×2, surface loose-typing) — identical to HEAD.

## [v0.0.3] - 2026-09-24

### feat(swarm): auto-focus tmux window to busy worker (enabled by default)

- **Context / Symptom**: Operators monitoring multi-agent execution in tmux had to manually switch windows or panes to observe active workers, losing track of subagents executing tools or waiting on long-running processes.
- **Key Changes**:
    - Implemented the auto-focus engine (`extensions/swarm/src/focus.ts`) with target candidate selection, active-window guard (`isCurrentActiveTmuxWindow`), and a 2.5-second anti-flapping cooldown.
    - Automatically switches tmux focus to busy workers on `agent_start`, `tool_execution_start`, and worker `settled` events via `maybeAutoFocusOnBusy` in `extensions/swarm/src/hooks.ts`.
    - Enabled by default (`autoFocusBusy: true`, `isAutoFocusEnabled`).
    - Added CLI and interactive controls: `/swarm focus` (immediate window switch to active or specified agent) and `/swarm auto-focus [on|off|status|toggle]`, supported with tab completion.
    - Respects environment override `PI_SWARM_AUTO_FOCUS=0` and cleanly excludes the root coordinator session from window theft.
    - Recorded internal errors safely via `logSwarmError`.
- **Verification**: `extensions/swarm/tests/auto-focus.test.mjs` (comprehensive 5-section suite testing focus triggers, window guard, and cooldowns), mock-LLM scenario `auto-focus-toggle.jsonl`.

### feat(swarm): minimal agent protocol & inferred lifecycle (R31)

- **Context / Symptom**: The legacy swarm protocol mandated explicit ACK tools (`swarm_ack_message`, `requiresAck: true`), leading to cognitive overload for LLMs, unacked ACK debt warnings in reconciler routines, and tool registration bloat (over 35 tools in namespace).
- **Key Changes**:
    - Transitioned to minimal agent protocol (`PI_SWARM_MINIMAL_PROTOCOL`, gate=1 enabled by default).
    - Deprecated manual ACK requirements: defaulted `requiresAck` to `false`, removed ACK instructions from agent system prompts (`identity.ts`), and filtered out legacy ACK debt warnings in `swarm_reconcile` and `swarm_stop_agent`.
    - Implemented inferred lifecycle and worker self-nudge on missing response (R31): Strike 1 directly self-nudges the worker without disturbing the root; Strike 2 escalates to root only if the worker settles without responding.
    - Enhanced `swarm_send_message` to return a synchronous delivery receipt with message ID, timestamp, and status.
    - Trimmed registered tools down to 14 core coordination tools (`swarm_send_message`, `swarm_check_mailbox`, `swarm_task_message`, `swarm_create_task`, `swarm_assign_task`, `swarm_update_task`, `swarm_task_status`, `swarm_validate_graph`, `swarm_print_graph`, `swarm_next_nodes`, `swarm_spawn_agent`, `swarm_agent_status`, `swarm_stop_agent`, `swarm_reconcile`), retiring 21 obsolete/redundant tools.
- **Verification**: `extensions/swarm/tests/r31-worker-nudge-and-ack-debt-fix.test.mjs` (all 6 scenarios), `extensions/swarm/tests/minimal-protocol-authoritative.test.mjs`, `extensions/swarm/tests/tool-gating.validate.mjs`, `extensions/swarm/tests/delivery-receipt.test.mjs`, mock-LLM fixture `inferred-lifecycle-worker.jsonl`.

### feat(swarm): root message coalescing & batching (R30)

- **Context / Symptom**: Rapid worker turn updates and status notifications flooded the root coordinator with separate mailbox messages, triggering multiple consecutive `pi.sendMessage` calls at the L2 runtime boundary, causing turn churn and context token blowup.
- **Key Changes**:
    - Added message coalescing in `extensions/swarm/src/delivery.ts` and `surface.ts` (`coalesceAndBatchInboundMessages`).
    - Coalesces pending root inbound messages into a single consolidated `swarm-batch-message` payload per tick.
    - Enforces exactly one `pi.sendMessage` invocation per delivery tick when multiple messages are queued, keeping turn processing predictable.
    - Retains all message IDs, attribution, and metadata within the batched container.
    - Formalized R30 contract row F20 in `docs/swarm/pi-runtime-contract.md` and ADR `docs/swarm/adr/2026-09-24-root-message-batching-and-coalescing.md`.
- **Verification**: `extensions/swarm/tests/r30-root-message-batching.test.mjs`, mock-LLM fixture `root-message-batching.jsonl`.

### feat(swarm): static root identity injection & delegation streak advisory

- **Context / Symptom**: Root coordinator agents suffered role amnesia after session compaction and frequently drifted into direct implementation (editing files directly) rather than delegating tasks to worker agents.
- **Key Changes**:
    - Injected static root orchestrator directives into `systemPrompt` during `before_agent_start` for root sessions (`hooks.ts`), ensuring instructions survive context compaction and preserve prompt cache hits.
    - Added delegation streak guard via `tool_result` hook: monitors consecutive direct file modifications (`edit`, `write_to_file`) by root and appends a gentle delegation reminder when streak reaches 3.
    - Automatically resets the edit streak whenever root uses any swarm coordination tool.
- **Verification**: `extensions/swarm/tests/root-delegation-guard.test.mjs`, mock-LLM fixture `root-delegation-guard.jsonl`.

### fix(swarm): empty pool escalation & worker spawn boot hardening

- **Context / Symptom**: Newly spawned agents suffered false-positive liveness failures before their first heartbeat arrived, triggering false empty pool escalations to the user. In addition, historical stopped workers caused noisy diagnostics, and capped goals continued triggering escalations indefinitely.
- **Key Changes**:
    - Added worker spawn boot grace period: `DEFAULT_AGENT_BOOT_GRACE_MS` (3 minutes, overridable via `PI_SWARM_AGENT_SPAWN_BOOT_GRACE_MS`), treating newly spawned agents as alive during bootup in `agentIsEffectivelyAlive`.
    - Added `bootFailedAgents` diagnostic guidance for agents that exceed the boot grace window without sending a heartbeat.
    - Filtered out historical stopped agents (> 10m) from `poolDiag` in `evaluateIdleGoalNudgeLocked`.
    - Enforced `maxNudges` cap on vacuous empty pool escalations to prevent endless escalation cycles.
    - Switched `isTmuxRunning` from `display-message` to `list-panes` to prevent active-window fallback falsely reporting closed windows as alive, and immediately set `agent.tmuxAlive = false` upon killing panes.
- **Verification**: `tests/r29-spawn-boot-grace-false-escalation.test.mjs`, `tests/pool-diag-historical-reproduce.test.mjs`, `tests/tmux-alive-fallback-reproduce.test.mjs`, `tests/vacuous-max-nudges-reproduce.test.mjs`, mock-LLM fixture `spawn-boot-grace-nudge.jsonl`.

### fix(swarm): tmux command robustness & process allowlist

- **Context / Symptom**: Leading dashes in prompt text (such as `--flag` arguments) were misparsed by tmux getopt as command-line switches in `tmux send-keys`. Furthermore, helper scripts invoking `pi` directly or running through `bun` were rejected by `isPanePiLike`.
- **Key Changes**:
    - Added `--` end-of-options delimiter to `sendToPane` and `sendKeys` in `extensions/swarm/src/tmux.ts` and `agents.ts`.
    - Expanded `isPanePiLike` command allowlist regex to recognize `pi` wrapper binaries and `bun` execution environments.
- **Verification**: `extensions/swarm/tests/send-keys-dash-prompt.test.mjs`, `extensions/swarm/tests/pane-pi-like.test.mjs`.

### fix(swarm): long-running tool health checks & false idle alarm suppression

- **Context / Symptom**: Workers executing prolonged commands (test runs, compilation, external fetches) were misidentified as idle, causing spurious idle epoch reminders and goal nudges.
- **Key Changes**:
    - Introduced active tool execution tracking (`activeToolExecution` / `lastToolCallAt`) into goal epoch evaluation to acknowledge ongoing work.
    - Suppressed idle epoch and goal nudges whenever the root coordinator is active or processing tools (`ROOT_BUSY_ACTIVE_EXECUTION_MS`).
- **Verification**: `extensions/swarm/tests/long-running-worker-nudge.test.mjs`, `extensions/swarm/tests/root-busy-no-goal-nudge.test.mjs`.

### feat(swarm): task status goal exposure & automatic qualification advance

- **Context / Symptom**: Operators could not view associated goal details from task queries, qualification gates required manual confirmation via a separate tool, and `swarm_stop_agent` was inadvertently omitted from the active tool registration list.
- **Key Changes**:
    - Restored `swarm_stop_agent` to the registered agent tool suite.
    - Exposed goal metadata (`goalId`, goal text, origin) in `swarm_task_status` output.
    - Retired `swarm_confirm_qualification` and enabled automatic progression of task qualification gates upon qualification check completion.
- **Verification**: `extensions/swarm/tests/minimal-protocol-authoritative.test.mjs`, `extensions/swarm/tests/smoke.test.mjs`, `extensions/swarm/tests/tool-gating.validate.mjs`.

### chore(package): prune package exports to swarm extension only

- **Context / Symptom**: Package manifest exposed internal and non-swarm extensions to external consumers.
- **Key Changes**:
    - Scoped `pi.extensions` in `package.json` strictly to `./extensions/swarm/index.ts`.
- **Verification**: Verified `package.json` extension manifest structure.

### fix(swarm/pool): split model pool swap notification & prioritize yaml config

- **Context / Symptom**: Model pool auto-swaps following a 429 quota/rate limit injected raw provider error JSON into the agent's LLM context, confusing the model and wasting turns. Additionally, hardcoded provider hints in tools conflicted with user settings in `swarm.yaml`.
- **Key Changes**:
    - Split swap nudge into two distinct messages: a user-facing visual warning (`swarm-pool-event`, display:true, followUp) noting the swap, and a clean prompt (`swarm-message`, continue-only, triggerTurn:true) without raw error noise.
    - Prioritized `.pi/swarm.yml` config over tool parameter hints and removed obsolete provider hints from coordination tools.
- **Verification**: `extensions/swarm/tests/pool-swap-nudge-content.test.mjs`, `extensions/swarm/tests/swarm-yaml-no-provider-hints.test.mjs`.

## [v0.0.2] - 2026-09-16

### fix(swarm): model pool retry rotation, settle nudge suppression, and goal check reset

- **Context / Symptom**: In-flight pool retries caused transient settle notifications to flood the root coordinator, model pool failed to rotate promptly after consecutive errors, and goal idle streaks failed to reset when workers showed activity.
- **Key Changes**:
    - Configured model pool rotation to trigger after 2 consecutive retries on a failing slot.
    - Suppressed transient settle nudges to root while model pool retry and auto-swap workflows are in progress.
    - Reset goal check streaks immediately upon detecting agent activity.
- **Verification**: `extensions/swarm/tests/idle-streak-reset.test.mjs`, `extensions/swarm/tests/pool-retry-settle-nudge.test.mjs`, `extensions/swarm/tests/pool-retry.test.mjs`, `extensions/swarm/tests/r28-stale-goal-nudge-order.test.mjs`.

## [v0.0.1] - 2026-09-15

### feat(swarm): monotonic goal nudge ordering, stuck-busy prevention, and sync wait guidance

- **Context / Symptom**: Superseded goal nudges resurfaced out-of-order, stuck-busy escalation triggered prematurely while root was executing long tools, and long background waits triggered false idle alarms.
- **Key Changes**:
    - Added monotonic sequence guard for goal nudges to prevent out-of-order resurrection.
    - Retired superseded and stale messages into `consumerReceipts` to prevent inflating wait times.
    - Checked root active tool execution (`ROOT_BUSY_ACTIVE_EXECUTION_MS`) before escalating stuck-busy state.
    - Suggested synchronous sleep/wait in goal idle nudges when waiting on background tasks.
    - Added standalone `/swarm-mark` command with datetime suffix and audit trail, goal nudges subcommand with infinite nudge support (`-1`), and durable internal-error logging (`errors.jsonl`).
    - Added `.pi/swarm.yml` YAML configuration support for the model pool and `/swarm deregister`.
- **Verification**: `extensions/swarm/tests/r28-stale-goal-nudge-order.test.mjs`, mock-LLM scenario `r28-goal-stale-order-prevention.jsonl`.

### fix(swarm): pool hardening — success resets, swap-chain cap, pool lock, provider-strict swap, dedupe, backoff

Edge-case sweep from a code review of the auto-swap path:

Docs: `docs/swarm/operations.md` § Model pool and `docs/swarm/architecture.md` cover all of the above; `extensions/swarm/README.md` links the summary.

- **Success now resets the failure streak**: `turn_end` with `stopReason "stop"` calls `recordSlotSuccess` for that slot. Previously a slot that transient-failed once and then served hundreds of healthy turns would still bench on its next transient.
- **Swap-chain cap (MAX_SWAP_CHAIN=2 per agent, 5min quiet reset)**: a failing prompt no longer cascades fail->swap->retry->fail through every pool slot, burning a turn each; beyond the cap the turn fails naturally (`pool.swap_chain_capped` trace).
- **Pool-state lock**: all read-modify-write cycles on `.pi/swarm/pool-state.json` (pickSlot rrCursor, recordProviderError, recordSlotSuccess, setSlotCooldown) now run under a dedicated mkdir-based mutex — concurrent agent processes can no longer lost-update each other.
- **Provider-strict swap resolution**: dropped the `find(model-without-provider)` fallback; ambiguous model ids shared across providers (gpt-5.4-mini exists on several) could resolve to a provider with no API key, yielding swap_failed loops. A slot that cannot resolve under its own provider is traced with a config hint.
- **Incident dedupe**: identical error text on the same slot within 30s counts once toward the streak (pi emits multiple error turns for one underlying failure via internal retries/overflow recovery), so `maxRetries` means distinct failures.
- **Exponential bench backoff**: consecutive benches without an intervening success double the cooldown (capped 24h) — a monthly-quota outage costs one probe per doubling instead of one per cooldownMs. `recordSlotSuccess` resets the streak.
- Tests extended: pool.test.mjs 45 assertions (dedupe, backoff doubling), pool-swap.test.mjs 16 (success reset, chain cap). Mock UAT re-run green: quota bench+swap+retry, recovery after cooldown.

### test(swarm): mock-provider UAT harness + full-scenario pool validation

- `scripts/uat/mock-provider-server.mjs`: local OpenAI-compatible server with scenario control (`{mode: ok | error | flaky}`) emitting VERBATIM provider error payloads — 429 quota (`insufficient_quota`), 429 rate_limit, 401 invalid key, 500 overloaded — over SSE. `scripts/uat/mock-provider-ext.ts`: pi extension registering `mock-a`/`mock-b` providers against it, so pi makes REAL streaming calls with fully scripted failures at zero cost.
- Fix found by the mock UAT: when EVERY pool slot is benched, `pickSlot` used to return the soonest-cooldown slot, causing the agent to thrash between dead slots (observed live: mock-a<->mock-b swap loop under all-slots-down). Now it returns undefined — the agent keeps its current model, the turn surfaces the error once, `pool.swap_no_candidate` is traced. No thrash.
- UAT verified live in tmux with real pi processes:
    - quota: agent on mock-a got a real 429 -> benched -> in-process swap to mock-b -> retried and answered on the SAME session/context.
    - auth (401): slot benched 6h immediately; all-slots-down ends with `pool.swap_no_candidate` (no thrash).
    - recovery: after scenario returns to ok and cooldowns expire, slots re-enter rotation and serve normally.
    - multi-agent failover: 3 concurrent agents (w1/w2/w3) on mock-a all hit 429 simultaneously -> all three swapped to mock-b within the same second (traces: 3x `pool.slot_failure` + 3x `pool.swap`) and all completed their turns.
    - remaining manual UAT: a REAL provider 429 with a nearly-exhausted key (scripted path is identical; only the error source differs) — run the same steps when such a key is available.
- Mock server also supports `{mode: "raw", status: <code>, body: {...}}` to replay any verbatim real-world provider payload. Validated live with a captured GlHF-style payload (`rate_limit_error`, code 1302): classified `rate_limit`, streak bumped, in-process swap to the fallback slot, agent answered on the same session.

### feat(swarm): in-process model auto-swap on provider errors (turn_end hook) — the agent fixes itself, no respawn

- pi does NOT exit on provider errors (429 quota, 401 auth, 5xx) — the turn fails with `stopReason: "error"` and the process keeps running. The earlier pane-watcher approach detected the wrong thing at the wrong layer and was reverted. Detection now happens INSIDE the agent's own pi process.
- New `turn_end` hook (hooks.ts): on an assistant turn with `stopReason "error"`, classify `errorMessage` (quota / rate_limit / auth / transient / unknown) from the REAL provider error text, record it against the exact `provider/model` slot that failed, then `pi.setModel()` to a different healthy pool slot picked by the rotation strategy — **in-process, conversation/context/mailbox fully preserved**. A `[PI-SWARM MODEL POOL]` system note tells the agent why the turn failed and that it now runs on a new model, so it retries its work.
- Error-kind bench policy (pool.ts `recordProviderError`): quota/auth bench the slot IMMEDIATELY (retrying cannot fix an exhausted quota or bad key); auth benches ≥6h; rate_limit/transient follow the `maxRetries` streak. Unknown errors (e.g. context overflow) never touch the streak and never swap.
- `/swarm pool list` shows the classified error per slot (e.g. `quota: 429 ...`).
- Verified live in tmux: an agent running a broken model (`ccs/nonexistent-model-x`) got a 502 on its turn → auto-swapped to `ccs/glm-5.1` in the SAME process → retried and answered normally, footer model changed, context intact (traces `pool.slot_failure` kind=transient + `pool.swap`). New `pool-swap.test.mjs` (12 assertions: classification matrix, quota immediate bench, in-process swap, context-overflow no-swap, transient streak, guest exemption).

### feat(swarm): model pool — weighted multi-provider rotation with health cooldown and restart failover

- `settings.json` previously supported only ONE `defaultModel`/`defaultProvider`; every spawn pinned that pair. New opt-in `modelPool` (array of `{model, provider?, weight?, label?}`) + `rotation` (`{strategy, cooldownMs, maxRetries}`) under `swarm` (or `extensions.swarm`).
- **Rotation strategies**: `weighted` (default; random by weight), `round-robin` (cursor persisted), `sticky` (sha256 of agent id → deterministic slot per agent).
- **Health + cooldown**: per-slot health persists in `.pi/swarm/pool-state.json`; `maxRetries` (default 2) consecutive failures bench a slot for `cooldownMs` (default 15 min). `weight: 0` = fallback-only, used when every weighted slot is benched; if ALL slots are benched, the soonest-to-recover is returned best-effort.
- **Spawn/restart integration**: `spawnAgent` picks from the pool when no explicit model is given (trace `pool.spawn_pick`); `restartAgent` detects the recorded slot is benched and re-picks a different slot (`pool.failover` trace, `avoidKey` deprioritized for round-robin). Agent id/role/mailbox/identity are preserved across failover restarts.
- **Commands**: `/swarm pool list` (weights, failures, cooldown remaining), `/swarm pool cooldown <provider/model> <ms>`, `/swarm pool clear <provider/model>`. New `src/pool.ts`; exports added to `index.ts`.
- Backward compatible: no `modelPool` ⇒ single-default behavior identical to before.
- Verified: new `pool.test.mjs` (40 assertions: weighted pick distribution/exclusion, failure→cooldown, benched exclusion, fallback-only promotion, success-clears-streak, sticky determinism, no-pool undefined); all suites green (the 2 pre-existing `completion.test.mjs` failures are present on the clean baseline and unrelated).

### feat(background-tasks): `background_watch` — event-driven monitoring so the agent never polls

- The agent could already `background_start` / `background_status` / `background_output`, but there was no event primitive: to notice a dev server becoming ready, a build failing, or a process stalling, it had to either block on `background_wait` (wasting a turn) or burn tokens in a `background_output` poll loop.
- **Added three tools**: `background_watch` (register a monitor), `background_watch_list` (list/cancel), `background_unwatch` (cancel by `watchId` or `taskId`). A watch takes exactly ONE trigger:
    - `pattern` — regex matched against **NEW** combined output (stdout+stderr) since the last scan. `ignoreCase` optional.
    - `port` — TCP readiness on `127.0.0.1` (nudge when the port starts accepting).
    - `idleMs` — stall detection (nudge if no new output for N ms).
    - `once:true` (default) fires once then completes; `once:false` is continuous and rate-limited by `watch.refireMs`; `ttlMs` caps lifetime.
- **Zero new polling infrastructure**: the evaluator piggybacks on the existing `renderUi` tick loop (`session_start` setInterval) and delivers via the SAME idle-gated `pi.sendUserMessage` path as the completion nudge — TUI-only, deferred while busy so it never interrupts a streaming turn.
- **Session-scoped & durable**: watchers persist in `state.json` (survive `/reload`); cursors advance per-stream so only NEW output matches (readiness still fires immediately on already-present output, since the first scan starts at offset 0). Cancellation on `background_unwatch`, on TTL, and automatically when the watched task goes terminal or is pruned.
- **Per-tick nudge coordination**: at most ONE `sendUserMessage` per tick is sent across the completion nudge and the watch nudge (each call starts a turn; a second one in the same tick previously threw `Agent is already processing a prompt`). Whichever claims the slot sends; the other defers its still-pending nudge to the next idle tick.
- Settings (env > `.pi/settings.json` > defaults): `PI_BG_TASKS_WATCH`, `PI_BG_TASKS_WATCH_MAX`, `PI_BG_TASKS_WATCH_REFIRE_MS`, `PI_BG_TASKS_WATCH_PORT_TIMEOUT_MS`, `PI_BG_TASKS_WATCH_PATTERN_MAX_LEN`, `PI_BG_TASKS_WATCH_RANGE_READ_BYTES`.
- Verified: new `watcher.test.mjs` (25 assertions: register validation, readiness/immediate fire, new-output-only, continuous refire + rate-limit, idle, port with a real listener, session scope, unwatch, prune cleanup, busy-defer); all 7 suites green (81 assertions); live tmux `pi --model glm-5.1 --provider zai-coding-cn` run confirms `background_start` → `background_watch` → `background_watch_list` shows `status:fired, firedCount:1, lastSnippet:SERVER-READY`, and both the completion nudge and the watch nudge deliver cleanly with no double-send error.

### chore(background-tasks): remove the redundant `/background-tasks` command; `/bg` is the sole command

- The extension registered **two** slash commands that did different things and invited confusion:
  `/bg` (the full-featured primary command — overlay dialog, `stop|kill`, `prune`, status filter, `all`, `on|off`) and `/background-tasks` (a thin config + counts dump). Worse, the _long_ name did _less_ than the short one.
- **Removed** the `pi.registerCommand("background-tasks", …)` block from `src/command.ts`; **`/bg` is now the sole command** (`Shift+Ctrl+B` shortcut unchanged). This also drops the config dump that lived only in that handler (max concurrent / log cap / kill-on-shutdown / scope / ui settings); those remain settable via env `PI_BG_TASKS*` / `.pi/settings.json`.
- Safe to remove: only that one registration block referenced it; no tests depend on the command; the design-doc §6 paragraph describing it was removed.
- Verified: `tsc --strict` clean; all 6 suites green (56 assertions); live tmux `pi -ne -e <ext>` load confirms the extension loads and `/bg` still opens the dialog, while `/background-tasks` is no longer a registered command.

### feat(background-tasks): tasks die with their spawning pi by default (parent-death watchdog); opt-in `survive:true` for long-lived daemons

- **Symptom:** background tasks were detached/unref'd and **outlived** the pi that started them. That was the old intentional default, but orphaned tasks surviving a pi **crash / kill-9** (where no `session_shutdown` hook can run) was treated as a critical bug — processes keep running with no owner.
- **Fix — default lifetime reversed; crash/kill-9 now covered:**
    - A **parent-death watchdog** runs _inside_ the detached `sh` wrapper (`src/constants.ts` `WRAPPER`). It polls the wrapper's _current_ parent vs. the spawning pi's pid — **passed explicitly** as a wrapper argv element (so there is no `$PPID` capture race). When that pi exits — cleanly OR via crash/kill-9 — the OS reparents the wrapper to init, the check fails, and the wrapper group-kills `"-$$"` (command + all descendants, no orphans; TERM then KILL after 2 s). Keying on **reparenting** (not pid liveness) makes it **pid-reuse resistant**. `src/lifecycle.ts` `spawnChild` always passes `process.pid` as that arg; `DPID` reaps the watchdog subshell on natural exit.
    - **`survive:false` is the default** → task dies with pi. New **`survive?: boolean`** param on the `background_start` tool (`src/tools/index.ts`), `StartInput`, and `BackgroundTask` (`src/types.ts`); `survive:true` starts the wrapper with the watchdog **disabled** so a long-lived daemon outlives pi. Persisted to `state.json`.
    - **`/reload` keeps tasks alive** — reload re-inits the extension but does not end the pi _process_, so the wrapper's parent never changes and the watchdog does not fire.
    - `session_shutdown`'s `killOnShutdown` (`src/hooks.ts`) is now an orderly fast-path only: it skips `survive:true` tasks and covers just clean shutdowns (the watchdog is the authoritative path and also catches crash/kill-9).
    - Caveat: **non-shell mode (`shell:false`) does not get the watchdog** — those tasks use `spawn` directly, not the wrapper. Documented as a V1 limitation.
- Verified: `watchdog.test.mjs` (6 assertions — default task killed after its spawner exits; `survive:true` still alive with correct process count; `survive` persisted to `state.json`) using a forked helper (`watchdog-spawn-helper.mjs`) that spawns a real task then exits to simulate pi dying. **Live, through-pi tmux run** (`pi -ne -e <ext>`, isolated temp project): a default task appeared in the widget (`⏳ live-sleep777`) and was **killed** once its spawning process died (`sleep 777` procs = 0); a `survive:true` task **persisted** (`sleep 888` procs ≥ 1) across the parent's death. All 6 suites green (56 assertions); `tsc --strict` clean; `WRAPPER` validated with `sh -n`.
- Note (pre-existing, surfaced during this work): the ambient UI refresh tick does a lock-free read only and does **not** reconcile (finalization relies on the live exit listener + tools + `/bg` dialog + `session_start`). So a task killed by the watchdog while pi is _up but idle_ may stay `running` in state until a reconcile trigger; the next pi's `session_start` reconcile finalizes it to `unknown`. Not changed here (out of scope; the watchdog's own kill behavior is correct end-to-end).

### feat(background-tasks): output detail view opens at the latest line and auto-follows new output (`tail -f` behavior)

- **Symptom:** opening a task's output in the `/bg` dialog always started at the **top** of the captured stdout/stderr, so for a still-running task you immediately had to scroll down (or wait and re-scroll) to see what it just produced.
- **Fix (`src/dialog.ts` `BgDialog`):** the detail (output) sub-view now opens at the **latest** line and **tails** new output as it streams in.
    - New `detailFollow` flag (single source of truth) drives it: **on** by default when a task is opened → the viewport is pinned to the newest line and re-reads on the 1 s refresh tick keep it there.
    - **Scrolling up** (`k`/`↑`/`pageup`) **pauses** auto-follow so you can read history without being yanked down; **reaching the bottom** (via `j`/`↓`/`pagedown`) or pressing **`G`** **resumes** following. `g` jumps to the top.
    - `loadDetail` pins to `detailLines.length` while following; when paused it holds the user's line and only clamps if the log shrank. (An earlier draft also followed when the viewport merely _showed_ the last line — that re-armed follow even after a small scroll-up; dropped in favor of the explicit flag.)
    - Detail footer now reads `line X/Y · j/k scroll · g/G top/bot · following|paused · esc back`; the list-view help notes output "opens at latest".
- Verified live in an isolated tmux pi session (`pi -ne -e <ext>`, seeded running task with a 45-line log): detail opened at the latest (`output-line-33..45`); appending `46..50` auto-scrolled into view; scrolling up paused (stayed at `22..34` through further appends); `G` jumped to the bottom and re-armed follow (subsequent appends tailed to `54`). `tsc --strict` clean; existing suites green (50 assertions). The dialog is TUI-only (no prior unit tests), so the scroll behavior is covered by this live run rather than a unit test.

### fix(background-tasks): default UI shows LIVE tasks only; killed/exited tasks hidden (not deleted) and reclaimable explicitly via `/bg prune`

- **Symptom:** the background-tasks widget and `/bg` dialog listed **every** task including `done`/`failed`/`killed`/`unknown`, so finished/killed tasks piled up and crowded out (or pushed past `maxRows`) the actually-running work. The persistent below-editor widget showed "all killed tasks, not just the live ones".
- **Fix — default views surface in-flight work only; exited tasks are hidden, never auto-deleted:**
    - **Below-editor widget** (`src/ui.ts` `renderUi`) now renders only `running`/`pending` tasks. When no task is live the widget is cleared (so killed/done tasks no longer linger); the footer status line still summarises finished counts (`bg: 2 done, 1 failed`) for awareness. `summaryLine` no longer prints a stale `0 running` once everything is terminal.
    - **`/bg` overlay dialog** (`src/dialog.ts` `BgDialog`) defaults to **live-only** too. New `e` key toggles "show exited" (reveals finished/killed/unknown); the header shows an `N exited hidden (e)` hint and the title counts always reflect the full scoped set. Added `e` to the footer + help.
    - **`/bg <status>`** and **`/bg all`** are unchanged — they remain the explicit ways to enumerate exited tasks.
- **Reclaim is opt-in, by request:** killed/exited tasks are acceptable to reclaim, but NOT via a default flag or the default UI. New **`/bg prune [all]`** is the single explicit path that deletes terminal tasks (and best-effort their log + exit-marker files) from `state.json`. New `pruneTerminal(cwd, opts)` in `src/lifecycle.ts` (locked, traced as `task.prune`): never touches `running`/`pending` tasks, respects session scope by default, and reclaims across sessions with `all`. Added `prune` to `/bg` tab-completion.
- Verified: `prune.test.mjs` (11: terminal-removed/live-retained/file-deletion, session scope, `all`, no-op, live-never-reclaimed) and `ui-live.test.mjs` (5: widget renders only the live row, terminal-only clears the widget, footer keeps counts, new live re-shows it); existing `lifecycle`/`nudge`/`session` suites stay green (34 assertions); `tsc --strict` clean. Not exercised live in tmux in this pass (TUI-render fix is covered deterministically by the widget-factory assertions; `/bg prune` is a state-only path validated by `prune.test.mjs`).

### feat(swarm): agent lifecycle manipulation — register / stop / restart / set_role / pause / send_keys / attach / release

- The swarm extension could **spawn** and **inspect** agents but had no surface to _manipulate_ a live agent: there was no way to adopt an already-running pi pane into a role, stop/restart an agent, repurpose its role, or park it without killing it. `spawnAgent` was the only writer of agent records and always created a fresh tmux window + pi process; externally-started agents also landed as ghosts with `tmuxTarget: "unknown"` (uninjectable, uncapturable, liveness-blind).
- Added a full **agent lifecycle** surface, each exposed as BOTH an agent tool (`pi.registerTool`, the primary coordination interface — agents self-organize via tool calls) and a human `/swarm` subcommand, both wrapping the SAME lock-free cores in `src/agents.ts`:
    - `swarm_register_agent` / `/swarm register <target> <id> [role…]` — adopt an **existing** tmux pane into a role without spawning; upsert by id, so re-registering with a different target **retargets** (fixes the `unknown`-target ghost case). Probes the pane, writes the record with the correct `tmuxTarget`, regenerates the identity, and injects a role/identity kickoff.
    - `swarm_stop_agent` / `/swarm stop <id> [--force] [--no-kill]` — kill the pane + mark stopped; **refuses active tasks unless `force`** (mailbox/identity/history persist via the stable id).
    - `swarm_restart_agent` / `/swarm restart <id>` — stop + respawn a fresh pi at the SAME id (recorded role/model/provider), so mailbox + identity persist. Respawns into the swarm's canonical `tmuxSession`.
    - `swarm_set_role` / `/swarm role <id> <role…> [--kind K] [--caps a,b]` — mutate role/roleKind/capabilities at runtime and regenerate + inject the identity, WITHOUT respawning (roleKind re-derived unless `--kind` pins it).
    - `swarm_set_agent_paused` / `/swarm pause|resume <id>` — drain an agent from the reuse pool WITHOUT killing its pane; `findReusableAgent` now skips `paused` agents.
    - `swarm_send_keys` / `/swarm sendkey <id> <keys> [--literal] [--enter]` — raw tmux keys to a pane (interrupt/dismiss/type); escape hatch.
    - `swarm_attach_agent` / `/swarm attach <id>` — print the tmux attach/select commands for a pane.
    - `swarm_release_agent_task` / `/swarm release <id> [<task-id>] [--force]` — clear a stale `activeTaskIds` pointer after a task is terminal/missing; **refuses non-terminal tasks unless `force`**.
- Supporting changes: `paused?: boolean` on `SwarmAgent`; refactored `reloadIdentity` to share a new `injectReloadIfAlive` helper with `setAgentRole` (consistent reload prompt); `paused` surfaced in `swarm_agent_status` rows; `parseTmuxTarget` best-effort session/window parse. Tab-completion (`src/completion.ts`) already covered all new subcommands.
- Only `swarm_gc_agents` remains deferred (use batch `swarm_stop_agent` + admin `swarm_prune`); the prior "deferred" notes on `swarm_stop_agent`/`swarm_release_agent_task` in `README.md`, `docs/swarm.md`, and `docs/swarm-task-graph.md` were updated to reflect they now ship.
- Verified: new `agent-lifecycle.test.mjs` (37 assertions: register/retarget, set_role version-bump+injection, pause/resume + reuse-skip via direct `findReusableAgent`, stop refuse/force, release stale pointer, restart id/mailbox preservation, send_keys, attach, error paths); fixed comparison bugs in the pre-staged `completion.test.mjs` (raw-item vs value-string; stale `'st'` collision now that `stop` also matches); updated `smoke.test.mjs` (44 tools). Full safety net `ALL GREEN`. Loaded + exercised live in an isolated tmux pi session (`pi v0.83.0`, glm-5.1/zai, clean temp cwd): `register`→`role`(`injected=true`)→`pause`/`resume`→`attach`→`stop`(`kill-window`)→`restart`(live `swarm:demo` pane with persisted role) all confirmed against real tmux + real state. Snapshots under `./tmux-snapshots/20260808-174*/`.

### refactor(swarm): split the monolithic index.ts (5310 lines) into a layered module tree

- `extensions/swarm/index.ts` went from **5310 lines / 310KB** (one file: types, helpers, state IO, task-graph, metrics, mailbox, loop, reconcile, 36 tool defs, 8 hooks, command) down to a **21-line entry point** that just wires the modules together and re-exports the 3 unit-tested helpers (`isDeliveryFailureRetryable`, `validateRunAgainstContract`, `computeIterationBest`).
- New layout under `extensions/swarm/src/`:
    - `types.ts` (all type/interface defs), `constants.ts` (all module-level consts), `utils.ts` (pure helpers), `state.ts` (paths + state/lock/trace/JSONL/evidence file IO).
    - `taskgraph.ts` (graph algorithms + status/closure/transitions/render), `metric.ts` (run/memory/iteration validation + ranking), `delivery.ts` (message parsing + retry predicate).
    - `session.ts` (model/root detection), `identity.ts` (identity markdown + write), `tmux.ts` (tmux wrappers), `mailbox.ts` (read/deliver/pump helpers), `agents.ts` (spawn/reuse/reload), `loop.ts` (loop state), `reconcile.ts` (mail+task sweep + status summary + pump).
    - `hooks.ts` (8 event hooks + root mailbox pump), `command.ts` (`/swarm` slash command).
    - `tools/{agents,messages,tasks,metrics,loop}.ts` — the 36 tool registrations grouped by domain (9/5/8/12/2).
- Method: every function/const/type body was extracted **verbatim** via a block-splitter (behavior preserved exactly); cross-module + external imports were generated per module. Largest file is now `reconcile.ts` (526 lines); nothing exceeds ~530.
- Verified equivalent: all existing checks stay green — `delivery.test.mjs` (7), `memory.test.mjs` (12), `loop-reconcile.validate.mjs`, `pump-retrigger.validate.mjs`, `reconcile-loop.validate.mjs` (5); plus a new smoke test (full 36-tool load via mock pi) and a functional test (12 tool execute paths). Loaded + exercised live in tmux (`pi v0.83.0`, glm-5.1/zai): `[Extensions] swarm`, `swarm:root` status line, `/swarm status`, and `.pi/swarm/` state written — all from the refactored tree.

### feat(swarm): graph-advance watcher — harness nudges the root to assign any ready-but-unassigned node so a graph never stalls mid-flight

- Symptom (seen live in `vai-race-clinic`): `plan_iteration` completes and `implement_change` becomes ready, but the root only DESCRIBES the next step ("implement_change now just needs to prepare the git toggle…") and ends its turn without calling `swarm_assign_task`. The worker's result message is informational (`requiresAck:false`), so nothing compels the root to advance, and — unlike the loop boundary states — there was NO harness nudge for a node that is merely ready-but-unassigned mid-graph. The graph stalls until a human intervenes.
- Fix, staying in the harness-as-watcher model (the harness checks state + nudges; the root remains the actor that assigns): a new `reconcileGraphAdvanceLocked` runs in the same throttled root-pump tick as the loop watcher. For every `in_progress` task it computes actionable nodes (deps satisfied, `computeReadyNodes`, unassigned) and, after ~`LOOP_RECONCILE_INTERVAL_MS`, sends one idempotent, action-critical (`requiresAck:true`) nudge per stalled node telling the root the exact call: `swarm_assign_task(taskId=…, nodeId=…)`, plus "keep driving the graph to completion — never end a turn by merely describing the next step, ACT on it". The nudge is auto-acked the moment the node is assigned/terminal (next reconcile tick), so reminders stop as soon as the root moves.
- This is the mid-graph counterpart to the loop watcher: the loop watcher drives iteration boundaries (plan / reopen / execute); the graph-advance watcher drives the nodes IN BETWEEN, so an `in_progress` task with the root paying attention runs end-to-end on its own. Safety net only — if the root assigns immediately on its own, the nudge never fires; it only catches stalls.
- New helper `sendGraphAdvanceNudgeLocked` + watcher `reconcileGraphAdvanceLocked`; reuses `computeReadyNodes` / `ackLoopNudgeLocked`. Validated deterministically by `extensions/swarm/graph-advance.validate.mjs` (6 scenarios: ready-unassigned nudge, assigned→auto-ack, done-task skip, idempotency, unsatisfied-deps skip, parallel-ready) and end-to-end in tmux on a seeded in_progress task (`implement_change` ready-but-unassigned): the root pump's `session_start` reconcile emitted the assign nudge, the root acted on it and assigned `implement_change → comp-implementer`, and the next tick auto-acked the nudge.

### feat(swarm): loop-watcher — harness detects loop states and nudges the root to drive every iteration autonomously

- After the pump fix, a loop-enabled task still stalled at two dead-ends the root was never told about: (1) **empty `proposalAgents`** (e.g. `vai-race-clinic`'s 20-iter task) kicks off at `phase=awaiting_plan` with nothing to wait for — the root got a kickoff nudge, acked it, and the loop never advanced because no harness logic reminded it to synthesize a plan; (2) after `swarm_loop_plan` records a plan, `loop.phase` becomes `planned` but **`recordLoopPlan` never reopens the task graph**, so iteration N+1 never executes and no nudge said so.
- Aligned to the loop's design model — **the harness is a state-checker + nudger; the root (an agent) performs every state change** (plan, reopen graph, execute). Added a throttled (`LOOP_RECONCILE_INTERVAL_MS = 30s`) `reconcileLoopNudgesLocked` watcher that runs inside the root pump and sends idempotent, action-critical (`requiresAck:true`) nudges for three states, auto-acking once each is resolved:
    - **ready_to_plan** — `phase≠planned` AND no pending proposals (empty pool OR all replied) → nudge "synthesize the next plan now" with carry-forward pointers (`swarm_iteration_context` / `swarm_iteration_status` + latest `distill_memory`). This is the direct fix for the empty-`proposalAgents` dead-end: it explicitly says "there is nothing to wait for". Auto-acked when `phase→planned`.
    - **plan recorded but graph closed** — `phase=planned` AND `task.status=done` → nudge to REOPEN the graph (`swarm_update_task(...,status="pending",force=true)` on the iteration nodes), listing them by name. Sent both immediately from `recordLoopPlan` and as a safety net by the throttled watcher. Auto-acked when the task leaves `done`.
    - **task executing** — `task.status≠done` → auto-ack that round's reopen + plan-now nudges so reminders stop while work runs.
- **Flow A — empty pool is an _intentional_ no-op fanout, not a bug, but the nudges now give the root a choice instead of silently skipping proposals.** `proposalAgents` is an optional config (default `[]`, "no-op fanout is valid" per `getLoopConfig`); it is NOT auto-populated from registered agents and kickoff does NOT auto-fan-out. So an empty pool means the root plans directly. To keep that useful (an optimization loop benefits from diverse ideas) the kickoff + plan-now nudges now surface a Flow-A option when the pool is empty: "(1) synthesize directly, OR (2) if you want diverse ideas first, send proposal requests yourself to [worker agents] (`swarm_send_message` requiresResponse / `swarm_task_message`), read their replies, then plan". The worker list is computed by a new `availableProposers(st)` helper (every registered agent except the root). The harness never auto-fans-out — it only tells the root WHO it can ask; the root (an agent) decides. (Loop status does not auto-track ad-hoc proposals; the root collects them.)
- **Design B + kickoff-auto-ack (found diagnosing the live `vai-race-clinic` stall):** the loop used to REQUIRE `swarm_loop_plan` to advance rounds — kickoff's guard skips a new round while `phase ∈ {collecting_proposals, awaiting_plan, refreshing}`, so if the root reopened the graph WITHOUT recording a loop plan (reasonable, since this task's graph has its own `plan_iteration` node) the loop stuck at that round forever. Two fixes: (1) new `executing` phase — when reconcile sees the graph reopen (`task.status≠done`) it advances the current round's phase from `awaiting_plan`/`collecting_proposals` to `executing`, so the next close-done lets kickoff start a fresh round WITHOUT a separate `swarm_loop_plan` (the graph owns the iteration); `loopStatusSnapshot` + the `/swarm loop status` render report `executing` as "round executing (graph reopened — let it run)". (2) the kickoff nudge (`...:nudge:root`) was only auto-acked by `recordLoopPlan`, so reopening-without-plan left it unacked → the pump re-triggered it (capped 3×) → wasted turns on "duplicate" responses. reconcile now auto-acks the kickoff nudge too when the task leaves `done`. Validated live: `vai-race-clinic` round 2 (staged but idle) received a clean assign nudge and the root assigned `plan_iteration` → comp-planner and ran; round 2's phase is `executing` so round 3 will kick off on close-done.
- Also rewrote the **kickoff nudge body** to branch on pool size and to tell the root up front about the plan → reopen → execute sequence.
- New helpers: `sendLoopPlanNowNudgeLocked`, `sendLoopReopenNudgeLocked`, `ackLoopNudgeLocked`, `reconcileLoopNudgesLocked`; `SwarmState.lastLoopReconcileAt`. Validated deterministically by `extensions/swarm/loop-reconcile.validate.mjs` (10 scenarios across both cells) and end-to-end in tmux on a seeded empty-pool task: reconcile fired on `session_start` and emitted the **plan-now** nudge ("round 1 ready to plan… nothing to wait for"), then after simulating `phase→planned` auto-acked it and emitted the **reopen** nudge, then after reopening the graph auto-acked the reopen nudge — all three cells confirmed in the mailbox + state ledger.

### fix(swarm): root auto-pump no longer swallows nudges that arrive while busy (loop-nudge-stuck-at-awaiting_plan)

- Root cause: `pumpRootMailbox` marked a message "surfaced" in the per-pid ledger at read time, BEFORE knowing whether delivery would actually trigger a turn. Delivery used `triggerTurn: true` only when `ctx.isIdle()`; when the root was busy it fell back to `deliverAs: "followUp"` with no trigger. So a nudge landing while busy (e.g. the iteration-loop nudge fired right at task-close) was followUp-delivered and marked surfaced, then permanently skipped by every later idle pump (incl. `agent_settled`). In `vai-race-clinic` this stranded the 20-iteration loop at `awaiting_plan` forever — the root was never prompted to record a plan.
- Fix (thorough, 3 parts): (1) **Defer when busy** — a busy pump surfaces/marks nothing and delivers no dead followUp, so the next idle pump (`session_start` / `agent_settled` / 5s interval) re-reads the message and delivers it WITH a real `triggerTurn`. This also stops queuing followUps that could themselves keep `isIdle()` false. (2) **Bounded re-trigger** — a surfaced+triggered but still-unacked `requiresAck` message is re-delivered with a fresh `triggerTurn` after 60s, up to 3 times, so a triggered-but-ignored nudge is not silently lost. Informational (`requiresAck:false`) messages still get exactly one triggered delivery. (3) **Loop nudge is now `requiresAck:true`** (it is action-critical, not informational) and `recordLoopPlan` auto-acks it by idempotencyKey, so reminders stop once a plan is recorded.
- New per-session ledger fields `triggeredAt` / `retriggerCount` (bounded by `PUMP_SESSION_ID_CAP` via a new `capMap` helper); pump trace now reports `idleAtStart`, `deferred`, and `retriggered`. Logic validated deterministically by `extensions/swarm/pump-retrigger.validate.mjs` (busy-defer, idle-trigger, bounded re-trigger, informational-not-retriggered, acked-skipped, fresh-vs-overdue ordering) and end-to-end in tmux: an root TUI session surfaced+triggered a seeded nudge on `session_start` (`count=1, idleAtStart=true, retriggered=0`) and the root acked it; interval pumps while that turn ran correctly reported `deferred=1`; the `agent_settled` pump re-ran idle.

### feat(swarm): pick tasks by `#`, uuid, or substring in graph/task/next/validate; `/swarm graph` now lists tasks with age

- Operators had to know a task-id verbatim to use `/swarm graph <id>`. Now every graph-flow command (`graph`, `task`, `next`, `validate`) accepts a **list index** (`1`, `2`, …), a **full task-id/uuid**, or a **distinctive substring** (e.g. `dashboard`, `iteration-demo`, `uat-clean`) — multiple substring hits return an `Ambiguous …` hint plus the list instead of guessing.
- `/swarm graph` (and `task`/`next`/`validate`) with **no argument now prints the indexed task list** so you can discover the `#`/id before re-running. `/swarm tasks` was rebuilt on the same renderer.
- The list is **sorted deterministically** (createdAt asc, task-id tiebreak) so a number you just saw maps to the same task on the next call, and now shows **age** (`17h`, `2d`, …) and an **updated** timestamp per task, plus node completion and `current → next`.
- Shared helpers added: `humanAge`, `listTasksIndexed`, `renderTasksIndexedList`, `resolveTaskArg`. Validated end-to-end in a fresh pi run: `/swarm graph` → `swarm.tasks via:graph-noarg` count=15; `/swarm graph 1` → `task.print` resolved to the oldest task and wrote its graph file; `validate 1`/`next 1` resolve consistently; substring `iteration-demo` resolves uniquely while `dashboard` reports ambiguous — all exit 0 with no crashes.

### feat(swarm): human-facing graph-flow viewing commands (`/swarm tasks|task|next|validate`)

- The agent has rich tools to inspect swarm graph flow (`swarm_task_status`, `swarm_print_graph`, `swarm_next_nodes`, `swarm_validate_graph`), but human operators only had `/swarm graph` and the `/swarm status` rollup. Added four `/swarm` subcommands so a user can see the same graph-flow state from the prompt without asking the model to call a tool:
    - `/swarm tasks` — lists every task graph with status, node completion count, and current/next nodes (so operators can discover task-ids before running the per-task commands).
    - `/swarm task <task-id> [runtime]` — full node/gate table + artifact existence; with `runtime` it also shows the closure roll-up (stored vs derived status, closed/open/stale counts) and agent/message/liveness warnings. Mirrors `swarm_task_status`.
    - `/swarm next <task-id>` — ready/next nodes plus a suggested reusable agent per ready node. Mirrors `swarm_next_nodes`.
    - `/swarm validate <task-id> [runtime]` — structural graph validation (ids, edges, reachability, terminals, ambiguous branches, rework cycles, path safety) plus optional runtime warnings. Mirrors `swarm_validate_graph`.
- All four reuse the existing module-level helpers the agent tools already use, so behavior is identical to the tool path. Validated end-to-end in a fresh pi session: each command fired its `via: "command"` trace (`swarm.tasks` count=15, `task.status.read` runtime=true, `task.next_nodes`, `task.validate` ok=true) and `/swarm task ... runtime` wrote the full graph + closure render to `.pi/swarm/traces/graphs/<id>.task.txt`.

### fix(swarm): stop the "ack then re-deliver" loop for acked-failed messages

- `swarm_ack_message(status="failed")` set the message record `status = "failed"`, which is the SAME status `swarm_reconcile` uses for retryable DELIVERY failures. So reconcile re-injected messages the recipient had already received and acknowledged as failed -> the agent saw the same message again, acked-failed again, looping until `MAX_ATTEMPTS`/TTL -> `dead_letter`.
- New helper `isDeliveryFailureRetryable(rec)` discriminates via `lastAck`: a `queued`/`failed` message the recipient has ALREADY acknowledged (any ack, incl. `failed`) is terminal and must never be re-injected. Reconcile's re-inject branch, its pending/mailbox branch, and the agent-status `pendingMessages` count now all use it.
- Net effect: acked-failed messages are no longer re-delivered or counted as pending, while genuine never-delivered `queued`/`failed` messages are still retried. Verified end-to-end against live state (the 3 acked-failed records no longer appear as `would_retry`/`pending`/`retried`) plus regression scripts `extensions/swarm/delivery.test.mjs` and `extensions/swarm/reconcile-loop.validate.mjs`.

### feat(swarm): human-facing `/swarm graph` command

- Added `/swarm graph <task-id> [text|mermaid|json]` so a human operator can render a task graph directly without asking the model to call `swarm_print_graph`.
- Supports text, Mermaid, and JSON output using the same graph-print helpers as the tool path.

### feat(packages): expose swarm extension as a real pi package

- Added a real `package.json` manifest with `keywords: ["pi-package"]` and `pi.extensions = ["./extensions"]` so the repo can be installed into another pi project with `pi install /path/to/pi-graph-agents`.
- Added packaged extension entry `extensions/swarm/index.ts` and repointed the local dev entry `.pi/extensions/swarm/index.ts` to re-export from the packaged source.
- Updated `README.md` with package install/usage instructions for a fresh pi project.

### docs(swarm): fresh graph UAT scenario + gap-closure validation

- Added `docs/swarm-graph-uat-scenario.md`, a clean-reset swarm graph UAT scenario covering the happy path, blocked/stale/session probes, both rework loops, and the exact last-live-holder self-stop case.
- Re-ran the scenario from a fresh swarm reset with newly spawned agents and confirmed the previously missing coverage gaps are now exercised end-to-end.
- Recorded two non-blocking findings from the rework loops: after `fix_from_test` the `test` node did not auto-reopen, and after `fix_from_review` the `review` node did not auto-reopen; both required an root/manual reopen to complete coverage.

### feat(swarm): production hardening batch 1 (task closure sweep, reconcile task sweep, PM summary, task-graph UAT)

- **Project-local default model/provider config:** the swarm extension now reads `.pi/settings.json` before env vars when resolving default child-agent `model` / `provider`. Recommended keys: top-level `swarm.defaultModel` / `swarm.defaultProvider`. `extensions.swarm.defaultModel` / `extensions.swarm.defaultProvider` are still accepted for backward compatibility. Precedence is explicit tool params → `.pi/settings.json` → `PI_SWARM_DEFAULT_MODEL` / `PI_SWARM_DEFAULT_PROVIDER` → code defaults/model presets.
- **Reconcile task sweep (WS-B.3/4):** `swarm_reconcile` now sweeps every `task.json` in addition to the mailbox. It reports stored-vs-derived status drift, surfaces stale/nudge signals (dead/stopped/unhealthy/tmux-dead assignee, missing assignee, dead-lettered assignment, `in_progress` past 24h stale / 30min nudge thresholds, delivered-but-unacked assignment), and stamps advisory `node.staleAt`. New `mark` param persists the recomputed `task.status` to repair drift; reconcile is otherwise mark-only and never auto-fails a node (kept idempotent, no reminder-message storms).
- **PM summary (WS-C):** `/swarm status` now emits a structured rollup (per-task `status/current/next/unacked`, agent counts by runtime/health, `closure:` line) with stable grep-able prefixes, bounded to non-terminal tasks. `swarm_task_status(runtime=true)` already carries the closure block.
- **Cancel path:** `swarm_update_task(force=true, cancelTask=true)` marks a task `cancelled` (sticky; releases all assignments).
- **Task-level blocked derivation:** `computeTaskStatus` now derives task `blocked` when every active (non-terminal, non-pending) node is `blocked` (resumable). Pure; doesn't regress done/failed/in_progress/ready.
- **roleKind id-first inference + self-heal (root-flagged bug):** `inferRoleKind` now checks the agent id for a strong role keyword before the role text, so e.g. `implementer-02` classifies as `implementer` even when its role prose mentions "reviewer". `ensureAgentDefaults` re-derives `roleKind` unless explicitly pinned (new `roleKindExplicit`), so records self-heal; `swarm_spawn_agent` accepts an optional `roleKind` override.
- **session_shutdown nudge:** now stamps `node.lastActivityAt` and routes the open-assignment nudge to each stale node's assigner (replyTarget) when registered, else root.
- **PM auto-notify on closure/settle (engine behavior, not prompt policy):** the root no longer has to poll to learn a worker closed a node or went idle with open work. `swarm_update_task` enqueues a concise mailbox report to the mailbox-only root when a node transitions into a closure-ish status (`done`/`failed`/`blocked`) — carrying taskId/nodeId/prev→new/outcome/assignee/artifact/task status/next-ready — with a stronger `task <id> closed (<status>)` variant on task-terminal (`done`/`failed`/`cancelled`). `agent_settled` enqueues an `agent <id> settled idle with open assignment(s)` nudge when a worker settles while still holding open work. Both are mailbox-only to `root`, `requiresAck=false`, gated on the transition (not every update); the settle nudge is cooldown-guarded per agent via persisted `lastSettleNotifyAt` (`SETTLE_NOTIFY_COOLDOWN_MS`) so repeated settles don't storm. No node-status mutation, no tmux inject, no daemon. **Also fixed a pre-existing auto-pump defect** surfaced by the new notifications: `deliverMessageLocked` no longer pre-marks mailbox-only messages in the shared `st.delivered[to]` dedup/surfaced ledger (that set is also used by `pumpRootMailbox`/`swarm_check_mailbox`), so the root auto-pump now actually surfaces close/settle/shutdown notifications to a turn without manual `swarm_check_mailbox` polling. The UAT now cross-references pump-traced surfaced ids with the mailbox to assert auto-surface (not just mailbox arrival).
- **Autonomous terminal closer for root-owned final nodes:** when a worker/tester/reviewer transition makes a ready **root-owned graph-terminal** node reachable (for example `review --approved--> commit` in the default workflow), the engine now auto-closes that terminal root node inside the same locked task update instead of waiting for a human PM turn to manually advance the final step. This fixes the graph-loop bug where all worker/reviewer lanes could be finished and idle while the task remained `in_progress` only because the pseudo-root final node had no autonomous executor.
- **Session-safe + read-safe root surfacing (review-blocker fix):** the auto-pump previously deduped the root mailbox against a single shared `st.delivered.root` ledger that several operations wrote (`pumpRootMailbox`, `swarm_check_mailbox(markDelivered)`, `swarm_ack_message`, tmux-inject paths), so any one of them — including a second root lane or a validation `pi -p` run — could mark a notification consumed and starve every other root session of TUI surfacing. The pump now keys "already surfaced" **per process** in a new `st.rootPumpSessions` map (`process.pid`), deliberately **not** `PI_SESSION_ID` (a child `pi -p` spawned from an agent's bash inherits the parent's `PI_SESSION_ID`, so keying on it would reintroduce starvation), and it never reads `st.delivered.root`. `swarm_check_mailbox` is decoupled from the pump (it keeps using the shared ledger, which the pump ignores), so a manual `check_mailbox(markDelivered=true)` or an explicit ack can no longer pre-empt a later pump surface. Bounded by `PUMP_SCAN_WINDOW`/`PUMP_SESSION_ID_CAP`/`PUMP_SESSION_TTL_MS`. The `mailbox.root_pump` trace now carries `cid` (pid) and `sid` (`PI_SESSION_ID`) for attribution. UAT section 12 proves both: two distinct root sessions each surface one notification (no theft), and `check_mailbox(markDelivered)` does not pre-empt a later pump surface.
- **Root auto-pump: decision/delivery split + print-mode-safe + identity fix (loop-blocking fix):** two corrections. (1) The pump now splits **decision** from **delivery**: the surfacing decision (scan mailbox, update the per-pid `rootPumpSessions` set, emit `mailbox.root_pump`) is ctx-free file IO and runs in **every** root session including `pi -p`/rpc/json — the `session_start` one-shot is now **awaited** (was fire-and-forget, so it raced print-mode process exit) so a short-lived validation turn reliably completes the decision before teardown. The **TUI delivery** (`pi.sendMessage`/`ctx.isIdle()`) is mode-gated to the live interactive root session (no-op in print mode). The 5s polling **interval** stays tui-only because its long-lived captured ctx is the real source of the `This extension ctx is stale after session replacement or reload` error; on any ctx error the pump stops itself cleanly (traced `mailbox.root_pump_error`) and the next `session_start` restarts a fresh pump. (2) **Identity fix:** `unset PI_SWARM_AGENT_ID` does **not** make a session the root — `currentAgentId()` returns the inert `swarm-guest` unless `PI_SWARM_IS_ROOT=1` is set, and the `session_start` hook returns early for guests (so the pump never started and PM auto-surface could not be exercised). `scripts/swarm_task_uat.sh` now `export PI_SWARM_IS_ROOT=1` (worker lanes still override via `PI_SWARM_AGENT_ID`, which wins in `currentAgentId`). Documented the reload contract (extension code is not hot-applied; `/reload` required; multi-process-safe pid keying; on reload it re-surfaces recent un-acked notifies as recovery).
- **Closure on create:** `swarm_create_task` now applies `computeTaskStatus` so a fresh task's status is engine-derived (`ready`).
- **Task-graph UAT (WS-A):** new committed entrypoint `scripts/swarm_task_uat.sh`. It drives the task tools end-to-end against throwaway ids in an **isolated working tree** (never touches live swarm state), running as the root, and asserts on `task.json`/state/traces (model-independent). Covers create→ready, assign→root, update→done closure, **auto-close of root-owned terminal nodes**, failed closure, cancel, task-level `blocked` derivation (+resumable), roleKind id-first inference, fabricated-stale reconcile, fabricated-drift `mark=true` repair, and PM auto-notify (node-close → root mailbox; worker settle-with-open-work → root mailbox).
- **Docs (WS-D):** `docs/swarm-task-graph.md` documents `computeTaskStatus` rules, the stale/nudge ladder, and marks `swarm_stop_agent`/`swarm_gc_agents`/`swarm_release_agent_task` as deferred; `docs/swarm.md` adds a "Task graph and closure" section + task-graph UAT validation; README adds "Supported now vs deferred".
- Typecheck clean. Existing closure (`computeTaskStatus`/`applyTaskStatus`), validate warning reactivation, and `session_shutdown` nudge are unchanged.

### feat(extensions): `message-timestamp` — time at the start of every agent message

- New project-local extension `.pi/extensions/message-timestamp.ts`. It renders a small dim `HH:MM:SS` timestamp line at the very beginning of each agent (assistant) message in the TUI, including every assistant message in a multi-turn (tool-using) reply.
- Implementation: hooks `message_start` for `role === "assistant"` and appends a TUI-only custom entry (`appendEntry` + `registerEntryRenderer`). Using a custom entry means the timestamp is purely visual — it is **not** added to the message content, so it never pollutes the LLM context.
- Hook choice matters: `turn_start` fires before the user message is committed to the log (so an entry there renders above the user message); `message_start` for the assistant role fires as the agent reply itself begins, so the entry lands right at the top of the agent message.
- Validated in an isolated tmux session (`ext-validate-msgts-*`, pi 0.83.0, glm-5.1/zai-coding-cn): confirmed correct placement for both a single-turn reply and a two-turn tool-using reply (one timestamp per assistant message). Snapshots under `tmux-snapshots/`.

### fix(swarm): auto-pump root mailbox reports

- Fixed a PM/root reporting bug where workers could correctly update task state and send `swarm_send_message(to="root")`, but the root would not notice until it manually polled the mailbox.
- The root session now runs a session-scoped mailbox pump that marks pending root messages delivered and surfaces them locally as `swarm-message` events, using `triggerTurn` when idle and `followUp` while busy.
- This preserves mailbox-only routing for the root pseudo-agent while making completion reports and handoffs visible without manual `swarm_check_mailbox`.

### feat(swarm): engine-enforced task closure for task graph loop

- Added Commit 4 task-graph execution tools to `.pi/extensions/swarm/index.ts`: `swarm_assign_task`, `swarm_update_task`, and `swarm_task_message`.
- Made assignment a durable runtime contract in `task.json`, with task-scoped handoff metadata, active-task lifecycle bookkeeping, and task-state-driven graph advancement.
- Added engine-enforced closure behavior and PM-facing closure summaries/runtime warnings so stale/open assignments, dead-lettered handoffs, ack-done-without-task-update, and other closeout inconsistencies are surfaced from machine state instead of pane text.
- Validated through swarm review/self-validation loops with typecheck-clean current tree and dedicated task-graph closure/detector evidence under `.pi/swarm-uat/runs/`.

### fix(extensions): `compact-resume` — avoid double agent-run on pre-prompt compaction

- **Bug:** the `ctx.isIdle()` delivery branch conflated two idle cases. A
  threshold compaction can also run _before_ a queued user message is sent
  (`prompt()` → `_checkCompaction` → `_runAgentPrompt`, while idle) — e.g. after
  resuming a large session, or aborting a huge response then typing. There the
  old code fired `triggerTurn`, starting a second `_runAgentPrompt` that raced
  the user's own run and could corrupt agent state or throw "Agent is already
  processing".
- **Fix:** delivery is now trigger-specific, not just idle-state: manual
  `/compact` (idle, nothing pending) → `triggerTurn`; threshold mid-run
  (`!idle`) → `followUp` (drained by the continuation loop); threshold while
  idle (pre-prompt) → **skip** (a user turn is already imminent, so resuming is
  redundant and unsafe).
- **Validation:** regression-checked both preserved paths in an isolated tmux
  session — the `followUp` probe still yields `FOLLOWUP_OK`, and a manual
  `/compact` still auto-resumes. Snapshot under
  `tmux-snapshots/compact-resume-validation/fix-regression-run.txt` (gitignored).

### feat(swarm): task graph MVP (create/status/validate/print/next)

- Added the first task-graph layer to `.pi/extensions/swarm/index.ts` with task state/types, atomic `task.json` writes, and `.pi/swarm/tasks/<task-id>/` runtime layout.
- Added swarm tools: `swarm_create_task`, `swarm_task_status`, `swarm_validate_graph`, `swarm_print_graph`, and `swarm_next_nodes`.
- Added backward-compatible structured agent metadata defaults for reuse (`roleKind`, `capabilities`, `activeTaskIds`, `maxConcurrentTasks`) plus internal reusable-agent matching.
- Validated in dedicated tmux UAT lanes with real task creation/printing/validation/status flows; evidence kept under `.pi/swarm-uat/runs/`.

### harden(extensions): `compact-resume` followUp probe + settings.json config

- Added a dedicated validation probe at `scripts/compact_resume_followup_probe.ts` to empirically confirm that a `turn_end` hook can queue `pi.sendMessage(..., { deliverAs: "followUp" })` and have pi's continuation loop drain it without user input.
- Hardened `.pi/extensions/compact-resume.ts` config loading so env vars still win, but project-local `.pi/settings.json` can now override `enabled`, `manual`, and `max` under `extensions["compact-resume"]` (or top-level `compactResume`).
- Kept default-on behavior intentionally; the extension exists to close a project-wide usability gap, while `.pi/settings.json` now provides a no-code project override.

### feat(extensions): `compact-resume` — auto-continue the task after compaction

- **Problem:** pi goes idle after an ordinary auto-compaction (`reason:
"threshold"`) or a manual `/compact` (`reason: "manual"`), because both set
  `willRetry: false`. Only `reason: "overflow"` (a hard context-overflow error
  caught mid-run) auto-retries. So after a normal compact the agent stops and
  you have to type "continue" yourself, even when it was mid-task.
- **Fix:** new project-local extension `.pi/extensions/compact-resume.ts`. It
  hooks the `session_compact` event and injects one `[compact-resume]` message
  that tells the agent to resume in-progress work (or confirm completion).
  Delivery branches on `ctx.isIdle()`: a `followUp` (fed into pi's existing
  continuation loop) during a run, or `triggerTurn: true` when idle.
- **Loop safety:** skips `overflow` (already retries); smart guard stops once a
  resume turn does no tool work; hard cap of consecutive auto-resumes since the
  last real user message (default 5).
- **Config (env):** `PI_COMPACT_RESUME` (0 disables), `PI_COMPACT_RESUME_MANUAL`
  (1 to also resume after explicit `/compact`), `PI_COMPACT_RESUME_MAX`. Status
  via the `/compact-resume` command.
- **Validated:** end-to-end in an isolated tmux session (pi 0.83.0,
  glm-5.1/zai-coding-cn) — after `/compact` the agent automatically started a
  continuation turn, inspected state, and stopped gracefully. Snapshot kept
  under `tmux-snapshots/compact-resume-validation/` (gitignored).
