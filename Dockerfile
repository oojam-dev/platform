# oojam platform image: build.oojam.dev (web), the worker and the gateway (SPEC §3.1).
# compose picks the command; web and gateway run as the unprivileged `node` user, the worker
# as root because it drives the host's Docker.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim
# git + tar for workspaces; the docker CLI (static, no daemon) for the worker.
ARG DOCKER_CLI_VERSION=29.4.3
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl tar \
 && arch="$(uname -m)" \
 && curl -fsSL "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_CLI_VERSION}.tgz" \
    | tar -xz -C /usr/local/bin --strip-components=1 docker/docker \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
COPY deploy/postgres/initdb/02-guards.sql ./deploy/postgres/initdb/02-guards.sql
EXPOSE 3000
CMD ["npm", "start"]
