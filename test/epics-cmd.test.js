import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `agenthook epics` CLI: text digest() (list + --ref detail) and readEpics against a fixture
// state dir with the receiver down (live:false, built from refmeta.epic).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pickProfile, readEpics } from "../src/agent-api.js";
import { digest } from "../src/commands/epics.js";

test("digest: list header + one line per epic, needs-you and eta", () => {
  const out = digest({
    at: "t",
    live: true,
    supported: true,
    epics: [
      { ref: "E1", name: "Epic one", total: 5, byStage: { finished: 2, merged: 1, backlog: 1, running: 1, needsYou: 0, untracked: 0 }, needsYou: [], eta: { days: 3, date: "2026-10-20" } },
      { ref: "E2", name: "Epic two", total: 2, byStage: { finished: 0, merged: 0, backlog: 0, running: 0, needsYou: 2, untracked: 0 }, needsYou: ["9", "10"], eta: null },
    ],
  });
  const lines = out.split("\n");
  assert.equal(lines[0], "live 2 epics");
  assert.equal(lines[1], 'E1 "Epic one" 3/5 eta 2026-10-20');
  assert.equal(lines[2], 'E2 "Epic two" 0/2 needs-you: 9 10');
});

test("digest: readyToClose appends ' ready-to-close' to the line", () => {
  const out = digest({
    at: "t",
    live: true,
    supported: true,
    epics: [{ ref: "E1", name: "Epic one", total: 2, byStage: { finished: 2, merged: 0, backlog: 0, running: 0, needsYou: 0, untracked: 0 }, needsYou: [], eta: null, readyToClose: true }],
  });
  assert.equal(out.split("\n")[1], 'E1 "Epic one" 2/2 ready-to-close');
});

test("digest: --ref detail is the epic line then one line per ticket; unsupported", () => {
  const out = digest({
    at: "t",
    live: false,
    supported: true,
    epic: {
      ref: "E1",
      name: "Epic one",
      total: 2,
      byStage: { finished: 1, merged: 0, backlog: 0, running: 0, needsYou: 1, untracked: 0 },
      needsYou: ["12"],
      eta: null,
      tickets: [
        { ref: "11", displayId: "#11", name: "First", bucket: "untracked" },
        { ref: "12", name: "Second", bucket: "needsYou" },
      ],
    },
  });
  const lines = out.split("\n");
  assert.equal(lines[0], 'E1 "Epic one" 1/2 needs-you: 12');
  assert.equal(lines[1], '  #11 untracked "First"');
  assert.equal(lines[2], '  12 needsYou "Second"');
  assert.equal(digest({ supported: false }), "epics unsupported");
});

test("readEpics against a down profile's refmeta: live:false list and detail; unknown ref names the fallback", async () => {
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), "agenthook-epics-cmd-"));
  const dir = path.join(registry, "down");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "refmeta.json"),
    JSON.stringify({
      "11": { title: "First", displayId: "#11", epic: { ref: "E1", name: "Epic one", url: "https://x/E1" } },
      "12": { title: "Second", epic: { ref: "E1", name: "Epic one", url: "https://x/E1" } },
    }),
  );
  fs.writeFileSync(path.join(dir, "held.json"), JSON.stringify({ "12": { stepId: "code", reason: "q?", heldAt: "2026-10-15T00:00:00Z" } }));

  const picked = pickProfile("down", null, registry);
  assert.ok("entry" in picked);
  const list = await readEpics(picked.entry, { registry });
  assert.equal(list.live, false);
  assert.equal(list.supported, true);
  assert.deepEqual(list.epics.map((e) => e.ref), ["E1"]);
  assert.equal(list.epics[0].readyToClose, false);

  const detail = await readEpics(picked.entry, { ref: "E1", registry });
  assert.equal(detail.live, false);
  assert.deepEqual(detail.epic.tickets.map((t) => t.ref), ["11", "12"]);

  await assert.rejects(() => readEpics(picked.entry, { ref: "NOPE", registry }), /no epic NOPE \(receiver down/);
  await assert.rejects(() => readEpics(picked.entry, { ref: "bad ref!", registry }), /invalid epic ref/);
});
