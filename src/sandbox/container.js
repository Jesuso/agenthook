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
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { DEFAULT_IMAGE } from "./image.js";

/** The container's HOME (a per-run host dir is mounted here). */
export const SANDBOX_HOME = "/home/agent";

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

/**
 * The `<runtime> run` argv for one sandboxed run (after the runtime binary). Pure.
 * docker maps the host uid with `--user uid:gid`; podman with `--userns=keep-id` (rootless, so
 * the same uid inside and out). Either way files the agent writes belong to the operator.
 * @param {{runtime: string, id: string, stateKey: string, ref: string, stepId: string, memory?: string, cpus?: number,
 *   uid: number, gid: number, home: string, mounts: import('../types.js').SandboxMount[], cwd: string,
 *   env: Record<string, string>, image: string, bin: string, args: string[]}} o
 * @returns {string[]}
 */
export function containerArgs(o) {
  /** @param {string} p */
  const checked = (p) => {
    // --mount is comma-separated: a path holding one can't be passed safely (no -v fallback).
    if (!path.isAbsolute(p) || /[,"\n]/.test(p)) throw new Error(`sandbox: cannot mount ${JSON.stringify(p)} (must be absolute, with no comma or quote)`);
    return p;
  };
  /** @param {string} src @param {string} dst @param {boolean} [ro] */
  const mount = (src, dst, ro) => ["--mount", `type=bind,src=${checked(src)},dst=${checked(dst)}${ro ? ",readonly" : ""}`];
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
    ...(o.runtime === "podman" ? ["--userns=keep-id"] : ["--user", `${o.uid}:${o.gid}`]),
    ...mount(o.home, SANDBOX_HOME),
    "-e", `HOME=${SANDBOX_HOME}`,
    ...o.mounts.flatMap((m) => mount(m.path, m.dst ?? m.path, m.ro)),
    "--workdir", o.cwd,
    ...Object.keys(o.env).flatMap((k) => ["-e", k]),
    o.image,
    o.bin,
    ...o.args,
  ];
}

/**
 * @param {import('../types.js').Config} cfg
 * @param {{runtime: "docker"|"podman", run?: Run, uid?: number, gid?: number}} opts  `run`/`uid`/`gid` for tests
 * @returns {import('../types.js').Sandbox}
 */
export function createContainerSandbox(cfg, { runtime, run = execRun, uid, gid }) {
  const bin = runtime === "docker" ? process.env.DOCKER || "docker" : process.env.PODMAN || "podman";
  const image = cfg.sandbox?.image || DEFAULT_IMAGE;
  const homes = path.join(cfg.stateDir, "sandbox-home");

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
      const img = await run(bin, ["image", "inspect", image], { timeoutMs: 30_000 }).catch((e) => ({ code: 1, stdout: "", stderr: e.message }));
      if (img.code !== 0) return { ok: false, reason: `sandbox image ${image} not found — run \`agenthook doctor --fix\` or build it (docs/sandbox.md)` };
      return { ok: true };
    },

    async wrap({ ref, stepId, bin: agentBin, args, env, cwd, mounts }) {
      const id = containerName({ stateKey: cfg.stateKey, ref, stepId });
      const home = path.join(homes, id);
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      // A mount landing under HOME needs its mountpoint to exist on the host first, made by us.
      for (const m of mounts) {
        const dst = m.dst ?? m.path;
        if (dst.startsWith(SANDBOX_HOME + "/")) fs.mkdirSync(path.join(home, dst.slice(SANDBOX_HOME.length + 1)), { recursive: true, mode: 0o700 });
      }
      const argv = containerArgs({
        runtime, id, stateKey: cfg.stateKey, ref, stepId,
        memory: cfg.sandbox?.memory, cpus: cfg.sandbox?.cpus,
        uid: uid ?? process.getuid?.() ?? 0, gid: gid ?? process.getgid?.() ?? 0,
        home, mounts, cwd, env, image, bin: agentBin, args,
      });
      let finished = false;
      return {
        bin,
        args: argv,
        env,
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
            try {
              fs.rmSync(home, { recursive: true, force: true });
            } catch (e) {
              console.error(`[sandbox] could not remove ${home}: ${e.message}`);
            }
          }
          return {};
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
      // Every run's container is gone now, so every per-run HOME left behind is an orphan.
      fs.rmSync(homes, { recursive: true, force: true });
      return names;
    },
  };
}
