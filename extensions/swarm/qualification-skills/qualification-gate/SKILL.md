---
name: qualification-gate
description: Prepare, challenge, and audit a lean qualification gate before swarm task execution. Use when creating a swarm task, reviewing its success criteria, or deciding auto versus human-discuss qualification. Intended for swarm root, reviewer, and auditor; implementers receive the frozen gate rather than this playbook.
---

# Qualification Gate

Use this skill **when a task is created**, before assigning source-changing implementation work. The gate is a short artifact at `artifacts/qualification-gate.md`, not a new process subsystem.

## Pick the mode

- **`auto`** — request is clear and low-risk. Root drafts; one reviewer/auditor challenges it; root records the revised gate. Limit to one draft → challenge → revision cycle.
- **`human-discuss`** — user outcome, scope, UX/API behavior, risk acceptance, or a trade-off is unclear. Draft and challenge first, then ask the human only the decisions they own. Do not assign implementation until the root records confirmation with `swarm_confirm_qualification`.

When unsure, choose `human-discuss`.

## Draft procedure (root)

1. State the requested user outcome in one observable sentence.
2. List 3–7 **hard gates**: facts that must be true to call the task successful.
3. For each gate, name evidence: command/test, mock-LLM fixture/transcript, inspection checklist, or human decision.
4. Add one negative/failure or regression case where relevant.
5. State scope/non-goals and unresolved questions.
6. In `auto`, send the draft to an auditor/reviewer for a bounded challenge; revise once.

Do not write activities as gates (bad: “write tests”). Write outcomes (good: “a stale update is rejected and a normal update still works”).

## Evidence choice

- **Script/test** — deterministic behavior that can be asserted.
- **Mock-LLM fixture + transcript** — any changed behavior under `extensions/swarm/`; fixture must reach the changed agent-facing path.
- **Checklist / independent review** — documentation, UX wording, evidence relevance, and whether proof matches user intent.
- **Human discussion** — product choices, visible behavior, scope, and accepted risk.

Project rules remain hard gates when applicable: bug fixes start with a red reproduction; swarm changes ship a mock-LLM fixture; Pi-runtime boundary changes consult the runtime contract and add the required real-boundary assertion; extension behavior is validated in fresh pi/tmux.

## Auditor challenge

Reject or request revision when:

- a gate is vague, merely an implementation step, or could pass while user intent fails;
- evidence is missing, stale, or does not exercise the claimed behavior;
- no regression/negative case exists where one is plausible;
- a user-owned trade-off is silently assumed;
- required project evidence is omitted.

Record concrete findings: file/claim, consequence, and fix proposal. Do not expand scope for style preferences.

## Template

```md
# Qualification Gate

## Requested outcome
One observable statement.

## Hard gates
- [ ] User-visible/functional claim.
- [ ] Negative or regression claim.
- [ ] Required project-specific claim.

## Evidence plan
- [ ] Command/test: `...`
- [ ] Fixture/transcript: `...`
- [ ] Independent review: reviewer/auditor checks relevance and completeness.

## Scope / non-goals
- ...

## Open human decisions
- Decision, options, and consequence. (Omit in clear auto mode.)
```

## Few-shot

### Bug fix

Bad: `- [ ] Fix stale update bug.`

Good:

```md
- [ ] Before the fix, a seeded old attempt update is rejected by the red regression assertion.
- [ ] After the fix, the same assertion passes and a current attempt update still succeeds.
- [ ] Mock-LLM scenario reaches assignment → stale update behavior and records its transcript.
```

### Swarm feature

```md
- [ ] Creating a task persists the requested qualification mode and gate artifact.
- [ ] `human-discuss` blocks implementation until root records human confirmation.
- [ ] `auto` has a complete draft/challenge checklist without waiting for the human.
- [ ] A mock-LLM task-creation lane records the real tool call and gate artifact.
```

## Output discipline

Keep the gate short. The user should see outcome, hard gates, evidence, and only meaningful questions—not internal test trivia. A task can be implemented or tested without being qualified; do not call it qualified while a hard gate is unchecked or an explicit waiver is absent.
