# Scaling CircuitLab to thousands of users (phase 12)

How would CircuitLab serve thousands of users? This document answers with numbers. Phase 12 changed
no application code: it measured the system built in phases 1 to 11, found where it breaks first,
and puts the fixes in order, each with the measurement behind it. The scripts that took the
measurements are in [`scripts/load`](../scripts/load) (see [Running it yourself](#running-it-yourself)).

Every claim carries a tag, so you can tell what was observed from what was concluded:
- **Measured:** observed in the runs described in [What was measured](#3-what-was-measured).
- **Calculated:** arithmetic on measured numbers and the assumptions of [section 1](#1-the-target).
- **Reasoned:** follows from reading the code or a library's source; not run.
- **Not tested:** a recommendation that hasn't been tried.

## The short answer

1. **The architecture already scales out.** The API keeps no state of its own: tokens are signed,
   and everything shared lives in PostgreSQL and Redis, so any copy can serve any request.
   **Measured:** two API copies gave 1.8 to 2.1 times the throughput of one, and six cross-copy
   checks passed. One condition: every copy needs the same `JWT_SECRET`, or sign-in breaks at
   random.
2. **For the target, 2 or 3 small API containers are enough.** The target is 1,000 people working
   at once. **Measured:** one container with 2 CPUs served about 330 requests a second of a
   typical mix at a comfortable load. The first limit is the API's own CPU, not the database:
   PostgreSQL used less than one of its 16 cores in every single-copy run.
3. **What breaks first isn't speed.** In the order it would bite:
   - **Requests that cost far more than the rest.** One login costs about 28 ms of CPU, and a
     circuit of 5,000 gates cuts a container's throughput by 20 to 35 times. They take the CPU from
     everyone on the same container: a login storm cut ordinary throughput by 95%.
   - **Redis has no memory limit.** One cached result is 2 KB for a 128-gate circuit and 98 KB for
     a 5,000-gate one, and nothing stops them piling up.
   - **Overload has no brake.** Only simulations are turned away (503); everything else queues
     for as long as it takes.
   - **PostgreSQL's connection limit** is reached at about 7 API copies.
   - **The run history** grows by a row per simulation: about 30 GB a month at the target's pace.
4. **The fixes, cheapest first:** [stage 1](#stage-1-fix-the-sharp-edges) (small changes, no new
   machines), [stage 2](#stage-2-several-api-copies-behind-a-load-balancer) (a load balancer and
   several copies), [stage 3](#stage-3-protect-the-database) (a connection pooler, partitioned
   history, a read replica), [stage 4](#stage-4-workers-and-results) (workers as a fleet, results
   in object storage).
5. **Nothing needs a rewrite,** and [section 8](#8-what-was-not-designed-and-why) lists what
   isn't worth building yet.

## 1. The target

"Thousands of users" is vague, so this document fixes numbers. They are assumptions, and every
figure below can be recomputed with different ones.

| Assumption | Value | Why |
| --- | --- | --- |
| Registered accounts | 10,000 | "Thousands" |
| Working at the same moment | 1,000 | One course doing the same lab |
| Requests per working person | 1 every 5 seconds | Editing, running, opening circuits |
| Busiest moment | 3 times the average | The start of the lab |
| So the API sees | 200 requests a second, 600 at the burst | 1,000 ÷ 5 s, times 3 |
| Sign-ins at the start | 1,000 within a minute, about 17 a second | Everyone opens the app |
| The mix | 25% cached simulations, 25% uncached, 20% open a circuit, 15% list, 15% save | A guess: no real traffic exists yet |
| The stretch | 10 times all of it | 10,000 at once: 2,000 requests a second, 6,000 at the burst |

## 2. What runs today

[docker.md](docker.md) has the full picture. For scaling, what matters is which part holds state:

| Part | What it holds | Several copies? |
| --- | --- | --- |
| API | Nothing between requests. Access tokens are self-contained: checking one needs only `JWT_SECRET`, not a lookup | Yes (**Measured**, below) |
| Worker | Nothing between jobs; a crashed worker's job goes back to the queue | Yes |
| PostgreSQL | Everything that must last: accounts, circuits, sessions, history, job status | One primary |
| Redis | The result cache (rebuildable), sign-in failure counts, the job queue, job results (24 hours) | One instance |

The two stores are where growth lands. Every limit in this document is either the API's CPU or one
of these two.

## 3. What was measured

### The setup

- **Machine:** a laptop (Intel i7-11800H, 8 cores and 16 threads, 15.7 GB), Windows 11, Docker
  Desktop 4.88 (engine 29.7, Compose 5.4). Docker's virtual machine had 16 CPUs and 3.8 GiB.
- **The system:** phase 11's `docker-compose.yml`, run as a separate Compose project with its own
  database, so no real data was touched. The API and the worker each got **2 CPUs**, like a small
  production container; PostgreSQL 18 and Redis 8 got no limit and their default settings
  (PostgreSQL: `max_connections` 100, `shared_buffers` 128 MB; Redis: no `maxmemory`).
  With 2 CPUs the simulation pool has 1 thread (one less than the CPUs), and each API process keeps
  up to 10 database connections.
- **The load:** a script of about 150 lines of Node, running in a container on the same Docker
  network, so Docker Desktop's port forwarding isn't in the way. It is a **closed loop**: each
  virtual user sends its next request the moment it receives the last answer, for 2 seconds of
  warm-up and 10 seconds measured (1 and 5 seconds for the one-user runs). So the numbers are
  capacity, not a count of people: real users pause between requests.
- **What was sampled:** every request's time (the median, p50, and the **p99**: the time that 99
  of 100 requests beat), and, in the middle of each run, `docker stats` (CPU per container; 100%
  is one core) and PostgreSQL's open connections.
- **The circuits:** a full adder (10 gates), a 64-input parity circuit (128 gates), and a chain of
  5,000 gates with 24 inputs (about half of the 10,000 the API allows).
- **Repeated:** the main scenarios ran twice, and the two runs agreed within 17% (most within 8%).

### One API container

32 virtual users, one container with 2 CPUs. "Run 1 / run 2" are the two runs, in requests a second.

| Request | What it does | 1 user | 32 users: run 1 / run 2 | p99 at 32 | API CPU | PostgreSQL CPU |
| --- | --- | --- | --- | --- | --- | --- |
| No token (a 401) | Routing and the guard; touches no store | 0.21 ms | 12,054 / – | 6 ms | 100% | 3% |
| `GET /health` | Plus a `SELECT 1` and a Redis `PING` | 0.48 ms | 4,059 / – | 13 ms | 101% | 19% |
| `GET /v1/users/me` | A token check and one row read | 0.80 ms | 2,871 / 3,062 | 18 ms | 109% | 39% |
| `GET /v1/circuits` | A page of 20 circuits | 1.24 ms | 1,735 / 1,802 | 30 ms | 129% | 73% |
| `GET /v1/circuits/{id}` | The access row, then the gates and wires | 2.33 ms | 831 / 863 | 53 ms | 119% | 86% |
| Simulate, cached | The access row, a Redis `GET`, a history `INSERT` | 2.85 ms | 1,083 / 1,078 | 51 ms | 106% | 89% |
| Simulate, not cached | Plus loading the circuit, a worker thread, a Redis `SET` | 6.75 ms | 399 / 369 | 122 ms | 138% | 68% |
| `POST /v1/circuits` | One transaction: the circuit, its gates and wires | 7.71 ms | 267 / 311 | 195 ms | 111% | 84% |
| `POST /v1/auth/login` | An Argon2id check and a session row | 28.6 ms | 46 / 54 | 1,105 ms | 203% | 9% |

What the table says:
- **A request costs about its round trips:** 0.2 ms with none, 0.8 ms with one, 2 to 3 ms with two
  or three. **Calculated** for `GET /v1/users/me`: about 0.38 ms of the API's CPU and 0.14 ms of
  PostgreSQL's per request, so the API spends more per query than the database does.
- **A cache hit still costs two database round trips,** the access check and the history row
  (**Reasoned**, from `simulation.service.ts`: a cached answer is still a run). The cache saves the
  gates, the wires and the worker thread: for the 128-gate circuit a hit is 2.7 times faster than a
  miss.
- **The API is the busy part.** Its CPU sat at 100% to 140%, which is one core (the Node event
  loop) plus Prisma's share. PostgreSQL never used a whole core. That alone doesn't prove the API
  is the limit; [two copies](#two-copies) does.
- **At saturation, waiting is the only thing that grows.** Latency is users divided by
  throughput: 32 ÷ 1,083 a second is 29.5 ms, and the measured mean was 29.5 ms. Adding users adds
  waiting, not throughput.
- **Login is a different animal.** It costs about 28 ms of CPU, so about 25 logins a second per
  CPU, and it was the only request that used both CPUs.

### Big circuits

The same container, with the 5,000-gate chain (10,001 wires), 8 users:

| Request | 1 user | 8 users | API CPU | PostgreSQL CPU |
| --- | --- | --- | --- | --- |
| `GET /v1/circuits/{id}` | 36.8 ms | 24 a second | 178% | 25% |
| Simulate, not cached | 74.7 ms | 18 a second | 197% | 22% |

**Measured:** on the big circuit a container served about 35 times fewer reads and 20 times fewer
uncached simulations a second than on the small ones, and the cost is the API's CPU: PostgreSQL
stayed at a quarter of a core. One cached result of that circuit takes 98 KB in Redis, against
2.2 KB for the 128-gate one. The API allows circuits twice this size.

**Reasoned:** `GET /v1/circuits/{id}` loads the whole circuit and only then compares the
`If-None-Match` ETag, although the version the ETag needs is already in the cheap access row. The
truth-table pages do it the right way round: a client with a current copy gets its 304 without the
circuit being read.

### Two copies

The same requests, 64 users, one API copy against two behind the same name (connections spread
evenly, as a load balancer would):

| Request | 1 copy | 2 copies | Gain | p99, 1 copy | p99, 2 copies |
| --- | --- | --- | --- | --- | --- |
| `GET /v1/circuits/{id}` | 757 a second | 1,435 | 1.90 times | 123 ms | 65 ms |
| Simulate, cached | 1,021 | 1,877 | 1.84 times | 85 ms | 49 ms |
| Simulate, not cached | 317 | 656 | 2.07 times | 364 ms | 136 ms |
| `POST /v1/auth/login` | 43 | 110 | 2.56 times | 2,300 ms | 976 ms |

**Measured:** the API was the limit, and it scales out nearly linearly. PostgreSQL rose to about
1.6 cores for it, a tenth of what the virtual machine had. Login scaled by more than 2 times; the
likely reason (a guess) is that a container hashing on 4 threads under a 2-CPU quota loses time to
CPU throttling. A new copy was healthy within 6 seconds of being created.

### A login storm

One container, ordinary traffic (cached simulations, 8 users) alone and next to logins:

| | Logins | Ordinary requests | Their p99 |
| --- | --- | --- | --- |
| Alone | none | 900 a second | 17 ms |
| A mild load of logins | 28 a second (about one CPU) | 776 a second (14% fewer) | 19 ms |
| A storm of logins | 52 a second (both CPUs) | **46 a second (95% fewer)** | **310 ms** |

**Measured:** while Argon2 uses the container's CPUs, nothing else gets them. Hashing is meant to
be expensive (OWASP's minimum settings, see [auth-design.md](auth-design.md)), so the answer is
never to make it cheaper.

**Reasoned:** nothing stops an anonymous client from causing this. The sign-in throttle is keyed
by account *and* address (`auth.service.ts`), so every new email address gets 5 free failures, and
each failure costs a full hash (against a decoy, for an unknown account). `POST /v1/auth/register`
hashes too, and isn't throttled at all.

### Overload

One container, 300 users, far more than it can serve (8 seconds):

| Request | Answered | Statuses | p50 | p99 |
| --- | --- | --- | --- | --- |
| `GET /v1/circuits/{id}` | 667 a second | all 200 | 416 ms | 516 ms |
| Simulate, not cached | 422 a second | 1,752 × 200 and 1,621 × 503 | 769 ms | 1,039 ms |

**Measured:** the API turns away only simulations (a 503 with `Retry-After: 1`, once 100 are
waiting for the worker thread), and nearly half of them were. Everything else just queues, and its
latency grows without limit: 300 ÷ 667 a second is 450 ms, and the mean was 424 ms. The refusal
also comes late, after the circuit has been loaded from the database, so a refused request still
costs most of the work.

**Reasoned:** the database connection pool never gives up waiting. `pg-pool` starts a timer only
when `connectionTimeoutMillis` is set, and `createPrismaClient` sets only the pool size, so a
request with no free connection waits as long as it takes. A 503 mapping for "no connection in
time" exists (`database-errors.ts`), but a wait with no limit never reaches it.

### Background jobs

Four truth-table jobs (two users, two each) of 2^21 rows on a 44-gate circuit, started together,
with 1, 2 and 4 worker containers (2 CPUs each):

| Workers | Finished after (seconds) | All done |
| --- | --- | --- |
| 1 | 4.2, 8.1, 12.1, 15.9 | 15.9 s |
| 2 | 4.5, 4.7, 8.7, 9.1 | 9.1 s |
| 4 | 5.8, 6.5, 6.7, 6.9 | 6.9 s |

**Measured:** a worker container computes about 24 million gate evaluations a second: each job took
about 3.9 s, one after another. Phase 10's estimate was 60 ns an evaluation; this is 42 ns. More
workers shorten the queue, but 4 gave 2.3 times, not 4: the laptop has 8 real cores, shared with
the API, PostgreSQL, Redis and the load script. **Not tested:** workers on separate machines.

**Calculated:** a user's whole daily allowance (20 jobs of 2^31 gate evaluations) is about 30
minutes of one worker. If 500 of 10,000 users used all of it, the day would need 250 worker-hours:
10 workers busy around the clock. This is why jobs have per-user limits.

### Are the copies interchangeable?

Two API copies, each step of a check taken through a different one:

| Check | Result |
| --- | --- |
| A token issued by A is accepted by B | pass |
| A circuit created through A is read through B | pass |
| A result cached by A is a cache hit on B | pass (`stored`, then `hit`) |
| 5 wrong sign-ins, 3 through A and 2 through B, block both (429), even with the right password | pass |
| A refresh token from A rotates on B; the old one is then refused on A | pass |
| A job started through A is polled and downloaded through B | pass |
| **The same, without a shared `JWT_SECRET`** | **fail: B answers 401 `invalid-token` to A's token** |

**Measured.** The last row is the one to remember: without a shared `JWT_SECRET`, each copy signs
with its own random key, and a second copy makes about half of all requests fail, depending on
which copy answers. `docker-compose.yml` passes `JWT_SECRET` through but doesn't require it.

### What grows

| What | Size | Where it matters |
| --- | --- | --- |
| A history row (`simulation_runs`) | 360 bytes for a small circuit (228 in the table, 129 in its indexes); 1.5 KB for the 64-input one, whose inputs are stored too | One row per simulation, cached or not |
| A cached result in Redis | 2.2 KB (128 gates); 98 KB (5,025 gates) | Each cache miss |
| Redis's memory limit | none (`maxmemory` 0, policy `noeviction`) | The cache, the queue, the throttle and job results share it |
| Database connections | 10 per API process (measured: 10 with one copy, 20 with two); a worker has a pool of the same size (**Reasoned**) | `max_connections` is 100, about 97 usable |

**Calculated:**
- 100 simulations a second for 8 hours is 2.9 million rows a day, 1.0 GB a day, **31 GB a month**.
- 50 cache misses a second, kept for the 1-hour expiry, is 180,000 entries: **0.4 GB** of Redis for
  small circuits, or 18 GB if they were 5,000-gate ones.
- With 10 connections per process, **7 API copies and 2 workers** use 90 of 97.

## 4. Where it breaks, in order

From the evidence above, in the order that growth would hit each one:

1. **Requests with a cost out of proportion** (logins, registrations, big circuits). They hurt
   already at the target: a lab starting is a login burst, and one big circuit uses a core.
   *Evidence:* the login storm, the big-circuit table. *Needs:* limits at the front door, and a
   separate set of copies for `/v1/auth/*`.
2. **Redis memory.** One user with a big circuit and random inputs fills it: at the 18 requests a
   second measured, about 6 GB within the 1-hour expiry (**Calculated**). When Redis dies, sign-in
   answers 503 (it fails closed on purpose) and jobs stop. *Needs:* a memory limit, and the cache
   apart from the queue.
3. **Overload without a brake.** Latency is users ÷ throughput, so a flood is a slowdown for
   everyone, and a stuck database makes requests wait forever. *Needs:* a pool timeout, and limits
   at the load balancer.
4. **The API's CPU.** The ordinary kind of limit: add copies (stage 2), about one per 330 requests
   a second.
5. **Database connections,** at about 7 copies. *Needs:* a connection pooler.
6. **The history table,** in weeks to months. *Needs:* retention at once, partitions before it is
   big.
7. **PostgreSQL's CPU,** at about 10 times the target. **Calculated:** the single-copy runs cost
   about 1.5 cores of PostgreSQL per 1,000 requests a second, so 6,000 a second would need about
   10: large, but still one machine (a straight-line extrapolation, not measured). This document
   never found the database's ceiling.
8. **Workers,** depending on how many users run big jobs (30 worker-minutes each, at the most).

### The load, in containers

**Calculated** from the measured rates (the lower of the two runs), the mix of section 1, and 60%
as the comfortable load of a container. One container then does about 560 requests a second at
100%, and **334 at 60%**.

| Load | Requests a second | API containers at 60% | With one spare | History rows a second | Connections (2 workers) |
| --- | --- | --- | --- | --- | --- |
| 1,000 working, average | 200 | 1 | 2 | 100 | 40 |
| 1,000 working, burst | 600 | 2 | 3 | 300 | 50 |
| 10,000 working, average | 2,000 | 6 | 7 | 1,000 | 90 |
| 10,000 working, burst | 6,000 | 18 | 19 | 3,000 | 210 |

Logins at the start of a lab (17 a second) need about half a CPU of hashing, where a container has
2: absorbed, like the mild load above. At 10 times that (167 a second) they need 4.7 CPUs, more
than two containers' worth, and would starve the traffic around them.

## 5. The plan

Each stage is useful without the next. "Size" is a rough guess: S is a day or less, M a few days,
L a week or more.

### Stage 1: fix the sharp edges

Small changes, no new machines. They fix what the measurements found, and help whatever comes
later.

| Change | Why | Size |
| --- | --- | --- |
| **Limit anonymous hashing:** a per-address limit on `/v1/auth/login` and `/v1/auth/register`, at the reverse proxy (nginx `limit_req`, Caddy) or as a Redis counter in the API, like the sign-in throttle | One address can burn a container's CPUs: the storm, and the unthrottled registration | S to M |
| **Give Redis a memory limit and split it in two:** one for the cache, evicting old entries (`allkeys-lru`), through the existing `REDIS_CACHE_URL` (tested in phase 10); one for the queue, throttle and results, which never evicts (`noeviction`). Both with `maxmemory` | A cached result is up to 98 KB, with no limit today | S (configuration, a second container) |
| **A wait limit on the database pool** (`connectionTimeoutMillis`, say 5 s), mapped to the existing 503 | Otherwise a request waits for a connection forever. Checking that the timeout error really becomes a 503 is part of the change | S |
| **Answer `If-None-Match` in `GET /v1/circuits/{id}` from the access row,** before loading gates and wires, as truth-table pages do | Loading a 5,000-gate circuit costs 37 ms of the API's CPU | S |
| **Retention for the history:** housekeeping deletes runs older than, say, 30 days, in batches (the scheduler exists) | 31 GB a month at the target's pace; deleting is cheap now and painful later | S to M |
| **Decide what a missing `JWT_SECRET` means:** refuse to start in production, or keep warning | Scaling out without it breaks sign-in, but refusing breaks phase 11's "one command, no setup". Probably refuse, and make `docker compose up` generate one | S (a decision first) |

**What stage 1 doesn't fix:** the API's own CPU, or anything about the database.

### Stage 2: several API copies behind a load balancer

The step that adds capacity, and the cheapest big one, because the API is already stateless.

- **Copies:** two for the target (one carries the average, two the burst), three to survive a loss.
  They are the same image. A new one is ready in under 6 seconds, so the number can follow the load
  (add one above 60% CPU).
- **A load balancer** (a managed one, or nginx, Caddy or Traefik on a small machine) that:
  - **terminates TLS,** which the API doesn't;
  - **passes on the client's address,** with `trust proxy` set in the API. **Reasoned:** without it
    the throttle sees the balancer's address for everyone, so the lock-out its key was designed to
    prevent (5 failures from anywhere locking the real owner out) becomes possible again;
  - **caps concurrent requests per copy** (about 64 here) and times requests out, so a flood
    becomes quick 503s instead of the unlimited waiting of the overload table;
  - **limits requests per address,** tighter on `/v1/auth/*`, and later per user.
- **A separate pool for `/v1/auth/*`:** routing by path to its own copies, **the same image**, no
  code change, sized by the login peak. Logins can then never starve ordinary requests.
- **Health checks: liveness for the balancer, readiness for dependencies.** `GET /health` answers
  503 when PostgreSQL *or Redis* is unreachable. **Reasoned:** if a balancer used it, a Redis blip
  would remove every copy at once, though phase 10's degraded mode (simulations work uncached)
  would have served users. The balancer should check only that the process answers; `/health` as it
  is suits an orchestrator deciding whether to restart.
- **Every copy needs the same `JWT_SECRET`,** and a `DATABASE_URL` and `REDIS_URL`: never the
  in-memory fallbacks, which keep their state in one process (**Reasoned**: that is what they are).
- **No sticky sessions,** which the checks above show aren't needed.

**What stage 2 doesn't fix:** connections multiply with copies, and the database is still one.

### Stage 3: protect the database

- **A connection pooler (PgBouncer, transaction pooling)** between the API and PostgreSQL, so that
  connections stop being copies × 10. **Not tested:** it must be tried with Prisma's `pg` adapter
  first. **Reasoned** in its favour: the one place the app takes a lock, starting a job, uses
  `pg_advisory_xact_lock`, the transaction-scoped kind that stays correct through such a pooler (a
  session-level lock would not).
- **Take the history write off the request.** Every simulation waits for its `INSERT`. Writing in
  batches (buffer, then one multi-row insert a second) would remove one of the three round trips of
  a cached simulation, perhaps a quarter to a third of its time (**Reasoned**, an estimate). The
  cost: a crash can lose the last second of history, a rule to decide with the product. Phase 10
  made a cached answer a run, and this keeps that.
- **Partition `simulation_runs` by month,** so that dropping a month is instant, where a `DELETE`
  of millions of rows isn't. The primary key and unique constraints have to include the partition
  key (`created_at`), so it is a migration with a data copy: far easier before the table is big.
- **A read replica** for reads that no write depends on: public circuits, other people's shared
  circuits, lists. **Reads that lead to a write stay on the primary:** the access check before an
  edit (optimistic locking compares the current version), and a user's own read right after their
  own write (a replica lags). **Not tested.**
- **Managed PostgreSQL** with backups and a standby, rather than running it by hand.

### Stage 4: workers and results

- **Workers as their own fleet,** scaled by the queue's depth: add one when the oldest waiting job
  has waited over a minute. A worker computes about 24 million gate evaluations a second.
- **Results in object storage** (S3 or compatible), behind the existing `JobResults` class, with a
  download straight from storage by a short-lived link. It takes the CSV encoding off the API's
  event loop and the results out of Redis memory: a user's worst case is 320 MiB a day, about
  320 GB for 1,000 of them (**Calculated**).
- **Polling:** clients ask about a waiting job every `Retry-After` (2 seconds), so 500 waiting jobs
  are 250 requests a second. A longer `Retry-After` as the queue grows, or a push channel, would
  cut that (**Reasoned**).

### What it looks like at the end

```
clients ──► load balancer ──┬──► api-auth        the same image; only /v1/auth/*
            · TLS           └──► api × N         everything else
            · rate limits           │
            · request timeouts      ├──► Redis (cache)   evicts old entries
            · client address        ├──► Redis (queue)   throttle, jobs, results: never evicts
                                    └──► PgBouncer ──► PostgreSQL primary ──► read replica
                                                            ▲
                  workers × M (scaled on queue depth) ──────┘ and Redis (queue), object storage
```

### When to do each step

Starting points to adjust, not laws:

| Signal | Do this when |
| --- | --- |
| API CPU, per copy | Above 60% for 10 minutes: add a copy |
| p99 of an ordinary request | Above 500 ms: add copies, or look for a cost problem |
| Logins | Above 15 a second sustained: a separate pool for `/v1/auth/*` |
| PostgreSQL connections | Above 70% of `max_connections`: a pooler |
| PostgreSQL CPU | Above 60% of its cores: a read replica, then a bigger machine |
| `simulation_runs` | Above 50 GB or 100 million rows: partition (retention should come first) |
| Redis memory | Above 70% of `maxmemory`: more memory, or look for who fills it |
| The oldest waiting job | Over a minute: add workers |

## 6. When something dies

Phase 10's [table for Redis](caching-and-jobs.md#when-redis-is-down) and phase 6's
[for the database](database-design.md#when-the-database-is-unavailable) still hold. What changes
with several machines:

| What dies | What users see | What recovers it |
| --- | --- | --- |
| One API copy | The requests in flight on it fail; the balancer stops sending it more | The balancer's liveness check; clients retry. A planned stop drains first (phase 4) |
| One worker | Its job goes back to the queue after the lock expires (tested in phase 10) | Another worker |
| Redis | Simulations work uncached, sign-in and jobs answer 503, `/health` says 503 | Redis restarting (`appendonly` keeps the data). A standby: not tested |
| PostgreSQL | Everything that needs it answers 503 with `Retry-After: 5` | A standby promoted (a managed database). Not designed here |
| The load balancer | Everything | A managed one, or two. A single balancer is a single point of failure |
| The whole site | Everything | Not designed: no second region |

## 7. What to watch

Today there is `GET /health`, and Nest's log on stdout: no metrics, no request ids, no traces.
Before scaling, add the four signals per route, plus the saturation of what they share:

- **Rate and errors** (the 5xx and 429 shares) per route.
- **Latency,** the p50 and p99 per route.
- **Saturation:** the API's CPU and event-loop lag, the database pool's wait time and size,
  PostgreSQL's connections, Redis's memory, the queue's depth and its oldest job.
- **A request id** in every log line and answer, so that a user's slow request can be found.

The triggers of [the last table](#when-to-do-each-step) are these signals; without them the plan
has nothing to decide on.

## 8. What was not designed, and why

- **Microservices.** The system already runs as three kinds of process from one image (API,
  worker, migrations). A service per module would add network failures between them, for no
  measured gain.
- **Kubernetes.** A managed container platform, or Compose on one or two machines, covers 2 to 19
  API containers. It earns its place with many services and teams.
- **Sharding the database.** It wasn't near its limit, and a partitioned history and a replica come
  first.
- **Another queue (Kafka, RabbitMQ).** BullMQ on Redis carried the measured jobs, and job volume is
  small: tables are bounded per user.
- **CQRS or event sourcing.** The reads and writes aren't different enough in shape to pay for it.
- **A CDN for the API.** Answers depend on who asks (private circuits), and the cache already
  covers the expensive request.
- **Caching more.** The cache covers the one request that is expensive and repeated; a hit saves
  the gates and wires, which is as much as a cache can.

## 9. For phase 13

A deployed demo is stages 1 and 2 in miniature: one small machine running phase 11's Compose stack
behind a reverse proxy. It needs the cheap parts of them: the proxy (TLS, `trust proxy`, a limit on
`/v1/auth/*`), `JWT_SECRET` and `POSTGRES_PASSWORD` set, and Redis with `maxmemory`.

## Known shortcuts

| Shortcut | Why it's acceptable for now | The proper fix |
| --- | --- | --- |
| Measured on a laptop with the load script on the same machine | The comparisons (one against two, small against big) hold on any machine; the script used 15% to 36% of a core, 81% for the one request that touches no store | Repeat on the target hardware. A cloud vCPU is usually slower than this laptop's cores, so treat the rates as an upper bound |
| A closed loop with no pauses | It finds the capacity directly | A load shaped like real use (users, pauses, a login burst) once there is real traffic |
| Small circuits, plus one of 5,000 gates | They show the range | A sample of real circuit sizes; the API allows 10,000 gates and 50,000 wires, which weren't measured |
| The target and the request mix are assumptions | Every number follows from them, and can be recomputed | Replace them with measured traffic |
| Local disk, no network latency between containers | The write path (`INSERT`, commits) was measured at its best | Repeat with a managed database: commits there usually cost more |
| PgBouncer, read replicas, object storage, workers on separate machines | Recommended from reading the code and documentation, not tried | Try each before adopting it |
| The thresholds in [When to do each step](#when-to-do-each-step) | Starting points | Adjust with real signals |
| Two runs of the main scenarios, not many | They agreed within 17% | More runs, if a decision depends on 10% |

## Running it yourself

The scripts are in [`scripts/load`](../scripts/load). They need Docker, and the `circuitlab` image
from `docker compose build`. The commands use a separate Compose project, so your own stack and
data aren't touched. (`compose.limits.yml` uses `!reset`, which needs Compose 2.24 or later.)

```bash
export JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))")

# 1. A separate stack: the API and worker limited to 2 CPUs, the API without a published port
docker compose -p circuitlab-load -f docker-compose.yml -f scripts/load/compose.limits.yml up -d --wait

# 2. The load, from a container on its network (several scenarios, 1 and 32 users)
node scripts/load/run-load.mjs --scenarios=get,simulate-hit,simulate-miss --concurrency=1,32 --out=result.json

# 3. Two copies, and the checks that they are interchangeable
docker compose -p circuitlab-load -f docker-compose.yml -f scripts/load/compose.limits.yml up -d --scale api=2 --wait
docker run --rm -i --network circuitlab-load_default -e TARGET_HOST=api --entrypoint node circuitlab --input-type=module - < scripts/load/checks.mjs

# 4. How fast jobs drain (change --scale worker=N and run it again)
docker run --rm -i --network circuitlab-load_default -e TARGET_HOST=api -e INPUTS=22 --entrypoint node circuitlab --input-type=module - < scripts/load/jobs-timing.mjs

# 5. Remove it all (this project's containers and volumes only)
docker compose -p circuitlab-load -f docker-compose.yml -f scripts/load/compose.limits.yml down --volumes
```

Scenarios: `floor`, `health`, `me`, `list`, `get`, `simulate-hit`, `simulate-miss`, `create`,
`login`, `get-big` and `simulate-miss-big`. The script creates an account and some circuits in
whatever stack it targets. It isn't part of `npm test`: load numbers depend on the machine, so a
test with a threshold would fail on a slow day.
