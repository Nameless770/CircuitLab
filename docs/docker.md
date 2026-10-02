# CircuitLab in Docker (phase 11)

One command starts all of CircuitLab:

```bash
docker compose up --build
```

The API then answers on http://localhost:3000 (try http://localhost:3000/health), and the desktop
app's online mode uses it as it is. Ctrl+C stops everything. The data stays in two Docker
volumes, so the next `docker compose up` finds your accounts and circuits again.

| Command | What it does |
| --- | --- |
| `docker compose up --build` | Builds the image if the code changed, and starts everything (Ctrl+C stops it) |
| `docker compose up --build -d` | The same, in the background |
| `docker compose ps` | What's running, and whether it's healthy |
| `docker compose logs -f api` | The API's log, live (also `worker`, `migrate`, `postgres`, `redis`) |
| `docker compose down` | Stops and removes the containers; the data stays |
| `docker compose down --volumes` | Also deletes the data: a fresh start |
| `docker compose exec postgres psql -U circuitlab` | A SQL prompt on the database |

The files: [Dockerfile](../Dockerfile), [docker-compose.yml](../docker-compose.yml), [.dockerignore](../.dockerignore).

## What runs

```
your computer ──► http://localhost:3000 ──► api ────► postgres, redis
                                             │
                                             │ puts big truth tables in redis's queue
                                             ▼
                                          worker ──► postgres, redis

migrate (runs first, then exits) ──► postgres
```

| Service | Image | Job |
| --- | --- | --- |
| `postgres` | `postgres:18-alpine` | Accounts, circuits, simulation runs (phases 5 and 6) |
| `redis` | `redis:8-alpine` | The result cache, the sign-in throttle, and the job queue (phase 10) |
| `migrate` | ours | Applies the migrations (`prisma migrate deploy`), then exits |
| `api` | ours | The REST API (phases 4 to 10), on port 3000 |
| `worker` | ours | Computes background truth-table jobs from the queue (phase 10) |

They start in order, and each waits until what it needs is *healthy*, not just started:
1. **PostgreSQL and Redis** start first. Each has a health check (`pg_isready`, `redis-cli ping`),
   so the others know when it's ready.
2. **`migrate`** waits for a healthy PostgreSQL, applies the migrations, and exits. Running it
   again is harmless: it says "No pending migrations to apply".
3. **The API and the worker** start only after `migrate` *finished successfully*. The API refuses to
   start on a database that isn't migrated, so starting them earlier would just fail.
4. **The API has a health check** of its own, its `/health` endpoint, so `docker compose ps`
   shows when it's ready.

## The decisions, and why

### One image, three jobs

`migrate`, `api` and `worker` all run the same image, built by one Dockerfile. Only the command
differs: `npm run migrate`, `node apps/api/dist/main.js`, `node apps/api/dist/worker.js`. One
build, and the three can never disagree about which version of the code they run.

### The worker is its own container

The API runs with `JOB_CONCURRENCY=0`, so it never computes big truth tables itself: it puts them
in the Redis queue, and the worker takes them from there. That is the setup phase 10 was designed
for. A huge table keeps the worker busy, never the API's answers, and more workers could be added
without touching the API.

### Building the image (the Dockerfile)

- **Two stages.**
  - **`build`** installs every package and compiles the TypeScript.
  - **`runtime`** copies the result and keeps only what running needs (`npm prune --omit=dev`).
  - TypeScript's compiler stays anyway: Prisma lists it as a peer dependency, so npm counts it as
    needed. The rest go: Vitest, Electron, electron-builder, Playwright, PGlite.
- **Dependencies are installed before the code is copied.** Docker reuses a step from its cache
  until the files it copied change. Copying only the `package.json` files and the lockfile first
  means the slow `npm ci` reruns only when the dependencies change, not after every code change.
- **`.dockerignore`** keeps out:
  - `node_modules` and `dist`: built inside the image, because Windows builds wouldn't run on Linux;
  - `.env`: secrets never go into an image;
  - the desktop installer and `.git`: big, and not needed.
- **`node:24-slim`** (Debian), plus OpenSSL, which Prisma's migration engine needs and the slim
  image leaves out.
  - **Why not Alpine?** Alpine is smaller, but uses a different C library (musl), which native
    packages such as `argon2` need separate builds for. Debian is the safe default.
- **It runs as the `node` user, not root.** If someone ever broke into the API, they wouldn't
  have root rights in the container.

### Stopping gracefully

The image starts Node directly: `CMD ["node", "apps/api/dist/main.js"]`. There's no shell or npm
in front of it, so Node is the container's main process and receives `docker compose stop`'s
SIGTERM itself.

The API then shuts down as phase 4 built it: it stops taking requests, lets running ones finish,
and closes the simulation pool. Tried: stopping took under a second, and the log shows "Closing
the simulation pool (SIGTERM; 0 running, 0 waiting)". Behind `npm start`, the signal could be lost,
and Docker would kill the API after 10 seconds.

### The data

- **Two named volumes,** `postgres-data` and `redis-data`, keep the data when containers are
  removed. Only `docker compose down --volumes` deletes it.
- **PostgreSQL 18 moved its data folder** to `/var/lib/postgresql/18/docker`, so the volume is
  mounted on `/var/lib/postgresql`. Most tutorials still mount `.../data`, which on 18 would leave
  the real data outside the volume.
- **Redis runs with `--appendonly yes`.** It writes every change to disk, so queued jobs and
  finished results survive a restart. Its default memory policy, `noeviction`, is the one BullMQ
  needs: the queue must never lose a key.

### Settings and secrets

The API already reads everything from environment variables (`DATABASE_URL`, `REDIS_URL`, ...),
so the compose file just sets them. The secrets come from a `.env` file next to it, which is never
committed (see `.env.example`):
- **`JWT_SECRET`** signs the access tokens. Without it, the API makes a random key at every start:
  it works, but each restart signs everyone out.
- **`POSTGRES_PASSWORD`** defaults to `circuitlab`. That's acceptable only because PostgreSQL and
  Redis have no published ports: nothing outside these containers can reach them. Only the API
  is published on your computer.
- **`API_PORT`** changes the API's port on your computer, if 3000 is taken (say, by
  `npm run start:api`).

### The Prisma CLI is now a runtime dependency

Applying migrations is part of running the app, not only of building it. So `prisma` (the CLI)
moved from `devDependencies` to `dependencies` in `packages/database`. The `migrate` service can
then use the same image as the API.

## How it was checked

On Docker Desktop 4.88 (engine 29.7), over HTTP, as any client would:
- **Startup:** `docker compose up` started everything in order. All 6 migrations were applied,
  and the API became healthy, using PostgreSQL and Redis (`/health`).
- **Accounts:** registering an account worked, so `argon2`'s Linux build works.
- **The cache:** the same simulation twice was answered "miss; stored", then "hit".
- **Jobs:** a background truth-table job succeeded, computed by the worker (the API has
  `JOB_CONCURRENCY=0`), and its CSV result downloaded.
- **Stopping:** graceful, in under a second.
- **The data:** after `docker compose down` and `up` again, the migrations had nothing left to do,
  the account could sign in again, and its circuit was still there.

## Known shortcuts

| Shortcut | Why it's acceptable for now | The proper fix |
| --- | --- | --- |
| The image is about 870 MB, about 150 MB of it Prisma's CLI and Studio, kept for migrations | One image is simpler, and disk space on a laptop is cheap | A separate small image for `migrate` |
| Every client looks like Docker's own network address to the API, so the sign-in throttle counts all clients as one | On your own computer you *are* the only client | When deploying (phase 13): a reverse proxy in front that passes on the client's address, and Express's `trust proxy` setting for it |
| Without `JWT_SECRET` in `.env`, restarting the API signs everyone out | One command still starts everything, with no setup | Set it in `.env` (generate one as `.env.example` shows) |
| Code changes need `docker compose up --build` | Rebuilding takes seconds once the dependencies are cached | Fine as it is; day-to-day development uses `npm run start:api` |
| npm warns that the install scripts of `argon2`, `prisma` and two others aren't approved yet | They still run: Prisma's engine is in the image. The warning is about a future npm default | Approve them (`npm install-scripts approve`) when that npm version arrives |
| The base images float (`node:24-slim`, `postgres:18-alpine`), so a rebuild can pick up a newer patch release | Patches are what you want for security | Pin image digests if builds must be exactly repeatable |
