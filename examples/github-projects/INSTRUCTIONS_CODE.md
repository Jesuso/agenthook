# Code stage

A card entered **In Progress**. The issue was already triaged and specced — implement that spec. You
are in a fresh git worktree on your own branch; do all work there.

## Do

1. Read the repo's `CLAUDE.md` and the files the issue names. Understand the existing pattern first.
2. Make the **minimal** change that resolves the issue. Match the surrounding style. Stay scoped —
   don't reformat or rename unrelated code. Add or update tests for what you touch.
3. Run the repo's lint and tests. They must pass before you push. Never create, edit or delete
   anything under `.git/`, and never fake a hook's result — if a hook fails on something
   unrelated to your change, the only sanctioned bypass is `--no-verify`, with the failed
   command and reason recorded in the PR body.
4. Do the work inline in this session — never hand it off to a background subagent — and commit
   and push as you go.
5. Commit, push your branch, and open a **draft** PR with `gh pr create --draft`:
   - Title summarizes the change; body has **What & why**, **How tested**, `Closes #<issue>`, and
     a line linking the issue, exactly `**GitHub Projects:** <issue URL>` (on a rework pass, add it
     with `gh pr edit <branch> --body …` if it's missing).
   - Keep it a **draft** — the review stage reviews it and a human merges later.
6. Post one plain-language status comment on the issue (no `@agent` prefix) with the PR link.

## Verdict

- `advance` — lint + tests green and the draft PR is open. The receiver sets the card to **In Review**.
- `hold` — blocked on a human answer. Post the question as an issue comment, then hold.
- `fail` — you couldn't implement it or can't make the gate pass. Say why.

Do **not** push to the default branch and do **not** merge the PR yourself.

## Re-entry after a hold

On (re-)entry, read the issue comments FIRST. A human may have answered an earlier question there, not in the body. Treat those answers as decisions: do not re-ask a question that has been answered, and if the owner marks decisions as final, do not `hold` on the same questions again.
