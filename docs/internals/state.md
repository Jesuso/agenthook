# State: store files, state-dir moves, archiving

## Key files

- `src/store.js` — JSON files in `dataDir`: `secrets.json` (handshake secrets keyed by webhook
  path, 0600), `seen.json` (dedup set), `running.json` (in-flight pipeline jobs for crash
  recovery), `queue.json` (jobs waiting behind `maxConcurrent`, replayed on boot), `attempts.json` (per-`(ref,step)` run counts backing the `changes`-loop cap), `repo.json`
  (multi-repo sticky `ref → repoId`, cleared on terminal states), and
  `held.json` (`ref → {stepId, reason, heldAt}` written on a `hold` verdict; any later run of the
  ref, `fail`, or drain clears it — it names the step an `@agent` reply resumes).
  **`seen` is reloaded from disk on every batch** because `catchup` edits it out-of-band;
  disk is the source of truth.
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
- `src/profile.js` — see [engine.md](engine.md) (the `profile.json` marker and `claimStateDir` boot
  rename gate).
