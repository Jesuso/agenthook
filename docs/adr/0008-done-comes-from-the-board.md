# Done comes from the board; the forge is a bridge

A ticket is **Done** when its board says so — the tracker's own completed/closed flag, and only that. Nothing else makes a ticket done: not a merged PR, and not agenthook's agents reaching their last step. The pipeline's terminal stage (a manual step's source stage, e.g. `agent:done`) is agenthook's **handoff**: agents are finished and the PR waits for a human, but the board is still open. agenthook works between three systems (itself, the forge, the board); each fact has one owner. The board owns *is this work done*; the forge owns *did this code land*; agenthook owns *are agents working on it*.

The forge is a **bridge**, not a status source. Boards that hear the forge themselves (GitHub Issues closed by `Closes #N`, Jira with a GitHub/Bitbucket integration) close their own tickets on merge. For boards that can't (Asana, Linear without the integration, `local`), agenthook's forge adapter carries the merge to the board — the `completeOnMerge` merge job — and the board's resulting done is what counts. PR facts (branch, number, open/merged/closed) are a convenience shown on the ticket, like Jira's development panel.

PR state never sets a ticket's progress; it only produces **Needs you** reasons when code and board disagree:

| Board ↓ / PR → | none | open | merged | closed unmerged |
|---|---|---|---|---|
| open | in flight / held / failed | needs you: awaiting merge | needs you: PR merged, close the ticket (bridge didn't deliver) | needs you: PR abandoned — re-run or close |
| done | done | done + needs you: open PR on a done ticket | done | done |

## Consequences

One terminal state (Done, one green) in every bar and count; `Merged` stops being a stage and `Finished` stops being user-facing; "done today" counts board transitions to done; a profile without a forge needs no special case (no PR facts, the board alone decides).

## Considered and rejected

Two terminal states (finished vs merged), which showed two greens for one meaning and painted an open PR (hollow green) the colour of done.

The terminal stage as a second source of done. On the dogfood board the agents enter `agent:done` before the PR merges, so the stage turned unmerged work green; only the tracker's own flag waits for the merge. A tracker that never delivers its flag (GitHub Projects v2) or has none (`local`, whose flag is its terminal stage) is read at stage entry instead (`fetchTask().completed`).
