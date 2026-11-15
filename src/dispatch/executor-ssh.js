// The `ssh` executor (#689, experimental; phase 2 of the remote-harness epic #681): a harness
// with a `remote` block runs its agent on another machine over ssh instead of the host/sandbox.
// The agent runs in an existing directory on the worker (`remote.workDir`) — code transport is a
// later ticket; the hub's own worktree/branch bookkeeping is unchanged. Only claude is supported
// (config refuses any other agent on a remote harness).
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { MAX_SANDBOX_VERDICT_BYTES } from "./verdict.js";

/** How long the remote watchdog (closed-stdin detector) and the explicit kill path wait between
 * SIGTERM and SIGKILL. Short on purpose — these are receiver-managed runs, not interactive ones. */
const SSH_KILL_GRACE_S = 2;

/** POSIX single-quote a string for a remote shell: wraps it in `'…'`, escaping embedded `'` as
 * `'\''`. Safe for any bytes — no interpolation, no special-casing `$`/backtick/newline/empty.
 * Pure. @param {string} s @returns {string} */
export function shQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/** A ref/step-safe path component, matching spawn.js's own sanitizer. @param {string} s */
const safePart = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, "_");

/** The per-stateKey base dir under a remote harness's `workDir`. @param {import('../types.js').RemoteHarness} remote @param {string} stateKey */
const remoteBase = (remote, stateKey) => `${remote.workDir}/.agenthook/${safePart(stateKey)}`;

/** Where a run's pgid/prompt-pipe files live on the worker. @param {import('../types.js').RemoteHarness} remote @param {string} stateKey */
const remoteRunsDir = (remote, stateKey) => `${remoteBase(remote, stateKey)}/runs`;

/** The remote per-run verdict dir (mirrors sandboxVerdictPathFor's own naming). @param {import('../types.js').RemoteHarness} remote @param {string} stateKey @param {string} ref @param {string} stepId */
const remoteVerdictDir = (remote, stateKey, ref, stepId) => `${remoteBase(remote, stateKey)}/verdicts/run-${safePart(ref)}-${safePart(stepId)}`;

/** The base ssh argv (options + host), before the trailing remote command. @param {import('../types.js').RemoteHarness} remote @returns {string[]} */
function sshBaseArgs(remote) {
  /** @type {string[]} */
  const args = ["-T", "-o", "BatchMode=yes"];
  if (remote.port) args.push("-p", String(remote.port));
  if (remote.identityFile) args.push("-i", remote.identityFile);
  if (remote.user) args.push("-l", remote.user);
  args.push(remote.host);
  return args;
}

/** Run `sh -c <script>` on the worker over a fresh ssh connection, each remote-command element
 * individually shQuoted (ssh joins its trailing argv with spaces before the remote shell parses
 * it — never `-A`). Resolves to stdout (a Buffer); a non-zero exit or network failure resolves to
 * null rather than throwing (every caller treats "couldn't reach it" as best-effort).
 * @param {import('../types.js').RemoteHarness} remote @param {string} script @param {{maxBuffer?: number}} [opts]
 * @returns {Promise<Buffer|null>} */
function runRemote(remote, script, { maxBuffer } = {}) {
  const args = [...sshBaseArgs(remote), shQuote("sh"), shQuote("-c"), shQuote(script)];
  return new Promise((resolve) => {
    execFile("ssh", args, { encoding: "buffer", maxBuffer: maxBuffer ?? 256 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/** The script a short-lived ssh call runs to TERM-then-KILL a run's process group, given its
 * pgid file. Idempotent — a missing file or an already-dead group is silently ignored.
 * @param {string} pgidFile @returns {string} */
function killScript(pgidFile) {
  return `p=$(cat ${shQuote(pgidFile)} 2>/dev/null); if [ -n "$p" ]; then kill -TERM "-$p" 2>/dev/null; sleep ${SSH_KILL_GRACE_S}; kill -KILL "-$p" 2>/dev/null; fi`;
}

/** Non-secret run metadata + a couple of locale/CI knobs — everything else (tracker/forge
 * tokens, per-run App tokens, ANTHROPIC_ and CLAUDE_ vars, SSH_AUTH_SOCK, an arbitrary harness `env` key)
 * is dropped. `AGENTHOOK_VERDICT_FILE` rides the `AGENTHOOK_` prefix. TERM/LANG/CI come straight
 * from the receiver's own env — containerEnv (spawn.js) already stripped them off `env` (it
 * treats TERM as host-only), so pulling them from `env` here would always miss. Pure (ignoring
 * the `process.env` read). @param {Record<string, string|undefined>} env @returns {Record<string, string>} */
export function remoteEnvAllowlist(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && k.startsWith("AGENTHOOK_")) out[k] = v;
  }
  for (const k of /** @type {const} */ (["TERM", "LANG", "CI"])) {
    if (typeof process.env[k] === "string") out[k] = /** @type {string} */ (process.env[k]);
  }
  return out;
}

/** The stdin payload the remote launcher reads: a line-count header of `KEY=VALUE` env records,
 * then a byte-count line and exactly that many raw bytes of the prompt — never shell-quoted (it
 * travels as data, not argv), so any prompt content is safe. Env values must not contain a
 * newline (the allowlist's values never do: paths, TERM/LANG/CI). Pure.
 * @param {Record<string, string>} env @param {string} prompt @returns {string} */
export function framePayload(env, prompt) {
  const entries = Object.entries(env);
  const lines = entries.map(([k, v]) => `${k}=${v}\n`).join("");
  const text = String(prompt ?? "");
  const plen = Buffer.byteLength(text, "utf8");
  return `${entries.length}\n${lines}${plen}\n${text}`;
}

/**
 * The remote POSIX-sh launcher (#689): reads the framed env+prompt off stdin, puts the agent in
 * its own process group (pgid file for reap/kill), runs it with the prompt on ITS stdin (not
 * argv — `execArgv` never includes the prompt), and starts a watchdog that TERM-then-KILLs the
 * group once stdin closes (client died, link dropped, or the hub ended it on a kill). Removes its
 * pgid file on exit and exits with the agent's own code. `head -c`/`setsid`/`/proc` are assumed
 * (Linux workers; a missing /proc falls back to the launcher's own pid as the pgid).
 * @param {{workDir: string, runsDir: string, pgidFile: string, promptPipe: string, verdictDir: string, execArgv: string[]}} o
 * @returns {string} */
function launcherScript({ workDir, runsDir, pgidFile, promptPipe, verdictDir, execArgv }) {
  const exec = execArgv.map(shQuote).join(" ");
  return [
    `cd ${shQuote(workDir)} || exit 1`,
    `mkdir -p ${shQuote(runsDir)}`,
    `rm -rf ${shQuote(verdictDir)}`,
    `mkdir -p -m 700 ${shQuote(verdictDir)}`,
    `rm -f ${shQuote(promptPipe)}`,
    `mkfifo ${shQuote(promptPipe)}`,
    `read -r n`,
    `i=0`,
    `while [ "$i" -lt "$n" ]; do IFS= read -r line; k=\${line%%=*}; v=\${line#*=}; export "$k=$v"; i=$((i+1)); done`,
    `read -r plen`,
    `setsid ${exec} < ${shQuote(promptPipe)} &`,
    `agentpid=$!`,
    `head -c "$plen" > ${shQuote(promptPipe)}`,
    // A backgrounded job of a non-job-control sh is never its own process group leader, so the
    // `setsid` command never forks (man setsid(1)): it calls setsid() on itself and execs in
    // place. Its pid is therefore always its own new pgid — no /proc read, no race.
    `echo "$agentpid" > ${shQuote(pgidFile)}`,
    `exec 3<&0`,
    `( cat <&3 >/dev/null; p=$(cat ${shQuote(pgidFile)} 2>/dev/null); if [ -n "$p" ]; then kill -TERM "-$p" 2>/dev/null; sleep ${SSH_KILL_GRACE_S}; kill -KILL "-$p" 2>/dev/null; fi ) &`,
    `wait "$agentpid" 2>/dev/null`,
    `code=$?`,
    `rm -f ${shQuote(pgidFile)} ${shQuote(promptPipe)}`,
    `exit "$code"`,
  ].join("\n");
}

/**
 * One harness's `ssh` executor (#689, experimental). `spawnPaths.sandboxVerdictPathFor` supplies
 * the hub-local copy-back target (`hubVerdictFile`) — same per-run-dir helper the sandbox
 * executor's own verdict path uses, so both get the "only dir mounted/copied into" guarantee.
 * @param {{stateKey: string, remote: import('../types.js').RemoteHarness, spawnPaths: {sandboxVerdictPathFor: (stepId: string, ref: string) => string}}} o
 * @returns {import('../types.js').Executor} */
export function createSshExecutor({ stateKey, remote, spawnPaths }) {
  return {
    name: "ssh",
    paths: ({ stepId, ref }) => ({
      cwd: remote.workDir,
      worktree: undefined,
      verdictFile: `${remoteVerdictDir(remote, stateKey, ref, stepId)}/verdict.json`,
      hubVerdictFile: spawnPaths.sandboxVerdictPathFor(stepId, ref),
    }),
    launch: async ({ runId, ref, stepId, args, env }) => {
      const prompt = args[1]; // buildClaudeArgs/resumeClaudeArgs always put the prompt at args[1]
      const execArgv = [remote.bin || "claude", args[0], ...args.slice(2)]; // drop the prompt — it travels on stdin, never argv
      const runsDir = remoteRunsDir(remote, stateKey);
      const safeRunId = safePart(runId);
      const pgidFile = `${runsDir}/${safeRunId}.pgid`;
      const promptPipe = `${runsDir}/${safeRunId}.pipe`;
      const verdictDir = remoteVerdictDir(remote, stateKey, ref, stepId);
      const script = launcherScript({ workDir: remote.workDir, runsDir, pgidFile, promptPipe, verdictDir, execArgv });
      const hubVerdictFile = spawnPaths.sandboxVerdictPathFor(stepId, ref);
      return {
        bin: "ssh",
        args: [...sshBaseArgs(remote), shQuote("sh"), shQuote("-c"), shQuote(script)],
        env: /** @type {Record<string, string>} */ (process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
        id: safeRunId,
        stdin: framePayload(remoteEnvAllowlist(env), prompt),
        kill: async () => {
          await runRemote(remote, killScript(pgidFile));
        },
        done: async () => {
          const buf = await runRemote(remote, `head -c ${MAX_SANDBOX_VERDICT_BYTES + 1} ${shQuote(`${verdictDir}/verdict.json`)} 2>/dev/null`, { maxBuffer: MAX_SANDBOX_VERDICT_BYTES + 2 });
          if (buf && buf.length > 0 && buf.length <= MAX_SANDBOX_VERDICT_BYTES) {
            try {
              fs.mkdirSync(path.dirname(hubVerdictFile), { recursive: true });
              fs.writeFileSync(hubVerdictFile, buf);
            } catch (e) {
              console.error(`[ssh] verdict copy-back write failed for ${hubVerdictFile}: ${e.message}`);
            }
          }
          return {};
        },
      };
    },
    reap: async () => {
      const runsDir = remoteRunsDir(remote, stateKey);
      const script = [
        `for f in ${shQuote(runsDir)}/*.pgid; do`,
        `  [ -f "$f" ] || continue`,
        `  p=$(cat "$f" 2>/dev/null)`,
        `  echo "$f"`,
        `  [ -n "$p" ] && kill -KILL "-$p" 2>/dev/null`,
        `  rm -f "$f"`,
        `done`,
      ].join("\n");
      const buf = await runRemote(remote, script);
      const runs = buf
        ? buf.toString("utf8").split("\n").filter(Boolean).map((f) => safePart(path.basename(f, ".pgid")))
        : [];
      return { containers: [], networks: [], runs };
    },
  };
}

/**
 * One `ssh` executor per harness that declares a `remote` block, keyed by harness name; `{}`
 * when none do. @param {{cfg?: Pick<import('../types.js').Config, 'stateKey'|'harnesses'>, spawnPaths?: {sandboxVerdictPathFor: (stepId: string, ref: string) => string}}} o
 * @returns {Record<string, import('../types.js').Executor>} */
export function createSshExecutors({ cfg, spawnPaths }) {
  /** @type {Record<string, import('../types.js').Executor>} */
  const out = {};
  if (!cfg?.harnesses || !spawnPaths) return out;
  for (const [name, h] of Object.entries(cfg.harnesses)) {
    if (h.remote) out[name] = createSshExecutor({ stateKey: cfg.stateKey, remote: h.remote, spawnPaths });
  }
  return out;
}
