# mock-llm provider extension

Pi extension that registers a `mock-llm` provider that replays scripted LLM
fixtures. Used for deterministic testing of swarm flows without burning real
tokens.

## Layout

```text
index.ts              provider registration
src/                  implementation
  stream.ts           scripted streaming over a JSONL fixture
fixtures/             JSONL fixtures — one per scenario (model id = filename stem)
tests/                deterministic end-to-end tests for fixtures (r18, selftest,
                      supersession-late-result)
```

## Fixtures

Each `.jsonl` file in `fixtures/` defines one scripted LLM session. The model id
is the filename stem. Pi loads a fixture via:

```bash
pi --provider mock-llm --model <fixture-stem> -e ./extensions/mock-llm
```

## Tests

Test suites live under `tests/` (not the repo root). Run via the package.json
script:

```bash
npm run test:mockllm
```

The orchestrator-authority-gated suites in `extensions/swarm/tests/` require
`PI_SWARM_AGENT_ID=orchestrator PI_SWARM_IS_ORCHESTRATOR=1` — see
`docs/swarm/contributor-guide.md`.
