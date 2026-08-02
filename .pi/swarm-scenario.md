# Pi Swarm validation scenario

Goal: exercise multi-agent coordination through the project-local `swarm` extension.

Agents:

1. `architect`
   - Role: coordination lead.
   - Task: inspect available swarm peers, propose a 3-step validation plan, send work instructions to `implementer` and `observer` via `swarm_send_message`.

2. `implementer`
   - Role: implementation/test worker.
   - Task: wait for/inspect mailbox, review `.pi/extensions/swarm/index.ts` behavior, report one concrete improvement or risk back to `architect`.

3. `observer`
   - Role: trace/debug reviewer.
   - Task: watch mailbox and trace, inspect `.pi/swarm/traces/events.jsonl`, report whether mailbox enqueue, tmux injection, and input intercept are visible.

Kickoff:
- Orchestrator spawns all three in the same project cwd and tmux swarm session.
- Orchestrator sends one kickoff message to `architect`.
- Agents should communicate only through swarm tools/mailbox, not through the human.

Success indicators:
- `.pi/swarm/swarm-state.json` lists all role agents with tmux targets.
- `.pi/swarm/mailboxes/*.jsonl` contains traffic.
- `.pi/swarm/traces/events.jsonl` contains `message.enqueue`, `message.inject.ok`, and `message.input_intercept` events.
- User can attach to the tmux session and observe each role window.
