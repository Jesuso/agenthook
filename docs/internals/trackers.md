# Provider specifics that bite

- **Asana** — every webhook carries its own `X-Hook-Secret` established by a handshake POST, so
  secrets are keyed by request path. One project webhook (path `/mytasks`) with filters
  `task/added` + `story/section_changed` (verified to deliver on a project hook). Both route via the
  task's **live** `memberships.section.gid` → the step whose `sourceSectionGid` matches. Dedup:
  `step:<id>:<gid>` (created-in-section) and `secmove:<storyGid>` (moved). `advance` moves a task by
  `POST /sections/<gid>/addTask`. A third filter, `story/comment_added`, carries the `@agent` resume
  (author = `created_by.gid` must equal `userGid`; dedup `trigger:<storyGid>`; project-hook delivery
  not yet smoke-tested).
- **Jira** — Basic auth (`base64("<email>:<token>")`, REST v2). Steps bind `sourceStatus`; routing
  is on the issue's status. `advance` has no "set status" — it executes the **transition** whose
  `to` matches the target (an unreachable status is a logged no-op). Webhook is **by hand** (Jira
  Cloud forbids token-created hooks); agenthook generates the signing secret + prints setup. Run
  behind a **stable** ingress. Dedup: `step:<id>:<key>` (created), `secmove:<changelogId>` (status move). **Epics** (ADR 0005): an issue whose type is at `hierarchyLevel` 1 (or `tracker.epicType` by name); its tickets are the issues with `parent` = it (`/search/jql`, `nextPageToken` paging); `epic_changed` signals come from the changelog item `IssueParentAssociation` (old + new parent key) and issue created/deleted under an epic.
- **GitHub** — issues have no board sections, so steps bind **labels** (`sourceLabel`): an issue
  carrying it fires the step. `advance` swaps the label — **add target, then remove source** (crash
  between the two leaves the issue re-firing, not stuck). One repo webhook on the `issues` event,
  **auto-created via REST** (unlike Jira) and signed with an agenthook-generated secret →
  `x-hub-signature-256`. Routes `opened`/`reopened`/`assigned` by the issue's current labels
  (`step:<id>:<n>`) and `labeled` by the added label (`secmove:<delivery>`). The hook also takes
  `issue_comment` (`created` only, PRs skipped) for the `@agent` resume (dedup `trigger:<comment.id>`),
  and `sub_issues` + `issues` `typed`/`untyped` → a read-only `{kind:'epic_changed', ref:<epic>}` signal
  (dedup `epic:<delivery>`) that `src/epic-changed.js` emits outside the queue, dropping ops' epics cache;
  since a resumed issue carries the step's `holdLabel`, `advance` removes that too. 'Us' = the token's login
  from `/user`. Token needs `repo` + `admin:repo_hook` (classic) or Issues + Webhooks RW (fine-grained).
- **GitHub Projects v2** — the *other* GitHub tracker: steps bind a board's **Status single-select
  options** (`sourceStatus`/… — Jira's keys), not labels. API is **GraphQL** (`/graphql`, Bearer);
  board is `tracker.project:"owner/number"` (org or user), `ref` = the issue number (resolved to its
  card by scanning items). `advance` **sets** the Status via `updateProjectV2ItemFieldValue` —
  **single-occupancy** (one mutation, no add-before-remove), so a card sits in exactly one stage; a
  Status with no board option is a logged no-op, and options are **not** auto-created. One **org**
  `projects_v2_item` hook (`created`/`edited`; `edited` acts only on a Status single-select change,
  re-reading the item live) signed like `github` → `x-hub-signature-256`. The hook auto-creates for
  an **org**-owned project (needs `admin:org_hook`), else prints manual setup; a **user-owned**
  project has **no PAT hook path**. URL is fixed → **stable ingress** (like Jira). 'Us' = `viewer`
  login; fail-closed. Token: classic `project`+`repo`(+`admin:org_hook`), or fine-grained Projects RW
  + Issues R + org Webhooks RW. **Epics**: an Issue card typed `epicType` or labelled `epicLabel`
  (the `github` rule over the GraphQL shape); tickets = its native sub-issues, staged by their own
  card's Status (`""` on-board with no Status, `null` off-board); `listEpics` = epic cards on this
  board only. No `epic_changed` signals yet (the org hook carries no sub-issue events).

See [epics.md](epics.md) for the cross-provider epic model this feeds into.
