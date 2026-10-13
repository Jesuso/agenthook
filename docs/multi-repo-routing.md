# Multi-repo routing — one profile, N repos

> Status: **design, not built.** Supersedes the single-`repoPath` assumption in
> `CLAUDE.md` once implemented. Scope: one board / one pipeline serving several code
> repositories, with the repo chosen **per task** from a tracker field.

## The problem

A profile pins exactly one `repoPath` (`config.js:118`). One org board, however, holds
tickets for several codebases: a backend/mono repo, an iOS app, an Android app. Today an
iOS ticket entering `agent:code` gets a worktree cut from the backend repo; the agent
notices the mismatch and halts — a wasted `claude -p` run and a stuck ticket.

The board is already the right place to say which codebase a ticket belongs to: an Asana
custom field ("Platform"), a GitHub label, a Jira component. What is missing is the
receiver's ability to read that signal and pick the matching checkout.

## Design

Keep the engine blind. The split mirrors the existing tracker/engine boundary:

- The **adapter** knows how to read its platform's routing signal and returns it as
  opaque strings — `Task.routeKeys: string[]`. It does not know what a repo is.
- The **engine** owns `cfg.repos[]` and maps those strings to a checkout. It does not
  know the strings came from an Asana enum.

So N tags → 1 repo is pure config, and adding a tracker never touches the routing logic.

```
Asana custom field "Platform" = "iOS"
        │  adapter: fetchTask → routeKeys: ["iOS"]
        ▼
cfg.repos: [ {id:"mono", match:["frontend","backend","infra"], default:true}
             {id:"ios",  match:["iOS"]}
             {id:"android", match:["Android"]} ]
        │  engine: resolveRepo(cfg, ["iOS"]) → repos.ios
        ▼
worktree cut from ~/workspace/alephbeta-ios, cwd = it, iOS instructions prepended
```

### Config

```jsonc
{
  "name": "alephbeta",
  "repos": [
    {
      "id": "mono",
      "path": "~/workspace/alephbeta",
      "match": ["frontend", "backend", "infra"],
      "default": true
    },
    {
      "id": "ios",
      "path": "~/workspace/alephbeta-ios",
      "match": ["iOS"],
      "instructionsFile": "./INSTRUCTIONS_IOS.md"
    },
    {
      "id": "android",
      "path": "~/workspace/alephbeta-android",
      "match": ["Android"],
      "worktreePrefix": "../android-agents"
    }
  ],
  "tracker": {
    "type": "asana",
    "routeField": "Platform",
    "pipeline": [ /* unchanged — one lane serves every repo */ ]
  }
}
```

| Field | Meaning |
| --- | --- |
| `repos[].id` | stable id; keys the worktree subdir, the sticky store, and `--repo` flags. `[A-Za-z0-9._-]+` |
| `repos[].path` | checkout root; `~` and config-relative paths resolve like `repoPath` |
| `repos[].match` | route keys that select this repo. Compared **case-insensitively, trimmed** |
| `repos[].default` | at most one; used when a task carries no route key |
| `repos[].instructionsFile` | optional repo context, prepended to the step's instructions |
| `repos[].worktreePrefix` | optional per-repo override of the global `worktreePrefix` |
| `tracker.routeField` | adapter-specific name of the field carrying the route key |

`match` is a list per repo, not a repo per tag, precisely so `[frontend, backend, infra] → mono`
is one entry. Order in the array is the tie-break order for conflict reporting only — it is
**not** a silent precedence (see below).

### Types (`src/types.js`)

```js
/**
 * @typedef {object} RepoConfig
 * @property {string} id
 * @property {string} path              absolute after loadConfig
 * @property {string[]} match           route keys selecting this repo (lowercased after load)
 * @property {boolean} [default]
 * @property {string} [instructionsFile] absolute after loadConfig
 * @property {string} [worktreePrefix]
 */
```

- `Task` gains `@property {string[]} [routeKeys]` — raw, adapter-supplied. Absent/`[]` ⇒ unrouted.
- `Config` gains `@property {RepoConfig[]} repos` — **always populated** (see back-compat) —
  and keeps `repoPath` as the default repo's path.
- `ProviderConfig` gains `@property {string} [routeField]`.
- `Store` gains `getRepo(ref) / setRepo(ref, repoId) / clearRepo(ref)`.

### Resolution

`resolveRepo(cfg, routeKeys) → { repo } | { error }` — pure, in `src/repos.js`, unit-tested:

1. Normalize `routeKeys` (trim, lowercase, drop empties, dedupe).
2. Collect every repo with a non-empty intersection with the key set.
3. **Exactly one** → that repo.
4. **Zero** → the `default` repo if declared; otherwise `error: "unroutable"`.
5. **More than one** → `error: "conflict"`. Never guess: a ticket tagged `backend` *and*
   `iOS` is a human's problem to split, and picking one silently produces a wrong-repo PR
   that reads as correct.

Both errors are **fail-closed** — consistent with `assigneeFilter`'s posture. `dispatch`
resolves the repo right after `fetchTask` and, on error, skips the spawn entirely:

```js
const task = await adapter.fetchTask(job.ref);
const routed = resolveRoute(cfg, store, job.ref, task);   // sticky read + resolveRepo
if (routed.error) {
  emit?.("blocked", job.ref, step.id, { reason: routed.error });
  await adapter.advance(job.ref, step.id, { outcome: "hold", reason: routed.message });
  return { kind: job.kind, ref: job.ref, name: task.name, url: task.url, code: 0 };
}
```

No agent runs, no money spent, the ticket lands in the hold lane with the reason logged.
A step without a hold stage leaves the task in place (existing `advance` behavior) — doctor
warns about that combination when `repos` is declared.

### Stickiness

The repo is resolved on the **first** step that routes a ref and then persisted, mirroring
`difficulty` (`store.js:103-119`, `repo.json` beside `difficulty.json`). Later steps read the
sticky value and skip re-resolution.

Why: `fetchTask` runs per step, so a human editing "Platform" between `code` and `review`
would otherwise repoint `review` at a different repo — and the worktree that `code` built
lives in the old one. Sticky routing makes a mid-flow field edit a no-op for the run in
flight, which is the safe reading.

`clearRepo(ref)` is called wherever `clearAttempts`/`clearDifficulty` already are:
`drainWorktree` on a manual step (`dispatch.js:308-309`) and terminal `fail`/drain
(`dispatch.js:448-451`).

### Worktree layout

`worktreeDir` becomes repo-aware:

```js
export const worktreeDir = (cfg, repo) =>
  path.resolve(repo.path, repo.worktreePrefix || cfg.worktreePrefix || "../agenthook-worktrees");
```

Sibling repos collide: `~/workspace/alephbeta` and `~/workspace/alephbeta-ios` both resolve
`../agenthook-worktrees` to the **same** directory, and `safeRef` is the same task gid — two
repos' worktrees would land on one path. So when a `repos` block is declared the path gains a
repo segment:

- legacy (no `repos` block): `<base>/<safeRef>` — unchanged, existing worktrees keep working
- multi-repo: `<base>/<repoId>/<safeRef>`

`worktreePath(cfg, ref, repo)`, `ensureWorktree(cfg, ref, repo)` and `drainWorktree(cfg, ref, repo)`
all take the resolved repo; the `git -C` host becomes `repo.path` (`worktree.js:67-80`).

### Prompt

`repos[].instructionsFile` is read fresh per run (like step instructions) and prepended:

```
<repo instructions>          ← "This is a SwiftUI app. Build with xcodebuild …"

<step instructions>          ← "How to review"

=== TICKET ===
<stepPrompt>
```

`stepPrompt`'s head also gains `Repo: <id> (<path>)` so the agent can state the mismatch if
routing was wrong, rather than discovering it from the file tree.

This is the piece that makes one lane genuinely serve two stacks: the iOS agent gets Swift
conventions without duplicating the pipeline.

## Adapter contract

`fetchTask` returns `routeKeys`. Every adapter is free to return `[]` (⇒ default repo), so
implementing this per tracker is incremental and non-breaking.

### Asana (first)

Custom field named by `tracker.routeField` (default: none ⇒ no routing). Field is matched by
**name**, case-insensitively, off the task's own `custom_fields`:

```js
const res = await api(
  `/tasks/${ref}?opt_fields=name,notes,permalink_url,assignee.gid,completed,` +
  `custom_fields.name,custom_fields.enum_value.name,custom_fields.multi_enum_values.name,` +
  `custom_fields.text_value,custom_fields.display_value`,
);
```

Extraction, in order: `multi_enum_values[].name` (N values) → `[enum_value.name]` →
`[text_value]` → `[display_value]`. Multi-enum is why `routeKeys` is an array rather than a
string — and why the conflict rule above exists.

A missing or unset field yields `[]`. A field name that matches nothing on the task is
logged once per run at debug level, not an error (the field may simply be blank).

### Other trackers (follow-ups, same contract)

- **GitHub (labels)** — `routeField` is a label **prefix**, e.g. `"platform:"`; keys are the
  suffixes of matching labels (`platform:ios` → `ios`). Pipeline labels are untouched.
- **Jira** — `routeField` names a component, a label, or a custom field (`customfield_NNNNN`);
  read in that order of preference.
- **GitHub Projects v2** — `routeField` names another single-select field on the board;
  read from the item's field values in the same GraphQL query that reads Status.
- **local** — `routeField` reads a top-level string/array key on the JSON item; used by the
  offline harness to test routing without network.

## Ops commands

Every place that reads `cfg.repoPath` becomes repo-aware. `cfg.repos` being always populated
keeps this mechanical:

| File | Change |
| --- | --- |
| `dispatch.js:320-329` | resolve repo → pass to worktree fns; `cwd` from the resolved repo |
| `worktree.js` | 3 fns take `repo`; `git -C repo.path` |
| `paths.js:16` | `worktreeDir(cfg, repo)` |
| `sessions.js:13` | `sessionDir(cfg, ref)` uses sticky repo; falls back to scanning every repo's worktree base for `safeRef` (drained refs have no sticky entry) |
| `cleanup.js:35-58` | loop `cfg.repos`: one `git worktree list` per repo, filtered by that repo's base |
| `follow.js:44` | merge candidate transcript dirs across repos (newest `=== TICKET ===` wins); `--repo <id>` narrows |
| `doctor.js:60` | per-repo git check + the config lints below |
| `heartbeat.js:35` | `repos: [{id, path}]` alongside `repoPath`; `status`/`ls` render ids |
| `run.js` | unchanged — routing happens at dispatch |

### Doctor checks

- every `repos[].path` exists and is a git repo
- ids unique, paths distinct
- no route key claimed by two repos (a static conflict — always unroutable at runtime)
- at most one `default`; **warn loudly when none is set** (unrouted tickets will all hold)
- `routeField` set when `repos.length > 1`, else nothing can ever route
- when `repos` is declared: warn if any step lacks a hold stage (routing errors have nowhere
  to park), and warn if legacy-layout worktrees still exist under a repo base

## Back-compat and migration

`loadConfig` always produces `cfg.repos`:

- no `repos` block → `[{ id: "default", path: repoPath, match: [], default: true }]`, and the
  legacy worktree layout stays. Existing profiles are byte-for-byte unaffected.
- `repos` declared → `repoPath` becomes optional; if present *and* no entry is marked
  `default`, the entry whose `path` equals `repoPath` becomes the default (else a hard config
  error naming the fix).

Migration for a live profile is: drain in-flight tasks (or let them finish), then add `repos`
+ `routeField`. Declaring `repos` changes worktree paths, so a task mid-flow at that moment
would have its worktree orphaned — `doctor` flags the orphans and `cleanup` removes them.

## Tests

Pure units, in keeping with the existing suite:

- `repos.test.js` — `resolveRepo`: single match, N-tags-one-repo, case/whitespace, unrouted →
  default, unrouted → no default → error, conflict → error, empty `routeKeys`
- `config.test.js` — synthesis from `repoPath`; `repos` + `repoPath` reconciliation; duplicate
  id / duplicate route key / two defaults all throw
- `paths.test.js` — legacy vs multi-repo worktree layout; sibling-repo collision is gone
- `asana.test.js` — `routeKeys` extraction from enum / multi-enum / text / missing field
  (pure parse of a fixture payload, no network)

## Rollout

1. **Engine** — `RepoConfig` types, `src/repos.js`, config synthesis + validation, repo-aware
   `paths`/`worktree`/`dispatch`, sticky store, hold-on-unroutable. Ships with the synthesized
   single repo, so behavior is unchanged and it is safe to merge before any adapter reads a field.
2. **Asana `routeKeys`** + repo instructions in the prompt. This is the ticket that unblocks
   backend + iOS.
3. **Ops** — `cleanup`, `sessions`/`resume`, `follow --repo`, `doctor` lints, heartbeat/status.
4. **Other trackers** — GitHub label prefix, Jira, Projects v2, local.

## Non-goals

- One ticket spanning two repos (a coordinated backend+iOS change). It holds for a human to
  split. Cross-repo worktree orchestration is a separate design.
- Per-step repo overrides. The repo is a property of the ticket, not of the stage.
- Auto-creating the tracker field. `init` may offer to *discover* it; it never writes one.
