# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Jesuso/agenthook/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Jesuso/agenthook/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/Jesuso/agenthook/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Jesuso/agenthook/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Jesuso/agenthook/releases/tag/v0.1.0
