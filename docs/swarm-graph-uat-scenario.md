# Swarm Graph UAT Scenario

## Goal
Validate a fresh swarm-graph run from clean state, covering both the happy path and critical recovery/runtime edge cases.

## Fresh swarm baseline
- Old swarm tmux sessions killed.
- Old swarm agent records removed.
- `.pi/swarm/` and `.pi/swarm-uat/` reset.
- A new orchestrator-led swarm will be spawned from this clean baseline.

## Agent set
- `planner-new`: plans scenario execution and drives graph-shape sanity.
- `implementer-new`: performs implementation/fix nodes when assigned.
- `tester-new`: runs scenario/UAT steps and records evidence.
- `reviewer-new`: reviews outcomes and checks graph/runtime semantics.

## Primary conversation flow
1. Orchestrator creates the UAT task graph.
2. `planner-new` completes `plan` with the intended path + edge coverage map.
3. `implementer-new` completes `implement`.
4. `tester-new` completes `test` on the happy path.
5. `reviewer-new` completes `review`.
6. Orchestrator completes `commit`.
7. Separate scenario nodes exercise failure/recovery branches below.

## Edge cases to verify

### A. Happy path / closure
1. `plan -> implement -> test -> review -> commit` succeeds.
2. Task auto-closes only when all graph-terminal nodes are terminal.
3. Success artifacts exist for each success node.

### B. Rework loops
4. `test --failed--> fix --implemented--> test` loops correctly.
5. `review --rejected--> fix --implemented--> review` loops correctly.
6. `maxAttempts` enforcement stops infinite rework.

### C. Blocking / clarification
7. A node can move to `blocked` with a clarification reason.
8. After unblock/reassignment, the same logical work resumes and downstream nodes stay unready until the node is terminal.

### D. Message vs graph state correctness
9. An agent sending an artifact/result message without `swarm_update_task(... status=done ...)` must NOT advance the graph.
10. Message ACK alone must NOT advance the graph.
11. `swarm_next_nodes` readiness must depend on task state, not mailbox state.

### E. Agent death / stale handling
12. Assigned agent shuts down mid-node -> node gets `staleAt`, task stays open, orchestrator gets a nudge.
13. Agent settles idle while still holding an open node -> nudge/reconcile path is visible.
14. Reassigning a stale node works and preserves graph correctness.
15. **New required case:** graph is NOT done but all assigned agents are stopped -> task must NOT auto-close; stale nodes must be surfaced; orchestrator must get nudges for the nodes whose agents stopped before updating graph state.

### F. Session/read safety
16. Guest session without explicit orchestrator opt-in must NOT consume/surface orchestrator traffic.
17. `swarm_check_mailbox(markDelivered:true)` must NOT suppress orchestrator surfacing for the live PM session.
18. PM reload/restart must restore fresh-code pump behavior and preserve surfacing.

### G. Agent routing / role behavior
19. Role matching picks the correct agent kind for assignment.
20. No-available-agent / stopped-agent cases trigger explicit fallback: reuse, respawn, or reassign.
21. Agents should perform only their assigned node/task scope.

## Expected pass criteria
- No false graph advancement from mailbox-only activity.
- No false task closure while non-terminal nodes remain.
- All recovery cases produce explicit stale/nudge/reassign signals.
- Fresh PM session surfaces orchestrator-directed notifications correctly.
- Final success path closes the task with `storedStatus == derivedStatus == done`.

## Execution order
1. Spawn fresh swarm agents.
2. Run happy-path task once end-to-end.
3. Run targeted edge scenarios in controlled order:
   - test fail rework
   - review reject rework
   - blocked/unblock
   - artifact-without-update
   - shutdown/stale/reassign
   - all-agents-stopped-before-done
   - guest/read-safe/reload
4. Reviewer signs off only if graph state and runtime state agree.
