#!/usr/bin/env bash
# Wrap any bring-up script with stdout+stderr tee'd to a timestamped log.
# Both terminal and log get the same content; exit code is preserved.
#
# Usage:
#   ./hyperbeam/bringup/run-with-log.sh ./hyperbeam/bringup/install.sh
#   ./hyperbeam/bringup/run-with-log.sh ./hyperbeam/bringup/smoke-test.sh
#
# Logs land in hyperbeam/bringup/logs/<script-basename>-<UTC-timestamp>.log
# and are gitignored.

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "usage: $0 <script> [args...]" >&2
    exit 2
fi

script="$1"
shift

name="$(basename "$script" .sh)"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
log_dir="$(dirname "$0")/logs"
mkdir -p "$log_dir"
log_file="$log_dir/${name}-${ts}.log"

{
    echo "# run-with-log: $script $*"
    echo "# started_at_utc: $ts"
    echo "# host: $(hostname)"
    echo "# user: $(whoami)"
    echo "# cwd: $(pwd)"
    echo "# git_rev: $(git rev-parse HEAD 2>/dev/null || echo 'not-a-git-checkout')"
    echo "# ---"
} | tee "$log_file"

# Run the wrapped script with combined stdout+stderr piped through tee -a.
# `set -o pipefail` ensures the script's exit code propagates past tee.
set +e
"$script" "$@" 2>&1 | tee -a "$log_file"
status=${PIPESTATUS[0]}
set -e

{
    echo "# ---"
    echo "# exit_status: $status"
    echo "# ended_at_utc: $(date -u +%Y%m%dT%H%M%SZ)"
} | tee -a "$log_file"

echo
echo "→ log: $log_file"
exit "$status"
