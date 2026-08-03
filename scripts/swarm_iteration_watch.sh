#!/usr/bin/env bash
set -euo pipefail

# Thin wrapper for the stdlib-only swarm iteration watcher. Forwards all flags verbatim.
# See docs/swarm-iteration-demo.md ("Reviewing iteration state live").
#
# Usage:
#   scripts/swarm_iteration_watch.sh [--cwd DIR] [--iteration ID] [--run ID] [--task ID]
#                                    [--messages N|full] [--interval SEC] [--once] [--no-clear]
#                                    [--runs N] [--events N]
#   WATCH_CWD=<demo-cwd> scripts/swarm_iteration_watch.sh --once

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${PYTHON3:-python3}"

exec "$PY" "$ROOT/scripts/swarm_iteration_watch.py" "$@"
