// The sandbox backend names, import-free on purpose: src/config.js validates `sandbox.type`
// against them and must not pull the Node-side registry (src/sandbox/index.js). A test holds
// the two equal (like src/agents/names.js).

/** Every registered sandbox backend. */
export const SANDBOX_NAMES = /** @type {const} */ (["docker", "podman"]);

/** Every `egress.mode` (src/sandbox/egress.js): allowlist (the default) = only the model API,
 * forge, tracker and allowed hosts; none = no network; open = unrestricted. */
export const EGRESS_MODES = /** @type {const} */ (["allowlist", "open", "none"]);

/** The vars `wrap()` (src/sandbox/container.js) sets for the egress proxy, in allowlist mode:
 * reserved in a service's `agentEnv` in every mode so an operator can't set a value that's
 * silently ignored (allowlist) or silently take effect where there's no proxy to override it
 * (open/none). */
export const EGRESS_PROXY_ENV_KEYS = /** @type {const} */ (["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY", "YARN_HTTPS_PROXY", "YARN_HTTP_PROXY"]);

/** Whether a step's runs go through the profile's sandbox: a `sandbox` block is set and the
 * step didn't opt out with `sandbox: false`. Pure.
 * @param {{sandbox?: unknown}} cfg @param {{sandbox?: boolean}|undefined} step */
export const isSandboxed = (cfg, step) => !!cfg.sandbox && step?.sandbox !== false;
