import { spawnSync } from "node:child_process";
import { onPath } from "../exec.js";
import { DEFAULT_IMAGE, AGENT_DOCKERFILE, buildImageArgs } from "./image.js";

/** The default image builder: `<bin> build -t <image> -` with the Dockerfile on stdin.
 * @param {string} bin @param {string[]} args @param {string} dockerfile */
export const buildImage = (bin, args, dockerfile) => spawnSync(bin, args, { input: dockerfile, stdio: ["pipe", "inherit", "inherit"] });

/**
 * The sandbox runtime + image preflight: the runtime CLI on PATH (`$<TYPE>` overrides it) and
 * reachable — stopping at the first failure — then each of `images` present (fix: build the
 * default recipe). `image` is the profile's agent image; any other entry is labelled the egress
 * proxy's. Shared with `ah ui`'s read-only readiness card (src/ui/sandbox.js).
 * @param {{ type: string, image: string }} sandbox
 * @param {{run: import('../types/ingress.js').IngressRun, has?: (bin: string) => boolean, build?: (bin: string, args: string[], dockerfile: string) => { status: number|null }, images?: string[]}} io
 * @returns {Promise<import('../types/doctor.js').Check[]>}
 */
export async function sandboxRuntimeChecks({ type: runtime, image }, { run, has = onPath, build = buildImage, images = [image] }) {
  const env = runtime.toUpperCase();
  const bin = process.env[env] || runtime;
  /** @type {import('../types/doctor.js').Check[]} */
  const out = [];
  if (!has(bin)) {
    out.push({ ok: false, label: `sandbox: ${runtime} binary on PATH`, note: bin, fix: { manual: `install ${runtime} or put it on PATH (or set $${env})` } });
    return out;
  }
  out.push({ ok: true, label: `sandbox: ${runtime} binary on PATH`, note: bin });
  const info = await run(bin, ["info"], { timeoutMs: 30_000 }).catch((e) => ({ code: 1, stdout: "", stderr: e.message }));
  const rootNote = runtime === "docker" ? "docker group membership is root-equivalent; prefer rootless podman" : "";
  if (info.code !== 0) {
    out.push({ ok: false, label: `sandbox: \`${bin} info\` succeeds`, note: (info.stderr || info.stdout).trim().split("\n")[0], fix: { manual: `start the ${runtime} daemon/socket, or give this user access to it` } });
    return out;
  }
  out.push({ ok: true, label: `sandbox: \`${bin} info\` succeeds`, note: rootNote });
  for (const img of new Set(images)) {
    const r = await run(bin, ["image", "inspect", img], { timeoutMs: 30_000 }).catch((e) => ({ code: 1, stdout: "", stderr: e.message }));
    out.push({
      ok: r.code === 0,
      label: `sandbox image present: ${img}${img !== image ? " (egress proxy)" : ""}`,
      note: r.code === 0 ? "" : "missing",
      fix: img === DEFAULT_IMAGE
        ? {
            describe: `build ${img}`,
            apply: () => {
              const b = build(bin, buildImageArgs(runtime, img), AGENT_DOCKERFILE);
              if (b.status !== 0) throw new Error(`\`${bin} build\` exited ${b.status}`);
            },
          }
        : { manual: `${runtime} build -t ${img} <dir with a Dockerfile that starts FROM ${DEFAULT_IMAGE}> — it needs sh, git, gh and the agent CLI on PATH — see docs/sandbox.md` },
    });
  }
  return out;
}
