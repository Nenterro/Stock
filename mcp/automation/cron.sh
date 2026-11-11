#!/usr/bin/env bash
# Plain-code automation (no Claude), run by cron on the home server:
#   cron.sh models | alerts | bookkeeping
# See run.mjs. Logs: ~/stock-automation/logs/<task>-<date>.log, kept 60 days.
set -uo pipefail
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
here="$(cd "$(dirname "$0")/.." && pwd)" # mcp/
task="${1:?task}"
work="$HOME/stock-automation"
mkdir -p "$work/logs"
log="$work/logs/$task-$(date +%F).log"
exec 9>"$work/.$task.lock"
flock -n 9 || { echo "$(date -Is) already running" >>"$log"; exit 0; }
export STOCK_API_URL="${STOCK_API_URL:-http://localhost:3005}"
export PERSONAL_INVESTMENT_DIR="${PERSONAL_INVESTMENT_DIR:-$HOME/personal-investment}"
echo "$(date -Is) start" >>"$log"
cd "$here" && timeout 3600 node automation/run.mjs "$task" >>"$log" 2>&1
echo "$(date -Is) exit $?" >>"$log"
find "$work/logs" -name '*.log' -mtime +60 -delete
exit 0
