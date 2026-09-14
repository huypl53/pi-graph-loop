# Qualification gate artifact

A short Markdown contract created by `swarm_create_task` next to `task.json`.
Stored at `.pi/swarm/tasks/<task-id>/artifacts/qualification-gate.md`. Two
modes ship in V1:

## Mode: auto (default)

```markdown
# Qualification: task-feature-x

## Goal
Ship the swarm_send_message parity test alongside the existing
swarm_ack_message coverage.

## Done means
- [ ] A new mjs test in extensions/swarm/tests/ exercises the tool surface
      end-to-end (envelope, mailbox append, status transitions).
- [ ] The test fails BEFORE the fix and passes AFTER.
- [ ] A reviewer/auditor has challenged the qualification at least once.

## Open questions
- None.

## Out of scope
- Cross-host mailbox delivery.
- Cryptographic mailbox auth.
```

## Mode: human-discuss

Same skeleton with an additional `## Human decision` section that root
records by hand. Implementation work is gated on `human-discuss` reaching
`ready`; until then `swarm_assign_task` to a source-changing implementer
node returns `QUALIFICATION_PENDING`.
