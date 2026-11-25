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
- the run's **outbox** — the only other thing a worker can send back (a draft-PR title/body and
  a ticket comment; see [Publishing the outbox](#publishing-the-outbox)) — is name-fixed, size-capped
  untrusted text: only `pr.json` and `comment.md` are ever opened, anything else is logged without
  being read, and nothing in it is executed or shell-interpolated. Publishing it — pushing the
  branch, opening the draft PR, posting the comment — happens on the **hub**, with the hub's own
  credentials; the worker holds none of them. A run whose commits touch `.github/workflows/` is
  never pushed: the ticket is held for a human instead;
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

## When the worker is off

Every ssh call the executor makes — the pre-run sync, the launcher, the post-run sync-back and
cleanup — carries `ConnectTimeout=10`, so an unreachable worker fails each attempt in seconds
instead of ssh's default ~2 minutes. What happens to the ticket depends on **how** the link
died:

- **Unreachable** — `Connection refused`, `Connection timed out`, `No route to host`,
  `Could not resolve hostname`, or a connection that never delivered anything. The harness's
  health breaker **trips** with the reason `worker unreachable: <host> (<detail>)` (a
  `harness_down` event) and the job goes back to the **front** of the queue — it is never failed
  for a worker that is down, and a trip never counts against the step's `maxAttempts`
  (a down worker that stays down past the cap keeps its jobs queued, not failed). `first-free`
  routing spills the requeued job onto the next harness with room. The breaker probe (one run at
  a time after the cooldown) brings the harness back the first time a run settles without
  tripping; `harness_reset {harness}` does it at once.
- **Auth or host-key failure** — the worker answered but refused the key or the host key didn't
  match. That is a misconfiguration, not an outage: the run is **refused** with
  `ssh auth failed on <host>: <line>` or `ssh host key failed on <host>: <line>` and the breaker
  never trips (retried or not, it would fail the same way). Fix the key or host verification on
  the hub; the ticket then reruns as usual.
- **The link drops mid-run** — the worker had already produced output. The run ends as a
  non-zero exit with no verdict (its commits come back only if the post-run sync-back can
  reach the worker — the receiver always attempts it, even after a crash, so a worker that
  returns before the next run still has them) and the breaker does not trip: a worker that
  ran and then dropped is not proved dead by that alone.

The pre-run sync (push + `worktree add`, or the no-worktree export) failing unreachable is the
same signal as the launcher failing — one reason, one trip, whether the worker went off before
or during the run.

## Publishing the outbox

The agent never holds the tracker's or the forge's credentials (they never cross, above), so it
cannot push its branch, open a PR, or comment on the ticket itself. Instead it may leave up to
two files in an `outbox/` directory **next to its verdict file** (the per-run dir, outside the
synced worktree, so nothing of it ever lands in the hub repo):

- `pr.json` — `{"title": "…", "body": "…"}` for the run's DRAFT pull request; and
- `comment.md` — a comment to post on the ticket.

Both are optional; most runs leave no outbox, and nothing changes when there is none.

**Copy-back.** On every run exit the hub's ssh `done()` copies back **only those two names**, each
capped at 128 KiB by the copy command itself (`head -c`; an over-cap file is dropped), refusing
symlinks and non-regular files the same way the verdict copy-back does. A **resume** turn keeps
the directory (a multi-turn run builds up its PR) and clears only `verdict.json`; a fresh launch
wipes the whole per-run dir, outbox included.

**Validation, on the hub, before the per-run dir is deleted.** Only `pr.json` and `comment.md` are
opened; every other filename in the dir gets exactly one line in the run log — the file itself is
never read (that is where a planted payload shows up without ever being touched). Then, per file:
`pr.json` must be a JSON object with a single-line string `title` (≤ 200 chars, after trim) and a
string `body` (≤ 60 KB); `comment.md` must be non-empty (≤ 60 KB) and may **not** start with the
configured resume trigger — the hub posts it under its OWN identity, so a comment starting with
`@agent` would self-trigger the resume gate. Every dropped or ignored file is one line in the
**run log** (and the server log), naming the file and the reason.

**Publishing, with the hub's own credentials, in the order push → PR → comment.**

1. **Push** (only when the run has a branch): the forge's `publishBranch` pushes the branch
   `--no-force`, the auth token passed only via git's environment (never argv). The GitHub forge
   first refuses — `{workflow: <path>}` — when any commit in the run touches
   `.github/workflows/`: the step is held for a human, nothing is pushed, and no PR or comment
   is posted. An empty range (nothing new since the last publish — a rework run that changed
   nothing) publishes nothing. A push **rejection fails the step** (nothing else may publish
   against a branch that never landed).
2. **PR** (when `pr.json` survived): the forge's `openPr` opens a **draft** PR against the repo's
   default branch — or **reuses the already-open PR** on the same head (`{created:false}`) when
   this is a rework run, so a rework never opens a second PR or edits the first one's
   title/body. A failure is one line in the run log and never fails the step: the PR's own
   title/body is the reviewable artifact.
3. **Comment** (when `comment.md` survived): posted on the ticket by the tracker adapter. Best
   effort — a failure is one line in the run log and never fails the step.

Publishing runs in `finish.js` **after every outcome rewrite has settled** (CI bounce, changes
review, auto-merge, follow-up) and before the step summary, drain and `adapter.advance` — so the
hold or the fail coming out of publishing IS the applied outcome.

See [docs/internals/dispatch.md](internals/dispatch.md) for the module-level detail (`outbox.js`,
`publish.js`, the ssh executor's copy-back).

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

## Following and resuming a session

A remote run's transcript and working directory live on the **worker** (`syncAfter` removes the
worktree/export dir after every run), not on the hub. `follow` and `resume` reach them over the
executor's ssh instead of looking at the hub's filesystem:

- `agenthook follow [id]` — an in-flight remote-harness run is picked up from `running.json`
  (the record's `host`) and its worker transcript is streamed **read-only** over the same no-pty
  probe ssh the executor uses (`-T`, never `-A`): nothing is pulled or copied locally, and it
  works even when the run started before `follow` supported remote. The id must be a valid
  transcript file name. A remote run of an agent that keeps **no** transcript on the worker
  (opencode) has nothing to stream: `follow` tails the **hub-side run log** for it instead — the
  only readable thing, and it says so first.
- `agenthook resume <ref> [<sel>]` — a remote-harness usage record is listed (tagged
  `@<host>`) even though claude keeps its transcripts locally, because the session to resume is
  the one on the worker. Picking one **probes the worker dir first** (no-pty ssh):
  - the dir is **gone** (normal after the run — `syncAfter` removes it): `resume` says the dir
    was removed after the run, offers the two options (re-run the step from the tracker, or
    `git worktree add` the session's ref on the worker yourself), warns that a recreated worktree
    is **not** synced back to the hub, and exits 1.
  - the dir is **present**: it prints (or with `--exec` runs) `ssh -t` into the worker dir
    (`cd <cwd> && exec <bin> -r <id>`). `-t` here is the one place agenthook asks ssh for a pty —
    always, deliberately, for an interactive session a human starts. The step's env is **never
    forwarded**: a step that sets env on the hub gets a warning line instead, and `--exec`
    inherits nothing from the run's environment.
- Both fail with one line naming the host, the harness and the first ssh stderr line when the
  worker is unreachable — they never fall back to the hub's local run log for a remote run
  (opencode's `follow` is the exception, above: there is nothing else to show).

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
