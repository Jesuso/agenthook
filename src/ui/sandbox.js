// `ah ui` sandbox readiness card, server side (`GET /api/sandbox-readiness`, docs/web-ui.md).
// Read-only: the three things a sandboxed claude step needs outside agenthook.config.json — the
// container runtime, the agent image, a claude credential in the profile's `.env` — checked with
// doctor's own probes (sandboxRuntimeChecks, sandboxCredentialProblem). Like the config editor it
// loads no config: the raw file at heartbeat.configPath, `.env` parsed in place (never into
// process.env). No fix is ever applied (doctor's image fix runs `docker build`), and no credential
// value leaves this module — a row is a boolean, a label, a note and the CLI command that fixes it.
import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { SANDBOX_CREDENTIAL_VARS, sandboxCredentialProblem } from "../agents/claude.js";
import { execRun, onPath, sandboxRuntimeChecks } from "../commands/doctor.js";
import { tildify } from "../profile.js";
import { DEFAULT_IMAGE } from "../sandbox/image.js";
import { SANDBOX_NAMES } from "../sandbox/names.js";
import { resolveConfigFile } from "./config.js";
import { isObj } from "./rows.js";
import { UI_MAX_BYTES } from "./save.js";

/** @typedef {import('./contract.js').SandboxReadiness} SandboxReadiness */
/** @typedef {SandboxReadiness['rows'][number]} ReadinessRow */

/** doctor's fix as a CLI remedy: a manual one as-is, the image build as `doctor --fix`.
 * @param {import('../commands/doctor.js').Fix|undefined} fix */
const remedyOf = (fix) => (!fix ? undefined : "manual" in fix ? fix.manual : "agenthook doctor --fix");

/** The parsed `.env` beside the config, or {} when it's missing, not a regular file, or too big.
 * @param {string} file */
function readDotEnv(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > UI_MAX_BYTES) return {};
    return util.parseEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * The profile's sandbox readiness, or null when the profile is unknown or publishes no config.
 * `type` (validated by the caller against SANDBOX_NAMES) overrides the saved `sandbox.type`, so a
 * sandbox toggled on in the form but not yet saved is checked too; the image is always the
 * config's (else DEFAULT_IMAGE), never the request's.
 * @param {string} registry @param {string} profile
 * @param {{ type?: string, run?: import('../types.js').IngressRun, has?: (bin: string) => boolean }} [opts]
 * @returns {Promise<SandboxReadiness|null>}
 */
export async function sandboxReadiness(registry, profile, { type, run = execRun, has = onPath } = {}) {
  const file = resolveConfigFile(registry, profile);
  if (!file) return null;
  /** @type {any} */
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    raw = null;
  }
  const sb = isObj(raw) && isObj(raw.sandbox) ? raw.sandbox : undefined;
  // A saved type outside SANDBOX_NAMES fails validateRawConfig; it never names a binary to probe.
  const runtime = type || (SANDBOX_NAMES.includes(sb?.type) ? sb.type : undefined);
  if (!runtime) return { enabled: false, rows: [] };
  const image = typeof sb?.image === "string" && sb.image ? sb.image : DEFAULT_IMAGE;

  /** @type {ReadinessRow[]} */
  const rows = [];
  // No `build` passed and no fix applied: the image check only inspects.
  const checks = await sandboxRuntimeChecks({ type: runtime, image }, { run, has, images: [image] });
  const down = checks.slice(0, 2).find((c) => !c.ok);
  if (down) {
    const remedy = remedyOf(down.fix);
    rows.push({ id: "runtime", ok: false, label: down.label, ...(down.note ? { note: down.note } : {}), ...(remedy ? { remedy } : {}) });
    rows.push({ id: "image", ok: false, label: `sandbox image present: ${image}`, note: "not checked — runtime unavailable", ...(remedy ? { remedy } : {}) });
  } else {
    const info = checks[1];
    rows.push({ id: "runtime", ok: true, label: info.label, ...(info.note ? { note: info.note } : {}) });
    const img = checks[2];
    const remedy = img.ok ? undefined : remedyOf(img.fix);
    rows.push({ id: "image", ok: img.ok, label: img.label, ...(img.note ? { note: img.note } : {}), ...(remedy ? { remedy } : {}) });
  }

  const dotEnv = path.join(path.dirname(file), ".env");
  const problem = sandboxCredentialProblem(readDotEnv(dotEnv));
  rows.push({
    id: "credential",
    ok: !problem,
    label: "claude credential in the profile's .env",
    note: problem ? `no ${SANDBOX_CREDENTIAL_VARS.join(" / ")} in ${tildify(dotEnv)}` : `set in ${tildify(dotEnv)}`,
    ...(problem ? { remedy: `claude setup-token, then add CLAUDE_CODE_OAUTH_TOKEN=… to ${tildify(dotEnv)} (or ANTHROPIC_API_KEY)` } : {}),
  });
  return { enabled: true, type: runtime, image, rows };
}
