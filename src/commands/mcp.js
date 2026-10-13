// `agenthook mcp [--read-only] [--config <path>]` — MCP server over stdio so external agents
// (Claude Code, other MCP clients) can read the pipeline and manage it. One server multiplexes
// every profile under ~/.agenthook; the `profile` tool argument picks one, defaulting to the
// profile of the config found from cwd (or --config), else the only running profile.
// Register it with:  claude mcp add agenthook -- agenthook mcp
// Docs: docs/mcp.md. stdout is protocol only — diagnostics go to stderr.
import { readFileSync } from "node:fs";
import { createMcpServer, serveStdio } from "../mcp/server.js";
import { createTools } from "../mcp/tools.js";
import { defaultProfileKey } from "../agent-api.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

const INSTRUCTIONS =
  "agenthook pipeline control. New to these tools? Call `guide` once: pipeline model, response shapes, recipes for held/failed/stuck tasks, error meanings. " +
  "Start with `tick` (or `status`) — it is one cheap call and tells you free slots, running agents, queue, held tasks, board and PR state. " +
  "Pass back `etag` as ifNoneMatch and `cursor` to keep repeat calls near-free. To wait for something to happen use `events` with `waitS` instead of looping on status. " +
  "Write tools (run, cancel, release, pause, …) act on the real board and real agents.";

/** @param {any} args */
export async function mcp(args) {
  const readOnly = args["read-only"] === true || process.env.AGENTHOOK_MCP_READONLY === "1";
  const defaultProfile = defaultProfileKey(args.config);
  const server = createMcpServer({
    name: "agenthook",
    version: pkg.version,
    instructions: INSTRUCTIONS,
    handlers: createTools({ readOnly, defaultProfile }),
  });
  console.error(`[mcp] agenthook ${pkg.version} on stdio — ${readOnly ? "read-only" : "read+write"}, default profile: ${defaultProfile ?? "(none)"}`);
  await serveStdio(server);
}
