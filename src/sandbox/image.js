// The default agent image for the per-run container sandbox. The recipe ships here, inside
// src/ (docker/ is not in the npm package), and is built with the Dockerfile on stdin and no
// build context: `<runtime> build -t <image> -`. `agenthook doctor --fix` runs exactly that.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

/** The image a sandbox runs when `sandbox.image` is unset. */
export const DEFAULT_IMAGE = `agenthook-agent:${pkg.version}`;

/** `DEFAULT_IMAGE`, but read fresh off `package.json` on disk every call (#885): a restart's
 * respawn runs the code on disk, which may expect a tag newer than this process's own
 * `DEFAULT_IMAGE` (fixed at module load). */
export function diskDefaultImage() {
  const diskPkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  return `agenthook-agent:${diskPkg.version}`;
}

/** The agent image recipe. No USER (the run sets the host uid) and no CMD (the run names the
 * agent binary). A custom `sandbox.image` built FROM this must keep sh, git, gh and the agent
 * CLIs (claude, opencode, pi) on PATH. */
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
ARG OPENCODE_VERSION=latest
RUN npm i -g opencode-ai@\${OPENCODE_VERSION}
ARG PI_VERSION=1.5.2
RUN npm i -g @earendil-works/pi-coding-agent@\${PI_VERSION}
RUN mkdir -p /home/agent && chmod 1777 /home/agent
`;

/** The build argv (after the runtime binary); the Dockerfile goes on stdin.
 * @param {string} _runtime "docker" | "podman" (same syntax today) @param {string} image */
export function buildImageArgs(_runtime, image) {
  return ["build", "-t", image, "-"];
}

/**
 * The manual remedy for a missing service image. A bare name (`postgres:16.4`) can't be told
 * offline from a locally built one (`myproj-db:pg17`), so both remedies are named; podman's
 * `localhost/` prefix for locally built images is unambiguous.
 * - `localhost/<repo>` → build only: `this image is built locally: <runtime> build -t <img> <dir with its Dockerfile>`.
 * - Bare name (no `/`) → `<runtime> pull <img>, or if it is built locally: <runtime> build -t <img> <dir with its Dockerfile>`.
 * - Registry or namespace (`ghcr.io/x/y:1`, `pgvector/pgvector:pg17`) → `<runtime> pull <img>`.
 * @param {string} runtime "docker" | "podman" (the configured `sandbox.type`)
 * @param {string} img the service image ref
 * @returns {string}
 */
export function serviceImageRemedy(runtime, img) {
  const withoutDigest = img.split("@")[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const repo = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
  const build = `${runtime} build -t ${img} <dir with its Dockerfile>`;
  if (repo.split("/")[0] === "localhost") return `this image is built locally: ${build}`;
  if (!repo.includes("/")) return `${runtime} pull ${img}, or if it is built locally: ${build}`;
  return `${runtime} pull ${img}`;
}
