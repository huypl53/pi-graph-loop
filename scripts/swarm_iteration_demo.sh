#!/usr/bin/env bash
set -euo pipefail

# Runnable UAT demo for the swarm metric/run/memory + iteration loop V1 tools.
#
# Exercises the full file-backed stack end-to-end against fixed literal ids inside an ISOLATED cwd
# (under .pi/swarm-uat/runs/, gitignored), so the live repo-root .pi/swarm/ is never touched:
#   metric contract -> runs -> memory -> iteration context
# plus the negative case: an incomplete-evidence run must NOT promote memory (the evidence gate
# rejects it; zero active memories may reference it).
#
# Primary assertions are file-backed (metrics/runs.jsonl/memory.jsonl/iterations.json/traces);
# tool stdout markers are secondary/best-effort. This makes the demo deterministic and
# model-independent in what it verifies.
#
# Usage:
#   scripts/swarm_iteration_demo.sh
#   SWARM_MODEL=glm-5.1 SWARM_PROVIDER=zai-coding-cn scripts/swarm_iteration_demo.sh
#   DEMO_MODE=single scripts/swarm_iteration_demo.sh        # one pi -p with the full narrative
#
# Env overrides: SWARM_MODEL, SWARM_PROVIDER, SWARM_CWD, DEMO_MODE (steps|single),
#                SWARM_MAX_ATTEMPTS, SWARM_STEP_DELAY.
#
# IMPORTANT: this uses the real packaged extension source extensions/swarm/index.ts. The repo copy
# at .pi/extensions/swarm/index.ts was removed; a guard below aborts if both ever exist (pi would
# double-register swarm via .pi/extensions auto-discovery).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${SWARM_MODEL:-glm-5.1}"
PROVIDER="${SWARM_PROVIDER:-zai-coding-cn}"
EXT="$ROOT/extensions/swarm/index.ts"
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_ID="iter-demo-${STAMP}"
LOG_DIR="$ROOT/.pi/swarm-uat/runs/${RUN_ID}"

# --- Duplicate-extension guard (acceptance requirement) ---------------------
if [[ ! -f "$EXT" ]]; then
	echo "FATAL: extension source not found at $EXT" >&2
	exit 2
fi
if [[ -f "$ROOT/.pi/extensions/swarm/index.ts" ]]; then
	echo "FATAL: $ROOT/.pi/extensions/swarm/index.ts also exists; pi would double-register swarm." >&2
	echo "       Remove the duplicate (keep only $EXT) and re-run." >&2
	exit 2
fi
command -v pi >/dev/null 2>&1 || { echo "FATAL: 'pi' not found on PATH." >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "FATAL: 'python3' not found on PATH (needed for assertions)." >&2; exit 2; }

# --- Isolation: never mutates live .pi/swarm/ -------------------------------
# The extension keys all state off ctx.cwd (.pi/swarm/...), so running pi from SWARM_CWD fully
# isolates metrics/runs/memory/iterations. Placed under runs/ (gitignored).
SWARM_CWD="${SWARM_CWD:-$LOG_DIR/cwd}"
mkdir -p "$LOG_DIR" "$SWARM_CWD"
cd "$SWARM_CWD"
# Opt in as orchestrator for a stable currentAgentId; memory_accept is a review action.
unset PI_SWARM_AGENT_ID
export PI_SWARM_IS_ORCHESTRATOR=1

DEMO_MODE="${DEMO_MODE:-steps}"
SWARM_MAX_ATTEMPTS="${SWARM_MAX_ATTEMPTS:-3}"
SWARM_STEP_DELAY="${SWARM_STEP_DELAY:-2}"

METRIC_ID="demo-quality-score"
BASELINE_ID="demo-baseline"
RUN001_ID="demo-run-001"
RUN002_ID="demo-run-002"
ITER_ID="demo-iter-001"
EV_DIR="$SWARM_CWD/.pi/swarm/demo-evidence"
RUNS_JSONL="$SWARM_CWD/.pi/swarm/runs/runs.jsonl"
MEM_JSONL="$SWARM_CWD/.pi/swarm/memory/memory.jsonl"
TRACE_JSONL="$SWARM_CWD/.pi/swarm/traces/events.jsonl"

PI_BASE=(pi --model "$MODEL" --provider "$PROVIDER" --approve -e "$EXT" --no-builtin-tools)
FAILURES=0

log() { printf '[iter-demo] %s\n' "$*" | tee -a "$LOG_DIR/harness.log"; }
fail() { log "FAIL: $*"; FAILURES=$((FAILURES + 1)); }

# run_step <name> <tool> <prompt>: invoke one constrained tool, capture stdout/stderr/exit. Retries
# on non-zero exit (provider 429 / transient model errors) with linear backoff.
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

# retry_cmd <max> <base_sleep> <cmd...>: run cmd, retry on non-zero up to max times with linear backoff.
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

# latest memoryId for a given sourceRunId from memory.jsonl (file-backed, robust).
memory_id_for_run() {
	local run_id="$1"
	python3 - "$MEM_JSONL" "$run_id" <<'PY'
import json, sys
f, run_id = sys.argv[1], sys.argv[2]
best = None
try:
    for line in open(f):
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("sourceRunId") == run_id:
            best = r.get("memoryId")
except FileNotFoundError:
    pass
print(best if best else "")
PY
}

prepare_evidence() {
	mkdir -p "$EV_DIR"
	cat >"$EV_DIR/baseline-summary.md" <<'MD'
# Baseline summary

quality_score=0.60, n=200 samples.
MD
	cat >"$EV_DIR/run-001-summary.md" <<'MD'
# Run 001 summary

quality_score=0.67 (+0.07 vs baseline). Prompt tightening.
MD
	cat >"$EV_DIR/run-001.patch" <<'DIFF'
--- a/prompt.txt
+++ b/prompt.txt
@@
-Be helpful.
+Be helpful, concise, and cite sources.
DIFF
	# NOTE: missing-summary.md is intentionally NOT created -> drives the negative case.
	log "evidence prepared under $EV_DIR (missing-summary.md deliberately absent)"
}

# --- The deterministic narrative (single source of truth for both modes) -----
narrative_prompt() {
	cat <<PROMPT
You are driving the swarm iteration demo. Call ONLY the named swarm tools, exactly as specified, in order. Do not skip steps. After each tool returns, print the exact marker line requested.

1) Call swarm_metric_define once with: id="$METRIC_ID", title="Demo quality score", primaryMetric={id:"quality_score",direction:"maximize",valueType:"number",source:{type:"artifact",artifactPath:".pi/swarm/demo-evidence/run-001-summary.md",jsonPath:"\$.quality_score"}}, validityRules=["evidence_required"], evidenceRequired=[".pi/swarm/demo-evidence/run-001-summary.md"]. Then print: DEMO_METRIC_DEFINED: $METRIC_ID

2) Call swarm_run_record once with: runId="$BASELINE_ID", metricContractId="$METRIC_ID", status="done", verdict="pass", metrics={quality_score:0.60}, inputs={set:"baseline"}, evidenceRefs=[".pi/swarm/demo-evidence/baseline-summary.md"]. Then print: DEMO_BASELINE: $BASELINE_ID

3) Call swarm_run_record once with: runId="$RUN001_ID", metricContractId="$METRIC_ID", status="done", verdict="pass", metrics={quality_score:0.67}, inputs={change:"prompt-tightening"}, evidenceRefs=[".pi/swarm/demo-evidence/run-001-summary.md",".pi/swarm/demo-evidence/run-001.patch"]. Then print: DEMO_RUN001: $RUN001_ID

4) Call swarm_run_compare once with: runIds=["$BASELINE_ID","$RUN001_ID"], metricId="quality_score". Then print: DEMO_COMPARE: best=$RUN001_ID

5) Call swarm_memory_propose once with: claim="Prompt tightening improved demo quality_score from 0.60 to 0.67", sourceRunId="$RUN001_ID", scope={kind:"metric-contract",id:"$METRIC_ID"}, confidence=0.8. Then print: DEMO_PROPOSE_VALID on its own line.

6) Call swarm_memory_accept once with: memoryId=<the memoryId returned by step 5>, status="active". Then print: DEMO_ACCEPT: active

7) Call swarm_memory_search once with: status="active", query="quality". Then print: DEMO_SEARCH_ACTIVE_DONE

8) Call swarm_run_record once with: runId="$RUN002_ID", metricContractId="$METRIC_ID", status="done", verdict="pass", metrics={quality_score:0.72}, inputs={change:"unverified"}, evidenceRefs=[".pi/swarm/demo-evidence/missing-summary.md"]. Then print: DEMO_RUN002: $RUN002_ID

9) Call swarm_memory_propose once with: claim="Unverified run-002 should NOT promote", sourceRunId="$RUN002_ID", scope={kind:"metric-contract",id:"$METRIC_ID"}, confidence=0.9. Then print: DEMO_PROPOSE_INCOMPLETE on its own line.

10) Call swarm_memory_search once with: status="active". Then print: DEMO_RUN002_PROMOTED: no

11) Call swarm_iteration_create once with: id="$ITER_ID", metricContractId="$METRIC_ID", baselineRunId="$BASELINE_ID", memoryIds=[<the memoryId from step 5>], goal="Improve demo quality_score". Then print: DEMO_ITER_CREATE: $ITER_ID

12) Call swarm_iteration_record once with: iterationId="$ITER_ID", runId="$RUN001_ID", label="prompt-tightening". Then print: DEMO_ITER_RECORD: best=$RUN001_ID

13) Call swarm_iteration_status once with: iterationId="$ITER_ID", includeContext=true. Then print: DEMO_ITER_STATUS_DONE

14) Call swarm_iteration_context once with: iterationId="$ITER_ID". Then print: DEMO_ITER_CONTEXT_DONE

Finally print exactly: DEMO_DONE
PROMPT
}

run_steps_mode() {
	log "DEMO_MODE=steps (deterministic, one tool per constrained pi -p)"

	run_step "01-metric-define" swarm_metric_define \
"Call swarm_metric_define exactly once with: id=\"$METRIC_ID\", title=\"Demo quality score\", primaryMetric={id:\"quality_score\",direction:\"maximize\",valueType:\"number\",source:{type:\"artifact\",artifactPath:\".pi/swarm/demo-evidence/run-001-summary.md\",jsonPath:\"\$.quality_score\"}}, validityRules=[\"evidence_required\"], evidenceRequired=[\".pi/swarm/demo-evidence/run-001-summary.md\"]. After it returns, print exactly this line: DEMO_METRIC_DEFINED: $METRIC_ID"

	run_step "02-run-baseline" swarm_run_record \
"Call swarm_run_record exactly once with: runId=\"$BASELINE_ID\", metricContractId=\"$METRIC_ID\", status=\"done\", verdict=\"pass\", metrics={quality_score:0.60}, inputs={set:\"baseline\"}, evidenceRefs=[\".pi/swarm/demo-evidence/baseline-summary.md\"]. After it returns, print exactly this line: DEMO_BASELINE: $BASELINE_ID"

	run_step "03-run-001" swarm_run_record \
"Call swarm_run_record exactly once with: runId=\"$RUN001_ID\", metricContractId=\"$METRIC_ID\", status=\"done\", verdict=\"pass\", metrics={quality_score:0.67}, inputs={change:\"prompt-tightening\"}, evidenceRefs=[\".pi/swarm/demo-evidence/run-001-summary.md\",\".pi/swarm/demo-evidence/run-001.patch\"]. After it returns, print exactly this line: DEMO_RUN001: $RUN001_ID"

	run_step "04-run-compare" swarm_run_compare \
"Call swarm_run_compare exactly once with: runIds=[\"$BASELINE_ID\",\"$RUN001_ID\"], metricId=\"quality_score\". After it returns, print exactly this line: DEMO_COMPARE: best=$RUN001_ID"

	run_step "05-memory-propose-valid" swarm_memory_propose \
"Call swarm_memory_propose exactly once with: claim=\"Prompt tightening improved demo quality_score from 0.60 to 0.67\", sourceRunId=\"$RUN001_ID\", scope={kind:\"metric-contract\",id:\"$METRIC_ID\"}, confidence=0.8. After it returns, print exactly: DEMO_PROPOSE_VALID"

	# Thread the memoryId from the file-backed store (robust; not stdout parsing).
	MEM001="$(memory_id_for_run "$RUN001_ID")"
	if [[ -z "$MEM001" ]]; then
		fail "could not resolve memoryId for $RUN001_ID from $MEM_JSONL (did step 5 run?)"
		MEM001="UNRESOLVED"
	else
		log "resolved mem001=$MEM001 from $MEM_JSONL"
	fi

	run_step "06-memory-accept" swarm_memory_accept \
"Call swarm_memory_accept exactly once with: memoryId=\"$MEM001\", status=\"active\". After it returns, print exactly: DEMO_ACCEPT: active"

	run_step "07-memory-search-active" swarm_memory_search \
"Call swarm_memory_search exactly once with: status=\"active\", query=\"quality\". After it returns, print exactly: DEMO_SEARCH_ACTIVE_DONE"

	run_step "08-run-002-incomplete" swarm_run_record \
"Call swarm_run_record exactly once with: runId=\"$RUN002_ID\", metricContractId=\"$METRIC_ID\", status=\"done\", verdict=\"pass\", metrics={quality_score:0.72}, inputs={change:\"unverified\"}, evidenceRefs=[\".pi/swarm/demo-evidence/missing-summary.md\"]. After it returns, print exactly this line: DEMO_RUN002: $RUN002_ID"

	run_step "09-memory-propose-incomplete" swarm_memory_propose \
"Call swarm_memory_propose exactly once with: claim=\"Unverified run-002 should NOT promote\", sourceRunId=\"$RUN002_ID\", scope={kind:\"metric-contract\",id:\"$METRIC_ID\"}, confidence=0.9. After it returns, print exactly: DEMO_PROPOSE_INCOMPLETE"

	run_step "10-memory-search-final" swarm_memory_search \
"Call swarm_memory_search exactly once with: status=\"active\". After it returns, print exactly: DEMO_RUN002_PROMOTED: no"

	run_step "11-iter-create" swarm_iteration_create \
"Call swarm_iteration_create exactly once with: id=\"$ITER_ID\", metricContractId=\"$METRIC_ID\", baselineRunId=\"$BASELINE_ID\", memoryIds=[\"$MEM001\"], goal=\"Improve demo quality_score\". After it returns, print exactly this line: DEMO_ITER_CREATE: $ITER_ID"

	run_step "12-iter-record" swarm_iteration_record \
"Call swarm_iteration_record exactly once with: iterationId=\"$ITER_ID\", runId=\"$RUN001_ID\", label=\"prompt-tightening\". After it returns, print exactly this line: DEMO_ITER_RECORD: best=$RUN001_ID"

	run_step "13-iter-status" swarm_iteration_status \
"Call swarm_iteration_status exactly once with: iterationId=\"$ITER_ID\", includeContext=true. After it returns, print exactly: DEMO_ITER_STATUS_DONE"

	run_step "14-iter-context" swarm_iteration_context \
"Call swarm_iteration_context exactly once with: iterationId=\"$ITER_ID\". After it returns, print exactly: DEMO_ITER_CONTEXT_DONE"

	# Best-effort stdout marker checks (file-backed assertions below are authoritative).
	grep -qF "DEMO_ITER_RECORD: best=$RUN001_ID" "$LOG_DIR/12-iter-record.out" && log "  note stdout echoed DEMO_ITER_RECORD marker" || true
	grep -qF "DEMO_RUN002_PROMOTED: no" "$LOG_DIR/10-memory-search-final.out" && log "  note stdout echoed DEMO_RUN002_PROMOTED=no" || true
}

run_single_mode() {
	log "DEMO_MODE=single (one pi -p with the full narrative; LLM-flaky, for interactive review)"
	set +e
	retry_cmd "$SWARM_MAX_ATTEMPTS" 6 "${PI_BASE[@]}" -p "$(cat "$LOG_DIR/demo.prompt.txt")" \
		>"$LOG_DIR/single.out" 2>"$LOG_DIR/single.err"
	local code=$?
	set -e
	printf '%s\n' "$code" >"$LOG_DIR/single.code"
	log "single mode exit=$code"
	[[ $code -ne 0 ]] && sed -n '1,80p' "$LOG_DIR/single.err" | tee -a "$LOG_DIR/harness.log" || true
	# In single mode the memoryId is threaded by the model itself; resolve it for assertions.
	MEM001="$(memory_id_for_run "$RUN001_ID")"
	[[ -z "$MEM001" ]] && MEM001="UNRESOLVED"
}

# =============================================================================
prepare_evidence
narrative_prompt >"$LOG_DIR/demo.prompt.txt"

case "$DEMO_MODE" in
	steps) run_steps_mode ;;
	single) run_single_mode ;;
	*) echo "FATAL: unknown DEMO_MODE='$DEMO_MODE' (use steps|single)" >&2; exit 2 ;;
esac

# --- File-backed assertions (primary) ---------------------------------------
log "assertions (file-backed; primary)"
ASSERT_RESULT="$(python3 - "$SWARM_CWD" "$ITER_ID" "$METRIC_ID" "$BASELINE_ID" "$RUN001_ID" "$RUN002_ID" "$MEM001" "$MEM_JSONL" "$RUNS_JSONL" "$TRACE_JSONL" <<'PY'
import json, os, sys, re
cwd, iter_id, metric_id, baseline_id, run001, run002, mem001, mem_jsonl, runs_jsonl, trace_jsonl = sys.argv[1:11]
results = []

def ok(label, cond):
    results.append((label, bool(cond)))

def read_jsonl(path):
    out = []
    try:
        for line in open(path):
            line = line.strip()
            if not line: continue
            try: out.append(json.loads(line))
            except Exception: pass
    except FileNotFoundError:
        pass
    return out

def latest_by_id(rows, idfield):
    latest = {}
    for r in rows:
        mid = r.get(idfield)
        if isinstance(mid, str):
            latest[mid] = r
    return latest

# metric contract
mc_path = os.path.join(cwd, ".pi/swarm/metrics", metric_id + ".json")
mc = None
if os.path.isfile(mc_path):
    try: mc = json.load(open(mc_path))
    except Exception: mc = None
ok("metric contract exists", mc is not None)
ok("metric direction=maximize", mc and mc.get("primaryMetric", {}).get("direction") == "maximize")

# runs
runs = read_jsonl(runs_jsonl)
run_ids = {r.get("runId") for r in runs}
ok("runs.jsonl has baseline", baseline_id in run_ids)
ok("runs.jsonl has run-001", run001 in run_ids)
ok("runs.jsonl has run-002", run002 in run_ids)
ok("runs.jsonl has exactly 3 distinct run ids", run_ids == {baseline_id, run001, run002})

# memory
mem_rows = read_jsonl(mem_jsonl)
latest_mem = latest_by_id(mem_rows, "memoryId")
active = [m for m in latest_mem.values() if m.get("status") == "active"]
ok("exactly one active memory", len(active) == 1)
ok("active memory sources run-001", any(m.get("sourceRunId") == run001 and m.get("status") == "active" for m in latest_mem.values()))
ok("NO active memory sources run-002 (incomplete evidence did not promote)", not any(m.get("sourceRunId") == run002 and m.get("status") == "active" for m in latest_mem.values()))
# run-002 propose must be rejected with a non-empty reason
r002_records = [m for m in mem_rows if m.get("sourceRunId") == run002]
r002_rejected = [m for m in r002_records if m.get("status") == "rejected" and m.get("rejectionReason")]
ok("run-002 memory rejected with non-empty reason", len(r002_rejected) >= 1)

# iteration session
iter_path = os.path.join(cwd, ".pi/swarm/iterations", iter_id + ".json")
sess = None
if os.path.isfile(iter_path):
    try: sess = json.load(open(iter_path))
    except Exception: sess = None
ok("iteration session exists", sess is not None)
ok("iteration bestRunId=run-001", sess and sess.get("bestRunId") == run001)
ok("iteration has >=2 entries", sess and len(sess.get("iterations", [])) >= 2)
ok("iteration pinnedMemoryIds includes mem001", sess and mem001 in (sess.get("pinnedMemoryIds") or []))

# traces
traces = read_jsonl(trace_jsonl)
events = [t.get("event") for t in traces]
def count(ev): return sum(1 for e in events if e == ev)
ok("trace has metric.define", count("metric.define") >= 1)
ok("trace has 3x run.record", count("run.record") >= 3)
ok("trace has run.compare", count("run.compare") >= 1)
ok("trace has 2x memory.propose", count("memory.propose") >= 2)
ok("trace has memory.accept", count("memory.accept") >= 1)
ok("trace has iteration.create", count("iteration.create") >= 1)
ok("trace has iteration.record", count("iteration.record") >= 1)
ok("trace has iteration.status", count("iteration.status") >= 1)
ok("trace has iteration.context", count("iteration.context") >= 1)

fails = sum(1 for _, c in results if not c)
for label, c in results:
    print(("PASS" if c else "FAIL"), "-", label)
print("ASSERT_FAILURES=" + str(fails))
PY
)"
echo "$ASSERT_RESULT" | tee -a "$LOG_DIR/harness.log"
ASSERT_FAILS="$(echo "$ASSERT_RESULT" | sed -n 's/^ASSERT_FAILURES=//p')"
[[ -z "$ASSERT_FAILS" ]] && ASSERT_FAILS=99
TOTAL_FAILS=$((FAILURES + ASSERT_FAILS))

log "DEMO_RUN002_PROMOTED: no (negative-case invariant asserted file-backed above)"
log "resolved LOG_DIR=$LOG_DIR"
log "ITER_DEMO_RESULT: $([ "$TOTAL_FAILS" -eq 0 ] && echo PASS || echo FAIL) (failures=$TOTAL_FAILS)"
[ "$TOTAL_FAILS" -eq 0 ] || exit 1
