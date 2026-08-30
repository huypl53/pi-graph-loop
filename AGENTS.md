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

## extension development flow
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
