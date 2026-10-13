# Plan: Idle-agent GC nudge — root-nudged reclamation of idle-but-running workers + agentGc config scaffold

> **Status:** RED phase (2026-10-13). Plan artifact written before any source change.
> **Mode:** root nudged only — the root LLM decides and calls `swarm_stop_agent` itself. NO auto-kill anywhere. `/swarm` slash commands are user-run-only and are never named in a nudge body (the root agent cannot execute them).
> **Terminal-manager agnostic:** tmux | herdr | mock. All liveness rides the existing driver-agnostic heartbeat-GC evidence (`tmuxAlive` field + probe ledger); this feature adds ZERO new terminal subprocess calls. Field names keep the historical `tmux*` spelling for state compatibility.

## 0. Problem

After long swarm sessions, workers whose tasks are done stay `status:"running"` with an idle runtime forever: pane/process alive, memory burned, nobody notified. Existing machinery:

| Existing | File | Gap |
|---|---|---|
| Heartbeat GC | `nudges/heartbeat-gc.ts` | Only labels `health:"stale"` (gate 3) or flips known-dead panes to `stopped`. Never tells root about the healthy-pane idle zombie. |
| Task-close sweep | `taskgraph/sweep.ts` | Runs only at task terminal transition; shared-pool workers never swept. |
| Stopped-record GC | `agent-gc.ts` / `agent-gc-auto.ts` | Purges stopped RECORDS only (and auto mode is OFF + un-scaffolded). Nothing stops the agent in the first place. |

## 1. Contract

**1.1 Nudge evaluator** — new module `extensions/swarm/src/nudges/idle-agent-gc.ts`:

```
evaluateIdleAgentGcNudgeLocked(pi, cwd, p, st, nowMs)
```

Runs as a pump maintenance phase in `surface/pump-phases.ts` (after heartbeat GC, before the stale-open scan — heartbeat GC freshly flips dead panes, we only target still-running records).

Eligibility per non-root agent (ALL must hold):
- `status === "running"` && `runtimeStatus === "idle"`
- heartbeat age > `afterMs` (default `PI_SWARM_IDLE_GC_AFTER_MS` / config 1_200_000 = 20′ — 2× the heartbeat stale window; no heartbeat field at all counts as infinite age)
- `activeTaskIds.length === 0` — never nudge about a worker with a live assignment
- no valid `reuse`/`park` lease (`leaseKind` set AND `leaseUntil > now`) — reuse pools and parked panes are intentional
- `paused !== true`
- no open graph node assigns it (`isTaskReferenced(agentId, taskGraphs)` from `agent-gc.ts` — same non-terminal-assignee closure the purge gate uses)

Per-agent cooldown/cap state on `SwarmState.idleGcNudgeState[agentId]` (new optional field, mirrors `taskStallState`): `{ nudges, lastNudgeAt, nudgedAt?: string[] }`.
- `cooldownMs` default 1_800_000 (30′): a second nudge for the same agent waits for cooldown.
- `maxNudges` default 3: at cap the evaluator stops nudging for that agent and emits trace `agent.idle_gc.cap` ONCE (`suppressed: true`).
- Global min-interval for the whole scan: `intervalMs` default 60_000, state `st.idleGcNudgeState._lastScanAt` (underscore key never used as an agentId — ids are safeId-validated lowercase alnum+-+_).
- Config `idleNudge.enabled: false` (or env `PI_SWARM_IDLE_GC_NUDGE_OFF=1`) disables the phase entirely (trace once per process: `agent.idle_gc.disabled`).

**1.2 Nudge message** — via `deliverMessageLocked(pi, cwd, p, st, {...})` (L1 durable; L2/L4 crossing is the existing pump-delivery path, same as task-stall/goal nudges):
- `to: "root"`, `priority: "normal"`, `requiresAck: false` (root acts via tools; an un-acked nudge must not dead-letter).
- `idempotencyKey` = `formatNotifyKey(NOTIFY_KEY_IDLE_GC_NUDGE, { agentId, seq })`; seq = global monotonically increasing per agent (`state.nudges + 1`). Key template: `agent:{agentId}:nudge:idle-gc:{seq}` (new constant).
- Subject: `Idle agent GC: ${agentId} idle ${humanAge} — reclaim it?`
- Body names ONLY LLM-callable tools:
  - `swarm_stop_agent(agentId="${agentId}")` — kill pane + mark stopped (mailbox/history persist)
  - `swarm_assign_task` — if the worker should be doing something instead
  - fact that stopped records auto-purge later (age-gated, `agentGc.auto` or `/swarm deregister --purge-stopped` as USER action — phrased as operator-side info, not an instruction to root)
- Zero raw filesystem paths in the body (de-path rule). Trace `agent.idle_gc.nudge_emitted` with `{ agentId, idleMs, nudgeSeq, key }`.

**1.3 R10-1** — the only new Pi-runtime crossing is `deliverMessageLocked`'s existing `pi.sendMessage` inside mailbox delivery. R10-1 counting test asserts: `sendMessageCalls === nudges` (1:1, no alternate sinks) and `=== 0` when disabled/capped/cooldown-gated.

**1.4 Config** — `agentGc` section (already a recognized key; currently parsed only for `auto`/`stoppedOlderThanMs`):

```yaml
agentGc:
  auto: false                  # purge stopped records >=24h (existing, default OFF)
  stoppedOlderThanMs: 86400000
  idleNudge:
    enabled: true              # ON by default
    afterMs: 1200000           # 20' idle before the root is nudged
    cooldownMs: 1800000        # per-agent cooldown between nudges
    maxNudges: 3               # per-agent cap, then suppress + cap trace
    intervalMs: 60000          # whole-scan throttle
```

Precedence: project `.pi/swarm.yml(.yaml)` > global `~/.pi/agent/swarm.yml(.yaml)` > defaults (existing `mergeSwarmConfig` layering). Non-numeric / negative values silently fall to defaults (same tolerance as `stoppedOlderThanMs`). Env overrides: `PI_SWARM_IDLE_GC_AFTER_MS`, `PI_SWARM_IDLE_GC_COOLDOWN_MS`, `PI_SWARM_IDLE_GC_MAX_NUDGES`, `PI_SWARM_IDLE_GC_INTERVAL_MS`, `PI_SWARM_IDLE_GC_NUDGE_OFF=1`.

**1.5 Scaffold** — `agentGc` joins the existing placeholder templates; NO new scaffold engine:
- `POOL_SCAFFOLD_YML_PLACEHOLDER` and `POOL_SCAFFOLD_GLOBAL_YML_PLACEHOLDER` (constants.ts) gain a commented `# --- Agent GC (optional; defaults shown) ---` block documenting all five idleNudge keys + auto/stoppedOlderThanMs.
- Templates stay comments-only (parse-to-null invariant preserved: scaffold files never activate anything).
- Existing `ensurePoolScaffold` / `ensureGlobalPoolScaffold` skip paths unchanged (a file that already exists is never rewritten — projects created before this change simply don't see the new commented block, which is fine: defaults are active without any file). The per-section "inherits from global when unset" behavior is the existing `mergeSwarmConfig` semantics, unchanged.
- `readAgentGcConfig` (agent-gc-auto.ts) extended with the `idleNudge` sub-config + env overrides.

## 2. Files

| File | Change |
|---|---|
| `extensions/swarm/src/nudges/idle-agent-gc.ts` | NEW — evaluator (pure gate logic + deliver + trace) |
| `extensions/swarm/src/surface/pump-phases.ts` | wire phase 7 (after heartbeat GC, try/caught, trace on error) |
| `extensions/swarm/src/nudges/graph-advance.ts` | re-export |
| `extensions/swarm/src/constants.ts` | `NOTIFY_KEY_IDLE_GC_NUDGE`, 4 idle-GC env-overridable constants + 2 trace names |
| `extensions/swarm/src/agent-gc-auto.ts` | `readAgentGcConfig` returns `idleNudge` section |
| `extensions/swarm/src/types/state.ts` | `SwarmIdleGcNudgeState` + `SwarmState.idleGcNudgeState?` |
| `extensions/swarm/src/pool-scaffold.ts` | (no logic change) |
| `extensions/swarm/src/constants.ts` | 2 scaffold templates gain the commented agentGc block |
| `docs/swarm/tools.md` + `extensions/swarm/README.md` | config + module-map rows |
| `CHANGELOG.md` | entry after green |

## 3. Fixtures (compulsory, mock-llm)

- **`extensions/mock-llm/fixtures/idle-agent-gc-nudge.jsonl`** (Pattern 2 — seeded world, single actor = root):
  scratch state seeds `worker-idle` (running/idle, heartbeat 30′ old, no tasks, no lease) + `worker-busy` (running/busy w/ activeTaskIds) + `worker-leased` (reuse lease valid) + `worker-paused`. Scripted root turn: acknowledges the idle-GC nudge in its mailbox and calls the real `swarm_stop_agent(agentId:"worker-idle")`. Asserts: nudge message exists in root mailbox with the right idempotencyKey family; only worker-idle was named; stop result says stopped; busy/leased/paused untouched.
- **`extensions/mock-llm/fixtures/agent-gc-scaffold.jsonl`** (fixture-sanity only): root turn calls `swarm_agent_status {}` — the scaffold lane test drives the real scaffold functions directly (pure file-shape assertions, no LLM behavior needed).

## 4. RED tests (written first, observed red before implementation)

1. **`extensions/swarm/tests/idle-agent-gc.test.mjs`** (pure + seeded-state, pattern `agent-stopped-gc.test.mjs`):
   - module exists + exports evaluator (RED: import fails)
   - eligibility matrix: idle-idle-eligible / busy skipped / leased skipped / paused skipped / task-referenced skipped / stale-heartbeat (hb fresh → not eligible)
   - cooldown: second call within cooldownMs → no second nudge; after cooldown → next seq nudge
   - cap: nudges 1..3 fire, 4th suppressed + single cap trace
   - R10-1: `sendMessageCalls === nudges`, zero sends when disabled
   - body hygiene: subject names agentId; body contains `swarm_stop_agent`; body contains NO `/swarm ` and NO `.pi/` path
2. **`extensions/mock-llm/tests/idle-agent-gc.test.mjs`** (fixture lane, pattern `mock-llm/tests/agent-stopped-gc.test.mjs`): replay through REAL registered `swarm_stop_agent`; seeded-state asserts.
3. **`extensions/swarm/tests/agent-gc-config.test.mjs`**: `readAgentGcConfig` defaults; project > global; invalid values → defaults; scaffold templates still parse to null + contain the agentGc block.

## 5. Validation lane (tmux, per AGENTS.md)

Dedicated session `ext-validate-idle-gc-<hhmmss>`; `pi --provider mock-llm --model idle-agent-gc-nudge -e ./extensions/mock-llm -e ./extensions/swarm` in a scratch cwd; capture before/after pane; cite `.pi/mock-llm/transcripts/idle-agent-gc-nudge/`.

## 6. Out of scope

- Auto-stop of idle agents (explicitly rejected — root decides).
- Extending heartbeat GC gate 3 beyond labeling.
- Turning `agentGc.auto` ON by default.
- Renaming `tmuxAlive`/`isTmuxRunning` (state-file compatibility).
