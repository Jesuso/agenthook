// sessions — repo-aware transcript lookup (multi-repo, #82). HOME points at a tmp dir so
// claudeProjectDir lands in a sandbox; no git, no network.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-sessions-"));
process.env.HOME = HOME;
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const { sessionDir, refRepo, listSessions } = await import("../src/sessions.js");
const { claudeProjectDir } = await import("../src/paths.js");
const { worktreePath } = await import("../src/worktree.js");

const mono = { id: "mono", path: "/w/alephbeta", match: [], default: true };
const ios = { id: "ios", path: "/w/alephbeta-ios", match: ["ios"] };
const multi = /** @type {any} */ ({ repoPath: mono.path, multiRepo: true, repos: [mono, ios], logDir: path.join(HOME, "logs") });

/** @param {string} dir @param {string} id */
const writeTranscript = (dir, id) => {
  fs.mkdirSync(dir, { recursive: true });
  const line = { type: "user", timestamp: "2026-09-24T10:00:00.000Z", message: { content: "=== TICKET === hi" } };
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify(line) + "\n");
};

test("sessionDir: a sticky repo.json entry resolves that repo's transcript dir", () => {
  const store = { getRepo: (/** @type {string} */ ref) => (ref === "7" ? "ios" : undefined) };
  assert.equal(refRepo(multi, "7", store).id, "ios");
  assert.equal(sessionDir(multi, "7", store), claudeProjectDir(worktreePath(multi, "7", ios)));
  assert.notEqual(sessionDir(multi, "7", store), sessionDir(multi, "7")); // no store → no sticky
});

test("sessionDir: without a sticky entry, falls back to the repo whose worktree transcripts exist", () => {
  const dir = claudeProjectDir(worktreePath(multi, "42", ios));
  writeTranscript(dir, "sess-42");
  const store = { getRepo: () => undefined }; // drained: sticky cleared
  assert.equal(refRepo(multi, "42", store).id, "ios");
  assert.equal(sessionDir(multi, "42", store), dir);
  assert.deepEqual(listSessions(multi, "42", store).map((s) => s.id), ["sess-42"]);
  // nothing on disk anywhere → the default repo
  assert.equal(refRepo(multi, "99", store).id, "mono");
});

test("sessionDir: several repos with transcripts → the newest wins", () => {
  const a = claudeProjectDir(worktreePath(multi, "5", mono));
  const b = claudeProjectDir(worktreePath(multi, "5", ios));
  writeTranscript(a, "old");
  writeTranscript(b, "new");
  fs.utimesSync(a, new Date(1000), new Date(1000));
  assert.equal(refRepo(multi, "5").id, "ios");
});

test("sessionDir: single-repo cfg is unchanged", () => {
  const cfg = /** @type {any} */ ({ repoPath: "/a/b/repo" });
  const expected = claudeProjectDir(worktreePath(cfg, "80"));
  assert.equal(sessionDir(cfg, "80"), expected);
  assert.equal(sessionDir(cfg, "80", { getRepo: () => undefined }), expected);
  const synth = /** @type {any} */ ({ repoPath: "/a/b/repo", multiRepo: false, repos: [{ id: "default", path: "/a/b/repo", match: [], default: true }] });
  assert.equal(sessionDir(synth, "80", { getRepo: () => "default" }), expected);
});
