# CLI commands

Everything is one CLI: `bin/agenthook.js` (the `agenthook` bin). During development run it via
`node bin/agenthook.js <cmd>`. Each command auto-discovers `./agenthook.config.json` (walking up
from cwd); `--config <path>` selects one explicitly.

```bash
node bin/agenthook.js init               # interactive scaffold of agenthook.config.json (cwd)
node bin/agenthook.js init --local [--yes] [--full-auto] [--name <n>]  # zero-setup local-board profile in this git repo (no token/tunnel)
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
node bin/agenthook.js ticket add "<title>" [--body <t>|--file <p>] [--step <id>]  # local profiles: add a ticket (receiver up → `ticket_add` op over control.sock)
node bin/agenthook.js ticket ls [--json] # local profiles: the board (ref, stage, title)
node bin/agenthook.js doctor             # preflight: token resolves, repo is git, port free, …
node bin/agenthook.js doctor --fix [--dry-run]  # apply the safe local fixes (state-dir perms, stale pidfile/control.sock, missing instruction files, UI bundle, worktree base, `git worktree prune`), then re-check; --dry-run only plans
node bin/agenthook.js alias [--remove]   # opt-in `ah` short command (symlink beside the agenthook bin)
node bin/agenthook.js ui [--port 4180] [--no-open]  # local read-only web dashboard (127.0.0.1, token→cookie; no config)
node bin/agenthook.js mcp [--read-only]  # MCP server (stdio, all profiles) for external agents — docs/mcp.md
node bin/agenthook.js tick [name…|--all] [--json]  # one-call status+board+PRs+events digest (same payload as the MCP `tick`; ≥2 names/--all = per-profile array)
node bin/agenthook.js digest [name] [--json]  # write + print a profile's Digest in-process (no receiver needed)
node bin/agenthook.js watch [name…|--all] [--event a,b] [--cursor <n|json>] [--timeout s]  # block until the next event (exit 2 on timeout; ≥2 names/--all = first event from any, object cursor)
node bin/agenthook.js watch [name…|--all] --follow [--heartbeat s] [--timeout s]  # stream: one JSON line per event + its exact resume cursor, optional heartbeat lines, final {"e":"watch_end"} (exit 0 on SIGTERM/SIGINT, 2 on total --timeout)

npm run typecheck                         # tsc --noEmit over the JSDoc types (no build)
npm test                                  # node:test suites in test/ (units + test/e2e.test.js: real receiver, local tracker, stub agent)
node --check bin/agenthook.js src/**/*.js # syntax check
```

No build step, no bundler — plain Node ESM (`"type": "module"`, Node ≥ 22). The code ships as JS
and runs unbuilt; TypeScript is used **only as a checker** via JSDoc + `checkJs` (`tsconfig.json`,
`noEmit`). Tests use the built-in `node:test` runner (zero deps); `test/e2e.test.js`
boots a real receiver (`agenthook start`, child process) against a `local` tracker and a stub agent
(`test/fixtures/stub-agent.mjs`, a step `bin` — never a model) and drives the happy / changes-cap /
hold / crash loops end to end; paths that need a webhook tracker or real `claude -p` are still
validated by manual smoke tests. CI
(`.github/workflows/ci.yml`) runs typecheck + tests + `node --check` on Node 22 & 24. There is no
lint config.

## Key files

- `bin/agenthook.js` — CLI router. Parses argv (global `--config`) and dispatches to `src/commands/*`.
- `src/commands/*.js` — one file per subcommand (init/start/stop/ls/status/follow/resume/agents/cleanup/
  webhook/catchup/reconcile/doctor/alias). These replace the old bash `scripts/`.
- `src/sessions.js` — ref → worktree → Claude transcript dir resolution, plus `recentRuns` (last-N
  from the per-run logs) and `listSessions` (every session a ref has, each labelled with its pipeline
  step by correlating the session's first-message time to the nearest run-log start). Backs `resume`.
  Note: a ref's transcripts live under `mangle(worktreePath(cfg, ref))` (agent cwd = worktree), **not**
  the repo mangle `follow` uses; a ref has one session per step run (code, review, …).
