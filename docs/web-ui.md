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
  owns: `agenthook.config.json` and the `instructionsFile`s it references.

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
  status: 'running' | 'queued' | 'held' | 'failed' | 'done' | 'idle';
  model: string | null;       // from run_start
  startedAt: string | null;
  costUsd: number;            // sum of run_end.costUsd
  trackerUrl: string | null;  // refmeta.url
  prUrl: string | null;       // derived from refmeta.pr + forge repository
  heldReason: string | null;
};
```

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

- CodeMirror editor for each step's `instructionsFile`, `baseHash` conflict handling, diff before save.
- **"What the agent sees" preview**: the prompt assembled exactly as `dispatch.js` builds it
  (standing instructions + `=== TICKET ===` + step prompt) against a real ticket.

### v3 — config editor

- A JSON Schema for `agenthook.config.json` (`src/config.schema.json`), shared by `doctor`
  validation and the UI form; raw-JSON fallback editor.
- Stage pickers powered by the adapters' existing `wizardSteps`/`pipelineBindings` discovery
  (pick an Asana section / Jira status / label instead of pasting ids).
- Pipeline graph: step cards with source → success / fail / hold / changes edges.
- Saves preserve `//` comment keys and key order (structural edit, never blind re-serialize),
  atomic write + `.bak`.
- The receiver reads config at boot, so pipeline edits apply on restart: a **restart-when-idle**
  action (waits for 0 running agents) over `control.sock`.

### Later

Write actions over `control.sock` (catchup, resume a held item, cancel an agent) — each its own
security review. Engine hot-reload of the pipeline is explicitly out of scope.
