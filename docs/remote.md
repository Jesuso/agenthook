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
- Lock down `authorized_keys` for the key the hub uses, so a compromised hub key can only run
  agenthook's own protocol, not an arbitrary shell:
  ```
  restrict,command="exec /bin/sh" ssh-ed25519 AAAA... agenthook-hub
  ```
  (`restrict` disables port/agent/X11 forwarding and ttys; the executor always runs `sh -c
  "<script>"` over a non-interactive, `BatchMode=yes` connection, so a bare `sh` is enough — it
  never needs a pty, forwarding, or any other grant `restrict` turns off.)
- Give that user an **API key with a spend cap**, not a subscription login — a worker that's ever
  reachable from a compromised or merely buggy hub should not be able to run up an unbounded bill.
  `agenthook doctor`'s credential check (below) tells you if it can find one.
- Install `git` and the agent CLI (`claude` by default — see [Current limits](#current-limits))
  on the worker's `PATH`, or set `harnesses.<name>.remote.bin` to its absolute path there.

## What never crosses

Only the allowlisted env (`src/dispatch/executor-ssh.js` `remoteEnvAllowlist`) and the framed
prompt reach the worker — never:

- tracker/forge tokens, or any per-run GitHub App token;
- `ANTHROPIC_*` / `CLAUDE_*` (the worker uses its **own** credentials, set up as above);
- the ssh agent socket (the connection is never made with `-A`);
- untracked or gitignored files, `.env`, or the profile config (only committed, tracked content
  travels — a `git archive HEAD` for a no-worktree step, a push + `worktree add` for a worktree
  one);
- the worker's own uncommitted edits, on the way back — only commits return, fast-forwarded.

## Checking it: `agenthook doctor`

For every `harnesses.<name>.remote`, `doctor` probes the worker over ssh (using the exact same
connection options the executor itself would) and reports, per harness:

- **reachable** — a plain ssh roundtrip. On failure, the rest of that harness's checks are
  skipped (an unreachable worker would just fail them all the same way).
- **git** on the worker's `PATH`.
- the **agent bin** (`remote.bin`, default `claude`) on the worker's `PATH`, plus its
  `--version` output.
- **`workDir` is writable** (created if missing).
- **agent credentials** — whether `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or
  `CLAUDE_CODE_OAUTH_TOKEN` is set, `~/.claude/.credentials.json` is non-empty, or
  `~/.claude/settings.json` sets `apiKeyHelper`, on the worker. This only ever reports **which**
  source it found — never a value. Finding none is a warning, not a failure (Bedrock, Vertex and
  other setups are also possible) — log `claude` in on the worker, or set an API key there with a
  spend cap.

## Seeing it while it runs

A run on a remote harness shows its worker host, not just the harness name:

- `agenthook tick` / `ah tick`: a RUN row reads `· <harness>@<host>` instead of `· <harness>`.
- `agenthook status`: a `remote  : <ref> <step> on "<harness>" @ <host>` line per in-flight
  remote run.
- the `tick` MCP tool's `running[]` rows, and the `status` op, carry the same `host` field — see
  [docs/agent-guide.md](agent-guide.md).

## Current limits

- Only the `local` tracker is supported with a remote harness.
- Only `claude` is supported as the agent (config refuses any other).
- The profile's per-run sandbox can't wrap a remote harness's step (`sandbox: false` it).
- Per-run GitHub App credentials can't be minted for a remote harness's step (they're scoped to
  the hub, not the worker) — set `githubRunToken: false`, or stop using App auth for that profile.
- Submodules and Git LFS are not supported yet — a tree with a `.gitmodules` or a
  `filter=lfs` `.gitattributes` entry refuses the run with a clear reason, before anything syncs.
- No worker-side container — the agent runs directly as the worker's ssh user, confined only by
  what that user's own OS account can reach.

See [docs/internals/dispatch.md](internals/dispatch.md#the-ssh-executor-srcdispatchexecutor-sshjs-689-launchkillenv-690-code-transport)
for the full protocol.
