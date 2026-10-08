# `ah ui` visual fixture

Seed a throwaway `AGENTHOOK_HOME` with three fake profiles (two up, one down) and screenshot the
dashboard. The seed covers every ticket status (`running`, `queued`, `held`, `failed`, `done`,
`idle`), and its timestamps are relative to now, so nothing is hidden by the 24h stale filter.
`npm test` doesn't run anything here, because it only globs `test/*.test.js`.

```bash
npm run build:ui                                   # ui/dist — the server serves the built bundle
HOME_DIR=$(mktemp -d)
node test/fixtures/ui/seed.js "$HOME_DIR"
AGENTHOOK_HOME="$HOME_DIR" node bin/agenthook.js ui --no-open --port 4321
# prints: agenthook ui at http://127.0.0.1:4321/?token=…
```

Then, in a second shell, use the printed URL. The `?token=` → cookie redirect is same-origin, so
headless Chrome follows it:

```bash
node test/fixtures/ui/shoot.js '<printed ?token= URL>' out-dark.png  --scheme dark
node test/fixtures/ui/shoot.js '<printed ?token= URL>' out-light.png --scheme light
# options: --size 1440x900 (default) · --wait '<css selector>' (default: a table row) · --chrome <bin>
#          --click '<css selector>' (wait for it, click it, then wait for --wait)

# the ticket drawer, open on the running ticket (fixture ref 221 has a live run + log):
node test/fixtures/ui/shoot.js '<printed ?token= URL>' drawer.png --click '[data-ticket-row="221"]' --wait '[data-drawer] pre'
```

`shoot.js` drives `google-chrome --headless` over the DevTools protocol (Node 22's built-in
`WebSocket`, no deps). It waits for the selector, emulates `prefers-color-scheme`, and captures the
viewport. The one-liner below works too, but it races the snapshot fetch and can capture
"Loading…". `--virtual-time-budget` would avoid that, but it never settles while the SSE stream is
open.

```bash
google-chrome --headless --screenshot=out.png --window-size=1440,900 --timeout=4000 \
  --blink-settings=preferredColorScheme=0 '<printed ?token= URL>'   # 0 = dark, 1 = light
```

Notes:
- "Up" profiles write `server.pid` = `1`. PID 1 always exists (`kill(1, 0)` gives `EPERM`, which
  counts as alive), so they read as up. There's no `control.sock` behind them, so *Remove…* on one
  answers 409 (live pid, dead socket) and never archives anything.
- Each profile's stub `agenthook.config.json` sits inside its state dir, because any other
  directory under `AGENTHOOK_HOME` would be listed as a profile.
- The events table stays empty: it shows live SSE events only, and the fixture is static.
- PNGs for a PR go under `docs/ui-screens/<issue>-{before,after}-{dark,light}.png`.
