# A GitHub epic is an issue typed "Epic" (or labelled `epic`), its tickets are its sub-issues

For the GitHub tracker an epic is an issue whose **issue type** is `Epic` (name configurable), or,
where issue types are unavailable, an issue carrying the configurable `epic` **label**. Its tickets
are the epic's direct **sub-issues**. This keeps the tracker-neutral epic shape of ADR 0003 and the
same rule: no agent ever runs on an epic.

## Why

- Sub-issues are GitHub's own hierarchy: `GET /repos/{o}/{r}/issues/{n}/sub_issues`, `…/parent`, and
  every issue carries `parent_issue_url` plus `sub_issues_summary {total, completed, percent_completed}`.
- Issue types are the official "what kind of issue is this" mechanism, but they are an organization
  feature; personal-account repositories (including this one) cannot use them. A label is the
  conventional fallback there.
- Identity must stay explicit, as in ADR 0003: an issue that merely has sub-issues is not an epic.
- GitHub delivers the changes as webhooks (`sub_issues`: `sub_issue_added/removed`,
  `parent_issue_added/removed`; `issues`: `typed`/`untyped`), so the epic view can refresh on events,
  unlike Asana where epics are found by reading.

## Consequences

- Two identity paths (type, label) behind one `isEpic`. Either marks an epic; type is preferred in docs.
- Limits to document: 100 sub-issues per parent, 8 nesting levels (we read direct children only).
- Webhook registration gains the `sub_issues` event; existing hooks need re-registration (`ah register`).
- GitHub Projects v2 tracker and Jira are later mappings onto the same shape.
- The type path is untested on our own repo (personal account); we dogfood the label path.
