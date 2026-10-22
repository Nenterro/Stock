#!/usr/bin/env bash
# Historical report extraction for the backtest, run by cron on the home
# server after the statements and news runs. Same pattern as
# extract-statements.sh: one headless Claude Code session per report, with
# only the archive MCP server and Read.
#
#   ARCHIVE_MAX     reports per run (default 400)
#   ARCHIVE_HOURS   stop starting new reports after this many hours (default 6),
#                   so the run stays inside the night and leaves the day's
#                   Claude usage alone
#   ARCHIVE_MODEL   Claude model alias (default sonnet)
set -uo pipefail

export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
here="$(cd "$(dirname "$0")/.." && pwd)" # mcp/
MAX="${ARCHIVE_MAX:-400}"
HOURS="${ARCHIVE_HOURS:-6}"
stop_at=$(( $(date +%s) + HOURS * 3600 ))
MODEL="${ARCHIVE_MODEL:-sonnet}"
API="${STOCK_API_LOCAL:-http://localhost:3005}"
export STOCK_API_URL="${STOCK_API_URL:-$API,https://huz-stock.duckdns.org:8888}"
export STOCK_API_HOST_DATA="${STOCK_API_HOST_DATA:-$HOME/Docker/stock-api/data}"
export EXTRACTOR_NAME="claude-code-cron"

work="$HOME/stock-archive"
logdir="$work/logs"
mkdir -p "$logdir"
log="$logdir/$(date +%F).log"
exec 9>"$work/.lock"
flock -n 9 || { echo "$(date -Is) already running" >>"$log"; exit 0; }

mcpconf="$work/mcp.json"
cat >"$mcpconf" <<EOF
{"mcpServers":{"archive":{"command":"node","args":["$here/archive-server.js"]}}}
EOF

pending() {
  curl -fsS -m 20 "$API/api/archive/status" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).queue.pending))'
}

# A usage limit says when it resets ("resets 2:30am (UTC)"). Sleep until then
# if that is before the given deadline (epoch seconds); fail otherwise.
wait_for_reset() {
  local t target
  t="$(grep -oE 'resets [0-9]{1,2}(:[0-9]{2})?(am|pm) (UTC)' <<<"$1" | head -1 | awk '{print $2}')"
  [ -z "$t" ] && return 1
  target="$(date -u -d "today $t" +%s 2>/dev/null)" || return 1
  [ "$target" -le "$(date +%s)" ] && target=$((target + 86400))
  target=$((target + 120))
  [ "$target" -ge "$2" ] && return 1
  echo "$(date -Is) usage limit; waiting until $(date -u -d "@$target" +%H:%M) UTC" >>"$log"
  sleep $((target - $(date +%s)))
}

PROMPT='You extract statements from archived annual reports. First call archive_instructions and follow them exactly. Process exactly ONE report: archive_next, read what you need (archive_pages and the Read tool for images), then archive_submit (or archive_skip). Do not process a second report. End with one line: "RESULT <id> <status>", or "RESULT EMPTY".'
TOOLS="mcp__archive__archive_instructions,mcp__archive__archive_next,mcp__archive__archive_pages,mcp__archive__archive_text,mcp__archive__archive_submit,mcp__archive__archive_skip,mcp__archive__archive_status,Read"

echo "$(date -Is) start: max $MAX, model $MODEL, pending $(pending 2>/dev/null || echo '?')" >>"$log"
for i in $(seq 1 "$MAX"); do
  n="$(pending 2>/dev/null || echo 1)"
  [ "$n" = "0" ] && { echo "$(date -Is) queue empty" >>"$log"; break; }
  [ "$(date +%s)" -ge "$stop_at" ] && { echo "$(date -Is) time window over" >>"$log"; break; }
  start=$(date +%s)
  out="$(cd "$work" && timeout 900 claude -p "$PROMPT" \
    --model "$MODEL" \
    --mcp-config "$mcpconf" --strict-mcp-config \
    --allowedTools "$TOOLS" \
    --add-dir "$STOCK_API_HOST_DATA/archive_pages" \
    --max-turns 40 2>&1)"
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
echo "$(date -Is) done: pending $(pending 2>/dev/null || echo '?')" >>"$log"
find "$logdir" -name '*.log' -mtime +60 -delete
