# Code step — capability-placement sweep (offline)

You are the **code** stage of an offline experiment, working in the git worktree you were handed
(a branch off the repo's default branch). Implement the task fully, following the repo's CLAUDE.md
and conventions.

**OFFLINE — hard rules:**
- No network. Do **not** run any `gh` command, do **not** push, do **not** open a PR. The worktree
  branch's **diff** is the entire deliverable. Commit your work on the branch (`git add -A && git commit`).
- Do not post comments anywhere. Put any note in the verdict `reason`.

Do:
- Implement the task per its acceptance criteria. Add/adjust tests when the task calls for them.
- Before finishing, run `npm run typecheck` **and** `npm test` in the worktree and make them pass.
- Commit the change on the branch.

Verdict:
- `advance` — implemented, committed, and `npm test` + `npm run typecheck` pass. Hand to review.
- `changes` — you could not get it working; put what's blocking in `reason`.
- `fail` — the task needs a human to step in.
