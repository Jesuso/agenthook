# GitHub Issues (`github`)

Stages are **labels** (`sourceLabel` …); the receiver creates missing labels on boot. "Ours" =
the token's login, or `tracker.assigneeLogin` with GitHub App auth. `gh` is authenticated for
agents the receiver spawns.

```bash
R=owner/repo   # from `agenthook guide authoring`
# ticket, staged and assigned in one call (fires the step on the `labeled`/`assigned` event)
gh issue create --repo $R --title "<title>" --body-file body.md --assignee <login> --label "<sourceLabel>"
# or: create unstaged, then let agenthook assign+stage it
gh issue create --repo $R --title "<title>" --body-file body.md
agenthook run <number> [stepId]

# epic: label it (default `epic`; or set the issue type when the repo has one). NO stage label, no assignee.
gh issue create --repo $R --title "<epic title>" --body-file epic.md --label epic
# link a child as a NATIVE sub-issue (needs the child's database id, not its number)
CHILD_ID=$(gh api repos/$R/issues/<childNumber> -q .id)
gh api -X POST repos/$R/issues/<epicNumber>/sub_issues -F sub_issue_id=$CHILD_ID

# dependency: <dep> is blocked by <blocker> (native, honoured by agenthook)
BLOCKER_ID=$(gh api repos/$R/issues/<blocker> -q .id)
gh api -X POST repos/$R/issues/<dep>/dependencies/blocked_by -F issue_id=$BLOCKER_ID
```

- A blocked issue fires only when every blocker is **closed**. Merging the blocker's PR does not
  close it unless the PR body says `Closes #<blocker>` or a step sets `closeIssue:true`.
- Sub-issues in another repo show as `untracked` in `epics`.
- Verify: `agenthook watch --ref <number> --event enqueued,run_start --timeout 60`;
  `agenthook epics --ref <epicNumber>`.
