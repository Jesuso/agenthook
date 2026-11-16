# Remote harnesses (experimental)

A harness can run its agent on another machine over ssh instead of the host or the sandbox —
add a `remote` block to one of `harnesses.<name>`:

```jsonc
{
  "harnesses": {
    "worker-1": {
      "remote": {
        "host": "10.0.0.5",
        "user": "agenthook",
        "identityFile": "/home/me/.ssh/agenthook_worker",
        "workDir": "/home/agenthook/work/some-repo"
      }
    }
  }
}
```

A step naming that harness (`"harness": "worker-1"`) runs there. `agenthook doctor` is the setup
check — see [Set up a worker](#set-up-a-worker) and [Checking it](#checking-it-agenthook-doctor).

## What this is

`workDir` is a directory on the worker under which agenthook keeps its own state
(`<workDir>/.agenthook/<name>/…`) — it doesn't need to exist in advance. Before every run, the
hub pushes (a worktree step) or exports (a no-worktree one, e.g. triage) the ticket's code there
over git+SSH — **the hub worktree stays the only real copy**. Only committed, tracked content
ever travels: a gitignored file, an untracked one, `.env` and your profile config in the checkout
never reach the worker. After every run (even a timeout, a cancel, or a crash) any commits the
agent made are fetched back and fast-forwarded into the hub worktree; a worker whose history no
longer descends from what was pushed (rewritten/diverged) fails the run instead of silently
losing or overwriting anything.

## The trust model, stated plainly

This is **one owner**, not multi-tenant isolation. The hub gets code execution on the worker as
the ssh user, and can read that user's agent credentials there (whatever lets `claude` run:
an API key, OAuth token, or `~/.claude/.credentials.json`). Point this only at a machine you
control and trust as much as the hub itself.

The direction that matters more in practice is the other one: the worker's output is **untrusted
input to the hub**. A compromised or buggy worker can try to feed back a forged verdict file or
rewritten git history. What limits that:

- the verdict file copied back from the worker goes through the same symlink-guard every
  sandboxed run's verdict does (`guardSandboxVerdict`) before it's trusted;
- the sync-back fast-forwards (`git merge --ff-only`) the hub worktree onto the worker's branch —
  it never force-overwrites. If the worker's history no longer descends from what the hub pushed
  (rewritten or diverged), the run fails instead of touching the hub worktree;
- the fetch that pulls the worker's branch back passes `--no-tags`, so a tag the worker plants —
  even one pointing straight at a commit the hub is about to accept — never lands in the hub repo;
- the agent's prompt and environment travel over the ssh connection's own stdin, never in argv on
  either side, through a strict allowlist (below) — nothing the worker's `ps`/`/proc` could read
  off argv, and nothing from the hub's own tracker/forge tokens or `ANTHROPIC_*`/`CLAUDE_*` env
  ever reaches the worker in the first place;
- a closed connection (the receiver restarting, a dropped link, an explicit cancel) kills the
  remote agent's whole process group; a boot or shutdown reap sweeps up anything a crashed
  receiver left running there, plus any leftover synced worktree/export dir.

None of this makes the worker a sandbox for the agent *on itself* — an agent that misbehaves on
the worker can still do whatever its own credentials there allow, same as an unsandboxed host
run. It bounds what a bad worker can do **back to the hub**.

## Set up a worker

- A **dedicated, unprivileged user** on the worker — not your own login, not root. `workDir`
  should be owned by it and nothing else should run as it.
- Lock down `authorized_keys` for the key the hub uses:
  ```
  restrict ssh-ed25519 AAAA... agenthook-hub
  ```
  (`restrict` disables port/agent/X11 forwarding and ttys — it does **not** limit which commands
  can run. With this key the hub has a full shell as the dedicated user; that is the one-owner
  trust model stated above, not a sandbox. The executor only ever runs `sh -c "<script>"` over a
  non-interactive, `BatchMode=yes` connection, so it never needs a pty, forwarding, or any other
  grant `restrict` turns off — `restrict` is defense in depth, not the boundary.)
- Give that user an **API key with a spend cap**, not a subscription login — a worker that's ever
  reachable from a compromised or merely buggy hub should not be able to run up an unbounded bill.
  `agenthook doctor`'s credential check (below) tells you if it can find one.
- Install `git` and the agent CLI (`claude` by default — see [Current limits](#current-limits))
  on the worker's `PATH`, or set `harnesses.<name>.remote.bin` to its absolute path there.
- The worker needs a **Linux** shell with GNU coreutils (`head -c` reads the framed prompt and, for
  opencode, the per-run config/contract/standing files byte-for-byte from stdin; `setsid` puts the
  agent in its own process group so a cancel can kill it).

## What never crosses

Only the allowlisted env (`src/dispatch/executor-ssh.js` `remoteEnvAllowlist`), an explicit, named
addition of whatever extra keys the agent's own `remote` hook returned (opencode: `OPENCODE_CONFIG`
plus the two disable flags — never a prefix passthrough, so the hub's own `OPENCODE_*` env never
crosses just because the name matches), and the framed prompt (plus, for opencode, the contract/
standing/config files the hook built) reach the worker — never:

- tracker/forge tokens, or any per-run GitHub App token;
- `ANTHROPIC_*` / `CLAUDE_*`, or the hub's own `OPENCODE_*` (the worker uses its **own**
  credentials, set up as above);
- the ssh agent socket (the connection is never made with `-A`);
- untracked or gitignored files, `.env`, or the profile config (only committed, tracked content
  travels — a `git archive HEAD` for a no-worktree step, a push + `worktree add` for a worktree
  one);
- the worker's own uncommitted edits, on the way back — only commits return, fast-forwarded.

**One exception you opt into:** an `opencodeConfig` set on a remote opencode harness (or its
step) is copied to the worker in full, for the length of the run. A literal API key written in
that file therefore reaches the worker. Write `"apiKey": "{env:NAME}"` instead — it resolves from
the worker's own environment, which the hub never fills — or leave provider setup to the worker's
own OpenCode config and set no `opencodeConfig` at all.

## Checking it: `agenthook doctor`

For every `harnesses.<name>.remote`, `doctor` probes the worker over ssh (using the exact same
connection options the executor itself would) and reports, per harness:

- **reachable** — a plain ssh roundtrip. On failure, the rest of that harness's checks are
  skipped (an unreachable worker would just fail them all the same way).
- **git** on the worker's `PATH`.
- the **agent bin** (`remote.bin`, default the resolved agent's own — `claude` or `opencode`) on
  the worker's `PATH`, plus its `--version` output. A missing `opencode` points at
  <https://opencode.ai> instead of claude's generic install hint.
- **`workDir` is writable** (created if missing).
- **agent credentials** — claude only (an opencode harness's endpoint/credentials are the
  worker's own OpenCode config's business, not doctor's): whether `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` is set, `~/.claude/.credentials.json` is
  non-empty, or `~/.claude/settings.json` sets `apiKeyHelper`, on the worker. This only ever
  reports **which** source it found — never a value. Finding none is a warning, not a failure
  (Bedrock, Vertex and other setups are also possible) — log `claude` in on the worker, or set an
  API key there with a spend cap.

## Seeing it while it runs

A run on a remote harness shows its worker host, not just the harness name:

- `agenthook tick` / `ah tick`: a RUN row reads `· <harness>@<host>` instead of `· <harness>`.
- `agenthook status`: a `remote  : <ref> <step> on "<harness>" @ <host>` line per in-flight
  remote run.
- the `tick` MCP tool's `running[]` rows, and the `status` op, carry the same `host` field — see
  [docs/agent-guide.md](agent-guide.md).

## OpenCode on the worker

A remote harness's agent can also be `opencode` (`harnesses.<name>.agent: "opencode"`, or the
profile's `agent`). `opencode run` gets the same unattended contract and standing-instructions
files a sandboxed local OpenCode run gets, plus any `opencodeConfig`'s content — but unlike the
sandbox, the worker keeps its **own** global OpenCode config, login and session database; nothing
replaces its `HOME`.

```jsonc
{
  "harnesses": {
    "worker-1": {
      "agent": "opencode",
      "remote": { "host": "10.0.0.5", "workDir": "/home/agenthook/work/some-repo" }
    }
  }
}
```

What this adds, beyond the synced code:

- A per-run directory on the worker, outside the synced worktree/export dir (so it's never
  committed or synced back), holds: the unattended-contract file, a standing-instructions file
  (when the step has one, ≤ 16 KB), and a generated `opencode.json` whose `instructions` names
  both as absolute worker paths. When the step (or harness) sets `opencodeConfig`, that file's own
  content is read on the **hub** (same 256 KB cap and JSON validation a sandboxed run's
  `opencodeConfig` gets) and merged in — its own `instructions` entries survive alongside the two
  the run adds. An oversize or invalid `opencodeConfig` refuses the run before anything syncs or
  spawns, exactly like a bad sandboxed one does.
- `OPENCODE_CONFIG` points the worker's `opencode run` at that generated file. OpenCode **merges**
  it on top of the worker's own global config — a local model server on the worker's own loopback,
  or any provider the worker is already logged into, keeps working unchanged; this just adds
  `instructions`. The only other env added is `OPENCODE_DISABLE_AUTOUPDATE`/
  `OPENCODE_DISABLE_MODELS_FETCH` (OpenCode's own non-essential network calls, skipped). These three
  keys are an explicit, named addition to the worker's env allowlist — never a prefix passthrough —
  so none of the hub's own `OPENCODE_*` env crosses just because the name matches.
- The directory (and everything in it) is removed after the run — on a clean exit, a timeout or
  cancel, and by the boot/shutdown reap sweep for anything a crashed run's own cleanup missed.
- The prompt still goes out over the connection's own stdin, never argv — OpenCode reads it from
  stdin when given no positional message (so the worker's `ps`/`/proc` shows
  `opencode run --format json [--auto] [-m …] [--variant …] --`, nothing after the `--`).

Usage/turns/context/compactions are read off the worker's own `opencode run --format json` stdout,
exactly like a local OpenCode run — nothing special about running it remotely changes what
dispatch records.

## Current limits

- Only the `local` tracker is supported with a remote harness.
- Only `claude` and `opencode` are supported as the agent (config refuses any other).
- The profile's per-run sandbox can't wrap a remote harness's step (`sandbox: false` it).
- Per-run GitHub App credentials can't be minted for a remote harness's step (they're scoped to
  the hub, not the worker) — set `githubRunToken: false`, or stop using App auth for that profile.
- Submodules and Git LFS are not supported yet — a tree with a `.gitmodules` or a
  `filter=lfs` `.gitattributes` entry refuses the run with a clear reason, before anything syncs.
- No worker-side container — the agent runs directly as the worker's ssh user, confined only by
  what that user's own OS account can reach.

See [docs/internals/dispatch.md](internals/dispatch.md#the-ssh-executor-srcdispatchexecutor-sshjs-689-launchkillenv-690-code-transport)
for the full protocol.
