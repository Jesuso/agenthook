#!/usr/bin/env bash
# Boot the receiver + an ngrok tunnel, then register the provider webhook at the
# live public URL. For a hosted deploy with a stable URL, skip this and instead:
#   node src/server.js &                     # run the receiver
#   node src/cli.js register https://you.example.com   # one-time webhook create
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cfg() { node -e "console.log(require('$DIR/config.json').$1)"; }
PORT="$(cfg port)"
DATADIR="$(node -e "const p=require('$DIR/config.json').dataDir||'./.runtime';console.log(require('path').resolve('$DIR',p))")"
LOGDIR="$(node -e "const p=require('$DIR/config.json').logDir||'./logs';console.log(require('path').resolve('$DIR',p))")"
NGROK="${NGROK:-ngrok}"

mkdir -p "$LOGDIR" "$DATADIR"

# Clean any previous run (kill by pidfile, never pkill -f a self-matching pattern).
[ -f "$DATADIR/server.pid" ] && kill "$(cat "$DATADIR/server.pid")" 2>/dev/null || true
pkill -f "ngrok http $PORT" 2>/dev/null || true
sleep 1

echo "Starting receiver on 127.0.0.1:$PORT ..."
nohup node "$DIR/src/server.js" >> "$LOGDIR/server.log" 2>&1 &
echo "  server pid $!"

echo "Starting ngrok tunnel ..."
nohup "$NGROK" http "$PORT" --log=stdout >> "$LOGDIR/ngrok.log" 2>&1 &
echo "  ngrok pid $!"

echo -n "Waiting for ngrok public URL "
PUBLIC_URL=""
for _ in $(seq 1 30); do
  PUBLIC_URL="$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);
      const t=(j.tunnels||[]).find(x=>x.public_url&&x.public_url.startsWith("https"));
      if(t)console.log(t.public_url);}catch{}});' 2>/dev/null || true)"
  [ -n "$PUBLIC_URL" ] && break
  echo -n "."; sleep 1
done
echo

if [ -z "$PUBLIC_URL" ]; then
  echo "ERROR: could not get ngrok URL. Check $LOGDIR/ngrok.log" >&2
  exit 1
fi
echo "Public URL: $PUBLIC_URL"

echo "Registering webhook ..."
node "$DIR/src/cli.js" register "$PUBLIC_URL"

echo
echo "Up. Assign yourself an item to trigger a run."
echo "Logs: tail -f $LOGDIR/server.log"
