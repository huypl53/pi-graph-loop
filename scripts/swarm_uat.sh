#!/usr/bin/env bash
set -euo pipefail

# UAT harness for extensions/swarm/index.ts (packaged swarm extension)
# Defaults intentionally use OpenAI gpt-5.4-mini per project validation preference.
# Override when needed:
#   SWARM_MODEL=glm-5.1 SWARM_PROVIDER=zai-coding-cn scripts/swarm_uat.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODEL="${SWARM_MODEL:-gpt-5.4-mini}"
PROVIDER="${SWARM_PROVIDER:-openai}"
EXT="extensions/swarm/index.ts"
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_ID="uat-${STAMP}"
LOG_DIR=".pi/swarm-uat/runs/${RUN_ID}"
mkdir -p "$LOG_DIR"

PI_BASE=(pi --model "$MODEL" --provider "$PROVIDER" --approve -e "$EXT")
PI_TOOL=("${PI_BASE[@]}" --no-builtin-tools)

log() { printf '[swarm-uat] %s\n' "$*" | tee -a "$LOG_DIR/harness.log"; }
run_pi() {
  local name="$1"; shift
  log "RUN $name: $*"
  set +e
  "$@" >"$LOG_DIR/${name}.out" 2>"$LOG_DIR/${name}.err"
  local code=$?
  set -e
  printf '%s\n' "$code" >"$LOG_DIR/${name}.code"
  log "$name exit=$code"
  if [[ $code -ne 0 ]]; then
    log "$name stderr follows:"
    sed -n '1,120p' "$LOG_DIR/${name}.err" | tee -a "$LOG_DIR/harness.log"
    return $code
  fi
}

log "root=$ROOT"
log "model=$MODEL provider=$PROVIDER run_id=$RUN_ID"
log "logs=$LOG_DIR"

if [[ "${SWARM_SKIP_PREFLIGHT:-0}" != "1" ]]; then
  run_pi preflight "${PI_BASE[@]}" -p 'Reply exactly: swarm-uat-preflight-ok'
fi

export PI_SWARM_DEFAULT_MODEL="$MODEL"
export PI_SWARM_DEFAULT_PROVIDER="$PROVIDER"
export PI_SWARM_CHILD_ARGS="--approve"

ROLE_SUFFIX="${SWARM_ROLE_SUFFIX:-$(date +%H%M%S)}"
ARCHITECT="uat-architect-${ROLE_SUFFIX}"
IMPLEMENTER="uat-implementer-${ROLE_SUFFIX}"
OBSERVER="uat-observer-${ROLE_SUFFIX}"

cat >"$LOG_DIR/roles.json" <<JSON
{
  "runId": "${RUN_ID}",
  "model": "${MODEL}",
  "provider": "${PROVIDER}",
  "agents": {
    "architect": "${ARCHITECT}",
    "implementer": "${IMPLEMENTER}",
    "observer": "${OBSERVER}"
  }
}
JSON

spawn_agent() {
  local agent_id="$1"
  local role="$2"
  local initial="$3"
  run_pi "spawn-${agent_id}" "${PI_TOOL[@]}" --tools swarm_spawn_agent -p \
    "Call swarm_spawn_agent exactly once with id \"${agent_id}\", role \"${role}\", model \"${MODEL}\", provider \"${PROVIDER}\", and initialPrompt \"${initial}\". Do not do anything else."
}

spawn_agent "$ARCHITECT" \
  "UAT architect. Coordinate a review of the swarm extension and UAT evidence. Do not edit files." \
  "You are ${ARCHITECT}, UAT architect. First call swarm_list_agents. Then send ${IMPLEMENTER} a task to review extensions/swarm/index.ts for risks, and send ${OBSERVER} a task to inspect traces/mailboxes/tmux evidence. Ask both to reply to you via swarm_send_message."

spawn_agent "$IMPLEMENTER" \
  "UAT implementer/reviewer. Review swarm extension behavior and report risks; do not edit files." \
  "You are ${IMPLEMENTER}. Wait for swarm messages. If idle call swarm_check_mailbox pendingOnly=true. When asked, review extensions/swarm/index.ts and report one concrete risk/improvement to ${ARCHITECT} via swarm_send_message. Do not edit files."

spawn_agent "$OBSERVER" \
  "UAT trace observer. Inspect swarm trace/debug evidence and report whether observability is sufficient; do not edit files." \
  "You are ${OBSERVER}. Wait for swarm messages. If idle call swarm_check_mailbox pendingOnly=true. When asked, use swarm_trace and mailbox evidence to assess whether enqueue, tmux injection, input intercept, and before/after snapshots are traceable. Reply to ${ARCHITECT} via swarm_send_message."

run_pi kickoff "${PI_TOOL[@]}" --tools swarm_send_message -p \
  "Call swarm_send_message exactly once to send to ${ARCHITECT} with subject \"UAT kickoff\" and body \"Run UAT review for swarm extension. Use current role agents only: implementer=${IMPLEMENTER}, observer=${OBSERVER}. Coordinate by sending tasks to them and collect replies. Focus on remaining issues and UAT evidence.\". Do not do anything else."

sleep "${SWARM_SETTLE_SECONDS:-45}"

log "Capturing tmux/session evidence"
tmux list-sessions >"$LOG_DIR/tmux-sessions.txt" 2>&1 || true
tmux list-windows -a >"$LOG_DIR/tmux-windows.txt" 2>&1 || true
cp .pi/swarm/swarm-state.json "$LOG_DIR/swarm-state.json" 2>/dev/null || true
cp .pi/swarm/traces/events.jsonl "$LOG_DIR/events.jsonl" 2>/dev/null || true
mkdir -p "$LOG_DIR/mailboxes"
cp .pi/swarm/mailboxes/*.jsonl "$LOG_DIR/mailboxes/" 2>/dev/null || true

LOG_DIR="$LOG_DIR" python3 - <<'PY' >"$LOG_DIR/summary.txt"
import json, os, pathlib, sys
root=pathlib.Path('.')
log_dir=pathlib.Path(os.environ['LOG_DIR'])
roles=json.loads((log_dir/'roles.json').read_text())
state_p=root/'.pi/swarm/swarm-state.json'
failures=[]
print('roles:', json.dumps(roles, indent=2))
st={}
if state_p.exists():
    st=json.loads(state_p.read_text())
    print('swarmId:', st.get('swarmId'))
    print('tmuxSession:', st.get('tmuxSession'))
else:
    failures.append('missing swarm-state.json')
for logical, aid in roles['agents'].items():
    ag=st.get('agents',{}).get(aid)
    print(f'{logical}/{aid}:', 'FOUND' if ag else 'MISSING', ag.get('tmuxTarget') if ag else '')
    if not ag:
        failures.append(f'missing role agent {logical}/{aid}')
    if not (root/'.pi/swarm/mailboxes'/f'{aid}.jsonl').exists():
        failures.append(f'missing mailbox for {aid}')
trace=root/'.pi/swarm/traces/events.jsonl'
events=[]
if trace.exists():
    events=[json.loads(l) for l in trace.read_text().splitlines() if l.strip()]
    for name in ['agent.spawn.ok','message.enqueue','message.input_intercept','message.inject.ok','message.ack','mailbox.poll']:
        print(name, sum(1 for e in events if e.get('event')==name))
else:
    failures.append('missing trace events.jsonl')
agent_ids=set(roles['agents'].values())
run_events=[e for e in events if e.get('agentId') in agent_ids or e.get('to') in agent_ids or e.get('from') in agent_ids or e.get('id') in st.get('messages',{})]
for name in ['agent.spawn.ok','message.enqueue','message.inject.ok']:
    if not any(e.get('event')==name and (e.get('agentId') in agent_ids or e.get('to') in agent_ids or e.get('from') in agent_ids) for e in events):
        failures.append(f'missing run event {name}')
print('run_related_events', len(run_events))
if failures:
    print('UAT_STATUS: FAIL')
    for f in failures: print(' -', f)
    sys.exit(1)
print('UAT_STATUS: PASS')
PY

log "DONE. Review $LOG_DIR/summary.txt and attach to tmux swarm session from swarm-state.json."
cat "$LOG_DIR/summary.txt"
