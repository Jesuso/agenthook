import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SINK_EVENTS, SINK_REQUIRED, SINK_TYPES, sinkErrors } from "../src/sinks-config.js";

test("SINK_TYPES / SINK_REQUIRED / DEFAULT_SINK_EVENTS", () => {
  assert.deepEqual(SINK_TYPES, ["slack", "webhook", "telegram"]);
  assert.deepEqual(SINK_REQUIRED, { slack: ["url"], webhook: ["url"], telegram: ["botToken", "chatId"] });
  assert.deepEqual(DEFAULT_SINK_EVENTS, ["blocked", "failed", "move_refused", "pipeline_done"]);
});

test("sinkErrors: absent and valid sinks have no errors", () => {
  assert.deepEqual(sinkErrors(undefined), []);
  assert.deepEqual(sinkErrors(null), []);
  assert.deepEqual(sinkErrors([]), []);
  assert.deepEqual(
    sinkErrors([
      { type: "slack", url: "${SLACK_URL}" },
      { type: "webhook", url: "https://x.example", events: ["blocked", "anything"] },
      { type: "telegram", botToken: "${TG}", chatId: 12345 },
    ]),
    [],
  );
});

test("sinkErrors: the validateRawConfig wording", () => {
  assert.deepEqual(sinkErrors({}), [`config: sinks must be an array.`]);
  assert.deepEqual(sinkErrors([null, 5, { type: "discord" }, { type: "constructor" }]), [
    `config: sinks[0].type must be one of slack, telegram, webhook (got undefined).`,
    `config: sinks[1].type must be one of slack, telegram, webhook (got undefined).`,
    `config: sinks[2].type must be one of slack, telegram, webhook (got "discord").`,
    `config: sinks[3].type must be one of slack, telegram, webhook (got "constructor").`,
  ]);
  assert.deepEqual(sinkErrors([{ type: "slack", url: "" }, { type: "telegram", botToken: "t" }, { type: "webhook", url: "u", events: "run_end" }, { type: "slack", url: "u", events: [1] }]), [
    `config: sinks[0] (slack) requires "url".`,
    `config: sinks[1] (telegram) requires "chatId".`,
    `config: sinks[2].events must be an array of strings.`,
    `config: sinks[3].events must be an array of strings.`,
  ]);
});
