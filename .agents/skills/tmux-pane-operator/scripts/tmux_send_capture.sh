#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  tmux_send_capture.sh --list [--snapdir DIR]
  tmux_send_capture.sh [-t TARGET] -c COMMAND [-d DEBOUNCE] [-p POST_PAUSE] [-s SNAPDIR] [--history-start N]

Options:
  -t, --target TARGET       tmux target, e.g. session:window.pane
                            If omitted, resolve the active pane.
  -c, --command COMMAND     command text to type into the pane
  -d, --debounce SECONDS    wait before C-m (default: 0.15)
  -p, --post-pause SECONDS  wait after C-m before capturing (default: 0.40)
  -s, --snapdir DIR         snapshot directory (default: ./tmux-snapshots/<timestamp>)
      --history-start N     capture pane history from line N (default: -2000)
      --list                write tmux discovery files and print discovery JSON
  -h, --help                show help

Outputs:
  - before.txt / after.txt
  - before.meta / after.meta
  - panes.before.txt / panes.after.txt
  - windows.before.txt / windows.after.txt
  - diff.txt
  - result.json
EOF
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 127
  }
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

write_discovery() {
  local suffix="$1"
  tmux list-panes -a -F 'id=#{pane_id}\ttarget=#{session_name}:#{window_index}.#{pane_index}\tactive=#{pane_active}\tdead=#{pane_dead}\twindow_active=#{window_active}\tsize=#{pane_width}x#{pane_height}\ttitle=#{pane_title}\tpath=#{pane_current_path}\tcmd=#{pane_current_command}' > "$snapdir/panes.${suffix}.txt"
  tmux list-windows -a -F '#{session_name}:#{window_index}\tactive=#{window_active}\tname=#{window_name}\tpanes=#{window_panes}\tlayout=#{window_layout}' > "$snapdir/windows.${suffix}.txt"
}

resolve_active_target() {
  tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'
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

require_cmd tmux
require_cmd python3

list_only=0
target=""
cmd=""
debounce="0.15"
post_pause="0.40"
snapdir=""
history_start="-2000"

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
    --list)
      list_only=1
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

resolved_target="${target:-$(resolve_active_target)}"

if [[ "$list_only" -eq 1 ]]; then
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

if [[ -z "$cmd" ]]; then
  usage >&2
  exit 2
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

tmux send-keys -l -t "$resolved_target" "$cmd"
sleep "$debounce"
tmux send-keys -t "$resolved_target" C-m
sleep "$post_pause"

write_discovery "after"
capture_meta "$meta_after"
capture_pane "$pane_after"

diff_summary="$(write_diff_and_excerpt)"

python3 - "$result_file" "$snapdir" "$target" "$resolved_target" "$cmd" "$debounce" "$post_pause" "$history_start" "$meta_before" "$pane_before" "$meta_after" "$pane_after" "$diff_file" "$excerpt_file" "$snapdir/panes.before.txt" "$snapdir/panes.after.txt" "$snapdir/windows.before.txt" "$snapdir/windows.after.txt" "$diff_summary" <<'PY'
import json, pathlib, sys
(
  result_file, snapdir, requested_target, resolved_target, cmd,
  debounce, post_pause, history_start,
  meta_before, pane_before, meta_after, pane_after,
  diff_file, excerpt_file,
  panes_before, panes_after, windows_before, windows_after,
  diff_summary_json,
) = sys.argv[1:]
obj = {
  'status': 'ok',
  'snapdir': snapdir,
  'requested_target': requested_target or None,
  'resolved_target': resolved_target,
  'command': cmd,
  'debounce_seconds': float(debounce),
  'post_pause_seconds': float(post_pause),
  'history_start': int(history_start),
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
