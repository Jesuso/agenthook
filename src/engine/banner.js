// The boot `fullAuto` banner (pure): how loud the boot log is about agents running with their
// CLI's skip-permissions flag depends on whether those runs are sandboxed. Warn only — it never
// refuses and never exits. Names no sandbox runtime (`cfg.sandbox.type` is printed as-is).
import os from "node:os";
import { isSandboxed } from "../sandbox/names.js";

/**
 * The boot banner for `cfg.fullAuto`: a ⚠ block when no sandbox is configured (or some steps opt
 * out with `sandbox:false`), a one-line note when every non-manual step runs sandboxed, null when
 * fullAuto is off. See docs/sandbox.md.
 * @param {Pick<import('../types.js').Config, 'fullAuto'|'sandbox'|'pipeline'>} cfg
 * @param {{user?: string}} [o]  `user`: who runs the receiver (default `os.userInfo().username`)
 * @returns {string|null}
 */
export function fullAutoBanner(cfg, { user = os.userInfo().username } = {}) {
  if (!cfg.fullAuto) return null;
  const outside = cfg.sandbox ? (cfg.pipeline ?? []).filter((s) => !s.manual && !isSandboxed(cfg, s)).map((s) => s.id) : [];
  if (cfg.sandbox && !outside.length) {
    return `[boot] fullAuto inside the ${cfg.sandbox.type} sandbox — each run sees only its worktree; egress ${cfg.sandbox.egress?.mode ?? "allowlist"}`;
  }
  const head = cfg.sandbox ? `fullAuto is ON and step(s) ${outside.join(", ")} run OUTSIDE the sandbox` : "fullAuto is ON with NO sandbox";
  return (
    `\n  ⚠  ${head} — agents run with their CLI's skip-permissions flag\n` +
    `     directly on this host. A verified webhook executes code here as ${user}; the only gate\n` +
    `     is the HMAC signature + a non-guessable URL. Configure a per-run sandbox ("sandbox" in\n` +
    `     the config, docs/sandbox.md) or set fullAuto:false (headless agents then cannot run\n` +
    `     privileged tools unless allowed — they never prompt). agenthook doctor shows the\n` +
    `     isolation report.\n`
  );
}
