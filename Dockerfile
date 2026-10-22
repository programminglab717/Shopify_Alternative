# syntax=docker/dockerfile:1
#
# Hatti's container images (ADR-724), built from the repository's root:
#
#   docker build --target core -t hatti-core .
#   docker build --target storefront -t hatti-storefront .
#
# The core image runs the Admin API by default; the worker, migrations and the core's command-line
# tools are other commands of the same image:
#
#   docker run hatti-core                                          # the API, on PORT (4000)
#   docker run hatti-core node --import ./dist/instrumentation.js dist/worker.js
#   docker run hatti-core node /app/packages/platform/db/dist/cli/migrate.js
#
# Each holds its app's built code and production dependencies alone, runs as the unprivileged
# node user, and is configured by the environment, as .env.example describes. The admin is static
# files served from the edge, not an image.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS base
# The packageManager of package.json, which pnpm checks it is.
ARG PNPM_VERSION=10.33.0
ENV CI=true
RUN npm install --global pnpm@${PNPM_VERSION} \
    && pnpm config set --global store-dir /pnpm/store
WORKDIR /app

# The workspace, installed and built, each package after those it depends on. The lockfile alone
# decides what is fetched, so a change to the code fetches nothing again. The store is kept in the
# fetch's layer, not a cache mount: a layer cache restored elsewhere, as CI's is, brings the
# layer's files but none of a mount's, and every install after it is offline.
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile \
    && pnpm --filter "@hatti/core..." --filter "@hatti/storefront..." run build \
    && scripts/image-tree.sh @hatti/core /out/core \
    && scripts/image-tree.sh @hatti/storefront /out/storefront

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
USER node

FROM runtime AS core
COPY --from=build /out/core /app
WORKDIR /app/apps/core
EXPOSE 4000
CMD ["node", "--enable-source-maps", "--import", "./dist/instrumentation.js", "dist/main.js"]

FROM runtime AS storefront
COPY --from=build /out/storefront /app
WORKDIR /app/apps/storefront
EXPOSE 4100
CMD ["node", "--enable-source-maps", "--import", "./dist/cli/instrumentation.js", "dist/cli/serve.js"]
