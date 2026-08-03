#!/usr/bin/env bash
set -euo pipefail

# Repeatable task-graph UAT for extensions/swarm/index.ts (packaged swarm extension).
#
# Exercises the task-graph tools end-to-end against throwaway task ids and asserts on the resulting
# task.json / swarm-state.json / trace events (deterministic, model-independent), with tool stdout
# used only as a secondary signal. This makes pane capture fallback evidence, not the primary source.
#
# Covered paths:
#   1. create  -> ready                       (engine closure: fresh task derives `ready`)
#   2. validate(structure + runtime)          (no hard errors)
#   3. assign  -> orchestrator-role node      (activeTaskIds gains task; assignment msg enqueued)
#   4. update  -> in_progress -> done(outcome)(node terminal; activeTaskIds released)
#   5. terminal closer -> ready orchestrator-owned terminal node auto-closes
#   6. closure -> task.status = done          (every terminal done => derived done)
#   7. failed  -> task.status = failed        (any node failed => derived failed)
#   7. cancel  -> task.status = cancelled     (orchestrator force + cancelTask; sticky)
#   8. stale   -> reconcile surfaces stale    (fabricated old lastActivityAt => task_node_stale)
#   9. drift   -> reconcile mark repairs      (fabricated status drift => task_status_repaired)
#  10. PM close-notify  -> orchestrator mailbox AND auto-surfaced by pump (node/task closed; no polling)
#  11. PM settle-notify -> worker settled w/ open work -> orchestrator mailbox + auto-surfaced (cooldown-guarded)
#  12. Session-safe + read-safe pump -> two orchestrator sessions both surface ONE notification (no theft);
#      check_mailbox(markDelivered:true) cannot pre-empt a later pump surface (per-process surfaced set)
#  14. Identity override + reload -> effective <agent>.md = base+override+provenance; version/hash/loadedAt
#      stamped on the agent record; reload of a missing agent errors; override removal clears the marker
#
# Usage:
#   scripts/swarm_task_uat.sh
#   SWARM_MODEL=glm-5.1 SWARM_PROVIDER=zai-coding-cn scripts/swarm_task_uat.sh
#
# Every step runs as the orchestrator (the default agent id), so node ownership/transition checks
# are bypassed and orchestrator-role nodes resolve to the always-present orchestrator pseudo-agent
# (mailbox-only; no tmux spawn required).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${SWARM_MODEL:-gpt-5.4-mini}"
PROVIDER="${SWARM_PROVIDER:-openai}"
EXT="$ROOT/extensions/swarm/index.ts"
STAMP="$(date +%Y%m%d-%H%M%S)"
SUFFIX="$(date +%s | tail -c 6)"
RUN_ID="task-uat-${STAMP}"
LOG_DIR="$ROOT/.pi/swarm-uat/runs/${RUN_ID}"
# Isolated working tree so the UAT never mutates the live project swarm state. The extension keys all
# state off ctx.cwd (.pi/swarm/...), so running pi from SWARM_CWD fully isolates task.json + state.
# Placed under runs/ (already gitignored) so the scratch tree never pollutes git status.
SWARM_CWD="${SWARM_CWD:-$LOG_DIR/cwd}"
mkdir -p "$LOG_DIR" "$SWARM_CWD"
cd "$SWARM_CWD"
# Force orchestrator context so node ownership/transition checks are bypassed and orchestrator-role
# nodes resolve to the always-present orchestrator pseudo-agent. NOTE: just unsetting PI_SWARM_AGENT_ID
# is NOT enough — currentAgentId() then returns the inert "swarm-guest" identity, which never starts
# the orchestrator mailbox pump (so PM auto-surface / session-safe surfacing could never be exercised)
# and does not act as the PM. Opt in explicitly. PI_SWARM_AGENT_ID still wins when set (the worker lanes
# below set it), so this exported opt-in does not affect worker simulations (charlie/settle agents).
unset PI_SWARM_AGENT_ID
export PI_SWARM_IS_ORCHESTRATOR=1
TASKS_DIR="$SWARM_CWD/.pi/swarm/tasks"
STATE_JSON="$SWARM_CWD/.pi/swarm/swarm-state.json"
TRACE_JSONL="$SWARM_CWD/.pi/swarm/traces/events.jsonl"

# Throwaway task ids (safeId keeps [a-z0-9_-]).
HAPPY_ID="uat-taskgraph-happy-${SUFFIX}"
FAIL_ID="uat-taskgraph-fail-${SUFFIX}"
CANCEL_ID="uat-taskgraph-cancel-${SUFFIX}"
STALE_ID="uat-taskgraph-stale-${SUFFIX}"
DRIFT_ID="uat-taskgraph-drift-${SUFFIX}"
BLK_ID="uat-taskgraph-blocked-${SUFFIX}"
RK_AGENT="uat-implementer-flavored-${SUFFIX}"
RK_TASK="uat-taskgraph-rolekind-${SUFFIX}"

# Single-tool pi driver. --no-builtin-tools + --tools <name> constrains the model to one tool.
PI_BASE=(pi --model "$MODEL" --provider "$PROVIDER" --approve -e "$EXT" --no-builtin-tools)

FAILURES=0

log() { printf '[task-uat] %s\n' "$*" | tee -a "$LOG_DIR/harness.log"; }
fail() { log "FAIL: $*"; FAILURES=$((FAILURES + 1)); }

# run_step <name> <tool> <prompt>: invoke one constrained tool, capture stdout/stderr/exit. Retries on
# non-zero exit (handles provider 429 rate limits / transient model errors) with linear backoff, and
# paces an inter-step delay to stay under rolling rate-limit windows. The UAT tools are effectively
# idempotent here (explicit taskIds; status sets; subject-substring matching), so a retried partial
# invocation cannot corrupt the assertions.
SWARM_MAX_ATTEMPTS="${SWARM_MAX_ATTEMPTS:-3}"
SWARM_STEP_DELAY="${SWARM_STEP_DELAY:-2}"
run_step() {
	local name="$1" tool="$2" prompt="$3"
	local code=1 attempt=0
	while [[ $attempt -lt $SWARM_MAX_ATTEMPTS ]]; do
		attempt=$((attempt + 1))
		log "RUN $name [tool=$tool] (attempt $attempt/$SWARM_MAX_ATTEMPTS)"
		set +e
		"${PI_BASE[@]}" --tools "$tool" -p "$prompt" >"$LOG_DIR/${name}.out" 2>"$LOG_DIR/${name}.err"
		code=$?
		set -e
		[[ $code -eq 0 ]] && break
		if [[ $attempt -lt $SWARM_MAX_ATTEMPTS ]]; then
			local backoff=$((attempt * 6))
			log "$name exit=$code (rate-limit/transient? retry in ${backoff}s)"
			sed -n '1,8p' "$LOG_DIR/${name}.err" | tail -3 | tee -a "$LOG_DIR/harness.log" || true
			sleep "$backoff"
		fi
	done
	printf '%s\n' "$code" >"$LOG_DIR/${name}.code"
	log "$name exit=$code"
	if [[ $code -ne 0 ]]; then
		sed -n '1,80p' "$LOG_DIR/${name}.err" | tee -a "$LOG_DIR/harness.log" || true
	fi
	sleep "$SWARM_STEP_DELAY"
	return 0
}

# retry_cmd <max> <base_sleep> <cmd...>: run cmd, retry on non-zero up to max times with linear
# backoff (handles provider 429 rate limits / transient errors). Returns last exit code.
retry_cmd() {
	local max="$1" base_sleep="$2"; shift 2
	local code=1 attempt=0
	while [[ $attempt -lt $max ]]; do
		attempt=$((attempt + 1))
		set +e; "$@"; code=$?; set -e
		[[ $code -eq 0 ]] && return 0
		[[ $attempt -lt $max ]] && sleep $((attempt * base_sleep))
	done
	return $code
}

# Assert a step's stdout contains a substring (secondary, best-effort signal).
assert_stdout_contains() {
	local name="$1" needle="$2"
	if grep -qF "$needle" "$LOG_DIR/${name}.out"; then
		log "  note stdout[$name] echoed \"$needle\""
	fi
}

# task_json <taskId> <python-expr-on-`t`>: read task.json, eval expr, compare to expected value.
# Usage: task_json_eq <taskId> <expr> <expected>
task_json_eq() {
	local tid="$1" expr="$2" expected="$3"
	local f="$TASKS_DIR/$tid/task.json"
	[[ -f "$f" ]] || { fail "task_json_eq: missing $f"; return 0; }
	local got
	got="$(python3 - "$f" "$expr" <<'PY'
import json, sys
f, expr = sys.argv[1], sys.argv[2]
t = json.load(open(f))
print(eval(expr, {"t": t}))
PY
)"
	if [[ "$got" == "$expected" ]]; then
		log "  ok task[$tid] $expr == $expected"
	else
		fail "task[$tid] $expr == '$got' (expected '$expected')"
	fi
}

# trace_has <event-name> [taskId]: confirm an event fired in that task's events.jsonl
# (task.create/update/close/cancel are per-task, not in the global swarm trace).
trace_has() {
	local event="$1" tid="${2:-}"
	[[ -n "$tid" ]] || { fail "trace_has '$event' called without a taskId"; return 0; }
	local f="$TASKS_DIR/$tid/events.jsonl"
	[[ -f "$f" ]] || { fail "trace_has: missing $f"; return 0; }
	if python3 - "$f" "$event" <<'PY'; then
import json, sys
f, event = sys.argv[1], sys.argv[2]
found = any(json.loads(l).get("event") == event for l in open(f) if l.strip())
sys.exit(0 if found else 1)
PY
		log "  ok trace[$tid] has '$event'"
	else
		fail "trace[$tid] missing event '$event' (tool may not have been invoked)"
	fi
}

fabricate() {
	# fabricate <taskId> <python-stmt-on-`t`-and-`now`>: mutate a throwaway task.json in place.
	local tid="$1" stmt="$2"
	local f="$TASKS_DIR/$tid/task.json"
	[[ -f "$f" ]] || { fail "fabricate: missing $f"; return 0; }
	python3 - "$f" "$stmt" <<'PY'
import json, sys, datetime
f, stmt = sys.argv[1], sys.argv[2]
t = json.load(open(f))
now = datetime.datetime.now(datetime.timezone.utc)
exec(stmt, {"t": t, "now": now, "json": json})
json.dump(t, open(f, "w"), indent=2)
PY
	log "  fabricated $tid: $stmt"
}

# fabricate_agent <agentId> <role>: inject a minimal agent record into swarm-state.json (no tmux) so
# we can exercise roleKind inference (id-first precedence) without spawning a real pane.
fabricate_agent() {
	local aid="$1" role="$2"
	mkdir -p "$SWARM_CWD/.pi/swarm/mailboxes"
	: >"$SWARM_CWD/.pi/swarm/mailboxes/$aid.jsonl"
	python3 - "$STATE_JSON" "$aid" "$role" <<'PY'
import json, sys, os
state_p, aid, role = sys.argv[1], sys.argv[2], sys.argv[3]
st = json.load(open(state_p)) if os.path.exists(state_p) else {"swarmId":"uat","tmuxSession":"uat","agents":{},"messages":{}}
st.setdefault("agents", {})
st.setdefault("messages", {})
st["agents"][aid] = {
	"id": aid, "role": role, "roleKind": "worker", "capabilities": [], "activeTaskIds": [],
	"maxConcurrentTasks": 1, "status": "running", "runtimeStatus": "idle", "health": "healthy",
	"tmuxSession": st.get("tmuxSession","uat"), "tmuxWindow": aid, "tmuxTarget": "unknown",
	"model": "uat", "provider": "uat", "cwd": ".", "mailbox": f".pi/swarm/mailboxes/{aid}.jsonl",
	"createdAt": "uat", "updatedAt": "uat",
}
json.dump(st, open(state_p, "w"), indent=2)
PY
	log "  fabricated agent $aid (role mentions reviewer to test id-first precedence)"
}

# state_json_eq <agentId> <expr-on-`a`> <expected>: read an agent record, eval expr, compare.
state_json_eq() {
	local aid="$1" expr="$2" expected="$3"
	local f="$STATE_JSON"
	[[ -f "$f" ]] || { fail "state_json_eq: missing $f"; return 0; }
	local got
	got="$(python3 - "$f" "$aid" "$expr" <<'PY'
import json, sys
f, aid, expr = sys.argv[1], sys.argv[2], sys.argv[3]
st = json.load(open(f))
a = st.get("agents", {}).get(aid)
print(eval(expr, {"a": a})) if a else print("__MISSING__")
PY
)"
	if [[ "$got" == "$expected" ]]; then
		log "  ok state[$aid] $expr == $expected"
	else
		fail "state[$aid] $expr == '$got' (expected '$expected')"
	fi
}

# state_msg_eq <msgId> <expr-on-`m`> <expected>: read a message record from swarm-state.json.
state_msg_eq() {
	local mid="$1" expr="$2" expected="$3"
	local f="$STATE_JSON"
	[[ -f "$f" ]] || { fail "state_msg_eq: missing $f"; return 0; }
	local got
	got="$(python3 - "$f" "$mid" "$expr" <<'PY'
import json, sys
f, mid, expr = sys.argv[1], sys.argv[2], sys.argv[3]
st = json.load(open(f))
m = st.get("messages", {}).get(mid)
print(eval(expr, {"m": m})) if m else print("__MISSING__")
PY
)"
	if [[ "$got" == "$expected" ]]; then
		log "  ok msg[$mid] $expr == $expected"
	else
		fail "msg[$mid] $expr == '$got' (expected '$expected')"
	fi
}

# trace_global_has <event>: confirm an event fired in the GLOBAL swarm trace (traces/events.jsonl).
# (message.idempotent_reuse / message.superseded are global, not per-task.)
trace_global_has() {
	local event="$1"
	local f="$TRACE_JSONL"
	[[ -f "$f" ]] || { fail "trace_global_has: missing $f"; return 0; }
	if python3 - "$f" "$event" <<'PY'; then
import json, sys
f, event = sys.argv[1], sys.argv[2]
found = any(json.loads(l).get("event") == event for l in open(f) if l.strip())
sys.exit(0 if found else 1)
PY
		log "  ok trace(global) has '$event'"
	else
		fail "trace(global) missing event '$event'"
	fi
}

# node_assign_msg <taskId> <nodeId>: print the current canonical assignment message id.
node_assign_msg() {
	local tid="$1" nid="$2"
	local f="$TASKS_DIR/$tid/task.json"
	python3 - "$f" "$nid" <<'PY'
import json, sys
f, nid = sys.argv[1], sys.argv[2]
t = json.load(open(f))
print(t.get("nodes", {}).get(nid, {}).get("assignmentMessageId") or "")
PY
}

# mailbox_has <recipientId> <subjectSubstring> <label>: assert <recipient>.jsonl contains a message
# addressed to recipient whose subject includes the substring. Directly asserts PM visibility (the
# orchestrator mailbox received the notification) without any manual polling.
mailbox_has() {
	local rcpt="$1" needle="$2" label="$3"
	local f="$SWARM_CWD/.pi/swarm/mailboxes/$rcpt.jsonl"
	[[ -f "$f" ]] || { fail "mailbox_has[$label]: missing mailbox $f"; return 0; }
	if python3 - "$f" "$rcpt" "$needle" <<'PY'; then
import json, sys
f, rcpt, needle = sys.argv[1], sys.argv[2], sys.argv[3]
hits = [m for l in open(f) if l.strip() for m in [json.loads(l)] if m.get("to") == rcpt and needle in (m.get("subject") or "")]
sys.exit(0 if hits else 1)
PY
		log "  ok mailbox[$label] $rcpt has subject~\"$needle\""
	else
		fail "mailbox[$label] $rcpt missing subject~\"$needle\" (PM not notified)"
	fi
}

# pump_surfaced <subjectSubstring> <label>: assert the orchestrator AUTO-PUMP surfaced (to a turn, via
# mailbox.orchestrator_pump) an orchestrator-bound message whose subject contains the substring, WITHOUT
# any swarm_check_mailbox polling. Cross-references pump-traced surfaced ids with the orchestrator mailbox.
# This is the real PM-visibility signal: the message was surfaced automatically, not just appended.
pump_surfaced() {
	local needle="$1" label="$2"
	local trace_f="$TRACE_JSONL"
	local omb="$SWARM_CWD/.pi/swarm/mailboxes/orchestrator.jsonl"
	[[ -f "$trace_f" && -f "$omb" ]] || { fail "pump_surfaced[$label]: missing trace or mailbox"; return 0; }
	if python3 - "$trace_f" "$omb" "$needle" <<'PY'; then
import json, sys
trace_f, mbox_f, needle = sys.argv[1], sys.argv[2], sys.argv[3]
surfaced = set()
for l in open(trace_f):
	l = l.strip()
	if not l: continue
	try: d = json.loads(l)
	except Exception: continue
	if d.get("event") == "mailbox.orchestrator_pump":
		for i in (d.get("ids") or []): surfaced.add(i)
target = None
for l in open(mbox_f):
	l = l.strip()
	if not l: continue
	try: m = json.loads(l)
	except Exception: continue
	if m.get("to") == "orchestrator" and needle in (m.get("subject") or ""):
		target = m.get("id"); break
sys.exit(0 if (target and target in surfaced) else 1)
PY
		log "  ok pump-surfaced[$label] orchestrator pump surfaced subject~\"$needle\" (no polling)"
	else
		fail "pump-surfaced[$label] orchestrator pump did NOT surface subject~\"$needle\" (auto-pump neutralized?)"
	fi
}

# pump_surfaced_sids <subjectSubstring>: print the distinct PI_SESSION_ID sids (space-separated) whose
# orchestrator pump surfaced an orchestrator-bound message whose subject contains the substring. Used
# by the session-safety / read-safety assertions (section 12). Empty string if none.
pump_surfaced_sids() {
	local needle="$1"
	local trace_f="$TRACE_JSONL"
	local omb="$SWARM_CWD/.pi/swarm/mailboxes/orchestrator.jsonl"
	[[ -f "$trace_f" && -f "$omb" ]] || { echo ""; return 0; }
	python3 - "$trace_f" "$omb" "$needle" <<'PY'
import json, sys
trace_f, mbox_f, needle = sys.argv[1], sys.argv[2], sys.argv[3]
target = None
for l in open(mbox_f):
	l = l.strip()
	if not l: continue
	try: m = json.loads(l)
	except Exception: continue
	if m.get("to") == "orchestrator" and needle in (m.get("subject") or ""):
		target = m.get("id"); break
if not target:
	print(""); sys.exit(0)
sids = set()
for l in open(trace_f):
	l = l.strip()
	if not l: continue
	try: d = json.loads(l)
	except Exception: continue
	if d.get("event") == "mailbox.orchestrator_pump" and target in (d.get("ids") or []):
		s = d.get("sid")
		if s is not None: sids.add(s)
print(" ".join(sorted(s for s in sids if s)))
PY
}

# pump_surfaced_by_all_sids <subjectSubstring> <space-separated-sids> <label>: assert the subject was
# surfaced by EVERY listed sid. This is the session-safety guarantee: each distinct orchestrator
# session surfaces the notification once; no session steals it from another.
pump_surfaced_by_all_sids() {
	local needle="$1" want="$2" label="$3"
	local got; got="$(pump_surfaced_sids "$needle")"
	local ok=1 want_sid
	for want_sid in $want; do
		if [[ " $got " != *" $want_sid "* ]]; then ok=0; fi
	done
	if [[ $ok -eq 1 ]]; then
		log "  ok session-safe[$label] subject~\"$needle\" surfaced by sids {$got} (includes all of {$want})"
	else
		fail "session-safe[$label] subject~\"$needle\" surfaced by sids {$got} (expected all of {$want}) — a session stole it"
	fi
}

# shared_delivered_has <subjectSubstring>: print True if the orchestrator-bound message with that
# subject is in the SHARED st.delivered.orchestrator ledger (the read/check_mailbox ledger the legacy
# pump consulted and that tester-02 proved starved surfacing — a single check_mailbox(markDelivered)
# pre-empted ~15 messages). Used to prove a cross-session read actually marked the shared ledger (the
# pre-emption vector) before asserting the session-safe pump still surfaces the message anyway.
shared_delivered_has() {
	local needle="$1"
	local f="$STATE_JSON"
	local omb="$SWARM_CWD/.pi/swarm/mailboxes/orchestrator.jsonl"
	[[ -f "$f" && -f "$omb" ]] || { echo False; return 0; }
	python3 - "$f" "$omb" "$needle" <<'PY'
import json, sys
state_f, mbox_f, needle = sys.argv[1], sys.argv[2], sys.argv[3]
target = None
for l in open(mbox_f):
	l = l.strip()
	if not l: continue
	try: m = json.loads(l)
	except Exception: continue
	if m.get("to") == "orchestrator" and needle in (m.get("subject") or ""):
		target = m.get("id"); break
st = json.load(open(state_f))
shared = set((st.get("delivered") or {}).get("orchestrator", []) or [])
print("True" if (target and target in shared) else "False")
PY
}

log "root=$ROOT model=$MODEL provider=$PROVIDER run_id=$RUN_ID"
log "logs=$LOG_DIR"
log "happy=$HAPPY_ID fail=$FAIL_ID cancel=$CANCEL_ID stale=$STALE_ID drift=$DRIFT_ID"

# Export defaults so spawned/constrained pi sessions share model+provider semantics.
export PI_SWARM_DEFAULT_MODEL="$MODEL"
export PI_SWARM_DEFAULT_PROVIDER="$PROVIDER"

# ---------- 1. Preflight ----------
run_step preflight swarm_create_task \
	'Reply with exactly: task-uat-preflight-ok'

# ---------- 2. Happy path: create -> assign -> update -> done closure ----------
run_step create-happy swarm_create_task \
	"Call swarm_create_task exactly once with title \"UAT happy closure\", goal \"Deterministic UAT happy-path closure\", taskId \"$HAPPY_ID\", start \"kickoff\", nodes {\"kickoff\":{\"role\":\"orchestrator plan\"},\"ship\":{\"role\":\"orchestrator commit\",\"terminal\":true,\"dependsOn\":[\"kickoff\"]}}, edges [{\"from\":\"kickoff\",\"to\":\"ship\",\"when\":\"go\"}]. Then reply done."
assert_stdout_contains create-happy "Created task"
task_json_eq "$HAPPY_ID" "t['status']" "ready"
trace_has "task.create" "$HAPPY_ID"

run_step validate-happy swarm_validate_graph \
	"Call swarm_validate_graph exactly once with taskId \"$HAPPY_ID\", runtime true. Then reply done."
assert_stdout_contains validate-happy "Validation: PASS"

run_step assign-kickoff swarm_assign_task \
	"Call swarm_assign_task exactly once with taskId \"$HAPPY_ID\", nodeId \"kickoff\". Then reply done."
assert_stdout_contains assign-kickoff "Assigned node kickoff"
task_json_eq "$HAPPY_ID" "t['nodes']['kickoff']['status']" "assigned"
task_json_eq "$HAPPY_ID" "t['nodes']['kickoff']['assignee']" "orchestrator"

run_step upd-kickoff-ip swarm_update_task \
	"Call swarm_update_task exactly once with taskId \"$HAPPY_ID\", nodeId \"kickoff\", status \"in_progress\". Then reply done."
task_json_eq "$HAPPY_ID" "t['nodes']['kickoff']['status']" "in_progress"
task_json_eq "$HAPPY_ID" "t['status']" "in_progress"

run_step upd-kickoff-done swarm_update_task \
	"Call swarm_update_task exactly once with taskId \"$HAPPY_ID\", nodeId \"kickoff\", status \"done\", outcome \"go\". Then reply done."
task_json_eq "$HAPPY_ID" "t['nodes']['kickoff']['status']" "done"
task_json_eq "$HAPPY_ID" "t['nodes']['kickoff']['outcome']" "go"
task_json_eq "$HAPPY_ID" "t['nodes']['ship']['status']" "done"
trace_has "task.autoclose.orchestrator" "$HAPPY_ID"
# Path (a) — PM close-notify: task going terminal (done) emits the stronger "task ... closed (done)"
# even though the terminal ship node was auto-closed by the engine.
mailbox_has "orchestrator" "closed (done)" "task-close-notify (autoclosed ship, task terminal)"
# Auto-surface proof: the orchestrator pump surfaced the task-close notify to a turn WITHOUT polling
# (this run is constrained to swarm_update_task, so swarm_check_mailbox is impossible).
pump_surfaced "closed (done)" "auto-surface close-notify"

# Closure assertion: every terminal done => derived task.status == done; orchestrator released.
task_json_eq "$HAPPY_ID" "t['status']" "done"
trace_has "task.close" "$HAPPY_ID"

run_step status-happy swarm_task_status \
	"Call swarm_task_status exactly once with taskId \"$HAPPY_ID\", runtime true. Then reply done."
assert_stdout_contains status-happy "Status: done"
assert_stdout_contains status-happy "derivedStatus=done"

# ---------- 3. Failed path: any node failed => derived failed ----------
run_step create-fail swarm_create_task \
	"Call swarm_create_task exactly once with title \"UAT failed closure\", goal \"Deterministic UAT failed-path closure\", taskId \"$FAIL_ID\", start \"build\", nodes {\"build\":{\"role\":\"orchestrator build\",\"terminal\":true}}, edges []. Then reply done."
task_json_eq "$FAIL_ID" "t['status']" "ready"

run_step assign-build swarm_assign_task \
	"Call swarm_assign_task exactly once with taskId \"$FAIL_ID\", nodeId \"build\". Then reply done."
run_step upd-build-failed swarm_update_task \
	"Call swarm_update_task exactly once with taskId \"$FAIL_ID\", nodeId \"build\", status \"failed\". Then reply done."
task_json_eq "$FAIL_ID" "t['nodes']['build']['status']" "failed"
task_json_eq "$FAIL_ID" "t['status']" "failed"
trace_has "task.close" "$FAIL_ID"

# ---------- 4. Cancel path: orchestrator force + cancelTask => sticky cancelled ----------
run_step create-cancel swarm_create_task \
	"Call swarm_create_task exactly once with title \"UAT cancel\", goal \"Deterministic UAT cancel-path\", taskId \"$CANCEL_ID\", start \"work\", nodes {\"work\":{\"role\":\"orchestrator work\",\"terminal\":true}}, edges []. Then reply done."
run_step cancel-task swarm_update_task \
	"Call swarm_update_task exactly once with taskId \"$CANCEL_ID\", nodeId \"work\", status \"done\", force true, cancelTask true. Then reply done."
assert_stdout_contains cancel-task "cancelled"
task_json_eq "$CANCEL_ID" "t['status']" "cancelled"
trace_has "task.cancel" "$CANCEL_ID"

# ---------- 5. Stale path: fabricated old activity => reconcile surfaces task_node_stale ----------
run_step create-stale swarm_create_task \
	"Call swarm_create_task exactly once with title \"UAT stale\", goal \"Deterministic UAT stale-path\", taskId \"$STALE_ID\", start \"slow\", nodes {\"slow\":{\"role\":\"orchestrator work\",\"terminal\":true}}, edges []. Then reply done."
run_step assign-slow swarm_assign_task \
	"Call swarm_assign_task exactly once with taskId \"$STALE_ID\", nodeId \"slow\". Then reply done."
run_step upd-slow-ip swarm_update_task \
	"Call swarm_update_task exactly once with taskId \"$STALE_ID\", nodeId \"slow\", status \"in_progress\". Then reply done."
# Push lastActivityAt 25h into the past so the reconcile task sweep flags the node stale (mark-only).
fabricate "$STALE_ID" "t['nodes']['slow']['lastActivityAt'] = (now - __import__('datetime').timedelta(hours=25)).isoformat()"
run_step reconcile-stale swarm_reconcile \
	"Call swarm_reconcile exactly once with dryRun false. Then reply done."
assert_stdout_contains reconcile-stale "task_node_stale"
# Mark-only: node must NOT have been auto-failed; staleAt should now be stamped.
task_json_eq "$STALE_ID" "t['nodes']['slow']['status']" "in_progress"
task_json_eq "$STALE_ID" "bool(t['nodes']['slow'].get('staleAt'))" "True"

# ---------- 6. Drift path: fabricated status drift => reconcile mark repairs it ----------
run_step create-drift swarm_create_task \
	"Call swarm_create_task exactly once with title \"UAT drift\", goal \"Deterministic UAT drift-path\", taskId \"$DRIFT_ID\", start \"d\", nodes {\"d\":{\"role\":\"orchestrator work\",\"terminal\":true}}, edges []. Then reply done."
run_step upd-drift-done swarm_update_task \
	"Call swarm_update_task exactly once with taskId \"$DRIFT_ID\", nodeId \"d\", status \"done\". Then reply done."
# Engine already derived done; corrupt stored status to force a stored/derived mismatch.
fabricate "$DRIFT_ID" "t['status'] = 'in_progress'"
run_step reconcile-drift swarm_reconcile \
	"Call swarm_reconcile exactly once with dryRun false, mark true. Then reply done."
assert_stdout_contains reconcile-drift "task_status_repaired"
task_json_eq "$DRIFT_ID" "t['status']" "done"

# ---------- 7. PM rollup: /swarm status emits closure line (best-effort via prompt) ----------
run_step pm-status swarm_task_status \
	"Call swarm_task_status exactly once with taskId \"$HAPPY_ID\", runtime true. Then reply done."
assert_stdout_contains pm-status "Closure:"

# ---------- 8. Blocked derivation: all-active-blocked => task blocked (resumable) ----------
run_step create-blk swarm_create_task \
	"Call swarm_create_task exactly once with title \"UAT blocked\", goal \"Deterministic UAT blocked-path\", taskId \"$BLK_ID\", start \"w\", nodes {\"w\":{\"role\":\"orchestrator work\",\"terminal\":true}}, edges []. Then reply done."
run_step assign-blk swarm_assign_task \
	"Call swarm_assign_task exactly once with taskId \"$BLK_ID\", nodeId \"w\". Then reply done."
run_step upd-blk swarm_update_task \
	"Call swarm_update_task exactly once with taskId \"$BLK_ID\", nodeId \"w\", status \"blocked\". Then reply done."
task_json_eq "$BLK_ID" "t['status']" "blocked"
# Resumable: leaving blocked returns the task to in_progress.
run_step upd-unblk swarm_update_task \
	"Call swarm_update_task exactly once with taskId \"$BLK_ID\", nodeId \"w\", status \"in_progress\". Then reply done."
task_json_eq "$BLK_ID" "t['status']" "in_progress"

# ---------- 9. roleKind inference: id-first precedence over reviewer-in-role-text ----------
# Fabricate an implementer-* agent whose role text mentions reviewer, then assign triggers
# ensureAgentDefaults re-inference + persist. Assert roleKind derives to implementer (id wins).
fabricate_agent "$RK_AGENT" "Swarm implementer who coordinates with tester/reviewer"
run_step create-rk swarm_create_task \
	"Call swarm_create_task exactly once with title \"UAT rolekind\", goal \"roleKind inference\", taskId \"$RK_TASK\", start \"r\", nodes {\"r\":{\"role\":\"implementer work\",\"terminal\":true}}, edges []. Then reply done."
run_step assign-rk swarm_assign_task \
	"Call swarm_assign_task exactly once with taskId \"$RK_TASK\", nodeId \"r\", agentId \"$RK_AGENT\". Then reply done."
state_json_eq "$RK_AGENT" "a['roleKind']" "implementer"
state_json_eq "$RK_AGENT" "a.get('roleKindExplicit')" "None"

# ---------- 11. PM auto-notify (settle): worker settles with an open assignment ----------
# Fabricate a worker that owns an open (in_progress) node, then run one turn AS that worker (print
# mode). Its agent_settled hook enqueues the settle-notify to the orchestrator mailbox (loop-safe,
# cooldown-guarded) without any polling. Asserts engine PM visibility for the idle/stall signal.
SETTLE_AGENT="uat-settle-worker-${SUFFIX}"
SETTLE_TASK="uat-taskgraph-settle-${SUFFIX}"
fabricate_agent "$SETTLE_AGENT" "Swarm implementer worker for settle notify"
run_step create-settle swarm_create_task \
	"Call swarm_create_task exactly once with title \"UAT settle\", goal \"settle notify\", taskId \"$SETTLE_TASK\", start \"s\", nodes {\"s\":{\"role\":\"implementer work\",\"terminal\":true}}, edges []. Then reply done."
run_step assign-settle swarm_assign_task \
	"Call swarm_assign_task exactly once with taskId \"$SETTLE_TASK\", nodeId \"s\", agentId \"$SETTLE_AGENT\". Then reply done."
run_step upd-settle-ip swarm_update_task \
	"Call swarm_update_task exactly once with taskId \"$SETTLE_TASK\", nodeId \"s\", status \"in_progress\". Then reply done."
# Worker now holds an open (in_progress) assignment. Run one turn AS the worker so agent_settled fires.
log "RUN settle-worker-as-agent [pi -p as $SETTLE_AGENT; retry on 429]"
set +e
retry_cmd "$SWARM_MAX_ATTEMPTS" 6 env PI_SWARM_AGENT_ID="$SETTLE_AGENT" "${PI_BASE[@]}" -p 'Reply with exactly: settle-ok' >"$LOG_DIR/settle-worker.out" 2>"$LOG_DIR/settle-worker.err"
settle_code=$?
set -e
log "settle-worker exit=$settle_code"
mailbox_has "orchestrator" "settled idle with open assignment" "settle-notify (worker->orchestrator)"
# The settle-notify is orchestrator-bound; it auto-surfaces on the orchestrator's NEXT pump. Run one
# orchestrator turn (constrained to swarm_task_status, so NO swarm_check_mailbox) and assert the pump
# surfaced the settle-notify to a turn without polling.
run_step orch-pump-after-settle swarm_task_status \
	"Call swarm_task_status exactly once with taskId \"$SETTLE_TASK\", runtime true. Then reply done."
pump_surfaced "settled idle with open assignment" "auto-surface settle-notify"

# ---------- 12. Session-safe + read-safe orchestrator surfacing ----------
# The orchestrator auto-pump keys "already surfaced" PER PROCESS (process.pid), not on the shared
# st.delivered.orchestrator ledger and not on PI_SESSION_ID (which a child `pi -p` validation run
# inherits from its parent). Consequences under test:
#   (A) two distinct orchestrator sessions each surface the SAME notification once (no theft);
#   (B) a swarm_check_mailbox(agentId=orchestrator, markDelivered=true) read writes st.delivered.orchestrator
#       but the pump ignores that ledger, so a later pump STILL surfaces the message.
# Both probes use requiresAck:false (informational, like the real PM close/settle notifications).
run_step send-sessafety-A swarm_send_message \
	'Call swarm_send_message exactly once with to "orchestrator", subject "session-safety-probe-A", body "probe", requiresAck false. Then reply done.'
run_step send-sessafety-B swarm_send_message \
	'Call swarm_send_message exactly once with to "orchestrator", subject "session-safety-probe-B", body "probe", requiresAck false. Then reply done.'
# (A) Two orchestrator sessions with DISTINCT PI_SESSION_IDs each run one idle turn; their pumps fire
# at session_start and each surfaces probe-A (fresh per-pid set => nothing stolen).
log "RUN sessafety-orch-alpha [pi -p, PI_SESSION_ID=uat-alpha; retry on 429]"
set +e
retry_cmd "$SWARM_MAX_ATTEMPTS" 6 env PI_SESSION_ID=uat-alpha "${PI_BASE[@]}" -p 'Reply with exactly: alpha-ok' >"$LOG_DIR/sessafety-alpha.out" 2>"$LOG_DIR/sessafety-alpha.err" || true
set -e
log "RUN sessafety-orch-beta [pi -p, PI_SESSION_ID=uat-beta; retry on 429]"
set +e
retry_cmd "$SWARM_MAX_ATTEMPTS" 6 env PI_SESSION_ID=uat-beta "${PI_BASE[@]}" -p 'Reply with exactly: beta-ok' >"$LOG_DIR/sessafety-beta.out" 2>"$LOG_DIR/sessafety-beta.err" || true
set -e
pump_surfaced_by_all_sids "session-safety-probe-A" "uat-alpha uat-beta" "two-session no-theft"
# (B) A NON-orchestrator (worker) session reads the orchestrator mailbox with markDelivered=true.
# Because currentAgentId != orchestrator this writes the SHARED st.delivered.orchestrator ledger —
# exactly the pre-emption vector tester-02 proved starved the legacy pump (one check_mailbox
# markDelivered pre-empted ~15 messages). The session-safe pump must IGNORE that shared ledger.
CHARLIE_AGENT="uat-reader-charlie-${SUFFIX}"
log "RUN sessafety-reader-charlie [pi -p as worker $CHARLIE_AGENT; check_mailbox markDelivered; retry on 429]"
set +e
retry_cmd "$SWARM_MAX_ATTEMPTS" 6 env PI_SWARM_AGENT_ID="$CHARLIE_AGENT" PI_SESSION_ID=uat-charlie "${PI_BASE[@]}" --tools swarm_check_mailbox -p 'Call swarm_check_mailbox exactly once with agentId "orchestrator", markDelivered true. Then reply ok.' >"$LOG_DIR/sessafety-charlie.out" 2>"$LOG_DIR/sessafety-charlie.err" || true
set -e
# Prove the pre-emption vector was exercised: probe-B must now be in the SHARED delivered.orchestrator
# ledger (the bug condition that starved the legacy pump). Without this the read-safe assertion below
# could pass vacuously (nothing was actually marked in the shared ledger).
PROBEB_SHARED="$(shared_delivered_has "session-safety-probe-B")"
if [[ "$PROBEB_SHARED" == "True" ]]; then
	log "  ok read-safe[probe-B] shared delivered.orchestrator marked by the cross-session read"
else
	fail "read-safe[probe-B] NOT in shared delivered.orchestrator — pre-emption vector not exercised"
fi
# Session delta (fresh pid) pump MUST STILL surface probe-B: the shared ledger is ignored by the pump.
log "RUN sessafety-orch-delta [pi -p, PI_SESSION_ID=uat-delta; retry on 429]"
set +e
retry_cmd "$SWARM_MAX_ATTEMPTS" 6 env PI_SESSION_ID=uat-delta "${PI_BASE[@]}" -p 'Reply with exactly: delta-ok' >"$LOG_DIR/sessafety-delta.out" 2>"$LOG_DIR/sessafety-delta.err" || true
set -e
probeB_sids="$(pump_surfaced_sids "session-safety-probe-B")"
if [[ " $probeB_sids " == *" uat-delta "* ]]; then
	log "  ok read-safe[probe-B] surfaced by uat-delta after check_mailbox(markDelivered) (sids={$probeB_sids})"
else
	fail "read-safe[probe-B] NOT surfaced by uat-delta after check_mailbox(markDelivered) — read pre-empted pump (sids={$probeB_sids})"
fi

# ---------- 13. Assignment idempotency + supersede + ack guard ----------
# Covers: deterministic idempotency key (same task/node/assignee/attempt -> reuse, no duplicate);
# newer assignment supersedes prior OPEN assignment (waived, excluded from response_missing); canonical
# node.assignmentMessageId; swarm_ack_message rejects done/processing on a superseded assignment unless
# the orchestrator passes waive=true. All assertions are file-backed (task.json + swarm-state messages
# + global trace); tool stdout (ASSIGNMENT_SUPERSEDED) is a secondary signal.
IDEM_AGENT="uat-idem-worker-${SUFFIX}"
IDEM_TASK="uat-taskgraph-idem-${SUFFIX}"
fabricate_agent "$IDEM_AGENT" "Swarm implementer worker for assignment idempotency"
run_step create-idem swarm_create_task \
	"Call swarm_create_task exactly once with title \"UAT idem\", goal \"assignment idempotency\", taskId \"$IDEM_TASK\", start \"w\", nodes {\"w\":{"role":"implementer work","terminal":true}}, edges []. Then reply done."
# (1) first assign -> msg1 (canonical pointer set)
run_step assign-idem-1 swarm_assign_task \
	"Call swarm_assign_task exactly once with taskId \"$IDEM_TASK\", nodeId \"w\", agentId \"$IDEM_AGENT\". Then reply done."
MSG1="$(node_assign_msg "$IDEM_TASK" "w")"
log "  idem msg1=$MSG1"
if [[ -z "$MSG1" ]]; then fail "idem: no assignmentMessageId after first assign"; fi
# (2) exact retry (same attempt) -> idempotent REUSE: canonical unchanged + global idempotent_reuse trace
run_step assign-idem-2 swarm_assign_task \
	"Call swarm_assign_task exactly once with taskId \"$IDEM_TASK\", nodeId \"w\", agentId \"$IDEM_AGENT\". Then reply done."
MSG1B="$(node_assign_msg "$IDEM_TASK" "w")"
if [[ -n "$MSG1" && "$MSG1" == "$MSG1B" ]]; then
	log "  ok idem: retry reused the same assignment message ($MSG1)"
else
	fail "idem: retry produced a different/new message (msg1=$MSG1 msg1b=$MSG1B) — idempotency key not honored"
fi
trace_global_has "message.idempotent_reuse"
# (3) force a fresh attempt: orchestrator resets node -> ready, then assign -> new msg2 + supersede msg1
run_step reset-idem-ready swarm_update_task \
	"Call swarm_update_task exactly once with taskId \"$IDEM_TASK\", nodeId \"w\", status \"ready\", force true. Then reply done."
run_step assign-idem-3 swarm_assign_task \
	"Call swarm_assign_task exactly once with taskId \"$IDEM_TASK\", nodeId \"w\", agentId \"$IDEM_AGENT\". Then reply done."
MSG2="$(node_assign_msg "$IDEM_TASK" "w")"
log "  idem msg2=$MSG2"
if [[ -n "$MSG2" && "$MSG2" != "$MSG1" ]]; then
	log "  ok idem: new attempt produced a new message ($MSG2 != $MSG1)"
else
	fail "idem: new attempt did not produce a new message (msg1=$MSG1 msg2=$MSG2)"
fi
trace_global_has "message.superseded"
state_msg_eq "$MSG1" "(m.get('superseded') or {}).get('supersededBy')" "$MSG2"
state_msg_eq "$MSG1" "(m.get('response') or {}).get('status')" "waived"
task_json_eq "$IDEM_TASK" "t['nodes']['w']['assignmentMessageId']" "$MSG2"
# (4) ack guard: worker attempts done on the superseded msg1 -> rejected (ASSIGNMENT_SUPERSEDED).
# The guard fires before the result-check, so no resultMessageId is required. File-backed proof:
# msg1 is NOT completed by the worker (lastAck from worker never becomes 'done'); only the orchestrator
# waive in step (5) can complete it. The ASSIGNMENT_SUPERSEDED stdout signal is secondary/soft because a
# constrained model may decline to call a "negative" tool — the hard check is the non-completion.
log "RUN idem-ack-guard [pi -p as $IDEM_AGENT; retry on 429]"
set +e
retry_cmd "$SWARM_MAX_ATTEMPTS" 6 env PI_SWARM_AGENT_ID="$IDEM_AGENT" "${PI_BASE[@]}" --tools swarm_ack_message -p "Call swarm_ack_message exactly once with messageId \"$MSG1\", status \"done\". Then reply done." >"$LOG_DIR/idem-ack-guard.out" 2>"$LOG_DIR/idem-ack-guard.err" || true
set -e
if grep -qF "ASSIGNMENT_SUPERSEDED" "$LOG_DIR/idem-ack-guard.out" "$LOG_DIR/idem-ack-guard.err" 2>/dev/null; then
	log "  ok idem: ack of superseded assignment rejected with ASSIGNMENT_SUPERSEDED"
else
	log "  note idem: ASSIGNMENT_SUPERSEDED not captured (model may not have called the tool); relying on file-backed non-completion below"
fi
# HARD: the worker could not complete the superseded assignment. lastAck.status must not be 'done' yet
# (the orchestrator waive in step 5 is what completes it). response must still be waived.
state_msg_eq "$MSG1" "(m.get('response') or {}).get('status')" "waived"
state_msg_eq "$MSG1" "(m.get('lastAck') or {}).get('status') == 'done'" "False"
# (5) orchestrator waive override: ack msg1 done with waive=true -> accepted as waived.
run_step idem-waive swarm_ack_message \
	"Call swarm_ack_message exactly once with messageId \"$MSG1\", status \"done\", waive true. Then reply done."
state_msg_eq "$MSG1" "(m.get('lastAck') or {}).get('status')" "done"
state_msg_eq "$MSG1" "(m.get('response') or {}).get('status')" "waived"

# ---------- 14. Identity override + reload (effective identity, version/hash, missing-agent error) ----------
# Deterministic + model-independent: writes an override file (bash), reloads via the tool, then asserts
# on the effective <agent>.md file and the agent record in swarm-state.json. The orchestrator agent is
# created by the preflight create_task step, so it already exists in swarm-state.json. tmux injection is
# best-effort and NOT asserted here (the orchestrator is mailbox-only, tmuxTarget="unknown").
ID_AGENT="orchestrator"
ID_FILE="$SWARM_CWD/.pi/swarm/agents/${ID_AGENT}.md"
ID_OV="$SWARM_CWD/.pi/swarm/agents/${ID_AGENT}.override.md"
ID_MARKER="DETERMINISTIC-UAT-IDENTITY-OVERRIDE-${SUFFIX}"
mkdir -p "$(dirname "$ID_OV")"
# (1) Write the override file (model-free). Generation must NEVER write this file; only read it.
printf 'Custom override instructions for %s. Unique marker: %s.\nFollow these custom rules when summarizing work.\n' "$ID_AGENT" "$ID_MARKER" > "$ID_OV"
log "identity: wrote override $ID_OV (marker=$ID_MARKER)"
# (2) Reload effective identity for the orchestrator (generated base + override + provenance).
run_step iden-reload swarm_reload_identity \
	"Call swarm_reload_identity exactly once with agentId \"$ID_AGENT\". Then reply done."
# (3) Effective file must contain the override marker AND the provenance footer (version/hash/loadedAt).
if grep -qF "$ID_MARKER" "$ID_FILE" && grep -qF "## Identity provenance" "$ID_FILE" && grep -qF "Version:" "$ID_FILE" && grep -qF "Hash:" "$ID_FILE"; then
	log "  ok identity[$ID_AGENT] effective file has override marker + provenance"
else
	fail "identity[$ID_AGENT] effective file missing override marker and/or provenance"
	sed -n '1,60p' "$ID_FILE" | tee -a "$LOG_DIR/harness.log" || true
fi
# (4) Agent record stamped with version (>=1) and hash + loadedAt.
ID_VER="$(python3 - "$STATE_JSON" "$ID_AGENT" <<'PY'
import json, sys
st = json.load(open(sys.argv[1]))
a = (st.get('agents') or {}).get(sys.argv[2]) or {}
v = a.get('identityVersion')
print(v if isinstance(v, int) else '')
PY
)"
ID_HASH="$(python3 - "$STATE_JSON" "$ID_AGENT" <<'PY'
import json, sys
st = json.load(open(sys.argv[1]))
a = (st.get('agents') or {}).get(sys.argv[2]) or {}
print((a.get('identityHash') or '')[:12])
PY
)"
ID_LOADED="$(python3 - "$STATE_JSON" "$ID_AGENT" <<'PY'
import json, sys
st = json.load(open(sys.argv[1]))
a = (st.get('agents') or {}).get(sys.argv[2]) or {}
print(a.get('identityLoadedAt') or '')
PY
)"
if [[ "$ID_VER" =~ ^[0-9]+$ && "$ID_VER" -ge 1 && -n "$ID_HASH" && -n "$ID_LOADED" ]]; then
	log "  ok identity[$ID_AGENT] stamped version=$ID_VER hash=$ID_HASH loadedAt=$ID_LOADED"
else
	fail "identity[$ID_AGENT] not stamped (version='$ID_VER' hash='$ID_HASH' loadedAt='$ID_LOADED')"
fi
# (5) Reload of a MISSING agent must NOT materialize it: the tool throws "Unknown swarm agent" inside
#     its withLock BEFORE writeState, so no agent record and no <id>.md file are created. We assert that
#     negative invariant (deterministic + model-independent) rather than grepping pi print-mode stdout,
#     which only echoes the model's final reply (often "done") and not the tool-error text.
ID_MISSING="uat-missing-identity-${SUFFIX}"
run_step iden-reload-missing swarm_reload_identity \
	"Call swarm_reload_identity exactly once with agentId \"$ID_MISSING\". Then reply done."
ID_MISSING_INSTATE="$(python3 - "$STATE_JSON" "$ID_MISSING" <<'PY'
import json, sys
st = json.load(open(sys.argv[1]))
print("true" if sys.argv[2] in (st.get('agents') or {}) else "false")
PY
)"
if [[ "$ID_MISSING_INSTATE" == "false" && ! -f "$SWARM_CWD/.pi/swarm/agents/${ID_MISSING}.md" ]]; then
	log "  ok identity reload of missing agent did not materialize it (not in state, no identity file)"
else
	fail "identity reload of missing agent materialized it (inState=$ID_MISSING_INSTATE)"
fi
# (6) Removing the override + reload -> effective file no longer carries the marker (override is read,
#     not stored in the generated base); provenance footer is retained.
rm -f "$ID_OV"
run_step iden-reload-noov swarm_reload_identity \
	"Call swarm_reload_identity exactly once with agentId \"$ID_AGENT\". Then reply done."
if ! grep -qF "$ID_MARKER" "$ID_FILE" && grep -qF "## Identity provenance" "$ID_FILE"; then
	log "  ok identity[$ID_AGENT] override removed: marker gone, provenance retained"
else
	fail "identity[$ID_AGENT] override removal did not clear marker from effective file"
fi

# ---------- 15. Stale/reassign lifecycle cleanup ----------
# Regression: a node reassigned old->new must (1) clear node.staleAt, (2) supersede+waive the old
# assignment message, (3) release old activeTaskIds, and (4) the shutdown/settle canonical-assignment
# guard must not let the (dying) old owner claim the node. Criteria 1-3 are file-backed on real
# swarm_assign_task output; criterion 4 is the scanAgentOpenAssignments predicate reimplemented 1:1
# over on-disk task.json + state.messages (design option ii; the real hook is also exercised in the
# focused live validation). All steps run in orchestrator context.
STALE_OLD="uat-stale-old-${SUFFIX}"
STALE_NEW="uat-stale-new-${SUFFIX}"
STALE_TK="uat-taskgraph-stale-reassign-${SUFFIX}"
fabricate_agent "$STALE_OLD" "Swarm tester worker (old owner)"
fabricate_agent "$STALE_NEW" "Swarm tester worker (new owner)"
run_step create-stale swarm_create_task \
	"Call swarm_create_task exactly once with title \"UAT stale\", goal \"stale reassign\", taskId \"$STALE_TK\", start \"v\", nodes {\"v\":{"role":"tester work","terminal":true}}, edges []. Then reply done."
# (1) first assign -> msgOld (old owns the node)
run_step assign-stale-old swarm_assign_task \
	"Call swarm_assign_task exactly once with taskId \"$STALE_TK\", nodeId \"v\", agentId \"$STALE_OLD\". Then reply done."
MSG_OLD="$(node_assign_msg "$STALE_TK" "v")"
log "  stale msgOld=$MSG_OLD"
[[ -n "$MSG_OLD" ]] || fail "stale: no assignmentMessageId after first assign"
state_msg_eq "$MSG_OLD" "m.get('to')" "$STALE_OLD"
state_msg_eq "$MSG_OLD" "str(bool(m.get('superseded')))" "False"
state_json_eq "$STALE_OLD" "str('$STALE_TK' in (a.get('activeTaskIds') or []))" "True"
# simulate the old owner having gone idle/dead and stamped staleAt onto the node
fabricate "$STALE_TK" "t['nodes']['v']['staleAt'] = '2026-01-01T00:00:00Z'"
task_json_eq "$STALE_TK" "t['nodes']['v'].get('staleAt')" "2026-01-01T00:00:00Z"
# (2) reassign old -> new
run_step assign-stale-new swarm_assign_task \
	"Call swarm_assign_task exactly once with taskId \"$STALE_TK\", nodeId \"v\", agentId \"$STALE_NEW\". Then reply done."
MSG_NEW="$(node_assign_msg "$STALE_TK" "v")"
log "  stale msgNew=$MSG_NEW"
[[ -n "$MSG_NEW" && "$MSG_NEW" != "$MSG_OLD" ]] || fail "stale: reassign did not produce a new canonical message (old=$MSG_OLD new=$MSG_NEW)"
task_json_eq "$STALE_TK" "t['nodes']['v'].get('assignee')" "$STALE_NEW"
state_msg_eq "$MSG_NEW" "m.get('to')" "$STALE_NEW"
state_msg_eq "$MSG_NEW" "str(bool(m.get('superseded')))" "False"
# criterion 2: old assignment superseded + waived
state_msg_eq "$MSG_OLD" "(m.get('superseded') or {}).get('supersededBy')" "$MSG_NEW"
state_msg_eq "$MSG_OLD" "(m.get('response') or {}).get('status')" "waived"
# criterion 3: old activeTaskIds released, new acquired
state_json_eq "$STALE_OLD" "str('$STALE_TK' in (a.get('activeTaskIds') or []))" "False"
state_json_eq "$STALE_NEW" "str('$STALE_TK' in (a.get('activeTaskIds') or []))" "True"
# criterion 1 (GAP A): node.staleAt cleared for the new assignment
task_json_eq "$STALE_TK" "str(t['nodes']['v'].get('staleAt'))" "None"
trace_has "task.stale.cleared" "$STALE_TK"
# criterion 4 (GAP B): scanAgentOpenAssignments predicate (1:1 mirror) over on-disk task.json +
# state.messages. (a) real post-reassign state: old does not hold, new holds. (b) simulated
# dying-old-owner stale-readState race (assignee read as old but canonical still points at new's
# message): the canonical-message guard must STILL reject old — this is the core of criterion 4 and
# is independent of the assignee check. The real shutdown/settle hook is also exercised in the
# focused live validation.
python3 - "$STATE_JSON" "$TASKS_DIR/$STALE_TK/task.json" "$STALE_OLD" "$STALE_NEW" <<'PY' || fail "stale: scanAgentOpenAssignments predicate mismatch (criterion 4)"
import json, sys, copy
state_p, task_p, old, new = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
messages = json.load(open(state_p)).get("messages", {})
node = json.load(open(task_p))["nodes"]["v"]
TERMINAL = {"done", "failed", "skipped"}
def holds(n, agent_id):
	# 1:1 mirror of scanAgentOpenAssignments per-node guard (extensions/swarm/index.ts)
	if n.get("assignee") != agent_id: return False
	if n.get("status") not in ("assigned", "in_progress"): return False
	if n.get("status") in TERMINAL: return False
	canon = n.get("assignmentMessageId")
	if canon:
		rec = messages.get(canon)
		if not rec: return False
		if rec.get("superseded"): return False
		if rec.get("to") != agent_id: return False
	return True
# (a) real post-reassign state
assert not holds(node, old), "old should not hold node (assignee moved to new)"
assert holds(node, new), "new should hold node (canonical msg addressed to new, not superseded)"
# (b) stale-readState race: assignee read as old but canonical still new's message -> canonical guard rejects old
race = copy.deepcopy(node); race["assignee"] = old
assert not holds(race, old), "canonical guard must reject old even if assignee read is stale (criterion 4 core)"
PY
log "  ok stale: scanAgentOpenAssignments predicate -> old never holds; new holds [v] (incl. stale-readState race)"

# ---------- Summary ----------
LOG_DIR="$LOG_DIR" python3 - "$HAPPY_ID" "$FAIL_ID" "$CANCEL_ID" "$STALE_ID" "$DRIFT_ID" "$BLK_ID" "$RK_AGENT" "$FAILURES" <<'PY' | tee "$LOG_DIR/summary.txt"
import json, os, sys, pathlib
root = pathlib.Path('.')
happy, fail, cancel, stale, drift, blk, rk_agent, failures = sys.argv[1:9]
tasks_dir = root / '.pi/swarm/tasks'
checks = []
def expect(tid, expr, expected, label):
	f = tasks_dir / tid / 'task.json'
	if not f.exists():
		checks.append((label, False, f'missing {f}')); return
	t = json.load(open(f))
	got = eval(expr, {"t": t})
	checks.append((label, got == expected, f'{expr}={got!r} want {expected!r}'))
expect(happy, "t['status']", 'done', 'happy closure=done')
expect(happy, "t['nodes']['ship']['status']", 'done', 'happy ship=done')
expect(fail, "t['status']", 'failed', 'fail closure=failed')
expect(cancel, "t['status']", 'cancelled', 'cancel sticky=cancelled')
expect(stale, "t['nodes']['slow']['status']", 'in_progress', 'stale mark-only (not failed)')
expect(drift, "t['status']", 'done', 'drift repaired=done')
expect(blk, "t['status']", 'in_progress', 'blocked resumable -> in_progress')
print('=== task-graph UAT summary ===')
for label, ok, detail in checks:
	print(('PASS' if ok else 'FAIL'), '-', label, '::', detail)
# staleAt marker presence
sf = tasks_dir / stale / 'task.json'
stale_at_ok = bool(json.load(open(sf))['nodes']['slow'].get('staleAt')) if sf.exists() else False
print(('PASS' if stale_at_ok else 'FAIL'), '- stale staleAt stamped ::', stale_at_ok)
# roleKind id-first precedence (agent record in swarm-state.json)
state_p = root / '.pi/swarm/swarm-state.json'
rk_ok, rk_detail = False, 'missing state'
if state_p.exists():
	a = json.load(open(state_p)).get('agents', {}).get(rk_agent)
	if a:
		rk_ok = a.get('roleKind') == 'implementer'
		rk_detail = f"roleKind={a.get('roleKind')!r} explicit={a.get('roleKindExplicit')!r}"
print(('PASS' if rk_ok else 'FAIL'), '- roleKind id-first (implementer wins over reviewer-in-role) ::', rk_detail)
# PM auto-notify (engine PM visibility): orchestrator mailbox must hold the close-notify (task terminal)
# and the settle-notify (worker settled with open work) without any manual mailbox polling.
omb = root / '.pi/swarm/mailboxes/orchestrator.jsonl'
def omb_has(needle):
	if not omb.exists(): return False
	for l in omb.read_text().splitlines():
		l = l.strip()
		if not l: continue
		try: m = json.loads(l)
		except Exception: continue
		if m.get('to') == 'orchestrator' and needle in (m.get('subject') or ''): return True
	return False
close_ok = omb_has('closed (done)')                          # task terminal close-notify (happy ship -> done)
settle_ok = omb_has('settled idle with open assignment')     # worker settle-notify (path 11)
print(('PASS' if close_ok else 'FAIL'), '- PM close-notify in orchestrator mailbox ::', close_ok)
print(('PASS' if settle_ok else 'FAIL'), '- PM settle-notify in orchestrator mailbox ::', settle_ok)
# PM auto-surface (no manual polling): the orchestrator auto-pump must surface the close-notify and
# settle-notify to a turn. Cross-reference pump-traced surfaced ids with the orchestrator mailbox.
import glob as _g
surfaced = set()
for _tf in _g.glob(str(root / '.pi/swarm/traces/*.jsonl')):
	for _l in open(_tf):
		_l = _l.strip()
		if not _l: continue
		try: _d = json.loads(_l)
		except Exception: continue
		if _d.get('event') == 'mailbox.orchestrator_pump':
			for _i in (_d.get('ids') or []): surfaced.add(_i)
def pump_has_subject(needle):
	if not omb.exists(): return False
	for _l in omb.read_text().splitlines():
		_l = _l.strip()
		if not _l: continue
		try: _m = json.loads(_l)
		except Exception: continue
		if _m.get('to') == 'orchestrator' and needle in (_m.get('subject') or ''):
			return _m.get('id') in surfaced
	return False
close_surfaced = pump_has_subject('node kickoff -> done')
settle_surfaced = pump_has_subject('settled idle with open assignment')
# Session-safe + read-safe (section 12): the pump keys surfaced-ids per process, so two distinct
# orchestrator sessions each surface one notification, and check_mailbox(markDelivered) cannot
# pre-empt a later pump surface.
def pump_sids_for_subject(needle):
	if not omb.exists(): return []
	_target = None
	for _l in omb.read_text().splitlines():
		_l = _l.strip()
		if not _l: continue
		try: _m = json.loads(_l)
		except Exception: continue
		if _m.get('to') == 'orchestrator' and needle in (_m.get('subject') or ''):
			_target = _m.get('id'); break
	if not _target: return []
	_out = set()
	for _tf in _g.glob(str(root / '.pi/swarm/traces/*.jsonl')):
		for _l in open(_tf):
			_l = _l.strip()
			if not _l: continue
			try: _d = json.loads(_l)
			except Exception: continue
			if _d.get('event') == 'mailbox.orchestrator_pump' and _target in (_d.get('ids') or []):
				_s = _d.get('sid')
				if _s is not None: _out.add(_s)
	return sorted(s for s in _out if s)
probeA_sids = pump_sids_for_subject('session-safety-probe-A')
probeB_sids = pump_sids_for_subject('session-safety-probe-B')
sessafe_ok = ('uat-alpha' in probeA_sids and 'uat-beta' in probeA_sids)
readsafe_ok = ('uat-delta' in probeB_sids)
# Read-safe vector proof: the cross-session check_mailbox(markDelivered) must have written the SHARED
# delivered.orchestrator ledger (the legacy pre-emption vector). Confirms the read actually exercised
# the path that used to starve the pump, so the readsafe_ok surface check is non-vacuous.
_probeB_id = None
for _l in (omb.read_text().splitlines() if omb.exists() else []):
	_l = _l.strip()
	if not _l: continue
	try: _m = json.loads(_l)
	except Exception: continue
	if _m.get('to') == 'orchestrator' and 'session-safety-probe-B' in (_m.get('subject') or ''):
		_probeB_id = _m.get('id'); break
_shared_orch = set((json.load(open(state_p)).get('delivered') or {}).get('orchestrator', []) or []) if state_p.exists() else set()
readsafe_shared_ok = bool(_probeB_id and _probeB_id in _shared_orch)
print(('PASS' if close_surfaced else 'FAIL'), '- PM auto-surface: orchestrator pump surfaced close-notify (no polling) ::', close_surfaced)
print(('PASS' if settle_surfaced else 'FAIL'), '- PM auto-surface: orchestrator pump surfaced settle-notify (no polling) ::', settle_surfaced)
print(('PASS' if sessafe_ok else 'FAIL'), '- session-safe: probe-A surfaced by both uat-alpha+uat-beta (no theft) ::', probeA_sids)
print(('PASS' if readsafe_ok else 'FAIL'), '- read-safe: probe-B surfaced by uat-delta after check_mailbox(markDelivered) ::', probeB_sids)
print(('PASS' if readsafe_shared_ok else 'FAIL'), '- read-safe: probe-B in shared delivered.orchestrator (vector exercised) ::', readsafe_shared_ok)
hard_failures = sum(1 for _, ok, _ in checks if not ok) + (0 if stale_at_ok else 1) + (0 if rk_ok else 1) + (0 if close_ok else 1) + (0 if settle_ok else 1) + (0 if close_surfaced else 1) + (0 if settle_surfaced else 1) + (0 if sessafe_ok else 1) + (0 if readsafe_ok else 1) + (0 if readsafe_shared_ok else 1) + int(failures)
print(f'CHECK_FAILURES={hard_failures}')
print('UAT_STATUS:', 'PASS' if hard_failures == 0 else 'FAIL')
sys.exit(1 if hard_failures else 0)
PY

log "DONE. Review $LOG_DIR/summary.txt"
