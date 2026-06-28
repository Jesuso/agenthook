# Contributing to agenthook

Thanks for considering a contribution. agenthook is a small, dependency-light Node project — easy
to hack on once you know the few conventions below.

## Project shape

- **Plain Node ESM, no build.** `"type": "module"`, Node ≥ 20. The code ships as JS and runs
  unbuilt. There is no bundler and no transpile step.
- **TypeScript as a checker only.** Types live in `src/types.js` as JSDoc `@typedef`s; `checkJs`
  (`tsconfig.json`, `noEmit`) type-checks the JS. `src/types.js`'s `Adapter` typedef **is** the
  provider contract — an adapter missing a method fails `npm run typecheck`.
- **ESM only.** `import`, never `require()`.
- The repo you're editing is the **receiver/framework**. The `claude -p` agents it spawns run in a
  *different* repo and read *that* repo's `CLAUDE.md` — not this one. See [`CLAUDE.md`](CLAUDE.md)
  and [docs/architecture.md](docs/architecture.md) for the design.

## Dev setup

```bash
git clone https://github.com/Jesuso/agenthook.git
cd agenthook
npm ci
```

Run the CLI from source during development:

```bash
node bin/agenthook.js <command>          # e.g. node bin/agenthook.js help
# or link it globally so `agenthook` points at your checkout:
npm link
```

## Before you push — the full local gate

CI (`.github/workflows/ci.yml`) runs exactly these on Node 20 & 22. Run them locally first:

```bash
npm run typecheck        # tsc --noEmit over the JSDoc types — must be green
npm test                 # node:test suites in test/
node --check bin/agenthook.js   # (CI checks every file under bin/ and src/)
```

Keep `npm run typecheck` green for any change under `src/`. Add or update a test in `test/` when you
touch a pure unit (`paths`, `pipeline`, `queue`, `store`, …). Engine/adapter paths that need network
or a real `claude -p` aren't unit-tested yet — describe the manual smoke test you ran in the PR.

## Adding a tracker or ingress adapter

This is the most common contribution and the engine is built for it — neither the tracker nor the
ingress is named in the engine.

1. Read the **reference doc-comment** at the top of `src/trackers/asana.js` (the adapter interface)
   and [docs/providers.md](docs/providers.md).
2. Create `src/trackers/<name>.js` (or `src/ingress/<name>.js`) exporting the factory.
3. Register it in `src/trackers/index.js` (`TRACKERS`) or `src/ingress/index.js` (`INGRESS`).
4. Tag the factory `/** @type {import('../types.js').AdapterFactory} */` so a wrong shape fails
   typecheck.
5. Optionally implement `wizardSteps()` for `init` live discovery.

The engine never changes to add a provider — if you find yourself editing `src/engine.js` to support
one, something's off; open an issue to discuss.

## Conventions

- **Don't commit secrets or local config.** `agenthook.config.json`, `config.json`, `.env`,
  `INSTRUCTIONS.md`, and `logs/` are gitignored. The committed templates are
  `agenthook.config.example.json`, `.env.example`, `INSTRUCTIONS.example.md`. Double-check `git
  status` before committing.
- Match the surrounding code: comment density, naming, the local `json(res) => Promise<any>` helper
  pattern for untyped external API JSON.
- Keep changes scoped. One logical change per PR.

## Pull requests

- Branch off `master`. Open the PR against `master`.
- Fill in the PR template (what/why, how tested, the checklist).
- Green CI is required to merge.
- For anything user-facing, update the relevant doc under `docs/` and add a line to
  [`CHANGELOG.md`](CHANGELOG.md) under "Unreleased".

## Security

Do **not** open a public issue for a vulnerability. Follow the private disclosure process in
[SECURITY.md](SECURITY.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree to
uphold it.
