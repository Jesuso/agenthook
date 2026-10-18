---
name: pre-release
description: Prove an agenthook release is ready before the user publishes — static checks, the packed-tarball release smoke with the real agent, a judgment pass over remedy hints, skipped tests, changelog vs diff and upgrade path, then a report and the exact publish hand-off; after publish, verify the registry tarball, cut the GitHub release and smoke `npx`. Use when the user says "/pre-release", "is this ready to release", "pre-release check", "prove it's ready", or is about to `npm publish`.
---

# Pre-release check

Goal: the user runs `npm publish` knowing a stranger's first ten minutes work. Unit tests run from
source with a foreground receiver and a seeded board; that is exactly what let 0.8.0's three
first-run bugs through (init summary named the wrong state dir, `start --detach` raced its boot,
the CLI's own `reconcile` hint was unsupported on local). The bugs were caught by installing the
**packed tarball as a stranger**, pasting the **docs verbatim**, and **following the tool's own
hints**. `test/release/smoke.mjs` does that mechanically; this skill runs it and covers what
needs judgment.

**You never publish, tag-push or create the release before the user says they published.** Fix
what you find on a branch + PR (standing authority); anything product-shaped (cut a feature,
delay) is the user's call — present it with a recommendation.

Args: optional target version (`/pre-release 0.9.0`); default = the version in `package.json`.

## 1. Gate — know what is being released

- `git fetch`; on `master`, clean tree, `HEAD == origin/master`. Else stop and say why.
- `PREV` = latest published (`npm view @jesuso/agenthook version`), `NEXT` = target.
  `NEXT` must be greater than `PREV` and not already a tag (`git tag -l vNEXT`).
- The range under review is `vPREV..HEAD`. List it: `git log --oneline vPREV..HEAD`, plus open
  PRs (`gh pr list`) and open issues labelled `bug` — anything that looks release-blocking goes
  in the report.

## 2. Static checks

Run all, record pass/fail + counts:

```bash
npm ci
npm run typecheck && npm test        # note the pass/skip/todo counts
npm run typecheck:ui && npm run test:ui && npm run build:ui
for f in bin/*.js $(git ls-files 'src/**/*.js'); do node --check "$f" || echo "FAIL $f"; done
```

- **Skipped tests:** `grep -rnE "\.(skip|todo)\(|\{ ?skip:" test/` — each one needs a reason
  that still holds (platform-only, needs network). An unexplained skip in an area this release
  touched is a finding.
- CI on `HEAD` green: `gh run list --branch master --limit 1`.

## 3. Release smoke — the stranger, with the real agent

```bash
npm run release:smoke -- --agent claude --upgrade-from latest --json <scratchpad>/smoke.json
```

(CI already runs it with the stub on every PR; this is the real-model run, a few cents.) Read the
JSON, not just the exit code:

- **pack:** the file diff vs the published version. Every added or removed path must be explained
  by a commit in the range; an unexplained one (a stray file, a dropped dir) is a finding.
- **quickstart / remedy:** wait times — a ticket taking far longer than in the last release is
  worth a look at `receiver.log` (kept in the temp dir with `--keep`).
- Any failed phase blocks the release: fix it (branch + PR), merge, restart from step 1.

## 4. Judgment pass (what the harness can't decide)

1. **Remedy audit.** `grep -rnoE "\`(agenthook|ah) [^\`]+\`" src/ | sort -u` — the harness proves
   the commands exist; you check each hint makes sense *in the state that prints it* (a hint telling
   a local-profile user to register a webhook is wrong even though `register` exists). Read the
   error/hint strings added or changed in the range (`git diff vPREV..HEAD -- src | grep -E
   '^\+.*(throw new Error|console\.(error|warn))'`).
2. **Changelog vs diff.** `[Unreleased]` (or the `NEXT` section) must cover every user-visible
   change in `git log vPREV..HEAD`: new commands/flags/config keys, changed defaults, removed
   behaviour. A changed default or removed key needs a "Changed" entry with a migration line
   (RELEASING.md compatibility policy). No entries for bugs that never shipped.
3. **Docs.** Every new command/flag/config key appears in `docs/` (and `docs/agent-guide.md` for MCP
   tools, events and error messages — a project rule). A new config key has a
   `src/config-schema.js` entry (a test enforces it, double-check anyway).
4. **Upgrade.** The harness only boots an old profile and runs one ticket. Also read the range for
   state-file format changes (`src/store.js`, `state-move.js`, anything writing under the state dir)
   and config meaning changes. Each needs either a migration that runs on load or a CHANGELOG
   migration line. Unhandled → finding.
5. **Security posture.** Any diff touching HMAC verification, assignee scoping, the `@agent` author
   check, or `fullAuto` defaults gets read line by line and called out in the report even if fine.
6. **Variation the harness doesn't cover**, only where the range makes it relevant: Node 24 (CI
   matrix covers tests, not the smoke — run `npx -p node@24 node test/release/smoke.mjs` if
   install/boot code changed), macOS socket limit (104), a non-systemd box.

## 5. Report + hand off

Publish the report as an Artifact (it goes to the user to decide on): verdict line first
(**ready** / **ready with notes** / **blocked**), then a table of steps 1–4 with evidence (counts,
smoke phase details, the pack diff), findings with what you did about each (PR #, issue #, or
"needs you"), and the open-PR/bug list. Then hand off the exact commands, in order, for the user
to run if they agree:

```bash
# if the release PR isn't merged yet: CHANGELOG [Unreleased] → [NEXT] — date, version bump (RELEASING.md 1-3)
git tag vNEXT <merge-sha> && git push origin vNEXT
npm publish --otp <code>
```

Keep `npm pack --json` `shasum` of the verified tarball for step 6 (`npm pack --dry-run --json` on
the tagged commit gives the same integrity when the build is reproducible; if `ui/dist` hashes
differ, say so rather than claiming a match).

## 6. After the user says it's published

1. Wait for the registry (`npm view @jesuso/agenthook@NEXT version` — can lag a minute; retry,
   don't conclude failure on the first miss).
2. `npm view @jesuso/agenthook@NEXT dist.integrity dist.shasum` — compare with the tarball you
   verified; report match/mismatch plainly.
3. `gh release create vNEXT --title vNEXT --notes-file <the CHANGELOG section>`; close the
   release's epic/milestone if there is one.
4. Smoke the real thing in a clean temp dir: `AGENTHOOK_HOME=$(mktemp -d /tmp/ah.XXXX) npx -y
   @jesuso/agenthook@NEXT --version`, then
   `npm run release:smoke -- --tarball "$(npm pack @jesuso/agenthook@NEXT --pack-destination <tmp> | tail -1)"`
   with the stub — proves the published bytes, not the local build.
5. One-line report: published, integrity match, release URL, smoke result.

## Lessons this skill encodes (add to them)

- Install the tarball, never the checkout — `ui/dist` is gitignored and only built by
  `prepublishOnly`, so source-tree runs hide packaging bugs.
- Paste docs as one block with no pauses — races only show when commands are typed back to back.
- Follow every hint the CLI prints — a hint is a promise; 0.8.0 shipped one it couldn't keep.
- A diagnosis isn't confirmed until a reproducer fails for that reason (#439 was closed, then
  reopened, within the same session).
- The npm registry lags after publish; `latest` can show the old version for a minute.
