# swarm_ack_message — tool result

The recipient calls `swarm_ack_message` to advance a `MessageRecord` through
its lifecycle. The tool is the only writer of `lastAck` on the record.

## Tool signature

```text
swarm_ack_message(
  messageId: string,           // required: MessageRecord.id
  status: "seen" | "processing" | "done" | "failed",  // required
  note?: string,               // free-form, surfaced in /swarm status
  resultMessageId?: string,    // reply id produced from this message
  waive?: boolean              // ROOT-ONLY: accept a superseded assignment as waived
)
```

## Example call (worker perspective)

```text
swarm_ack_message(
  messageId="msg-7f3a1b9c-2e44-4b9d-8c1a-1f0e9d2c5a01",
  status="done",
  note="Test added at extensions/swarm/tests/messages.test.mjs; passing.",
  resultMessageId="msg-8a4b2c0d-3f55-4cae-9d2b-200f0ae3d6b2"
)
```

## Tool result (root-side observation)

The tool returns the updated `MessageRecord`. The `lastAck.status` advances
the durable state; `response.status` flips to `verified` only after a
non-superseded reply is accepted.

Key invariants enforced inside the `withLock` block at
`extensions/swarm/src/tools/messages.ts`:

- a superseded assignment message cannot be ACKed `done` without `waive=true`
  (a root-only escape hatch that records `waivedAt` + `waivedBy`)
- late replies against a superseded attempt are fenced with
  `message.reply_rejected_superseded` and do NOT release debt
- terminal task updates stamp `terminalAt` and release response debt in the
  same lock window
