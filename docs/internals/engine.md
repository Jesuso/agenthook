# Engine: request flow, boot flow, supporting modules

Request flow (`src/engine/http.js` → `src/engine/index.js` `intake`):
`POST` → `adapter.authenticate(ctx)` (sync, no network — must let the engine ACK in <10s) →
either reply to a handshake, `401` a bad signature, or **ACK 200 immediately** and then run
`adapter.processEvents(ctx)` off the response path → `intake()` dedups via the `seen` store →
`queue.enqueue` → `dispatch` spawns `claude -p` for the step → on exit `dispatch` reads the agent's
verdict file and `adapter.advance` moves the task to the section that verdict maps to (advance →
success = the next step's trigger; fail → failure; hold → hold lane; changes → the target step's
source = the rework loop).

Boot flow (`engine.serve()` = `src/engine/boot.js`, server owns the ingress lifecycle):
persisted quota reading → `sandbox?.check()` (unavailable → boot throws, nothing brought up) →
`ingress.up(port)` → write `publicUrl` → **listen → `startControl` → write
pidfile** (listen precedes any register: a new hook POSTs a handshake at once — Asana needs it echoed;
`startControl`'s owner check reads the old pidfile, so it precedes the write) → if
`ingress.describe().ephemeral` then `adapter.unregisterWebhooks()` (scrub dead-URL hooks) →
`adapter.ensureLabels?()` → `adapter.registerWebhook(url)` → `forge?` (ephemeral →
`forge.unregisterWebhooks()`; then `forge.registerWebhook(url)` — best-effort, never aborts boot) →
`sandbox?.reap()` (remove containers/networks a dead receiver left running — best-effort, logged as
`[recover] reaped …` and a `sandbox_reaped` event when non-empty) →
`recoverInterrupted()` (resolve `running.json` survivors as failures — **local only, no board poll**)
→ `restoreQueued()` → `puller.pull()` (queue-stage pull into free slots; **only** reads a step's
opt-in queue stage, a no-op without one) → one `runReconcile`, then one `runMergeCatchup` (both in
`src/reconcile.js`; PRs merged in the gap — each in its own try/catch; only with
`--reconcile-on-boot`, a restart's respawn) → SIGINT/SIGTERM handlers. A boot failure after `ingress.up` downs the ingress and
closes control; on exit `ingress.down()`.

`registerWebhook` is the only boot tracker call that isn't best-effort, so it is retried
(`src/engine/boot-retry.js`, keyed on the error's numeric `status` — see `Adapter.registerWebhook`):
a 5xx/429 or network/timeout error retries **indefinitely** on a 5 s → 10 → 20 → … → 5 min capped
backoff; a 404 retries three times over ~1 min (10/20/30 s), then boot fails; anything else fails at
once. Each wait logs `[boot] tracker unavailable, retrying in <N>s (…)`, and the heartbeat carries
`starting: "tracker unavailable"` until it succeeds, so `status` prints `starting (tracker
unavailable) (pid N)` instead of `UP`. A SIGINT/SIGTERM during the wait (`agenthook stop`) aborts it
and takes the boot-failure path above, so the ingress is downed rather than orphaned.

## Key files

- `src/engine/` — the receiver: `index.js` = `createEngine`, the composition root and entry point (`claimStateDir`
  first, wiring, the `intake()` closure, fatal `process.on` handlers at construction); `http.js` the
  request handler (fast-ACK-then-async is deliberate — providers retry a slow 2xx); `boot.js`
  `serve()`; `banner.js` the pure boot `fullAutoBanner` (sandbox-aware, warn-only); `teardown.js` `shutdown`/`forceExit`/`teardown`/`onFatal` + `finishTeardown` (the
  once-only respawn/archive tail; `forceExit`/`onFatal` SIGTERM the children, then `sandbox.reap()`
  bounded at 3s); `controllers.js` the restart/decommission requesters + quota
  pacer; `recovery.js` local crash recovery (`running.json`, no board poll) + overlap releaser;
  `intake.js` the push sink; `context.js` types-only `EngineState` (the shared mutable flags,
  `control`, `server`).
- `src/queue.js` — bounded-concurrency queue (`maxConcurrent`); worktree isolation makes parallel
  agents safe. Takes an `onChange` callback the engine wires to the heartbeat. The health/quota
  breaker (per-harness up/down/probing, the unharnessed gate, the reopen timer) lives next to it in
  `src/harness-breaker.js` (`createHarnessBreaker`), behind a narrow interface (`stateOf`, `entry`,
  `gateClosed`, `settle`, `closeForQuota`, `reset`, `prune`, `arm`, `stop`) — `settle`/`prune` never
  fire its `onChange`, the caller reports/pumps at its own moment. `createQueue` binds `onChange`
  lazily and defers the boot `.arm()` call until after `report`/`pump` are declared, so a
  synchronous injected timer with a past deadline can't fire into a TDZ reference.
- `src/heartbeat.js` — per-profile status JSON in the state dir, plus cross-profile readers
  (`listProfiles`/`readProfile`, pid-liveness) backing `ls`/`status`. Entries are
  `{stateKey, name, …}`: `stateKey` = dir name (the id the UI API uses), `name` = label
  (heartbeat → `profile.json` → dir). `resolveProfile(arg)` backs `status <x>`/`agents <x>`:
  state key wins, else a unique label; a shared label throws.
- `src/profile.js` — the per-state-dir `profile.json` marker (`{configPath, stateKey, name, createdAt,
  updatedAt, webhooks}` — `webhooks` stamped by `createEngine` from `adapter.describe().webhooks`; a
  prior value carries over when `writeProfileMarker` is called without it) and the boot rename gate
  `claimStateDir`, run first in `createEngine` (and in the
  `start --detach` parent): a *fresh* state dir (no marker, nothing but an empty `logs/`) whose config
  already owns a marked sibling dir is removed and refused ("add `stateId`") instead of silently forking state.
- `src/prompts.js` — blind prompt builders; platform words come from `adapter.describe()`.
- `src/wizard.js` — zero-dep prompt runner used by `init`; adapters contribute `WizardStep[]`.
- `src/paths.js` — derived paths (Claude transcript dir mangled from `repoPath`; worktree base).
- `src/config/` — discovers `agenthook.config.json` (cwd walk-up / `--config`), interpolates
  `${VAR}` refs from the environment (auto-loads `.env` beside the config and in cwd), and resolves
  the **four distinct locations**: install dir, config dir, central state dir (`~/.agenthook/<stateKey>`,
  `stateKey = stateId ?? name`; also `dataDir`/`logDir`/pidfile/heartbeat), and `repoPath`. The active `tracker` block is mirrored
  to `cfg.providerConfig` so adapters are unchanged; `cfg.provider` = `tracker.type`.
- `src/config-reload.js` — the pure `diffConfig(cur, next)` behind `agenthook reload` / the `reload`
  control op (#725): an allowlist diff returning the reloadable keys (`changed`, dotted paths) and
  the restart-required ones. `src/engine/controllers.js` `createReloadRequester` wires the `reload`
  dep (refused while a restart/decommission holds the queue; a new run image is
  `createSandbox(next).check()`-ed first via the injected `checkImages`; then it *replaces* `cfg`'s
  reloadable keys, calls `quotaPacer.setThresholds`, re-prunes + re-applies operator overrides
  *before* `queue.reconfigure` (with the shape from `src/engine/harnessing.js` `buildHarnessing`) so
  an override still wins, and emits one `config_reloaded`). Running agents keep the config they
  started with because the shared objects are replaced, never mutated. One known exception: a run
  that *settles* after a reload reads its harness's `downGraceSeconds` from the current (new) config
  (`src/dispatch/finish.js`), not from when it started — the breaker grace is a settle-time knob.
