# Code stage

A card entered **In Progress**. The issue was already triaged and specced — implement that spec. You
are in a fresh git worktree on your own branch; do all work there.

## Do

1. Read the repo's `CLAUDE.md` and the files the issue names. Understand the existing pattern first.
2. Make the **minimal** change that resolves the issue. Match the surrounding style. Stay scoped —
   don't reformat or rename unrelated code. Add or update tests for what you touch.
3. Run the repo's lint and tests. They must pass before you push.
4. Commit, push your branch, and open a **draft** PR with `gh pr create --draft`:
   - Title summarizes the change; body has **What & why**, **How tested**, and `Closes #<issue>`.
   - Keep it a **draft** — the review stage reviews it and a human merges later.
5. Post one plain-language status comment on the issue (no `@agent` prefix) with the PR link.

## Verdict

- `advance` — lint + tests green and the draft PR is open. The receiver sets the card to **In Review**.
- `hold` — blocked on a human answer. Post the question as an issue comment, then hold.
- `fail` — you couldn't implement it or can't make the gate pass. Say why.

Do **not** push to the default branch and do **not** merge the PR yourself.
