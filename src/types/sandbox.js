/** @typedef {import('./pipeline.js').Step} Step */
/** @typedef {import('./ingress.js').IngressRun} IngressRun */
/** @typedef {import('./config.js').Config} Config */

/**
 * The optional sandbox config block (`sandbox` in agenthook.config.json): run each agent in its
 * own container with only its worktree mounted (src/sandbox/). Absent = runs on the host.
 * @typedef {object} SandboxConfig
 * @property {string} type      sandbox backend ("docker" | "podman")
 * @property {string} [image]   agent image (default `agenthook-agent:<package version>`)
 * @property {string} [memory]  container memory cap, e.g. "4g" (unset = runtime default)
 * @property {number} [cpus]    container CPU cap, e.g. 2 (unset = runtime default)
 * @property {EgressConfig} [egress]  the runs' network policy (default mode allowlist)
 * @property {Record<string, ServiceConfig>} [services]  the Service catalog steps opt into by name (the name is the agent's hostname for it)
 */

/**
 * One Service (`sandbox.services.<name>`): a database or cache container started fresh for each
 * run of a step that lists it, on the run's internal network only (docs/adr/0007).
 * @typedef {object} ServiceConfig
 * @property {string} image                          image with an explicit tag or digest; never pulled
 * @property {Record<string, string>} [env]          literal env for the service container
 * @property {{cmd: string[], timeoutS?: number}} [wait]  readiness probe: `cmd` is exec'd in the service until it exits 0, within `timeoutS` (default 60)
 * @property {Record<string, string>} [agentEnv]     literal env added to the agent's container (e.g. DATABASE_URL)
 * @property {string} [memory]                       service memory cap (default "1g")
 * @property {number} [cpus]                         service CPU cap (default 1)
 */

/**
 * A sandboxed run's network policy (`sandbox.egress`, a step's `egress`; src/sandbox/egress.js).
 * @typedef {object} EgressConfig
 * @property {'allowlist'|'open'|'none'} [mode]  allowlist (default) = only the model API, forge, tracker, origin and `allow`; none = no network; open = unrestricted
 * @property {string[]} [allow]  extra rules (`host`, `*.domain`, `host:port`, `…!private`) or registry presets (`@npm`, `@pypi`, …)
 * @property {string[]} [deny]   rules or presets removed from the defaults (e.g. the tracker API)
 */

/** The egress a run's sandbox enforces: `rules` only matter for `allowlist`.
 * @typedef {object} SandboxEgress
 * @property {'allowlist'|'open'|'none'} mode
 * @property {string[]} rules
 */

/** One bind mount into a sandboxed run.
 * @typedef {object} SandboxMount
 * @property {string} path   absolute host path; mounted at the SAME path inside the container unless `dst` is set
 * @property {string} [dst]  absolute container path (only for a mount under the sandbox's `home`, e.g. a transcript dir)
 * @property {boolean} [ro]  read-only
 * @property {"file"|"dir"} [mask]  hide `path` instead of mounting it: a file behind /dev/null, a dir behind an empty tmpfs
 */

/** What a run's sandbox has to say once it exits (generic, so a sandbox feature needs no new plumbing).
 * @typedef {object} SandboxReport
 * @property {string[]} [notes]             lines dispatch appends to the run log as `[agenthook] <note>`
 * @property {Record<string, any>} [extra]  fields dispatch merges into the run's `run_end` event
 * @property {{host: string, port: number, error: string}[]} [upstreamFailures]  distinct host:port the egress proxy couldn't reach for an allowed request (src/sandbox/container.js upstreamReport) — fed to the harness breaker (healthTrip)
 * @property {string} [failed]  the run otherwise exited clean, but `done()` could not be trusted (#690: an ssh run's sync-back refused — non-ff, or a merge it would overwrite) — step.js maps this onto `refused`, so the run fails instead of advancing on an un-synced verdict
 */

/** What `wrap()` returns for one run: dispatch spawns `bin args` (the runtime client) instead
 * of the agent, with `env` over the client's runtime env.
 * @typedef {object} SandboxRun
 * @property {string} bin
 * @property {string[]} args
 * @property {Record<string, string>} env   the container env; the client passes each var by name
 * @property {string} id                    container name
 * @property {() => Promise<void>} kill     force-stop the container (idempotent)
 * @property {() => Promise<SandboxReport>} done  post-exit cleanup (idempotent)
 */

/** A sandbox adapter: where one agent run executes.
 * @typedef {object} Sandbox
 * @property {() => {name: string, home: string}} describe  `home` = the container's HOME
 * @property {() => Promise<{ok: true} | {ok: false, reason: string}>} check  runtime reachable + image present
 * @property {(o: {runId: string, ref: string, stepId: string, bin: string, args: string[], env: Record<string, string>, cwd: string, mounts: SandboxMount[], step: Step, egress?: SandboxEgress, image?: string, files?: {dst: string, content: string, mode?: number}[]}) => Promise<SandboxRun>} wrap  `egress` absent = open (the runtime's default network); `image` = the run's harness image (absent = the profile's); `files` are written into the per-run HOME (see Sandbox's `sandbox` hook on AgentAdapter)
 * @property {() => Promise<{containers: string[], networks: string[], runs: string[]}>} reap  force-remove every container
 *   and network labelled with this profile; `runs` is the distinct `"<ref>/<step>"` values read from the removed
 *   containers' `agenthook.ref`/`agenthook.step` labels (best-effort — a container with neither label is omitted)
 */

/** A factory `(cfg, opts?) => Sandbox`; `run` replaces the CLI runner in tests. `defaultImage`
 * overrides the image used when `sandbox.image` is unset — the restart preflight passes the
 * respawn's on-disk version instead of this process's own `DEFAULT_IMAGE` (#885).
 * @typedef {(cfg: Config, opts?: { run?: IngressRun, defaultImage?: string }) => Sandbox} SandboxFactory */

/** A run launched by an Executor (#682): identical to SandboxRun — `id` is empty and `done()`
 * yields no report for the host executor's trivial launch. `stdin` (#689, ssh): the framed
 * env+prompt payload spawn.js writes to the launched process's stdin, keeping it open until
 * exit or kill, instead of closing it at once (host/sandbox leave it unset).
 * @typedef {SandboxRun & {stdin?: string}} ExecutorRun */

/**
 * Which launcher runs a job (#682 phase 1, #689 phase 2 — the remote-harness epic #681): `'host'`
 * (a plain spawn), `'sandbox'` (the profile's per-run container), or `'ssh'` (a remote worker,
 * src/dispatch/executor-ssh.js). Chosen per run, after the harness resolves, by `executorFor`
 * (src/dispatch/executor.js).
 * @typedef {object} Executor
 * @property {'host'|'sandbox'|'ssh'|string} name
 * @property {string} [host]  the worker host (ssh executor only) — the breaker's unreachable reason and the ssh config-failure refusal name it (#828)
 * @property {(o: {stepId: string, ref: string, worktree: string, hasWorktree: boolean, repoPath: string}) => {cwd: string, worktree: string|undefined, verdictFile: string, hubVerdictFile?: string, configDir?: string}} paths
 *   the run's paths AS THE AGENT SEES THEM. For host and sandbox these equal the hub's own
 *   `worktree`/`repoPath` (host: `verdictPathFor`; sandbox: `sandboxVerdictPathFor`), and
 *   `hubVerdictFile`/`configDir` are unset — the agent-facing and hub-facing verdict path are the same file.
 * `ssh`'s `cwd`/`verdictFile` are paths on the remote worker (a deterministic per-ref(+step)
 *   worktree or export dir under the harness's `remote.workDir`, #690 — not `remote.workDir`
 *   itself, so a verdict-repair resume turn relaunches into the same cwd); `hubVerdictFile` is
 *   the local copy target `done()` writes the remote verdict back to, which the hub actually
 *   reads; `configDir` (#739) is a deterministic per-ref(+step) directory on the worker, outside
 *   the synced worktree/export dir, an `AgentAdapter.remote` hook's returned `files` are written
 *   under — removed by `done()`/`reap()`, never synced back.
 * @property {(o: {runId: string, ref: string, stepId: string, bin: string, defaultBin?: string, args: string[], env: Record<string, string>, cwd: string, mounts: SandboxMount[], step: Step, egress?: SandboxEgress, image?: string, files?: {dst: string, content: string, mode?: number}[], hub?: {repoId: string, repoPath: string, worktree?: string, branch?: string}, raw?: boolean, prompt?: string, remoteEnv?: Record<string, string>, resume?: boolean}) => Promise<ExecutorRun>} launch
 *   `hub` (ssh only, #690): the HUB-side repo/worktree this run's code should be synced from/to
 *   before/after the run — `worktree`+`branch` set only for a worktree step; absent entirely for
 *   a launch with no code to sync (e.g. the low-level unit tests of this module)
 *   `raw` (ssh only, #710's gate): run the given `bin`/`args` on the worker verbatim (no prompt
 *   pulled off argv onto stdin) and never fetch the worker's edits back in `done()` — only host/
 *   sandbox/ssh-with-`raw` may run a gate; any other executor name refuses one
 *   `prompt`/`defaultBin` (ssh only, #739): the exact prompt string `args` was built from (ssh
 *   removes exactly that element from `args` — index 1 (claude's `-p <prompt>`) or the last
 *   element (opencode's trailing positional) — rather than assuming a fixed shape; a mismatch
 *   throws, refusing the run instead of risking the prompt leaking into the worker's argv) and
 *   the resolved agent's own default bin (used as `remote.bin || defaultBin`, never a hard-coded
 *   `"claude"`); host/sandbox ignore both.
 *   `remoteEnv` (ssh only, #739): exactly the keys an `AgentAdapter.remote` hook returned (e.g.
 *   opencode's `OPENCODE_CONFIG`) — added to the worker env allowlist by name, never scanned as a
 *   prefix off `env` itself, so no hub-side env value with a matching name crosses just because
 *   it's present on the hub.
 * @property {() => Promise<{containers: string[], networks: string[], runs: string[]}>} [reap]  force-remove anything this executor left running (sandbox: containers/networks; ssh: remote pgids, worktrees and exports under every run's harness `workDir`, #690)
 */

export {};
