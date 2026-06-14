# agenthook receiver. The agent itself needs the `claude` CLI + your repo's
# toolchain (git, language runtime, gh, test deps); extend this image to match
# the repo agents will work in, or mount that toolchain in.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
# No runtime deps today (pure Node stdlib); keep the step for when that changes.
RUN npm install --omit=dev || true
COPY src ./src

# config.json, INSTRUCTIONS.md, tokens, and the target repo are mounted at runtime
# (see docker/compose.yml) so no secrets bake into the image.
EXPOSE 4123
CMD ["node", "src/server.js"]
