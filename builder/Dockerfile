# oojam builder (SPEC §4.1): Claude Agent SDK + the site's toolchain + Chromium for smoke tests.
# Built on the server by deploy/bin/update-platform: docker build -t oojam-builder:latest builder/
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep jq ca-certificates procps less tree \
 && rm -rf /var/lib/apt/lists/*

# Chromium for smoke tests (and for the agent to screenshot its own work if it wants).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /app/node_modules /opt/oojam-builder/node_modules
RUN cd /opt/oojam-builder && npx playwright install --with-deps chromium \
 && chmod -R a+rX /ms-playwright && rm -rf /var/lib/apt/lists/* /root/.npm

# uid 1000, matching the workspace the worker chowns.
RUN userdel -r node \
 && useradd --create-home --uid 1000 --shell /bin/bash builder \
 && mkdir -p /workspace /job /home/builder/.claude \
 && chown builder:builder /workspace /job /home/builder/.claude

WORKDIR /opt/oojam-builder
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
COPY BUILDER.md ./BUILDER.md

ENV HOME=/home/builder \
    WORKSPACE_DIR=/workspace \
    JOB_DIR=/job \
    npm_config_ignore_scripts=true \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1 \
    NO_PROXY=gateway,localhost,127.0.0.1 \
    no_proxy=gateway,localhost,127.0.0.1

USER builder
WORKDIR /workspace
CMD ["node", "/opt/oojam-builder/dist/run.js"]
