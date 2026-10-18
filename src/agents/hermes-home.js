// The isolated Hermes home of an `isolated` hermes step (the default): its own
// `HERMES_HOME` under the profile's state dir, so tickets never share memory, skills,
// sessions or `state.db` with each other or with the user's own `~/.hermes`. Only the
// user's `config.yaml` is copied in (refreshed when its hash changes) — never `auth.json`,
// `.env`, memories, skills or sessions — so an isolated run has NO credentials: it works
// with a local (loopback) provider only. `hermesProviderInfo` is a dependency-free scan of
// `config.yaml` that tells which provider a run would use and whether it is local.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/** The isolated Hermes home of a profile (shared by its isolated hermes steps).
 * Exported for the resume command and #395's token export, which read sessions there.
 * @param {string} stateDir */
export function hermesHomeDir(stateDir) {
  return path.join(stateDir, "hermes-home");
}

/** The user's own Hermes home whose `config.yaml` an isolated home copies: the receiver's
 * `HERMES_HOME` when set, else `~/.hermes`. Injectable for tests.
 * @param {NodeJS.ProcessEnv} [env] @param {string} [home] */
export function hermesSourceHome(env = process.env, home = os.homedir()) {
  return env.HERMES_HOME || path.join(home, ".hermes");
}

/** @param {string|Buffer} data */
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/**
 * Create (0700) the isolated home and copy `<sourceHome>/config.yaml` into it (0600) when
 * the copy is missing or differs from the source by sha256. Nothing else is ever copied.
 * A missing source returns `{ok:false}` with the user-facing reason; never throws for it.
 * @param {{stateDir: string, sourceHome: string}} o
 * @returns {{ok: true, home: string, configText: string} | {ok: false, reason: string}}
 */
export function ensureHermesHome({ stateDir, sourceHome }) {
  const src = path.join(sourceHome, "config.yaml");
  /** @type {Buffer} */
  let data;
  try {
    data = fs.readFileSync(src);
  } catch {
    return { ok: false, reason: `hermes step is isolated but ${src} is missing; create it or set isolated:false` };
  }
  const home = hermesHomeDir(stateDir);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const dest = path.join(home, "config.yaml");
  let cur;
  try {
    cur = fs.readFileSync(dest);
  } catch {
    /* missing → copy */
  }
  if (!cur || sha256(cur) !== sha256(data)) {
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, dest);
  }
  return { ok: true, home, configText: data.toString("utf8") };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** @param {string} s */
const unquote = (s) => s.replace(/^(["'])(.*)\1$/, "$2");

/**
 * Which inference provider a hermes run uses and whether it is local — from `config.yaml`
 * text, with no YAML library: an indentation scanner over block mappings that reads
 * `model.provider`, `model.base_url` and `providers.<name>.api|base_url`. Pure.
 * `effective` = `provider` (the step's / profile's) ?? `model.provider`. `local`:
 * true = a `providers:` entry whose URL host is loopback; false = a non-loopback entry, or
 * a provider with no entry while `providers:` parsed cleanly (a built-in cloud provider);
 * null = could not tell (no provider, unparseable text, an entry with no URL) — callers
 * fail open on null.
 * @param {string} text @param {string} [provider]
 * @returns {{effective: string|undefined, local: boolean|null}}
 */
export function hermesProviderInfo(text, provider) {
  /** @type {{indent: number, key: string}[]} */
  const stack = [];
  /** @type {Map<string, string>} */
  const values = new Map();
  /** @type {Set<string>} */
  const providerNames = new Set();
  let hasProviders = false;
  let ok = true;
  /** @type {number|null} block scalar (`|`/`>`) body: skip lines indented past this */
  let blockIndent = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").replace(/\s+$/, "");
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== null) {
      if (indent > blockIndent) continue;
      blockIndent = null;
    }
    if (line.trim() === "---") continue;
    const body = line.trimStart();
    if (body.startsWith("- ") || body === "-") continue; // list items: nothing we read lives in one
    const m = /^("[^"]*"|'[^']*'|[^\s:"'{}[\],][^:]*?):(?:\s+(.*))?$/.exec(body);
    if (!m) {
      ok = false;
      break;
    }
    const key = unquote(m[1].trim());
    const value = (m[2] ?? "").trim();
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const keyPath = [...stack.map((s) => s.key), key];
    if (/^[|>][+-]?\d*$/.test(value)) blockIndent = indent;
    if (keyPath.length === 1 && key === "providers") {
      hasProviders = true;
      if (value && !/^(~|null)$/.test(value)) ok = false; // flow-style `{…}`: not scanned
    }
    if (keyPath.length === 2 && keyPath[0] === "providers") providerNames.add(key);
    if (value) values.set(keyPath.join("."), unquote(value));
    else stack.push({ indent, key });
  }
  const effective = provider || (ok ? values.get("model.provider") : undefined) || undefined;
  if (!ok || !effective) return { effective, local: null };
  // A provider with no `providers:` entry may still carry its URL on `model.base_url`
  // (hermes' `custom` provider); otherwise it is a built-in, i.e. cloud, provider.
  const url = providerNames.has(effective)
    ? (values.get(`providers.${effective}.api`) ?? values.get(`providers.${effective}.base_url`))
    : effective === values.get("model.provider") && values.get("model.base_url");
  if (!providerNames.has(effective) && !url) return { effective, local: hasProviders || values.has("model.provider") ? false : null };
  if (!url) return { effective, local: null };
  try {
    return { effective, local: LOOPBACK.has(new URL(url).hostname) };
  } catch {
    return { effective, local: null };
  }
}

/**
 * The pre-spawn check of an isolated hermes step: prepare its home and refuse a run that
 * could only fail for lack of credentials. Returns the user-facing reason to fail the run
 * without spawning, or undefined to go ahead (incl. when the provider can't be told).
 * @param {{stateDir: string, sourceHome: string, provider?: string}} o
 * @returns {string|undefined}
 */
export function hermesPreflight({ stateDir, sourceHome, provider }) {
  const r = ensureHermesHome({ stateDir, sourceHome });
  if (!r.ok) return r.reason;
  if (hermesProviderInfo(r.configText, provider).local === false) {
    return "hermes step is isolated and has no credentials; use a local provider or set isolated:false";
  }
  return undefined;
}
