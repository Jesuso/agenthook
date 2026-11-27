# `ah ui` server, identity, config schema

## Key files

- `src/reader/*.js` — the profile state readers (epic #839 ticket 8), used by the panel below plus
  the MCP/agent API, the digest, the control ops, and several CLI commands: `rows.js` (pure
  `buildRows`/`buildSnapshot` over state dirs; events tail-read, last 256 KB), `stats.js`
  (`dailyStats` pure day buckets + `readStats`: the whole `events.jsonl` history read incrementally
  by byte offset → `GET /api/stats`: finished/merged/runs/outcomes/cost per day, spend per step,
  per-ticket cost quantiles; no rollup file), `run-logs.js` (run listing: `listRuns` from the
  profile's `logs/` dir, `resolveRunLog` name + realpath validation). Read-only, like the rest of
  `src/ui/`.
- `src/ui/*.js` — `ah ui` server (docs/web-ui.md), plus `src/shared/contract.js` (JSDoc
  view-model typedefs, also bundled by the browser):
  `server.js` (Host guard → token/cookie auth → `/api/snapshot` + `/api/stream` SSE + traversal-safe
  `ui/dist` static), `watch.js` (lazy on first stream: `fs.watch` on registry + state dirs, 50 ms
  debounce + hash dedupe, torn read keeps last good value, `events.jsonl` byte-offset tail,
  `control.sock` liveness with pidfile fallback — no polling; the 25 s SSE ping is the only interval).
  `logs.js` (the live tail: `createLogTail` byte-offset tail off a `logs/` dir watch → `/api/runs` +
  `/api/log/stream`, run listing from `src/reader/run-logs.js`). `instructions.js` (v2 editor read side: `listInstructions` /
  `readInstructionFile` / `promptPreview` over the heartbeat's `instructions` allowlist + the
  `.prompt.md` sidecars → `/api/instructions[/file]` + `/api/prompt-preview`; `watch.js` watches the
  allowlisted files' parent dirs and emits SSE `instructions` on a sha256 change, `source:'disk'`).
  Its write side, `writeInstructionFile` ← `PUT /api/instructions/file` (Origin + `X-AH-UI` +
  JSON + 256 KB guards, `baseHash` → 409, sync temp→fsync→backup (state dir `instructions-bak/`, never beside the file)→rename, `ui-audit.jsonl` 0600;
  the server `noteWrite`s the watcher and broadcasts `source:'ui'`), and `config.js` (v3 config
  editor: `GET /api/config` = the raw file at `heartbeat.configPath` + `validateRawConfig` errors +
  `literalSecrets`; `PUT /api/config` = same guards, 422 on invalid (nothing written), backup in
  `config-bak/`, audit `sensitive` = changed `src/shared/contract.js` `SENSITIVE_FIELDS` via the import-free `src/shared/sensitive.js`
  the browser also bundles; SSE `config`) are the
  **only** UI file writes — both go through `src/atomic-save.js` (`atomicSave`), and `test/ui-server.test.js`
  confines write calls to it. `src/control/client.js` (shared infrastructure, not a `src/ui/`
  module — it's the client half of `src/control/server.js`) provides `controlRequest` (one NDJSON request over a
  profile's `control.sock`, skipping the `hello` line, resolving `{ok,result|error}` or rejecting
  `down`/`timeout`; `resolveProfileSock` gates by `listProfiles` like `src/reader/run-logs.js`'s `profileDir`)
  backs more endpoints that are **not** file writes: `GET /api/discover` (cookie only; 5 s
  timeout), `GET /api/sandbox-readiness` (cookie only; `sandbox.js` runs `src/sandbox/readiness.js`'s
  read-only `sandboxRuntimeChecks` probes (shared with `doctor`) and checks the profile's `.env` for a
  credential, no value returned;
  `sandboxIo` stubs the probes in tests), `POST /api/restart` (the v2/v3 write-guard chain; sends `{when:'idle'}`, 2 s
  timeout) and `POST /api/pause` / `/api/resume` (same guards; `args:{}`) — all map the receiver's
  reply to 503 (down) / 504 (timeout) / 502 (`ok:false`) / 200, and the three POSTs audit their
  outcome via `src/atomic-save.js`'s `appendAudit` (also used by `atomicSave`).
   `POST /api/release` (same guards; `{profile, ref, comment?}`, 20 s timeout, audited without the comment) answers a held
  ticket via the receiver's `release` op. `POST /api/ticket` (same guards; `{profile, title, body?, step?,
  blockedBy?}`, the release timeout) creates a ticket on a local-board profile via the receiver's `ticket_add` op —
  the server validates it (blank title or an over-`TICKET_BODY_MAX` body → 400; a non-local tracker → 409),
  normalizes `blockedBy` with the local adapter's `normalizeBlockedBy`, maps the reply like the other control
  POSTs (a 503 reads "start the receiver to add tickets"; a 502 strips the local adapter's `local: ` prefix) and
  audits `{action:'ticket-add', profile, status[, ref]}` without the title/body. `GET /api/epics[/<ref>]` (cookie only, like discover; `<ref>` must match
  `EPIC_REF_RE` → else 400; 20 s `epicsTimeoutMs`) relays the receiver's `epics` op; down (503) → 200 `live:false`
  via `agent-api/` `readLocalEpics` (shared with the MCP `epics` tool/CLI fallback; no tracker call, no write). `POST /api/profile/remove` (same guards; cookie-only `GET /api/profile/remove-preview` is its
  read side) sends `decommission {when:'idle'}` → 202, or — socket down, no live pid — archives the
  stopped profile via `src/archive.js` `archiveStateDir` → 200: the one state-dir change outside
  `src/atomic-save.js`, made from `server.js` (a live pid behind a dead socket → 409, never an archive).
  Otherwise a blind **reader**: never writes any state dir, never loads a config; PR links come
  from the heartbeat's `repository`.
- `src/shared/identity.js` — a profile's colour + emoji (`ui: {color, emoji}` in config). Import-free so config validation (`identityErrors`),
  the heartbeat (`ui`), `src/reader/rows.js` `profileView` (resolved `color`/`emoji`, validated — foreign values never reach the browser) and the
  browser bundle share one palette (`PROFILE_COLORS`, tokens `--color-profile-<id>` in `ui/src/index.css`) and one curated emoji list.
  Unset → `deriveIdentity(stateKey)` (FNV-1a), so every profile is distinct with no config.
- `src/shared/config-schema.js` — the one definition of every user config key (epic #344): `CONFIG_SCHEMA` entries
  (`path` with `"*"` for any index/record key, `type`, `label`, one-line `help` ≤120 chars, `section`, `default`,
  `options`, `min`/`max`, `scope`, `sensitive`, `editor:"pending"` = no form yet) + `NO_FORM` (load-derived keys,
  each with a reason). Import-free; the config editor renders its fields from it (label, raw key, `HelpTip`,
  placeholder). `test/config-schema.test.js` parses `src/types/` and fails when a config `@property` has neither
  an entry nor a `NO_FORM` reason, and holds the `sensitive` set equal to `SENSITIVE_FIELDS`.

**The `src/shared/` rule.** Anything the browser bundle imports at runtime lives in `src/shared/`
(currently `config-schema.js`, `identity.js`, `quota.js`, `pricing.js`, `energy.js`,
`sinks-config.js`, `repos-config.js`, `digest-config.js`, `contract.js`, `sensitive.js`). Those
modules import only each other, or `src/agents/names.js` / `src/sandbox/names.js` (also
import-free), and never a `node:` built-in or a bare package — a server-side change can't
accidentally pull Node code into the panel bundle. `test/shared-boundary.test.js` enforces both
sides: every `src/shared/*.js` import stays inside that allowlist, and no `ui/src/` file imports
runtime code from `src/` outside `src/shared/`.

See [digest.md](digest.md) for the on-demand Digest feature this UI also surfaces.
