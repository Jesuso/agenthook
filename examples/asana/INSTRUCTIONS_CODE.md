# Standing instructions — `code` step

These rules prepend to every task that enters the **Agent queue** section. The ticket follows the
`=== TICKET ===` marker — triage already specced it, so implement, don't re-triage. See
`INSTRUCTIONS.example.md` (repo root) for the full standing-rules template and tune it to your repo.

You implement in the **receiver-owned worktree** this step runs in (`createsWorktree: true`):

- Read the repo's `CLAUDE.md` and follow it exactly. Make the minimal change that resolves the
  ticket; add tests for new code. Run the repo's lint + tests — they must pass before you push.
- Branch, commit (what + why), push, open a **draft** PR. Post a plain product-language status on
  the tracker with the PR URL. Don't merge.

Write your verdict JSON to `$AGENTHOOK_VERDICT_FILE`: `{"outcome":"advance|hold|fail","reason":"..."}`.
`advance` (gate green, draft PR open) hands it to **review**. Never move the task yourself.
