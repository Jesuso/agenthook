#!/usr/bin/env bash
# Teardown for agent worktrees. Removes one ONLY when it's truly done: its PR is
# merged/closed OR its tracker item is completed. Agents never remove their own
# worktrees (INSTRUCTIONS §7) — this is the one place that does.
#
#   ./cleanup-worktrees.sh                  # dry run: show what WOULD be removed
#   ./cleanup-worktrees.sh --apply          # remove the done ones
#   ./cleanup-worktrees.sh --apply --force  # also remove dirty worktrees
#
# Provider-blind: PR state comes from `gh` run inside each worktree (auto-detects
# the repo from its remote); item completion comes through the active adapter
# (_done-check.mjs). The ticket check is best-effort — when the item ref can't be
# recovered from the worktree name, the PR signal alone decides.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(node "$DIR/scripts/_config.mjs" repoPath)"
WTDIR="$(node "$DIR/scripts/_config.mjs" worktreeDir)"

APPLY=0; FORCE=""
for a in "$@"; do
  [ "$a" = "--apply" ] && APPLY=1
  [ "$a" = "--force" ] && FORCE="--force"
done

# Parse `git worktree list --porcelain` into records, keep only agent worktrees
# (those living under the configured worktree dir).
path=""; branch=""
git -C "$REPO" worktree list --porcelain | while IFS= read -r line; do
  case "$line" in
    "worktree "*) path="${line#worktree }" ;;
    "branch "*)   branch="${line#branch refs/heads/}" ;;
    "")  # blank line ends one record
      case "$path" in
        "$WTDIR"/*)
          # PR state for this branch — gh reads the repo from the worktree's remote.
          prstate=""
          if [ -n "$branch" ]; then
            prstate="$(cd "$path" && gh pr list --head "$branch" --state all \
              --json state -q '.[0].state' 2>/dev/null)"
          fi

          # Best-effort item completion: recover a numeric/leading ref from the
          # worktree name (agents name dirs "<ref>-<slug>"). Skip if not recoverable.
          base="$(basename "$path")"; ref="${base%%-*}"
          done_item="unknown"
          if [ -n "$ref" ]; then
            done_item="$(node "$DIR/scripts/_done-check.mjs" "$ref" 2>/dev/null)"
          fi

          reason=""
          [ "$done_item" = "true" ] && reason="item-completed"
          { [ "$prstate" = "MERGED" ] || [ "$prstate" = "CLOSED" ]; } && reason="${reason:+$reason,}pr-$prstate"

          if [ -n "$reason" ]; then
            echo "REMOVE  $path  [branch=${branch:-?} item=$ref pr=${prstate:-none} -> $reason]"
            if [ "$APPLY" = "1" ]; then
              if git -C "$REPO" worktree remove $FORCE "$path" 2>/tmp/agenthook-wtrm.err; then
                echo "        removed."
              else
                echo "        SKIP (dirty? use --force): $(cat /tmp/agenthook-wtrm.err)"
              fi
            fi
          else
            echo "KEEP    $path  [branch=${branch:-?} item=$ref done=$done_item pr=${prstate:-none}]"
          fi
          ;;
      esac
      path=""; branch="" ;;
  esac
done

if [ "$APPLY" = "1" ]; then
  git -C "$REPO" worktree prune && echo "(pruned stale worktree refs)"
else
  echo "Dry run — re-run with --apply to remove the REMOVE-marked worktrees (add --force for dirty ones)."
fi
