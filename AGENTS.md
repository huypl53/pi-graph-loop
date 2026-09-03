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
