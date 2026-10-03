# Caching and background jobs (phase 10)

Phase 10 adds Redis to CircuitLab, and with it three things:
- **A result cache** for simulations and truth-table pages.
- **Background jobs** (BullMQ) for truth tables too big for one response.
- **A sign-in throttle shared by every API instance,** where phase 7's lived in one process's memory.

`npm run demo:jobs` shows all of it over HTTP. Without `REDIS_URL`, the API still runs, with
everything in one process's memory, like it runs without `DATABASE_URL`.

## What lives where

| Store | Holds | Why there |
| --- | --- | --- |
| PostgreSQL | Users, circuits, sessions, the history of runs (jobs included) | Must last, and is queried by relations |
| Redis | The result cache, sign-in failure counts, the job queue, job results (24 hours) | Short-lived, shared by every process, needs expiry and atomic counters |
| Memory (no `REDIS_URL`) | The same, for one process | Development, tests, demos |

**One module decides.** `RedisModule` binds the cache, the throttle, and the result store to Redis
or to memory, as `StorageModule` binds the repositories to PostgreSQL or memory. `JobsModule` does
the same for the queue (BullMQ or a queue inside the process). Nothing else knows which it got.

**Redis is the source of nothing.** Anything in it can be rebuilt (a cached result, a job's rows)
or is allowed to be forgotten (failure counts). Each job's record, and the truth about its status,
are in PostgreSQL: if Redis lost everything, no job would claim a result it doesn't have.

## The result cache

**What is cached.**
- Successful simulations, including the signals and the evaluation order, so one entry serves
  requests with and without `include=signals`.
- Truth-table JSON pages, stored as bits (see below).

Failures aren't cached (a refusal is cheap to repeat), and neither are CSV and NDJSON downloads
(too big; they are streamed).

**The key holds the circuit version, so nothing ever has to be invalidated.**
- `sim:<circuit id>:<version>:<SHA-256 of mode, inputs and state>`
- `page:<circuit id>:<version>:<offset>:<limit>`

A result depends only on the circuit version and the request, and every change to a circuit
makes a new version (phase 3's ETags). So an entry can never be out of date. After an edit, requests
simply use new keys, and old entries expire after an hour (`CACHE_TTL_SECONDS`) or are evicted. No
"delete these keys when a circuit changes" code exists that could be forgotten somewhere. Inputs and
state are sorted before hashing, so `{A, B}` and `{B, A}` are the same request.

**The access check always comes first.** It reads one row (the circuit's owner, visibility, the
caller's share, and the version), and the version then completes the cache key. So a hit skips
loading the gates and wires, the worker threads, and the simulation. It never skips "may this
caller see this circuit?". A test checks that a stranger gets 404 for a result someone else cached.

**The cache can't break a request (cache-aside, failing open).** The service asks the cache; on a
miss it computes and stores. If Redis is down, every lookup counts as a miss and the answer is
computed as before. `Cache-Status` (RFC 9211) says what happened: `CircuitLab; hit`, or
`CircuitLab; fwd=miss; stored`.

**A cached answer is still a run.** It is recorded in the history like any other: the history is
about what people asked and got, not about which machine did the arithmetic.

**Measured (`demo:jobs`).** A 16-bit adder takes about 50 ms the first time and 2 to 4 ms from the
cache, over HTTP.

**Two Redis memory policies.** A cache should evict old entries when memory runs out
(`maxmemory-policy allkeys-lru`). A job queue must never lose a key (`noeviction`, which BullMQ
requires), and one Redis has one policy. So `REDIS_CACHE_URL` may name a separate Redis for the
cache. Without it, one Redis with `noeviction` (Redis 8's default) serves both. Every cache entry
expires, and when that Redis is full, cache writes fail, which counts as a miss.

## Background truth-table jobs

**Why jobs.** A download holds at most 1,048,576 rows (phase 3). A bigger table is minutes of work
and hundreds of megabytes of text. Holding one request open that long is fragile:
- timeouts and load balancers end it;
- a dropped connection loses all the work;
- it occupies the API's worker threads meanwhile.

A job decouples asking from computing. The table is computed once, in the background, and kept
for a day, to be downloaded (again, if need be) at the client's pace.

**The asynchronous request-reply pattern.**

| Request | Answer |
| --- | --- |
| `POST /v1/circuits/{id}/truth-table/jobs` `{"offset": 0, "limit": 4194304}` | 202 Accepted, the job, `Location: <job URL>`, `Retry-After: 2` |
| `GET <job URL>` | 200: `status`, `rowsDone`, and `links.result` once it can be downloaded; `Retry-After` while unfinished |
| `GET <job URL>/result` | 200: the rows as CSV (default) or NDJSON; 409 if not finished or failed; 410 once deleted or expired |
| `DELETE <job URL>` | 204: cancels a job that is waiting or running, or deletes a finished one's result |

**A job is a run.** Phase 5 designed `simulation_runs` for this:
- `kind = 'truth_table'`, with `row_offset` and `row_limit`;
- the statuses `queued` and `running`;
- a partial index of unfinished runs.

So a job has the same id as its run, appears in the circuit's history, and needed no new
columns. Phase 10's migration adds one index (see database-design.md).

**A job's status only moves forward,** and every change is a compare-and-swap on the status
(`UPDATE ... WHERE status IN (...)`):

```
queued --> running --> succeeded
   \          \------> failed
    \-----------\----> cancelled
```

Of a cancellation and a finishing worker racing, exactly one wins. A worker that finishes a job
cancelled meanwhile can't mark it succeeded, and throws its result away. A worker given a job
that was cancelled while waiting finds nothing to start.

**Who may do what.**
- **Starting:** anyone who can read the circuit, if signed in (a job is kept on their behalf, and
  counts against their allowance).
- **Seeing a job:** only the person who started it, and only while they can still see the circuit.
  Losing access to a circuit means losing access to its tables.

**Limits, and why each.**

| Limit | Value | Why |
| --- | --- | --- |
| Rows per job | 16,777,216 (2^24) | 16 times the largest download |
| Gate evaluations per job (rows × gates) | 2,147,483,648 (2^31) | About two minutes of one worker thread: one evaluation measured about 60 ns |
| Result size (rows × outputs) | 134,217,728 values | 16 MiB once stored as bits |
| Unfinished jobs per user | 2 | One user can't fill the queue |
| Jobs per user in any 24 hours | 20 | With the result size, this bounds the memory one user can claim in Redis (about 320 MiB at worst) |
| Running time | 10 minutes | A safety net, five times the work budget |
| Results kept | 24 hours | Time to download; then Redis deletes them itself |

A job over a limit is refused at once (422 `computation-too-large`, with the largest job that
would fit this circuit), not after minutes of work.

**The same request twice gets the same job.** If a user asks again for the same rows of the
same circuit version while their first job is still waiting or running, they get that job back
(202, same `Location`). A client that retries after a lost answer never doubles the work or uses
up its allowance. This is why jobs don't need the `Idempotency-Key` header that phase 3's plan
mentioned.

**The circuit version is pinned.** A job computes the version current when it was started. If
the circuit changes before a worker begins, the job fails with `version-conflict` rather than
silently computing a different circuit. Once the worker has loaded the circuit, edits don't
affect it.

**Results are stored as bits, and formatted when downloaded.**
- **Inputs aren't stored:** row n's inputs are n in binary.
- **Outputs take one bit each,** in chunks written as the job goes.
- **Measured** for a 10-bit adder (2,097,152 rows, 11 outputs): 2.8 MiB stored, 145 MiB as CSV.
  Gzip would have shrunk the CSV only about 12 times.
- **One job serves both formats.** The download decodes the bits and runs them through the same
  encoder as the synchronous download. A test checks that the two are byte for byte identical.

**Results are kept in Redis, with an expiry.** Results are temporary (24 hours) and can always be
computed again, which is what Redis's expiry is for. PostgreSQL keeps data that must last, and
wouldn't need a cleanup job for it. A local folder wouldn't be shared by several API instances.
At a much larger scale they belong in object storage (S3), behind the same `JobResults` class
(phase 12).

## BullMQ

**Producer and consumer.**
- **API instances add jobs to the queue** (`BullMqJobQueue`).
- **Workers take them** (`BullMqJobWorkers`): in the API process (`JOB_CONCURRENCY`, default 1),
  and/or in worker processes (`npm run start:worker`).
- **`JOB_CONCURRENCY=0` makes an API-only instance.** The API and the workers then scale apart:
  heavy tables never slow down the API's answers, and workers can be added when the queue grows.
  Phase 11 runs them as separate containers.

**The queue carries only the job's id.** BullMQ's job id is the job's id, so:
- adding the same job twice is harmless;
- any process can look up a job's progress by its id;
- the queue losing a job can never make it look done.

**Retries.**
- **A failure that a retry can't fix is not retried.** This means any 4xx problem (the circuit
  changed; it needs more memory than a worker has) and running out of time. The processor marks
  the job failed and tells BullMQ not to retry (`UnrecoverableError`).
- **Anything else is retried,** 3 attempts in all, 1 then 2 seconds apart. That covers a database
  or Redis outage, or a worker stopped mid-job. Only the last failure marks the job failed.

**A worker that dies loses its job, and another takes it.** BullMQ holds a lock on each running job,
which the worker keeps renewing. When the worker stops (shutting down, or crashing), the job goes
back to the queue and another worker takes it. A test stops a worker in the middle of a
million-row job and checks that a second one finishes it.

**Cancelling.** `DELETE` marks the job cancelled in PostgreSQL; that record is the truth. A waiting
job is also taken out of the queue. A running one sees its cancellation at its next look (every
250 ms) and stops.

**Progress.** The worker reports the rows done after each page. Any API instance reads it from
Redis, so a client polling through a load balancer sees it advance.

**Housekeeping, every 10 minutes.** A BullMQ job scheduler runs it once in all, however many
processes there are:
- it deletes expired sessions (phase 7 left this for phase 10);
- it fails jobs still unfinished an hour after they were requested (`internal-error`). Those were
  lost: their worker's machine died and Redis lost the job too. Otherwise they would say "running"
  forever and use up their owner's allowance.

**Without Redis,** an in-process queue runs the same processor, with BullMQ's limits as its
weaknesses: waiting jobs are lost when the process stops, only that process can work on them, and
failures aren't retried. A timer runs housekeeping.

**Why BullMQ on Redis.** BullMQ 6 can also keep its queue in PostgreSQL. We use Redis because the
cache and the throttle need it anyway, it is the roadmap's choice, and a queue in Redis keeps job
traffic off the database.

## The sign-in throttle, shared

Phase 7's throttle counted failures in one process's memory. With two API instances, an attacker
could make 5 guesses on each. Now the counts are in Redis:
- **One count for all instances.** A test spreads guesses over two instances and is still blocked
  after 5.
- **Atomic.** A failure is counted by a Lua script, which Redis runs without interleaving, so two
  instances counting at once can't lose a count.
- **Private.** Keys are hashed, so email addresses aren't stored in Redis as they are.
- **Two clocks, on purpose.** Whether 15 minutes have passed is decided with the app's injected
  `Clock`, so the time-travel tests hold for Redis too. Redis's own expiry only deletes keys whose
  window is over.
- **It fails closed.** When Redis is down, sign-in answers 503 rather than skipping the throttle: a
  security control that switches itself off in an outage would invite one.

## When Redis is down

| What | Answer |
| --- | --- |
| Starting the API | Refused, with where Redis was expected (never the password) |
| Simulating, truth-table pages | Work, uncached (`Cache-Status: CircuitLab; fwd=miss`) |
| Signing in | 503 `server-unavailable`, `Retry-After: 5` |
| Starting a job | 503; the job is forgotten, so it doesn't wait forever or count against the user |
| A job's status | Works (it is in PostgreSQL), without progress or the result's link |
| Downloading a result | 503 |
| `GET /health` | 503, `redis: { reachable: false }` |
| Redis hanging (not answering) | The same 503s after 2 seconds (every command has a time limit), not a hung request |
| Redis back | Recovered without a restart, within a few seconds |

Each is tested, by stopping and freezing a real Redis in Docker (`redis.test.ts`).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `REDIS_URL` | none | Redis connection string. Without it, everything above lives in this process's memory |
| `REDIS_CACHE_URL` | `REDIS_URL` | A separate Redis for the cache, which may then evict (`allkeys-lru`) |
| `REDIS_PREFIX` | `circuitlab` | Prefix of every key, so several apps or test runs can share one Redis |
| `CACHE_TTL_SECONDS` | 3600 | How long results stay cached; 0 turns the cache off |
| `JOB_CONCURRENCY` | 1 | Jobs this process computes at once; 0 for an API-only instance (needs Redis, and a worker) |

## Patterns, in a sentence each

- **Cache-aside with versioned keys:** the service fills the cache, and the version in the key
  replaces invalidation.
- **Asynchronous request-reply:** 202, a status URL to poll, a result URL.
- **Producer and consumer:** API instances queue, workers consume; each side scales on its own.
- **Compare-and-swap state machine:** every status change says what it expects the status to be.
- **The database record is the truth; the queue only delivers.**
- **Redis or memory, chosen in one module** (dependency injection, as in phase 9).
- **Fail open, fail closed, on purpose:** the cache fails open (an optimisation), the throttle
  fails closed (a security control).

## Left for later

- **`Idempotency-Key` for other POSTs.** Jobs don't need it (the same request gets the same job),
  but creating a circuit twice by retrying still makes two circuits.
- **Rate limits on the whole API**, with `RateLimit` headers: designed in phase 12, for a gateway to
  enforce before requests reach the API ([system-design.md](system-design.md#stage-2-several-api-copies-behind-a-load-balancer)).
- **Results in object storage (S3)** when Redis memory becomes the limit: designed in phase 12
  ([system-design.md](system-design.md#stage-4-workers-and-results)), together with a memory limit for
  Redis and the cache on a Redis of its own (`REDIS_CACHE_URL`).

Phase 3's plan put the first two in phase 10. They were moved, not forgotten.
