# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- UI: cost leaves the glance level (PRODUCT.md: "No model, harness, context or cost" on Home and
  Overview). The Home card no longer shows "cost today" (agents / queued are unchanged, and a down
  card with spend renders no stats row at all), the Overview's Progress zone is gone — one quiet
  "N done today" line sits by the page headline, with a muted "yesterday N" when either count is
  non-zero — and the digest meta line no longer names what the digest run cost. The figures move to
  the Statistics page, which gains a small **Today** card (cost today vs yesterday, and the 48 h
  rework rate with its "needs 10+ runs" state) and the History strip, previously under the Progress
  tiles; the ticket drawer's cost is untouched (#786).
- Docs: local models — the OpenCode example config sets `"interleaved": {"field": "reasoning"}` so a
  reasoning model sees its earlier thinking on later turns; the measured effect and the
  context/compaction trade-off are documented (#784).
- ui: in the Epics list, an **open** epic with no tickets now shows the muted "no tickets" text
  (like a closed empty epic already did) instead of an empty progress bar and "0/0"; the row's
  note column stays aligned and the link still names its state for screen readers (#776).
- UI: Home cards hide the agents / queued stats row while the receiver is down (as the profile
  Overview already does) — no more `— / —` dashes repeating the stopped status; the cost stat is
  unchanged, and a down card with no cost renders no empty stats row at all (#777).
- ui: the Statistics "Done per day" heatmap caption now reads "stronger colour = more tickets"
  (es: "color más intenso = más tickets") instead of "darker = more tickets", which was only true in
  the light theme — in dark theme busy days are brighter, not darker (#775).
- UI: Config step cards — the expand/collapse button is named per step ("expand step: triage" /
  "collapse step: triage") instead of a bare "expand step", and the "+N advanced" count is its own
  non-truncating element beside the header summary, so it is never the part that gets cut off (#758).
- `restart`: a refusal now reaches the CLI, MCP and UI with its reason (bounded) instead of the
  opaque `restart failed`. A config-check failure is worded as a check that ran in the **running**
  receiver — whose in-memory code may be older than the code on disk — and names the escape, `agenthook
  stop && agenthook start` (#767).
- UI: the open ticket drawer now lives in the URL as `?t=<ref>` — a ticket is bookmarkable,
  survives a reload, and Back/× close it without losing the view; a cold load with an unknown
  `?t=` quietly drops it (#766).
- UI: segmented controls (the stats ranges, the tickets status filter, view switches) are now one
  Tab stop instead of one per option; Arrow keys (wrapping), Home and End move the selection, and
  the range and status-filter groups carry an accessible name (#765).
- UI: on a profile's Overview the All tickets table drops the redundant profile column (the
  `lockProfile` doc now matches the behaviour), and the ticket title cell shrinks to the table's
  free width and truncates inside it, so no horizontal scroll appears at laptop widths (#759, #770).
- UI: the Config pipeline graph now scales down to fit its pane (to 11/12 of full size, keeping
  step names at or above 11px); panes narrower than that scroll as before (#756).
- UI: the Harnesses table moved from Overview to the Statistics page (#754).
- UI: Activity lines drop the profile name; the heading shows the count or 'N new', not both (#764).
- UI: the browser tab title now names the Stats, Instructions and Config views and the profile, like Epics already did (#757).

**Upgrading from 0.15** — nothing to migrate, three behaviours to know about:

- A `pause`, and a per-harness slot limit set at runtime, now **survive a restart**. Before, a
  restart cleared them. `agenthook status` and `doctor` show them; `agenthook unpause` and
  `agenthook concurrency` undo them.
- With `harnesses` configured, quota pacing closes **only the harnesses that share the exhausted
  subscription**, until it resets. Before, it paused the whole receiver. A profile without
  `harnesses` behaves as before.
- A harness that is the only harness of some step keeps one slot back from steps that list it as
  one option among several. `doctor` prints the effective reserve; `harnesses.<name>.reserve: 0`
  turns it off.

Remote harnesses (`harnesses.<name>.remote`) are **experimental**: tested against a simulated ssh,
not yet against a real worker.

### Added

- A `pi` agent adapter (`agent: "pi"`, #752): spawns `pi -p --mode json --offline [--model
  provider/id] [--thinking <level>] -- <prompt>`, parses its JSONL stdout into a live token tally
  (per-turn, summed), a usage record (`unpriced` unless pi reports a non-zero cost) and the run log,
  and records turns, per-turn context and `compactions`. Pi's print mode has no permission prompt
  and takes no allow/deny policy, so a pi step must run **sandboxed** (a step setting an
  `allow`/`deny` is refused rather than run unrestricted). Set `piConfigDir` (step or harness; the
  step's own wins) to a host dir holding pi's `models.json`/`settings.json` (each optional), copied
  — never mounted — into the per-run sandbox HOME's `.pi/agent`. A sandboxed run gets its unattended
  contract (and, ≤ 16 KB, its standing instructions) as `.pi/agent/agenthook-*.md` files passed with
  `--append-system-prompt`, which survive compaction (verified on pi 1.5.2 across four compactions);
  the sandbox hook's new `args` return field carries those flags before the argv's `--` separator.
  The model-API egress allowlist picks up the `host:port` of each `providers.*.baseUrl` in
  `piConfigDir`'s `models.json`. `ah doctor` reports the pi version (`pi --version`) for a pi step
  whose bin is on PATH, or an install hint when it isn't. The agent image installs
  `@earendil-works/pi-coding-agent` (default `1.5.2`). Pi has no remote harness and its session state
  lives in the per-run HOME, so a sandboxed run can't be resumed (it still lists in `ah resume` from
  `usage.jsonl`). See [docs/agents.md](docs/agents.md#agents-claude-cursor-hermes-opencode-pi) and
  [docs/sandbox.md](docs/sandbox.md#pi-in-the-sandbox).

- A remote harness (`harnesses.<name>.remote`) can now run `opencode` on the worker, not just
  `claude` (#739). It gets the same unattended contract and standing-instructions files a
  sandboxed local OpenCode run gets, plus any `opencodeConfig`, written into a per-run directory
  on the worker and pointed at by `OPENCODE_CONFIG` — which OpenCode merges on top of the worker's
  own global config, so its login, session database and model endpoint (incl. a local model
  server on the worker's own loopback) stay the worker's own. The prompt still never touches
  argv on either side of the connection; the agent's own stdin and a strict, named env allowlist
  carry it and the three OpenCode-specific keys instead. `remote.bin` now defaults to the resolved
  agent's own binary (`claude` or `opencode`), not a hard-coded `"claude"`. `agenthook doctor`
  probes the harness's actual resolved agent bin, with an OpenCode-specific install hint, and
  skips the claude-only credential probe for an opencode harness. See
  [docs/remote.md](docs/remote.md#opencode-on-the-worker).

- Harness routing now reserves a slot on an exclusive harness — one a step lists as its *only*
  harness — against a spill from another step that lists it as one option among several (#745).
  A harness some other step names as an alternative gets an automatic reserve of 1 (override with
  `harnesses.<name>.reserve`, an integer ≥ 0; `0` keeps the order rule but turns the slot-count
  reserve off). A down/quota-closed or 0-capped alternative never counts, so a step whose other
  harnesses are all unusable may still fill every slot on the exclusive one, first come first
  served. Whatever the reserve, a startable job with no open alternative is always preferred over
  one that has, so a spiller never jumps a job that can only use that harness. Surfaced in `ah
  tick`/`agenthook status` (`why`/"waiting on a reserve") and `ah doctor` (the effective reserve
  per exclusive harness). `src/pull.js`'s queue-stage puller budget subtracts the reserve too.

- Web UI: the board moves only when something happens (#699). A ticket that changes step slides
  its mark to the new column; a row that turns up fades in; a row that starts needing you is washed
  once (on your return, if the tab was in the background). Sections, tabs, step cards and the ticket
  drawer answer a click with a short fade. Nothing loops, nothing plays on page load, and reduced
  motion removes all travel.

- A step that lists several `harness`es can now set `model` and `effort` per entry, not just once
  for the whole list (#736): a `harness` list element may be `{ "name": …, "model": …, "effort": … }`
  instead of a bare name, and its `model`/`effort` pin runs routed to that harness alone — they win
  over the step's own `model`/`effort`, the harness's, `escalate` and `lite`. `harnesses.<name>` also
  gains an `effort` default (a step's own effort beats it). Resolution order, per `model` and
  `effort` independently, is now entry > escalate > lite > step > harness. The web UI keeps an
  object entry intact (showing its pin read-only), and `ah doctor` warns when a step-level `model`
  is broadcast to two or more list entries that lack their own entry `model`.

- `agenthook reload` (and the `reload` control op / MCP tool) re-reads and validates the config,
  then applies its reloadable keys — `maxConcurrent`, `quota`, `sandbox.egress`, harnesses (add/
  remove/rename/any field except `remote`), and per-step spawn knobs (`harness`, `routing`,
  `model`, `effort`, `escalate`, `lite`, `instructionsFile`, `egress`, `maxConcurrent`) — to runs
  that **start after** the reload, with no restart (#725). Running agents keep the config they
  started with (the shared `cfg` keys are replaced, never mutated). The new config must be valid,
  must not change a restart-required key (adding/removing/reordering steps, `name`/`stateId`/
  `tracker`/`repos`, `remote`, adding or removing the `sandbox` or `harnesses` block — the error
  names every such key), and any newly-gained run image is verified via a sandbox check before
  anything is applied. Active operator overrides still win after a reload; a harness override for
  a removed harness is dropped. Emits a `config_reloaded` event; `.env` is not re-read (use
  `restart` for that).

- `ah doctor` now flags a sandboxed opencode step whose effective model is missing the
  `variants` entry its `effort` needs (#731) — without one, OpenCode's `--variant <effort>` has
  nothing to resolve and sends no reasoning effort at all. [docs/local-models.md](docs/local-models.md)
  documents the required `variants` shape and how to turn off tools an unattended opencode run
  can't use via a `permission` block in `opencodeConfig`.

- A profile with `harnesses`: a running pipeline job on a step that names no `harness` now shows
  up (#726). It's counted under an implicit entry named after the agent CLI it spawns (`claude`,
  `cursor`, `hermes`, `opencode`), separate from `harnesses` so the puller budget, breaker,
  `set_concurrency`/`harness_reset` and `doctor` never see a fake harness. `tick`'s JSON carries
  `slots.unharnessed` ({[agent]: count}) and its digest/`status` print a line for it; the web UI's
  harness chip row shows a dashed, uncapped chip per implicit entry alongside the configured ones.
  A profile without harnesses, or whose runs are all harnessed, is unchanged.

- Quota pacing now closes only the harnesses that share an exhausted Claude subscription, instead
  of the whole receiver (#723). On a profile with `harnesses`, a reading at/above a `quota`
  threshold closes the run's subscription group (every `claude` harness with no own
  `ANTHROPIC_BASE_URL`/credential env, plus the unharnessed `claude` steps) until the window's
  `resetsAt`, reopening on its own via a one-shot timer; other harnesses keep starting runs.
  Profiles without `harnesses` keep today's receiver-wide pause unchanged. A `cause:"quota"`
  breaker entry persists across restarts, never adds strikes and never probes; `harness_down`/
  `harness_up` carry `cause`, and `status`/`tick`/`doctor`/the web UI show the harness as closed
  for quota with its reopen time (and stop counting it as Needs you). `harness_reset` on a
  quota-closed harness suppresses re-closing until that window resets.

- A step's optional `gate` (#710): a command the receiver runs, in the run's own executor, right
  after an `advance` (agent-written, repaired, or deduced) and before the move — it can only veto
  that advance, never grant one. A non-zero exit or timeout gets the agent one more turn carrying
  the gate's output (a resume when possible), up to the step's `maxAttempts`, then holds with the
  output tail in the reason. Catches the case where an agent's "typecheck green" doesn't match
  what the repo's own checks say, before a whole review run is spent on code that doesn't compile.
  See `gate`/`gateTimeoutMinutes` in [getting-started.md](docs/getting-started.md) and the new
  `gate_pass`/`gate_fail` events. The ssh executor gained an opt-in `raw` launch mode so a remote
  step's gate runs on the worker, never the hub.
- Operator runtime overrides — the global `pause`, global `set_concurrency {max}`, and per-harness
  `set_concurrency {harness, max}` (and `pause {harness}` drain) — now persist in `overrides.json`
  and are re-applied at boot, so a restart no longer silently drops a pause or a drained harness
  (#724). Reset spelling is `set_concurrency {reset: true}` (with `harness` for one harness);
  `pause`/`resume` take an optional `harness`, and a value equal to the config value clears the
  entry. The heartbeat carries an `overrides` field (`{paused, maxConcurrent: {value, config},
  harnesses: {…}}`) that `tick`/`status`/`doctor` render next to the configured value. New CLI
  commands `agenthook pause` / `unpause` / `concurrency <n|reset> [--harness <name>]`.

- A ratchet test (`test/any-ratchet.test.js`, baseline `test/any-baseline.json`) fails `npm test`
  if explicit `any` tokens (JSDoc in `src/`, TS in `ui/src/`) grow past the committed baseline;
  `test/**` now has its own `tsconfig.test.json` and `npm run typecheck:test`, run non-blocking in
  CI for now (1300+ pre-existing errors) (#711).

- Sandboxed opencode runs (`oc-local`-style small-window harnesses) now carry an unattended
  contract as a config `instructions` file, so it survives a context compaction (#712).
  OpenCode's own post-compaction continuation message ("stop and ask for clarification…") is
  hardcoded and unconfigurable; a small model reading it after losing context could end an
  unattended run on a question. Host and ssh opencode runs, and the claude adapter, are
  unchanged.

- Sandboxed opencode runs also receive the step's standing instructions (repo `instructionsFile`
  + step `instructionsFile` text) as a second `instructions` file
  (`agenthook-standing.md`), so they survive a context compaction alongside the unattended
  contract (#716). The standing text is kept in the run prompt too (so it is sent twice: once
  as part of the system prompt via `instructions`, once as part of the one-shot run prompt). A
  `console.warn` is emitted (run log) when the standing text exceeds 16 KB and is not written
  to a file. The ticket text is not included in the standing file.

- **Experimental** remote harness, code transport (#690): before every ssh-executor run, the
  hub now syncs the ticket's code to the worker over git+SSH (no forge) instead of running in a
  fixed `remote.workDir` — the hub worktree stays the only real copy. A worktree step force-pushes
  the hub's branch to a per-repo bare repo on the worker (`<workDir>/.agenthook/<name>/repos/
  <repo>.git`) and adds a deterministic per-ref worktree there; a no-worktree step (e.g. triage)
  streams a tracked-only `git archive HEAD` into a per-ref export dir instead, so a gitignored/
  untracked file, `.env` or the profile config never travel. After every run — even a timeout,
  cancel, or crash — any worker commits are fetched back and fast-forwarded (`--ff-only`) into the
  hub worktree; a worker branch whose history no longer descends from what was pushed fails the
  run rather than overwriting anything (`SandboxReport.failed`, mapped onto the run's `refused`).
  A dirty hub worktree, or one with a `.gitmodules`/`filter=lfs` tree (submodules/LFS aren't
  supported on a remote harness yet), refuses the run before anything spawns. Every hub-side git
  call this adds is `HOST_GIT_SAFE`-hardened (`src/worktree.js` `hostGitSafe`, now also true for
  any profile with a remote harness, not just a sandboxed one) and the push/fetch travel over a
  `GIT_SSH_COMMAND` built from the harness's own host/port/identity/user, never `-A`. `reap()`
  additionally clears leftover synced worktrees/exports and prunes the bare repos. See
  [docs/local-models.md](docs/local-models.md#remote-worker-experimental-689) and
  [docs/internals/dispatch.md](docs/internals/dispatch.md#the-ssh-executor-srcdispatchexecutor-sshjs-689-launchkillenv-690-code-transport).
- **Experimental** remote harness, doctor + status/tick + docs (#691, phase 2, ticket 3 of 3 of
  #681): `agenthook doctor` now knows remote harnesses exist. It probes each `harnesses.<name>.
  remote`'s worker over ssh (using the same connection options the `ssh` executor itself builds,
  not a copy of the command) for reachability, `git`, the agent bin (+ its `--version`), a
  writable `workDir`, and — warning, not failing, and never printing a value — whether a
  credential source (`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`CLAUDE_CODE_OAUTH_TOKEN`, the
  credentials file, or `apiKeyHelper`) is visible there. An unreachable worker reports one ✗ and
  skips the rest of that harness's probes. The existing host-side bin checks now skip a remote
  harness's own `bin` (it runs on the worker, not the host) and a step routed only through remote
  harness(es). A running remote run's `running.json` record, `tick`'s `running[]`, and the
  `status` op now carry the worker's `host`; the `tick` text digest reads `· <harness>@<host>`
  instead of `· <harness>`, and `status` prints a `remote` line per in-flight remote run. New
  [docs/remote.md](docs/remote.md): the trust model, worker setup, what never crosses, and
  current limits, linked from `README.md`, `docs/local-models.md` and the portable skill's
  `setup.md`.
- Web UI: the profile Overview is now a board and uses the whole window (#696, #697, #746). One
  row per ticket with the pipeline's steps as columns: each row is drawn up to the step its ticket
  is in, with a mark for running, waiting, held or failed. The tickets that need you come first,
  with their action on the row. What finished today is one count, opened on request. The catch-up
  digest, progress figures and activity sit beside the board on a wide window and below it on a
  narrow one. Stats, Epics, Instructions and Config use the whole window too.
- A "New ticket" action on the web UI's profile overview for local-board profiles (#698): a button
  (and the `n` key) opens a dialog with a title, an optional markdown body, the starting step
  (defaulting to the pipeline's first non-manual step), and optional comma-separated blockers. It
  creates the ticket by calling the running receiver's `ticket_add` op over the control socket
  (`POST /api/ticket`, same guards as the other control actions) — the UI still never loads a config
  or writes the board. The button is hidden on non-local profiles and disabled while the receiver is
  down (a 503 reads "start the receiver to add tickets"); a server refusal (e.g. a bad step) is shown
  inline in the dialog. A stopped local board still reads as `tracker: "local"` because the profile
  marker now carries the tracker's `provider`, and an up local board's overview advertises its
  ticketable steps via the heartbeat's `ticketSteps`.
- Home now ranks cards by what the operator can act on now (#694): died profiles (crashed or
  killed rather than stopped) first, then up profiles, then stopped profiles with something still
  pending — a stopped profile's stale Needs-you count no longer outranks a live one or renders as
  a live red/amber alert; it shows muted with an "as of \<age\>" label instead. A fatal exit
  (`onFatal`) now leaves its pidfile in place (it used to delete it alongside the clean-shutdown
  path), so a crash is told apart from a deliberate `agenthook stop`: the new `ProfileView.died`
  flag drives a "stopped unexpectedly" pill and a failed-tone card border.
- **Experimental** remote harness, phase 2 (#689): a harness can set `remote: {host, user?,
  port?, identityFile?, workDir, bin?}` to run its agent over ssh on another machine instead of
  the host or the profile's sandbox, via a new `ssh` executor (`src/dispatch/executor-ssh.js`).
  The agent runs in an existing directory on the worker (`workDir`) — code transport/worktrees
  there is a later ticket, so the hub's own worktree/branch bookkeeping is unchanged and nothing
  the remote agent edits is brought back yet. The prompt and a strict env allowlist travel over
  the ssh connection's own stdin, never in argv on either side; a closed connection kills the
  remote agent's process group; boot/shutdown reap sweeps up anything a crashed receiver left
  running on a remote worker. Config validation refuses a step on a remote harness that is
  sandboxed, would get per-run GitHub App credentials, resolves to a non-`claude` agent, or runs
  on a non-`local` tracker — none of these can be lifted yet. See
  [docs/local-models.md](docs/local-models.md#remote-worker-experimental-689) and
  [docs/internals/dispatch.md](docs/internals/dispatch.md#the-ssh-executor-srcdispatchexecutor-sshjs-689-launchkillenv-690-code-transport).
- A down/probing harness now surfaces as an error, not routing noise (#688). A health-breaker
  trip's fast-exit `harness_down.reason` can carry the agent's own last error line after the
  receiver's own "no output" observation (e.g. an auth failure, not just that nothing came out),
  redacted (new `redactSecrets` in `src/agent-env.js`: secret-shaped env values and common token
  shapes become `***`) and bounded to ~300 chars. The web UI's Needs-you zone now lists every
  down/probing harness of an up profile above the ticket rows — name, state, reason, until, and the
  hint "Fix the cause, then run `harness_reset <name>`" — counted in the headline, the all-clear
  check, the page title and the Home card's needs-you figure; it disappears on its own once
  `harness_up` fires. A routing spill (a full-but-`up` harness) produces nothing. The slot chips
  tint the same way. `tick`'s text digest appends the `harness_reset` hint to its down/probing line.
- Deduced verdict (#680): on an `implement`/`change` step, a clean exit with no valid verdict is
  often a plain fact — the run added commits to the ticket branch — rather than something only
  another model turn can answer. Before the #677 repair turn runs, the receiver now deduces
  `advance` from the worktree branch's commit count when every gate holds (clean exit, no
  question-hold, a non-manual success target, at least one commit since the run started — a dirty
  tree with no commit doesn't count), skipping the repair spawn entirely. This is where repair
  never helped anyway: hermes has no `resumeArgs`, and a sandboxed opencode run's session is
  already gone by the time a repair would need it. Opt-out per step via the new `deduceVerdict`
  config key (default `true`). `run_end` gains `verdictSource` (`"agent"`\|`"repaired"`\|
  `"deduced"`), also stored on the per-step summary record, so the UI run caption can mark a
  deduced/repaired outcome as the receiver's call rather than the agent's own claim.
- Verdict repair (#677): a clean exit with no valid verdict ("decided, not delivered" — the agent
  said it finished but never wrote the file — or "stopped early") now gets one receiver-driven
  repair turn — the same agent session resumed with a fixed prompt — before holding for a human.
  Opt-in-by-default per step via the new `verdictRepairs` config key (default 1, 0 disables); needs
  the step's agent to support headless resume (claude, cursor, opencode — new `resumeArgs` on each;
  hermes is unchanged) and a captured session id, and is skipped for a sandboxed opencode run (its
  session lives in a per-run sandbox HOME, gone at teardown). Emits `verdict_repair {result, turns}`
  before `run_end`, which then carries `repaired: true|false`; a still-missing verdict's hold reason
  names the attempt (`no valid verdict (after N repair turn(s))`).
- A `branchPrefix` config key (#674), default `agent/`: two profiles pointed at the same repo
  (e.g. a GitHub-tracker profile and a local-board profile) can now give their receiver-made
  branches distinct prefixes instead of colliding on `agent/<ref>`. `agenthook doctor` gains a
  lint that warns when another registered profile shares a repo with the same effective
  `branchPrefix` or the same worktree directory, naming the fix (a distinct `branchPrefix` and/or
  `worktreePrefix`).
- The agent skill gains a first-time setup reference (`skills/agenthook/references/setup.md`):
  prerequisites, `init --local`, `fullAuto` as the user's call, pointing steps at local models
  (Claude Code / OpenCode / Hermes on Ollama) without overrunning the server's parallel slots,
  then `doctor` → `start` → first ticket → `watch`. `SKILL.md` routes to it when no
  `agenthook.config.json` exists yet, and its description now covers setup.
- The source `SKILL.md` is stamped with the package version on every `npm version` (the new
  `version` lifecycle script), so a skill installed straight from git with
  `npx skills add Jesuso/agenthook@vX.Y.Z` carries its release and `agenthook doctor` can flag it
  when it lags the installed CLI. The README documents `npx skills add` as an install path.
- The skill ships `scripts/ensure-cli.sh` for whoever installs the skill before the CLI: it
  reports the `agenthook` on `PATH`, or installs the version the skill is stamped with via npm
  (falling back to `~/.local` when the global prefix is not writable), or says Node ≥ 22 is
  missing. `SKILL.md` and the setup reference point agents at it.
- A live context gauge (#658): a running row now carries `ctx` (the latest turn's live prompt
  size) and `ctxMax` (the model's context window), so `status`/`tick`/the UI can show `ctx
  54K/64K` on a running agent before an imminent compaction/stall happens, or spot a mis-sized
  model/harness for a step. `ctxMax` resolves from a new step/harness `contextTokens` config key,
  else (opencode only) a step's `opencodeConfig` `limit.context`, else a built-in table for the
  Claude family (`src/models.js`); `ctx` is absent on hermes (no structured usage). The UI's Now
  row shows the gauge in red past 90% used.
- Context compactions are now marked and counted per run (#657). The run log renders a compaction
  as a one-line `🗜 compaction (…)` marker — claude from the `compact_boundary` system event
  (`{trigger, pre_tokens, post_tokens?}`); opencode by inferring one from a ≥20% prompt-size drop
  between neighbouring `step_finish` events, since `opencode run --format json` (1.19.5) emits no
  compaction event. The count rides along as `compactions` wherever `turns` (#645) does —
  `usage.jsonl`, the `run_end` event, `runs` rows and `ah stats`' new `cmp` column — absent on
  cursor/hermes. See [docs/usage.md](docs/usage.md#where-records-live).
- Every step prompt now carries an unattended-run notice: it tells the agent no human reads its
  messages or answers questions while the run is on, and that it must decide, act and finish
  rather than ask for confirmation — and, if it genuinely can't proceed, say so in its verdict
  instead of ending on a question (#655).
- A clean exit with no valid verdict whose last output line is a question now holds with a
  specific reason instead of the generic `"no valid verdict"`:
  `no verdict: the agent ended by asking a question instead of acting: "<line>"`, quoting the
  question (clipped to 200 chars) so the held `why` and the `blocked`/`verdict_missing` events say
  exactly what the agent wanted to ask. A weak/local model ending its turn on "Want me to go
  ahead?" instead of a verdict is now diagnosable from the hold alone (#655).
  See [docs/local-models.md](docs/local-models.md).
- OpenCode now runs inside the per-run sandbox (#647). The agent image installs `opencode-ai`
  alongside `claude` — an existing `agenthook-agent:<version>` image predates this; remove it and
  run `agenthook doctor --fix` to rebuild. A new `opencodeConfig` key (on a step or a harness; the
  step's own wins) names a host path to an OpenCode JSON config, copied — never mounted — into
  that run's per-run sandbox HOME, so a local-model provider can be configured there.
  `agenthook doctor` lints a configured provider's `baseURL` for a loopback or unallowed-private
  LAN address, same as a harness's `ANTHROPIC_BASE_URL`. `cursor` and `hermes` are still refused
  sandboxed. See [docs/sandbox.md#opencode-in-the-sandbox](docs/sandbox.md#opencode-in-the-sandbox).
- Per-run turn metrics (#645): `usage.jsonl` records, the `run_end` event and `runs` rows
  (`ah agent-api`/MCP) now carry `turns`, `firstContext`, `peakContext` and `lastContext` — how
  many model turns a run took and how its context grew — for agents whose parser sees per-turn
  usage (claude, opencode today; absent on cursor/hermes). An enabler for comparing a local-model
  harness against a cloud one. See [docs/usage.md](docs/usage.md#where-records-live).
- Harness breaker: trip on a connection-level model-API failure, not only a fast exit (#639). A
  no-output, non-zero exit now also trips the breaker at **any** wall time — not just inside
  `downGraceSeconds` — when the run's output reports a connection-level model-API failure
  (`ECONNREFUSED`/`ENOTFOUND`/`EHOSTUNREACH`/`ETIMEDOUT`/`ECONNRESET`, an `agenthook egress: …
  failed`/`cannot resolve` line, or `API Error: 502/503/504`); any 4xx `API Error` never trips. A
  sandboxed run prefers the egress proxy's own `upstream-failures.jsonl` record (new, alongside
  `denied.jsonl`) for the step's `ANTHROPIC_BASE_URL` host. `downGraceSeconds` still only governs
  the original fast-exit signal. See
  [docs/local-models.md](docs/local-models.md#when-a-harness-fails) and
  [docs/sandbox.md](docs/sandbox.md#egress).
- `ah ui --host <ip>` binds the dashboard to another address (`0.0.0.0` / `::` = every interface) so a browser on a trusted LAN can use it; default stays `127.0.0.1`. The Host guard then accepts the bound address (any of the machine's own interface addresses for `0.0.0.0`), never a DNS name; the launch token stays the only credential and the CLI warns on a non-loopback bind.
- Named harnesses with slot pools (#619). A top-level `harnesses` record declares agent backends
  (`agent`, `model`, `bin`, `env`, `provider`, `toolsets`, `sandbox.image`), each with its own
  `maxConcurrent`. A step names one or a list with `harness`, and `routing` (`first-free`, the
  default, or `round-robin`) picks a harness with a free slot when the job starts; with all of them
  full the job waits without blocking unrelated work. The step's own knobs win, `env` merges.
  `tick`/`status` show `slots.harnesses`; `run_start`/`run_end` carry `harness`; the
  queue-stage pull only pulls into harness room. A profile without `harnesses` is unchanged. See
  [docs/local-models.md](docs/local-models.md#several-backends-harnesses).
- Per-harness usage, live caps and a UI editor (#620). A harness run's usage record carries
  `harness`; MCP `status`/`tick --json` add `harnessUsage` (runs and tokens per harness), CLI
  `status` prints a `harness :` line per harness, `runs` rows carry `model` and `harness`, and the
  digest snapshot adds `last24h.harnesses`. MCP `set_concurrency {max, harness}` changes one
  harness's slot cap at runtime. The web UI edits `harnesses` (add, rename and remove keep the steps'
  references valid) and a step's `harness`/`routing`, and the Overview shows an `active/max` chip
  per harness. A profile without `harnesses` gets none of these keys.
- Harness health breaker (#621). A run on a harness whose backend looks down (the agent's preflight
  refused, the spawn failed, or a fast non-zero exit with no model output inside
  `harnesses.<name>.downGraceSeconds`, default 30) marks that harness down for
  `cooldownMinutes` (default 10, doubled per repeat strike up to 60) and emits `harness_down`. The
  run goes back to the front of the queue (`run_end` `outcome: "requeued"`, while under
  `maxAttempts`) and the queue routes around the harness; after the cooldown one probe run decides,
  and a healthy one emits `harness_up`. All harnesses of a step down → its jobs wait, never fail.
  `slots.harnesses[name]` gains `state`/`until`/`reason`, `tick` prints a line per down harness,
  the state persists in `harness-health.json`, and the `harness_reset {harness}` op clears it. See
  [docs/local-models.md](docs/local-models.md#when-a-harness-fails).
- `doctor` checks named harnesses (#632): a harness's own `bin` (or an `agent` other than the
  profile's) must resolve on PATH; a sandboxed harness's or step's `ANTHROPIC_BASE_URL` naming a
  loopback address warns it's unreachable from inside the container, and one naming any other
  private address needs a matching `host:port!private` rule in the effective egress allowlist;
  and each harness's slot count is reported, with a warning when a step's harnesses all cap to 0.
  A profile without `harnesses` gets none of these lines.
- Harness on `tick`/`status` running rows (#630). A live run on a named harness carries `harness`
  in its `running[]` row (from `running.json`; the key is omitted when the run has none), and the
  `tick` text digest appends `· <harness>` to the RUN line. Profiles without harnesses are
  unchanged.
- `set_concurrency {harness, max: 0}` drains a harness at runtime (#640). Setting a named
  harness's slot cap to `0` stops new starts on it while running agents finish — the way to keep
  runs off a dead backend before the health breaker trips or restarts the receiver — and
  `tick`/`status` show `max: 0`; `set_concurrency {harness, max: n}` with `n > 0` re-enables it.
  `0` is allowed only for a named harness: the global cap keeps its `1..64` range. The UI editor
  is unchanged.
- The skill's setup reference now has the agent ask which agent CLI to use, not only which model:
  it lists the installed ones and asks harness, model and (for a local model) context window and
  the server's parallel slots in one message, proposing a pairing only when one is known to work
  on that machine. It says where each key goes (`agent` top-level; `model`, `contextTokens`,
  `provider`, `env` per step) and that OpenCode resolves the provider from its own config.

### Security

- The remote-harness sync-back `git fetch` (#691, from #701 review) now passes `--no-tags`: a
  worker could otherwise plant a tag pointing into the commits it fetches back — git's default
  auto-follow would pull it straight into the hub repo. The commits themselves still fast-forward
  exactly as before; only tag auto-follow is turned off.

### Internal

- The executor axis (#682, remote-harness epic #681 phase 1): which launcher a run uses (host or
  the profile's sandbox) is now picked per run, after the harness resolves, via a new
  `src/dispatch/executor.js` instead of naming the sandbox directly in spawn/kill/timeout/boot
  reap/shutdown. No behaviour change.

### Fixed

- UI: the ticket drawer shows the title on its own line (up to two lines, `line-clamp-2`), and the
  close button stays at the top right instead of wrapping with the header facts when the model name
  is long (#755).
- `ah ui --host <addr>` now prints and opens the bound address, not a dead `127.0.0.1` link (#737).
  A wildcard bind (`0.0.0.0`/`::`) prints the loopback link plus one "reachable on every interface"
  line (listing the non-internal addresses) instead of one URL per interface.
- `ah agents` now lists every running run, not only `claude -p` processes (#735). It read `ps`
  and kept only lines whose command started with a known agent binary, so a sandboxed or remote
  (ssh) run — whose local process is a container runtime or `ssh` client — never matched, and
  `--all` only knew the binaries the discovered config named. Rows now come from each profile's
  `running.json` (the state `tick` and the web UI read, written for every run whatever the agent
  or executor), with `harness`/`model` columns, a `stale` marker for a leftover whose pid is
  dead (excluded from the running count, `stale: true` in `--json`), and elapsed time derived
  from `startedAt`.

- A sandboxed opencode run no longer sends the step's standing instructions twice (#731): once
  in the run prompt, once more as the `agenthook-standing.md` instructions file added in #716.
  When that file is written, the run prompt now carries only the `=== TICKET ===` marker and the
  ticket text; the UI's "what the agent sees" sidecar still shows the full form. A run whose
  standing text is over 16 KB (no file written) is unaffected.

- Ticket drawer: with `routing: first-free` across several harnesses, the run caption named
  neither harness nor model, and the header's model/context always showed the *live* run's
  figures whatever run was selected below — so a past held local-model run could read as
  "sonnet 5 · 105K/1M". `listRuns` now falls back from `run_end` to the matching `run_start` for a
  run's model/harness (a running run, or one whose `run_end` carries no model, still shows what it
  started with); the run caption shows them; the header follows the *selected* run (model hidden
  when unknown, context only while the selected run is the live one) and its cost is now labelled
  "total" since it's the ticket's summed cost, not the selected run's own. A held/failed reason is
  now prefixed with the harness that produced it (`on <harness>: `), only for a step with 2+ named
  harnesses (`held.json`, `blocked`, `failed` gain an optional `harness`). Also: in the drawer's
  Story view, a tool/compaction/error line right after a markdown list no longer gets absorbed into
  the list's last bullet, and the Overview's "created but blocked" notice no longer survives a
  profile switch.
- The live context gauge's window table was stale: every Claude model was listed at 200,000
  tokens, so a run past 200K (current models run in a 1M window) read as a false over-limit. The
  table now holds Anthropic's published default windows (no beta header,
  https://platform.claude.com/docs/en/about-claude/models/overview): 1,000,000 for every current
  model — fable/mythos 5-1 and 5, opus 5-5/5/4-8/4-7/4-6, sonnet 5-5/5/4-6, haiku 5-5 and the
  `opus`/`sonnet`/`haiku`/`fable` aliases — and 200,000 for Claude Haiku 4.5. When the observed
  `ctx` exceeds `ctxMax` (proving the table or an explicit `contextTokens` wrong for that model),
  `status`/`tick` rows omit `ctxMax`, the `tick` digest prints the bare `· ctx 212K` instead of
  `212K/200K`, and dispatch logs one warning per run naming the model and both figures.
- `restart` keeps stale `.env` values (#684): every detached respawn (`restart`, and the
  `start --detach` hop it goes through) inherited the parent's whole environment, and `.env`
  loading never overwrites an already-set var — so an edited `.env` value was never re-read
  until a full `stop` + `start`. `loadEnv` now records which keys it actually set from a file,
  and every detached child's env drops those (a shell-exported var is untouched), so the server
  re-reads `.env` itself on every restart. A harness breaker still survives a restart on purpose
  (it is often unrelated, and `probing` self-heals); instead, the `restart` reply (CLI/MCP/UI) now
  lists any harness still down (`harnessesDown`) and points at `harness_reset`. The systemd unit
  path already restarted into a fresh process and needed no change.
- Sandboxed Claude Code runs now honour the operator's attribution preference (#675). A run in a
  per-run sandbox starts with an empty HOME, so `attribution` / `includeCoAuthoredBy` set off in
  `~/.claude/settings.json` were ignored and agent commits carried `Co-authored-by: Claude`. Those
  keys (and nothing else of that file) are now seeded into the sandbox; the new profile key
  `attribution` (`false` = always off, `true` = the agent's default) overrides it.
- A sandboxed run ignored the operator's own Claude commit/PR attribution preference (#675): the
  per-run HOME starts empty, so a sandboxed `claude -p` never saw `~/.claude/settings.json` and
  fell back to the CLI default (attribution on), even when the operator had turned it off for
  their own unsandboxed runs. A new `attribution` profile key (claude-only): unset (default)
  seeds just the host's `attribution`/`includeCoAuthoredBy` keys into the sandbox HOME, so a
  sandboxed run now matches what an unsandboxed run already read; `false` forces attribution off
  via `--settings` on both host and sandboxed runs; `true` leaves the CLI's own default alone.

### Changed

- Overview "Now": each running or queued ticket is one line of essentials — id, title, step and its
  clock. The model, context, cost and the agent's sentence moved to the ticket drawer (one click),
  and "Follow log" went (the row already opens it). The context figure is no longer coloured as an
  alarm, and stands alone when it exceeds the listed window (the listed value is then provably wrong).
- `agenthook init` now asks first where the work comes from — a local board (the default, Enter)
  or a tracker. `init --local` and the new `init --remote` skip the question; `--yes` alone means
  the local board; with no terminal and no flag it fails naming both commands instead of hanging.
- `init --remote`'s tracker wizard now asks the tracker first, before the profile/name/repo
  questions, defaulting to whichever tracker already has a token set in the environment (shown
  next to its name, e.g. `github  (GITHUB_TOKEN found)`). The token (or GitHub App key) is checked
  right after, before any other question: a missing one no longer loses every answer collected so
  far — it names the variable, says where it looked (shell env or a `.env` beside the config), and
  offers to fall back to a local board instead.
- `init` on a local board, run interactively, now defaults the `fullAuto` question to **yes**
  (only you can add tickets to a local board, and without it the first ticket cannot edit a
  file), offers the agent skill, and offers to start the receiver. Unattended behaviour is
  unchanged: `--yes` never enables `fullAuto`, only `--full-auto` does. The tracker wizard's
  `fullAuto` question still defaults to no.

- `events` text output shows the harness: `run_start`/`run_end` lines print `harness=<name>` right
  after `model=` when the event carries one (absent or null without, so lines of profiles without
  harnesses are unchanged), and `harness_down`/`harness_up` print readably as
  `harness_down <name> reason=… until=…` / `harness_up <name>` (#631).
- `status` shows the breaker state on its harness lines (#638): a harness down for a cooldown
  prints `· down until HH:MMZ (reason)` and a harness in its probe window `· probing` (an `up`
  harness prints exactly as before), and every configured harness gets a line — even with
  `0 runs` — so a down harness is never invisible. Profiles without harnesses are unchanged.
- `docs/local-models.md` gains a worked example of Claude Code on a local Ollama with a cloud
  spill harness, with the measured context overhead, speed, Ollama quirks and firewall notes.
- `docs/local-models.md` gains a "Behind the sandbox" note on reaching a LAN model endpoint from a
  sandboxed run: `ANTHROPIC_BASE_URL` at the host's LAN IP, a `!private` egress rule, and the host
  firewall (`ufw`) that may still drop the Docker bridge traffic (#628).
- `docs/local-models.md` gains an OpenCode variant of the Ollama worked example: a third `oc-local`
  harness on the same Ollama behind a minimal `opencodeConfig`, with the shared-GPU
  `maxConcurrent`/`OLLAMA_NUM_PARALLEL` note (#650).

### Changed

- `agenthook skill install` (and `init`'s skill offer) now installs **one canonical copy** at
  `.agents/skills/agenthook` (or `~/.agents/skills/agenthook` globally) instead of a copy per
  agent, plus a relative symlink for each requested agent that doesn't already read that
  cross-agent dir natively at that scope — today that's Claude Code and Hermes at both scopes,
  plus Cursor and Gemini CLI globally only (their repo-level dir is `.agents/skills`, but their
  user-level dirs are `~/.cursor/skills` / `~/.gemini/skills`, not `~/.agents/skills`); Codex and
  OpenCode read it directly at both scopes, so no dir at all is created for them. Re-installing
  over an old per-agent copy migrates it: a stamped copy at a now-native agent's own dir is
  removed, and one at a linked agent's dir becomes a symlink. A foreign (unstamped) `agenthook`
  dir in a native agent's dir is left untouched either way, and is now reported as `foreign` (it
  used to produce no output line at all) so a leftover foreign copy doesn't silently load twice.
  On win32, where a symlink needs a privilege agenthook may not have, a failed link falls back to
  a real copy instead. `agenthook skill ls` shows the canonical copy's version and each
  link as `-> <canonical>`; `doctor`'s stale-skill warning follows the canonical copy (so its fix
  never turns a link back into a copy) and separately flags a leftover per-agent copy as stale
  (#667).

### Fixed

- `doctor` no longer hides a persisted global pause or `maxConcurrent` override on a profile
  without `harnesses`: the harness slot lints returned early before checking the global overrides,
  so `status`/`tick` showed the override but `doctor` printed nothing.
- A gate-cap hold's reason now keeps the *last* 1000 characters of the gate output tail (test
  totals and tsc errors are usually at the end), not the first.
- `agenthook skill install`'s OpenCode dirs were `.opencode/skill` / `.config/opencode/skill`
  (singular); OpenCode actually reads `skills` (plural). The old singular dirs are now only
  scanned for cleanup of a previously-installed stamped copy (#667).
- UI: a ⋯ menu is no longer clipped by the card it sits in (#661). The menu now renders in a top
  layer, opens upward when there is no room below and shifts to stay inside the viewport; keyboard
  behaviour is unchanged.
- `usage.jsonl` records carry `durationMs` for every agent: dispatch derives it from `startedAt`/`endedAt` when the adapter reports no `duration_ms` (opencode, hermes), so `stats` and the digest's wall-time columns no longer skip those runs (#652).
- `tick`/`status` show `slots.harnesses` (and `capped`) from boot: the heartbeat's queue state is seeded from the queue when the engine starts, not only after the first run.
- Sandbox egress: an operator `!private` rule now replaces the plain rule for the same `host:port`, including the agent's own `ANTHROPIC_BASE_URL` rule. A model served on the LAN behind `ANTHROPIC_BASE_URL` was refused even when allowed with `!private`, because the proxy takes the first matching rule.
- A missing agent binary (`ENOENT` at spawn) no longer crashes the receiver: the run fails with
  `spawn failed: …` (#621).
- GitHub: a ticket sent back from `done` with `run --force` now emits `pipeline_done` when it
  reaches `done` again (its `agent:done` label is dropped on re-entry) (#672).

## [0.15.0] — 2026-11-04

### Added

- Approve with follow-up checks. A step's `advance` verdict can carry `followUp: ["…"]`: criteria
  only verifiable once the change is live. At an allowed risk tier (`forge.autoMerge.tiers`, else
  low/medium; read exactly as auto-merge reads it, so a reviewer cannot re-rate a `tierFrom` ticket)
  it is an ordinary approval (auto-merge runs as usual). The checks are recorded on the ref
  (`followup_pending` event, `status.followUp`, `ah tick`), listed by `agenthook followup [list]`
  and cleared by `agenthook followup done <ref>` (MCP: `followup_done`; `followup_done` event).
  agenthook never sees a deploy: `followup_due` fires when the PR merges (or at approval with no
  `forge`) and is actionable in `watch --actionable`. A higher or missing tier turns the verdict
  into a `hold` naming the checks. The example review instructions describe when to use it.
- `agenthook service install|uninstall|status [name]` (Linux): run a profile's receiver as a
  systemd `--user` service, so it comes back after a crash (`Restart=on-failure`) and at login, or
  at boot once you turn on lingering with `loginctl enable-linger` yourself (printed, never run).
  `install` enables the unit without starting it; `--dry-run` prints it, `--no-enable` only writes
  it, and it replaces a stale unit written for the same config (after `rename --move`). Other
  platforms get an "unsupported" message. A control-socket `restart` under the unit exits 75
  (`RestartForceExitStatus=75`) so systemd restarts it inside the unit, reconcile on boot
  included, instead of a detached respawn that would escape supervision; a refused start (already
  running, port in use) exits 78 and is not retried. `TimeoutStopSec=30min` lets a stop drain the
  running agents. See docs/troubleshooting.md.
- `agenthook watch --actionable`: wake only for events that need a human or supervisor (`blocked`,
  `failed`, `move_refused`, `auto_merge_failed`/`auto_merge_skipped`, a `ci_red` the receiver did not
  re-run or bounce, a `tooLate` `auto_merge_disabled`, a `ci_green` on a PR without auto-merge). The
  rest is folded into a `summary` (counts + refs per event) printed with the next wake or the
  timeout, which also carries the cursor. A receiver that is not running (checked at start and
  every `--liveness` seconds) wakes the watch with a `daemon_down` event instead of a silent timeout.
  With `--follow`, one `{"e":"actionable"}` line per wake. `--wake a,b` / `--quiet a,b` add to /
  drop from the built-in list by event type.
- `pipeline_done` carries `awaitingMerge: true` and `pr` when `forge.autoMerge` is on and the PR
  has not merged yet, so it is not mistaken for a merge.

- Blockers on the local board. `agenthook ticket add … --blocked-by <ref,ref>` writes a `blockedBy`
  list on the item; it rests in its stage until every listed ticket reaches a done stage (a manual
  step's `sourceStatus`), then the last blocker's move pushes its step in-process (an `unblock:` job),
  the same gate Asana and GitHub dependencies give you. The local adapter implements `openBlockers`
  (dispatch's re-check), `listQueued` skips blocked items, `ticket ls` shows `blocked by #n`, and the
  `ticket_add` control op accepts `blockedBy`. Each ref must already be on the board.
- Opt-in auto-merge on review approval (`forge.autoMerge`, GitHub forge). When the review step
  approves a PR with `advance` and its verdict's `summary.tier` is in `autoMerge.tiers`, the receiver
  marks the PR ready (if draft) and enables GitHub auto-merge (`method`: `squash` by default, `merge`
  or `rebase`), so GitHub merges it once the required checks pass — what `gh pr ready` +
  `gh pr merge --auto` did by hand. Never on `hold`/`changes`/`fail`, a missing tier or one outside
  the list; idempotent on re-runs. A refusal (auto-merge not allowed, permissions, network) never
  fails the step: it emits `auto_merge_failed {pr?, tier, reason}` and leaves the PR alone. Success
  emits `auto_merge_enabled {pr, tier, method}`; `prs` rows gain `autoMerge: true` and `ah tick`
  shows `auto-merge`. Off when the block is absent. `autoMerge.step` picks any non-manual approving
  step and `autoMerge.tierFrom` reads the tier from an earlier step's verdict (e.g. merge after QA
  on the review's tier). An approving advance whose tier doesn't qualify emits `auto_merge_skipped`
  instead of staying silent. Only the commit the tier step judged can merge: its PR head is
  recorded when it starts and auto-merge is pinned to it (`expectedHeadOid`); a moved head is a
  skip. Auto-merge comes off again (`auto_merge_disabled`) on any later `changes`/`fail` — verdict,
  red-CI bounce, operator `cancel`, restart recovery — before the task moves (a refused disable
  holds the task instead of reworking), and on a new commit pushed to the PR after approval
  (`pull_request` synchronize webhook). `tooLate: true` flags a PR that had already merged.
  Not combinable with multi-repo `repos` yet. The tier must come from a step after the
  `createsWorktree` step (review, QA, …): config validation refuses a triage tier, or the code step
  judging its own work.

### Fixed

- `agenthook events --event` / `watch --event` accept every event type the receiver writes
  (`move_refused`, `verdict_missing`, `quota_pause`, `restarting`, …); before, a filter on one of
  them was refused as an "unknown event type". A test now keeps the list in step with the emitters.
- A held task no longer stays in `held` / "needs you" after its ticket is completed on the board.
  When the board's done is recorded (the tracker's done webhook, `recheck`, or the merge catch-up in
  `reconcile`), the hold is dropped along with any pipeline job still waiting for it, and a
  `hold_cleared {via:"board_done"}` event is written. Nothing moves on the tracker (before, the only
  way out was `cancel`, which moved the closed ticket to the failure lane), and a running agent is
  left alone. `recheck {ref}` also clears a hold left on a ticket whose done was recorded earlier.

## [0.14.0] — 2026-10-29

### Added

- `agenthook serve` is an alias of `start`, and a mistyped command now suggests the closest one
  (`unknown command "strat" — did you mean \`agenthook start\`?`) (#549).
- Queued rows in the Overview's **Now** zone show how long they have been waiting (`waiting 6m`,
  muted, minute precision on the same per-label clock as elapsed times). The ticket-row contract
  gains `queuedAt`, stamped when the job is accepted into the queue and kept across a restart's
  queue restore (#580).
- Row actions for a ticket stuck in **Needs you** after its board closed or its PR merged (#598). The
  dashboard's ⋯ menu on a PR row offers **Re-check**: it asks the tracker and forge again and records
  only a missed `board_done`/merge (`via: "recheck"`), never writing the tracker. It also offers
  **Close on board** (`mergedOpen`/`openOnDone`: closes the ticket on the tracker), **Dismiss**,
  **Open PR** and **Open ticket**, and the zone header gets **Re-check all**. The same actions exist as
  the `recheck` / `close_on_board` control ops and MCP tools, and as `agenthook recheck <ref>|--all`.
  `reconcile` (and `--reconcile-on-boot`) now re-checks the rows already flagged with a PR reason,
  and nothing else.

### Fixed

- The review step reads the ticket's description and tracker comments for acceptance criteria and
  can post its outcome back on the ticket, instead of grading against the PR body the coding stage
  wrote. It holds when it cannot read the criteria at all (#597).
- A step that reuses the worktree an earlier step created (review after code) now gets the real
  branch name in its prompt instead of `undefined` (#596).
- `agenthook start` on a port claimed by another profile no longer says "stop it" when that profile
  is not running; it names the real cause (another process holds the port) (#548).
- **Dismiss** now clears a PR row's Needs-you reason until the ticket's next run (#598).
- The merge catch-up no longer skips a PR whose ticket was already completed (#598). It queues the
  self-closing merge job, so the merge is recorded, and it records the board's done.

## [0.13.0] — 2026-10-27

### Added

- The Digest agent now writes a short, listen-friendly spoken version in the same run as the
  markdown digest (no second model call): the read-aloud 🔊 on the Digest speaks it instead of the
  full markdown, falling back to the markdown on an older digest that has none (#575).
- Ticket summaries and the Digest in the dashboard's language. The ticket drawer shows the quick
  extract of the description at once, then swaps in a short summary written in the UI language by
  a cheap tool-less `claude -p` (`summaries.model`, default `claude-haiku-5-5`;
  `summaries.maxBudgetUsd`, default $0.10 per run). Summaries are cached per ticket, language and
  description in `<stateDir>/ticket-summaries.json`, so reopening a ticket or switching back to a
  language costs no run, and an edited description is re-summarized. Only a tracked ticket
  assigned to us is summarized (never an epic); a failure silently keeps the extract. The work goes
  through a new `summary` control op behind `POST /api/summary`, never on boot or a timer, with at
  most 2 runs at once outside the agent slots. A `summary_end` event (hidden by default) records
  each run's cost (#573).
- An optional profile `language` (a BCP-47 tag such as `es`): agents write their human-facing
  text (verdict reason, the one plain sentence, tracker comments, held questions) and the Digest in
  that language. Code, commits and PRs are unaffected. Unset keeps today's behaviour (#564).
- A reading panel: the app bar's **Aa** button sets text size, letter-and-word spacing (one
  control, widened together), a shorter line for rendered prose, and a warm background. Settings
  are per browser and prose only (ids, logs, code, editors and diffs are untouched); nothing
  changes until you pick something (#559).
- The dashboard speaks Spanish: the reading panel's new **Language** setting (Auto / English /
  Español) re-renders the app shell, Home, the Overview and the shared components in place and
  sets `<html lang>`. Auto only picks a language whose translation is complete, so until the
  remaining views follow (#562) it stays English and Español is marked "(partial)". The spend,
  energy and quota readouts stay English (they are shared with the CLI). Adding a language is one
  dictionary file; see docs/web-ui.md § Languages (#561).
- The whole dashboard now speaks Spanish: Epics and the epic page, Stats, the Tickets table, the
  ticket drawer (including the run-log viewer's chrome), Config with every form label and help
  line, Instructions, the pipeline graph, and every dialog, empty state and error message. Español
  is complete, so Auto picks it on a Spanish browser and the reading panel no longer marks it
  "(partial)". Spanish wording is neutral Latin American ("costo", "espacios", "centavos"). Config
  labels and help are translated by a UI-side overlay, so `src/config-schema.js` and the CLI stay
  English, and a test fails a new config key until it is translated; another test fails any
  hard-coded English text added to a view (#562).
- Read aloud, in the same panel: with **Read aloud** on (only offered where the browser has
  `speechSynthesis`), a 🔊 button reads the Digest, each Needs you row and the ticket drawer's
  plain lines in the page's language, at a chosen **Speed**. **Read new Needs you** speaks entries
  that arrive after the page loaded, queued behind any speech already playing. Escape stops speech.
  Off by default, no dependency (#560).
- Every agent run now ends with one plain sentence for a human (`summary.plain`): the outcome and,
  on a hold or fail, what you must decide. The dashboard shows it in place of the raw reason on
  Needs you and Now rows and at the top of the ticket drawer (the full reason stays in the tooltip
  and drawer); it also rides on `run_end` as `plain`. A run without one renders as before (#563).
- Answer a held ticket by clicking an option instead of typing: when a hold has 2-4 real answers,
  the agent can offer them (`summary.options`); they show as buttons with a confirm step in the
  Release panel and the ticket drawer. Confirming sends the chosen text through the existing
  `release` op, exactly like a typed answer — no tracker comment, no new adapter method. A held
  ticket without options renders as before (#565).

- An Overview built around **Needs you**: held, failed and PR-ready tickets lead, each with its one
  named action; the receiver's state is shown truthfully (up, reconnecting, down) and the page is
  fully keyboard- and screen-reader-usable (#551).
- **Re-run** a failed ticket from the dashboard: it goes back into its failed step's source stage
  and the webhook fires it again, without reassigning. Also a `retry` control op, `POST /api/retry`
  and a `retry` MCP tool (#552).
- The ticket drawer shows run history as **swimlanes**, one lane per step with a bar per run, its
  hand-offs and sends-back drawn between them, and the log gets a **Story** view (each agent message
  a beat, the report as markdown) beside the raw tail (#554).
- The epic page reads in attention order: Needs you (each ticket's reason and named action:
  Release…, Re-run…, Review PR), then Running, Backlog, Not on the board, and Done folded. A pace
  line in words replaces the sparkline (a stall warning after 5 idle days, an ETA only with its
  basis), and the Epics list leads with what needs you (#555).
- Elapsed times and "N ago" labels tick live: a running ticket's elapsed time counts seconds for
  its first minute, then minutes; each label updates on its own boundary, and while the dashboard
  is disconnected it holds its last reading, dimmed and marked `~` (#579).

### Changed

- **Done comes only from the board** (ADR 0008, #583). A ticket is Done only when its tracker's own
  completed/closed flag says so: never a merged PR, and never just because the agents reached the
  pipeline's last stage (e.g. `agent:done`), which is now a handoff waiting for you. The dashboard
  has one green for Done everywhere: the epic bar loses the lighter "finished" shade and the hollow
  "awaiting merge" segment, and the copy says "done" instead of "finished". PR state only explains
  why a ticket needs you: awaiting merge, PR merged but ticket still open, PR closed unmerged, or an
  open PR on a done ticket. A new `board_done` event records the board's flag flipping (GitHub issue
  closed, Asana task completed, Jira done-category status, Linear completed/canceled). Projects v2
  and `local`, which never deliver that flag, report it when the ticket enters a manual step. Old
  history still counts its `pipeline_done` finishes until the first `board_done` (#584–#587).
  `pipeline_done` is still emitted on entering a `drainWorktree` step but no longer means done:
  a script or supervisor that read it as "the ticket is done" should watch `board_done` instead.
- The merge bridge no longer moves or completes a ticket whose board closes it on merge by itself
  (a `Closes #N` PR, `forge.boardClosesOnMerge`, or an already-completed task); it only drains the
  worktree. If the merge can't reach the board, the ticket shows "PR merged — close the ticket"
  under Needs you (#588).
- **Behavior change:** the Digest follows the dashboard's language (falling back to `language`,
  then English) and is cached per language in `digest.json`; an older single-digest file is still
  read, not lost. With `digest.model` unset the Digest now runs on
  `summaries.model` (Haiku 5.5 by default) instead of the CLI's default model, and with
  `digest.maxBudgetUsd` unset it uses `summaries.maxBudgetUsd` when that is set. Set
  `digest.model` to keep the old model (#573).

### Fixed

- A finished ticket no longer drops back to idle in the dashboard when a CI-fix or merge job runs
  on its PR afterwards. The `enqueued` event now carries the job's `kind`, a CI/merge job's
  enqueue is no longer read as a re-run, and a PR the receiver knows is merged or closed now wins
  over the event history (#577).
- An epic's tickets link to their own tracker URL instead of one guessed from the epic's URL,
  which broke for Asana permalinks ending in `/f`, for sub-issues from another GitHub repo, and
  whenever the receiver was down (#556).

## [0.12.0] — 2026-10-24

### Added

- Port collisions between profiles are caught: `init --local` now skips ports configured by other
  registered profiles (even stopped ones), not just listening ports, says why it skipped any
  (`port 4127  (4123 claimed by profile "x", 4124–4126 in use)`), and takes `--port <n>`. `ls` shows
  a stopped profile's configured port (marked `*`) instead of `?`, `doctor` warns when two profiles
  share a port, and `start` fails before boot naming the profile that claims a busy port (#537).
- A portable **agent skill** in `skills/agenthook/` (open `SKILL.md` format, loaded by Claude Code,
  Cursor, Codex, OpenCode, Gemini CLI, Hermes…): how to create tickets, epics and dependency chains
  the receiver will actually pick up, and how to supervise (needs-you, release, re-fire), with one
  reference per tracker. `agenthook skill install [--agent …] [--repo [path]]` copies it into the
  detected agents' skill dirs or into the code repo (so the agents the receiver spawns there load it
  too); `skill ls` lists copies; `doctor` warns when an installed copy is older than the package and
  `--fix` reinstalls it; `init` offers the install. Also installable with `npx skills add`.
  Replaces `examples/skills/agenthook-supervisor`.
- `agenthook guide [topic]`: the agent guide from a shell for agents without MCP, and a new dynamic
  topic **`authoring`** (CLI and MCP `guide {topic:"authoring", profile?}`) rendered from the
  profile's config — tracker, the identity a ticket must be assigned to, every step's stages, the
  epic rule, whether dependencies are honoured — so an agent never hardcodes labels or logins.
- **Services for sandboxed runs** (#498): `sandbox.services` declares throwaway databases/caches
  (`image` pinned to a tag or digest, literal `env`, optional `wait.cmd` readiness probe, `agentEnv`
  for the agent, per-service `memory`/`cpus`), and a step opts in with `services: ["db"]`. Each run
  gets fresh service containers on its own internal network, reachable by name, with no host
  mounts, ports or env; they are removed with the run and reaped on boot. A service that won't start
  or become ready fails the run before the agent spawns. `doctor` lists each step's services and a
  missing service image fails the sandbox check (images are never pulled); `run_end` carries
  `services`. Services keep their image's user and a fixed capability set (ADR 0007). A service
  that exits early is kept until teardown so the failure carries its own log lines. A service's
  `env` may not set names the docker/podman client reads (`PATH`, `HOME`, `DOCKER_*`, `XDG_*`, …),
  and its `agentEnv` may not set the egress proxy's vars (`HTTPS_PROXY`, `NO_PROXY`, …) in any
  egress mode. Readiness examples probe over TCP (`pg_isready -h 127.0.0.1`), since a socket probe
  can pass against an image's init-time temporary server.

### Fixed

- Sandboxed claude runs set `CLAUDE_CODE_TMPDIR` under the run's own HOME, so a repo checked out
  under `/tmp/claude-<uid>/…` no longer fails with claude refusing a root-owned temp dir (#538).
- Boot's sandbox reap line now uses the docs' verb and counts networks too, naming the run(s) the
  leftovers came from (`[recover] reaped 3 container(s), 1 network(s) left by run 12/code`); the
  egress proxy and service containers carry the run's ref/step labels, and a new `sandbox_reaped`
  event (`containers`, `networks`, `runs`) reaches supervisors on the bus (#539).

## [0.11.0] — 2026-10-21

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

[Unreleased]: https://github.com/Jesuso/agenthook/compare/v0.15.0...HEAD
[0.15.0]: https://github.com/Jesuso/agenthook/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/Jesuso/agenthook/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/Jesuso/agenthook/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/Jesuso/agenthook/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/Jesuso/agenthook/compare/v0.10.0...v0.11.0
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
