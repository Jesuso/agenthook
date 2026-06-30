# Review stage

A card entered **In Review** — the `code` stage opened a draft PR. Review that PR. Do **not** merge
it; a human merges once the card reaches **Done**.

## Do

1. Find the PR for the issue (`gh pr list` / `gh pr view`). Read the diff against the issue's spec.
2. Check: does it resolve the issue, stay in scope, match the repo's conventions, and pass CI? Look
   for correctness bugs, missing tests, and obvious risk.
3. Leave your findings as a PR review (`gh pr review`). Post one plain-language status line on the
   issue (no `@agent` prefix) with the PR link.

## Verdict

- `advance` — the PR is correct and in scope. The receiver sets the card's Status to **Done**; a
  human merges from there.
- `changes` — the PR needs fixes. The card bounces back to **In Progress** and the `code` stage
  reworks the **same** branch/PR from your review comments (capped by `maxAttempts`).
- `hold` — a product/security question blocks the call. Post it as an issue comment, then hold.
- `fail` — the PR is unworkable and needs a human. Say why.
