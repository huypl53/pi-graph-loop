#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  tmux_run_capture.sh --list [--snapdir DIR]
  tmux_run_capture.sh [--create-session NAME] [--reuse-session] [--window-name NAME] [--cwd DIR] [-s SNAPDIR]
  tmux_run_capture.sh [-t TARGET] [--create-session NAME] [--reuse-session] [--window-name NAME] [--cwd DIR] -c COMMAND [-d DEBOUNCE] [-p POST_PAUSE] [-s SNAPDIR] [--history-start N] [--wait-for PATTERN] [--wait-timeout SECONDS] [--wait-interval SECONDS]

Options:
  -t, --target TARGET       tmux target, e.g. session:window.pane
                            If omitted, resolve the active pane or the created session pane.
  -c, --command COMMAND     command text to type into the pane
      --create-session NAME create a detached tmux session for this run
      --reuse-session       reuse the named session if it already exists
      --window-name NAME    initial window name when creating a session (default: validate)
      --cwd DIR             working directory for a created session/window
  -d, --debounce SECONDS    wait before C-m (default: 0.15)
  -p, --post-pause SECONDS  wait after C-m before capturing (default: 0.40)
  -s, --snapdir DIR         snapshot directory (default: ./tmux-snapshots/<timestamp>)
      --history-start N     capture pane history from line N (default: -2000)
      --wait-for PATTERN    regex to wait for in pane output after command or creation
      --wait-timeout SEC    max seconds to wait for pattern (default: 10)
      --wait-interval SEC   polling interval while waiting (default: 0.25)
      --list                write tmux discovery files and print discovery JSON
  -h, --help                show help

Outputs:
  - before.txt / after.txt
  - before.meta / after.meta
  - panes.before.txt / panes.after.txt
  - windows.before.txt / windows.after.txt
  - diff.txt
  - excerpt.txt
  - result.json
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 127
  }
}

write_discovery() {
  local suffix="$1"
  tmux list-panes -a -F 'id=#{pane_id}\ttarget=#{session_name}:#{window_index}.#{pane_index}\tactive=#{pane_active}\tdead=#{pane_dead}\twindow_active=#{window_active}\tsize=#{pane_width}x#{pane_height}\ttitle=#{pane_title}\tpath=#{pane_current_path}\tcmd=#{pane_current_command}' > "$snapdir/panes.${suffix}.txt"
  tmux list-windows -a -F '#{session_name}:#{window_index}\tactive=#{window_active}\tname=#{window_name}\tpanes=#{window_panes}\tlayout=#{window_layout}' > "$snapdir/windows.${suffix}.txt"
}

resolve_active_target() {
  tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'
}

resolve_first_pane_for_session() {
  local session_name="$1"
  tmux list-panes -t "${session_name}:0" -F '#{session_name}:#{window_index}.#{pane_index}' | head -n 1
}

capture_meta() {
  local file="$1"
  {
    echo "target=$resolved_target"
    echo "time=$(date -Iseconds)"
    tmux list-panes -t "$resolved_target" -F 'id=#{pane_id} target=#{session_name}:#{window_index}.#{pane_index} active=#{pane_active} dead=#{pane_dead} window_active=#{window_active} size=#{pane_width}x#{pane_height} title=#{pane_title} path=#{pane_current_path} cmd=#{pane_current_command}'
  } > "$file"
}

capture_pane() {
  local file="$1"
  tmux capture-pane -p -J -S "$history_start" -t "$resolved_target" > "$file"
}

write_diff_and_excerpt() {
  python3 - "$pane_before" "$pane_after" "$diff_file" "$excerpt_file" <<'PY'
import difflib, json, pathlib, sys
before_path, after_path, diff_path, excerpt_path = sys.argv[1:5]
before = pathlib.Path(before_path).read_text(errors='replace').splitlines()
after = pathlib.Path(after_path).read_text(errors='replace').splitlines()
diff = list(difflib.unified_diff(before, after, fromfile='before.txt', tofile='after.txt', lineterm=''))
pathlib.Path(diff_path).write_text('\n'.join(diff) + ('\n' if diff else ''), encoding='utf-8')
added = [line[1:] for line in diff if line.startswith('+') and not line.startswith('+++')]
removed = [line[1:] for line in diff if line.startswith('-') and not line.startswith('---')]
excerpt_lines = added[-20:] if added else after[-20:]
excerpt = '\n'.join(excerpt_lines)
pathlib.Path(excerpt_path).write_text(excerpt + ('\n' if excerpt else ''), encoding='utf-8')
print(json.dumps({
  'changed': before != after,
  'added_line_count': len(added),
  'removed_line_count': len(removed),
  'excerpt': excerpt,
}, ensure_ascii=False))
PY
}

create_session_if_requested() {
  if [[ -z "$create_session" ]]; then
    return
  fi

  if tmux has-session -t "$create_session" 2>/dev/null; then
    if [[ "$reuse_session" -eq 1 ]]; then
      session_created=0
    else
      echo "tmux session already exists: $create_session (use --reuse-session to allow reuse)" >&2
      exit 3
    fi
  else
    local args=(-d -s "$create_session" -n "$window_name")
    if [[ -n "$cwd" ]]; then
      args+=(-c "$cwd")
    fi
    tmux new-session "${args[@]}"
    session_created=1
  fi

  resolved_target="${target:-$(resolve_first_pane_for_session "$create_session")}"
}

pane_matches_pattern() {
  local pattern="$1"
  local capture
  capture="$(tmux capture-pane -p -J -S "$history_start" -t "$resolved_target")"
  TMUX_CAPTURE="$capture" python3 - "$pattern" <<'PY'
import os, re, sys
pattern = sys.argv[1]
text = os.environ.get('TMUX_CAPTURE', '')
try:
    matched = re.search(pattern, text, re.MULTILINE) is not None
except re.error as e:
    print(f"Invalid regex for --wait-for: {e}", file=sys.stderr)
    sys.exit(2)
sys.exit(0 if matched else 1)
PY
}

wait_for_pattern_if_requested() {
  wait_status="not_requested"
  wait_elapsed_seconds="0"

  if [[ -z "$wait_for" ]]; then
    return
  fi

  local start_ts now elapsed
  start_ts="$(python3 - <<'PY'
import time
print(time.time())
PY
)"

  while true; do
    if pane_matches_pattern "$wait_for"; then
      now="$(python3 - <<'PY'
import time
print(time.time())
PY
)"
      wait_elapsed_seconds="$(python3 - "$start_ts" "$now" <<'PY'
import sys
start, now = map(float, sys.argv[1:3])
print(f"{now-start:.3f}")
PY
)"
      wait_status="matched"
      return
    fi

    now="$(python3 - <<'PY'
import time
print(time.time())
PY
)"
    elapsed="$(python3 - "$start_ts" "$now" <<'PY'
import sys
start, now = map(float, sys.argv[1:3])
print(now-start)
PY
)"

    if python3 - "$elapsed" "$wait_timeout" <<'PY'
import sys
elapsed, timeout = map(float, sys.argv[1:3])
sys.exit(0 if elapsed >= timeout else 1)
PY
    then
      wait_elapsed_seconds="$(python3 - "$elapsed" <<'PY'
import sys
print(f"{float(sys.argv[1]):.3f}")
PY
)"
      wait_status="timeout"
      return
    fi

    sleep "$wait_interval"
  done
}

require_cmd tmux
require_cmd python3

list_only=0
target=""
cmd=""
debounce="0.15"
post_pause="0.40"
snapdir=""
history_start="-2000"
create_session=""
reuse_session=0
window_name="validate"
cwd=""
wait_for=""
wait_timeout="10"
wait_interval="0.25"
mode="send"
session_created=0
wait_status="not_requested"
wait_elapsed_seconds="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--target)
      target="${2:-}"
      shift 2
      ;;
    -c|--command)
      cmd="${2:-}"
      shift 2
      ;;
    --create-session)
      create_session="${2:-}"
      shift 2
      ;;
    --reuse-session)
      reuse_session=1
      shift
      ;;
    --window-name)
      window_name="${2:-}"
      shift 2
      ;;
    --cwd)
      cwd="${2:-}"
      shift 2
      ;;
    -d|--debounce)
      debounce="${2:-}"
      shift 2
      ;;
    -p|--post-pause)
      post_pause="${2:-}"
      shift 2
      ;;
    -s|--snapdir)
      snapdir="${2:-}"
      shift 2
      ;;
    --history-start)
      history_start="${2:-}"
      shift 2
      ;;
    --wait-for)
      wait_for="${2:-}"
      shift 2
      ;;
    --wait-timeout)
      wait_timeout="${2:-}"
      shift 2
      ;;
    --wait-interval)
      wait_interval="${2:-}"
      shift 2
      ;;
    --list)
      list_only=1
      mode="discovery"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$snapdir" ]]; then
  snapdir="./tmux-snapshots/$(date +%Y%m%d-%H%M%S)"
fi
mkdir -p "$snapdir"

if [[ "$list_only" -eq 1 ]]; then
  resolved_target="${target:-$(resolve_active_target)}"
  write_discovery "discovery"
  result_json="$snapdir/discovery.json"
  python3 - "$snapdir" "$resolved_target" "$result_json" <<'PY'
import json, pathlib, sys
snapdir, resolved_target, result_json = sys.argv[1:4]
obj = {
  'mode': 'discovery',
  'resolved_target': resolved_target,
  'snapdir': snapdir,
  'files': {
    'panes': f'{snapdir}/panes.discovery.txt',
    'windows': f'{snapdir}/windows.discovery.txt',
  }
}
pathlib.Path(result_json).write_text(json.dumps(obj, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print(json.dumps(obj, ensure_ascii=False))
PY
  exit 0
fi

create_session_if_requested

if [[ -z "$create_session" ]]; then
  resolved_target="${target:-$(resolve_active_target)}"
fi

if [[ -z "$cmd" ]]; then
  mode="create"
else
  mode="send"
fi

meta_before="$snapdir/before.meta"
pane_before="$snapdir/before.txt"
meta_after="$snapdir/after.meta"
pane_after="$snapdir/after.txt"
diff_file="$snapdir/diff.txt"
excerpt_file="$snapdir/excerpt.txt"
result_file="$snapdir/result.json"

write_discovery "before"
capture_meta "$meta_before"
capture_pane "$pane_before"

if [[ -n "$cmd" ]]; then
  tmux send-keys -l -t "$resolved_target" "$cmd"
  sleep "$debounce"
  tmux send-keys -t "$resolved_target" C-m
  sleep "$post_pause"
fi

wait_for_pattern_if_requested

write_discovery "after"
capture_meta "$meta_after"
capture_pane "$pane_after"

diff_summary="$(write_diff_and_excerpt)"

python3 - "$result_file" "$mode" "$snapdir" "$target" "$resolved_target" "$cmd" "$debounce" "$post_pause" "$history_start" "$meta_before" "$pane_before" "$meta_after" "$pane_after" "$diff_file" "$excerpt_file" "$snapdir/panes.before.txt" "$snapdir/panes.after.txt" "$snapdir/windows.before.txt" "$snapdir/windows.after.txt" "$diff_summary" "$create_session" "$session_created" "$wait_for" "$wait_status" "$wait_timeout" "$wait_interval" "$wait_elapsed_seconds" <<'PY'
import json, pathlib, sys
(
  result_file, mode, snapdir, requested_target, resolved_target, cmd,
  debounce, post_pause, history_start,
  meta_before, pane_before, meta_after, pane_after,
  diff_file, excerpt_file,
  panes_before, panes_after, windows_before, windows_after,
  diff_summary_json,
  created_session_name, session_created,
  wait_for, wait_status, wait_timeout, wait_interval, wait_elapsed_seconds,
) = sys.argv[1:]
obj = {
  'status': 'ok',
  'mode': mode,
  'snapdir': snapdir,
  'requested_target': requested_target or None,
  'resolved_target': resolved_target,
  'command': cmd or None,
  'debounce_seconds': float(debounce),
  'post_pause_seconds': float(post_pause),
  'history_start': int(history_start),
  'session': {
    'requested_name': created_session_name or None,
    'created': bool(int(session_created)),
  },
  'wait': {
    'pattern': wait_for or None,
    'status': wait_status,
    'timeout_seconds': float(wait_timeout),
    'interval_seconds': float(wait_interval),
    'elapsed_seconds': float(wait_elapsed_seconds),
  },
  'files': {
    'before_meta': meta_before,
    'before_pane': pane_before,
    'after_meta': meta_after,
    'after_pane': pane_after,
    'panes_before': panes_before,
    'panes_after': panes_after,
    'windows_before': windows_before,
    'windows_after': windows_after,
    'diff': diff_file,
    'excerpt': excerpt_file,
  },
  'feedback': json.loads(diff_summary_json),
}
pathlib.Path(result_file).write_text(json.dumps(obj, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
print(json.dumps(obj, ensure_ascii=False))
PY
