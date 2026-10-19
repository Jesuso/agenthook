// Per-run GitHub App tokens for agents (#474). Under App auth the receiver mints its own
// hour-long installation token (src/github-auth.js); an agent run gets a SEPARATE one, minted
// for that run only: scoped to the run's repo(s), limited to what the step kind needs (never
// `workflows`, admin or secrets), revoked when the run ends.
//
// A run can outlive its token (DEFAULT_MAX_MINUTES is 120, a token lives 1h and can't be
// extended), so the token never goes in an env var. It lives in a per-run `gh` config dir
// (`GH_CONFIG_DIR`) that a timer rewrites before expiry; `gh` and the git credential helper
// (`!gh auth git-credential`) read it again on every call. GH_TOKEN/GITHUB_TOKEN are stripped
// from the run's env because `gh` prefers an env token over its config.
//
// Run tokens never go through github-auth.js's cache, and an agent never gets the receiver's
// cached token.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mintInstallationToken, isAppAuth } from "./github-auth.js";

const API = "https://api.github.com";
// Re-mint a run token this long before its `expires_at`.
export const RUN_TOKEN_REFRESH_MS = 10 * 60 * 1000;
// A failed refresh retries this often, until the current token expires.
export const RUN_TOKEN_RETRY_MS = 60 * 1000;
/** Allowlisted names removed from a run-token run's env: `gh` prefers an env token over its
 * config, and an SSH agent would let git push with the operator's key. SSH_AUTH_SOCK stays when
 * the code isn't on github.com (an issues-only token): those pushes still need it. */
export const RUN_TOKEN_STRIP = /** @type {string[]} */ (["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK"]);

/** The permission set a step kind's run token gets (unknown/absent kind = implement). Never
 * `workflows`, `administration`, `secrets`, `actions: write` or an org permission. Pure.
 * @param {string} [kind] @returns {Record<string, "read"|"write">} */
export function runTokenPermissions(kind) {
  if (kind === "triage") return { metadata: "read", contents: "read", issues: "write" };
  if (kind === "review") return { metadata: "read", contents: "read", pull_requests: "write", issues: "write", checks: "read", statuses: "read" };
  return { metadata: "read", contents: "write", pull_requests: "write", issues: "write", checks: "read", statuses: "read", actions: "read" };
}

/** The repos one run token covers, as names inside one account (the API's `repositories`
 * field takes names, not owner/name). Throws when the two repos are under different accounts.
 * A null side is left out. Pure.
 * @param {{codeRepo: string|null, issueRepo: string|null}} o  each "owner/name" or null
 * @returns {{owner: string, repositories: string[]}|null}  null when both are null */
export function runTokenRepos({ codeRepo, issueRepo }) {
  const split = (/** @type {string|null} */ r) => (r ? /** @type {[string, string]} */ (String(r).split("/")) : null);
  const code = split(codeRepo);
  const issue = split(issueRepo);
  if (code && issue && code[0].toLowerCase() !== issue[0].toLowerCase()) {
    throw new Error(`issue repo ${issueRepo} and code repo ${codeRepo} are under different accounts — one installation token cannot cover both`);
  }
  const first = code ?? issue;
  if (!first) return null;
  /** @type {string[]} */
  const repositories = [];
  for (const r of [code, issue]) if (r && !repositories.some((n) => n.toLowerCase() === r[1].toLowerCase())) repositories.push(r[1]);
  return { owner: first[0], repositories };
}

/** The access_tokens body for one run: its repos and the kind's permissions. With no code repo
 * on github.com the token covers the issue repo only, so permissions narrow to metadata + issues.
 * Null when neither repo is on github.com (nothing to scope). Pure.
 * @param {{codeRepo: string|null, issueRepo: string|null, kind?: string}} o
 * @returns {{owner: string, repositories: string[], permissions: Record<string, "read"|"write">}|null} */
export function runTokenBody({ codeRepo, issueRepo, kind }) {
  const repos = runTokenRepos({ codeRepo, issueRepo });
  if (!repos) return null;
  const all = runTokenPermissions(kind);
  /** @type {Record<string, "read"|"write">} */
  const permissions = codeRepo ? all : { metadata: "read", issues: all.issues ?? "read" };
  return { ...repos, permissions };
}

/** "owner/name" from a GitHub issue or PR web URL, else null. Pure. @param {string|null|undefined} url */
export function issueRepoFromUrl(url) {
  const m = typeof url === "string" ? url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/\d+/) : null;
  return m ? `${m[1]}/${m[2]}` : null;
}

/** `hosts.yml` for github.com holding `token`, in both the legacy single-account form and the
 * multi-account `users:` form, so old and new `gh` both read it. Pure. @param {string} token */
export function ghHostsYml(token) {
  return [
    "github.com:",
    "    users:",
    "        x-access-token:",
    `            oauth_token: ${token}`,
    "    git_protocol: https",
    "    user: x-access-token",
    `    oauth_token: ${token}`,
    "",
  ].join("\n");
}

/** Env-based git config (git ≥ 2.31) for a run: github.com credentials come from
 * `gh auth git-credential` only (inherited helpers reset for github.com), and SSH github
 * remotes are rewritten to HTTPS so a push uses the run token, not the operator's SSH key. Pure.
 * @returns {Record<string, string>} */
export function runGitEnv() {
  const pairs = [
    ["credential.https://github.com.helper", ""],
    ["credential.https://github.com.helper", "!gh auth git-credential"],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
  ];
  /** @type {Record<string, string>} */
  const env = { GIT_CONFIG_COUNT: String(pairs.length), GIT_TERMINAL_PROMPT: "0" };
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

/** Revoke an installation token (`DELETE /installation/token`, 204). Best-effort: never throws.
 * @param {string} token @param {{fetch?: typeof fetch}} [o] @returns {Promise<boolean>} */
export async function revokeRunToken(token, { fetch: f = (...a) => globalThis.fetch(...a) } = {}) {
  try {
    const res = await f(`${API}/installation/token`, { method: "DELETE", headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
    return res.status === 204;
  } catch {
    return false;
  }
}

/** Write `file` atomically (tmp + rename), mode 0600. @param {string} file @param {string} text */
function writeSecret(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/**
 * Mint one run's token and lay out its `gh` config dir (I/O). `dir` is wiped first (a crashed
 * run's leftovers), then created 0700 with `dir/gh/hosts.yml` 0600. A timer re-mints the token
 * with the same body before it expires and rewrites hosts.yml; the old token is left to expire
 * so an in-flight call isn't cut off. A failed refresh logs one line and retries every minute
 * until expiry — it never kills the run. `dispose` stops refreshing, revokes the current token
 * and removes `dir`; idempotent, never throws. Null when neither repo is on github.com.
 * @param {import('./types.js').GithubAuthConfig} auth
 * @param {{codeRepo: string|null, issueRepo: string|null, kind?: string, dir: string, log?: (line: string) => void,
 *   fetch?: typeof fetch, now?: () => number, setTimeout?: (fn: () => void, ms: number) => any, clearTimeout?: (t: any) => void}} o
 * @returns {Promise<import('./types.js').RunCredentials|null>}
 */
export async function createRunCredentials(auth, { codeRepo, issueRepo, kind, dir, log = () => {}, fetch: f = (...a) => globalThis.fetch(...a), now = Date.now, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout }) {
  const scoped = runTokenBody({ codeRepo, issueRepo, kind });
  if (!scoped) return null;
  const body = { repositories: scoped.repositories, permissions: scoped.permissions };
  const ghDir = path.join(dir, "gh");
  const hosts = path.join(ghDir, "hosts.yml");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(ghDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.chmodSync(ghDir, 0o700);

  let { token, expiresAt } = await mintInstallationToken(auth, body, { fetch: f, now });
  try {
    writeSecret(hosts, ghHostsYml(token));
    // `version: "1"` = already on the multi-account layout, so gh never migrates (rewrites) hosts.yml.
    writeSecret(path.join(ghDir, "config.yml"), `version: "1"\ngit_protocol: https\nprompt: disabled\n`);
  } catch (e) {
    await revokeRunToken(token, { fetch: f });
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }

  let disposed = false;
  /** @type {any} */
  let timer = null;
  /** @param {number} ms */
  const schedule = (ms) => {
    timer = st(refresh, Math.max(0, ms));
    timer?.unref?.();
  };
  async function refresh() {
    timer = null;
    if (disposed) return;
    try {
      const next = await mintInstallationToken(auth, body, { fetch: f, now });
      if (disposed) {
        await revokeRunToken(next.token, { fetch: f });
        return;
      }
      writeSecret(hosts, ghHostsYml(next.token));
      ({ token, expiresAt } = next);
      schedule(Math.max(RUN_TOKEN_RETRY_MS, expiresAt - RUN_TOKEN_REFRESH_MS - now()));
    } catch (e) {
      if (disposed) return;
      const left = expiresAt - now();
      log(`GitHub run token refresh failed: ${e?.message ?? e}${left > 0 ? ` — retrying every ${RUN_TOKEN_RETRY_MS / 1000}s until it expires` : " — the token has expired"}`);
      if (left > 0) schedule(Math.min(RUN_TOKEN_RETRY_MS, left));
    }
  }
  schedule(Math.max(RUN_TOKEN_RETRY_MS, expiresAt - RUN_TOKEN_REFRESH_MS - now()));

  const writes = Object.entries(scoped.permissions)
    .filter(([, v]) => v === "write")
    .map(([k]) => `${k}:write`);
  const repoList = scoped.repositories.map((r) => `${scoped.owner}/${r}`).join(", ");
  return {
    env: { GH_CONFIG_DIR: ghDir, ...runGitEnv() },
    strip: codeRepo ? [...RUN_TOKEN_STRIP] : RUN_TOKEN_STRIP.filter((n) => n !== "SSH_AUTH_SOCK"),
    label: `GitHub App token: ${repoList} (${writes.join(", ") || "read-only"}), expires ${new Date(expiresAt).toISOString().slice(11, 16)} UTC`,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      if (timer) ct(timer);
      timer = null;
      await revokeRunToken(token, { fetch: f });
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/** @type {Map<string, string>} */
const origins = new Map();

/** The `origin` remote URL of a checkout ("" when it has none), cached per path for the process.
 * @param {string} repoPath @returns {string} */
export function originUrl(repoPath) {
  let url = origins.get(repoPath);
  if (url === undefined) {
    try {
      url = execFileSync("git", ["-C", repoPath, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      url = "";
    }
    origins.set(repoPath, url);
  }
  return url;
}

/**
 * The `runCredentials` method a GitHub adapter (tracker or forge) exposes. It returns null —
 * the #470 env applies — unless `block` is on GitHub App auth and `githubRunToken` isn't false.
 * Any failure to scope throws `GitHub run token: <why>`, and dispatch refuses the run.
 * @param {{auth?: import('./types.js').GithubAuthConfig}} block  the adapter's config block
 * @param {Pick<import('./types.js').Config, 'githubRunToken'>} cfg
 * @param {{codeRepo: (repoPath: string) => string|null, issueRepo?: string|null}} o  the adapter's code-repo resolver and issue-repo fallback
 * @returns {NonNullable<import('./types.js').Adapter['runCredentials']>}
 */
export function githubRunCredentials(block, cfg, { codeRepo, issueRepo }) {
  return async ({ step, task, repoPath, dir, log }) => {
    if (!isAppAuth(block) || cfg.githubRunToken === false) return null;
    try {
      return await createRunCredentials(/** @type {import('./types.js').GithubAuthConfig} */ (block.auth), {
        codeRepo: codeRepo(repoPath),
        issueRepo: issueRepoFromUrl(task.url) ?? issueRepo ?? null,
        kind: step.kind,
        dir,
        log,
      });
    } catch (e) {
      throw new Error(`GitHub run token: ${e?.message ?? e}`);
    }
  };
}
