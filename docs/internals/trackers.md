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
  behind a **stable** ingress. Dedup: `step:<id>:<key>` (created), `secmove:<changelogId>` (status move). A `comment_created` carries the `@agent` resume, handled before the payload-assignee gate (a comment payload's `issue.fields` may be abbreviated): author `comment.author.accountId` must strictly equal our `/myself` accountId (`isOwner`, never `isOurs`), plus a fresh `ownedByUs` fetch; dedup `trigger:<comment.id>`. **Epics** (ADR 0005): an issue whose type is at `hierarchyLevel` 1 (or `tracker.epicType` by name); its tickets are the issues with `parent` = it (`/search/jql`, `nextPageToken` paging); `epic_changed` signals come from the changelog item `IssueParentAssociation` (old + new parent key) and issue created/deleted under an epic.
- **GitHub** — issues have no board sections, so steps bind **labels** (`sourceLabel`): an issue
  carrying it fires the step. `advance` swaps the label — **add target, then remove source** (crash
  between the two leaves the issue re-firing, not stuck). One repo webhook on the `issues` event,
  **auto-created via REST** (unlike Jira) and signed with an agenthook-generated secret →
  `x-hub-signature-256`. Routes `opened`/`reopened`/`assigned` by the issue's current labels
  (`step:<id>:<n>`) and `labeled` by the added label (`secmove:<delivery>`). A webhook payload's
  labels/assignees are a SNAPSHOT — a delayed delivery (e.g. during a GitHub incident) can carry
  one that's since gone stale, so both routes re-read the issue live (`liveIssue`, strongly
  consistent, same as `stillRestingIn`/`listResting`) rather than trusting the payload, and yield
  no job when the live issue has moved to a different step, closed, or is no longer ours. The hook also takes
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
  an **org**-owned project (needs `admin:org_hook`) subscribed to `projects_v2_item` +
  `issue_comment`, else prints manual setup; a **user-owned** project has **no hook path** for item
  moves (GitHub sends `projects_v2_item` only for org-level projects — not via a GitHub App either). `issue_comment` (`created` only, PRs skipped) carries the `@agent` resume: author must
  strictly equal the `viewer` login (`isOwner`, never `isOurs`), then one `node(Issue){projectItems}`
  read maps the issue to its card on *this* project (no board scan; none → no job), `issueIsOurs`
  on that fresh issue, `resumeJob`, and — when the held step sets `holdStatus` — the card's live
  Status must still equal it; dedup `trigger:<comment.id>`. A **repo** hook (same URL + secret,
  "Issue comments") delivers it too — printed, never auto-created, for user-owned boards / no scope. URL is fixed → **stable ingress** (like Jira). 'Us' = `viewer`
  login; fail-closed. Token: classic `project`+`repo`(+`admin:org_hook`), or fine-grained Projects RW
  + Issues R + org Webhooks RW. **Epics**: an Issue card typed `epicType` or labelled `epicLabel`
  (the `github` rule over the GraphQL shape); tickets = its native sub-issues, staged by their own
  card's Status (`""` on-board with no Status, `null` off-board); `listEpics` = epic cards on this
  board only. No `epic_changed` signals yet (the org hook carries no sub-issue events).
- **GitHub App auth** (`github`, `github-projects`, and the `github` forge) — an optional
  `auth: {type:"app", appId, installationId, privateKey|privateKeyPath}` replaces `token`.
  `src/github-auth.js` (node:crypto only) signs an RS256 JWT, exchanges it for an installation
  token, and caches it module-wide per `appId:installationId` (shared by tracker + forge), refetching
  5 min before `expires_at`. `githubFetch` retries a 401 once with a fresh token. An installation
  token is a `[bot]`, so 'us' is **`tracker.assigneeLogin`** (required, validated) and never `/user`
  or `viewer`. Projects v2 assigns via `user(login:){id}`. The App's own webhook stays inactive; the
  same repo/org hooks are created with the installation token. User-facing:
  [docs/github-app.md](../github-app.md).
- **Linear** — steps bind one team's **workflow state names** (`sourceStatus`/… — Jira's keys),
  resolved case-insensitively to state ids from `tracker.team` (a team key or URL; team + states
  memoised, an unknown name throws listing the team's states). API is **GraphQL**
  (`api.linear.app/graphql`); a personal API key goes in `Authorization: <key>` with **no `Bearer`**.
  `ref` = the issue **identifier** (`ENG-123`, which `issue(id:)` accepts). `advance` **sets** the
  state via `issueUpdate({stateId})` — no transition graph, every move lands. One **team** webhook
  (resource types Issue + Comment) is auto-created via `webhookCreate`, signed with an
  agenthook-generated secret; creating it needs a Linear **admin**, else boot prints manual setup.
  `authenticate`: `linear-signature` hex HMAC first, then `webhookTimestamp` must be within **60 s**
  (replay window). Routes Issue `create` (`step:<id>:<ref>`) and `update` with `updatedFrom.stateId`
  (`secmove:<issueId>:<updatedAt>`); Comment `create` is the `@agent` resume (author `userId` must
  **strictly** equal `viewer.id`; dedup `trigger:<comment.id>`). 'Us' = GraphQL `viewer` id, resolved
  lazily and memoised; the assignee check reads the payload's `assigneeId`; fail-closed. No epics.

See [epics.md](epics.md) for the cross-provider epic model this feeds into.

## Done signal

The board is the only source of Done (#583). A ticket is **board-done** when its tracker's native
done flag is set, **or** when it enters a **terminal stage** — the source stage of a `manual: true`
step. The terminal stage counts as done for **every** tracker. `fetchTask().completed` reports the
**native flag only** (local, which has no flag, reports its terminal stage); a reader that wants
board-done checks the stage separately.

Both halves surface as one event, `board_done` (signal only — nothing runs, nothing moves):

- `via: "flag"` — the tracker delivered the done flag flipping on a ticket that passes the adapter's
  fail-closed ownership check. The adapter returns a `{kind:'board_done'}` job alongside whatever
  jobs it already returns (close-release, unblock, step routing); `src/board-done.js` dedups it on
  `seen` and emits it outside the run queue, like `epic_changed`. `step` is `""`.
- `via: "stage"` — dispatch's manual branch (`src/dispatch/step.js`) emits it on every manual-step
  entry, with or without `drainWorktree`. `step` = the manual step, plus `name`, `url`.
  `pipeline_done` is unchanged (still `drainWorktree` only).

One ticket can produce both (e.g. a GitHub `closeIssue` done step: the stage entry, then the close
webhook); a counter dedups per ref. The dashboard never makes a row from a `board_done` alone
(`src/ui/rows.js`): a flag signal can name an owned ticket the pipeline never touched.

| Tracker | Native done flag | `fetchTask().completed` | Webhook when the flag flips → job | Terminal stage counts |
|---|---|---|---|---|
| Asana | task `completed` | `t.completed === true` | `task changed [completed]`: live re-read (`completed,assignee.gid`); completed + `isOurs` → `board_done` (`done:<gid>:<event created_at>`), plus the unblock jobs | yes |
| Jira | status category `done` | `statusCategory.key === "done"` | `jira:issue_updated` with a status changelog item: after the `isOurs` gate, `fields.status.statusCategory.key === "done"` → `board_done` (`done:<changelog.id>`), whether or not a step matched | yes |
| GitHub labels | issue `closed` | `issue.state === "closed"` | `issues closed`: `issueIsOurs(issue)` → `board_done` (`done:<x-github-delivery>`), plus the close-release jobs | yes — without `closeIssue` it is the only done agenthook itself produces (the issue stays open until a human or a `Closes #N` merge closes it) |
| GitHub Projects v2 | issue `closed` | `norm(issue.state) === "closed"` | none — the org hook subscribes only `projects_v2_item` + `issue_comment`, so an issue close is never delivered. Done is observed through the terminal stage: a Status move into a manual step's status (e.g. GitHub's built-in "Item closed → Done" project workflow) | yes — the only observed done |
| Linear | state type `completed` or `canceled` | `completed`/`canceled` | Issue `update` with `updatedFrom.stateId`: the new state's `type` (from `team().states`) is `completed`/`canceled` and `isOurs(assigneeId)` → `board_done` (`done:<id>:<updatedAt>`), whether or not a step matched | yes |
| local | none (terminal stage only) | the stage is a manual step's `sourceStatus` (failure, hold and unbound stages are not) | no webhooks; a move into any step's source stage (manual included) is pushed via `onJobs` | yes — the only done |
