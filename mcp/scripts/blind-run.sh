#!/usr/bin/env bash
# Blind judgement tasks for the backtest (lib/backtest/blind.js), run by cron
# on the home server once the report archive is done. One headless Claude
# Code session per task, with only the blind MCP server: no web, no files,
# nothing that could reveal the real names or dates.
#
#   BLIND_MAX     tasks per run (default 200)
#   BLIND_HOURS   stop starting new tasks after this many hours (default 6)
#   BLIND_MODEL   Claude model alias (default sonnet)
set -uo pipefail

export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
here="$(cd "$(dirname "$0")/.." && pwd)" # mcp/
MAX="${BLIND_MAX:-200}"
HOURS="${BLIND_HOURS:-6}"
stop_at=$(( $(date +%s) + HOURS * 3600 ))
MODEL="${BLIND_MODEL:-sonnet}"
API="${STOCK_API_LOCAL:-http://localhost:3005}"
export STOCK_API_URL="${STOCK_API_URL:-$API,https://huz-stock.duckdns.org:8888}"

work="$HOME/stock-blind"
logdir="$work/logs"
mkdir -p "$logdir"
log="$logdir/$(date +%F).log"
exec 9>"$work/.lock"
flock -n 9 || { echo "$(date -Is) already running" >>"$log"; exit 0; }

mcpconf="$work/mcp.json"
cat >"$mcpconf" <<EOF
{"mcpServers":{"blind":{"command":"node","args":["$here/blind-server.js"]}}}
EOF

# A usage limit says when it resets ("resets 2:30am (UTC)"). Sleep until then
# if that is before the deadline (epoch seconds); fail otherwise.
wait_for_reset() {
  local t target
  t="$(grep -oE 'resets [0-9]{1,2}(:[0-9]{2})?(am|pm) \(UTC\)' <<<"$1" | head -1 | awk '{print $2}')"
  [ -z "$t" ] && return 1
  target="$(date -u -d "today $t" +%s 2>/dev/null)" || return 1
  [ "$target" -le "$(date +%s)" ] && target=$((target + 86400))
  target=$((target + 120))
  [ "$target" -ge "$2" ] && return 1
  echo "$(date -Is) usage limit; waiting until $(date -u -d "@$target" +%H:%M) UTC" >>"$log"
  sleep $((target - $(date +%s)))
}

PROMPT='You answer blind backtest tasks. First call blind_instructions and follow them exactly. Process exactly ONE task: blind_next, then blind_submit. End with one line: "RESULT <id> <kind> done", or "RESULT EMPTY" if blind_next returned empty.'
TOOLS="mcp__blind__blind_instructions,mcp__blind__blind_next,mcp__blind__blind_submit"

echo "$(date -Is) start: max $MAX, model $MODEL" >>"$log"
for i in $(seq 1 "$MAX"); do
  [ "$(date +%s)" -ge "$stop_at" ] && { echo "$(date -Is) time window over" >>"$log"; break; }
  start=$(date +%s)
  out="$(cd "$work" && timeout 900 claude -p "$PROMPT" \
    --model "$MODEL" \
    --mcp-config "$mcpconf" --strict-mcp-config \
    --allowedTools "$TOOLS" \
    --max-turns 12 2>&1)"
  code=$?
  result="$(grep -o 'RESULT .*' <<<"$out" | tail -1)"
  echo "$(date -Is) #$i exit $code $(($(date +%s) - start))s ${result:-no result line}" >>"$log"
  if [ -z "$result" ]; then
    printf '%s\n' "$out" | tail -20 >>"$log"
    # Usage limit: wait for the reset if it comes in time, else stop for tonight.
    grep -qiE 'limit|login|auth|credit' <<<"$out" && { wait_for_reset "$out" "$stop_at" && continue; break; }
  fi
  [ "$result" = "RESULT EMPTY" ] && break
done
echo "$(date -Is) done" >>"$log"
find "$logdir" -name '*.log' -mtime +60 -delete
