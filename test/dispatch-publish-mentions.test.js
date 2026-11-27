import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// Mention safety, redesigned (#829): our own code-vs-prose detection in `neutralizeMentions`
// (src/dispatch/outbox.js) kept disagreeing with GitHub's actual renderer — three review rounds
// on PR #838 found renderer bypasses faster than they could be special-cased. The fix stops
// trying to tell code from prose at all:
//   - `breakAllMentions` (src/dispatch/outbox.js) inserts a zero-width space right after every
//     `@` followed by a letter/digit, with no notion of code — nothing can bypass a rule that
//     doesn't look at structure.
//   - `liveMentions` (src/forges/github.js) asks GitHub's own `/markdown` renderer which logins
//     a piece of text would actually notify (a render-only call — it never notifies anyone).
//   - `publishOutbox` (src/dispatch/publish.js) uses the renderer as the arbiter when the forge
//     offers it: the backtick-wrapped text (`neutralizeMentions`) publishes only when the
//     renderer reports nothing foreign; any other case — a foreign login still live, the call
//     throwing, or no `liveMentions` at all — falls back to `breakAllMentions`. The PR title
//     always goes straight to `breakAllMentions` (no render call).
import test from "node:test";
import assert from "node:assert/strict";
import { breakAllMentions } from "../src/dispatch/outbox.js";
import { publishOutbox } from "../src/dispatch/publish.js";
import { forge as githubForge, stubFetch } from "./_forge-helpers.js";

// --- breakAllMentions ---

/** @param {string} in_ @param {string|undefined} owner @param {string} want */
const expect = (in_, owner, want) => assert.equal(breakAllMentions(in_, owner), want, JSON.stringify({ in_, owner, want }));

test("breakAllMentions: a stranger's mention gets the character, the owner's own (case-insensitive) doesn't", () => {
  expect("@bob", "octo", "@\u200bbob");
  expect("@OCTO hi", "octo", "@OCTO hi");
  expect("@octo @bob", "OCTO", "@octo @\u200bbob");
});

test("breakAllMentions: @org/team is broken (it notifies a whole team)", () => {
  expect("cc @acme/team", "octo", "cc @\u200bacme/team");
});

test("breakAllMentions: @owner-x and @owner/team are NOT the owner's exact mention — both broken", () => {
  expect("@octo-bot", "octo", "@\u200bocto-bot");
  expect("@octo/admins", "octo", "@\u200bocto/admins");
});

test("breakAllMentions: an email gets the character too — there is no context-sensitive exemption left", () => {
  expect("email a@b.com stays live otherwise", "octo", "email a@\u200bb.com stays live otherwise");
});

test("breakAllMentions: a fenced block and an inline code span get the character too — no code exemption at all", () => {
  expect("```\n@bob\n```", "octo", "```\n@\u200bbob\n```");
  expect("`@bob`", "octo", "`@\u200bbob`");
});

test("breakAllMentions: idempotent on its own output", () => {
  const once = breakAllMentions("hi @bob and @octo", "octo");
  assert.equal(breakAllMentions(once, "octo"), once);
});

test("breakAllMentions: with no owner known, every mention is broken (fail closed)", () => {
  expect("@bob @octo", undefined, "@\u200bbob @\u200bocto");
  expect("@bob", null, "@\u200bbob");
});

// --- liveMentions (src/forges/github.js), parsing GitHub's own /markdown render ---

test("liveMentions: collects user- and team-mention anchors, ignores a plain link", async () => {
  const f = githubForge();
  const html =
    `<p>hi <a href="https://github.com/someuser" class="user-mention" data-hovercard-type="user">@someuser</a> ` +
    `and <a href="https://github.com/orgs/acme/teams/core" class="team-mention" data-hovercard-type="team">@acme/core</a> ` +
    `see <a href="https://example.com">docs</a></p>`;
  const stub = stubFetch({ "POST /markdown": { text: html } });
  try {
    const live = await f.liveMentions("hi @someuser and @acme/core see https://example.com");
    assert.deepEqual([...live].sort(), ["acme/core", "someuser"]);
    const call = stub.calls.find((c) => c.url.endsWith("/markdown"));
    assert.ok(call, "the markdown render endpoint was called");
    assert.equal(call.body.mode, "gfm");
  } finally {
    stub.restore();
  }
});

test("liveMentions: a non-2xx throws", async () => {
  const f = githubForge();
  const stub = stubFetch({ "POST /markdown": { status: 502, text: "bad gateway" } });
  try {
    await assert.rejects(() => f.liveMentions("@bob"));
  } finally {
    stub.restore();
  }
});

// --- publishOutbox (src/dispatch/publish.js): the fake forge drives the decision tree ---

/** One fake forge/adapter pair, parameterised by an optional `liveMentions`.
 * @param {{ liveMentions?: (text: string, call: number) => Promise<string[]>, ownerHint?: string }} [o] */
function rig(o = {}) {
  const lines = [];
  /** @type {any} */ let prArg;
  let liveCalls = 0;
  const forge = {
    describe: () => ({ name: "github" }),
    publishBranch: async () => ({ pushed: ["origin/agent/42"] }),
    openPr: async (/** @type {any} */ a) => {
      prArg = a;
      return { number: 7, created: true };
    },
    ...(o.liveMentions
      ? {
          liveMentions: async (/** @type {string} */ text) => {
            liveCalls++;
            return o.liveMentions(/** @type {any} */ (text), liveCalls);
          },
        }
      : {}),
  };
  const adapter = {
    describe: () => ({ platform: "GitHub", taskNoun: "issue", trigger: "@agent", commentHowTo: "comment", ownerHint: o.ownerHint ?? "@octo" }),
    postComment: async (/** @type {any} */ ref, /** @type {any} */ body) => {
      lines.push(`comment:${body}`);
    },
  };
  const store = { setHeld: () => {}, setRefMeta: () => {}, clearFindings: () => {} };
  const verdict = { outcome: "advance", reason: "ok" };
  const base = { ref: "42", stepId: "code", remote: true, hasWorktree: true, worktree: "/wt", branch: "agent/42", verdict, store, log: (/** @type {string} */ l) => lines.push(l), reasonHarness: "worker" };
  return (/** @type {any} */ over = {}) =>
    publishOutbox({ ...base, forge: /** @type {any} */ (forge), adapter: /** @type {any} */ (adapter), ...over }).then((res) => ({ res, lines, verdict, prArg, liveCalls: () => liveCalls }));
}

test("(a) the renderer finds no foreign login -> the backtick-wrapped text publishes, one render call", async () => {
  const run = rig({ liveMentions: async () => [] });
  const r = await run({ outbox: { comment: "hi @bob @octo" } });
  const posted = r.lines.find((l) => l.startsWith("comment:")) ?? "";
  assert.equal(posted, "comment:hi `@bob` @octo");
  assert.equal(r.liveCalls(), 1);
});

test("(b) a foreign login is live on the wrapped text -> every mention is broken instead", async () => {
  const run = rig({ liveMentions: async (_text, call) => (call === 1 ? ["bob"] : []) });
  const r = await run({ outbox: { comment: "hi @bob @octo" } });
  const posted = r.lines.find((l) => l.startsWith("comment:")) ?? "";
  assert.equal(posted, "comment:hi @\u200bbob @octo");
  assert.equal(r.liveCalls(), 2, "the broken text is re-checked once");
});

test("(c) the render call throws -> mentions are broken, no second call", async () => {
  const run = rig({ liveMentions: async () => Promise.reject(new Error("boom")) });
  const r = await run({ outbox: { comment: "hi @bob @octo" } });
  const posted = r.lines.find((l) => l.startsWith("comment:")) ?? "";
  assert.equal(posted, "comment:hi @\u200bbob @octo");
  assert.equal(r.liveCalls(), 1);
});

test("(d) the forge has no liveMentions -> mentions are broken, no render call at all", async () => {
  const run = rig({});
  const r = await run({ outbox: { comment: "hi @bob @octo" } });
  const posted = r.lines.find((l) => l.startsWith("comment:")) ?? "";
  assert.equal(posted, "comment:hi @\u200bbob @octo");
});

test("(e) still live after breaking every mention -> that item is skipped; an unrelated item still publishes", async () => {
  const run = rig({ liveMentions: async (text) => (text.includes("bob") ? ["bob"] : []) });
  const r = await run({ outbox: { comment: "hi @bob", pr: { title: "t", body: "a perfectly safe body" } } });
  assert.equal(r.res.comment, undefined, "the comment was not posted");
  assert.ok(
    r.lines.some((l) => l.includes("still live after breaking")),
    "a run-log line explains the skip",
  );
  assert.ok(r.res.pr, "the unrelated PR still published");
  assert.equal(r.prArg.body, "a perfectly safe body");
});

test("(f) the PR title is always broken directly — the renderer is never asked about it", async () => {
  const run = rig({
    liveMentions: async (text) => {
      if (text.includes("@bob")) throw new Error("the title must never reach the renderer");
      return [];
    },
  });
  const r = await run({ outbox: { pr: { title: "ping @bob", body: "no mentions here" } } });
  assert.equal(r.prArg.title, "ping @\u200bbob");
  assert.equal(r.prArg.body, "no mentions here");
});

// --- the 14 renderer-disagreement bypass inputs found across three review rounds on PR #838:
// each used to let a live "@octocat" mention through `neutralizeMentions`'s code-vs-prose
// guess. `breakAllMentions` has no such guess, so every one of them is neutralised when the
// renderer reports the login still live (path (b)) — the whole point of the redesign.
const BYPASSES = [
  "\t```\n@octocat\n\t```", // TAB-indented fence (an indented code block, not a fence)
  " ```\n@octocat\n```", // NBSP-indented fence
  "```\nx\n```\r\n@octocat\r\n", // CRLF closing fence
  "see \\` x @octocat ` here", // backslash-escaped backtick
  "a ` stray backtick, then @octocat", // unmatched backtick
  "# @octocat", // ATX heading
  "@octocat\n====", // setext heading
  "---\n@octocat", // thematic break
  "> ```\n> @octocat\n> ```", // fence inside a blockquote
  "- ```\n  @octocat\n  ```", // fence inside a list item
  "| a | @octocat |\n|---|---|", // table cell
  '<div data-x="@octocat">hi</div>', // raw HTML attribute
  "<@octocat>", // autolink
  "<pre>\n@octocat\n</pre>", // raw HTML block
];

test("all 14 historical renderer-disagreement bypass inputs: none publishes a live @octocat once the renderer flags it", async () => {
  for (const input of BYPASSES) {
    const run = rig({ liveMentions: async (_text, call) => (call === 1 ? ["octocat"] : []) });
    const r = await run({ outbox: { comment: input } });
    const posted = r.lines.find((l) => l.startsWith("comment:")) ?? "";
    assert.ok(!posted.includes("@octocat"), `bypass not neutralised: ${JSON.stringify(input)} -> ${JSON.stringify(posted)}`);
  }
});
