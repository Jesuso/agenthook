# `ah ui` server, identity, config schema

## Key files

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

See [digest.md](digest.md) for the on-demand Digest feature this UI also surfaces.
