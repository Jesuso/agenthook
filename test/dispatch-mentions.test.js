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

test("no mentions, no owner, and empty text are identity", () => {
  expect("plain text", "octo", "plain text");
  expect("@bob", undefined, "`@bob`");
  expect("", undefined, "");
});
