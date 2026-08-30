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

## Validation checklist

1. Update or add the fixture JSONL file.
2. Run `node extensions/mock-llm/selftest.test.mjs`.
3. Start a fresh tmux validation lane with `pi -e ./extensions/mock-llm` and select a scenario model.
4. Verify the expected turn shape, abort/hang behavior, and transcript output under `.pi/mock-llm/transcripts/`.
5. Capture the tmux pane output so the scenario can be reviewed later.
