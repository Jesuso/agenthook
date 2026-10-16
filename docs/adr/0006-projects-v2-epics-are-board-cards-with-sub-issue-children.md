# GitHub Projects v2 epics are epic-marked cards on the board, their children are sub-issues

For the Projects v2 tracker an epic is an issue card on the board that is an epic by the GitHub
rule of ADR 0004 (issue type `Epic`, or label `epic`). Its tickets are the epic's direct sub-issues,
each staged by its own card's Status on the board. Listing is scoped to the board. No agent runs on
an epic.

## Why

- Same identity and membership as the labels tracker, so one mental model for both GitHub trackers
  and one `isEpicIssue` rule. GraphQL `Issue` carries `issueType`, `labels`, `parent`, `subIssues`.
- The pipeline already scans the board's cards; the epic fields ride on that query, so a ticket
  learns its epic with no extra request, and an epic is skipped where the pipeline reads cards.
- Board scope matches Asana (project scope): the epics a team tracks on a board are the epics shown.

## Consequences

- **No push.** `projects_v2_item` (org hook) does not carry sub-issue changes and a user-owned board
  has no hook, so the view refreshes on ticket events and Refresh. A repo-level `sub_issues`
  subscription would need a `tracker.repo`; not done.
- GitHub adds sub-issues to the parent's projects by default, so children are normally on the board.
- A card with no Status is backlog; an off-board or other-repo child is untracked.
- Verified live on a throwaway user-owned board: epic listing, children with Status, ticket-side
  parent, and an epic card in a pipeline Status being skipped. The issue-type path and the org webhook
  are untested (personal account).
