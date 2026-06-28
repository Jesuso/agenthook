# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/Jesuso/agenthook/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/Jesuso/agenthook/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Jesuso/agenthook/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Jesuso/agenthook/releases/tag/v0.1.0
