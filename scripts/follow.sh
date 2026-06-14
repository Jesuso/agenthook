#!/usr/bin/env bash
# Follow a LIVE agent read-only by tailing its session transcript (JSONL). Never
# spawns a second process (unlike `claude --resume`), so it can't interfere.
#
#   ./follow.sh <session-id>   # follow a specific session
#   ./follow.sh                # auto-pick the most recently active agent session
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJ="$(node "$DIR/scripts/_config.mjs" projectDir)"
arg="${1:-}"

if [ -n "$arg" ]; then
  F="$PROJ/$arg.jsonl"
else
  # newest dispatched transcript — first turn carries the engine marker "=== TICKET ==="
  F=""
  for f in $(ls -t "$PROJ"/*.jsonl 2>/dev/null); do
    head -c 8000 "$f" | grep -q "=== TICKET ===" && { F="$f"; break; }
  done
fi
[ -z "$F" ] || [ ! -f "$F" ] && { echo "session transcript not found: ${arg:-<auto>}" >&2; exit 1; }
echo "following: $(basename "$F")  (Ctrl+C to stop — agent keeps running)"
echo "────────────────────────────────────────────────────────"

# A little recent context, then stream new lines. Each JSONL line -> one readable line.
tail -n 15 -f "$F" | node -e '
const rl=require("readline").createInterface({input:process.stdin});
const clip=(s,n=200)=>{s=(s||"").replace(/\s+/g," ").trim();return s.length>n?s.slice(0,n)+"…":s;};
rl.on("line",(line)=>{
  let j; try{j=JSON.parse(line);}catch{return;}            // skip partial/non-JSON lines
  const content=j.message?.content;
  const blocks=Array.isArray(content)?content:(typeof content==="string"?[{type:"text",text:content}]:[]);
  for(const b of blocks){
    if(b.type==="text" && b.text?.trim())      console.log("🤖 "+clip(b.text,500));
    else if(b.type==="tool_use")               console.log("🔧 "+b.name+"  "+clip(JSON.stringify(b.input),140));
    else if(b.type==="tool_result"){
      const t=Array.isArray(b.content)?b.content.map(x=>x.text||"").join(" "):b.content;
      console.log("   ↳ "+clip(t,140));
    }
  }
});
'
