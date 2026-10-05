# Putting CircuitLab online (phase 13)

This turns phase 11's Docker setup into a site other people can reach: one machine, HTTPS, and
the settings that [phase 12](system-design.md) recommended for being on the internet. It is two
files, laid over the ones you already use: [docker-compose.prod.yml](../docker-compose.prod.yml)
and [deploy/Caddyfile](../deploy/Caddyfile).

```
                                        ┌─► API copies (2) ──────┐
the internet ──► Caddy (HTTPS, 80/443) ─┤                        ├──► PostgreSQL
                                        └─► sign-in copies (1) ──┤    Redis: the queue, the throttle, job results
                                            only /v1/auth/*      │    Redis: the result cache
                                                  worker ────────┘
```

Only Caddy can be reached from outside. The API copies, the worker, PostgreSQL and both Redis servers
live on Docker's private network. Open the site's address and you land on the API's documentation
(Swagger UI), where anyone can register and try the API. The desktop app can use it too: Settings,
then the server address.

The API runs as several copies of one container, and Caddy shares the requests out between them
([phase 12's stage 2](system-design.md#stage-2-several-api-copies-behind-a-load-balancer)). Two
API copies and one for sign-ins and registrations is the default; [below](#how-many-copies) says how
to change it.

## What you need

- **A Linux machine with Docker** and Docker Compose 2.24 or later (the file uses `!reset`). A small
  cloud server will do. **Measured** with the default setup (two API copies and one for sign-ins), the
  containers use about 0.6 GB at rest: an API copy about 125 MiB, a sign-in copy 130 to 160 MiB, the
  worker 80 to 115 MiB, PostgreSQL 50 to 75 MiB. Under load they grow (simulations run in threads), and
  the first build, which runs `npm ci` and the TypeScript compiler, is hungrier still (not measured). So
  take 2 GB or more, and more CPUs help: each copy is one more core's worth of API.
- **A domain name** pointing at the machine (an `A` record, and `AAAA` for IPv6). Caddy asks Let's
  Encrypt for a certificate, and Let's Encrypt must be able to reach the name. Without one you can
  run plain HTTP on the machine's address, to have a look: passwords and tokens then travel
  unencrypted.
- **Ports 80 and 443 open,** in the provider's firewall too. Port 80 is where Let's Encrypt checks
  that the name is yours.

I can't create accounts or rent machines for you, so this is the part that is yours. Any provider
with a plain Linux server works.

## From an empty machine to a running site

**1. Install Docker,** following [docs.docker.com/engine/install](https://docs.docker.com/engine/install/).

**2. Get the code,** and go into its folder:

```bash
git clone <the address of your repository> circuitlab
cd circuitlab
```

**3. Make the settings.** `.env` holds the keys, so it never goes into git (it is in `.gitignore`)
and nobody else should read it:

```bash
cat > .env <<EOF
SITE_ADDRESS=demo.example.com
JWT_SECRET=$(openssl rand -base64 36 | tr -d '\n')
POSTGRES_PASSWORD=$(openssl rand -hex 24)
EOF
```

Replace `demo.example.com` with your domain name. The password is made of hexadecimal digits only,
on purpose: it goes into a connection URL, where characters like `@` and `/` would break it.

**4. Start it.** The first time this builds the image and downloads the others, which takes a few
minutes:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

**5. Look at it:**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
curl https://demo.example.com/health
```

Every service should be `healthy` (the worker and Caddy have no health check and show `Up`), and
`/health` should say `"status":"ok"`. Then open `https://demo.example.com` in a browser.

**Tip.** Putting `COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml` in `.env` makes plain
`docker compose ps`, `docker compose logs` and so on use both files, which shortens everything
below. (`:` is the separator on Linux and macOS.)

## What the setup does, and why

Each point answers something the measurements of [system-design.md](system-design.md) found.

- **HTTPS, and the client's real address.** Caddy gets and renews the certificate. It also puts
  the client's address in `X-Forwarded-For`, *replacing* any that the client sent, and the API,
  with `TRUST_PROXY=1`, believes exactly that one hop. Without it, every client would look like
  Caddy to the sign-in throttle, and 5 wrong guesses from anywhere would lock the real owner out of
  an account. **Tested** (below): a client that forges the header gains nothing.
  - `TRUST_PROXY` is the number of proxies in front of the API. If you put another one in front
    of Caddy (Cloudflare, a load balancer), it is 2, and Caddy has to be told to trust that proxy
    (`trusted_proxies` in its configuration). Too high a number lets clients forge their address.
- **Only Caddy is reachable.** The API's own port isn't published (`ports: !reset []`), so nothing
  can skip the proxy.
- **Several copies of the API, and Caddy to share the requests out** (phase 12, stage 2). The API's own
  CPU is the first limit, and it keeps nothing between requests, so copies add up: phase 12 **measured**
  1.8 to 2.1 times the throughput from two. A copy that dies costs only the requests running on it.
  - **Finding them.** Docker's DNS gives the service's name one address per copy, and Caddy asks
    again every 2 seconds, so a copy that starts, stops or restarts is noticed by itself. The next
    request goes to the copy with the fewest running.
  - **Dead and full copies.** A copy that can't be reached 3 times in 10 seconds is left alone for those
    10 seconds, and Caddy tries another copy meanwhile. A copy with 64 requests running gets no more;
    when all are full Caddy keeps looking for 2 seconds, then answers **503 with `Retry-After: 5`**, in the
    same problem-document form as the API's own 503s. So a flood is turned away quickly instead of
    waiting for ever (**tested**, below).
  - **A pool for sign-ins.** `/v1/auth/*` goes to copies of its own (`api-auth`, the same image), so that a
    burst of logins, each a password hash, can't slow everyone else.
  - **The copies must agree on three things:** the `JWT_SECRET` (a token signed by one is checked by
    another), the database and Redis. All three come from the same lines of the Compose file, and
    **tested** (below): a token, the cache, the sign-in lock and the address limit are shared.
  - **Caddy doesn't probe the copies,** it learns from the requests it sends: Caddy's own documentation
    says that active health checks don't run for the kind of upstream that finds copies by DNS. The API
    has `GET /health/live` for a balancer that does probe; see
    [phase 12](system-design.md#stage-2-several-api-copies-behind-a-load-balancer).
- **Real secrets, or no start.** `JWT_SECRET`, `POSTGRES_PASSWORD` and `SITE_ADDRESS` are
  *required*: Compose stops with a message naming the missing one. Without a `JWT_SECRET` the API
  makes a random key at every start, so a restart signs everyone out, and a second API copy would
  reject the first one's tokens (**measured** in phase 12).
- **Two Redis servers, both with a memory limit (256 MB).** The cache's one forgets its oldest entries
  when it fills up (`allkeys-lru`), which is right for a cache. The other holds the job queue, the
  throttle and job results, and never forgets (`noeviction`), which a queue needs. Phase 12
  **measured** one cached result at 2 KB for a small circuit and 98 KB for a 5,000-gate one, and
  without limits nothing stopped them piling up.
- **A limit on password hashing: `AUTH_RATE_LIMIT`, 30 sign-ins and registrations a minute per
  address.** Each costs a full Argon2 hash, about 28 ms of CPU, and phase 12 **measured** that a
  stream of them takes both CPUs of a container and leaves nothing for anyone else. The throttle
  couldn't stop it: it counts failures per account, so a client making up email addresses never
  trips it, and registration had no throttle at all.
  - **Behind a shared address,** such as a school's, many people look like one. A class of 1,000
    signing in within a minute needs `AUTH_RATE_LIMIT=1200` or more. That is 28 CPU-seconds of
    hashing (**calculated**): about 14 seconds of both CPUs of a small server, which will slow
    everything else for that long. A limit that high protects little, so for a big class raise
    `API_AUTH_COPIES`: `/v1/auth/*` has copies of its own, so the hashing can't slow the rest.
  - **It counts addresses, not networks.** On IPv6 a client can switch addresses within its own
    block. Counting by block is the fix, and isn't done.
  - **It fails closed:** with Redis down, signing in and registering answer 503, like the throttle.
- **A wait limit on the database: `DATABASE_POOL_TIMEOUT_MS`, 5 seconds.** A request that finds every
  database connection busy waits at most that long, then gets a 503 with `Retry-After`. Without a limit
  it waited for ever, and a busy database turned into a pile of waiting requests (phase 12 **measured**
  that). Neither Compose file sets it, so the default applies; 0 would bring the waiting back.
- **The history is kept for 30 days: `RUN_RETENTION_DAYS`.** Every simulation and truth-table job is a
  row of about 360 bytes, so one simulation a second adds about 31 MB a day (**calculated**). Housekeeping
  deletes what finished more than that many days ago, every 10 minutes, in batches. 0 keeps everything,
  which is for a database with room to spare.

## Day to day

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f api caddy   # what is happening
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps                  # what runs, and whether it is healthy
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop                # stop everything; the data stays
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d               # start it again
```

`logs caddy` is the access log: a line of JSON for every request, with its status, how long it took, and
the address of the copy that answered (`upstream`). It also holds each client's address and the path they
asked for, so keep it only as long as you need it. Docker keeps the last 30 MB of it, no more.

### How many copies

Set `API_COPIES` (the API, 2 by default) and `API_AUTH_COPIES` (sign-ins and registrations, 1) in `.env`,
then run the same `up -d`. Compose adds or removes copies and leaves the others alone, and Caddy notices
within 2 seconds. **Measured:** going from 2 API copies to 3 took 5 seconds, and the next 60 requests were
shared 16, 22 and 22.

- **Each copy is about 125 MiB at rest and a core or more of CPU when busy** (phase 12 saw 100% to 140% of
  a core for ordinary requests, and simulations also run in threads), so more copies than the machine has
  cores doesn't help. Phase 12 measured about 330 requests a second per copy of a typical mix at a
  comfortable load.
- **Each copy opens up to 10 database connections** (`DATABASE_POOL_SIZE`), and PostgreSQL allows about 97:
  7 API copies and 2 workers use 90. Beyond that the database needs a connection pooler, which is stage 3
  of the plan and isn't done.
- **1 and 1 is the smallest setup,** for a small machine. It works the same, but a copy that dies is a
  site that is down until Docker restarts it.

**Updating.** Pull the new code and rebuild. The migrations run by themselves first (running them
again is harmless), and the copies are recreated:

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

**Measured:** with a request every 25 ms, recreating the API copies lost none. The ones that arrived while no
copy was ready waited about 1.5 seconds, because Caddy keeps looking for a copy for 2 seconds before giving
up. A migration that an *old* copy can't work with (a column it doesn't know) would still break the copies
that haven't been replaced yet; that isn't tested, so keep migrations compatible with the release before.

**Backing up.** PostgreSQL holds everything that must last (accounts, circuits, history). The Redis
data can all be rebuilt or is allowed to be lost: the cache is a cache, and job results expire after
a day. Make a backup with:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres pg_dump --clean --if-exists -U circuitlab circuitlab | gzip > circuitlab-$(date +%F).sql.gz
```

Run it from a scheduled job (`cron`), and copy the files off the machine: a backup that lives on
the disk it protects protects nothing. **To restore,** on a machine with the stack running (stop
the API and the worker first, so that nothing is writing):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop api worker
gunzip -c circuitlab-2026-10-03.sql.gz | docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres psql -U circuitlab -q circuitlab
docker compose -f docker-compose.yml -f docker-compose.prod.yml start api worker
```

`--clean --if-exists` makes the dump replace the tables that are already there, so this works over a
freshly migrated database too. **Tested** below.

**Starting over.** `docker compose -f docker-compose.yml -f docker-compose.prod.yml down --volumes`
deletes the containers *and the data*, including the certificates. Take a backup first.

## Checking it from outside

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://demo.example.com/docs   # 200
curl https://demo.example.com/health                                      # {"status":"ok", ...}
```

To see the address limit work (the made-up email addresses keep the per-account throttle out of
the way, so this is the limit and nothing else):

```bash
for i in $(seq 35); do
  curl -s -o /dev/null -w "%{http_code} " -X POST https://demo.example.com/v1/auth/login \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"nobody$i@example.com\",\"password\":\"a long wrong passphrase\"}"
done; echo
```

You should see about 30 `401`s and then `429`s, for a minute.

To check that the copies share the work and behave as one, on any machine with Docker, there is a script
that starts this same setup under a project name of its own (nothing of yours is touched), asks it
questions through Caddy, and removes it again. It takes a few minutes the first time, which builds the image:

```bash
node scripts/check-copies.mjs
```

With `--keep` it leaves the stack running afterwards, for you to look at, and prints the command that removes it
(`--remove=<its project name>`, which refuses any name the script didn't make itself).

## What was tested, and what wasn't

**Stage 2 (the copies),** by `scripts/check-copies.mjs`, with the real files, two API copies and two sign-in
copies, on a laptop. It passed all 11 checks (CI runs it on every push too):
- **Routing:** sign-ins and registrations are answered by the sign-in copies and nothing else is; 60
  requests with a token from the sign-in pool were all answered, 30 by each API copy.
- **The copies behave as one:** the cache (1 miss and 19 hits over both copies), the sign-in lock (5 wrong
  guesses split 3 and 2 over the two sign-in copies lock the account), and the address limit (a 429 after
  the 30 a minute, over both sign-in copies, while ordinary requests still work).
- **A copy that dies:** killing an API copy during a steady stream of requests failed none of them (the
  slowest took 12 ms; in a second try with a request every 20 ms, one request took 256 ms). The copy
  came back, and took its share.
- **No copy at all, and a flood:** with every API copy stopped, Caddy answers 503 as a problem document with
  `Retry-After: 5` (after 4 to 9 seconds in three tries: Docker's DNS is slow to say a name is gone), and signing in
  still works. With 500 users reading a 5,000-gate circuit for 8 seconds, about 700 requests were served and
  about 1,350 turned away after 2 seconds (the slowest 2.4), none failed any other way, and a request 3
  seconds later took 39 ms.
- **By hand, the same day:** going from 2 to 3 API copies and back; recreating the API copies during a
  steady stream of requests (none failed, the slowest waited 1.5 seconds); the memory of each container.

**Before stage 2,** on the development machine, with the real files and a freshly built image (Caddy on
ports 18080 and 18443, because the usual ones were taken):

- **Through Caddy, over plain HTTP:** the health check; the root redirecting to the docs; the docs
  page and the contract; registering; creating a circuit; a simulation that is stored and then a
  cache hit; a truth table as CSV; a background job computed by the worker.
- **The address limit and forged headers:** 35 sign-in attempts, each from a different account and
  each with a different made-up `X-Forwarded-For`. The limit still tripped after 30, and the answer
  was a problem document with `Retry-After`. Caddy had replaced the forged headers with the real
  address, as the setup relies on.
- **Compression:** the Swagger UI script, 1.59 MB, went over the wire as 0.45 MB with gzip (Caddy
  prefers zstd when the browser asks for it).
- **Redis:** the memory limits and policies of both servers; the cache's entries in the cache's Redis
  only, and the queue, throttle and results in the other.
- **Required settings:** Compose refuses to start without each of the three, naming it.
- **Backup and restore:** a dump restored into an empty database and over a migrated one, with
  every row count equal.
- **HTTPS:** with `SITE_ADDRESS=localhost`, Caddy serves HTTPS with a certificate from its own test
  authority, and sends plain HTTP to it.

**Not tested:**
- **A real Let's Encrypt certificate:** it needs a public machine and a domain name. The file is
  Caddy's ordinary setup for one, but it hasn't run for one here.
- **A real server and a real network:** the DNS records, the provider's firewall, and what the
  machine does under real traffic.
- **IPv6, and a proxy in front of Caddy.**
- **Copies on several machines,** and a balancer outside this one. The copies would be the same image
  with the same `JWT_SECRET`, `DATABASE_URL` and `REDIS_URL`, but that hasn't been tried.
- **A real crash of a copy.** The check kills one with `docker kill`, which Docker counts as stopping it by
  hand, so its restart policy doesn't apply (the check starts it again). A crash would be restarted.
- **How a real provider's DNS behaves** when a whole pool of copies is gone: the 4 seconds above came from
  a laptop's resolver.

**Known shortcuts of the demo:**
- **Registration is open to anyone** who finds the address. Phase 12's limit keeps a single address
  from making the server hash all day; it doesn't decide who may have an account.
- **One machine:** if it goes down, so does the site (phase 12, section 6). Several copies protect against
  one of the processes dying, not against that.
- **The number of copies is set by hand,** in `.env`; nothing adds one when the load goes up.
- **No limit per address on anything but sign-ins and registrations:** Caddy has no rate limiting of its own.
- **No monitoring or alerts:** `docker compose logs` and `/health` are all there is (phase 12,
  section 7).
- **Backups are a command to schedule,** not something that runs by itself.
- **No HSTS header** (which tells browsers to use only HTTPS for the name). Caddy redirects HTTP to
  HTTPS, but a browser's first visit can still be plain HTTP. It is left out because browsers
  remember it for a year, which is a lot to commit a demo name to.
- **The images float:** `caddy:2-alpine` and `redis:8-alpine` pick up new patch releases when pulled,
  which is what you want for security, but makes a rebuild not exactly repeatable.

## Without a server of your own

Nothing here is specific to one provider. Any platform that runs a Dockerfile can run the API and the
worker from the same image (`node apps/api/dist/main.js` and `node apps/api/dist/worker.js`) with the
environment variables of [the README](../README.md#running-the-api): a managed PostgreSQL for
`DATABASE_URL`, a managed Redis for `REDIS_URL`, a `JWT_SECRET`, `TRUST_PROXY=1` behind the platform's
own proxy, and a migration run (`npm run migrate -w @circuitlab/database`) before each release. That
route is **not tested**.
