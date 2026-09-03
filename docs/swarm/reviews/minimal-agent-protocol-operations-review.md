# Operations / migration review — minimal-agent-protocol-proposal.md

**Reviewer role:** `protocol-ops-reviewer` (operations, migration, telemetry, UAT)
**Artifact under review:** `docs/swarm/minimal-agent-protocol-proposal.md` (Revision v3 — normative §§A–K)
**v1 review:** 2026-08-28 (5 conditions + 27 findings + 10-row UAT matrix; verdict APPROVE WITH CONDITIONS)
**v2 review:** 2026-08-28 (4/5 conditions closed; verdict APPROVE WITH CONDITIONS; 7 D-conditions raised)
**Date of v3 sign-off:** 2026-08-28
**Scope constraint:** operations, migration, telemetry, UAT, rollout. NOT a code/proposal change. NOT an authority/permission or architecture verdict (other reviewers own those; UX §J bindings are referenced but not re-reviewed here).

---

## Verdict (v3 sign-off)

**APPROVE.**

All 7 v2 D-conditions are closed in v3. The §K operational bindings and the §2.2 corrected root count (12 distinct tool names / 13 capabilities) are operationally precise and ready to land in the implementation gate. No new blockers. One minor observation (E-1) for the implementation gate.

The proposal is safe to implement under the existing per-issue release-gate discipline (`docs/swarm/reliability-execution-plan.md`).

---

## 1. D-condition tracking (v2 → v3)

| ID | v2 condition | v3 location | Status |
|---|---|---|---|
| D-1 | Worker reconcile rate budget + `scope:"self"\|"all"` | §E Worker row: `PI_SWARM_RECONCILE_DRYRUN_WORKER_RATE_MS` (default 60000), `scope:"self"` enforced; §K.1 binding | **CLOSED.** Both rate budget and scope are specified; "returns a rate-limit error rather than running an unbounded sweep" is the right fallback. |
| D-2 | `currentNodes` cache-then-remove plan | §I item 4: "Phase 2 keeps `currentNodes` as a write-through compatibility cache… Phase 3 removes its writes/readers only after all consumers use the derived status projection" | **CLOSED.** Phased plan explicit; preserves `flow-dialog.ts:410` reader and 6 write sites in `tools/tasks.ts`. |
| D-3 | Derived-attention trace event name | §K.2: `message.attention.derived` with `source: "responseDeadlineMs" \| "transportStale" \| "legacyAckMissing"` + identity fields + timestamp; "consumer-facing category" role is correct | **CLOSED.** Naming is consistent with the existing `message.response.sent` / `message.superseded` family. |
| D-4 | 5-site identity-card regeneration completeness | §K.3: "update all five explicit-ACK instruction sites: four identity-generation sites and the `formatSwarmMessageContent` runtime body in `delivery.ts`. Gate=1 worker messages must not render `[PI-SWARM ACK REQUIRED]`; legacy gate=0 messages retain it." | **CLOSED.** All 5 sites enumerated; per-gate behavior specified (gate=0 retains, gate=1 removes). |
| D-5 | Alias-window alignment | §F.3: "Keep aliases in admin/compatibility mode for the same two-stable-release window defined in §D" (covers `swarm_print_graph`); §K.4: "`swarm_next_nodes` and `swarm_print_graph` compatibility aliases stay available for the same two-stable-release window" | **CLOSED.** Both aliases now aligned to the §D two-stable-release window. |
| D-6 | §2.2 update to 13-tool root profile | §2.2 comment: 5 worker + 5 additional orchestration tools + 2 goal tools = **12 distinct tool names** (or 13 capabilities counting reconcile modes separately) | **CLOSED.** The 12-distinct / 13-capabilities split is the right framing — `swarm_reconcile` is one registration with role-dependent execution mode, but its dry-run vs mutation modes are genuinely different capabilities. |
| D-7 | 10×2 model UAT matrix | §H last paragraph: "Run all ten scenarios in **both** required model/provider lanes: `glm-5.1` / `zai-coding-cn` and `gpt-5.4-mini` / `openai`. This is a 10×2 UAT matrix; report results independently by lane." + §I.5 | **CLOSED.** Both lanes explicit; independent reporting required. |

## 2. v2 condition partial close

| ID | v2 partial | v3 location | Status |
|---|---|---|---|
| C4 partial | Derived-attention trace event name | §K.2 (D-3 above) | **CLOSED.** |

All v1 conditions (C1–C5) are now fully closed.

## 3. Verification against current code

| v3 claim | Source-of-truth | Verified |
|---|---|---|
| 12 distinct root tool names | Worker 5 + orchestration 5 + goal 2 = 12 | YES — §2.2 corrected math |
| `swarm_reconcile` is one tool, role-dependent execution | `tools/messages.ts:188-208` (single registration, `dryRun` parameter) | YES |
| `swarm_reconcile(mark=true)` is root-gated today | `reconcile.ts:1121` (`requireRootAuthority`) | YES |
| 5-site identity regeneration: 4 in `identity.ts` + 1 in `delivery.ts` | `identity.ts:129-151` (4 sites) + `delivery.ts:31` (1 site) | YES — v3 specifies exactly these 5 |
| `task.currentNodes` is durable on `TaskState` | `types.ts:559` | YES — Phase 2 cache plan is correct |
| 6 `task.currentNodes` write sites | `tools/tasks.ts:70,81,86,212,399,578,783` | YES — Phase 3 removal requires editing all 6 |
| `task.currentNodes` reader is `flow-dialog.ts:410` only | `grep -n currentNodes` confirms | YES |
| `consumerReceipts` migration precedent exists | `reconcile.ts:789-825` | YES — the §D migration tool follows this precedent |
| `formatNotifyKey` and `SAFE_ID_RE` semantic-dedupe key convention | `constants.ts:113-119` | YES — `message.attention.derived` does not need a dedupe key (it's an event, not a notification) |
| Module-load env-var pattern | `PI_SWARM_ORPHAN_TIMEOUT_MS`, `PI_SWARM_MAX_NUDGES`, `PI_SWARM_MAX_TASK_STALL_NUDGES` all read at module load (`constants.ts:159, 181, 195`) | YES — `PI_SWARM_MINIMAL_PROTOCOL` and `PI_SWARM_RECONCILE_DRYRUN_WORKER_RATE_MS` follow the same pattern |
| `/swarm protocol migrate [--dry-run]` is new (not in current code) | `grep -rn swarm_protocol` returns nothing | YES — implementation requirement |
| §K.3 exact worker-tool set binding | Current `tools/gating.ts:33-43` already implements identity-based gating via `setActiveTools` | YES — the §K.3 binding is enforceable by the existing mechanism |

## 4. Implementation-gate observation (non-blocker)

**E-1 (non-blocker).** §K.1 specifies `scope: "self" | "all"` for `swarm_reconcile`. The current `swarm_reconcile` tool parameter set (`messages.ts:194-198`) does NOT include a `scope` field. The implementation gate must add `scope` to the tool's `parameters` schema with the default value depending on caller identity:

- Caller is `worker-*` (any non-root agent): default `scope: "self"`; any other value rejected with `SCOPE_FORBIDDEN`.
- Caller is `root` or admin: any value accepted.

The current `reconcile()` function (`reconcile.ts:1085`) takes an `agentId` parameter that already implements `self`-style filtering when set. The `scope: "self"` path should reuse this parameter internally (set `agentId: currentAgentId()`). The `scope: "all"` path leaves `agentId` unset.

This is a small follow-on that the implementation gate should not miss. Non-blocker because it's a clear contract; the alternative (parameterless self-only behavior for workers) would also satisfy the §K.1 contract.

---

## 5. Final summary

**Verdict restated:** **APPROVE.**

The Revision v3 normative section is operationally complete. The §K operational bindings close every v2 D-condition; the §2.2 corrected tool count resolves the v2 D-6 numerology question correctly (12 distinct registrations, 13 capabilities if you split reconcile modes); the §H + §I 10×2 UAT matrix is the right compliance posture for the headline acceptance criterion. The v3 plan is ready for the implementation gate under the per-issue release-gate discipline.

**All five v1 conditions (C1–C5) closed.**
**All seven v2 D-conditions (D-1–D-7) closed.**
**Zero remaining blockers.**
**One non-blocker observation (E-1) for the implementation gate.**

**Recommended next step:** the root launches the per-issue execution queue per `docs/swarm/reliability-execution-plan.md`. Issue 25 (this proposal's implementation) tracks five work items per §I. Phase 1 ships behind `PI_SWARM_MINIMAL_PROTOCOL=0`; Phase 2 flips the gate; Phase 3 (after two stable releases) deprecates `requiresAck`. The §H 10×2 UAT matrix and the §K operational bindings are the release-gate checklist.

---

## 6. Cross-references (v3)

- v3 schema/evidence mapping: §A (10-row table)
- v3 terminal rules: §B
- v3 deadline/TTL/attempt ladder: §C
- v3 gate + migration: §D
- v3 role profiles: §E (5 worker / 12 distinct / 13 capabilities root)
- v3 consolidation details: §F (incl. §F.3 two-release alias alignment)
- v3 telemetry/acceptance: §G
- v3 UAT matrix: §H (10×2 model lanes)
- v3 work breakdown: §I (5 items; §I.4 phased currentNodes; §I.5 two-lane UAT)
- v3 UX bindings (referenced, not re-reviewed): §J (single critical section, durable assignment token, exact worker-tool UAT assertion, migration idempotence UAT, `/swarm protocol migrate` command, non-task terminal contract)
- v3 operations bindings: §K (5 items; D-1..D-7 closures)

Existing source-of-truth anchors (unchanged):
- `extensions/swarm/src/types.ts:130-170` (`MessageRecord`)
- `extensions/swarm/src/types.ts:559` (`task.currentNodes` durable)
- `extensions/swarm/src/tools/tasks.ts:70,81,86,212,399,578,783` (`currentNodes` write sites)
- `extensions/swarm/src/flow-dialog.ts:410` (`currentNodes` reader)
- `extensions/swarm/src/reconcile.ts:1083-1280` (dead-letter + retry + reinject + ack_missing ladder)
- `extensions/swarm/src/reconcile.ts:1121` (`requireRootAuthority` for `swarm_reconcile(mark=true)`)
- `extensions/swarm/src/tools/messages.ts:69-78` (supersede guard)
- `extensions/swarm/src/tools/messages.ts:188-208` (`swarm_reconcile` registration, single tool with `dryRun` parameter)
- `extensions/swarm/src/tools/gating.ts:33-43` (`setActiveTools` identity gating)
- `extensions/swarm/src/identity.ts:129-151` (4 explicit-ACK identity sites)
- `extensions/swarm/src/delivery.ts:31` (`[PI-SWARM ACK REQUIRED]` runtime body)
- `extensions/swarm/src/constants.ts:113-119, 159, 181, 195` (`formatNotifyKey` + module-load env-var pattern)
- `extensions/swarm/src/reconcile.ts:789-825` (`consumerReceipts` migration back-fill precedent)
- `docs/swarm/reliability-execution-plan.md` (per-issue release gates, UAT protocol)
