# A Jira epic is a hierarchy-level-1 issue, its tickets are the issues whose `parent` is it

For the Jira tracker an epic is an issue whose **issue type is at hierarchy level 1** (Jira's own
epic level; `tracker.epicType` pins a type by name instead). Its tickets are its direct children:
the issues whose `parent` is the epic, listed with JQL `parent = KEY`. Same tracker-neutral shape and
the same rule as ADR 0003 and 0004: no agent ever runs on an epic.

## Why

- Jira has epics natively, so identity and membership need no convention. `issuetype.hierarchyLevel`
  is part of the REST API, and the ticket's own `parent` object carries the parent's issue type, so a
  ticket learns its epic from the one issue fetch it already makes.
- The `parent` field is Atlassian's replacement for the deprecated Epic Link / Parent Link custom
  fields, and `parent = KEY` is the documented way to search an epic's children (the epic-specific
  endpoints are deprecated). Using it covers team-managed and company-managed projects alike.
- Level 1 rather than the name "Epic": renamed or localized epic types keep working, and a Subtask's
  parent (a Story, level 0) can never be mistaken for an epic.
- Parent changes show up in webhooks (changelog item `IssueParentAssociation`, with the old and the
  new parent keys), so the epic view refreshes on events, like GitHub.

## Consequences

- JQL cannot filter by hierarchy level, so listing epics first reads the project's issue types and
  then searches `issuetype in (<level-1 names>)` (memoized).
- Search pages by `nextPageToken`; we page up to 10 pages of 100.
- The webhook is created by hand (Jira Cloud forbids it with a token); epic support asks to tick
  **Issue deleted** too, optionally.
- Verified against a real Jira Cloud project (team-managed): listing, children, ticket-side parent,
  and the changelog shapes for add, remove and reparent.
