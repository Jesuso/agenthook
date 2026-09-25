# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
