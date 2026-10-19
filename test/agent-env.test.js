import "./_setup.js"; // first: isolate AGENTHOOK_HOME even for single-file `node --test` runs
// The agent spawn env allowlist (#470): pure, no process.env reads beyond the defaults.
import test from "node:test";
import assert from "node:assert/strict";
import { BASE_AGENT_ENV, agentEnvAllow, buildAgentEnv, envNameMatches, looksSecret, strippedNames } from "../src/agent-env.js";
import { AGENTS } from "../src/agents/index.js";
import { TRACKER_AGENT_ENV, TRACKERS } from "../src/trackers/index.js";
import { FORGE_AGENT_ENV, FORGES } from "../src/forges/index.js";

const source = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  LC_ALL: "C.UTF-8",
  XDG_RUNTIME_DIR: "/run/user/1000",
  NGROK_AUTHTOKEN: "ngrok",
  GITHUB_APP_PRIVATE_KEY: "pem",
  ASANA_TOKEN: "asana",
  SOME_SECRET: "x",
};

test("buildAgentEnv with BASE_AGENT_ENV keeps process basics and drops credentials", () => {
  const env = buildAgentEnv({ source, allow: BASE_AGENT_ENV, platform: "linux" });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/u", LC_ALL: "C.UTF-8", XDG_RUNTIME_DIR: "/run/user/1000" });
  assert.deepEqual(strippedNames({ source, allow: BASE_AGENT_ENV, platform: "linux" }), ["ASANA_TOKEN", "GITHUB_APP_PRIVATE_KEY", "NGROK_AUTHTOKEN", "SOME_SECRET"]);
});

test("envNameMatches: a PREFIX* matches only at the start; \"*\" passes everything", () => {
  assert.equal(envNameMatches("LC_ALL", ["LC_*"], "linux"), true);
  assert.equal(envNameMatches("XLC_ALL", ["LC_*"], "linux"), false);
  assert.equal(envNameMatches("PATHX", ["PATH"], "linux"), false);
  assert.deepEqual(buildAgentEnv({ source, allow: ["*"], platform: "linux" }), source);
  assert.deepEqual(strippedNames({ source, allow: ["*"], platform: "linux" }), []);
});

test("buildAgentEnv: layers override in order and may set a name the allowlist drops", () => {
  const env = buildAgentEnv({ source, allow: ["PATH"], layers: [{ HERMES_HOME: "/a", X: "1" }, undefined, { X: "2", SOME_SECRET: "step" }], platform: "linux" });
  assert.deepEqual(env, { PATH: "/usr/bin", HERMES_HOME: "/a", X: "2", SOME_SECRET: "step" });
});

test("buildAgentEnv: strip removes allowlisted source names, but a layer may still set them (#474)", () => {
  const src = { ...source, GITHUB_TOKEN: "pat", GH_TOKEN: "pat2" };
  const env = buildAgentEnv({ source: src, allow: ["PATH", "GITHUB_TOKEN", "GH_TOKEN"], strip: ["GITHUB_TOKEN", "GH_TOKEN"], layers: [{ GH_CONFIG_DIR: "/run/gh" }, { GH_TOKEN: "step" }], platform: "linux" });
  assert.deepEqual(env, { PATH: "/usr/bin", GH_CONFIG_DIR: "/run/gh", GH_TOKEN: "step" });
});

test("envNameMatches: case-insensitive on win32 only", () => {
  assert.equal(envNameMatches("Path", ["PATH"], "win32"), true);
  assert.equal(envNameMatches("Path", ["PATH"], "linux"), false);
  assert.deepEqual(buildAgentEnv({ source: { Path: "C:\\bin", SystemRoot: "C:\\Windows" }, allow: BASE_AGENT_ENV, platform: "win32" }), { Path: "C:\\bin", SystemRoot: "C:\\Windows" });
});

test("looksSecret: credential-shaped names only", () => {
  for (const n of ["NGROK_AUTHTOKEN", "GITHUB_APP_PRIVATE_KEY", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "DB_PASSWORD", "GOOGLE_APPLICATION_CREDENTIALS"]) assert.equal(looksSecret(n), true, n);
  for (const n of ["PATH", "TERM", "KEYTIMEOUT", "AWS_REGION"]) assert.equal(looksSecret(n), false, n);
});

test("buildAgentEnv: undefined source and layer values are dropped", () => {
  const env = buildAgentEnv({ source: { PATH: undefined, HOME: "/h" }, allow: ["*"], layers: [/** @type {any} */ ({ X: undefined })], platform: "linux" });
  assert.deepEqual(env, { HOME: "/h" });
  assert.deepEqual(strippedNames({ source: { SOME_SECRET: undefined }, allow: [], platform: "linux" }), []);
});

test("agentEnvAllow: base, then agent, tracker, forge, operator, in order", () => {
  assert.deepEqual(agentEnvAllow({ agent: ["A"], tracker: ["T"], forge: ["F"], operator: ["O"] }), [...BASE_AGENT_ENV, "A", "T", "F", "O"]);
  assert.deepEqual(agentEnvAllow(), BASE_AGENT_ENV);
});

test("declarations: each agent's envPassthrough, each tracker's and forge's agentEnv", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(AGENTS).map(([k, a]) => [k, a.envPassthrough])),
    { claude: ["ANTHROPIC_*", "CLAUDE_*"], cursor: ["CURSOR_API_KEY"], hermes: ["HERMES_HOME"], opencode: ["OPENCODE_*"] },
  );
  assert.deepEqual(Object.keys(TRACKER_AGENT_ENV).sort(), Object.keys(TRACKERS).sort());
  assert.deepEqual(TRACKER_AGENT_ENV, { asana: ["ASANA_TOKEN"], jira: ["JIRA_API_TOKEN"], github: ["GITHUB_TOKEN"], "github-projects": ["GITHUB_TOKEN"], local: [], linear: ["LINEAR_API_KEY"] });
  assert.deepEqual(Object.keys(FORGE_AGENT_ENV).sort(), Object.keys(FORGES).sort());
  assert.deepEqual(FORGE_AGENT_ENV, { github: ["GH_TOKEN", "GITHUB_TOKEN"], gitlab: [] });
});
