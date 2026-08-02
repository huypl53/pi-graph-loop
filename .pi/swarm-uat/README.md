# Swarm UAT harness

Run the default UAT with OpenAI `gpt-5.4-mini`:

```bash
scripts/swarm_uat.sh
```

If OpenAI credentials are unavailable, run the same scenario with another provider/model:

```bash
SWARM_MODEL=glm-4.5 SWARM_PROVIDER=zai-coding-cn scripts/swarm_uat.sh
```

Useful env vars:

- `SWARM_MODEL` default `gpt-5.4-mini`
- `SWARM_PROVIDER` default `openai`
- `SWARM_SKIP_PREFLIGHT=1` skips the initial model health check
- `SWARM_SETTLE_SECONDS=45` controls how long the harness waits before collecting evidence
- `SWARM_ROLE_SUFFIX=<suffix>` makes deterministic agent IDs

Each run writes:

```txt
.pi/swarm-uat/runs/<run-id>/
  harness.log
  roles.json
  summary.txt
  swarm-state.json
  events.jsonl
  mailboxes/*.jsonl
  tmux-sessions.txt
  tmux-windows.txt
  *.out / *.err / *.code
```

UAT pass criteria:

1. Three role agents are present in `summary.txt`: architect, implementer, observer.
2. `events.jsonl` contains `agent.spawn.ok`, `message.enqueue`, `message.inject.ok`, and `message.input_intercept`.
3. Role mailboxes contain traffic between architect and workers.
4. `.pi/swarm/traces/tmux/` contains before/after delivery snapshots.
5. User can attach to the tmux session listed in `summary.txt` and inspect role windows.
