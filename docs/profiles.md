# Profiles & parallel runs

A **profile** is one config = one process = one isolated state dir. Run as many as you like
side by side; nothing is shared.

```bash
agenthook start --config ~/proj-a/agenthook.config.json   # port 4123
agenthook start --config ~/proj-b/agenthook.config.json   # port 4124 (set in its config)

agenthook ls              # every profile + live status
# NAME    UP  PORT  TRACKER  INGRESS  AGENTS  QUEUE  LAST EVENT
# proj-a  *   4123  asana    ngrok    1       0      2m ago
# proj-b  *   4124  asana    hosted   0       0      1h ago

agenthook status proj-a   # one profile in detail (url, queue, recent runs)
```

Each command auto-discovers `./agenthook.config.json` (walking up from the cwd); `--config`
selects one explicitly.

## Renaming a profile

```bash
agenthook rename proj-b2          # relabel only: inserts "stateId": "proj-b", state dir stays put
agenthook rename proj-b2 --move   # relabel AND move ~/.agenthook/proj-b/ → ~/.agenthook/proj-b2/
```

`--move` drops `stateId` from the config once the dir follows the name. A **running** receiver
does the move itself on a restart-when-idle (new runs pause, running agents finish, the dir is
renamed, the config rewritten, and it comes back up on the new key with all its history); a
**stopped** one has it moved directly by the CLI. The web UI's Config view offers the same as
"Move state dir to match name" whenever the label and the state key differ.

- **Crash safety:** the dir is moved first, then the config written (a failed write moves the dir
  back). If the process dies between the two, the next `start` is refused with the exact
  `"stateId": "<new>"` to add — or move the dir back by hand.
- **Same filesystem only:** a state dir on a different filesystem than `~/.agenthook` is refused
  ("move by hand") — the move is always a plain rename, never a copy.
- **Windows:** the control pipe is keyed by the state key, so it follows the move. A handle still
  open on the dir can make the rename fail (`EPERM`/`EBUSY`); the receiver then restarts on the
  old key unchanged — retry later.

## Removing a profile

```bash
agenthook remove proj-b           # archive ~/.agenthook/proj-b/ → ~/.agenthook-archive/proj-b-<stamp>/
agenthook remove proj-b --purge   # stopped only: archive, then permanently delete the archived copy
```

`remove` takes a label or state key (never the cwd config) and asks you to type the profile name
(`--yes` skips the prompt; required on a non-interactive stdin). A **running** receiver does it
itself: it finishes its running agents, unregisters its webhooks (`--keep-hooks` keeps them),
exits and archives its own state dir. A **stopped** one is archived directly, but its webhooks
can't be unregistered without it — run `agenthook unregister --config <path>` **before**
removing. The config file and agent worktrees are never touched (`agenthook cleanup` prunes the
latter); undo an archive by moving the dir back.

From the web UI: the web UI (`agenthook ui`) has a **Remove…** action on each dashboard profile row. It never
hard-deletes: the state dir moves to `~/.agenthook-archive/<key>-<YYYY-MM-DDTHH-MM-SS>/`
(`$AGENTHOOK_HOME-archive/…` under a custom `AGENTHOOK_HOME`), keeping history, dedup, logs and
webhook secrets — **reversible** by moving the dir back. Confirm by typing the profile's label.

- **Running receiver:** it decommissions itself at idle — new runs pause, running agents finish,
  it unregisters its webhooks (an opt-out checkbox), exits and archives its dir.
- **Stopped receiver:** the UI archives the dir directly. Webhooks can't be unregistered without
  the receiver, so it shows the exact `agenthook unregister --config <path>` to run (skip it if the
  profile never registered one).
- **Not touched:** the config file, and agent worktrees — clean those with `agenthook cleanup` in
  the repo.
