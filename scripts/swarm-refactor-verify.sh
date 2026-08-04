#!/usr/bin/env bash
# Run the full swarm refactor safety net. Exit non-zero on any failure.
set -u
cd "$(dirname "$0")/.."
rc=0
for f in extensions/swarm/*.test.mjs extensions/swarm/*.validate.mjs; do
  echo "### $f"
  node "$f" || rc=1
done
echo "=============================="
[ $rc -eq 0 ] && echo "ALL GREEN" || echo "FAILURES PRESENT"
exit $rc
