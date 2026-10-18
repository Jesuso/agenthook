# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

agenthook is an **event-driven agentic-development receiver**. Work flows through a **pipeline**
of steps bound to a tracker's stages (Asana sections, Jira statuses, or GitHub labels). A task
entering a step's source stage fires a webhook; the receiver verifies it and spawns a headless `claude -p` in a
receiver-owned git worktree to do that step's work; on a clean exit it moves the task to the next
section — which fires the next step. There is no polling loop — forward motion is event-driven,
crash recovery is local, and `catchup`/`reconcile` exist only to replay items missed during downtime.
The one narrow exception is an opt-in **queue stage** (below): a step that sets one pulls its
backlog when a slot frees — on `run_end` and once on boot, never on a timer.

> Note: this repo is the receiver/framework. The `claude -p` agents it spawns run in a
> *different* repo (`config.repoPath`) and read *that* repo's CLAUDE.md plus the step's
> instruction file — not this file.

## Commands

Everything is one CLI: `bin/agenthook.js` (the `agenthook` bin). During development run it via
`node bin/agenthook.js <cmd>`. Each command auto-discovers `./agenthook.config.json` (walking up
from cwd); `--config <path>` selects one explicitly.

```bash
node bin/agenthook.js init               # interactive scaffold of agenthook.config.json (cwd)
node bin/agenthook.js start [--detach]   # ingress up → register webhook → serve (server owns ingress)
node bin/agenthook.js stop [--keep-hooks]# SIGTERM the receiver; also deletes its webhooks
node bin/agenthook.js rename <newName> [--move]  # relabel (inserts stateId); --move also moves the state dir (at idle if running)
node bin/agenthook.js restart            # restart the running receiver once idle
node bin/agenthook.js remove <name|key> [--purge] [--yes] [--keep-hooks]  # retire a profile: archive ~/.agenthook/<key>/ to ~/.agenthook-archive/ (running: decommission at idle; --purge = delete permanently, stopped only)
node bin/agenthook.js ls                 # table of ALL profiles under ~/.agenthook + live status
node bin/agenthook.js status [name]      # one profile in detail (url, queue, recent runs)
node bin/agenthook.js follow [session]   # tail a live agent transcript read-only
node bin/agenthook.js resume [ref [session]]  # last N runs / a ref's sessions / print|--exec claude --resume
node bin/agenthook.js agents [--all]     # running `claude -p` procs (this profile; --all = every profile)
node bin/agenthook.js cleanup [--apply [--force]]  # tear down done agent worktrees
node bin/agenthook.js register <url>     # manual webhook create (hosted/static URL)
node bin/agenthook.js unregister         # delete this profile's webhooks
node bin/agenthook.js catchup <ref> [--force]  # replay one missed item through the live server
node bin/agenthook.js reconcile          # replay tasks resting in pipeline sections (explicit poll)
node bin/agenthook.js doctor             # preflight: token resolves, repo is git, port free, …
node bin/agenthook.js alias [--remove]   # opt-in `ah` short command (symlink beside the agenthook bin)
node bin/agenthook.js ui [--port 4180] [--no-open]  # local read-only web dashboard (127.0.0.1, token→cookie; no config)
node bin/agenthook.js mcp [--read-only]  # MCP server (stdio, all profiles) for external agents — docs/mcp.md
node bin/agenthook.js tick [name…|--all] [--json]  # one-call status+board+PRs+events digest (same payload as the MCP `tick`; ≥2 names/--all = per-profile array)
node bin/agenthook.js digest [name] [--json]  # write + print a profile's Digest in-process (no receiver needed)
node bin/agenthook.js watch [name…|--all] [--event a,b] [--cursor <n|json>] [--timeout s]  # block until the next event (exit 2 on timeout; ≥2 names/--all = first event from any, object cursor)

npm run typecheck                         # tsc --noEmit over the JSDoc types (no build)
npm test                                  # node:test suites in test/ (pure units; no network/spawn)
node --check bin/agenthook.js src/**/*.js # syntax check
```

No build step, no bundler — plain Node ESM (`"type": "module"`, Node ≥ 22). The code ships as JS
and runs unbuilt; TypeScript is used **only as a checker** via JSDoc + `checkJs` (`tsconfig.json`,
`noEmit`). Tests use the built-in `node:test` runner (zero deps) and cover the pure units —
`paths`, `pipeline`, `queue` (concurrency + coalescing), `store` (persistence); engine/adapter
paths that need network or `claude -p` are still validated by manual smoke tests. CI
(`.github/workflows/ci.yml`) runs typecheck + tests + `node --check` on Node 22 & 24. There is no
lint config.

## Architecture

The whole point is the **blind engine + swappable adapters** split, now on **two axes** plus an
optional third: the engine names neither the *tracker* (where work comes from) nor the *ingress*
(how it's reachable), nor the optional *forge* (what happened to the code — e.g. a PR merged).
Each lives behind its own one-interface adapter. See `docs/agenthook-v2.md` for the full design.

Request flow (`src/engine.js`):
`POST` → `adapter.authenticate(ctx)` (sync, no network — must let the engine ACK in <10s) →
either reply to a handshake, `401` a bad signature, or **ACK 200 immediately** and then run
`adapter.processEvents(ctx)` off the response path → `intake()` dedups via the `seen` store →
`queue.enqueue` → `dispatch` spawns `claude -p` for the step → on exit `dispatch` reads the agent's
verdict file and `adapter.advance` moves the task to the section that verdict maps to (advance →
success = the next step's trigger; fail → failure; hold → hold lane; changes → the target step's
source = the rework loop).

Boot flow (`engine.serve()`, server owns the ingress lifecycle):
`ingress.up(port)` → if `ingress.describe().ephemeral` then `adapter.unregisterWebhooks()` (scrub
dead-URL hooks) → `adapter.registerWebhook(url)` → listen + write pidfile + heartbeat →
`forge?` (ephemeral → `forge.unregisterWebhooks()`; then `forge.registerWebhook(url)` — best-effort,
never aborts boot) → `recoverInterrupted()` (resolve `running.json` survivors as failures — **local
only, no board poll**) → `restoreQueued()` → `puller.pull()` (queue-stage pull into free slots;
**only** reads a step's opt-in queue stage, a no-op without one) → on exit `ingress.down()`.

Key files:
- `bin/agenthook.js` — CLI router. Parses argv (global `--config`) and dispatches to `src/commands/*`.
- `src/commands/*.js` — one file per subcommand (init/start/stop/ls/status/follow/resume/agents/cleanup/
  webhook/catchup/reconcile/doctor/alias). These replace the old bash `scripts/`.
- `src/sessions.js` — ref → worktree → Claude transcript dir resolution, plus `recentRuns` (last-N
  from the per-run logs) and `listSessions` (every session a ref has, each labelled with its pipeline
  step by correlating the session's first-message time to the nearest run-log start). Backs `resume`.
  Note: a ref's transcripts live under `mangle(worktreePath(cfg, ref))` (agent cwd = worktree), **not**
  the repo mangle `follow` uses; a ref has one session per step run (code, review, …).
- `src/engine.js` — the receiver. Fast-ACK-then-async is deliberate (providers retry a slow 2xx);
  also owns local crash recovery (`running.json`, no board poll), heartbeat, and graceful shutdown.
- `src/trackers/*.js` + `index.js` — tracker adapters. `asana.js`'s header is the **reference
  doc-comment for the adapter interface**; read it before adding one. Register in `index.js`'s
  `TRACKERS` (keyed by `cfg.tracker.type`). Interface: `describe`, `authenticate`, `processEvents`,
  `fetchTask`, `advance`, `listResting`, `registerWebhook`, `unregisterWebhooks`, `forgeCatchup`,
  optional `wizardSteps` (powers `init` live discovery), optional `listQueued(stepId)` (refs in the
  step's queue stage, board order, filtered like `listResting` — not `store.listQueued`, which is
  the local `queue.json`), optional `openBlockers(ref)` (unresolved blockers, fail-open; `dispatch.js`
  re-checks it at run time so a dependency added while a job waited in the local queue still gates it),
  optional `onJobs(emit)` (an in-process event source — `local` only, no webhooks: the engine wires a
  sink at boot; `createPushSink` parks a ref's pushed job until its current run settles).
- `src/ingress/*.js` + `index.js` — ingress adapters (`ngrok` managed/ephemeral, `manual`/`hosted`
  static). Registry `INGRESS` keyed by `cfg.ingress.type`. Interface: `describe() → {name,ephemeral}`,
  `up(port) → {url}`, `down()`, optional `wizardSteps`.
- `src/forges/*.js` + `index.js` — optional forge adapters (`github`). Registry `FORGES` keyed by
  `cfg.forge.type`; no `forge` block → `createForge` returns null and nothing changes. Interface:
  `describe`, `authenticate` (sync), `processEvents`, `registerWebhook`, `unregisterWebhooks`. The
  engine routes POST `/forge[/]` to the forge (else the tracker). `github` turns a merged PR on an
  `agent/<ref>` branch into a `{kind:'merge', ref, stepId:<completeOnMerge step|"">, dedupKey:'merged:<n>'}`
  job; its hook path is `/forge` (**not** `/github`, which the github tracker's scrub deletes) and it
  always verifies `x-hub-signature-256` via the shared `src/hmac.js` `verifyHubSignature`. A red
  `workflow_run` on a same-repo `agent/<ref>` branch becomes a `{kind:'ci', dedupKey:'ci:<run>:<attempt>'}`
  job (`forge.redCi:false` disables): dispatch's `runCi` re-runs failed jobs on attempt 1, else posts
  the log tail as a **PR comment only** (never into findings/prompts — the PR head controls it) and
  bounces `changes` → `forge.ciTarget` (default the `createsWorktree` step) through the shared
  `guardChanges` cap, parking it (`store.setCiRed`) while a step runs on the ref.
- `src/dispatch.js` — a one-line re-export shim (the public path every importer uses) over
  `src/dispatch/`, split by concern around one per-dispatcher state object (`context.js` typedefs;
  `index.js` = `createDispatcher` wiring + `runClaude`/`cancel`): `prompt.js`/`verdict.js`/`pr.js`
  pure helpers, factories `spawn.js` (spawn, log streaming, timeouts/kill), `usage.js` (finalize,
  energy), `routing.js`, `merge.js`, `ci.js`, and `runStep` cut in two: `step.js` (gates, worktree,
  prompt — standing instructions + `stepPrompt` base joined by `=== TICKET ===` — and the spawn with
  `AGENTHOOK_VERDICT_FILE`) → `finish.js` (usage, verdict, run_end, `adapter.advance`). **Verdict**:
  non-zero exit → `fail`; clean exit + valid file → its outcome; clean exit + no file → `advance`.
  `changes` is capped per `(ref,step)` by `maxAttempts` (default 3) to bound the rework loop. A
  `merge` job spawns no agent: fail-closed assignee check → `adapter.enterStage` into the
  `completeOnMerge` (manual) step (its own webhook then drains + emits `pipeline_done`) → optional
  `adapter.complete` (Asana: `completed:true`) → emit `merged`.
- `src/agents/*.js` — agent adapters: the coding-agent CLI a step spawns (`claude`, `cursor`, `hermes`, `opencode`). Interface
  `AgentAdapter` (`src/types.js`): `describe` (optional `promptFile: true` — dispatch passes the prompt via a
  file, not argv, e.g. hermes' `--query-file`), `buildArgs`, `createParser` (stdout → log text + tally +
  `result`/`sessionId`; optional `pushStderr` feeds stderr to the parser, e.g. hermes' `session_id:` line),
  `usageRecord(result|null, ctx)` (decides `unpriced`), `sessions`
  (`{transcriptDir, resumeCommand, files, cwdDirs}` or null — backs `follow`/`resume`/`sessions.js`, which union every agent the profile + its steps run; a null-`sessions` agent with an optional top-level `resumeCommand` — opencode — is resumed from `usage.jsonl` session ids instead), `defaults`
  (`requireVerdict`/`bin`, under the step's), optional `env({cfg,step})` (agent env under the step's `env`, also in `resume`)
  and `preflight({cfg,step,provider})` (a reason fails the run with no spawn). Hermes steps are `isolated` by default
  (`hermes-home.js`: own `HERMES_HOME` at `<stateDir>/hermes-home`, only `config.yaml` copied, local providers only). `index.js` = `AGENTS` + `getAgent`/`agentFor` (step `agent` →
  `cfg.agent` → `claude`); `names.js` = the import-free `AGENT_NAMES` the config schema + validation use.
- `src/pipeline.js` + `src/worktree.js` — the pipeline (`tracker.pipeline[]`, **required**). A task
  entering a step's `sourceSectionGid` fires that step; a clean exit advances to `successSectionGid`
  (= next step's source, so the move re-triggers the next step) unless the agent's verdict says
  `hold`/`changes`/`fail` (`prevStep()` resolves a `changes` target's default). `worktree.js` is the
  **receiver-owned** worktree (create on `createsWorktree`, `drainWorktree` to remove), keyed by task
  ref so all steps share one — no globbing. **No implicit polling**: forward motion is event-driven,
  crash recovery reads local `running.json` only, and the only board poll is the explicit
  `agenthook reconcile` command — with **one narrow exception**: a step that sets a queue-stage key
  (`queueSectionGid` Asana / `queueStatus` Jira·github-projects·local / `queueLabel` GitHub) opts in
  to reading **that one stage**, only on `run_end` (when a slot is free) and once on boot. It is
  never timer-driven, and `listResting` is still never called on boot. `src/pull.js` pulls the top
  `maxConcurrent − active − queued − pending` items via `enterStage(…, {assign:false})` (the same
  move `ah run` makes — the webhook then fires the step). Order: Asana section order, Jira
  `Rank ASC`, GH Projects board position, GitHub labels **oldest-created first** (labels have no order).
- `src/repos.js` — multi-repo routing (pure). `cfg.repos[]` (`{id, path, match, default?,
  instructionsFile?, worktreePrefix?}`; no block → one synthesized `default` repo at `repoPath`,
  `cfg.multiRepo=false`, nothing changes). `resolveRepo(cfg, task.routeKeys)` → exactly one repo;
  no match → the `default` repo; two matches → `conflict`, none + no default → `unroutable` — both
  **hold** the task in `runStep` (no spawn, no attempt, `setHeld` so `@agent` re-runs it). The first
  routed step sticks the ref to its repo (`repo.json`, multi-repo only); worktrees then nest as
  `<base>/<repo.id>/<ref>`. Adapters only supply opaque `Task.routeKeys`.
- `src/queue.js` — bounded-concurrency queue (`maxConcurrent`); worktree isolation makes parallel
  agents safe. Takes an `onChange` callback the engine wires to the heartbeat.
- `src/store.js` — JSON files in `dataDir`: `secrets.json` (handshake secrets keyed by webhook
  path, 0600), `seen.json` (dedup set), `running.json` (in-flight pipeline jobs for crash
  recovery), `queue.json` (jobs waiting behind `maxConcurrent`, replayed on boot), `attempts.json` (per-`(ref,step)` run counts backing the `changes`-loop cap), `repo.json`
  (multi-repo sticky `ref → repoId`, cleared on terminal states), and
  `held.json` (`ref → {stepId, reason, heldAt}` written on a `hold` verdict; any later run of the
  ref, `fail`, or drain clears it — it names the step an `@agent` reply resumes).
  **`seen` is reloaded from disk on every batch** because `catchup` edits it out-of-band;
  disk is the source of truth.
- `src/heartbeat.js` — per-profile status JSON in the state dir, plus cross-profile readers
  (`listProfiles`/`readProfile`, pid-liveness) backing `ls`/`status`. Entries are
  `{stateKey, name, …}`: `stateKey` = dir name (the id the UI API uses), `name` = label
  (heartbeat → `profile.json` → dir). `resolveProfile(arg)` backs `status <x>`/`agents <x>`:
  state key wins, else a unique label; a shared label throws.
- `src/ui/*.js` — `ah ui` server (docs/web-ui.md): `contract.js` (JSDoc view-model typedefs),
  `rows.js` (pure `buildRows`/`buildSnapshot` over state dirs; events tail-read, last 256 KB),
  `server.js` (Host guard → token/cookie auth → `/api/snapshot` + `/api/stream` SSE + traversal-safe
  `ui/dist` static), `stats.js` (`dailyStats` pure day buckets + `readStats`: the whole `events.jsonl` history read incrementally by byte offset → `GET /api/stats`: finished/merged/runs/outcomes/cost per day, spend per step, per-ticket cost quantiles; no rollup file), `watch.js` (lazy on first stream: `fs.watch` on registry + state dirs, 50 ms
  debounce + hash dedupe, torn read keeps last good value, `events.jsonl` byte-offset tail,
  `control.sock` liveness with pidfile fallback — no polling; the 25 s SSE ping is the only interval).
  `logs.js` (run-log viewer: `listRuns` from the profile's `logs/` dir, `resolveRunLog` name +
  realpath validation, `createLogTail` byte-offset tail off a `logs/` dir watch → `/api/runs` +
  `/api/log/stream`). `instructions.js` (v2 editor read side: `listInstructions` /
  `readInstructionFile` / `promptPreview` over the heartbeat's `instructions` allowlist + the
  `.prompt.md` sidecars → `/api/instructions[/file]` + `/api/prompt-preview`; `watch.js` watches the
  allowlisted files' parent dirs and emits SSE `instructions` on a sha256 change, `source:'disk'`).
  Its write side, `writeInstructionFile` ← `PUT /api/instructions/file` (Origin + `X-AH-UI` +
  JSON + 256 KB guards, `baseHash` → 409, sync temp→fsync→backup (state dir `instructions-bak/`, never beside the file)→rename, `ui-audit.jsonl` 0600;
  the server `noteWrite`s the watcher and broadcasts `source:'ui'`), and `config.js` (v3 config
  editor: `GET /api/config` = the raw file at `heartbeat.configPath` + `validateRawConfig` errors +
  `literalSecrets`; `PUT /api/config` = same guards, 422 on invalid (nothing written), backup in
  `config-bak/`, audit `sensitive` = changed `contract.js` `SENSITIVE_FIELDS` via the import-free `sensitive.js` the browser
  also bundles; SSE `config`) are the
  **only** UI file writes — both go through `save.js` (`atomicSave`), and `test/ui-server.test.js`
  confines write calls to it. `control-client.js` (`controlRequest` — one NDJSON request over a
  profile's `control.sock`, skipping the `hello` line, resolving `{ok,result|error}` or rejecting
  `down`/`timeout`; `resolveProfileSock` gates by `listProfiles` like `logs.js`'s `profileDir`)
  backs more endpoints that are **not** file writes: `GET /api/discover` (cookie only; 5 s
  timeout), `POST /api/restart` (the v2/v3 write-guard chain; sends `{when:'idle'}`, 2 s
  timeout) and `POST /api/pause` / `/api/resume` (same guards; `args:{}`) — all map the receiver's
  reply to 503 (down) / 504 (timeout) / 502 (`ok:false`) / 200, and the three POSTs audit their
  outcome via `save.js`'s `appendAudit` (also used by `atomicSave`).
  `POST /api/release` (same guards; `{profile, ref, comment?}`, 20 s timeout, audited without the comment) answers a held
  ticket via the receiver's `release` op. `GET /api/epics[/<ref>]` (cookie only, like discover; `<ref>` must match
  `EPIC_REF_RE` → else 400; 20 s `epicsTimeoutMs`) relays the receiver's `epics` op; down (503) → 200 `live:false`
  via `agent-api.js` `readLocalEpics` (shared with the MCP `epics` tool/CLI fallback; no tracker call, no write). `POST /api/profile/remove` (same guards; cookie-only `GET /api/profile/remove-preview` is its
  read side) sends `decommission {when:'idle'}` → 202, or — socket down, no live pid — archives the
  stopped profile via `src/archive.js` `archiveStateDir` → 200: the one state-dir change outside
  `save.js`, made from `server.js` (a live pid behind a dead socket → 409, never an archive).
  Otherwise a blind **reader**: never writes any state dir, never loads a config; PR links come
  from the heartbeat's `repository`.
- `src/agent-api.js` + `src/mcp/*` + `src/ops.js` — the **agent-facing surface** (docs/mcp.md; usage guide for agents `docs/agent-guide.md`, served by the MCP `guide` tool — update it when a tool, event or error message changes). `agent-api.js`
  is the pure read model over a state dir (`readStatus` slots/running/queue/held with an `etag`,
  `readEventsSince`/`waitForEvents` byte-offset cursors — `waitForEvents` is `fs.watch`-driven, never
  polling —, `readRuns`/`readRunLogTail`, `readTick`, `pickProfile` multiplexing); reads work with the
  receiver down. `readEpics(entry, {ref?, fresh?, tz?})` is live-then-local: the receiver's `epics` op
  when up, else `readLocalEpics` (the `ah ui` receiver-down fallback, also used by `GET /api/epics`) —
  `live()` tags a down socket error `{code:'down'}` so `readEpics` can fall back without string-matching
  the message. Backs the MCP `epics` tool and `agenthook epics`; `tick {epics:true}` adds its list
  (minus per-day `velocity.days`) or `epicsError`. `mcp/server.js` is a zero-dep stdio JSON-RPC MCP transport, `mcp/tools.js` the tool
  table (`--read-only` unlists + refuses every write). Live-only reads (`board`, `prs`) and all writes go
  over `control.sock` to `ops.js` (`createOps`, wired in `engine.js`, passed to `startControl({commands})`):
  `pause/resume/set_concurrency/cancel/run/release/reconcile/pull`, each audited to `control-audit.jsonl`
  (0600, comment text never logged), refusals exposed to the caller (`e.expose`). `cancel` = `queue.remove`
  + `runClaude.cancel(ref)` (SIGTERM→SIGKILL; resolves as `fail`, "cancelled by operator"). `release`
  reuses `resumeJob` (the `@agent` gate); `run` is `agenthook run`'s move incl. `entryBlock`. Forge
  `listAgentPrs` (github) backs `prs`. The read `epics` (`{ref?, fresh?, tz?}`) lists every epic + its tickets
  (`listEpics` then `listEpicTickets` per epic; no readers → `supported:false`) and joins them with local rows/history
  through `epics.js` outside the cache. `board`/`prs`/`epics` are cached ~30 s (`ttlCache`) — an explicit tool call
  is the only trigger, so the no-implicit-polling rule holds.
- `src/state-move.js` — `rename --move`'s core, shared by the engine and the CLI: `checkMove`
  (valid/free/non-colliding target, config still keys `from`, same filesystem) and
  `moveStateDir` (rename the dir, then rewrite/drop `stateId` via `json-edit.js`
  `setStateIdInConfigText` + `atomicSave`; a failed write renames the dir back). A running
  receiver moves in `teardown()` of a `restart {when:'idle', moveTo}` (after the pidfile is gone,
  before `spawnDetached`, which then logs into the new dir); a failed move restarts on the old key.
- `src/archive.js` — `archiveStateDir` (epic #209): rename a **stopped** profile's state dir to
  `<registry>-archive/<key>-<UTC stamp>/` (refuses `.`/`..`, a live pid, an existing target, cross-fs)
  + audit line. The engine's control-socket `decommission {when:'idle'}` pauses like `restart`,
  unregisters webhooks (best-effort), exits with no respawn and archives in teardown's tail.
- `src/digest.js` + `src/digest-config.js` — the on-demand **Digest** (docs/web-ui.md, ADR 0002): `buildSnapshot` (pure over a state dir), `buildDigestArgs` (tool-less `claude -p`, project settings only, never `fullAuto`), `createDigester` (single-flight, outside the slot pool, writes `<stateDir>/digest.json`, emits `digest_start`/`digest_end`). Reached only through the `digest` control op (`ops.js`) ← `POST /api/digest`; the SOUL file (`digest.soul`, default `SOUL.md` beside the config) is on the instructions allowlist with scope `soul`.
- `src/ticket-summary.js` — `summarizeDescription` (pure): a tracker description → one plain paragraph (≤240 chars, first prose paragraph, markdown/fences/checklists stripped), stored by dispatch as `refmeta.summary` and shown by the UI as what a ticket is about.
- `src/epics.js` — pure `epicStats` (progress by bucket, needs-you, velocity, ETA) joining an `Epic` + its `EpicTicket`s with `ui/rows.js` `TicketRow`s and `ui/stats.js` `readHistory`; `isNeedsYou` mirrors `ui/src/summary.ts`; `ticketBucket` is the per-ticket decision, `epicDetail` adds it per ticket,
  `localEpics` groups `refmeta.epic` for the UI's receiver-down fallback, `EPIC_REF_RE` guards refs before any tracker URL. No I/O.
- `src/identity.js` — a profile's colour + emoji (`ui: {color, emoji}` in config). Import-free so config validation (`identityErrors`),
  the heartbeat (`ui`), `ui/rows.js` `profileView` (resolved `color`/`emoji`, validated — foreign values never reach the browser) and the
  browser bundle share one palette (`PROFILE_COLORS`, tokens `--color-profile-<id>` in `ui/src/index.css`) and one curated emoji list.
  Unset → `deriveIdentity(stateKey)` (FNV-1a), so every profile is distinct with no config.
- `src/config-schema.js` — the one definition of every user config key (epic #344): `CONFIG_SCHEMA` entries
  (`path` with `"*"` for any index/record key, `type`, `label`, one-line `help` ≤120 chars, `section`, `default`,
  `options`, `min`/`max`, `scope`, `sensitive`, `editor:"pending"` = no form yet) + `NO_FORM` (load-derived keys,
  each with a reason). Import-free; the config editor renders its fields from it (label, raw key, `HelpTip`,
  placeholder). `test/config-schema.test.js` parses `src/types.js` and fails when a config `@property` has neither
  an entry nor a `NO_FORM` reason, and holds the `sensitive` set equal to `SENSITIVE_FIELDS`.
- `src/profile.js` — the per-state-dir `profile.json` marker (`{configPath, stateKey, name, createdAt,
  updatedAt, webhooks}` — `webhooks` stamped by `createEngine` from `adapter.describe().webhooks`; a
  prior value carries over when `writeProfileMarker` is called without it) and the boot rename gate
  `claimStateDir`, run first in `createEngine` (and in the
  `start --detach` parent): a *fresh* state dir (no marker, nothing but an empty `logs/`) whose config
  already owns a marked sibling dir is removed and refused ("add `stateId`") instead of silently forking state.
- `src/prompts.js` — blind prompt builders; platform words come from `adapter.describe()`.
- `src/wizard.js` — zero-dep prompt runner used by `init`; adapters contribute `WizardStep[]`.
- `src/paths.js` — derived paths (Claude transcript dir mangled from `repoPath`; worktree base).
- `src/config.js` — discovers `agenthook.config.json` (cwd walk-up / `--config`), interpolates
  `${VAR}` refs from the environment (auto-loads `.env` beside the config and in cwd), and resolves
  the **four distinct locations**: install dir, config dir, central state dir (`~/.agenthook/<stateKey>`,
  `stateKey = stateId ?? name`; also `dataDir`/`logDir`/pidfile/heartbeat), and `repoPath`. The active `tracker` block is mirrored
  to `cfg.providerConfig` so adapters are unchanged; `cfg.provider` = `tracker.type`.

The normalized unit passed engine-wide is the **job**: `{ kind: 'pipeline'|'merge', ref, stepId, dedupKey, comment? }`.
Adapters produce jobs; the engine only ever sees jobs. The execution model is the pipeline: a task
moving between board sections drives it. The one comment path is the **`@agent` resume**: an
owner-authored comment starting with `cfg.trigger` on a **held** item re-runs the held step with
the comment as `job.comment` (appended to the prompt). Gate (all required, fail-closed): author
**strictly** = our tracker identity (independent of `assigneeFilter` — never reuse `isOurs`), body
starts with the trigger, the item passes the assignee gate, `store.getHeld(ref)` names a non-manual
step, and that step is under its `maxAttempts` cap (agent and owner share one token, so the cap
bounds self-triggering). Adapter-neutral half: `resumeJob` in `src/pipeline.js`. Asana + GitHub
labels only; Jira / Projects v2 not yet.

## Provider specifics that bite

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

## Typing (JSDoc + checkJs)

Types live in `src/types.js` as JSDoc `@typedef`s with no runtime code — `Adapter` there **is**
the provider contract. Reference any type with `import('./types.js').Foo`. Adapter factories are
tagged `/** @type {import('../types.js').AdapterFactory} */`, so an adapter missing a method or
returning the wrong shape fails `npm run typecheck` — that's the whole point of the setup.

`tsconfig.json` is `strict` but with `useUnknownInCatchVariables: false` (the code reads
`e.message`). External API JSON is genuinely untyped: each adapter has a local
`json(res) => Promise<any>` helper — map fields off that rather than fighting `unknown`. Keep
`npm run typecheck` green when touching `src/`.

## Conventions

- ESM only — `import`, never `require()` (one stray `require` in `asana.js` was a bug). All of
  `bin/` and `src/` is ESM.
- Ops are JS subcommands now (no bash `scripts/`). They stay blind by going *through the engine*:
  `src/paths.js` derives the Claude transcript dir (mangled from `repoPath`) that `follow` reads,
  and `cleanup` asks the active adapter (`fetchTask().completed`) whether an item is done. The
  receiver launches `claude -p` with `cwd: repoPath`, so transcripts live under that path's mangle.
- Never `pkill -f` a pattern that matches the calling shell; `stop` kills by the pidfile at
  `cfg.pidFile` (`~/.agenthook/<name>/server.pid`).
- Runtime state is central (`~/.agenthook/<name>/`), outside any repo. In *this* repo,
  `agenthook.config.json`, `config.json`, `.env`, `INSTRUCTIONS.md`, and `logs/` are gitignored —
  verify before any commit. `agenthook.config.example.json` / `.env.example` / `INSTRUCTIONS.example.md`
  are the committed templates.

## Security posture

The receiver runs `claude -p --dangerously-skip-permissions` when `fullAuto` is set: a verified
webhook leads straight to code execution on the host, gated only by HMAC + a non-guessable URL.
It is **not** sandboxed. See `docs/architecture.md#security-posture` and `README.md`.
