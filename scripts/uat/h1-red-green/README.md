# H1 response-debt validation

The D1 engine lane in `extensions/swarm/tests/response-debt-parallel-nudge.test.mjs` now replays the agent-side reply from `extensions/mock-llm/fixtures/response-debt-parallel-nudge.jsonl`, then delivers the captured tool call through the real `deliverMessageLocked` engine. The fixture provides `replyTo` and the assignment conversation context; the assertion verifies both the original assignment and its parallel nudge debt settle.

## Fresh interactive Pi lane

Use a disposable project and leave the tmux session available for inspection. The seeder requires an explicit target nested beneath `.pi/swarm-uat/runs/`, resolves existing parent directories, and rejects the repository root, current working directory, external paths, and symlink targets before writing. Its guard regression is `node scripts/uat/h1-red-green/seeder-isolation.test.mjs` (9/9); the pre-fix missing-target reproduction is `.pi/swarm-uat/runs/h1-seeder-isolation-red-20260927/RED-evidence.md`. From the repository root:

```bash
OUT=.pi/swarm-uat/runs/h1-live-interactive-20260927
PROJECT="$PWD/$OUT/project"
mkdir -p "$OUT"
node scripts/uat/h1-red-green/seed-live-fixture.mjs seed "$PROJECT"

.agents/skills/tmux-pane-operator/scripts/tmux_run_capture.sh \
  --create-session h1-response-debt-live-20260927 \
  --window-name mock-llm \
  --cwd "$PROJECT" \
  -c "PI_SWARM_AGENT_ID=worker-x PI_SWARM_IS_ROOT=0 PI_MOCK_LLM_TRANSCRIPTS_DIR='$PWD/$OUT/transcripts' pi -ne -e '$PWD/extensions/mock-llm' -e '$PWD/extensions/swarm' --provider mock-llm --model response-debt-parallel-nudge" \
  --wait-for 'pi|>' --wait-timeout 30
```

After startup, capture the pane and submit the fixture-triggering prompt to the returned target (normally `h1-response-debt-live-20260927:0.0`). In this interactive Pi lane, the helper's `C-m` did not submit the input; literal `Enter` did:

```bash
TARGET=h1-response-debt-live-20260927:0.0
OUT=.pi/swarm-uat/runs/h1-live-interactive-20260927
tmux capture-pane -p -t "$TARGET" -S - > "$OUT/pane-before-prompt.txt"
tmux send-keys -l -t "$TARGET" 'Reply to the original assignment now.'
sleep 0.5
tmux send-keys -t "$TARGET" Enter
sleep 1
tmux capture-pane -p -t "$TARGET" -S - > "$OUT/pane-after-prompt.txt"
```

Verify durable state and preserve the interactive output/transcript:

```bash
node scripts/uat/h1-red-green/seed-live-fixture.mjs assert "$PROJECT" | tee "$OUT/assertion.json"
tmux capture-pane -p -t h1-response-debt-live-20260927:0.0 -S - > "$OUT/pane-after.txt"
```

The lane passes only when both `msg-assign-d1` and `msg-nudge-d1` are `verified` by the same reply message. The RED artifact is `.pi/swarm-uat/runs/h1-fixture-response-debt-red-20260927/attempt2/RED.log`. The live GREEN assertion is `.pi/swarm-uat/runs/h1-live-interactive-20260927/assertion.json`; fixture transcripts are under `.pi/swarm-uat/runs/h1-live-interactive-20260927/transcripts/response-debt-parallel-nudge/`.
