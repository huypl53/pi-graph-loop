---
name: mock-llm-scenarios
description: Author and validate deterministic mock-LLM JSONL fixtures for the extensions/mock-llm provider testbed. Use for adding scenario fixtures, transcript assertions, and local swarm/UAT recipes that reproduce 429s, hangs, torn JSON, aborted streams, and recovery edge cases without live model APIs.
---

# mock-llm-scenarios

Use this skill when you need to extend or validate the mock-LLM fixture provider testbed.

## What this testbed is

`extensions/mock-llm/` registers a local-only provider named `mock-llm`.
Each model id is the stem of a JSONL fixture file under `extensions/mock-llm/fixtures/`.
A request consumes exactly one scripted turn from that file, then advances to the next turn on the next request.
When the script runs out, the provider returns a terminal `script_exhausted` error instead of silently hanging.

The provider also writes per-request transcripts under `.pi/mock-llm/transcripts/` so tests can assert event timing and ordering.

## Fixture file format

Each file is JSONL: one JSON object per line, one turn per request.
Blank lines and `#` comment lines are ignored.

### Turn object
```json
{
  "name": "optional label",
  "stopReason": "stop | toolUse | length | error | aborted",
  "events": [ ... ]
}
```

### Event types
All events support `delayMs`.

#### Text
```json
{ "type": "text", "text": "hello", "delayMs": 25, "chunks": ["he", "llo"] }
```

#### Thinking
```json
{ "type": "thinking", "text": "...", "delayMs": 10 }
```

#### Tool call
```json
{
  "type": "toolcall",
  "name": "Edit",
  "id": "call-1",
  "arguments": { "path": "notes.txt", "content": "patched" },
  "delayMs": 25,
  "chunks": ["{\"path\":", "\"notes.txt\"..."]
}
```

#### Hang / stall
```json
{ "type": "hang", "delayMs": 0, "until": "abort" }
```

#### Error injection
```json
{ "type": "error", "kind": "429", "status": 429, "body": { "error": { ... } } }
{ "type": "error", "kind": "torn_json", "message": "Unexpected end of JSON input" }
{ "type": "error", "kind": "abort", "message": "Request was aborted" }
```

#### Stop
```json
{ "type": "stop", "reason": "stop", "delayMs": 0 }
```

## Authoring rules

- Keep the script deterministic: the same fixture must always emit the same event order and timings.
- Prefer small `delayMs` values; use `hang` only when you want the caller to abort the request.
- Use `chunks` to split a content block into repeatable streaming deltas.
- Use a 429 body that matches the live provider payloads you want to reproduce.
- If the provider should fail because the response stream ends without a terminal answer, use `hang` plus abort, not a fake success.
- If the provider should fail because the script is out of turns, let the provider reach `script_exhausted` rather than adding a silent fallback.

## Scenario recipes in this repo

- `429-mid-edit` — stream starts normally, then a quota-style 429 interrupts the turn.
- `edit-not-persisted` — tool-call path and final response are scripted, but the fixture is used to reproduce response-path problems rather than live file IO.
- `response-missing-settle` — starts working, then hangs until the caller aborts it.
- `settled-with-open-assignment` — returns a polite stop while the task graph still has open work.
- `drift-then-wake` — first request hangs, second request wakes and finishes normally.

## Multi-agent replay patterns

Swarm agents never talk to each other directly — all communication flows through mailbox JSONL + graph state on disk, and every agent is a separate pi process with its own `PI_SWARM_AGENT_ID`. The mock provider's turn cursor is **in-process** (`runtimeTurnCursor` in `src/stream.ts`): each process advances its own fixture independently. You therefore cannot script "A sends, B receives" inside one fixture. Use one of these three patterns instead:

### Pattern 1 — handoff-chain (one process plays multiple roles)

One scripted session acts as role A then role B against the real shared state (`fixtures/handoff-chain.jsonl` is the reference): turn 1 (A) closes its node + sends `swarm_task_message`; turn 2 (B) checks mailbox + acks; turn 3 (B) advances its own node. This genuinely exercises ownership fencing, ack lifecycle, and handoff credit because the engine only checks agent ids and assignment records — it does not care which process invoked the tool. Use this when the *coordination semantics* are under test.

### Pattern 2 — seeded world + single-actor script (the workhorse)

Instead of running the second agent, seed on-disk state *as if* it had acted, then let the engine react:

- seed `messages[msg-1]` with `status=acked`, a deferral note, and `createdAt` older than the cooldown (see `graph-advance-nudge-rearm` + its lane seeding helper) to test re-arm re-send;
- seed a stale `allIdleSinceAt` to test the busy-epoch reset (`goal-busy-epoch-reset`);
- leave a node ready-but-unassigned to trigger graph-advance / initial-ready nudges.

The scripted turns only need to respond to engine output (ack a nudge, verify the mailbox) — the pump/reconcile machinery runs for real on its normal tick. This is deterministic (no cross-process timing) and covers almost every engine-side behavior.

### Pattern 3 — parallel real lanes (for delivery machinery itself)

When the *transport* is under test — tmux injection, reconcile retry, dead-lettering — run two real pi processes with different fixtures/scripts (see the issue-11 UAT: an root lane with `PI_SWARM_IS_ROOT=1` and a worker lane with a scripted `swarm_send_message`). Coordinate with explicit sleeps and by mutating the mailbox file between turns from outside the processes. Accept the timing races — that is the point: the engine must be robust to them. Reserve this pattern for delivery/injection paths that patterns 1-2 cannot reach.

### Choosing a pattern

- Testing what agents *say to each other* (handoffs, acks, fences) → pattern 1.
- Testing what the *engine does* around agents (nudges, cooldowns, caps, epochs, dedupe) → pattern 2.
- Testing how messages *physically move* (tmux injection, retries, TTL, dead-letter) → pattern 3.

## Validation checklist

1. Update or add the fixture JSONL file.
2. Run `node extensions/mock-llm/selftest.test.mjs`.
3. Start a fresh tmux validation lane with `pi -e ./extensions/mock-llm` and select a scenario model.
4. Verify the expected turn shape, abort/hang behavior, and transcript output under `.pi/mock-llm/transcripts/`.
5. Capture the tmux pane output so the scenario can be reviewed later.
