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

## Running a config

The corpus refs are closed issues, so replay = re-inject them into the pipeline's first stage, run,
measure, reset. Per config:

1. **Set the tiering** for this config in the pipeline (triage/code/review model + effort) — see the
   config table above. The escalation knobs live on the pipeline steps (`model`/`effort`, per #46/#53).
2. **Reset state** between configs so runs don't share history:
   ```bash
   node bin/agenthook.js cleanup --apply --force   # drain done worktrees
   # clear attempts.json for the corpus refs (per-(ref,step) changes-loop counts)
   ```
3. **Re-inject the corpus.** For each ref, put it in triage's source label (reopen + relabel, or
   `agenthook run <ref>` where a step supports direct injection), then let the pipeline drive it
   triage → code → review → done.
4. **Record per ticket:** accept (clean exit + tests pass + human accept), tokens/cost (per-run
   logs), rework (`attempts.json` `changes` count).

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
