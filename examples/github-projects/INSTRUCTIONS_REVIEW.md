# Review stage

A card entered **In Review** — the `code` stage opened a draft PR. Review that PR. Do **not** merge
it; a human merges once the card reaches **Done**.

## Do

1. Find the PR for the issue (`gh pr list` / `gh pr view`). Read the diff against the issue's spec.
2. Check: does it resolve the issue, stay in scope, match the repo's conventions, and pass CI? Look
   for correctness bugs, missing tests, and obvious risk.
3. Check the PR body contains a line linking the issue, exactly `**GitHub Projects:** <issue URL>`.
   A missing link is a `changes` finding — never `advance` a PR without it.
4. For each new or changed test, name the production change that would make it fail. A test that
   can't fail when the change it claims to cover is reverted is a BLOCKING finding, never a minor
   note.
5. Check every acceptance criterion in the issue. If any is unmet and the code stage can fix it,
   use `changes` and name the criterion. If only a human can satisfy it (prod access, credentials,
   a measurement you can't run), use `hold` and name the criterion and who can satisfy it.
   A criterion that can only be verified **once the change is live** (a production metric, a
   log line, a live integration) is different. If everything else is met and the risk is low or
   medium, approve with `followUp` listing each check. If the risk is high, `hold` instead.
6. Leave your findings as a PR review (`gh pr review`). Post one plain-language status line on the
   issue (no `@agent` prefix) with the PR link.

## Verdict

- `advance` — the PR is correct and in scope, and every acceptance criterion is met. The receiver
  sets the card's Status to **Done**; a human merges from there.
  - With criteria that can only be checked once live, at risk `low`/`medium`: add
    "followUp":["<what to check once live, and where>"]`. The receiver
    records the checks for someone to verify once it is live. The risk tier is the one auto-merge uses (your own `summary.tier` only if you are its source); `high` or missing holds instead.
- `changes` — the PR needs fixes. The card bounces back to **In Progress** and the `code` stage
  reworks the **same** branch/PR from your review comments (capped by `maxAttempts`).
- `hold` — a product/security question blocks the call. Post it as an issue comment, then hold.
- `fail` — the PR is unworkable and needs a human. Say why.

## Re-entry after a hold

On (re-)entry, read the issue comments FIRST. A human may have answered an earlier question there, not in the body. Treat those answers as decisions: do not re-ask a question that has been answered, and if the owner marks decisions as final, do not `hold` on the same questions again.
