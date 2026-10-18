// The default agent image for the per-run container sandbox. The recipe ships here, inside
// src/ (docker/ is not in the npm package), and is built with the Dockerfile on stdin and no
// build context: `<runtime> build -t <image> -`. `agenthook doctor --fix` runs exactly that.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

/** The image a sandbox runs when `sandbox.image` is unset. */
export const DEFAULT_IMAGE = `agenthook-agent:${pkg.version}`;

/** The agent image recipe. No USER (the run sets the host uid) and no CMD (the run names the
 * agent binary). A custom `sandbox.image` built FROM this must keep sh, git, gh and the agent
 * CLI on PATH. */
export const AGENT_DOCKERFILE = `FROM node:22-bookworm-slim
RUN apt-get update \\
  && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \\
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \\
  && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \\
  && apt-get update \\
  && apt-get install -y --no-install-recommends gh \\
  && rm -rf /var/lib/apt/lists/*
ARG CLAUDE_VERSION=latest
RUN npm i -g @anthropic-ai/claude-code@\${CLAUDE_VERSION}
RUN mkdir -p /home/agent && chmod 1777 /home/agent
`;

/** The build argv (after the runtime binary); the Dockerfile goes on stdin.
 * @param {string} _runtime "docker" | "podman" (same syntax today) @param {string} image */
export function buildImageArgs(_runtime, image) {
  return ["build", "-t", image, "-"];
}
