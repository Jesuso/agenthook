# Web UI — design plan

Status: **planned** (epic tracked on GitHub). v1 is a read-only proof of concept.

A local web dashboard for agenthook: see every profile, how many agents are working, what each
ticket is doing (with links to the ticket on its tracker and to its PR), and — in later phases —
review and edit the pipeline config and each step's instructions markdown with a real editor.

Inspiration: OpenClaw's Control UI (schema-driven config form + raw JSON editor) and Hermes Agent's
`hermes dashboard` (local web server, localhost by default). We take the ideas, not the
complexity: no remote access layer, no secrets management, no hosted service. Fully open source.

## Decisions

| Topic | Decision |
|---|---|
| Scope | **One UI for all profiles** under `~/.agenthook/` (same discovery as `ah ls`). |
| Access | **Localhost only.** No remote / tailnet / tunnel access. |
| Secrets | **Never.** The UI edits config files only; `${ENV}` refs are shown as refs, never resolved. `.env` is not read or written. |
| v1 | **Read-only.** Editing lands in v2 (instructions) and v3 (config). |
| Look & feel | **Dense ops console**: tables, monospace for ids/paths, dark-first (light supported). Built to sit on a second screen. |
| Node | Raise `engines` to **Node ≥ 22** (Node 20 is EOL as of 2026-04). |
| Realtime | **No polling.** `fs.watch` (inotify/FSEvents/kqueue) → Server-Sent Events. No socket.io (adds a dep and falls back to long-polling). |

## Why a separate process, not the receiver's port

The receiver's port is what the ingress (e.g. ngrok) tunnels to the internet. Anything served there
is reachable by anyone who has the webhook URL. And editing step instructions is editing what an
unsandboxed `claude -p` runs under `fullAuto` — the editor is an RCE-grade surface.

So the UI is its own command and process:

```
ah ui [--port 4180] [--no-open]
```

- Binds **127.0.0.1** only. No flag to bind elsewhere.
- Generates a random token per launch and opens `http://127.0.0.1:4180/?token=…` (Jupyter-style);
  the token is exchanged for an `HttpOnly; SameSite=Strict` cookie. Every API call requires it.
- Rejects requests whose `Host` isn't `127.0.0.1:<port>`/`localhost:<port>` (DNS-rebinding) and,
  for writes (v2+), whose `Origin` doesn't match (CSRF).
- Is a **blind reader** of the state dirs. It never writes receiver-owned runtime state
  (`running.json`, `queue.json`, `held.json`, `seen.json`, …). In v2+ it writes only files the user
  owns: `agenthook.config.json` and the `instructionsFile`s it references. The one state-dir move
  it makes is archiving a **stopped** profile on Remove… (v3, below), via `src/archive.js`.

## Data sources (v1 needs almost no engine change)

Everything lives in `~/.agenthook/<profile>/`:

| UI shows | Source |
|---|---|
| Profiles, up/down, port, ingress, fullAuto | `heartbeat.json` + pidfile (`listProfiles`/`readProfile` in `src/heartbeat.js`) |
| Agents working / queued | `heartbeat.queue`, `running.json`, `queue.json` |
| Held items + reason | `held.json` |
| Ticket display id, title, PR number | `refmeta.json` (already written by `dispatch.js`) |
| Timeline, outcomes, cost | `events.jsonl` (append-only; `run_end.costUsd`) |
| Run logs / sessions | `logs/`, `src/sessions.js` (`recentRuns`, `listSessions`) |

### Engine changes required

1. **Tracker URL in `refmeta`.** `refmeta` has `displayId`/`title`/`pr` but no link. Cache
   `task.url` alongside them at dispatch so every ticket row links to its tracker from its first run.
2. **PR URL.** With a `forge` block (or a `github` tracker), build
   `https://github.com/<repository>/pull/<pr>` from the cached number — no API call. Without one,
   show the PR number only.
3. **`control.sock` — instant liveness.** A crashed receiver writes nothing, so a stale heartbeat
   is indistinguishable from a quiet one without polling the pid. The receiver listens on
   `~/.agenthook/<profile>/control.sock` (a named pipe on Windows); the UI server connects, and a
   closed connection marks the profile down immediately. v1 uses it **only for liveness**; later
   write actions (catchup, cancel, restart-when-idle) go over this socket rather than by editing
   engine-owned files.

## Realtime model

```
disk change ──fs.watch──► ui server ──SSE──► browser
browser edit ──POST {path, baseHash, content}──► atomic write ──► fs.watch ──► SSE to all tabs   (v2+)
```

- `GET /api/snapshot` → full state on connect. `GET /api/stream` (SSE) → typed deltas. The browser
  `EventSource` reconnects by itself and re-fetches the snapshot on reconnect.
- Run-log viewer: `GET /api/runs?profile=&ref=` → `{ runs: RunView[] }` listed straight from the
  profile's `logs/` (outcome/cost/`endedAt` joined from `run_end`; `endedAt` = its `ts`, `null`
  while running or once it aged out of the events tail). `GET /api/log/stream?profile=&run=` (SSE)
  → `init` (last ≤ 64 KB from a line boundary), `append`, `reset` — a per-connection `fs.watch` on
  the `logs/` dir, closed with the connection. `run` must be a run-log basename actually listed in
  `logs/` whose realpath stays there; anything else is `404`.
- **Watch directories, not files.** `heartbeat.json` and friends are rewritten (and atomic writes
  rename over the inode), so a file-level watch dies. Watch the state dir and filter by name.
- **Debounce + hash.** `fs.watch` emits duplicates/out-of-order; debounce ~50 ms, re-read, compare a
  content hash, broadcast only on real change.
- **Tail `events.jsonl` by byte offset** — read only the appended bytes, never the whole file.
- **Never `fs.watchFile`** — it is stat-polling.
- **v2 conflicts.** Writes carry `baseHash`; a mismatch returns `409` and the UI shows
  "changed on disk — reload / diff / overwrite". The server remembers the hash it just wrote to
  suppress its own echo.

## The ticket row (view model)

One merged record per ref, built server-side from `running` + `queue` + `held` + `refmeta` +
recent `events`:

```ts
type TicketRow = {
  profile: string;
  ref: string;
  displayId: string;          // refmeta.displayId, else ref
  title: string | null;
  step: string | null;        // current / last step id
  status: 'running' | 'queued' | 'held' | 'failed' | 'done' | 'idle' | 'interrupted' | 'stalled';
  model: string | null;       // from run_start
  startedAt: string | null;
  costUsd: number;            // sum of run_end.costUsd
  trackerUrl: string | null;  // refmeta.url
  prUrl: string | null;       // derived from refmeta.pr + forge repository
  heldReason: string | null;
};
```

When the owning profile is down, `running` reads as `interrupted` and `queued` reads as
`stalled` — the receiver isn't live to finish or drain those jobs (it resolves them on its next
boot: `recoverInterrupted()` / `restoreQueued()`).

## Stack

| Layer | Choice | Why |
|---|---|---|
| UI server | `src/ui/` — plain `node:http`, **JSDoc-typed JS**, zero runtime deps | Matches the core; runs unbuilt. Node refuses to strip `.ts` under `node_modules`, so server-side TS would break `npm install`ed copies. |
| Frontend | `ui/` — **TypeScript + React + Vite + Tailwind** | Real TS where a build step exists anyway; the stack agents write most fluently. Bundle size is moot for a local tool. |
| Editor (v2) | CodeMirror 6, markdown mode + split preview | MIT, light; Monaco is too heavy. |
| Shared contract | `src/ui/contract.js` (JSDoc typedefs: snapshot, SSE events, `TicketRow`) | The frontend `import type`s it, so server and browser can't drift. |
| Tests | `node:test` for the server (watcher, debounce, row builder, auth); Vitest for frontend logic | Same zero-dep core runner; Playwright smoke later. |

Dependency policy:
- The core keeps **zero runtime deps**. UI libraries are `devDependencies` only, shipped as a
  prebuilt bundle (`ui/dist`, in npm `files`).
- `ui/dist` is **not committed**; it is built in CI and in `prepublishOnly`. In a dev checkout,
  `ah ui` with no bundle exits with "run `npm run build:ui`".
- Licenses restricted to MIT / Apache-2.0 / BSD / ISC, enforced in CI.

## Phases

### v1 — read-only dashboard (the PoC)

- `ah ui` server: auth token, host checks, snapshot + SSE, directory watcher, events tail.
- Engine: tracker URL in refmeta; `control.sock` liveness.
- Frontend: profiles overview (up/down, agents running/queued, fullAuto badge), tickets table with
  tracker + PR links, live event feed, read-only run-log viewer (live tail of the active run).

**Done when:** every live profile appears with its agent count; tickets update live with working
tracker and PR links; event feed and log viewer work; a state-file change reaches the UI in
< 100 ms; no polling anywhere (no `setInterval` fetches, no `fs.watchFile`).

### v2 — instructions editor

The first phase that **writes**. Scope: the markdown files the pipeline uses as standing
instructions — each step's `instructionsFile`, the profile default `instructionsFile`, and each
repo's `instructionsFile`. Nothing else is writable.

**Edits are live.** `dispatch.js` re-reads instructions at every spawn, so a save takes effect on
the next agent run with no restart — including later steps of tickets already in flight. The
save flow says so and shows how many agents are running on steps that use the file.

**Which files (receiver → heartbeat).** `ah ui` loads no config and never resolves `${ENV}`, so the
receiver publishes what it already resolved at boot: `configPath` and an `instructions` list of
`{ path, scope: 'step'|'default'|'repo', ids[] }` (absolute paths). That list is the **only**
write allowlist.

**Write guards** (`PUT /api/instructions/file`):
- Cookie auth + `Host` check (as v1) + **`Origin` must equal the server origin** + required
  custom header `X-AH-UI: 1` + `Content-Type: application/json` (forces a CORS preflight that
  no other origin passes). Body capped at 256 KB.
- Target must match an allowlisted path exactly, exist, be a regular file (no symlink — `lstat`),
  end in `.md`, and realpath to itself.
- Optimistic concurrency: the request carries `baseHash` (sha256 of the content the editor
  loaded); a mismatch returns `409` with the current content + hash. No blind overwrite.
- Atomic write: temp file in the same dir with the original mode → fsync → rename. The previous
  content is kept as a one-generation backup in the profile's state dir
  (`~/.agenthook/<profile>/instructions-bak/`, 0600) — never beside the file, where a `.bak` would
  escape the repo's `INSTRUCTIONS*.md` ignore rules.
- Every save is appended to a UI-owned `~/.agenthook/<profile>/ui-audit.jsonl`
  (`{ts, path, oldHash, newHash, bytes}`) — the only state-dir file the UI writes.
- External edits (your `$EDITOR`) reach open tabs as SSE `instructions` events (dir watch +
  hash), and the server suppresses the echo of its own write.

**"What the agent sees" preview — from the last real prompt.** An exact preview needs the ticket,
and fetching it needs tracker credentials the UI must not hold. Instead the receiver saves every
run's assembled prompt beside its log (`<log>.prompt.md`, mode 0600). The preview takes the step's
most recent prompt, splits it at `=== TICKET ===`, and substitutes the editor's live buffer for
the standing part (repo instructions + step instructions, in dispatch order). Exact, credential-free,
no control-socket commands. A step that never ran previews the standing part only.

**Editor UX.** CodeMirror 6 (markdown), rendered preview via `react-markdown` (no raw HTML),
`@codemirror/merge` diff shown before every save, unsaved-changes guard, "changed on disk —
reload / diff / overwrite" banner on 409 or an external edit.

### v3 — config editor

Edits `agenthook.config.json` — the one file at the receiver-published `heartbeat.configPath`.

**Shipped so far:** the **Config** tab's raw JSON editor (live parse check, server errors and
literal-secret warnings, diff → confirm with a second ack for changed sensitive fields — secret
values masked — guarded `PUT /api/config`, reload/diff/overwrite banner) and **Restart when idle**
after a save, its banner driven by SSE (`restart_requested` → `restarting` → a new pid), and the
**Basics** / **Pipeline** form tabs beside Raw (one shared buffer; every change a `jsonc-parser`
edit, reorder swaps the steps' exact text) with **stage pickers** fed by `GET /api/discover` on
first form-tab open and on Refresh, and a collapsible **pipeline graph** panel above every pane
(raw/basics/pipeline), re-deriving from the live buffer on every edit — form or raw text — without
a save; an unparseable buffer shows "fix the JSON to see the graph" instead.

**Scope.** Dedicated forms for the **pipeline designer** (steps: add / remove / reorder; id, kind,
model, effort, `maxAttempts`, `maxMinutes`, `idleMinutes`, `createsWorktree`, `drainWorktree`,
`manual`, `instructionsFile`; the tracker's stage bindings) and the **top-level basics** (`name`,
`maxConcurrent`, `fullAuto`, `port`, `trigger`). Everything else (`repos`, `forge`, `ingress`,
`sinks`, tracker credentials) through a **raw JSON editor** with the same validation and diff.

**Formatting-preserving edits, zero-dep server.** The browser turns form changes into minimal text
edits with `jsonc-parser` (`modify` + `applyEdits`, MIT) so `//` comment keys, key order and the
file's formatting survive; the raw editor sends text directly. The server stays dependency-free:
it `JSON.parse`s the proposed text and runs **`validateRawConfig`** — the validation extracted from
`loadConfig` into a pure function that treats `${VAR}` strings as opaque and never resolves env.
Invalid → `422` with the errors; nothing written.

**Save guards** reuse v2's: cookie + Host + exact Origin + `X-AH-UI: 1` + JSON, size cap, path must
equal `heartbeat.configPath` exactly (regular file, no symlink, realpath), `baseHash` → `409`,
atomic temp+rename keeping mode, backup in the state dir, audit line. The audit line also names
**sensitive fields** that changed (`fullAuto`, `claudeBin`, tracker/forge/ingress tokens, user
scoping like `userGid`/`assigneeFilter`), and the UI asks for a second confirmation for them.
A known secret field holding a literal instead of a `${VAR}` ref gets a **warning** (save allowed).

**Renaming a profile.** The Basics form's `name` field is editable: typing a new label inserts
`"stateId": "<current state key>"` right after `"name"` (unless `stateId` is already set), so the
save keeps the profile's state dir — `~/.agenthook/<stateKey>/` — in place. The server guards
this: a save whose effective state key (`stateId ?? name`) no longer matches the profile's actual
state-dir name is a `422` (covers a raw-tab rename with no `stateId`, or editing/removing one), and
a new label that collides with another profile's label or state key is also a `422` (checked only
when the label is actually changing, so an unrelated save isn't blocked by a pre-existing
collision). `name` stays a **sensitive field** — the confirm dialog and audit line show it as
`label (name)` — and, like any other config change, the new label takes effect on **Restart when
idle**.

**Moving the state dir to match.** When the loaded config's label differs from the state key and
the buffer is clean, the Config view shows **Move state dir to match name** (receiver up) or a
hint to run `ah rename <name> --move` (receiver stopped). The confirm explains the move
(`~/.agenthook/<key>/` → `~/.agenthook/<name>/`, at idle, `stateId` removed, restart on the new
key); confirming sends `POST /api/restart` with `{profile, moveTo: <name>}` (same guard chain; a
non-string `moveTo` is a `400`; the audit line records `moveTo`), which the receiver validates
before pausing anything (a `502` names the refusal). The move can't be a config save — the PUT
guard requires the effective key to equal the open profile. The restart banner tracks it, and once
the snapshot lists the new key (the old one vanishes with the dir) the view follows to it.

**Stage pickers — via the receiver.** Listing an Asana project's sections / Jira statuses / labels
/ Projects Status options needs tracker credentials the UI never holds. Adapters gain an optional
`listStages()` (extracted from their `init` wizard discovery); the receiver answers a read-only
`discover` command on `control.sock`. The UI server exposes this as `GET /api/discover?profile=`
(cookie-auth, no write guards — it's a read) via `src/ui/control-client.js`'s `controlRequest`: one
NDJSON request over the profile's `control.sock`, skipping the `hello` line. Unknown profile →
`404` (socket never contacted); receiver down → `503`; no reply within 5 s → `504`; receiver
`ok:false` → `502` with its error; else `200` + the `discover` result as is.

**Applying changes — restart when idle.** The receiver reads config at boot. A `restart` command
on `control.sock`: the receiver stops starting new runs (incoming jobs still queue to
`queue.json`), waits for 0 active agents, shuts down gracefully, re-spawns itself detached on the
same config, and the new process runs **one `reconcile`** to recover webhooks missed in the gap
(an explicit, user-triggered poll — consistent with the no-polling rule). Hot-reload stays out of
scope. The respawn is `start --detach --config <path> --reconcile-on-boot` (an
internal flag: the new server runs that one reconcile after boot; a reconcile error doesn't abort it).
The UI server exposes this as `POST /api/restart` with body `{profile}` — not a file write, so no
`baseHash`/`text`, but the same guard chain (cookie, same-origin `Origin`, `X-AH-UI: 1`, JSON body
≤ 256 KB) as the `PUT` editors. It always sends `{when:'idle'}` over `control.sock` (the browser
never picks `when`); the status mapping is the same as `discover`'s. Either way, once the profile
is known, the outcome is audited — `{ts, action:'restart', profile, status}` appended to that
profile's `ui-audit.jsonl` via `save.js`'s `appendAudit`.

**Removing a profile.** Each dashboard profile row has a **Remove…** action that archives the
state dir — never a hard delete (permanent purge is CLI-only). The modal first fetches `GET
/api/profile/remove-preview?profile=<key>` (cookie only, read-only; unknown → `404`):
`{profile, label, up, configPath, archivePattern, webhookHint}` — paths tildified, `archivePattern`
= `<registry>-archive/<key>-<YYYY-MM-DDTHH-MM-SS>/` (so it follows `AGENTHOOK_HOME`), `configPath`
from `profile.json` else the heartbeat (null for a legacy dir), `webhookHint` =
`agenthook unregister --config <configPath>` or null. It states that the move is reversible, the
config file is untouched, and agent worktrees are left for `agenthook cleanup`; a running profile
gets an "Unregister webhooks" checkbox (default on), a stopped one the `webhookHint`. Confirming
needs the label typed exactly, then sends `POST /api/profile/remove` with `{profile, unregister?}`
— the `restart` guard chain, `405 Allow: POST` for other methods. The UI server sends
`decommission {when:'idle', unregister}` (default `true`) over `control.sock` and maps:

| Status | When |
|---|---|
| `202 {pending:true, active, queued[, alreadyPending]}` | the receiver accepted: it pauses, waits for 0 agents, unregisters webhooks, exits and archives itself |
| `200 {archivedTo, webhookHint}` | socket down (`503`) and no live pid: the UI server archived the dir itself (`archiveStateDir`) |
| `400` | `profile` not a string, or `unregister` present and not a boolean (socket never contacted) |
| `404` | unknown profile |
| `409 {error}` | socket down but the pid is alive (`run agenthook stop first`), or `archiveStateDir` refused |
| `502 {error}` | the receiver refused (`ok:false`: a restart pending, already draining, an old receiver) |
| `504` | no reply within the restart timeout |

Every outcome but a successful archive is audited — `{ts, action:'remove', profile, status,
unregister}` in the profile's `ui-audit.jsonl`; `archiveStateDir` writes its own `action:'remove'`
line into the archived dir. The browser follows a pending removal over SSE: `decommission_requested`
→ `decommissioning` (feed events), the row showing "removing when idle (N agents running)…" from
the live `ProfileView.active`, then `profile_removed` once the dir leaves the registry — which also
closes an open run panel and clears a profile filter naming it. This stopped-branch archive is the
one state-dir move the UI server makes.

**Control socket hardening (prerequisite).** Profile state dirs are created / tightened to `0700`
and the socket is created under a `0o077` umask (no chmod race), before any command lands.
Protocol: NDJSON `{id, cmd, args}` → `{id, ok, result|error}`, allowlisted commands only
(`discover`, `restart`, `decommission`); the v1 `hello` line is unchanged.

**Pipeline graph.** Pure `ui/src/pipelineGraph.ts` (`layoutPipeline`, Vitest-covered) derives SVG
step cards with advance / fail / hold / changes / queue edges from the buffer's stage bindings, and
owns all the geometry: node positions plus one route per edge (`routes`, parallel to `edges`).
`ui/src/PipelineGraph.tsx` only draws it, centered, in a panel above the pane (not a fourth tab, so
it stays visible while editing). The layout is layered:

- a queue-stage row on top, only when a step has a queue stage;
- the step row — at the top margin when there are no queue stages and no `changes` arc (no empty
  band), with a success exit nothing sources (e.g. `done`) inline at its right end;
- sinks below: a fail/hold stage used by **one** step sits under that step's column (two private
  sinks share the column, narrowed); a stage used by 2+ steps is **one** pill in a lower row,
  centered under its sources and reached by orthogonal routes — a drop off the step's bottom edge
  (a distinct x per edge), a run along the stage's own channel track, a drop into the pill — so no
  sink route crosses a step→step line or a card.

A step's `changes` target has no static binding — it's a runtime verdict — so the graph draws
`review → previous step` (`prevStep`, the engine's default) as an arc above the step row, with a
short persistent "changes" label on the arc (its t=0.5 point). Every other label shows on hover
(a widened invisible hit-stroke per edge); hovering the arc shows "changes (default target)". The
panel is collapsed on Raw and Basics and expanded on Pipeline — reset on every pane switch, the
▾/▸ toggle holds until the next one — and is as tall as the SVG's content. An unknown tracker (no
`stageKeys`) draws step nodes and `changes` edges only.

### Later

Write actions over `control.sock` (catchup, resume a held item, cancel an agent) — each its own
security review. Engine hot-reload of the pipeline is explicitly out of scope.
