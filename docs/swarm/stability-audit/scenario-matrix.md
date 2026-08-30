# Stability-audit scenario matrix (strict)

Mandate: every swarm feature must be audited via mock-LLM fixtures. This matrix extends the feature inventory (inventory-master.md) with **cross-cutting failure & communication scenarios** that single-feature fixtures cannot cover alone.

## Contract for every scenario

A scenario = **fixture (agent-side script)** + **lane choreography (harness-side actions/time)** + **state assertions (pass criteria)**. A fixture alone is NOT a scenario. Evidence = transcript + swarm-state/trace inspection after the lane runs.

Rules:
- Fixtures replay only what the LLM would emit (text/toolcall/thinking/error/hang/stop, delayMs timing, lowercase tool names).
- Harness verdicts (idle/stale/reassign/supersede/dead-letter/escalation) are driven by the REAL swarm extension in the lane with real time constants — never scripted.
- Every hang event MUST have an abort path in the choreography (timeout --signal=INT wrapper or explicit abort).
- Honest failure > fake pass: if a scenario cannot be set up deterministically, the report says so.

## A. Provider failure modes (agent-side scripted via error events)

| ID | Scenario | Fixture | Choreography | Pass criteria |
|---|---|---|---|---|
| S1 | All providers 429 (quota exhausted everywhere) | `quota-exhausted-all-turns.jsonl` — every turn = single 429 error event | Run 3 turns in agent lane; keep assignment open; run reconcile | Agent NOT marked failed/settled spuriously; assignment intact; no state corruption; transcript shows 3 provider errors, not silent hang |
| S2 | 429 storm then quota recovery | `quota-429-then-recovery.jsonl` — turns 1-2 = 429 errors, turn 3 = ack + result toolcall + stop | Run 3 turns; then verify response credit | Work resumes cleanly; result credited once; no duplicate processing after recovery |
| S3 | 429 mid-edit partial state | EXISTS: `429-mid-edit.jsonl` | existing | existing |
| S4 | Malformed/torn stream mid-task then recovery | `torn-json-then-recovery.jsonl` — turn 1 = torn-json error mid-toolcall, turn 2 = clean retry turn | Run 2 turns | Terminal error emitted (not crash); retry turn succeeds; transcript shows error→recovery |

## B. Stale/dead agents with open work (harness-side choreography)

| ID | Scenario | Fixture | Choreography | Pass criteria |
|---|---|---|---|---|
| S5 | ALL agents stale, tasks NOT done | `stale-all-agents.jsonl` — turn 0 = normal accept+processing ack, then script ends | Spawn 2 worker lanes, let them ack, then KILL both panes; wait past attention/stale windows; run swarm_reconcile; inspect task + traces | Dead/missing panes detected; nodes surfaced (staleAt/blocked-visible); assignments released or flagged; orchestrator notified via trace; NO auto-success, NO fabricated evidence |
| S6 | Agent dies mid-node (in_progress) | `inprogress-death.jsonl` — turn 0 = update_task in_progress + ack | Kill pane after turn 0; wait; reconcile | Node stays in_progress + stale-flagged (not auto-closed); reassign candidate surfaced; evidence not stamped |
| S7 | Assignment injection to dead pane | none (orchestrator-side) | Kill worker pane; send assignment via swarm_assign_task; observe delivery retries; inspect dead letters | Failed injection retried then dead-lettered/intercepted with record; no silent drop; reconcile surfaces it |
| S8 | response-required worker dies before result | `response-required-death.jsonl` — turn 0 = seen+processing acks only | Kill pane after turn 0; wait past REMINDER_NO_PROGRESS_MS; observe escalation chain | response_missing escalation fires: blocking + reminder thread; final verdict (abort/dead-letter) WITHOUT false credit; thread records the attempt honestly |

## C. Task-graph multi-agent communication

| ID | Scenario | Fixture | Choreography | Pass criteria |
|---|---|---|---|---|
| S9 | Node handoff chain | `handoff-chain.jsonl` (2 roles: A closes with artifact, B receives + acks) | Two lanes on one task graph A→B; drive A done; observe handoff message + B turn | Handoff recorded with taskId/fromNode/toNode/artifactRefs; B's ack credits the thread; B node advances only via its own update |
| S10 | Parallel nodes, one fails | `parallel-fail-a.jsonl` (A fails honestly), `parallel-fail-b.jsonl` (B succeeds) | Two parallel nodes A,B feeding gate G; run both; inspect gating | G waits correctly for both verdicts; failed A does not corrupt B; downstream reflects failure branch, not fake success |
| S11 | Reassign after stale release; old agent resurrects | reuse `assignment-fence-stale-attempt.jsonl` (batch 1) as resurrected-agent side | S5-style kill + release; assign node to fresh agent; re-inject stale agent pane; let it attempt stale update | Stale update fenced (ASSIGNMENT_SUPERSEDED-equivalent); fresh assignee unaffected; trace shows arbitration |
| S12 | Supersession arbitration race | `supersession-race-old.jsonl`, `supersession-race-new.jsonl` | Two lanes attempt update on same node with different attemptIds | Exactly one wins; other fenced; evidence/outcome recorded from winner; no double-close |
| S13 | Assignment arrives mid-turn | `midturn-assign.jsonl` — long turn 0 (text+toolcall+delay), turn 1 reads mailbox + acks | Inject assignment while turn 0 streaming | Turn 0 completes uninterrupted; message visible next turn; no lost injection |
| S14 | Shared-context concurrent updates | `shared-context-a.jsonl`, `shared-context-b.jsonl` (different context keys) | Two nodes update sharedContext concurrently | Both updates merged, no lost keys; order deterministic under lock |
| S15 | Commit-node evidence integrity | `commit-no-evidence.jsonl` — attempts terminal close on commit-like node without git evidence | Prepare fake commit-like node; run update; inspect | Close blocked with honest error demanding evidence; no bypass; when evidence exists (baseline commit) close succeeds |

## Priority order

1. S1, S2, S5, S7, S8 — quota exhaustion + stale-with-open-work (user-mandated core)
2. S11, S12, S13 — arbitration/interception correctness
3. S6, S9, S10, S15 — graph communication integrity
4. S4, S14 — resilience polish

## Mapping to inventory features

S1/S2/S4 → F17 (pool) + F8; S5–S8 → F4/F5/F24; S9–S15 → F1/F2/F3/F10/F12.

## Open constraints (honest)

- Time-window scenarios (S5–S8) need shortened constants in a scratch swarm state or a test-only override documented in the report — env-var config is disallowed by user policy, so use dedicated scratch `.pi` dirs (like row76 validate script did).
- S7 has no agent-side fixture: it is pure harness choreography; its evidence is delivery/trace records, not transcripts.
