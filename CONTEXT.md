# agenthook

Event-driven receiver that runs headless agents on tracker tickets as they move through a pipeline. Its purpose is to boil agent activity down to what a human must act on, since human attention is the bottleneck.

## Language

**Profile**:
One area of work a person peeks at on its own (e.g. development, customer support, content). A person focuses on one profile at a time.
_Avoid_: Project, workspace

**Ticket**:
A unit of tracker work an agent moves through the pipeline.
_Avoid_: Task, issue, item

**Finished**:
A ticket whose agents reached the pipeline's terminal step. Means agents are done, not that the work shipped. "Done today" counts tickets finished since local midnight.
_Avoid_: Done (ambiguous with merged), completed, shipped

**Merged**:
A ticket's PR was merged. Only observable on a profile with a forge.
_Avoid_: Shipped, landed

**Needs you**:
A ticket that is blocked on a human: held, failed, or a PR awaiting merge. The headline number of a profile.
_Avoid_: Attention, alerts, pending
