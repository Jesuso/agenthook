# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `ah ui`: the Basics form's Sandbox group shows a read-only **Sandbox readiness** card once a
  backend is set (saved or just toggled on). It has three ✓/✗ rows: the container runtime is
  installed and reachable, the agent image is built, and a claude credential is in the profile's
  `.env`. Each ✗ row shows the CLI command that fixes it (`agenthook doctor --fix`,
  `claude setup-token`, …). It is backed by `GET /api/sandbox-readiness`, which reuses doctor's
  checks (now shared as `sandboxRuntimeChecks`). It never builds an image, never writes `.env`,
  and never returns a credential value (#495).
- Merge catch-up: `agenthook reconcile` (and reconcile-on-boot) now also replays agent PRs the
  forge merged while the receiver was down, so `completeOnMerge`, the worktree drain and the
  release of dependent tasks still happen. Backed by a new optional `Forge.listMergedAgentPrs`
  (GitHub) and a stored watermark (`merge-watermark.json`, first run looks back 7 days); a merge
  the live webhook already handled is never re-run, and a plain boot makes no forge call. The
  `reconcile` MCP tool reports `merged`; a `reconcile_merges` control op runs only this step (#517).
- `agenthook init` now offers two more stages for every wizard-driven tracker (Linear, Asana,
  Jira, GitHub, GitHub Projects): a skippable **hold** stage (a `hold` verdict moves the task there
  so the board shows the agent is waiting on a human) and a skippable **done** stage. Picking a done
  stage appends a manual `done` step with `drainWorktree`, which also makes the forge's
  `completeOnMerge` prompt apply, so trackers without a complete API (Linear and others) see the
  task land in Done when its PR merges (#482).
- `agenthook watch --follow` (alias `--stream`) stays attached and prints one JSON line per event
  instead of exiting after the first batch. Each line carries the exact cursor just past that
  event (resume from any line with no gaps or duplicates), `--heartbeat <s>` emits a keepalive
  line, and a final `watch_end` line reports the cursor on SIGTERM/SIGINT (exit 0), `--timeout`
  (exit 2) or every watched profile disappearing (exit 1) (#505).

### Changed

- The code-step instruction templates (`INSTRUCTIONS.example.md`, `examples/*/INSTRUCTIONS_CODE.md`,
  the `init --local` scaffold) now forbid writing under `.git/` or faking a hook's result; the only
  sanctioned bypass of an unrelated hook failure is `--no-verify` with the failed command and the
  reason recorded in the PR body, or a `hold` when the repo forbids bypassing hooks (#502).
- `requireVerdict` now defaults to `true`: a step whose agent exits 0 without writing a valid
  verdict file now **holds** (resumable with `@agent`) instead of silently advancing. Add
  `"requireVerdict": false` to a step to keep the old advance-on-clean-exit behaviour. A
  `verdict_missing {reason}` event fires just before the hold (#500).
- The built-in review prompt and the shipped `INSTRUCTIONS_REVIEW.md` templates now block on a
  test that can't fail when the change it covers is reverted, and on an unmet acceptance criterion
  (bounced with `changes` if the agent can fix it, held for a human otherwise); the review prompt
  can now `hold` (#503).
- The implement/change prompt for a PR-based tracker now requires the PR body to link the task on
  its own line, exactly `**<Platform>:** <task URL>`; the review prompt checks for that line and
  returns `changes` (never `advance`) when it's missing. Same rule added to the shipped
  `examples/*/INSTRUCTIONS_CODE.md` / `INSTRUCTIONS_REVIEW.md` templates (#504).
- The default worktree base is now `../<repo-dir-name>-worktrees` instead of the shared
  `../agenthook-worktrees`, so two profiles (or two single-repo setups) whose checkouts sit under
  the same parent directory no longer collide when their trackers produce the same ref. Migration:
  a worktree already present at `../agenthook-worktrees/<ref>` keeps being used for that ref until
  it's drained; the old directory can be removed once no task is in flight. An explicit
  `worktreePrefix` (global or per-repo) is unaffected (#480).

### Fixed

- Boot no longer dies when the tracker is flaky: `registerWebhook` is retried on 5xx/429/network
  errors/timeouts with a capped backoff (5 s doubling to 5 min, indefinitely) and on a 404 three
  times over about a minute, logging `[boot] tracker unavailable, retrying in Ns`; meanwhile
  `agenthook status` shows `starting (tracker unavailable)` instead of UP, and SIGINT/SIGTERM abort
  the wait. Asana and GitHub errors now carry the HTTP status for this (#510).
- Sandbox: in `egress.mode: "allowlist"` the run now also gets `NODE_USE_ENV_PROXY=1` and
  `YARN_HTTPS_PROXY`/`YARN_HTTP_PROXY`, so corepack (Node's built-in fetch) and Yarn Berry's own
  fetcher reach the egress proxy and a `packageManager`-pinned Yarn 4/pnpm project can install (#509).
- A managed tunnel (ngrok, cloudflared) that dies after boot is now visible: the ingress adapter's
  new optional `onExit` hook records `ingressDown {at, reason}` in the heartbeat, `agenthook status`
  prints `ingress : <type> DOWN (...)` instead of UP, and `agenthook doctor` warns that webhooks
  can't reach the receiver until `agenthook restart` (#483).
- The merge job's "has no complete() — leaving <ref> open" log line now appears only when nothing
  moved the task, and names the remedy (a manual step with `completeOnMerge: true`) (#482).
- Claude runs now set `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, so a background subagent is no
  longer killed 10 minutes after its last turn (a step's own `env` can still override it). The
  stream-json parser also sums `usage`/`duration_ms` across multiple `result` events (one per
  background turn) instead of keeping only the last turn's, which previously under-reported
  tokens/duration next to the session's cumulative `total_cost_usd` (#501).
- GitHub tracker: a webhook delivered late (e.g. during a GitHub incident) no longer re-runs a step
  the issue has already left. `opened`/`reopened`/`assigned` now route off a fresh read of the live
  issue instead of the payload's label snapshot, and `labeled` reconfirms the issue still carries the
  label; a closed issue, one no longer assigned to us, or a failed read yields no job (#506).

## [0.10.0] — 2026-10-18

**Trust release:** agents get less of your machine by default, and can optionally run in a per-run
container. **Before upgrading, read these three:**

- **Agents no longer inherit the receiver's environment.** Run `agenthook doctor`: it lists what
  is no longer passed. Add what your agents need to `agentEnvPassthrough` (`["*"]` restores 0.9).
- **`fullAuto: false` claude runs are pinned** to `--setting-sources user,project --permission-mode
  dontAsk`. They need Claude Code ≥ 2.1.303 (older versions fail those runs), and file edits must be
  allowed explicitly (repo `.claude/settings.json` or a step `allow` policy).
- **GitHub App auth now mints a per-run token** (`githubRunToken`, on by default). An App without
  Contents and Pull requests write refuses runs. Grant them, or set `githubRunToken: false`.

### Added

- `agenthook doctor` prints an **isolation report**: `isolation ·` rows for the sandbox (type and
  image), the agent env, egress, credentials (your own token or per-run App tokens, and whether
  unsandboxed steps can still read the host `gh` login and `~/.ssh`), each step's permission mode,
  and prompt fencing. ⚠ rows flag `fullAuto` without a sandbox, a `sandbox: false` step under
  `fullAuto`, a `defaultMode: "acceptEdits"` or a broad allow rule (`Bash`, `Edit(*)`, …) in
  `~/.claude/settings.json`, and a global git `insteadOf` rule that rewrites `https://github.com/`
  to SSH (run-token pushes would use your SSH key). Warn-only; nothing ever refuses. `status` gains a
  `sandbox :` line and the heartbeat a `sandbox` field (#476).
- Per-run GitHub App tokens for agents. Under GitHub App auth each agent run gets its own 1-hour
  installation token, scoped to the run's repo(s) and to what the step kind needs (never
  Workflows, admin or secrets). It lives in a per-run `gh` config dir that the receiver refreshes
  before expiry, and it is revoked when the run ends. A run whose token can't be minted fails with
  `GitHub run token: …` instead of falling back to your token. `doctor` mints and revokes one to
  check the App's permissions. Under the container sandbox the config dir is bind-mounted
  read-only at the same path so a sandboxed run sees the refreshed token too. See
  `docs/github-app.md#agent-run-tokens` (#474).
- Per-step `allow` / `deny` policy (`{ "commands": [...], "paths": [...] }`). For `claude`,
  `allow` runs the step with `--permission-mode dontAsk --allowedTools …` (and drops
  `--dangerously-skip-permissions` even under `fullAuto`); `deny` adds `--disallowedTools …`, which
  holds in every mode. A step with a policy on an agent that can't enforce it (`cursor`, `opencode`,
  `hermes`) is refused before spawn, never run unrestricted. `doctor` lists each step's effective
  rules and warns where they are advisory (no sandbox, interpreters on the allowlist). Steps without
  a policy get exactly the same argv as before. See `docs/configuration.md` (#475).
- Per-run container sandbox (`"sandbox": { "type": "docker" | "podman" }`, optional `image`,
  `memory`, `cpus`; a step opts out with `"sandbox": false`). Each agent run gets its own
  throwaway container as your user with all capabilities dropped, mounting only its worktree, the
  repo's git dir (config and hooks read-only), a per-run verdict dir and its own transcript dir;
  env is passed by name, never in argv. Boot refuses if the runtime is unavailable and reaps
  orphaned containers; cancel and timeout kill the container. Only `claude` is supported for now:
  a sandboxed `cursor`, `hermes` or `opencode` step is refused, never run on the host. `doctor --fix`
  builds the image. Network is allowlisted by default (see the next entry). See
  `docs/sandbox.md` (#472).
- Egress allowlist for sandboxed runs (`sandbox.egress`, and a per-step `egress`). Each run sits
  on its own internal network with no route out except a per-run HTTPS proxy that lets through only
  the model API (`api.anthropic.com`, `ANTHROPIC_BASE_URL`'s host, Bedrock/Vertex), the forge, the
  tracker API the prompt uses, the origin host and what you `allow` — host rules or registry presets
  (`@npm`, `@pypi`, `@crates`, `@go`, `@rubygems`, `@maven`, `@yarn`; none by default, doctor
  suggests them from lockfiles). Names that resolve to loopback, link-local (cloud metadata) or
  private addresses are refused. A denied host gets a 403 the agent can quote, a line in the run log
  and `egressDenied` on `run_end`; the outcome is unchanged. `mode: "none"` cuts the network,
  `"open"` restores the runtime default (doctor warns). The proxy runs the built-in image, so a
  custom `sandbox.image` also needs `agenthook-agent:<version>` (#473).
- Config editor: Basics → Sandbox group sets the profile's `sandbox` block (backend, image,
  memory, cpus, egress) — previously Raw-only. An inline warning shows when `fullAuto` is on with
  no sandbox configured.

### Changed

- **`fullAuto: false` claude steps run pinned.** Every claude run that isn't a `fullAuto` bypass
  (no `allow` policy) now passes `--setting-sources user,project --permission-mode dontAsk`, allows
  writing its own verdict file, and denies editor writes to the worktree's `.claude/settings.json`
  and `.claude/settings.local.json`. They no longer follow a `defaultMode` in
  `~/.claude/settings.json` (a user-level `bypassPermissions` used to make them silently full-auto)
  and no longer read `.claude/settings.local.json`; the repo `CLAUDE.md` and `.claude/settings.json`
  still load. Steps with an `allow` policy get the same sources and settings-file guard. `fullAuto`
  bypass argv is unchanged. **Migration:** to let a non-fullAuto step edit files, allow it
  explicitly: `"permissions": {"allow": ["Edit", "Bash(npm test)"]}` in the repo's
  `.claude/settings.json`, or a step `allow` policy (docs/configuration.md) (#476).
- The boot `fullAuto` banner depends on the sandbox: the full ⚠ block without one (it no longer
  suggests "permission prompts" — headless agents can't prompt), the same block naming the steps
  that set `sandbox: false`, or one `[boot] fullAuto inside the <type> sandbox` line when every step
  is sandboxed. `status` prints `auto    : headless (privileged tools denied unless allowed)`
  instead of `permissioned`. `docs/sandbox.md` is restructured around "what a bad ticket can reach"
  (#476).
- **Under GitHub App auth agents now push, comment and open PRs as the App (`<app>[bot]`)** with a
  1h token scoped to the run's repo. Grant the App Contents and Pull requests write (the
  [agent runs table](docs/github-app.md#minimal-permissions)). `githubRunToken: false` restores
  your own credentials. The `github` tracker prompt now comments with
  `gh issue comment <n> --repo <o>/<r>` instead of curl and `$GITHUB_TOKEN` (#474).

- **Agents no longer inherit the receiver's environment.** A spawned agent gets only an allowlist:
  process basics (`PATH`, `HOME`, locale, `TERM`, `XDG_*`, proxies, `SSH_AUTH_SOCK`, toolchain
  dirs), its own CLI's variables (`ANTHROPIC_*`/`CLAUDE_*` for claude, `CURSOR_API_KEY`,
  `OPENCODE_*`, `HERMES_HOME`), and the token the tracker's prompt tells it to use (e.g.
  `GITHUB_TOKEN`, `JIRA_API_TOKEN`), plus `GH_TOKEN`/`GITHUB_TOKEN` with a GitHub forge. Ingress
  authtokens, App private keys, webhook secrets and anything else in `.env` or your shell are
  stripped. **Migration:** run `agenthook doctor`. It lists what is no longer passed and what your
  agents likely need. Add those names to `"agentEnvPassthrough": ["AWS_*", "OPENAI_API_KEY"]`, or
  set `"agentEnvPassthrough": ["*"]` to keep the 0.9 behaviour. Either way, a receiver started from
  inside Claude Code no longer hands agents that session's own variables (`CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_CODE_MESSAGING_*`, `CLAUDE_EFFORT`, `CLAUDECODE`, …). This closes the environment path
  only: without a sandbox the agent can still read `.env` and your credential files from disk
  (#470).

### Security

- Ticket titles, descriptions, review findings and the owner's `@agent` reply are now fenced as
  untrusted data in every step prompt, behind a per-prompt nonce, with a standing rule to `hold` or
  `fail` (quoting the text) instead of following embedded instructions. Comments the agent reads
  count as answers only when posted by our own account. This is a mitigation, not a boundary; see
  the new "Prompt injection" section in `SECURITY.md` (#471).

### Fixed

- `agenthook init` now reads a `.env` beside the config (or in the current directory) for the tracker
  token, as its own error message promised. Before, it only saw exported variables and refused with
  "LINEAR_API_KEY is not set" even when the `.env` had it (#468).

## [0.9.0] — 2026-10-18

### Added

- Linear tracker (`tracker.type: "linear"`): a team's workflow states are the pipeline stages,
  refs are issue identifiers (`ENG-123`), scoping is the API key's user (fail closed), and the
  `@agent` resume works on comments. `start` creates the team webhook (HMAC + timestamp checked) or
  prints manual setup when the key's user isn't an admin. See `docs/linear-setup.md` (#444).
- `cloudflared` ingress: a quick tunnel (random `trycloudflare.com` URL, no account) or a named
  tunnel (`ingress.tunnel` + `ingress.hostname`, stable URL). Each profile runs its own process, so
  parallel profiles work without ngrok's one-tunnel limit (#445).
- `tailscale` ingress: exposes the receiver through Tailscale Funnel at a stable
  `https://<machine>.<tailnet>.ts.net/<profile>` URL. `start` checks up front that the node is
  connected, HTTPS certificates are on and Funnel is permitted (#449).
- GitLab forge (`forge.type: "gitlab"`, `forge.project`, optional `forge.baseUrl` for
  self-managed): a merged MR from an `agent/<ref>` branch completes the task, and a failed pipeline
  is retried once and then sent back to the code step, as with GitHub. `init` offers it when
  `origin` is a GitLab remote. GitLab authenticates hooks with a shared token rather than an HMAC,
  so use an HTTPS ingress. See `docs/gitlab.md` (#450).
- GitHub App auth (`tracker.auth` / `forge.auth` = `{ type: "app", appId, installationId,
  privateKey | privateKeyPath }`) for the `github` and `github-projects` trackers and the `github`
  forge, as an alternative to a personal token. Under App auth `tracker.assigneeLogin` is required:
  it is the identity for scoping and the `@agent` author check. A token-only config is unchanged.
  See `docs/github-app.md` (#451).
- `agenthook doctor --fix [--dry-run]` applies safe, local fixes: tightens the state dir to 0700,
  removes a stale pidfile or control socket, creates missing instruction files from the template,
  rebuilds a stale UI bundle, creates a missing worktree base and prunes stale worktree entries.
  It never touches `.env`, the config or webhooks. Plain `doctor` now also warns about a missing
  instruction file (a step would run with empty standing instructions) and says how many problems
  `--fix` can repair (#446).
- Jira supports the `@agent` resume: an `@agent …` comment from the token owner on a held issue
  re-runs the held step with the reply in its prompt, behind the same fail-closed gate as Asana and
  GitHub. Tick **Comment → created** on the hand-made Jira webhook to enable it (#447).
- GitHub Projects v2 supports the `@agent` resume: an `@agent …` comment from the token owner on a
  held card's issue re-runs the held step with the reply in its prompt. The auto-created org webhook
  now also subscribes to `issue_comment` (an existing hook is replaced on the next boot); a
  user-owned board, or a token without `admin:org_hook`, can use a repo webhook with the
  **Issue comments** event, whose setup `start` prints (#448).

### Fixed

- Docs and the `github-projects` startup message no longer claim a GitHub App gives a user-owned
  Projects v2 board a webhook: GitHub sends `projects_v2_item` only for organization-level projects
  (#451).
- A control socket path over the OS limit (a long `AGENTHOOK_HOME` or profile name) now refuses to
  start with a clear message; before, Node silently bound a truncated path and the CLI reported a
  running receiver as down (#439).

### Internal

- Release smoke (`npm run release:smoke`, `test/release/smoke.mjs`): installs the packed tarball
  into a temp prefix and runs `docs/quickstart.md` verbatim, the failure tour, the CLI's own remedy
  hints, restart, teardown and an upgrade, with a stub agent. Runs in CI on every PR;
  `--agent claude` before a release (see RELEASING.md).

## [0.8.0] — 2026-10-18

Stabilize and land (epic #412): a first run needs no tracker token and no tunnel, and the two
largest modules are split with no behaviour change. See [ROADMAP.md](ROADMAP.md).

### Added

- `RELEASING.md` — release cadence, checklist, and the config compatibility policy (a key whose
  meaning or default changes, or that's removed, gets a deprecation warning at config load for at
  least one minor release before the change).
- `ah doctor` and `ah ui` warn (⚠) when the built `ui/dist` bundle is missing or older than
  `ui/src` — previously a stale bundle was served silently.
- **Zero-setup quickstart** ([docs/quickstart.md](docs/quickstart.md)): `agenthook init --local`
  scaffolds a local-board profile (code → review → done) in the current git repo with no tracker
  token and no tunnel; `agenthook ticket add "<title>" [--body|--file] [--step]` adds a ticket
  (through the running receiver's new `ticket_add` control op, so the step fires at once) and
  `agenthook ticket ls` lists the board. `fullAuto` stays off unless you pass `--full-auto` or
  answer yes. `doctor` no longer flags the missing token on a local profile.
- **Event-driven `local` tracker** — stage changes on a local board push their jobs into the
  receiver in-process (a new optional adapter capability, `onJobs`), so steps chain with no
  poller and no network. `ah run <ref>` and `ah reconcile` on a local profile go through the
  running receiver, and `start --detach` returns once the receiver is serving, so a command typed
  next reaches it.
- A quickstart demo recording at the top of the README, and [ROADMAP.md](ROADMAP.md).

### Changed

- `src/dispatch.js` and `src/engine.js` are split into `src/dispatch/` and `src/engine/`
  modules. The old paths re-export everything, so importers are unchanged; no behaviour change.
- `CLAUDE.md` is now a short core; per-area detail moved to `docs/internals/`.
- A local item in a stage no step binds (e.g. `backlog`) is no longer reported as completed, so
  `ah run` accepts it and `cleanup` leaves it alone.

### Fixed

- `ah remove` and the UI's remove dialog no longer warn about un-unregistered webhooks for a
  profile that never had any (a `local` tracker with no forge).
- `ah ticket add` caps the body by its encoded size, so a large multi-byte body is refused with a
  clear message instead of being reported as "receiver is down".

### Internal

- A shared tracker conformance suite runs every tracker adapter against one contract
  (`test/conformance/`), and an end-to-end test drives a real receiver, the local tracker and a
  stub agent through the whole pipeline on every PR.

## [0.7.0] — 2026-10-18

### Added

- **Agent adapters** — a step can run a coding agent other than Claude Code. Set `agent` per step
  (profile default `claude`); `bin` and `env` keep working for any adapter. Four adapters ship:
  - **`claude`** (default): unchanged behaviour; the reference adapter.
  - **`cursor`**: Cursor's `agent` CLI. Tokens are reported at the end of a run; no dollar cost.
  - **`hermes`** (experimental): Nous Research's Hermes Agent, with its own options (below).
  - **`opencode`**: OpenCode, any provider and model (`provider/model`), including local Ollama
    models. `effort` maps to its `--variant`; `resume` uses `opencode -s <id>`.
  `ah agents` lists the running agent processes; `ah doctor` checks each step's agent binary.
  See `docs/agents.md`.
- **Hermes step options** — `provider` (a step key or the root `agentProvider`) becomes `--provider`;
  `effort` becomes `--reasoning`; `maxMinutes` becomes `--run-budget`.
- **Hermes isolated mode** (default on) — each profile gets its own `HERMES_HOME` under its state
  directory, with only your `config.yaml` copied in. Runs use `--ignore-rules --source tool -t
  terminal,file`, so tickets never share memory, skills or sessions with each other or with your own
  Hermes. Isolated runs have no credentials: a cloud provider fails before spawning, with a clear
  message. Set `isolated: false` on a step to keep the old behaviour.
- **Hermes token capture** — after a run, the real token counts are read from
  `hermes sessions export` (time-limited, best-effort). Hermes runs remain unpriced.
- **Estimated cost** — every run with known tokens gets an API-equivalent estimate from a rate
  table (`pricing` config to extend or override). Estimates are labelled `est.` and kept apart from
  reported cost in Stats, `ah usage`, `ah ls`, `ah status` and the UI. Runs with no matching rate get
  no estimate, never $0.
- **Local energy** — steps with `energy: true` record the electricity their runs use (kWh and USD),
  from an hwmon sensor, a shell command, or a fixed wattage. Overlapping runs split the reading by
  time. The figure appears beside the cost or estimate and is never added to it. See
  `docs/local-models.md`.
- **Claude quota readout** — `ah status`, MCP `status`/`tick` and the UI show the 5-hour and weekly
  Claude subscription windows, persisted so they show with the receiver down.
- **Quota pacing** (opt-in) — set `quota.pauseAboveSevenDay` / `quota.pauseAboveFiveHour` to pause new
  runs at a threshold and resume at the window's reset. Running agents always finish; your own
  `pause`/`resume` wins.
- **Config editor** — Integrations, Repos, Tracker, Forge and Ingress tabs, nested step editors,
  a confirm modal, and revert.

### Changed

- **Hermes steps are isolated by default.** Existing Hermes steps now run in their own home with the
  three-toolset set above. To keep the old shared `~/.hermes` behaviour, set `isolated: false` on the
  step. A Hermes step on a cloud provider now fails fast in isolated mode.
- **`requireVerdict` defaults to `true` for Hermes** (text-only output): silence holds the ticket.
- Run and usage records carry new fields — `estUsd`, `costBasis` and, for energy steps, `energyKwh`,
  `energyUsd`, `energySource`. `costUsd` still means "reported by the agent" and is still Claude-only;
  nothing is summed across the reported and estimated fields.
- Local-model and other unpriced runs are tagged `unpriced` (and kept out of reported spend).
- The quota pacer's operator `resume` overrides only the window that tripped.
- `ui/dist` is not in git — after pulling, run `npm run build:ui` (and restart `ah ui`).

### Fixed

- Sink events are delivered in emit order with a bounded backlog.
- `ah doctor`'s port check no longer flags this profile's own receiver.
- Config layout: no sideways page scroll at narrow widths, a stable banner, and card errors shown
  where they belong.
- The UI header keeps its reading order between 900 and 1023 px.
- Finished runs from a timed-out or failed usage export no longer log twice or affect the verdict.

### Known limits

- Energy measurement is gross draw and GPU-only on hwmon; CPU and the rest of the system are not
  counted. The `command` source is the escape hatch for other GPUs.
- Estimates are API-equivalent shadow prices, not your bill. Subscription plans show them by default.
- Quota readings are Claude-only; Cursor, OpenCode and Hermes expose no quota.
- Hermes isolated mode carries no credentials: cloud providers need `isolated: false` (which shares
  your Hermes home) until a later opt-in credential key exists.
- Hermes is experimental. Its token counts come from a post-run export, and its tool surface is
  limited to `terminal,file` by default.

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
- Tests (`node:test`) + GitHub Actions CI (typecheck + tests + syntax check on Node 20 & 22).

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
- Docs: architecture, providers, sandbox.

### Security

- `fullAuto` (which adds `--dangerously-skip-permissions`) ships **off by default**; the server
  prints a loud warning at every boot while it's on.
- Webhook signatures verified with constant-time HMAC; handshake secrets stored `0600`.
- See [SECURITY.md](SECURITY.md) for the threat model and disclosure process.

[Unreleased]: https://github.com/Jesuso/agenthook/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/Jesuso/agenthook/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/Jesuso/agenthook/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Jesuso/agenthook/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Jesuso/agenthook/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Jesuso/agenthook/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Jesuso/agenthook/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Jesuso/agenthook/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Jesuso/agenthook/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Jesuso/agenthook/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/Jesuso/agenthook/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Jesuso/agenthook/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Jesuso/agenthook/releases/tag/v0.1.0
