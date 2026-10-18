# Digest and ticket summaries

## Key files

- `src/digest.js` + `src/digest-config.js` — the on-demand **Digest** (docs/web-ui.md, ADR 0002): `buildSnapshot` (pure over a state dir), `buildDigestArgs` (tool-less `claude -p`, project settings only, never `fullAuto`), `createDigester` (single-flight, outside the slot pool, writes `<stateDir>/digest.json`, emits `digest_start`/`digest_end`). Reached only through the `digest` control op (`ops.js`) ← `POST /api/digest`; the SOUL file (`digest.soul`, default `SOUL.md` beside the config) is on the instructions allowlist with scope `soul`.
- `src/ticket-summary.js` — `summarizeDescription` (pure): a tracker description → one plain paragraph (≤240 chars, first prose paragraph, markdown/fences/checklists stripped), stored by dispatch as `refmeta.summary` and shown by the UI as what a ticket is about.
