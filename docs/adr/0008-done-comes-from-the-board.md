# Done comes from the board; the forge is a bridge

A ticket is **Done** when its board says so — the tracker's completed/closed flag, or the ticket sits in the pipeline's terminal stage. Nothing else makes a ticket done: not a merged PR, and not agenthook's agents reaching their last step. agenthook works between three systems (itself, the forge, the board); each fact has one owner. The board owns *is this work done*; the forge owns *did this code land*; agenthook owns *are agents working on it*.

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
