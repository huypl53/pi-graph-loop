#!/usr/bin/env bash
set -euo pipefail

# Repeatable task-graph UAT for .pi/extensions/swarm/index.ts (Commit 4/5-class flows).
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
EXT="$ROOT/.pi/extensions/swarm/index.ts"
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
