# Experiment: capability-placement sweep

Tracks GitHub issue [#54](https://github.com/Jesuso/agenthook/issues/54). This directory holds the
**frozen corpus** that turns that runbook into a runnable experiment.

## The question

We front-loaded the tiering (triage `opus/high` · code `sonnet/low` · review `opus/medium`) on the
literature verdict. This sweep tests it on **our own tickets**: where does spending the strong model
buy the most accept-rate per dollar?

Run the SAME corpus under 4 configs, changing exactly **one** stage to the strong model
(`opus + high`) each time, everything else cheap (`sonnet + low`):

| Config | triage | code | review |
|---|---|---|---|
| **0** baseline | cheap | cheap | cheap |
| **P** strong-plan | **strong** | cheap | cheap |
| **C** strong-code | cheap | **strong** | cheap |
| **R** strong-review | cheap | cheap | **strong** |

## The corpus (`capability-placement-corpus.json`)

20 **real, already-shipped** tickets (every one closed `agent:done` — a known-good outcome exists to
judge replays against), curated to span difficulty:

| Difficulty | Count | Refs |
|---|---|---|
| easy | 7 | #1 #4 #7 #12 #19 #66 #68 |
| medium | 8 | #6 #11 #22 #41 #46 #50 #57 #58 |
| hard | 5 | #24 #25 #26 #27 #53 |

`difficulty` is a **curator judgment** from scope + labels (easy = mechanical/localized/single-file,
several `good first issue`; medium = new subcommand or cross-file plumbing or non-trivial bug; hard =
new adapter surface / GraphQL / cross-cutting dispatch logic). It is the axis for prediction **C**
(cheap code fails mainly on the hard subset) — not a precise measure. Each entry freezes
`frozen_body` (the task text at freeze time) so a replay is reproducible even if the live issue is
edited later.

Why closed tickets and not fresh ones: the sweep needs a **fixed** set replayed 4×; real shipped work
gives us a reference solution per ticket to score "accept" against, and the difficulty spread is real
rather than synthetic.

## The replay-substrate problem (why the closed-ticket corpus can't just run)

The dogfood pipeline's `repoPath` **is this repo**, and every closed ticket above is **already
merged into `master`**. The code agent works in a worktree off current `master`, so it would be
asked to "implement #24" while `src/trackers/github-projects.js` already exists → it no-ops or
duplicates. **Accept-rate ≈ 100% for every config = zero discriminating signal.** Replaying shipped
tickets is only valid against a base commit that *predates* each ticket (per-ticket base pinning),
which the live webhook pipeline can't do.

Decision (2026-07-02): run the sweep on a **synthetic corpus** of fresh, unimplemented tasks instead
— clean measurement, no history pollution, uses the live pipeline unchanged. Tradeoff: no known-good
shipped reference, so accept is judged on the replayed PR (tests pass + human). The closed-ticket
corpus (`capability-placement-corpus.json`) is retained for a future per-ticket-base harness.

## The synthetic corpus (`capability-placement-synthetic-corpus.json`)

20 fresh tasks, **verified absent from `master` at freeze**, graded to mirror the difficulty spread:

| Difficulty | Count | IDs |
|---|---|---|
| easy | 7 | E1–E7 |
| medium | 8 | M1–M8 |
| hard | 5 | H1–H5 |

Each carries an issue-ready `body` (goal + acceptance criteria). Because nothing pre-exists in the
repo, every config faces a real, unsolved problem — so accept-rate discriminates.

## Running a config (synthetic corpus)

Per config (0, P, C, R), in order — **each step fires real agents, so order matters**:

1. **Set the tiering** for this config in `agenthook.config.json` (gitignored local file) —
   `pipeline[].model` + `.effort` for `triage`/`code`/`review`. cheap = `claude-sonnet-4-6`/`low`,
   strong = `claude-opus-4-8`/`high`. Then **restart** so the server reloads it:
   ```bash
   node bin/agenthook.js stop && node bin/agenthook.js start --detach
   ```
2. **Reset state** so configs don't share history:
   ```bash
   node bin/agenthook.js cleanup --apply --force              # drain worktrees
   : > ~/.agenthook/agenthook-dogfood/attempts.json && echo '{}' > ~/.agenthook/agenthook-dogfood/attempts.json
   # close the prior config's PRs + delete their branches before re-injecting (avoid conflicts)
   ```
3. **Inject the corpus.** File each task as an issue with `--assignee Jesuso --label agent:triage`
   (fail-closed: no assignee **or** no source label = no fire). The pipeline then drives each
   triage → code → review → done. See the injection snippet below.
4. **Record per task:** accept (clean exit + tests pass + human accept), tokens/cost (`ah usage`),
   rework (`attempts.json` `changes` count).

### Injection snippet

```bash
# after config tiering is set + server restarted:
python3 - <<'PY'
import json, subprocess
m = json.load(open('docs/experiments/capability-placement-synthetic-corpus.json'))
for t in m['tasks']:
    subprocess.run(['gh','issue','create','--repo','Jesuso/agenthook',
        '--title', f"[sweep {t['id']} {t['difficulty']}] {t['title']}",
        '--body', t['body'],
        '--assignee','Jesuso','--label','agent:triage'], check=True)
PY
```

> **Cost note:** 20 tasks × 4 configs = **80 live agent runs → ~80 PRs**. Consider a pilot
> (config 0 on a 3-task subset: one E, one M, one H) to validate the harness + get first numbers
> before committing to the full 80. **Efficiency:** use *tests-pass* as the automated accept signal
> and reserve human accept for the passing subset, rather than judging all 80 by hand.

## Metrics (per config)

- **Accept rate** — clean exit + tests pass + human accept (the real outcome).
- **Tokens / cost** — from the per-run logs (`ah usage` aggregates).
- **Rework** — `changes`-loop count from `attempts.json`.

## Predictions (from the research — confirm or refute)

- **P** buys the most accept-rate per dollar (weak planner ≫ weak executor in damage; ~42% of
  failures are spec/design; errors compound).
- **C** helps mainly on the **hard subset** (cheap code only fails where the base model lacks
  non-trivial success — Snell 2024). This is why the corpus carries a difficulty axis.
- **R** helps little **if** review already runs tests (the test oracle, not the model, catches most
  bugs) — the signal for whether review can come off opus.

## Follow-ups

- **Exp 2** — review oracle vs review smarts: seed known bugs, see whether the test run or the model
  catches them.
- **Exp 3** — difficulty-gated middle: depends on #53's gating in place (it is, as of 0.2.0).
