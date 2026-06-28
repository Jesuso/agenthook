<!-- Thanks for contributing! Keep PRs scoped to one logical change. -->

## What & why

<!-- What does this change, and why? Link any related issue (Fixes #123). -->

## How tested

<!-- Unit test added/updated? For engine/adapter paths that need network or a real
     `claude -p`, describe the manual smoke test you ran (tracker, ingress, what you observed). -->

## Checklist

- [ ] `npm run typecheck` is green
- [ ] `npm test` passes
- [ ] `node --check` passes on changed files (CI runs it over `bin/` + `src/`)
- [ ] Updated the relevant doc under `docs/` (and README) for user-facing changes
- [ ] Added a `CHANGELOG.md` entry under **Unreleased** for user-facing changes
- [ ] No secrets or local config committed (`agenthook.config.json`, `.env`, `INSTRUCTIONS.md`, `logs/`)
- [ ] For a new adapter: registered in `index.js`, tagged with the `AdapterFactory` type, engine unchanged
