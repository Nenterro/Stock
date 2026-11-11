#!/usr/bin/env bash
# Headless Claude tasks, run by cron on the home server:
#   claude-task.sh research | watch | pack | audit
# Each runs one `claude -p` session in the private Personal Investment repo
# (pulled first, committed and pushed after), with the stock-tracker MCP
# server and only the tools that task needs. Instructions:
# mcp/automation/<TASK>.md. Logs: ~/stock-automation/logs/claude-<task>-<date>.log.
#
#   <TASK>_MODEL   overrides the model, e.g. AUDIT_MODEL=claude-opus-5-5
set -uo pipefail
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
here="$(cd "$(dirname "$0")/.." && pwd)" # mcp/
task="${1:?task}"
TASK="$(tr '[:lower:]' '[:upper:]' <<<"$task")"
work="$HOME/stock-automation"
pi="${PERSONAL_INVESTMENT_DIR:-$HOME/personal-investment}"
mkdir -p "$work/logs"
log="$work/logs/claude-$task-$(date +%F).log"
exec 9>"$work/.claude.lock" # one Claude task at a time
flock -w 7200 9 || { echo "$(date -Is) another Claude task still running" >>"$log"; exit 0; }
export STOCK_API_URL="${STOCK_API_URL:-http://localhost:3005}"
export PERSONAL_INVESTMENT_DIR="$pi"

# Models: Opus where judgement matters, Sonnet for the nightly watch.
case "$task" in
  watch) default_model="claude-sonnet-5-5"; minutes=30 ;;
  research) default_model="claude-opus-5-5"; minutes=120 ;;
  pack) default_model="claude-opus-5-5"; minutes=90 ;;
  audit) default_model="claude-opus-5-5"; minutes=120 ;;
  *) echo "unknown task $task" >>"$log"; exit 2 ;;
esac
model_var="${TASK}_MODEL"
MODEL="${!model_var:-$default_model}"

mcpconf="$work/mcp-stock-tracker.json"
cat >"$mcpconf" <<EOF
{"mcpServers":{"stock-tracker":{"command":"node","args":["$here/server.js"]}}}
EOF

# Read-only market and portfolio tools for every task; writes per task.
READ="mcp__stock-tracker__stock_status,mcp__stock-tracker__get_portfolio,mcp__stock-tracker__get_xray,mcp__stock-tracker__get_performance,mcp__stock-tracker__get_transactions,mcp__stock-tracker__get_fundamentals,mcp__stock-tracker__get_technicals,mcp__stock-tracker__get_fund_holdings,mcp__stock-tracker__get_price_history,mcp__stock-tracker__get_quotes,mcp__stock-tracker__search_assets,mcp__stock-tracker__screen_stocks,mcp__stock-tracker__plan_contribution,mcp__stock-tracker__get_expected_returns,mcp__stock-tracker__build_model_portfolio,mcp__stock-tracker__get_statements,mcp__stock-tracker__get_data_quality,mcp__stock-tracker__get_jobs,mcp__stock-tracker__get_news,mcp__stock-tracker__get_geo_brief,mcp__stock-tracker__get_risk_register,mcp__stock-tracker__get_research,mcp__stock-tracker__list_insights,mcp__stock-tracker__get_insight"
FILES="Read,Write,Edit,Glob,Grep"
case "$task" in
  watch) TOOLS="$READ,$FILES,mcp__stock-tracker__save_insight" ;;
  research) TOOLS="$READ,$FILES,WebSearch,WebFetch,mcp__stock-tracker__save_insight,mcp__stock-tracker__set_watchlist,mcp__stock-tracker__set_note" ;;
  pack) TOOLS="$READ,$FILES,WebSearch,mcp__stock-tracker__save_insight,mcp__stock-tracker__set_targets,mcp__stock-tracker__record_forward_test_weights" ;;
  audit) TOOLS="$READ,$FILES,WebSearch,mcp__stock-tracker__save_insight,mcp__stock-tracker__run_job,mcp__stock-tracker__retry_statement,mcp__stock-tracker__set_watchlist,mcp__stock-tracker__set_note" ;;
esac

# --rebase: a run that could not push last time still has its commit locally.
git -C "$pi" pull -q --rebase >>"$log" 2>&1 || echo "$(date -Is) git pull failed" >>"$log"

PROMPT="You are running the scheduled '$task' task for the user's investment system, unattended. Read $here/automation/$TASK.md and follow it exactly. Today is $(date +%F). Your working directory is the user's Personal Investment records. End with one line: RESULT <one-sentence summary>."
run() {
  cd "$pi" && timeout $((minutes * 60)) claude -p "$PROMPT" \
    --model "$MODEL" \
    --mcp-config "$mcpconf" --strict-mcp-config \
    --allowedTools "$TOOLS" \
    --add-dir "$here/automation" "$work/logs" "$HOME/stock-news/logs" "$HOME/stock-statements/logs" 2>&1
}
echo "$(date -Is) start: model $MODEL" >>"$log"
out="$(run)"
code=$?
# Usage limit: wait for the reset (up to 6 hours) and try once more.
t="$(grep -oE 'resets [0-9]{1,2}(:[0-9]{2})?(am|pm) \(UTC\)' <<<"$out" | head -1 | awk '{print $2}')"
if [ -n "$t" ] && ! grep -q 'RESULT ' <<<"$out"; then
  target="$(date -u -d "today $t" +%s)"
  [ "$target" -le "$(date +%s)" ] && target=$((target + 86400))
  if [ $((target - $(date +%s))) -lt 21600 ]; then
    echo "$(date -Is) usage limit; waiting until $t UTC" >>"$log"
    sleep $((target - $(date +%s) + 120))
    out="$(run)"
    code=$?
  fi
fi
result="$(grep -o 'RESULT .*' <<<"$out" | tail -1)"
echo "$(date -Is) exit $code ${result:-no result line}" >>"$log"
[ -z "$result" ] && printf '%s\n' "$out" | tail -40 >>"$log"

# Commit and push what the session wrote.
if [ -n "$(git -C "$pi" status --porcelain)" ]; then
  git -C "$pi" add -A
  git -C "$pi" commit -q -m "Automated $task, $(date +%F)

${result:-no result line}" >>"$log" 2>&1
  # Someone may have pushed while the session ran: rebase on top, then push.
  { git -C "$pi" pull -q --rebase && git -C "$pi" push -q; } >>"$log" 2>&1 || echo "$(date -Is) git push failed" >>"$log"
fi
find "$work/logs" -name '*.log' -mtime +60 -delete
exit 0
