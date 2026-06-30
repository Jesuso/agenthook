# Standing instructions for auto-dispatched agents

Copy this to `INSTRUCTIONS.md` (gitignored) and tune it to your repo. These rules are
prepended to EVERY task the agent receives. They are policy; the ticket that follows is the
specific work. When they conflict, follow these unless the ticket's intent clearly requires
otherwise — and if so, say which you chose and why (plainly on the tracker, with the
technical reasoning in the PR).

> Throughout: "the tracker" = the issue/task system that triggered you (Asana, GitHub, Jira…);
> "the item" = the task/issue. "the trigger" = the marker humans use to request a change
> (default `@agent`).

## Two channels, two audiences

The tracker is read by product/non-technical people following the flow; the PR is read by
engineers. Every report respects this split — never duplicate content across them:

- **Tracker comments: product language only.** What changed from the user's/business's point
  of view and what state the work is in. No branch names, file paths, commands, or stack
  traces. Always include the PR URL — that link IS the path to the technical detail.
- **PR (description + comments): all technical detail.** Branch, worktree path, implementation
  notes, test/lint results, review findings, commands, logs.
- One fact lives in one place. The tracker answers "where is this and is it OK?"; the PR
  answers "what exactly was done and how do I verify it?".

## 1. Isolate first — always work in a git worktree

Other agents may run at the same time in the same repo. Do NOT work in the shared checkout.

- **New work:** create a fresh branch + worktree off the latest default branch:
  ```bash
  git -C <repo> fetch -q origin
  git -C <repo> worktree add -b <branch> <worktreePrefix>/<ref>-<slug> origin/<default-branch>
  ```
- **Resuming (change request):** reuse the original worktree — never create a second one for
  the same branch. If it's gone, recreate it from the existing branch.
- `cd` into that worktree and do all reading, editing, committing there.
- Pick a unique path (`<ref>-<slug>`) so parallel agents never share a directory.

## 2. Implement

- Follow the repository's `CLAUDE.md` rules exactly (tests, layering, lint, etc.).
- Keep the change scoped to the ticket. Add tests for new code.
- **Stay out of shared root files** when your ticket lives in a subdirectory. Sibling agents
  running in parallel will each touch a root file (`.gitignore`, top-level `README.md`, a shared
  index) and their PRs then collide at merge — a single coordinating PR owns those. If your
  committed file would be hit by a root ignore rule, prefer a **local** `.gitignore` in your own
  subdirectory (e.g. `examples/<x>/.gitignore` with `!agenthook.config.json`) over editing the
  root one.

## 3. Pre-push checks

- Run the repo's lint + the relevant tests; they must pass before you push.
- For UI/bug work: capture the **before** state on the default branch early, save under
  `<worktree>/proof/`.

## 4. Ship — open the PR, post initial status

- Commit, push the branch, open a **ready** PR — NOT a draft (a draft can't be merged, so a
  review-passed item would stall at the merge gate). For a change request, push to the EXISTING
  PR — never open a second one.
- **PR description (technical):** what changed and how, branch name, worktree path, test/lint
  results. Include a `Closes #<ref>` line (the tracker item's number) so merging the PR closes
  the item — that keeps item-state aligned with merge-state instead of closing it early.
- **Tracker comment (product):** one or two plain sentences on what the change does for the
  user, plus the PR URL. Do NOT start it with the trigger — that marker is for humans.

## 5. Self-review

- Run an automated review pass on your diff (e.g. the `code-review` skill with `--fix`).
- If it changed files: re-run lint + tests, commit (`chore: address review findings`), push.
- Leave a review signal in BOTH places — even "no issues found". PR comment = technical
  outcome; tracker comment = one plain status sentence.

## 6. Proof — demonstrate it works

Produce evidence the final branch does what the ticket asked. Inspect the artifact yourself
before attaching it.

- UI: screenshots of the final result at the ticket's exact route/state.
- CLI/script: run it, capture command + full output + exit code.
- API/backend: call the endpoint or run the test, capture request/response.
- Bug fix: pair the §3 before-capture with an after-capture of the repro passing.

Prove against YOUR build (rebuild from your worktree; confirm the running instance serves your
code). Save artifacts under `<worktree>/proof/` (don't commit them). Report to BOTH places per
*Two channels*. If proof needs a human (login wall, missing creds), don't block: put the exact
manual steps in the PR and one plain sentence on the tracker.

## 7. Leave your worktree in place

Never `git worktree remove`. Teardown is a separate step that runs only after the PR is
merged/closed or the ticket is done. Record the worktree path in the PR description.

## 8. When unsure — ask, don't guess

If the ticket is ambiguous or unsafe to do unattended, post a tracker comment with the
question (no trigger prefix) and stop. Phrase it in product terms with concrete options
("Should archived projects appear here, or only active ones?"). A human replies with
`<trigger> <answer>`, which re-dispatches you with their decision.
