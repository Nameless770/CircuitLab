# Putting CircuitLab online (phase 13)

This turns phase 11's Docker setup into a site other people can reach: one machine, HTTPS, and
the settings that [phase 12](system-design.md) recommended for being on the internet. It is two
files, laid over the ones you already use: [docker-compose.prod.yml](../docker-compose.prod.yml)
and [deploy/Caddyfile](../deploy/Caddyfile).

```
the internet ──► Caddy (HTTPS, ports 80 and 443) ──► API ──► PostgreSQL
                                                      │  ──► Redis: the queue, the throttle, job results
                                                      │  ──► Redis: the result cache
                                                   worker ──► the same
```

Only Caddy can be reached from outside. The API, the worker, PostgreSQL and both Redis servers live
on Docker's private network. Open the site's address and you land on the API's documentation
(Swagger UI), where anyone can register and try the API. The desktop app can use it too: Settings,
then the server address.

## What you need

- **A Linux machine with Docker** and Docker Compose 2.24 or later (the file uses `!reset`). A small
  cloud server will do. **Calculated** from phase 12's measurements, the containers use about 0.6
  to 1 GB; the first build, which runs `npm ci` and the TypeScript compiler, is hungrier still (not
  measured). So take 2 GB or more.
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
    everything else for that long. A limit that high protects little, so for a big class give
    `/v1/auth/*` copies of its own (phase 12, stage 2).
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

**Updating.** Pull the new code and rebuild. The migrations run by themselves first (running them
again is harmless), and the API restarts, which takes a few seconds:

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

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
curl -s -o /dev/null -w "%{http_code}
" https://demo.example.com/docs   # 200
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

## What was tested, and what wasn't

On the development machine, with the real files and a freshly built image (Caddy on ports 18080
and 18443, because the usual ones were taken):

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

**Known shortcuts of the demo:**
- **Registration is open to anyone** who finds the address. Phase 12's limit keeps a single address
  from making the server hash all day; it doesn't decide who may have an account.
- **One machine:** if it goes down, so does the site (phase 12, section 6).
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
