# Asana example profile

A runnable 3-step **triage → code → review** pipeline (plus a terminal `done` that drains the
worktree) for the Asana tracker.

1. Copy this directory into your project (it becomes the config dir).
2. Create a `.env` beside `agenthook.config.json` with `ASANA_TOKEN=...` (and `NGROK_AUTHTOKEN=...`).
3. Fill the `YOUR_*` ids (`userGid`/`workspaceGid`/`projectGid`) and `repoPath`, then map each step's
   `TODO_*_GID` to a real Asana section gid (chaining: one step's `successSectionGid` = the next's
   `sourceSectionGid`).
4. `agenthook doctor` then `agenthook start`.

Finding the ids and the webhook are covered in [docs/asana-setup.md](../../docs/asana-setup.md).
