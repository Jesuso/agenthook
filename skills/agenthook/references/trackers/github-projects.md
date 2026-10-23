# GitHub Projects v2 (`github-projects`)

Stages are options of the board's single-select **Status** field (`sourceStatus` …). Board =
`tracker.project` (`owner/number`). "Ours" = the token's login (`viewer`) or
`tracker.assigneeLogin`. Only *org*-owned boards deliver item webhooks.

Order matters: assign **before** the card exists or its Status changes — an issue `assigned`
event is not handled by this tracker.

```bash
R=owner/repo; OWNER=<org>; N=<project number>
gh issue create --repo $R --title "<title>" --body-file body.md --assignee <login>
URL=$(gh issue view <number> --repo $R --json url -q .url)
gh project item-add $N --owner $OWNER --url $URL
# set Status = the step's sourceStatus (ids via `gh project field-list $N --owner $OWNER --format json`)
gh project item-edit --project-id <PVT_id> --id <item id> --field-id <Status field id> --single-select-option-id <option id>
# simpler: let agenthook do assign+Status
agenthook run <number> [stepId]
```

- Epic: an **Issue card on the board** labelled `epic` (or typed `epicType`); children are native
  sub-issues (see github.md), each staged by its own card's Status. Epic card: no Status in a
  source stage.
- Dependencies are **not** honoured here. Keep dependents off source statuses and `run` them later.
