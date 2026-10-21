#!/usr/bin/env bash
# Nightly PSX statement extraction, run by cron on the home server.
#
# Each filing gets its own headless Claude Code session (`claude -p`) with
# only the statements MCP server and the Read tool, so one bad filing can't
# derail the rest and context stays small. The backend validates every
# submission (balance sheet balances, profit matches PSX); anything that
# fails is held for review rather than stored.
#
#   STATEMENTS_MAX     filings per run (default 20)
#   STATEMENTS_MODEL   Claude model alias (default sonnet)
#
# Setup and cron line: see CLAUDE.md ("Statement extraction").
set -uo pipefail

export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
here="$(cd "$(dirname "$0")/.." && pwd)" # mcp/
MAX="${STATEMENTS_MAX:-20}"
MODEL="${STATEMENTS_MODEL:-sonnet}"
API="${STOCK_API_LOCAL:-http://localhost:3005}"
export STOCK_API_URL="${STOCK_API_URL:-$API,https://huz-stock.duckdns.org:8888}"
export STOCK_API_HOST_DATA="${STOCK_API_HOST_DATA:-$HOME/Docker/stock-api/data}"
export EXTRACTOR_NAME="claude-code-cron"

logdir="$HOME/stock-statements/logs"
mkdir -p "$logdir"
log="$logdir/$(date +%F).log"
exec 9>"$HOME/stock-statements/.lock"
flock -n 9 || { echo "$(date -Is) already running" >>"$log"; exit 0; }

mcpconf="$HOME/stock-statements/mcp.json"
cat >"$mcpconf" <<EOF
{"mcpServers":{"statements":{"command":"node","args":["$here/statements-server.js"]}}}
EOF

pending() {
  curl -fsS -m 20 "$API/api/statements" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).queue.pending))'
}

PROMPT='You are the extractor for PSX financial statements. First call statements_instructions and follow them exactly. Then process exactly ONE filing: call statements_next, read the page images it lists with the Read tool, and call statements_submit (or statements_skip). If submit reports problems, re-read the pages concerned and resubmit, at most twice. Do not process a second filing. End with one line: "RESULT <id> <status>", or "RESULT EMPTY" if statements_next returned empty.'
TOOLS="mcp__statements__statements_instructions,mcp__statements__statements_next,mcp__statements__statements_submit,mcp__statements__statements_skip,mcp__statements__statements_status,Read"

echo "$(date -Is) start: max $MAX, model $MODEL, pending $(pending 2>/dev/null || echo '?')" >>"$log"
for i in $(seq 1 "$MAX"); do
  n="$(pending 2>/dev/null || echo 1)"
  [ "$n" = "0" ] && { echo "$(date -Is) queue empty" >>"$log"; break; }
  out="$(cd "$HOME/stock-statements" && timeout 900 claude -p "$PROMPT" \
    --model "$MODEL" \
    --mcp-config "$mcpconf" --strict-mcp-config \
    --allowedTools "$TOOLS" \
    --add-dir "$STOCK_API_HOST_DATA/statements_pages" \
    --max-turns 40 2>&1)"
  code=$?
  result="$(grep -o 'RESULT .*' <<<"$out" | tail -1)"
  echo "$(date -Is) #$i exit $code ${result:-no result line}" >>"$log"
  if [ -z "$result" ]; then
    printf '%s\n' "$out" | tail -20 >>"$log"
    # Usage limit or auth problem: stop for tonight, the queue keeps.
    grep -qiE 'limit|login|auth|credit' <<<"$out" && break
  fi
  [ "$result" = "RESULT EMPTY" ] && break
done
echo "$(date -Is) done: pending $(pending 2>/dev/null || echo '?')" >>"$log"
find "$logdir" -name '*.log' -mtime +60 -delete
