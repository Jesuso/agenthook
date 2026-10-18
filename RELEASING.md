# Releasing

## Cadence

Release when it's worth it — **at most weekly**. No release train, no deadline pressure.

## Checklist

1. Move `[Unreleased]` entries in `CHANGELOG.md` into a new `## [x.y.z] — YYYY-MM-DD` heading, and
   update the compare link refs at the bottom: `[Unreleased]` becomes `vX.Y.Z...HEAD`, and add a new
   `[x.y.z]: vPREV...vX.Y.Z` line for the release.
2. Bump the version: `npm version <minor|patch> --no-git-tag-version` (or edit `package.json` +
   `package-lock.json` by hand).
3. Open a release PR titled `chore(release): x.y.z`. Merge it.
4. Tag the merge commit: `git tag vX.Y.Z` and push the tag.
5. `npm publish --otp <code>` — runs `prepublishOnly` (`typecheck`, `test`, `build:ui`).
6. Create a GitHub Release from the tag, using the CHANGELOG section as the release notes.

## Config compatibility policy

A config key that changes **meaning or default**, or is **removed**, gets a deprecation warning at
config load for at least one minor release before the change ships. Every breaking change is
documented under the CHANGELOG's **"Changed"** heading with a migration line (e.g. "to keep the old
behaviour, set …").

Pre-1.0, a minor release can still break something — but never silently.
