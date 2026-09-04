## Graph/loop/prompt
> this project is to build agents harness with graph 

## Rules
- This project is a live pi agent packages


## pi session spawn rules
- use tmux skill to create a dedicated tmux session for validation/review work; if a full new session is not practical, create a clearly named pane/window instead
- in that session/pane start pi with bare `pi` (it reads defaultModel/defaultProvider from `~/.pi/agent/settings.json` and credentials from `~/.pi/agent/auth.json`)
- only pass explicit model/provider flags after verifying the provider is authenticated (`pi auth`); a model/provider combo without a stored key makes pi exit with `No API key found` and the pane looks dead. Example verified lanes:
```
pi --model glm-5.1 --provider zai-coding-cn   # ONLY if zai-coding-cn has a key in auth.json
pi --model gpt-5.4-mini --provider openai
```

## bug fixing: reproduce first (user mandate 2026-08-31)
- the FIRST step of every bug fix is a reproducing artifact: a failing test or mock-llm lane that exhibits the actual bug symptom — written and observed red BEFORE any source fix is authored
- trace forensics (events.jsonl, pane captures) is diagnosis, not reproduction: it tells you where to look; only the reproducing artifact proves you found the real cause
- red-green discipline: the plan node names the reproduction (expected wrong behavior + how to observe it); the implement node runs it red, lands the minimal fix, runs it green; the red artifact IS the regression test — no after-the-fact test authoring for the same bug
- if a bug cannot be reproduced deterministically, state so explicitly in the plan artifact and name the closest deterministic proxy (seeded state, synthetic clock) — never skip straight to fixing
- applies to live incidents too: reconstruct the failing state (seed it), observe the wrong behavior, then fix — a fix for an unreproduced bug is a hypothesis, not a fix

## swarm feature coding: mock-LLM fixtures are compulsory
- every swarm feature change (new feature, fix, or behavior modification in extensions/swarm/) must ship a mock-llm fixture/scenario exercising the changed behavior end-to-end before it can be considered done
- the fixture replays the agent-side of the interaction deterministically (extensions/mock-llm/fixtures/*.jsonl — one JSONL line per scripted turn; model id = fixture filename stem); validation lanes run `pi --provider mock-llm --model <scenario> -e ./extensions/mock-llm -e ./extensions/swarm`
- pipeline implication: the plan node names the fixture(s) to author; the implement node authors them; the test node runs a real mock-llm lane and cites transcripts (.pi/mock-llm/transcripts/) as evidence; the review node checks the scenario actually covers the changed code path (not just the happy path)
- if mocking streaming behavior proves impractical for a specific surface, an OpenAI-completions-compatible mock (static canned completion responses) is the fallback — state which and why in the plan artifact
- incident-derived fixtures (429-mid-edit, edit-not-persisted, response-missing-settle, settled-with-open-assignment, drift-then-wake) are the template for scenario quality: deterministic, timing-controlled (delayMs), abortable hangs, explicit error injection, lowercase pi-builtin tool names

## extension docs map
- canonical swarm docs live under `docs/swarm/`
- start with `docs/swarm/index.md`, then read `docs/swarm/architecture.md` and `docs/swarm/contributor-guide.md` before changing swarm behavior
- use `extensions/swarm/README.md` for the implementation module map
- update focused docs in `docs/swarm/` when adding or changing swarm features; do not treat `docs/swarm.md` as the only source of truth

## Pi runtime contract (mandatory consultation)

Before changing swarm code that touches Pi lifecycle, delivery, interrupt, or reload semantics
(any of `pi.sendMessage`, `pi.sendUserMessage`, `ctx.abort`, `ctx.signal`, `ctx.shutdown`,
`ctx.reload`, `ctx.newSession`, `ctx.switchSession`, `ctx.fork`, the `input` event,
the `agent_settled`/`agent_end` lifecycle boundary, the orchestrator pump, or
`extensions/swarm/src/tools/messages.ts`'s user-visible delivery text), the contributor MUST:

1. Read [`docs/swarm/pi-runtime-contract.md`](docs/swarm/pi-runtime-contract.md) and the
   matching section in [`docs/swarm/pi-runtime-evidence.md`](docs/swarm/pi-runtime-evidence.md).
2. Identify which of the four layers (durable mailbox / Pi queue acceptance / visible surface /
   LLM consumption) the change crosses.
3. Add or update a row in `pi-runtime-contract.md §10` if the change introduces, removes, or
   modifies a false / unproven claim about Pi runtime.
4. If the change adds a new swarm code path that crosses a Pi runtime boundary, include an
   R10-1 boundary-counting assertion (a test that counts calls at the real `pi.sendMessage` /
   `ctx.abort` / `pi.registerTool` / `ctx.reload` boundary, not at an internal helper).
5. If the change touches a claim in `pi-runtime-contract.md §10`, file a separate R-row task
   for the production fix — this KB task does NOT ship swarm behavior changes.

Reviewers MUST reject any swarm PR that touches Pi runtime semantics and does not cite the
matching contract § in its diff.

## extension development flow
- Deterministic & Offline-First: Tests must execute in milliseconds without making real network requests or requiring paid API tokens.
- when developing or changing a pi extension, do not stop at code changes; always include a validation/test step in tmux so the extension is exercised in a fresh interactive pi environment
- prefer an isolated tmux target dedicated to the validation run so the user can later inspect or attach to it for review
- after starting the validation pi session, run the smallest realistic workflow that proves the extension behavior, such as loading the extension, invoking the tool/command/hook, and checking the resulting output
- capture before/after pane output and keep the tmux target identifier and snapshot/log paths in the final report so the user can review what happened
- do not claim the extension is validated unless the tmux run actually happened, or clearly explain why validation was skipped or blocked

## extension validation report checklist
- tmux session/window/pane target used for validation
- exact pi command used to start the validation session
- validation actions performed inside pi
- result summary, failures, and follow-up fixes if needed
- where the user can review logs, snapshots, or captured pane output
