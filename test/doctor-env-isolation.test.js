import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Doctor — agent env lints (#470, names only, never values), ghAuthLints, and the
// isolation report (#476).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runChecks, agentEnvLints, ghAuthLints, isolationReport, parseForceSshRewrites, runTokenLints } from "../src/commands/doctor.js";
import { cleanProfile, io, problem, recorder } from "./_doctor-helpers.js";

// --- agent env lints (#470): names only, never values ---

/** A config file whose tracker token is `token` (tokenVar reads the raw file). @param {string} token */
function rawConfigFile(token) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-doctor-env-"));
  const file = path.join(dir, "agenthook.config.json");
  fs.writeFileSync(file, JSON.stringify({ tracker: { type: "github", token } }));
  return file;
}

/** @param {any} [over] @returns {any} */
const envCfg = (over = {}) => ({ provider: "local", pipeline: [{ id: "code" }, { id: "done", manual: true }], configPath: "/nonexistent.json", ...over });
const base = { PATH: "/usr/bin", HOME: "/home/u", LANG: "C.UTF-8" };
/** @param {any[]} ls */
const byLabel = (ls) => Object.fromEntries(ls.map((l) => [l.label, l]));

test("agentEnvLints: a plain claude profile gets nothing extra", () => {
  assert.deepEqual(agentEnvLints(envCfg(), { env: base, platform: "linux" }), []);
});

test("agentEnvLints: the migration view names the stripped credentials, never their values", () => {
  const ls = agentEnvLints(envCfg(), { env: { ...base, NGROK_AUTHTOKEN: "s3cr3t", ANTHROPIC_API_KEY: "sk" }, platform: "linux" });
  const got = byLabel(ls);
  assert.equal(got["agent env: not passed to agents"].level, "info");
  assert.equal(got["agent env: not passed to agents"].note, "NGROK_AUTHTOKEN");
  assert.equal(got["agent env: credentials agents still get"].note, "ANTHROPIC_API_KEY (claude)");
  assert.ok(!JSON.stringify(ls).includes("s3cr3t"), "no value is ever printed");
});

test("agentEnvLints: tags each passed credential with its source", () => {
  const ls = agentEnvLints(envCfg({ provider: "github", forge: { type: "github" }, agentEnvPassthrough: ["OPENAI_API_KEY"] }), {
    env: { ...base, GITHUB_TOKEN: "t", GH_TOKEN: "t", OPENAI_API_KEY: "k" },
    platform: "linux",
  });
  assert.equal(byLabel(ls)["agent env: credentials agents still get"].note, "GH_TOKEN (forge (gh)), GITHUB_TOKEN (tracker prompt, forge (gh)), OPENAI_API_KEY (agentEnvPassthrough)");
});

test("agentEnvLints: \"*\" warns that agents inherit everything", () => {
  const ls = agentEnvLints(envCfg({ agentEnvPassthrough: ["*"] }), { env: { ...base, NGROK_AUTHTOKEN: "x" }, platform: "linux" });
  assert.deepEqual(ls.map((l) => [l.level, l.label]), [["warn", `agent env: agentEnvPassthrough is "*"`]]);
  assert.match(ls[0].note ?? "", /whole environment, including NGROK_AUTHTOKEN/);
});

test("agentEnvLints: claude on Bedrock warns about the stripped AWS_* names", () => {
  const ls = agentEnvLints(envCfg(), { env: { ...base, CLAUDE_CODE_USE_BEDROCK: "1", AWS_ACCESS_KEY_ID: "a", AWS_REGION: "us-east-1" }, platform: "linux" });
  const w = byLabel(ls)["agent env: claude on Bedrock loses AWS credentials"];
  assert.equal(w.level, "warn");
  assert.match(w.note, /AWS_ACCESS_KEY_ID/);
  assert.match(w.fix.manual, /AWS_\* to agentEnvPassthrough/);
  // passed through → silent
  const ok = agentEnvLints(envCfg({ agentEnvPassthrough: ["AWS_*"] }), { env: { ...base, CLAUDE_CODE_USE_BEDROCK: "1", AWS_ACCESS_KEY_ID: "a" }, platform: "linux" });
  assert.equal(ok.some((l) => /Bedrock/.test(l.label)), false);
});

test("agentEnvLints: an opencode step warns about stripped provider keys", () => {
  const ls = agentEnvLints(envCfg({ agent: "opencode" }), { env: { ...base, OPENAI_API_KEY: "k" }, platform: "linux" });
  const w = byLabel(ls)["agent env: opencode provider keys stripped"];
  assert.equal(w.level, "warn");
  assert.match(w.note, /opencode may read provider keys from env: OPENAI_API_KEY/);
  // claude doesn't read OPENAI_API_KEY: only the info line
  assert.equal(agentEnvLints(envCfg(), { env: { ...base, OPENAI_API_KEY: "k" }, platform: "linux" }).some((l) => l.level === "warn"), false);
});

test("agentEnvLints: a ${GH_PAT} tracker token while the prompt names an unset $GITHUB_TOKEN", () => {
  const configPath = rawConfigFile("${GH_PAT}");
  const ls = agentEnvLints(envCfg({ provider: "github", configPath }), { env: { ...base, GH_PAT: "p" }, platform: "linux" });
  const w = ls.find((l) => /tracker token/.test(l.label));
  assert.equal(w?.level, "warn");
  assert.equal(w?.label, "agent env: tracker token is ${GH_PAT} but the prompt tells agents to use $GITHUB_TOKEN, which is unset");
  // GITHUB_TOKEN set, or the token is ${GITHUB_TOKEN} itself → silent
  assert.equal(agentEnvLints(envCfg({ provider: "github", configPath }), { env: { ...base, GH_PAT: "p", GITHUB_TOKEN: "t" }, platform: "linux" }).some((l) => /tracker token/.test(l.label)), false);
  assert.equal(agentEnvLints(envCfg({ provider: "github", configPath: rawConfigFile("${GITHUB_TOKEN}") }), { env: base, platform: "linux" }).some((l) => /tracker token/.test(l.label)), false);
});

test("agentEnvLints: git settings the agent loses", () => {
  const ls = agentEnvLints(envCfg(), { env: { ...base, GIT_SSH_COMMAND: "ssh -i k", GIT_CONFIG_COUNT: "1" }, platform: "linux" });
  assert.match(byLabel(ls)["agent env: git in the agent loses its settings"].note, /GIT_CONFIG_COUNT, GIT_SSH_COMMAND/);
});

test("agentEnvLints: under run tokens the receiver's GitHub tokens move to 'not passed', with the reason", () => {
  const env = { ...base, GITHUB_TOKEN: "t", NGROK_AUTHTOKEN: "s" };
  // App auth on the forge
  const f = byLabel(agentEnvLints(envCfg({ forge: { type: "github", ...APP } }), { env, platform: "linux" }));
  assert.equal(f["agent env: not passed to agents"].note, "GITHUB_TOKEN (replaced by the per-run GitHub App token), NGROK_AUTHTOKEN");
  assert.equal("agent env: credentials agents still get" in f, false, "run-stripped tokens are no longer listed as passed");
  // App auth on the tracker only
  const t = byLabel(agentEnvLints(envCfg({ provider: "github", providerConfig: APP }), { env, platform: "linux" }));
  assert.equal(t["agent env: not passed to agents"].note, "GITHUB_TOKEN (replaced by the per-run GitHub App token), NGROK_AUTHTOKEN");
  assert.equal("agent env: credentials agents still get" in t, false);
});

test("agentEnvLints: token auth (and githubRunToken:false) still list the GitHub tokens as passed", () => {
  const env = { ...base, GITHUB_TOKEN: "t" };
  const token = byLabel(agentEnvLints(envCfg({ provider: "github", providerConfig: { auth: { type: "token", token: "x" } }, forge: { type: "github" } }), { env, platform: "linux" }));
  assert.equal(token["agent env: credentials agents still get"].note, "GITHUB_TOKEN (tracker prompt, forge (gh))");
  assert.equal("agent env: not passed to agents" in token, false);
  const off = byLabel(agentEnvLints(envCfg({ provider: "github", providerConfig: APP, githubRunToken: false }), { env, platform: "linux" }));
  assert.match(off["agent env: credentials agents still get"].note, /^GITHUB_TOKEN \(tracker prompt\)/);
  assert.equal("agent env: not passed to agents" in off, false);
});

test("agentEnvLints: a step env GH_TOKEN under App auth stays a runTokenLints warning, not a lint change", () => {
  const cfg = { provider: "github", providerConfig: APP, pipeline: [{ id: "code", env: { GH_TOKEN: "g" } }, { id: "done", manual: true }] };
  assert.deepEqual(runTokenLints(cfg, { originRepo: () => "o/r" }), [{ level: "warn", label: `step "code" env GH_TOKEN overrides the per-run App token` }]);
  const f = byLabel(agentEnvLints(envCfg({ provider: "github", providerConfig: APP }), { env: { ...base, GH_TOKEN: "g" }, platform: "linux" }));
  assert.equal(f["agent env: not passed to agents"].note, "GH_TOKEN", "the allowlist already strips it, so it keeps its bare form");
});

test("ghAuthLints: runs gh auth status with the filtered agent env; a failure warns", () => {
  /** @type {any[]} */
  const calls = [];
  const spawn = (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {any} */ opts) => (calls.push({ cmd, args, env: opts.env }), { status: 1 });
  const env = { ...base, SOME_SECRET: "x", GH_TOKEN: "g" };
  const ls = ghAuthLints(envCfg({ provider: "asana", forge: { type: "github" } }), { spawn, onPath: () => true, env, platform: "linux" });
  assert.deepEqual(calls.map((c) => [c.cmd, c.args]), [["gh", ["auth", "status"]]]);
  assert.equal("SOME_SECRET" in calls[0].env, false, "the receiver's secrets never reach the probe");
  assert.equal(calls[0].env.GH_TOKEN, "g", "the forge's GH_TOKEN does");
  assert.equal(calls[0].env.PATH, "/usr/bin");
  assert.deepEqual(ls.map((l) => [l.level, l.label]), [["warn", "gh is not authenticated for agents (they open and review PRs with gh)"]]);
  // authenticated → silent; local tracker → never probed; gh missing → one warn, no probe
  assert.deepEqual(ghAuthLints(envCfg({ provider: "asana" }), { spawn: () => ({ status: 0 }), onPath: () => true, env, platform: "linux" }), []);
  calls.length = 0;
  assert.deepEqual(ghAuthLints(envCfg(), { spawn, onPath: () => true, env, platform: "linux" }), []);
  assert.deepEqual(ghAuthLints(envCfg({ provider: "asana" }), { spawn, onPath: () => false, env, platform: "linux" }).map((l) => l.label), ["gh not on PATH"]);
  assert.equal(calls.length, 0);
});

// --- isolation report (#476) ---

/** isolationReport over a minimal config. @param {any} cfg @param {any} [o] */
const iso = (cfg, o = {}) => isolationReport(/** @type {any} */ ({ provider: "local", providerConfig: {}, pipeline: [{ id: "code" }, { id: "done", manual: true }], ...cfg }), { user: "ana", ...o });
/** The rows matching `re` (on label + note). @param {any[]} rows @param {RegExp} re */
const rowsOf = (rows, re) => rows.filter((r) => re.test(`${r.label} ${r.note}`));
const APP = { auth: { type: "app", appId: "1", installationId: "2", privateKey: "k" } };

test("isolationReport: every row is labeled isolation · and is info or warn, never fail", () => {
  for (const cfg of [{}, { fullAuto: true }, { fullAuto: true, sandbox: { type: "podman" } }]) {
    const rows = iso(cfg);
    assert.ok(rows.length >= 6);
    assert.ok(rows.every((r) => r.label.startsWith("isolation · ") && (r.level === "info" || r.level === "warn")), JSON.stringify(rows));
    assert.deepEqual([...new Set(rows.map((r) => r.label))], ["isolation · sandbox", "isolation · env", "isolation · egress", "isolation · credentials", "isolation · permissions", "isolation · untrusted input"]);
  }
});

test("isolationReport: sandbox row — none, ⚠ fullAuto without one, type + image, ⚠ a sandbox:false step under fullAuto", () => {
  assert.equal(rowsOf(iso({}), /sandbox none \(agents run on this host\)/).length, 1);
  assert.equal(rowsOf(iso({}), /fullAuto without a sandbox/).length, 0);
  const fa = rowsOf(iso({ fullAuto: true }), /fullAuto without a sandbox/);
  assert.equal(fa.length, 1);
  assert.equal(fa[0].level, "warn");
  assert.equal(fa[0].note, "fullAuto without a sandbox — a verified webhook runs code on this host as ana; see docs/sandbox.md");
  assert.match(iso({ sandbox: { type: "podman", image: "my:img" } })[0].note, /^podman, image my:img$/);
  assert.match(iso({ sandbox: { type: "docker" } })[0].note, /^docker, image agenthook-agent:/);
  const off = iso({ fullAuto: true, sandbox: { type: "podman" }, pipeline: [{ id: "triage", sandbox: false }, { id: "code" }, { id: "done", manual: true, sandbox: false }] });
  assert.deepEqual(rowsOf(off, /runs on the host under fullAuto/).map((r) => [r.level, r.note]), [["warn", 'step "triage" runs on the host under fullAuto']]);
});

test("isolationReport: env row — stripped (default / named passthrough), \"*\" not stripped (⚠ only under fullAuto)", () => {
  assert.equal(rowsOf(iso({}), /isolation · env/)[0].note, "stripped; passes through nothing extra");
  assert.equal(rowsOf(iso({ agentEnvPassthrough: ["FOO", "BAR_*"] }), /isolation · env/)[0].note, "stripped; passes through FOO, BAR_*");
  const star = rowsOf(iso({ agentEnvPassthrough: ["*"] }), /isolation · env/)[0];
  assert.deepEqual([star.level, star.note], ["info", `not stripped — agents inherit the receiver's full env ("*")`]);
  assert.equal(rowsOf(iso({ fullAuto: true, agentEnvPassthrough: ["*"] }), /isolation · env/)[0].level, "warn");
});

test("isolationReport: egress row — n/a without a sandbox, allowlist (defaults + N extra), none/open, step overrides; always info", () => {
  assert.equal(rowsOf(iso({}), /isolation · egress/)[0].note, "n/a (no sandbox — the host's network)");
  assert.equal(rowsOf(iso({ sandbox: { type: "podman" } }), /isolation · egress/)[0].note, "allowlist (defaults + 0 extra)");
  assert.equal(rowsOf(iso({ sandbox: { type: "podman", egress: { allow: ["npm"] } } }), /isolation · egress/)[0].note, "allowlist (defaults + 1 extra)");
  const open = rowsOf(iso({ sandbox: { type: "podman", egress: { mode: "open" } }, pipeline: [{ id: "a", egress: { mode: "none" } }, { id: "b" }] }), /isolation · egress/)[0];
  assert.deepEqual([open.level, open.note], ["info", "open; step overrides: a=none"]);
});

test("isolationReport: credentials row — own token (⚠ under fullAuto), App + all sandboxed ℹ, App + host step ⚠, force-SSH ⚠", () => {
  const own = rowsOf(iso({ provider: "asana" }), /isolation · credentials/);
  assert.deepEqual(own.map((r) => [r.level, r.note]), [["info", "your own token (tracker/forge token or gh login) — usable until you revoke it"]]);
  assert.equal(rowsOf(iso({ provider: "asana", fullAuto: true }), /isolation · credentials/)[0].level, "warn");
  const gh = { provider: "github", providerConfig: APP };
  assert.deepEqual(rowsOf(iso({ ...gh, sandbox: { type: "podman" } }), /isolation · credentials/).map((r) => [r.level, r.note]), [["info", "per-run GitHub App token (1h, repo-scoped)"]]);
  // A forge App counts too; githubRunToken:false turns it off.
  assert.match(rowsOf(iso({ forge: { type: "github", ...APP }, sandbox: { type: "podman" } }), /isolation · credentials/)[0].note, /^per-run GitHub App token/);
  assert.match(rowsOf(iso({ ...gh, githubRunToken: false, sandbox: { type: "podman" } }), /isolation · credentials/)[0].note, /^your own token/);
  const host = rowsOf(iso({ ...gh, sandbox: { type: "podman" }, pipeline: [{ id: "code", sandbox: false }, { id: "review" }] }), /isolation · credentials/);
  assert.deepEqual(host.map((r) => [r.level, r.note]), [["warn", "step(s) code: scoped run token given, but the host gh login and ~/.ssh stay readable"]]);

  const rule = "url.git@github.com:.insteadof https://github.com/\n";
  const ssh = rowsOf(iso({ ...gh }, { gitInsteadOf: rule }), /rewrites https:\/\/github.com\/ to SSH/);
  assert.equal(ssh.length, 1);
  assert.equal(ssh[0].level, "warn");
  assert.match(ssh[0].note, /\(url\.git@github\.com:\.insteadof\) — run pushes use your SSH key; remove the rule or enable the sandbox$/);
  assert.equal(rowsOf(iso({ ...gh, sandbox: { type: "podman" } }, { gitInsteadOf: rule }), /to SSH/).length, 0, "every step sandboxed: the host rule can't apply");
  assert.equal(rowsOf(iso({}, { gitInsteadOf: rule }), /to SSH/).length, 0, "no run tokens: the operator's own key is used anyway");
});

test("isolationReport: credentials row — none for a local/no-forge profile with nothing passed to agents (#491)", () => {
  assert.deepEqual(rowsOf(iso({}), /isolation · credentials/).map((r) => [r.level, r.note]), [["info", "none (local tracker, no forge)"]]);
  assert.deepEqual(rowsOf(iso({ fullAuto: true }), /isolation · credentials/).map((r) => [r.level, r.note]), [["info", "none (local tracker, no forge)"]]);
  // a GH token passthrough or a step env gives agents something, so it's "your own token" again
  assert.match(rowsOf(iso({ agentEnvPassthrough: ["GH_TOKEN"] }), /isolation · credentials/)[0].note, /^your own token/);
  assert.match(rowsOf(iso({ agentEnvPassthrough: ["*"] }), /isolation · credentials/)[0].note, /^your own token/);
  assert.match(rowsOf(iso({ pipeline: [{ id: "code", env: { GITHUB_TOKEN: "x" } }, { id: "done", manual: true }] }), /isolation · credentials/)[0].note, /^your own token/);
  // a forge on top of the local tracker also means credentials exist
  assert.match(rowsOf(iso({ forge: { type: "github" } }), /isolation · credentials/)[0].note, /^your own token/);
});

test("parseForceSshRewrites: git@github.com: and ssh:// bases rewriting https://github.com match; reverse and other hosts don't", () => {
  assert.deepEqual(parseForceSshRewrites("url.git@github.com:.insteadof https://github.com/"), ["url.git@github.com:.insteadof"]);
  assert.deepEqual(parseForceSshRewrites("url.ssh://git@github.com/.insteadOf https://github.com/\n"), ["url.ssh://git@github.com/.insteadof"], "keys come out as git prints them (insteadof lowercased)");
  assert.deepEqual(parseForceSshRewrites("url.git@github.com:.insteadof https://github.com"), ["url.git@github.com:.insteadof"]);
  assert.deepEqual(parseForceSshRewrites("url.https://github.com/.insteadof git@github.com:"), [], "the reverse (SSH → HTTPS) is harmless");
  assert.deepEqual(parseForceSshRewrites("url.git@gitlab.com:.insteadof https://gitlab.com/"), []);
  assert.deepEqual(parseForceSshRewrites("url.git@github.com:.insteadof https://github.company.com/"), []);
  assert.deepEqual(parseForceSshRewrites(""), []);
});

test("isolationReport: permissions — one row per non-manual step with its mode", () => {
  const pipeline = [
    { id: "plain" },
    { id: "allow", allow: { commands: ["git"] } },
    { id: "deny", deny: { commands: ["curl"], paths: [".env"] } },
    { id: "herm", agent: "hermes" },
    { id: "done", manual: true },
  ];
  const modes = (/** @type {any} */ cfg) => rowsOf(iso({ pipeline, ...cfg }), /isolation · permissions/).map((r) => r.note);
  assert.deepEqual(modes({}), [
    'step "plain" (claude): dontAsk (pinned; repo/user allow rules apply)',
    'step "allow" (claude): allow policy (dontAsk, 3 rules)',
    'step "deny" (claude): dontAsk (pinned; repo/user allow rules apply), deny policy (4 rules)',
    'step "herm" (hermes): agent CLI default',
  ]);
  assert.deepEqual(modes({ fullAuto: true }), [
    'step "plain" (claude): skip-permissions (fullAuto)',
    'step "allow" (claude): allow policy (dontAsk, 3 rules)',
    'step "deny" (claude): skip-permissions (fullAuto), deny policy (4 rules)',
    'step "herm" (hermes): skip-permissions (fullAuto)',
  ]);
});

test("isolationReport: ~/.claude/settings.json defaultMode is reported ignored (⚠ + migration for acceptEdits); broad allow rules ⚠ on pinned steps", () => {
  const dm = (/** @type {string} */ m) => rowsOf(iso({}, { userClaudeSettings: { permissions: { defaultMode: m } } }), /defaultMode/);
  assert.deepEqual(dm("bypassPermissions").map((r) => [r.level, r.note]), [["info", '~/.claude/settings.json defaultMode "bypassPermissions" is ignored — agenthook pins the mode']]);
  const ae = dm("acceptEdits");
  assert.equal(ae[0].level, "warn");
  assert.match(ae[0].note, /to let a non-fullAuto step edit files, allow it explicitly: "permissions": \{"allow": \["Edit", "Bash\(npm test\)"\]\} in the repo's \.claude\/settings\.json, or a step allow policy/);

  const allow = { permissions: { allow: ["Bash(*)", "Bash(npm test)", "Edit", "Read", "Write(//**)"] } };
  const broad = rowsOf(iso({}, { userClaudeSettings: allow }), /widens every pinned claude step/);
  assert.deepEqual(broad.map((r) => r.level), ["warn", "warn", "warn"]);
  assert.match(broad[0].note, /^~\/\.claude\/settings\.json allows "Bash\(\*\)" — it widens every pinned claude step \(allow policies included\)$/);
  assert.equal(rowsOf(iso({ fullAuto: true }, { userClaudeSettings: allow }), /widens/).length, 0, "bypass steps ignore allow rules");
  assert.equal(rowsOf(iso({ pipeline: [{ id: "h", agent: "hermes" }] }, { userClaudeSettings: allow }), /widens/).length, 0, "no claude step");
});

test("runChecks: the isolation block is emitted (no ✗), and a default profile's isolation rows are not problems", async () => {
  const { cfg } = cleanProfile();
  const checks = await runChecks(cfg, io());
  const rows = checks.filter((c) => c.label.startsWith("isolation · "));
  assert.ok(rows.length >= 6);
  assert.ok(rows.every((c) => c.ok), "no isolation ✗ rows");
  assert.deepEqual(rows.filter(problem), []);
  const fa = await runChecks({ ...cfg, fullAuto: true }, io());
  assert.ok(fa.some((c) => c.warn && /fullAuto without a sandbox/.test(String(c.note))));
  assert.ok(fa.filter((c) => c.label.startsWith("isolation · ")).every((c) => c.ok));
});

test("runChecks: the global insteadof rules are read through spawn only when a run token is used on the host", async () => {
  const { cfg } = cleanProfile();
  const rec = recorder();
  await runChecks(cfg, io({ spawn: rec.spawn }));
  assert.ok(!rec.calls.some((c) => c.args.includes("--get-regexp")));
  /** @type {string[][]} */
  const seen = [];
  const spawn = /** @type {any} */ ((/** @type {string} */ cmd, /** @type {string[]} */ args) => (seen.push([cmd, ...args]), args.includes("--get-regexp") ? { status: 0, stdout: "url.git@github.com:.insteadof https://github.com/\n" } : { status: 0 }));
  const checks = await runChecks(/** @type {any} */ ({ ...cfg, forge: { type: "github", repository: "o/r", ...APP } }), io({ spawn, fetch: async () => new Response("{}", { status: 500 }) }));
  assert.ok(seen.some((a) => a[0] === "git" && a.includes("--get-regexp")));
  assert.ok(checks.some((c) => c.warn && /to SSH \(url\.git@github\.com:\.insteadof\)/.test(String(c.note))));
});

