# An Asana epic is a task with the custom task type "Epic"

Asana has no native epic. We read an epic as a task whose Asana custom task type is "Epic" (the type
name is configured), and its tickets as the epic's direct subtasks that are also in the profile's
project. The receiver never runs an agent on an Epic-typed task, even if it lands in a pipeline stage.

## Why

- Identity must be explicit. Treating any parent task, or any task with dependencies, as an epic
  misreads ordinary structure. A task type marks intent and nothing else uses it.
- Asana's own guidance only describes epics as a convention (sections, a dropdown field, Portfolios,
  a separate project). Of those, the task type is the closest native marker, and the API exposes it
  (`custom_type`, `GET /custom_types`).
- Membership by `parent` is read from the ticket side, which `fetchTask` already loads. Dependencies
  are not membership: they already gate tickets (`openBlockers`).

## Consequences

- The user creates the type and retypes existing epics; our workspace had none and the three
  existing epics used dependencies, one subtask, and prose.
- Asana limits: no advanced-search filter for task types, types are set by a `PUT` after create, and
  we have not verified webhook behaviour on a type change.
- Epic progress is a live read of the epic's subtasks on demand (cached, no timer polling); the
  read-only UI reaches it through the receiver. GitHub and Jira get their own mapping later onto the
  same tracker-neutral epic shape.
