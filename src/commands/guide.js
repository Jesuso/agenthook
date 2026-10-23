// `agenthook guide [topic]` — the agent guide from a shell, for agents without the MCP server
// (same text the MCP `guide` tool serves). No topic = the list. `authoring` is rendered from this
// profile's config: tracker, identity, step stages, epic rule, blocker support (src/guide.js).
import { loadConfig } from "../config.js";
import { AUTHORING, guideTopics, loadGuide, renderAuthoring } from "../guide.js";

/** @param {any} args */
export async function guide(args) {
  const topic = typeof args._[0] === "string" ? args._[0].toLowerCase() : "";
  if (!topic) {
    console.log(`topics: ${guideTopics().join(", ")}, all\nagenthook guide <topic>   # \`authoring\` reads ./agenthook.config.json (or --config)`);
    return;
  }
  if (topic === AUTHORING) {
    console.log(renderAuthoring(loadConfig({ configPath: args.config })));
    return;
  }
  const { topics } = loadGuide();
  if (topic === "all") return void console.log([...topics.values()].join("\n\n"));
  const t = topics.get(topic);
  if (!t) {
    console.error(`unknown topic "${topic}". Topics: ${guideTopics().join(", ")}, all`);
    process.exit(1);
  }
  console.log(t);
}
