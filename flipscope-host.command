#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
#  FlipScope Host
#  Runs the local listing scraper + a public tunnel so
#  leeschoettle.com/flipscope.html can fetch photos for you AND anyone you share
#  it with. Double-click this file. Keep the window open. Ctrl-C to stop.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")" || exit 1

CF="$(command -v cloudflared || echo /opt/homebrew/bin/cloudflared)"
if [ ! -x "$CF" ]; then
  echo "cloudflared is not installed. In Terminal run:"
  echo "    brew install cloudflared"
  echo "then double-click this file again."
  read -r -p "Press Enter to close."
  exit 1
fi

SERVE_PID=""
if ! lsof -ti tcp:3456 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "▸ Starting FlipScope server on :3456"
  node serve.js > flipscope-server.log 2>&1 &
  SERVE_PID=$!
  sleep 2
else
  echo "▸ FlipScope server already running on :3456"
fi

echo "▸ Opening public tunnel…"
CFLOG="$(mktemp)"
"$CF" tunnel --url http://localhost:3456 --no-autoupdate > "$CFLOG" 2>&1 &
CF_PID=$!

URL=""
for _ in $(seq 1 40); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$CFLOG" | head -1)"
  [ -n "$URL" ] && break
  sleep 1
done

cleanup() {
  echo; echo "▸ Stopping…"
  kill "$CF_PID" 2>/dev/null
  [ -n "$SERVE_PID" ] && kill "$SERVE_PID" 2>/dev/null
  # mark endpoint offline
  printf '{"api":null,"updated":"%s"}\n' "$(date -u +%FT%TZ)" > flipscope-endpoint.json
  git rev-parse --git-dir >/dev/null 2>&1 && git commit -m "flipscope: host offline" -- flipscope-endpoint.json >/dev/null 2>&1 && git push >/dev/null 2>&1
  exit 0
}
trap cleanup INT TERM

if [ -z "$URL" ]; then
  echo "  ✗ Tunnel did not start. Log: $CFLOG"
  read -r -p "Press Enter to close."
  cleanup
fi

echo
echo "  ┌─────────────────────────────────────────────────────────────"
echo "  │  Public API : $URL"
echo "  │  Share link : https://leeschoettle.com/flipscope.html?api=$URL"
echo "  └─────────────────────────────────────────────────────────────"
echo

# Publish the endpoint so the hosted site auto-discovers it (no link needed).
printf '{"api":"%s","updated":"%s"}\n' "$URL" "$(date -u +%FT%TZ)" > flipscope-endpoint.json
if git rev-parse --git-dir >/dev/null 2>&1; then
  git pull --rebase --autostash >/dev/null 2>&1 || true
  if git commit -m "flipscope: tunnel endpoint" -- flipscope-endpoint.json >/dev/null 2>&1 && git push >/dev/null 2>&1; then
    echo "  ✓ Published. leeschoettle.com/flipscope.html goes live for everyone in ~1 min."
  else
    echo "  ⚠ Auto-publish failed. Share this link instead:"
    echo "     https://leeschoettle.com/flipscope.html?api=$URL"
  fi
fi

echo
echo "  FlipScope is LIVE. Leave this window open. Press Ctrl-C to stop."
wait
