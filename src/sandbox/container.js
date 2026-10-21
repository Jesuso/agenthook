// The container sandbox (docker / podman): every agent run gets its own throwaway container
// with only what dispatch hands `wrap()` bind-mounted, each at the SAME absolute path as on
// the host (so the worktree's `gitdir:` pointer, the prompt's paths and the verdict path all
// stay true), plus a per-run HOME. The container runs non-root as the host uid, with every
// capability dropped, no-new-privileges, a pids cap and an optional memory/CPU cap. Env values
// never reach argv: each var is passed by NAME (`-e NAME`) and the runtime client reads the
// value from its own env, so `ps` shows none of them.
//
// HOME is a per-run host dir (`<stateDir>/sandbox-home/<id>`, 0700) bind-mounted at
// /home/agent rather than a tmpfs: a mount whose `dst` lies under HOME (claude's transcript
// dir) then lands on a mountpoint created on the host by the operator's uid, never on a
// root-owned dir the runtime would create inside a tmpfs. `done()` removes it.
//
// Egress (docs/sandbox.md#egress): in `allowlist` mode the run gets its own `--internal`
// network (no route out) plus a proxy container on that network AND the runtime's default one,
// running egress-proxy.mjs over the run's rules; the agent reaches the outside only through
// HTTPS_PROXY (plus NODE_USE_ENV_PROXY for Node's built-in fetch and YARN_HTTPS_PROXY/
// YARN_HTTP_PROXY for Yarn Berry's own fetcher, neither of which honors HTTPS_PROXY on its own).
// `none` = `--network none`; `open` (or no egress) = the runtime's default network.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_IMAGE } from "./image.js";
import { needsEgressProxy } from "./egress.js";

/** The container's HOME (a per-run host dir is mounted here). */
export const SANDBOX_HOME = "/home/agent";

/** The network a runtime attaches containers to by default: the proxy's leg to the outside. */
export const DEFAULT_NETWORK = /** @type {Record<string, string>} */ ({ docker: "bridge", podman: "podman" });

/** The proxy's port inside the run's network. */
export const EGRESS_PROXY_PORT = 3128;

/** The proxy script on the host (shipped in the package's src/), bind-mounted read-only. */
const PROXY_SCRIPT = fileURLToPath(new URL("./egress-proxy.mjs", import.meta.url));
const PROXY_DST = "/opt/agenthook/egress-proxy.mjs";

/** How long `wrap()` waits for the proxy's `ready` file. */
export const EGRESS_READY_TIMEOUT_MS = 10_000;

/** At most this many denied hosts are named in the run log and on `run_end`. */
const DENIED_CAP = 20;

/** @typedef {import('../types.js').IngressRun} Run */

/** The default `run`: execFile, killed after `timeoutMs`. A non-zero exit resolves; a spawn
 * failure (ENOENT) or a kill rejects. @type {Run} */
const execRun = (bin, args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number") return reject(err);
      resolve({ code: err ? Number(err.code) : 0, stdout, stderr });
    });
  });

/** @param {string} s */
const clean = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, "_");

/** A run's container name: `ah-<stateKey>-<ref>-<stepId>-<4 hex>`, limited to [A-Za-z0-9_.-].
 * @param {{stateKey: string, ref: string, stepId: string, suffix?: string}} o */
export function containerName({ stateKey, ref, stepId, suffix = crypto.randomBytes(2).toString("hex") }) {
  return `ah-${clean(stateKey)}-${clean(ref)}-${clean(stepId)}-${suffix}`;
}

/** First line of a CLI's stderr (or stdout), for a reason. @param {{stdout: string, stderr: string}} r */
const firstLine = (r) => (r.stderr || r.stdout || "").trim().split("\n")[0];

/** @param {string} p */
const checked = (p) => {
  // --mount is comma-separated: a path holding one can't be passed safely (no -v fallback).
  if (!path.isAbsolute(p) || /[,"\n]/.test(p)) throw new Error(`sandbox: cannot mount ${JSON.stringify(p)} (must be absolute, with no comma or quote)`);
  return p;
};
/** @param {string} src @param {string} dst @param {boolean} [ro] */
const mount = (src, dst, ro) => ["--mount", `type=bind,src=${checked(src)},dst=${checked(dst)}${ro ? ",readonly" : ""}`];

/** A mask hides a host path under a read-only mount: a file behind /dev/null, a dir behind an
 * empty root-owned 0555 tmpfs. @param {import('../types.js').SandboxMount} m */
const maskOrMount = (m) =>
  m.mask === "dir" ? ["--mount", `type=tmpfs,dst=${checked(m.path)},tmpfs-size=4096,tmpfs-mode=0555`]
  : m.mask === "file" ? mount("/dev/null", m.path, true)
  : mount(m.path, m.dst ?? m.path, m.ro);

/** @param {string} runtime @param {number} uid @param {number} gid */
const userArgs = (runtime, uid, gid) => (runtime === "podman" ? ["--userns=keep-id"] : ["--user", `${uid}:${gid}`]);

/**
 * The `<runtime> run` argv for one sandboxed run (after the runtime binary). Pure.
 * docker maps the host uid with `--user uid:gid`; podman with `--userns=keep-id` (rootless, so
 * the same uid inside and out). Either way files the agent writes belong to the operator.
 * `network` (unset = the runtime's default) is `none` or the run's internal egress network.
 * @param {{runtime: string, id: string, stateKey: string, ref: string, stepId: string, memory?: string, cpus?: number,
 *   uid: number, gid: number, home: string, mounts: import('../types.js').SandboxMount[], cwd: string,
 *   env: Record<string, string>, image: string, bin: string, args: string[], network?: string}} o
 * @returns {string[]}
 */
export function containerArgs(o) {
  return [
    "run", "--rm", "--init", "--pull", "never",
    "--name", o.id,
    "--label", `agenthook.profile=${o.stateKey}`,
    "--label", `agenthook.ref=${o.ref}`,
    "--label", `agenthook.step=${o.stepId}`,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "1024",
    ...(o.memory ? ["--memory", o.memory] : []),
    ...(o.cpus ? ["--cpus", String(o.cpus)] : []),
    ...userArgs(o.runtime, o.uid, o.gid),
    ...(o.network ? ["--network", o.network] : []),
    ...mount(o.home, SANDBOX_HOME),
    "-e", `HOME=${SANDBOX_HOME}`,
    ...o.mounts.flatMap(maskOrMount),
    "--workdir", o.cwd,
    ...Object.keys(o.env).flatMap((k) => ["-e", k]),
    o.image,
    o.bin,
    ...o.args,
  ];
}

/**
 * The `<runtime> run` argv of a run's egress proxy (after the runtime binary). Pure. Same
 * hardening and uid mapping as the agent's container; always the built-in image (it has node).
 * @param {{runtime: string, id: string, stateKey: string, uid: number, gid: number, egressDir: string, network: string}} o
 * @returns {string[]}
 */
export function proxyArgs(o) {
  return [
    "run", "-d", "--rm", "--init", "--pull", "never",
    "--name", `${o.id}-proxy`,
    "--label", `agenthook.profile=${o.stateKey}`,
    "--network", o.network,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "256",
    ...userArgs(o.runtime, o.uid, o.gid),
    ...mount(PROXY_SCRIPT, PROXY_DST, true),
    ...mount(o.egressDir, "/egress"),
    DEFAULT_IMAGE,
    "node", PROXY_DST, "/egress",
  ];
}

/**
 * What a run's denied.jsonl says, as its sandbox report: one log note per denied host:port by
 * count (descending, at most 20, then "… and N more"), and `egressDenied` for `run_end`
 * (omitted when nothing was denied). A `{"truncated": N}` summary line (written by the proxy
 * when its own log cap was hit) adds `egressDeniedTruncated` and a note, without affecting
 * `egressDenied`. Pure; unparseable lines are skipped.
 * @param {string} jsonl @returns {import('../types.js').SandboxReport}
 */
export function egressReport(jsonl) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  let truncated = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (Number.isInteger(d?.truncated)) {
        truncated += d.truncated;
        continue;
      }
      if (typeof d?.host !== "string" || !Number.isInteger(d?.port)) continue;
      const key = `${d.host}:${d.port}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } catch {
      /* a torn last line */
    }
  }
  if (!counts.size && !truncated) return {};
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const shown = sorted.slice(0, DENIED_CAP);
  const notes = shown.map(([hp, n]) => `egress denied: ${hp} (${n}×) — add it to sandbox.egress.allow (or the step's egress.allow) if this step needs it`);
  if (sorted.length > DENIED_CAP) notes.push(`… and ${sorted.length - DENIED_CAP} more`);
  if (truncated > 0) notes.push(`egress denied: … and ${truncated} more denied request(s) not logged (denied.jsonl cap)`);
  /** @type {Record<string, any>} */
  const extra = {};
  if (shown.length) extra.egressDenied = shown.map(([hp]) => hp);
  if (truncated > 0) extra.egressDeniedTruncated = truncated;
  return { notes, extra };
}

/** Read up to `max` bytes of a regular file ("" when missing or not a regular file).
 * @param {string} file @param {number} max */
function readCapped(file, max) {
  try {
    if (!fs.lstatSync(file).isFile()) return "";
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(max);
      const n = fs.readSync(fd, buf, 0, max, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/**
 * @param {import('../types.js').Config} cfg
 * @param {{runtime: "docker"|"podman", run?: Run, uid?: number, gid?: number, readyTimeoutMs?: number}} opts  `run`/`uid`/`gid`/`readyTimeoutMs` for tests
 * @returns {import('../types.js').Sandbox}
 */
export function createContainerSandbox(cfg, { runtime, run = execRun, uid, gid, readyTimeoutMs = EGRESS_READY_TIMEOUT_MS }) {
  const bin = runtime === "docker" ? process.env.DOCKER || "docker" : process.env.PODMAN || "podman";
  const image = cfg.sandbox?.image || DEFAULT_IMAGE;
  const homes = path.join(cfg.stateDir, "sandbox-home");
  const egressDirs = path.join(cfg.stateDir, "egress");
  const hostUid = () => uid ?? process.getuid?.() ?? 0;
  const hostGid = () => gid ?? process.getgid?.() ?? 0;
  /** A CLI call whose non-zero exit throws `what failed: <first line>`. @param {string[]} args @param {string} what */
  const must = async (args, what) => {
    const r = await run(bin, args, { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`${what} failed: ${firstLine(r)}`);
  };
  /** Best-effort removal of a run's proxy, network and egress dir (logged, never thrown).
   * @param {{proxy: string, network: string, dir: string, started: {proxy: boolean, network: boolean}}} e */
  const teardownEgress = async (e) => {
    if (e.started.proxy) {
      const stopR = await run(bin, ["stop", "-t", "5", e.proxy], { timeoutMs: 30_000 }).catch((err) => ({ code: 1, stdout: "", stderr: err.message }));
      if (stopR.code !== 0 && !/no such container|is not running|no container with name/i.test(stopR.stderr || stopR.stdout)) console.error(`[sandbox] ${bin} stop ${e.proxy} failed: ${firstLine(stopR)}`);
      const r = await run(bin, ["rm", "-f", e.proxy], { timeoutMs: 30_000 }).catch((err) => ({ code: 1, stdout: "", stderr: err.message }));
      if (r.code !== 0 && !/no such container|no container with name/i.test(r.stderr || r.stdout)) console.error(`[sandbox] ${bin} rm -f ${e.proxy} failed: ${firstLine(r)}`);
    }
    if (e.started.network) {
      const r = await run(bin, ["network", "rm", e.network], { timeoutMs: 30_000 }).catch((err) => ({ code: 1, stdout: "", stderr: err.message }));
      if (r.code !== 0 && !/no such network|not found/i.test(r.stderr || r.stdout)) console.error(`[sandbox] ${bin} network rm ${e.network} failed: ${firstLine(r)}`);
    }
  };
  /** @param {string} dir */
  const rmDir = (dir) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.error(`[sandbox] could not remove ${dir}: ${err.message}`);
    }
  };

  return {
    describe: () => ({ name: runtime, home: SANDBOX_HOME }),

    async check() {
      let info;
      try {
        info = await run(bin, ["info"], { timeoutMs: 30_000 });
      } catch (e) {
        return { ok: false, reason: `${bin} not runnable (${e.code || e.message}) — install ${runtime} or put it on PATH (or set $${runtime.toUpperCase()})` };
      }
      if (info.code !== 0) return { ok: false, reason: `\`${bin} info\` failed: ${firstLine(info)} — is the ${runtime} daemon/socket up?` };
      // The egress proxy always runs the built-in image, so a custom image needs it too.
      for (const img of new Set([image, ...(needsEgressProxy(cfg) ? [DEFAULT_IMAGE] : [])])) {
        const r = await run(bin, ["image", "inspect", img], { timeoutMs: 30_000 }).catch((e) => ({ code: 1, stdout: "", stderr: e.message }));
        if (r.code !== 0) return { ok: false, reason: `sandbox image ${img} not found — run \`agenthook doctor --fix\` or build it (docs/sandbox.md)` };
      }
      return { ok: true };
    },

    async wrap({ ref, stepId, bin: agentBin, args, env, cwd, mounts, egress }) {
      const id = containerName({ stateKey: cfg.stateKey, ref, stepId });
      const home = path.join(homes, id);
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      // A mount landing under HOME needs its mountpoint to exist on the host first, made by us.
      for (const m of mounts) {
        const dst = m.dst ?? m.path;
        if (dst.startsWith(SANDBOX_HOME + "/")) fs.mkdirSync(path.join(home, dst.slice(SANDBOX_HOME.length + 1)), { recursive: true, mode: 0o700 });
      }
      const mode = egress?.mode ?? "open";
      const egressState = mode === "allowlist" ? { proxy: `${id}-proxy`, network: `${id}-net`, dir: path.join(egressDirs, id), started: { proxy: false, network: false } } : null;
      /** @type {Record<string, string>} */
      const proxyEnv = {};
      if (egressState) {
        const url = `http://${egressState.proxy}:${EGRESS_PROXY_PORT}`;
        Object.assign(proxyEnv, {
          HTTPS_PROXY: url, https_proxy: url, HTTP_PROXY: url, http_proxy: url,
          NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1",
          // Node's built-in fetch (corepack) and Yarn Berry's own fetcher ignore HTTPS_PROXY.
          NODE_USE_ENV_PROXY: "1", YARN_HTTPS_PROXY: url, YARN_HTTP_PROXY: url,
        });
      }
      const runEnv = { ...env, ...proxyEnv };
      const argv = containerArgs({
        runtime, id, stateKey: cfg.stateKey, ref, stepId,
        memory: cfg.sandbox?.memory, cpus: cfg.sandbox?.cpus,
        uid: hostUid(), gid: hostGid(),
        home, mounts, cwd, env: runEnv, image, bin: agentBin, args,
        network: mode === "none" ? "none" : egressState?.network,
      });
      if (egressState) {
        // dispatch never calls done() on a wrap() rejection: undo whatever was made first.
        try {
          await startEgress(egressState, egress?.rules ?? []);
        } catch (e) {
          await teardownEgress(egressState);
          rmDir(egressState.dir);
          rmDir(home);
          throw e;
        }
      }
      let finished = false;
      /** @type {import('../types.js').SandboxReport} */
      let report = {};
      return {
        bin,
        args: argv,
        env: runEnv,
        id,
        async kill() {
          const r = await run(bin, ["kill", id], { timeoutMs: 30_000 }).catch((e) => ({ code: 1, stdout: "", stderr: e.message }));
          if (r.code !== 0 && !/no such container|is not running|no container with name/i.test(r.stderr || r.stdout)) {
            console.error(`[sandbox] ${bin} kill ${id} failed: ${firstLine(r)}`);
          }
        },
        async done() {
          if (!finished) {
            finished = true;
            rmDir(home);
            if (egressState) {
              await teardownEgress(egressState);
              report = egressReport(readCapped(path.join(egressState.dir, "denied.jsonl"), 4 * 1024 * 1024));
              rmDir(egressState.dir);
            }
          }
          return report;
        },
      };
    },

    async reap() {
      const ps = await run(bin, ["ps", "-a", "--filter", `label=agenthook.profile=${cfg.stateKey}`, "--format", "{{.Names}}"], { timeoutMs: 30_000 });
      if (ps.code !== 0) throw new Error(`\`${bin} ps\` failed: ${firstLine(ps)}`);
      const names = ps.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      if (names.length) {
        const rm = await run(bin, ["rm", "-f", ...names], { timeoutMs: 60_000 });
        if (rm.code !== 0) throw new Error(`\`${bin} rm -f\` failed: ${firstLine(rm)}`);
      }
      // Networks after containers: a network still in use can't be removed.
      const nets = await run(bin, ["network", "ls", "-q", "--filter", `label=agenthook.profile=${cfg.stateKey}`], { timeoutMs: 30_000 });
      if (nets.code !== 0) throw new Error(`\`${bin} network ls\` failed: ${firstLine(nets)}`);
      const netIds = nets.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      if (netIds.length) {
        const rm = await run(bin, ["network", "rm", ...netIds], { timeoutMs: 60_000 });
        if (rm.code !== 0) throw new Error(`\`${bin} network rm\` failed: ${firstLine(rm)}`);
      }
      // Every run's container is gone now, so every per-run HOME / egress dir left behind is an orphan.
      fs.rmSync(homes, { recursive: true, force: true });
      fs.rmSync(egressDirs, { recursive: true, force: true });
      return names;
    },
  };

  /**
   * Bring up one run's egress: the internal network, the proxy on it (rules written first),
   * the proxy's leg to the outside, then wait for its `ready` file. Throws on any step; the
   * caller tears down what was started.
   * @param {{proxy: string, network: string, dir: string, started: {proxy: boolean, network: boolean}}} e @param {string[]} rules
   */
  async function startEgress(e, rules) {
    fs.mkdirSync(e.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(e.dir, "allow.json"), JSON.stringify({ rules }), { mode: 0o600 });
    e.started.network = true;
    await must(["network", "create", "--internal", "--label", `agenthook.profile=${cfg.stateKey}`, e.network], `\`${bin} network create\``);
    e.started.proxy = true;
    const id = e.proxy.slice(0, -"-proxy".length);
    await must(proxyArgs({ runtime, id, stateKey: cfg.stateKey, uid: hostUid(), gid: hostGid(), egressDir: e.dir, network: e.network }), "egress proxy start");
    await must(["network", "connect", DEFAULT_NETWORK[runtime], e.proxy], `\`${bin} network connect ${DEFAULT_NETWORK[runtime]}\``);
    const ready = path.join(e.dir, "ready");
    const deadline = Date.now() + readyTimeoutMs;
    while (!fs.existsSync(ready)) {
      if (Date.now() >= deadline) {
        const logs = await run(bin, ["logs", "--tail", "5", e.proxy], { timeoutMs: 10_000 }).catch(() => null);
        const why = logs ? (logs.stderr || logs.stdout).trim().split("\n").filter(Boolean).at(-1) : undefined;
        throw new Error(`egress proxy did not start within ${Math.round(readyTimeoutMs / 100) / 10}s${why ? `: ${why}` : ""}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
