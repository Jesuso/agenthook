#!/usr/bin/env bash
# Delete the provider's webhooks and stop the local receiver + tunnel.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="$(node -e "console.log(require('$DIR/config.json').port)")"
DATADIR="$(node -e "const p=require('$DIR/config.json').dataDir||'./.runtime';console.log(require('path').resolve('$DIR',p))")"

node "$DIR/src/cli.js" unregister || true

if [ -f "$DATADIR/server.pid" ]; then
  kill "$(cat "$DATADIR/server.pid")" 2>/dev/null && echo "stopped server" || echo "server not running (stale pidfile)"
  rm -f "$DATADIR/server.pid"
fi
pkill -f "ngrok http $PORT" 2>/dev/null && echo "stopped ngrok" || true
echo "done"
