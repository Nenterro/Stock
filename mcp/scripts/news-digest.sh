#!/usr/bin/env bash
# Nightly news digest, run by cron on the home server after the statements
# run. One headless Claude Code session reads the day's articles (via
# mcp/news-server.js), tags them, writes the brief and updates the risk
# register. Instructions: mcp/news/DIGEST.md.
#
#   NEWS_MODEL   Claude model alias (default sonnet)
set -uo pipefail

export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
here="$(cd "$(dirname "$0")/.." && pwd)" # mcp/
MODEL="${NEWS_MODEL:-sonnet}"
API="${STOCK_API_LOCAL:-http://localhost:3005}"
export STOCK_API_URL="${STOCK_API_URL:-$API,https://huz-stock.duckdns.org:8888}"
export EXTRACTOR_NAME="claude-code-cron"

work="$HOME/stock-news"
logdir="$work/logs"
mkdir -p "$logdir"
log="$logdir/$(date +%F).log"
exec 9>"$work/.lock"
flock -n 9 || { echo "$(date -Is) already running" >>"$log"; exit 0; }

mcpconf="$work/mcp.json"
cat >"$mcpconf" <<EOF
{"mcpServers":{"news":{"command":"node","args":["$here/news-server.js"]}}}
EOF

# Fresh articles first, so the digest covers the evening too.
token="$(grep -E '^STOCK_API_WRITE_TOKEN=' "$here/.env" 2>/dev/null | cut -d= -f2-)"
curl -fsS -m 120 -X POST -H "Authorization: Bearer $token" "$API/api/news/collect" >>"$log" 2>&1
echo >>"$log"

PROMPT='You write the nightly news digest. Call news_instructions and follow them exactly: news_batch, then one news_submit. End with the RESULT line.'
TOOLS="mcp__news__news_instructions,mcp__news__news_batch,mcp__news__news_submit"

digest() {
  cd "$work" && timeout 1800 claude -p "$PROMPT" \
    --model "$MODEL" \
    --mcp-config "$mcpconf" --strict-mcp-config \
    --allowedTools "$TOOLS" \
    --max-turns 15 2>&1
}
echo "$(date -Is) start: model $MODEL" >>"$log"
out="$(digest)"
code=$?
# A usage limit (the backtest may have used the window): wait for the reset,
# up to 6 hours, and try once more, so a busy window doesn't skip a day.
t="$(grep -oE 'resets [0-9]{1,2}(:[0-9]{2})?(am|pm) \(UTC\)' <<<"$out" | head -1 | awk '{print $2}')"
if [ -n "$t" ] && ! grep -q 'RESULT ' <<<"$out"; then
  target="$(date -u -d "today $t" +%s)"
  [ "$target" -le "$(date +%s)" ] && target=$((target + 86400))
  if [ $((target - $(date +%s))) -lt 21600 ]; then
    echo "$(date -Is) usage limit; waiting until $t UTC" >>"$log"
    sleep $((target - $(date +%s) + 120))
    out="$(digest)"
    code=$?
  fi
fi
result="$(grep -o 'RESULT .*' <<<"$out" | tail -1)"
echo "$(date -Is) exit $code ${result:-no result line}" >>"$log"
[ -z "$result" ] && printf '%s\n' "$out" | tail -30 >>"$log"
find "$logdir" -name '*.log' -mtime +60 -delete
exit 0
