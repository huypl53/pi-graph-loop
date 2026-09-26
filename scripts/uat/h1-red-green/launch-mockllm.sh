#!/usr/bin/env bash
# H1 validation lane: interactive mock-llm Pi session in an explicitly disposable project.
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

if [ -z "${PROJECT:-}" ]; then
  echo "Set PROJECT to a disposable directory under .pi/swarm-uat/runs/ (see README.md)." >&2
  exit 2
fi
if [ ! -d "$(dirname "$PROJECT")" ]; then
  echo "Create PROJECT's parent directory under .pi/swarm-uat/runs/ before launching." >&2
  exit 2
fi

node scripts/uat/h1-red-green/seed-live-fixture.mjs seed "$PROJECT"
PROJECT="$(cd "$(dirname "$PROJECT")" && pwd)/$(basename "$PROJECT")"
RUN_DIR="$(dirname "$PROJECT")"
mkdir -p "$RUN_DIR/transcripts"
cd "$PROJECT"
export PI_SWARM_AGENT_ID=worker-x
export PI_SWARM_IS_ROOT=0
export PI_MOCK_LLM_TRANSCRIPTS_DIR="$RUN_DIR/transcripts"
exec pi -ne -e "$ROOT/extensions/mock-llm" -e "$ROOT/extensions/swarm" \
  --provider mock-llm --model response-debt-parallel-nudge
