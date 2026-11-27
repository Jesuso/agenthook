import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// What dispatch hands a sandboxed run (src/dispatch/sandbox.js): git dirs, mounts, the env
// split, the container's git config, and checkout masks. Pure, plus one real `git worktree add`
// fixture (shared with the other dispatch-sandbox-*.test.js files via _dispatch-sandbox-helpers.js).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { trustedGitDirs, sandboxMounts, containerEnv, runtimeEnv, gitSandboxEnv, mergeGitConfigEnv, hostOf, checkoutMasks } from "../src/dispatch/sandbox.js";
import { runGitEnv } from "../src/github/run-token.js";
import { fixture } from "./_dispatch-sandbox-helpers.js";

test("trustedGitDirs: a git-worktree checkout resolves its admin dir and the main checkout's common dir", () => {
  const { repo, wt } = fixture();
  assert.deepEqual(trustedGitDirs(repo, wt), { gitDir: path.join(repo, ".git", "worktrees", "42"), commonDir: path.join(repo, ".git") });
  assert.deepEqual(trustedGitDirs(repo, repo), { gitDir: path.join(repo, ".git"), commonDir: path.join(repo, ".git") }, "a main checkout's .git is both");
  assert.throws(() => trustedGitDirs(path.join(repo, "nope"), wt), /is not a directory/);
});

// Review #481: the worktree's `.git` and the admin dir's `commondir` are agent-writable (both
// sit in rw mounts). Neither may ever choose a mount source — a tampered one refuses the run.
test("trustedGitDirs: a rewritten worktree .git (gitdir → operator home) is refused, never resolved", () => {
  const { root, repo, wt } = fixture();
  const home = path.join(root, "operator-home");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${home}\n`);
  assert.throws(() => trustedGitDirs(repo, wt), /worktree git metadata does not point into/);
  // A look-alike admin dir elsewhere that names the real common dir is refused too.
  fs.writeFileSync(path.join(home, "commondir"), path.join(repo, ".git"));
  assert.throws(() => trustedGitDirs(repo, wt), /does not point into/);
});

test("trustedGitDirs: a rewritten commondir (→ operator home) is refused", () => {
  const { root, repo, wt } = fixture();
  const home = path.join(root, "operator-home");
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(repo, ".git", "worktrees", "42", "commondir"), home);
  assert.throws(() => trustedGitDirs(repo, wt), /does not point into/);
});

test("trustedGitDirs: a symlinked admin dir or a FIFO .git is refused without blocking", () => {
  const { root, repo, wt } = fixture();
  const admin = path.join(repo, ".git", "worktrees", "42");
  const moved = path.join(root, "moved-admin");
  fs.renameSync(admin, moved);
  fs.symlinkSync(moved, admin);
  assert.throws(() => trustedGitDirs(repo, wt), /does not point into/);
  fs.rmSync(path.join(wt, ".git"));
  execFileSync("mkfifo", [path.join(wt, ".git")]);
  assert.throws(() => trustedGitDirs(repo, wt), /does not point into/);
});

test("sandboxMounts (worktree): worktree + common rw, config + hooks ro (hooks created), verdict rw, then the agent's", () => {
  const { repo, wt } = fixture();
  const common = path.join(repo, ".git");
  fs.rmSync(path.join(common, "hooks"), { recursive: true, force: true });
  const m = sandboxMounts({ cwd: wt, hasWorktree: true, verdictDir: "/state/verdicts/run-42-code", gitCommonDir: common, agentMounts: [{ path: "/h/.claude/projects/x", dst: "/home/agent/.claude/projects/x" }] });
  assert.deepEqual(m, [
    { path: wt, ro: false },
    { path: common, ro: false },
    { path: path.join(common, "config"), ro: true },
    { path: path.join(common, "hooks"), ro: true },
    { path: "/state/verdicts/run-42-code" },
    { path: "/h/.claude/projects/x", dst: "/home/agent/.claude/projects/x" },
  ]);
  assert.ok(fs.statSync(path.join(common, "hooks")).isDirectory(), "hooks exists before the run, so the agent can't create it");
});

test("sandboxMounts (no worktree, e.g. triage): the main checkout and its git dir read-only, no overlays", () => {
  const { repo } = fixture();
  const common = path.join(repo, ".git");
  const m = sandboxMounts({ cwd: repo, hasWorktree: false, verdictDir: "/v", gitCommonDir: common });
  assert.deepEqual(m, [{ path: repo, ro: true }, { path: common, ro: true }, { path: "/v" }]);
});

test("sandboxMounts: a symlinked hooks or config (planted by an earlier run) is refused, not bind-mounted", () => {
  const { root, repo, wt } = fixture();
  const common = path.join(repo, ".git");
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.rmSync(path.join(common, "hooks"), { recursive: true, force: true });
  fs.symlinkSync(elsewhere, path.join(common, "hooks"));
  assert.throws(() => sandboxMounts({ cwd: wt, hasWorktree: true, verdictDir: "/v", gitCommonDir: common }), /hooks is not a directory/);
  fs.rmSync(path.join(common, "hooks"));
  fs.renameSync(path.join(common, "config"), path.join(elsewhere, "config"));
  fs.symlinkSync(path.join(elsewhere, "config"), path.join(common, "config"));
  assert.throws(() => sandboxMounts({ cwd: wt, hasWorktree: true, verdictDir: "/v", gitCommonDir: common }), /config is not a regular file/);
});

test("containerEnv drops host-only keys, keeps tokens and the verdict file; runtimeEnv keeps only the client's", () => {
  const env = {
    PATH: "/usr/bin", HOME: "/home/me", USER: "me", SSH_AUTH_SOCK: "/run/ssh", XDG_RUNTIME_DIR: "/run/user/1", TERM: "xterm", TERM_PROGRAM: "x",
    DOCKER_HOST: "unix:///x", NODE_OPTIONS: "--inspect", npm_config_cache: "/c", DBUS_SESSION_BUS_ADDRESS: "d",
    GH_TOKEN: "ghp", AGENTHOOK_VERDICT_FILE: "/v/verdict.json", CLAUDE_CODE_OAUTH_TOKEN: "o", UNDEF: undefined,
  };
  assert.deepEqual(containerEnv(env), { GH_TOKEN: "ghp", AGENTHOOK_VERDICT_FILE: "/v/verdict.json", CLAUDE_CODE_OAUTH_TOKEN: "o" });
  assert.deepEqual(runtimeEnv(env), { PATH: "/usr/bin", HOME: "/home/me", USER: "me", XDG_RUNTIME_DIR: "/run/user/1", DOCKER_HOST: "unix:///x" });
});

test("hostOf: scp-style, ssh:// and https remotes", () => {
  assert.equal(hostOf("git@github.com:o/r.git"), "github.com");
  assert.equal(hostOf("ssh://git@gitlab.example.com:2222/g/p.git"), "gitlab.example.com");
  assert.equal(hostOf("https://github.com/o/r"), "github.com");
  assert.equal(hostOf(undefined), undefined);
  assert.equal(hostOf("not a url"), undefined);
});

/** GIT_CONFIG_* env → [key, value] pairs. @param {Record<string, string>} env */
const pairsOf = (env) => Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);

test("gitSandboxEnv: an SSH github origin pushes over HTTPS with gh's helper, safe.directory, and the host author", () => {
  const env = gitSandboxEnv({ originUrl: "git@github.com:o/r.git", author: { name: "Op", email: "op@x" } });
  assert.deepEqual(pairsOf(env), [
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
    ["credential.https://github.com.helper", "!gh auth git-credential"],
    ["safe.directory", "*"],
    ["push.default", "current"],
  ]);
  assert.equal(env.GIT_AUTHOR_NAME, "Op");
  assert.equal(env.GIT_COMMITTER_NAME, "Op");
  assert.equal(env.GIT_AUTHOR_EMAIL, "op@x");
  assert.equal(env.GIT_COMMITTER_EMAIL, "op@x");
});

test("gitSandboxEnv: gitlab takes the host from forge.baseUrl and a GITLAB_TOKEN helper; no origin → safe.directory only", () => {
  const env = gitSandboxEnv({ originUrl: "git@other:g/p.git", forgeType: "gitlab", forgeBaseUrl: "https://gitlab.acme.io", author: {} });
  const pairs = pairsOf(env);
  assert.deepEqual(pairs[0], ["url.https://gitlab.acme.io/.insteadOf", "git@gitlab.acme.io:"]);
  assert.equal(pairs[2][0], "credential.https://gitlab.acme.io.helper");
  assert.match(pairs[2][1], /GITLAB_TOKEN/);
  assert.equal(env.GIT_AUTHOR_NAME, undefined);
  assert.deepEqual(pairsOf(gitSandboxEnv({})), [["safe.directory", "*"], ["push.default", "current"]]);
});

test("gitSandboxEnv skipHostAuth: a run-token sandboxed run drops the insteadOf/credential pairs, keeps safe.directory + author", () => {
  const env = gitSandboxEnv({ originUrl: "git@github.com:o/r.git", author: { name: "Op", email: "op@x" }, skipHostAuth: true });
  assert.deepEqual(pairsOf(env), [["safe.directory", "*"], ["push.default", "current"]]);
  assert.equal(env.GIT_AUTHOR_NAME, "Op");
});

// Review pass on #484's sandbox rework: skipHostAuth must only drop the insteadOf/credential
// pairs when the *resolved* host is github.com. A run token (#474) never covers another forge's
// host, so skipping there would strip that host's push credentials with nothing to replace them
// — a sandboxed run that could push before this merge would be unable to push after it.
test("gitSandboxEnv skipHostAuth: a non-github host keeps its own insteadOf/credential pairs (a github run token never covers it)", () => {
  const env = gitSandboxEnv({ originUrl: "git@gitlab.acme.io:o/r.git", forgeType: "gitlab", forgeBaseUrl: "https://gitlab.acme.io", skipHostAuth: true });
  const pairs = pairsOf(env);
  assert.deepEqual(pairs[0], ["url.https://gitlab.acme.io/.insteadOf", "git@gitlab.acme.io:"]);
  assert.equal(pairs[2][0], "credential.https://gitlab.acme.io.helper");
  assert.match(pairs[2][1], /GITLAB_TOKEN/);
});

test("mergeGitConfigEnv re-indexes a run token's git env (#474) and the sandbox's own, with no duplicate GIT_CONFIG_COUNT indices", () => {
  const creds = runGitEnv(); // GIT_CONFIG_COUNT=4 (reset, gh helper, two insteadOf), plus GIT_TERMINAL_PROMPT
  const sbx = gitSandboxEnv({ originUrl: "git@github.com:o/r.git", author: { name: "Op", email: "op@x" }, skipHostAuth: true }); // just safe.directory + author
  const merged = mergeGitConfigEnv(creds, sbx);
  assert.equal(Number(merged.GIT_CONFIG_COUNT), 6);
  assert.deepEqual(pairsOf(merged), [
    ["credential.https://github.com.helper", ""],
    ["credential.https://github.com.helper", "!gh auth git-credential"],
    ["url.https://github.com/.insteadOf", "git@github.com:"],
    ["url.https://github.com/.insteadOf", "ssh://git@github.com/"],
    ["safe.directory", "*"],
    ["push.default", "current"],
  ]);
  assert.equal(merged.GIT_TERMINAL_PROMPT, "0");
  assert.equal(merged.GIT_AUTHOR_NAME, "Op");
  // Only a single, re-indexed GIT_CONFIG_COUNT — never two conflicting sets of KEY_n/VALUE_n.
  assert.equal(Object.keys(merged).filter((k) => k === "GIT_CONFIG_COUNT").length, 1);
});

test("sandboxMounts: the per-run GH_CONFIG_DIR (#474) mounts read-only as the directory, not a file, so a refresh's atomic rename is visible inside", () => {
  const { repo, wt } = fixture();
  const common = path.join(repo, ".git");
  const credsDir = path.join(path.dirname(repo), "run-creds-dir");
  fs.mkdirSync(credsDir);
  const m = sandboxMounts({ cwd: wt, hasWorktree: true, verdictDir: "/v", gitCommonDir: common, credsMount: credsDir });
  const mount = m.find((x) => x.path === credsDir);
  assert.ok(mount, "GH_CONFIG_DIR mount present");
  assert.equal(mount.ro, true);
  assert.ok(fs.statSync(mount.path).isDirectory(), "mount source is the dir, not hosts.yml itself");
});

test("checkoutMasks: gitignored files and dirs plus the config/.env extras are masked; tracked files, symlinks and outside paths are not", () => {
  const { root, repo } = fixture();
  fs.writeFileSync(path.join(repo, ".gitignore"), ".env\nagenthook.config.json\nlogs/\nnode_modules/\n");
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=x");
  fs.writeFileSync(path.join(repo, "agenthook.config.json"), "{}");
  fs.mkdirSync(path.join(repo, "logs"));
  fs.writeFileSync(path.join(repo, "logs", "r.log"), "x");
  fs.writeFileSync(path.join(repo, "notes.local"), "untracked, not ignored");
  fs.symlinkSync(path.join(repo, ".env"), path.join(repo, "envlink"));
  fs.appendFileSync(path.join(repo, ".gitignore"), "envlink\n");
  const m = checkoutMasks(repo, { extra: [path.join(repo, "cfg.json"), path.join(root, "outside.env"), undefined] });
  fs.writeFileSync(path.join(repo, "cfg.json"), "{}"); // created after: a missing extra is skipped
  assert.deepEqual(m, [
    { path: path.join(repo, ".env"), mask: "file" },
    { path: path.join(repo, "agenthook.config.json"), mask: "file" },
    { path: path.join(repo, "logs"), mask: "dir" },
  ]);
  assert.deepEqual(checkoutMasks(repo, { extra: [path.join(repo, "cfg.json")] }).map((x) => path.basename(x.path)), [".env", "agenthook.config.json", "cfg.json", "logs"]);
});

test("checkoutMasks: a dir git can't list throws (the run is refused, never started with secrets visible)", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ah-nogit-")));
  assert.throws(() => checkoutMasks(dir), /could not list .*gitignored files/);
});

test("sandboxMounts: masks follow the read-only checkout of a no-worktree run, and are ignored for a worktree run", () => {
  const { repo, wt } = fixture();
  const common = path.join(repo, ".git");
  const masks = [{ path: path.join(repo, ".env"), mask: /** @type {const} */ ("file") }];
  const m = sandboxMounts({ cwd: repo, hasWorktree: false, verdictDir: "/v", gitCommonDir: common, masks });
  assert.deepEqual(m.slice(0, 2), [{ path: repo, ro: true }, masks[0]]);
  const w = sandboxMounts({ cwd: wt, hasWorktree: true, verdictDir: "/v", gitCommonDir: common, masks });
  assert.ok(!w.some((x) => x.mask));
});
