# Red-First Log — task-fu-readmailbox-rss (implementer-09)

## Artifact
`extensions/swarm/tests/mailbox-oversized-line.test.mjs` — written and observed RED before any
source change (mailbox.ts / collectors.ts / constants.ts untouched at observation time).

## RED observation (2026-10-04, node v26.8.2)
Command: `node extensions/swarm/tests/mailbox-oversized-line.test.mjs` (small-cap lane, env
`PI_SWARM_MAILBOX_LINE_MAX_BYTES=8192` pinned at process boot).

Fixture: scratch mailbox JSONL = 2 normal lines + 1 well-formed 50 MB line
(`"x".repeat(50*1024*1024)` body).

RED results:
```
FAIL [R1] no mailbox.oversized_line_skipped entry in errors.jsonl (guard missing)
FAIL [R2] unexpected ids: msg-n1,msg-n2,msg-oversize   (oversized line fully parsed & returned)
FAIL [R3] oversized line parsed in incremental branch (readMailboxSince)
FAIL [R4] oversized line materialized via sync path (flow/collectors.readMailboxLine)
FAIL     constants: DEFAULT_MAILBOX_LINE_MAX_BYTES / PI_SWARM_MAILBOX_LINE_MAX_BYTES not exported
FAIL     default-cap child lane: skip failed (msg-big returned; no durable entry)
```

Hard red gate per plan §0 is [R1] (binary, durable-trace absence) — observed red.
Soft RSS lane: heapUsed delta ≈ 104.5 MB on a 50 MB oversized line (> 2× line budget headroom
used), logged only, not CI-hard.

The green-contract lane "oversized line STAYS in file" and the corrupt-small-distinct lane pass
both pre- and post-change (they pin unchanged behavior, not the new guard).

## Green target (post-fix)
Same suite green: skip + durable log-once entry (file/lineIndex/byteOffset/byteLength/cap),
inert skipped lines, checkpoint advancing full byte length, corrupt-small path distinct,
constants surface (1 MiB default, env-tunable, floor vs body cap).
