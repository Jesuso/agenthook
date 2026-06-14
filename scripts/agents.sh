#!/usr/bin/env bash
# List running headless `claude -p` agent runs (pid, runtime, kind, ref).
# These are plain OS processes the receiver spawns — no claude subcommand tracks them.
set -uo pipefail

found=0
for pid in $(pgrep -f 'claude -p' 2>/dev/null); do
  cmd="$(tr '\0\n' '  ' < "/proc/$pid/cmdline" 2>/dev/null)" || continue
  case "$cmd" in *"claude -p"*) ;; *) continue ;; esac
  et="$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')"
  kind="implement"
  case "$cmd" in *"A CHANGE has been requested"*) kind="change" ;; esac
  ref="$(sed -n 's/.* Ref: \([^ ]*\).*/\1/p' <<<"$cmd" | head -1)"
  printf "pid=%-7s %-9s kind=%-9s ref=%s\n" "$pid" "$et" "$kind" "${ref:-?}"
  found=$((found + 1))
done
echo "── $found agent(s) running ──"
