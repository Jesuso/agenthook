#!/usr/bin/env bash
# Find the agent session that handled an item (by name fragment) and print how to
# resume it. A dispatched session's FIRST user turn IS the prompt the receiver fed
# it — which always contains the engine marker "=== TICKET ===". Matching only the
# first turn excludes this orchestrator session, which merely quotes those strings.
#
#   ./resume.sh "Patron Content Preview"
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJ="$(node "$DIR/scripts/_config.mjs" projectDir)"
REPO="$(node "$DIR/scripts/_config.mjs" repoPath)"
WTBASE="$(basename "$(node "$DIR/scripts/_config.mjs" worktreeDir)")"
Q="${*:-}"
[ -z "$Q" ] && { echo "usage: resume.sh <item name fragment>" >&2; exit 1; }
[ -d "$PROJ" ] || { echo "no transcript dir for this repo: $PROJ" >&2; exit 1; }

node -e '
const fs=require("fs"), path=require("path");
const [proj,repo,wtbase,q]=process.argv.slice(1);
const files=fs.readdirSync(proj).filter(f=>f.endsWith(".jsonl"))
  .map(f=>({f,m:fs.statSync(path.join(proj,f)).mtimeMs})).sort((a,b)=>b.m-a.m);
const firstUser=(lines)=>{for(const l of lines){try{const j=JSON.parse(l);
  if(j.type==="user"){const c=j.message?.content;
    return typeof c==="string"?c:Array.isArray(c)?c.map(x=>x.text||"").join(" "):"";}}catch{}}return"";};
const wtRe=new RegExp(wtbase.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"/[A-Za-z0-9._-]+","g");
for(const {f} of files){
  const txt=fs.readFileSync(path.join(proj,f),"utf8");
  const fu=firstUser(txt.split("\n"));
  if(!fu.includes("=== TICKET ===")) continue;               // dispatched agent only
  if(!fu.toLowerCase().includes(q.toLowerCase())) continue;   // this item
  const id=f.replace(/\.jsonl$/,"");
  const freq=(re)=>{const m=txt.match(re)||[];const c={};m.forEach(x=>c[x]=(c[x]||0)+1);
    return Object.entries(c).sort((a,b)=>b[1]-a[1])[0]?.[0];};
  const branch=freq(/(?:feat|fix|chore)\/[a-z0-9-]+/g);
  const wt=freq(wtRe);
  const pr=(txt.match(/(?:PR #|pull\/)(\d+)/g)||[]).map(s=>s.match(/\d+/)[0]).sort().pop();
  console.log("session : "+id);
  console.log("branch  : "+(branch||"?"));
  console.log("PR      : "+(pr?("#"+pr):"?"));
  console.log("worktree: "+(wt||"?"));
  console.log("");
  console.log("# 1) re-materialize the work tree (if it was torn down):");
  console.log(`git -C ${repo} worktree add ${wt||"<worktree-path>"} ${branch||"<branch>"}`);
  console.log("# 2) resume the session interactively:");
  console.log(`cd ${repo} && claude --resume ${id}`);
  process.exit(0);
}
console.error("no agent session found for: "+q); process.exit(1);
' "$PROJ" "$REPO" "$WTBASE" "$Q"
