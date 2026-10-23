# Authoring work for agenthook

Run `agenthook guide authoring` first (MCP `guide {topic:"authoring"}`). It prints, for this
profile: the tracker kind, the identity a ticket must be assigned to, every step with its
source / success / hold / failure / queue stage, the first step for new work, how an epic is
recognised, and whether dependencies are honoured. Everything below refers to those values.

## One ticket

1. **Write the body for an agent, not a person.** Goal, acceptance criteria as a checklist, the
   files or areas involved, what is out of scope. Decisions belong in the **body**, not in
   comments — the agent's prompt carries the body; comments are read only on an explicit resume.
2. **Create it on the tracker** assigned to the receiver's identity (`guide authoring` →
   "ours"). Tracker calls: `references/trackers/<kind>.md`.
3. **Put it in a stage.** Either create it directly in the first step's source stage, or create
   it unstaged and start it with `agenthook run <ref> [stepId]` (MCP `run`) — `run` assigns and
   moves in one call and is the safer path on every tracker. Use `run` with `force:true` only when
   you know no agent is on the ticket.
4. **Verify**: `agenthook watch --ref <ref> --event enqueued,run_start --timeout 60`. Nothing
   within a minute → re-read the ticket: assignee? stage? open blocker? Is the receiver up
   (`agenthook status`)? A ticket resting unfired after the receiver was down is replayed by
   `agenthook reconcile`.

Do not start a ticket in a `manual` step (those are human lanes such as "done").

## An epic with tickets

An epic is recognised by **type or label only** (`guide authoring` → Epics). It is a container:

- The epic itself must **not** be in any step's source stage and needs no assignee. An epic that
  lands in a stage is skipped (`epic_skipped` event) — nothing runs, nothing moves.
- Its tickets are linked the tracker's native way (sub-issues / subtasks / `parent`), never by
  prose like "part of #12" or a task-list checkbox. Each ticket is created exactly like
  "One ticket" above: assigned to us, body for an agent, staged or `run`.
- Tickets that depend on one another: see Dependencies. Start only the unblocked ones.

Steps:

1. Create the epic (typed/labelled as `guide authoring` says), body = the overall goal and the
   intended split. No stage, no assignee.
2. Create each ticket linked to the epic. Body per ticket, acceptance criteria, assignee = us.
3. Declare dependencies (if the tracker honours them) or leave dependents unstaged.
4. `run` the first ticket(s). Verify with `watch`.
5. `agenthook epics --ref <epic>` (MCP `epics {ref}`): every ticket should list with a `bucket`
   (`backlog`, `running`, `needsYou`, `finished`, `merged`); `untracked` means the link is not the
   native one or the ticket is outside the project/board/repo.

When a pipeline step (e.g. triage) splits an epic, it follows the same list, then ends with the
tickets' refs in its verdict summary so the next step and the user can find them.

## Dependencies

If `guide authoring` says the tracker honours blockers (GitHub Issues, Asana today): declare the
native dependency, then stage both tickets. The blocked one rests in its source stage and fires
on its own when the blocker is done — on GitHub that means the blocker **issue is closed**
(a step with `closeIssue:true`, or `Closes #N` in the merged PR); a merge alone does not close it.
On Asana the blocker must be marked **completed** (a step with `completeTask:true`, or the merge
path).

Otherwise agenthook ignores links. Keep the dependent ticket out of every source stage and `run` it
yourself after the blocker lands (watch for `pipeline_done` / `merged` on the blocker).

## Taking an existing ticket

`agenthook run <ref> [stepId]` — assigns the receiver's identity and enters the step's source
stage. A ticket already in a pipeline stage is refused without `force`. To re-fire a ticket that
is *already resting* in its source stage, use `agenthook catchup <ref>` (replays the event),
not `run --force` (a move into the same stage fires nothing).

## Checklist before you say "created"

- [ ] assignee = receiver identity (every ticket; not the epic)
- [ ] ticket in a non-manual step's source stage, or started with `run`
- [ ] epic typed/labelled per `guide authoring`, children linked natively
- [ ] dependents either natively blocked (supported trackers) or left unstaged
- [ ] `watch` showed `enqueued`/`run_start`, or `epics --ref` lists every child
