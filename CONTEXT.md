# agenthook

Event-driven receiver that runs headless agents on tracker tickets as they move through a pipeline. Its purpose is to boil agent activity down to what a human must act on, since human attention is the bottleneck.

## Language

**Profile**:
One area of work a person peeks at on its own (e.g. development, customer support, content). A person focuses on one profile at a time.
_Avoid_: Project, workspace
_Español_: Perfil

**Ticket**:
A unit of tracker work an agent moves through the pipeline.
_Avoid_: Task, issue, item
_Español_: Ticket

**Epic**:
A large body of work made of several tickets, tracked as one group so a person can see how the whole is progressing. An epic is itself a tracker item, but is not a ticket: no agent runs on it.
_Avoid_: Initiative, project, parent ticket
_Español_: Épica

**Done**:
A ticket whose board says it's done: the tracker's completed/closed flag, or the ticket sits in the pipeline's terminal stage. A merged PR or agents reaching their last step never make a ticket done — see [ADR 0008](adr/0008-done-comes-from-the-board.md). "Done today" counts board transitions to done since local midnight.
_Avoid_: Finished, completed, shipped
_Español_: Terminado

_Finished is agenthook's internal pipeline event (agents reached the last step); it is not a user-facing term and has no Spanish entry here._

**Merged**:
A fact about a ticket's PR (the forge saw it merge), not a stage. Only observable on a profile with a forge, and never on its own makes a ticket done.
_Avoid_: Shipped, landed
_Español_: Fusionado

**Needs you**:
A ticket that is blocked on a human: held, failed, or one of: a PR awaiting merge (board open, PR open); a PR merged but the ticket still open (the bridge didn't deliver); a PR closed unmerged (re-run or close); an open PR on a done ticket. The headline number of a profile.
_Avoid_: Attention, alerts, pending
_Español_: Te necesita

**Ready to close**:
An open epic whose tickets are all Done, waiting for a person to close it on the tracker. Shown
on the epic only — never counted in the profile's headline Needs you.
_Avoid_: completed
_Español_: Listo para cerrar

**Digest**:
An on-demand, agent-written summary of one profile's recent activity, boiled down to what needs a human. Only the latest is kept.
_Avoid_: Report, briefing, summary (ambiguous with a run's verdict summary)
_Español_: Resumen

**Service**:
A throwaway helper (a database, a cache) that a sandboxed run's tests talk to. Defined once on the profile; a step names the services its runs need. Each run gets its own fresh copy, gone when the run ends.
_Avoid_: Sidecar (implementation word), dependency, stack
_Español_: Servicio

**SOUL**:
A profile's standing description of what matters to its owner and how its digest should sound. A markdown file the owner edits.
_Avoid_: Persona, prompt
_Español_: SOUL
