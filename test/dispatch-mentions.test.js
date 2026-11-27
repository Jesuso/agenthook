import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// `neutralizeMentions` (src/dispatch/outbox.js, #829): worker-written text is untrusted —
// before the hub publishes a remote run's outbox under its own identity, every GitHub-style
// mention is wrapped in backticks so a ticket can't use it to @mention an arbitrary user.
// The owner's own login is exempt (case-insensitive); with no owner known, EVERY mention is
// neutralised (fail closed).
import test from "node:test";
import assert from "node:assert/strict";
import { neutralizeMentions } from "../src/dispatch/outbox.js";

/** @param {string} in_ @param {string|undefined} owner @param {string} want */
const expect = (in_, owner, want) => assert.equal(neutralizeMentions(in_, owner), want, JSON.stringify({ in_, owner, want }));

test("a stranger's mention is wrapped, a trailing word is not", () => {
  expect("@bob @octo", "octo", "`@bob` @octo");
  expect("hello @bob and bob", "octo", "hello `@bob` and bob");
  expect("@bob@x", "octo", "`@bob`@x");
  expect("ping @john-doe please", "octo", "ping `@john-doe` please", "hyphenated logins must match — under-matching is the unsafe direction");
  expect("cc @acme/team", "octo", "cc `@acme/team`", "org/team mentions notify the whole team");
});

test("the owner's own login is exempt, case-insensitively", () => {
  expect("@OCTO hi", "octo", "@OCTO hi");
  expect("@octo @bob", "OCTO", "@octo `@bob`");
});

test("with no owner known every mention is neutralised (fail closed)", () => {
  expect("@bob", undefined, "`@bob`");
  expect("@bob @octo", null, "`@bob` `@octo`");
});

test("code is never rewritten: inline spans (even across lines) and fenced blocks pass through", () => {
  expect("`@bob`", "octo", "`@bob`");
  expect("a @bob b `@bob` c", "octo", "a `@bob` b `@bob` c");
  expect("``\n@bob\n``", "octo", "``\n@bob\n``", "a double-backtick span spans lines");
  expect("```\n@bob\n```", "octo", "```\n@bob\n```");
  expect("```js\nconst s = '@bob';\n```\n@octo", "octo", "```js\nconst s = '@bob';\n```\n@octo", "a fence opens, the mention inside stays, the mention after it doesn't");
  expect("a `x`@bob b", "octo", "a `x`\`@bob\` b", "a mention right after a closing span is still neutralised (fail closed)");
});

test("newlines separate mentions; emails are untouched", () => {
  expect("@bob\n@octo", "octo", "`@bob`\n@octo");
  expect("email a@b.com stays", "octo", "email a@b.com stays", "a word char precedes the @ — not a mention");
});

test("an UNMATCHED backtick is literal text — it must not swallow the paragraph or smuggle a live mention", () => {
  expect("a ` stray backtick, then @stranger", "octo", "a ` stray backtick, then `@stranger`");
  expect("``` a`b\n@stranger", "octo", "``` a`b\n`@stranger`", "a backtick fence with a backtick in its info string is not a fence (CommonMark)");
  expect("a ` b ` c ` @d", "octo", "a ` b ` c ` `@d`", "the first two runs pair up; a stray third run stays literal");
});

test("no mentions, no owner, and empty text are identity", () => {
  expect("plain text", "octo", "plain text");
  expect("@bob", undefined, "`@bob`");
  expect("", undefined, "");
});

test("renderer bypasses are neutralised: when we and GitHub might disagree about code, we neutralise", () => {
  // A TAB-indented "```" is an indented code block in CommonMark (a tab is 4 columns), not a
  // fence — the line after it is a live-mention paragraph on GitHub. (Red before: the FENCE
  // regex matched tabs via \s{0,3}, opened a never-closing fence, and the mention passed.)
  expect("\t\u0060\u0060\u0060\n@octocat\n\t\u0060\u0060\u0060", "me", "\t\u0060\u0060\u0060\n`@octocat`\n\t\u0060\u0060\u0060");
  // Same for a U+00A0 (NBSP) indent: \s matched it, CommonMark only counts U+0020 spaces.
  expect("\u00a0\u0060\u0060\u0060\n@octocat\n\u0060\u0060\u0060", "me", "\u00a0\u0060\u0060\u0060\n`@octocat`\n\u0060\u0060\u0060");
  // A CRLF closing fence: the line is "```\r" when split on \n only, and "." does not match \r —
  // the block "never closed" and every later mention passed. GitHub treats \r\n as a line
  // ending. (Red before: the CRLF split kept the closer from matching the FENCE regex.)
  expect("\u0060\u0060\u0060\nx\n\u0060\u0060\u0060\r\n@octocat\r\n", "me", "\u0060\u0060\u0060\nx\n\u0060\u0060\u0060\r\n`@octocat`\r\n");
  // A backslash-escaped backtick (\`) is a literal backtick that never opens a code span
  // (CommonMark 2.4) — before, it paired with the unescaped one and protected the mention.
  expect("see \\\u0060 x @octocat \u0060 here", "me", "see \\\u0060 x `@octocat` \u0060 here");
});
