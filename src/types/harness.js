/**
 * A named agent backend (`harnesses.<name>`): a bundle of spawn knobs with its own slot pool.
 * A step naming it gets these knobs where it sets none of its own (src/dispatch/harness.js).
 * @typedef {object} Harness
 * @property {string} [agent]                  agent adapter (src/agents/); default the profile's
 * @property {string} [model]                  the agent's model
 * @property {string} [effort]                 the agent's reasoning effort (claude `--effort`, hermes `--reasoning`, opencode `--variant`); a step's own effort wins
 * @property {string} [bin]                    the agent's executable (a name on PATH or an absolute path)
 * @property {Record<string, string>} [env]   extra environment for the agent; a step's own `env` keys win
 * @property {string} [provider]               inference provider (hermes `--provider`); other agents ignore it
 * @property {string[]} [toolsets]            hermes `-t` toolsets; other agents ignore it
 * @property {number} [maxConcurrent]          max runs on this harness at once, across every step (default: bounded only by the global cap)
 * @property {{image?: string}} [sandbox]     sandboxed runs on this harness use this image instead of `sandbox.image`
 * @property {number} [cooldownMinutes]        health breaker: how long a tripped harness stays down (1–60, default 10), doubled per repeat strike up to 60
 * @property {number} [downGraceSeconds]       health breaker: a non-zero exit with no model output inside this many seconds trips it (default 30)
 * @property {string} [opencodeConfig]         opencode only, sandbox only: host path to an OpenCode JSON config; a step's own `opencodeConfig` wins
 * @property {string} [piConfigDir]            pi only, sandbox only: host dir holding pi's `models.json` and/or `settings.json` (each optional); a step's own `piConfigDir` wins
 * @property {number} [contextTokens]          the model's context window (tokens) on this harness, for the running record's `ctxMax` (#658); a step's own wins
 * @property {RemoteHarness} [remote]          when set, runs on this harness use the `ssh` executor (src/dispatch/executor-ssh.js) instead of host/sandbox (#689, experimental)
 * @property {number} [reserve]                 slots kept back from a spilling job with an open alternative elsewhere (#745); only on a harness some step lists as its only harness (effective default there: 1 if some other step lists it as one option among several, else 0); ignored otherwise
 */

/**
 * A remote worker a harness's runs execute on, over ssh (#689, experimental). The agent runs
 * under `workDir` (`<workDir>/.agenthook/<stateKey>/…`, #690): before every run its ticket's
 * code is synced there over git+SSH (a force-push + `worktree add` for a worktree step, a
 * tracked-only `git archive` for a no-worktree step); after every run (always, incl. timeout/
 * cancel) any commits are fetched back and fast-forwarded into the hub worktree, never the
 * worker's uncommitted edits. Submodules and LFS are not supported yet.
 * @typedef {object} RemoteHarness
 * @property {string} host            ssh host (DNS name or IP)
 * @property {string} [user]          ssh user; default the local ssh client's own
 * @property {number} [port]          ssh port; default 22
 * @property {string} [identityFile]  path to a private key, passed as ssh `-i`
 * @property {string} workDir         absolute path on the worker the agent runs in
 * @property {string} [bin]           the agent CLI on the worker; default the resolved agent's own bin ("claude", "opencode" or "pi")
 */

export {};
