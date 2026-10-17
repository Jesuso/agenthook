# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] — 2026-10-16

### Added

- **Epics** — insight into large groups of tickets, on all four trackers. An **epic** is a tracker
  item that groups tickets; no agent ever runs on one (an epic dropped into a pipeline stage is
  skipped with an `epic_skipped` event and never counted by `reconcile` or the queue pull). Each
  tracker uses its own native marker (ADR 0003–0006):
  - **Asana**: a task with the custom task type `Epic` (`tracker.epicType`); tickets are its
    subtasks that are also in the project. Create the type by hand — Asana's API can't.
  - **GitHub (labels) and GitHub Projects v2**: an issue typed `Epic` (organization repos) or
    labelled `epic` (`tracker.epicType` / `tracker.epicLabel`); tickets are its native sub-issues.
    On Projects v2 only epic cards on the board are listed, each child staged by its card's Status.
  - **Jira**: an issue type at hierarchy level 1 (or `tracker.epicType` by name); tickets are the
    issues whose `parent` is it. The deprecated *Epic Link* field is not read.
- **Epics view** in `ah ui` — an Epics tab (progress bar by stage with a sliding stripe on the running
  part, needs-you count, velocity and ETA when there is enough history), an epic page, and an epic
  chip and filter on tickets. Live from the receiver, with a receiver-down fallback built from local
  history. `GET /api/epics[/<ref>]`.
- `agenthook epics [name] [--ref <epic>] [--fresh] [--json]`, the MCP `epics` tool and
  `tick --epics` give agents and terminals the same payload; the **Digest** mentions epics that need
  you or have progress worth noting.
- **Ready to close**: an epic that is still open while every ticket is finished (and none needs you)
  is flagged on the epic only — a chip in the Epics list, a banner on the epic page, `readyToClose` in
  the `epics` payload and a line in the Digest. It never counts in the profile's headline Needs you,
  and agenthook never closes the epic itself. Only computed from a live read, never the offline
  fallback.
- `epic_changed` event (GitHub and Jira): the tracker delivered an epic-structure change (a child
  gained or lost its parent, an epic created or retyped). Read-only signal that refreshes the Epics
  view; hidden by default like `coalesced`. Asana sends nothing for these changes, so its view
  refreshes on ticket events and the Refresh button.

### Changed

- The GitHub hook now also subscribes to `sub_issues`. An existing hook needs recreating: restart the
  receiver (it recreates the hook on boot) or `agenthook register <url>`.
- Jira: ticking **Issue deleted** on the hand-made webhook is now optional-but-useful (it only feeds
  the Epics view).
- `ui/dist` is not in git — after pulling, run `npm run build:ui` (and restart `ah ui`) to get the
  new dashboard.

- A GitHub personal-account repo (no issue types) no longer logs a warning on every epics read: the
  `422` on the issue-type query is noted once, then skipped.
- Turning on a `forge` for the first time makes finished tickets with a known PR read as "PR awaiting
  merge" until the `prs` op has recorded their merged state (it learns 20 per call).

### Known limits

- Epics on the GitHub issue-type path and on an org-owned Projects v2 board (including its webhook)
  are untested; the label path and a user-owned board are verified live. Jira higher hierarchy levels
  (Premium initiatives) are ignored.

## [0.5.0] — 2026-10-15

### Added

- **Profile-focused web UI** (docs/web-ui.md). Home is one card per profile (needs-you count,
  agents, queue, cost today); each profile has an Overview built around the human-attention
  bottleneck — **Needs you**, **Now**, **Progress** — plus profile identity (`ui: {color, emoji}`),
  release of a held ticket (**Release…**), restart-when-idle and pause/resume, and tracker links.
- **Digest ("Catch me up")** — an on-demand, tool-less `claude -p` summary of one profile written
  from a receiver-built snapshot and a SOUL file (`digest.soul`, default `SOUL.md`); never started
  automatically, outside the slot pool (ADR 0002). `ah digest [profile]` runs it from the CLI.
- **Stats** — daily stats derived from the whole `events.jsonl` history (`GET /api/stats`, no
  rollup file): a Stats tab with a finished-per-day calendar heatmap, spend by step, run outcomes
  and per-ticket cost (median + p10–p90), and a small trend on the Overview.
- **What a ticket is about** — a plain one-paragraph summary of the tracker description is stored
  as `refmeta.summary` and shown on Now rows, Needs-you rows and the drawer.
- `ci_green` event: emitted once per `(ref, sha)` when every check on an agent PR's head has passed
  (payload `pr`, `sha`, `mergeable`, `mergeState`), so supervisors can wait on `events` instead of
  polling the forge (#259). Signal only; `forge.greenCi:false` disables.
- `dismiss {ref}` operator action (MCP tool, control socket, and a **dismiss** button on failed/cancelled
  rows in `ah ui`): acknowledges a failed or cancelled ticket by writing a `dismissed` event, so it
  stops counting as "needs you". The ticket and board are untouched; a later failure counts again.
- Per-step `maxConcurrent` cap inside the global slot pool (#277); `catchup` MCP write tool (#272);
  PR rows marked `mine` for the profile owner (#278); verdict free-form `summary` kept and shown on
  `runs`/`prs` (#279); `move_refused` event for refused or failed advances (#274).

### Changed

- Dashboard: an operator `cancel` now shows as a distinct `cancelled` status instead of `failed`, and
  no longer counts toward the "needs you" tile.
- "PR ready" in Needs you requires a known PR; the `prs` op learns the merged/closed state of known
  PRs, so tickets finished by hand no longer sit in Needs you forever (#289).

### Fixed

- ngrok ingress registered another profile's tunnel as its own, so webhooks were registered at the
  wrong domain (#284).
- Block gate is re-checked at dispatch time (#276); blocked Asana tasks are skipped in queue pulls
  (#271); coalesced webhooks no longer emit `enqueued` (#273); `status`/`tick` etag no longer churns
  while an agent runs (#270).
- Native `<select>` menus are readable in the dark theme (#292).

## [0.4.0] — 2026-10-13

### Added

- **Agent interface** (docs/mcp.md, docs/agent-guide.md). External agents — an engineering-manager
  loop, a Claude Code session — can read and manage the pipeline without hand-written polling scripts.
  - `agenthook mcp [--read-only]`: zero-dependency stdio MCP server multiplexing every profile.
    Reads (`profiles`, `status`, `events`, `runs`) come from the state dir and work with the receiver
    down; `board`, `prs`, `tick` and all writes go over `control.sock`.
  - Write tools: `run`, `cancel`, `release`, `pause`, `resume`, `set_concurrency`, `reconcile`,
    `pull`, `restart` — audited to `control-audit.jsonl` (0600; `release` text never logged).
    Granting them delegates operator authority; see SECURITY.md. `--read-only` removes them.
  - Token thrift: `etag`/`ifNoneMatch`, byte-offset event cursors, and `events` with `waitS`
    (`fs.watch`-driven, no polling).
  - `guide` tool + `docs/agent-guide.md` so agents learn the model, response shapes, recipes and
    error meanings without reading source; ready-made skill in `examples/skills/agenthook-supervisor`.
  - `agenthook tick [--json]` and `agenthook watch` for shell-only agents.
  - GitHub forge `listAgentPrs` (CI roll-up, mergeability) backs `prs`; new `dequeued` event.
  - Dispatcher `cancel` (SIGTERM→SIGKILL, resolves as `fail` "cancelled by operator"); the queue gains
    runtime `setMax`, `remove`, operator pause; a paused queue also stops backlog pulls.

- **Web dashboard** (`agenthook ui`, docs/web-ui.md). A local, token-gated dashboard on 127.0.0.1
  with live updates (SSE, no polling): profiles overview with capacity, tickets table, event feed
  rail, ticket drawer with a live-tailed run log, pipeline graph, light and dark themes. It can edit
  instruction files (diff-confirm, conflict detection, backups in the state dir, live "what the agent
  sees" prompt preview) and the config (raw JSON editor plus Basics/Pipeline forms with stage
  pickers; validated, guarded save, restart-when-idle), rename or remove profiles, and restart a
  receiver. Writes are Origin/header-guarded and audited to `ui-audit.jsonl`.
- **Control socket** (`control.sock`, 0600, NDJSON): liveness, `discover`, `restart {when:"idle"}`
  (followed by one reconcile), and `decommission {when:"idle"}`. The UI and the new agent interface
  both use it.
- **Profile management**: `agenthook rename <name> [--move]` (label-only, or move the state dir via
  restart-when-idle), `agenthook restart`, `agenthook remove <name|key> [--purge]` (archives the state
  dir to `~/.agenthook-archive/`). Profiles carry a stable `stateId` state key and a `profile.json`
  marker; commands resolve a profile by label or key; `ls` shows each config path and flags ghost or
  config-missing profiles; only `start` creates a state dir.
- Per-step `maxMinutes` / `idleMinutes` timeouts for `claude -p`; each run's assembled prompt is
  persisted beside its log.

### Changed

- **Minimum Node raised to 22** (#130). Node 20 is EOL; CI now runs on Node 22 & 24.

### Fixed

- State dirs are created private and `control.sock` is born 0600 (#183).
- A detached receiver on Linux runs in its own systemd user scope, so it survives its parent's
  session ending (#234); detached-receiver output and crash cause are logged (#160).
- The code-stage prompt tells the agent to check PR mergeability before waiting on CI (#161).
- GitHub tracker `listResting` (so `reconcile`) re-reads each candidate issue live: GitHub's
  list-by-label index lags label moves by seconds, which could replay a ticket that had just left
  the stage and start a second agent on it.
- **Forge hook cleanup is scoped to the profile's own hook** (#118). `deleteOurHooks()` in the
  `github` forge deleted every repo hook whose URL ended in `/forge`, so two profiles with a
  `forge` block on one repo removed each other's hook on boot/stop — the other profile silently
  lost `pull_request`/`workflow_run` deliveries. A hook is now ours only when its id matches the
  one persisted on create (`forge:github:hookId:<owner>/<repo>` in the profile's secrets KV), its
  URL matches the profile's previous public URL (legacy hooks), or it sits at the exact target
  being registered. `agenthook register` constructs the forge before overwriting `public_url.txt`
  so it still sees the old URL.
- `agenthook events --follow` no longer exits with `no events yet` when `events.jsonl` does not
  exist (#119). It watches the data directory, starts at byte 0, prints `waiting for events...`
  to stderr (stdout stays clean JSONL under `--json`), and drains once after the watcher attaches
  to close the creation race. The tail loop is the exported `tailFile(dir, file, startPos, onLine)`.
- The code-stage prompt no longer hardcodes "include the branch name and PR number" for the
  tracker status comment (#120). Comment contents now follow the step's standing instructions,
  falling back to "include the PR link" when they are silent — so an instructions-file rule like
  "no branch names in tracker comments" is no longer overridden by the later harness line.
- `ah agents` and bare `ah status` no longer need the config's secrets. Both only read
  `~/.agenthook/<name>`, but went through `loadConfig`, which interpolates every `${VAR}` and
  throws `unset environment variable(s)` when one is missing — so from a worktree without a
  `.env` (or any shell without the tokens) `ah agents` printed nothing and exited 1 while
  `ah status <name>` still said UP, which scripts read as "daemon up, zero agents". They now
  use `peekConfig` (name + state paths from the raw JSON, no interpolation), and `ah agents`
  accepts an optional profile name like `ah status [name]`.

## [0.3.0] — 2026-09-25

### Added

- **Forge axis** (`cfg.forge`, `src/forges/github.js`) — an optional third blind adapter beside
  tracker and ingress that reports what happened to the *code*. The `github` forge serves
  `POST /forge` (always `x-hub-signature-256`-verified via the shared `src/hmac.js`) and turns a
  merged PR on an `agent/<ref>` branch into a `merge` job: no agent, fail-closed assignee check,
  `enterStage` into the single `completeOnMerge` manual step, then `adapter.complete` (Asana:
  `completed:true`) and a `merged` event. `stop`/`register`/`unregister` manage the forge hook too.
- **Red-CI handling** on agent PRs. The forge also subscribes to `workflow_run`: a failed run on a
  same-repo `agent/<ref>` branch becomes a `ci` job. Attempt 1 re-runs the failed jobs; attempt 2
  posts the failing log tail as a PR comment (never into prompts — the PR head controls it) and
  bounces `changes` to `forge.ciTarget` (default the `createsWorktree` step) through the shared
  `maxAttempts` cap. A bounce is parked while a step runs on the ref. `forge.redCi:false` disables.
- **Multi-repo routing** — one board, N codebases. `cfg.repos[]` (`{id, path, match, default?,
  instructionsFile?, worktreePrefix?}`) maps a task's opaque `routeKeys` to a checkout via pure
  `resolveRepo`: one match wins, none falls back to the `default` repo, `conflict`/`unroutable`
  **hold** the task (no spawn, no attempt). Worktrees nest as `<base>/<repo.id>/<ref>`; the first
  routed step sticks the ref to its repo (`repo.json`). Every tracker supplies keys through
  `tracker.routeField` (Asana custom field, GitHub labels, Jira field, Projects v2 field, local).
  `cleanup`/`resume`/`follow --repo`/`doctor`/`status`/`ls` are repo-aware; `doctor` gains a ⚠
  warning level with repo lints and legacy-orphan detection. No `repos` block → unchanged.
- **Queue-stage auto-pull** (opt-in). A step may bind a backlog lane — `queueSectionGid` (Asana),
  `queueStatus` (Jira / Projects v2 / local) or `queueLabel` (GitHub). When a `maxConcurrent` slot
  frees (`run_end`) and once on boot, `src/pull.js` pulls the top items into free slots via
  `enterStage(…, {assign:false})` so the live webhook fires the step. Board order: Asana section
  order, Jira `Rank ASC`, Projects board position, GitHub oldest-created first. Never timer-driven.
- **File-overlap guard** (`overlapGuard: true`). Triage verdicts may list predicted `paths`; a
  sibling task's worktree step waits in its source stage while those paths overlap another
  in-flight task's lock, and is re-offered when that blocker leaves the pipeline.
- **`@agent` resume from a held step** (Asana + GitHub). An owner-authored comment starting with
  `cfg.trigger` on a held item re-runs the step that held, with the comment appended to the prompt.
  Fail-closed: author must equal our tracker identity, the assignee gate must pass, `held.json`
  must name a non-manual step under its `maxAttempts` cap.
- **Asana task dependencies.** A task with an incomplete blocker rests in its source section;
  completing the last blocker releases its dependents (new `task changed` webhook filter). Opt-in
  per-step `completeTask` (Asana analog of `closeIssue`) marks the task completed on entry.
- **Event bus.** Every lifecycle transition appends to `<dataDir>/events.jsonl` (`enqueued`,
  `run_start`, `run_end`, `pipeline_done`, `blocked`, `failed`, `merged`, `ci_red`, `pulled`).
  New **`ah events`** command (`--follow`, `--event`, `--ref`, `--json`). Opt-in **sinks** forward
  `blocked`/`failed`/`pipeline_done` to Slack, Telegram or a webhook.
- **Queue persistence.** Jobs waiting behind `maxConcurrent` are written to `queue.json` and
  re-enqueued on boot; `ah status` shows the persisted queue while the server is down.
- **Human ids everywhere.** `Task.displayId` (Asana: the `tracker.displayIdField` custom field,
  default `ID`; GitHub: `#<n>`) plus title and PR number are recorded per ref in `refmeta.json` and
  shown by `ah agents` (`--verbose` adds pid/ref, `--json` emits records), `ah status` and
  `ah events` (`--ref` also resolves a display id or PR number).
- **Review findings feed rework.** A verdict may carry `findings`; on a `changes` bounce they are
  injected into the target step's prompt and cleared afterwards.
- **Per-step `lite` override.** `{ descriptionHeadings, model?, effort? }` swaps in a cheaper
  model/effort when every listed heading is present in the ticket description. A stored-difficulty
  `escalate` match still wins.
- Prompts tell agents to **read tracker comments** on re-entry after a hold
  (`AdapterMeta.readCommentsHowTo`), so human answers left as comments are seen.
- **`local` tracker** (`src/trackers/local.js`): a JSON board in the profile's data dir, no
  webhooks, no assignee scoping — drives the real engine offline. `AdapterMeta.usesPR:false`
  drops all PR language from prompts. Ships with the `docs/experiments` sweep harness.

### Changed

- New agent branches are cut from a **freshly fetched `origin/<default>`** (best-effort fetch,
  `--no-track`, falls back to the local default branch).
- `ah agents` shows `ctx=<total context>` and `out=<output>` instead of `tok=input/output`; cache
  read/create tokens are now part of the live tally.
- `running.json` records the step's `model`; the run log's first line is a `# <displayId> <title>`
  header.

### Fixed

- Step dedup keys (`step:<id>:<ref>`) are released when a run ends, is refused (coalesce/drain) or
  is recovered after a crash — re-runs no longer need `catchup --force`.
- `ah agents` shows raw token counts under 1k instead of flooring to `0k`.

## [0.2.0] — 2026-07-01

### Added

- **GitHub Issues tracker** (`src/trackers/github.js`). The pipeline runs off issue **labels**
  (`sourceLabel`/`successLabel`/`failureLabel`/`holdLabel`): an issue carrying a step's `sourceLabel`
  fires it, and `advance` swaps the label (add-before-remove, crash-safe). The repo webhook is
  **auto-created via REST** and signed with an agenthook-generated secret (`x-hub-signature-256`),
  so it works behind an ephemeral ingress. Token: `repo` + `admin:repo_hook` (classic) or Issues +
  Webhooks RW (fine-grained); assignee scoping by the token's `/user` login, fail-closed. Adds
  `docs/github-setup.md` and the first adapter unit tests (`test/github.test.js`).
- **GitHub Projects v2 tracker** (`src/trackers/github-projects.js`). Steps bind a board's **Status
  single-select options** (not labels); the API is **GraphQL**. `advance` **sets** the Status
  (`updateProjectV2ItemFieldValue`) so a card sits in exactly one stage (single-occupancy, no
  add-before-remove). One **org** `projects_v2_item` webhook (`created`/`edited`) auto-creates when
  the project is org-owned (needs `admin:org_hook`), else prints manual setup; the fixed URL wants a
  stable ingress. Adds `docs/github-projects-setup.md`.
- **Native GitHub issue dependencies** — the GitHub Issues tracker now respects `blocked_by`. An
  issue with an open blocker **rests unfired** (block gate); closing the last blocker **re-fires**
  its dependents (close-release). Optional per-step `closeIssue` closes an issue on entry for the
  dependency-release case.
- **Per-step `model` and `effort`**, passed to `claude -p` (`--model` / `--effort`), so each
  pipeline step can run at its own capability tier. Plus **difficulty-gated escalation**: a triage
  step emits a `difficulty` in its verdict, persisted per task, and a downstream step's `escalate`
  map (`easy`/`medium`/`hard` → `{model, effort}`) sizes the agent up **only** for hard tickets —
  cheap-by-default implementation, strong model when it's warranted.
- **Token & cost tracking.** Every `claude -p` run is spawned with `--output-format stream-json`
  and its `result` event captured to an append-only `usage.jsonl` (`UsageRecord`: per-run tokens,
  cache read/create, model, cost, session). Surfaced by a new **`ah usage`** command (per-run table,
  `--ref`, `--day`/`--week` rollups) and token/cost columns on **`ah agents`** (live tally),
  **`ah status`**, and **`ah ls`**. Adds `docs/usage.md`.
- Contributor on-ramps: GitHub Discussions (Q&A + Ideas), `.github/SUPPORT.md`, a "Ways to
  contribute" section in `CONTRIBUTING.md`, a "Contributing & community" section in the README, a
  Sponsor button (`.github/FUNDING.yml`), and an `.editorconfig`.

### Changed

- Feature requests now go to **Discussions › Ideas** instead of the issue tracker; the
  `feature_request` issue template was removed and the issue chooser funnels ideas/questions to
  Discussions. Issues are for reproducible bugs.

## [0.1.2] — 2026-06-28

### Security

- Removed the maintainer email from `SECURITY.md` and `CODE_OF_CONDUCT.md`. Vulnerability and
  conduct reports now route through GitHub's private reporting form, so no personal or company
  contact address is published with the package.

## [0.1.1] — 2026-06-28

### Added

- `agenthook --version` (also `-v` / `version`) prints the installed version.
- Contributor scaffolding: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, this changelog, and GitHub
  issue/PR templates.
- Onboarding docs: getting-started, Asana/Jira setup, and a symptom-first troubleshooting guide.

### Fixed

- `agenthook alias` install hint now points at the correct `@jesuso/agenthook` package name.

## [0.1.0] — 2026-06-28

First public release, published to npm as **[@jesuso/agenthook](https://www.npmjs.com/package/@jesuso/agenthook)**
(the `agenthook` command).

### Added

- **Event-driven pipeline engine.** A task entering a step's source section fires a headless
  `claude -p` in a receiver-owned git worktree; on exit the agent's verdict (`advance` / `hold` /
  `changes` / `fail`) routes the task to the next section. No polling loop.
- **Two blind adapter axes** — tracker (where work comes from) and ingress (how the receiver is
  reachable) — each behind a one-interface adapter.
  - **Trackers:** Asana (sections drive the pipeline, auto-created webhook) and Jira Cloud
    (statuses drive it, by-hand webhook, Basic auth).
  - **Ingress:** `ngrok` (managed, ephemeral or reserved domain) and `hosted`/`manual` (static URL).
- **One CLI** (`agenthook`): `init`, `start`, `stop`, `ls`, `status`, `follow`, `resume`, `agents`,
  `cleanup`, `register`/`unregister`, `catchup`, `reconcile`, `doctor`, `alias`, `--version`.
- **Opt-in `ah` short command** via `agenthook alias` (symlink beside the bin; never forced).
- **Crash recovery** from local `running.json` (no board poll) + `catchup`/`reconcile` to replay
  events missed during downtime.
- **Assignee scoping**, fail-closed by default: only acts on items assigned to the token's own
  account unless `assigneeFilter: false`.
- **Sandbox** (`docker/`) — the blessed way to run `fullAuto` with only the repo mounted.
- Docs: getting-started, Asana/Jira setup, troubleshooting, architecture, providers, sandbox.
- Tests (`node:test`) + GitHub Actions CI (typecheck + tests + syntax check on Node 20 & 22).

### Security

- `fullAuto` (which adds `--dangerously-skip-permissions`) ships **off by default**; the server
  prints a loud warning at every boot while it's on.
- Webhook signatures verified with constant-time HMAC; handshake secrets stored `0600`.
- See [SECURITY.md](SECURITY.md) for the threat model and disclosure process.

[Unreleased]: https://github.com/Jesuso/agenthook/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Jesuso/agenthook/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Jesuso/agenthook/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/Jesuso/agenthook/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Jesuso/agenthook/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Jesuso/agenthook/releases/tag/v0.1.0
