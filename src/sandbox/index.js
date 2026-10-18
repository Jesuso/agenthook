// Sandbox registry — an optional blind axis like src/ingress/. A sandbox answers "where does
// one agent run execute": unset = on the host (as always); set = each run in its own container
// with only its worktree, the git metadata it commits through, one transcript dir and a
// per-run verdict dir mounted. dispatch wraps the spawn through it; boot checks it and reaps
// orphaned runs. Keys must equal the import-free SANDBOX_NAMES (src/sandbox/names.js).
import { createContainerSandbox } from "./container.js";

/** @type {Record<string, import('../types.js').SandboxFactory>} */
export const SANDBOXES = {
  docker: (cfg, opts) => createContainerSandbox(cfg, { runtime: "docker", ...opts }),
  podman: (cfg, opts) => createContainerSandbox(cfg, { runtime: "podman", ...opts }),
};

/**
 * null when `cfg.sandbox` is unset (runs on the host, today's behavior). Throws on an unknown type.
 * @param {import('../types.js').Config} cfg
 * @returns {import('../types.js').Sandbox|null}
 */
export function createSandbox(cfg) {
  if (!cfg.sandbox) return null;
  const type = cfg.sandbox.type;
  const factory = Object.hasOwn(SANDBOXES, type) ? SANDBOXES[type] : undefined;
  if (!factory) throw new Error(`unknown sandbox "${type}". Known: ${Object.keys(SANDBOXES).join(", ")}`);
  return factory(cfg);
}
