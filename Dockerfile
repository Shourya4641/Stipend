# One image, three services. They share every dependency and differ only
# in the entrypoint, so three Dockerfiles would be three copies of one
# build drifting apart. Railway overrides the start command per service.
FROM node:24-alpine AS base
# Pinned explicitly rather than via corepack: corepack reads a
# packageManager field and fails outright if it is absent or mismatched,
# which is a confusing build failure for a version we can simply state.
RUN npm install -g pnpm@12.14.0
WORKDIR /app

# Dependencies in their own layer, keyed on the lockfile, so editing src/
# rebuilds in seconds instead of re-resolving every package.
FROM base AS deps
# pnpm-workspace.yaml carries onlyBuiltDependencies — without it the
# install fails on ERR_PNPM_IGNORED_BUILDS.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS runtime
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml ./
COPY tsconfig*.json ./
# Migrations are applied by the facilitator at startup, so the SQL and the
# journal must be in the image — without them a fresh deploy serves
# against an empty schema.
COPY drizzle ./drizzle
COPY src ./src

# tsx runs TypeScript directly: no build step, so the thing deployed is
# the thing that was tested. For a ten-day project that removes a whole
# class of "works locally, broken in the image" failures.
# tsx directly, NOT through `pnpm exec`: pnpm re-verifies the lockfile and
# attempts an install on every invocation, which costs seconds at every
# container start and fails on ERR_PNPM_IGNORED_BUILDS before the command
# even runs. The binary is already in the image; invoke it.
CMD ["node_modules/.bin/tsx", "src/facilitator/server.ts"]
