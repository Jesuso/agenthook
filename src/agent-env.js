// The agent spawn environment (#470): an allowlist, not the receiver's whole env. A webhook-
// started agent only needs process basics, its own CLI's variables and the tracker token its
// prompt names — not the ingress authtoken, an App private key or a webhook secret. Import-free
// and pure, so dispatch, doctor and the UI can all use it.

/** Names every agent gets. A trailing "*" is a prefix match. */
export const BASE_AGENT_ENV = [
  // process basics
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "TZ",
  // locale / terminal
  "LANG", "LANGUAGE", "LC_*", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR",
  // per-user dirs; the D-Bus session bus is what gh's keyring uses on Linux
  "XDG_*", "DBUS_SESSION_BUS_ADDRESS",
  // network plumbing (#473's proxy will rely on these)
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  // git over ssh
  "SSH_AUTH_SOCK",
  // toolchain locations the repo's tests may need (paths, not secrets)
  "JAVA_HOME", "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME", "PYENV_ROOT", "VIRTUAL_ENV",
  "NVM_DIR", "VOLTA_HOME", "BUN_INSTALL", "PNPM_HOME",
  // Windows process basics (matched case-insensitively on win32)
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "PROGRAMDATA", "PROGRAMFILES", "HOMEDRIVE", "HOMEPATH",
];

/** The parent Claude Code session's own variables, set when the receiver is started from inside
 * one: its session id, IPC socket and messaging token (which would let an agent message that
 * session), entrypoint, pid and effort. `CLAUDE_*` passthrough would otherwise hand them to every
 * claude run; they are stripped whatever the allowlist says (a step `env` can still set one). */
export const HOST_SESSION_ENV = /** @type {const} */ ([
  "CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_*", "CLAUDE_CODE_BRIDGE_*", "CLAUDE_CODE_MESSAGING_*",
]);

/** The allowlist for one agent run, in order: the base names, the agent CLI's `envPassthrough`,
 * the tracker prompt's `agentEnv`, the forge's `agentEnv`, the operator's `agentEnvPassthrough`. Pure.
 * @param {{agent?: readonly string[], tracker?: readonly string[], forge?: readonly string[], operator?: readonly string[]}} [o]
 * @returns {string[]} */
export function agentEnvAllow({ agent = [], tracker = [], forge = [], operator = [] } = {}) {
  return [...BASE_AGENT_ENV, ...agent, ...tracker, ...forge, ...operator];
}

/** Does `name` match a pattern list ("NAME", "PREFIX*", or "*")? Case-insensitive on win32
 * (its env names are). Pure.
 * @param {string} name @param {readonly string[]} patterns @param {string} [platform] */
export function envNameMatches(name, patterns, platform = process.platform) {
  const fold = platform === "win32" ? (/** @type {string} */ s) => s.toUpperCase() : (/** @type {string} */ s) => s;
  const n = fold(name);
  return patterns.some((p) => {
    const q = fold(p);
    return q.endsWith("*") ? n.startsWith(q.slice(0, -1)) : n === q;
  });
}

/** A name that looks like a credential. Pure. @param {string} name */
export function looksSecret(name) {
  return /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIALS?)$/i.test(name) || /^AWS_(ACCESS|SECRET|SESSION)_/i.test(name);
}

/**
 * The agent env. `source` (process.env) is filtered to `allow`, minus HOST_SESSION_ENV and the
 * names in `strip` (a run's per-run credentials replace them, #474), then each of `layers` is spread on top, in
 * order. Layers are explicit operator or adapter choices, so they are never filtered.
 * Undefined values are dropped. Pure.
 * @param {{source: Record<string,string|undefined>, allow: readonly string[], strip?: readonly string[], layers?: (Record<string,string>|undefined)[], platform?: string}} o
 * @returns {Record<string,string>}
 */
export function buildAgentEnv({ source, allow, strip = [], layers = [], platform }) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && envNameMatches(k, allow, platform) && !envNameMatches(k, HOST_SESSION_ENV, platform) && !envNameMatches(k, strip, platform)) out[k] = v;
  for (const layer of layers) for (const [k, v] of Object.entries(layer ?? {})) if (v !== undefined) out[k] = v;
  return out;
}

/** Names in `source` that `allow` (or HOST_SESSION_ENV) drops (sorted). Doctor and tests use it. Pure.
 * @param {{source: Record<string,string|undefined>, allow: readonly string[], platform?: string}} o @returns {string[]} */
export function strippedNames({ source, allow, platform }) {
  return Object.keys(source)
    .filter((k) => source[k] !== undefined && (!envNameMatches(k, allow, platform) || envNameMatches(k, HOST_SESSION_ENV, platform)))
    .sort();
}
