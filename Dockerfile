# The CircuitLab API image. docker-compose.yml runs it three ways: the API, the worker that
# computes big truth tables, and a one-off job that applies the database migrations.
#
# Two stages: "build" installs every tool and compiles; "runtime" keeps only what running needs,
# so the final image doesn't carry TypeScript, Vitest, Electron and the rest.

# Debian slim with Node.js 24 (the API needs Node 22.18 or later, for Prisma 7).
FROM node:24-slim AS base
# Prisma's migration engine needs OpenSSL, which the slim image leaves out.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
# npm would otherwise check online for a newer npm every time it runs a script.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app

# ---------------------------------------------------------------------------------------------
FROM base AS build
# The desktop app is a workspace too, but its Electron program isn't needed in here.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

# Dependencies first, on their own: this slow step is then reused from Docker's cache until a
# package.json or the lockfile changes, instead of rerunning after every code change.
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/netlist/package.json packages/netlist/
COPY packages/runner/package.json packages/runner/
COPY packages/api-contract/package.json packages/api-contract/
COPY packages/database/package.json packages/database/
COPY apps/api/package.json apps/api/
COPY apps/desktop/package.json apps/desktop/
COPY examples/package.json examples/
RUN npm ci

# Then the code, and the build: the Prisma Client first, then TypeScript for the API and the
# packages it uses (tsc -b follows the project references).
COPY . .
RUN npm run generate --workspace @circuitlab/database \
 && npx tsc -b apps/api

# Keep only the packages needed to run: development tools go.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
# Not root: if the app were ever broken into, the attacker wouldn't be root in the container.
USER node
EXPOSE 3000
# The exec form (a list, no shell, no npm in between) makes Node the first process, so it gets
# `docker compose stop`'s SIGTERM itself and shuts down gracefully: it stops taking requests and
# lets the running ones finish (see app.ts).
CMD ["node", "apps/api/dist/main.js"]
