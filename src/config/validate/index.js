// Structural validation of a raw (uninterpolated) config object: the top-level checks, the
// per-step loop (delegated to validate/steps.js), and the secret-field helpers the UI config
// editor and the server side both need.
import { identityErrors } from "../../shared/identity.js";
import { digestErrors, summariesErrors } from "../../shared/digest-config.js";
import { pricingErrors } from "../../shared/pricing.js";
import { energyErrors } from "../../shared/energy.js";
import { quotaErrors } from "../../shared/quota.js";
import { sinkErrors } from "../../shared/sinks-config.js";
import { reposErrors } from "../../shared/repos-config.js";
import { autoMergeErrors } from "../../auto-merge.js";
import { AGENT_NAMES } from "../../agents/names.js";
import { SECRET_FIELDS, isEnvRef } from "../../shared/sensitive.js";
import { NAME_ERROR, STATE_ID_ERROR, BRANCH_PREFIX_RE, validName, ENV_PATTERN_RE, isAgentName, label } from "./common.js";
import { harnessesErrors } from "./harnesses.js";
import { stepErrors } from "./steps.js";
import { sandboxErrors } from "./sandbox.js";

/**
 * Structural validation of a config object WITHOUT resolving it: pure (no fs, no env, no
 * path resolution), never throws for any JSON value, and collects every error in check
 * order rather than stopping at the first. `${VAR}` strings are opaque values. loadConfig
 * runs it on the interpolated config and throws `errors[0]`; the UI config editor runs it
 * on the raw file (secrets never leave the env). The two checks that need resolved paths —
 * repos sharing a path, a repoPath matching no declared repo — stay in resolveRepos.
 * @param {any} raw
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function validateRawConfig(raw) {
  /** @type {string[]} */
  const errors = [];
  // Only a null/undefined root would crash the property reads below; any other non-object
  // simply fails the named-key checks (as loadConfig always has).
  if (raw == null) return { ok: false, errors: [`config: the config must be a JSON object.`] };
  const cfg = raw;

  if (!validName(cfg.name)) errors.push(NAME_ERROR);
  if (cfg.stateId !== undefined && !validName(cfg.stateId)) errors.push(STATE_ID_ERROR);
  const tracker = cfg.tracker;
  if (!tracker?.type) errors.push(`config: "tracker.type" is required (e.g. "asana").`);
  if (!cfg.repoPath && cfg.repos == null) {
    errors.push(`config: "repoPath" is required (the repo agents work in), unless a "repos" block declares them.`);
  }

  errors.push(...reposErrors(cfg.repos));

  if (cfg.branchPrefix != null) {
    const bp = cfg.branchPrefix;
    const ok =
      typeof bp === "string" &&
      BRANCH_PREFIX_RE.test(bp) &&
      !bp.includes("..") &&
      bp.slice(0, -1).split("/").every((c) => !c.startsWith(".") && !c.endsWith(".lock"));
    if (!ok) {
      errors.push(
        `config: "branchPrefix" must be slash-separated components of [A-Za-z0-9._-]+ ending in "/" (e.g. "agent/", "team/bot/"); no "..", and no component starting with "." or ending with ".lock".`,
      );
    }
  }

  if (cfg.agent != null && !isAgentName(cfg.agent)) {
    errors.push(`config: "agent" ${JSON.stringify(cfg.agent)} is not a known agent (${AGENT_NAMES.join(", ")}).`);
  }

  if (cfg.agentProvider != null && (typeof cfg.agentProvider !== "string" || !cfg.agentProvider.trim())) {
    errors.push(`config: "agentProvider" must be a non-empty string.`);
  }

  if (cfg.agentEnvPassthrough != null) {
    if (!Array.isArray(cfg.agentEnvPassthrough)) errors.push(`config: "agentEnvPassthrough" must be an array of variable names, PREFIX*, or "*".`);
    else {
      for (const n of cfg.agentEnvPassthrough) {
        if (n !== "*" && (typeof n !== "string" || !ENV_PATTERN_RE.test(n))) errors.push(`config: "agentEnvPassthrough" entry ${JSON.stringify(n)} must be a variable name, a PREFIX*, or "*".`);
      }
    }
  }

  if (cfg.githubRunToken != null && typeof cfg.githubRunToken !== "boolean") {
    errors.push(`config: "githubRunToken" must be true or false.`);
  }

  if (cfg.overlapGuard != null && typeof cfg.overlapGuard !== "boolean") {
    errors.push(`config: "overlapGuard" must be true or false.`);
  }

  if (cfg.attribution != null && typeof cfg.attribution !== "boolean") {
    errors.push(`config: "attribution" must be true or false.`);
  }

  if (cfg.language != null) {
    let valid = typeof cfg.language === "string" && cfg.language.trim() !== "";
    if (valid) {
      try {
        Intl.getCanonicalLocales(cfg.language);
      } catch (e) {
        if (e instanceof RangeError) valid = false;
      }
    }
    if (!valid) errors.push(`config: "language" must be a BCP-47 language tag (e.g. "es").`);
  }

  const harnesses = cfg.harnesses;
  errors.push(...harnessesErrors(harnesses));

  const pipeline = Array.isArray(tracker?.pipeline) && tracker.pipeline.length ? tracker.pipeline : null;
  if (!pipeline) {
    errors.push(`config: "tracker.pipeline" is required (a non-empty array of steps).`);
  }
  const ids = new Set();
  (pipeline ?? []).forEach((/** @type {import('./common.js').RawNode} */ step, /** @type {number} */ i) => stepErrors(errors, ids, cfg, harnesses, step, i));

  const onMerge = (pipeline ?? []).filter((/** @type {any} */ s) => s && typeof s === "object" && s.completeOnMerge);
  if (onMerge.length > 1) {
    errors.push(`config: only one pipeline step may set completeOnMerge (found ${onMerge.map((/** @type {any} */ s) => label(s.id)).join(", ")}).`);
  }

  errors.push(...sinkErrors(cfg.sinks));
  errors.push(...identityErrors(cfg.ui));
  errors.push(...digestErrors(cfg.digest));
  errors.push(...summariesErrors(cfg.summaries));
  errors.push(...pricingErrors(cfg.pricing));
  errors.push(...energyErrors(cfg.energy));
  errors.push(...quotaErrors(cfg.quota));
  errors.push(...sandboxErrors(cfg.sandbox));

  // GitHub App auth (src/github/auth.js). Under it the identity can't be derived from the token
  // (an installation token is the App's bot), so the tracker's assigneeLogin is required —
  // fail closed rather than fall back to /user or `viewer`.
  if (tracker?.auth != null) {
    if (tracker.type !== "github" && tracker.type !== "github-projects") errors.push(`config: "tracker.auth" is only supported on the github and github-projects trackers.`);
    else {
      errors.push(...githubAuthErrors(tracker.auth, "tracker.auth"));
      const login = tracker.assigneeLogin;
      if (tracker.auth?.type === "app" && (typeof login !== "string" || !login.trim())) {
        errors.push(`config: GitHub App auth needs "tracker.assigneeLogin" — the human login the App acts for (scoping and the @agent author check use it; it is never derived from the App token).`);
      }
    }
  }
  if (cfg.forge?.auth != null) {
    if (cfg.forge.type !== "github") errors.push(`config: "forge.auth" is only supported on the github forge.`);
    else errors.push(...githubAuthErrors(cfg.forge.auth, "forge.auth"));
  }

  // Optional forge axis (PR awareness). Absent = undefined, nothing changes.
  if (cfg.forge && !cfg.forge.type) errors.push(`config: "forge.type" is required when a forge block is set (e.g. "github").`);
  // No ciTarget lookup against a missing pipeline: that would only add a spurious "not a step id".
  if (cfg.forge?.ciTarget != null && pipeline) {
    const t = pipeline.find((/** @type {any} */ s) => s && typeof s === "object" && s.id === cfg.forge.ciTarget);
    if (!t) errors.push(`config: forge.ciTarget "${label(cfg.forge.ciTarget)}" is not a pipeline step id.`);
    else if (t.manual) errors.push(`config: forge.ciTarget "${label(t.id)}" is a manual step (a red-CI bounce needs an agent step).`);
  }
  errors.push(...autoMergeErrors(cfg.forge, pipeline, cfg.repos));

  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * Structural errors in a GitHub `auth` block (`tracker.auth` / `forge.auth`). Pure.
 * @param {any} auth @param {string} at @returns {string[]}
 */
export function githubAuthErrors(auth, at) {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return [`config: "${at}" must be an object ({ "type": "app", … }).`];
  if (auth.type !== "app") return [`config: "${at}.type" must be "app" (a GitHub App).`];
  /** @type {string[]} */
  const out = [];
  /** @param {any} v */
  const filled = (v) => (typeof v === "string" && v.trim() !== "") || (typeof v === "number" && Number.isFinite(v));
  if (!filled(auth.appId)) out.push(`config: "${at}.appId" is required (the GitHub App's id).`);
  if (!filled(auth.installationId)) out.push(`config: "${at}.installationId" is required (the App's installation on the repo/org).`);
  const hasKey = typeof auth.privateKey === "string" && auth.privateKey.trim() !== "";
  const hasPath = typeof auth.privateKeyPath === "string" && auth.privateKeyPath.trim() !== "";
  if (hasKey === hasPath) out.push(`config: "${at}" needs exactly one of "privateKey" (the PEM, e.g. "\${GITHUB_APP_PRIVATE_KEY}") or "privateKeyPath".`);
  return out;
}

/** The list lives in src/shared/sensitive.js (the config editor bundles it); re-exported for the server side. */
export { SECRET_FIELDS };

/**
 * The concrete paths (e.g. "tracker.token", "sinks[1].botToken") of SECRET_FIELDS holding a
 * literal: a non-empty string that is not exactly one `${VAR}` ref. Pure — never reads env.
 * Non-strings (`webhookSecret: false` opt-out, null), "" and missing fields are not reported.
 * @param {any} raw @returns {string[]}
 */
export function literalSecrets(raw) {
  /** @type {string[]} */
  const out = [];
  /** @param {any} node @param {string[]} segs @param {string} at */
  const walk = (node, segs, at) => {
    if (!segs.length) {
      if (typeof node === "string" && node !== "" && !isEnvRef(node)) out.push(at);
      return;
    }
    if (!node || typeof node !== "object") return;
    const [seg, ...rest] = segs;
    if (seg.endsWith("[*]")) {
      const key = seg.slice(0, -3);
      const arr = node[key];
      if (Array.isArray(arr)) arr.forEach((el, i) => walk(el, rest, `${at ? `${at}.` : ""}${key}[${i}]`));
      return;
    }
    if (Object.hasOwn(node, seg)) walk(node[seg], rest, at ? `${at}.${seg}` : seg);
  };
  for (const field of SECRET_FIELDS) walk(raw, field.split("."), "");
  return out;
}
