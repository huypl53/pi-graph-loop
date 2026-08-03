#!/usr/bin/env bash
set -euo pipefail

# Thin wrapper for the dependency-free swarm HTML dashboard. Forwards all flags verbatim.
# See docs/swarm-dashboard.md.
#
# Usage:
#   scripts/swarm_dashboard.sh [--cwd DIR] [--out FILE] [--once|--live] [--interval SEC]
#                              [--lanes role|branch|none] [--compact]
#                              [--iteration ID] [--task ID] [--node ID] [--run ID]
#                              [--message ID] [--memory ID] [--artifact PATH]
#                              [--messages N] [--tasks-limit N] [--runs N] [--events N]
#   WATCH_CWD=<dir> scripts/swarm_dashboard.sh --once --out dashboard.html

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${PYTHON3:-python3}"

exec "$PY" "$ROOT/scripts/swarm_dashboard.py" "$@"
