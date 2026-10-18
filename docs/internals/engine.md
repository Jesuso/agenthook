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
persisted quota reading → `ingress.up(port)` → write `publicUrl` → **listen → `startControl` → write
pidfile** (listen precedes any register: a new hook POSTs a handshake at once — Asana needs it echoed;
`startControl`'s owner check reads the old pidfile, so it precedes the write) → if
`ingress.describe().ephemeral` then `adapter.unregisterWebhooks()` (scrub dead-URL hooks) →
`adapter.ensureLabels?()` → `adapter.registerWebhook(url)` → `forge?` (ephemeral →
`forge.unregisterWebhooks()`; then `forge.registerWebhook(url)` — best-effort, never aborts boot) →
`recoverInterrupted()` (resolve `running.json` survivors as failures — **local only, no board poll**)
→ `restoreQueued()` → `puller.pull()` (queue-stage pull into free slots; **only** reads a step's
opt-in queue stage, a no-op without one) → one `runReconcile` (only with `--reconcile-on-boot`, a
restart's respawn) → SIGINT/SIGTERM handlers. A boot failure after `ingress.up` downs the ingress and
closes control; on exit `ingress.down()`.

## Key files

- `src/engine.js` — a one-line re-export shim (the public path every importer uses) over
  `src/engine/`, the receiver: `index.js` = `createEngine`, the composition root (`claimStateDir`
  first, wiring, the `intake()` closure, fatal `process.on` handlers at construction); `http.js` the
  request handler (fast-ACK-then-async is deliberate — providers retry a slow 2xx); `boot.js`
  `serve()`; `teardown.js` `shutdown`/`forceExit`/`teardown`/`onFatal` + `finishTeardown` (the
  once-only respawn/archive tail); `controllers.js` the restart/decommission requesters + quota
  pacer; `recovery.js` local crash recovery (`running.json`, no board poll) + overlap releaser;
  `intake.js` the push sink; `context.js` types-only `EngineState` (the shared mutable flags,
  `control`, `server`).
- `src/queue.js` — bounded-concurrency queue (`maxConcurrent`); worktree isolation makes parallel
  agents safe. Takes an `onChange` callback the engine wires to the heartbeat.
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
- `src/config.js` — discovers `agenthook.config.json` (cwd walk-up / `--config`), interpolates
  `${VAR}` refs from the environment (auto-loads `.env` beside the config and in cwd), and resolves
  the **four distinct locations**: install dir, config dir, central state dir (`~/.agenthook/<stateKey>`,
  `stateKey = stateId ?? name`; also `dataDir`/`logDir`/pidfile/heartbeat), and `repoPath`. The active `tracker` block is mirrored
  to `cfg.providerConfig` so adapters are unchanged; `cfg.provider` = `tracker.type`.
