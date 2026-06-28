# Sandbox image for running agenthook with fullAuto confined to a container.
# Everything the receiver and its `claude -p` agents touch lives inside here; the
# host exposes only the repo (mounted at /work/repo) and a few env-supplied tokens.
# See docs/sandbox.md.
FROM node:20-bookworm-slim

# git is required (worktrees, branches, PRs); ca-certificates + curl for API calls
# and the optional ngrok install. Keep the layer small.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# The coding agent. Pin via build-arg if you need a specific version.
ARG CLAUDE_VERSION=latest
RUN npm i -g @anthropic-ai/claude-code@${CLAUDE_VERSION}

# agenthook itself. Defaults to the published package (@jesuso/agenthook); override
# AGENTHOOK_SPEC with a local tarball name (built via `npm pack`) for dev images:
#   docker build --build-arg AGENTHOOK_SPEC=jesuso-agenthook-0.1.0.tgz -f docker/Dockerfile .
ARG AGENTHOOK_SPEC=published
COPY . /tmp/agenthook-src
RUN if [ "$AGENTHOOK_SPEC" = "published" ]; then \
      npm i -g @jesuso/agenthook; \
    else \
      npm i -g "/tmp/agenthook-src/${AGENTHOOK_SPEC}"; \
    fi \
  && rm -rf /tmp/agenthook-src

# Optional: the ngrok ingress. Skip it (ENABLE_NGROK=0) and use the `hosted` ingress
# behind your own reverse proxy for a smaller image with no extra outbound binary.
ARG ENABLE_NGROK=1
RUN if [ "$ENABLE_NGROK" = "1" ]; then \
      curl -sSfL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz \
        | tar -xz -C /usr/local/bin ngrok; \
    fi

# Run unprivileged. node:* ships a `node` user (uid 1000); give it the work + home dirs.
RUN mkdir -p /work/repo /work/worktrees /home/node/.agenthook /home/node/.claude \
  && chown -R node:node /work /home/node/.agenthook /home/node/.claude
USER node
WORKDIR /work/repo

# The receiver discovers ./agenthook.config.json by walking up from cwd. The mounted
# config must set repoPath:"/work/repo" and worktreePrefix:"/work/worktrees" so the
# agent's worktrees stay inside the container (see docs/sandbox.md).
CMD ["agenthook", "start"]
